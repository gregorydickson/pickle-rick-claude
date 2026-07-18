---
title: "B-CGHARD — Codegraph: fix the input harvester + reconcile the broken soak enable-path (v2.1) [REFINED — SCOPE COLLAPSED]"
priority: P2
finding: CG-HARD
status: ready
type: bug-feature-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "2026-07-17 refined by the 3×3 analyst team (session 2026-07-17-d933dddb); scope collapsed after all three analysts + operator verification found WS-CGH-A/B already shipped"
---

# B-CGHARD *(refined — scope collapsed to the genuine open work)*

## 0. Scope collapse — verified at HEAD `9b181e58` (operator-confirmed 2026-07-17)

Most of the original bundle is **already shipped** (prior session, 2026-07-16). Verified by grep:
- **WS-CGH-A** (query hang): `runSyncQuery` 0 hits, `codegraph-query-runner.ts` exists, degrade-wiring live (`spawn-morty.ts:2659` `{ emit: cgEmit }`) — commit `172b57f5`.
- **getImpactRadius subtraction**: 0 hits in `codegraph-service.ts` — commit `904a7aed`.
- **WS-CGH-B** (verify-before-inject): `query_timeout`/`query_failed`/`stale_refs`/`dropped_stale` all in `types/index.ts:1158-1184` — commit `d244b7b0`.
- **Hardening audits**: commit `f541bd66`.

Their deletion/enum regression owner is `codegraph-context-events-schema-conformance.test.js` (live pins), NOT a retained open ticket — building them again would spawn no-diff workers on already-true exit conditions and phantom-Done the bundle. **They are dropped.**

**Two genuinely-open items remain:**
1. **WS-CGH-D** — the input harvester (`deriveCodegraphTerms` still naive `matchAll → push → slice(0,8)`).
2. **Enable-path reconciliation** — B-SSAT's `install.sh:529` MANAGED_KEYS force-resets `codegraph.enabled → false` on every deploy, so all three enable docs (PRD §2, `CLAUDE.md` CUJ #2, README `:527`) are now wrong, and the README's "survives redeploys" claim is FALSE.

## 1. WS-CGH-D — fix the input terms (Ticket `e7a9ce71`, medium)

**Mechanism (verified):** `deriveCodegraphTerms` (`spawn-morty.ts:584-602`) harvests every backticked span from title+body in DOCUMENT ORDER (`matchAll(/\`([^\`\n]+)\`/g)` → `push(m[1])`, zero filtering, `:594-595`), appends title words ≥4 chars (with `CODEGRAPH_TERM_STOPWORDS` applied ONLY here, `:598`), then `.slice(0, 8)`. The first 8 backticks win — in a well-cited ticket those are file paths and `file.ts:NNNN` line-refs, so the better the citation discipline, the worse the payload.

**Fix (the mechanism the analysts corrected — reuse is only HALF the job):**
- **New lexical filter layer over the backtick spans, BEFORE resolution:** drop bare line-refs (`^:?~?\d+(-\d+)?\+?$`), language keywords (extend `CODEGRAPH_TERM_STOPWORDS` at `:568` with `return`/`break`/`while`/`for`/`if`/… and apply it to the backtick loop, not just title words), and >40-char spans (prose). Strip call-expression noise (`applyAutoTicketCompletionValidation({...});` → the bare symbol).
- **Rank-before-slice (the actual root):** prefer identifier-shaped tokens; `slice(0,8)` over document order IS the bug. `deriveCodegraphTerms` already dedupes via a `seen` Set — do not re-add dedup; the fix is ranking.
- **REUSE `resolveSymbolRef` (`check-readiness.ts:435`) for the identifier-present half ONLY.** It is NOT a keyword filter — `resolveSymbolRef('return') === true` (verified `:439-449`: `\breturn\b` word-matches ~every tracked file → `candidates.length>1` → resolves; the `length===0` branch falls through to `resolveExternalSymbolRef` against dep `.d.ts`, even more permissive). Run resolution behind ONE shared `ResolverCache` for the whole spawn + a `query_timeout_ms`-class wall bound — never O(terms × repo-files) unbounded on the spawn hot path (that would re-open the hang class WS-CGH-A closed).
- **D2 emission skip:** when the derived terms are all noise/unresolved, do NOT emit the 8KB `## Code Graph Context` section — skip it (or emit an honest skip reason) rather than burning worker context on junk.

**⚠ Simplification Review correction:** the original §3 "(2) Reuse … no new machinery" is FALSE for WS-CGH-D — the backtick lexical layer is unavoidable new code; reuse covers only the identifier-present half. Recorded honestly.

**Fixtures (committed, not ephemeral):** inline the four R-MWMO ticket bodies (`de25ce90`, `be604d1d`, `a5f8cf4f`, `a3812edd`) verbatim under `extension/tests/fixtures/codegraph-terms/`. They are adversarial by construction (citation-dense). Session-dir paths cannot be referenced from `node --test`.

### Acceptance criteria (outcome-based, [[feedback_verify_the_outcome_not_the_mechanism]])
- **AC-CGH-D1**: for EVERY committed fixture, `deriveCodegraphTerms(title, body)` yields **≥ ⌈0.5 × min(derived_count, CODEGRAPH_MAX_TERMS)⌉** terms that resolve to a real symbol, and **zero** bare line-refs, language keywords, or >40-char spans. Pin `be604d1d` (today: 0 resolving symbols) as the regression case — **it MUST fail before the fix and pass after** (assert both directions or document the pre-fix baseline). — Verify: `cd extension && npm run test:fast -- tests/codegraph-terms-*.test.js` — Type: test
- **AC-CGH-D2**: a ticket whose derived terms are all noise yields **no emitted `## Code Graph Context` section** (or an honest skip reason), not 8KB. — Verify: same test asserts empty/skip on an all-noise fixture — Type: test
- **AC-CGH-D3** *(soak-artifact semantics; NOT a schema change here)*: the soak baseline records **distinct resolved symbols**, NOT `hits_count` (`return` occurs 859× → huge hits, zero information). Documented in the Ticket `f85853fc` soak-protocol note; no new payload field in this bundle.
- **AC-CGH-D4** (no latency regression): resolution runs behind a shared `ResolverCache` + wall bound; a fixture with many terms completes within the bound. — Verify: test asserts a single cache instance / bounded call count — Type: test

## 2. Enable-path reconciliation (Ticket `f85853fc`, small, doc-only)

**The bug (introduced by B-SSAT, uncommitted-to-deployed yet):** `install.sh:529` MANAGED_KEYS runs `jq '… | .codegraph.enabled = false | .codegraph.index_at_setup = false …'` unconditionally on every deploy (logs `MANAGED_KEYS forced codegraph.enabled: … -> false`). So:
- **PRD §2 / CLAUDE.md CUJ #2** ("flip **source** + `bash install.sh`") **cannot enable** codegraph — MANAGED_KEYS forces literal false regardless of source.
- **README `:527`** ("edit deployed … the flip **survives redeploys**") is **FALSE** — any mid-soak `install.sh` silently disables it.

**Fix (doc-only — do NOT make install.sh source-driven; committing `enabled:true` to source breaks the opt-in default).** Reconcile all three docs to `install.sh` ground truth, one truth:
> **Enable for the soak:** with no active pipeline session, edit the **DEPLOYED** `~/.claude/pickle-rick/pickle_settings.json` (`codegraph.enabled: true`, `index_at_setup: true`) via tmp-write + `mv`, and **do NOT run `bash install.sh` again until the soak completes** — MANAGED_KEYS (`install.sh:529`) force-resets both keys to `false` on every deploy, so a source flip never enables and any mid-soak redeploy silently disables the feature. **Discard and restart any rep that straddled a redeploy.** Do NOT commit `enabled: true` to source (breaks the opt-in default). The soak measures **distinct resolved symbols**, not `hits_count`.

Delete the README's "survives redeploys" sentence and its stale "deployed-values-win merge" reasoning (the durability-killer is MANAGED_KEYS, not the merge — see [[project_install_sh_merge_makes_settings_fixes_inert]]).

### Acceptance criteria
- **AC-CGH-E1**: README `### Soak protocol` no longer claims "survives redeploys" and states the MANAGED_KEYS reset — Verify: `grep -q "survives redeploys" README.md` exits **non-zero** AND `grep -q "MANAGED_KEYS" README.md` exits 0 — Type: test
- **AC-CGH-E2**: PRD §2 + `CLAUDE.md` CUJ #2 + README all describe the deployed-edit path (no "flip source + install.sh enables") — Verify: `grep -q "flip source" ...` absent; the deployed-edit phrase present in all three — Type: llm-conformance

## 3. Simplification Review

1. **Necessary?** WS-CGH-D is necessary (the harvester feeds junk; the engine's proven capability is gated on it). The doc-fix is pure reconcile (subtractive — deletes a false claim).
2. **REUSE not ADD?** WS-CGH-D reuses `resolveSymbolRef` for the identifier-half; the lexical filter is unavoidable new code (analyst-corrected — the "no new machinery" claim was false). Doc-fix reuses the existing README section.
3. **Guards brittle complexity to SUBTRACT?** The doc-fix subtracts a false durability claim. WS-CGH-D subtracts noise from worker context (8KB of `return`/line-refs → fewer, real symbols) and adds a D2 skip that removes junk emission entirely.
4. **SUBTRACTS:** junk context bytes (D2 skip); a false doc claim. **NOT built:** the already-shipped A/B/subtraction/audits (dropped); a source-driven install.sh (rejected — breaks opt-in); a new `resolved_symbols` schema field (deferred to soak artifact).

## 4. Build notes
- **Green tree** on the launch commit required.
- **Launch env** exports `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=600000` (B-SSAT not deployed yet).
- **Pipeline-safe** — `deriveCodegraphTerms`/context-injection are NOT the salvage/completion path.
- Hardening tickets omitted (2-file surgical bundle; the pipeline's citadel/anatomy/szechuan phases harden).

## Implementation Task Breakdown
| Order | ID | Title | Tier | Files |
|---|---|---|---|---|
| 10 | e7a9ce71 | WS-CGH-D: fix input harvester (lexical filter + rank + reuse resolver, D2 skip, committed fixtures) | medium | `extension/src/bin/spawn-morty.ts`, `extension/tests/fixtures/codegraph-terms/*`, `extension/tests/codegraph-terms-*.test.js` |
| 20 | f85853fc | Reconcile the soak enable-path docs to install.sh MANAGED_KEYS truth | small | `README.md`, `CLAUDE.md`, `prds/p2-codegraph-harden-then-soak-v2.1.md` |
