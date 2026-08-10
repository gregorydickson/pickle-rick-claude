#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
function normalizePath(p) {
    return p.replace(/\/$/, '');
}
function isPathInScope(stagedPath, allowedPaths) {
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
function isTrapDoorCatalogPath(stagedPath) {
    const n = normalizePath(stagedPath);
    return n === 'CLAUDE.md' || n.endsWith('/CLAUDE.md');
}
function maybeEmitImpactWarning(service, stagedPaths, allowedPaths) {
    if (!service || stagedPaths.length === 0)
        return;
    let dependents;
    try {
        dependents = service.getImpactRadius(stagedPaths, 2);
    }
    catch {
        return; // fail-open — service error never blocks the gate
    }
    if (!Array.isArray(dependents) || dependents.length === 0)
        return;
    const outside = dependents.filter((d) => !isPathInScope(d, allowedPaths));
    if (outside.length === 0)
        return;
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
    }
    catch {
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
function getStagedPaths() {
    const result = spawnSync('git', ['diff', '--staged', '--name-only', '--no-renames', '-z'], {
        encoding: 'utf-8',
        timeout: 15_000,
    });
    if ((result.status ?? 1) !== 0)
        return [];
    return (result.stdout || '').split('\0').filter(Boolean);
}
export function checkScopeDiff(opts = {}) {
    const scopeJsonPath = opts.scopeJsonPath;
    const headRef = opts.headRef ?? 'HEAD';
    const getStagedFn = opts._getStagedPaths ?? getStagedPaths;
    if (!scopeJsonPath || !fs.existsSync(scopeJsonPath)) {
        return { status: 'no_scope' };
    }
    let scopeData;
    try {
        scopeData = JSON.parse(fs.readFileSync(scopeJsonPath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'malformed_scope', error: `Failed to parse scope.json: ${msg}` };
    }
    if (!scopeData ||
        typeof scopeData !== 'object' ||
        !Array.isArray(scopeData.allowed_paths) ||
        !scopeData.allowed_paths.every((p) => typeof p === 'string')) {
        return { status: 'malformed_scope', error: 'scope.json missing or invalid allowed_paths array' };
    }
    const allowedPaths = scopeData.allowed_paths;
    const staged = getStagedFn();
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
        suggested_remediation: 'Unstage outside-scope paths or expand scope.json:allowed_paths before committing.',
    };
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-scope-diff.js') {
    const args = process.argv.slice(2);
    function parseArg(flag) {
        const idx = args.indexOf(flag);
        if (idx === -1 || idx + 1 >= args.length)
            return undefined;
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
                if (parsed.scope_json_path)
                    scopeJsonPath = parsed.scope_json_path;
                if (parsed.head_ref)
                    headRef = parsed.head_ref;
                if (parsed.ticket_id)
                    ticketId = parsed.ticket_id;
            }
        }
        catch {
            // stdin parse failure is non-fatal — fall through to CLI args / defaults
        }
    }
    const result = checkScopeDiff({ scopeJsonPath, headRef });
    if (result.status === 'no_scope' || result.status === 'ok') {
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(0);
    }
    if (result.status === 'malformed_scope') {
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
    }
    catch {
        // logActivity buffers on failure; never block the gate exit on telemetry.
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(1);
}
