# BUG 2026-08-24 — `monitor.test.js` cancellations under Node 22

**Status:** Open
**Filed by:** ticket `139925d8` (Part B), per the refined PRD's section-1 ruling that these
cancellations be **re-filed, not silently dropped**.
**Owner surface:** `extension/src/bin/monitor.ts` — **product code**.

> **Read the mechanism section before scoping any ticket off this PRD.** A ticket scoped to
> `extension/tests/monitor.test.js` is **unsatisfiable by construction**. The prior PRD's Non-goals
> line pointed the implementer away from the only file that could change, and that is why this
> report exists a second time.

---

## 1. Summary

`extension/tests/monitor.test.js` reports 20 cancelled tests, not failures. The cancellation is
caused by a **deliberately `.unref()`'d watchdog timer in product code** at
`extension/src/bin/monitor.ts:93-103`, and it is gated on the **Node major**, not the host OS.

The prior report attributed this to darwin. That attribution does not survive measurement: the same
20 cancellations reproduce on Node 22 and vanish on Node 24 **on the same darwin host**, and the same
20 test names are present in the `ubuntu-latest` failure set.

---

## 2. Mechanism (the load-bearing section)

`writeWithWatchdog` (`extension/src/bin/monitor.ts:85-103`) returns a promise settled by either the
write callback, a `'drain'` listener, or a watchdog `setTimeout`. That timer is then unref'd:

```ts
const timer = setTimeout(() => {
  finish(new Error(
    `monitor stdout watchdog: no drain within ${watchdogMs}ms (pane wedged?)`
  ));
}, watchdogMs);
// Allow the process to exit if the watchdog timer is the only
// remaining handle (e.g., during shutdown).
if (typeof (timer as { unref?: () => void }).unref === 'function') {
  (timer as { unref: () => void }).unref();
}
```

The unref is **intentional and correct for production**: the monitor must never delay process exit
because a watchdog is pending. In production the process always has other active handles, so the
timer fires normally.

Under test, a sink that never drains leaves that unref'd timer as the **only** thing that can settle
the awaited promise. Being unref'd, it does not hold the event loop open. On Node 22 the runner
drains the loop, the await is still pending, and `node:test` emits:

```
failureType: 'cancelledByParent'
error: 'Promise resolution is still pending but the event loop has already resolved'
```

which cancels the enclosing test and **every test after it in the file**.

**Why a test-scoped ticket cannot satisfy this.** The unsettled promise is manufactured by product
code. `monitor.test.js` can only either (a) stop exercising the watchdog path — deleting the
coverage that the two `writeWithWatchdog` tests exist to provide — or (b) hold a ref'd timer on the
loop to paper over it. Neither changes the fact that `writeWithWatchdog` can return a promise with
**zero** terminal outcomes. Fixing that means editing `monitor.ts`.

### 2.1 The same defect has a sibling

`extension/src/services/codegraph-service.ts:406-413` (`runWithTimeout`) contains the identical
construct — an unref'd timeout timer that is the sole settler — and its doc comment at `:395-399`
explicitly claims *"EXACTLY ONE terminal outcome: timeout-degrade, success, or error-degrade."*
With the unref, zero outcomes is reachable. It produced 18 cancellations by the same mechanism.

Ticket `139925d8` resolved the **codegraph test suite** with a test-scoped keep-alive (no product
change, no assertion touched), explicitly deferring the product-level question to this PRD. The
owner of this PRD inherits **both** call sites: whether an unref'd timer may leave a promise
permanently unsettled is one decision, and it currently has two instances.

---

## 3. Evidence

### 3.1 Measured on darwin — **HOST-LOCAL** (arm64, macOS 23.6.0)

**These are host-local observations. They are evidence about the mechanism and about the Node-major
dependency. They are NOT evidence about the CI gate.**

Same file, same working tree, two Node majors:

| Node | `monitor.test.js` | `codegraph-service.test.js` |
|---|---|---|
| v24.19.0 | `pass 74, fail 0, cancelled 0` | `pass 19, fail 0, cancelled 0` |
| **v22.23.2** | `pass 54, fail 0, **cancelled 20**` | `pass 1, fail 0, **cancelled 18**` |

Every cancelled entry on v22.23.2 carries `failureType: 'cancelledByParent'` and
`error: 'Promise resolution is still pending but the event loop has already resolved'`.

20 + 18 = **38**, and the per-file split (20 from monitor) reproduces the prior report's
"38 cancellations, 20 of them its own" exactly — while reassigning the cause from the host to the
Node major.

A minimal standalone reproduction (unref'd timer racing a never-settling promise) gives
`pass 0, cancelled 2` on v22.23.2 and `pass 2, cancelled 0` when a single ref'd timer is held across
the await — confirming loop-drain, not a timeout, is the trigger.

### 3.2 Measured on `ubuntu-latest` — CI

Source: Release run `32689967189`, job `97321772822`, tag `v2.1.0-beta.13`, 2026-08-24T04:25:42Z.
Runner `Image: ubuntu-24.04` (`ubuntu24/20260816.277`), Node **v22.23.2** — the same Node major as
the darwin reproduction above.

`npm run test:fast:budget` exited `FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=3
runs_requested=5` (`failures=3` counts failed **runs**, not tests). The `REPEATED ACROSS RUNS` block
lists **69 test names**, failing in all 3 runs. Mapping those names back to their source files
(68 of 69 are unique to one test file):

- **`monitor.test.js` accounts for 20 of the 69.** The suite **is** in the Linux failure set.
- `codegraph-service.test.js` accounts for 18 more.
- The remaining 31 belong to a mechanically distinct class (missing `corepack`/`EXTENSION_DIR`
  provisioning in `release.yml`), fixed under ticket `139925d8` Part A.

### 3.3 Correction — three earlier "ubuntu counter-evidence" readings are not measurements

The prior report cited, from the 87,992-byte CI log: `monitor.test.js` occurring **0** times,
`cancelled` occurring **0** times, and `Promise resolution is still pending` occurring **0** times.
All three counts are accurate, and none of them mean what they were read to mean.

`check-flake-budget.ts:249-292` (`runIterations`) captures each tier run with
`spawnSync(..., { encoding: 'utf8' })`, writes the full stdout/stderr to
`/tmp/flake-budget-logs-*/run-N.log` — **never uploaded as a CI artifact** — and prints to the
console only names extracted by `extractFailingTestDetails` (`:131-144`), which captures the test
**name** from `^✖ <name>` / `^not ok N - <name>` and **no file path**.

Consequently:

- **`monitor.test.js: 0`** is a tautology. No file path is ever printed, for any suite. The count is
  0 for all 15 failing files, including the three the prior ticket named as authoritative.
- **`cancelled: 0`** and **`pending: 0`** are tautologies. No raw `node:test` output reaches the CI
  log at all; both strings exist only in the un-uploaded per-run temp logs.

The related inference — *"38 cancellations would have printed ~38 names; 3 printed"* — also does not
hold: **69** names are printed under `REPEATED ACROSS RUNS`. The `3` was the failed-**run** count
from the `FAIL_BUDGET_EXCEEDED` header.

**None of this makes the darwin measurements wrong.** They were real. What was wrong was the
inference that CI *disagreed* with them — the log was simply silent on the question.

---

## 4. Consequence

1. **The release gate is reddened on `ubuntu-latest`.** 20 of the 69 repeated failures in run
   `32689967189` are `monitor.test.js`. After ticket `139925d8` Part A lands (which clears 31 + 18 =
   49 of the 69), these 20 remain and continue to contribute to `FAIL_BUDGET_EXCEEDED`. **The gate
   does not go green on this PRD's work being deferred.**
2. **Darwin contributors see 20 cancellations locally on Node 22.** `extension/package.json`
   `engines.node` pins the 22 line and all three workflows pin `22.x`, so this is the supported
   configuration, not an off-pin edge case.
3. **The signal is misleading in both directions.** Cancellations surface as anonymous
   "failing tests" through the flake-budget reporter, with no file path and no cancellation marker —
   which is precisely how this was mis-attributed to darwin for a full cycle.
4. **A latent product-behaviour question is open.** `writeWithWatchdog` and `runWithTimeout` can each
   return a promise that never settles when their unref'd timer is the only remaining handle. In
   production other handles mask it. Whether that is acceptable is this PRD's call to make.

---

## 5. Suggested scope for the fixing ticket

- **In scope:** `extension/src/bin/monitor.ts` (the unref'd watchdog at `:93-103`), and a decision on
  the sibling at `extension/src/services/codegraph-service.ts:413`.
- **Explicitly in scope:** `extension/tests/monitor.test.js` — but only as a *consumer* of the
  product fix. It cannot be the whole fix.
- **Do not** resolve this by deleting or weakening the two `writeWithWatchdog` tests. They are the
  only coverage of the wedged-pane path.
- **Verification must pin the Node major**, e.g.
  `node --test extension/tests/monitor.test.js` under **v22.23.2**, asserting `cancelled 0`.
  Verifying on Node 24 alone proves nothing: the file already passes 74/74 there.
- **Consider** whether the flake-budget reporter should surface file paths and the TAP
  `# cancelled` directive (`check-flake-budget.ts:131-144`). It is not the defect, but it is what
  made the defect unreadable from CI. Per `CLAUDE.md` "Filing findings", this is recorded as an
  observation here, not opened as its own PRD.
