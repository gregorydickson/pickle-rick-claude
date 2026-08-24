# BUG-2026-08-21 (P0) — the MCP fallback hands `claude` a file that is not an MCP config

## Status
Open. Refined 2026-08-23 from `prd.md` by a 3-role x 2-cycle analyst team. HEAD `551057d1`.
Both mandatory pre-launch checks passed and are recorded in the source PRD.

## 0. What refinement changed (read this first)

The authored PRD was directionally right and structurally wrong. Six changes, each measured:

1. **This is a HOIST, not a new guard.** The exact record predicate AC-1 asks for already ships at
   `extension/src/bin/setup.ts:1820`, one call downstream of the resolver that lacks it. The codebase
   already encodes "this resolver returns paths that may not be MCP configs" and applies it at one of
   four consumers. Building a second copy is the default outcome of the authored text.
2. **Layer 1 is worse than layer 2 and was never scoped.** `backend-spawn.ts:361-363` returns
   `worker_mcp_config_path` verbatim with **no existence check, no parse, no `mcpServers` check** —
   layer 2 at least calls `existsSilently`. A typo'd override reproduces the identical fatality.
3. **The fix as authored converts a loud failure into a silent one.** No AC discharges the Impact
   section's own "gives no usable diagnostic" complaint. Post-fix an operator with a broken config
   gets workers that run fine with no MCP and no message.
4. **No AC asserts the happy path survives.** An over-strict validator that rejects every valid config
   passes AC-1..AC-5 as written.
5. **Three existing fast-tier tests assert the inverse of AC-1**, and one builder-level test is
   **fake-green by construction on this host**. Without repairing them the bundle cannot go green
   honestly.
6. **AC-5 as authored would deadlock a worker.** It targets `pickle_settings.json`, a Worker Forbidden
   Op blocked by basename at `hooks/handlers/config-protection.ts:109`/`:188` — zero commits, ticket
   unsatisfiable.

## 1. What happens

`resolveMcpConfigWithLayer` (`extension/src/services/backend-spawn.ts:357-370`) has four precedence
layers (`session_merged` > `settings_override` > `claude_json_fallback` > `omitted`). Two of them hand
`claude` a path without establishing it is an MCP config:

| layer | site | check performed |
|---|---|---|
| `settings_override` | `:362-363` | **none** — returns `worker_mcp_config_path` verbatim |
| `claude_json_fallback` | `:366-368` | `existsSilently` only — no parse, no `mcpServers` |

Claude Code always creates `~/.claude.json` (it holds `numStartups`, `projects`, `tipsHistory`); the
`mcpServers` key is not guaranteed to be in it. Measured behavior of `claude --mcp-config`:

| fixture | result |
|---|---|
| no `mcpServers` key | `Error: Invalid MCP configuration: mcpServers: Invalid input: expected record, received undefined` |
| `{"mcpServers":[]}` | `Error: ... expected record, received array` (a **distinct** error) |
| `{"mcpServers":{}}` | `ok` — empty record is VALID |
| `{"mcpServers":{...}}` | `ok` |

Every worker, analyst, **and manager** spawn routes through this resolver. A dead manager means no
orchestrator survives to park the item, flag it, and continue — the exact outcome the PRIME DIRECTIVE
forbids. That is the real severity argument, stronger than the authored Impact paragraph.

**This host does not reproduce the bug**: `~/.claude.json` has `mcpServers` present, object,
non-array, **0 servers** — the valid arm. Verification MUST use an injected `homeDir` / `HOME`, never
host observation. A session that survives proves nothing; it is running on the passing arm.

## 2. Acceptance criteria

- **AC-1 (the hoist).** A precedence layer resolves to a *path* only when that path exists, parses as
  JSON, and its `mcpServers` value is a record — `v && typeof v === 'object' && !Array.isArray(v)`.
  This predicate already exists at `setup.ts:1820` and MUST be extracted into a single exported helper
  (`hasMcpServersRecord`) consumed by both sites, **not reimplemented**. It applies to **both**
  `settings_override` (`:362`) and `claude_json_fallback` (`:366`). Empty record passes; array fails.
- **AC-2** A malformed / unreadable / `mcpServers`-less config resolves to the next layer, ultimately
  `omitted`, never to a path — *except* present-with-empty `mcpServers`, which resolves to the path.
  The winning layer is logged truthfully via `emitMcpConfigResolved`.
- **AC-3 (PRIME DIRECTIVE).** No new halt path, and **no new `exit_reason`**. A bad config degrades;
  it never fails a spawn and never breaks the phase loop.
- **AC-4 (parametrized, one ticket).** `resolveMcpConfigWithLayer(bag, fixtureHome)` is driven over
  every state and asserts **both** `path` and `layer`: absent · unparseable · no `mcpServers` ·
  `mcpServers: []` · `mcpServers: null` · `mcpServers: {}` · `mcpServers: {linear:{}}`; plus a
  precedence row proving `settings_override` beats a malformed `~/.claude.json`. Verified against an
  injected `homeDir`, never the real `$HOME`.
- **AC-5 (docs, deadlock-free).** `CLAUDE.md:161` no longer says "`null` = no MCP forwarding".
  Replacement: "`null` = no operator override; the runtime falls back to `~/.claude.json` **only when
  that file parses and contains an `mcpServers` record**, otherwise `--mcp-config` is omitted."
  **Do NOT edit `pickle_settings.json`** — Worker Forbidden Op, blocked by basename; its stale
  `_worker_mcp_config_path_doc:55` is a **manager-owned residual**.
  `extension/src/services/CLAUDE.md:13` is NOT a target — it records the forwarding invariant.
- **AC-6 (the diagnostic — closes the PRD's own Impact).** When a layer is skipped because its config
  is missing, unparseable, or lacks an `mcpServers` record, emit exactly one `stderr` line naming the
  rejected path, the failing condition, and the consequence. Matches the existing degradation idiom at
  `backend-spawn.ts:490`/`:503`. **At most once per process** (no per-spawn spam) and never blocks the
  spawn. `settings_override` is an *explicit* operator choice and warns at higher prominence than the
  layer-2 fallback, which was never deliberately chosen. **This is a warning, not a gate** (AC-3).
- **AC-7 (regression / happy path).** A `~/.claude.json` with real servers, and a valid
  `worker_mcp_config_path`, both continue to resolve to their existing paths and layers with no
  behavior change. Precedence order unchanged.
- **AC-8 (coupling — protect the downstream guard).** `setup.ts:1816-1822` keeps its parse (it needs
  `operatorEntries`, the value, not just validity) and calls the shared `hasMcpServersRecord`. Neither
  call site is deleted; the predicate exists exactly once. Pin this so the Simplify phase cannot
  delete `:1820` reasoning "the resolver validates now".
- **AC-9 (repair the tests that pin the bug).** In `tests/services/backend-spawn-mcp.test.js`, the
  three fixtures at `:59`, `:71`, `:94` write `'{}'` and then assert the resolver RETURNS that path
  (`:62`, `:74`, `:97`) — they assert the inverse of AC-1. Change each fixture to `'{"mcpServers":{}}'`,
  preserving each test's real intent (**precedence**: layer 1 beats layer 2). Do **not** delete them.
- **AC-10 (un-fake the builder seam).** `backend-spawn-mcp.test.js:264` overrides `HOME` only when the
  real `~/.claude.json` is ABSENT; it is present here, so the test takes the permissive `else` arm at
  `:277-281` asserting the layer is *one of* `['omitted','claude_json_fallback']` — true pre-fix and
  post-fix. **This test cannot fail for this bug on the operator's machine.** Adopt the deterministic
  pattern that already exists in the sibling file: `withEmptyHome` (`tests/worker-mcp-merge.test.js:57-69`,
  used unconditionally at `:289-298`). Remove the host branch.

## 3. Explicit rulings (the PRD rules; the worker does not)

- **Layer 1 is IN SCOPE.** The two analysts split on silent-vs-loud degradation. Ruling: validate layer
  1 with the same predicate, **warn at higher prominence** (AC-6), and **continue**. Silently ignoring
  an explicit operator instruction is the fake-green class this codebase keeps paying for; halting on
  it violates the PRIME DIRECTIVE. Warn loudly, degrade, never stop.
- **TOCTOU is accepted, not engineered around.** `~/.claude.json` is rewritten by Claude Code itself
  (mtime moved twice during refinement). A transient parse failure degrades to `omitted` for that
  spawn, must be warned (AC-6), and must never halt (AC-3).
- **Parse cost: accepted, memoize per process.** The file measured 82,650 bytes / 60 keys here and
  grows. The resolver moves from `existsSync` to read+parse and fires per worker and per analyst spawn.
  Parse once per process and memoize on the resolved path; do not add a cache invalidation mechanism.
- **The AC-8 trap-door prose in `extension/src/services/CLAUDE.md:13` is STALE.** It documents
  `opts.mcpConfig ?? resolveMcpConfigPath(...)`, which the code no longer has — both builders now use
  `resolveSpawnMcpConfig` (`:545`, `:562`), which is what produces the `session_merged` label. Its
  machine-checkable clause is only the `'--mcp-config'` literal. **Do not "restore" the documented
  shape** — that discards the `layer` binding and mislabels every session-merged spawn.
- **Poisoned-ledger recovery is OUT OF SCOPE, and is a documented residual.** Repeated 5-second spawn
  deaths drive `bounded_terminal_escape_cap` (default 3) via the persisted `state.recovery_attempts`
  ledger, which deliberately survives `--resume` (`mux-runner.ts:7010-7066`). Deploying the fix does
  not un-poison that ledger; a resumed session keeps its Skipped tickets. **Do not build ledger-clearing
  machinery** — that is new abort-adjacent complexity against a subtractive bundle. Record it as an
  operator note: a session poisoned by this bug should be started fresh, not resumed.
- **Do NOT restore `~/.claude.json.bak.pickle-2026-08-20`.** Measured: the backup holds **2** project
  entries against the live file's **72**. If the workaround is ever reverted it must be surgical
  (`jq 'del(.mcpServers)'`), never a `cp` of the backup. Better: never touch the host — verify by
  injected `homeDir` (AC-4/AC-10).

## 4. Non-goals

Changing the precedence ORDER. Adding a config-repair or migration path. Un-poisoning
`state.recovery_attempts`. Editing `pickle_settings.json`. Rewriting the AC-8 trap-door prose beyond
noting it is stale. Any new `exit_reason` or halt condition.

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Over-strict validator rejects valid configs; every AC still passes | AC-7 pins the happy path |
| R2 | Simplify deletes the now-"redundant" `setup.ts:1820` guard | AC-8 pins both call sites |
| R3 | A second divergent copy of the predicate ships | AC-1 mandates one exported helper |
| R4 | Bundle looks red because 3 existing tests pin the bug | AC-9 repairs them in the same ticket |
| R5 | Headline assertion never executes on the operator's host | AC-10 adopts `withEmptyHome` |
| R6 | Worker "repairs" the builders to the stale trap-door shape | Ruled explicitly in §3 |
| R7 | Fix verified by "the session survived" — proves nothing | §1 + AC-4 mandate injected `homeDir` |
| R8 | Doc ticket deadlocks on a Worker Forbidden Op | AC-5 targets `CLAUDE.md` only |

## 6. Assumptions

- `os.homedir()` honors `HOME` on this platform (verified: darwin returns the override).
- `claude`'s MCP config schema (record required, array rejected, empty record accepted) is stable; it
  was measured directly rather than read from docs.
- `install.sh` MANAGED_KEYS will not stomp `CLAUDE.md` (verified: it touches only four settings keys
  in the deploy prefix).

## 7. Ticket decomposition

`complexity_tier: medium` — unanimous across all three analysts. Touches the spawn path for every
worker, analyst and manager; spans two source files, two test files and one doc. Tier `small` skips
`test:fast` entirely, which is exactly where the inverted assertions live.

| # | ticket | scope | ACs |
|---|---|---|---|
| 1 | Extract `hasMcpServersRecord` and hoist it into both resolver layers | `backend-spawn.ts`, `setup.ts` | AC-1, AC-2, AC-8 |
| 2 | Parametrized resolver matrix over an injected `homeDir` | `tests/services/backend-spawn-mcp.test.js` | AC-4, AC-7, AC-9 |
| 3 | Once-per-process degradation warning on a skipped layer | `backend-spawn.ts` | AC-3, AC-6 |
| 4 | Un-fake the builder seam with `withEmptyHome` | `tests/services/backend-spawn-mcp.test.js` | AC-10 |
| 5 | Correct the `null` semantics doc | `CLAUDE.md` | AC-5 |
| 6 | Closer: full release gate, residual log for the two manager-owned items | — | — |

Tickets 1 and 3 share `backend-spawn.ts`; 2 and 4 share one test file. Sequence 1 → 3 and 2 → 4 to
avoid scope-fence contention; 5 is independent.

## 8. Simplification Review

1. **Necessary?** Yes — a fresh install is non-functional and the failure reads as a spawn storm.
2. **Reuse?** Yes, and more than the `omitted` arm: the record predicate already ships at
   `setup.ts:1820`; this bundle hoists it to the choke point and shares it. The warning reuses the
   degradation idiom at `:490`/`:503`. The test fix reuses `withEmptyHome` from a sibling file.
3. **Guards brittle complexity?** It removes a divergence rather than adding a guard.
4. **Subtracts?** Three things: one silent failure mode with no diagnostic, one duplicated predicate
   that could drift, and one fake-green test seam.
