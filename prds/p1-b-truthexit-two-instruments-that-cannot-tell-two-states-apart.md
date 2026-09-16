# B-TRUTHEXIT — two instruments that cannot tell two states apart

**Both bugs are one shape:** an instrument collapses two distinguishable states into one output, and the
collapsed output is the one that reads as a defect. Neither is a new capability; both are **subtractions
of ambiguity**. GitHub **#33**, **#34**.

**Why this bundle is small and ships anyway:** #34 is a **hard prerequisite** of [[B-LENS]] ROOT L7
("the loops should fix all issues they find") — routing the citadel channel into the fixer before the
matcher is repaired would spend ~121 iterations adding anchors that already exist. #33 is bundled with
it because it is the same shape on the same day, not to pad the roster. **Two roots is the honest size;
do not inflate it.**

---

## 🚧 ROOT T1 — `test-runner` reports a KILLED child as a FAILED one (#33)

`extension/src/bin/test-runner.ts:438`, the terminal line of every tier run:

```ts
const result = spawnSync(process.execPath, nodeArgs, buildTestSpawnOptions(disposableTmpRoot));
…
process.exit(result.status ?? 1);
```

`spawnSync` returns `status` **and** `signal`. A child killed by a signal has `status: null` and `signal`
set; `?? 1` collapses that to **exit 1 — byte-identical to a genuine test-failure exit**.
**`result.signal` is never read anywhere in the file** (`grep -c 'result\.signal'` → **0**); the only
signal-adjacent code is `reapTimedOutChild`, which keys on `result.error.code === 'ETIMEDOUT'` — an
error, not a signal.

**Measured consequence.** `post_final_tier_degraded` fires in exactly three sessions, all ending
`status: failed`. The one carrying a diagnostic tail reports:

```
tests 9538 · suites 579 · pass 9534 · fail 0 · skipped 3 · duration_ms 254138
```

**Zero failures, non-zero exit, classified red, `nonConvergent` raised, success verdict withheld.**

**A signal death is a SUFFICIENT explanation, and is deliberately NOT claimed as THE explanation** — the
instrument discards the field that would decide it. **That discard is the defect.** Do not write a
ticket that asserts those three runs were killed.

### AC-T1
- **AC-T1-1 (the mechanism):** a child that exits via signal is reported as such. The signal reaches the
  exit path, and from there into `post_final_verdict.dimensions`, so a killed tier reads as killed.
- **AC-T1-2:** a child that genuinely fails tests is UNCHANGED — same exit code, same message. This root
  must not alter the failing path at all.
- **AC-T1-3 (mutation, both directions):** kill a child with `SIGKILL` after it prints its summary ⇒ the
  new attribution appears. Make a test genuinely fail ⇒ the attribution does **not** appear and the old
  behaviour holds. **One direction alone passes a carry-anything change.**
- **AC-T1-4:** `process.exit(result.status ?? 1)` keeps returning a non-zero code for a killed child —
  this is an ATTRIBUTION fix, not a "treat kills as success" fix. **A killed tier is still not green.**
- **AC-T1-5:** no new `EXIT_REASONS` member, no new gate leg, no halt. Assert the member COUNT.
- **AC-T1-6 (do NOT widen scope):** the downstream question — whether `degraded: true` should still
  withhold a success verdict when the tier reported `fail 0` — is **out of scope**. It is a policy call
  and it is the operator's. Record it, do not change it.

---

## 🚧 ROOT T2 — citadel's anchor matcher rejects the repo's own test-naming convention (#34)

`extension/src/services/citadel/trap-door-coverage-audit.ts:237`:

```ts
function hasTestCase(content: string, anchor: string): boolean {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:it|test)\\s*\\(\\s*['"\`]${escaped}['"\`]`).test(content);
}
```

The closing quote is required **immediately** after the anchor, so only a test titled *exactly* the
anchor matches. **The repo's convention is `'<anchor>: <description>'`, used by 2040 tests.**

**Measured on the last run's `citadel_report.json`:**

| | |
|---|---:|
| findings | 163 |
| from `source_section: trap_door_coverage` | 162 |
| of shape `ENFORCE anchor #X not found in <file>` | 147 |
| **anchor IS present in that file — FALSE** | **121** |
| anchor genuinely absent — REAL | **26** |

`AP-RMS-9` appears **3 times** in `extension/tests/spawn-refinement-team-checker.test.js`, including the
test at line 495, and citadel reports it missing from that exact file. Meanwhile
`scripts/audit-trap-door-enforcement.sh`, auditing the same invariant, exits **0**.

**The channel is 18% signal, not 0%.** The 26 are real and unfixed today. **Repair the matcher; do not
delete the check.**

### AC-T2
- **AC-T2-1 (the mechanism):** `hasTestCase` accepts `'<anchor>: <description>'` and any other boundary
  the repo actually uses, and still accepts a title that is exactly the anchor.
- **AC-T2-2 (BOTH halves, and this is the whole ticket):** re-running the audit over the same tree must
  clear **the 121** and **keep the 26**. **A widening that also clears the 26 has broken the check, not
  fixed it** — assert both counts, not just the drop.
- **AC-T2-3 (prefix safety):** the anchor must not match a LONGER anchor sharing its prefix —
  `AP-EXT-ITER4-01` must not satisfy a reference to `AP-EXT-ITER4-011`, and vice versa. Use a boundary,
  not a bare `startsWith`.
- **AC-T2-4 (do not re-create a known past bug):** a previous defect in this family truncated the anchor
  at the first space, so `#exits` matched 25 unrelated tests. **The widening must not make a short or
  generic anchor match broadly.** Pin it with a deliberately generic anchor.
- **AC-T2-5 (agreement with the authoritative audit):** after the fix, citadel's `trap_door_coverage`
  High count and `audit-trap-door-enforcement.sh` must not contradict each other on the same tree. If
  they still disagree, that disagreement is the finding — report it rather than tuning until they match.
- **AC-T2-6 (mutation, both directions):** delete a genuinely present anchor ⇒ a finding appears. Add one
  of the 121 back as a real absence ⇒ it is reported. Revert the matcher ⇒ the 121 return.

---

## 🔌 Interface Contracts

| symbol | location | note |
|---|---|---|
| `hasTestCase` | `services/citadel/trap-door-coverage-audit.ts:237` | unexported module-local — pin through the audit's own entry point, or export only if the ticket justifies it |
| the anchor finding | same file, `:176` | message shape `ENFORCE anchor #X not found in <path>` |
| `process.exit(result.status ?? 1)` | `bin/test-runner.ts:438` | the collapse site |

**T1 output:** the exit path additionally reports the signal when one is present. A killed child stays
non-zero.
**T2 output:** unchanged finding shape; only the matcher's acceptance set changes.

---

## 🧪 Verification Strategy

| what | command |
|---|---|
| types | `./node_modules/.bin/tsc --noEmit` |
| lint | `./node_modules/.bin/eslint src/ --max-warnings=0` |
| compile before running tests | `./node_modules/.bin/tsc` |
| the two suites | `node bin/test-runner.js tests/test-runner-timeout.test.js tests/citadel/trap-door-coverage-audit.test.js --test-concurrency=1` |
| the authoritative cross-check (T2) | `bash scripts/audit-trap-door-enforcement.sh` — exits 0 today and must keep exiting 0 |

**Replay corpus for T2, already on disk and re-derivable:** the last run's `citadel_report.json`
(163 findings). The 121/26 split is reproduced by, for each `ENFORCE anchor #X not found in <path>`
finding, testing whether `X` occurs in `<path>`.

**No executable-form criteria are offered.** The obvious ones are true at HEAD and could not tell "the
fix landed" from "nothing happened". Add one only if it is FALSE at HEAD and TRUE after, and prove the
first half before writing it down.

---

## 📋 Test Expectations

▶ marks a MECHANISM row: it must exercise the real code path, not a hand-built input.

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| ▶ AC-T1-1 | `tests/test-runner-timeout.test.js` | signal reaches the exit path | a SIGKILLed child is reported as killed |
| AC-T1-2 | `tests/test-runner-timeout.test.js` | failing path untouched | a genuine test failure exits exactly as before |
| AC-T1-3 | `tests/test-runner-timeout.test.js` | mutation both ways | kill ⇒ attribution present; fail ⇒ attribution absent |
| AC-T1-4 | `tests/test-runner-timeout.test.js` | a kill is still non-zero | exit code non-zero |
| AC-T1-5 | `tests/nostop-gates-invariant.test.js` | set size | `EXIT_REASONS.length` unchanged |
| ▶ AC-T2-1/2 | `tests/citadel/trap-door-coverage-audit.test.js` | replay the real corpus | the 121 clear **and** the 26 remain |
| AC-T2-3 | `tests/citadel/trap-door-coverage-audit.test.js` | prefix safety | `…4-01` does not satisfy `…4-011` |
| AC-T2-4 | `tests/citadel/trap-door-coverage-audit.test.js` | generic-anchor control | a short generic anchor does not match broadly |
| AC-T2-5 | `tests/citadel/trap-door-coverage-audit.test.js` | agreement | citadel and the shell audit do not contradict on one tree |
| AC-T2-6 | `tests/citadel/trap-door-coverage-audit.test.js` | mutation both ways | delete a present anchor ⇒ reported; revert matcher ⇒ 121 return |

---

## 🛡 PRIME DIRECTIVE compliance

- **No halt, no abort, no phase-loop break.** Neither root touches the loop.
- **No new gate leg.** T2 repairs an existing detector; T1 repairs an existing exit path.
- **`EXIT_REASONS` gains nothing** (AC-T1-5).
- **Both roots are subtractions of ambiguity:** each removes a collapse between two states the system
  already distinguishes internally — `status` vs `signal`, and "anchor absent" vs "anchor present under
  our own naming convention".
- **Would the next iteration have caught these?** No. #34 has been reporting 147 Highs that nobody acts
  on, which reads more reassuring the longer it runs; #33's three firings each looked like a fresh
  one-off. Both rot silently, which is what earns a permanent fix.

## Non-goals

- Do NOT change whether `degraded: true` withholds a success verdict (AC-T1-6) — operator policy.
- Do NOT delete citadel's `trap_door_coverage` section — it is 18% signal.
- Do NOT tune the matcher until it agrees with the shell audit (AC-T2-5); report a residual disagreement.
- Do NOT treat the three `post_final_tier_degraded` runs as proven signal deaths.
- Do NOT pad this bundle to hit a ticket count.

## Simplification Review

**T2 is one regex and its controls.** T1 is one field carried through an exit path. Neither needs a new
module, artifact or contract — and if either grows one, that is the signal to stop and re-scope.

**The risk is a vacuous green, as always.** AC-T2-2 is the load-bearing one: a widening that clears all
147 would look like a triumphant fix and would mean the check no longer checks anything. **Assert the 26
survive.**
