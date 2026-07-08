// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const READINESS_BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const {
  buildRefinementManifest,
  enrichManifestTicketsFromSourcePrds,
} = await import('../bin/spawn-refinement-team.js');

function tmpDir(prefix = 'pickle-source-prd-relative-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function withCwd(nextCwd, fn) {
  const previous = process.cwd();
  process.chdir(nextCwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function writeFile(repoRoot, relativePath, content) {
  const fullPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function createFixtureRepo(parentRelativePath = 'bundle.md') {
  const repoRoot = tmpDir('pickle-source-prd-repo-');
  git(repoRoot, ['init', '-q']);
  fs.mkdirSync(path.join(repoRoot, 'extension'), { recursive: true });

  const relativePeer = writeFile(repoRoot, 'prds/source-relative.md', [
    '# Relative Source',
    '',
    '## Relative Section',
    '',
    '- AC-REL-01',
  ].join('\n'));
  const absolutePeer = writeFile(repoRoot, 'prds/source-absolute.md', [
    '# Absolute Source',
    '',
    '## Absolute Section',
    '',
    '- AC-ABS-01',
  ].join('\n'));
  const repoPeer = writeFile(repoRoot, 'prds/source-repo.md', [
    '# Repo Source',
    '',
    '## Repo Section',
    '',
    '- AC-ROOT-01',
  ].join('\n'));
  const parentPrdPath = writeFile(repoRoot, parentRelativePath, [
    '---',
    'peer_prds:',
    '  deferred:',
    '    - ./prds/source-relative.md',
    `    - ${absolutePeer}`,
    '    - prds/source-repo.md',
    '---',
    '# Bundle',
  ].join('\n'));

  return { repoRoot, parentPrdPath, relativePeer, absolutePeer, repoPeer };
}

function baseTickets() {
  return [
    { id: 'ticket-rel', title: 'Relative', source_ac_ids: ['AC-REL-01'] },
    { id: 'ticket-abs', title: 'Absolute', source_ac_ids: ['AC-ABS-01'] },
    { id: 'ticket-root', title: 'Repo', source_ac_ids: ['AC-ROOT-01'] },
  ];
}

function buildEnrichedTickets(parentPrdPath, cwd) {
  return withCwd(cwd, () => enrichManifestTicketsFromSourcePrds(parentPrdPath, baseTickets()));
}

function writeTicket(sessionDir, ticket) {
  const ticketDir = path.join(sessionDir, ticket.id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticket.id}.md`), [
    '---',
    `id: ${ticket.id}`,
    `key: ${ticket.id.toUpperCase()}`,
    `ac_ids: [${ticket.source_ac_ids.join(', ')}]`,
    `source_prd: ${ticket.source_prd}`,
    `source_section: ${ticket.source_section}`,
    '---',
    '',
    '# Ticket',
    '',
    '## Acceptance Criteria',
    '- [ ] `node --eval "process.exit(0)"`',
  ].join('\n'));
}

function runReadiness(sessionDir, repoRoot) {
  return spawnSync(process.execPath, [
    READINESS_BIN,
    '--session-dir', sessionDir,
    '--repo-root', repoRoot,
  ], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('spawn-refinement-team: source_prd normalization is cwd-independent and repo-root-relative', () => {
  const { repoRoot, parentPrdPath } = createFixtureRepo();
  try {
    const expected = buildEnrichedTickets(parentPrdPath, repoRoot);
    const fromExtension = buildEnrichedTickets(parentPrdPath, path.join(repoRoot, 'extension'));
    const fromTmp = buildEnrichedTickets(parentPrdPath, os.tmpdir());

    assert.deepEqual(fromExtension, expected);
    assert.deepEqual(fromTmp, expected);
    assert.deepEqual(expected.map((ticket) => ticket.source_prd), [
      'prds/source-relative.md',
      'prds/source-absolute.md',
      'prds/source-repo.md',
    ]);
    for (const ticket of expected) {
      assert.match(ticket.source_prd, /^[A-Za-z]/);
      assert.doesNotMatch(ticket.source_prd, /^\//);
      assert.doesNotMatch(ticket.source_prd, /\/Users\//);
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('spawn-refinement-team: relative parentPrdPath throws explicit assertion', () => {
  assert.throws(
    () => enrichManifestTicketsFromSourcePrds('bundle.md', baseTickets()),
    /enrichManifestTicketsFromSourcePrds requires absolute parentPrdPath/
  );
});

test('spawn-refinement-team: nested bundle PRDs still resolve repo-root-relative peer_prds', () => {
  const { repoRoot, parentPrdPath } = createFixtureRepo('prds/bundles/bundle.md');
  try {
    const tickets = buildEnrichedTickets(parentPrdPath, os.tmpdir());
    assert.deepEqual(tickets.map((ticket) => ticket.source_prd), [
      'prds/source-relative.md',
      'prds/source-absolute.md',
      'prds/source-repo.md',
    ]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('spawn-refinement-team: composed source PRDs propagate nested AC provenance into the manifest', () => {
  const repoRoot = tmpDir('pickle-source-prd-compose-');
  const refinementDir = path.join(repoRoot, 'refinement');
  try {
    fs.mkdirSync(refinementDir, { recursive: true });
    const parentPrdPath = writeFile(repoRoot, 'bundle.md', [
      '---',
      'composes:',
      '  - prds/source-beta.md',
      '---',
      '# Bundle',
    ].join('\n'));
    writeFile(repoRoot, 'prds/source-beta.md', [
      '---',
      'composes:',
      '  - nested/source-gamma.md',
      '---',
      '# Source Beta',
      '',
      '## Beta Section',
      '',
      '- AC-BETA-01',
    ].join('\n'));
    writeFile(repoRoot, 'prds/nested/source-gamma.md', [
      '# Source Gamma',
      '',
      '## Gamma Section',
      '',
      '- AC-GAMMA-01',
    ].join('\n'));
    fs.writeFileSync(path.join(refinementDir, 'analysis_requirements.md'), [
      '## ac_shape_smells',
      '```json',
      JSON.stringify({
        ac_shape_smells: [],
        tickets: [
          {
            id: 'ticket-gamma',
            title: 'Gamma',
            source_ac_ids: ['AC-GAMMA-01'],
          },
        ],
      }),
      '```',
      '',
    ].join('\n'));

    const manifest = buildRefinementManifest({
      prdPath: parentPrdPath,
      sessionDir: repoRoot,
    }, {
      refinementDir,
      cyclesRequested: 1,
      maxTurns: 1,
      allCycleResults: [[]],
      finalResults: [{ roleId: 'requirements', success: true, logPath: path.join(repoRoot, 'worker.log'), exitCode: 0, signal: null, cycle: 1 }],
      allSuccess: true,
    });

    assert.deepEqual(manifest.tickets.map((ticket) => ({
      id: ticket.id,
      source_prd: ticket.source_prd,
      source_section: ticket.source_section,
      mapped_requirements: ticket.mapped_requirements,
    })), [
      {
        id: 'ticket-gamma',
        source_prd: 'prds/nested/source-gamma.md',
        source_section: 'Gamma Section',
        mapped_requirements: ['AC-GAMMA-01'],
      },
    ]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('spawn-refinement-team: composed source PRDs walk deferred peer_prds before assigning manifest provenance', () => {
  const repoRoot = tmpDir('pickle-source-prd-compose-peer-');
  const refinementDir = path.join(repoRoot, 'refinement');
  try {
    fs.mkdirSync(refinementDir, { recursive: true });
    const parentPrdPath = writeFile(repoRoot, 'bundle.md', [
      '---',
      'composes:',
      '  - prds/source-beta.md',
      '---',
      '# Bundle',
    ].join('\n'));
    writeFile(repoRoot, 'prds/source-beta.md', [
      '---',
      'peer_prds:',
      '  deferred:',
      '    - nested/source-gamma.md',
      '---',
      '# Source Beta',
      '',
      '## Beta Section',
      '',
      '- AC-BETA-01',
    ].join('\n'));
    writeFile(repoRoot, 'prds/nested/source-gamma.md', [
      '# Source Gamma',
      '',
      '## Gamma Section',
      '',
      '- AC-GAMMA-01',
    ].join('\n'));
    fs.writeFileSync(path.join(refinementDir, 'analysis_requirements.md'), [
      '## ac_shape_smells',
      '```json',
      JSON.stringify({
        ac_shape_smells: [],
        tickets: [
          {
            id: 'ticket-gamma',
            title: 'Gamma',
            source_ac_ids: ['AC-GAMMA-01'],
          },
        ],
      }),
      '```',
      '',
    ].join('\n'));

    const manifest = buildRefinementManifest({
      prdPath: parentPrdPath,
      sessionDir: repoRoot,
    }, {
      refinementDir,
      cyclesRequested: 1,
      maxTurns: 1,
      allCycleResults: [[]],
      finalResults: [{ roleId: 'requirements', success: true, logPath: path.join(repoRoot, 'worker.log'), exitCode: 0, signal: null, cycle: 1 }],
      allSuccess: true,
    });

    assert.deepEqual(manifest.tickets.map((ticket) => ({
      id: ticket.id,
      source_prd: ticket.source_prd,
      source_section: ticket.source_section,
      mapped_requirements: ticket.mapped_requirements,
    })), [
      {
        id: 'ticket-gamma',
        source_prd: 'prds/nested/source-gamma.md',
        source_section: 'Gamma Section',
        mapped_requirements: ['AC-GAMMA-01'],
      },
    ]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('spawn-refinement-team: manifest enrichment normalizes analyst-provided source_prd values', () => {
  const { repoRoot, parentPrdPath } = createFixtureRepo('prds/bundles/bundle.md');
  const refinementDir = path.join(repoRoot, 'refinement');
  try {
    fs.mkdirSync(refinementDir, { recursive: true });
    fs.writeFileSync(path.join(refinementDir, 'analysis_requirements.md'), [
      '## ac_shape_smells',
      '```json',
      JSON.stringify({
        ac_shape_smells: [],
        tickets: [
          {
            id: 'ticket-rel',
            title: 'Relative',
            source_ac_ids: ['AC-REL-01'],
            source_prd: './prds/source-relative.md',
            source_section: 'Wrong Section',
          },
          {
            id: 'ticket-abs',
            title: 'Absolute',
            source_ac_ids: ['AC-ABS-01'],
            source_prd: path.join(repoRoot, 'prds/source-absolute.md'),
          },
          {
            id: 'ticket-root',
            title: 'Repo',
            source_ac_ids: ['AC-ROOT-01'],
            source_prd: 'prds/bundles/prds/source-repo.md',
          },
        ],
      }),
      '```',
      '',
    ].join('\n'));

    const manifest = buildRefinementManifest({
      prdPath: parentPrdPath,
      sessionDir: repoRoot,
    }, {
      refinementDir,
      cyclesRequested: 1,
      maxTurns: 1,
      allCycleResults: [[]],
      finalResults: [{ roleId: 'requirements', success: true, logPath: path.join(repoRoot, 'worker.log'), exitCode: 0, signal: null, cycle: 1 }],
      allSuccess: true,
    });

    assert.deepEqual(manifest.tickets.map((ticket) => ({
      id: ticket.id,
      source_prd: ticket.source_prd,
      source_section: ticket.source_section,
    })), [
      { id: 'ticket-rel', source_prd: 'prds/source-relative.md', source_section: 'Relative Section' },
      { id: 'ticket-abs', source_prd: 'prds/source-absolute.md', source_section: 'Absolute Section' },
      { id: 'ticket-root', source_prd: 'prds/source-repo.md', source_section: 'Repo Section' },
    ]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('check-readiness: normalized source_prd does not emit file_path findings', () => {
  const { repoRoot, parentPrdPath } = createFixtureRepo();
  const sessionDir = path.join(repoRoot, 'session');
  try {
    const tickets = buildEnrichedTickets(parentPrdPath, os.tmpdir());
    for (const ticket of tickets) writeTicket(sessionDir, ticket);
    fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
      prd_path: parentPrdPath,
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        key: ticket.id.toUpperCase(),
        ac_ids: ticket.source_ac_ids,
        source_prd: ticket.source_prd,
        source_section: ticket.source_section,
        mapped_requirements: ticket.mapped_requirements,
      })),
    }, null, 2));

    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    const sourcePrdFindings = out.findings.filter((finding) =>
      finding.kind === 'file_path' && /^prds\/source-(relative|absolute|repo)\.md$/.test(finding.detail)
    );
    assert.deepEqual(sourcePrdFindings, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
