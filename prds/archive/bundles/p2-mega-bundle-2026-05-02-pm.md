---
title: P2 Mega Bundle (refined Cycle 3) — strip + state-drift + retry + handoff + hermes + god-fn-2
status: Refined
date: 2026-05-02
priority: P2
backend: codex-required
type: manifest
peer_prds:
  related:
    - prds/p1-strip-excessive-defense-deploy-reversion.md
    - prds/multi-repo-task-state-drift.md
    - prds/tool-error-retry-tracking.md
    - prds/smart-iteration-handoff.md
    - prds/hermes-integration.md
    - prds/god-functions-remediation-phase-2.md
refinement_contract:
  - "AC-MEGA-A..F is a smelly enumeration; collapsed into ONE rollup ticket with describe.each([...])"
  - "Section C requires a PRECHECK ticket (C.0) verifying PostToolUseFailure hook exists; otherwise C.1/C.2 defer"
  - "Hermes test floor is hard ≥18, not soft ~20"
  - "God-fn count is 25 carve-outs, not 27"
  - "Wasted-iter target metric is replay-based: bundle adds measurement infra; actual % is post-replay"
---

# PRD — P2 Mega Bundle (refined Cycle 3)

Composes 6 source PRDs into a single autonomous codex run. Strip first (foundational), then 5 follow-on epics, then rollup, wiring, 4 hardening, closer.

## Cycle 3 lock-ins

1. **Smell collapse**: AC-MEGA-A..F was 6 ACs reducing to "every section's source PRD all green." Per AC-shape rule, decomposed into ONE parametrized rollup ticket (`da1e3992`) using `describe.each([...])` over the six sections + a `bundle/bundle_ac_ledger.json` writer/reader contract. The six AC labels survive as semantic groupings but resolve to a single test row.

2. **Section C precheck**: `tool-error-retry-tracking.md` references the `PostToolUseFailure` hook. If that event name doesn't exist in the current Claude Code harness, C.1+C.2 are dead weight. Ticket C.0 (`23a6dc03`) is a 1-day investigation that produces `bundle/c-precheck.md` with verdict {EXISTS, RENAME, MISSING}. If MISSING, Section C exits clean and rollup row C marks `all_acs_green: true, evidence: "deferred per c-precheck verdict MISSING"`.

3. **Hermes test floor**: ≥18 new tests, not "~20." Ticket E.5 (`c7732079`) computes the count via grep and fails fast if below floor.

4. **God-fn count**: Cycle 3 codebase analyst recounted — 25 carve-out markers in the current tree, not 27 as the source PRD says. Ticket F.4 (`d72bf06e`) is the closer that proves zero remain post-refactor.

5. **Wasted-iter measurement vs achievement**: source PRD's "30%/20% reduction" target is replay-based; achievable only after multiple post-bundle pipeline runs feed `bundle/wasted-iter-baseline.json`. Bundle ships measurement infra (D.6 `5c849fed`) and explicitly defers achievement to post-release replay reports.

## Composition + Implementation Task Breakdown

| Order | ID | Title | Section | Source PRD |
|---|---|---|---|---|
| 10 | 87666c73 | A.1 — Strip cron sampler | A | strip |
| 20 | 0fb35afd | A.2 — Strip mux-runner pre-flight | A | strip |
| 30 | 642d8816 | A.3 — Strip scheduled-soak | A | strip |
| 40 | 8876cec2 | A.4 — Strip launch-gate verifier | A | strip |
| 50 | 8868e2b8 | A.5 — Mark refined PRD AC-DR-03/07/15 removed | A | strip |
| 60 | b5b2e444 | B.1 — Replace auto-mark-done with completion validation | B | multi-repo |
| 70 | cb261250 | B.2 — Indicator desync sync invariant | B | multi-repo |
| 80 | 8a5093cc | B.3 — Phantom advancement guard | B | multi-repo |
| 90 | 016d4ce7 | B.4 — Frontmatter as ticket-status SoT | B | multi-repo |
| 100 | 23a6dc03 | C.0 — PRECHECK PostToolUseFailure hook exists | C | tool-error |
| 110 | 37c8648b | C.1 — last-tool-error.json + hook handler | C | tool-error |
| 120 | 32a98b2c | C.2 — Escalating guidance injection | C | tool-error |
| 130 | 2f19418d | D.1 — Stall recovery taxonomy | D | smart-handoff |
| 140 | 4d8a7bac | D.2 — Ticket sizing tier → budget | D | smart-handoff |
| 150 | 711d1be7 | D.3 — Cross-iter knowledge handoff_notes.md | D | smart-handoff |
| 160 | dcece8eb | D.4 — Quality-pass model selection | D | smart-handoff |
| 170 | 822edac0 | D.5 — Lint-gaming guard | D | smart-handoff |
| 180 | 5c849fed | D.6 — Wasted-iter event + replay-baseline | D | smart-handoff |
| 190 | 681c3e76 | E.1 — Backend type extension | E | hermes |
| 200 | b1bcaede | E.2 — hermes worker spawn parity | E | hermes |
| 210 | d8067ef6 | E.3 — hermes manager spawn parity | E | hermes |
| 220 | dc611735 | E.4 — Hermes identity in state/log/metric | E | hermes |
| 230 | c7732079 | E.5 — ≥18 hermes-specific tests | E | hermes |
| 240 | 17c12ab6 | F.1 — God-fn group 1: bin/ | F | god-fn-2 |
| 250 | 3dca73f2 | F.2 — God-fn group 2: services/ | F | god-fn-2 |
| 260 | e178f6dc | F.3 — God-fn group 3: hooks/ + types/ | F | god-fn-2 |
| 270 | d72bf06e | F.4 — God-fn closer: zero carve-outs | F | god-fn-2 |
| 280 | da1e3992 | Bundle rollup — AC-MEGA-A..F parametrized | rollup | this bundle |
| 290 | 93b632be | Wire — end-to-end mega-bundle integration | wiring | this bundle |
| 300 | b81da616 | Harden HT-1 — code quality | hardening | template |
| 310 | 9f6cc3f4 | Harden HT-2 — data flow | hardening | template |
| 320 | 3b146e48 | Harden HT-3 — test quality | hardening | template |
| 330 | e50e4ea9 | Harden HT-4 — cross-reference | hardening | template |
| 340 | 71a47673 | Closer — v1.69.0 release | closer | this bundle |

**Total**: 34 atomic + parent = 35 ticket files. v1.69.0 (skips 1.68.0 + 1.67.0 — strip absorbs both intentionally).

## Bundle Acceptance Criteria

| ID | Verifier |
|---|---|
| AC-MEGA-A..F (rollup) | `tests/integration/mega-bundle-rollup.test.js` describe.each over 6 sections |
| AC-MEGA-INTEGRATE | `tests/integration/mega-bundle-e2e.test.js` end-to-end |
| AC-MEGA-CLOSER | v1.69.0 published + installed |

## Pre-flight (operator)

```bash
SRC_V=$(jq -r .version /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/package.json)
DEP_V=$(jq -r .version $HOME/.claude/pickle-rick/extension/package.json)
[ "$SRC_V" = "$DEP_V" ] || bash install.sh
```

A 1-hour cron babysit is recommended for long pipelines.

## Cross-references

- Bundle session: `~/.local/share/pickle-rick/sessions/2026-05-02-fca7952b/`
- Cycle 3 analyses: `${SESSION_ROOT}/refinement/analysis_{requirements,codebase,risk-scope}.md`
- Predecessor (P0 deploy-reversion bundle): `~/.local/share/pickle-rick/sessions/2026-05-02-ad240987/`

— Pickle Rick out. *belch*
