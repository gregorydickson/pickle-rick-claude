import * as fs from 'fs';
import type { CodegraphSettings } from '../types/index.js';
import { logActivity } from './activity-logger.js';
import { runCodegraphQueryBatch, type CodegraphQueryBatchResult } from './codegraph-query-runner.js';

// NOTE: `@colbymchenry/codegraph` is NEVER imported at module top level. It is a
// per-platform native bundle that may be absent, and the kill-switch must yield a
// fully inert instance that never loads it. All access goes through a lazy
// `await import(...)` inside `defaultLoadImpl` / the default rebuild + lock paths.
// (Static assertion shared with C9: `! grep -rn "^import.*@colbymchenry/codegraph" src/`.)

/** Failure classes distinguished by the service (PRD C1). */
export type CodegraphDegradeReason = 'locked' | 'corrupt' | 'schema_skew' | 'timeout' | 'error';

/** Monotonic per-session counters. */
export interface CodegraphCounters {
  ops: number;
  degraded: number;
  latched: number;
  /** b1089e97: `codegraph_context_injected` emissions this session. */
  injected: number;
  /** b1089e97: `codegraph_context_skipped` emissions this session. */
  skipped: number;
}

/**
 * Structural slice of the upstream `CodeGraph` instance this service depends on.
 * Per `extension/data/codegraph-api-inventory.json`: `indexAll`/`sync`/`buildContext`
 * are async (Promise-returning) and are the only timeout targets; `searchNodes`,
 * `getCallers`, and `close` are SYNCHRONOUS and therefore lose
 * the timeout claim (a synchronous call cannot be raced against a timer).
 */
export interface CodegraphImpl {
  indexAll(): Promise<unknown>;
  sync(): Promise<unknown>;
  searchNodes(query: string): unknown;
  getCallers(nodeId: string): unknown;
  buildContext(task: unknown): Promise<unknown>;
  close(): void;
}

/**
 * Canonical event shape handed to the sink. The service ALWAYS stamps `ts`
 * explicitly (never relies on the sink's default clock). The default sink maps
 * this onto the `activity-events.schema.json` shape; injected sinks (tests, C4)
 * see this canonical form directly.
 */
export interface CodegraphEmitEvent {
  event:
    | 'codegraph_index_built'
    | 'codegraph_index_failed'
    | 'codegraph_sync_completed'
    | 'codegraph_degraded';
  ts: string;
  operation?: string;
  reason?: string;
  error?: string;
  gate_payload?: Record<string, unknown>;
}

/** Injected-dependency seam (mirrors `runMcpSnapshot`'s `fetchFn` pattern in setup.ts). */
export interface CodegraphDeps {
  /** Pre-built impl — bypasses the lazy import entirely (primary test seam). */
  impl?: CodegraphImpl | null;
  /** Override the default lazy `import()` loader. Returning null = unavailable. */
  loadImpl?: () => Promise<CodegraphImpl | null>;
  /** Event sink. Default: best-effort `logActivity`. */
  emit?: (event: CodegraphEmitEvent) => void;
  /** Timestamp source. Default: `new Date().toISOString()`. */
  now?: () => string;
  /** Environment for the kill-switch read. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Rename the corrupt db aside. Default: `fs.renameSync(dbPath, dbPath + '.corrupt-<ts>')`. */
  quarantine?: (dbPath: string) => void;
  /** Rebuild the index after quarantine. Default: lazy import + fresh `CodeGraph` init. */
  rebuild?: () => Promise<CodegraphImpl | null>;
  /** Serialize rebuild under a file lock. Default: upstream `FileLock` wrap. */
  withFileLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Resolve the on-disk db path. Default: lazy `getDatabasePath(workingDir)`. */
  dbPath?: string;
  /** Sleep helper for retry/backoff — injectable for tests to skip real delays. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Killable-subprocess query runner (A1 test seam). Default delegates to
   * `runCodegraphQueryBatch`, which spawns a `detached` child and group-kills it on
   * timeout. Tests inject this to force timeout/failure outcomes without a real spawn.
   */
  runQueryBatch?: (
    input: { workingDir: string; searches: string[]; callers: string[] },
    timeoutMs: number,
  ) => Promise<CodegraphQueryBatchResult>;
}

const KILL_SWITCH_ENV = 'PICKLE_CODEGRAPH';
const KILL_SWITCH_VALUE = 'off';

// Bounded retry/backoff for serve --mcp startup: transient native-module or
// index-init failures are retried at most MCP_STARTUP_MAX_RETRIES times before
// the service degrades to codegraph_degraded.
const MCP_STARTUP_MAX_RETRIES = 2;
const MCP_STARTUP_BACKOFF_MS = [500, 1500] as const;

function classifyError(message: string): CodegraphDegradeReason {
  const m = message.toLowerCase();
  if (m.includes('database is locked')) return 'locked';
  if (m.includes('not a database') || m.includes('malformed') || m.includes('corrupt')) return 'corrupt';
  if (m.includes('schema') || m.includes('migration') || m.includes('version')) return 'schema_skew';
  return 'error';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lazy-load the upstream default bag (CJS dynamic re-export — must default-import). */
async function loadCodegraphBag(): Promise<Record<string, unknown>> {
  const mod = (await import('@colbymchenry/codegraph')) as Record<string, unknown>;
  const bag = (mod.default as Record<string, unknown> | undefined) ?? mod;
  return bag;
}

/**
 * Fail-open wrapper around `@colbymchenry/codegraph`. Never throws to callers,
 * never loads the dependency when killed, races async ops against settings
 * timeouts, classifies failures, quarantines+rebuilds-once on corruption, and
 * latches the session disabled when the index is unrecoverable.
 */
export class CodegraphService {
  private readonly workingDir: string;
  private readonly settings: CodegraphSettings;
  private readonly deps: CodegraphDeps;
  private readonly killSwitch: boolean;

  private impl: CodegraphImpl | null = null;
  private loadFailed = false;
  private loadDegradeEmitted = false;
  private latched = false;
  private rebuildAttempted = false;
  private readonly counters: CodegraphCounters = { ops: 0, degraded: 0, latched: 0, injected: 0, skipped: 0 };

  private constructor(workingDir: string, settings: CodegraphSettings, deps: CodegraphDeps) {
    this.workingDir = workingDir;
    this.settings = settings;
    this.deps = deps;
    const env = deps.env ?? process.env;
    this.killSwitch = env[KILL_SWITCH_ENV] === KILL_SWITCH_VALUE;
    if (deps.impl) this.impl = deps.impl;
  }

  static create(workingDir: string, settings: CodegraphSettings, deps: CodegraphDeps = {}): CodegraphService {
    return new CodegraphService(workingDir, settings, deps);
  }

  getSessionCounters(): CodegraphCounters {
    return { ...this.counters };
  }

  /** b1089e97: record a `codegraph_context_injected` emission (count only — no event). */
  recordContextInjected(): void {
    this.counters.injected += 1;
  }

  /** b1089e97: record a `codegraph_context_skipped` emission (count only — no event). */
  recordContextSkipped(): void {
    this.counters.skipped += 1;
  }

  /** True while the instance answers every call with null and emits nothing. */
  private get inert(): boolean {
    return this.killSwitch || this.latched;
  }

  close(): void {
    // Sync per inventory. Never load the dependency just to close it.
    if (this.killSwitch || !this.impl) return;
    try {
      this.impl.close();
    } catch {
      // Releasing resources must never throw to the caller.
    }
    this.impl = null;
  }

  async indexAll(): Promise<unknown | null> {
    const impl = await this.beginOp();
    if (!impl) return null;
    const t0 = Date.now();
    const result = await this.runWithTimeout('indexAll', this.settings.index_timeout_ms, () => impl.indexAll());
    if (result.ok) {
      const duration_ms = Date.now() - t0;
      const v = result.value as Record<string, unknown> | null | undefined;
      const files_indexed = typeof v?.filesIndexed === 'number' ? (v.filesIndexed as number) : undefined;
      this.emit({
        event: 'codegraph_index_built',
        ts: this.now(),
        operation: 'indexAll',
        gate_payload: { duration_ms, ...(files_indexed !== undefined ? { files_indexed } : {}) },
      });
    }
    return result.ok ? result.value : null;
  }

  async sync(): Promise<unknown | null> {
    const impl = await this.beginOp();
    if (!impl) return null;
    const result = await this.runWithTimeout('sync', this.settings.sync_timeout_ms, () => impl.sync());
    if (result.ok) this.emit({ event: 'codegraph_sync_completed', ts: this.now(), operation: 'sync' });
    return result.ok ? result.value : null;
  }

  async buildContext(task: unknown): Promise<unknown | null> {
    const impl = await this.beginOp();
    if (!impl) return null;
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
  async runQueryBatch(searches: string[], callers: string[]): Promise<CodegraphQueryBatchResult> {
    if (this.inert) { return { status: 'ok', searches: {}, callers: {} }; }
    this.counters.ops += 1;
    const run =
      this.deps.runQueryBatch ??
      ((input, ms): Promise<CodegraphQueryBatchResult> =>
        runCodegraphQueryBatch(input, { timeoutMs: ms, ...(this.deps.env ? { env: this.deps.env } : {}) }));
    let result: CodegraphQueryBatchResult;
    try {
      result = await run(
        { workingDir: this.workingDir, searches, callers },
        this.settings.query_timeout_ms,
      );
    } catch {
      this.degradeOpen('query', 'runner-threw');
      return { status: 'failed', reason: 'runner-threw' };
    }
    if (result.status === 'timeout' || result.status === 'failed') {
      this.degradeOpen('query', result.reason);
    }
    return result;
  }

  async searchNodes(query: string): Promise<unknown | null> {
    // Behind the subprocess boundary (A1) — no in-process sync query is reachable.
    const r = await this.runQueryBatch([query], []);
    return r.status === 'ok' ? (r.searches[query] ?? []) : null;
  }

  async getCallers(nodeId: string): Promise<unknown | null> {
    // Behind the subprocess boundary (A1) — no in-process sync query is reachable.
    const r = await this.runQueryBatch([], [nodeId]);
    return r.status === 'ok' ? (r.callers[nodeId] ?? []) : null;
  }

  // --- internals -----------------------------------------------------------

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private emit(event: CodegraphEmitEvent): void {
    try {
      if (this.deps.emit) {
        this.deps.emit(event);
        return;
      }
      defaultEmit(event);
    } catch {
      // Telemetry must never break the caller.
    }
  }

  /** Gate the op (inert short-circuit), resolve the impl, and count a live op. */
  private async beginOp(): Promise<CodegraphImpl | null> {
    if (this.inert) return null;
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

  private async resolveImpl(): Promise<CodegraphImpl | null> {
    if (this.killSwitch) return null;
    if (this.impl) return this.impl;
    if (this.loadFailed) return null;
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
      } catch {
        // Transient load failure — fall through to the next attempt; once the
        // loop exhausts MCP_STARTUP_MAX_RETRIES, loadFailed is latched below.
      }
    }
    this.loadFailed = true;
    return null;
  }

  private async sleepMs(ms: number): Promise<void> {
    const fn = this.deps.sleep;
    if (fn) return fn(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Race an async op against `timeoutMs`. The `done` latch guarantees EXACTLY ONE
   * terminal outcome: timeout-degrade, success, or error-degrade. A timed-out op is
   * orphaned — its later settle hits the `done` guard and is swallowed (no second
   * event, no unhandledRejection because both handlers are attached up front).
   */
  private runWithTimeout(
    op: string,
    timeoutMs: number,
    start: () => Promise<unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.degrade(op, 'timeout');
        resolve({ ok: false });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      let work: Promise<unknown>;
      try {
        work = Promise.resolve(start());
      } catch (err) {
        // Synchronous throw from the op factory.
        if (!done) {
          done = true;
          clearTimeout(timer);
          void this.handleError(op, err).then(() => resolve({ ok: false }));
        }
        return;
      }

      work.then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: true, value });
        },
        (err) => {
          if (done) return; // orphan rejected after timeout — swallow
          done = true;
          clearTimeout(timer);
          void this.handleError(op, err).then(() => resolve({ ok: false }));
        },
      );
    });
  }

  /** Emit a `codegraph_degraded` with an OPEN reason string (schema `reason` is unconstrained). */
  private degradeOpen(op: string, reason: string): void {
    this.counters.degraded += 1;
    this.emit({ event: 'codegraph_degraded', ts: this.now(), operation: op, reason });
  }

  private degrade(op: string, reason: CodegraphDegradeReason): void {
    this.degradeOpen(op, reason);
  }

  private async handleError(op: string, err: unknown): Promise<void> {
    const reason = classifyError(errMessage(err));
    this.degrade(op, reason);
    if (reason === 'corrupt') await this.onCorrupt();
  }

  /** Quarantine + rebuild ONCE under a file lock; a second corrupt or a failed rebuild latches. */
  private async onCorrupt(): Promise<void> {
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
    } catch {
      this.latch();
    }
  }

  /** Session-sticky disable. Emits exactly one terminal event, then stays inert. */
  private latch(): void {
    if (this.latched) return;
    this.latched = true;
    this.counters.latched = 1;
    this.impl = null;
    this.emit({ event: 'codegraph_degraded', ts: this.now(), operation: 'latch', reason: 'error' });
  }

  private quarantine(dbPath: string): void {
    if (this.deps.quarantine) {
      this.deps.quarantine(dbPath);
      return;
    }
    fs.renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
  }

  private async rebuild(): Promise<CodegraphImpl | null> {
    if (this.deps.rebuild) return this.deps.rebuild();
    return defaultLoadImpl(this.workingDir);
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.deps.withFileLock) return this.deps.withFileLock(fn);
    return defaultWithFileLock(this.dbPath(), fn);
  }

  private dbPath(): string {
    // Conventional path from the inventory (`.codegraph/codegraph.db`); the
    // injected `dbPath` wins so production can pass `getDatabasePath(workingDir)`.
    return this.deps.dbPath ?? `${this.workingDir}/.codegraph/codegraph.db`;
  }
}

/** Default lazy loader: open an existing graph, falling back to init. */
async function defaultLoadImpl(workingDir: string): Promise<CodegraphImpl | null> {
  const bag = await loadCodegraphBag();
  const CodeGraph = bag.CodeGraph as
    | { open?: (root: string) => Promise<unknown>; init?: (root: string) => Promise<unknown> }
    | undefined;
  if (!CodeGraph) return null;
  const graph = CodeGraph.open ? await CodeGraph.open(workingDir) : await CodeGraph.init?.(workingDir);
  return (graph ?? null) as CodegraphImpl | null;
}

/** Default file-lock wrapper using upstream `FileLock`. */
async function defaultWithFileLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  const bag = await loadCodegraphBag();
  const FileLock = bag.FileLock as
    | (new (p: string) => { acquire: () => Promise<void>; release: () => Promise<void> | void })
    | undefined;
  if (!FileLock) return fn();
  const lock = new FileLock(`${dbPath}.lock`);
  await lock.acquire();
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** Default event sink: best-effort `logActivity`, mapped to the schema shape. */
function defaultEmit(event: CodegraphEmitEvent): void {
  const payload: Parameters<typeof logActivity>[0] = {
    event: event.event,
    source: 'pickle',
    ts: event.ts,
  };
  if (event.reason) payload.reason = event.reason;
  if (event.error) payload.error = event.error;
  if (event.operation || event.gate_payload) {
    payload.gate_payload = {
      ...(event.operation ? { operation: event.operation } : {}),
      ...(event.gate_payload ?? {}),
    };
  }
  logActivity(payload);
}
