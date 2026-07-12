---
title: "B-FOMH — Fable orthogonal-surfaces residuals (a–d): ui-test-worker source adoption, honest gate-noise messages, redirecting block messages, microverse prompt fixes"
priority: P3
finding: R-FOMH
status: queued
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD; prompt/message text + hook-test pin surgery)"
source_assessment: "MASTER_PLAN R-FOMH row (fable orthogonal-surfaces survey 2026-07-10; filed not fixed). Parts (e)/(f) of the row are explicitly OUT of this bundle."
---

# B-FOMH — fable orthogonal residuals, parts (a)–(d)

## 0. Scope statement

Four filed message/prompt-surface defects from the 2026-07-10 orthogonal survey. All are
text-layer with test-pin surgery; none touch salvage/Done-flip/state machinery. Parts (e)
(FOM-prose pin-vs-single-source decision) and (f) (live-run tier-interaction watch) are
DECISIONS/observations, not buildable — out of scope here.

## 1. Workstreams

### WS-FOMH-A — adopt `ui-test-worker.md` into repo source + convergence honesty

- **AC-FOMH-A1** — `ui-test-worker.md` currently exists ONLY in the deployed tree
  (`~/.claude/commands/ui-test-worker.md`, ~5.7K) with NO repo source — a Source-of-Truth
  violation. Adopt it: copy the deployed content into `.claude/commands/ui-test-worker.md`
  (repo), byte-identical as the starting point, so `install.sh` owns it thereafter. — Type: test
  (`test -f .claude/commands/ui-test-worker.md`; README command table row added per the
  Documentation Rule)
- **AC-FOMH-A2** — convergence honesty fix in the adopted prompt: `converged: true` MUST declare
  verified-vs-attrition with pass/fail/env_error counts — a dead dev server must read as
  env_error attrition, never instant convergence (the R-SZGB shape). — Type: lint
  (`grep -qE "pass.*fail.*env_error" .claude/commands/ui-test-worker.md`)

### WS-FOMH-B — tsc-gate budget-expiry message honesty

- **AC-FOMH-B1** — `formatBlockReason` (tsc-gate hook) gains a per-kind suffix: a
  `cold_cache_timeout` (gate budget expiry) block explicitly says it is "gate budget expired,
  NOT proof of a compile error — warm the cache with `npx tsc --noEmit`, then retry once" —
  today it reads as a compile failure with no first-line output, and workers rewrite correct
  code or flip Failed on gate noise. — Type: test (hook-test per-string pins updated in the SAME
  ticket — the known pin-surgery cost is the ticket, not a surprise)

### WS-FOMH-C — config-protection block messages redirect instead of dead-ending

- **AC-FOMH-C1** — config-protection state/config block messages gain proceed-without-it
  guidance + the sanctioned `StateManager.update` override recipe (the R-WSRC bypass-retry
  iteration burn: workers currently retry the same blocked write). Message text only; the
  BLOCK decisions themselves are untouched. — Type: test (hook-test string pins updated
  same-ticket; block/approve decisions unchanged — existing decision tests stay green
  unmodified)

### WS-FOMH-D — pickle-microverse prompt: bystander-sweep + inert-check

- **AC-FOMH-D1** — `pickle-microverse.md` interactive steps 5a.7/5b.7 replace `git add -A` with
  path-scoped staging guidance (the repo-wide bystander-sweep prohibition; same rule the runtime
  already enforces via `dirty-tree-salvage`). — Type: lint
  (`! grep -q "git add -A" .claude/commands/pickle-microverse.md`)
- **AC-FOMH-D2** — the metric-read step gains inert-check guidance: a non-numeric/garbage score
  is treated as unmeasurable (do not act, do not revert good work on it). — Type: lint (grep for
  the inert-check phrasing in the metric step)

## 2. Out of scope

- R-FOMH (e): pin-vs-single-source decision for the mirrored FOM prose families — operator
  decision, not a build.
- R-FOMH (f): reduced-tier/small-budget live-run watch — observation item.
- Any hook DECISION change (messages only); any runtime code beyond `formatBlockReason`'s
  string composition.

## Simplification Review (subtract-before-add)

**A** — (1) Adopting an orphan into source is a Source-of-Truth REPAIR, not an addition; A2 is
prompt text. (2) Reuse: install.sh's existing command deploy path. (3)/(4) Subtraction: removes
the only-in-deployed orphan class for this file (and the honest fix removes a false-convergence
path). **B/C** — (1) Message strings only; no new branches beyond a suffix map. (2) Reuse:
existing formatBlockReason seam + existing override flags (documents them, adds none). (3) THIS
IS the subtract-play: better messages reduce bypass-retry churn instead of adding retry guards.
(4) No subtraction available; recorded. **D** — (1) Prompt edits align the doc with an
already-enforced runtime rule (drift repair). (4) Subtracts a documented-but-prohibited
instruction (`git add -A`).

## Risks

- Pin surgery (B/C) is the classic doc-coupled-test red — budget the ticket for it explicitly;
  never loosen a decision pin to make a message pin pass.
- A1 must adopt the DEPLOYED bytes as-is first (diffable), THEN apply A2 on top — two commits,
  so the adoption diff is clean.
