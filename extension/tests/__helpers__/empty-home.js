import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function mkTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Points HOME at an empty dir so the resolver's ~/.claude.json fallback misses
// deterministically (the dev/CI host may have a real ~/.claude.json).
export function withEmptyHome(fn) {
    const prevHome = process.env.HOME;
    const emptyHome = mkTmpDir('empty-home-');
    process.env.HOME = emptyHome;
    try {
        return fn();
    } finally {
        if (prevHome === undefined) { delete process.env.HOME; }
        else process.env.HOME = prevHome;
        rmDir(emptyHome);
    }
}
