import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { BACKENDS } from '../types/index.js';
import { StateManager } from './state-manager.js';
import { logActivity } from './activity-logger.js';
/**
 * R-WSRC-4 — Test-harness sandbox assertion.
 *
 * Thrown by `buildClaudeWorkerInvocation` when `process.env.PICKLE_TEST_MODE === '1'`
 * AND any `addDirs[i]` resolves (via `fs.realpathSync`) outside the canonical
 * `os.tmpdir()`. Catches the leak class where a test fixture sets
 * `working_dir: REPO_ROOT` (or `EXTENSION_DIR: REPO_ROOT`), spawns a worker,
 * and the spawn timeout fires (R-MRWG-2) — the orphaned
 * `claude --dangerously-skip-permissions --add-dir <real-repo>` subprocess
 * then retains write access to the operator's real working tree.
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
const _sm = new StateManager();
const BACKEND_FLIP_REASON_TTL_MS = 60_000;
export function __resetBackendWarnings() {
    _warnedBackends.clear();
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
 * Single source of truth for MCP-config precedence. Returns both the resolved
 * path (null when omitted) and which layer matched, so the public
 * `resolveMcpConfigPath` and the activity-logging `emitMcpConfigResolved` share
 * one decision tree instead of reimplementing it.
 */
function resolveMcpConfigWithLayer(settingsBag, homeDir) {
    const override = settingsBag?.worker_mcp_config_path;
    if (typeof override === 'string' && override.trim()) {
        return { path: override.trim(), layer: 'settings_override' };
    }
    const claudeJson = path.join(homeDir ?? os.homedir(), '.claude.json');
    if (existsSilently(claudeJson)) {
        return { path: claudeJson, layer: 'claude_json_fallback' };
    }
    return { path: null, layer: 'omitted' };
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
 *   - codegraph bin unresolvable OR write failure (merge-fail) → one degraded-style
 *     log line + operator passthrough.
 *   - otherwise → write `{ mcpServers: { codegraph, ...operatorEntries } }` and return
 *     the session path. Operator entries are spread LAST so an operator-supplied
 *     `codegraph` key WINS the name collision (intentional override). No operator
 *     entries → codegraph-only config.
 *
 * Invariants: the operator config file is never mutated; exactly one writer authority
 * (serve watcher OFF, see `resolveCodegraphServeEntry`).
 */
export function buildWorkerMcpConfig(sessionDir, workingDir, settings, snapshotEntries) {
    const passthrough = () => resolveMcpConfigPath(settings) ?? null;
    if (settings?.expose_mcp_to_workers !== true)
        return passthrough();
    const codegraph = resolveCodegraphServeEntry(workingDir);
    if (!codegraph) {
        process.stderr.write('[backend-spawn] worker MCP merge degraded: codegraph bin unresolved; passthrough operator config\n');
        return passthrough();
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
        return passthrough();
    }
}
export function buildWorkerInvocation(backend, opts) {
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
    // R-WSRC-4: test-harness sandbox assertion. No-op unless PICKLE_TEST_MODE=1.
    assertAddDirsUnderTmpdirIfTestMode(opts.addDirs);
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
export function backendEnvOverrides(backend) {
    const env = { PICKLE_BACKEND: backend };
    return env;
}
// ---------------------------------------------------------------------------
// R-CSI / W2.R1 — session-scoped process isolation (setpgid + stamp)
//
// Every subprocess pickle-rick spawns is stamped with the owning session id and
// working_dir and (on POSIX) launched `detached` so it leads its OWN process
// group. The single source of truth for both is here so every spawn site (the
// worker spawn in spawn-morty.ts, the manager spawn in mux-runner.ts) stamps and
// scopes identically — a kill that targets `process.kill(-pid, sig)` then reaps
// exactly that session's subtree and CANNOT reach a concurrent session's (or an
// out-of-repo pipeline's) healthy workers by a bare binary name.
//
// Kill-switch: PICKLE_RECOVERY_CONSOLIDATION=off reverts to the per-seam behaviour
// (no detach → kills fall back to the direct child as before this fix landed). Only
// the literal lowercase string 'off' disables; any other value / absent keeps the
// consolidated session-group isolation active.
// ---------------------------------------------------------------------------
export const SESSION_ISOLATION_KILL_SWITCH = 'PICKLE_RECOVERY_CONSOLIDATION';
/**
 * Env stamp identifying the owning session for every spawned subprocess.
 * `sessionId` is the session directory basename (e.g. `2026-06-13-2bd4740a`);
 * `workingDir` is the session's canonical project directory. Both are read back
 * by kill/reaping paths to scope targets to this session only.
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
 * `setpgid` via Node's `detached: true`). False on win32 (no process groups) and
 * when the `PICKLE_RECOVERY_CONSOLIDATION=off` kill-switch reverts to per-seam
 * behaviour. `env` defaults to `process.env` and is injectable for testing.
 */
export function shouldIsolateSessionGroup(env = process.env) {
    if (process.platform === 'win32')
        return false;
    if (env[SESSION_ISOLATION_KILL_SWITCH] === 'off')
        return false;
    return true;
}
export function loadBackendFromSession(sessionDir) {
    return resolveBackendFromStateFile(path.join(sessionDir, 'state.json'));
}
