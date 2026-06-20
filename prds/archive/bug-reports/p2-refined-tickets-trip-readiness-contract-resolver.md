---
title: P2 — Refined tickets routinely fail the readiness contract resolver on bundle-created artifacts
status: Draft
date: 2026-05-03
priority: P2
type: bug
peer_prds:
  related:
    - prds/archive/bug-reports/readiness-gate-manifest-prd-bundle-mismatch.md  # PARENT — manifest-vs-bundle mismatch (shipped via P0 Section D)
    - prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md  # surfaced here on session 2026-05-03-7d9ee8cc
    - prds/archive/bundles/p2-mega-bundle-2026-05-02-pm.md                  # also hit this via state.flags.skip_readiness_reason bypass
---

# PRD — Refined tickets routinely fail the readiness contract resolver

## Symptom

`/pickle-pipeline` on the reliability-and-test-coverage bundle (session `2026-05-03-7d9ee8cc`) crashed at iteration 1 with `check-readiness exited 2; no manager spawn attempted`. Forensics: 30+ contract-resolution failures across 9 distinct tickets, falling into 5 distinct classes — every class is a known false-positive shape.

| # | Class | Example failures | Why it's a false positive |
|---|---|---|---|
| 1 | Bundle-created artifacts (forward refs) | `QUARANTINE.md`, `ci.yml`, `demote()`, `engines.gh`, `Coverage-Exception:` trailer | The bundle CREATES these via its own tickets — they MUST not exist at readiness time. |
| 2 | Path-resolution misses for files that DO exist | `release.yml`, `MASTER_PLAN.md`, `Install.sh` | `resolvePathRef()` checks 5 base dirs but doesn't see `.github/workflows/release.yml` from a bare `release.yml`; case-sensitive miss on `Install.sh` vs `install.sh`. |
| 3 | Stdlib / external CLI APIs | `t.todo()`, `t.skip()`, `fs.utimes`, `process.env` | Not in repo source — they're node:test / node:fs / node:process exports. The resolver only greps tracked files. |
| 4 | JSON-output / config-key fields | `_audit.c8`, `_audit.flatted`, `total.lines.pct`, `total.statements.pct` | These are runtime JSON output keys (npm audit, c8 coverage), not source symbols. They appear in tickets as documentation of what fields a script consumes. |
| 5 | Test-defined helpers | `buildFixtureScript()` (defined in `extension/tests/install-script.test.js`) | `resolveSymbolRef()` at line 151 explicitly excludes `tests/` from the candidate set: `!/(^|\/)tests?\//.test(file)`. Helpers that exist in tests trip the resolver every time. |

The forensic report at `${SESSION_ROOT}/readiness_2026-05-03.md` ran 26m 46s, then the pipeline exited at 0/4 phases. Full session burned ~27 min of wall plus codex spawn time on the readiness gate before any worker code ran.

## Why this is a distinct bug class (vs the parent PRD)

`prds/archive/bug-reports/readiness-gate-manifest-prd-bundle-mismatch.md` solved **manifest-vs-bundle** mismatch (the bundle PRD path wasn't in the readiness manifest, so workers couldn't find their source PRD). That fix shipped via P0 Section D. AC-RGM-01..07 are green.

This bug is upstream of that fix — it's about **the bodies of the tickets themselves**:

- The refinement team's prompt (`extension/src/bin/spawn-refinement-team.ts`) tells analysts to populate `## Research Seeds` with `Files`, `APIs/types`, `Patterns`, `Test patterns` — and the analysts naturally surround named artifacts with backticks because they're code-shaped.
- The contract resolver (`extension/src/bin/check-readiness.js:99-117`) extracts every backticked token matching a symbol/path shape and demands resolution.
- For greenfield/forward-creating tickets, that's an impedance mismatch — every "Files to create:" entry is a guaranteed failure unless un-backticked.

Result: every refined PRD that ships >2 forward-created artifacts fails readiness. The mega bundle (session `2026-05-02-fca7952b`) hit this and was unblocked via `state.flags.skip_readiness_reason = "bundle pre-validated by refinement team"`. That's a workaround, not a fix.

## Root causes (3 paths, fix any combination)

### RC-1 — Refinement-team prompt is silent on forward-ref hygiene

`spawn-refinement-team.ts` builds the worker prompt around analysis of an existing PRD. The prompt asks for ticket-shaped output but doesn't tell analysts how to mark forward-created artifacts. Analysts default to backticking everything code-shaped — which is the right rendering convention for human readers but trips the readiness contract resolver.

### RC-2 — `check-readiness.js` resolver doesn't recognize forward-ref annotation

Even if a ticket DOES say "the QUARANTINE.md file (created by ticket 3829b975)", the resolver still extracts `QUARANTINE.md` and tries to grep for it. There's no way to mark a backticked token as "intentional forward reference."

### RC-3 — `resolveSymbolRef()` excludes `tests/` from candidate files (line 151)

`!/(^|\/)tests?\//.test(file)` excludes any file under `tests/` from the symbol-resolution candidate set. Test helpers defined in `extension/tests/*` are unfindable by name. Any ticket that says `\`buildFixtureScript()\`` (the existing real helper in `extension/tests/install-script.test.js`) fails the gate. This is a check-readiness bug independent of refinement.

### RC-4 — `resolvePathRef()` doesn't try repo-tracked-paths fallback

`resolvePathRef()` checks 5 base dirs and joins each base + ref. It does NOT fall back to `git ls-files | grep <ref>$` to catch bare filenames whose canonical path is deeper (`release.yml` → `.github/workflows/release.yml`). Tickets that rendered the filename without the directory always trip the gate.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-RTRC-1 | Refinement-team worker prompt includes a section "Forward-reference hygiene" instructing analysts: backtick a path/symbol ONLY when the artifact already exists at HEAD; for bundle-created artifacts, write them un-backticked OR with explicit "(created by ticket <id>)" annotation; for stdlib/external APIs, never backtick. | P0 |
| R-RTRC-2 | `check-readiness.js` `extractContractReferences()` skips backticked tokens immediately followed by a `(created by ticket <hash>)` or `(introduced by ticket <hash>)` parenthetical. Document the convention in `extension/CLAUDE.md` so the rule is discoverable by analysts and the resolver in lockstep. | P0 |
| R-RTRC-3 | `resolveSymbolRef()` no longer excludes `tests/` from candidates. Symbol must resolve in EITHER source OR test files — both are part of the project; helpers defined in tests are still real symbols. | P1 |
| R-RTRC-4 | `resolvePathRef()` falls back to `git ls-files` + suffix-match: if no base+ref join succeeds, see whether any tracked path ends with `/<ref>` (or equals `<ref>`). Match → resolved. | P1 |
| R-RTRC-5 | Stdlib/external API allowlist: `extension/.cli-pins.json` (or new `extension/.readiness-allowlist.json`) lists known-external symbols (`t.todo`, `t.skip`, `fs.utimes`, `process.env.*`, npm-audit JSON paths, c8 coverage paths). Resolver consults this allowlist before reporting. | P1 |
| R-RTRC-6 | `npm test` regression suite includes a fixture session with 3 tickets that exercise each of RC-1 through RC-4: a forward-ref-annotated bundle artifact, a test-defined helper, a deep repo path, a stdlib API. Contract-only run exits 0. | P0 |

## Acceptance Criteria

| AC | Verification |
|---|---|
| AC-RTRC-01 | Re-run `node check-readiness.js --session-dir <fixture> --contract-only` against the regression fixture; exit 0 — Verify: `npm test -- --grep readiness.forward-ref-fixture` — Type: test |
| AC-RTRC-02 | Refinement worker prompt includes Forward-reference hygiene section — Verify: `grep -c "Forward-reference hygiene" extension/src/bin/spawn-refinement-team.ts` returns ≥1 — Type: lint |
| AC-RTRC-03 | resolveSymbolRef finds test-defined helpers — Verify: regression test creates a fixture ticket referencing `\`buildFixtureScript()\``; contract-only check passes — Type: test |
| AC-RTRC-04 | resolvePathRef finds deep paths via suffix match — Verify: regression test creates fixture ticket referencing `\`release.yml\``; contract-only check passes — Type: test |
| AC-RTRC-05 | Allowlist works — Verify: regression test references `\`t.todo()\`` while `.readiness-allowlist.json` includes `t.todo`; contract-only check passes — Type: test |
| AC-RTRC-06 | After all fixes land, the v1.69.0 reliability bundle session re-runs check-readiness and exits 0 with NO `state.flags.skip_readiness_reason` set — Verify: pipeline relaunch on session `2026-05-03-7d9ee8cc` passes readiness with no bypass — Type: integration |

## Workaround until R-RTRC-1..6 land

Three flavors:

1. **Bypass at session-launch**: set `state.flags.skip_readiness_reason = "<reason>"` in `state.json`. Mux-runner then passes `--skip-readiness <reason>` to check-readiness, exits clean. (Used by mega bundle session `2026-05-02-fca7952b`.) Loses readiness signal for the duration.

2. **Mass-edit tickets post-refinement**: parallel agent team rewrites every backticked forward-ref to either un-backticked text or fully-qualified path. (Used by reliability-bundle session `2026-05-03-7d9ee8cc` after first crash.) Adds 5-10 min wall + 4 agent slots per refinement run.

3. **Pre-create stub files**: empty `QUARANTINE.md`, empty `ci.yml`, function-stub for `demote()`, etc. Lets the resolver pass without bypass. ~10 min manual work; loses xfail discipline for the affected tickets.

None of these are sustainable for the steady state. Per-ticket mass-edit (option 2) is the cleanest workaround until R-RTRC-1+R-RTRC-2 ship.

## Risk

**Resolver too permissive after fix**: if R-RTRC-2's `(created by ticket <hash>)` annotation pattern is too lax, real drift gets masked by an annotation that points at a non-existent or already-Done ticket. Mitigation: validate the cited ticket hash exists in `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md` AND its status frontmatter is NOT `Done` (otherwise the create-promise is no longer credible).

**Allowlist becomes a junk drawer**: R-RTRC-5's allowlist could expand to cover any token a ticket uses sloppily. Mitigation: each entry needs a one-line `source:` field (npm registry URL, node:test docs URL, c8 schema) — entries without source are rejected by a lint.

## Cross-references

- Surfaced during reliability-bundle session: `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/`
- Forensic report: `${SESSION_ROOT}/readiness_2026-05-03.md` (810 lines)
- Pipeline-runner crash log: `${SESSION_ROOT}/pipeline-runner.log` line "[2026-05-03T18:26:44.148Z] Phase pickle exited with code 1"
- Source resolver: `extension/src/bin/check-readiness.js:99-205`
- Refinement-team prompt builder: `extension/src/bin/spawn-refinement-team.ts:367-525` (the `buildAnalystPrompt` function and adjacent)
- Parent PRD: `prds/archive/bug-reports/readiness-gate-manifest-prd-bundle-mismatch.md` shipped — different layer of the same gate

— Pickle Rick out. *belch*
