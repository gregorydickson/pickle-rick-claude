import type { CodegraphSettings, HardeningSettings, PickleSettings, RateLimitSettings } from '../types/index.js';

// Settings resolution: the pure resolvers over a `pickle_settings.json` bag and the env-only runtime
// knobs, with their compiled defaults. Nothing here reads the filesystem or imports pickle-utils, so
// the dependency runs one way — pickle-utils re-exports this module and every existing import path
// keeps resolving. The bag loader `loadPickleSettingsBag` and the two resolvers that default through
// the extension root (`resolveWorkerTestGateTimeoutMs`, `resolveJudgeBackend`) stay in pickle-utils:
// `getExtensionRoot` is source-pinned there, and importing it back would close an import cycle.

// R-TIERWEDGE: N for the tier-run STALL detector — the longest a tier run may produce NO
// output at all before it is reported as stalled. A tier run streams TAP continuously, so
// absence of growth is the observable the hang actually presents; CPU is not (a zero-CPU run
// with a growing log is merely slow). Deliberately a SEPARATE number from
// `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS` in `pickle-utils.ts` even though the two coincide today — that one is
// a wall-clock budget operators are told to raise per-machine, and why raising it must not
// widen this window is explained where the two meet (`spawn-morty.ts:runWorkerGateTestCommand`).
// Floor for operator override: 60_000 ms (one minute of total silence is already abnormal for
// a streaming tier run; below that, normal scheduling jitter would report false stalls).
export const DEFAULT_TIER_STALL_THRESHOLD_MS = 600_000;
export const TIER_STALL_THRESHOLD_FLOOR_MS = 60_000;
export const TIER_STALL_THRESHOLD_ENV_VAR = 'PICKLE_TIER_STALL_THRESHOLD_MS';

// B2 rate-limit probe: the ONE declaration of the operator knob "how often does a rate-limit
// wait re-ask the API", and of the probe protocol the two waiting runners speak. Both
// `mux-runner.ts` and `microverse-runner.ts` park on a rate limit and both re-probe; each had
// grown its own verbatim copy of these six values and of the resolver body below, so the single
// documented knob had two compiled definitions and a change to either one's default or floor
// would have left the two runners disagreeing about the same env var with nothing to notice.
// Neither runner could own it — `microverse-runner.ts` imports FROM `mux-runner.ts`, so the
// reverse import is a cycle — which is precisely why it belongs in a module both already import (via pickle-utils).
export const RATE_LIMIT_PROBE_INTERVAL_ENV_VAR = 'PICKLE_RATE_LIMIT_PROBE_INTERVAL_MS';
export const DEFAULT_RATE_LIMIT_PROBE_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_RATE_LIMIT_PROBE_INTERVAL_MS = 60_000;
export const RATE_LIMIT_PROBE_TIMEOUT_MS = 120_000;
export const RATE_LIMIT_PROBE_LOG_FILENAME = 'rate_limit_probe.log';
/** Smallest prompt that still forces a real API round trip. */
export const RATE_LIMIT_PROBE_PROMPT = 'Reply with exactly: ok';

/** Compiled default for `hardening.silent_death_respawn_cap` (ticket 90574654). */
export const DEFAULT_SILENT_DEATH_RESPAWN_CAP = 1;

/** Compiled default for `hardening.failed_flip_suppression_cap` (ticket 7eb9fa20). */
export const DEFAULT_FAILED_FLIP_SUPPRESSION_CAP = 2;

/** Compiled default for `hardening.breaker_recovery_grace_seconds` (AC-A5, B-RRH). */
export const DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS = 30;

/** Compiled default for `hardening.bounded_terminal_escape_cap` (AC-A4, f8000435). */
export const DEFAULT_BOUNDED_TERMINAL_ESCAPE_CAP = 3;

/** Non-negative-integer-or-fallback field resolver shared by every `hardening.*` field. */
function resolveNonNegativeIntField(block: Record<string, unknown>, key: string, fallback: number): number {
  const v = block[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
}

/**
 * Ticket 90574654 — resolve the additive `hardening:` settings block (DISTINCT
 * from `bmad_hardening`). Doctrine mirrors `loadRefinementSettings`
 * (spawn-refinement-team.ts): start from compiled defaults; an absent, partial,
 * or malformed bag/block/field never throws and falls back per field.
 * `silent_death_respawn_cap` accepts non-negative integers only — `0` disables
 * silent-death respawns entirely. `failed_flip_suppression_cap` (ticket
 * 7eb9fa20) follows the same rule — `0` disables evidence-backed Failed-flip
 * suppression (flip-intents with evidence escalate immediately).
 * `breaker_recovery_grace_seconds` (AC-A5) and `bounded_terminal_escape_cap`
 * (AC-A4) follow the same non-negative-integer-or-default doctrine.
 */
export function resolveHardeningSettings(bag: PickleSettings | null | undefined): HardeningSettings {
  const settings: HardeningSettings = {
    silent_death_respawn_cap: DEFAULT_SILENT_DEATH_RESPAWN_CAP,
    failed_flip_suppression_cap: DEFAULT_FAILED_FLIP_SUPPRESSION_CAP,
    breaker_recovery_grace_seconds: DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS,
    bounded_terminal_escape_cap: DEFAULT_BOUNDED_TERMINAL_ESCAPE_CAP,
  };
  if (!bag || typeof bag !== 'object') return settings;
  const block = (bag as Record<string, unknown>).hardening;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const b = block as Record<string, unknown>;
  settings.silent_death_respawn_cap = resolveNonNegativeIntField(b, 'silent_death_respawn_cap', settings.silent_death_respawn_cap);
  settings.failed_flip_suppression_cap = resolveNonNegativeIntField(b, 'failed_flip_suppression_cap', settings.failed_flip_suppression_cap);
  settings.breaker_recovery_grace_seconds = resolveNonNegativeIntField(b, 'breaker_recovery_grace_seconds', settings.breaker_recovery_grace_seconds);
  settings.bounded_terminal_escape_cap = resolveNonNegativeIntField(b, 'bounded_terminal_escape_cap', settings.bounded_terminal_escape_cap);
  return settings;
}

function parseSettingBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function parseSettingIntFloor(v: unknown, floor: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined;
  return Math.max(floor, v);
}

function parseSettingIntClamp(v: unknown, floor: number, ceiling: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined;
  return Math.max(floor, Math.min(ceiling, v));
}

export function resolveCodegraphSettings(bag: unknown): CodegraphSettings {
  // Compiled defaults are OFF (aligned with the shipped pickle_settings.json
  // opt-in stance, de3c5959): a missing/malformed settings file must NOT
  // silently activate codegraph — sandboxed test runs without a settings file
  // were indexing fixture dirs through the old enabled:true fallback (97
  // leaked codegraph_index_built events, 2026-06-12..07-08).
  const settings: CodegraphSettings = {
    enabled: false,
    index_at_setup: false,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 120000,
    sync_timeout_ms: 30000,
    query_timeout_ms: 5000,
  };
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return settings;
  const block = (bag as Record<string, unknown>).codegraph;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const b = block as Record<string, unknown>;
  const enabled = parseSettingBool(b.enabled);
  if (enabled !== undefined) settings.enabled = enabled;
  const indexAtSetup = parseSettingBool(b.index_at_setup);
  if (indexAtSetup !== undefined) settings.index_at_setup = indexAtSetup;
  const exposeMcp = parseSettingBool(b.expose_mcp_to_workers);
  if (exposeMcp !== undefined) settings.expose_mcp_to_workers = exposeMcp;
  const staleness = parseSettingIntFloor(b.staleness_max_age_minutes, 1);
  if (staleness !== undefined) settings.staleness_max_age_minutes = staleness;
  const ctxBytes = parseSettingIntClamp(b.context_max_bytes, 1024, 65536);
  if (ctxBytes !== undefined) settings.context_max_bytes = ctxBytes;
  const indexMs = parseSettingIntFloor(b.index_timeout_ms, 5000);
  if (indexMs !== undefined) settings.index_timeout_ms = indexMs;
  const syncMs = parseSettingIntFloor(b.sync_timeout_ms, 1000);
  if (syncMs !== undefined) settings.sync_timeout_ms = syncMs;
  const queryMs = parseSettingIntFloor(b.query_timeout_ms, 500);
  if (queryMs !== undefined) settings.query_timeout_ms = queryMs;
  return settings;
}

export const DEFAULT_MAX_PARK_MINUTES = 360;

/**
 * Ticket e9bdac75 (Workstream B): resolve the rate-limit park controls from the
 * additive `rate_limit:` block in `pickle_settings.json`. Per-field fallback —
 * absent/partial/malformed input yields the compiled default. Mirrors
 * `resolveHardeningSettings` / `resolveCodegraphSettings`.
 */
export function resolveRateLimitSettings(bag: PickleSettings | null | undefined): RateLimitSettings {
  const settings: RateLimitSettings = { max_park_minutes: DEFAULT_MAX_PARK_MINUTES };
  if (!bag || typeof bag !== 'object') return settings;
  const block = (bag as Record<string, unknown>).rate_limit;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const maxPark = parseSettingIntFloor((block as Record<string, unknown>).max_park_minutes, 1);
  if (maxPark !== undefined) settings.max_park_minutes = maxPark;
  return settings;
}

export interface ScopeSettings {
  autoExtendSignatureCallers: boolean;
}

/**
 * Ticket 0b9b2319 (WS-3): resolve the additive `scope:` block in
 * `pickle_settings.json`. Mirrors `resolveHardeningSettings` robustness —
 * an absent, partial, or malformed bag/block/field never throws and falls
 * back to the default-OFF compiled default. The single field
 * `auto_extend_signature_callers` (default `false`) gates the bounded,
 * opt-in build-phase scope auto-extension in `setupScope`.
 */
export function resolveScopeSettings(bag: PickleSettings | null | undefined): ScopeSettings {
  const settings: ScopeSettings = { autoExtendSignatureCallers: false };
  if (!bag || typeof bag !== 'object') return settings;
  const block = (bag as Record<string, unknown>).scope;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return settings;
  const autoExtend = parseSettingBool((block as Record<string, unknown>).auto_extend_signature_callers);
  if (autoExtend !== undefined) settings.autoExtendSignatureCallers = autoExtend;
  return settings;
}

/**
 * R-TIERWEDGE: resolve N for the tier-run stall detector (`spawn-morty.ts:runCommand`'s
 * `stallThresholdMs` mode) — the longest a tier run may emit NOTHING before it is reported
 * as stalled.
 *
 * Same shape as `resolveWorkerTestGateTimeoutMs` in `pickle-utils.ts`: env override wins, parsed as a strict
 * positive integer and clamped up to `TIER_STALL_THRESHOLD_FLOOR_MS`; every other input —
 * absent, blank, non-numeric, zero, negative, or fractional — falls back to the compiled
 * `DEFAULT_TIER_STALL_THRESHOLD_MS`. There is deliberately no `pickle_settings.json` arm:
 * that file is a worker-forbidden write and `install.sh` MANAGED_KEYS strips such pins on
 * every deploy (B-SSAT), so an env override is the sanctioned tune-back.
 *
 * `env` is an explicit parameter so callers — unit tests especially — can resolve against a
 * literal object instead of ambient process state. That is what keeps this key OUT of
 * `PICKLE_GATE_SCRUBBED_ENV_KEYS`: a test that never reads `process.env` cannot be
 * contaminated by an operator's export, so the enumeration does not need to grow (root
 * CLAUDE.md: prefer the formulation that needs no list).
 *
 * Reporting only — a resolved stall window never aborts anything. The detector that consumes
 * it stamps `stalled: no output growth for <N>ms` and lets the caller's existing disposition
 * run.
 */
export function resolveTierStallThresholdMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawEnv = env[TIER_STALL_THRESHOLD_ENV_VAR];
  if (typeof rawEnv === 'string' && rawEnv.trim().length > 0) {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
      return Math.max(parsed, TIER_STALL_THRESHOLD_FLOOR_MS);
    }
  }
  return DEFAULT_TIER_STALL_THRESHOLD_MS;
}

/**
 * How often a rate-limit wait re-asks. Clamped UP to `MIN_RATE_LIMIT_PROBE_INTERVAL_MS` so an
 * operator override cannot turn the park into a spawn-burn; absent/garbage falls back to the
 * compiled default.
 *
 * The `parseInt` parse is carried over verbatim from the two copies this replaces — deliberately
 * looser than the sibling `resolveTierStallThresholdMs` above, which rejects a fractional or
 * trailing-garbage value rather than truncating it. Tightening it here would be a behaviour
 * change to both runners wearing the clothes of a move.
 */
export function resolveRateLimitProbeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env[RATE_LIMIT_PROBE_INTERVAL_ENV_VAR] ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RATE_LIMIT_PROBE_INTERVAL_MS;
  return Math.max(raw, MIN_RATE_LIMIT_PROBE_INTERVAL_MS);
}
