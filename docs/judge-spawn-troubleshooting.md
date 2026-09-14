# Judge Spawn Troubleshooting

Operator reference for diagnosing and resolving LLM judge backend issues in the Pickle Rick microverse convergence loop.

---

## 1. Symptoms

| Symptom | Likely cause |
|---|---|
| `ETIMEDOUT` in iteration log | Judge CLI probe or measurement timed out (cold-start or network latency) |
| Hung judge — no output for >60 s | Nested-Claude stdin contamination (`CLAUDE_CODE`/`CLAUDECODE` env not stripped). R-SJET-3 strips these; confirm env isolation is in effect. |
| `[warn] judge probe timed out` in log | First availability probe timed out (`probeJudgeBackendAvailability`). Treated as non-fatal — runner falls through to measurement loop. |
| `judge_cli_missing` exit reason | `claude` binary not on PATH at judge spawn time. Install Claude Code CLI or set `PATH`. |
| `all_judge_backends_exhausted` exit reason | Primary AND fallback judge backends both failed typed measurement. See § 5 for pipeline routing. |
| `metric_unmeasurable_unrecoverable` exit reason | Measurement exhausted all retries with non-timeout failures. The `metric_unmeasurable` activity event's `gate_payload.phase` (and `phase:` in the runner log line) says whether it was the `baseline` or an `iteration` measurement. Runs before Z2 recorded this as `baseline_unmeasurable_unrecoverable` in either phase; that spelling is read as this reason. |

**Probe vs measurement distinction** (R-MJCP-8): `probeJudgeBackendAvailability` is a fail-fast existence check (≥5 s). Only `kind: 'missing'` (ENOENT-class) → `judge_cli_missing`. A probe timeout falls through to the measurement loop, so a slow cold-start does NOT kill the run.

---

## 2. Config Keys

All keys live under the `microverse` block in `pickle_settings.json`:

```json
{
  "microverse": {
    "judge_backend":          "claude",
    "judge_backend_fallback": "codex",
    "judge_model_claude":     "claude-sonnet-4-6",
    "judge_model_codex":      "gpt-5.4"
  }
}
```

| Key | Type | Valid values | Default | Effect |
|---|---|---|---|---|
| `judge_backend` | string | `"claude"` · `"codex"` · `"auto"` | `"claude"` | Primary judge backend selection |
| `judge_backend_fallback` | string | `"claude"` · `"codex"` | `"codex"` | Fallback when primary fails with typed error AND `judge_backend` is `"auto"` |
| `judge_model_claude` | string | any Claude model ID | `"claude-sonnet-4-6"` | Model passed to the claude CLI judge |
| `judge_model_codex` | string | any Codex model ID | `"gpt-5.4"` | Model passed to the codex CLI judge |

**Important**: `judge_model_claude` and `judge_model_codex` affect worker-iteration spawn model selection for the judge only. Worker spawns continue to honor `state.backend` / `state.worker_backend` independently.

Source: `extension/src/services/pickle-utils.ts:22-76` (`DEFAULT_MICROVERSE_SETTINGS`, `getMicroverseSettingsWithDefaults`).

---

## 3. Sticky Fallback Semantics

When `judge_backend` is `"auto"` and the primary backend (`claude`) fails with a **typed** measurement error (e.g. ETIMEDOUT after 4-attempt backoff), the runner:

1. Writes `state.judge_backend_resolved = "codex"` (the fallback value from `judge_backend_fallback`).
2. On subsequent iterations within the same session, `resolveJudgeBackend()` reads this breadcrumb and routes all judge spawns to the fallback — skipping re-probe of the primary.
3. The breadcrumb **persists across mux-runner iterations** within the same session state file.
4. It is **cleared on session reset** (new session init) or manually (see § 4).

If `judge_backend` is `"claude"` or `"codex"` (not `"auto"`), sticky fallback is bypassed entirely — the setting is the final answer.

Source: `extension/src/services/pickle-utils.ts:600-621` (`resolveJudgeBackend`); `extension/src/types/index.ts` (`judge_backend_resolved` field invariant).

---

## 4. Operator Force-Reprobe Recipe

To clear the sticky fallback breadcrumb and force the runner to re-probe the primary backend on the next iteration:

```bash
# 1. Stop the pipeline first (Ctrl-C or /eat-pickle)

# 2. Locate state.json for your session
SESSION_DIR=~/.local/share/pickle-rick/sessions/<date-hash>
STATE=$SESSION_DIR/state.json

# 3. Clear the sticky breadcrumb
jq 'del(.judge_backend_resolved)' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"

# 4. Resume
/pickle-tmux --resume
```

> **Note**: Do NOT edit `state.json` while the pipeline is running — the state manager uses atomic tmp-rename writes that will overwrite manual edits. Always stop the pipeline before editing.

---

## 5. Exit-Reason Mapping

Pipeline routing introduced by commit `5a25ef7b` (ticket `23393a69`):

| `MicroverseExitReason` | Pipeline action | Outcome |
|---|---|---|
| `judge_timeout` | `run-finalize-gate` | Finalize gate runs on converged work; continue or halt by gate exit code |
| `all_judge_backends_exhausted` | `run-finalize-gate-incomplete` | Gate pass → `reportPhaseIncomplete` (exit 3, auto-resume eligible via R-CNAR); gate fail → exit 1 |
| `judge_cli_missing` | `run-finalize-gate-incomplete` | Parks and reports; success withheld (no longer a fatal abort) |
| `metric_unmeasurable_transient` | `run-finalize-gate-incomplete` | As above (legacy spelling `baseline_unmeasurable_transient` reads as this) |
| `metric_unmeasurable_unrecoverable` | `run-finalize-gate-incomplete` | As above (legacy spellings `baseline_unmeasurable` / `baseline_unmeasurable_unrecoverable` read as this) |
| `judge_unreachable` | Failure exit | `isMicroverseFailureExit` → pipeline failure |

**`all_judge_backends_exhausted` recovery path** (R-SJET-4):

When both primary and fallback backends fail typed measurement:
- `mapJudgeMeasurementFailure` returns `'all_judge_backends_exhausted'`
- `classifyMicroverseHaltDecision` maps this to action `'run-finalize-gate-incomplete'`
- `runAllBackendsExhaustedFinalizeGate` runs the finalize gate; on pass it calls `reportPhaseIncomplete` (exit code 3) so `auto-resume.sh` can retry the phase

Exit code 3 triggers `PipelineRunnerExitCode.PhaseIncomplete`, which means `auto-resume.sh` will attempt to re-run the phase (R-CNAR-4 stop conditions still apply).

Activity event emitted during recovery: `pipeline_all_backends_exhausted_recovery_attempted` (added in `5a25ef7b`).

Source: `extension/src/bin/pipeline-runner.ts`, `extension/src/types/index.ts:835-856`.
