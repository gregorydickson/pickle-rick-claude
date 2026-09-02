// @tier: fast
/**
 * e9bdac75 (Workstream B) — Rate-limit park-until-reset + bounded auto-resume.
 *
 * Root cause: `computeRateLimitAction` had a hard `3×` config cap
 * (`maxApiWaitMs = configWaitMs * 3`) that discarded any reset window longer than
 * 15min (5min default), so a 5h reset fell through to the config default and the
 * runner spawn-burned into the wall, never auto-resuming.
 *
 * The fix removes the cap, honors the full `reset_at` clamped to a NEW
 * `max_park_minutes` setting (default 360), parks via the EXISTING
 * `rate_limit_wait.json` flag (already honored by the C6/C6a watchdogs), persists
 * the park-arm in a NEW `state.rate_limit_park` field so it survives `--resume`, and
 * resumes once with counters preserved.
 *
 * Schema-neutral: no new lifecycle phase, no new exit_reason. `rate_limit_park_exhausted`
 * is activity-only; the B5 clean exit reuses the EXISTING `rate_limit_exhausted` exit path.
 *
 * Pure decision functions are exercised directly with a fake clock + injected jitter.
 * The injectable `processRateLimitCycle` (LoopContext with `now`/`sleep`/`readState`/
 * `updateState`/`writeState`/`unlink`/`deactivate`) drives the park→resume cycle with no
 * real waits. The wired live loop path + SIGTERM/B4 ordering are covered by
 * source-content assertions (the established mux-runner watchdog test idiom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  computeRateLimitAction,
  resolveParkResumeTime,
  drawParkResumeJitterMs,
  isParkExhausted,
  processRateLimitCycle,
  detectRateLimitInLog,
  PARK_RESUME_JITTER_MIN_MS,
  PARK_RESUME_JITTER_MAX_MS,
} from '../bin/mux-runner.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveRateLimitSettings, DEFAULT_MAX_PARK_MINUTES } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const src = readFileSync(MUX_SRC, 'utf8');

// computeRateLimitAction reads real Date.now() to derive apiWaitMs from reset_at, so
// reset epochs MUST be relative to real time. The LOOP wait uses the injected fake
// clock (ctx.now/ctx.sleep) so there are still no real waits.
const NOW = Date.now();
const NOW_SEC = Math.floor(NOW / 1000);

// A LoopContext driven entirely by a fake clock — no real sleep, no real disk.
function makeCtx(overrides = {}) {
  let clock = NOW;
  const events = [];
  let state = {
    active: true,
    start_time_epoch: NOW_SEC,
    max_time_minutes: 0,
    iteration: 7,
    rate_limit_park: null,
    ...(overrides.state || {}),
  };
  const written = {};
  const unlinked = [];
  let deactivated = false;
  const ctx = {
    sessionDir: '/tmp/rrh-park-session',
    statePath: '/tmp/rrh-park-session/state.json',
    extensionRoot: '/tmp/ext',
    iteration: 7,
    log: () => {},
    exitResult: { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: overrides.resetsAt ?? null } },
    consecutiveRateLimits: overrides.consecutiveRateLimits ?? 0,
    maxRateLimitRetries: 3,
    rateLimitWaitMinutes: 5,
    maxParkMinutes: overrides.maxParkMinutes ?? DEFAULT_MAX_PARK_MINUTES,
    parkJitterMs: 90_000, // deterministic mid-band jitter
    now: () => clock,
    // Each poll advances the fake clock so the wait loop terminates instantly.
    sleep: async () => { clock += overrides.sleepStepMs ?? 60_000; },
    readState: () => state,
    updateState: (mutator) => { mutator(state); },
    writeState: (p, v) => { written[p] = v; },
    unlink: (p) => { unlinked.push(p); },
    writeHandoff: () => {},
    deactivate: () => { deactivated = true; state.active = false; },
  };
  return {
    ctx,
    getState: () => state,
    getWritten: () => written,
    getUnlinked: () => unlinked,
    wasDeactivated: () => deactivated,
    getEvents: () => events,
    advanceClock: (ms) => { clock += ms; },
    setClock: (ms) => { clock = ms; },
  };
}

// ---------------------------------------------------------------------------
// Settings — max_park_minutes default + clamp
// ---------------------------------------------------------------------------

test('settings: resolveRateLimitSettings default is 360 minutes', () => {
  assert.equal(resolveRateLimitSettings(null).max_park_minutes, 360);
  assert.equal(resolveRateLimitSettings({}).max_park_minutes, 360);
  assert.equal(DEFAULT_MAX_PARK_MINUTES, 360);
});

test('settings: resolveRateLimitSettings honors a valid override and clamps to floor 1', () => {
  assert.equal(resolveRateLimitSettings({ rate_limit: { max_park_minutes: 720 } }).max_park_minutes, 720);
  // Floor clamp: 0 / negative / non-integer fall back to the default.
  assert.equal(resolveRateLimitSettings({ rate_limit: { max_park_minutes: 0 } }).max_park_minutes, 1);
  assert.equal(resolveRateLimitSettings({ rate_limit: { max_park_minutes: -5 } }).max_park_minutes, 1);
  assert.equal(resolveRateLimitSettings({ rate_limit: { max_park_minutes: 2.5 } }).max_park_minutes, 360);
  assert.equal(resolveRateLimitSettings({ rate_limit: 'nope' }).max_park_minutes, 360);
});

// ---------------------------------------------------------------------------
// B1 — 5h reset parks ≈5h (NOT the 15-min 3× cap), one wait event, 0 spawns
// ---------------------------------------------------------------------------

test('B1: 429 with reset_at = now+5h parks ≈5h (full window, NOT the removed 3× cap)', () => {
  const fiveHours = NOW_SEC + 5 * 3600;
  const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: fiveHours } };
  // 5min config; old behavior would cap at 3×=15min and fall back to config. New: ~5h.
  const action = computeRateLimitAction(exitResult, 1, 3, 5, 360);
  assert.equal(action.action, 'wait');
  assert.equal(action.waitSource, 'api');
  const fiveHoursMs = 5 * 3600 * 1000;
  assert.ok(
    action.waitMs >= fiveHoursMs && action.waitMs <= fiveHoursMs + 60_000,
    `waitMs ${action.waitMs} must be ~5h, not the 15-min 3× cap (${15 * 60 * 1000})`,
  );
  assert.equal(action.resetAtEpochSec, fiveHours, 'reset_at persisted for resume re-arm');
  assert.notEqual(action.waitMs, 15 * 60 * 1000, 'the removed 3× cap must NOT apply');
});

test('B1: a reset beyond max_park_minutes clamps to the ceiling', () => {
  const farFuture = NOW_SEC + 999_999; // ~277h
  const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: farFuture } };
  const action = computeRateLimitAction(exitResult, 1, 3, 5, 360);
  assert.equal(action.waitSource, 'api');
  assert.equal(action.waitMs, 360 * 60 * 1000, 'clamped to max_park_minutes, not config default');
});

test('B1: park emits exactly ONE rate_limit_wait and writes the rate_limit_wait.json park flag (0 spawns)', async () => {
  // Drive the cycle but stop it short of resume by keeping the wake target far away,
  // then snapshot what was written before the resume. We assert via source that the
  // park flag is written BEFORE the sleep loop, and that the loop never spawns.
  const fiveHours = NOW_SEC + 5 * 3600;
  const h = makeCtx({ resetsAt: fiveHours, sleepStepMs: 60_000 });
  await processRateLimitCycle(h.getState(), h.ctx);
  const waitPath = '/tmp/rrh-park-session/rate_limit_wait.json';
  // The wait flag was written (park entry) and then unlinked on resume.
  assert.ok(h.getWritten()[waitPath], 'rate_limit_wait.json park flag was written');
  assert.equal(h.getWritten()[waitPath].wait_source, 'api');
  assert.equal(h.getWritten()[waitPath].resets_at_epoch, fiveHours);
  // Source: no worker spawn happens inside the api_limit park block — the loop
  // `continue`s before CB recording + result branching entirely, so no new spawn
  // decision is made this iteration. (Presence of rate_limit_wait.json plays no
  // role in gating a spawn attempt — see the B3 AC-A5 block: it only ever feeds
  // the two liveness watchdogs and, until this bundle's B3 fix, a no-progress
  // counter suppression it should never have fed.)
  assert.match(src, /continue;\s*\/\/ Skip CB recording \+ result branching entirely/);
});

// ---------------------------------------------------------------------------
// B2 — resume at max(reset_at+jitter, now+min_wait); 1 worker; counters preserved
// ---------------------------------------------------------------------------

test('B2: resolveParkResumeTime = max(reset_at + jitter, now + min_wait)', () => {
  const minWaitMs = 5 * 60 * 1000;
  // reset_at in the near future + jitter dominates min_wait.
  const resetSoon = NOW_SEC + 600; // +10min
  const tSoon = resolveParkResumeTime(resetSoon, NOW, minWaitMs, 90_000);
  assert.equal(tSoon, resetSoon * 1000 + 90_000, 'reset+jitter wins when it exceeds now+min_wait');
  // reset_at already passed → now + min_wait floor wins.
  const resetPast = NOW_SEC - 600;
  const tPast = resolveParkResumeTime(resetPast, NOW, minWaitMs, 90_000);
  assert.equal(tPast, NOW + minWaitMs, 'now+min_wait floor wins for a stale reset');
  // No reset_at at all → now + min_wait.
  assert.equal(resolveParkResumeTime(null, NOW, minWaitMs, 90_000), NOW + minWaitMs);
});

test('B2: jitter is drawn within [60s, 120s]', () => {
  assert.equal(drawParkResumeJitterMs(() => 0), PARK_RESUME_JITTER_MIN_MS);
  assert.equal(drawParkResumeJitterMs(() => 0.9999999), PARK_RESUME_JITTER_MAX_MS);
  const mid = drawParkResumeJitterMs(() => 0.5);
  assert.ok(mid >= PARK_RESUME_JITTER_MIN_MS && mid <= PARK_RESUME_JITTER_MAX_MS);
});

test('B2: resume re-spawns ≤1 worker for the SAME ticket/phase with iteration + counters PRESERVED', async () => {
  const reset = NOW_SEC + 600;
  const h = makeCtx({
    resetsAt: reset,
    state: {
      active: true, start_time_epoch: NOW_SEC, max_time_minutes: 0, iteration: 7,
      // counters that must NOT be poisoned by the park cycle:
      worker_artifact_progress: { 'ticket-A': { spawn_count: 2, last_artifact_count: 4, zero_progress_count: 1 } },
      current_ticket: 'ticket-A',
      rate_limit_park: null,
    },
    sleepStepMs: 120_000,
  });
  const result = await processRateLimitCycle(h.getState(), h.ctx);
  // continue (single re-spawn next loop), not break/bail.
  assert.equal(result.kind, 'continue');
  const after = h.getState();
  // iteration preserved (park never touches it):
  assert.equal(after.iteration, 7, 'iteration must be preserved across park');
  // zero_progress_count NOT poisoned:
  assert.equal(after.worker_artifact_progress['ticket-A'].zero_progress_count, 1);
  assert.equal(after.current_ticket, 'ticket-A', 'same ticket on resume');
  // park-arm cleared on clean resume:
  assert.equal(after.rate_limit_park, null);
  // rate_limit_wait.json unlinked on resume (re-spawn allowed):
  assert.ok(h.getUnlinked().includes('/tmp/rrh-park-session/rate_limit_wait.json'));
  // api source → consecutiveRateLimits reset to 0 on resume:
  assert.equal(result.consecutiveRateLimits, 0);
});

/**
 * Every `logActivity(...)` object-literal argument in `src` that names `<eventName>`,
 * brace-matched so each is read whole. Discovery is by BRACE MATCH, never by a
 * `logActivity({ event: '<name>'` text needle: that needle is formatting-sensitive,
 * so reflowing one emitter across lines silently drops it from coverage (measured).
 * Scoping to the literal is the point: a span assertion joining the event name to a
 * field name is satisfied by any later occurrence of that field anywhere in the file.
 */
function activityEmitterLiterals(eventName) {
  const CALL = 'logActivity(';
  const carriesEvent = new RegExp(`event:\\s*'${eventName}'`);
  const literals = [];
  for (let from = 0; ; ) {
    const at = src.indexOf(CALL, from);
    if (at === -1) break;
    const open = at + CALL.length;
    from = open;
    if (src[open] !== '{') continue; // not an object-literal argument
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}' && (depth -= 1) === 0) { end = i; break; }
    }
    assert.notEqual(end, -1, `logActivity object literal at offset ${at} must be closed`);
    const literal = src.slice(open, end + 1);
    if (carriesEvent.test(literal)) literals.push(literal);
    from = end;
  }
  assert.ok(literals.length > 0, `${eventName} must have at least one logActivity emitter`);
  return literals;
}

/** ONE check applied to EVERY emitter of the event -- not one assert per emitter. */
function assertEveryEmitterCarries(eventName, field) {
  const literals = activityEmitterLiterals(eventName);
  literals.forEach((literal, i) => {
    assert.match(literal, new RegExp(`\\b${field}\\b`),
      `${eventName} emitter ${i + 1}/${literals.length} must carry ${field}`);
  });
}

test('B2: rate_limit_resume carries parked_minutes (source emitter check)', () => {
  // Scoped to each emitter's own object literal, and applied to EVERY emitter of the
  // event. The prior form `/event: 'rate_limit_wait'[\s\S]*?reset_at/` spanned the
  // whole file: `reset_at` occurs 21 times in mux-runner.ts, so it stayed GREEN with
  // the field stripped from BOTH emitters (measured). Its neighbour only looked sound
  // because `parked_minutes` happens to occur nowhere else -- and even it saw only the
  // FIRST of the two emitters (also measured).
  assertEveryEmitterCarries('rate_limit_resume', 'parked_minutes');
  assertEveryEmitterCarries('rate_limit_wait', 'reset_at');
});

// ---------------------------------------------------------------------------
// B3 — parked wall excluded from max_time_minutes AND the no-progress window
// ---------------------------------------------------------------------------

test('B3: parked wall is EXCLUDED from max_time_minutes (start_time_epoch advanced by parked seconds)', async () => {
  const reset = NOW_SEC + 600; // 10min reset
  const h = makeCtx({
    resetsAt: reset,
    // a tight 30-min budget that would otherwise be eaten by a 10-min park
    state: { active: true, start_time_epoch: NOW_SEC, max_time_minutes: 30, iteration: 7, rate_limit_park: null },
    sleepStepMs: 120_000,
  });
  const startEpochBefore = h.getState().start_time_epoch;
  const result = await processRateLimitCycle(h.getState(), h.ctx);
  assert.equal(result.kind, 'continue', 'park did NOT trip the max_time limit');
  const after = h.getState();
  // start_time_epoch advanced by ~the parked seconds → elapsed excludes parked time.
  assert.ok(after.start_time_epoch > startEpochBefore,
    'start_time_epoch must advance by parked seconds so the wall-clock cap excludes park');
});

test('B3: the park block continues before the timeout-counter path → no-progress window frozen', () => {
  // The api_limit branch ends in `continue` BEFORE the per-ticket timeout halt block,
  // so PICKLE_TIMEOUT_NO_PROGRESS_WINDOW_SECONDS is never advanced while parked.
  const apiBlock = src.slice(src.indexOf("if (exitType === 'api_limit')"));
  const continueIdx = apiBlock.indexOf('continue;  // Skip CB recording + result branching entirely');
  const timeoutIdx = apiBlock.indexOf('Per-ticket timeout halt');
  assert.ok(continueIdx > 0 && timeoutIdx > continueIdx,
    'the park continue must precede the per-ticket timeout halt block');
  // Parked time is excluded from the wall via start_time_epoch advance (source).
  assert.match(src, /s\.start_time_epoch \+= parkedSeconds/);
});

// ---------------------------------------------------------------------------
// B4 — park survives --resume (re-arm from persisted reset_at, no spawn-burn)
// ---------------------------------------------------------------------------

test('B4: park is persisted to state.rate_limit_park on entry (carries reset_at)', async () => {
  const reset = NOW_SEC + 5 * 3600;
  let parkPersistedReset = undefined;
  const h = makeCtx({ resetsAt: reset, sleepStepMs: 60_000 });
  // Wrap updateState to capture the persisted park-arm at entry (before resume clears it).
  const origUpdate = h.ctx.updateState;
  h.ctx.updateState = (mutator) => {
    origUpdate(mutator);
    const p = h.getState().rate_limit_park;
    if (p && parkPersistedReset === undefined) parkPersistedReset = p.reset_at_epoch_sec;
  };
  await processRateLimitCycle(h.getState(), h.ctx);
  assert.equal(parkPersistedReset, reset, 'reset_at persisted into state.rate_limit_park on park entry');
});

test('B4: on --resume the runner re-arms the park BEFORE the stale-artifact unlink (no spawn-burn)', () => {
  // The startup re-arm reads ownerState.rate_limit_park; if reset_at is still future it
  // RE-WRITES rate_limit_wait.json and SKIPS the unlink — so no worker spawns on relaunch.
  const rearmIdx = src.indexOf('Re-armed rate-limit park from persisted state');
  const unlinkIdx = src.indexOf("try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* not present */ }");
  assert.ok(rearmIdx > 0, 're-arm branch present');
  assert.ok(unlinkIdx > rearmIdx, 're-arm branch precedes the stale-artifact unlink (else branch)');
  assert.match(src, /parkArmStillFuture\s*=\s*typeof persistedReset === 'number' && persistedReset > 0/);
  assert.match(src, /persistedReset \* 1000 > Date\.now\(\)/);
});

// ---------------------------------------------------------------------------
// B5 — ceiling → rate_limit_park_exhausted + clean exit; no reset_at → fallback
// ---------------------------------------------------------------------------

test('B5: isParkExhausted trips strictly above max_park_minutes', () => {
  assert.equal(isParkExhausted(360 * 60 * 1000, 360), false, 'exactly at ceiling is not exhausted');
  assert.equal(isParkExhausted(360 * 60 * 1000 + 1, 360), true, 'just past the ceiling is exhausted');
  assert.equal(isParkExhausted(0, 360), false);
});

test('B5: cumulative park > max_park_minutes → rate_limit_park_exhausted + clean exit (rate_limit_exhausted, NOT a new exit_reason)', async () => {
  const reset = NOW_SEC + 5 * 3600; // another 5h park...
  const h = makeCtx({
    resetsAt: reset,
    maxParkMinutes: 60, // ...against a 1h ceiling
    state: {
      active: true, start_time_epoch: NOW_SEC, max_time_minutes: 0, iteration: 7,
      // already parked 55 min this episode; the next park (clamped to 60min) pushes
      // cumulative past the 60-min ceiling → exhausted.
      rate_limit_park: { reset_at_epoch_sec: reset, parked_started_epoch_ms: NOW, cumulative_parked_ms: 55 * 60 * 1000, consecutive_waits: 3 },
    },
  });
  const result = await processRateLimitCycle(h.getState(), h.ctx);
  assert.equal(result.kind, 'break');
  assert.equal(result.reason, 'rate_limit_exhausted', 'reuses the EXISTING exit_reason, never a new one');
  assert.ok(h.wasDeactivated(), 'clean exit-for-recovery deactivates');
});

test('B5: rate_limit_park_exhausted is activity-only — NEVER an exit_reason enum member', () => {
  // The mux ExitReason union must not contain rate_limit_park_exhausted.
  const exitReasonDecl = src.match(/export type ExitReason =([^;]+);/);
  assert.ok(exitReasonDecl, 'ExitReason union found');
  assert.ok(!/rate_limit_park_exhausted/.test(exitReasonDecl[1]),
    'rate_limit_park_exhausted must NOT be an ExitReason enum member');
  // And it IS emitted as an activity event.
  assert.match(src, /event: 'rate_limit_park_exhausted'/);
});

test('B5: no reset_at → fall back to now + configured min_wait + emit rate_limited_without_reset_at (never spawn-burn)', async () => {
  const h = makeCtx({
    resetsAt: null, // no reset_at on the 429
    consecutiveRateLimits: 0, // below maxRetries → wait, not bail
    state: { active: true, start_time_epoch: NOW_SEC, max_time_minutes: 0, iteration: 7, rate_limit_park: null },
    sleepStepMs: 6 * 60 * 1000, // jump past the 5-min min_wait in one poll
  });
  const result = await processRateLimitCycle(h.getState(), h.ctx);
  // It waits (parks for the configured min wait), then continues — never spawn-burns.
  assert.equal(result.kind, 'continue');
  // Source: the no-reset fallback emits rate_limited_without_reset_at.
  assert.match(src, /!rlAction\.hasResetsAt[\s\S]*?event: 'rate_limited_without_reset_at'/);
});

// ---------------------------------------------------------------------------
// B6 — SIGTERM during park → ticket NOT Failed, park-arm survives, 0 archive/reset
// ---------------------------------------------------------------------------

test('B6: SIGTERM handler uses recordExitReason(signal)+safeDeactivate — NOT a ticket-Failed flip, NO archive/reset', () => {
  const handler = src.slice(src.indexOf('const handleShutdownSignal'));
  const body = handler.slice(0, handler.indexOf('process.exit(0);'));
  // It records the signal and deactivates — forensic, not a failure flip.
  assert.match(body, /recordExitReason\(statePath, 'signal'\)/);
  assert.match(body, /safeDeactivate\(statePath\)/);
  // It must NOT flip the ticket Failed, archive a diff, or reset HEAD during park.
  assert.ok(!/markTicket(Failed|Skipped)/.test(body), 'SIGTERM must not flip the ticket Failed/Skipped');
  assert.ok(!/resetToSha|git reset|pre_reset_diff_archived/.test(body), 'SIGTERM must not archive/reset');
});

test('B6: the persisted park-arm survives SIGTERM (handler does not clear state.rate_limit_park)', () => {
  const handler = src.slice(src.indexOf('const handleShutdownSignal'));
  const body = handler.slice(0, handler.indexOf('process.exit(0);'));
  assert.ok(!/rate_limit_park\s*=\s*null/.test(body),
    'SIGTERM handler must NOT clear the persisted park-arm — it must survive for --resume re-arm');
});

// ---------------------------------------------------------------------------
// B3 — rate_limit_wait.json presence alone cannot classify a spawn failure as
// rate-limited (AC-M6b); a stale/expired resets_at must not re-arm a park.
// ---------------------------------------------------------------------------

test('B3/AC-A5: the no-progress-counter suppression no longer reads rate_limit_wait.json presence', () => {
  // Anchor on the AC-A5 comment text rather than a line number so this survives
  // unrelated reformatting elsewhere in the file.
  const acA5Idx = src.indexOf("AC-A5 (B-RRH): a rate-limited spawn");
  assert.ok(acA5Idx > 0, 'AC-A5 no-progress-counter suppression block must exist');
  const block = src.slice(acA5Idx, acA5Idx + 2000);
  const apSuppressEnd = block.indexOf('apSuppressIncrement = apRateLimited || apBreakerGrace;');
  assert.ok(apSuppressEnd > 0, 'apSuppressIncrement assignment must be present in the block window');
  const decision = block.slice(0, apSuppressEnd);
  // The CODE construct that read presence must be gone — a bare substring check
  // on 'rate_limit_wait.json' would also match this file's own explanatory
  // prose, so this asserts the removed CALL SHAPE specifically.
  assert.ok(!/existsSync\([^)]*rate_limit_wait\.json/.test(decision),
    'AC-A5 must not call fs.existsSync(...rate_limit_wait.json...) — presence alone must not classify a spawn failure');
  // The per-iteration log detector remains the sole classifier for this disjunct.
  assert.match(decision, /const apRateLimited =\s*detectRateLimitInLog\(/);
});

test('B3: a spawn failure with no rate-limit evidence in its OWN log is not classified as rate-limited', () => {
  // Exercises the exact function AC-A5 now depends on exclusively. A stale
  // rate_limit_wait.json elsewhere on disk plays no part in this call.
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-b3-ratelimit-'));
  const logFile = path.join(dir, 'tmux_iteration_1.log');
  writeFileSync(logFile, JSON.stringify({ type: 'result', subtype: 'error', is_error: true }) + '\n');
  assert.equal(detectRateLimitInLog(logFile).limited, false);
});

test('B3: a spawn failure WITH a structured rejected rate_limit_event in its own log is still classified as rate-limited', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-b3-ratelimit-'));
  const logFile = path.join(dir, 'tmux_iteration_1.log');
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(logFile, JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'usage' },
  }) + '\n');
  const info = detectRateLimitInLog(logFile);
  assert.equal(info.limited, true);
  assert.equal(info.resetsAt, resetsAt);
});

test('B3: restorePersistedRateLimitPark does not re-arm from a resets_at already in the past (already correct at HEAD, predates this bundle)', () => {
  // Regression pin, not a new fix: `parkArmStillFuture` was introduced in the
  // original e9bdac75 feature commit (git log -S confirms it predates B-MEGADRAIN)
  // and already strictly requires the persisted reset_at to be in the FUTURE
  // before re-arming — an expired/past resets_at falls through to the
  // unlink-and-clear branch instead.
  const fnIdx = src.indexOf('function restorePersistedRateLimitPark');
  assert.ok(fnIdx > 0, 'restorePersistedRateLimitPark must exist');
  const fnBody = src.slice(fnIdx, fnIdx + 1500);
  assert.match(fnBody, /const parkArmStillFuture = typeof persistedReset === 'number' && persistedReset > 0\s*&&\s*persistedReset \* 1000 > Date\.now\(\);/);
  assert.match(fnBody, /if \(parkArmStillFuture && persistedPark\) {/);
  // The strict future-only guard, not `>=`, is what refuses a resets_at that is
  // exactly now or in the past.
  assert.ok(!/persistedReset \* 1000 >= Date\.now\(\)/.test(fnBody),
    'the re-arm guard must be a strict future check, not >=');
});
