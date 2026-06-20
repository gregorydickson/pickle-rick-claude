# BUG REPORT — 2026-06-12 — Pipeline launch on a feature branch after refinement: stale HEAD pin + forward-ref readiness rejection

**Discovered by:** weekend autonomous babysitter driving `loanlight-api` bundle B1 (LOA-1154 credit reliability parity), backend `codex`, pickle-rick v2.0-beta-2.
**Severity:** High — two distinct defects each independently block `/pickle-pipeline` from ever entering the build manager when the canonical "refine on default branch → build on a feature branch" flow is used. Required three manual interventions to launch one bundle.
**Repro context:** session `2026-06-12-4dddf819`. PRD refined on `main`; build intended on feature branch `gregory/loa-1154-credit-reliability-parity`; 10 tickets (6 impl + 4 hardening), all impl tickets forward-create files/contracts.

---

## Finding A — `setup.js --resume --tmux` preserves the stale branch/SHA pin; no re-pin path; collides with the dirty-tree guard (catch-22)

### Symptom
`pipeline-runner` PHASE 1 (pickle) exits 1 in <1s. `mux-runner.log`:
```
HEAD mismatch detected: pinned_branch=main observed_branch=gregory/loa-1154-credit-reliability-parity
                        pinned_sha=ef88ee29... observed_sha=64f97cb...
mux-runner finished. 1 iterations, 0m 0s
```

### Root cause
The session was created (`setup.js --paused`) while checked out on `main`, which recorded `state.pinned_branch=main` / `state.pinned_sha=<main HEAD>` / `start_commit=<main HEAD>`. A later `setup.js --resume --tmux --backend codex` — run while already checked out on the feature branch — **did not re-pin**: `pinned_branch` stayed `main`. When the build ran on the feature branch (HEAD advanced by a legitimate prep commit), the HEAD-mismatch guard aborted.

### The catch-22 (why this isn't just operator error)
1. The dirty-tree guard (`[FATAL] Working tree ... is dirty`) **forces** a commit/stash before launch.
2. Committing **advances HEAD**, moving it away from the stale pin.
3. The HEAD-mismatch guard then **aborts** because HEAD ≠ pin.
4. There is **no documented re-pin path** — `--resume` does not re-pin, and no `--repin`/reset bin script exists (only `circuit-reset.js`, unrelated).

So the standard, documented flow ("refine; then ship each bundle to a branch + PR") cannot launch a build on a feature branch without manual `state.json` surgery.

### Workaround applied
Hand-patched `state.json`: `pinned_branch`/`pinned_sha`/`start_commit` → current feature-branch HEAD; cleared `head_pin_mismatch_detail`.

### Acceptance criteria (machine-checkable)
- [ ] `setup.js --resume --tmux` re-pins `pinned_branch`/`pinned_sha` to the **current** `git HEAD` of the working dir when it differs from the stored pin (or emits an explicit, documented re-pin instruction). Verify: integration test — create session on branch A, checkout branch B + commit, `setup.js --resume --tmux`, assert `state.pinned_sha == git rev-parse HEAD`.
- [ ] A documented re-pin mechanism exists (bin script or `setup.js --repin`) and is referenced in the `/pickle-pipeline` skill's branch/scope section. Verify: `grep -rn "repin\|re-pin" extension/bin .claude/commands`.
- [ ] The dirty-tree guard message names the re-pin/clean path when a feature-branch build is intended. Verify: guard copy includes the remediation.

---

## Finding B — readiness + ticket-audit gates reject same-bundle forward-created file/contract references (hardening-ticket templates emit unannotated `MODIFIED_FILES`)

### Symptom
After clearing Finding A, PHASE 1 reaches Iteration 1 then halts:
```
READINESS HALT: check-readiness exited 2; no manager spawn attempted
exit_reason: pickle_readiness_halt
```
`check-readiness` reports 14 findings, all `file_path`/`contract` "Referenced … does not resolve":
`worker-lock.ts`, `worker-lock.spec.ts`, `migration-0167-...spec.ts`, `credit-orphan-recovery.e2e-spec.ts`, contract `credit.silent_run_detected`.

### Root cause
Every flagged reference is a **same-bundle forward-creation** — created by an earlier-`order` ticket (10/20/40), referenced by later tickets (the 4 hardening tickets at order 70–100, plus the order-40 reconcile ticket) that execute *after* creation. `check-readiness` resolves references against **current HEAD** and cannot see same-bundle forward creations. Two contributing decomposition issues make it worse:
1. **Hardening-ticket templates (Step 7e) emit `MODIFIED_FILES` as plain backticked paths with no forward-ref annotation.** The decomposer copies the union of impl-ticket files into the hardening tickets' Research Seeds verbatim; none carry `(forward-created)`/`(created by ticket <hash>)`. So readiness flags all of them. This is structural — it recurs on **every** bundle that has hardening tickets + forward-creating impl tickets.
2. The order-40 ticket annotated a forward-ref with the **non-canonical** form `` `...worker-lock.ts` (ticket 72892c98) `` instead of `(created by ticket 72892c98)`; readiness does not recognize `(ticket X)` as a forward-ref annotation.

### Prior art
This is the same class as `prds/archive/bug-reports/BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md` — apparently not fully closed for the hardening-template path.

### Workaround applied
Set `state.flags.skip_quality_gates_reason` (covers both readiness + ticket-audit) with a reason citing the all-forward-created finding set. Build then spawned the manager normally. **This skip will be reused for B2/B3/B4 this weekend** because the defect is structural — every bundle hits it.

### Acceptance criteria (machine-checkable)
- [ ] `check-readiness` treats a referenced path/contract as resolved if it is forward-created by a lower-`order` ticket in the same bundle, even when unannotated. Verify: unit test — bundle where ticket order 70 references a file whose `Files to modify/create` is declared by ticket order 10; `check-readiness` exits 0.
- [ ] OR the Step 7e hardening-ticket templates auto-annotate `MODIFIED_FILES` entries that are forward-created within the bundle with the canonical `(created by ticket <hash>)`. Verify: decompose a forward-creating bundle; `grep` every hardening-ticket `MODIFIED_FILES` path resolves or carries a canonical annotation.
- [ ] `/pickle-refine-prd` (or its decomposition subagent guidance) emits the **canonical** annotation form `(created by ticket <hash>)` — never `(ticket <hash>)`. Verify: readiness recognizes the emitted annotation; a lint over written tickets finds no bare `(ticket <8hex>)` forward-refs.

---

## Combined impact
The documented happy path — `/pickle-refine-prd <prd>` then `/pickle-pipeline --backend codex` on a feature branch — is currently **un-launchable without manual state surgery + a quality-gate skip**. Findings A and B are independent; both must be fixed for the autonomous babysitter loop to launch bundles unattended.
