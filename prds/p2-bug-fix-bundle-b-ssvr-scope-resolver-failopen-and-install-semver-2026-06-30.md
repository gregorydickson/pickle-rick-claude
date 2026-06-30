# PRD — B-SSVR: scope-resolver fail-open (R-SSBR) + install.sh prerelease semver (R-ISVP)

**Code:** B-SSVR (Scope-Safe + Semver Repair)
**Priority:** P2 (R-SSBR) + P3 (R-ISVP)
**Filed:** 2026-06-30
**Bundle type:** bug-fix, two independent workstreams, **NORMAL pipeline** (no salvage-path edit — R-PSRB does NOT apply; `scope-resolver.ts` + `install.sh` are pipeline-safe; the running pipeline executes deployed JS, not this source diff).

Two reuse-first correctness repairs surfaced by OBSERVATION mode, in different subsystems with **zero file overlap** (`extension/src/services/scope-resolver.ts` vs `install.sh`). Both *re-arm an existing guard that is currently silently dead* — neither adds new machinery.

Source bug reports (verified, not guessed):
- `prds/BUG-REPORT-2026-06-30-scope-resolver-stale-shared-base-ref-false-empty-diff.md`
- `prds/BUG-REPORT-2026-06-30-install-sh-semver-comparison-rejects-prerelease.md`

---

## WS-1 — R-SSBR: scope-resolver fail-SAFE on a stale/ahead base ref (P2)

**Component:** `extension/src/services/scope-resolver.ts` — `resolveAllowedFromDiffMode` (`:204-238`), `resolveDefaultBase` (`:604`).

### Problem

In a heavily-shared multi-worktree checkout the local `refs/remotes/origin/main` can be transiently **at or ahead of** the feature branch's HEAD at scope-resolve time. When that happens, `getMergeBase(baseRef,'HEAD')` returns `HEAD` itself, the three-dot diff `HEAD...HEAD` is empty, and `resolveAllowedFromDiffMode` throws `SCOPE_EMPTY_DIFF` for a branch that genuinely has a diff. The empty branch throws **before** `writeScopeJson`, so no `scope.json` is written, the CUJ-6a WARN-demotion lets citadel/anatomy-park/szechuan-sauce proceed **UNSCOPED**, and szechuan's auto-commit is then free to roam — a fail-OPEN on the scope-lock safety boundary that directly enables the R-SSOC off-scope-commit class. Proven a stale-ref artifact, not a real empty diff (identical computation re-run yields 12 files).

### Fix (reuse-first, fail-SAFE)

1. **Ancestry sanity-check (the load-bearing fix).** In `resolveAllowedFromDiffMode`, after computing `baseSha = getMergeBase(baseRef,'HEAD')`, detect the suspect state `baseSha === headSha` (HEAD is an ancestor of `baseRef` ⇒ base ref is at/ahead of HEAD). In that state the empty diff is NOT trustworthy: do not throw `SCOPE_EMPTY_DIFF`. Instead recompute the base from a non-racy source via a new internal helper `resolveForkPointBase(repoRoot, baseRef)` that returns `git merge-base --fork-point <baseRef> HEAD` (falling back to plain `git merge-base` then local `main`/`master`) and re-run `computeAllowedFromDiff` against that fork-point. Only if the fork-point diff is *also* empty may resolution conclude empty.
2. **Distinct error when even the fork-point is unusable.** If no fork-point base can be resolved AND `baseSha === headSha`, throw a new `ScopeErrorCode` member `SCOPE_BASE_AHEAD_OF_HEAD` (NOT `SCOPE_EMPTY_DIFF`) so the runner/operator can distinguish "nothing changed" from "the base ref is stale/ahead." Add it to the `ScopeErrorCode` union and to `scope-errors-doc-parity` coverage.
3. **No silent unscoped review when `--scope branch` was explicitly requested.** This is documentation-of-intent only inside this WS — the existing CUJ-6a WARN-demotion in `pipeline-runner.ts` stays as-is for the genuine-empty case; WS-1's ancestry fix removes the *false* empty that was feeding it. (A runner-side hold/retry is explicitly OUT of scope for this bundle to keep it reuse-first; note it as a follow-up.)

### Acceptance criteria (WS-1)

- `resolveAllowedFromDiffMode` no longer emits `SCOPE_EMPTY_DIFF` when `baseSha === headSha` and a non-empty fork-point diff exists; it returns that fork-point allow-list instead.
- A new `scope-resolver` unit test (`extension/tests/scope-resolver-base-ahead.test.js`) constructs a repo where the passed base ref is at/ahead of HEAD but a real fork-point diff exists, and asserts: (a) resolution does NOT throw `SCOPE_EMPTY_DIFF`, (b) the returned `allowed` equals the fork-point diff file set, (c) a genuinely-empty branch (HEAD == fork-point, no diff) still yields the empty-resolution path.
- `SCOPE_BASE_AHEAD_OF_HEAD` is a member of `ScopeErrorCode` and passes `scope-errors-doc-parity.test.js` (no phantom/undocumented code).
- A new trap-door entry in `extension/src/services/CLAUDE.md` (or the existing `scope-resolver.ts` trap door) pins the ancestry-check invariant with `PATTERN_SHAPE: baseSha === headSha` guard before any `SCOPE_EMPTY_DIFF` throw.
- Full release gate green (tsc + eslint + audits + fast-c4 + integration + expensive). No regression in `scope-pipeline.test.js` / `scope-refresh.test.js`.

---

## WS-2 — R-ISVP: install.sh `compare_semver` understands prerelease (P3)

**Component:** `install.sh` — `compare_semver` (`:51`) + its single downgrade-guard caller (`:199`).

### Problem

`compare_semver`'s validation regex `^[0-9]+[.][0-9]+[.][0-9]+$` matches only plain `X.Y.Z`, so every `2.0.0-beta.NN` fails → `echo "❌ Invalid semver comparison" >&2; exit 1`. The sole caller invokes it in `$(...)`, so `exit 1` kills only the subshell, `$(...)` captures empty stdout, and `[ "" -lt 0 ]` errors `integer expression expected` and falls through. The downgrade-protection guard (`REFUSE: source older than deployed`) is therefore **dead for the entire `beta.*` line** — an accidental `beta.31→beta.20` deploy installs silently.

### Fix (reuse-first, re-arms the existing guard)

1. Widen the validation regex to accept an optional prerelease suffix: `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`.
2. Compare the `X.Y.Z` triplet first (existing logic, unchanged). When the triplet is equal, compare the prerelease per semver: **a version with NO prerelease outranks one with a prerelease**; two prereleases compare by their trailing numeric identifier (`beta.31 > beta.20`).
3. Replace the `exit 1`-in-subshell anti-pattern: on genuinely malformed input, `echo` a defined sentinel and `return` (non-zero) so the caller's `[ ... -lt 0 ]` never hits `integer expression expected`.

### Acceptance criteria (WS-2)

- `compare_semver 2.0.0-beta.31 2.0.0-beta.30` → `1`; `compare_semver 2.0.0-beta.30 2.0.0-beta.31` → `-1`; equal → `0`.
- `compare_semver 2.0.0 2.0.0-beta.31` → `1` (release outranks prerelease); `compare_semver 2.0.0-beta.31 2.0.0` → `-1`.
- A `beta.N → beta.(N-1)` install over a deployed newer beta is **REFUSED** (downgrade guard fires) absent `--allow-downgrade`.
- No `Invalid semver comparison` / `integer expression expected` stderr on a normal beta→beta upgrade.
- A test under `extension/tests/` (extend the existing install-script suite, e.g. `install-script.test.js` or a new `install-semver-prerelease.test.js`) covers the full prerelease comparison matrix above by invoking the real `compare_semver` from `install.sh`.
- Full release gate green.

---

## Simplification Review (subtract-before-add)

**WS-1 (R-SSBR):**
1. **Necessary?** Yes — correctness repair of a fail-OPEN safety boundary, not a feature.
2. **Reuse vs add?** Reuse: the fork-point recompute uses `git merge-base --fork-point` and the existing `computeAllowedFromDiff`; no parallel diff path. One new internal helper (`resolveForkPointBase`) and one new error-enum member — minimal surface.
3. **Guards existing brittle complexity?** It *fixes* the brittle behavior (trusting a racy ref) rather than wrapping it; the CUJ-6a WARN stays for the genuine-empty case. No second escape hatch.
4. **Subtract?** Removes a silent scope-lock-loss path — the system gets *safer and more honest* (a stale base now names itself `SCOPE_BASE_AHEAD_OF_HEAD` instead of masquerading as "no changes"). No new flag/state field.

**WS-2 (R-ISVP):**
1. **Necessary?** Yes — re-arms a guard that is currently dead, not a new gate.
2. **Reuse vs add?** Reuse: extend `compare_semver` + its single callsite; the X.Y.Z path is unchanged; no parallel comparator, no new flag.
3. **Guards existing brittle complexity?** Fixes the over-strict regex; does not wrap it.
4. **Subtract?** Replaces the `exit 1`-in-subshell anti-pattern with a `return`/sentinel — removes a silent-failure mode.

---

## Out of scope / follow-ups

- Runner-side hold-or-retry of review phases when `--scope branch` resolves empty (a behavior change in `pipeline-runner.ts`, not the resolver) — note only.
- A short-timeout `git fetch` of the default branch before resolving (optional belt-and-suspenders) — deferred; the ancestry check fixes the observed defect without it.
