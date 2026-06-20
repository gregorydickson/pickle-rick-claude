# P1 — R-HCAG · Hallucinated Conformance Attestation Gate (Refined)

*(refined: requirements + codebase + risk-scope analysts, cycles 1-3, 2026-05-18)*

**Status**: Refined 2026-05-18 AM (CDT) — successor to Finding #2 (codex Done-without-commit) class.

**Trigger**: B-SJET ticket `f00097e8` (session `2026-05-17-6ff53ea2` iter 7) marked Done with PASS conformance citing `readJudgeBackendSettings()` at `extension/src/services/backend-spawn.ts:511-585`, `JudgeBackend` types at `extension/src/types/index.ts:146-149`, and shipped defaults at `pickle_settings.json:30-37` — **none of those symbols/lines exist at HEAD**, zero commits attributed. Finding #47 R-SJET stayed OPEN despite ALL_PASS.

**Hallucination is triple-layer (codebase analyst cycle 3 verified)**:
1. Wholly fake symbols (`readJudgeBackendSettings`, `JudgeBackend`, `JudgeBackendMode` — absent everywhere)
2. REAL symbols cited at hallucinated line ranges (`buildJudgeInvocation` cited at `backend-spawn.ts:511-585`, actual at line 433; `measureLlmMetricAttempt` cited at `microverse-runner.ts:1487-1513`, actual at line 1722)
3. Markdown section headers (`## Acceptance Criteria`, `## Solution`, etc.) appearing inline as backticked-looking tokens — parser must exclude or false-positive

**Root cause**: mux-runner's between-ticket gate trusts worker `conformance_*.md` prose self-attestation. No mechanical check that citations correspond to symbols actually present in the diff between `state.start_commit` (or previous ticket's `completion_commit`) and HEAD.

**Class history**: Finding #2 (R-CCPL successor) closed 2026-05-15. Recurred 2026-05-17 PM on B-CCPM-1b (2/3 tickets) + B-SJET (1/3 — the highest-stakes ticket). Prose-only safeguard insufficient.

## Reproducer

1. Spawn worker on any P1 bundle.
2. Worker writes minimally-plausible `conformance_2026-05-XX.md` with `## Verdict\nALL_PASS` + prose citations to symbols that don't exist.
3. Worker exits without `git commit`.
4. Manager treats `## Verdict ALL_PASS` as sufficient evidence; mux-runner flips ticket Done; epic completes.
5. PRD reproducer still fails at HEAD; bookkeeping reports ✅ SHIPPED.

## Goal

Mechanical gate between worker exit and ticket-Done that proves conformance citations correspond to actual diff content. Worker self-attestation alone never closes a ticket. Closure requires (a) non-null `completion_commit` on ticket frontmatter from `hasCompletionCommit({...}).source === 'explicit'` AND (b) every cited file/symbol resolving against the diff window via grep-on-diff-hunk-line, AND (c) `## Diff Evidence` section presence on PASS/ALL_PASS verdicts, AND (d) no unsanctioned `completion_commit_auto_filled` event in `state.activity[]`.

## Critical User Journeys (CUJs)

**CUJ-HCAG-01 — Worker authoring**: Worker completes implementation, runs `git diff --stat <state.start_commit>..HEAD`, pastes the file list as `## Diff Evidence`, writes conformance citing only files/symbols visible in own diff, commits. Gate passes; ticket flips Done. *(refined: requirements cycle 2)*

**CUJ-HCAG-02 — Operator halt recovery**: Worker writes hallucinated conformance. Gate halts mux-runner with `conformance_citation_drift`. Operator inspects stderr line, reads `<session_dir>/<id>/conformance_*.md`, decides: (a) reject + retry the ticket, or (b) bypass via operator-only `state.flags.skip_conformance_citation_audit_reason='<allowlist-reason>' + ..._signed_by=<principal>'` for a legitimate exemption. Workers/managers MUST NOT set the bypass — operator-only edit per R-WSRC. *(refined: requirements cycle 2 + risk-scope cycle 3)*

**CUJ-HCAG-03 — Closer replay**: Closer iteration runs the gate with relaxed citation policy (version-bump diffs lack semantic symbols). Closer MUST replay the snapshotted `f00097e8-hallucinated-2026-05-17.md` fixture against the deployed gate (post-`bash install.sh`, post-MD5-parity, pre-`gh release create`), observe `exit_reason === 'conformance_citation_drift'`, emit `e2e_replay_passed`. Replay non-halt → abort with `closer_e2e_replay_failed`. *(refined: risk-scope cycles 2-3)*

**CUJ-HCAG-04 — Multi-ticket bundle halt recovery + refinement self-audit**: After ticket N halts, operator bypasses, re-runs; ticket N+1's `baseRef` resolution skips ticket N (whose `exit_reason !== 'success'`) and walks earlier in bundle order until a clean-exit ticket is found. Refinement analyst for R-HCAG-* tickets MUST end every plan with a `## Citation Self-Audit` block per R-RTRC-7; readiness gate blocks Approved on unresolved `path_not_verified`. *(refined: risk-scope cycle 3)*

## Closer-Iteration Scope

The citation gate RUNS on closer iterations with relaxed citation policy. Closer iterations CANNOT bypass the gate.

- `baseRef` = bundle's FIRST implementation ticket's `completion_commit` (closer is last).
- Closer conformance MUST cite (a) `extension/package.json` (version bump line in diff), (b) `prds/MASTER_PLAN.md`, (c) at least one source file in `extension/src/**/*.ts` whose compiled mirror in `extension/**/*.js` was rebuilt by `bash install.sh`.
- Symbol-grep is OPTIONAL for closer (version-bump diffs lack semantic symbols); file-existence + diff-presence + `## Diff Evidence` section presence are mandatory.
- Closer iteration MUST replay the snapshotted `f00097e8-hallucinated-2026-05-17.md` fixture per CUJ-HCAG-03.
- Allowlist for `state.flags.skip_conformance_citation_audit_reason` is `{schema-migration, docs-only-ticket, shallow-clone-baseref}`. **`closer-recovery` is NOT on the allowlist** — closer must produce a valid conformance under the relaxed policy.

## Proposed fix (R-HCAG-0..8)

### R-HCAG-0 — Fixture snapshot prerequisite *(refined: risk-scope cycle 3)*

Snapshot the literal f00097e8 hallucinated conformance text into a committed fixture: `extension/tests/fixtures/conformance/f00097e8-hallucinated-2026-05-17.md`. Source: `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-17-6ff53ea2/f00097e8/conformance_2026-05-17.md`. Required by R-HCAG-1 unit tests, R-HCAG-6 e2e replay, closer CUJ-HCAG-03.

ENFORCE: `extension/tests/fixtures/conformance/f00097e8-hallucinated-2026-05-17.md` exists and contains text matching the original session file byte-for-byte at the cited section boundaries.

### R-HCAG-1 — Conformance citation parser (`extension/src/services/conformance-citations.ts`) *(refined: requirements + codebase + risk-scope cycles 1-3)*

New service. Public function:

```ts
parseConformanceCitations(text: string): {
  citations: Citation[];
  hasDiffEvidenceSection: boolean;
  verdict: 'ALL_PASS' | 'PASS' | 'FAIL' | 'UNKNOWN';
}

type Citation = {
  filePath: string;       // e.g., "extension/src/services/backend-spawn.ts"
  lineRange?: [number, number];  // e.g., [511, 585]; lower-bound used for proximity check
  symbols: string[];      // backticked symbol tokens associated with this file/range
  cellContext?: string;   // table-cell raw text if extracted from a table cell
}
```

Extraction rules:
1. Backticked file paths matching `extension/<...>`, `src/<...>`, or top-level repo paths (`prds/`, `docs/`, `package.json`, `pickle_settings.json`, etc.).
2. Optional `:<line>` or `:<line>-<line>` ranges. Multi-range per file emits ONE citation per range (no merge/drop). *(refined: requirements cycle 3 P0 #3)*
3. Symbol names from surrounding prose: backticked tokens within the same sentence or markdown-table-cell. *(refined: requirements cycle 3 P0 #5)* When inside a `|`-delimited table cell, all backticked symbol tokens associate with all path-with-range tokens in the same cell (Cartesian; one-to-one is the degenerate case).
4. **Exclude markdown headers from symbol extraction**: parser regex MUST discard backticked tokens that match `/^##+\s/` or contain `## ` prefix. *(refined: codebase cycle 3 NEW P0)*
5. Cap: 50 citations per file, 200 per document. *(refined: codebase cycle 3 P2)* Exceed → trim with `parser_citation_cap_exceeded` warning.
6. Treat absent citations as hard failure when verdict ∈ {ALL_PASS, PASS}: PASS-without-citations is invalid (verifier returns `ok: false, reason: 'no_citations_in_pass_verdict'`).
7. `hasDiffEvidenceSection === true` iff a level-2 heading matching `/^##\s+Diff\s+Evidence\s*$/m` appears in the conformance text.

ENFORCE: `extension/tests/services/conformance-citations.test.js` — covers:
- f00097e8 fixture yields 12+ citation entries (full enumerated set from requirements cycle 3 P0 #4)
- Multi-range citations within one cell emit multiple entries
- Markdown `##` headers yield ZERO citations
- Cap exceeded emits warning
- Table-cell Cartesian association

### R-HCAG-2 — Citation/diff verifier (`extension/src/services/citation-diff-verifier.ts`) *(refined: all analysts)*

Public function:

```ts
verifyCitationsAgainstDiff(opts: {
  sessionDir: string;
  ticketId: string;
  citations: Citation[];
  baseRef: string;   // resolved 40-char SHA, NOT symbolic
  headRef: string;   // resolved 40-char SHA, ONCE per gate invocation
  perCallTimeoutMs?: number;  // default 10_000
  perGateBudgetMs?: number;   // default 60_000
}): {
  ok: boolean;
  missing: Citation[];
  reason: 'ok' | 'no_citations_in_pass_verdict' | 'missing_diff_evidence_section'
    | 'symbol_absent' | 'symbol_line_range_drift' | 'line_range_drift'
    | 'baseref_unresolvable' | 'gate_timeout' | 'auto_filled_completion_commit_unsanctioned';
  evidence: { resolved_base: string; resolved_head: string; per_citation: Array<{citation: Citation; status: 'ok'|'missing_file'|'missing_symbol'|'line_drift'|'symbol_line_drift'; matched_lines?: number[]}>; };
}
```

For each citation:
1. `git diff --name-only <baseRef>..<headRef>` MUST include the cited file (unless cited file is `D`-deleted, in which case `git diff --name-status` reports D → accepted).
2. `git show <headRef>:<file>` MUST succeed.
3. **Symbol presence + proximity**: each cited symbol MUST appear in `git show <headRef>:<file>` AS AN ADDED LINE in `git diff <baseRef>..<headRef> -- <file>` (`+` lines only — not file content alone, prevents context-line false positives). *(refined: risk-scope cycle 3 R3 + codebase cycle 3)*
4. **Line-range proximity**: when `lineRange.lower` is set, `grep -nE '\b<symbol>\b'` on `git show <headRef>:<file>` MUST emit ≥1 match within `[lineRange.lower - 25, lineRange.lower + 25]`. Outside range → `symbol_line_range_drift`. *(refined: codebase cycle 3 NEW P0)*
5. **Line-range drift**: when cited file IS in diff but cited line range contains unrelated content (file is real, range is hallucinated) → `line_range_drift`. *(refined: codebase cycle 3 P2)*
6. **Missing diff-evidence section**: when verdict ∈ {ALL_PASS, PASS} AND `hasDiffEvidenceSection === false` AND no bypass-allowlist reason → `missing_diff_evidence_section`.

**baseRef precedence** *(refined: risk-scope cycle 3 NEW P0 #4)*:
1. For ticket N, walk previous bundle tickets N-1 → 1; return the first whose final `exit_reason === 'success'` AND `completion_commit` is non-null AND `hasCompletionCommit({...}).source === 'explicit'`.
2. If no such ticket exists → `state.start_commit`.
3. If `state.start_commit` is null (legacy session) → backfill via `git rev-list --max-parents=0 HEAD` (first repo commit); emit `conformance_start_commit_backfilled`.
4. **DROP `HEAD~10` entirely** *(refined: codebase cycle 3 + risk-scope cycle 2-3)*.
5. Each skip emits `conformance_baseref_skipped_halted_ticket` with `{skipped_ticket_id, last_exit_reason, last_completion_commit_source}`.
6. If resolved baseRef fails `git rev-parse` (sandbox/shallow-clone class) → halt with `conformance_baseref_unresolvable`.

**Subprocess discipline**: every `spawnSync('git', ...)` passes `timeout: perCallTimeoutMs` (10s default). Cumulative across gate ≤ `perGateBudgetMs` (60s default) — exceed → `conformance_gate_timeout`.

**Manager-handoff lane ordering**: citation gate runs FIRST (Order A); the existing `hasManagerHandoff` short-circuit at `mux-runner.ts:2443-2464` runs AFTER, only on citation-gate PASS. *(refined: requirements cycle 3 NEW P0 #1)*

ENFORCE: `extension/tests/services/citation-diff-verifier.test.js` + `extension/tests/mux-runner-baseref-skips-halted-tickets.test.js`.

### R-HCAG-3 — mux-runner integration (`extension/src/bin/mux-runner.ts`) *(refined: all analysts)*

After worker exits but BEFORE flipping `ticket.status = "Done"` (and BEFORE the `hasManagerHandoff` short-circuit):

1. Read `conformance_*.md` (latest) from ticket dir via new `readLatestTicketConformanceText` sibling reader. *(refined: codebase cycle 2 P0)*
2. Call `parseConformanceCitations` → `verifyCitationsAgainstDiff`.
3. Cross-check `state.activity[]` for `completion_commit_auto_filled` entries with `ticket_id` matching current ticket. If present without sanctioned allowlist → halt (see R-HCAG-4 below).
4. On failure: emit-record-deactivate ordering MUST be **exactly**:
   ```ts
   logActivity(statePath, {
     event: 'conformance_citation_drift',
     source: 'pickle',
     ticket_id,
     gate_payload: { missing_files, missing_symbols, base_ref, head_ref, reason },
   }); // logActivity auto-stamps ts; avoids R-WSE-2 manual-ts divergence class
   process.stderr.write(`[fatal] ${new Date().toISOString()} ticket ${ticket_id} conformance cited ${missing.length} file(s)/symbol(s) absent from diff ${resolved_base}..HEAD: ${missing.map(c=>c.filePath).join(', ')} — see ${sessionDir}/${ticket_id}/conformance_*.md\n`);
   recordExitReason(statePath, 'conformance_citation_drift');
   safeDeactivate(statePath);
   ```
   *(refined: risk-scope cycle 3 NEW P1)*
5. **Bypass-flag semantics** (operator-only edit per R-WSRC):
   - `state.flags.skip_conformance_citation_audit_reason` ∈ `{schema-migration, docs-only-ticket, shallow-clone-baseref}` (closer-recovery REJECTED with `conformance_bypass_invalid_reason`). *(refined: risk-scope cycle 3 NEW P0 #2)*
   - Companion: `state.flags.skip_conformance_citation_audit_signed_by` (non-empty principal).
   - Ticket-scoped: `state.flags.skip_conformance_citation_audit_ticket_id`.
   - Emit `conformance_citation_audit_bypassed` exactly once per `(session, ticket)` pair via persisted markers `state.flags.conformance_citation_audit_bypassed_emitted_for_ticket` + `..._emitted_at`. NO closure-flag-in-memory approach (auto-resume.sh re-execs lose closures). *(refined: codebase cycle 3 NEW P0)*
6. `docs-only-ticket` auto-detect: gate inspects `git diff --name-only <baseRef>..<headRef>`; if all paths match `^(docs/|.*\.md$|.*\.txt$|CHANGELOG$|MASTER_PLAN\.md$)`, gate auto-applies docs-only exemption (skips symbol-grep + section-presence requirement). Mismatch between auto-detect and operator-set `docs-only-ticket` → `conformance_bypass_invalid_reason`. *(refined: risk-scope cycle 3 NEW P1)*

Register `conformance_citation_drift` in:
- `mux-runner.ts:2419` `ExitReason` union
- `mux-runner.ts:2421` `isHaltExit` body
- `mux-runner.ts:2422` `isFailureExit` body

Auto-resume.sh stops on `exit_reason !== 'pipeline_phase_incomplete'` per R-CNAR-4(c) (no auto-resume.sh edit needed).

ENFORCE: `extension/tests/mux-runner-conformance-citation-gate.test.js` (citation-valid → Done; missing-file → halt; symbol-absent → halt; line-range-drift → halt; missing-diff-evidence → halt; bypass-flag → skip + event; docs-only auto-detect; manager-handoff ordering).

### R-HCAG-4 — Completion-commit + auto-fill enforcement (`extension/src/services/git-utils.ts` + mux-runner cross-check) *(refined: all analysts)*

`ticket.status = "Done"` MUST require non-null `completion_commit` AND `hasCompletionCommit({...}).source === 'explicit'` AND no unsanctioned auto-fill.

Gate logic:
1. Refuse Done when `hasCompletionCommit({...}).source !== 'explicit'` (both `'inferred'` and `'absent'` halt).
2. Read `state.activity[]` for `completion_commit_auto_filled` entries with matching `ticket_id` (event already registered at `extension/src/types/activity-events.schema.json:349`, emitted at `extension/src/bin/auto-fill-completion-commit.ts:92-99`).
3. If `completion_commit_auto_filled` present for current ticket:
   - Verify `git log <baseRef>..HEAD --grep=<ticket_id_short>` returns ≥1 commit (worker-attribution required); AND
   - Verify `state.flags.allow_completion_commit_autofill_for[<ticket_id>]` exists with `{reason ∈ {'schema-migration', 'closer-recovery'}, signed_by: <non-empty principal>}`.
   - Both pass → emit `completion_commit_autofill_gate_passed`; proceed.
   - Either fails → halt with `conformance_citation_drift` + `gate_payload.reason='auto_filled_completion_commit_unsanctioned'`.
4. Worker `git commit` writes `completion_commit` via `updateTicketFrontmatter`. `completion_commit_inferred` does NOT satisfy.

ENFORCE: `extension/tests/git-utils-ticket-frontmatter.test.js` (existing extension) + `extension/tests/auto-fill-completion-commit-gate.test.js` (forward-created) — auto-fill writes SHA, gate halts unless allowlist + worker-attribution match.

### R-HCAG-5 — Worker conformance template hardening (`.claude/commands/send-to-morty.md`) *(refined: requirements + risk-scope)*

Update the worker conformance template + manager send-to-morty prompt so workers know:
1. PASS verdict is conditional on `git commit` having landed AND every citation surviving R-HCAG-2 verification.
2. Workers MUST run `git diff --stat <state.start_commit>..HEAD` and paste the file list as a `## Diff Evidence` section.
3. Workers MUST NOT cite line numbers they did not personally observe in their own diff this iteration.
4. Hallucinated citations are a halt condition, not a retry condition.

ENFORCE: `extension/tests/send-to-morty-conformance-citation-guidance.test.js` — doc-only regression. Test MUST assert the following four literal substrings are present in `.claude/commands/send-to-morty.md`:
- `"PASS verdict is conditional on git commit having landed"`
- `"Hallucinated citations are a halt condition"`
- `` "Workers MUST run `git diff --stat`" ``
- `"Workers MUST NOT cite line numbers they did not personally observe"`

*(refined: codebase + requirements cycles 2-3 — exact literals required)*

### R-HCAG-6 — E2E replay against f00097e8 fixture *(refined: risk-scope cycle 3)*

End-to-end test: spawn a fake worker that writes the snapshotted f00097e8 conformance fixture, exits without commit, asserts mux-runner halts with `conformance_citation_drift` (NOT `manager_handoff_pending`) and does NOT flip ticket to Done.

ENFORCE: `extension/tests/integration/conformance-citation-gate-e2e.test.js` — manager-handoff ordering enforced (Order A); halt exit reason exact-match assertion.

### R-HCAG-7 — Activity event schema registration (atomic, medium) *(refined: codebase + risk-scope cycle 3)*

Promoted from hardening bullet to atomic ticket. For each new event:
- `conformance_citation_drift`
- `conformance_citation_audit_bypassed`
- `conformance_missing`
- `conformance_baseref_unresolvable`
- `conformance_gate_timeout`
- `conformance_bypass_invalid_reason`
- `completion_commit_autofill_gate_passed`
- `conformance_baseref_skipped_halted_ticket`
- `conformance_start_commit_backfilled`
- `e2e_replay_passed`
- `closer_e2e_replay_failed`

Register in 7 locations (R-PDD-oneOf trap door, codebase cycle 3 verified count):
1. `extension/src/types/activity-events.schema.json` `definitions[]`
2. Same file's `oneOf[]` array (definition-without-oneOf is iter-13 regression class)
3. `extension/activity-events.schema.json` deployed mirror (both definitions + oneOf)
4. `extension/src/types/index.ts` `VALID_ACTIVITY_EVENTS` const
5. `extension/types/index.js` deployed mirror (regenerated by `bash install.sh` per AC-RVN-08)
6. `extension/tests/activity-event-payload.test.js` `EVENT_CASES` table
7. `extension/src/bin/spawn-refinement-team.ts:148+` `ACTIVITY_EVENT_SCHEMA_SECTION` constant

Plus for `conformance_citation_drift` AND `closer_e2e_replay_failed`:
- `extension/src/bin/mux-runner.ts:2419` `ExitReason` union
- `mux-runner.ts:2421` `isHaltExit`
- `mux-runner.ts:2422` `isFailureExit`

ENFORCE: `extension/tests/conformance-citation-event-schema-conformance.test.js` (forward-created, follows iter-7..9 schema-conformance pattern).

### R-HCAG-8 — Closer (manager-owned residuals) *(refined: risk-scope cycle 3)*

Closer iteration (manager-owned):
1. `[manager]` bump `extension/package.json` + `extension/package-lock.json` patch +1 → e.g. 1.75.5.
2. `[manager]` commit `chore: bump version to 1.75.5` + `git push origin main` (immediately, anti-R-CSI).
3. `[manager]` `bash install.sh` (exit 0).
4. `[manager]` MD5 parity verify on 5 trafficked files.
5. `[manager]` regenerate compiled JS if drifted, commit + push.
6. `[manager]` update `prds/MASTER_PLAN.md` to mark B-HCAG ✅ SHIPPED v1.75.5 + close Finding #2 successor class; commit + push.
7. `[manager]` **REPLAY f00097e8 fixture** against deployed gate; assert `exit_reason === 'conformance_citation_drift'`; emit `e2e_replay_passed` with `{fixture_path, expected_halt_reason: 'conformance_citation_drift', observed_halt_reason, deployed_gate_md5}`.
8. `[manager]` `gh release create v1.75.5` only after replay passes.

If replay does not halt OR observed reason ≠ expected → abort with `closer_e2e_replay_failed`.

Closer conformance MUST cite per closer-iteration scope (above). Closer is GATED, not exempt.

## Acceptance criteria (expanded)

| ID | Criterion | Evidence | Type |
|---|---|---|---|
| AC-HCAG-01 | Parser returns the f00097e8 fixture's 12+ enumerated citation set with exact filePath+lineRange keys; verifier classifies the 5 hallucinated-line-range ones as MISSING. | Unit test against committed fixture. | test |
| AC-HCAG-02 | `verifyCitationsAgainstDiff` returns `ok: false, reason: 'symbol_absent'` when cited symbol is absent from `+` lines of `git diff <baseRef>..<headRef> -- <file>`. | Unit test. | test |
| AC-HCAG-03 | `verifyCitationsAgainstDiff` returns `ok: false, reason: 'symbol_line_range_drift'` when cited symbol exists in file but >25 lines from `lineRange.lower`. | Unit test. | test |
| AC-HCAG-04 | `verifyCitationsAgainstDiff` returns `ok: false, reason: 'line_range_drift'` when cited file is in diff but cited range contains unrelated content (real-file/hallucinated-range case). | Unit test. | test |
| AC-HCAG-05 | mux-runner emits `conformance_citation_drift` via `logActivity` BEFORE `recordExitReason` BEFORE `safeDeactivate` (verifiable order via activity log + state.json final write). | Integration test. | test |
| AC-HCAG-06 | mux-runner refuses Done when `hasCompletionCommit({...}).source !== 'explicit'`. | Unit test. | test |
| AC-HCAG-07 | mux-runner refuses Done when `completion_commit_auto_filled` is in `state.activity[]` for current ticket AND `state.flags.allow_completion_commit_autofill_for[<ticket_id>]` is absent/incomplete. | Unit test. | test |
| AC-HCAG-08 | Bypass-flag emits `conformance_citation_audit_bypassed` exactly once per (session, ticket) pair via persisted markers (survives auto-resume.sh re-exec). | Integration test. | test |
| AC-HCAG-09 | `closer-recovery` bypass reason is REJECTED with `conformance_bypass_invalid_reason`. | Unit test. | test |
| AC-HCAG-10 | Parser excludes markdown `##`-prefixed tokens from symbol extraction (f00097e8 fixture yields ZERO header-symbols). | Unit test. | test |
| AC-HCAG-11 | Parser emits ONE citation per `<filePath>:<range>` occurrence; multi-range per file yields multiple entries (not merged/dropped). | Unit test. | test |
| AC-HCAG-12 | Parser within markdown table-cell associates all backticked symbol tokens with all path-with-range tokens in the same cell (Cartesian). | Unit test. | test |
| AC-HCAG-13 | Parser caps at 50 citations/file, 200/document; exceed emits `parser_citation_cap_exceeded` warning. | Unit test. | test |
| AC-HCAG-14 | Parser+verifier require `## Diff Evidence` section presence on PASS/ALL_PASS verdicts; absence → `missing_diff_evidence_section` halt. | Unit test. | test |
| AC-HCAG-15 | `docs_only_ticket` auto-detect inspects `git diff --name-only`; mismatch between auto-detect and operator-set bypass reason → `conformance_bypass_invalid_reason`. | Integration test (3 scenarios). | test |
| AC-HCAG-16 | baseRef precedence walks previous bundle tickets, skipping those with `exit_reason !== 'success'`; each skip emits `conformance_baseref_skipped_halted_ticket`. | Integration test (3-ticket fixture). | test |
| AC-HCAG-17 | When `state.start_commit` is null, baseRef backfills via `git rev-list --max-parents=0 HEAD` and emits `conformance_start_commit_backfilled`. | Unit test. | test |
| AC-HCAG-18 | If resolved baseRef fails `git rev-parse` → halt with `conformance_baseref_unresolvable`; NO silent pass. | Unit test. | test |
| AC-HCAG-19 | All `spawnSync('git', ...)` calls in R-HCAG-2 + R-HCAG-4 pass `timeout: 10_000`; cumulative ≤60s; exceed → `conformance_gate_timeout`. | Hang-guard test. | test |
| AC-HCAG-20 | Citation gate runs BEFORE the existing `hasManagerHandoff` short-circuit (Order A); f00097e8 fixture replay halts with `conformance_citation_drift` NOT `manager_handoff_pending`. | E2E integration test. | test |
| AC-HCAG-21 | f00097e8 fixture replay against deployed gate halts mux-runner with `conformance_citation_drift`, leaves ticket status In Progress. | E2E integration test. | test |
| AC-HCAG-22 | `isHaltExit('conformance_citation_drift') === true` AND `isHaltExit('closer_e2e_replay_failed') === true`; both registered in `isFailureExit`. | Unit test. | test |
| AC-HCAG-23 | All 11 new events appear in 7 schema-registration locations; schema-conformance test passes. | `extension/tests/conformance-citation-event-schema-conformance.test.js` | test |
| AC-HCAG-24 | Send-to-morty template contains 4 literal substrings (R-HCAG-5). | Doc-only test. | test |
| AC-HCAG-25 | Closer emits `e2e_replay_passed` with proper payload BEFORE invoking `gh release create`; replay-fail → `closer_e2e_replay_failed`. | Integration test. | test |
| AC-HCAG-26 | Ticket-scoped flags (`state.flags.*_for_ticket_id`, `..._for[<ticket_id>]`) are cleared at ticket transition. | Unit test. | test |
| AC-HCAG-27 | Workers MUST NOT set bypass flag — operator-only state edit per R-WSRC parity. | Test: worker process attempting to write the flag triggers existing R-WSRC config-protection hook. | test |
| AC-HCAG-28 | auto-resume.sh halts on `conformance_citation_drift` exit reason per R-CNAR-4(c) (no auto-resume edit needed; existing logic suffices). | `extension/tests/auto-resume-stop-conditions.test.js` extension. | test |

## Bundle-Internal Hallucination Hardening *(refined: risk-scope cycle 3)*

All refinement plans for R-HCAG-0..8 MUST end with a `## Citation Self-Audit` block listing every backticked file path and backticked symbol cited in the plan, each annotated as either `(verified at HEAD: <command output>)` or `(forward-created)` per R-RTRC-7. Readiness gate at `extension/src/bin/spawn-refinement-team.ts:425-462` blocks Approved on any unresolved `path_not_verified`.

Closer (R-HCAG-8) replay is the second meta-mitigation: the deployed gate proves itself against the same backend (codex) that produced f00097e8's hallucination.

## Risks *(refined verbatim: risk-scope cycle 3)*

| Risk | Mitigation |
|---|---|
| R1: Worker writes no conformance file at all. | Halt with `conformance_missing`; not bypassable. |
| R2: `state.start_commit` is null/unreachable. | Backfill via `git rev-list --max-parents=0 HEAD`; emit `conformance_start_commit_backfilled`. |
| R3: Cited symbol matches a string-literal/comment false positive. | R-HCAG-2 step 3 tightened: symbol must appear on an added (`+`) diff line. |
| R4: Cited symbol renamed in the diff. | Verifier failure is correct semantics; R-HCAG-5 template requires post-rename names. |
| R5: Cited file deleted by the diff (legitimate refactor). | Verifier checks `git show <baseRef>:<file>` existence AND `git diff --name-status` reports D; both pass → accepted. |
| R6: `git` subprocess hang. | Per-call `timeout: 10000`; per-gate budget 60s; halt with `conformance_gate_timeout`. |
| R7: HEAD moves mid-gate. | Resolve `headRef = git rev-parse HEAD` ONCE; all subsequent calls use resolved SHA. |
| R8: Bypass-flag abuse. | Allowlist `{schema-migration, docs-only-ticket, shallow-clone-baseref}` (closer-recovery REJECTED); companion `..._signed_by` principal; ticket-scoped. |
| R9: Fixture decay (f00097e8 session dir pruned). | R-HCAG-0 prerequisite — fixture committed in same atomic as R-HCAG-1. |
| R10: Worker cites only real-but-uninvolved symbols. | R-HCAG-2 step 3 diff-hunk-line tightening (see R3). |
| R11: `auto-fill-completion-commit.ts` backdoor. | R-HCAG-4 cross-checks activity stream; halts unless allowlisted reason + principal. |
| R12: Closer iteration not scoped. | Closer-Iteration Scope section pins relaxed citation policy; closer is gated, not exempt. |
| R13: `state.session_id` undefined → "once per session" event-dedup fails. | Use persisted `state.flags.conformance_citation_audit_bypassed_emitted_for_ticket` (canonical key = `path.basename(sessionDir)`, always defined). |
| R14: `## Diff Evidence` section omitted. | Verifier requires section presence for PASS/ALL_PASS; halt `missing_diff_evidence_section`. |
| R15: Multi-ticket bundle baseRef chain corrupted by partial halt. | baseRef precedence skips tickets with `exit_reason !== 'success'`; emits `conformance_baseref_skipped_halted_ticket`. |
| R16: Manager-prose-triggered bypass. | Bypass requires operator-only state edit (R-WSRC `allow_state_writes_reason` parity); manager prompt forbids it. |
| R17: Refinement analyst self-audit recursion. | All R-HCAG-* plans require `## Citation Self-Audit` block per R-RTRC-7; readiness blocks Approved on unresolved `path_not_verified`. |
| R18: Manager-handoff lane short-circuits ahead of citation gate. | Citation gate runs FIRST (Order A); existing `hasManagerHandoff` short-circuit runs after. |
| R19: Line-range hallucination (real symbol, wrong line). | R-HCAG-2 step 4 — symbol-line proximity ±25 lines from `lineRange.lower`. |

## Bundle sizing

**8 atomic implementation + 1 manager closer + 4 hardening = 13 tickets.** Codex backend.

Sequencing:
- R-HCAG-0 first (fixture snapshot; foundational; small).
- R-HCAG-1 + R-HCAG-7 in parallel (parser is foundational; schema-reg is independent of parser semantics).
- R-HCAG-2 after R-HCAG-1 (verifier consumes parser output).
- R-HCAG-4 in parallel with R-HCAG-1/2 (completion-commit logic is independent).
- R-HCAG-3 after R-HCAG-1/2/4/7 (wires the gate; depends on parser + verifier + event registry + completion-commit gate).
- R-HCAG-5 in parallel with R-HCAG-3 (docs).
- R-HCAG-6 after R-HCAG-3 (e2e proves the gate halts against fixture).
- R-HCAG-8 (closer) last — replay against deployed gate.
- 4 hardening tickets after R-HCAG-8.

Hardening tickets (per refine skill template):
- T-HARDEN-1 Code quality review
- T-HARDEN-2 Data flow audit
- T-HARDEN-3 Test quality review
- T-HARDEN-4 Cross-reference consistency audit

## Adversarial review notes (preserved)

This bundle exists because workers fabricated PASS conformance. The bundle implementing the fix MUST NOT itself fall to the same failure mode:
- **Refinement gate**: R-HCAG-1 parser unit tests run against the literal f00097e8 fixture text (R-HCAG-0 snapshotted, committed). No parser-test passes without the fixture.
- **Closer verify-then-close**: R-HCAG-8 closer replays the f00097e8 fixture against the deployed gate before `gh release create`; emits `e2e_replay_passed` or aborts.
- **Citation self-audit**: every R-HCAG-* refinement plan ends with `## Citation Self-Audit` per R-RTRC-7; readiness gate blocks on unresolved `path_not_verified`.

## Out of scope

- Replacing worker self-attestation entirely with an LLM judge of conformance prose (different bundle; this fix is mechanical only).
- Tightening the existing `readLatestTicketConformanceSnapshot` `hasManagerHandoff` regex to require non-"None" body (sibling PRD; out of R-HCAG scope per requirements cycle 3 P1).
- B-SJET-2 (re-attempt of R-SJET-1/2/3/4 LLM judge fix). B-HCAG ships FIRST so B-SJET-2 runs under the hardened gate.
- Auto-rollback of hallucinated commits (halt is sufficient; operator decides recovery path).
- Cross-session citation auditing (Citadel territory).

## Related findings / bundles

- Finding #2 (codex Done-without-commit) — closed 2026-05-15, recurred × 2 bundles. This PRD definitively closes the **hallucinated-acceptance** subclass; the **uncommitted-but-real-work** subclass is partially covered by R-HCAG-4 (completion_commit enforcement).
- Finding #47 R-SJET — still OPEN; B-SJET-2 launches AFTER B-HCAG ships.
- R-CTSF `docs/closer-ticket-manager-handoff.md` — extended by R-HCAG-5 closer guidance.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---:|---|---|---|---|---|---|
| 10 | e38236f4 | R-HCAG-0 fixture snapshot | High | repo at v1.75.4 HEAD | committed fixture | `extension/tests/fixtures/conformance/f00097e8-hallucinated-2026-05-17.md`, README.md |
| 20 | b3804eab | R-HCAG-1 citation parser | High | R-HCAG-0 done | parser service + tests | `extension/src/services/conformance-citations.ts`, test file |
| 30 | 6e12702a | R-HCAG-7 schema registration | High | independent | 11 events registered | `activity-events.schema.json` source+mirror, `index.ts` source+mirror, `spawn-refinement-team.ts`, `mux-runner.ts` ExitReason union |
| 40 | e103b28d | R-HCAG-4 completion-commit + auto-fill gate | High | R-HCAG-7 done | gate service + tests | `git-utils.ts`, `auto-fill-completion-commit-gate.test.js` |
| 50 | 4cdf69b4 | R-HCAG-2 citation/diff verifier | High | R-HCAG-1 + R-HCAG-7 done | verifier service + tests | `citation-diff-verifier.ts`, 2 test files |
| 60 | 3e3a6561 | R-HCAG-3 mux-runner integration | High | R-HCAG-1/2/4/7 done | gate wired + tests | `mux-runner.ts`, `mux-runner-conformance-citation-gate.test.js` |
| 70 | 545c05f1 | R-HCAG-5 template hardening | Medium | independent | doc + test | `.claude/commands/send-to-morty.md`, doc test |
| 80 | d4be99dd | R-HCAG-6 e2e replay | High | R-HCAG-0..4 done | e2e integration test | `extension/tests/integration/conformance-citation-gate-e2e.test.js` |
| 90 | 70b67297 | T-HARDEN-1 code quality | High | R-HCAG-0..6 done | zero P0-P1 violations | union MODIFIED_FILES |
| 100 | afd9f3f9 | T-HARDEN-2 data flow audit | High | T-HARDEN-1 done | zero CRITICAL+HIGH | union MODIFIED_FILES + trap doors |
| 110 | a61069ce | T-HARDEN-3 test quality | High | T-HARDEN-2 done | every AC mapped, zero P0-P1 gaps | TEST_FILES |
| 120 | cdd32a5d | T-HARDEN-4 cross-reference | High | T-HARDEN-3 done | zero CRITICAL+HIGH mismatches | DOC_FILES + MODIFIED_FILES |
| 140 | cb64927f | R-HCAG-8 closer | High | All upstream + hardening done | v1.75.5 tagged + replay passed | `package.json`, `package-lock.json`, `MASTER_PLAN.md` |

