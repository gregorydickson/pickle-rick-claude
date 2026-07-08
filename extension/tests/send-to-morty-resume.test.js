// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MORTY_COMMAND = path.join(REPO_ROOT, '.claude', 'commands', 'send-to-morty.md');
const REVIEW_COMMAND = path.join(REPO_ROOT, '.claude', 'commands', 'send-to-morty-review.md');

function readCommand(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}

function makeTmpTicket() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-morty-resume-')));
    const ticketDir = path.join(root, 'ticket');
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
        path.join(ticketDir, 'rick_ticket_abc123.md'),
        ['---', 'id: abc123', 'updated: "2026-05-01"', '---', '', '# Ticket', ''].join('\n')
    );
    return { root, ticketDir, projectDir };
}

function writeArtifact(ticketDir, name, content, mtime = new Date('2026-05-02T00:00:00Z')) {
    const filePath = path.join(ticketDir, name);
    fs.writeFileSync(filePath, content);
    fs.utimesSync(filePath, mtime, mtime);
    return filePath;
}

function latestArtifact(ticketDir, pattern) {
    const [prefix, suffix] = pattern.split('*');
    return fs.readdirSync(ticketDir)
        .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
        .sort()
        .at(-1);
}

function ticketUpdatedTime(ticketDir) {
    const ticketFile = fs.readdirSync(ticketDir).find((name) => /^rick_ticket_.*\.md$/.test(name));
    assert.ok(ticketFile, 'fixture must include a linear ticket file');
    const body = fs.readFileSync(path.join(ticketDir, ticketFile), 'utf-8');
    const match = body.match(/^updated:\s*"?([^"\n]+)"?/m);
    assert.ok(match, 'fixture ticket must include updated frontmatter');
    return new Date(`${match[1]}T00:00:00Z`).getTime();
}

function reviewIsFreshAndApproved(ticketDir, reviewName) {
    const reviewPath = path.join(ticketDir, reviewName);
    if (!fs.existsSync(reviewPath)) {
        return false;
    }
    const content = fs.readFileSync(reviewPath, 'utf-8');
    if (/\b(NEEDS REVISION|REJECTED)\b/.test(content) || !/\bAPPROVED\b/.test(content)) {
        return false;
    }
    return fs.statSync(reviewPath).mtime.getTime() >= ticketUpdatedTime(ticketDir);
}

function firstMortyWrite(ticketDir, projectDir) {
    const hasFreshApprovedResearch = latestArtifact(ticketDir, 'research_*.md')
        && reviewIsFreshAndApproved(ticketDir, 'research_review.md');
    if (!hasFreshApprovedResearch) {
        return path.join(ticketDir, 'research_2026-05-01.md');
    }

    const hasFreshApprovedPlan = latestArtifact(ticketDir, 'plan_*.md')
        && reviewIsFreshAndApproved(ticketDir, 'plan_review.md');
    if (!hasFreshApprovedPlan) {
        return path.join(ticketDir, 'plan_2026-05-01.md');
    }

    return path.join(projectDir, 'source-change.txt');
}

test('send-to-morty prompts contain Resume Detection blocks in the entry position', () => {
    const morty = readCommand(MORTY_COMMAND);
    assert.ok(morty.includes('## Resume Detection (run BEFORE Step 1)'));
    assert.ok(
        morty.indexOf('## Init') < morty.indexOf('## Resume Detection (run BEFORE Step 1)'),
        'main resume block must follow Init'
    );
    assert.ok(
        morty.indexOf('## Resume Detection (run BEFORE Step 1)') < morty.indexOf('## Session Knowledge Transfer'),
        'main resume block must precede Session Knowledge Transfer'
    );

    const review = readCommand(REVIEW_COMMAND);
    assert.ok(review.includes('## Resume Detection (run BEFORE Phase 1)'));
    assert.ok(
        review.indexOf('## Init') < review.indexOf('## Resume Detection (run BEFORE Phase 1)'),
        'review resume block must follow Init'
    );
    assert.ok(
        review.indexOf('## Resume Detection (run BEFORE Phase 1)') < review.indexOf('## Lifecycle'),
        'review resume block must precede Lifecycle'
    );
});

test('send-to-morty resume: empty dir first writes research artifact', () => {
    const fixture = makeTmpTicket();
    try {
        const firstWrite = firstMortyWrite(fixture.ticketDir, fixture.projectDir);
        assert.equal(path.dirname(firstWrite), fixture.ticketDir);
        assert.match(path.basename(firstWrite), /^research_.*\.md$/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('send-to-morty resume prompt contains TIER_RESUME_TABLE placeholder for tier-specific injection', () => {
    const morty = readCommand(MORTY_COMMAND);
    assert.ok(
        morty.includes('{{TIER_RESUME_TABLE}}'),
        'send-to-morty.md must contain the TIER_RESUME_TABLE placeholder (R-PIAP-A2)'
    );
});

test('send-to-morty resume: approved research first writes plan artifact', () => {
    const fixture = makeTmpTicket();
    try {
        writeArtifact(fixture.ticketDir, 'research_2026-05-01.md', '# Research\n');
        writeArtifact(fixture.ticketDir, 'research_review.md', 'APPROVED\n');

        const firstWrite = firstMortyWrite(fixture.ticketDir, fixture.projectDir);
        assert.equal(path.dirname(firstWrite), fixture.ticketDir);
        assert.match(path.basename(firstWrite), /^plan_.*\.md$/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('send-to-morty resume prompt contains TIER_LIFECYCLE_SECTIONS placeholder for tier-specific injection', () => {
    const morty = readCommand(MORTY_COMMAND);
    assert.ok(
        morty.includes('{{TIER_LIFECYCLE_SECTIONS}}'),
        'send-to-morty.md must contain the TIER_LIFECYCLE_SECTIONS placeholder (R-PIAP-A2)'
    );
});

test('send-to-morty resume: approved research and plan first write project source', () => {
    const fixture = makeTmpTicket();
    try {
        writeArtifact(fixture.ticketDir, 'research_2026-05-01.md', '# Research\n');
        writeArtifact(fixture.ticketDir, 'research_review.md', 'APPROVED\n');
        writeArtifact(fixture.ticketDir, 'plan_2026-05-01.md', '# Plan\n');
        writeArtifact(fixture.ticketDir, 'plan_review.md', 'APPROVED\n');

        const firstWrite = firstMortyWrite(fixture.ticketDir, fixture.projectDir);
        assert.notEqual(path.dirname(firstWrite), fixture.ticketDir);
        assert.ok(firstWrite.startsWith(fixture.projectDir));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('send-to-morty resume: rejected research review first rewrites research artifact', () => {
    const fixture = makeTmpTicket();
    try {
        writeArtifact(fixture.ticketDir, 'research_2026-05-01.md', '# Research\n');
        writeArtifact(fixture.ticketDir, 'research_review.md', 'REJECTED\n');

        const firstWrite = firstMortyWrite(fixture.ticketDir, fixture.projectDir);
        assert.equal(path.dirname(firstWrite), fixture.ticketDir);
        assert.match(path.basename(firstWrite), /^research_.*\.md$/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('send-to-morty resume: stale approved research review first rewrites research artifact', () => {
    const fixture = makeTmpTicket();
    try {
        writeArtifact(fixture.ticketDir, 'research_2026-05-01.md', '# Research\n');
        writeArtifact(
            fixture.ticketDir,
            'research_review.md',
            'APPROVED\n',
            new Date('2026-04-30T00:00:00Z')
        );

        const firstWrite = firstMortyWrite(fixture.ticketDir, fixture.projectDir);
        assert.equal(path.dirname(firstWrite), fixture.ticketDir);
        assert.match(path.basename(firstWrite), /^research_.*\.md$/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});
