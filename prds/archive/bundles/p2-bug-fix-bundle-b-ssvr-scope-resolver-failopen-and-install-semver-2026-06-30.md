# PRD (refined) — B-SSVR: scope-resolver fail-CLOSED on stale base ref (R-SSBR) + install.sh prerelease semver (R-ISVP)

*(refined 2026-06-30 from 3-analyst × 2-cycle refinement — requirements / codebase / risk-scope all converged. Pre-refinement preserved at `prd.md`.)*

**Code:** B-SSVR · **Priority:** P2 (R-SSBR) + P3 (R-ISVP) · **Bundle:** bug-fix, 2 workstreams, **NORMAL pipeline** (no salvage-path edit — R-PSRB N/A; the running pipeline executes deployed JS, not this source diff).

Two reuse-first correctness repairs, zero file overlap (`scope-resolver.ts` + `pipeline-runner.ts` vs `install.sh`). Both re-arm a guard that is currently silently dead.

Source bug reports: `BUG-REPORT-2026-06-30-scope-resolver-stale-shared-base-ref-false-empty-diff.md`, `BUG-REPORT-2026-06-30-install-sh-semver-comparison-rejects-prerelease.md`.

---

## Refinement-critical reframe (read first)

The original PRD's WS-1 headline success path — "base at/ahead of HEAD but a real fork-point diff exists → returns the fork-point allow-list" — is **geometrically near-unreachable**. When `baseSha === getMergeBase(baseRef,'HEAD') === headSha`, HEAD is an ancestor of `baseRef`, so HEAD's entire history is reachable from `baseRef` and `git merge-base --fork-point` collapses back to HEAD ⇒ the fork-point diff is **also empty**. The "12 files on re-run" in the bug report is a **transient** artifact (a concurrent fetch/ref-update landed between the two resolves), NOT a static base the recompute recovers.

**Therefore the realistic, asserted disposition is the throw, not the allow-list return.** WS-1 is a **fail-OPEN → fail-CLOSED** repair: a stale/ahead base must surface a clean halt (`SCOPE_BASE_AHEAD_OF_HEAD`), never a silent unscoped review run. The fork-point recompute is a best-effort *attempt* that usually returns empty; its allow-list return is asserted ONLY against a synthetic fixture with a genuine divergent fork-point + seeded reflog.

Because the new error code currently propagates **uncaught** out of `setupScope` (`pipeline-runner.ts:1755` is a bare `throw err`; only `SCOPE_EMPTY_DIFF` is caught at `:1750`), **minimal runner disposition is now IN SCOPE** (it was wrongly deferred): the catch must convert `SCOPE_BASE_AHEAD_OF_HEAD` into a clean fail-CLOSED halt with a forensic `exit_reason`, NOT an uncaught crash and NOT an unscoped proceed.

---

## WS-1 — R-SSBR: scope-resolver fail-CLOSED on a stale/ahead base ref (P2, `complexity_tier: medium`)

**Files:** `extension/src/services/scope-resolver.ts` · `extension/src/bin/pipeline-runner.ts` (scope-setup catch) · `extension/tests/scope-resolver-base-ahead.test.js` (forward-created) · `extension/tests/scope-errors-doc-parity.test.js` (reads source dynamically — no edit, must stay green) · one `extension/CLAUDE.md` trap-door entry.

### Fix

1. **Ancestry sanity-check (default-base path only).** In `resolveAllowedFromDiffMode` (`:204-238`), AFTER `baseSha = getMergeBase(baseRef,'HEAD')` and ONLY when scope was resolved via the auto-default base (i.e. `parsed.mode !== 'diff'` — an explicit operator `diff:<ref>` is NOT silently swapped), detect `baseSha === headSha`. In that state the empty diff is untrustworthy: attempt `resolveForkPointBase`, and if it yields a usable divergent base, recompute `computeAllowedFromDiff` against it. Otherwise throw `SCOPE_BASE_AHEAD_OF_HEAD` — do NOT throw `SCOPE_EMPTY_DIFF`.
2. **`resolveForkPointBase(repoRoot, baseRef, headSha)` — new internal helper, soft git form.** Uses the non-throwing `runGit([...], repoRoot, false)` form (mirrors `resolveDefaultBase`; `getMergeBase`'s default `check=true` throws, which would break fallback). Fallback chain, each result rejected if empty OR `=== headSha`:
   (1) `git merge-base --fork-point <baseRef> HEAD`;
   (2) plain `git merge-base <baseRef> HEAD` **ONLY IF result `!== headSha`** (else skip — it reproduces the false-empty at `:218`);
   (3) local `refs/heads/main` then `refs/heads/master` via `git rev-parse` (NOTE: `resolveDefaultBase` returns the *remote* `origin/main`; this LOCAL step is new, author it). Returns the first base whose diff vs HEAD is non-empty, else `null`.
3. **New error code.** Add `SCOPE_BASE_AHEAD_OF_HEAD` to the `ScopeErrorCode` union (`:49-56`) AND wire a matching `throw new ScopeError('SCOPE_BASE_AHEAD_OF_HEAD', …)` in the same diff (the parity test extracts both via regex — a union member never thrown goes RED). This keeps registration co-located WITHIN `scope-resolver.ts` (no separate registry).
4. **Runner disposition (fail-CLOSED, IN SCOPE).** At `pipeline-runner.ts:1750`, `SCOPE_BASE_AHEAD_OF_HEAD` MUST fall through to a clean fail-CLOSED halt: record a forensic `exit_reason` (e.g. `scope_base_ahead_of_head`) and surface a non-zero/halt, NOT an uncaught crash and NOT `return null` + proceed unscoped. It **MUST NOT** be added to the `SCOPE_EMPTY_DIFF` WARN-demotion branch.

### Acceptance criteria (WS-1)

- [ ] **(throw is primary)** When the auto-default base is at/ahead of HEAD (`baseSha === headSha`) and no usable divergent fork-point exists, `resolveAllowedFromDiffMode` throws `SCOPE_BASE_AHEAD_OF_HEAD` (NOT `SCOPE_EMPTY_DIFF`). — Verify: `node --test extension/tests/scope-resolver-base-ahead.test.js` — Type: test
- [ ] **(reflog-starved fixture)** A fixture where `git merge-base --fork-point` yields nothing (starved reflog) and the base is ahead still terminates in `SCOPE_BASE_AHEAD_OF_HEAD`, never a spurious empty/`SCOPE_EMPTY_DIFF`. — Verify: same test — Type: test
- [ ] **(fork-point recovery, conditional)** A fixture with a GENUINE divergent fork-point (HEAD has commits `baseRef` lacks AND a seeded reflog so `--fork-point` succeeds) returns the fork-point allow-list and writes scope (does NOT throw). The test specifies the exact commit topology + reflog-seeding steps; if not constructible, this AC is dropped and the throw stands as primary. — Verify: same test — Type: test
- [ ] **(true-empty unchanged)** A genuinely-empty branch (HEAD == fork-point, no real diff, base NOT ahead) still yields the legitimate `SCOPE_EMPTY_DIFF` path. — Verify: same test — Type: test
- [ ] **(explicit diff not swapped)** When `parsed.mode === 'diff'` (operator named `diff:<ref>`), the ancestry recompute does NOT engage — an explicit base is honored as-is. — Verify: same test — Type: test
- [ ] **(runner fail-CLOSED, positive)** When setup-time `resolveScope` throws `SCOPE_BASE_AHEAD_OF_HEAD`, the pipeline records a forensic `exit_reason` and halts (clean), and does NOT write `scope.json` + proceed UNSCOPED. — Verify: `node --test extension/tests/scope-resolver-base-ahead.test.js` (runner-disposition case) — Type: test
- [ ] **(runner regression, negative)** `SCOPE_BASE_AHEAD_OF_HEAD` is NOT folded into the `SCOPE_EMPTY_DIFF` WARN-demotion at `pipeline-runner.ts:1750`; a test asserts the run fails closed (function does not `return null` on this code). — Verify: same test — Type: test
- [ ] **(error-doc parity)** `scope-errors-doc-parity.test.js` is green — `SCOPE_BASE_AHEAD_OF_HEAD` is both a union member AND thrown. — Verify: `node --test extension/tests/scope-errors-doc-parity.test.js` — Type: test
- [ ] **(trap door)** Exactly one trap-door entry added to `extension/CLAUDE.md` pinning the `baseSha === headSha` guard with `ENFORCE: extension/tests/scope-resolver-base-ahead.test.js` and a `PATTERN_SHAPE`. — Verify: `bash extension/scripts/audit-trap-door-enforcement.sh` — Type: lint
- [ ] **(full gate)** tsc + eslint + audits + fast-c4 + integration + expensive green; `scope-pipeline.test.js` / `scope-refresh.test.js` unregressed. — Verify: release gate — Type: test

### Interface contracts (WS-1)
- `resolveForkPointBase(repoRoot: string, baseRef: string, headSha: string): string | null` — returns a base SHA/ref whose `base...HEAD` diff is non-empty and `!== headSha`, else `null`. Uses soft `runGit(..., false)`; never throws on git failure.
- `resolveAllowedFromDiffMode` unchanged signature; new throw `SCOPE_BASE_AHEAD_OF_HEAD` reachable only on the `parsed.mode !== 'diff'` + `baseSha === headSha` + no-fork-point path.
- `ScopeErrorCode` gains exactly one member: `'SCOPE_BASE_AHEAD_OF_HEAD'`.

---

## WS-2 — R-ISVP: install.sh `compare_semver` understands prerelease, mirroring the in-repo oracle (P3, `complexity_tier: medium`)

**Files:** `install.sh` (`compare_semver` `:52` + caller `:199`) · `extension/tests/install-script.test.js` (fixture `:78` + behavioral consumer) · `extension/tests/force-vs-allow-downgrade.test.js` (fixture `:137` + consumer) · prerelease-matrix test (extend `install-script.test.js` OR `extension/tests/install-semver-prerelease.test.js` forward-created).

**Reuse oracle:** `extension/src/bin/check-update.ts` already ships a correct prerelease comparator — `compareSemver` (`:64`) → `comparePrerelease` (`:55`) orders by **ident lexically FIRST, then num**, with `SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/` (`:35`). bash MUST mirror this contract, not hand-roll a weaker trailing-numeric ordering.

### Fix

1. **Widen the regex to match the oracle's shape** — accept `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+\.[0-9]+)?$` (prerelease is exactly `-<ident>.<num>`, symmetric with `check-update.ts:SEMVER_RE`). Bare `-beta` (no trailing number) is malformed in BOTH comparators.
2. **Strip the prerelease before the triplet split** (fixes the `IFS=. read` arithmetic blowup where `a_patch` absorbs `0-beta.31`): `local a_core="${a%%-*}"`; `local a_pre=""`; `[[ "$a" == *-* ]] && a_pre="${a#*-}"`; then `IFS=. read -r a_major a_minor a_patch <<< "$a_core"`. X.Y.Z compared via existing `10#` arithmetic.
3. **On triplet-equal, mirror `comparePrerelease`**: empty `a_pre` (release) outranks non-empty (prerelease); two prereleases compare by `<ident>` (`${a_pre%%.*}`) **lexically first**, then trailing `<num>` (`${a_pre##*.}`) numerically. (Trailing-numeric-only is WRONG — it inverts `rc.1` vs `beta.31`.)
4. **Rewire the caller** (`install.sh:199`) to branch on the return code, not raw stdout: `if ! cmp=$(compare_semver "$SRC_V" "$DEP_V"); then <handle malformed>; elif [ "$cmp" -lt 0 ]; then <refuse downgrade>; fi`. `compare_semver` emits ONLY `-1|0|1` on stdout for valid input and `return`s non-zero with NO integer-parseable stdout on malformed input (kills the `exit 1`-in-subshell anti-pattern).
5. **One real function, no drift.** The matrix test extracts the REAL `compare_semver` body from `install.sh` (awk/sed between `compare_semver() {` and its matching `}`) and `eval`s it — NOT a hand-copied fixture. Reconcile BOTH existing fixtures (`install-script.test.js:78`, `force-vs-allow-downgrade.test.js:137`): update to the new logic with a source-parity assertion, or replace with the extracted real function. No third/fourth drifting copy.

### Acceptance criteria (WS-2)

- [ ] `compare_semver 2.0.0-beta.31 2.0.0-beta.30` → `1`; `… beta.30 beta.31` → `-1`; `… beta.31 beta.31` → `0`. — Verify: matrix test — Type: test
- [ ] `compare_semver 2.0.0 2.0.0-beta.31` → `1` (release ⟩ prerelease); `… 2.0.0-beta.31 2.0.0` → `-1`. — Verify: matrix test — Type: test
- [ ] `compare_semver 2.0.0-rc.1 2.0.0-beta.31` → `1` (ident `rc` ⟩ `beta`, NOT trailing-num); `… 2.0.0-beta.31 2.0.0-rc.1` → `-1`. — Verify: matrix test — Type: test
- [ ] **(oracle parity)** For `{beta↔beta, beta↔rc, release↔beta, equal}`, bash `compare_semver` returns the SAME sign as `check-update.ts:compareSemver`. — Verify: matrix test asserts parity against the TS oracle — Type: test
- [ ] **(malformed path — the original bug)** `compare_semver foo 2.0.0` and `compare_semver 2.0.0-beta 2.0.0-beta.1` (numberless) emit NO integer-parseable stdout token, `return` non-zero, and produce NO `integer expression expected` / `Invalid semver comparison` on a normal beta→beta upgrade; the caller takes a defined non-downgrade branch. — Verify: matrix + caller test — Type: test
- [ ] **(downgrade guard re-armed)** A `beta.N → beta.(N-1)` install over a deployed newer beta is REFUSED absent `--allow-downgrade`; WITH `--allow-downgrade` (the `handle_allowed_downgrade` branch) it proceeds. — Verify: `install-script.test.js` / `force-vs-allow-downgrade.test.js` — Type: test
- [ ] **(no drift)** The matrix exercises the REAL `compare_semver` from `install.sh` (extract-and-eval); both prior fixtures are reconciled; no third copy. — Verify: source-parity assertion in the test — Type: test
- [ ] **(full gate)** release gate green. — Verify: release gate — Type: test

### Interface contracts (WS-2)
- `compare_semver <a> <b>`: stdout ∈ `{-1,0,1}` and exit 0 for two valid `X.Y.Z[-<ident>.<num>]` versions; exit ≠ 0 with empty/non-numeric stdout for malformed input. Ordering identical-in-sign to `check-update.ts:compareSemver`.
- Caller `install.sh:199`: branches on `$?` first, then on the `{-1,0,1}` value.

---

## Risks

| Risk | Mitigation |
|---|---|
| Fork-point reflog-starvation in the shared-worktree trigger environment (the exact failure env) → `--fork-point` returns nothing | Guarded fallback chain (skip plain merge-base when `=== headSha`, then local refs); terminal `SCOPE_BASE_AHEAD_OF_HEAD` throw is asserted by a reflog-starved fixture — the fix fails CLOSED, never silently empty. |
| New error code's runner disposition (uncaught crash vs renamed-not-fixed) | Positive AC (forensic `exit_reason`, clean halt) + negative regression AC (NOT folded into the `SCOPE_EMPTY_DIFF` WARN-demotion). |
| TS/bash comparator drift on cross-prefix prereleases (`beta→rc`) | bash mirrors `comparePrerelease` (ident-then-num); cross-language parity AC against `check-update.ts:compareSemver`; symmetric validity domain (`-<ident>.<num>`). |
| 3-copy `compare_semver` fixture drift → green build over dead real guard | Extract-and-eval the REAL function; reconcile both fixtures; source-parity assertion; no new copy. |

## Simplification Review (subtract-before-add)

**WS-1:** (1) Necessary — fail-OPEN→fail-CLOSED safety repair. (2) Reuse — fork-point recompute reuses `git merge-base --fork-point` + existing `computeAllowedFromDiff`; one internal helper + one enum member. (3) Fixes the brittle "trust a racy ref" behavior rather than wrapping it; CUJ-6a WARN stays for the genuine-empty case. (4) Subtracts a silent scope-lock-loss path — a stale base now names itself instead of masquerading as "no changes."

**WS-2:** (1) Necessary — re-arms a dead guard. (2) Reuse — extend `compare_semver` + its single caller; **and** mirror the existing `check-update.ts` oracle's ordering contract (the operator's subtract-before-add steer: don't hand-roll a third weaker comparator — assert parity against the canonical one). (3) Fixes the over-strict regex + the `exit 1`-in-subshell anti-pattern; no second hatch. (4) Subtracts the silent-failure mode AND collapses fixture drift from 3 copies toward one extracted source.

## Out of scope / follow-ups

- Runner-side hold-or-retry of review phases on empty resolution (a `pipeline-runner.ts` behavior change beyond the minimal fail-CLOSED disposition) — note only.
- Short-timeout `git fetch` of the default branch before resolving — the *more correct* root fix for transient ref staleness; the ancestry check mitigates the symptom, not the staleness. Deferred.
- `refreshScope` is genuinely immune (recomputes from the frozen absolute `base_sha` in setup-time `scope.json`, not a live ref) — no fix needed.
- Unifying `install.sh` semver onto a single source of truth shared with `check-update.ts` (bash can't import TS) — the WS-2 parity assertion is the minimum-viable subtraction; full unification deferred.

## Implementation Task Breakdown

| Order | ID | Title | Pri | Tier | Entry | Exit | Files |
|---|---|---|---|---|---|---|---|
| 10 | 4bea20de | R-SSBR: scope-resolver fail-CLOSED on stale/ahead base ref | High | medium | clean tree | `SCOPE_BASE_AHEAD_OF_HEAD` thrown + fail-CLOSED runner halt + parity green | scope-resolver.ts, pipeline-runner.ts, scope-resolver-base-ahead.test.js, extension/CLAUDE.md |
| 20 | 497be11e | R-ISVP: install.sh prerelease semver mirroring check-update oracle | High | medium | clean tree | prerelease matrix + oracle parity + caller rewire green | install.sh, install-script.test.js, force-vs-allow-downgrade.test.js, (matrix test) |
