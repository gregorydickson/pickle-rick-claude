# B-DEPLOYPARITY — a fast-tier test grades the machine's deployed copy, so every gate between a command edit and its deploy is red (`main`)

Measured 2026-10-02. Gate `20261002T152831Z-49037` on `main@c48dc61c`: 21/22 green, soak 1803.7s. `test_fast_budget` is red
on ONE test, deterministic in 3/3 runs: `tests/send-to-morty-no-premature-promise.test.js` ›
`R-MWBG: send-to-morty.md deployed copy matches the repo copy`.

## Mechanism

- B-RUNREPORT-54 T1 (`11af854e`) correctly changed the prompt's `status: Done` to `status: "Done"` in
  `.claude/commands/send-to-morty.md`.
- The test (`@tier: fast`, `:134`) asserts that file equals `~/.claude/commands/send-to-morty.md` — the copy deployed by the
  last `install.sh` on THIS host. The release gate always runs BEFORE `install.sh` (deploying an ungated tree is forbidden), so:
  - any branch that edits `send-to-morty.md` is red at its own gate until it has been deployed — which requires a green gate;
  - during the 2.2 beta soak the deployed runtime is `exp/b-lanes`, so `main` can never satisfy it, and the `exp/b-lanes`
    merge-down gate reds the same way.
- The test is an instrument defect, not a product check: it measures host state, not the tree. Its own comment (`805c06ba`)
  already concedes it "belongs with extension-wiring deploy-smoke instead". Its sibling `R-MWBG negative proof` (`:150`) only
  proves the parity test can fail; with the parity test gone it pins nothing.
- `diff -q .claude/commands/send-to-morty.md ~/.claude/commands/send-to-morty.md` → differ (rc 1) at HEAD.

## Fix (subtraction)

1. Delete the two deploy-parity tests (`R-MWBG: … deployed copy matches the repo copy` and `R-MWBG negative proof: …`) from
   `extension/tests/send-to-morty-no-premature-promise.test.js`, plus any constant/import only they use. Keep the file's other
   6 tests (the directive content assertions) untouched.
2. Move the observation to where it is true — AFTER a deploy: in `prds/babysitter.md` (CURRENT PROMPT rule B/S deploy step
   and the measurement rules), require `diff -rq .claude/commands ~/.claude/commands` (0 differing) alongside the existing
   by-content checks of `extension/bin` and `services/`. Doc-only; no new gate leg.

## Acceptance criteria (measured at `c48dc61c`)

1. `grep -c "deployed copy matches the repo copy" extension/tests/send-to-morty-no-premature-promise.test.js` → 0 (HEAD: **2**).
2. `cd extension && node --test tests/send-to-morty-no-premature-promise.test.js` → 0 failures with the deployed copy still
   stale (HEAD: 1 failure).
3. `grep -c "diff -rq .claude/commands" prds/babysitter.md` ≥ 1 (HEAD: **0**).
4. `cd extension && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review

1. Necessary? It removes a check; nothing is added to code.
2. Reuse: the babysitter's existing by-content deploy verification absorbs the observation.
3. Brittle guard: this IS the brittle guard — a source-tree gate reading host deploy state — and the fix deletes it.
4. Subtraction: two tests (one of which exists only to prove the other can fail). Gate leg count unchanged (22).

## Non-goals

Any other test in this file; deploy machinery; `install.sh`.
