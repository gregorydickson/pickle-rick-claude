# FEAT: turn on codegraph MCP for workers — and make the flip actually reach the runtime

- **Date**: 2026-08-16
- **Priority**: P2 (capability — first capability work after the reliability run)
- **Branch**: `release/v2.1-beta`
- **Measured at**: `770dfe8a` (fast tier green: 7720 tests, 507 suites, fail 0, cancelled 0, 855250 ms)

## What is already built (verified in source, 2026-08-16)

The plumbing is complete and unused. `buildWorkerMcpConfig`
(`extension/src/services/backend-spawn.ts:475`) merges the operator's snapshotted MCP entries with a
`codegraph serve --mcp` entry, writes `<sessionDir>/mcp/worker-mcp.json`, and returns that path for the
worker's `--mcp-config`. `resolveCodegraphServeEntry` (`:435`) resolves the bin via
`require.resolve('@colbymchenry/codegraph/package.json')` and pins `CODEGRAPH_NO_WATCH=1` for
single-writer safety. Consumed at `extension/src/bin/spawn-morty.ts:3054`; codex workers are excluded by
construction. Codegraph itself is already ON and working — `codegraph_context_injected` fired 14 times
in session `2026-08-16-791e6dd0`.

**So this ticket is a flip plus its verification, NOT new plumbing.** Do not rewrite
`buildWorkerMcpConfig`.

## The two reasons a naive flip does nothing

1. **The flip is inert on an existing install.** The deploy script merges settings with
   `jq -s '.[0] * .[1]' <source> <deployed>` at `install.sh:507` — the DEPLOYED file is second, so
   **deployed wins** for any key it already contains. Deployed currently has
   `codegraph.expose_mcp_to_workers: false`, and the key is NOT in the MANAGED_KEYS block at
   `install.sh:513` (which force-owns `worker_test_gate_timeout_ms`, `codegraph.enabled`,
   `codegraph.index_at_setup`). Flipping only the source default changes nothing after a deploy.
2. **The failure mode is silent.** With the flag on and the bin unresolvable, `buildWorkerMcpConfig`
   writes one stderr line and returns operator passthrough. The run proceeds, no activity event is
   emitted, and the feature reads as ON while being OFF. On this box the bin resolves only because
   `~/.claude/pickle-rick/extension/node_modules/@colbymchenry/codegraph` is a SYMLINK into the source
   repo; a user installing from a release has no such symlink, so passthrough is their default path.

## Acceptance criteria

- **AC-1 — the flip reaches the runtime.** After a deploy, the deployed `pickle_settings.json` reads
  `codegraph.expose_mcp_to_workers: true` even when the pre-existing deployed file said `false`. Achieve
  it the way the sibling keys do (MANAGED_KEYS force), and log the forced transition exactly as
  `codegraph.enabled` does. A test drives the deployed-says-false upgrade path.
- **AC-2 — a worker actually receives the config.** In a real session, the worker spawn carries
  `--mcp-config <sessionDir>/mcp/worker-mcp.json`, that file exists, and its `mcpServers` contains a
  `codegraph` entry whose `args` end in `serve --mcp`. Assert on the spawned argv and the file, not on
  the settings value.
- **AC-3 — the worker can actually call it.** Demonstrate a worker performing one successful codegraph
  MCP tool call, with the evidence recorded (log line or activity event). A config file that is written
  but never answers is not "working".
- **AC-4 — degradation is LOUD, not silent.** When the codegraph bin is unresolvable or the merge write
  fails, the run still proceeds on operator passthrough (never abort — Prime Directive), but emits an
  activity event naming the reason. The current bare stderr line does not satisfy this AC. A test forces
  the unresolvable-bin path and asserts the event.
- **AC-5 — operator config is never mutated and collisions still favour the operator.** The existing
  invariants hold: the operator's MCP file is not written to, and an operator-supplied `codegraph` key
  still wins the name collision. Regression pins, not new behavior.
- **AC-6 — codex is unaffected.** Codex workers still receive no `--mcp-config`. Pin it.
- **AC-7 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. Test count must not shrink below
  7720, read from the runner's own summary block.
- **AC-8 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort
  site, no new setting key. `PICKLE_CODEGRAPH=off` must still disable the whole thing including this.

## Known risk to record, not to fix here

The release-install path (no source symlink) is where `resolveCodegraphServeEntry` most likely returns
null. AC-4 makes that visible rather than silent; actually making the bin resolve for a tarball install
is a separate ticket and must NOT be attempted in this bundle.

## Simplification Review

1. **What can be subtracted instead of added?** The `false` default is the subtraction target — the
   feature is built, gated off, and the gate has outlived its purpose. Nothing new is written except the
   MANAGED_KEYS entry and the degraded-path event.
2. **Does this add a new abort condition?** No — AC-8 forbids it, and AC-4 explicitly keeps degradation
   on the passthrough path.
3. **Does this add a new configuration surface?** No new key; it makes an existing key
   source-authoritative, matching its two siblings.
4. **Is a fix at this seam load-bearing for anything else?** Yes — MANAGED_KEYS is the mechanism that
   made the last settings fix stop being inert (B-SSAT). Any future settings default has the same
   problem, so this keeps that one mechanism as the single answer.
