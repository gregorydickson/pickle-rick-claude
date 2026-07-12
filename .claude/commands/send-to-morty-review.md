Internal review worker — not for direct user invocation.

# REVIEW: $ARGUMENTS

Review Worker. Persona via CLAUDE.md. **Text before every tool call.**

## Init
```bash
node "$HOME/.claude/pickle-rick/extension/bin/worker-setup.js" $ARGUMENTS
```
Extract `${SESSION_ROOT}`, `${TICKET_ID}`, `${TICKET_DIR}`.

## Resume Detection (run BEFORE Phase 1)

| Files in `${TICKET_DIR}` | Enter at phase |
|---|---|
| (none, or `review_scope.md` missing) | 1 (Scope Discovery) |
| `review_scope.md` exists; no `spec_conformance.md` | 2 (Spec Conformance) |
| `spec_conformance.md` says `CONFORMANT`; no `review_findings.md` | 3 (Focused Review) |
| `review_findings.md` exists; no Simplify pass evidence | 4 (Simplify) |

Stale-review guard: if a review file's mtime is older than the ticket file's `updated:` frontmatter date, treat as stale and re-do that phase from scratch.

Rejected reviews (`NON-CONFORMANT`): re-do the failed phase from scratch.

## ⚠️ Synchronous Gate Confirmation & Commit-First

Gate/test confirmation (tsc, eslint, test:fast) runs SYNCHRONOUSLY in your own turn — NEVER background it, poll a monitor, or await an external event to confirm it. No waker exists in `claude -p`; a worker that parks on an async confirmation idles to budget death with the diff uncommitted.

If the diff is green on tsc+eslint and only the test tier is unconfirmed, COMMIT FIRST — do not hold a deterministically-green diff hostage to an unconfirmed test tier.

## Lifecycle — ONE REVIEW, phases 1→4, then `<promise>I AM DONE</promise>`

### Phase 1: Scope Discovery
1. Read `${SESSION_ROOT}/${TICKET_ID}/rick_ticket_${TICKET_ID}.md`
2. Extract `review_group` (comma-separated ticket IDs) from frontmatter
3. Per ticket: read dir, check artifacts (`plan_*.md`, `research_*.md`), scan `git log --oneline --all --grep="${id}"`, collect modified files
4. Dedupe, filter to source files only
5. Write `${TICKET_DIR}/review_scope.md`: date, review group, tickets table (ID/Title/Status/Files), files in scope, exclusions

### Phase 2: Spec Conformance
Per ticket in `review_group`:
1. Read spec at `${SESSION_ROOT}/${id}/rick_ticket_${id}.md`
2. Read existing `${SESSION_ROOT}/${id}/conformance_*.md` if present
3. **Acceptance criteria**: Re-run commands that could be affected by other tickets (shared state/types/integration). Skip isolated unit checks already passing in Morty's report — but Morty's report is a claim, not evidence: "already passing" counts only when the report shows real command output AND the diff contains the claimed change; a bare asserted PASS gets re-run. Review is the last semantic check — rubber-stamping self-reports is how phantom-Done work ships. For `llm-conformance`: read impl, quote code, PASS/FAIL + justification.
4. **Interface contracts**: Resolve type aliases, compare field-by-field against impl signatures.
5. **Test expectations**: Verify each expected test exists and passes.
6. **Type check**: Project type checker — no new errors in touched files.
7. **LLM conformance**: Per requirement, quote impl code, PASS/FAIL + justification. Flag ambiguous requirements as under-specified.

Write `${TICKET_DIR}/spec_conformance.md`:
```
# Spec Conformance Report
Per ticket: | Check | Status | Detail | (Acceptance/Contracts/Tests/Types/LLM)
## Spec Quality Signals
[Ambiguous requirements → append to prd_refined.md Verification Strategy as "Lessons Learned"]
## Overall: CONFORMANT / NON-CONFORMANT
```
CONFORMANT → next. NON-CONFORMANT → fix, re-verify.

### Phase 3: Focused Review
Read `${TICKET_DIR}/review_scope.md` for file list.

**P0 — fix immediately:**
- Security: injection, path traversal, prototype pollution, unvalidated input, hardcoded secrets, unsafe deserialization
- Correctness: race conditions, silent failures, type mismatches at boundaries, off-by-one, state machine violations

**P1 — fix if safe:**
- Architecture: cross-ticket duplication, inconsistent patterns, circular deps, layer violations
- Test Coverage: integration gaps, error path coverage, mock realism

Per issue: classify, severity (P0/P1/P2), fix P0+P1 immediately, document P2.

Zero findings on clean code is a SUCCESSFUL review — never manufacture findings to look thorough. Not certain a finding is real? It is a P2 note, not a fix: one false-positive "fix" poisons already-verified work and derails the whole pass.

Write `${TICKET_DIR}/review_findings.md`:
```
# Review Findings
P0 table (fixed) | P1 table (fixed) | P2 table (documented)
## Cross-Ticket Coherence | ## Test Status (passing/build/new tests)
```

### Phase 4: Simplify
`git diff --name-only` for combined file list. Kill dead code, collapse redundancy, flatten nesting (max 2), purge slop comments, normalize style. Don't touch files outside scope. Don't add functionality. Verify after each file — revert if broken. Your Phase 3 fixes are UNCOMMITTED: "revert" means path-scoped `git checkout -- <the one file you just simplified>`, named files only — never an unscoped `git restore`/`checkout` of a directory, which wipes your own fixes and the reviewed tickets' work. If the reverted file ALSO contains one of your Phase 3 fixes, re-apply that fix immediately after the revert — a file-level checkout wipes both, and `review_findings.md` must stay truthful about what is actually fixed. Preserve work before anything else. Run tests after all changes.

Output `<promise>I AM DONE</promise>`. STOP.
