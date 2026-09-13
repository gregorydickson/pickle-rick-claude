// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCitadelAudit, __setAnalyzerOverridesForTests } from '../services/citadel/audit-runner.js';

const __dirname = import.meta.dirname;
const FIXTURE_DIR = path.resolve(__dirname, '../../prds/fixtures/citadel');
const HIGH_OR_ABOVE = new Set(['Critical', 'High']);

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fileName), 'utf-8'));
}

function assertFixturePrdExists(fixture) {
  assert.equal(typeof fixture.prd, 'string');
  assert.ok(fs.existsSync(path.join(FIXTURE_DIR, fixture.prd)), `${fixture.prd} is missing`);
}

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function writeFiles(repoRoot, files) {
  for (const [filePath, content] of Object.entries(files)) {
    writeFile(repoRoot, filePath, content);
  }
}

function createReplayRepo(fixture) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-self-test-repo-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFiles(repoRoot, fixture.baseFiles);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFiles(repoRoot, fixture.headFiles);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'head']);
  return { repoRoot, base };
}

function createSession(fixture) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-self-test-session-'));
  for (const [fileName, value] of Object.entries(fixture.sessionArtifacts ?? {})) {
    const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    writeFile(sessionDir, fileName, content);
  }
  return sessionDir;
}

async function runFixture(fixture, options = {}) {
  const { repoRoot, base } = createReplayRepo(fixture);
  const sessionDir = createSession(fixture);
  try {
    const report = await runCitadelAudit({
      prdPath: 'prd.md',
      diffRange: `${base}..HEAD`,
      repoRoot,
      sessionDir,
      strict: options.strict ?? false,
    });
    return { report, repoRoot, sessionDir };
  } catch (error) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(run) {
  fs.rmSync(run.repoRoot, { recursive: true, force: true });
  fs.rmSync(run.sessionDir, { recursive: true, force: true });
}

function matchedHighIssueIds(report, issues) {
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
  return issues
    .filter((issue) => {
      const finding = byId.get(issue.expectedFindingId);
      return finding && HIGH_OR_ABOVE.has(finding.severity);
    })
    .map((issue) => issue.id);
}

describe('citadel self-test fixtures', () => {
  test('LOA-618 positive fixture surfaces at least six stable issue ids at High or above', async () => {
    const fixture = readJson('loa-618-diff-fixture.json');
    const issues = readJson('loa-618-issues.json');
    assertFixturePrdExists(fixture);
    const run = await runFixture(fixture, { strict: true });
    try {
      const matched = matchedHighIssueIds(run.report, issues);
      assert.equal(issues.length, 8);
      assert.ok(issues.every((issue) => /^LOA-618-ISSUE-00[1-8]$/.test(issue.id)));
      assert.ok(
        matched.length >= fixture.expected.minimumMatchedIssuesAtHighOrAbove,
        `matched ${matched.length} stable issue ids: ${matched.join(', ')}`,
      );
      assert.equal(run.report.exit_code, fixture.expected.strictExitCode);
      assert.equal(run.report.schema, '1.0');
    } finally {
      cleanup(run);
    }
  });

  test('noise-floor fixture stays below the false-positive severity budget', async () => {
    const fixture = readJson('noise-floor-diff-fixture.json');
    assertFixturePrdExists(fixture);
    const run = await runFixture(fixture);
    try {
      assert.equal(run.report.summary.critical, fixture.expected.maxCriticalFindings);
      assert.equal(run.report.summary.high, fixture.expected.maxHighFindings);
      assert.ok(run.report.summary.low < fixture.expected.maxLowFindingsExclusive);
    } finally {
      cleanup(run);
    }
  });

  test('random-sample cohort records a stable recall baseline without regression', async () => {
    const baseline = readJson('recall-baseline.json');
    const sampleRuns = [];
    // The recall-baseline.json fixture predates the wired ac-coverage and
    // allowlist-dead-entry analyzers. Random-sample fixtures intentionally
    // expose only an AC id with no implementation/test evidence in their
    // diff, which the newer analyzers correctly flag. Override those two
    // analyzers here so the baseline isolates cross-phase / sibling-auth /
    // structural recall — keeping the LOA-618 positive test (above) as the
    // authority on the full analyzer stack.
    const emptyAnalyzer = () => ({ findings: [] });
    __setAnalyzerOverridesForTests(new Map([
      ['citadel-ac-coverage', emptyAnalyzer],
      ['citadel-allowlist-dead', emptyAnalyzer],
      ['citadel-state-transitions', emptyAnalyzer],
      ['citadel-trap-door', emptyAnalyzer],
      ['citadel-endpoint-contract', emptyAnalyzer],
      ['citadel-frontend-prop-drift', emptyAnalyzer],
    ]));
    try {
      for (const sample of baseline.samples) {
        const fixture = readJson(sample.fixture);
        assertFixturePrdExists(fixture);
        sampleRuns.push({ sample, run: await runFixture(fixture) });
      }

      const knownIssues = baseline.samples.reduce((sum, sample) => sum + sample.knownIssues, 0);
      const matchedIssues = baseline.samples.reduce((sum, sample) => sum + sample.matchedIssues, 0);
      const measuredRecall = knownIssues === 0 ? 1 : matchedIssues / knownIssues;
      const recallDrop = baseline.baselineRecall - measuredRecall;

      assert.ok(baseline.samples.length >= 5);
      assert.equal(baseline.sampleCount, baseline.samples.length);
      assert.ok(recallDrop <= baseline.maxRecallDrop);
      for (const { sample, run } of sampleRuns) {
        assert.equal(
          run.report.summary.findings,
          sample.falsePositiveFindings,
          `${sample.fixture} false-positive baseline changed`,
        );
      }
    } finally {
      __setAnalyzerOverridesForTests(null);
      for (const { run } of sampleRuns) cleanup(run);
    }
  });
});
