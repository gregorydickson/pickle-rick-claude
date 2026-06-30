// @tier: fast
// F5 / R-APV-1: spawn-refinement-team must wire checkAnalystOutputPaths into
// manifest build so unverified backticked paths surface as
// ticket_quality_warnings BEFORE the readiness gate halts the pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanAnalystOutputsForUnverifiedPaths } from '../bin/spawn-refinement-team.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpDir(prefix = 'pickle-apv-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'real-file.ts'), '// real\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

test('scanAnalystOutputsForUnverifiedPaths: emits warning for phantom backticked path', () => {
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        // Analyst output cites a path that does NOT exist at HEAD and is NOT annotated.
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_codebase.md'),
            '# Analysis\n\nCitation: `extension/services/phantom.ts` — does not exist anywhere.\n'
        );
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].defect_class, 'analyst_path_not_verified');
        assert.match(warnings[0].evidence, /analyst=codebase/);
        assert.match(warnings[0].evidence, /extension\/services\/phantom\.ts/);
        assert.equal(warnings[0].source, 'analyst');
        assert.equal(warnings[0].file_line, 'analysis_codebase.md');
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('scanAnalystOutputsForUnverifiedPaths: ignores non-canonical (per-cycle) files', () => {
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        // Per-cycle file should NOT be scanned (synthesis uses canonical only).
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_codebase_c1.md'),
            '# Analysis cycle 1\n\nCitation: `extension/services/phantom-c1.ts`\n'
        );
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 0);
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('scanAnalystOutputsForUnverifiedPaths: emits warning when citing real-but-untracked path', () => {
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        // Create the file but don't track it via git — git ls-files returns empty.
        fs.writeFileSync(path.join(workingDir, 'untracked.ts'), '// new\n');
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_codebase.md'),
            '# Analysis\n\nCitation: `extension/services/untracked.ts`\n'
        );
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].evidence, /extension\/services\/untracked\.ts/);
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});
