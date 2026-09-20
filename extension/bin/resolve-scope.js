import * as path from 'path';
import { resolveScope, ScopeError } from '../services/scope-resolver.js';
const USAGE = 'Usage: resolve-scope --scope <flag> --session-root <path> [--scope-base <ref>] [--target <path>]';
function parseFlag(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length)
        return undefined;
    return args[idx + 1];
}
if (process.argv[1] && path.basename(process.argv[1]) === 'resolve-scope.js') {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(USAGE);
        process.exit(0);
    }
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
        if (err instanceof Error && err instanceof ScopeError) {
            process.stderr.write(JSON.stringify({ code: err.code, message: err.message }) + '\n');
        }
        else {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(JSON.stringify({ code: 'UNKNOWN', message }) + '\n');
        }
        process.exit(2);
    }
}
