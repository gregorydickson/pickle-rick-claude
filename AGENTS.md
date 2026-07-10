# ⛔ STOP — Worker Forbidden Ops (R-WSRC)

You're a worker inside pickle-rick-claude (meta-tool: runtime modifies itself). Runtime hooks block these writes — bypass attempts (incl. `>`, `tee`, `node -e fs.writeFileSync`) fail loud. Your `--add-dir` flags are NOT carte blanche.

| Forbidden | Override flag (if any) |
|---|---|
| `state.json` / `state.json.tmp.*` (any session) | `allow_state_writes_reason` (schema migration only) |
| `LATEST_SCHEMA_VERSION` bump in `types/index.ts` / `.js` | schema-migration ticket + `_internalSchemaBump` |
| `pickle_settings.json` / `.tmp.*` | `allow_settings_writes_reason` |
| `circuit_breaker.json`, `pipeline-status.json` / `.tmp.*` | none |
| `bash install.sh` | none |
| `~/.claude/pickle-rick/**` | none |
| Other tickets' dirs | none |
| `spawnSync`/`spawn` without `timeout` | per-callsite |
| Orchestrator tokens (`EPIC_COMPLETED`, `TASK_COMPLETED`, `PRD_COMPLETE`, `TICKET_SELECTED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, `ANALYSIS_DONE`) | none — emit ONLY `<promise>I AM DONE</promise>` |

If your ticket seems to require one: STOP. Wrong scope OR override flag missing. Mark Skipped with `skipped_reason: "requires <flag> not set"`.

PRD: `prds/archive/bundles/p1-worker-source-state-recursion-contamination.md`.
