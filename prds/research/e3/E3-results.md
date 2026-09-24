# E3: offline review-recall probe, results (2026-09-24)

**Verdict: INCONCLUSIVE under the pre-registered read-out rule. The instrument ran at its ceiling.**
- (b)/(a) recall is 0.90/0.80 = **1.125×**, below the 1.5× the rule needs.
- (c) recall is 1.00 against (a)'s 0.80. That is 1.25×, not "≫".
- Found-per-pass is **not flat**: 16 for (a), 5 for (c). It tracks k.
- One whole-diff pass found **14–19 of 20** planted defects. That is far from SWR-Bench's roughly fixed 0.4–0.5 per pass. With defects this easy, per-pass capacity does not bind, and the probe cannot tell the two hypotheses apart.

## 1. Material

- **Bundle:** B-INVENTED.
  - base `f36ea11ea20ebe5e4b6efdb43b924321c575f9b7`: the `start_commit` of session `2026-09-17-df5973be`.
  - head `3ae1d57af4797309561af1c347b77af6e8a6634f`: `ad2b3f94^`, the last commit before B-GATERED was authored. It includes the bundle's own anatomy-park and szechuan commits.
- **Diff scope:** `extension/src/{bin,services,lib,hooks,types}` and `extension/tests`, with `*CLAUDE.md` excluded.
  - Compiled JS mirrors (`extension/bin|hooks|lib|services/*.js`, the tsc output) are also excluded.
  - Result: **7,083 diff lines (~409 KB, ~211k input tokens), 45 files, 5,154 added lines**.
- **Partitions (arm b):**

  | Partition | Diff lines |
  |---|---|
  | bin | 870 |
  | services + lib | 685 |
  | hooks + types | 926 |
  | tests | 4,602 |

- **Prompt source:** the real anatomy-park text, taken verbatim and concatenated:
  - `.claude/commands/anatomy-park.md` lines 318–324 (Override 1.5: severity and conf rules, the conf<80 drop, the CRITICAL escape hatch).
  - `extension/szechuan-sauce-principles.md` lines 54–98 (Priority Matrix, Confidence Scoring, False Positives — Do NOT Flag).
  - `.claude/commands/anatomy-park.md` lines 344–383 (Override 2, PHASE 1: REVIEW, including its checklist).
  - The source was the main tree at 6aaf2b14.
- **Adaptations** (stated in the prompt header):
  - There are no tools, so the git-log and CLAUDE.md steps are skipped.
  - Phase 1 only.
  - The output is a JSON array (file, line, severity, conf, title, quote, bug, scenario, proposed_fix) instead of the markdown format.
  - Each `+` and context line of the diff is prefixed with its post-image line number, standing in for the line numbers the Read tool gives the real worker.
  - The assembled prompt header is `prompts/header.txt`.
- **Model:** `claude-opus-5-5`. `modelUsage` confirms it on every call. Claude Code 2.1.281.

## 2. Mutations (all single-line, all on `+` lines of the diff's post-image)

The repo has no reusable mutation tool. The `mutation` hits under `extension/scripts` are prose about manual mutation-verification, so all mutations were hand-authored. The full list is in `mutations.json`.

| id | file:line | original | mutated | kind |
|---|---|---|---|---|
| B1 | src/bin/microverse-runner.ts:957 | `!fs.existsSync(p) && readRecoverableJsonObject(p) === null` | `… \|\| …` | && → \|\| |
| B2 | src/bin/pipeline-runner.ts:2134 | `filter((n) => !keptSet.has(n))` | `filter((n) => keptSet.has(n))` | drop negation |
| B3 | src/bin/pipeline-runner.ts:3099 | `if (briefCode !== 0) {` | `if (briefCode === 0) {` | flip comparison |
| B4 | src/bin/pipeline-runner.ts:4787 | `counters.nonConvergent > 0` | `counters.nonConvergent > 1` | off-by-one |
| B5 | src/bin/setup.ts:399 | `filter(ticket => !!ticket.id)` | `filter(ticket => !ticket.id)` | drop negation |
| S1 | src/services/citadel/ac-coverage-scorecard.ts:172 | `&& !COMMON_WORDS.has(…)` | `&& COMMON_WORDS.has(…)` | drop negation |
| S2 | src/services/citadel/audit-runner.ts:82 | `if (persistError !== null) {` | `if (persistError === null) {` | flip comparison |
| S3 | src/services/citadel/audit-runner.ts:129 | `await withLock(lockKey, {}, async () => {` | `withLock(lockKey, {}, async () => {` | remove await |
| S4 | src/services/recoverable-json.ts:138 | `if (shouldSkipLiveTmp(tmpPid, tmpPath)) continue;` | `if (!shouldSkipLiveTmp(…)) continue;` | add negation |
| S5 | src/lib/reconcile-ticket-truth.ts:69 | `probeTreeDirty(cwd) ?? true` | `probeTreeDirty(cwd) ?? false` | change default value (fail-open) |
| H1 | src/hooks/handlers/config-protection.ts:1325 | `…ProhibitedOp(value.slice(1))` | `…ProhibitedOp(value.slice(2))` | off-by-one |
| H2 | src/hooks/handlers/tsc-gate.ts:214 | `if (segmentDefinesGitAlias(tokens)) return true;` | `… return false;` | change return value |
| H3 | src/hooks/shell-exec.ts:561 | `? afterEnv + 1 : afterEnv;` | `? afterEnv : afterEnv + 1;` | swap branches |
| H4 | src/hooks/shell-exec.ts:1685 | `if (budget < 0) return command;` | `if (budget > 0) return command;` | flip comparison |
| H5 | src/hooks/shell-exec.ts:1757 | `if (value.length > 0) values.push(value);` | `if (value.length > 1) …` | off-by-one |
| T1 | tests/pipeline-runner.test.js:2900 | `assert.equal(r.remediatorSpawned, 0,` | `assert.ok(r.remediatorSpawned >= 0,` | vacuous assertion |
| T2 | tests/salvage-backfilled-done.test.js:325 | `assert.equal(truth.dirty, false,` | `assert.notEqual(truth.dirty, true,` | weakened (admits `null`) |
| T3 | tests/szechuan-sauce.test.js:277 | `assert.ok(files.length > 3,` | `assert.ok(files.length >= 0,` | vacuous guard |
| T4 | tests/hermes-smoke.test.js:55 | `for (let i = 0; i < count; i++) {` | `… i <= count …` | off-by-one fixture |
| T5 | tests/tsc-gate.test.js:2313 | `for (const command of positives) {` | `… of positives.slice(1)) {` | skips first case |

- **Test-file mutations weaken the test; they do not break it.** A flipped expected value would red the test, and the prompt's False Positives list tells the reviewer to ignore broken tests.
- **Arm (c) subset:** B1, B2, B5, H4, T3. It was drawn with `random.seed(20260924); random.sample(ids, 5)` before any call ran. It is not stratified: it contains no services mutation and three bin mutations.

## 3. Results

- 18/18 design calls completed: exit 0, `is_error: false`, 1 turn each, all JSON parsed.
- **No failures and no refusals.**

| Arm | k | Recall per repeat | Recall mean (range) | Found per pass | False positives | Findings emitted |
|---|---|---|---|---|---|---|
| (a) whole, k=20 | 20 | 0.70, 0.95, 0.75 | **0.80** (0.70–0.95) | 14, 19, 15 → **16.0** per call | 0, 0, 0 | 14, 19, 15 |
| (b) 4 partitions, k=20 (union) | 20 | 0.90, 0.90, 0.90 | **0.90** (0.90–0.90) | 18 per 4 calls = **4.5 per call** (bin 5, svc 5, hooks 4, tests 4) | 0, 0, 0 | 18, 18, 18 |
| (c) whole, k=5 | 5 | 1.00, 1.00, 1.00 | **1.00** | **5.0** per call | 0, 0, 0 | 5, 5, 5 |

**Hit counts per mutation over 3 repeats:**
- **(a):** every B, S and H mutation 3/3, except H5 2/3. T1, T3, T4 and T5 1/3 each (all four in the same repeat, r2). T2 0/3.
- **(b):** every B, S and H mutation 3/3, except H5 0/3. T1, T3, T4 and T5 3/3. T2 0/3.
- **(c):** all five 3/3.

**Where the (a) → (b) gain comes from:**
- **The test files, and nothing else.** In 2 of 3 whole-diff passes the reviewer emitted **zero findings in `extension/tests`**. The tests are the last 4,600 lines of the 7,083-line diff, and weakened assertions rate lower severity. Partitioning recovered them: 12/15 test hits against 4/15.
- **On `src/`, partitioning did not help and was slightly worse.** H5 went from 2/3 in (a) to 0/3 in (b).
- **T2 was never found in any arm.** It is the subtlest mutation: `notEqual(x, true)` quietly admits the `null` state.

**False positives:**
- **Zero in all 18 calls.** Every emitted finding matched a planted mutation.
- **k=0 control (an extra call, outside the design):** the same whole diff with no mutations, 1 call, produced 2 findings:
  - `shell-exec.ts:854`: `GIT_ALIAS_CONFIG_KEY_RE` matches paths such as `alias.ts`, so it can over-block. Plausible, not verified.
  - `death-crystal-html.ts:210`: "`openDeathCrystalReport` has no caller". This is a **false positive**: the caller is `.claude/commands/death-crystal.md:181-186`, which is outside the diff scope.
  - Neither finding appeared in any of the 18 mutated runs. **The planted defects displaced whatever the reviewer would otherwise report.** So "FP = 0" reflects crowding-out, not reviewer precision.

**Scoring and spot-check:**
- A mutation counts as found when a finding names the same file and a line within ±3, or quotes the mutated code (whitespace-normalised) (`score.py`).
- 5 matches were read by hand: a_r1 H3, a_r2 T4, b_tests_r1 T5, c_r2 H4, b_services_r2 S3. **All 5 correctly describe the injected defect**, with an accurate mechanism and the exact reverting fix.

**Cost and wall-clock:**

| Arm | Cost | Wall-clock per call |
|---|---|---|
| (a) | $3.83 for 3 calls | 62–84 s |
| (b) | $4.34 for 12 calls | 27–39 s |
| (c) | $1.97 for 3 calls | 37–43 s |
| k=0 control | $1.76 | — |

In (b), one partition set takes ~130 s serially and ~39 s if run concurrently.

## 4. Read-out against the spike rule

- **Rule 1** ((b) ≥ 1.5× (a) recall at ≤ 1.25× FPs → unit size matters, go to E1): **not met.** 1.125×. The FP condition is trivially met at 0 vs 0.
- **Rule 2** ((c) recall ≫ (a) with found-per-pass flat → defect count dominates): **not met.** Found-per-pass rises with k (5 → 16 per whole-diff pass), which is the opposite of the SWR-Bench shape. (c)'s edge is only 1.25× and sits at the ceiling.
- **Result: inconclusive.**

What the data does support, with n=3:
1. For single-line behavioural defects that contradict nearby code or comments, one Opus pass over a ~211k-token accumulated diff has **no small fixed per-pass capacity**: it found up to 19 of 20. The SWR-Bench mechanism does not reproduce at this difficulty.
2. The only unit-size effect is **positional/severity attrition at the tail of the diff**. Whole-diff passes dropped the test-file partition in 2 of 3 repeats. Partitioning removed that miss.
3. Planted defects **crowd out** real findings. The unmutated control surfaced 2 non-mutation findings (1 plausible, 1 false); the mutated runs surfaced 0.

## 5. Caveats and deviations

- **n=3 per arm, and one run, a_r2, moves (a)'s mean by 0.05.** (a)'s range (0.70–0.95) overlaps (b)'s point value. The 1.125× ratio is inside run-to-run noise. Do not read (b) > (a) as established.
- **The mutations are easier than real defects.** This repo's code is heavily commented, and most mutated lines contradict a docblock or comment a few lines away ("TRUE is the fail-CLOSED direction", "null reads DIRTY"). The reviewers' bug texts cite those comments. That is a big part of why recall saturates.
- **A sharper probe** would use harder ground truth, for example re-introducing real historic anatomy-park findings by reverting their fix commits, or mutations that no adjacent comment contradicts.
- **The design did not place mutations by position.** The tests partition is both last in the diff and lower in severity, so position and severity are confounded as the cause of the tail attrition.
- **Arm (c)'s subset is unstratified** (no services mutation).
- **Deviation, invocation:**
  - The prompt went to `claude -p` through **stdin**, not argv. It is 420 KB, near macOS `ARG_MAX`.
  - Tools were disabled (`--tools ""`) and the diff was inlined. There was no read-only file access. The reviewer could not open files outside the diff, which is how the control's death-crystal FP arose.
  - `--max-turns 2`; every call used 1.
- **Deviation, environment:**
  - Calls ran from an empty scratch dir, so the project `CLAUDE.md` and subsystem trap-door CLAUDE.md files were **not** loaded. The real worker loads them.
  - `~/.claude/CLAUDE.md` (the user's global file) was loaded; `--bare` was not usable with OAuth.
  - The real worker also reads the whole subsystem, not only the diff, and runs a multi-turn tool loop.
- **Deviation, scope and design:**
  - Compiled JS mirrors and `CLAUDE.md` files were excluded from the reviewed diff.
  - One extra k=0 control call was added outside the 18-call design. It is reported separately and does not enter any arm's numbers.
- **Measurement hygiene:**
  - The scratch worktree was restored after every diff build and removed at the end.
  - No file in the main tree was edited, committed or pushed.
  - Main HEAD moved from 6aaf2b14 to 5fdd4262 during the run. That was someone else's commit; the prompt text was read before it.

## 6. Reproduce

```bash
S=/private/tmp/claude-501/-Users-gregorydickson-pickle-rick-claude/1a9760a7-ab27-43f9-8d14-9eb17a27240f/scratchpad/e3
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
git -C /Users/gregorydickson/pickle-rick-claude worktree add --detach $S/wt 3ae1d57af4797309561af1c347b77af6e8a6634f
# prompts/header.txt was assembled from anatomy-park.md 318-324 + szechuan-sauce-principles.md 54-98
# + anatomy-park.md 344-383 at 6aaf2b14, wrapped with the adaptation header and the JSON output spec
python3 $S/build.py            # applies mutations.json to the worktree, writes diffs/*.diff (numbered), restores
for spec in "a_whole_k20:extension (whole bundle: src/bin, src/services, src/lib, src/hooks, src/types, tests)" \
            "c_whole_k5:extension (whole bundle: src/bin, src/services, src/lib, src/hooks, src/types, tests)" \
            "b_bin_k20:extension/src/bin" "b_services_k20:extension/src/services + extension/src/lib" \
            "b_hooks_k20:extension/src/hooks + extension/src/types" "b_tests_k20:extension/tests"; do
  n=${spec%%:*}; sed "s#SUBSYSTEM_NAME#${spec#*:}#" $S/prompts/header.txt > $S/prompts/$n.txt
  cat $S/diffs/$n.diff >> $S/prompts/$n.txt
done
# each call (run1.sh <name> <rep>), from an empty cwd $S/run:
#   claude -p --model claude-opus-5-5 --output-format json --max-turns 2 --tools "" < prompts/<name>.txt > raw/<name>_r<rep>.json
for r in 1 2 3; do for n in a_whole_k20 c_whole_k5 b_bin_k20 b_services_k20 b_hooks_k20 b_tests_k20; do echo "$n $r"; done; done \
  | xargs -P 6 -n 2 $S/run1.sh
python3 $S/score.py            # writes scores.json, prints per-arm table and per-mutation hit counts
git -C /Users/gregorydickson/pickle-rick-claude worktree remove --force $S/wt
```

**Artifacts in `$S`:**

| Path | Contents |
|---|---|
| `mutations.json` | the mutation list |
| `diffs/` | the numbered diffs |
| `prompts/` | the full prompts |
| `raw/*.json`, `raw/*.stderr` | raw output of every call |
| `raw/runlog.txt` | exit code and seconds per call |
| `scores.json` | per-run found ids and FP details |
| `raw/x_whole_k0_r1.json` | the k=0 control |
