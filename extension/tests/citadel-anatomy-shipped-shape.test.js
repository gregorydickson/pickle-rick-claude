// @tier: fast
//
// AP-EXT-ITER45-01 ENFORCE (closes AP-EXT-ITER13-02) — the citadel anatomy cross-phase
// reader vs. the shape the PRODUCER writes.
//
// `readPhaseFindings` (`src/services/citadel/audit-runner.ts`) harvests a TOP-LEVEL
// `findings` array out of `anatomy-park.json` and reads nothing else. For three passes no
// shipped run wrote that key — the anatomy-park ledger lives under `findings_history`,
// keyed by subsystem — so citadel's anatomy replay input was silently always empty in
// production, with no `anatomy-park:missing` breadcrumb either (the file EXISTS; absence
// is the wrong channel for "present but unreadable by this consumer").
//
// AP-EXT-ITER13-02 declared the gap producer-only-fixable because "the entries carry no
// `id` and no `severity`, so there is nothing structured to lift". That premise was
// refuted by the live artifact: this loop's entries DO carry `id`/`severity`/`confidence`
// under `findings_history[subsystem][].findings[]`. The fix still landed on the PRODUCER
// (`.claude/commands/anatomy-park.md` Override 5), which now emits the top-level array as
// an explicit contract — the consumer is untouched, and case 3 below always proved the
// reader itself works.
//
// The fixture is the load-bearing half. It is the shape THIS loop ships, not a
// hand-authored array: per AP-EXT-ITER13-01, "assert a verbatim SHIPPED entry, never a
// hand-authored array fixture — that fixture is what let the inert reading pass". Case 4
// is the mutation: delete the one contract key from that same fixture and the harvest
// drops to zero, silently. That is what a producer regression looks like, and it is why
// the key is worth a test.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';
import { renderMicroverseDashboard } from '../bin/monitor.js';

const __dirname = import.meta.dirname;
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/citadel-cross-phase-fixture');
const SHIPPED_SHAPE = path.join(FIXTURE_DIR, 'anatomy-park.shipped-shape.json');
const HAND_AUTHORED = path.join(FIXTURE_DIR, 'anatomy-park.json');

// Citadel's `isSeverity` accepts exactly these. anatomy-park's native taxonomy is
// CRITICAL/HIGH, so the producer must map before it writes; an unmapped entry is dropped
// whole, not downgraded.
const CITADEL_SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);

function writeFile(root, filePath, content) {
  const fullPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-anatomy-shape-repo-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', '# PRD\n\n## Acceptance Criteria\n\n**AC-TEST-01**: Stable.\n');
  writeFile(repoRoot, 'src/index.ts', '// AC-TEST-01\nexport const before = true;\n');
  writeFile(repoRoot, 'tests/index.test.ts', '// AC-TEST-01\nimport { describe } from "node:test";\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFile(repoRoot, 'src/index.ts', '// AC-TEST-01\nexport const after = true;\n');
  writeFile(repoRoot, 'tests/index.test.ts', '// AC-TEST-01 covered\nimport { describe } from "node:test";\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'head']);
  return { repoRoot, base };
}

// `artifact` is either a path to copy verbatim or an object to serialize — the mutation
// cases need the latter, and routing both through one helper keeps every case on the
// identical audit code path.
async function auditWithAnatomyArtifact(artifact) {
  const { repoRoot, base } = makeRepo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-anatomy-shape-session-'));
  try {
    const dest = path.join(sessionDir, 'anatomy-park.json');
    if (typeof artifact === 'string') fs.copyFileSync(artifact, dest);
    else fs.writeFileSync(dest, JSON.stringify(artifact, null, 2));
    const report = await runCitadelAudit({
      prdPath: 'prd.md',
      diffRange: `${base}..HEAD`,
      repoRoot,
      sessionDir,
    });
    return report.sections.cross_phase;
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

function readShippedShape() {
  return JSON.parse(fs.readFileSync(SHIPPED_SHAPE, 'utf8'));
}

describe('AP-EXT-ITER45-01: citadel anatomy cross-phase reader vs. the producer shape', () => {
  // Fixture guard. Without this, someone could green case 2 by bolting an invented array
  // onto the fixture while production still shipped nothing — exactly how the inert
  // AP-EXT-ITER13-01 reading passed. So the array must be a PROJECTION: every id in it has
  // to trace back to a real ledger entry in the same file.
  test('the shipped-shape fixture carries the contract array, and it projects the ledger', () => {
    const shipped = readShippedShape();

    assert.ok(
      Array.isArray(shipped.findings) && shipped.findings.length > 0,
      'shipped anatomy-park.json must carry a non-empty top-level `findings` array',
    );
    assert.equal(typeof shipped.findings_history, 'object');

    const ledgerIds = new Set(
      Object.values(shipped.findings_history)
        .flat()
        .flatMap((entry) => (Array.isArray(entry.findings) ? entry.findings : []))
        .map((finding) => finding.id),
    );

    for (const finding of shipped.findings) {
      assert.equal(typeof finding.id, 'string', 'every contract entry needs a string id');
      assert.ok(
        CITADEL_SEVERITIES.has(finding.severity),
        `severity ${JSON.stringify(finding.severity)} is not citadel-spelled — the producer `
        + 'must map CRITICAL->Critical / HIGH->High before writing, or citadel drops the entry',
      );
      assert.ok(
        ledgerIds.has(finding.id),
        `contract entry ${finding.id} has no matching findings_history record — the array is a `
        + 'projection of the ledger, not a second source of truth',
      );
    }

    // The ledger keeps CLOSED findings forever; the contract array carries only OPEN ones.
    // AP-EXT-ITER44-01 is fixed and committed, so it must NOT appear in the hand-off.
    assert.ok(ledgerIds.has('AP-EXT-ITER44-01'));
    assert.equal(
      shipped.findings.some((f) => f.id === 'AP-EXT-ITER44-01'),
      false,
      'a fixed finding must leave the contract array while its ledger record stays',
    );
  });

  test('a real anatomy-park.json contributes its open findings to citadel', async () => {
    const shipped = readShippedShape();
    const crossPhase = await auditWithAnatomyArtifact(SHIPPED_SHAPE);

    assert.equal(
      crossPhase.summary.anatomy_park,
      shipped.findings.length,
      'every open finding the producer projects must reach citadel',
    );
    assert.equal(crossPhase.summary.anatomy_park_missing, false);
    assert.deepEqual(
      crossPhase.findings.filter((f) => f.source === 'anatomy-park').map((f) => f.id).sort(),
      shipped.findings.map((f) => f.id).sort(),
    );
    // Fence-blocked / stall-sealed findings are exactly the ones a downstream reader still
    // needs to see, so they must survive the hand-off rather than be filtered as "won't fix".
    assert.ok(crossPhase.findings.some((f) => f.id === 'AP-BIN-ITER14-01'));
  });

  test('the reader also accepts a hand-authored array — same code path, different shape', async () => {
    const crossPhase = await auditWithAnatomyArtifact(HAND_AUTHORED);

    assert.equal(crossPhase.summary.anatomy_park, 3);
    assert.equal(crossPhase.summary.anatomy_park_missing, false);
  });

  // The mutation. This is the pre-fix production behavior, reproduced from the SAME fixture
  // by deleting the one key the producer contract adds.
  test('MUTATION: dropping the top-level array silently zeroes the harvest', async () => {
    const shipped = readShippedShape();
    delete shipped.findings;
    const crossPhase = await auditWithAnatomyArtifact(shipped);

    assert.equal(crossPhase.summary.anatomy_park, 0);
    // No breadcrumb: the artifact is PRESENT, so `missing` is correctly false. That is the
    // whole hazard — the regression is indistinguishable from "anatomy-park found nothing".
    assert.equal(crossPhase.summary.anatomy_park_missing, false);
    assert.equal(
      crossPhase.findings.some((f) => f.id === 'anatomy-park:missing'),
      false,
    );
  });

  // The value half of the contract, which the ledger's own CRITICAL/HIGH spelling fails.
  test('MUTATION: anatomy-native severity spelling is dropped entry-and-all', async () => {
    const shipped = readShippedShape();
    shipped.findings = [
      { id: 'AP-SEV-01', severity: 'CRITICAL', subsystem: 'bin', message: 'unmapped critical' },
      { id: 'AP-SEV-02', severity: 'HIGH', subsystem: 'bin', message: 'unmapped high' },
      { id: 'AP-SEV-03', severity: 'High', subsystem: 'bin', message: 'mapped high' },
    ];
    const crossPhase = await auditWithAnatomyArtifact(shipped);

    assert.equal(
      crossPhase.summary.anatomy_park,
      1,
      'CRITICAL/HIGH are not citadel severities — those entries are dropped, not downgraded',
    );
    assert.deepEqual(
      crossPhase.findings.filter((f) => f.source === 'anatomy-park').map((f) => f.id),
      ['AP-SEV-03'],
    );
  });
});

// AP-EXT-ITER11-01 ENFORCE — the SECOND reader of this same artifact, and the same defect
// class: a consumer of `anatomy-park.json` assuming a shape the PRODUCER has never written.
//
// `monitor.ts:mvSubsystemLine` labelled each subsystem row with `String(entry)` over the last
// `findings_history` entry. Every shipped entry is an OBJECT (127/127 live entries across 12/12
// host artifacts, 0 strings), so the anatomy-park operator pane printed `[object Object]` in that
// column on every real run, for every subsystem, since the pane shipped.
//
// It stayed green because the only case exercising the column — `tests/monitor.test.js` AC-5 —
// feeds `findings_history: { name: ['a very very long last action description'] }`, an array of
// STRINGS. That is the AP-EXT-ITER13-01 rule ("assert a VERBATIM SHIPPED entry, never a
// hand-authored fixture") violated in the other direction: a hand-authored fixture pinning a
// shape production does not emit. So these cases drive the SAME verbatim shipped fixture the
// citadel cases above use.
describe('AP-EXT-ITER11-01: the anatomy-park monitor pane vs. the producer shape', () => {
  function renderPane(anatomyArtifact) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-anatomy-shape-'));
    try {
      fs.writeFileSync(
        path.join(sessionDir, 'anatomy-park.json'),
        JSON.stringify(anatomyArtifact, null, 2),
      );
      const rendered = renderMicroverseDashboard({ session_dir: sessionDir }, null);
      return rendered.replace(/\x1b\[[0-9;]*[mJH]/g, '');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }

  // The load-bearing case: the VERBATIM shipped artifact, not a hand-authored one.
  test('the shipped-shape ledger labels each row with its pass verdict, never [object Object]', () => {
    const shipped = readShippedShape();
    const plain = renderPane(shipped);

    assert.equal(
      plain.includes('[object Object]'),
      false,
      `pane coerced an object ledger entry into a label: ${JSON.stringify(plain)}`,
    );
    for (const subsystem of shipped.subsystems) {
      const entries = shipped.findings_history[subsystem];
      const last = entries[entries.length - 1];
      const expected = last.verdict ?? last.result;
      assert.equal(typeof expected, 'string', 'fixture guard: shipped entries carry a verdict');
      const row = plain.split('\n').find((line) => line.trim().startsWith(subsystem));
      assert.ok(row, `no pane row for subsystem ${subsystem}`);
      assert.ok(
        row.includes(expected),
        `row for ${subsystem} should carry its verdict ${JSON.stringify(expected)}, got ${JSON.stringify(row)}`,
      );
    }
  });

  // Anti-vacuity control. Without this the case above is satisfiable by blanket-'--'ing the
  // column, which would trade a wrong label for a dead one.
  test('a string ledger entry is still its own label', () => {
    const plain = renderPane({
      subsystems: ['bin'],
      consecutive_clean: { bin: 1 },
      stall_limit: 3,
      findings_history: { bin: ['handwritten-label'] },
    });

    assert.ok(
      plain.includes('handwritten-label'),
      `string entries must render verbatim, got ${JSON.stringify(plain)}`,
    );
  });

  // The unlabelled arm: an entry whose spelling this pane does not know reads as UNKNOWN, using
  // the token the pane already uses for a field it cannot read (`AC-7: missing fields render --`).
  // A coerced label here is the defect; a wrong-but-confident label would be worse than both.
  test('a ledger entry with no verdict spelling reads as the unknown token, not a coercion', () => {
    const plain = renderPane({
      subsystems: ['bin'],
      consecutive_clean: { bin: 0 },
      stall_limit: 3,
      findings_history: { bin: [{ pass: 4, confident_findings: 2, note: 'no verdict key here' }] },
    });

    assert.equal(
      plain.includes('[object Object]'),
      false,
      `unknown entry shape must not be coerced, got ${JSON.stringify(plain)}`,
    );
    const row = plain.split('\n').find((line) => line.trim().startsWith('bin'));
    assert.ok(row.includes('--'), `expected the unknown token in ${JSON.stringify(row)}`);
  });
});
