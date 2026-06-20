# BUG REPORT — pipeline szechuan/anatomy may pass EMPTY allowed_paths to the judge when scope.json is absent/refresh-null at phase setup

**Filed:** 2026-06-19 (capture-only, babysitter — surfaced while fixing #129 R-SSOC)
**Code:** R-PEAP (Pipeline Empty Allowed-Paths) — *candidate, unconfirmed*
**Priority:** P3 (latent; needs session-artifact confirmation before it is actionable)
**Deployed runtime:** v2.0.0-beta.18+
**Backend:** any (`/pickle-pipeline`)
**Discovered by:** L1 root-cause trace during #129 R-SSOC. **NOT yet confirmed as a live incident** — see "Why this is capture-only / unconfirmed" below.

## VERDICT (2026-06-20): REFUTED as the incident cause — latent code path only

Read-only verification against the actual `2026-06-19-2b1e2707` session artifacts (`~/.local/share/pickle-rick/sessions/2026-06-19-2b1e2707/`):
- `scope.json` had all **12** bank-statement `allowed_paths`.
- `microverse.json` had the **same 12** `allowed_paths` (NOT empty).
- `pipeline-runner.log`: `scope-refresh: phase=szechuan-sauce … allowed=12` → `--allowed-paths-file` WAS passed; `Szechuan Sauce setup complete`.
- `microverse-runner.log`: `LLM baseline metric: 24`, improving 24→14 across iterations.

So the judge **received correct scope data**. The empty-`allowed_paths` theory is **REFUTED for this incident**. R-PEAP remains a *plausible-from-code latent path* but is unconfirmed in the wild — **revisit ONLY if a future session shows `scope.json` non-empty AND `microverse.json.allowed_paths` empty.**

**Secondary finding (re #129 R-SSOC L1):** the baseline 24 → 14 improvement within the scoped run is more consistent with the judge measuring **in-scope** violations than with whole-tree scoring — i.e., #129's "judge scored whole-tree → steered the worker off-scope" L1 premise is murkier than the original report assumed. This does NOT undermine the shipped #129 fix: Part B (runner-side post-iteration scope audit) detects off-scope commits **deterministically regardless of why the worker drifted**, and Part A is a harmless hedge. Next week's field-soak will now SURFACE any off-scope recurrence (via the `worker_edit_outside_scope` event) so it can be root-caused properly instead of inferred.

## Summary

A read-only trace of the judge-scoping data flow found a credible path where a `/pickle-pipeline`
anatomy-park / szechuan-sauce phase can launch `init-microverse.js` **without** `--allowed-paths-file`,
producing a `microverse.json` with empty/undefined `allowed_paths`. At runtime the LLM judge then
receives an **empty** `allowedPaths` array, so `buildJudgePrompt`'s `allowedPaths.length > 0` scoped
branch is skipped and the judge falls through to the **whole-tree** `Target path:` prompt — scoring the
entire repo instead of the in-scope subset. This is the same observable symptom as #129 R-SSOC L1
(judge scores whole-tree → steers the worker off-scope), reached via a *different* mechanism
(missing data vs. weak prompt).

## Suspected causal chain (code-read only)

1. `pipeline-runner.ts` `setupAnatomyPark` / `setupSzechuanSauce` compute `effectiveScope` /
   `effectiveAllowedPaths` from the freshly-passed `scope` param, falling back to
   `readPersistedAllowedPaths(sessionDir)` (reads `scope.json`).
2. `--allowed-paths-file` is appended to the `init-microverse.js` argv **only if**
   `effectiveScope.allowedPaths.length > 0 && fs.existsSync(scopePath)` (anatomy ~`:1846`,
   szechuan ~`:2004`).
3. `refreshPhaseScope` → `scope-resolver.ts:refreshScope` returns `null` when `scope.json` does not
   exist yet (or the phase was already entered), so `scope` is `undefined` and
   `readPersistedAllowedPaths` returns `undefined` when `scope.json` is absent.
4. With no `--allowed-paths-file`, `init-microverse.ts` (~`:139-141`) defaults `allowedPaths` to
   `undefined` → `microverse.json.allowed_paths` empty/undefined.
5. `microverse-runner.ts` passes `state.allowed_paths ?? []` to the judge (~`:2902`, `:3172`) → empty
   array → `buildJudgePrompt` whole-tree branch.

(Line numbers approximate; resolve at HEAD before acting.)

## Why this is capture-only / unconfirmed

The #129 R-SSOC source incident's **evidence #2 contradicts this theory for that incident**:
`microverse.json.allowed_paths` had **12 paths** in session `2026-06-19-2b1e2707`. If those 12 paths
were present, `--allowed-paths-file` *was* passed and the judge *did* receive them — so #129's
whole-tree score (24) was a prompt-adherence failure, not an empty-data failure. R-PEAP is therefore a
**separate latent path**, plausible from the code but **not** the confirmed cause of any observed run.
Building a fix now would be fixing an unconfirmed theory against contradicting evidence — explicitly
declined per the "trust ground truth, don't add speculative machinery" directive.

## What confirmation requires (do this before building)

Pull the actual phase-setup artifacts from a `/pickle-pipeline` run and check:
- Did `scope.json` exist at the moment `setupAnatomyPark` / `setupSzechuanSauce` ran for the FIRST
  microverse phase of the session? (Citadel runs first and may write scope.json; or it may not.)
- Was `--allowed-paths-file` actually present in the `init-microverse.js` argv? (grep the runner log.)
- Did the resulting `microverse.json.allowed_paths` come up empty on a session whose `scope.json` was
  non-empty? That empty-despite-present-scope.json case is the confirming signal.

If confirmed, the least-additive fix is to make the `--allowed-paths-file` gate fall back to
`scope.json` whenever it exists (drop the `effectiveScope` precondition when `readPersistedAllowedPaths`
returns a non-empty set), so a correct `scope.json` always reaches the judge. NOT a new flag/guard.

## Relationship to shipped work

- **#129 R-SSOC (shipped v2.0.0-beta.21):** Part A tightened the scoped judge prompt to constrain
  *scoring* (hedges the prompt-adherence failure mode); Part B added a deterministic runner-side
  post-iteration scope audit that fires `worker_edit_outside_scope` regardless of judge behavior or
  empty-vs-present allowed_paths. **Part B already makes R-PEAP-class drift observable** even if R-PEAP
  is real — the off-scope commits would still be caught at `/pickle-status`. R-PEAP, if confirmed, would
  additionally stop the judge *steering* the worker off-scope in the first place.
- Sibling to #95 B-SJWT (judge scope-vs-allowed_paths) and #105 R-RGED dim-4 (scanning vs writing).
