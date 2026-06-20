---
title: P1 Bug Bundle — anatomy-park crash, szechuan judge model, pipeline-state-desync tail (refined cycle 3)
status: Shipped
date: 2026-05-01
priority: P1
shipped: v1.67.0 (20/20 sections, closer commit 2c814e8)
backend: codex-required
type: manifest
peer_prds:
  subsumed: []
  deferred:
    - prds/archive/bug-reports/anatomy-park-runner-undefined-description-crash.md
    - prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md
    - prds/archive/bug-reports/pipeline-state-desync-and-pane-respawn-tmpdir.md
  unrelated: []
  partially_obsolete:
    - prds/archive/bug-reports/anatomy-park-finalizer-history-crash.md  # F1 already shipped in c36af94 — see note in §Cross-references
---

# PRD — P1 Bug Bundle (refined: requirements/codebase/risk-scope, cycle 3)

> **Refinement note (2026-05-01)**: 3 analysts × 3 cycles. Critical findings folded inline. Source PRDs stay canonical for atomic ticket detail; this manifest carries bundle-level orchestration plus the cycle-3 ACs that bind the source PRDs together.

Manifest PRD composing three open P1s into a single `/pickle-pipeline --backend codex` run.

## Source PRDs (authoritative)

| Section | Source PRD | Tickets | Estimated LOC | Refinement narrowing |
|---|---|---|---|---|
| **A** | `prds/archive/bug-reports/anatomy-park-runner-undefined-description-crash.md` | AC-APRC-01..05 (mandatory) | ~150-250 | AC-APRC-02 reframed — proper fix is a runtime-validating loader (`assertMicroverseStateShape`) called from `readMicroverseState`, not optional-chaining sprawl. See §Refinement Narrowing |
| **B** | `prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md` | AC-SCJM-01..05 (mandatory) | ~30-50 (was 200-300) | AC-SCJM-02 narrowed to ONE-LINE fix at `init-microverse.ts:13`. Codebase Analyst verified. Do NOT touch `microverse-runner.ts:975-976` routing |
| **C** | `prds/archive/bug-reports/pipeline-state-desync-and-pane-respawn-tmpdir.md` (tail) | PSD-T6..T10 | ~250 (T6 split T6a + T6b per AC-BB-20) | PSD-T6 actually touches 39 test files. Split per AC-BB-20. PSD-T10 IS the bundle closer with version literal overridden to v1.67.0 |

**Bundle total**: 15 implementation tickets + 4 hardening tickets + 1 parent. ~600-800 LOC.

## Refinement Narrowing (cycle 3 critical findings)

### B's true root cause: one literal, not a sweeping refactor

**Verified by Codebase Analyst at HEAD**:
- `extension/src/bin/init-microverse.ts:13` — `judge_model: 'claude-sonnet-4-6'` in `DEFAULT_METRIC` literal.
- `extension/src/bin/init-microverse.ts:75-77` — `else { metric = DEFAULT_METRIC; }` fires when `--metric-json` not passed.
- `extension/src/bin/pipeline-runner.ts:951-962` (`setupSzechuanSauce`) — does NOT pass `--metric-json`. So szechuan ALWAYS uses `DEFAULT_METRIC` and ALWAYS stamps `judge_model: 'claude-sonnet-4-6'` into `microverse.json`.
- `extension/src/bin/microverse-runner.ts:975-976` — `const usingClaudeDefault = backend === 'claude'; const model = judgeModel || (usingClaudeDefault ? DEFAULT_JUDGE_MODEL : undefined);` — `judgeModel` is truthy, so `model = 'claude-sonnet-4-6'` regardless of backend.
- `extension/src/services/backend-spawn.ts:222` — `if (opts.model) args.push('-m', opts.model);` — codex receives `-m claude-sonnet-4-6` which the codex CLI rejects on ChatGPT-account auth.

**Minimum-correct fix**: delete one line at `init-microverse.ts:13`. When the field is absent, `state.key_metric.judge_model` is undefined → `microverse-runner.ts:976`'s ternary kicks in → on codex backend `model === undefined` → `buildCodexJudgeInvocation` skips `-m` (line 222 guard). On claude backend `DEFAULT_JUDGE_MODEL` is used as before. Zero behavior change on claude; codex routing unblocks.

**`microverse-runner.ts:864` `DEFAULT_JUDGE_MODEL` is still load-bearing** on the claude backend after the fix. Section B implementer MUST NOT delete it.

### A's true root cause class: type-vs-runtime mismatch

`MicroverseSessionState.key_metric` is non-optional in the type but optional in practice (anatomy-park sessions don't write it). Optional-chaining sprawl (`mvState.key_metric?.description`) patches sites one at a time; the proper fix is a runtime-validating loader (`assertMicroverseStateShape`) in `readMicroverseState`.

### C's true scope: PSD-T6 touches 39 test files

PSD-T6 cannot be a single commit. Per AC-BB-20, it splits into:
- T6a: env-var removal from `package.json` + per-test inline opt-in for the ~3 tests that genuinely need a tmpdir override (Codebase Analyst verified)
- T6b: source-code consumer rename if the env var name changes (~4 source files per Codebase Analyst)

Each commit ≤150 LOC.

## Acceptance Gates (cycle 3 final, AC-BB-01..20)

| ID | Phase | Owner | Verification artifact | Check |
|---|---|---|---|---|
| AC-BB-01 | bundle-end | post-bundle-audit | `bundle/ac-bb-01.json` | All Section A mandatory ACs (AC-APRC-01..05) pass per source PRD |
| AC-BB-02 | bundle-end | post-bundle-audit | `bundle/ac-bb-02.json` | All Section B mandatory ACs (AC-SCJM-01..05) pass per source PRD |
| AC-BB-03 | bundle-end | post-bundle-audit | `bundle/ac-bb-03.json` | All Section C tickets PSD-T6..T10 shipped; `npm test` no longer requires `PICKLE_TEST_ALLOW_MISSING_EXTENSION_SENTINEL=1` (PSD-T6 closes that workaround) |
| AC-BB-04 | per-phase | pipeline-runner-instrumentation | `bundle/ac-bb-04.json` | Anatomy-park phase of THIS pipeline run reaches Phase 4/4 szechuan-sauce — bundle's anatomy-park run validates A's fix on its own diff |
| AC-BB-05 | per-phase | pipeline-runner-instrumentation | `bundle/ac-bb-05.json` | Szechuan-sauce phase produces non-empty `convergence.history` with at least one judge-scored iteration; codex argv contains NO `-m` pair (mechanical assertion via spawn-spy) |
| AC-BB-06 | bundle-end | closer-commit-gate | `bundle/ac-bb-06.json` | Single closer commit bumps 1.66.0 → 1.67.0; release gate (`tsc --noEmit && eslint && tsc && npm test`) passes; gated on `cat bundle/ac-bb-*.json \| jq 'all(.status == "pass")'` |
| AC-BB-07 | bundle-end | post-bundle-audit | `bundle/ac-bb-07.json` | Trap-door catalog gains new INVARIANTs (PSD-T9, AC-APRC-05, AC-SCJM-05) without exceeding 1500-char limit; `tests/state-field-invariants.test.js` passes |
| AC-BB-15 | per-ticket precondition | refinement-validator | `bundle/ac-bb-15.json` | AC-SCJM-02 lands as one-line removal of `judge_model: 'claude-sonnet-4-6'` from `DEFAULT_METRIC` plus integration test asserting codex argv contains no `-m` pair. MUST NOT touch `microverse-runner.ts:962-1011` unless AC-SCJM-01 writeup explicitly justifies |
| AC-BB-16 | bundle-end | closer-commit-gate | `bundle/ac-bb-NN.json` aggregate | Every bundle-level AC declares OWNER + verification artifact; closer commit gated on `jq 'all(.status == "pass")'` returning true |
| AC-BB-17 | per-ticket precondition | refinement-validator | `bundle/ac-bb-17.json` | Reproducer fixtures for AC-APRC-01 + AC-SCJM-04 checked in BEFORE PSD-T6 first commit |
| AC-BB-18 | refinement-end | refinement-validator | `bundle/ac-bb-18.json` | `peer_prds` frontmatter present (this PRD) |
| AC-BB-19 | bundle-start | operator-preflight | `bundle/ac-bb-19.json` | CUJ-0 pre-flight: `codex --version` ≥ `engines.codex` from `package.json` |
| AC-BB-20 | per-ticket | ci-gate | `bundle/ac-bb-20.json` | PSD-T6 lands as ≥2 commits (T6a + T6b), each ≤150 LOC |

## CUJs

### CUJ-0 — Operator pre-flight (before launching the bundle pipeline)

```bash
# Codex version check
node -e "console.log(require('./extension/package.json').engines.codex)"  # → ^0.128.0
codex --version  # → must satisfy ^0.128.0

# Working tree clean
git status --short  # MUST be empty

# Branch on main, ahead of origin
git rev-parse --abbrev-ref HEAD  # → main
git log @{u}..HEAD --oneline | wc -l  # commits-ahead count visible

# v1.66.0 deployed
grep '"version"' ~/.claude/pickle-rick/extension/package.json | head -1  # → 1.66.0

# No stale active sessions for this cwd
jq -s 'map(select(.working_dir == env.PWD and .active == true))' ~/.local/share/pickle-rick/sessions/*/state.json
# → empty array

# Time budget: <5 min
```

### CUJ-1 — Happy path (bundle ships v1.67.0)

`/pickle-pipeline prds/archive/bundles/p1-bug-bundle-2026-05-01-pm.md --backend codex` → 4 phases (pickle, citadel, anatomy-park, szechuan-sauce) → all pass → v1.67.0 tagged.

### CUJ-2 — Phase-3 anatomy-park crash on bundle's own diff

If A's fix has a regression, anatomy-park crashes at iter ≥2. Bundle exits failed at Phase 3/4. Operator path: re-run `/pickle-pipeline ... --skip-anatomy` to ship A's fix without anatomy-park self-test, then verify anatomy-park works on a follow-up run.

### CUJ-3 — Operator resumes after AC-BB-08 pre-phase abort

If pipeline-runner aborts at szechuan-sauce phase entry because Section B is incomplete:
1. Read session state to identify unmerged Section B tickets.
2. Path (a) `--resume-from-phase szechuan-sauce` — UNSUPPORTED at HEAD. Use path (b).
3. Path (b): roll back Section A via `git revert <A-first>..<A-last>`, file follow-up PRD, do NOT bump version (closer commit was held).

## Sequencing (refinement-locked)

1. **Section C first (PSD-T6a, T6b, T7, T8, T9, T10)** — closes v1.66.0 npm-test workaround before A/B add new test fixtures. PSD-T10 IS the bundle closer (version overridden to v1.67.0).
2. **Section A (AC-APRC-01..05)** — guards `mvState.key_metric.description` access via runtime-validating loader.
3. **Section B (AC-SCJM-01..05)** — one-line fix at `init-microverse.ts:13`; integration test locks codex argv has no `-m` pair.

**Mutex edges** (per AC-BB-12): tickets touching `init-microverse.ts:6-32` (Section B) and tickets touching `init-microverse.ts:30-80` (Section A reframe) MUST NOT be assigned to parallel workers — refinement_manifest enforces `mutex_with` field.

## Cross-references

- Source PRDs (above table) — canonical detail.
- v1.66.0 release notes: https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.66.0
- Citadel + Hardening Bundle precedent: `prds/citadel-hardening-bundle.md` (Apr 29).
- **Sibling PRD `prds/archive/bug-reports/anatomy-park-finalizer-history-crash.md` (2026-04-30)** — its F1 (defensive `convergence?.history`) ALREADY SHIPPED in `c36af94` (verify `microverse-runner.ts:1180` at run start). The remaining open question (option (a) stub-`convergence` vs option (b) discriminated union) is OUT OF SCOPE for this bundle.

## Implementation Task Breakdown

See `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md` per ticket. Order: 10..200.

| Order | ID | Title | Section | Priority |
|---|---|---|---|---|
| 10 | PSD-T6a | Remove EXTENSION_DIR env-var workaround from npm test, add per-test opt-in | C | High |
| 20 | PSD-T6b | Rename PICKLE_TEST_ALLOW_MISSING_EXTENSION_SENTINEL → EXTENSION_DIR_TEST | C | High |
| 30 | PSD-T7 | ESLint rule: no bare process.env.EXTENSION_DIR outside getExtensionRoot() | C | High |
| 40 | PSD-T8 | Integration test: pipeline-state-coherence.test.js | C | High |
| 50 | PSD-T9 | Trap-door catalog: 3 new INVARIANTs (state-iteration, phase-step, getExtensionRoot) | C | Medium |
| 60 | APRC-T1 | Reproduce anatomy-park `mvState.key_metric.description` crash in isolation | A | High |
| 70 | APRC-T2 | Add `assertMicroverseStateShape` runtime validator to `readMicroverseState` | A | High |
| 80 | APRC-T3 | Defensive guards on iteration history accesses (lines 902, 1084, 1523) | A | Medium |
| 90 | APRC-T4 | Integration test: anatomy-park-microverse-runner-no-key-metric.test.js | A | High |
| 100 | APRC-T5 | Trap-door entry: mvState shape validator INVARIANT in extension/CLAUDE.md | A | Medium |
| 110 | SCJM-T1 | Detect & isolate the judge model selection — writeup of call site | B | High |
| 120 | SCJM-T2 | Remove `judge_model: 'claude-sonnet-4-6'` from `init-microverse.ts:13` DEFAULT_METRIC | B | High |
| 130 | SCJM-T3 | Convergence guard: assert non-empty `convergence.history` before declaring convergence; emit `judge_unreachable` exit | B | High |
| 140 | SCJM-T4 | Integration test: microverse-runner-judge-failure.test.js asserts codex argv has no `-m` pair | B | High |
| 150 | SCJM-T5 | Trap-door entry: judge model selection INVARIANT in extension/CLAUDE.md | B | Medium |
| 160 | H1 | Harden: code quality review of bundle diff | All | High |
| 170 | H2 | Audit: data flow integrity for bundle diff | All | High |
| 180 | H3 | Harden: test quality review of bundle diff | All | High |
| 190 | H4 | Audit: cross-reference consistency for bundle diff | All | High |
| 200 | T10/Closer | Bundle closer: bump 1.66.0 → 1.67.0, run release gate, tag v1.67.0 | All | High |

— Pickle Rick out. *belch*
