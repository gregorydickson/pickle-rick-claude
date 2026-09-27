# E3b: review recall on real reverted defects (2026-09-26)

**Verdict: INCONCLUSIVE under the pre-registered rule. The instrument ran at its FLOOR.**
- Recall was **0.00 in every arm and every repeat**: (a) 0/12 ×3, (b) 0/12 ×3, (c) 0/3 ×3.
- (b)/(a) is 0/0 (undefined), so rule 1 cannot fire; (c) is not ≫ (a), so rule 2 cannot fire.
- Found-per-pass is **flat at zero** — trivially "flat", which is not the SWR-Bench shape either.
- **E3's saturation did not recur; it inverted.** Planted single-line mutations (E3): 14–19 of 20 per pass. Real historical defects with their fix comments stripped (E3b): 0 of 12, in 16 calls.
- What each pass *did* emit was a small, roughly fixed number of other findings: 1–2 per whole-diff pass, 1–3 per unioned lane set. None touched a pool defect.

## 0. Pre-registration (written before any model call)

- **Pool:** 12 real past fixes (D1–D12), each a single `extension/src/**/*.ts` file, re-introduced by reversing the fix.
- **Diff:** `extension/src` from base `12ffe1327d` to head `1ad3f505c3` (plus/minus the pool patches), CLAUDE.md excluded.
- **Arms**, 3 repeats each, `claude-opus-5-5`: (a) whole diff, k=12; (b) the beta lane roster (`resolve-scope.js --print-subsystems`), each lane sees only its files, findings unioned; (c) whole diff, k=3 = `random.seed(20260926); random.sample(D1..D12, 3)` = **D1, D2, D11**, drawn before any call.
- **Control:** 1 whole-diff call with k=0; its findings are subtracted from every arm's false positives.
- **Hit:** a finding names the defect's file and lands within ±5 lines of the reverted hunk, or quotes its code.
- **Read-out:**
  - (b) recall ≥ 1.5× (a) at ≤ 1.25× (a)'s false positives → **unit size matters**.
  - (c) recall ≫ (a) (taken as ≥ 1.5×) **and** found-per-pass flat (taken as (a)'s mean found-per-pass ≤ 1.5× (c)'s, although (a) holds 4× the defects) → **defect count dominates; lanes pay only via concurrency**.
  - Otherwise → **inconclusive**. Saturation = (a) recall ≥ 0.9 in every repeat.

## 1. Material

- **Window:** first-parent `main`, base `12ffe1327d9f326620f13d5ed621dec680181d1a` (2026-08-28) → head `1ad3f505c31ec6ec231c489b9482b36777fbcea6` (2026-09-07).
  - Chosen by search: over 2,500 first-parent commits, the window holding the most pool candidates whose defective lines were **introduced inside the window**, under a ~15k-line diff cap.
  - Every defect therefore shows up as ordinary `+` lines of the bundle diff. No `-` line carries the fixed code (checked: 0 of the fixes' code lines appear as removed lines).
- **Diff scope:** `extension/src` only, `*CLAUDE.md` excluded; compiled mirrors are outside `extension/src`. **14,812 diff lines, 878 KB, ~414k input tokens, 37 files.**
  - `extension/tests` was **excluded** (deviation from E3): with tests the window was 47k lines. The pool is src-only.
- **Pool (12 real fixes; one `extension/src/**/*.ts` file each; subjects mark a defect):**

| id | fix sha | file | defect (own words) |
|---|---|---|---|
| D1 | 6a85aded9a | bin/mux-runner.ts | touched-path `git diff --name-only` without `-c diff.relative=false`: under an ambient `diff.relative=true`, below the toplevel paths come back cwd-relative and miss repo-root `allowed_paths` |
| D2 | 2c0c99c34d | bin/spawn-refinement-team.ts | `git ls-files -- *<token>` pathspec is cwd-relative; from a subdirectory a real tracked file resolves to 0 matches → citation reported `path_not_found` |
| D3 | c329656525 | services/orphan-reaper.ts | derived TMPDIR sweep returns the same `{scanned:0,removed:0}` for an unreadable dir as for a clean one ("never counted" = "counted nothing") |
| D4 | c1248201dd | services/convergence-gate.ts | test-failure dedupe keyed on test NAME erases distinct same-titled failures; the survivor matches the baseline → fail-open green |
| D5 | 58ca7b6bd2 | services/convergence-gate.ts | `not ok` failure regex lacks a word boundary; prose like "not okay…" becomes a failing test |
| D6 | aae07df69d | hooks/shell-exec.ts | each `*` of a star run becomes `.*`; a long run is catastrophic backtracking that stalls the guard hook (fail-open by timeout) |
| D7 | a02d847c56 | bin/mux-runner.ts | implement-pass `spawnSync` has no `maxBuffer`; >1 MB of LLM output → ENOBUFS kill, completed pass reads not-ok |
| D8 | 11e825a4c6 | types/index.ts | exit-reason lookup `record[reason] ?? default` returns inherited prototype members (`constructor`, `toString`) |
| D9 | 281e2c5f0f | bin/test-runner.ts | process-group reap only on ETIMEDOUT; a child killed by a signal leaves `node --test` grandchildren running |
| D10 | 98fc34771f | bin/mux-runner.ts | cross-ticket regression recorder counts `script_failure` entries (gate died before any TAP) and accuses a ticket |
| D11 | 0e02ae5cd6 | bin/reap-orphans.ts | fixture-TMPDIR sweep failure returns zeros like a clean sweep, and the printer is silent unless `removed > 0` |
| D12 | a2332d3f58 | bin/mux-runner.ts | `status === null` classified `never_executed`, although ETIMEDOUT/ENOBUFS children ran and were killed; the log misreports (weakest defect in the pool) |

- **Rejected candidates:** comment/docblock-only or refactor commits in the window; `27c7a5323c` and `65692d01c4` (reverse does not apply cleanly at head: code later reshaped; `ed1503d3d7` would have forced a 18k-line base).
- **Recipe** (`build.py`): `H_fixed` = head + forward-apply of the three fixes that landed after head (D1, D2, D9; all apply cleanly). Variant(k) = `H_fixed` + `git apply -R` of the k chosen fixes, newest first. Reviewed diff = `git diff -U3 <base> -- <files>` of the worktree, `+`/context lines prefixed with post-image line numbers (as E3). Every reverse applies cleanly, alone and together.
- **Lanes (arm b):** `node ~/.claude/pickle-rick/extension/bin/resolve-scope.js --print-subsystems --target <worktree at head>` (deployed v2.2.0-beta.1 runtime). The diff falls into three lanes:

| Lane | Files | Diff lines | Pool defects |
|---|---|---|---|
| `extension/src/bin` | 15 | 9,990 | D1 D2 D7 D9 D10 D11 D12 |
| `extension/src/services` | 17 | 2,581 | D3 D4 D5 |
| `extension/src/.` (hooks, lib, types) | 5 | 2,241 | D6 D8 |

- **Prompt source:** byte-identical to E3's `prompts/header.txt` (anatomy-park.md 318–324 + szechuan-sauce-principles.md 54–98 + anatomy-park.md 344–383 at 6aaf2b14, with E3's no-tools adaptation header and JSON output spec); `SUBSYSTEM_NAME` = the lane name, or "extension (whole bundle: …)".
- **Invocation:** as E3 — `claude -p --model claude-opus-5-5 --output-format json --max-turns 2 --tools ""`, prompt on stdin, from an empty scratch cwd. `modelUsage` = `claude-opus-5-5` on every call. Claude Code 2.1.281.

## 2. Results

- **16/16 calls completed**: exit 0, `is_error: false`, all JSON parsed, **no refusals, no failures.** 15 used 1 turn; `b_src_bin_k12_r2` used 2.
- **Control (k=0, 1 call): 0 findings** (`[]`), so no finding in any arm is subtracted as pre-existing.

| Arm | k | Recall per repeat | Recall mean (range) | Found per pass | Findings emitted | False positives |
|---|---|---|---|---|---|---|
| (a) whole, k=12 | 12 | 0, 0, 0 | **0.00** (0–0) | 0 | 2, 1, 1 | 2, 1, 1 |
| (b) 3 lanes, unioned | 12 | 0, 0, 0 | **0.00** (0–0) | 0 per set, 0 per call | 3, 3, 1 (per 3 calls) | 3, 3, 1 |
| (c) whole, k=3 (D1, D2, D11) | 3 | 0, 0, 0 | **0.00** (0–0) | 0 | 1, 1, 1 | 1, 1, 1 |

- **Scoring** (`score.py`): hit = same file and line within ±5 of a code-bearing reverted hunk (comment-only hunks dropped, `core.py`), or a quote containing one of its code lines. **Independent check:** none of the 12 defective functions' names (`listRangeTouchedPaths`, `resolveTrackedSuffixMatches`, `sweepDerivedTmpDirFixtures`, `parseTestOutput`, `TEST_FAILURE_LINE_RE`, `shellPatternToRegex`, `spawnConvergedPlanImplementPass`, `classifyExitReason`, `reapTimedOutChild`, `recordCrossTicketRegression`, `sweepStaleFixtureTmpDirs`, `classifyRemediatorSpawn`) occurs in any of the 16 outputs. The zero is not a matcher artefact.
- **Hand spot-check (5):** a_r1 microverse-runner:4515, b_src_root_r3 config-protection:731, c_r3 activity-timeline-verifier:320, b_src_services_r1 backend-spawn:756, b_src_root_r1 tsc-gate:482. All five describe non-pool code with a concrete mechanism; none is a mis-scored pool hit.
- **What the reviewer found instead.** One finding recurs in 7 of 9 whole/bin passes (a ×3, b ×2, c ×2): the LLM-judge score overwritten by `violations.length` (microverse-runner). Others: argv truncation applied on macOS (services lane ×2), tsc-gate root tsconfig skipped, config-protection glob over-block (×2), activity-timeline verifier. These count as "false positives" under the rule only because the control call emitted nothing; **whether they are real is not measured here** (hypothesis: the recurring microverse one is real — main now scores the baseline by `violations.length` too, `extension/src/bin/microverse-runner.ts:4690`).
- **Cost/wall-clock:** $24.63 total. Whole-diff calls 118–333 s ($0.34–3.85; the spread is prompt-cache hits). Lanes: bin 97–304 s, services 73–81 s, root 129–176 s; a lane set is ~300 s serial, ~170–300 s concurrent (bin dominates).

## 3. Read-out against the pre-registered rule

- **Rule 1** (b ≥ 1.5× a at ≤ 1.25× FP): **not met** — 0 vs 0. Lanes did emit more non-pool findings (7 vs 4 over 3 repeats) but found no pool defect.
- **Rule 2** (c ≫ a, flat found-per-pass): **not met** — (c) 0.00 is not ≫ 0.00.
- **Result: inconclusive. Floor, not ceiling.**

What the data supports (n = 3 per arm):
1. **Real historical defects in a ~414k-token accumulated diff are almost invisible to one no-tools Phase-1 pass**, whether whole, per lane, or with only 3 of them present. That is the opposite of E3 and brackets the question: planted comment-contradicting mutations saturate, real defects stripped of their fix comments floor.
2. **Per-pass output is small and roughly fixed** (1–3 findings), independent of k and of unit size within the 2.2k–15k-line range tested. This is consistent with the "fixed finds per pass" reading of SWR-Bench, but here the fixed budget was spent on *other* candidates, so it says nothing about recall of these defects.
3. **The lane split did not help on these defects even at 2.2–2.6k lines** (services, root lanes: 0 of 5 pool defects in 6 calls).

## 4. Caveats and deviations

- **The real worker is not this reviewer.** It has tools (grep, `git log`, file reads), loads subsystem CLAUDE.md trap doors, runs multi-turn and many passes. Many pool defects need knowledge outside the diff (git's `diff.relative`/pathspec semantics at a subdirectory, spawnSync's 1 MB default, what a producer emits). E3b measures the no-tools single-pass floor, not anatomy-park.
- **Most pool defects were originally found by anatomy-park itself, on later passes, often with measurement** ("measured at this exact call shape…"). That they are hard for one pass is partly selection: easy defects were fixed before they reached a later-pass commit.
- **Diff is 2× E3's** (414k vs 211k tokens) and `extension/tests` was excluded; size and difficulty are confounded between E3 and E3b.
- **Arm (c)'s seeded subset is all in the bin lane** (D1, D2, D11): unstratified, as in E3.
- **Conf ≥ 80 drop.** The prompt tells the reviewer to drop anything below 80 and to prefer zero findings. Some pool defects may have been seen and dropped in thinking; outputs contain only surviving findings.
- **FP counts are "non-pool, non-control" findings, not verified false positives**; the control emitted nothing, so nothing was subtracted.
- **Hygiene:** all work in scratch; the scratch worktree was restored after each build and removed at the end; nothing in the main tree was edited except this directory and the spike report. Nothing committed.

## 5. Reproduce

```bash
S=<scratch>/e3b; export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
git -C <repo> worktree add --detach $S/wt 1ad3f505c31ec6ec231c489b9482b36777fbcea6
for h in <each pool sha in pool.json>; do f=<its .ts file>; git -C <repo> show --format= $h -- $f > $S/fix_${h:0:10}.patch; done
node ~/.claude/pickle-rick/extension/bin/resolve-scope.js --print-subsystems --target $S/wt > $S/lanes.json
mkdir -p $S/prompts $S/raw $S/run; cp prds/research/e3b/{build.py,core.py,score.py,run1.sh,pool.json} $S/; cp prds/research/e3b/prompt-header.txt $S/prompts/header.txt
python3 $S/build.py && python3 $S/core.py        # diffs/*.diff + meta.json (defect locations)
# prompts/<name>.txt = header with SUBSYSTEM_NAME substituted + diffs/<name>.diff
$S/run1.sh x_whole_k0 1                            # control
for r in 1 2 3; do for n in a_whole_k12 c_whole_k3 b_src_bin_k12 b_src_services_k12 b_src_root_k12; do echo "$n $r"; done; done | xargs -P 6 -n 2 $S/run1.sh
python3 $S/score.py
git -C <repo> worktree remove --force $S/wt
```

Files here: `prompt-header.txt` (E3's header, byte-identical), `build.py`, `core.py`, `score.py`, `run1.sh`, `pool.json` (pool with subjects), `meta.json` (defect line ranges per variant), `scores.json` (per-run found ids and non-pool findings). Raw outputs, prompts and diffs stay in scratch (too large).

