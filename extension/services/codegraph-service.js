import * as fs from 'fs';
import { logActivity } from './activity-logger.js';
import { runCodegraphQueryBatch } from './codegraph-query-runner.js';
const KILL_SWITCH_ENV = 'PICKLE_CODEGRAPH';
const KILL_SWITCH_VALUE = 'off';
// Bounded retry/backoff for serve --mcp startup: transient native-module or
// index-init failures are retried at most MCP_STARTUP_MAX_RETRIES times before
// the service degrades to codegraph_degraded.
const MCP_STARTUP_MAX_RETRIES = 2;
const MCP_STARTUP_BACKOFF_MS = [500, 1500];
function classifyError(message) {
    const m = message.toLowerCase();
    if (m.includes('database is locked'))
        return 'locked';
    if (m.includes('not a database') || m.includes('malformed') || m.includes('corrupt'))
        return 'corrupt';
    if (m.includes('schema') || m.includes('migration') || m.includes('version'))
        return 'schema_skew';
    return 'error';
}
function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Lazy-load the upstream default bag (CJS dynamic re-export — must default-import). */
async function loadCodegraphBag() {
    const mod = (await import('@colbymchenry/codegraph'));
    const bag = mod.default ?? mod;
    return bag;
}
/**
 * Fail-open wrapper around `@colbymchenry/codegraph`. Never throws to callers,
 * never loads the dependency when killed, races async ops against settings
 * timeouts, classifies failures, quarantines+rebuilds-once on corruption, and
 * latches the session disabled when the index is unrecoverable.
 */
export class CodegraphService {
    workingDir;
    settings;
    deps;
    killSwitch;
    impl = null;
    loadFailed = false;
    loadDegradeEmitted = false;
    latched = false;
    rebuildAttempted = false;
    counters = { ops: 0, degraded: 0, latched: 0, injected: 0, skipped: 0 };
    constructor(workingDir, settings, deps) {
        this.workingDir = workingDir;
        this.settings = settings;
        this.deps = deps;
        const env = deps.env ?? process.env;
        this.killSwitch = env[KILL_SWITCH_ENV] === KILL_SWITCH_VALUE;
        if (deps.impl)
            this.impl = deps.impl;
    }
    static create(workingDir, settings, deps = {}) {
        return new CodegraphService(workingDir, settings, deps);
    }
    getSessionCounters() {
        return { ...this.counters };
    }
    /** b1089e97: record a `codegraph_context_injected` emission (count only — no event). */
    recordContextInjected() {
        this.counters.injected += 1;
    }
    /** b1089e97: record a `codegraph_context_skipped` emission (count only — no event). */
    recordContextSkipped() {
        this.counters.skipped += 1;
    }
    /** True while the instance answers every call with null and emits nothing. */
    get inert() {
        return this.killSwitch || this.latched;
    }
    close() {
        // Sync per inventory. Never load the dependency just to close it.
        if (this.killSwitch || !this.impl)
            return;
        try {
            this.impl.close();
        }
        catch {
            // Releasing resources must never throw to the caller.
        }
        this.impl = null;
    }
    async indexAll() {
        const impl = await this.beginOp();
        if (!impl)
            return null;
        const t0 = Date.now();
        const result = await this.runWithTimeout('indexAll', this.settings.index_timeout_ms, () => impl.indexAll());
        if (result.ok) {
            const duration_ms = Date.now() - t0;
            const v = result.value;
            const files_indexed = typeof v?.filesIndexed === 'number' ? v.filesIndexed : undefined;
            this.emit({
                event: 'codegraph_index_built',
                ts: this.now(),
                operation: 'indexAll',
                gate_payload: { duration_ms, ...(files_indexed !== undefined ? { files_indexed } : {}) },
            });
        }
        return result.ok ? result.value : null;
    }
    async sync() {
        const impl = await this.beginOp();
        if (!impl)
            return null;
        const result = await this.runWithTimeout('sync', this.settings.sync_timeout_ms, () => impl.sync());
        if (result.ok)
            this.emit({ event: 'codegraph_sync_completed', ts: this.now(), operation: 'sync' });
        return result.ok ? result.value : null;
    }
    async buildContext(task) {
        const impl = await this.beginOp();
        if (!impl)
            return null;
        const result = await this.runWithTimeout('buildContext', this.settings.query_timeout_ms, () => impl.buildContext(task));
        return result.ok ? result.value : null;
    }
    /**
     * Run a batch of codegraph queries (search terms + caller node ids) for ONE section
     * build behind the killable subprocess boundary (A1). The SDK queries are SYNC native
     * calls, so an in-process race can never preempt a wedged one — the runner spawns a
     * `detached` child and group-kills it on timeout. Kill-switch / latched short-circuits
     * to an empty `ok` result (mirrors the old null→zero_hits collapse). Timeout/failure
     * emit an open-string `codegraph_degraded`; the discriminated result flows to the
     * consumer, which maps it to `query_timeout` / `query_failed` skip reasons. Never throws.
     */
    async runQueryBatch(searches, callers) {
        if (this.inert)
            return { status: 'ok', searches: {}, callers: {} };
        this.counters.ops += 1;
        const run = this.deps.runQueryBatch ??
            ((input, ms) => runCodegraphQueryBatch(input, { timeoutMs: ms, ...(this.deps.env ? { env: this.deps.env } : {}) }));
        let result;
        try {
            result = await run({ workingDir: this.workingDir, searches, callers }, this.settings.query_timeout_ms);
        }
        catch {
            this.degradeOpen('query', 'runner-threw');
            return { status: 'failed', reason: 'runner-threw' };
        }
        if (result.status === 'timeout' || result.status === 'failed') {
            this.degradeOpen('query', result.reason);
        }
        return result;
    }
    async searchNodes(query) {
        // Behind the subprocess boundary (A1) — no in-process sync query is reachable.
        const r = await this.runQueryBatch([query], []);
        return r.status === 'ok' ? (r.searches[query] ?? []) : null;
    }
    async getCallers(nodeId) {
        // Behind the subprocess boundary (A1) — no in-process sync query is reachable.
        const r = await this.runQueryBatch([], [nodeId]);
        return r.status === 'ok' ? (r.callers[nodeId] ?? []) : null;
    }
    getImpactRadius(nodeId) {
        // SYNC impl (inventory) — deleted by ticket 8321922b; left compiling, NOT extended.
        return this.impactRadiusSync(nodeId);
    }
    // --- internals -----------------------------------------------------------
    now() {
        return this.deps.now ? this.deps.now() : new Date().toISOString();
    }
    emit(event) {
        try {
            if (this.deps.emit) {
                this.deps.emit(event);
                return;
            }
            defaultEmit(event);
        }
        catch {
            // Telemetry must never break the caller.
        }
    }
    /** Gate the op (inert short-circuit), resolve the impl, and count a live op. */
    async beginOp() {
        if (this.inert)
            return null;
        const impl = await this.resolveImpl();
        if (!impl) {
            // Dependency unavailable while enabled = a degraded op, not a crash.
            // Emit ONCE — a persistently absent dependency must not spam one degrade
            // per call for the rest of the session.
            if (!this.loadDegradeEmitted) {
                this.loadDegradeEmitted = true;
                this.degrade('load', 'error');
            }
            return null;
        }
        this.counters.ops += 1;
        return impl;
    }
    /** getImpactRadius's inlined body — the sole remaining sync-impl query (deletion pending 8321922b). */
    async impactRadiusSync(nodeId) {
        const impl = await this.beginOp();
        if (!impl)
            return null;
        try {
            return impl.getImpactRadius(nodeId);
        }
        catch (err) {
            await this.handleError('getImpactRadius', err);
            return null;
        }
    }
    async resolveImpl() {
        if (this.killSwitch)
            return null;
        if (this.impl)
            return this.impl;
        if (this.loadFailed)
            return null;
        for (let attempt = 0; attempt <= MCP_STARTUP_MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const backoffMs = MCP_STARTUP_BACKOFF_MS[Math.min(attempt - 1, MCP_STARTUP_BACKOFF_MS.length - 1)];
                await this.sleepMs(backoffMs);
            }
            try {
                const loaded = this.deps.loadImpl ? await this.deps.loadImpl() : await defaultLoadImpl(this.workingDir);
                if (loaded) {
                    this.impl = loaded;
                    return loaded;
                }
            }
            catch {
                // Transient load failure — fall through to the next attempt; once the
                // loop exhausts MCP_STARTUP_MAX_RETRIES, loadFailed is latched below.
            }
        }
        this.loadFailed = true;
        return null;
    }
    async sleepMs(ms) {
        const fn = this.deps.sleep;
        if (fn)
            return fn(ms);
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Race an async op against `timeoutMs`. The `done` latch guarantees EXACTLY ONE
     * terminal outcome: timeout-degrade, success, or error-degrade. A timed-out op is
     * orphaned — its later settle hits the `done` guard and is swallowed (no second
     * event, no unhandledRejection because both handlers are attached up front).
     */
    runWithTimeout(op, timeoutMs, start) {
        return new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => {
                if (done)
                    return;
                done = true;
                this.degrade(op, 'timeout');
                resolve({ ok: false });
            }, timeoutMs);
            if (typeof timer.unref === 'function')
                timer.unref();
            let work;
            try {
                work = Promise.resolve(start());
            }
            catch (err) {
                // Synchronous throw from the op factory.
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    void this.handleError(op, err).then(() => resolve({ ok: false }));
                }
                return;
            }
            work.then((value) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                resolve({ ok: true, value });
            }, (err) => {
                if (done)
                    return; // orphan rejected after timeout — swallow
                done = true;
                clearTimeout(timer);
                void this.handleError(op, err).then(() => resolve({ ok: false }));
            });
        });
    }
    /** Emit a `codegraph_degraded` with an OPEN reason string (schema `reason` is unconstrained). */
    degradeOpen(op, reason) {
        this.counters.degraded += 1;
        this.emit({ event: 'codegraph_degraded', ts: this.now(), operation: op, reason });
    }
    degrade(op, reason) {
        this.degradeOpen(op, reason);
    }
    async handleError(op, err) {
        const reason = classifyError(errMessage(err));
        this.degrade(op, reason);
        if (reason === 'corrupt')
            await this.onCorrupt();
    }
    /** Quarantine + rebuild ONCE under a file lock; a second corrupt or a failed rebuild latches. */
    async onCorrupt() {
        if (this.rebuildAttempted) {
            this.latch(); // second corrupt after a successful rebuild
            return;
        }
        this.rebuildAttempted = true;
        try {
            const rebuilt = await this.withFileLock(async () => {
                this.quarantine(this.dbPath());
                return this.rebuild();
            });
            if (!rebuilt) {
                this.latch();
                return;
            }
            this.impl = rebuilt;
        }
        catch {
            this.latch();
        }
    }
    /** Session-sticky disable. Emits exactly one terminal event, then stays inert. */
    latch() {
        if (this.latched)
            return;
        this.latched = true;
        this.counters.latched = 1;
        this.impl = null;
        this.emit({ event: 'codegraph_degraded', ts: this.now(), operation: 'latch', reason: 'error' });
    }
    quarantine(dbPath) {
        if (this.deps.quarantine) {
            this.deps.quarantine(dbPath);
            return;
        }
        fs.renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
    }
    async rebuild() {
        if (this.deps.rebuild)
            return this.deps.rebuild();
        return defaultLoadImpl(this.workingDir);
    }
    async withFileLock(fn) {
        if (this.deps.withFileLock)
            return this.deps.withFileLock(fn);
        return defaultWithFileLock(this.dbPath(), fn);
    }
    dbPath() {
        // Conventional path from the inventory (`.codegraph/codegraph.db`); the
        // injected `dbPath` wins so production can pass `getDatabasePath(workingDir)`.
        return this.deps.dbPath ?? `${this.workingDir}/.codegraph/codegraph.db`;
    }
}
/** Default lazy loader: open an existing graph, falling back to init. */
async function defaultLoadImpl(workingDir) {
    const bag = await loadCodegraphBag();
    const CodeGraph = bag.CodeGraph;
    if (!CodeGraph)
        return null;
    const graph = CodeGraph.open ? await CodeGraph.open(workingDir) : await CodeGraph.init?.(workingDir);
    return (graph ?? null);
}
/** Default file-lock wrapper using upstream `FileLock`. */
async function defaultWithFileLock(dbPath, fn) {
    const bag = await loadCodegraphBag();
    const FileLock = bag.FileLock;
    if (!FileLock)
        return fn();
    const lock = new FileLock(`${dbPath}.lock`);
    await lock.acquire();
    try {
        return await fn();
    }
    finally {
        await lock.release();
    }
}
/** Default event sink: best-effort `logActivity`, mapped to the schema shape. */
function defaultEmit(event) {
    const payload = {
        event: event.event,
        source: 'pickle',
        ts: event.ts,
    };
    if (event.reason)
        payload.reason = event.reason;
    if (event.error)
        payload.error = event.error;
    if (event.operation || event.gate_payload) {
        payload.gate_payload = {
            ...(event.operation ? { operation: event.operation } : {}),
            ...(event.gate_payload ?? {}),
        };
    }
    logActivity(payload);
}
