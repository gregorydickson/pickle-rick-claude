# Findings from the v2.0.0-beta.1 release gate (mostly FIXED in-flight; review-hammer blind spots + serialization remain)

**Filed**: 2026-06-12 (babysitter release takeover, session 2026-06-10-f50e5c11)
**Status**: Mixed — CI fixes SHIPPED; review-process + serialization items OPEN

## Shipped during the release takeover (no further action)
- **parseVersion stale test** (`check-update.test.js`) asserted pre-R2 "rejects prerelease" behavior; R2 inverted it. Synced (`c8d893ad`).
- **Gate-wiring canonical drift**: C10 added `audit-guarded-reset.sh` to CLAUDE.md/ci.yml/release.yml but not the canonical `FULL_CMD` in `check-wired.sh` + `release-gate-wiring.test.js`. Synced (`c57a8e08`).
- **CI shallow-checkout**: ci.yml/release.yml used `actions/checkout@v4` with no `fetch-depth`, so `audit-fix-commits.sh`'s `git merge-base HEAD origin/main` failed exit 128 on CI (pre-existing; ALL prior releases likely red). Fixed with `fetch-depth: 0` (`c77f9950`).
- **CI test:fast c=8 oversubscription**: hardcoded `--test-concurrency=8` oversubscribed the 2-core CI runner → ~48 broad timeout-shaped flakes (all green locally at c≤4). Clamped concurrency to `availableParallelism()` in `test-runner.ts` (R-TCC-1, `3a3619d5`).

## OPEN — review-hammer cross-file blind spot (P2)
The bundle's own review hammers (d49c7596 test-quality, b0111894 cross-ref) reviewed only the bundle's NEW/changed files. They missed:
- the pre-existing `check-update.test.js` assertion that R2's behavior change invalidated (cross-file test drift);
- the `check-wired.sh` / `release-gate-wiring.test.js` canonical that C10's gate-chain edit invalidated.
**Fix**: extend the test-quality + cross-ref review scopes to include any pre-existing file that asserts/encodes behavior the bundle changed (grep for the changed symbols/commands across ALL tests + canonical-config files, not just the diff). AC: a fixture where a bundle changes behavior X and a pre-existing test pins old-X is flagged by the review hammer.

## OPEN — codegraph serve handshake serialization (P3)
`codegraph-real-index.test.js` C0/C7 `serve --mcp` handshake (60s timeout) flakes under expensive-tier concurrency (110ms isolated). Add it to a serial manifest or run the expensive tier at low concurrency. (The R-TCC-1 clamp helps but the handshake is heavier than typical.)

## OPEN — b0111894-escalated install.sh gap (P3)
`install.sh` lacks the `INSTALL_BYPASS_ACTIVE_SESSION` audit-write that README documents. Additive audit event, no data loss, not beta-blocking. Needs a follow-up ticket.

## CORRECTION (2026-06-12) — CI test:fast red is documented fast-suite flakiness, NOT the bundle

The `fetch-depth` + concurrency-clamp fixes got CI past the audits, but the release.yml run at the fully-fixed commit `3a3619d5` STILL fails test:fast with **exactly 48 failures** (same count at c=8 and c≤4 — not random flake variance). Every one of the 48 **passes locally** (full `test:fast` = 6037/6040 at c=2; verify-recapture's file 32/32; codegraph-service 16/16). They are CI-environment-specific (slower/UTC GitHub runner → subprocess-heavy + timing-sensitive tests time out).

This is the **documented R-TSPF / R-TFP fast-suite-on-CI flake class**. The repo already encodes that single-pass `test:fast` is unreliable on CI: `stability-gate.yml` runs it 30× and `check-flake-budget.ts` tolerates a failure budget. The `release.yml` gate runs `npm run test:fast` ONCE, so it is structurally fragile against the very flakiness the repo otherwise accommodates.

**This is NOT a release blocker for the artifact** — v2.0.0-beta.1 is verified green locally across all tiers and the tarball asset is attached. It IS a real gate-design gap.

**Fix (OPEN, P2): wire the release gate's test:fast to the flake-tolerant mechanism.** Replace the single-pass `npm run test:fast` in the canonical `FULL_CMD` (CLAUDE.md/ci.yml/release.yml/check-wired.sh/release-gate-wiring.test.js) with either `check-flake-budget` (rerun-with-budget) or a serial-manifest pass, so CI green reflects real failures, not runner-load flakes. AC: release.yml goes green on a clean bundle; an actually-broken test still reds it.
