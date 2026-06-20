---
title: "B-CGCAP — Codegraph default-on capability (v2.1, evidenced): A/B harness + supply-chain policy + propagation, then flip"
priority: P2
finding: CG-CAP
status: deferred-post-GA
type: feature-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "v2.0.0 GA (B-GA) shipped — codegraph opt-in baseline + honest docs"
source_assessment: "2026-06-16 codex adversarial review of B-GA; reliability-first / capability-second release principle"
---

# B-CGCAP — Codegraph default-on, the ambitious way (post-GA capability cut)

## 0. Why this is separate from GA

Per the standing release principle (reliability first, capability second, *be ambitious*), the
v2.0.0 GA cut ships codegraph **opt-in** — honest, low-risk. This bundle is where the ambition
lives: turn the default ON, but **earned with evidence**, not optimism. It is gated on B-GA (GA)
having shipped first.

Three verified facts from the 2026-06-16 codex adversarial review make default-on a capability
cut, not a GA gate:
1. **No efficacy harness exists.** `runProbe(args)` is a stub — `return loadCorpus(args.ticketsDir)`
   (`extension/bin/codegraph-efficacy-probe.js:155`). The WITH/WITHOUT spawn-and-score path is
   described in comments but never invoked. You cannot currently produce the number that would
   justify default-on.
2. **The propagation paradox.** `install.sh:479` merges `jq -s '.[0] * .[1]'` (deployed values win),
   so an existing `false/false` install is indistinguishable from a deliberate operator disable. A
   default-on flip can never honestly auto-propagate to existing installs without an explicit
   intent marker introduced *first*.
3. **Unaudited native dependency.** `install.sh:441-469` runs `npm install --no-save
   @colbymchenry/codegraph@0.9.9 --no-audit` with no checksum/vendor/provenance policy. Default-on
   forces that native addon onto every operator at setup.

## 1. Workstreams (all post-GA)

### WS-CAP-A — Build the real A/B efficacy harness
- **AC-CAP-A1 — `runProbe` actually runs an A/B.** Implement the WITH-graph / WITHOUT-graph arms:
  isolated worktrees per arm, **randomized arm order** (the current protocol runs a fixed order,
  `prds/archive/research/codegraph-ab-protocol.md:11-21`), a **pinned model + version**, a prebuilt index
  (no setup-time race), and post-hoc Jaccard / hallucinated-ref scoring over captured diffs. — Type: test
- **AC-CAP-A2 — explicit decision threshold + power.** The baseline records corpus N, repeat count,
  run-to-run variance, and a pre-registered significance bar. "Within noise → opt-in" is only sound
  if the noise band is measured, not assumed. Grow the corpus beyond the 5 fixtures if variance is
  high. — Type: artifact (`prds/research/codegraph-efficacy-baseline.md`, forward-created)

### WS-CAP-B — Native-dependency supply-chain policy
- **AC-CAP-B1 — vendor/checksum/provenance for `@colbymchenry/codegraph@0.9.9`.** Replace the
  `--no-audit` install with a policy: pinned integrity hash verified at install, vendored or
  provenance-checked source, and a documented CVE-watch / update process. Default-on is not
  defensible until an operator pulling this addon by default is a deliberate, audited choice. — Type:
  test + artifact

### WS-CAP-C — Default-flip propagation mechanism
- **AC-CAP-C1 — operator-intent marker + propagation.** Introduce the marker that lets a future
  source default-flip reach installs that never customized the key, while preserving genuine
  operator disables. Solve fresh-vs-existing cleanly: fresh installs may default-on freely (no
  paradox); existing installs flip only when the deployed value equals the recorded shipped default.
  Follow the `install.sh:485` `auto_update_enabled` post-merge-override pattern; cover with an
  install-script test (4 cases: old-default propagates / operator value survives / non-codegraph key
  untouched / idempotent). — Type: test

### WS-CAP-D — The flip (data-gated)
- **AC-CAP-D1 — flip default-on iff earned.** Run AC-CAP-A1 over the corpus; if `efficacy_delta > 0`
  past the threshold AND a large-repo `index_at_setup` soak passes within `index_timeout_ms` AND the
  `PICKLE_CODEGRAPH=off` kill-switch is verified as a one-step revert, set source defaults
  `enabled:true / index_at_setup:true` and reconcile docs to a TRUE "Default-ON". Otherwise stay
  opt-in and record why. — Type: test + artifact

### WS-CAP-E — Interactive MCP lane (stretch)
- **AC-CAP-E1 — decide `expose_mcp_to_workers`.** Gated on the C0 handshake serialization tracked in
  B-V2RG. If the injected-context lane's efficacy is positive, evaluate whether the interactive MCP
  serve lane (`backend-spawn.ts:471-479`; gives workers ad-hoc `getImpactRadius`/queries) adds
  measured value. Ambitious stretch, not required for the default-on flip. — Type: artifact

## 2. Out of scope
- Anything in B-GA (the opt-in baseline + honest docs ship at GA).
- Reliability work (REC-1 / R-WPEX) — those are GA blockers, not here.

## 3. Notes
Anchors verified 2026-06-16 by codex adversarial review of B-GA. This bundle is intentionally NOT a
GA gate; it is the capability fast-follow the reliability-first principle sequences after GA. See
`prds/p1-ga-readiness-drop-beta-v2.0.0.md`.
