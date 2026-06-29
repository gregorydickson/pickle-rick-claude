# Hardcoded-Date Fixture Time-Bomb Audit — 2026-06-29

**Ticket:** B-RELHYG WS-2 (`3aae3870`) · **Verdict:** null diff — zero genuine time-bombs.

## What a time-bomb is

A fixture `started_at` (or equivalent ISO date) is a genuine time-bomb **iff** its hardcoded value is
compared against the real wall-clock (`Date.now()`) in a way that flips a test result as the date ages.

## The only wall-clock comparator for `started_at`

`pruneOldSessions` (`src/services/pickle-utils.ts`, `maxAgeDays = 7`), called **exclusively** from
`src/bin/setup.ts`. So a fixture is at risk only if a test **spawns `setup.js` as a subprocess** AND feeds it
a **hardcoded** `started_at`. Other comparators are not time-bomb vectors here:
- `preferNewerSession` / `getSessionRecencyMs` — relational (date_A vs date_B), not vs now (except a defensive
  future-skew guard, which the `2099-12-31` sentinels deliberately exercise).
- `mux-runner` time budgets use `start_time_epoch`, not `started_at`.

## Result

Of the 36 files carrying a hardcoded `started_at` ISO date, **none** also spawns `setup.js` with a hardcoded
date. The intersection (setup.js-spawners ∩ hardcoded `started_at`) is **empty**. Every audited file pins its
date for deterministic output and never compares it to real "now".

Spot-checked setup.js-spawning files that do carry hardcoded ISO datetimes:
- `beta6-ga-session-resume.test.js` — `started_at` is dynamic (`new Date(Date.now() - 3600000)`, the precedent
  fix); its `2026-06-15` values are `ts` activity-event fields, never prune-compared.
- `setup.test.js` — clock mocked (`mock.timers.enable` @ `2026-04-29`); `2099-12-31` is the future-skew sentinel.
- `pipeline-runner.test.js`, `mega-bundle-e2e.test.js` — relational / self-consistent fixed scan bounds.

## Conclusion

The codebase does **not** have a widespread `started_at` time-bomb class in test fixtures. The beta6 incident
was the lone genuine case and is already fixed. No fixtures were converted (converting deterministic-date
fixtures would needlessly churn them). A forward-protection lint was filed as out-of-scope — open only if the
class recurs.
