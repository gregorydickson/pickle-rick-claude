---
title: P2 Bundle — deploy-reversion lockdown + gate-baseline runtime diagnostic
status: Draft
date: 2026-05-02
priority: P0
backend: codex-required
type: manifest
peer_prds:
  related:
    - prds/archive/incidents/schema-version-deploy-reversion-rca.md  # F7 was deferred; THIS is what makes it P0 now
    - prds/archive/bug-reports/anatomy-park-gate-baseline-missing.md  # SHIPPED v1.66.0 but invisible because of deploy-reversion
    - prds/archive/bug-reports/pipeline-runner-state-active-not-claimed-on-relaunch.md  # P3, still open
    - prds/archive/bug-reports/readiness-gate-manifest-prd-bundle-mismatch.md  # P2, still open
---

# PRD — P2 Bundle: Deploy-reversion lockdown + gate-baseline runtime diagnostic

**Promoted to P0** from P2 because the deploy-reversion meta-bug has now silently undone two consecutive releases (v1.66.0 → v1.64.0 reverted within ~minutes of `bash install.sh`), and every shipped fix that depends on deployed-source parity is invisible to the running pipeline. Until F7 lands, every release is a coin flip — install.sh deploys cleanly, then auto-updater reverts it, then the next pipeline runs against stale code, then anatomy-park hits the bug the release was supposed to fix.

## Forensic timeline (2026-05-01 → 2026-05-02)

| Time (UTC) | Event | Source | Deployed |
|---|---|---|---|
| 2026-05-01 22:35 | v1.66.0 tagged via `gh release create` | 1.66.0 | 1.66.0 (verified) |
| 2026-05-01 22:36 | `bash install.sh` deployed v1.66.0 | 1.66.0 | 1.66.0 (verified) |
| 2026-05-01 23:48 | Bundle session `325ccb80` created via setup.js | 1.66.0 | 1.66.0 |
| 2026-05-02 00:20 | First pipeline launch — readiness halt at 00:26:55 | 1.66.0 | **REVERTED to 1.64.0** by ~01:00 |
| 2026-05-02 01:26 | Pipeline relaunched, ran 144m, shipped 5 of 15 pickle tickets, false-epic exit | 1.66.0 | 1.64.0 |
| 2026-05-02 03:09 | Pipeline advanced to anatomy-park | 1.66.0 | 1.64.0 |
| 2026-05-02 03:30 | Anatomy-park exit 1 (gate-baseline missing — same bug v1.66.0 was supposed to fix) | 1.66.0 | 1.64.0 |
| 2026-05-02 11:18 | Manual `bash install.sh` re-deployed v1.66.0 | 1.66.0 | 1.66.0 (verified) |
| 2026-05-02 11:46 | Pipeline relaunched | 1.66.0 | **REVERTED to 1.64.0** before 14:11 |
| 2026-05-02 14:11 | Pickle phase ✓ shipped all 15 + 4 hardening + closer (v1.67.0 bump committed) | 1.67.0 | 1.64.0 |
| 2026-05-02 14:25 | Anatomy-park exit 1 — same gate-baseline bug, deployed v1.64.0 still has no recapture code | 1.67.0 | 1.64.0 |

**Pattern**: deployed code reverts from v1.66.0 → v1.64.0 within ~30-60 minutes of `bash install.sh`. Source ↔ deployed parity is invisible to the running pipeline because mux-runner and microverse-runner subprocesses load the deployed JS at spawn time.

## Source PRDs (authoritative)

| Section | Source PRD | Tickets | LOC | Refinement narrowing |
|---|---|---|---|---|
| **A** | `prds/archive/incidents/schema-version-deploy-reversion-rca.md` (F7 lockdown) | F7 from that PRD = ~3-5 atomic tickets | ~150 | F7 was deferred at v1.62.0 ship time; promote to mandatory |
| **B** | (NEW) gate-baseline runtime diagnostic | NEW: 2-3 atomic tickets | ~60 | After deployed v1.66.0 lands and persists, run anatomy-park and assert recapture log line fires |
| **C** | `prds/archive/bug-reports/pipeline-runner-state-active-not-claimed-on-relaunch.md` | All ACs from that PRD | ~150 | Already drafted; pull forward from P3 backlog |
| **D** | `prds/archive/bug-reports/readiness-gate-manifest-prd-bundle-mismatch.md` | All ACs from that PRD | ~430 | Already drafted; pull forward from P2 backlog |

**Bundle total**: ~12-15 atomic tickets + 4 hardening + 1 closer (v1.67.0 → v1.68.0). ~800 LOC.

## Bundle-level Acceptance Criteria

*(refined: requirements + codebase + risk Cycle 3 — supersedes original AC-DR-01..07)*

| ID | Phase | Owner | Verification artifact | Check |
|---|---|---|---|---|
| AC-DR-01 | bundle-end | post-bundle-audit | `bundle/ac-dr-01.json` | All Section A ACs from `prds/archive/incidents/schema-version-deploy-reversion-rca.md` pass (kill-switch verify) |
| AC-DR-02 | bundle-end | activity-event-assertion | `bundle/ac-dr-02.json` | Bundle's `state.json.activity[]` contains ≥1 `{event:"baseline_recapture_attempted", iteration:1}` during anatomy-park phase. (Section B.1 + B.2.) |
| AC-DR-03 | **REMOVED** (see `prds/p1-strip-excessive-defense-deploy-reversion.md`) | status: removed | n/a | 24h soak / sampler-finalize requirement stripped per AC-STRIP-10. |
| AC-DR-04a | bundle-end | check-update-pre-extract-guard | `bundle/ac-dr-04a.json` | `check-update.ts:performUpgrade()` reads candidate tarball's `extension/package.json:version` BEFORE `extractAndInstall`. Refuses if `compareSemver(candidate, current) < 0` UNLESS `options.allowDowngrade === true`. `--force` does NOT bypass; only `--allow-downgrade` does. Defense-in-depth. P1. |
| AC-DR-04b | bundle-end | install-sh-source-guard | `bundle/ac-dr-04b.json` | `install.sh` reads SRC_V + DEP_V at start; refuses unless `--allow-downgrade`; runs in BOTH `INSTALL_MODE=git` AND `tarball` (NOT gated on the existing schemaVersion git-only block at L65-84). Defense-in-depth. P1. |
| AC-DR-04c | bundle-end | release-gate-bump-then-tag | `bundle/ac-dr-04c.json` | New `bin/release-gate.sh`. `--pre-tag <tag>` verifies `git show <tag>:extension/package.json \| jq -r .version` equals HEAD bump. `--post-tag <tag>` verifies `gh release download <tag>` extracted pkg.json matches expected. Exit codes: 10 pre-tag package version mismatch; 11 jq parse failed; 12 tag or tagged package missing; 20 release download failed; 21 downloaded tarball package version mismatch; 22 GitHub release API error. **PRIORITY P0 — only AC that prevents root-cause recurrence.** |
| AC-DR-04d | bundle-start | section-a-diagnostic | `bundle/ac-dr-04d.json` | Section A diagnostic identifies which hypothesis explains the 2026-05-01 → 2026-05-02 reversion timeline given `auto_update_enabled:false` is engaged today. Three options: (A) kill-switch was off historically and got reset, (B) external writer beyond known three, (C) defect in kill-switch path. Output: `bundle/section-a-rca-followup.md` with file:line evidence. P0. |
| AC-DR-05 | per-phase | watcher-liveness-assertion | `bundle/ac-dr-05.json` | The feed-termination literal emitted by watcher binaries does NOT appear in `tmux-runner.log` OR `tmux capture-pane` output between iterations across full pipeline run. (Section C.) |
| AC-DR-06 | per-phase | readiness-manifest-gate | `bundle/ac-dr-06.json` | Section D: bundle PRD's tickets (without `source_prd` frontmatter) clear readiness without `--skip-readiness`. AC-RGM-01..07 from source PRD all pass. |
| AC-DR-07 | **REMOVED** (see `prds/p1-strip-excessive-defense-deploy-reversion.md`) | status: removed | n/a | 1h launch-gate sampler requirement stripped per AC-STRIP-10. |
| AC-DR-08 | bundle-end | downgrade-flow-test | `bundle/ac-dr-08.json` | R-A-DOWNGRADE-UX six-case test matrix passes. `--closer-context` flag bypasses active-session check while writing audit log. |
| AC-DR-09 | per-deploy | install-sh-cache-hygiene | `bundle/ac-dr-09.json` | install.sh post-rsync removes `~/.claude/pickle-rick/update-check.json` if its `current_version` doesn't match deployed pkg.json (or sentinel `"1.0.0"`). |
| AC-DR-10 | per-phase | mux-runner-heartbeat | `bundle/ac-dr-10.json` | mux-runner reads pkg.json:version + content-hashes at iter start AND end; mismatch emits `deploy_drift_detected`, halts pipeline, fails iter `deploy-drift-mid-run`. |
| AC-DR-11 | bundle-start | v166-disposition | `bundle/ac-dr-11.json` | v1.66.0 broken release: closer downloads tarball (`bundle/pre-deletion-archive/`) + records SHA-256 BEFORE any `gh release delete`. |
| AC-DR-12 | T+24h closer-late | closer-cleanup-sequencing | `bundle/ac-dr-12.json` | `gh release delete v1.66.0` ONLY after AC-DR-03's 24h soak passes. If AC-DR-03 fails, v1.66.0 stays for forensic re-creation. |
| AC-DR-13 | bundle-end | install-script-worktree-aware | `bundle/ac-dr-13.json` | install.sh detects worktree context (under `.claude/worktrees/agent-*/`); refuses if HEAD predates `origin/main` ancestor or `compareSemver(SRC_V, DEP_V) < 0`. Test fixture: worktree at v1.62.0 vs deployed v1.67.0 → refusal. |
| AC-DR-14 | bundle-end | state-schema-forward-compat | `bundle/ac-dr-14.json` | `state-manager.js` event validator: (a) on READ, log+ignore unknown events (forward-compat with reverted-deployed code), (b) on WRITE, validate against current whitelist with no array caching. Tests: v1.67.0-deployed reads state.json with `baseline_recapture_attempted` → no crash; v1.68.0 reads pre-bundle state.json → no crash. |
| AC-DR-15 | **REMOVED** (see `prds/p1-strip-excessive-defense-deploy-reversion.md`) | status: removed | n/a | PRE-FLIGHT drift-detection requirement stripped per AC-STRIP-10. |
| AC-DR-16 | bundle-end | bundle-artifact-validator | `bundle/ac-dr-16.json` | `bin/verify-bundle.js` globs `bundle/ac-dr-*.json`, validates each against R-BUNDLE-ARTIFACT-SCHEMA, computes status (0=pass, 1=fail, 2=inconclusive). |

## Sequencing (refinement-locked)

1. **Section A first (F7 lockdown)** — until install.sh is locked down, the rest of the bundle's fixes vanish into the deployed-vs-source gap.
2. **Section B (gate-baseline diagnostic)** — assert that the v1.66.0 recapture fix actually fires now that A guarantees deploy parity. If it doesn't fire even with deployed v1.66.0, gate-baseline has a deeper bug than recapture (probably H2 from the original gate-baseline PRD).
3. **Section C (state.active claim)** — independent fix; can land in parallel with A but makes monitor reliable for D's testing.
4. **Section D (readiness manifest gate)** — final piece; closes the workaround that's currently masking the bug shape.
5. **Closer**: 1.67.0 → 1.68.0, pre-tag gate, tag, post-tag gate, then install. AC-DR-07 and AC-DR-03 soak gates are removed per `prds/p1-strip-excessive-defense-deploy-reversion.md`.

## Cross-cutting risks

| ID | Risk | Mitigation |
|---|---|---|
| BR-1 | Section A's F7 lockdown breaks legitimate downgrade paths (e.g., user wants to roll back) | F7 should require `--allow-downgrade` flag for explicit rollback; default-blocks |
| BR-2 | The deploy-reversion mechanism may not be `check-update.js` alone — could be a hook or a brew/npm-style external auto-updater | Section A's diagnostic ticket must `lsof`/`ps` watch deployed file mutations during a soak window; identify ALL writers |
| BR-3 | `gh release latest` returning v1.64.0 tarball despite v1.66.0 being marked Latest is a github API edge case | Verify `gh api repos/.../releases/latest` returns the actual v1.66.0 tarball URL; confirm download integrity via `tar -tzf` |
| BR-4 | After F7 ships, install.sh still permits the auto-updater path that bypasses lockdown | Section A audit must enumerate ALL `extension/{services,bin,types,hooks}/*` write sites and either funnel them through install.sh or add lockdown guards |

## Reproducer

Pre-fix: every `bash install.sh && tail -F microverse-runner.log` leaves the AC-DR-02 activity event assertion unsatisfied after ~30-60 min, despite source containing the recapture instrumentation. Cause: deployed JS reverts to v1.64.0.

Post-fix: deployed JS persists at v1.66.0+ across 24h soak. Anatomy-park phase reaches Phase 4/4 of any `/pickle-pipeline` run.

## Operator workaround (until bundle ships)

Manually `bash install.sh` BEFORE every pipeline launch AND verify deployed version matches source via:

```bash
SRC_V=$(jq -r .version /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/package.json)
DEP_V=$(jq -r .version $HOME/.claude/pickle-rick/extension/package.json)
[ "$SRC_V" = "$DEP_V" ] || { echo "DEPLOY DRIFT: src=$SRC_V deployed=$DEP_V — re-run install.sh"; exit 1; }
```

Then launch the pipeline within ~5 min of install.sh to minimize the reversion window.

## Cross-references

- Forensic evidence: bundle session `2026-05-01-325ccb80` ran 2026-05-01 23:48 → 2026-05-02 14:25; pickle ✓ both runs (5+15 tickets, 29 commits including v1.67.0 closer); anatomy-park ✗ on both runs because deployed JS = v1.64.0
- v1.66.0 release: https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.66.0
- v1.67.0 closer: commit `2c814e8` (NOT tagged on GitHub — pending operator decision after deploy-reversion lockdown ships)
- Source PRDs (above table) — canonical detail.

— Pickle Rick out. *belch*
