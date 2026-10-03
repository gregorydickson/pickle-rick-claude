import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filterBySubsystem, resolveScope, ScopeError } from '../services/scope-resolver.js';
const USAGE = 'Usage: resolve-scope --scope <flag> --session-root <path> [--scope-base <ref>] [--target <path>]\n'
    + '       resolve-scope --print-subsystems --target <dir> [--scope <flag>] [--scope-base <ref>]';
function parseFlag(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length)
        return undefined;
    return args[idx + 1];
}
function reportScopeError(err) {
    if (err instanceof Error && err instanceof ScopeError) {
        process.stderr.write(JSON.stringify({ code: err.code, message: err.message }) + '\n');
    }
    else {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(JSON.stringify({ code: 'UNKNOWN', message }) + '\n');
    }
}
/**
 * `--print-subsystems`: print the review lanes the anatomy-park PIPELINE would
 * rotate over, so the standalone `/anatomy-park` command reads the compiled rule
 * (`discoverLanes` + `filterBySubsystem`) instead of restating it in prose.
 *
 * Discovery is total: a failed discovery prints `[]` and exits 0 — the caller
 * reads that as "no lanes" exactly as the pipeline does. A `--scope` that cannot
 * be resolved is NOT degraded discovery: it refuses (exit 2, nothing on stdout),
 * because printing the unfiltered roster would widen the review past the fence.
 * The pipeline runner is imported lazily so the plain scope-resolution path
 * never pays for it.
 */
async function printSubsystems(args) {
    const target = path.resolve(parseFlag(args, '--target') ?? process.cwd());
    const scopeFlag = parseFlag(args, '--scope');
    let lanes = [];
    let generated = new Set();
    let gitRepoRoot = (cwd) => cwd;
    try {
        const runner = await import('./pipeline-runner.js');
        gitRepoRoot = runner.gitRepoRoot;
        ({ lanes, generated } = runner.discoverLanes(target));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`resolve-scope: lane discovery degraded — ${message}\n`);
    }
    if (scopeFlag !== undefined) {
        const givenRoot = parseFlag(args, '--session-root');
        const sessionRoot = givenRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-scope-print-'));
        // process.exit skips `finally`, so the scratch root is removed explicitly on both arms.
        const cleanup = () => { if (givenRoot === undefined)
            fs.rmSync(sessionRoot, { recursive: true, force: true }); };
        try {
            const scope = resolveScope({
                scopeFlag,
                scopeBase: parseFlag(args, '--scope-base'),
                target,
                sessionRoot,
                repoRoot: process.cwd(),
            });
            lanes = filterBySubsystem(lanes, scope.allowed_paths, target, gitRepoRoot(process.cwd()), generated);
        }
        catch (err) {
            cleanup();
            reportScopeError(err);
            process.exit(2);
        }
        cleanup();
    }
    process.stdout.write(`${JSON.stringify(lanes, null, 2)}\n`);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'resolve-scope.js') {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(USAGE);
        process.exit(0);
    }
    if (args.includes('--print-subsystems')) {
        // No process.exit on success: stdout may be a pipe, and an explicit exit after a write
        // can drop everything past the pipe buffer. Falling off the event loop flushes it.
        printSubsystems(args).catch((err) => {
            reportScopeError(err);
            process.exit(2);
        });
    }
    else {
        runScopeResolution(args);
    }
}
function runScopeResolution(args) {
    const scopeFlag = parseFlag(args, '--scope');
    const sessionRoot = parseFlag(args, '--session-root');
    if (!scopeFlag || !sessionRoot) {
        process.stderr.write(`${USAGE}\n`);
        process.exit(1);
    }
    const scopeBase = parseFlag(args, '--scope-base');
    const target = parseFlag(args, '--target');
    try {
        resolveScope({
            scopeFlag,
            scopeBase,
            target,
            sessionRoot,
            // `paths:<glob>` is always resolved against the git repository toplevel so the
            // same --scope value produces identical allowed_paths regardless of which
            // working_dir invoked this CLI (R-RSBI-2). The anchoring is `resolveScope`'s own
            // (`resolveRepoToplevel`, AP-EXT-ITER322-01): it derives the toplevel from whatever
            // directory it is handed, so a raw cwd here IS the toplevel reading. Resolving it a
            // second time here would be a fifth spelling of one predicate whose every arm the
            // callee already repeats (AP-EXT-ITER326-01).
            repoRoot: process.cwd(),
        });
    }
    catch (err) {
        reportScopeError(err);
        process.exit(2);
    }
}
