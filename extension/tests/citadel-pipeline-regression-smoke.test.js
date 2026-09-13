// @tier: fast
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  __setCitadelRemediationDepsForTests,
  main,
  readCitadelReport,
} from '../bin/pipeline-runner.js';

// B-HRP R-HRP-1: citadel no longer halts — it runs a bounded detect→remediate loop and the
// pipeline ALWAYS continues to anatomy-park/szechuan-sauce. These smoke tests keep runCitadelAudit
// REAL (the point is to prove Citadel detects the LOA-618 issues) but stub the remediation spawns
// so no real worker is launched, and assert the pipeline CONTINUES rather than halting.
function stubCitadelRemediationNoHalt(sessionDir) {
  __setCitadelRemediationDepsForTests({
    loadSettings: () => ({ cap: 1, remediatorTimeoutMs: 1000 }),
    spawnGateRemediatorMain: async ({ stdout }) => {
      const briefPath = path.join(sessionDir, 'citadel-brief.md');
      fs.writeFileSync(briefPath, 'fix it');
      stdout(`BRIEF_PATH=${briefPath}`);
      return 0;
    },
    spawnRemediator: () => { /* no-op: do not spawn a real remediator worker in tests */ },
  });
}

const __dirname = import.meta.dirname;
const FIXTURE_DIR = path.resolve(__dirname, '../../prds/fixtures/citadel');
const HIGH_OR_ABOVE = new Set(['Critical', 'High']);

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fileName), 'utf-8'));
}

function writeFile(root, filePath, content) {
  const fullPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function writeFiles(root, files) {
  for (const [filePath, content] of Object.entries(files)) {
    writeFile(root, filePath, content);
  }
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function createReplayRepo(fixture) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-pipeline-repo-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  writeFiles(repoRoot, fixture.baseFiles);
  writeFiles(repoRoot, {
    'support/a.ts': 'export const supportA = true;\n',
    'support/b.ts': 'export const supportB = true;\n',
    'support/c.ts': 'export const supportC = true;\n',
  });
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFiles(repoRoot, fixture.headFiles);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'head']);
  return { repoRoot, base };
}

function writeSession(sessionDir, repoRoot, fixture, extraPipeline = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repoRoot,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: 'TICKET-16',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: true,
    backend: 'claude',
    prd_path: 'prd.md',
    start_commit: fixture.base,
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
    target: repoRoot,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
    citadel_strict: false,
    ...extraPipeline,
  }, null, 2));
}

function createPipelineFixtureSession(fixture, extraPipeline = {}) {
  const replay = createReplayRepo(fixture);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-pipeline-session-'));
  writeSession(sessionDir, replay.repoRoot, { ...fixture, base: replay.base }, extraPipeline);
  return { ...replay, sessionDir };
}

function seedSessionArtifacts(sessionDir, fixture) {
  for (const [fileName, value] of Object.entries(fixture.sessionArtifacts ?? {})) {
    const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    writeFile(sessionDir, fileName, content);
  }
}

async function expectMainExit(sessionDir, code) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = ((actualCode) => {
    throw new ExitIntercept(actualCode ?? 0);
  });
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === code,
    );
  } finally {
    process.exit = originalExit;
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
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

afterEach(() => {
  __setSpawnRunnerForTests(null);
  __setCitadelRemediationDepsForTests(null);
});

describe('citadel pipeline regression smoke', () => {
  test('pipeline runs Citadel on the LOA-618 fixture, detects the issues, and CONTINUES (no halt)', async () => {
    const fixture = readJson('loa-618-diff-fixture.json');
    const issues = readJson('loa-618-issues.json');
    const run = createPipelineFixtureSession(fixture);
    stubCitadelRemediationNoHalt(run.sessionDir);
    const calls = [];
    __setSpawnRunnerForTests(async (_cmd, args) => {
      const scriptName = path.basename(args[0]);
      calls.push(scriptName);
      if (scriptName === 'mux-runner.js') {
        seedSessionArtifacts(run.sessionDir, fixture);
      }
      return 0;
    });

    try {
      // R-HRP-1: Citadel still writes its findings report, but it no longer halts — the pipeline
      // continues through anatomy-park and szechuan-sauce (the remediator is fed the findings).
      await expectMainExit(run.sessionDir, 0);
      assert.deepEqual(calls, ['mux-runner.js', 'microverse-runner.js', 'microverse-runner.js']);
      const report = readCitadelReport(run.sessionDir);
      assert.ok(report);
      const matched = matchedHighIssueIds(report, issues);
      assert.ok(
        matched.length >= fixture.expected.minimumMatchedIssuesAtHighOrAbove,
        `matched ${matched.length} stable issue ids: ${matched.join(', ')}`,
      );
      // The report still computes its severity-based exit_code field; it is simply no longer
      // used to halt the pipeline.
      assert.equal(report.exit_code, fixture.expected.strictExitCode);
      assert.equal(report.schema, '1.0');
      const status = JSON.parse(fs.readFileSync(path.join(run.sessionDir, 'pipeline-status.json'), 'utf-8'));
      assert.notEqual(status.status, 'failed');
    } finally {
      cleanup(run);
    }
  });

  test('strict pipeline detects High citadel findings and CONTINUES (citadel_strict widens remediation, no halt)', async () => {
    const fixture = readJson('loa-618-diff-fixture.json');
    const run = createPipelineFixtureSession(fixture, { citadel_strict: true });
    stubCitadelRemediationNoHalt(run.sessionDir);
    const calls = [];
    __setSpawnRunnerForTests(async (_cmd, args) => {
      const scriptName = path.basename(args[0]);
      calls.push(scriptName);
      if (scriptName === 'mux-runner.js') {
        seedSessionArtifacts(run.sessionDir, fixture);
      }
      return 0;
    });

    try {
      await expectMainExit(run.sessionDir, 0);
      assert.deepEqual(calls, ['mux-runner.js', 'microverse-runner.js', 'microverse-runner.js']);
      const report = readCitadelReport(run.sessionDir);
      assert.ok(report);
      assert.equal(report.exit_code, fixture.expected.strictExitCode);
      assert.ok(report.summary.high + report.summary.critical >= fixture.expected.minimumMatchedIssuesAtHighOrAbove);
      const status = JSON.parse(fs.readFileSync(path.join(run.sessionDir, 'pipeline-status.json'), 'utf-8'));
      assert.notEqual(status.status, 'failed');
    } finally {
      cleanup(run);
    }
  });

  test('pipeline advances through Citadel when the noise-floor fixture stays clean', async () => {
    const fixture = readJson('noise-floor-diff-fixture.json');
    const run = createPipelineFixtureSession(fixture);
    const calls = [];
    __setSpawnRunnerForTests(async (_cmd, args) => {
      calls.push(path.basename(args[0]));
      return 0;
    });

    try {
      await expectMainExit(run.sessionDir, 0);
      assert.deepEqual(calls, ['mux-runner.js', 'microverse-runner.js', 'microverse-runner.js']);
      const report = readCitadelReport(run.sessionDir);
      assert.ok(report);
      assert.equal(report.summary.critical, fixture.expected.maxCriticalFindings);
      assert.equal(report.summary.high, fixture.expected.maxHighFindings);
      assert.ok(report.summary.low < fixture.expected.maxLowFindingsExclusive);
      const anatomyPrd = fs.readFileSync(path.join(run.sessionDir, 'prd-anatomy-park.md'), 'utf-8');
      const szechuanPrd = fs.readFileSync(path.join(run.sessionDir, 'prd.md'), 'utf-8');
      for (const prd of [anatomyPrd, szechuanPrd]) {
        assert.match(prd, /## Citadel Report/);
        assert.match(prd, /Read: citadel_report\.json/);
      }
    } finally {
      cleanup(run);
    }
  });
});
