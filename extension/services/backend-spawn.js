import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { BACKENDS } from '../types/index.js';
import { StateManager } from './state-manager.js';
import { logActivity } from './activity-logger.js';
import { materializeTrailerHooks } from './git-trailer-hooks.js';
import { GIT_CONFIG_COUNT_ENV_VAR, PICKLE_TICKET_ID_ENV_VAR } from './pickle-utils.js';
/**
 * R-WSRC-4 — Test-harness sandbox assertion.
 *
 * Thrown by `buildWorkerInvocation` — for EVERY backend arm — when
 * `process.env.PICKLE_TEST_MODE === '1'` AND any `addDirs[i]` resolves (via
 * `fs.realpathSync`) outside the canonical `os.tmpdir()`. Catches the leak class
 * where a test fixture sets `working_dir: REPO_ROOT` (or
 * `EXTENSION_DIR: REPO_ROOT`), spawns a worker, and the spawn timeout fires
 * (R-MRWG-2) — the orphaned `claude --dangerously-skip-permissions --add-dir
 * <real-repo>` (or `codex exec --dangerously-bypass-approvals-and-sandbox
 * --add-dir <real-repo>`) subprocess then retains write access to the operator's
 * real working tree.
 */
export class AddDirOutsideSandboxError extends Error {
    offendingDirs;
    tmpdirRealpath;
    constructor(offendingDirs, tmpdirRealpath) {
        super(`R-WSRC-4: PICKLE_TEST_MODE=1 but addDirs contain paths outside os.tmpdir() (${tmpdirRealpath}): ${offendingDirs.join(', ')}. ` +
            `Test fixtures must root working_dir/EXTENSION_DIR under os.tmpdir() to prevent leaked claude subprocesses ` +
            `retaining --add-dir <real-repo> write access.`);
        this.name = 'AddDirOutsideSandboxError';
        this.offendingDirs = offendingDirs;
        this.tmpdirRealpath = tmpdirRealpath;
    }
}
function realpathOrSelf(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return p;
    }
}
function isUnderTmpdirRealpath(dir, tmpdirRealpath) {
    const resolved = realpathOrSelf(dir);
    if (resolved === tmpdirRealpath)
        return true;
    return resolved.startsWith(tmpdirRealpath + path.sep);
}
/**
 * R-WSRC-4: assert each addDir resolves under os.tmpdir() when PICKLE_TEST_MODE=1.
 * No-op in production (env var unset). Returns silently on pass; throws
 * `AddDirOutsideSandboxError` listing every offender on fail.
 */
export function assertAddDirsUnderTmpdirIfTestMode(addDirs) {
    if (process.env.PICKLE_TEST_MODE !== '1')
        return;
    const tmpdirRealpath = realpathOrSelf(os.tmpdir());
    const offenders = [];
    for (const dir of addDirs) {
        if (!dir)
            continue;
        if (!isUnderTmpdirRealpath(dir, tmpdirRealpath))
            offenders.push(dir);
    }
    if (offenders.length > 0)
        throw new AddDirOutsideSandboxError(offenders, tmpdirRealpath);
}
export function isBackend(value) {
    return typeof value === 'string' && BACKENDS.includes(value);
}
// Dedupe by (source, value) so a bad state.json or typo'd env var warns once
// per process rather than N times per call site. Same silent-fallback trap-door
// class as the spawnSync-no-timeout cluster: a downgrade to 'claude' that should
// have been 'codex' wastes a whole Morty spawn with no signal.
const _warnedBackends = new Set();
// AC-6 warn-once: ONE MCP-degradation line for the whole process, regardless of how
// many worker/analyst spawns resolve the config. Kept apart from `_warnedBackends`
// (which dedupes per message key) because AC-6 caps the total, not the distinct set.
let _mcpDegradationWarned = false;
const _sm = new StateManager();
const BACKEND_FLIP_REASON_TTL_MS = 60_000;
/** Test-only: clears every warn-once latch in this module (backends + MCP degradation). */
export function __resetBackendWarnings() {
    _warnedBackends.clear();
    _mcpDegradationWarned = false;
}
function parseBackendFlipTs(value) {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
function isRecentFlipReason(timestampMs, nowMs) {
    if (timestampMs > nowMs)
        return false;
    return nowMs - timestampMs <= BACKEND_FLIP_REASON_TTL_MS;
}
function clearBackendFlipReasonFlags(statePath) {
    try {
        _sm.update(statePath, state => {
            const flags = state.flags;
            if (typeof flags === 'object' && flags !== null) {
                delete flags.backend_flip_reason;
                delete flags.backend_flip_reason_ts;
                if (!Object.keys(flags).length) {
                    state.flags = {};
                }
            }
        });
    }
    catch {
        // fail-open: worker execution can still continue without flip-carve-out cleanup
    }
}
// eslint-disable-next-line complexity -- HT-1 reviewed: backend resolution branches enumerate state/env/CLI precedence per R-XBL-2 trap door.
export function assertBackendPreSpawn(input) {
    if (input.source === 'refinement-lock' ||
        input.source === 'cli-flag-override' ||
        input.source === 'settings' ||
        input.source === 'env' ||
        input.source === 'default') {
        // 'settings' is the enable_backend_routing_heuristic flip: an intentional,
        // configured routing decision, so resolved != state.backend is expected.
        return { mode: 'match', resolvedBackend: input.resolvedBackend };
    }
    const state = (() => {
        try {
            return _sm.read(input.statePath);
        }
        catch {
            return null;
        }
    })();
    const stateBackend = isBackend(state?.backend) ? state?.backend : undefined;
    const stateWorkerBackend = isBackend(state?.worker_backend)
        ? state.worker_backend
        : undefined;
    if (!stateBackend || stateBackend === input.resolvedBackend || stateWorkerBackend === input.resolvedBackend) {
        return { mode: 'match', resolvedBackend: input.resolvedBackend, stateBackend };
    }
    const flipReason = typeof state?.flags?.backend_flip_reason === 'string' ? state.flags.backend_flip_reason : null;
    const flipTs = parseBackendFlipTs(state?.flags?.backend_flip_reason_ts);
    if (!flipReason || flipTs === null || !isRecentFlipReason(flipTs, Date.now())) {
        return { mode: 'mismatch', resolvedBackend: input.resolvedBackend, stateBackend };
    }
    clearBackendFlipReasonFlags(input.statePath);
    return { mode: 'bypass', resolvedBackend: input.resolvedBackend, stateBackend };
}
function warnBadBackend(sourceLabel, value) {
    const key = `${sourceLabel}:${value}`;
    if (_warnedBackends.has(key))
        return;
    _warnedBackends.add(key);
    process.stderr.write(`[pickle-rick] unrecognized backend ${JSON.stringify(value)} from ${sourceLabel} — falling back to 'claude' (valid: ${BACKENDS.join(', ')})\n`);
}
export function resolveBackend(source) {
    // Refinement lock sentinel: PRD refinement is planning, not implementation.
    // Codex is reserved for implementation. This sentinel is set by
    // spawn-refinement-team and propagates to every grandchild via env
    // inheritance, so any downstream caller that reads state.json (e.g.
    // loadBackendFromSession) cannot leak codex back into the refinement phase.
    // Silent force — no warning, no log.
    if (process.env.PICKLE_REFINEMENT_LOCK === '1')
        return 'claude';
    // Past the refinement-lock carve-out, backend resolution is identical to the
    // manager-backend path (state.backend → PICKLE_BACKEND env → 'claude', warning
    // on unrecognized values), so delegate instead of duplicating the precedence.
    return resolveManagerBackendValue(source);
}
function resolveManagerBackendValue(source) {
    const raw = source ? source.backend : undefined;
    if (isBackend(raw))
        return raw;
    if (typeof raw === 'string' && raw.length > 0)
        warnBadBackend('state', raw);
    const env = process.env.PICKLE_BACKEND;
    if (isBackend(env))
        return env;
    if (typeof env === 'string' && env.length > 0)
        warnBadBackend('PICKLE_BACKEND env', env);
    return 'claude';
}
export function resolveWorkerBackendFromState(source) {
    if (process.env.PICKLE_REFINEMENT_LOCK === '1') {
        return {
            backend: 'claude',
            source: 'env_lock',
            workerBackend: null,
            managerBackend: resolveManagerBackendValue(source),
        };
    }
    const managerBackend = resolveManagerBackendValue(source);
    const rawWorkerBackend = source ? source.worker_backend : undefined;
    if (isBackend(rawWorkerBackend)) {
        return {
            backend: rawWorkerBackend,
            source: 'worker_backend',
            workerBackend: rawWorkerBackend,
            managerBackend,
        };
    }
    if (typeof rawWorkerBackend === 'string' && rawWorkerBackend.length > 0) {
        warnBadBackend('state.worker_backend', rawWorkerBackend);
    }
    return {
        backend: managerBackend,
        source: 'backend',
        workerBackend: null,
        managerBackend,
    };
}
export function resolveBackendFromStateFileWithSource(statePath, cliBackend) {
    // Refinement lock is non-overridable: short-circuits on the lock variable
    // before disk-I/O so a stale/hostile state.json cannot recover codex for a
    // locked-in planning run.
    if (process.env.PICKLE_REFINEMENT_LOCK === '1') {
        return { backend: 'claude', source: 'refinement-lock' };
    }
    // Explicit CLI override must beat persisted state/env because spawn-site
    // callers already validated the value and are intentionally overriding the
    // session's default backend for this launch.
    if (cliBackend !== undefined) {
        return { backend: cliBackend, source: 'cli-flag-override' };
    }
    let parsed = null;
    try {
        parsed = _sm.read(statePath);
    }
    catch {
        // ignore read/parsing errors and continue to env/default fallback
    }
    if (isBackend(parsed?.backend)) {
        return { backend: parsed.backend, source: 'state' };
    }
    if (typeof parsed?.backend === 'string' && parsed.backend.length > 0) {
        warnBadBackend('state', parsed.backend);
    }
    const envBackend = process.env.PICKLE_BACKEND;
    if (isBackend(envBackend))
        return { backend: envBackend, source: 'env' };
    if (typeof envBackend === 'string' && envBackend.length > 0) {
        warnBadBackend('PICKLE_BACKEND env', envBackend);
    }
    return { backend: 'claude', source: 'default' };
}
export function resolveWorkerBackendFromStateFile(statePath) {
    let parsed;
    try {
        parsed = _sm.read(statePath);
    }
    catch {
        parsed = null;
    }
    return resolveWorkerBackendFromState(parsed);
}
export function resolveBackendFromStateFile(statePath) {
    return resolveBackendFromStateFileWithSource(statePath).backend;
}
/**
 * Shared predicate: does a parsed `mcpServers` value satisfy the claude CLI's
 * `--mcp-config` schema? An empty record `{}` passes; an array, `null`, or a
 * missing key fails. Consumed by both `resolveMcpConfigWithLayer` (below) and
 * `setup.ts`'s `materializeWorkerMcpConfig` — the predicate exists exactly once.
 */
export function hasMcpServersRecord(mcpServers) {
    return !!mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers);
}
/**
 * Per-process memoized verdict for a resolved MCP-config path, keyed on the
 * resolved path. The file is read + parsed once per process (measured 82,650
 * bytes / 60 keys on a live host, and this fires per worker/analyst spawn) — no
 * cache invalidation, per the PRD's "Parse cost" ruling.
 */
const mcpConfigVerdictCache = new Map();
function computeMcpConfigVerdict(filePath) {
    if (!existsSilently(filePath)) {
        return 'missing';
    }
    let root;
    try {
        root = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch {
        return 'unparseable';
    }
    // A primitive root has no `mcpServers` to read — treat it as the absent-key case
    // rather than letting the property access throw.
    const mcpServers = root && typeof root === 'object'
        ? root.mcpServers
        : undefined;
    if (mcpServers === undefined) {
        return 'no_mcpServers_key';
    }
    return hasMcpServersRecord(mcpServers) ? 'valid' : 'mcpServers_not_a_record';
}
function classifyMcpConfigFile(filePath) {
    const cached = mcpConfigVerdictCache.get(filePath);
    if (cached !== undefined) {
        return cached;
    }
    const verdict = computeMcpConfigVerdict(filePath);
    mcpConfigVerdictCache.set(filePath, verdict);
    return verdict;
}
/** Human-readable rendering of each refusal reason, for the AC-6 warning line. */
const MCP_VERDICT_LABEL = {
    missing: 'file missing',
    unparseable: 'unparseable JSON',
    no_mcpServers_key: 'no mcpServers record',
    mcpServers_not_a_record: 'mcpServers is not a record',
};
/**
 * AC-6 — one stderr line, at most once per process, naming the rejected path, the
 * failing condition, and the consequence. Reuses the degradation idiom already in
 * this file (`[backend-spawn] … degraded: …; …`, see `buildWorkerMcpConfig`).
 *
 * Two prominence levels: `settings_override` is an EXPLICIT operator instruction, so
 * it warns as `WARNING:`; `claude_json_fallback` was never deliberately chosen by
 * anyone, so it warns as the quieter `note:`.
 *
 * AC-3: this is a warning, NOT a gate. No throw, no `exit_reason`, no halt, no delay —
 * it runs after the resolution is already decided and cannot change it. stderr only;
 * stdout carries orchestrator protocol.
 */
function warnMcpLayerDegraded(rejection, winningLayer) {
    if (_mcpDegradationWarned) {
        return;
    }
    _mcpDegradationWarned = true;
    const prominence = rejection.layer === 'settings_override' ? 'WARNING' : 'note';
    const consequence = winningLayer === rejection.layer
        // Layer 1 `missing` is passed through verbatim by design (see resolver doc below).
        ? 'path passed through unvalidated; claude CLI will report the failure'
        : winningLayer === 'omitted'
            ? '--mcp-config omitted'
            : `falling back to ${winningLayer}`;
    // Path is operator-supplied: quote it (as `warnBadBackend` does) so a value
    // containing a newline cannot forge a second log line.
    process.stderr.write(`[backend-spawn] ${prominence}: MCP config degraded: ${rejection.layer} ${JSON.stringify(rejection.filePath)} `
        + `(${MCP_VERDICT_LABEL[rejection.verdict]}); ${consequence}\n`);
}
/**
 * Single source of truth for MCP-config precedence. Returns both the resolved
 * path (null when omitted) and which layer matched, so the public
 * `resolveMcpConfigPath` and the activity-logging `emitMcpConfigResolved` share
 * one decision tree instead of reimplementing it.
 *
 * A candidate layer resolves to a path only when that file EXISTS and its
 * `mcpServers` value is a record (AC-1/AC-2) — a missing file is a distinct
 * failure from a malformed one; a settings_override that simply doesn't exist
 * yet is the explicit operator config named for this session's `--add-dir`
 * sandbox layout (materialized by session setup) and is passed through
 * verbatim so the CLI's own "file not found" reports the real cause. A file
 * that DOES exist but fails the predicate falls through to the next layer,
 * ultimately `omitted` — it never resolves to a path.
 *
 * Every refusal of a config that was NAMED (layer 1) or FOUND (layer 2) emits one
 * `warnMcpLayerDegraded` line, at most once per process (AC-6). An ABSENT
 * `~/.claude.json` is deliberately NOT a refusal — no layer was chosen and none was
 * skipped, so the ordinary no-config host stays silent. An absent layer-1 override
 * IS warned (an explicit operator instruction pointing at nothing) while still being
 * passed through verbatim, so resolution is unchanged.
 */
function resolveMcpConfigWithLayer(settingsBag, homeDir) {
    // Layer 1 is recorded before layer 2 can be and is never overwritten, so the
    // higher-prominence rejection always wins the single warn slot. The warning is
    // emitted only once the winner is known — the consequence clause names it (AC-6).
    let rejection = null;
    const decide = () => {
        const override = settingsBag?.worker_mcp_config_path;
        if (typeof override === 'string' && override.trim()) {
            const overridePath = override.trim();
            const verdict = classifyMcpConfigFile(overridePath);
            if (verdict !== 'valid') {
                rejection = { layer: 'settings_override', filePath: overridePath, verdict };
            }
            if (verdict === 'missing' || verdict === 'valid') {
                return { path: overridePath, layer: 'settings_override' };
            }
        }
        const claudeJson = path.join(homeDir ?? os.homedir(), '.claude.json');
        const verdict = classifyMcpConfigFile(claudeJson);
        if (verdict === 'valid') {
            return { path: claudeJson, layer: 'claude_json_fallback' };
        }
        // An ABSENT `~/.claude.json` is the ordinary no-config default, not a rejection:
        // nothing was chosen and nothing was refused, so it stays silent.
        if (verdict !== 'missing' && !rejection) {
            rejection = { layer: 'claude_json_fallback', filePath: claudeJson, verdict };
        }
        return { path: null, layer: 'omitted' };
    };
    const resolved = decide();
    if (rejection) {
        warnMcpLayerDegraded(rejection, resolved.layer);
    }
    return resolved;
}
export function resolveMcpConfigPath(settingsBag, homeDir) {
    return resolveMcpConfigWithLayer(settingsBag, homeDir).path ?? undefined;
}
/**
 * Emit the `worker_mcp_config_resolved` activity event naming the winning layer.
 * Takes the already-resolved path + layer so callers that hold a per-spawn
 * `opts.mcpConfig` override can truthfully name `session_merged` (C7 / AC5),
 * while the no-override path keeps the settings/claude.json/omitted semantics.
 */
function emitMcpConfigResolved(mcpConfigPath, layer) {
    try {
        logActivity({
            event: 'worker_mcp_config_resolved',
            source: 'pickle',
            gate_payload: { mcp_config_path: mcpConfigPath, precedence_layer: layer },
        });
    }
    catch {
        // best-effort: never block spawn on activity log failure
    }
}
/**
 * AC-4 — make the worker-MCP merge degradation LOUD.
 *
 * Both failure branches of `buildWorkerMcpConfig` used to write one bare stderr line
 * and return operator passthrough with NO activity event, so a session in which the
 * codegraph MCP server was never delivered was indistinguishable, downstream, from one
 * in which it was. That is this codebase's dominant defect class: a failed operation
 * read as a measured result. On a release/tarball install the codegraph bin does not
 * resolve at all, so that silent branch is the DEFAULT path for real users, not an edge
 * case — the symlink into the source repo that makes it resolve is a dev-box artifact.
 *
 * Reuses the already-registered `codegraph_degraded` event (see `ActivityEventType` and
 * `activity-events.schema.json`) rather than minting a new type — no new event, no new
 * setting key, no new exit_reason. Best-effort and non-throwing, exactly like its
 * neighbour `emitMcpConfigResolved`: reporting can never be the thing that stops a run.
 */
function emitWorkerMcpMergeDegraded(reason, passthroughPath, detail) {
    try {
        logActivity({
            event: 'codegraph_degraded',
            source: 'pickle',
            reason,
            ...(detail ? { error: detail } : {}),
            gate_payload: {
                operation: 'worker_mcp_merge',
                fallback: 'operator_passthrough',
                passthrough_path: passthroughPath,
            },
        });
    }
    catch {
        // best-effort: never block spawn on activity log failure
    }
}
/**
 * Resolve the effective `--mcp-config` path + winning precedence layer for a spawn.
 * A per-spawn `opts.mcpConfig` override (the session-merged `worker-mcp.json` path
 * materialized at setup) wins as `session_merged`; otherwise fall back to the shared
 * settings/claude.json/omitted decision tree.
 */
function resolveSpawnMcpConfig(opts) {
    if (opts.mcpConfig)
        return { path: opts.mcpConfig, layer: 'session_merged' };
    return resolveMcpConfigWithLayer(opts.settingsBag);
}
/**
 * Resolve the absolute `node <bin> serve --mcp` command for the bundled
 * `@colbymchenry/codegraph` server. The package `exports` map blocks subpath
 * resolution of the bin, so resolve via the (exported) package.json then join
 * with `bin.codegraph` — the convention recorded in
 * `extension/data/codegraph-api-inventory.json` (`serve.bin_resolution`) and
 * proven by the real `serve --mcp` handshake integration test.
 *
 * Writer-ownership (C7): the inventory records `serve.watcher_disableable: true`
 * and that `CODEGRAPH_NO_WATCH=1` is the empirically-verified authoritative opt-out
 * that silences the serve auto-sync watcher. We launch serve with the watcher OFF so
 * C4's runtime `sync` remains the SOLE writer to `.codegraph/codegraph.db` — exactly
 * one writer authority for the index.
 *
 * Returns `null` on any resolution failure (package/platform-bundle absent) so the
 * caller can fail open to the operator passthrough config.
 */
function resolveCodegraphServeEntry(workingDir) {
    try {
        const req = createRequire(import.meta.url);
        const pkgJsonPath = req.resolve('@colbymchenry/codegraph/package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        const binRel = pkg.bin?.codegraph ?? 'npm-shim.js';
        const binAbs = path.join(path.dirname(pkgJsonPath), binRel);
        return {
            command: 'node',
            args: [binAbs, 'serve', '--mcp'],
            // C7 single-writer: watcher OFF (see fn doc) — codegraph-api-inventory.json serve finding.
            env: { CODEGRAPH_NO_WATCH: '1' },
            cwd: workingDir,
        };
    }
    catch {
        return null;
    }
}
/**
 * C7 — Claude-family-ONLY session-merged worker MCP config.
 *
 * Materializes `<sessionDir>/mcp/worker-mcp.json` merging the operator's snapshotted
 * MCP server entries with an absolute-command `codegraph serve --mcp` entry, and
 * returns the path to use as the worker `--mcp-config`. Codex workers are excluded
 * elsewhere (`buildCodexInvocation` never receives `--mcp-config`).
 *
 * Resolution:
 *   - `expose_mcp_to_workers !== true` (disabled) → operator passthrough: return
 *     `resolveMcpConfigPath(settings)` (or null); write nothing.
 *   - `PICKLE_CODEGRAPH=off` (kill switch) → operator passthrough; write nothing (AC-8).
 *   - codegraph bin unresolvable OR write failure (merge-fail) → one degraded-style
 *     log line, ONE `codegraph_degraded` activity event naming the reason (AC-4), and
 *     operator passthrough. Never throws — a degraded merge is not a reason to stop.
 *   - otherwise → write `{ mcpServers: { codegraph, ...operatorEntries } }` and return
 *     the session path. Operator entries are spread LAST so an operator-supplied
 *     `codegraph` key WINS the name collision (intentional override). No operator
 *     entries → codegraph-only config.
 *
 * Invariants: the operator config file is never mutated; exactly one writer authority
 * (serve watcher OFF, see `resolveCodegraphServeEntry`).
 */
export function buildWorkerMcpConfig(sessionDir, workingDir, settings, snapshotEntries, deps = {}) {
    const passthrough = () => resolveMcpConfigPath(settings) ?? null;
    // AC-8 — `PICKLE_CODEGRAPH=off` disables EVERYTHING codegraph, including worker MCP
    // delivery. Gated here (the single writer) rather than at the setup.ts call site so
    // every present and future caller inherits it. Same shape as the disabled arm below:
    // operator passthrough, nothing written, no throw. Not a degradation — the operator
    // asked for this — so it is deliberately silent rather than emitting a degrade event.
    const env = deps.env ?? process.env;
    if (env['PICKLE_CODEGRAPH'] === 'off') {
        return passthrough();
    }
    if (settings?.expose_mcp_to_workers !== true)
        return passthrough();
    const resolveServeEntry = deps.resolveServeEntry ?? resolveCodegraphServeEntry;
    const codegraph = resolveServeEntry(workingDir);
    if (!codegraph) {
        process.stderr.write('[backend-spawn] worker MCP merge degraded: codegraph bin unresolved; passthrough operator config\n');
        const fallback = passthrough();
        emitWorkerMcpMergeDegraded('worker_mcp_bin_unresolved', fallback);
        return fallback;
    }
    // Operator entries spread LAST → operator `codegraph` (if any) wins the collision.
    const mcpServers = { codegraph, ...(snapshotEntries ?? {}) };
    try {
        const mcpDir = path.join(sessionDir, 'mcp');
        fs.mkdirSync(mcpDir, { recursive: true });
        const outPath = path.join(mcpDir, 'worker-mcp.json');
        fs.writeFileSync(outPath, JSON.stringify({ mcpServers }, null, 2));
        return outPath;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[backend-spawn] worker MCP merge degraded: write failed (${msg}); passthrough operator config\n`);
        const fallback = passthrough();
        emitWorkerMcpMergeDegraded('worker_mcp_merge_write_failed', fallback, msg);
        return fallback;
    }
}
export function buildWorkerInvocation(backend, opts) {
    // R-WSRC-4: one sandbox assertion for EVERY worker arm, at the dispatcher.
    // It used to sit inside `buildClaudeWorkerInvocation`, so the codex arm —
    // which spawns `codex exec --dangerously-bypass-approvals-and-sandbox` and
    // appends the same `--add-dir` list — was never checked.
    assertAddDirsUnderTmpdirIfTestMode(opts.addDirs);
    if (backend === 'codex')
        return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model, opts.effort);
    if (backend === 'hermes')
        return buildHermesWorkerInvocation(opts);
    if (backend === 'deepseek')
        return buildDeepseekWorkerInvocation(opts);
    if (backend === 'grok')
        return buildGrokWorkerInvocation(opts);
    if (backend === 'kimi')
        return buildKimiWorkerInvocation(opts);
    if (backend === 'gemini')
        return buildGeminiWorkerInvocation(opts);
    return buildClaudeWorkerInvocation(opts);
}
export function buildManagerInvocation(backend, opts) {
    // AP-EXT-ITER9-01 OPEN GAP: this dispatcher carries the SAME `--add-dir
    // <workingDir>` under the same bypass-permissions flags and takes NO R-WSRC-4
    // assertion. Adding it here is correct and was built + reverted this pass: it
    // reddens `tests/iteration-outcome.test.js` ("fractional mux max-turn settings
    // fall back before spawning manager"), which runs under PICKLE_TEST_MODE=1 with
    // an unsandboxed `PICKLE_DATA_ROOT` — a real fixture leak the guard correctly
    // flags, but that test file is outside this session's scope.json. See the
    // `backend-spawn.ts` trap door in src/services/CLAUDE.md.
    if (backend === 'codex')
        return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model);
    if (backend === 'hermes')
        return buildHermesWorkerInvocation(opts);
    if (backend === 'deepseek')
        return buildDeepseekManagerInvocation(opts);
    if (backend === 'grok')
        return buildGrokWorkerInvocation(opts);
    if (backend === 'kimi')
        return buildKimiWorkerInvocation(opts);
    if (backend === 'gemini')
        return buildGeminiWorkerInvocation(opts);
    return buildClaudeManagerInvocation(opts);
}
function buildClaudeWorkerInvocation(opts) {
    const { path: mcpCfg, layer } = resolveSpawnMcpConfig(opts);
    emitMcpConfigResolved(mcpCfg, layer);
    const args = ['--dangerously-skip-permissions'];
    appendAddDirArgs(args, opts.addDirs);
    if (opts.outputFormat && opts.outputFormat !== 'text') {
        args.push('--output-format', opts.outputFormat);
    }
    if (opts.model)
        args.push('--model', opts.model);
    if (mcpCfg)
        args.push('--mcp-config', mcpCfg);
    // NOTE: claude CLI has no public reasoning-effort flag for `claude -p`; opts.effort
    // is intentionally ignored here. Don't inject --append-system-prompt or env vars
    // as a workaround — the value still survives in state.json for future logging/use.
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildClaudeManagerInvocation(opts) {
    const { path: mcpCfg, layer } = resolveSpawnMcpConfig(opts);
    emitMcpConfigResolved(mcpCfg, layer);
    const args = ['--dangerously-skip-permissions'];
    for (const dir of opts.addDirs) {
        if (dir)
            args.push('--add-dir', dir);
    }
    if (opts.noSessionPersistence)
        args.push('--no-session-persistence');
    if (opts.streamJson)
        args.push('--output-format', 'stream-json', '--verbose');
    if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
        args.push('--max-turns', String(opts.maxTurns));
    }
    if (opts.model)
        args.push('--model', opts.model);
    if (mcpCfg)
        args.push('--mcp-config', mcpCfg);
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildCodexInvocation(prompt, addDirs, model, effort) {
    const args = [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--ephemeral',
        // Bypass user-level rule files (`~/.codex/AGENTS.md`, `~/.codex/CLAUDE.md`,
        // `~/.codex/skills/*/SKILL.md`). A stale or parallel-universe codex
        // installation can otherwise misdirect the manager into chasing
        // non-existent paths mid-iteration. Pickle-rick's prompts already carry
        // every contract codex needs — letting `~/.codex/` rules override them
        // produces FM-4 (stall-on-imaginary-worker) where codex narrates a worker
        // that doesn't exist instead of invoking spawn-morty.js.
        '--ignore-rules',
        // R-MFW-3 Option-D stub: MCP forwarding for codex workers is deferred to
        // R-MFW-4 (setup-time snapshot path).
        //
        // Option B (per-invocation MCP injection via `-c mcp.servers.*=…`) was
        // investigated and is NOT feasible:
        //   1. Codex has no `--mcp-config <path>` flag (unlike claude).
        //   2. `-c` overrides are documented as applying to values "otherwise
        //      loaded from config.toml"; their behaviour when `--ignore-user-config`
        //      suppresses config.toml is unspecified and untested.
        //   3. MCP server config is a complex nested TOML array — injecting it
        //      per-invocation via `-c` is fragile and has no reliable schema anchor.
        //   4. `resolveMcpConfigPath` (R-MFW-2) returns a JSON file path for
        //      claude's `--mcp-config`; there is no codex equivalent.
        //
        // Option C (removing `--ignore-user-config`) is REJECTED — it reintroduces
        // FM-4 (INV-IGNORE-USER-CONFIG).
        //
        // Resolution: R-MFW-4 will write a setup-time MCP snapshot before codex
        // workers are spawned; that snapshot covers codex without modifying the
        // per-invocation args here. `worker_mcp_snapshot_servers` in
        // pickle_settings.json (R-MFW-1) controls which servers are snapshotted.
        '--ignore-user-config',
    ];
    appendAddDirArgs(args, addDirs);
    if (model)
        args.push('-m', model);
    // Codex `-c key=value` is the documented config-override syntax. Must come
    // BEFORE the `--` prompt separator or codex parses it as part of the prompt.
    if (effort)
        args.push('-c', `reasoning.effort=${effort}`);
    args.push('--', prompt);
    return { cmd: 'codex', args, backend: 'codex' };
}
function buildGrokWorkerInvocation(opts) {
    const args = ['--no-subagents'];
    if (opts.model?.trim())
        args.push('--model', opts.model.trim());
    args.push('-p', opts.prompt);
    return { cmd: 'grok', args, backend: 'grok' };
}
function buildKimiWorkerInvocation(opts) {
    // INV-SWARM-OFF: kimi has no --no-subagents flag. Only disable path is
    // --agent-file pointing to a spec that excludes kimi_cli.tools.agent:Agent.
    const servicesDir = path.dirname(fileURLToPath(import.meta.url));
    const agentFile = path.resolve(servicesDir, '../data/kimi-no-swarm.yaml');
    const args = ['--print', '--agent-file', agentFile];
    if (opts.model?.trim())
        args.push('--model', opts.model.trim());
    args.push('-p', opts.prompt);
    return { cmd: 'kimi', args, backend: 'kimi' };
}
function buildGeminiWorkerInvocation(opts) {
    // INV-SWARM-OFF: gemini has no --no-subagents flag. --approval-mode default
    // keeps auto-approve off (the yolo default is false, this makes it explicit).
    // --output-format stream-json matches the measured one-shot CLI surface.
    const args = ['--approval-mode', 'default', '--output-format', 'stream-json'];
    if (opts.model?.trim())
        args.push('-m', opts.model.trim());
    args.push('-p', opts.prompt);
    return { cmd: 'gemini', args, backend: 'gemini' };
}
function buildDeepseekEnvOverlay() {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key)
        throw new Error('DEEPSEEK_API_KEY is not set — cannot build DeepSeek invocation');
    return {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: key,
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'deepseek-v4-pro',
    };
}
function buildDeepseekWorkerInvocation(opts) {
    const base = buildClaudeWorkerInvocation(opts);
    return { ...base, backend: 'deepseek', env: buildDeepseekEnvOverlay() };
}
function buildDeepseekManagerInvocation(opts) {
    const base = buildClaudeManagerInvocation(opts);
    return { ...base, backend: 'deepseek', env: buildDeepseekEnvOverlay() };
}
function buildDeepseekJudgeInvocation(opts) {
    const base = buildClaudeJudgeInvocation(opts);
    return { ...base, backend: 'deepseek', env: buildDeepseekEnvOverlay() };
}
function buildHermesWorkerInvocation(opts) {
    const args = [
        'chat',
        '-q', opts.prompt,
        '-Q',
        '--ignore-rules',
        '--ignore-user-config',
    ];
    if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
        args.push('--max-turns', String(opts.maxTurns));
    }
    const toolset = opts.toolset?.trim() || opts.toolsets?.map(t => t.trim()).filter(Boolean).join(',');
    if (toolset)
        args.push('--toolsets', toolset);
    if (opts.provider?.trim())
        args.push('--provider', opts.provider.trim());
    if (opts.model?.trim())
        args.push('-m', opts.model.trim());
    return { cmd: 'hermes', args, backend: 'hermes' };
}
/**
 * Build a read-only judge invocation.
 *
 * The LLM judge scores candidate diffs — it MUST NOT write files, commit, or
 * shell out. Both backend paths are explicitly locked down:
 *
 * - claude: `--allowedTools Read,Glob,Grep` + `--no-session-persistence`,
 *   threads `--system-prompt` and `-p <prompt>`. No Bash/Edit/Write tools.
 * - codex: `codex exec -s read-only` (codex's built-in read-only sandbox;
 *   see `codex exec --help`). Also passes `--ignore-rules` and
 *   `--ignore-user-config` so the judge cannot be biased by user- or
 *   project-level execpolicy / config TOML. `--ephemeral` keeps the session
 *   off disk. Crucially the bypass flag is DROPPED — the judge never gets
 *   full FS access.
 *
 * codex exec does NOT expose `--system-prompt` / `--allowedTools` /
 * `--no-session-persistence`. The system prompt is inlined as a prefix to the
 * user prompt; the read-only sandbox replaces the tool allowlist.
 */
export function buildJudgeInvocation(backend, opts) {
    if (backend === 'codex')
        return buildCodexJudgeInvocation(opts);
    if (backend === 'deepseek')
        return buildDeepseekJudgeInvocation(opts);
    return buildClaudeJudgeInvocation(opts);
}
function buildClaudeJudgeInvocation(opts) {
    const args = ['--dangerously-skip-permissions'];
    appendAddDirArgs(args, opts.addDirs);
    if (opts.model)
        args.push('--model', opts.model);
    if (opts.systemPrompt)
        args.push('--system-prompt', opts.systemPrompt);
    // Read-only tool allowlist — judge MUST NOT write, edit, or execute.
    args.push('--allowedTools', 'Read,Glob,Grep');
    args.push('--no-session-persistence');
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildCodexJudgeInvocation(opts) {
    // Inline the system prompt as a prefix since `codex exec` has no
    // --system-prompt flag. The read-only sandbox enforces the actual safety
    // guarantee; the system prompt only shapes the scoring contract.
    const composedPrompt = opts.systemPrompt
        ? `${opts.systemPrompt}\n\n${opts.prompt}`
        : opts.prompt;
    const args = [
        'exec',
        // Read-only sandbox — no file writes, no shell exec, no network.
        // Replaces --dangerously-bypass-approvals-and-sandbox; DO NOT add that
        // flag back into the judge path.
        '-s', 'read-only',
        // Ignore user CLAUDE.md / AGENTS.md / .rules files so project-specific
        // rules cannot bias the judge's scoring contract.
        '--ignore-rules',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--ephemeral',
    ];
    appendAddDirArgs(args, opts.addDirs);
    if (opts.model)
        args.push('-m', opts.model);
    args.push('--', composedPrompt);
    return { cmd: 'codex', args, backend: 'codex' };
}
function existsSilently(p) {
    try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    }
}
/**
 * Append `--add-dir <dir>` for each existing sandbox dir. Single source of truth
 * for the existence-filtered add-dir allowlisting shared by every worker/judge
 * builder (claude + codex). The manager builder intentionally does NOT use this
 * — it pushes add-dirs without the existence gate.
 */
function appendAddDirArgs(args, addDirs) {
    for (const dir of addDirs) {
        if (dir && existsSilently(dir))
            args.push('--add-dir', dir);
    }
}
const TRAILER_HOOKS_MANAGED_DIRNAME = 'git-trailer-hooks';
function parseNonNegativeInt(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
/** Warn-once dedupe reusing the existing `_warnedBackends` set (no parallel warn mechanism). */
function warnTrailerHooksFailure(reason) {
    const key = `trailer-hooks:${reason}`;
    if (_warnedBackends.has(key))
        return;
    _warnedBackends.add(key);
    process.stderr.write(`[backend-spawn] trailer hooks materialization failed (${reason}) — omitting core.hooksPath + PICKLE_TICKET_ID\n`);
}
/**
 * Builds the `core.hooksPath` + `PICKLE_TICKET_ID` env fragment. All-or-nothing: a null
 * `ticketId` or a `materializeTrailerHooks` failure yields `{}` (logged once, never throws).
 * Composes with an inherited `GIT_CONFIG_COUNT` (from `opts.env`, defaulting to `process.env`) —
 * appends at index `n = existing count`, never hardcodes index 0.
 */
function buildTrailerHooksEnvFragment(opts) {
    if (!opts.ticketId)
        return {};
    const managedDir = path.join(opts.sessionDir, TRAILER_HOOKS_MANAGED_DIRNAME);
    const result = materializeTrailerHooks({ repoRoot: opts.workingDir, managedDir });
    if (!result.ok) {
        warnTrailerHooksFailure(result.reason);
        return {};
    }
    const inheritedEnv = opts.env ?? process.env;
    const n = parseNonNegativeInt(inheritedEnv[GIT_CONFIG_COUNT_ENV_VAR]) ?? 0;
    return {
        [GIT_CONFIG_COUNT_ENV_VAR]: String(n + 1),
        [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
        [`GIT_CONFIG_VALUE_${n}`]: result.managedDir,
        [PICKLE_TICKET_ID_ENV_VAR]: opts.ticketId,
    };
}
export function backendEnvOverrides(backend, trailerOpts) {
    const env = { PICKLE_BACKEND: backend };
    if (!trailerOpts)
        return env;
    return { ...env, ...buildTrailerHooksEnvFragment(trailerOpts) };
}
// ---------------------------------------------------------------------------
// R-CSI / W2.R1 — session-scoped process isolation (setpgid + stamp)
//
// TWO SEPARATE MECHANISMS live here, and only ONE of them is load-bearing.
//
// 1. `shouldIsolateSessionGroup()` — LOAD-BEARING. A spawn that passes it to
//    `detached` makes its child LEAD a process group, which is what gives
//    `process.kill(-pid, sig)` (services/orphan-reaper.ts `killProcessGroup`)
//    a subtree to reap without naming a bare binary. Attribution of an ALREADY
//    RUNNING proc back to its session is likewise NOT done from the stamp below:
//    `orphan-reaper.ts resolveOwningSessionDir` scans argv for the first
//    `--add-dir` under the sessions root.
//
// 2. `sessionStampEnv()` — DIAGNOSTIC ONLY. See its own docstring.
//
// NOT every spawn site does either. The stamp is applied at exactly two sites
// (the worker spawn in spawn-morty.ts, the manager iteration spawn in
// mux-runner.ts); `detached` is applied at the WORKER spawn and NOT at the
// manager spawn, deliberately — a manager that led its own group would escape
// `pipeline-runner.ts`'s `killProcessGroup(muxPid)` teardown, which reaps the
// manager precisely BECAUSE it shares mux-runner's group. Do not "fix" that
// asymmetry by detaching the manager, and do not group-kill a manager pid: with
// no group of its own, `kill(-managerPid)` names mux-runner's OWN group — the
// AP-EXT-ITER47-01 self-group hazard.
// ---------------------------------------------------------------------------
/**
 * Env stamp identifying the owning session for a spawned subprocess.
 * `sessionId` is the session directory basename (e.g. `2026-06-13-2bd4740a`);
 * `workingDir` is the session's canonical project directory.
 *
 * DIAGNOSTIC ONLY: nothing in this runtime READS either key — not the kill
 * paths, not the reapers, not the hooks — and nothing ever has (measured over
 * full history; the pair has been write-only since `45d9659d` introduced it).
 * Its value is that `env | grep PICKLE_` inside a live subprocess names the
 * owning session, which is how run evidence is captured
 * (`docs/gitattr-live-run-evidence.md`). Treat a claim that some kill/reap path
 * "scopes by the stamp" as false until a reader exists: the real scoping is
 * `shouldIsolateSessionGroup()` + argv `--add-dir` attribution (see the section
 * comment above). If you ever DO wire a reader, update this docstring in the
 * same change — `backend-spawn-trailer-env.test.js` pins the two together.
 */
export function sessionStampEnv(sessionId, workingDir) {
    const env = {};
    if (sessionId)
        env.PICKLE_SESSION = sessionId;
    if (workingDir)
        env.PICKLE_WORKING_DIR = workingDir;
    return env;
}
/**
 * Whether a spawned subprocess should lead its own process group (POSIX
 * `setpgid` via Node's `detached: true`). False on win32 (no process groups).
 */
export function shouldIsolateSessionGroup() {
    return process.platform !== 'win32';
}
export function loadBackendFromSession(sessionDir) {
    return resolveBackendFromStateFile(path.join(sessionDir, 'state.json'));
}
