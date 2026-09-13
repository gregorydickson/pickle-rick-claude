// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditSiblingAuthPreconditions } from '../services/citadel/sibling-auth-audit.js';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath) {
  return {
    path: filePath,
    status: 'M',
    kind: 'production',
    changedLines: [],
    blame: [],
  };
}

function diffSummary(repoRoot, changedFiles) {
  return {
    range: 'main..HEAD',
    base: 'main',
    head: 'HEAD',
    repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function createGitRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-sibling-audit-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', '# Fixture PRD\n');
  writeFile(repoRoot, 'src/runs.controller.ts', 'export const before = true;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  return { repoRoot, base };
}

describe('auditSiblingAuthPreconditions', () => {
  test('reports sibling guard/precondition divergence with missing guard names', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-sibling-guard-'));
    try {
      writeFile(
        repoRoot,
        'src/runs.controller.ts',
        [
          '@Controller("runs/:id")',
          'export class RunsController {',
          '  @Roles("admin")',
          '  @UseGuards(AuthGuard)',
          '  @Get("comparison")',
          '  getComparison() {',
          '    requireFeature("compare");',
          '    assertOwner();',
          '    return true;',
          '  }',
          '',
          '  @Roles("admin")',
          '  @Get("summary")',
          '  getSummary() {',
          '    return true;',
          '  }',
          '}',
          '',
        ].join('\n'),
      );

      const report = auditSiblingAuthPreconditions(diffSummary(repoRoot, [changedFile('src/runs.controller.ts')]));

      assert.equal(report.guardParityFindings.length, 1);
      assert.equal(report.guardParityFindings[0].severity, 'Medium');
      assert.deepEqual(report.guardParityFindings[0].missingGuards, [
        'flag-check',
        'guards(AuthGuard)',
        'ownership-lookup',
      ]);
      assert.deepEqual(report.guardParityFindings[0].methods, [
        'getComparison (GET /runs/:id/comparison)',
        'getSummary (GET /runs/:id/summary)',
      ]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports destructive missing roles and destructive-role drift', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-destructive-role-'));
    try {
      writeFile(
        repoRoot,
        'src/runs.controller.ts',
        [
          '@Controller("runs/:id")',
          'export class RunsController {',
          '  @Roles("admin")',
          '  @Delete("runs")',
          '  deleteRun() { return true; }',
          '',
          '  @Roles("admin", "ops")',
          '  @Post("override-status")',
          '  overrideStatus() { return true; }',
          '',
          '  @Post("cancel-run")',
          '  cancelRun() { return true; }',
          '}',
          '',
        ].join('\n'),
      );

      const report = auditSiblingAuthPreconditions(diffSummary(repoRoot, [changedFile('src/runs.controller.ts')]));

      assert.equal(report.destructiveRoleFindings.length, 2);
      assert.equal(report.destructiveRoleFindings[0].severity, 'Critical');
      assert.match(report.destructiveRoleFindings[0].message, /no effective @Roles/);
      assert.equal(report.destructiveRoleFindings[1].severity, 'High');
      assert.match(report.destructiveRoleFindings[1].message, /destructive-role drift/);
      assert.match(report.destructiveRoleDriftTable, /overrideStatus/);
      assert.match(report.destructiveRoleDriftTable, /admin, ops/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runCitadelAudit AC-CIT-10 behavior', () => {
  test('re-running unchanged diff writes identical JSON and returns same exit code', async () => {
    const { repoRoot, base } = createGitRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-session-'));
    try {
      writeFile(
        repoRoot,
        'src/runs.controller.ts',
        [
          '@Controller("runs/:id")',
          'export class RunsController {',
          '  @Post("cancel-run")',
          '  cancelRun() { return true; }',
          '}',
          '',
        ].join('\n'),
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-qm', 'head']);

      const first = await runCitadelAudit({ prdPath: 'prd.md', diffRange: `${base}..HEAD`, repoRoot, sessionDir });
      const firstJson = fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8');
      const second = await runCitadelAudit({ prdPath: 'prd.md', diffRange: `${base}..HEAD`, repoRoot, sessionDir });
      const secondJson = fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8');

      assert.equal(first.exit_code, second.exit_code);
      assert.equal(firstJson, secondJson);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('concurrent same-session invocations leave one valid locked report', async () => {
    const { repoRoot, base } = createGitRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-session-'));
    try {
      writeFile(
        repoRoot,
        'src/runs.controller.ts',
        [
          '@Controller("runs/:id")',
          'export class RunsController {',
          '  @Roles("admin")',
          '  @Delete("runs")',
          '  deleteRun() { return true; }',
          '}',
          '',
        ].join('\n'),
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-qm', 'head']);

      const [first, second] = await Promise.all([
        runCitadelAudit({ prdPath: 'prd.md', diffRange: `${base}..HEAD`, repoRoot, sessionDir }),
        runCitadelAudit({ prdPath: 'prd.md', diffRange: `${base}..HEAD`, repoRoot, sessionDir }),
      ]);
      const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8'));

      assert.equal(persisted.schema, '1.0');
      assert.equal(first.exit_code, second.exit_code);
      assert.equal(persisted.summary.findings, first.summary.findings);
      assert.equal(persisted.exit_code, first.exit_code);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
