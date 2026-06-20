# BUG REPORT — Readiness gate over-blocks the whole pipeline on false positives (2026-06-14)

**Status:** OPEN — operator-flagged design weakness. Filed during the B-CGH launch (session `2026-06-14-a0321981`).
**Severity:** P1 (design). The readiness gate hard-halts the *entire* pipeline at iteration 0 on findings that are frequently false positives. This has now recurred across multiple bundles and routinely costs a manual babysitter intervention or a `skip_quality_gates_reason` bypass.
**Relates to (does NOT duplicate):** Open Finding #111 R-RSPIN part (B) + `prds/archive/bug-reports/bug-readiness-forward-created-citation-blindness.md` (R-RFCB) — those cover *unannotated* `MODIFIED_FILES` from the Step-7e hardening templates and the non-canonical `(ticket <hash>)` form. This report adds **two sharper root causes** and a **design-level halt-behavior** concern that R-RFCB does not address.

## Operator signal

> "I think the check readiness fails way too often — it should likely continue or fix the issue(s). It has become a weak point for pickle rick."

The gate's *intent* (catch phantom paths / hallucinated contracts before spawning workers) is sound. The *failure mode* is that it is simultaneously (a) prone to false positives on legitimately forward-created or differently-spelled paths and (b) wired as a hard, all-or-nothing halt of the whole pipeline at iteration 0. The combination means a single cosmetic finding discards the entire prepared bundle's run.

## Incident evidence (B-CGH, 2026-06-14)

`check-readiness` exited 2 → pickle phase exited 1 in 28s → `Phase pickle failed (exit 1) — stopping pipeline` → 0/4 phases, nothing built. Five findings, all non-bugs:

| Finding (`detail`) | Ticket | Real? | Root cause |
|---|---|---|---|
| `pickle-rick-claude/CLAUDE.md` | 484b7f6b | authoring slip | repo-name-prefixed path — repo root IS `pickle-rick-claude`, so the file is `CLAUDE.md`; prefix doesn't resolve (RC-2 below) |
| `pickle-rick-claude/CLAUDE.md` | 9615c32c | authoring slip | same |
| `tests/codegraph-context-events-schema-conformance.test.js` | b1089e97 | **FALSE POSITIVE** | file IS declared forward-created as `extension/tests/…` in Files-to-create; verify cmd referenced the same file as `cd extension && … tests/…` (RC-1) |
| `bin/codegraph-efficacy-probe.js` | 61d02c4e | **FALSE POSITIVE** | declared forward-created as `extension/bin/…`; `test -f bin/…` after `cd extension` (RC-1) |
| `tests/codegraph-degradation.test.js` | e72edc1a | **FALSE POSITIVE** | declared forward-created as `extension/tests/…`; verify cmd `cd extension && … tests/…` (RC-1) |

All five were cleared with cosmetic ticket-text edits (no behavior change). The bundle then passed readiness and built. The gate caught zero real defects and cost one full pipeline run + a manual intervention.

## Root causes

### RC-1 (NEW, the sharp one) — path-form asymmetry: forward-created suppression is exact-string, HEAD resolution is suffix-aware

`extension/src/bin/check-readiness.ts`:
- **HEAD resolution** (`resolvePathRef`, R-RTRC-4) is *suffix-aware*: it tries multiple bases (`repoRoot`, `repoRoot/extension`, ticket `workingDir`, …) AND a `git ls-files` suffix-match fallback (`(?:^|/)<ref>$`). So `tests/X.test.js` would resolve against `extension/tests/X.test.js` *if it existed at HEAD*.
- **Forward-created suppression** (`buildBundleCreationIndex`, line ~377) is *exact-membership only*: "Suppression is exact-membership only, so a genuinely phantom path … still produces a finding." A path declared `extension/tests/X.test.js` (forward-created) does **not** suppress a reference to `tests/X.test.js`.

The two resolution paths are **asymmetric**: a not-yet-created file is held to a stricter (exact-string) standard than an already-existing file (suffix-match). The natural authoring pattern — declare `extension/tests/X` in *Files to create*, then reference it in a `cd extension && node --test tests/X` verify command — trips the gate even though both spellings denote the same forward-created file and the annotation is perfectly canonical.

### RC-2 — repo-name-prefixed paths are not normalized

`pickle-rick-claude/CLAUDE.md` is a natural way to disambiguate "the root CLAUDE.md" from `extension/CLAUDE.md`, but the repo root *is* `pickle-rick-claude/`, so `path.resolve(repoRoot, "pickle-rick-claude/CLAUDE.md")` and the suffix-match `(?:^|/)pickle-rick-claude/CLAUDE.md$` both miss. The resolver has no "strip leading repo-basename" normalization.

### RC-3 (DESIGN) — one finding = hard pipeline halt at iteration 0, no graduated response

`mux-runner` exits 2 on any readiness finding (`READINESS HALT`), which surfaces as a non-zero pickle exit, which `pipeline-runner` treats as "phase failed → stop." There is **no graduated response**:
- no auto-remediation of trivially-fixable path-form findings (the exact fixes applied here by hand are mechanical),
- no advisory/continue tier for low-confidence `file_path` findings (R-PHC-6 already established "continue-by-default" for pickle/anatomy/szechuan phase failures — readiness is the conspicuous exception, halting *before* any ticket runs),
- no recurrence budget tracking whether the gate's false-positive rate exceeds its value (the W5 subtract-before-add governance dashboard exists for skip flags but not for gate false positives).

The existing escape hatch (`skip_quality_gates_reason`) disables *all* quality gates wholesale — exactly the "second escape hatch instead of fixing the guard" smell W5b warns against.

## Proposed directions (for examination — not all required)

- **AC-RGO-1 (RC-1, highest leverage):** make forward-created suppression suffix-aware — mirror `resolvePathRef`'s `(?:^|/)<ref>$` logic in `buildBundleCreationIndex`/`extractContractReferences` so a declared `extension/tests/X` suppresses a referenced `tests/X` (and vice versa). Symmetrical resolution: a forward-created path is suppressed iff its existing-file counterpart *would* resolve by the same suffix rule. Keep teeth: a genuinely phantom path (no declaration, no suffix match against any declared path) still flags.
- **AC-RGO-2 (RC-2):** normalize a leading repo-basename segment before resolution (`<repo>/x` → `x` when `<repo> === path.basename(repoRoot)`), or add it as another suffix-match base.
- **AC-RGO-3 (RC-3, design):** introduce a graduated response. Option (a) auto-remediate mechanical path-form findings in place + re-run once before halting; Option (b) downgrade `file_path` findings whose ref suffix-matches a declared forward-created path to **advisory** (warn + continue, like R-PHC-6) and reserve hard-halt for `contract`/phantom classes; Option (c) both. Operator decision required on which.
- **AC-RGO-4 (governance, W5):** add a readiness false-positive recurrence metric to the `/pickle-metrics` W5c dashboard — count findings later cleared by cosmetic-only ticket edits — so the gate's strictness is measured against a budget and becomes a loosening candidate when over.
- **AC-RGO-5 (regression net):** a fixture bundle that declares a forward-created file as `extension/tests/X` and references it as `tests/X` in a verify command MUST pass readiness (the exact B-CGH RC-1 shape).

## Acceptance / verification anchors

- `extension/src/bin/check-readiness.ts` — `buildBundleCreationIndex` (~:379), `extractContractReferences` (~:388), `resolvePathRef` (~:414, R-RTRC-4 suffix-match already here).
- `extension/src/bin/mux-runner.ts` — `runMuxReadinessGate` (the exit-2 halt site).
- `extension/src/bin/pipeline-runner.ts` — `shouldHaltAfterPhase` (R-PHC-6 continue-by-default precedent for the design tier).
- Tests: `extension/tests/check-readiness-forward-ref-fixture.test.js` (extend with the path-form-asymmetry fixture), `extension/tests/check-readiness-tilde-paths.test.js` (sibling precedent for skip-class additions).

## Why this matters (north-star alignment)

This is a textbook D1 (validation overreach) case from `prds/p1-design-simplification-and-autonomy-2026-06-13.md`: a guard that false-blocks beyond its budget should be **loosened or removed, not given a second escape hatch**. The fix is to make resolution *symmetric* (RC-1/RC-2) and the halt *proportional* (RC-3), not to lean harder on `skip_quality_gates_reason`.
