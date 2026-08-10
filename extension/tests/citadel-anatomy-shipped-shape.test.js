// @tier: fast
//
// AP-EXT-ITER13-02 ENFORCE — the citadel anatomy cross-phase reader vs. the shape the
// PRODUCER writes.
//
// `readPhaseFindings` (`src/services/citadel/audit-runner.ts`) reads a TOP-LEVEL
// `findings` array out of `anatomy-park.json`. No shipped run writes that key: the
// anatomy-park ledger lives under `findings_history`, keyed by subsystem, and its entries
// are per-pass COUNTS plus a verdict, not `CrossPhaseFinding` records. So citadel's
// anatomy replay input is silently always empty in production.
//
// THIS FILE PINS THE CURRENT (DEFECTIVE) BEHAVIOR ON PURPOSE. The gap is documented as
// OPEN in `src/bin/CLAUDE.md` (AP-EXT-ITER13-02) — closing it needs a PRODUCER change
// (the anatomy-park worker prompt fixes no entry schema, so there is nothing structured to
// lift), which is out of scope for a consumer-side widening. Until that lands, the point
// of these cases is that the divergence cannot go silent: the moment producer and consumer
// agree, case 1 goes RED and whoever fixed it updates this file. Same posture as the
// AP-EXT-ITER9-01 replay case in `tests/services/backend-spawn-trailer-env.test.js`.
//
// Case 3 is the load-bearing half. Cases 1 and 2 alone would be satisfied by a reader that
// is simply broken; case 3 proves the reader WORKS — just against a shape only a
// hand-authored fixture ever has. That is the AP-EXT-ITER13-01 failure mode restated:
// "assert a verbatim SHIPPED entry, never a hand-authored array fixture — that fixture is
// what let the inert reading pass."
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

const __dirname = import.meta.dirname;
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/citadel-cross-phase-fixture');
const SHIPPED_SHAPE = path.join(FIXTURE_DIR, 'anatomy-park.shipped-shape.json');
const HAND_AUTHORED = path.join(FIXTURE_DIR, 'anatomy-park.json');

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

async function auditWithAnatomyArtifact(anatomyFixturePath) {
  const { repoRoot, base } = makeRepo();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-anatomy-shape-session-'));
  try {
    fs.copyFileSync(anatomyFixturePath, path.join(sessionDir, 'anatomy-park.json'));
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

describe('AP-EXT-ITER13-02: citadel anatomy cross-phase reader vs. the producer shape', () => {
  // Fixture guard. Without this, someone "fixing" the fixture by bolting a top-level
  // `findings` array onto it would green case 1 while leaving production untouched —
  // exactly how the inert AP-EXT-ITER13-01 reading shipped.
  test('the shipped-shape fixture really is the producer shape (no top-level findings)', () => {
    const shipped = JSON.parse(fs.readFileSync(SHIPPED_SHAPE, 'utf8'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(shipped, 'findings'),
      false,
      'shipped anatomy-park.json must NOT carry a top-level `findings` key',
    );
    assert.equal(typeof shipped.findings_history, 'object');
    assert.ok(Array.isArray(shipped.findings_history.extension));
    // The ledger's entries are counts + a verdict, NOT CrossPhaseFinding records: they
    // carry no `id` and no `severity`, which is why a consumer-side widening cannot
    // recover them and the fix has to land on the producer.
    for (const entry of shipped.findings_history.extension) {
      assert.equal(typeof entry.findings, 'number');
      assert.equal(entry.id, undefined);
      assert.equal(entry.severity, undefined);
    }
  });

  test('OPEN GAP: a real anatomy-park.json contributes ZERO cross-phase findings', async () => {
    const crossPhase = await auditWithAnatomyArtifact(SHIPPED_SHAPE);

    assert.equal(
      crossPhase.summary.anatomy_park,
      0,
      'AP-EXT-ITER13-02 is CLOSED if this is non-zero — update this file and the '
      + 'src/bin/CLAUDE.md bullet rather than relaxing the assertion',
    );
    // The artifact is PRESENT, so `missing` is correctly false — the breadcrumb is an
    // absence signal and is not the right channel for "present but unreadable by this
    // consumer". Pinned so a future fix does not reach for the wrong lever.
    assert.equal(crossPhase.summary.anatomy_park_missing, false);
    assert.equal(
      crossPhase.findings.some((f) => f.id === 'anatomy-park:missing'),
      false,
    );
  });

  test('the reader works — but only against a shape no producer emits', async () => {
    const crossPhase = await auditWithAnatomyArtifact(HAND_AUTHORED);

    // Same code path, same session layout; the ONLY difference is the artifact shape.
    assert.equal(crossPhase.summary.anatomy_park, 3);
    assert.equal(crossPhase.summary.anatomy_park_missing, false);
  });
});
