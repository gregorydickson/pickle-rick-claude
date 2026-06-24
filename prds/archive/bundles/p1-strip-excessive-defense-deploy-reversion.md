---
title: P1 — Strip excessive defense-in-depth from deploy-reversion bundle before v1.68.0 tag
status: Draft
date: 2026-05-02
priority: P1
type: bug
peer_prds:
  related:
    - prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md  # the over-engineered bundle this strips
    - prds/archive/incidents/schema-version-deploy-reversion-rca.md                      # parent
---

# PRD — Strip excessive defense-in-depth from deploy-reversion bundle

## Why

The P0 bundle that just shipped (`prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md`, 30 tickets, ~1295 LOC) over-engineered the response to a procedural bug.

**The actual root cause** is a one-line shell verification: `git show <tag>:extension/package.json | jq -r .version` must equal HEAD's pkg.json before `gh release create`. v1.66.0 was tagged at SHA `41528af7` whose pkg.json says `1.64.0`; the tarball ships v1.64.0 code; auto-update re-delivers v1.64.0 forever. **`bin/release-gate.sh --pre-tag` is the fix.**

Codebase analyst Cycle 3 stated this directly:
> *"AC-DR-04a/b are defensive hardening for a hypothetical reoccurrence; AC-DR-04c is the only AC that prevents the bug from recurring."*

Cycle 3 nonetheless stacked defense at every layer because the forensic timeline showed reversions striking 30–60 min after install.sh — a class of writer outside the procedural bug. That fear drove ~600 LOC of cron sampling, drift detection, artifact invalidation, T+24h scheduled finalizers, and forward-compat schema shims. None of it is needed once the procedural bug is closed and the kill-switch jq-merge precedence (A.14) lands.

## Scope

Strip the components below **before** `gh release create v1.68.0`. The bundle ships smaller, the lockdown surface stays minimal, and follow-up defense can be re-added if real-world soak post-v1.68.0 shows reversions still happening.

## Strip — components to remove

| Component | Files | Tickets | LOC removed |
|---|---|---|---|
| Cron sampler | `bin/verify-deploy-parity.js`, install.sh cron-install/uninstall blocks, `~/.claude/pickle-rick/deploy-baseline.json` write block | A.11 (`a3038fa4`) | ~150 |
| Mux-runner pre-flight | `extension/src/bin/mux-runner.ts` SHA-256 baseline + drift halt + artifact invalidation hooks; `deploy_drift_detected` activity event | A.8 (`c56ab4a7`) | ~80 |
| Scheduled-soak finalizer | `bin/finalize-bundle.js`, `extension/tests/finalize-bundle.test.js` | scheduled-soak (`14eb3a15`) | ~180 |
| Launch-gate verifier | `bin/verify-launch.js`, `extension/tests/launch-gate.test.js` | closer artifact piece | ~60 |
| AC-DR-15 PRE-FLIGHT artifact | `bundle/ac-dr-15.json` writes anywhere, `bundle/ac-dr-pre-flight.json` references | mux-runner pre-flight | ~10 |
| 24h soak language | `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md` AC-DR-03 row → mark as deferred | docs only | n/a |

**Approx total removed**: ~480 LOC, 4 ticket-units of complexity.

## Keep — components that earn their weight

- **A.1** `bin/release-gate.sh` — the actual fix. Pre-tag + post-tag verifiers.
- **A.2** check-update.ts pre-extract version guard — defense-in-depth, ~30 LOC.
- **A.3** install.sh source-vs-deployed guard — defense-in-depth, ~25 LOC.
- **A.4** RCA followup artifact (`bundle/section-a-rca-followup.md`) — done, keep.
- **A.5** install.sh cache hygiene + `bin/purge-update-cache.js` — fixes update-check.json poisoning.
- **A.6** install.sh worktree-aware lockdown — prevents 7-worktree stale-checkout regression.
- **A.7** state-manager forward-compat validator — small (~25 LOC), harmless, prevents read-side crashes if the activity-event whitelist drifts again.
- **A.9** stop-hook spawn rate-limit — kills the 1000-spawn-per-session debug.log spam.
- **A.10** `--allow-downgrade` UX (confirm + audit + active-session refusal) — operator escape hatch.
- **A.12** v1.66.0 forensic archive (`bundle/pre-deletion-archive/`) — artifact already created, keep on disk.
- **A.13** install.sh active-session refusal — prevents clobbering live pipeline.
- **A.14** install.sh post-merge force-write `auto_update_enabled:false` — directly addresses Hypothesis A from the RCA.
- **B.1 + B.2** — gate-baseline event + verifier (anatomy-park diagnostic, separate concern).
- **C.1 + C.2** — pipeline-runner state.active claim + re-evaluation gate.
- **D.1–D.3** — readiness manifest schema + bundle PRD recognition. *We literally used `--skip-readiness` to launch this pipeline; D.3 makes that workaround unneeded.*
- **HT-1..HT-4** — the four hardening tickets already shipped real fixes. Keep their commits.

## Acceptance Criteria

| ID | Verification |
|---|---|
| AC-STRIP-01 | `bin/verify-deploy-parity.js` does not exist on disk after strip |
| AC-STRIP-02 | install.sh contains no `crontab` invocation; no cron entry installed by `bash install.sh` |
| AC-STRIP-03 | install.sh does not write `~/.claude/pickle-rick/deploy-baseline.json` |
| AC-STRIP-04 | `bin/finalize-bundle.js` does not exist |
| AC-STRIP-05 | `bin/verify-launch.js` does not exist |
| AC-STRIP-06 | `extension/src/bin/mux-runner.ts` contains no `deploy_drift_detected` event emission, no SHA-256 baseline computation, no `bundle/ac-dr-*.json` invalidation logic |
| AC-STRIP-07 | `extension/src/types/index.ts` `VALID_ACTIVITY_EVENTS` does NOT contain `'deploy_drift_detected'` (the two `baseline_recapture_*` events stay — Section B keeps them) |
| AC-STRIP-08 | `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` all green |
| AC-STRIP-09 | `bash bin/release-gate.sh --pre-tag <test-fixture-tag>` still passes |
| AC-STRIP-10 | Refined PRD (`prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md`) marks AC-DR-03 (24h soak), AC-DR-07 (1h soak), AC-DR-15 (PRE-FLIGHT) as `status: removed` with strip-PRD cross-reference |
| AC-STRIP-11 | `extension/package.json` bumped to 1.68.0 AFTER all strips and gates green |
| AC-STRIP-12 | Single commit: `chore: strip excessive defense from deploy-reversion bundle (P1 follow-up)` |

## Implementation Sequence

1. **Identify strip surface**: `git log --oneline -- bin/verify-deploy-parity.js bin/finalize-bundle.js bin/verify-launch.js` to find the tickets' commits. Don't `git revert` — surgical delete is simpler since strip touches multiple commits.
2. **Delete files**: the four script files (`verify-deploy-parity.js`, `finalize-bundle.js`, `verify-launch.js`) + their test files (`extension/tests/verify-deploy-parity.test.js`, `finalize-bundle.test.js`, `launch-gate.test.js`).
3. **Patch install.sh**: remove the cron-install block, `--uninstall-cron` flag, and `deploy-baseline.json` write block. Keep the SRC_V/DEP_V guard, worktree-aware check, active-session check, jq-merge force-write, and cache hygiene.
4. **Patch mux-runner.ts**: remove the pre-flight SHA-256 hash code, the `deploy_drift_detected` emit, the iteration-boundary drift check, and the `bundle/ac-dr-*.json` invalidation rewriter. Keep the existing pre-bundle iteration_start logic from A.7.
5. **Patch types/index.ts**: remove `'deploy_drift_detected'` from `VALID_ACTIVITY_EVENTS`. Keep `'baseline_recapture_attempted'` and `'baseline_recapture_succeeded'`.
6. **Patch package.json scripts.test**: remove the deleted test files from the long whitespace list.
7. **Mark refined PRD**: update AC-DR-03 / AC-DR-07 / AC-DR-15 rows in `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md` to `status: removed (see prds/p1-strip-excessive-defense-deploy-reversion.md)`.
8. **Run gates**: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`.
9. **Commit + push**: single commit per AC-STRIP-12.
10. **Bump version** to 1.68.0, commit `chore: bump version to 1.68.0`.
11. **Run release procedure**: `bash bin/release-gate.sh --pre-tag v1.68.0` → `gh release create v1.68.0` → `bash bin/release-gate.sh --post-tag v1.68.0` → `bash install.sh`.

## Non-Goals

- Re-running the pipeline. This is a manual surgical strip, not autonomous.
- Reverting Section B/C/D, hardening tickets, or any of the keep-list. Those are independent fixes.
- Re-running the 30-ticket bundle without the cron sampler. The bundle's done; we trim before publishing.
- Introducing a new "lite" lockdown design. If real-world soak shows residual reversions post-v1.68.0, file a follow-up PRD with empirical evidence; don't add defense pre-emptively.

## Risk

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | Removing AC-DR-15 PRE-FLIGHT means the bundle's own pipeline could run under reverted-deployed JS in a future bug class | Bundle is single-shot here; future pipelines can re-add if needed |
| R-2 | No cron sampling means we won't detect slow drift in production | Manual `node bin/verify-bundle.js` works on demand; operator can re-run pre-flight pkg.json check anytime |
| R-3 | `deploy_drift_detected` event removal might break test fixtures referencing it | AC-STRIP-08 catches this; fix any test that specifically asserts the event |

## Cross-references

- Bundle session that created the over-engineering: `~/.local/share/pickle-rick/sessions/2026-05-02-ad240987/`
- Cycle 3 codebase analyst's verdict: `${SESSION_ROOT}/refinement/analysis_codebase.md` ("AC-DR-04c is the only AC that prevents the bug from recurring")
- Procedural root-cause evidence: `git merge-base --is-ancestor a800a17 41528af7` exits 1
- v1.66.0 release: https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.66.0 (still GitHub-Latest; AC-DR-12 deletion deferred)

— Pickle Rick out. Less code, fewer cron jobs, more operator trust. *belch*
