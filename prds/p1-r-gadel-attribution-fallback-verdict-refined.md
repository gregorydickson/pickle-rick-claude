---
title: "R-GADEL — answer whether the Pickle-Ticket trailer covers what message inference covered, then act on the answer [REFINED]"
priority: P1
finding: R-GADEL
status: needs-operator-decision
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
build_mode: attended
source_assessment: "Refined 2026-08-04 by the 3-role x 3-cycle analyst team (session 2026-08-04-35db3a3b), all_success=true. Author's retraction below: 6 premises corrected, 1 blocking contradiction surfaced."
---

# R-GADEL *(refined)*

## 0. AUTHOR'S RETRACTION — what refinement corrected

I authored this PRD, self-tested one of its ACs, and still shipped six defects. Recorded per
`prds/CLAUDE.md` discipline. **Analyst cross-correction was the mechanism** — the codebase analyst
falsified the requirements analyst's headline split by *running* the tests, and the risk analyst
falsified two recommendations both siblings had endorsed.

| # | My claim | Corrected finding | Source |
|---|---|---|---|
| **R1** | AC-GADEL-A2 is well-formed — "verified to extract exactly 10 tokens" | The grep is **unfenced over the whole PRD file**. Ten today is a *coincidence of the draft*, not a property of the AC. Adding any `file:line` anywhere — evidence, an example, a risk note — silently **adds a mandatory Verdict row**. My self-test proved the draft, not the contract. | all 3 |
| **R2** | "WS-A gates B; produce it FIRST" | **The gate is prose.** Not one of AC-B1…B5 reads, greps, or requires the matrix. If ticket 10 parks or emits an empty file, **every WS-B AC is still satisfiable** — WS-B drives the tier green and comments verdicts it invented. | requirements, risk |
| **R3** | `file:line` anchors are a sound primary key | **The bundle's own mandated edits invalidate them.** AC-B2 requires adding a comment to each changed assertion; `boundary-commit-at-iteration.test.js` holds 3 of the 10 anchors, so editing `:69` renumbers `:102` and `:176`. | requirements |
| **R4** | §3's 32/32 trailer coverage shows the common path is covered | **§3 measured *worker* commits only.** `pipeline-runner.ts:3196` builds mux-runner's env via `backendEnvOverrides(backend)` with **no `trailerOpts`** — so every **runner-authored** commit is untrailered *by construction*. Field proof: `e284c7ca` carries `TRAILER=[]`. This is a live production gap my evidence structurally could not see. | codebase |
| **R5** | The 8 files are the scope | **The tests import the compiled mirror, not the source** (`../bin/mux-runner.js`, `../services/ticket-completion-evidence.js`). 133 `.js` mirror files are tracked; `isPathInScope` is a literal prefix match. A src-only restore is **doubly dead**: mirror is `outside_scope` at commit, and AC-B1 executes **pre-fix compiled code**. | risk |
| **R6** | Ticket 30 (WS-C) is `small` | **`large`.** The wipe hazard that justifies `small` requires a *red* gate; §0 records `test:fast` **green**. So `large`'s downside is unreachable while `small`'s is a fabricated verdict — WS-C runs 11 audits + both integration halves + expensive + a 30-min soak floor, and a killed gate records as red-or-indeterminate, not as a timeout. | requirements, risk |

**One sibling claim I am NOT adopting** — the requirements analyst's 6/4 "two regressions" split
(4 failures as `commit-failed`/`honest_failure`, therefore a second, commit-authoring regression, therefore
a third `indirect` enum value). The codebase analyst **ran all four** with `env -u PICKLE_TICKET_ID -u
GIT_CONFIG_*` and measured `grep -c "commit-and-continue: git (add|commit)"` → **0 in every one**.
`commit-failed` is a lossy string collapsing three exits of `commitAndContinueDoneFlip`; two log, and the
third — `mux-runner.ts:5112` `if (!guard.ok)` — is **silent**. All four are the silent attribution-guard
refusal. **10/10 of §2 is one regression: attribution.** The `indirect` enum is REJECTED — it would exile
four genuine live-contract tests from AC-B1 and forbid WS-B from touching them.

---

## ⛔ BLOCKING — operator decision required before WS-B can be scoped

**The C3 carve-out contradicts the behaviour the failing tests demand.**

My §4 forbids restoring **C3** (declared-file-touch attribution) — "the broadest and least selective
mechanism… must not be restored merely because C1/C2 needed it." The codebase analyst found the
citation that makes this a live contradiction:

> `mux-runner.ts:5326-5328` documents AC-DURA-8's attribute branch as running through
> **`readEvidence`'s declared-file-touch window** — which *is* C3.

And AC-DURA-8 is not incidental: two of the ten failures **are** the untagged-commit journey, and their
names state the required end state as executable spec:

- `AC-DURA-8 attribute branch: worker committed untagged (HEAD moved), clean tree → completion_commit back-filled, no second commit, outcome=attributed`
- `AC-DURA-8 attribute: worker committed untagged (HEAD moved, ticket-id in subject) → guard attributes to Done, back-fills completion_commit, no re-commit`

Combined with **R4** (runner-authored commits are untrailered by construction, field-proven), the
untagged-commit case is not hypothetical — it is *guaranteed* for an entire commit class.

**The three options, and none is free:**

| Option | Consequence |
|---|---|
| **(a) Allow a narrow C3 restore** | Contradicts my own §4 carve-out. Restores the broadest mechanism. Reddens `gitattr-inference-deleted.test.js`, requiring AC-B4 reconciliation. |
| **(b) Hold the carve-out; fix the producer instead** | Wire `trailerOpts` into `pipeline-runner.ts:3196` so runner-authored commits carry trailers. Attacks R4's root cause and keeps the −347 subtraction — but is **new scope** not in this PRD, and does nothing for commits already in history. |
| **(c) Hold the carve-out; accept the AC-DURA-8 tests stay red** | Honest, but means beta.8 ships with the Done-stamping regression guard red. Contradicts AC-B1. |

**Recommendation: (b), with (c) as the recorded fallback for historical commits.** It is the only
option that fixes a cause rather than a symptom, and it keeps the subtraction. But it changes WS-B's
shape, so it is the operator's call, not mine.

---

## Amendments carried into the workstreams

Applied verbatim from analyst recommendations where they were paste-ready.

### A1 — fence AC-GADEL-A2's token extraction (closes R1 **and** a fail-open)

Replace the unfenced grep with a §2-scoped read plus an exact-count assertion. The count assertion also
closes the fail-open shape two analysts flagged independently: an empty token list means the loop body
never executes and the AC exits 0 over an empty table.

```
TOKENS=$(awk '/^## 2\. The 10 failures/{f=1} f&&/^```$/{c++; if(c==2) exit} f&&c==1&&/\.test\.js:[0-9]+$/{print}' prds/p1-r-gadel-attribution-fallback-verdict.md | sort -u)
test "$(printf '%s\n' "$TOKENS" | grep -c .)" -eq 10 || exit 1
for t in $TOKENS; do grep -qE "^\| \`$t\` \|" prds/research/gadel-trailer-coverage-matrix.md || exit 1; done
```

§2's note changes from "do not reformat" to: **"AC-GADEL-A2 extracts from this fenced block only and
asserts the count is exactly 10. Adding a token *inside* changes the AC's contract and requires updating
the count in lockstep. Adding one *outside* — in examples, risk prose, or an inherited-failure list — is
safe, and is the correct place for evidence about failures this bundle does not own."**

### A2 — WS-A must actually gate WS-B (closes R2)

New **AC-GADEL-B0** *(gate)*: the matrix exists and is complete before any WS-B code commit. Verify:
`test -f prds/research/gadel-trailer-coverage-matrix.md` **and** AC-A1 + AC-A2 both exit 0 **and**
`git log --oneline -1 -- prds/research/gadel-trailer-coverage-matrix.md` returns a commit that is an
ancestor of every commit this ticket makes under `extension/`. — Type: test

**AC-GADEL-B2** amended to name its source: *"…a comment naming the verdict **recorded for that test in
`prds/research/gadel-trailer-coverage-matrix.md`**. The judge reads the matrix and the diff together; a
comment naming a verdict absent from the matrix fails this AC."*

### A3 — test NAME is the authoritative key, not `file:line` (closes R3)

§4.5's Verdict table gains a required **`Test name`** column carrying the `test(...)` title verbatim. The
§2 token stays for traceability; the **name** is what downstream ACs resolve against, because line
numbers move under WS-B's own edits. All ten names were extracted and verified at HEAD by the
requirements analyst and are carried into §2 of the refined PRD — they are also the only place a reader
can see what the ten failures actually assert.

### A4 — scope must include the compiled mirror (closes R5)

WS-B's allowlist adds the mirror siblings for every source file it may touch — at minimum
`extension/services/ticket-completion-evidence.js` and `extension/bin/mux-runner.js`. Precedent and
rationale: the szechuan src-only/mirror deadlock. Without this, a `live-contract` restore cannot commit
and AC-B1 measures pre-fix code.

### A5 — WS-C tiering and honesty pins (closes R6)

Ticket 30 → **`large`**. AC-GADEL-C1 gains the env pins (`PICKLE_INSTALL_ROOT` off `$HOME`,
`SOAK_SECONDS`) so the deploy-lifecycle soak cannot self-skip, plus: **a skipped stage is recorded as
`SKIPPED`, never as green.** Additionally, `bash install.sh` is hard-blocked from workers at
`config-protection.ts:735` — any install step in WS-C must be `[manager]`-tagged or carry the
manager-only `allow_install_sh_reason` override.

---

## Unchanged from the original PRD

§1 (what was deleted), §3's raw telemetry **as qualified by R4**, §5 Simplification Review, §6 Risks,
and the anti-fake-green posture. **AC-GADEL-B3's assertion floor stands unmodified** — it survived three
cycles without a challenge, and it remains the structural defence against a worker reaching green by
deleting assertions.
