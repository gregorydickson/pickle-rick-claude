// @tier: integration
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEAL_SCRIPT = path.resolve(__dirname, '../../scripts/heal-deferred-tickets.sh');

const tmpDirs = [];

function makeTmpDir(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

// Returns a bin dir containing a fake `npm` that always exits 0.
function makeFakeNpmBin() {
    const binDir = path.join(makeTmpDir('heal-fakenpm-'), 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const npmScript = path.join(binDir, 'npm');
    fs.writeFileSync(npmScript, '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(npmScript, 0o755);
    return binDir;
}

// Build a minimal ticket frontmatter with a DEFERRED body line.
function makeTicketContent(id, status, completionCommit) {
    const lines = [
        '---',
        `id: ${id}`,
        `title: "Heal test ticket ${id}"`,
        `status: "${status}"`,
    ];
    if (completionCommit) lines.push(`completion_commit: ${completionCommit}`);
    lines.push('---');
    lines.push('# Description');
    lines.push('');
    lines.push('# DEFERRED: waiting on R-WMW to ship');
    lines.push('');
    lines.push('Some body text.');
    return lines.join('\n') + '\n';
}

// Build a fixture session dir with one ticket file.
function makeFixture(id, status, completionCommit) {
    const sessionDir = makeTmpDir('heal-session-');
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketFile = path.join(ticketDir, `rick_ticket_${id}.md`);
    fs.writeFileSync(ticketFile, makeTicketContent(id, status, completionCommit));
    return { sessionDir, ticketFile };
}

function runHeal(sessionDir, pairs, extraEnv = {}) {
    return spawnSync('bash', [HEAL_SCRIPT, sessionDir, ...pairs], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ...extraEnv },
    });
}

after(() => {
    for (const d of tmpDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test('heal-script: flips Skipped+completion_commit ticket to Done', () => {
    const id = 'abcd1234';
    const commit = 'deadbeef01234567';
    const { sessionDir, ticketFile } = makeFixture(id, 'Skipped', commit);
    const fakeNpmBin = makeFakeNpmBin();

    const result = runHeal(sessionDir, [`${id}:${commit}`], {
        PATH: fakeNpmBin + path.delimiter + process.env.PATH,
    });

    assert.equal(result.status, 0, `heal-script exited non-zero:\n${result.stderr}`);

    const healed = fs.readFileSync(ticketFile, 'utf8');
    assert.match(healed, /^status: "Done"/m, 'status must be "Done"');
    assert.match(healed, new RegExp(`completion_commit: ${commit}`), 'completion_commit must be preserved');
    assert.match(healed, /^healed_at: \d{4}-\d{2}-\d{2}T/m, 'healed_at must be injected');
    assert.doesNotMatch(healed, /^# DEFERRED:/m, '# DEFERRED: line must be removed');
    assert.match(healed, /Some body text\./, 'body text must be preserved');
    assert.match(result.stdout + result.stderr, /\[healed\]/, 'output must contain [healed]');
});

test('heal-script: idempotent — second run leaves frontmatter byte-identical', () => {
    const id = 'idem5678';
    const commit = 'cafe0000cafe0000';
    const { sessionDir, ticketFile } = makeFixture(id, 'Skipped', commit);
    const fakeNpmBin = makeFakeNpmBin();
    const env = { PATH: fakeNpmBin + path.delimiter + process.env.PATH };

    // First run — heals
    const r1 = runHeal(sessionDir, [`${id}:${commit}`], env);
    assert.equal(r1.status, 0, `first heal failed:\n${r1.stderr}`);

    const afterFirst = fs.readFileSync(ticketFile, 'utf8');
    assert.match(afterFirst, /^status: "Done"/m, 'status must be Done after first run');

    // Second run — idempotent
    const r2 = runHeal(sessionDir, [`${id}:${commit}`], env);
    assert.equal(r2.status, 0, `second heal failed:\n${r2.stderr}`);

    const afterSecond = fs.readFileSync(ticketFile, 'utf8');
    assert.equal(afterSecond, afterFirst, 'frontmatter must be byte-identical after second run');

    // Second run reports [skip] already Done
    assert.match(r2.stdout + r2.stderr, /\[skip\].*already Done/i, 'second run must report skip');
});

test('heal-script: non-existent ticket exits 0 with [skip] on stderr', () => {
    const sessionDir = makeTmpDir('heal-missing-');
    const fakeId = 'no000000';

    const result = runHeal(sessionDir, [`${fakeId}:abc123`]);

    assert.equal(result.status, 0, 'must exit 0 for missing ticket');
    assert.match(result.stderr, /\[skip\]/, 'must emit [skip] to stderr');
    assert.match(result.stderr, new RegExp(fakeId), 'stderr must name the ticket id');
});

test('heal-script: non-Skipped ticket (e.g. Todo) is skipped without healing', () => {
    const id = 'todo9999';
    const commit = 'feedfeed00000000';
    const { sessionDir, ticketFile } = makeFixture(id, 'Todo', commit);
    const originalContent = fs.readFileSync(ticketFile, 'utf8');

    const result = runHeal(sessionDir, [`${id}:${commit}`]);

    assert.equal(result.status, 0, 'must exit 0 for non-Skipped ticket');
    assert.match(result.stderr, /\[skip\]/, 'must emit [skip] to stderr');

    const afterContent = fs.readFileSync(ticketFile, 'utf8');
    assert.equal(afterContent, originalContent, 'ticket file must be unchanged');
});
