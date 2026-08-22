#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';

/** Minimal seam for impact-radius analysis. Tests inject a fake; CLI passes nothing (fail-open). */
export interface ImpactRadiusService {
  getImpactRadius(paths: string[], depth: number): string[] | null;
}

export interface CheckScopeDiffOpts {
  scopeJsonPath?: string;
  headRef?: string;
  impactService?: ImpactRadiusService;
  /** @internal Test seam — overrides internal git staged-paths lookup. */
  _getStagedPaths?: () => string[] | null;
}

export interface ScopeDiffResult {
  status: 'ok' | 'outside_scope' | 'no_scope' | 'malformed_scope' | 'enumeration_failed';
  staged_count?: number;
  staged_paths_outside_scope?: string[];
  scope_json_path?: string;
  head_ref?: string;
  suggested_remediation?: string;
  error?: string;
}

/**
 * AP-EXT-ITER41-01: the ONE predicate for "the fence could not render a verdict".
 *
 * `malformed_scope` and `enumeration_failed` differ only in WHY the fence is
 * unreadable — a garbage `allowed_paths` versus a git enumeration that never
 * completed. Neither is a finding about the tree, so every consumer owes them a
 * single shared disposition (the CLI exits 2 on both). Splitting them lets a
 * consumer handle one and let the other fall through its "not outside_scope"
 * return, which reports a fence that never ran as a fence that passed.
 */
export function isUnevaluableScopeStatus(status: ScopeDiffResult['status']): boolean {
  return status === 'malformed_scope' || status === 'enumeration_failed';
}

function normalizePath(p: string): string {
  return p.replace(/\/$/, '');
}

function isPathInScope(stagedPath: string, allowedPaths: string[]): boolean {
  const normalized = normalizePath(stagedPath);
  return allowedPaths.some((allowed) => {
    const normalizedAllowed = normalizePath(allowed);
    return normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + '/');
  });
}

// R-TDCS (#128): a subsystem `CLAUDE.md` is anatomy-park's own trap-door catalog
// deliverable. A trap door is by definition a PRE-EXISTING invariant, so its
// catalog file is almost never in the feature diff — strict branch-diff scope
// (`allowed_paths`) then fences out the very file the tool exists to write, and
// identified trap doors die in session-ephemeral `anatomy-park.json`. Exempt
// `CLAUDE.md` catalog files from the scope-violation check: they are
// documentation-only tool output, not code scope creep. The fence on source
// files stays fully intact. This also subsumes the Layer-2 staleness case — a
// just-written `CLAUDE.md` no longer depends on a frozen `allowed_paths`.
function isTrapDoorCatalogPath(stagedPath: string): boolean {
  const n = normalizePath(stagedPath);
  return n === 'CLAUDE.md' || n.endsWith('/CLAUDE.md');
}

function maybeEmitImpactWarning(
  service: ImpactRadiusService | undefined,
  stagedPaths: string[],
  allowedPaths: string[],
): void {
  if (!service || stagedPaths.length === 0) return;
  let dependents: string[] | null;
  try {
    dependents = service.getImpactRadius(stagedPaths, 2);
  } catch {
    return; // fail-open — service error never blocks the gate
  }
  if (!Array.isArray(dependents) || dependents.length === 0) return;
  const outside = dependents.filter((d) => !isPathInScope(d, allowedPaths));
  if (outside.length === 0) return;
  try {
    logActivity({
      event: 'scope_impact_warning',
      source: 'pickle',
      gate_payload: {
        staged_paths: stagedPaths,
        transitive_dependents_outside_scope: outside,
        radius_depth: 2,
      },
    });
  } catch {
    // Telemetry must never block the caller.
  }
}

/**
 * AP-EXT-ITER31-01: `-z` is load-bearing, not cosmetic. `allowed_paths` is built
 * from `--name-status -M100 -z` (`scope-resolver.ts:computeAllowedFromDiff`), so
 * this reader must cross the SAME git contract. Without `-z`, `core.quotePath`
 * (on by default) C-quotes every non-ASCII path — `café.ts` reads back as the
 * literal `"caf\303\251.ts"`, matches nothing in the fence, and an explicitly
 * ALLOWED file is reported `outside_scope`. Fix the contract, never un-quote in JS.
 */
function getStagedPaths(): string[] | null {
  const result = spawnSync('git', ['diff', '--staged', '--name-only', '--no-renames', '-z'], {
    encoding: 'utf-8',
    timeout: 15_000,
    // AP-EXT-ITER38-01: the staged name list is an unbounded enumeration, so it
    // declares the ONE ceiling (AP-EXT-ITER8-01) instead of inheriting Node's 1 MB
    // default. Past it Node SIGTERMs git and hands back the first megabyte with
    // `status === null`, which the guard below can only read as "could not enumerate".
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
  });
  // An enumeration that did not complete is NOT an empty enumeration. `[]` is a
  // POSITIVE finding ("nothing is staged") that `checkScopeDiff` turns into a green
  // fence; a failed/truncated/timed-out read has found nothing of the sort. Same
  // predicate as before — only the verdict it reports changed, from a fabricated
  // answer to no answer. Sibling readers already draw this line: `git-utils.ts:
  // listWorkingTreeDirtyPaths` throws, `mux-runner.ts:computeSourceTreeSignature`
  // returns null.
  if ((result.status ?? 1) !== 0) return null;
  return (result.stdout || '').split('\0').filter(Boolean);
}

/**
 * AP-EXT-ITER40-01: `scope.json` is written tmp-rename (`scope-resolver.ts:writeScopeJson`
 * — `writeFileSync(<p>.tmp.<pid>)` then `renameSync`), so a killed writer leaves the ONLY
 * valid fence in a sibling `.tmp.<pid>`. Every other scope reader crosses that window
 * through the one recovery primitive, which PROMOTES the orphan onto the base path
 * (`scope-resolver.ts:refreshScope`, `check-gate.ts:readAllowedPaths`,
 * `pipeline-runner.ts:readPersistedAllowedPaths`, `microverse-runner.ts:
 * resolveScopeAuditInputs`). This reader raw-read `existsSync` + `JSON.parse` instead, so
 * the fence read as ABSENT — and `no_scope` exits 0.
 *
 * Absence is therefore decided AFTER the recovering read, never as a pre-gate above it
 * (the AP-EXT-ITER16-01 / AP-EXT-ITER6-02 shape): a pre-gate short-circuits the very
 * promotion on the next line, making the recovery dead code.
 */
function resolveAllowedPaths(
  scopeJsonPath: string,
): { ok: true; allowedPaths: string[] } | { ok: false; result: ScopeDiffResult } {
  let recovered: object | null;
  try {
    recovered = readRecoverableJsonObject(scopeJsonPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, result: { status: 'malformed_scope', error: `Failed to parse scope.json: ${msg}` } };
  }

  if (!recovered) {
    // Below the recovery, not above it. A null here is "no base AND no promotable
    // orphan"; only then is the session genuinely unscoped.
    return fs.existsSync(scopeJsonPath)
      ? { ok: false, result: { status: 'malformed_scope', error: 'Failed to parse scope.json: not a JSON object' } }
      : { ok: false, result: { status: 'no_scope' } };
  }

  const field = (recovered as { allowed_paths?: unknown }).allowed_paths;
  if (!Array.isArray(field) || !field.every((p: unknown) => typeof p === 'string')) {
    return {
      ok: false,
      result: { status: 'malformed_scope', error: 'scope.json missing or invalid allowed_paths array' },
    };
  }
  return { ok: true, allowedPaths: field as string[] };
}

export function checkScopeDiff(opts: CheckScopeDiffOpts = {}): ScopeDiffResult {
  const scopeJsonPath = opts.scopeJsonPath;
  const headRef = opts.headRef ?? 'HEAD';
  const getStagedFn = opts._getStagedPaths ?? getStagedPaths;

  if (!scopeJsonPath) {
    return { status: 'no_scope' };
  }

  const resolved = resolveAllowedPaths(scopeJsonPath);
  if (!resolved.ok) {
    return resolved.result;
  }

  const allowedPaths: string[] = resolved.allowedPaths;
  const staged = getStagedFn();
  if (staged === null) {
    return {
      status: 'enumeration_failed',
      scope_json_path: scopeJsonPath,
      head_ref: headRef,
      error: 'git diff --staged could not be enumerated; scope fence was not evaluated',
    };
  }
  const outside = staged.filter((p) => !isPathInScope(p, allowedPaths) && !isTrapDoorCatalogPath(p));

  if (outside.length === 0) {
    maybeEmitImpactWarning(opts.impactService, staged, allowedPaths);
    return { status: 'ok', staged_count: staged.length };
  }

  maybeEmitImpactWarning(opts.impactService, staged, allowedPaths);
  return {
    status: 'outside_scope',
    staged_paths_outside_scope: outside,
    scope_json_path: scopeJsonPath,
    head_ref: headRef,
    suggested_remediation:
      'Unstage outside-scope paths or expand scope.json:allowed_paths before committing.',
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-scope-diff.js') {
  const args = process.argv.slice(2);

  function parseArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  let scopeJsonPath = parseArg('--scope-json');
  let headRef = parseArg('--head-ref');
  let ticketId = parseArg('--ticket-id');

  // Optionally read from stdin JSON
  if (!scopeJsonPath && !process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync('/dev/stdin', 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.scope_json_path) scopeJsonPath = parsed.scope_json_path;
        if (parsed.head_ref) headRef = parsed.head_ref;
        if (parsed.ticket_id) ticketId = parsed.ticket_id;
      }
    } catch {
      // stdin parse failure is non-fatal — fall through to CLI args / defaults
    }
  }

  const result = checkScopeDiff({ scopeJsonPath, headRef });

  if (result.status === 'no_scope' || result.status === 'ok') {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  // Both statuses mean the same thing to the caller — the fence could not render a
  // verdict — so they share ONE disposition and one exit code. Exiting 0 on either
  // would report a fence that never ran as a fence that passed.
  if (isUnevaluableScopeStatus(result.status)) {
    process.stderr.write(JSON.stringify({ error: result.error, status: result.status }) + '\n');
    process.exit(2);
  }

  // outside_scope → emit audit event then exit 1.
  // AC-APWS-1 requires a `worker_edit_outside_scope` activity event so
  // /pickle-status renderScopeDrift can surface drift to the operator.
  try {
    logActivity({
      event: 'worker_edit_outside_scope',
      source: 'pickle',
      ...(ticketId ? { ticket_id: ticketId } : {}),
      gate_payload: {
        scope_json_path: result.scope_json_path ?? scopeJsonPath ?? '',
        staged_paths_outside_scope: result.staged_paths_outside_scope ?? [],
        head_ref: result.head_ref ?? headRef ?? 'HEAD',
        suggested_remediation: result.suggested_remediation ?? '',
      },
    });
  } catch {
    // logActivity buffers on failure; never block the gate exit on telemetry.
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(1);
}
