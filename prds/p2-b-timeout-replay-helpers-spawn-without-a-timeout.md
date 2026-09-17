# B-TIMEOUT — the replay helpers spawn without a timeout

**One root. The branch is RED and this is why.** `B-ROUTABLE`'s preservation replay (`949dff1c`) and
`B-TRUTHEXIT`'s corpus replay both added `git show`-based subprocess calls to
`extension/tests/szechuan-sauce.test.js`, and four of them carry no `timeout`.

**This is NOT a stale pin.** `audit-subprocess-heavy-tests-missing-timeout.test.js:647` is correct, it
long predates both bundles, and root `CLAUDE.md` lists `spawnSync`/`spawn` without `timeout` as a
**Worker Forbidden Op**. The audit is right and the new code is wrong. **Do not touch the audit.**

**Measured at HEAD `a1e737cb`:**

```
missing-timeout suite: 19 pass / 1 fail
tests/szechuan-sauce.test.js   execSync   ::dd24a1d0cd
tests/szechuan-sauce.test.js   execSync   ::e81a0a3bdd
tests/szechuan-sauce.test.js   execSync   ::34ee117edd
tests/szechuan-sauce.test.js   execSync   ::62663e733d
```

`grep -c 'execSync(' extension/tests/szechuan-sauce.test.js` → **12**;
`grep -c 'timeout:'` → **2**.

It also reached the run's verdict honestly, which is worth recording: `post_final_tier_degraded:red`
fired with `code: 'ERR_ASSERTION', actual: 1, expected: 0` and
`test:fast halves measured: parallel_exit=0 serial_exit=1`. **Unlike the three historical firings this
one is a REAL failure**, correctly classified `red` rather than `inconclusive` — the AC-Q2 split is
working.

---

## 🚧 ROOT T — give every replay spawn a finite timeout

### AC-T
- **AC-T-1:** every `execSync`/`spawnSync`/`spawn` call in `extension/tests/szechuan-sauce.test.js`
  carries a finite `timeout`. Pick a value that comfortably exceeds a `git show` of a compiled mirror on
  a loaded box — **an over-tight timeout converts this red into a flake**, which is worse.
- **AC-T-2:** `node bin/test-runner.js tests/audit-subprocess-heavy-tests-missing-timeout.test.js`
  exits **0**.
- **AC-T-3 (do NOT weaken the instrument):** the audit, its threshold and its exemption list are
  **unchanged**. `git diff` must show no edit to
  `extension/tests/audit-subprocess-heavy-tests-missing-timeout.test.js` or to
  `extension/scripts/audit-subprocess-heavy-tests.sh`.
- **AC-T-4 (mutation — proves the fix is what greened it):** remove one of the added timeouts and the
  audit must RED again, naming that call. A green that survives the mutation means something else
  greened the suite.
- **AC-T-5:** the replay tests still pass and still assert what they asserted before — a timeout must not
  silently truncate a `git show` and turn a real replay into an empty one. **Assert the replay's own
  output is non-empty**, or the timeout has hidden the thing the replay exists to measure.

## 🛡 PRIME DIRECTIVE compliance

No halt, no abort, no new gate leg, no `EXIT_REASONS` change. This removes a forbidden-op violation the
existing audit already detects.

## Non-goals

- Do NOT modify the audit or its exemptions (AC-T-3).
- Do NOT delete or skip the replay tests to make the audit pass — they are the anti-vacuity controls for
  two shipped bundles.
- Do NOT touch any other file.

## Simplification Review

**One root, one file, four call sites.** The size is honest: the skill's own skip gates mean a single
small ticket needs no wiring and no hardening rows, and padding it would be the habit this repo indicts.
The only real risk is AC-T-1's value — too tight and a correct fix becomes an intermittent red.
