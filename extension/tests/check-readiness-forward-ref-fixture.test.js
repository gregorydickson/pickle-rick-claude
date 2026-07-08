// @tier: fast
// R-RTRC-6: regression suite — fixture tickets exercising each of:
//   RC-2: test-defined helper resolves via lifted tests/ exclusion (R-RTRC-3)
//   RC-3: deep repo path resolves via git ls-files suffix-match (R-RTRC-4)
// AC-RTRC-01: contract-only run on a regression fixture exits 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const REPO_ROOT = path.resolve(__dirname, '..');

function tmpDir(prefix = 'pickle-rtrc-fixture-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${id}.md`);
    fs.writeFileSync(ticketPath, body);
    return ticketPath;
}

function runReadiness(sessionDir, repoRoot = REPO_ROOT, extraArgs = []) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
        '--contract-only',
        ...extraArgs,
    ], { encoding: 'utf-8', timeout: 15000 });
}

test('R-RTRC-6 RC-2: test-defined helper resolves via lifted tests/ exclusion', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-rtrc-repo-');
    try {
        // Build a tiny git repo whose only source is a test helper. With the
        // pre-fix `tests/` exclusion, the helper would not be in the resolver
        // scope and the contract finding would fire. R-RTRC-3 lifts the
        // exclusion so the symbol resolves.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'rtrc@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'rtrc'], { cwd: repoRoot });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'helper-fixture.test.js'),
            'export class RtrcHelperRune { static buildSeed() { return 42; } }\n',
        );
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        const symbol = 'RtrcHelperRune.buildSeed()';
        writeTicket(sessionDir, 'rc2test1', [
            '---',
            'id: rc2test1',
            'key: RC2-TEST',
            'ac_ids: []',
            '---',
            '',
            '# RC-2 test-defined helper',
            '',
            '## Interface Contracts',
            '',
            `- \`${symbol}\` MUST exist.`,
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] `node --test tests/helper-fixture.test.js` exits 0.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const contractFindings = out.findings.filter((f) => f.kind === 'contract' && f.detail === symbol);
        assert.equal(contractFindings.length, 0, 'R-RTRC-3 should resolve test-defined helper');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('AC-B1 B1-PHANTOM: genuine phantom (no declaration, no HEAD file) still flags', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-b1-repo-');
    try {
        // Empty git repo so the path cannot resolve via bases or git ls-files,
        // and the ticket declares nothing forward-created. Teeth must fire.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'b1@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'b1'], { cwd: repoRoot });
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        const phantom = 'extension/services/b1phantom-nonexistent.ts';
        writeTicket(sessionDir, 'b1phan01', [
            '---',
            'id: b1phan01',
            'key: B1-PHANTOM',
            'ac_ids: []',
            '---',
            '',
            '# B1 genuine phantom',
            '',
            '## Description',
            '',
            `Touches \`${phantom}\` but never declares it forward-created.`,
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Field `kind` equals exactly `phantom`.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.notEqual(result.status, 0, `expected non-zero exit for phantom; stdout=${result.stdout}; stderr=${result.stderr}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'fail');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path' && f.detail === phantom);
        assert.equal(pathFindings.length, 1, `genuine phantom must flag exactly once; got ${JSON.stringify(out.findings)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('AC-B2 B2-REPOPREFIX: `<repo-basename>/CLAUDE.md` resolves to HEAD CLAUDE.md', () => {
    const sessionDir = tmpDir();
    // Repo dir is literally named `pickle-rick-claude` so path.basename(repoRoot)
    // === 'pickle-rick-claude', matching the ticket's literal B-CGH shape.
    const repoRoot = path.join(tmpDir('pickle-b2-parent-'), 'pickle-rick-claude');
    try {
        fs.mkdirSync(repoRoot, { recursive: true });
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'b2@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'b2'], { cwd: repoRoot });
        fs.writeFileSync(path.join(repoRoot, 'CLAUDE.md'), '# project rules\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        writeTicket(sessionDir, 'b2pre001', [
            '---',
            'id: b2pre001',
            'key: B2-REPOPREFIX',
            'ac_ids: []',
            '---',
            '',
            '# B2 repo-name-prefixed ref',
            '',
            '## Files',
            '',
            // Repo-basename prefix must be stripped → resolves to HEAD CLAUDE.md.
            '- `pickle-rick-claude/CLAUDE.md`',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] File `CLAUDE.md` exists at HEAD.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path');
        assert.equal(pathFindings.length, 0, `repo-prefixed ref must resolve via basename strip; got ${JSON.stringify(pathFindings)}`);
    } finally {
        fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AC-B2 B2-NONMATCH: non-matching prefix `other-repo/X` is NOT stripped (still flags)', () => {
    const sessionDir = tmpDir();
    const repoRoot = path.join(tmpDir('pickle-b2-parent-'), 'pickle-rick-claude');
    try {
        // Same repo (basename `pickle-rick-claude`, has CLAUDE.md), but the ref's
        // leading segment is `other-repo` — NOT the repo basename. It must not be
        // stripped, and `other-repo/CLAUDE.md` exists nowhere → genuine phantom.
        fs.mkdirSync(repoRoot, { recursive: true });
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'b2@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'b2'], { cwd: repoRoot });
        fs.writeFileSync(path.join(repoRoot, 'CLAUDE.md'), '# project rules\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        const ref = 'other-repo/CLAUDE.md';
        writeTicket(sessionDir, 'b2non001', [
            '---',
            'id: b2non001',
            'key: B2-NONMATCH',
            'ac_ids: []',
            '---',
            '',
            '# B2 non-matching prefix stays intact',
            '',
            '## Description',
            '',
            `Touches \`${ref}\` — a foreign-repo prefix that must not be stripped.`,
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Field `kind` equals exactly `phantom`.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.notEqual(result.status, 0, `expected non-zero exit for non-matching prefix; stdout=${result.stdout}; stderr=${result.stderr}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'fail');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path' && f.detail === ref);
        assert.equal(pathFindings.length, 1, `non-matching prefix must NOT be stripped and must flag once; got ${JSON.stringify(out.findings)}`);
    } finally {
        fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AC-B3 two-class: genuine phantom (no forward-create, no HEAD) → hard-halt (exit 2)', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-b3-repo-');
    try {
        // Empty git repo so the ref resolves via NEITHER the forward-created set
        // (nothing declared) NOR the HEAD path set (not tracked). AC-B3 class 2: a
        // true phantom hard-halts with exit 2 and exactly one file_path finding.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'b3@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'b3'], { cwd: repoRoot });
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        const phantom = 'extension/services/b3phantom-nonexistent.ts';
        writeTicket(sessionDir, 'b3phan01', [
            '---',
            'id: b3phan01',
            'key: B3-PHANTOM',
            'ac_ids: []',
            '---',
            '',
            '# AC-B3 genuine phantom hard-halts',
            '',
            '## Description',
            '',
            `Touches \`${phantom}\` but never declares it forward-created.`,
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Field `kind` equals exactly `phantom`.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 2, `expected hard-halt exit 2 for phantom; got ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'fail');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path' && f.detail === phantom);
        assert.equal(pathFindings.length, 1, `genuine phantom must hard-halt exactly once; got ${JSON.stringify(out.findings)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('AC-B3 shape: ReadinessFinding has NO certainty/score field (no third tier)', () => {
    // The two-class predicate forbids an intermediate tier. Assert the source
    // ReadinessFinding interface carries no such field and the source never names
    // one. The forbidden token is built at runtime so this assertion does not
    // itself plant the literal in a way the AC grep (scoped to src/) would count.
    const src = fs.readFileSync(path.resolve(REPO_ROOT, 'src/bin/check-readiness.ts'), 'utf-8');
    const forbidden = ['conf', 'idence'].join('');
    assert.equal(src.includes(forbidden), false, `ReadinessFinding must not gain a ${forbidden} field (AC-B3: two classes only)`);
    // Pin the interface field set so an added field is caught structurally.
    const ifaceMatch = src.match(/export interface ReadinessFinding\s*\{([\s\S]*?)\}/);
    assert.ok(ifaceMatch, 'ReadinessFinding interface must exist');
    const fieldNames = [...ifaceMatch[1].matchAll(/^\s*([A-Za-z_]\w*)\??\s*:/gm)].map((m) => m[1]).sort();
    assert.deepEqual(fieldNames, ['analyst', 'detail', 'kind', 'message', 'ticket'],
        `ReadinessFinding fields must stay the canonical 5 (no added tier field); got ${JSON.stringify(fieldNames)}`);
});

test('R-RTRC-6 RC-3: deep repo path resolves via git ls-files suffix-match', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-rtrc-repo-');
    try {
        // Deep nested file. None of resolvePathRef's static bases (repoRoot,
        // repoRoot/extension, ticket cwd, sessionDir) resolve `nested-deep.ts`
        // alone. R-RTRC-4 falls back to `git ls-files | grep '/<ref>$'`.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'rtrc@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'rtrc'], { cwd: repoRoot });
        const deepDir = path.join(repoRoot, 'packages', 'core', 'src', 'modules', 'rtrc', 'deep');
        fs.mkdirSync(deepDir, { recursive: true });
        fs.writeFileSync(path.join(deepDir, 'nested-deep.ts'), 'export const sigil = true;\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        writeTicket(sessionDir, 'rc3deep1', [
            '---',
            'id: rc3deep1',
            'key: RC3-DEEP',
            'ac_ids: []',
            '---',
            '',
            '# RC-3 deep repo path',
            '',
            '## Files',
            '',
            // Bare basename — only the suffix-match fallback can resolve this.
            '- `nested-deep.ts`',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] File `nested-deep.ts` exists at HEAD.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path');
        assert.equal(pathFindings.length, 0, 'R-RTRC-4 suffix-match must resolve deep path');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
