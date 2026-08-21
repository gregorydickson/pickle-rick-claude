# BUG-2026-08-21 (P0) — the MCP fallback hands `claude` a file that is not an MCP config, killing every worker spawn

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
