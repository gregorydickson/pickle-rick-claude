Open a portal to another codebase, extract its patterns, and generate a PRD to transplant them into your project.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Step 0: Parse Flags

Scan `$ARGUMENTS`:

| Flag | Default | Effect |
|------|---------|--------|
| `--run` | false | Auto-launch convergence loop: execute → coverage scan → delta PRD → re-execute until 100% |
| `--target <path>` | cwd | Target repo/directory for the transplant |
| `--depth <shallow\|deep>` | `deep` | `shallow` = summary, routes, models, invariants only; `deep` = full inventory with services, config, imports |
| `--no-refine` | false | Skip the automatic refinement cycle (Step 6) |
| `--no-converge` | false | Single execution pass — no coverage loop (use with `--run` for one-shot) |
| `--max-passes <N>` | 3 | Auto-continue convergence for N passes before prompting user (0 = always prompt) |
| `--cycles <N>` | 3 | Number of refinement cycles (ignored if `--no-refine`) |
| `--max-turns <N>` | 100 | Max turns per refinement worker (ignored if `--no-refine`) |
| `--save-pattern <name>` | — | Save extracted pattern to persistent library for future reuse |

Remaining text = `${EXEMPLAR}` (the portal destination — a GitHub URL, local file/dir path, npm/PyPI package name, or plain-text description of a pattern).

Store: `AUTO_RUN`, `TARGET_DIR`, `DEPTH`, `SKIP_REFINE`, `NO_CONVERGE`, `MAX_PASSES`, `CYCLES`, `MAX_TURNS`, `SAVE_PATTERN`, `EXEMPLAR`.

If `EXEMPLAR` is empty → ask user: "Where should I open the portal? Give me a GitHub URL, file path, package name, or describe the pattern you want to steal."

## Step 1: Initialize Session

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --paused --task "Portal Gun: ${EXEMPLAR}"
```
Extract `SESSION_ROOT=<path>`. Extension root: `$HOME/.claude/pickle-rick` (`${EXTENSION_ROOT}`).

## Step 2: Open the Portal (Acquire Exemplar)

Detect exemplar type and acquire source:

**NO FILE LIMITS.** Acquire ALL source files — completeness is critical. Missing files = missing PRD requirements = incomplete migration.

### GitHub URL
Patterns: `github.com/`, `raw.githubusercontent.com/`, `gist.github.com/`

- **Single file**: `gh api` or WebFetch to retrieve raw content
- **Directory/tree**: `gh api repos/{owner}/{repo}/contents/{path}` — recursively list ALL files, fetch ALL source files
- **Full repo**: clone to `${SESSION_ROOT}/portal/donor/`. Use `gh repo clone` or sparse checkout. Fetch entire source tree.
- **Gist**: `gh gist view <id>`
- **PR**: `gh pr diff <url>` to see the changes as the exemplar

Save all fetched source to `${SESSION_ROOT}/portal/donor/` preserving relative paths.

### Local Path
- File: copy to `${SESSION_ROOT}/portal/donor/`
- Directory: Use Glob to discover ALL source files. Copy everything — source, tests, types, config, middleware, models, routes, services. Do NOT filter or prioritize. The only exclusions are: `node_modules/`, `.git/`, `dist/`, `build/`, `__pycache__/`, `.next/`, coverage reports.

### Package Name
- npm: `npm info <pkg>` for repo URL → treat as GitHub URL. If no repo, `npm pack <pkg> | tar xf` to extract source
- PyPI: `pip show <pkg>` for home-page → treat as GitHub URL

### Plain-Text Description
- No source to fetch. Agent must synthesize from training knowledge.
- Write `${SESSION_ROOT}/portal/pattern_description.md` capturing the user's intent.
- Still produce `migration_inventory.md` in Step 3b — synthesize the expected routes, models, services, and config from the pattern description. Mark all items as `[SYNTHESIZED]` (no donor file references). This is required so Step 5 can generate the PRD from the inventory.

Announce what was acquired: **total file count**, languages detected, directory structure summary.

**Error handling**: If acquisition fails (gh api error, file not found, npm pack failure, network timeout):
1. Print what failed and why
2. Ask user to provide an alternative source or fix the issue
3. Do NOT proceed to Step 3 with empty/missing donor code

## Step 3: Scan the Other Side (Pattern Extraction)

<!-- [Improvement I: Pattern Library Search -- START] -->
### 3a: Check Pattern Library

Before analyzing, check if a matching pattern already exists:

1. Read `~/.claude/pickle-rick/patterns/index.md` (if it exists)
2. For each entry, compare the **Source** column against `${EXEMPLAR}`:
   - Exact path/URL match → **HIT**
   - Same repo/directory name but different subpath → **PARTIAL**
   - No match → continue
3. On **HIT**: Read the cached pattern file (`~/.claude/pickle-rick/patterns/${name}.md`). If the file is missing or unreadable, warn: "Pattern `${name}` listed in index but file missing — proceeding with full analysis." and treat as no match. Otherwise print: "Found cached pattern: `${name}`. Using as baseline — will verify against current donor and update if stale."
   - Use the cached analysis as a starting template — verify each section against the actual donor files (they may have changed since extraction)
   - Skip sections that match, update sections that diverged
   - If donor files are identical: skip to Step 4 with cached analysis (copy to `${SESSION_ROOT}/portal/migration_inventory.md`). Note: cached patterns in old format (pre-migration-inventory) should be treated as partial — perform full fresh analysis.
4. On **PARTIAL**: Print: "Found related pattern: `${name}` from `${source}`. Cross-referencing during analysis."
   - Read the cached pattern and use it as context (related patterns, shared conventions) but perform full fresh analysis
5. On no library or no match: proceed with full analysis below
<!-- [Improvement I: Pattern Library Search -- END] -->

### 3b: Analyze Donor — Migration Inventory

Analyze the donor code EXHAUSTIVELY. Produce `${SESSION_ROOT}/portal/migration_inventory.md`:

**Read every source file.** Do not skim, sample, or summarize. The inventory drives the PRD — anything missing here won't be ported.

```markdown
# Migration Inventory: [Name]

## Source
[URL/path/package]

## Summary
[1-2 paragraph description of what this codebase does]

## Routes / Endpoints / Entry Points
Enumerate EVERY route, endpoint, handler, or entry point. For each:
| Route/Entry | Method | File | Handler | Description |
|:---|:---|:---|:---|:---|
| /api/users | GET | src/routes/users.ts:15 | listUsers | Returns paginated user list |
[... EVERY route — do not truncate]

## Models / Schemas / Types
Enumerate EVERY model, schema, type definition, interface, enum:
| Name | File | Fields/Shape | Used By |
|:---|:---|:---|:---|
| User | src/models/user.ts:5 | id, email, name, role, createdAt | routes/users, services/auth |
[... EVERY model — do not truncate]

## Services / Business Logic
Enumerate EVERY service, utility, helper, middleware:
| Service | File | Methods | Description |
|:---|:---|:---|:---|
| AuthService | src/services/auth.ts | login, verify, refresh | JWT auth with bcrypt |
[... EVERY service — do not truncate]

## Config / Environment
| Variable/Config | File | Purpose |
|:---|:---|:---|
| DATABASE_URL | .env, src/config.ts | PostgreSQL connection |
[... ALL config]

## Dependencies (external)
| Package | Version | Purpose | Target Equivalent |
|:---|:---|:---|:---|
| express | 4.18.2 | HTTP framework | [what target uses or needs] |

## Invariants
[Rules that MUST hold for correctness — auth flows, data integrity, ordering guarantees]

## Migration Complexity
| Category | Count | Notes |
|:---|:---|:---|
| Routes/endpoints | [N] | |
| Models/schemas | [N] | |
| Services/utilities | [N] | |
| Test files | [N] | |
| Config items | [N] | |
| **Total items to port** | **[N]** | |

<!-- [Improvement B: File Manifest -- START] -->
## File Manifest

MANDATORY: Use Glob to enumerate ALL donor files. Do not truncate, summarize with "...", or omit files you consider unimportant. Completeness is the entire point of this manifest.

### Root files ([count from Glob])
[List EVERY file in donor root — one per line with brief purpose]
- filename.ext (brief purpose)

### Subdirectories
[For each subdirectory, list ALL files:]
- dirname/ ([count] files)
  - filename.ext (brief purpose)
<!-- [Improvement B: File Manifest -- END] -->

<!-- [Improvement C: Import Graph -- START] -->
### Import Graph (entry: [entry point file])

Trace imports from the entry point(s) using Grep tool. Cover ALL import patterns:
- ES static: `import ... from '...'`
- CJS: `require('...')`
- Dynamic: `import('...')`
- Re-exports: `export * from '...'`
- Barrel files: `index.ts` that re-exports

For each file, classify:
- **Required**: reachable from entry point
- **Unused by pipeline**: exists in donor but not imported
- **External dep**: npm/pip package (not local file)

**Language-specific patterns:**

| Language | Import Patterns to Trace |
|:---|:---|
| TypeScript/JavaScript | (covered above: ES import, CJS require, dynamic import, re-exports, barrels) |
| Python | `import X`, `from X import Y`, `from . import Y` (relative), `__init__.py` barrel files |
| Go | `import "path"`, `import ( ... )` grouped imports, internal vs external packages |
| Rust | `use crate::X`, `mod X;` (submodule declarations), `use super::X`, `pub use` re-exports |

If donor language is not in the table above, write: "Import graph skipped -- [language] not yet supported. See File Manifest for complete inventory." and classify all files as "Required (unverified)" instead of skipping classification entirely.

[Import graph here -- trace from entry point, show dependency tree]
(files NOT reachable from entry -- classify as Unused)
(files imported but not available locally -- classify as "Required (not fetched)" with the import source noted)
<!-- [Improvement C: Import Graph -- END] -->

<!-- [Improvement D: Transplant Classification -- START] -->
### File Classification

Classify each donor file based on import graph reachability and content analysis:

| File | Classification | Rationale |
|:---|:---|:---|
| [file] | [category] | [why] |

Categories and detection heuristics:
- **Direct transplant**: Reachable from entry point AND target has no equivalent file
- **Type-only transplant**: Exports only `interface`/`type`/`enum` -- no runtime code
- **Behavioral reference**: UI/framework-specific code in a different stack than target (e.g., vanilla JS -> React)
- **Replace with equivalent**: Use multi-signal matching (not just name grep):
  1. **Name match**: Grep target for similar function/class/export names from donor
  2. **Signature match**: Extract donor function signatures (params, return types). Grep target for functions with similar parameter patterns
  3. **Behavioral match**: Read donor function bodies. For each key behavior (e.g., "parses PDF", "validates schema", "uploads to S3"), Grep target for related terms/APIs
  4. Require at least 2 of 3 signals to classify as Replace (a single name match like both having `utils.ts` is insufficient). Note WHICH target file is the equivalent and HOW the behaviors differ
- **Environment prerequisite**: Contains `process.env`, config objects, or infrastructure references
- **Not needed**: NOT reachable from entry point import graph

**When import graph was skipped** (unsupported language): All files are "Required (unverified)" — the "Not needed" category cannot be determined. Rely on content analysis signals only: Type-only, Behavioral reference, Replace with equivalent, and Environment prerequisite still apply. Files that don't match any content-based category default to "Direct transplant (unverified)".
<!-- [Improvement D: Transplant Classification -- END] -->
```

For `--depth shallow`: focus on Summary, Routes/Endpoints, Models, and Invariants only.
For `--depth deep`: complete all sections with code-level detail.

## Step 3.5: Scope Confirmation

Present the migration inventory to the user before proceeding. This prevents wasted work on items the user doesn't want ported.

Print a summary:
```
Portal Inventory: [N] items to port
  Routes/endpoints: [N]
  Models/schemas:   [N]
  Services:         [N]
  Config items:     [N]
  Test files:       [N]

Confirm scope? (y = proceed, or list items to EXCLUDE)
```

**STOP and wait for user response.** Do not proceed to Step 4 until the user confirms or provides exclusions.

If user excludes items, mark them in `migration_inventory.md` with `[EXCLUDED]` and remove from the Migration Complexity totals. The PRD will only cover non-excluded items.

If user confirms (or says "y", "yes", "looks good", etc.), proceed to Step 4.

## Step 4: Survey This Side (Target Analysis)

Analyze the target codebase at `${TARGET_DIR}`. Produce `${SESSION_ROOT}/portal/target_analysis.md`:

```markdown
# Target Codebase Analysis

## Tech Stack
[Languages, frameworks, build tools, test frameworks]

## Relevant Existing Patterns
[Code that does something similar or adjacent to the donor pattern]

## Conventions
- Naming: [conventions]
- File structure: [conventions]
- Error handling: [conventions]
- Testing: [conventions]

## Integration Points
[Where the transplanted pattern would connect to existing code]
- [File/module 1]: [how it connects]
- [File/module 2]: [how it connects]

## Conflicts & Constraints
[Existing patterns that might clash with the donor]

## Adaptation Requirements
[What must change to make the donor pattern fit]
- Language: [source] → [target]
- Framework: [source] → [target]
- Conventions: [adaptations needed]

<!-- [Improvement E: Deep Target Diff -- START] -->
## Per-File Modification Specs

For each existing target file that will be modified (files classified as "Behavioral reference" or "Direct transplant" where the target already has the file, by Step 3's classification):

### [filepath] (Modified)
**Current behavior**: [describe what this file does now]
**Lines/patterns to update**:
  - Line [N]: `[current code]` -- [what needs to change]
  - Line [N]: `[current string/value]` -- [replacement]
**Required changes**: [summary of all changes needed]
<!-- [Improvement E: Deep Target Diff -- END] -->
```

Use Glob/Grep/Read.

## Step 5: Synthesize the PRD

Cross-reference `migration_inventory.md` and `target_analysis.md`. Write `${SESSION_ROOT}/prd.md`:

**The PRD must enumerate EVERY item from the migration inventory.** If the inventory has 30 routes, the PRD has 30 requirements. Nothing gets "summarized away." The inventory is the checklist — the PRD is the spec.

```markdown
# [Name] Migration PRD
| [Name] Migration PRD | | [Summary] |
|:---|:---|:---|
| **Author**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: [Date] | **Visibility**: Internal |

## Introduction
Migrating [donor] functionality into [target codebase].
Source: [URL/path]. Inventory: `portal/migration_inventory.md`.

## Objective & Scope
**Objective**: Port all confirmed-scope items from donor to target, adapted to target conventions.
**Coverage target**: 100% of non-excluded inventory items.

### In-scope (from Migration Inventory)
[List EVERY confirmed item — routes, models, services. Reference inventory line items by name.]

### Excluded (user-confirmed)
[Items marked [EXCLUDED] in inventory, with reason]

## Migration Plan — Routes/Endpoints
ONE requirement per route. Each row = one ticket-worthy unit of work.

| # | Donor Route | Donor File | Target Route | Target File | Adaptation |
|:---|:---|:---|:---|:---|:---|
| R1 | GET /api/users | src/routes/users.ts | GET /api/users | src/modules/users/users.controller.ts | Express → NestJS controller |
[... EVERY route from inventory — do not truncate, do not summarize]

## Migration Plan — Models/Schemas
| # | Donor Model | Donor File | Target Model | Target File | Adaptation |
|:---|:---|:---|:---|:---|:---|
| M1 | User | src/models/user.ts | User | src/modules/users/user.entity.ts | Mongoose → TypeORM/Drizzle |
[... EVERY model from inventory]

## Migration Plan — Services/Business Logic
| # | Donor Service | Donor File | Target Service | Target File | Adaptation |
|:---|:---|:---|:---|:---|:---|
| S1 | AuthService | src/services/auth.ts | AuthService | src/modules/auth/auth.service.ts | Adapt to NestJS DI |
[... EVERY service from inventory]

## Migration Plan — Config/Environment
| # | Donor Config | Target Config | Notes |
|:---|:---|:---|:---|
| C1 | DATABASE_URL | Already exists | Verify connection string format |
[... ALL config items]

## Acceptance Criteria
For EACH migration item above:
- [ ] R1: GET /api/users returns equivalent response shape
- [ ] R2: POST /api/users creates user with same validation rules
- [ ] M1: User model has all fields from donor
[... ONE checkbox per inventory item — this is the convergence checklist]

## Behavioral Validation Tests
| Test | Inventory Item | Donor Behavior | Expected Target Behavior |
|:---|:---|:---|:---|
| test_list_users | R1 | Returns paginated array | Same response shape, same pagination |
[... at least one test per route/service]

## Risks & Mitigations
| Risk | Severity | Mitigation |
|:---|:---|:---|
| Framework differences (Express→NestJS, etc.) | Medium | Adapt patterns, preserve behavior |
| Missing shared utilities | Medium | Port utilities as separate tickets |

## Portal Artifacts
- Migration inventory: `portal/migration_inventory.md`
- Target analysis: `portal/target_analysis.md`
- Donor source: `portal/donor/`

## Coverage Tracking
Total items: [N] | Ported: 0 | Remaining: [N] | Coverage: 0%
(Updated by convergence loop after each execution pass)
```

**Every inventory item MUST appear in a Migration Plan table AND as an Acceptance Criteria checkbox.** If the inventory has N items, the PRD has N rows + N checkboxes. This is the completeness guarantee.

<!-- [Improvement A: PRD Validation -- START] -->
## Step 5.5: PRD Validation Pass

Before refinement, validate all file paths referenced in the PRD against the actual filesystem. This catches wrong prefixes, stale line numbers, incomplete directory listings, and hallucinated paths before they propagate into tickets.

### 5.5-pre: Remote Donor Check
If the donor was acquired from a remote source (GitHub URL, npm package, PyPI package) AND the donor files were saved to `${SESSION_ROOT}/portal/donor/`:
- Rewrite donor path references to use the local `portal/donor/` copy for validation
- E.g., `github.com/owner/repo/src/foo.ts` → validate against `${SESSION_ROOT}/portal/donor/src/foo.ts`

If the donor was remote AND no local copy exists (acquisition fully failed):
- Classify all donor-referencing paths as `SKIP: remote donor (no local copy)` — do not flag as NOT FOUND
- Still validate all TARGET paths normally

If the donor was remote AND acquisition was partial (some files fetched, others failed):
- Validate available local copies normally (they exist under `portal/donor/`)
- Classify paths referencing files that were NOT fetched as `SKIP: remote donor (not fetched)`
- Still validate all TARGET paths normally

### 5.5a: Extract Paths
Scan `${SESSION_ROOT}/prd.md` for all backtick-quoted strings containing `/`. These are candidate file paths. Exclude:
- URLs (strings starting with `http://`, `https://`, `git://`)
- Shell variables without a path component (e.g., `${SESSION_ROOT}` alone)
- Glob patterns used as examples (e.g., `**/*.ts`)

### 5.5b: Classify Each Path
For each extracted path, apply detection in this order (stop at first match):

1. **To-create**: Path appears under a "New Files", "Files to Create", or "Files to Add" heading in the PRD → `TO-CREATE: {path} (skipped)`. Skip further checks.
2. **Exists (valid or shifted)**: `Read(path)` succeeds → file exists. If a line number is referenced (e.g., `path:42`), read that line. If content at the stated line doesn't match what the PRD describes, search the file for the expected content → `SHIFTED: {path}:{stated} -> actual :{found}`. If line content matches or no line number is referenced → `VALID: {path}`.
3. **Wrong prefix**: `Read(path)` fails → `Glob(**/${basename})`. If 1+ matches found → `INVALID: {path} -- found at {match}`. If multiple matches, list all.
4. **Incomplete directory**: Path references a directory (no file extension, or PRD lists directory contents). Run `Glob({dir}/*)` and compare count to PRD-listed count → `INCOMPLETE: {dir} -- PRD lists {n}, found {actual}. Missing: {list}`.
5. **Hallucinated**: `Read(path)` fails AND `Glob(**/${basename})` returns 0 matches → `NOT FOUND: {path} -- no match in codebase`.
6. **Stale reference**: `Read(path)` succeeds (file exists) but the referenced symbol, function, or export (e.g., `export function foo`) is not found anywhere in the file → `STALE: {path} -- referenced content "{snippet}" not found in file`.

### 5.5c: Write Validation Report
Write `${SESSION_ROOT}/portal/validation_report.md`:

```markdown
# PRD Validation Report
Generated: [timestamp]
Source PRD: ${SESSION_ROOT}/prd.md

## Summary
- Total paths extracted: [N]
- Valid: [N]
- To-create (skipped): [N]
- Shifted line numbers: [N]
- Invalid prefix: [N]
- Incomplete directory: [N]
- Not found: [N]
- Stale reference: [N]

## Details
[One line per path with classification, e.g.:]
VALID: src/index.ts
TO-CREATE: src/new-module.ts (skipped)
SHIFTED: src/db/index.ts:29 -> actual :47
INVALID: pdfjs-pipeline/adapter.ts -- found at src/pdfjs-pipeline/adapter.ts
INCOMPLETE: src/schema/ -- PRD lists 4, found 8. Missing: e.ts, f.ts, g.ts, h.ts
NOT FOUND: src/phantom/ghost.ts -- no match in codebase
STALE: src/auth.ts -- referenced content "export function validateToken" not found in file
```

### 5.5d: Update PRD
Apply corrections to `${SESSION_ROOT}/prd.md` based on the validation report:

- **SHIFTED**: Update line numbers in the PRD to actual locations.
- **INVALID** (with matches): Replace wrong paths with correct paths found by Glob.
- **INCOMPLETE**: Add a `<!-- INCOMPLETE: {dir} has {N} additional files not listed -->` comment in the PRD near the directory reference.
- **NOT FOUND**: Mark with `[UNVERIFIED]` suffix (e.g., `` `src/phantom/ghost.ts` [UNVERIFIED] ``).
- **STALE**: Mark with `[STALE]` suffix and note the referenced content was not found.
- **TO-CREATE** and **VALID**: No changes needed.

Do NOT use bash commands (`stat`, `ls`, `grep`, `find`). Use Read, Glob, Grep tools only.
<!-- [Improvement A: PRD Validation -- END] -->

## Step 6: Refinement Cycle (unless `--no-refine`)

If `SKIP_REFINE` is true → skip to Step 7.

The portal artifacts give the refinement team extra context a normal PRD wouldn't have. The analysts cross-reference donor patterns against target constraints to catch transplant-specific risks.

### 6a: Launch Refinement Monitor (if tmux available)
Check `tmux -V`. If available:
```bash
REFINE_HASH="$(basename "${SESSION_ROOT}" | sed 's/.*\(.\{8\}\)$/\1/')"
REFINE_SESSION="refine-${REFINE_HASH}"
tmux new-session -d -s "$REFINE_SESSION" -c "$(pwd)"
tmux send-keys -t "$REFINE_SESSION" "node ${EXTENSION_ROOT}/extension/bin/refinement-watcher.js ${SESSION_ROOT}" Enter
```
Print: `Monitor: tmux attach -t $REFINE_SESSION`

If tmux NOT available: print tip, skip monitor.

### 6b: Spawn Refinement Team
```bash
node "${EXTENSION_ROOT}/extension/bin/spawn-refinement-team.js" --prd "${SESSION_ROOT}/prd.md" --session-dir "${SESSION_ROOT}"
```
Optional: `--timeout <sec>` | `--cycles <n>` (default:3) | `--max-turns <n>` (default:100). Pass `CYCLES` and `MAX_TURNS` if user specified them.

Wait for `REFINEMENT_DIR=` and `MANIFEST=` output.

The 3 parallel analysts per cycle:
- **Requirements Analyst** → `analysis_requirements.md` — validates functional requirements against donor invariants
- **Codebase Context** → `analysis_codebase.md` — checks integration points, convention alignment, conflict detection
- **Risk & Scope** → `analysis_risk-scope.md` — evaluates transplant risks, semantic drift potential, test coverage gaps

Cycle 2+ cross-references all prior analyses + portal artifacts (`migration_inventory.md`, `target_analysis.md`).

### 6c: Cleanup Monitor
```bash
REFINE_HASH="$(basename "${SESSION_ROOT}" | sed 's/.*\(.\{8\}\)$/\1/')"
tmux kill-session -t "refine-${REFINE_HASH}" 2>/dev/null || true
```

### 6d: Audit Reports
Read `${SESSION_ROOT}/refinement_manifest.json`. For failed workers: warn, note gaps, continue with available reports. Read all `analysis_*.md` + original PRD + portal artifacts.

### 6e: Synthesize Refined PRD
Write `${SESSION_ROOT}/prd_refined.md`. Rules:
1. Preserve original transplant PRD structure
2. Additive — append `*(refined: [source])*` after additions
3. P0 gaps first (especially invariant violations or missing behavioral tests)
4. No invention — only content from analyses + portal artifacts
5. Preserve Portal Artifacts section — append refinement summary
6. Strengthen Behavioral Validation Tests table based on analyst findings
7. Update Risks & Mitigations with transplant-specific risks from Risk & Scope analyst
8. Add `## Refinement Notes` section at end summarizing what changed and why

Copy refined PRD back to `${SESSION_ROOT}/prd.md` (original preserved as `prd_pre_refinement.md`).

### 6f: Refinement Summary
Write `${SESSION_ROOT}/refinement_summary.md`: timestamp, per-analysis changes, risk flags, failed workers if any.

Announce: refinement complete, key findings, risk level.

<!-- [Improvement F: Post-Edit Consistency -- START] -->
### 6g: Post-Edit Consistency Check

When the user requests scope changes to the PRD (e.g., "remove XML support", "change upload limit to 25MB", "drop the LLM budget feature"), run a consistency scan BEFORE confirming the edit is complete.

#### Check 1: Contradictory Numeric Values
Scan for numeric values associated with the same concept appearing with different values.

**IS a contradiction (flag):**
- "Maximum upload size: 50MB" (CUJ-2) + "Upload limit: 25MB" (Risk Mitigations) → same concept, different values → FLAG
- "7 sections in findings display" (CUJ-1) + "15 sections in schema definition" when schema drives display → FLAG
- "Timeout: 30s" (Functional Requirements) + "Timeout: 120s" (Acceptance Criteria for the same requirement) → FLAG

**IS NOT a contradiction (skip):**
- "S3 max object size: 5GB" + "Upload limit: 25MB" → different concepts (infrastructure capacity vs application limit) → SKIP
- "Poll every 1s during active processing" + "Poll every 60s during idle timeout" → same metric but explicitly different operational contexts → SKIP

#### Check 2: Stale Feature References
After removing or renaming a feature, search for ALL terms related to that feature throughout the PRD. Report each occurrence with its section and surrounding context.

**Example**: User says "remove XML support". Search for: `XML`, `MISMO`, `parser`, `xpath`, and any feature-specific terms that appeared near XML references. Each hit is a potential stale reference.

#### Check 3: Section Count Alignment
Verify structural consistency:
- Number of CUJs matches number of requirement groups (each CUJ has a corresponding functional requirements section)
- Every CUJ has at least one functional requirement row
- Every functional requirement maps to at least one acceptance criterion
- Every behavioral validation test maps to a declared invariant

#### Check 4: Report
List all findings BEFORE confirming the edit is complete:
```
CONFLICT: {concept} = {value1} (section {s1}) vs {value2} (section {s2})
STALE: "{term}" in {section}: "{surrounding context}"
ORPHAN: CUJ-{n} has no corresponding requirements
ORPHAN: FR-{n} has no acceptance criteria
OK: No inconsistencies found
```

If any CONFLICT or STALE findings exist, present them to the user and ask whether each is intentional before finalizing the edit.
<!-- [Improvement F: Post-Edit Consistency -- END] -->

<!-- [Improvement J: Incremental Re-Validation -- START] -->
### 6h: Incremental Re-Validation

After any user-requested PRD edits (scope changes, path corrections, feature additions/removals), re-run a targeted validation pass on CHANGED sections only:

1. Identify which PRD sections were modified by the edit (based on the user's stated edit request)
2. Extract new or changed backtick-quoted paths from those sections
3. Also scan UNCHANGED sections for paths that reference concepts removed by the edit (e.g., if "GenServer" was removed, find paths containing "genserver" in unchanged sections — these are now stale)
4. Run the same 5.5b classification pipeline on all collected paths
5. For any new INVALID, NOT FOUND, or SHIFTED results:
   - Append to `${SESSION_ROOT}/portal/validation_report.md` under a `## Re-Validation (Edit N)` heading
   - Report findings to user inline before confirming the edit is complete
6. If the edit introduced new files to the "New Files" section, verify they don't already exist (would indicate the user wants to modify, not create)

This runs AFTER Step 6g's consistency check. The sequence is: user requests edit → apply edit → 6g consistency check → 6h re-validation → report all findings → confirm.
<!-- [Improvement J: Incremental Re-Validation -- END] -->

## Step 7: Propagate (Pattern Persistence)

Save the extracted pattern for future reuse. This implements the "Propagate" step of gene transfusion — making patterns discoverable and reusable across projects.

### 7a: Pattern Library
Pattern library location: `~/.claude/pickle-rick/patterns/`

Derive `PATTERN_NAME`: use `SAVE_PATTERN` value if set, otherwise infer from exemplar (repo name, file basename without extension, or slugified description). Fallback: `pattern-<date>`.

**Decision tree:**
1. `--save-pattern <name>` set → `PATTERN_NAME = SAVE_PATTERN`. Save immediately, no prompt.
2. `--save-pattern` not set AND `--no-refine` not set → check if `~/.claude/pickle-rick/patterns/${PATTERN_NAME}.md` already exists:
   - If exists: prompt user: "Pattern `${PATTERN_NAME}` already in library. Update it with this session's analysis? (y/n)"
     - User accepts → overwrite file, update index entry date
     - User declines → skip
   - If not exists: prompt user: "Save this pattern to the library for future portal-gun sessions? (name suggestion: `${PATTERN_NAME}`)"
     - User accepts → save with suggested or user-provided name
     - User declines → skip, no further action
3. `--save-pattern` not set AND `--no-refine` set → skip with hint: "Pattern available at `${SESSION_ROOT}/portal/migration_inventory.md` — use `--save-pattern <name>` to persist."

**When saving:**
1. Create `~/.claude/pickle-rick/patterns/` if it doesn't exist. If creation fails, warn and skip (non-fatal).
2. Copy `${SESSION_ROOT}/portal/migration_inventory.md` → `~/.claude/pickle-rick/patterns/${PATTERN_NAME}.md`
3. Create or append to `~/.claude/pickle-rick/patterns/index.md`:

If `index.md` doesn't exist, create with header:
```markdown
# Pattern Library
Extracted patterns available for future `/portal-gun` sessions.

| Pattern | Source | Date | Summary |
|:---|:---|:---|:---|
```

Append entry:
```markdown
| [Name] | [Source URL/path] | [Date] | [Summary] |
```

If `index.md` exists but doesn't contain the expected table header, warn "Pattern library index may be corrupted" but still append.

### 7b: Project-Local Copy
Runs only if `PATTERN_NAME` was set (i.e., pattern was saved in 7a or `--save-pattern` was provided).
Copy `${SESSION_ROOT}/portal/migration_inventory.md` → `${TARGET_DIR}/.patterns/${PATTERN_NAME}.md` if `.patterns/` dir exists. If not, skip silently.

## Step 8: Advance State & Handoff

```bash
node "${EXTENSION_ROOT}/extension/bin/update-state.js" step breakdown "${SESSION_ROOT}"
```

Verify: `prd.md` exists AND state.json has `step: breakdown`.

**Note**: State advances to `breakdown`. When the user runs `/pickle-tmux --resume`, pickle.md Phase 2 (Ticket Manager) will decompose the PRD into atomic tickets before entering the orchestration loop. This is the standard Pickle Rick lifecycle — portal-gun handles PRD creation, pickle handles decomposition and execution.

**If `AUTO_RUN` is false**:
Print results: PRD path, pattern summary, donor → target mapping, refinement status, pattern library status.
Offer next steps:
- `/pickle-tmux --resume ${SESSION_ROOT}` — decompose + execute in tmux
- Edit `${SESSION_ROOT}/prd.md` to adjust before executing

**If `AUTO_RUN` is true**: Proceed to Step 9.

## Step 9: Convergence Loop (AUTO_RUN=true only)

The portal-gun convergence loop: execute → measure coverage → generate delta PRD → re-execute → repeat until all inventory items are ported.

### 9a: Check multiplexer
`tmux -V`. If present → set MUX=tmux. If missing, check Zellij (>= 0.40.0). If neither: suggest install, note PRD is ready for manual resume. Stop.

### 9b: Execute Pass

Re-initialize for execution:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations 0 --max-time 0
```
Launch tmux session and runner:
```bash
PORTAL_HASH="$(basename "${SESSION_ROOT}" | sed 's/.*\(.\{8\}\)$/\1/')"
PORTAL_SESSION="portal-${PORTAL_HASH}"
tmux new-session -d -s "$PORTAL_SESSION" -c <working_dir>
sleep 1
tmux send-keys -t "$PORTAL_SESSION":0 "node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js ${SESSION_ROOT}; echo ''; echo 'Pass complete. Checking coverage...'; read" Enter
```

mux-runner auto-creates the 4-pane monitor window on startup — no manual invocation needed.
Print: `tmux attach -t $PORTAL_SESSION`

Wait for runner to complete (state.json `active: false`).

### 9c: Coverage Scan

After each execution pass, measure migration coverage against the inventory:

1. Read `${SESSION_ROOT}/portal/migration_inventory.md` — get the full list of in-scope items
2. For each inventory item (routes, models, services), scan the target codebase:
   - **Route/endpoint**: Grep target for the route path or handler name
   - **Model/schema**: Grep target for the model name, check if fields match
   - **Service**: Grep target for the service name or equivalent functions
   - **Config**: Check if env vars / config keys exist in target
3. Classify each item: `PORTED` (found in target with equivalent behavior), `PARTIAL` (exists but incomplete), `MISSING` (not found)
4. Write `${SESSION_ROOT}/portal/coverage_report.md`:

```markdown
# Coverage Report — Pass [N]
Generated: [timestamp]

## Summary
Total items: [N] | Ported: [N] | Partial: [N] | Missing: [N] | Coverage: [%]

## Details
| # | Item | Category | Status | Notes |
|:---|:---|:---|:---|:---|
| R1 | GET /api/users | Route | PORTED | Found at src/modules/users/users.controller.ts |
| R2 | POST /api/users | Route | MISSING | No equivalent found |
| M1 | User model | Model | PARTIAL | Missing 2 fields: role, createdAt |
[... every item]
```

5. Update the PRD's Coverage Tracking section with current numbers.

### 9d: Convergence Check

If `NO_CONVERGE` is true → skip to 9f (single pass, no loop).

If coverage = 100% → converged. Print report. Output `<promise>TASK_COMPLETED</promise>`.

If coverage < 100% AND this is pass 1 through `MAX_PASSES` (default: 3) → generate delta PRD and re-execute (Step 9e).

If coverage < 100% AND this is pass `MAX_PASSES + 1`+ → print coverage report, list remaining items, ask user:
> Coverage at [N]% after [pass] passes. [M] items remaining. Continue iterating? (y/n)

### 9e: Delta PRD Generation

For MISSING and PARTIAL items from the coverage report:

1. Write `${SESSION_ROOT}/prd_delta_pass_[N].md` using the SAME full PRD template structure (Introduction, Objective, Migration Plan tables, Acceptance Criteria) but scoped to remaining items only:
   - MISSING items get full migration plan rows
   - PARTIAL items get specific "complete" requirements (e.g., "Add missing fields role, createdAt to User model")
   - Include updated Coverage Tracking with pass history
2. Copy delta PRD to `${SESSION_ROOT}/prd.md` (preserve original as `prd_pass_[N-1].md`)
3. Reset state to `breakdown`:
```bash
node "${EXTENSION_ROOT}/extension/bin/update-state.js" step breakdown "${SESSION_ROOT}"
```
4. Return to Step 9b (re-execute)

### 9f: Final Report
Print: total passes, final coverage, items ported per pass, session path, attach command.

Output: `<promise>TASK_COMPLETED</promise>`
