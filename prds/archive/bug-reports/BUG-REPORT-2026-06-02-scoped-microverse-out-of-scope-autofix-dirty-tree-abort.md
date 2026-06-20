---
title: BUG REPORT — 2026-06-02 — scoped anatomy-park/szechuan runs let a package-wide `lint --fix` mutate files OUTSIDE `scope.json:allowed_paths`, and the runner's clean-tree precondition then aborts ("Working tree is dirty and not a git repository"), recurring every gate/iteration until an out-of-scope file is manually committed
status: Draft
filed: 2026-06-02
priority: P2
type: bug-incident
r_code: R-SMAF
bundle: unbundled
related:
  - prds/MASTER_PLAN.md                                                          # finding #91 (this report, R-SMAF) + #92 (R-RSBI secondary)
  - prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md                  # B-APWS (#11 R-APWS, CLOSED v1.79.1) — gated worker `git add`/commit to allowlist; did NOT cover lint-autofix mutating the working tree
  - prds/archive/bug-reports/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md             # #80, Done ea3cb135 — adjacent dirty-tree-guard class (bundle self-cleanup), different trigger
  - prds/archive/bug-reports/BUG-REPORT-2026-05-28-citadel-monorepo-workingdir-as-reporoot-path-doubling.md  # R-CWRR (#88) — same workingDir-vs-repoRoot class as the R-RSBI secondary
  - prds/archive/bug-reports/p2-szechuan-anatomy-finalize-gate-npmrc-warn-pollution-masks-real-failures.md   # adjacent finalize-gate-noise class
  - prds/archive/bug-reports/anatomy-park-judge-unreachable-on-worker-convergence.md                # adjacent — post-convergence exit-path issues (R-APXG secondary)
  - extension/src/bin/microverse-runner.js                                      # the clean-tree precondition / abort site
  - extension/src/bin/check-gate.js                                             # gate runs lint (autofix) — candidate out-of-scope mutator
  - extension/src/bin/resolve-scope.js                                          # R-RSBI secondary — scope-base resolution
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-06-01-971c9eb4  # anatomy-park (staged-bundles scope, loanlight-api monorepo) — primary repro
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-06-02-12d45682  # szechuan-sauce (same scope) — secondary
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-06-01-cd0fb939  # pickle-tmux build (5-ticket drain) — clean, no dirty-tree issue (data point: only the scoped microverse templates hit it)
---

# R-SMAF — scoped microverse runs let an out-of-scope `lint --fix` dirty the tree, then abort on the clean-tree precondition

## Status

**Open.** Directly observed this session (loanlight-api LOA-955 remediation pipeline). Does NOT pre-commit to a fix; the mechanism is observable in the runtime and should be confirmed with one regression before changing the abort logic.

## TL;DR

Running `/anatomy-park` or `/szechuan-sauce` with `--scope paths:<subsystem-glob>` against a monorepo subpackage, the microverse-runner aborted on startup with:

```
ERROR: Working tree is dirty and not a git repository. Aborting.
[FATAL] Working tree is dirty — not a git repo, cannot auto-commit
```

The dirtying file was **outside** the resolved `scope.json:allowed_paths`: a package-wide `pnpm run lint` (eslint `--fix`, invoked by the gate and/or the worker's pre-commit lint-autofix step) removed an *unused* `// eslint-disable-next-line` directive in `packages/api/src/lib/credit-pipeline/candidate-generators/credit-reducto-generator.ts` — a file the scoped run had no business touching. The clean-tree precondition then aborted the whole run. It **recurred on every gate/iteration**: restoring the file let the run start, but the next lint pass re-dirtied it, so the operator had to **commit the unrelated one-line autofix** to make the recurrence stop.

This survives **B-APWS** (#11 R-APWS, CLOSED v1.79.1), which gated the worker's `git add`/commit to the allowlist — but a package-wide `lint --fix` mutates the *working tree* directly, never going through the gated `git add`, so the allowlist never sees it.

## Mechanism

1. `--scope paths:…` resolves `scope.json:allowed_paths` correctly to the subsystem files (e.g. the 7 `staged-bundles/*` files). ✅
2. A gate or worker step runs the project lint script package-wide. Most repos bake `--fix` into `lint` (the szechuan worker template Step 6 *explicitly* runs lint autofix before commit; check-gate's lint check is another candidate). eslint `--fix` with `reportUnusedDisableDirectives` rewrites any file in the package with an unused disable directive — **including files outside `allowed_paths`**.
3. The microverse-runner's clean-tree precondition sees a dirty working tree and aborts (`microverse-runner.js`). It does **not** subtract out-of-scope changes the way the gate subtracts pre-existing typecheck/lint failures against `gate/baseline.json`.
4. Restoring the file is futile — the next lint pass re-applies the same autofix. The only way forward is to commit the unrelated change (scope leak into the PR) or pre-emptively neutralize it.

## Evidence (this session)

- anatomy-park run `2026-06-01-971c9eb4`: first launch aborted as above; `git status` showed only `M packages/api/src/lib/credit-pipeline/candidate-generators/credit-reducto-generator.ts` (NOT in `scope.json`). Diff was a single removed `// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment`.
- After `git restore` + relaunch via `launch.sh`, the run started and the worker converged — but a later gate re-dirtied the same file; the post-convergence exit gate then hung (see R-APXG below).
- Committing the one-liner (`a413c3f96 chore: remove unused eslint-disable directive (gate autofix)`) stopped the recurrence; szechuan-sauce then launched clean.
- Control: the pickle-tmux **build** session `2026-06-01-cd0fb939` (no `--scope`, full-package gate) never hit this — only the *scoped* microverse templates did, because for an unscoped run the out-of-scope file is in-scope.

## Recommended fix (confirm before implementing)

Pick one; (a) is the most targeted:
- **(a)** In the microverse-runner clean-tree precondition, when `scope.json` exists, evaluate dirtiness **only over `allowed_paths`** — out-of-scope working-tree changes are ignored (and optionally `git stash`/`git checkout --` reverted as pre-run hygiene), mirroring how the gate subtracts the `baseline.json` failure set.
- **(b)** Make any lint-autofix step run by a scoped microverse pass `--fix` only the `allowed_paths` files (pass the scoped file list to eslint), never the whole package.
- **(c)** Pre-run: snapshot out-of-scope files and restore them after each gate so the tree stays clean within scope.

A regression spec: scoped run + an out-of-scope file that lint would autofix → run must NOT abort and must NOT commit the out-of-scope change.

## Secondary findings (same incident — file as smaller findings / cross-refs)

- **R-RSBI (P3) — `resolve-scope.js` base inconsistency.** The same `--scope paths:<glob>` resolved against **`packages/api`** for the anatomy-park run but against the **repo root** for the szechuan-sauce run, so the glob prefix that matched in one returned `SCOPE_EMPTY_PATHS` in the other (`src/modules/…/staged-bundles/**` vs `packages/api/src/modules/…/staged-bundles/**`). Same `workingDir`-vs-`repoRoot` class as **R-CWRR** (#88). Operator had to retry with a different prefix. Fix: resolve `paths:` globs against a single, documented base (repo toplevel) regardless of template/working_dir.
- **Misleading abort copy.** "Working tree is dirty **and not a git repository**" — it *is* a git repo (toplevel at the monorepo root); the working_dir is a subpackage. The two conditions are conflated; the message should distinguish "dirty (out-of-scope)" from "no `.git` found."
- **R-APXG (P2) — anatomy-park post-convergence exit gate hangs.** After the worker signaled convergence (`anatomy-park.json: converged=true`, trap door committed), the "per-iteration gate before exit" ran but never returned (5+ min, no closing banner); the session had to be killed manually. Likely coupled to the dirty out-of-scope file (gate can't reach a clean state). Adjacent to `anatomy-park-judge-unreachable-on-worker-convergence.md`.
- **gitnexus graph-preflight noise.** `setup.js` logged `[graph-preflight] gitnexus analyze failed: gitnexus analyze exited 1` on every launch and can re-dirty `CLAUDE.md`/`AGENTS.md` (known). Non-fatal but contributes to the dirty-tree class; worth making the preflight scope-aware or non-mutating.
- **Babysitting / no completion signal (UX).** The tmux-launched stages (`pickle-tmux`, `anatomy-park`, `szechuan-sauce`) are not harness-tracked, so an orchestrating chat must poll session state to know when a stage finished and to chain the next. Operator expectation: **stages auto-chain and signal completion without an agent babysitting**, and a stage the operator already named (e.g. szechuan-sauce) should **run without a mid-pipeline confirmation prompt**. Largely covered by the launch-friction / babysit-harden bundles (`prds/archive/bundles/p2-pipeline-launch-friction-bundle-2026-05-18.md`, `prds/archive/bundles/p1-bug-fix-bundle-b-pipe-babysit-harden-2026-05-27.md`); the net new ask is that `/pickle-pipeline` (build → citadel → anatomy-park → szechuan-sauce) is the intended auto-chaining entry point and should be the documented one-shot for "run the whole cleanup chain," so a human/agent never stages them by hand.

## Impact

P2 pipeline-friction: every scoped anatomy-park/szechuan run on a monorepo whose package-wide lint autofixes any out-of-scope file will abort on launch and recur, forcing either an unrelated scope-leak commit into the operator's PR or repeated manual restores. It silently widens the review diff and breaks the "scoped run touches only allowed_paths" contract that B-APWS established for the commit path.
