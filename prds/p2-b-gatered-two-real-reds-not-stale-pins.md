# B-GATERED — the two gate reds B-INVENTED introduced

**Both reds are REAL. Neither is a stale pin over a behaviour-preserving refactor**, and that was
checked first, per the gate-red rule. Four legs went red at `3ae1d57a` from **two** causes.

| root | legs red | cause | verification host |
|---|---|---|---|
| **G1** two `execFileSync` git callsites without a `timeout` | 3 | `ac648a36` (this bundle's anatomy-park pass) | `scripts/audit-subprocess-heavy-tests.sh` |
| **G2** the executable-assertion ratio fell below its recorded floor | 1 | ticket authoring in this bundle | `scripts/audit-acceptance-assertion-coverage.sh` |

**All commands run from `extension/`.**

---

## 🚧 ROOT G1 — three legs, one defect

`tests/citadel-audit-runner.test.js` gained two `execFileSync('git', …)` callsites with **no
`timeout`**:

- `:196` — `const run = (args) => execFileSync('git', args, { cwd: root, stdio: [...] });`
- `:319` — `const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: [...] }).toString().trim();`

Root `CLAUDE.md`'s Worker Forbidden Ops table lists `spawnSync`/`spawn` with no `timeout` as forbidden,
enforced per-callsite by trap doors. The scanner reports:

```
tests/citadel-audit-runner.test.js: new missing-timeout execFileSync(...) callsite not in baseline
  (tests/citadel-audit-runner.test.js::execFileSync::e9bc83181a…)
```

**One defect reds three legs, which is why they must not be triaged separately:**
`audit-subprocess-heavy-tests` runs it directly; `test_integration` runs the same audit in its
`pretest:integration`; and `test_fast_budget` reds on `AP-EXT-ITER42-01: the committed extension/tests
corpus has zero un-baselined missing-timeout callsites` — the in-suite oracle for the same invariant.
It failed **3 of 3** flake-budget runs, so it is deterministic, not a flake.

**Fix the callsites, not the baseline.** Adding the hashes to
`scripts/subprocess-heavy-missing-timeout-baseline.json` would silence three legs while leaving two
unbounded git spawns in a test that runs under load — the exact "green light wired to nothing" this
repo keeps finding.

### AC-G1
- [ ] Neither callsite spawns without a timeout — Verify: `grep -c "execFileSync('git', args, { cwd" tests/citadel-audit-runner.test.js` returns 0 — Type: lint
- [ ] The scanner reports no un-baselined callsite — Verify: `bash scripts/audit-subprocess-heavy-tests.sh` exits 0 — Type: lint
- [ ] The in-suite oracle greens — Verify: `node bin/test-runner.js tests/audit-subprocess-heavy-tests-missing-timeout.test.js --test-concurrency=1` exits 0 — Type: test
- [ ] The baseline file is unchanged — Verify: `git diff --name-only -- scripts/subprocess-heavy-missing-timeout-baseline.json` returns 0 — Type: lint
- [ ] The integration tier greens — Verify: `npm run test:integration` exits 0 — Type: integration
- [ ] Typecheck and lint pass — Verify: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exits 0 — Type: typecheck

### Test Expectations — G1
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| callsites bounded | `extension/tests/citadel-audit-runner.test.js` | both git spawns | each carries an explicit `timeout` |
| oracle greens | `extension/tests/audit-subprocess-heavy-tests-missing-timeout.test.js` | AP-EXT-ITER42-01 | zero un-baselined callsites |

---

## 🚧 ROOT G2 — the ratchet is correct and the authoring regressed

```
below floor: measured 25/82 is below the recorded session_min_ratio 13/40
  — tickets are being authored without an executable assertion
```

**Measured across the two gate runs:**

| | previous gate (`e8aa307d`, GREEN) | this gate (`3ae1d57a`, RED) |
|---|---:|---:|
| tickets scanned | 108 | 118 |
| guarded / measurable | **24/73** = 32.88% | **25/82** = 30.49% |
| floor `session_min_ratio` 13/40 | 32.5% | 32.5% |

**+9 to the denominator, +1 to the numerator.** Of this bundle's nine tickets, `grep -lE` finds two
matching the executable form and **one of those two is prose describing existing behaviour**
(`` `install.sh:225` exits 1 ``) that merely matches the regex. So **one genuine executable acceptance
criterion across nine tickets.**

**The instrument is not at fault and must not be touched.** `audit-acceptance-assertion-coverage.sh:28`
documents `session_min_ratio` as a deliberate **RATIO LOWER-BOUND ONLY** — it *"never refuses for being
above it, since the corpus grew since last time is not a regression"*. It refuses exactly one thing:
the ratio falling. It fell because of how the tickets were written.

**Do NOT retro-edit the Done B-INVENTED tickets to raise the number.** Their work is complete; adding
executable forms after the fact would move the metric without improving anything — fake-green in the
instrument this bundle exists to defend. **Do NOT lower the recorded floor.**

**The only honest repair is forward:** every criterion in this bundle's own tickets uses the executable
form (`` `cmd` exits N `` / `` `cmd` returns N ``), which lifts the corpus ratio as a consequence of
doing the work correctly rather than as its purpose.

### AC-G2
- [ ] Every acceptance criterion in this bundle's tickets carries an executable assertion — Verify: `bash scripts/audit-acceptance-assertion-coverage.sh` exits 0 — Type: lint
- [ ] The recorded floor is unchanged — Verify: `git diff --name-only -- scripts/acceptance-assertion-coverage-floor.json` returns 0 — Type: lint
- [ ] No Done ticket from session `2026-09-17-df5973be` is edited — Verify: `git status --porcelain` returns 0 — Type: lint

---

## NOT in Scope
- Adding the callsite hashes to the missing-timeout baseline.
- Lowering `session_min_ratio`, or any edit to either audit script.
- Retro-editing completed B-INVENTED tickets.
- Any new release-gate leg — both roots are already caught by existing legs, which is how they were found.

## Exit State
The gate is 22/22 green at a commit that fixes the callsites rather than baselining them, and the
executable-assertion ratio is back above its floor because the tickets were authored correctly.
