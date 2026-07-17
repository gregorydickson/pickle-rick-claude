---
title: "B-SSAT — Settings source-authoritative + de-flake the worker test gate (v2.1)"
priority: P1
finding: "B.5b / worker_test_gate_timeout_ms (R-WTFT inert)"
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "2026-07-17 MASTER_PLAN re-sequence — the queue's #1-2 subtractive reliability unblock; also the measurement prerequisite for B-CGHARD codegraph work"
---

# B-SSAT — Settings source-authoritative + de-flake the worker test gate

## 0. Thesis (one sentence)

Two coupled defects let the **deployed** `pickle_settings.json` silently override committed **source**
values forever, which has (a) made the worker `test:fast` gate false-fail every `medium`+ ticket on
this repo and (b) left codegraph running a configuration nobody chose — both fixed by making a small set
of **code-managed** settings keys source-authoritative at `install.sh` time.

## 1. Background — verified 2026-07-17

### 1a. The merge lets deployed win (the root enabler)
`install.sh:510` merges settings with:
```
jq -s '.[0] * .[1]' "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/pickle_settings.json"
```
`.[0]` is the repo **source**, `.[1]` is the **deployed** copy, and jq's `*` lets the **right operand
(deployed) win** on scalar conflicts. Proven at the shell:
- `source 600000 * deployed 240000 → 240000`
- **source with the key deleted → 240000 still survives** (a key absent from the left cannot unset the right)

So editing source + `bash install.sh` — the procedure `CLAUDE.md` mandates — **changes nothing while
looking done.** Precedent that the fix is safe and already partially present: `install.sh:516-517`
force-overrides `auto_update_enabled=false` on the deployed file *after* the merge, so that one key is
already effectively source-controlled today.

### 1b. R-WTFT shipped inert (defect surfaced by 1a)
`0173662d fix(worker-gate): raise test:fast timeout 240s -> 600s + env override (R-WTFT)` raised the
constant `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS` **240_000 → 600_000**, but `pickle_settings.json:36` is
still pinned at **240000** (born there in `e34894ea`, 2026-05-11, never touched). The resolver
`resolveWorkerTestGateTimeoutMs` (`services/pickle-utils.ts:883-902`) is a single knob —
**env override → settings key → default (600_000)** — so the settings pin outranks the fixed constant
and R-WTFT has been **dead on arrival since it shipped.** Field effect: the worker gate SIGTERMs
`npm run test:fast` at 240000ms against a suite that runs green in ~305–352s, so every `medium`+ ticket
gate fails with `__timeout__`; `failed_flip_suppressed` (evidence=both) saves the work but burns a
suppression slot (cap 2) per ticket, and a third strike would flip a **green** ticket **Failed**.

### 1c. The trap-door invariant guards the wrong site
`extension/CLAUDE.md:188` declares an INVARIANT that `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS` stays ≥ ~5min
("BREAKS: … reopens the R-WUWC-1 class"), enforced on the **constant** (compliant at 600_000) while
`pickle_settings.json` violates it at 240000 **unguarded** — R-WUWC-1 is therefore already reopened in
the field via the file the invariant does not watch.

### 1d. Codegraph runs an unlabeled arm (same root cause, second symptom)
Source `codegraph.enabled:false` / `index_at_setup:false`; **deployed `true` / `true`** — divergence
caused solely by 1a. The field runs a codegraph configuration no one selected, so no soak can name which
arm it measured. Making these keys source-authoritative turns the field OFF (source's value); a soak
then turns it ON deliberately. **This is the measurement prerequisite for B-CGHARD.**

## 2. Scope / workstreams (refinement owns final ticket decomposition)

- **WS-1 — `install.sh`: managed keys become source-authoritative.** Introduce a small, explicit
  `MANAGED_KEYS` handling applied to the deployed `pickle_settings.json` *after* the base merge, so that
  for each managed key the deployed file reflects source (or the code default), NOT a stale deployed
  scalar. Must handle the **unset case**: a key absent from source must be **removed** from deployed
  (jq `del(...)`), because a plain merge cannot unset it (see 1a). Operator-tunable keys NOT in the
  managed set keep today's merge-preserve behavior.
- **WS-2 — remove the stale worker-gate timeout pin.** Delete `worker_test_gate_timeout_ms` from source
  `pickle_settings.json` so the code default (600_000, env-overridable) is the single source of truth,
  AND ensure WS-1 removes it from the deployed file (the unset case above). Codegraph keys
  (`enabled`, `index_at_setup`) are managed to their source values `false`/`false`.
- **WS-3 — invariant/doc reconciliation.** Extend the `extension/CLAUDE.md:188` INVARIANT so it also
  forbids a sub-floor `worker_test_gate_timeout_ms` in `pickle_settings.json` (or records that WS-2's
  deletion collapses the timeout to a single code-owned site). Update `CLAUDE.md`'s settings/env docs so
  the resolver precedence (env → settings → default) and the source-authoritative merge are documented.

## 3. Acceptance criteria (machine-checkable)

- **AC-SSAT-1** (WS-2 source): `jq -e 'has("worker_test_gate_timeout_ms")' pickle_settings.json` exits
  **non-zero** (key absent from source).
- **AC-SSAT-2** (WS-2 source): `jq -e '.codegraph.enabled == false and .codegraph.index_at_setup == false' pickle_settings.json`
  exits **0**.
- **AC-SSAT-3** (WS-1 outcome, hermetic): a test that seeds a fake deployed
  `pickle_settings.json` containing `worker_test_gate_timeout_ms: 240000` and
  `codegraph: {enabled:true, index_at_setup:true}`, runs the `install.sh` merge+managed-keys step against
  a source that omits the timeout key and sets codegraph false/false, then asserts the resulting deployed
  file has **no `worker_test_gate_timeout_ms`** and `codegraph.enabled == false`,
  `index_at_setup == false`.
- **AC-SSAT-4** (resolver outcome): with the deployed file from AC-SSAT-3 and no env override,
  `resolveWorkerTestGateTimeoutMs(<deployedRoot>)` returns **600000**.
- **AC-SSAT-5** (env override still wins): `resolveWorkerTestGateTimeoutMs(<root>, null, {PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '600000'})` returns **600000** regardless of settings; and a sub-floor
  env value clamps to the 60_000 floor per the existing contract.
- **AC-SSAT-6** (no regression on operator-tunable keys): the AC-SSAT-3 harness also seeds a
  non-managed key the operator customized in the deployed file and asserts it is **preserved** after the
  merge (managed-key handling must not become a blanket source overwrite).
- **AC-SSAT-7** (invariant present): `grep -q worker_test_gate_timeout_ms extension/CLAUDE.md` in the
  R-WTFT invariant block (WS-3 reconciliation landed).

## 4. Simplification Review (subtract-before-add — REQUIRED)

1. **Necessary at all?** WS-2 and WS-3 are pure removal/reconcile (delete a stale pin, fix a
   mis-targeted invariant). WS-1 adds a small managed-keys step to `install.sh` — necessary because a
   merge cannot unset a stale deployed key, and the whole class of source/field divergence stays alive
   without it.
2. **REUSE instead of ADD?** Yes — WS-1 **reuses the existing `auto_update_enabled` post-merge
   force-override pattern** (`install.sh:516-517`), generalized to a small key list, rather than a new
   propagation sidecar. Do NOT build a settings-sync service.
3. **Guards existing brittle complexity that should be SUBTRACTED?** Yes — the brittle thing is the
   merge that pins stale scalars forever. The honest fix is subtractive: remove the stale timeout pin and
   stop the merge from preserving code-managed keys. We are NOT adding an escape hatch around the gate;
   we are removing the false input, per `[[feedback_subtract_flaky_gate_input_not_add_resistance]]`.
4. **What does this SUBTRACT?** The stale `worker_test_gate_timeout_ms` pin (−1 source line); the
   entire source/field silent-divergence surface for managed keys; and it retires R-WTFT's dead-on-arrival
   state (the 600_000 fix finally reaches the field). **Explicitly NOT built:** a suite-tracking dynamic
   budget (rejected as additive — the fixed 600_000 default already solves it), and a global merge-direction
   flip (rejected as higher blast radius than the per-key managed set; note it as the more-invasive
   alternative refinement may still choose if the managed-key list proves unwieldy).

## 5. Build notes (operational — for the launcher, not the workers)

- **Green-tree precondition** must be satisfied on the launch commit (`cd extension && npm run test:fast`
  green at rest) before launch.
- **The bug fixes its own gate.** Launch with `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=600000` exported so the
  bundle's own `medium`+ worker gates do not false-fail on the very defect they remove.
- **Settings-write override.** WS-2 edits source `pickle_settings.json`, which the config-protection hook
  guards by basename (`config-protection.ts:99,118`). Set
  `state.flags.allow_settings_writes_reason` (e.g. "B-SSAT: remove stale worker-gate timeout pin;
  source-authoritative settings") after setup so the worker is not blocked.
- **Pipeline-safe, not salvage-path.** This bundle touches `install.sh`, `pickle_settings.json`,
  `extension/CLAUDE.md`, and a hermetic test — none is the salvage/completion-evidence/Done-flip path, so
  the R-PSRB hand-build exception does NOT apply. Build via `/pickle-pipeline`.
- **Scope fence:** `install.sh`, `pickle_settings.json`, `extension/CLAUDE.md`, `CLAUDE.md`,
  `extension/tests/**`, and (WS-1 test helper only) any new `extension/src`/compiled-mirror test scaffold.
