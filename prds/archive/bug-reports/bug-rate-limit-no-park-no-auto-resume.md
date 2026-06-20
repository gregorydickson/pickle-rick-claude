# Bug: rate-limit detection neither parks the run nor auto-resumes — burns iterations into the wall, then idles past reset

**Filed**: 2026-06-11 (babysitter interventions #3/#4, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle)
**Severity**: P1 — every long run that crosses a five-hour API window loses hours and risks spurious ticket/run state damage
**Status**: Open

## Incident

mux-runner detected the limit correctly and repeatedly, WITH the reset time in hand:

```
[02:21:17] API rate limit detected (consecutive: 2/3)
[02:21:17] API reports reset at 2026-06-11T06:20:00.000Z (type: five_hour)
[03:05:44] API rate limit detected (consecutive: 4/3)
```

What it did with that knowledge — nothing structural:

1. **D1 — spawn-burn instead of park.** Iterations kept advancing (~5 min cadence, iter 27→31) spawning managers/workers that immediately 429'd and exited with 0-byte logs. Pure quota+iteration waste against a wall with a KNOWN reset time.
2. **D2 — zero-progress counters charged against innocent tickets.** Each 429'd spawn incremented `worker_artifact_progress.zero_progress_count` for the current ticket (0780b805 hit the 3-spawn observe threshold at 03:26; sibling counters: 931c492f at 5, 08e75a59 at 3). Combined with B-LERD (`ladder_exhausted` exits the run), the rate limit was ~1-2 iterations from killing the whole bundle and possibly flipping a healthy ticket. The babysitter manually stopped the runner at 03:45 to preempt it.
3. **D3 — no auto-resume.** Nothing in the runtime schedules a resume at the reported reset time. The manual stop idled 06:20→12:33 (6h13m of lost runtime) until the next babysitter tick. Even absent manual intervention, a ladder-exit during the limit would equally have left the run dead past reset.

## Recovery applied (this incident)

- Manual stop at 03:45Z pre-exhaustion (controlled pause; runners + parked workers killed).
- At 12:33Z tick: found uncommitted-but-green H3 work in the tree (`archiveBeforeDestructive` + 10/10 tests) — committed reset-proof as `e4b6cdda` per the commit-verified-work-first doctrine; cleared the stale `worker_artifact_progress['0780b805']` counter; `setup.js --resume` + relaunch. Iteration 32 proceeding on 0780b805.

### Refinement (2026-06-11 tick, from preserved manager-prompt forensics)

A fixed-interval pause ALREADY EXISTS: the resumed manager prompt carries "NOTE: Resumed after 5-minute API rate limit wait (source: config)". So the runtime parks for a config-sourced 5 minutes and resumes — regardless of the reported `reset_at` being hours away. D1 is therefore "fixed-interval wait ignores reset_at", not "no wait exists". The fix below should REPLACE the 5-minute config wait's resume condition (park until `max(reset_at + jitter, now + configured_min_wait)`) rather than introduce a parallel mechanism.

### Second occurrence (2026-06-11 13:37Z, same session)

Next five_hour window: 3/3 consecutive at 13:37Z, reset 17:30Z, workers dying at 0 within ~17 minutes of the prior window's work resuming. Babysitter response upgraded: clean stop BEFORE any zero-progress accounting (wap counter for in-flight ticket 90574654 confirmed at 0), one-shot timed auto-resume armed for 17:36Z. Confirms the bug bites every ~5h window boundary on long bundles — roughly 3-4 times across this 25-ticket run.

### Third occurrence (2026-06-11 16:05Z, fresh account)

The fresh-quota account hit its OWN five_hour window ~2h after switch-over (2/3 at 16:05Z, reset 19:00Z). Confirms the bug is account-agnostic and recurs on EVERY window boundary — at large-tier parallel-worker burn this is roughly every 2-4 tickets regardless of which account. By 2/3 the in-flight ticket (e56ed23f/H1) had already taken `zero_progress_count: 1` from a 429'd spawn that produced no artifacts — the counter-poisoning pathway composing with B-LERD, exactly as predicted. Babysitter stopped at 2/3 (pre-3/3, pre-burn), cleared the H1 counter, armed timed resume for 19:06Z. Pattern across this single run: 3 window walls, all babysitter-handled.

## Fix proposal (machine-checkable)

1. **Park-until-reset**: on `consecutive >= threshold` with a reported reset time, the runner enters `rate_limit_parked`: no manager/worker spawns, no iteration advance, no zero-progress accounting; emit `rate_limit_parked {reset_at, ts}`; sleep in capped intervals re-checking a probe call.
2. **Auto-resume**: at `reset_at + jitter (60-120s)`, probe once; success → emit `rate_limit_resumed {parked_minutes, ts}` and continue the SAME iteration (counters untouched). Probe still limited → re-park to the new reported reset.
3. **Counter immunity**: spawn outcomes classified as rate-limited NEVER increment `worker_artifact_progress.zero_progress_count` nor any recovery-ladder counter (compose with B-LERD fix #1).
4. **Wall-clock exclusion**: parked time excluded from `max_time` budget accounting when a session wall is set.
5. AC: fixture with injected 429-classifier responses → runner parks within one iteration (zero spawns while parked, counters frozen, event emitted), fake clock past reset + healthy probe → resumes same ticket, total spawns during park == probe calls only. Park/resume round-trip survives a `setup.js --resume` mid-park.

## Verification of recovery

- `e4b6cdda` on main (tsc clean, 10/10 guarded-reset tests).
- mux-runner.log 12:34:40Z: Iteration 32, current_ticket=0780b805, orphan manager reaped, worker spawned.
