# B-SELFRED-FIX — two deterministic fast-tier reds after B-SELFRED (general; main, then merge down per rule P)

Gate on `main` at `1b6306ab` (B-SELFRED, not yet pushed): 21/22 green. `test_fast_budget` is red with the same 3
failures in all 3 flake-budget runs. Measured 2026-09-28.

## Red 1 — a catalog entry split across lines (citadel rule-set audit)
`extension/tests/citadel/rule-set-invariant-audit.test.js` fails two cases: "AP-EXT-ITER296-01: entries below the
first heading after ## Trap Doors are audited" and "auditTrapDoorDeclarations — integration: real
extension/CLAUDE.md". The message is `extension/src/bin/CLAUDE.md: entries below the cut are malformed:
malformed-triple:no-breaks`.

Commit `c87fff4a` rewrote the AP-EXT-ITER221-01 entry as three physical lines: the bullet, then an `R-ORSR-6 (…)`
paragraph, then a `BREAKS:` paragraph. The audit parses each entry as ONE line carrying INVARIANT / BREAKS / ENFORCE,
so the bullet line has no BREAKS. **Fix:** rejoin the entry into one physical line, keeping every sentence. Merge the
refusal-bound text into the INVARIANT clause, before the existing `BREAKS:`.

## Red 2 — a test that pins the pre-B-SELFRED behaviour
`extension/tests/microverse-post-convergence-gate-bound.test.js:269`, "R-ORSR-6: self-introduced red gate is NEVER
force-converged (no disown by attrition)". It holds HEAD constant (`getHeadSha` → `'selfred1'`) and asserts that
`'converged'` never comes back over 6 self-red iterations. B-SELFRED
(`prds/p0-b-selfred-bound-the-no-disown-refusal-loop.md`) changed that on purpose: after
`POST_CONVERGENCE_GATE_DEFERRAL_LIMIT` refusals with HEAD unchanged, the baseline-aware cap gate decides. Green
converges; red ends `no_progress`. **Fix:** re-express the test as the NEW invariant. Do not delete it.
- (a) HEAD constant + cap gate stubbed RED → never `'converged'`, and the terminal result is `'no_progress'`.
- (b) HEAD advancing on every iteration + cap gate stubbed GREEN → never `'converged'` within 6 iterations. The
  latch cannot be disowned by attrition while work lands.

Rename the title to match. Stub the cap gate through `_deps.runGate`, which `runCapGate` calls via
`runBaselineAwareGate`.

## Acceptance criteria (measured red at `1b6306ab`)
1. `cd extension && ./node_modules/.bin/tsc && node --test tests/citadel/rule-set-invariant-audit.test.js` passes
   (HEAD: 2 failing). `bash scripts/audit-trap-door-enforcement.sh` exits 0.
2. `cd extension && node --test tests/microverse-post-convergence-gate-bound.test.js` passes (HEAD: 1 failing). Case
   (a) reds if the bound's red arm is changed to return `'converged'`, and case (b) reds if a HEAD move stops
   resetting the refusal count. Record both mutations in a comment.
3. `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review
One doc line rejoined and one test re-expressed. No product change.
