---
title: "B-SSAT — Settings source-authoritative + de-flake the worker test gate (v2.1) [REFINED]"
priority: P1
finding: "B.5b / worker_test_gate_timeout_ms (R-WTFT inert)"
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "2026-07-17 MASTER_PLAN re-sequence; refined by the 3×3 analyst team (session 2026-07-17-fa82461f)"
---

# B-SSAT — Settings source-authoritative + de-flake the worker test gate *(refined)*

## 0. Thesis

The **deployed** `pickle_settings.json` silently overrides committed **source** values forever, because
`install.sh:510`'s `jq -s '.[0] * .[1]'` merge lets the deployed (right) operand win. That has (a) made the
worker `test:fast` gate false-fail every `medium`+ ticket (R-WTFT shipped inert), and (b) left codegraph
running an unlabeled deployed-only arm. Fix by making a small, enumerated set of **code-managed** keys
source-authoritative in `install.sh`, remove the stale timeout pin, and reconcile the invariant doc.

## 1. Background — verified at the shell across 3 refinement cycles

- **1a. The merge lets deployed win.** `install.sh:510` `jq -s '.[0] * .[1]' "$SCRIPT_DIR/…" "$EXTENSION_ROOT/…"` — deployed (`.[1]`) wins scalar conflicts, and a key absent from source **cannot be unset** by the merge. Precedent for the fix already in-tree: `install.sh:515-517` force-overrides `auto_update_enabled=false` on the deployed file *after* the merge (post-`fi`, unconditional).
- **1b. R-WTFT shipped inert.** `0173662d` raised `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS` 240_000 → 600_000, but `pickle_settings.json:36` is still `240000` (both source AND deployed carry `240000` — **the bug is the source pin out-ranking the constant in the resolver, NOT source/deployed divergence**; only codegraph diverges). The resolver `resolveWorkerTestGateTimeoutMs` (`services/pickle-utils.ts:883-902`) is env → settings → default(600_000).
- **1c. The floor is env-only.** `resolveWorkerTestGateTimeoutMs` applies `Math.max(parsed, 60_000)` on the **env** branch only (`:894`); the **settings** branch returns the raw value un-clamped (`:898-900`). So a "sub-floor settings pin" cannot be guarded by a floor — the only durable fix is to remove the pin.
- **1d. Codegraph runs an unlabeled arm.** Source `codegraph.enabled:false`/`index_at_setup:false`; deployed **`true`/`true`** (live-verified) — divergence caused solely by 1a. Making these source-authoritative turns the field OFF (source's value); B-CGHARD's soak then turns it ON deliberately via source-edit + `install.sh` (there is no `PICKLE_CODEGRAPH=on`). **Measurement prerequisite for B-CGHARD.**

## 2. MANAGED_KEYS — the mechanism (WS-1)

**Membership predicate (bounds the mechanism, not just today's list):** a key is *managed* iff it has an
authoritative **code default AND operator tuning is not supported**. Every timeout/tunable
(`staleness_max_age_minutes`, `context_max_bytes`, `max_park_minutes`, the codegraph `*_timeout_ms`
fields, the whole `hardening`/`rate_limit` blocks) is operator-tunable and **NEVER** managed.

**Managed set today (closed, 3 entries):**
| Key | Op | Rationale |
|---|---|---|
| `worker_test_gate_timeout_ms` | `del` (unset) | code-owned (default 600_000); a merge cannot unset a stale deployed pin |
| `codegraph.enabled` | → source `false` | field arm must be labeled/source-chosen |
| `codegraph.index_at_setup` | → source `false` | same |

**Mechanics (per-jq-path, NEVER whole-object — a `.codegraph = {…}` replace destroys 6 operator-tunable sub-keys):**
```bash
# Place AFTER the if/else/fi (co-located with the auto_update_enabled override at install.sh:515-517),
# so it runs on BOTH the merge path and the fresh-cp path. Reuse the mktemp+mv idiom for atomicity.
TMPFILE="$(mktemp)"
jq 'del(.worker_test_gate_timeout_ms) | .codegraph.enabled = false | .codegraph.index_at_setup = false' \
  "$EXTENSION_ROOT/pickle_settings.json" > "$TMPFILE" \
  && mv "$TMPFILE" "$EXTENSION_ROOT/pickle_settings.json"
```
- **Fold in `auto_update_enabled`** (source already `false`): add `| .auto_update_enabled = false` to the same jq and **delete** the dedicated `install.sh:516` line — two post-merge mechanisms collapse to one (dedup).
- **Observability (R1 mitigation):** when a managed key's deployed value *differed* from the forced value, emit one line naming the key old→new (via `log-activity.js`, like the `:407-448` parity probe, or stderr `echo`). No line when it already matched (no false noise on the common case). Makes "documented downgrade — never silent" a checked outcome.
- **Do NOT** write the code default *value* into the deployed file; source-absent ⇒ `del`. Make deployed byte-identical to source for managed keys.

## 3. Acceptance criteria (machine-checkable) — CORRECTED

- **AC-SSAT-0** *(informational, pre-state attribution)*: at setup, record `jq '{codegraph, worker_test_gate_timeout_ms}' "$HOME/.claude/pickle-rick/pickle_settings.json"` into the ticket artifact so the field effect is attributable, not assumed.
- **AC-SSAT-1** (WS-2 source): `jq -e 'has("worker_test_gate_timeout_ms")' pickle_settings.json` exits **non-zero**.
- **AC-SSAT-2** (WS-2 source): `jq -e '.codegraph.enabled == false and .codegraph.index_at_setup == false' pickle_settings.json` exits **0**.
- **AC-SSAT-3** (WS-1, hermetic, EXTENDS `buildKillSwitchForceFixtureScript`/`makeKillSwitchForceFixture` in `extension/tests/install-script.test.js:320-372`): the fixture builder — which **hand-copies** the install.sh merge (`:326`) + override (`:332`) and today covers only `auto_update_enabled` — MUST be extended with WS-1's managed-keys jq. Seed deployed `{worker_test_gate_timeout_ms:240000, codegraph:{enabled:true, index_at_setup:true, staleness_max_age_minutes:15}}`; source omits the timeout, codegraph false/false. After merge+managed-keys assert: **no** `worker_test_gate_timeout_ms`, `codegraph.enabled==false`, `codegraph.index_at_setup==false`. Do **NOT** invoke full `install.sh` (networked `npm install @colbymchenry/codegraph` + self-probe).
- **AC-SSAT-4** (resolver outcome, CHAINED): run `resolveWorkerTestGateTimeoutMs(<deployedRoot>)` against **the deployed file AC-SSAT-3 produced** (not a fresh fixture), no env override → returns **600000**. This is the accepted proxy for the field symptom (a `medium`+ gate no longer SIGTERMs at 240s); no integration test is expected.
- **AC-SSAT-5** (env wins + floor is env-only): `resolveWorkerTestGateTimeoutMs(<root>, null, {PICKLE_WORKER_TEST_FAST_TIMEOUT_MS:'30000'})` returns **60000** (env floor clamp, `:894`); with `'600000'` returns 600000 regardless of settings. Note: a sub-floor *settings* value returns raw (no clamp, `:898-900`) — which is *why* WS-2 deletes the key.
- **AC-SSAT-6** (non-managed nested key preserved): the AC-SSAT-3 harness also seeds deployed `codegraph.staleness_max_age_minutes:15` (source default 30); after the step assert `staleness_max_age_minutes==15` **preserved** while `enabled==false` source-forced — same object, proving per-path (not whole-object) handling.
- **AC-SSAT-7** (WS-3 invariant, REAL — replaces the fake-green grep): `grep -q "source-authoritative and install.sh removes any deployed pin" extension/CLAUDE.md` exits **0**. *(Phrase verified ABSENT on HEAD → grep=0; the old `grep worker_test_gate_timeout_ms` was fake-green — it matched the pre-existing `:188` line on untouched HEAD.)*
- **AC-SSAT-8** (WS-1 fresh install): with **no** deployed `pickle_settings.json` (the `makeKillSwitchForceFixture({deployedAutoUpdateEnabled:null})` variant), merge+managed-keys yields a deployed file with **no** `worker_test_gate_timeout_ms`, `codegraph.enabled==false`, `index_at_setup==false`.
- **AC-SSAT-9** (WS-1 observable revert, pairs with R1): when the managed step forces a key whose deployed value DIFFERED, install.sh emits a line naming the key + old→new; when deployed already matched source, **no** line is emitted. The AC-SSAT-3 harness (deployed `codegraph.enabled:true`→`false`) asserts the line; a match case asserts silence.

## 4. Simplification Review (subtract-before-add)

1. **Necessary?** WS-2/WS-3 are pure removal/reconcile. WS-1 adds a small managed-keys jq — necessary because a merge cannot unset a stale deployed key (1a), and the source/field divergence class stays alive otherwise.
2. **REUSE not ADD?** Yes — WS-1 **reuses the `auto_update_enabled` post-merge force-override** (`install.sh:515-517`) generalized to a 3-key list, and **absorbs** that line (dedup, −1 mechanism). Reuses the `mktemp`+`mv` atomicity idiom and the `log-activity.js` breadcrumb pattern from the `:407-448` parity probe. No new sync service.
3. **Guards brittle complexity that should be SUBTRACTED?** Yes — the brittle thing is the merge pinning stale scalars forever. The fix is subtractive: remove the stale timeout pin, stop preserving code-managed keys. We remove the false gate input, we do NOT add resistance around the gate ([[feedback_subtract_flaky_gate_input_not_add_resistance]]).
4. **SUBTRACTS:** the stale timeout pin (−1 source line, retires R-WTFT's dead-on-arrival state); the source/field divergence surface for managed keys; the dedicated `auto_update_enabled` line (folded in). **NOT built:** a suite-tracking dynamic budget (additive — 600_000 already solves it; see R3 tripwire instead); a global merge-direction flip (higher blast radius than the per-key managed set).

## 5. Risks

- **R1 — managed keys silently revert deliberate operator tuning on every `install.sh`.** The reused precedent reverts with no output. Mitigation: closed enumerated set + membership predicate (§2); two-CUJ docs (§6); **AC-SSAT-9** makes a *differing* revert observable. Blast radius today ≈ 0 (3 keys no sane operator tunes), but the mechanism generalizes — predicate bounds it.
- **R2 — the hermetic AC-SSAT-3 tests a hand-copy of install.sh** (`install-script.test.js:320-372` transcribes the merge/override rather than sourcing it), so it can stay green while shipped install.sh regresses. Mitigation: mirror WS-1's managed-keys jq into the fixture builder **in lockstep**, and cite the existing md5 parity probe (`install.sh:407-448`, release-gate-mirrored, which `exit 1`s on source→deployed drift) as the precedent for asserting deploy-path parity rather than hand-copying.
- **R3 — the fixed 600_000 budget re-breaks silently on suite growth.** Accepted risk + **tripwire**: revisit the default if `test:fast` wall-clock approaches ~500s (§1b cites ~305–352s today). The `:188` invariant guards only the ≥5min lower bound, not 600s exceeding runtime.

## 6. Two tune-back CUJs (WS-3 docs — document BOTH, distinctly)

1. **Worker test-gate timeout (per-machine):** `export PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=<ms>` (env override, floor 60_000). Do NOT re-add `worker_test_gate_timeout_ms` to any `pickle_settings.json` — install.sh strips it every deploy.
2. **Codegraph enable (e.g. B-CGHARD soak):** set `codegraph.enabled:true`/`index_at_setup:true` in **source** `pickle_settings.json`, then `bash install.sh` (no env-on exists). Produces a labeled, attributable arm.

## 7. Tiering & build notes

- **Tiers (unanimous across analysts):** WS-1 = **medium** (edits `install.sh` deploy path, release-gate-mirrored by `install-script.test.js`, + a subprocess-spawning hermetic test — do not let "one jq block" tier it `small`). WS-2 = **small**. WS-3 = **small**, pure-doc, **append-only** to the `:188` trap-door block (do NOT reword its `ENFORCE`/`PATTERN_SHAPE` anchors — `audit-trap-door-enforcement.sh` scans them).
- **Green-tree precondition** satisfied on the launch commit (6813/0).
- **The bug fixes its own gate:** launch env exports `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=600000` so the bundle's own `medium`+ worker gates don't false-fail on the very 240s defect they remove.
- **Settings-write override:** WS-2 edits source `pickle_settings.json`, guarded by config-protection (`config-protection.ts:99,118`, basename match). `state.flags.allow_settings_writes_reason` set at launch.
- **Pipeline-safe, not salvage-path** — build via `/pickle-pipeline`.

## Implementation Task Breakdown

| Order | ID | Title | Tier | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | ssat-ws2 | Remove stale timeout pin; assert codegraph source-off | small | HEAD green | AC-SSAT-1/2 pass | `pickle_settings.json` |
| 20 | ssat-ws1 | install.sh MANAGED_KEYS (source-authoritative) + hermetic fixture | medium | WS-2 done | AC-SSAT-3/4/5/6/8/9 pass | `install.sh`, `extension/tests/install-script.test.js` |
| 30 | ssat-ws3 | Append B-SSAT invariant + two tune-back CUJs | small | WS-1 done | AC-SSAT-7 passes | `extension/CLAUDE.md`, `CLAUDE.md` |

*Hardening tickets intentionally omitted:* this is a 3-file surgical subtraction (~1 jq line + source delete + doc append + one hermetic-fixture extension), and the full pipeline's citadel → anatomy-park → szechuan-sauce phases supply the cross-cutting review that build-internal hardening tickets exist for. Four large-tier hardening passes on this diff would be redundant over-processing against the reliability+simplification north star. The three highest-risk findings (fake-green AC-SSAT-7, fixture hand-copy R2, silent revert R1) are baked into the ticket ACs and citadel-checked.
