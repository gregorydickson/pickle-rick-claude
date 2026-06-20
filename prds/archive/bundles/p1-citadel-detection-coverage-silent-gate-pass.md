# PRD: Citadel Detection Coverage on Silent-Gate-Pass Class (R-CCDC)

**Status**: DIAGNOSE-THEN-FIX 2026-05-14 PM (Priority P1, queue-blocking). Successor to **R-CCNW** (closed via verify-then-close on 2026-05-14 PM — wiring scope shipped; see `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md` status block for the 7/9 AC HEAD audit). This PRD scopes the **detection-coverage** gap that R-CCNW's wiring did NOT solve.

## Problem

Citadel's mechanical wiring is correct. Its semantic coverage is wrong for the silent-gate-pass bug class.

On session `2026-05-13-b54f2143` (R-TSPF bundle), citadel produced `citadel_report.json` with **288 findings, exit 0**. Anatomy-park then shipped **6 CRITICAL + 22 HIGH** on the same diff, including four silent-gate-pass CRITICAL fixes to:

- `extension/scripts/release-gate.sh` (commit `46dc21a6` — release tarball install payload false-green)
- (anatomy-park fix) `verify-recapture-fired.js` (commit `91f10462` — stale anatomy window recapture pass)
- (anatomy-park fix) `verify-bundle.js` (commit `1bc49d48` — unknown AC false-green)
- `extension/src/services/convergence-gate.ts` (commit `a38492c9` — delegated test gate false-green)

**Zero of citadel's 288 findings referenced any of those 4 files.** The wired analyzers ran but did not flag the bug class. Anatomy-park (3-4h) caught what citadel (1.3s) should have caught preemptively.

R-CCNW's HEAD audit confirms this is a *detection-logic* gap, not a wiring gap:
- T3 (`ac-coverage-scorecard.ts`), T4 (`allowlist-dead-entry-detector.ts`), T6 (`trap-door-coverage-audit.ts`), T8 (`state-transition-audit.ts`) are all imported and invoked by `audit-runner.ts`
- Their `sections` map entries write to `citadel_report.json`
- But none of them emitted findings for the 4 silent-gate-pass commits

## Suspected diagnoses (H-classes)

| H | Hypothesis | Disambiguation |
|---|---|---|
| H-A | **Analyzers don't recognize the bug-class patterns.** The silent-gate-pass class (false-green, recapture-pass, unknown-AC false-green) is a behavioral pattern (gate emits success on invalid input) the analyzers' rules don't pattern-match. | For each of the 4 files, manually inspect each analyzer's rules: does any rule's predicate cover the actual code shape of the fix? |
| H-B | **Diff scope filters out the changed files.** Citadel's `diff-walker.ts` may exclude `.sh` scripts, `extension/scripts/` paths, or filter by file extension/path in a way that drops the changed files before the analyzers see them. | Run `diff-walker` against the b54f2143 diff range manually; check whether the 4 files appear in its output. |
| H-C | **Severity thresholds mask the findings.** Analyzers emit findings at `'Low'` or `'Info'` severity that get filtered out of the top-level `summary.findings` count. Reporter may swallow them. | Grep `citadel_report.json` from b54f2143 for ANY finding (any severity) whose `file` field matches one of the 4. If present at Low/Info → H-C. |
| H-D | **Analyzer-side false-clean logic.** An analyzer's "skip-when-shape-mismatch" or "skip-when-allowlist-hit" code path triggers on these files, emitting `{skipped: 'project_shape_mismatch'}` for files that should be in scope. | Inspect the `sections` map for `skipped:` entries that match the 4 files' subsystem. |

Hypotheses are not mutually exclusive — multiple may hold per file or per analyzer.

## Diagnostic Plan

R-CCDC ships in two stages: **diagnose** (read-only forensic pass) then **fix** (narrow patch). The diagnose stage may collapse the fix scope to a single analyzer, single rule, or single file filter.

### Stage 1: Diagnose (read-only, no source changes)

1. Locate b54f2143's citadel artifacts: `~/.local/share/pickle-rick/sessions/2026-05-13-b54f2143/citadel_report.json` + `citadel_report.md`.
2. For each of the 4 anatomy-park-fixed files, run the **file × analyzer matrix**: for each analyzer module under `extension/src/services/citadel/*.ts`, determine whether the file appears in the analyzer's input (diff scope) and whether the analyzer's rules covered the actual bug shape.
3. Replay citadel locally against the b54f2143 diff range (`git show b54f2143^..b54f2143 | head` to verify the diff is captured) using `node extension/bin/citadel.js --prd <bundle-prd> --diff <range>`. Capture per-analyzer diagnostics.
4. Per-hypothesis evidence collection:
   - H-A: paste the relevant analyzer rule pattern + the actual code shape; show mismatch.
   - H-B: paste `diff-walker` output for the diff range; confirm absence of the 4 files.
   - H-C: grep `citadel_report.json` for any finding whose `file` matches one of the 4 paths.
   - H-D: paste `sections.*.skipped` entries.
5. **Deliverable**: `prds/research-r-ccdc-b54f2143-2026-05-14.md` containing the file × analyzer × hypothesis matrix and a recommended fix scope (one of: rule-coverage patch, diff-scope-filter patch, severity-threshold patch, skip-logic patch — or a small combination).

### Stage 2: Fix (single PRD bundle, ≤8 tickets)

Scope set by Stage 1's recommended fix scope. Likely outcomes:

- **Rule-coverage patch**: extend the specific analyzer's rule (e.g. T6 trap-door-coverage's ENFORCE regex, T3 ac-coverage-scorecard's commit-match logic) to recognize the silent-gate-pass shape.
- **Diff-scope patch**: add `extension/scripts/*.sh` and `verify-*.js` to the diff-walker's tracked extensions/paths.
- **Severity patch**: bump silent-gate-pass detections from Low → High in the reporter.
- **Skip-logic patch**: tighten `project_shape_mismatch` predicates so legitimate scripts don't skip.

Stage 2 PRD requirements crystallize after Stage 1 lands.

## Scope

**In**:
- Diagnose-phase: `extension/src/services/citadel/diff-walker.ts`, all analyzer modules, `audit-runner.ts` flow tracing
- Fix-phase: narrow patches to whichever surfaces Stage 1 identifies
- Regression fixtures: `extension/tests/citadel/fixtures/b54f2143/` (the 4 files' diffs as synthetic test cases)
- Trap-door pin in `extension/CLAUDE.md` enforcing the regression

**Out**:
- Wiring (already shipped per R-CCNW closure)
- New analyzer module types (separate PRD if Stage 1 surfaces the need)
- Anatomy-park rule changes (anatomy-park is the safety net, R-CCDC ships the preventive)
- The R-CCNW cosmetic cleanups (AC-01 shell script port, AC-05 field rename) — file standalone if anyone cares

## CUJs

1. **Diagnose**: operator runs forensic pass per Stage 1, produces research doc, identifies which analyzer × file combinations failed.
2. **Validate fix**: after Stage 2 ships, re-run citadel against b54f2143 diff. The new report MUST emit ≥1 Critical or High finding per silent-gate-pass file (`release-gate.sh`, `verify-recapture-fired.js`, `verify-bundle.js`, `convergence-gate.ts`).
3. **Preserve clean runs**: bundles that are actually clean MUST NOT regress to false-positive findings post-R-CCDC. Test with a known-clean fixture.

## Requirements

| ID | Priority | Requirement |
|---|---|---|
| R1 | P0 | Stage-1 diagnostic deliverable `prds/research-r-ccdc-b54f2143-2026-05-14.md` exists with the file × analyzer × hypothesis matrix and a concrete recommended fix scope. |
| R2 | P0 | Stage-2 fix-phase requirements crystallize after R1 lands; this PRD is then amended with R3+ machine-checkable criteria. |
| R3 | P0 (Stage 2) | Re-running citadel against b54f2143's diff range emits ≥1 Critical or High finding whose `file` field references each of: `release-gate.sh`, `verify-recapture-fired.js`, `verify-bundle.js`, `convergence-gate.ts`. Verified by replay + manifest grep. |
| R4 | P0 (Stage 2) | A regression fixture under `extension/tests/citadel/fixtures/b54f2143/` exercises each silent-gate-pass file's diff and asserts the analyzer emits a finding. |
| R5 | P0 (Stage 2) | Trap-door pin in `extension/CLAUDE.md` enforces detection-coverage invariant: silent-gate-pass class produces Critical/High citadel findings. PATTERN_SHAPE locks the rule that Stage 1 identified. |
| R6 | P1 (Stage 2) | No false-positive regression on a known-clean fixture bundle. |
| R7 | P1 (Stage 2) | Type checker passes; existing citadel tests continue passing. |

## Verification

| Req | Check | Command |
|---|---|---|
| R1 | Research doc exists with file × analyzer matrix and recommended fix scope | `test -f prds/research-r-ccdc-b54f2143-2026-05-14.md && grep -q "Hypothesis" $_` |
| R3 | Re-run citadel; assert findings reference each of the 4 files | `node extension/bin/citadel.js --prd <bundle> --diff <range>` + manifest grep |
| R4 | Fixture-driven regression test asserts analyzer emits finding per file | `node --test extension/tests/citadel/fixtures/b54f2143/*.test.js` |
| R5 | Trap-door audit passes | `bash extension/scripts/audit-trap-door-enforcement.sh` |
| R6 | Clean-fixture bundle still produces 0 false positives | dedicated fixture test |
| R7 | Type + test gates green | `npx tsc --noEmit && npm run test:fast` |

## Conformance Check

- [ ] Type checker passes — no new errors
- [ ] Test runner passes (fast + integration tiers)
- [ ] Lint passes — 0 new warnings
- [ ] R1 research doc committed
- [ ] R3 replay against b54f2143 emits the expected findings
- [ ] R5 trap-door pin in place
- [ ] R6 clean-fixture regression test green

## Assumptions

- The b54f2143 session's `citadel_report.json` is still on disk at `~/.local/share/pickle-rick/sessions/2026-05-13-b54f2143/`. If missing, replay against the diff range produces a fresh report.
- The 4 silent-gate-pass commits represent a *coherent bug class* (false-green gate outputs), not 4 unrelated bugs. Stage 1 confirms or denies this.
- Whatever Stage 1 surfaces, the fix scope fits ≤8 tickets in one bundle. If it doesn't, file follow-up R-CCDC-2 and ship in waves.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Stage 1 finds the bug class is too heterogeneous for a single fix | Split into per-analyzer fix PRDs (R-CCDC-T3, R-CCDC-T6, etc.) and ship sequentially. |
| Patching analyzer rules creates false positives on clean bundles | R6 explicit no-regression criterion; clean-fixture test gates the fix. |
| The 4 anatomy-park-fixed files no longer reproduce on replay (HEAD has moved) | Diagnostic uses the diff range, not HEAD. The 4 commit SHAs are preserved. |
| Stage 1 surfaces that the bug is in anatomy-park's pattern-replay, not citadel | Re-scope to anatomy-park; file new PRD; R-CCDC closes as "diagnosed, wrong subsystem." |

## Business Impact

- **Closes the actual stability gap** that motivated R-CCNW's P2→P1 promotion. Wiring was a prereq; detection is the payoff.
- **Restores citadel's intended 1.3s preventive role.** Anatomy-park reclaims its design role as defense-in-depth, not the only effective conformance audit.
- **Adds regression fixture coverage** that locks the b54f2143-class bugs out of future bundles.

## Coupling with Other Queue Items

- **R-CCNW** (closed via verify-then-close): prerequisite. R-CCDC is the successor PRD covering the residual semantic gap.
- **R-CCPL** (DIAGNOSIS-ONLY): orthogonal. Different subsystem (classifier vs citadel analyzers). Both follow the same diagnose-then-fix pattern.
- **R-FRA + R-QGSK + R-PPPG** (next pipeline candidate): orthogonal. R-CCDC's diagnostic phase can run in parallel with the gate-ergonomics bundle.

## Stakeholders

- **Author**: Gregory Dickson (Pickle Rick)
- **Diagnostician (Stage 1)**: read-only forensic pass on b54f2143's citadel artifacts; runs alongside any pipeline.
- **Implementer (Stage 2)**: TBD after Stage 1 lands. Backend choice depends on R-CCPL diagnosis (claude if codex strike loop still firing).
- **Reviewers**: any operator who has seen citadel green a bundle that anatomy-park then cleaned up.

## References

- `extension/src/services/citadel/audit-runner.ts` — wiring (shipped per R-CCNW)
- `extension/src/services/citadel/diff-walker.ts` — diff-scope filter (H-B suspect)
- `extension/src/services/citadel/*.ts` — analyzer rules (H-A, H-D suspect)
- `extension/src/services/citadel/reporter.ts` — severity surface (H-C suspect)
- `~/.local/share/pickle-rick/sessions/2026-05-13-b54f2143/` — primary forensic artifact
- `prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md` — R-CCNW closure (predecessor)
- Anatomy-park commits: `46dc21a6`, `91f10462`, `1bc49d48`, `a38492c9`
