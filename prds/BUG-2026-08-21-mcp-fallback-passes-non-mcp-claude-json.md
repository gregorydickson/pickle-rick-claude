> **✅ SHIPPED 2026-08-24 as v2.1.0-beta.13 — CLOSED, not drainable.** Full pipeline 4/4,
> `exit_reason: converged`, 769m 58s, session `2026-08-23-6fa67c68`, 21 commits, release gate green
> modulo the two filed inherited failures. The refined PRD (10 ACs, explicit rulings, risk register,
> 6-ticket decomposition) is `BUG-2026-08-21-mcp-fallback-REFINED.md`; the SHIP STATE entry at the top
> of `MASTER_PLAN.md` carries the gate evidence and the anatomy-park harvest.
>
> Landed: `e040828a` hoist `hasMcpServersRecord` into BOTH layers (memoized) · `56542ad8` +
> `ef5bdb91` once-per-process degradation warning · `bb158251` parametrized resolver matrix over an
> injected `homeDir` · `921aa083` un-fake the builder seam with `withEmptyHome`.

# BUG-2026-08-21 (P0) — the MCP fallback hands `claude` a file that is not an MCP config, killing every worker spawn

> **✅ STALE-PREMISE CHECK PASSED — re-measured 2026-08-23 at HEAD `d75bd524`, both trees.** The
> mechanism named by this PRD (not merely its R-code) is live and identical in source and deployed:
>
> | tree | site | code |
> |---|---|---|
> | source | `extension/src/services/backend-spawn.ts:366` | `if (existsSilently(claudeJson)) return { path: claudeJson, layer: 'claude_json_fallback' };` |
> | deployed | `~/.claude/pickle-rick/extension/services/backend-spawn.js:266` | identical |
>
> Existence-only, no `mcpServers` inspection, in both. Reproduced live against synthetic configs:
> a file WITHOUT `mcpServers` yields `Invalid MCP configuration: mcpServers: Invalid input: expected
> record, received undefined`; `{"mcpServers":{}}` yields `ok`.
>
> **One authored sentence is measurably wrong and refinement should not be misled by it.** The PRD says
> *"the `mcpServers` key only appears once a user-scoped MCP server is configured."* Measured on this
> host: `~/.claude.json` has `mcpServers` **present as an object with ZERO servers**. So key-presence is
> NOT equivalent to a-server-was-configured, and this host therefore does **not** reproduce the bug —
> its fallback passes a valid-but-empty config. That is consistent with the PRD's fresh-machine framing
> and does not weaken it; it sharpens the discriminator. The ACs already encode the right one
> (**AC-1** tests `mcpServers` is a *record*, and **AC-4** requires present-with-empty to be covered) —
> note that present-with-empty must resolve to the **path**, since `claude` accepts it; only
> absent/malformed resolve to `omitted`.
>
> **✅ GREEN-TREE CHECK PASSED — baseline recorded before launch.** `npm run test:fast` from
> `extension/`, interpreter pinned to node 24.19.0 (the 22.x line cancels ~38 tests on this host and
> would have manufactured a false red):
>
> ```
> tests 7872 · suites 518 · pass 7865 · fail 1 · cancelled 0 · skipped 5 · todo 1 · 172.8s
> ```
>
> The single failure is `install.sh bun probe > bun probe emits banner when bun is absent` — the
> long-filed inherited P3 (`BUG-2026-08-21-bun-probe-path-filter-misses-homebrew.md`), which fails
> BECAUSE bun is installed at `/opt/homebrew/bin` where its substring `PATH` filter cannot see it.
> **Recorded as inherited.** `cancelled 0` and the count matches the last recorded baseline exactly, so
> any OTHER fast-tier failure appearing during this bundle is caused by this bundle.

> **Everything else here is authored, not measured** — treat the layer-precedence narrative and the
> `worker_mcp_config_path: null` claim in AC-5 as leads for refinement to establish, not as findings.

## Status
Open. Found 2026-08-21 while launching `BUG-2026-08-20`. **Severity above that bundle**: on a machine
where the operator has never configured a user-scoped MCP server, EVERY worker and analyst spawn dies
instantly and the run produces nothing.

## What happens
All three refinement analysts died in ~5 seconds, cycle 1, identical error:

```
Error: Invalid MCP configuration:
mcpServers: Invalid input: expected record, received undefined
```

`resolveMcpConfigWithLayer` (`extension/src/services/backend-spawn.ts`) has precedence:
1. `settingsBag.worker_mcp_config_path`, 2. **`~/.claude.json` if present**, 3. omit.

Layer 2 passes `~/.claude.json` whenever the file EXISTS, without checking it contains `mcpServers`.
Claude Code always creates that file (it holds `numStartups`, `installMethod`, `tipsHistory`, ...);
the `mcpServers` key only appears once a user-scoped MCP server is configured.

Reproduced directly:
```
$ claude --mcp-config ~/.claude.json -p "say ok"
Error: Invalid MCP configuration: mcpServers: Invalid input: expected record, received undefined
$ echo '{"mcpServers":{}}' > /tmp/m.json && claude --mcp-config /tmp/m.json -p "say ok"
ok
```

## Impact
A fresh install is non-functional and gives no usable diagnostic — the failure reads as a spawn storm
(all workers dead in seconds), not a config error. `worker_mcp_config_path: null` is documented as
"no MCP forwarding", but null does NOT mean omit: it falls through to layer 2.

## Acceptance criteria
- **AC-1** Layer 2 is taken ONLY when `~/.claude.json` parses AND `mcpServers` is a record. Otherwise
  resolution falls through to `omitted`.
- **AC-2** A malformed / unreadable / `mcpServers`-less `~/.claude.json` resolves to `omitted`, never
  to a path — and the chosen layer is logged truthfully (C7/AC5 names the winning layer).
- **AC-3** No new halt path. A bad user config degrades to `omitted`; it does not fail the spawn.
- **AC-4** Tests cover: absent file, unparseable file, present-without-`mcpServers`, present-with-empty
  `mcpServers`, present-with-servers. Each asserts the resolved layer.
- **AC-5** `worker_mcp_config_path: null` semantics documented accurately (it does NOT mean omit today).

## Non-goals
Changing MCP forwarding policy. Adding a new setting. Writing to `~/.claude.json` from the runtime.

## Simplification Review
1. **Necessary?** A validation guard on an existing branch — no new mechanism.
2. **Reuse?** Yes: the `omitted` arm already exists; this only routes to it correctly.
3. **Guards brittle complexity?** It CORRECTS a brittle assumption (file-exists implies valid MCP
   config). The subtraction is the unchecked assumption, not a new hatch.
4. **Subtracts?** One silent failure mode with no diagnostic.

## Workaround applied 2026-08-21 (operator machine only, NOT a fix)
Added an empty `mcpServers` key to `~/.claude.json`; backup at `~/.claude.json.bak.pickle-2026-08-20`.
