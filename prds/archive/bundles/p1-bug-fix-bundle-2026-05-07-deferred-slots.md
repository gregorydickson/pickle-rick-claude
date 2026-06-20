---
title: P1 — Bug-fix bundle 2026-05-07 (deferred slots: codex hallucination root cause + judge model + cap/handshake + install chmod + anatomy-park /bin/ scope)
status: Shipped
filed: 2026-05-07
priority: P1
shipped: closes Open Findings #1, #3, #4 (commit 923a7273)
type: bug-bundle
composes:
  - prds/archive/bug-reports/codex-classifier-prompt-leak.md                    # Slot G — MANAGER_PERSISTENT_HALLUCINATION root cause
  - prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md       # Slot H — judge spawns with unsupported model
  - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md     # Slot I R-1 + Slot J (R-ICP-1..4 only)
related:
  - prds/p1-bug-fix-bundle-theme-a-refinement-quality.md    # predecessor; Theme A 9/9 sections shipped 2026-05-07 AM
  - prds/MASTER_PLAN.md                                     # post-bundle bookkeeping target
backend_constraint: claude
refine: false
unattended: true
---

# PRD — P1 Bug-Fix Bundle 2026-05-07 — deferred slots

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

Theme-A pipeline shipped 9/9 sections 2026-05-07 AM (Sections A/B/C/D/F/G/H/I + L). Three production fixes landed in the afternoon hardening sweep (`b0f5ceca` baseline-staleness defer, `cbce383a` test:fast concurrency cap, `67ae0348` spawn-morty preloaded-state reuse). Production gates clean: TypeScript clean, ESLint clean, trap-door audit clean (113 ENFORCE refs), phantom-Done audit clean. test:fast failure count down from 186 to ~10–15.

Four open findings remain from the predecessor session — three are root-cause defects whose surface PRDs already exist; one (anatomy-park /bin/ scope) is a small additive scope fix. One operational hardening item (install.sh chmod manifest) is folded in to close Open Finding #4. This bundle composes them into a single unattended `/pickle-pipeline --no-refine --backend claude` run.

Backend MUST be `claude`. **Slot G IS the codex hallucination root cause** — running this bundle through `--backend codex` would reproduce the very defect it fixes and risk silent loss of the worker's own progress mid-bundle (witnessed on attractor session `pipeline-1d81a0bb` where codex bailed on this defect class).

## Refinement: SKIPPED

`refine: false`. Each slot is either (a) a fully-specified existing PRD with R-codes already enumerated, or (b) a small additive fix with a clear contract. The refinement-team would re-scope work that's already crisp. Operator override: drop `--no-refine` from the launch command if a slot proves under-specified mid-run (will not be needed).

## Per-slot disposition table — R-BUNDLE-DISPO-2026-05-07

| Slot | R-codes | Source PRD | Disposition |
|---|---|---|---|
| **G** — codex classifier prompt leak | R-CCPL-1..6 (mapped from source R1..R6) | `prds/archive/bug-reports/codex-classifier-prompt-leak.md` | **IMPLEMENT** — all 6 reqs from source PRD |
| **H** — szechuan judge model | R-SCJM-1..6 | `prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md` | **IMPLEMENT** — all 6 ACs from source PRD |
| **I R-1** — iteration cap parity on resume | R-ICP-3, R-ICP-4 | `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` | **IMPLEMENT** — only R-ICP-3 + R-ICP-4 (R-ICP-2 carried in slot J; R-ICP-5/6 already shipped; R-ICP-7 covered by composite test in Section H below) |
| **J** — mux-runner cap-hit exit code | R-ICP-1, R-ICP-2 | `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` | **IMPLEMENT** — exit 3 + pipeline halt |
| **K** — install.sh chmod manifest | R-ICM-1..3 *(NEW)* | this PRD § Section F | **IMPLEMENT** — replace hand-maintained list with manifest/glob |
| **L** — anatomy-park default scope adds /bin/ | R-APBS-1..3 *(NEW)* | this PRD § Section G | **IMPLEMENT** — repo-root /bin/ enumerated as a subsystem when present |

Slots G and L have natural ordering benefits: slot G ships first within the build phase (highest blast-radius defect; closes Open Finding #1); slot L's fix lands in time for the pipeline's own `anatomy-park` phase to benefit from the broader scope when reviewing this bundle.

## Section A — Bundle bootstrap *(FIRST)*

| Req | Description |
|---|---|
| **R-BUNDLE-1** | `state.flags.bundle_bootstrap_mode = "2026-05-07-deferred-slots"` with the new session-hash allowlist; auto-applies BOTH `skip_readiness_reason` AND `skip_ticket_audit_reason` for THIS bundle's launch only. Activity event `bundle_bootstrap_exemption_applied` records `{bundle_id, session_hash, flags}`. |
| **R-BUNDLE-DISPO** | The disposition table above is committed at `extension/src/data/bundle-disposition-2026-05-07-deferred-slots.json`. R-TAQ-2 audit-ticket-bundle reads this file. Exempts disposition `IMPLEMENT-but-no-source-PRD-for-K-L` (slots K and L are NEW reqs in this bundle, not inherited). |

**Section A — Acceptance Criteria**

- **AC-A-01** — `bundle-disposition-2026-05-07-deferred-slots.json` exists, schema-valid against the bundle-disposition schema.
- **AC-A-02** — Audit-ticket-bundle on this session's tickets exits 0 (or only with non-fatal warnings).
- **AC-A-03** — Activity event `bundle_bootstrap_exemption_applied` records the new bundle id.

## Section B — Slot G — Codex classifier prompt leak *(SECOND — closes Open Finding #1)*

Source: `prds/archive/bug-reports/codex-classifier-prompt-leak.md` (read in full). All 6 source requirements (R1..R6) are inherited verbatim and renamed `R-CCPL-1..6` for disposition-table consistency.

| Req | Description |
|---|---|
| **R-CCPL-1** *(=source R1)* | `extractAssistantContent` distinguishes prompt content from model response in codex plain-text logs. |
| **R-CCPL-2** *(=source R2)* | `classifyCompletion` returns `'task_completed'` only when the model's response contains the EPIC_COMPLETED token. |
| **R-CCPL-3** *(=source R3)* | Worker template files contain no classifier-matched promise token in unbroken substring form. Authoritative blocklist sourced from `extension/src/hooks/handlers/stop-hook.ts:170-183` (or a shared constants module both files import). |
| **R-CCPL-4** *(=source R4)* | Codex output format detected explicitly via the block-delimiter rule, not via "stream-json failed → assume plain-text." Fail-loud on delimiter drift. |
| **R-CCPL-5** *(=source R5)* | Regression tests cover all 6 fixtures from source PRD § "Test Expectations" (`codex-prompt-leak`, `codex-real-completion`, `codex-ticket-selected`, `claude-stream-json`, `claude-real-completion`, `mixed-json-noise`). |
| **R-CCPL-6** *(=source R6)* | All-tickets-pending guard error message includes the iteration log path. |

**Section B — Acceptance Criteria** (all from source PRD § Verification table; references in source unchanged):

- **AC-CCPL-01..06** — one per requirement; all map to `extension/tests/mux-runner-classifier.test.ts`, `extension/tests/template-no-bare-tokens.test.ts`, `extension/tests/mux-runner-guard-logging.test.ts` per source verification table.
- **AC-CCPL-07** — Deployed templates (`~/.claude/commands/{pickle,meeseeks,szechuan-sauce,microverse,pickle-tmux}.md`) post-`bash install.sh` contain zero unbroken `<promise>[A-Z_]*</promise>` substrings outside HTML comments.
- **AC-CCPL-08** — Trap-door entry in `extension/CLAUDE.md`: "Codex plain-text classifier MUST detect via block delimiters; stream-json fallback MUST require ≥1 `type:"assistant"` JSON line."

**Files in scope**: `extension/src/bin/mux-runner.ts` (extractAssistantContent + classifier), `extension/src/services/promise-tokens.ts` (NEW; shared constants module per source PRD § Coupling), `.claude/commands/{pickle,meeseeks,szechuan-sauce,microverse,pickle-tmux}.md` (substring-broken token forms), `install.sh` (template macro substitution if R-CCPL-3 chooses the macro variant), tests as listed in source PRD.

## Section C — Slot H — Szechuan judge model unconditional-claude routing *(THIRD)*

Source: `prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md` (read in full). All 6 ACs (AC-SCJM-01..06) inherited verbatim and renamed `R-SCJM-1..6`.

| Req | Description |
|---|---|
| **R-SCJM-1** *(=source AC-SCJM-01)* | Locate the call site that selects `claude-sonnet-4-6` as judge model for codex backend. Grep `extension/src/` for the literal `claude-sonnet-4-6`. Document call site in PR description. |
| **R-SCJM-2** *(=source AC-SCJM-02)* | Refactor `microverse-runner.ts` (and helpers) to always spawn the LLM judge via the claude path, even when `--backend codex` is set. Worker iteration spawn continues to honor `--backend codex`. |
| **R-SCJM-3** *(=source AC-SCJM-03)* | Convergence guard: before declaring convergence in `microverse-runner.ts:~640`, assert `convergence.history.length >= min_iterations` AND ≥1 history entry has a non-null `score`. If neither holds, exit `judge_unreachable` with non-zero process exit code. `pipeline-runner.ts` surfaces `judge_unreachable` distinctly from `converged`. |
| **R-SCJM-4** *(=source AC-SCJM-04)* | Integration test `extension/tests/integration/microverse-runner-judge-failure.test.js`: stub judge spawn to throw the literal `'claude-sonnet-4-6' model is not supported when using Codex with a ChatGPT account` error twice; assert `judge_unreachable` + non-zero exit. |
| **R-SCJM-5** *(=source AC-SCJM-05)* | Trap-door in `extension/CLAUDE.md`: judge LLM spawn MUST be claude-routed regardless of `--backend`. PATTERN_SHAPE: `model:\s*claude-` or `--model\s+claude-` in any codex spawn site outside the worker iteration codepath. |
| **R-SCJM-6** *(=source AC-SCJM-06)* | `pipeline-runner.ts` does NOT spawn `finalize-gate` when microverse exits with `judge_unreachable`; pipeline reports szechuan as failed and stops. |

**Files in scope**: `extension/src/bin/microverse-runner.ts`, `extension/src/services/microverse/` (judge-spawn helper if extracted), `extension/src/services/codex-spawn.ts`, `extension/src/bin/init-microverse.ts:13` (the operator-cited literal-`judge_model` site), `extension/src/bin/pipeline-runner.ts` (judge_unreachable handling), tests as above, `extension/CLAUDE.md`.

## Section D — Slot I R-1 — Resume-cap parity *(FOURTH)*

Source: `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` § R-ICP-3 + R-ICP-4 only. R-ICP-5/6 already shipped (phantom-Done watcher closed via Theme-A Section G); R-ICP-7 covered by Section H integration test below.

| Req | Description |
|---|---|
| **R-ICP-3** *(carried)* | `setup.js --resume <SESSION_ROOT>` reads `state.json:max_iterations` (and `max_time`, `worker_timeout`, `backend`) from disk and honors them as the active cap. CLI `--max-iterations` on resume overrides; otherwise persisted values win. |
| **R-ICP-4** *(carried)* | `setup.js` initial setup persists CLI `--max-iterations`, `--max-time`, `--worker-timeout` into `state.json` AT setup time. Subsequent reads (mux-runner, pipeline-runner, monitor) use persisted values, not re-derive defaults. |

**Section D — Acceptance Criteria**

- **AC-ICP-03** *(=source AC-ICP-03)* — `setup.js --resume` honors persisted state. Verify: `cd extension && npm test -- --grep setup.resume-honors-persisted-cap`.
- **AC-ICP-04** *(NEW)* — Replay test using session `2026-05-03-7d9ee8cc` fixture: `state.json:max_iterations=100` persisted; `setup.js --resume` returns cap=100, NOT default-derived 15.
- **AC-ICP-05** *(NEW)* — Trap-door in `extension/CLAUDE.md`: "max_iterations / max_time / worker_timeout / backend persist at initial setup; resume MUST read persisted values, not re-derive."

**Files in scope**: `extension/src/bin/setup.ts` (resume logic), `extension/src/services/state-manager.ts` (schema enforcement of persisted CLI args), `extension/CLAUDE.md`, `extension/tests/setup-resume-honors-persisted-cap.test.js` (NEW).

## Section E — Slot J — Mux-runner cap-hit exit + pipeline-runner halt *(FIFTH)*

Source: `prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` § R-ICP-1 + R-ICP-2.

| Req | Description |
|---|---|
| **R-ICP-1** *(carried)* | mux-runner exits with code **3** (distinct from 0=clean and 1=error) when iteration cap is hit without an `EPIC_COMPLETED` promise. `state.exit_reason` = `iteration_cap_exhausted`. |
| **R-ICP-2** *(carried)* | pipeline-runner treats exit code 3 from a phase as "phase incomplete; halt pipeline; report unfinished count." Prints unfinished ticket list with orders + IDs. |

**Section E — Acceptance Criteria**

- **AC-ICP-01** *(=source)* — `cd extension && npm test -- --grep mux-runner.iteration-cap-distinct-exit`.
- **AC-ICP-02** *(=source)* — `cd extension && npm test -- --grep pipeline-runner.halt-on-incomplete-phase`.
- **AC-ICP-06** *(=source AC-ICP-06)* — End-to-end regression: `cd extension && npm test -- --grep iteration-cap-and-phantom-done-end-to-end`. Synthetic 5-Todo session, mux-runner cap=2; assert exit code 3, `exit_reason=iteration_cap_exhausted`, pipeline halts with unfinished list, no phantom-Done escape.
- **AC-ICP-07** *(NEW, replaces source R-ICP-7)* — Caller-impact audit: any caller of mux-runner that previously treated non-zero exit as fatal must be updated. Today the only callers are `pipeline-runner.ts` (handled by R-ICP-2 above) and interactive `/pickle` (already prints the message). Audit script `extension/scripts/audit-mux-runner-callers.sh` greps for `mux-runner` spawn sites; CI fails on new caller without explicit code-3 handling.

**Files in scope**: `extension/src/bin/mux-runner.ts` (cap exit logic), `extension/src/bin/pipeline-runner.ts` (phase advance + code-3 handling), `extension/scripts/audit-mux-runner-callers.sh` (NEW), tests as above.

## Section F — Slot K — install.sh chmod manifest *(SIXTH — closes Open Finding #4)*

The current `install.sh` lines 401–425+ hand-maintain a chmod +x list — every new bin script must be added by hand. This caused the `dot-builder.js` filemode regression on `e47ae8c3`. Replace with one of: (a) directory-glob `chmod +x "$EXTENSION_ROOT/extension/bin/"*.js *.sh`, (b) explicit manifest file `extension/bin/.chmod-manifest` listing executable-bit files. The 4 chmod 600/700 entries elsewhere (`audit_file`, `activity` dir) are intentional permission reductions and are NOT in scope — they stay as-is.

| Req | Description |
|---|---|
| **R-ICM-1** | Replace the hand-maintained `chmod +x "$EXTENSION_ROOT/extension/bin/<name>.js"` block (`install.sh` lines 401–425+) with either a directory-glob `chmod +x "$EXTENSION_ROOT/extension/bin/"*.js` OR a manifest-driven approach reading `extension/bin/.chmod-manifest`. Worker chooses based on which approach passes the deploy-lifecycle soak test cleanly; both are acceptable. |
| **R-ICM-2** | After install, every `*.js` file in `extension/bin/` AND `extension/hooks/dispatch.js` has executable bit set. Verify via `test -x` in a post-install assertion in `install.sh` itself; print `OK chmod` or fail loud. |
| **R-ICM-3** | The 4 chmod 600/700 entries (lines 90, 115, 314 in install.sh — `audit_file` × 2, `activity` dir) remain untouched and verified post-install via `stat -f '%Lp'` (macOS) / `stat -c '%a'` (Linux) returning exactly `600` / `700`. |

**Section F — Acceptance Criteria**

- **AC-ICM-01** — `bash install.sh` from a clean source tree results in every `extension/bin/*.js` file being executable. Verify in `install.sh`'s own post-install loop; deployment fails loud on any non-executable bin file.
- **AC-ICM-02** — Add a new file `extension/bin/_test-chmod-fixture.js` (test-only fixture, deletable post-test); run `bash install.sh`; assert it gets +x without touching install.sh's R-ICM-1 surface. **This is the regression-test fixture for Open Finding #4.** Cleanup: fixture is deleted by `extension/tests/integration/install-chmod-coverage.test.js` after assertion.
- **AC-ICM-03** — `tests/integration/deploy-lifecycle-soak.test.js` passes with `RUN_EXPENSIVE_TESTS=1 SOAK_SECONDS=1800`. **Required gate** — slot K cannot ship without this.
- **AC-ICM-04** — Trap-door in `extension/CLAUDE.md`: "install.sh chmod block is generated/glob'd, NOT hand-maintained. Adding a new file under `extension/bin/` requires NO install.sh edit."

**Files in scope**: `install.sh` (lines 401–425+), `extension/bin/.chmod-manifest` (NEW if manifest variant chosen), `extension/tests/integration/install-chmod-coverage.test.js` (NEW), `extension/CLAUDE.md`.

**Risk**: install.sh is the deploy artifact; a regression here breaks every subsequent deploy. The deploy-lifecycle soak test (1800s) is the safety net — it catches "deployment installs nothing" and "deployment installs but bin files aren't executable" failure modes. **Slot K cannot land without AC-ICM-03 green.**

## Section G — Slot L — Anatomy-park default scope adds repo-root /bin/ *(SEVENTH — closes Open Finding #3)*

Today's default subsystem enumeration in `pipeline-runner.ts:resolveAnatomySubsystems` (line 273) misses repo-root `/bin/` when `/anatomy-park` runs from the pickle-rick-claude repo root. The repo-root `/bin/` contains 6 release-critical scripts (`release-gate.sh`, `purge-update-cache.js`, `verify-bundle.js`, `verify-recapture-fired.js`, `section-c-still-needed.js`, plus `CLAUDE.md`). 4 are `.js` (≥3-source-file threshold met). The miss is a scope-resolution defect, not a count defect.

| Req | Description |
|---|---|
| **R-APBS-1** | When `/anatomy-park` is invoked from repo root with no explicit `--target` (or with `--target` resolving to repo root), `resolveAnatomySubsystems` enumerates `/bin/` as a subsystem if it contains ≥3 files matching the source-file extension list (`*.ts`, `*.js`, `*.py`, `*.go`, `*.rs`, `*.java`, `*.tsx`, `*.jsx`). The current source-file count for repo-root `/bin/` is 4 (`*.js`), so it MUST be enumerated. |
| **R-APBS-2** | Diagnose the exclusion: trace why `/bin/` is currently filtered out. Likely candidates: (a) hardcoded denylist in `resolveAnatomySubsystems`, (b) extension-list mismatch (e.g., `.sh` files preferred over `.js`), (c) the default TARGET resolves to `extension/`, not repo root. Document root cause in PR description. |
| **R-APBS-3** | Regression test: `extension/tests/anatomy-park-resolveSubsystems-bin.test.js` — fixture repo with `/bin/{a,b,c}.js`, `/bin/CLAUDE.md`, plus `/extension/src/` (existing pattern); assert `resolveAnatomySubsystems(<fixture-root>)` returns BOTH `bin` and `extension/src` (or whatever the existing pattern enumerates) in the subsystem list. |

**Section G — Acceptance Criteria**

- **AC-APBS-01** — `cd extension && npm test -- --grep anatomy-park-resolveSubsystems-bin` passes.
- **AC-APBS-02** — Live verification: from `pickle-rick-claude` repo root, `/anatomy-park --dry-run` (or the equivalent dry-run flag if one exists; otherwise inspect activity-event `subsystems_discovered`) reports `/bin/` in the discovered list.
- **AC-APBS-03** — Trap-door in `extension/CLAUDE.md`: "anatomy-park subsystem enumeration MUST include repo-root /bin/ when present; absence in default scope is a regression."

**Files in scope**: `extension/src/bin/pipeline-runner.ts` (`resolveAnatomySubsystems` near line 273), tests as above, `extension/CLAUDE.md`.

**Note on ordering**: This bundle's own `anatomy-park` phase will benefit from R-APBS-1's broadened scope when reviewing the bundle's diff — `/bin/` scripts modified by slot K (R-ICM) will be in scope for the post-build review.

## Bundle-level Acceptance Criteria

- **AC-BUNDLE-01** — All slot R-codes (G: R-CCPL-1..6 / H: R-SCJM-1..6 / I R-1: R-ICP-3..4 / J: R-ICP-1..2 / K: R-ICM-1..3 / L: R-APBS-1..3) reach `status: Done` with valid `completion_commit:` SHAs. **22 atomic tickets total.**
- **AC-BUNDLE-02** — Production gates clean post-bundle:
  - `cd extension && npx tsc --noEmit` exits 0
  - `npx eslint src/ --max-warnings=-1` exits 0
  - All audit scripts green: `audit-test-tiers.sh`, `audit-test-isolation.sh`, `audit-fix-commits.sh`, `audit-bundle-thesis.sh`, `audit-quarantine.sh`, `audit-trap-door-enforcement.sh`
  - `npm run test:fast` and `npm run test:integration` pass
  - `RUN_EXPENSIVE_TESTS=1 SOAK_SECONDS=1800 npm run test:expensive` passes (gates slot K)
- **AC-BUNDLE-03** — Trap-door audit count strictly increases by ≥3 (one new ENFORCE per slot G/I/J/K/L; slot H adds ≥1). Theme-A baseline was 113; bundle target ≥118.
- **AC-BUNDLE-04** — `prds/MASTER_PLAN.md` updated post-bundle to mark Open Findings #1, #3, #4 as Closed (closed-by: this bundle); Open Finding #5 remains as separate doc-only follow-up; Theme-A predecessor remains Closed.
- **AC-BUNDLE-05** — Activity event `bundle_completion_audit` records the bundle id, all 22 ticket completion commits, and a hash of the final `state.json` for the post-mortem session.
- **AC-BUNDLE-06** — `git status --short` clean at end of bundle (compiled JS in sync with TS source via final `bash install.sh` in the closer; no dirty tree).

## Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Slot G's substring-broken-token transformation in `.claude/commands/*.md` accidentally breaks the model's ability to emit the literal token (model's pattern-matching on the macro form fails) | Med | High | R-CCPL-3 + AC-CCPL-07 verify deployed templates contain the literal post-`install.sh` substitution. Manual smoke (`/pickle-tmux --backend claude` on a 3-ticket session) confirms classifier behavior. |
| R2 | Slot K install.sh edit deploys nothing (e.g., glob pattern doesn't match on macOS bash 3.2 vs Linux bash 5+) | Low | Critical | AC-ICM-03 deploy-lifecycle soak test (1800s) is a hard gate — no merge without it green. R-ICM-2 post-install assertion in install.sh itself fails loud at deploy time. |
| R3 | Slot L's `resolveAnatomySubsystems` change unintentionally double-counts `/bin/` (e.g., once as repo-root child, once as some other path) | Low | Med | R-APBS-3 fixture test asserts exactly-once enumeration. Production gate's anatomy-park dry-run on this repo (AC-APBS-02) verifies live behavior. |
| R4 | Slot I R-1 + Slot J interact: changing exit code 0→3 on cap-hit (R-ICP-1) AND changing how setup.js --resume reads max_iterations (R-ICP-3/4) creates a window where a session with cap=15 (resume-derived) hits cap-3 exit, but pipeline-runner halts as expected. The two are complementary, not conflicting, by design. | Low | Low | AC-ICP-06 end-to-end test exercises both together. |
| R5 | Bundle runs unattended; an unhandled defect in slot G/H wedges the pickle phase before slots K/L ship | Med | Med | Slots are ordered by blast radius (G→H→I→J→K→L). Each slot's tests gate the next. mux-runner's iteration cap (now correctly bounded by R-ICP-3/4 once slot D ships) stops runaway. |
| R6 | Bundle composes 6 slots; refinement-team would have caught cross-slot dependencies that `--no-refine` skips | Med | Low | Cross-slot interactions enumerated in R4 above. The 6 slots have no shared mutated files except `extension/CLAUDE.md` (each adds a trap-door entry — appended, not overwritten) and `extension/src/bin/mux-runner.ts` (slots G + J both touch it; G's classifier change is in `extractAssistantContent`, J's is in cap-exit logic — disjoint regions). |
| R7 | `git log` truncation observed in pre-launch Track 1 sweep means MASTER_PLAN's "shipped" claims for older PRDs cannot be commit-hash-verified by `git log \| grep` | Low | Low (cosmetic) | This bundle does not depend on MASTER_PLAN's historical claims. Operator follow-up: verify Track 1 PRDs by code-state grep, not commit-hash grep. Tracked outside this bundle. |

## Pre-flight checklist (before launch)

- [ ] `git status --short` clean. Working tree at `a6c9eb48` (or later, if hardening commits land between drafting and launch).
- [ ] `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` exits 0 (baseline clean).
- [ ] `bash scripts/audit-trap-door-enforcement.sh` exits 0 with 113 ENFORCE refs (baseline).
- [ ] `npm run test:fast` failure count ≤ 15 (post-hardening baseline).
- [ ] `~/.claude/pickle-rick/extension/` md5-parity OK with source (run `bash install.sh` ONCE NOW if drift, then verify).
- [ ] No live mux-runner / spawn-morty processes from any prior bundle.
- [ ] `extension/package.json` version is `1.72.2` (closer leaves it at 1.72.2 unless slot count justifies a 1.73.0 minor bump — operator decides at close).
- [ ] **Local-only mode confirmed**: pipeline DOES NOT push commits, DOES NOT `gh release create`. The closer commits to local main only.

## Closer

| Req | Description |
|---|---|
| **R-CLOSER-1** | At bundle end: `bash install.sh` runs once to sync compiled JS with TS source. Final `git status --short` MUST be clean. If dirty, halt and surface for operator review (do not auto-commit a dirty tree at close). |
| **R-CLOSER-2** | Optional minor version bump 1.72.2 → 1.73.0 IF AC-BUNDLE-01 ships ≥20 tickets AND slot K's chmod manifest counts as a deploy-surface change worth a minor-version signal. Operator decides; bundle does NOT auto-bump. **No `gh release create`** — local-only mode. |
| **R-CLOSER-3** | `prds/MASTER_PLAN.md` updated to mark Open Findings #1, #3, #4 Closed (closed-by SHA TBD-at-close); add post-mortem session id to MASTER_PLAN's session log. |

## Launch command

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
/pickle-pipeline --no-refine --backend claude prds/archive/bundles/p1-bug-fix-bundle-2026-05-07-deferred-slots.md
```

**Backend MUST be claude.** Slot G IS the codex hallucination root cause; running this bundle through codex would reproduce the very defect being fixed.

---

*Pickle Rick out. Six slots, one bundle, claude backend, no refine, unattended. Local-only — nothing leaves this machine until the operator says go. Belch.*
