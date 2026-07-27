# BUG REPORT 2026-07-27 — R-MVPARK: the microverse park has no cumulative ceiling, and ignores the operator's

**Found:** live, during the B-GITATTR run (session `2026-07-26-013335ff`), anatomy-park phase 3/4.
**Status:** verified by grep at HEAD `6d9d9faf`. Not fixed. Run not interrupted.
**Class:** B-RRH applied to one caller, missed in its sibling — the same shape as R-NSG-AJBE.

---

## What was observed

Anatomy-park parked for **exactly 6 hours** mid-run and resumed correctly:

```
2026-07-27T05:44:37Z  API rate limit detected (consecutive: 1/3)
2026-07-27T05:44:37Z  Rate limit wait: 360min (source: api)
2026-07-27T11:44:42Z  [anatomy-park] refreshing per-iteration gate baseline (24649s old > 14400s max)
2026-07-27T11:44:48Z  --- Iteration 5 ---
```

Parking beats dying, and the stale-baseline recapture on resume is exactly right. The bug is not that it
parked. **It is that nothing bounds how many times it can.**

## The defect

`computeRateLimitAction` is exported from `mux-runner.ts:3183` and shared by both runners:

```ts
export function computeRateLimitAction(
  exitResult, consecutiveRateLimits, maxRetries, configWaitMinutes,
  maxParkMinutes: number = DEFAULT_MAX_PARK_MINUTES,   // 360, pickle-utils.ts:843
): RateLimitAction
```

| Caller | Args passed | Cumulative ledger |
|---|---|---|
| `mux-runner.ts:6911`, `:10660` | **5** — passes resolved `maxParkMinutes` | ✅ `state.rate_limit_park` (11 refs to `isParkExhausted`/`cumulative_parked_ms`) |
| `microverse-runner.ts:4132` | **4** — omits the 5th | ❌ **zero** refs to `rate_limit_park`; 0 refs to `resolveRateLimitSettings`/`max_park_minutes` |

Two consequences, with different severities. Keeping them separate matters — one is currently invisible.

### (a) LOAD-BEARING — cumulative park is unbounded on the microverse phases

The B5 trap door in `extension/CLAUDE.md` states the contract plainly:

> `computeRateLimitAction` clamps **one** wait to `maxParkMs`, so `isParkExhausted` fires only on the
> **cumulative** term. BREAKS: … `rate_limit_park_exhausted` unreachable; B3 exempts parked wall from
> `max_time_minutes`, so a 429 storm is unbounded.

microverse-runner has the clamp (each single wait ≤ 6h) and **not** the accumulator. Its only bound is a
consecutive **count** — `consecutiveRateLimits >= maxRetries` (3) → `rate_limit_exhausted` — and that
counter is **reset to 0 on any successful iteration** (`microverse-runner.ts:4363`, also `:3208` via
`resetRateLimitCounter`).

So the unbounded pattern is:

```
park 6h → iteration succeeds → counter resets to 0 → park 6h → succeeds → …
```

Bounded only by `max_iterations` (500 here). With `max_time_minutes` disabled — which is the **default**,
and is what this session runs (`Max Time: ∞`) — there is no wall-clock backstop at all. Three *consecutive*
parks bail at 18h; any success in between resets the ledger to zero.

This bites TARGET repos, not just self-builds: any `/pickle-pipeline` reaching anatomy-park or
szechuan-sauce on a rate-limited account can park indefinitely overnight, which is the precise failure mode
B-RRH was built to end.

### (b) LATENT — the operator's `max_park_minutes` is ignored on those phases

microverse-runner never resolves `pickle_settings.rate_limit`, so it uses the compiled default. mux-runner
resolves and passes it.

**Currently invisible, and I want that on the record rather than overstated:** the shipped setting is
`{"max_park_minutes": 360}` — identical to `DEFAULT_MAX_PARK_MINUTES = 360`. So today both paths clamp to
6h and no divergence is observable. The observed 360min park is consistent with either. This leg becomes
real the moment an operator changes the setting: pickle would honor it, anatomy-park and szechuan-sauce
would silently keep 6h.

## Why this is the R-NSG-AJBE shape again

B-RRH built the cumulative ledger and wired it into `mux-runner`'s two call sites. The third caller — in a
different file, reached only on phases 3 and 4 — kept the old count-only behaviour and inherited a defaulted
parameter that made the omission invisible at the type level. A defaulted 5th argument is exactly the kind
of seam a per-site fix slides past: the sibling still compiles, still runs, and silently gets different
semantics.

That is the second instance today of *"the fix landed on the callers we enumerated."* The generalizable
lesson from R-NSG-AJBE applies verbatim: the deliverable is an invariant with reach, not a set of patched
sites.

## Fix direction (subtractive first)

1. **Preferred — one park implementation, not two.** The cumulative ledger already exists, is persistent
   across relaunch, and is tested. Route the microverse path through the same
   `state.rate_limit_park` accumulator rather than growing a second ledger beside it. Two park
   implementations with two budgets is the duplicated-mechanism smell; deleting one is the win.
2. If (1) is too large for one bundle, the minimum correct step is to pass the resolved `maxParkMinutes`
   as the 5th argument at `microverse-runner.ts:4132` **and** accumulate — passing the arg alone only
   fixes leg (b) and leaves the unbounded leg untouched. Do not stop at the arg.
3. **Add the invariant, not just the fix:** a test asserting **every** `computeRateLimitAction` call site
   passes the cumulative-bounding argument, enumerated structurally rather than by name list. Without it a
   fourth caller repeats this.

## Not doing now, and why

The run is healthy at 10/10 tickets Done, phase 3/4, ~8.5h of real work behind it. Interrupting a live
pipeline to fix a defect that is now recorded would risk verified work for no gain — and the park behaviour
is *safe*, merely unbounded. Filed for the drain queue.
