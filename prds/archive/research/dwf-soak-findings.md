---
title: R-DWF-3-SOAK — Live soak findings for workflow refine path
verdict: FAIL
soak_run_date: 2026-06-01
workflow: .claude/workflows/refine-analyze.js
input_prd: prds/archive/bundles/p2-bug-fix-bundle-b-ppcd-pipeline-citadel-phase-list-drift.md
cycles_requested: 1
agents_spawned: 10
duration_ms: 737851
error: "TypeError: agent({schema}) received an invalid JSON Schema: unknown format \"date-time\" ignored in schema at path \"#/properties/completed_at\""
---

# R-DWF-3-SOAK — Soak Findings

> **Verdict: FAIL** — The workflow refine path cannot be used as a drop-in replacement for the legacy subprocess path until the `ManifestSchema` `format: "date-time"` issue is resolved. R-DWF-3 and R-DWF-6 are NOT started. P3 PRD (`prds/archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md`) shelved per AC-SOAK-3.

## Soak results

| Check | Expected | Observed | PASS/FAIL |
|---|---|---|---|
| analyses-count | 3 (3 roles × 1 cycle) | 0 files written to `soak/refinement/` | FAIL |
| manifest-validates | ajv exit 0; ≥1 ticket | No manifest produced (synthesis agent never executed) | FAIL |
| no-agent-errors | zero agent errors | TypeError in synthesis agent schema setup | FAIL |
| manifest-written | `soak/refinement_manifest.json` exists | File absent | FAIL |

## Root cause

The `ManifestSchema` in `.claude/workflows/refine-analyze.js` (line ~133) declares:

```js
completed_at: { type: 'string', format: 'date-time' },
```

The workflow agent runtime validates schemas via AJV before launching each agent. The AJV instance used by the runtime does **not** have the `date-time` format validator registered (requires `ajv-formats` or similar). This causes AJV to throw a `TypeError` when the synthesis agent's schema is submitted, preventing the synthesis agent from ever executing.

The 3 analyst agents (requirements, codebase, risk-scope) ran successfully (evidenced by `agent_count: 10` and `duration_ms: 737851`), but because the synthesis agent schema validation failed, no analysis files were written to disk and no manifest was produced.

## Error transcript

```
TypeError: agent({schema}) received an invalid JSON Schema: unknown format "date-time" ignored in schema at path "#/properties/completed_at"
    at C (/$bunfs/root/src/entrypoints/cli.js:3579:4858)
```

## Fix required before re-running soak

Remove or relax `format: 'date-time'` in `ManifestSchema` and `refinement-manifest.schema.json`:

```js
// Before:
completed_at: { type: 'string', format: 'date-time' },

// After:
completed_at: { type: 'string', minLength: 1 },
```

This is a one-line fix. File a new bug report (e.g. R-DWF-SCHEMA-FMT) and re-run the soak after the fix ships. Then re-evaluate P3 shelving.

## What worked

- Workflow machinery launched and ran 3 analyst agents in parallel.
- The `AnalysisSchema` (used by analyst agents) has no `format:` keywords and validated successfully.
- The parallel fan-out pattern (3 analysts × N cycles) is functional.
- The soak framework correctly detected the failure — no silent false-positive.
