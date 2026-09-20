// @tier: fast
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { walkDiff } from '../services/citadel/diff-walker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_RUNNER_SRC = path.resolve(__dirname, '../src/bin/pipeline-runner.ts');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function setupMonorepo() {
  const repoDir = mkTmp('cwrr-monorepo-');
  tmpDirs.push(repoDir);
  const pkgDir = path.join(repoDir, 'packages', 'api');
  fs.mkdirSync(pkgDir, { recursive: true });

  git(['init', '-q', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.local'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);

  const fooPath = path.join(pkgDir, 'foo.ts');
  fs.writeFileSync(fooPath, 'export const foo = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'seed'], repoDir);

  // modify to create a diff
  fs.writeFileSync(fooPath, 'export const foo = 2;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'change'], repoDir);

  return { repoDir, pkgDir };
}

function setupSinglePackage() {
  const repoDir = mkTmp('cwrr-single-');
  tmpDirs.push(repoDir);

  git(['init', '-q', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.local'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);

  const barPath = path.join(repoDir, 'bar.ts');
  fs.writeFileSync(barPath, 'export const bar = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'seed'], repoDir);

  fs.writeFileSync(barPath, 'export const bar = 2;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'change'], repoDir);

  return { repoDir };
}

describe('R-CWRR citadel repoRoot monorepo fix', () => {
  test('structural: PipelineRuntime includes repoRoot field', () => {
    const src = fs.readFileSync(PIPELINE_RUNNER_SRC, 'utf-8');
    assert.match(
      src,
      /interface PipelineRuntime \{[\s\S]*?\brepoRoot:\s*string;[\s\S]*?\}/,
      'PipelineRuntime must declare repoRoot: string',
    );
  });

  test('structural: executeCitadelPhase passes runtime.repoRoot not runtime.workingDir', () => {
    const src = fs.readFileSync(PIPELINE_RUNNER_SRC, 'utf-8');

    // Extract the executeCitadelPhase function body for targeted assertion.
    // The function signature ends with `): Promise<{ exitCode: number }> {` — we need
    // to skip past the TypeScript return type annotation to find the opening body brace.
    const fnSigStart = src.indexOf('async function executeCitadelPhase(');
    assert.ok(fnSigStart !== -1, 'executeCitadelPhase function must exist');

    // Find the function body opening brace: first `{` after the closing `>` of the return type
    const returnTypeSuffix = '): Promise<{ exitCode: number }> {';
    const bodyBraceIdx = src.indexOf(returnTypeSuffix, fnSigStart);
    assert.ok(bodyBraceIdx !== -1, 'executeCitadelPhase must have expected return type signature');
    const bodyStart = bodyBraceIdx + returnTypeSuffix.length - 1; // points to `{`

    // Track braces from the body opening to extract just the function body
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    const fnBody = src.slice(bodyStart, bodyEnd + 1);

    assert.match(
      fnBody,
      /repoRoot:\s*runtime\.repoRoot/,
      'executeCitadelPhase must pass runtime.repoRoot to runCitadelAudit',
    );
    assert.doesNotMatch(
      fnBody,
      /repoRoot:\s*runtime\.workingDir/,
      'executeCitadelPhase must not pass runtime.workingDir as repoRoot',
    );
  });

  test('structural: GIT_REPO_ROOT_TIMEOUT_MS constant exists', () => {
    const src = fs.readFileSync(PIPELINE_RUNNER_SRC, 'utf-8');
    assert.match(
      src,
      /const GIT_REPO_ROOT_TIMEOUT_MS\s*=\s*\d+/,
      'GIT_REPO_ROOT_TIMEOUT_MS constant must be defined',
    );
  });

  test('structural: loadPipelineRuntime computes repoRoot via git rev-parse with timeout', () => {
    const src = fs.readFileSync(PIPELINE_RUNNER_SRC, 'utf-8');
    // AP-EXT-ITER324-01: the second operand is matched as ANY identifier, never the literal
    // name `workingDir`. `resolveGitRepoRoot` now delegates to the shared `gitRepoRoot`, whose
    // parameter is `cwd` because its seven other callers pass a `target` or a state-read dir —
    // so a name-keyed needle read an intact resolver as deleted. The invariant this pin states
    // is that loadPipelineRuntime's repoRoot comes from a TIMED `rev-parse --show-toplevel`,
    // and that claim is about the spawn, not about what anyone named its argument.
    assert.match(
      src,
      /execFileSync\('git',\s*\['-C',\s*\w+,\s*'rev-parse',\s*'--show-toplevel'\]/,
      'loadPipelineRuntime must call git -C <dir> rev-parse --show-toplevel',
    );
    // ...and that loadPipelineRuntime actually REACHES it, so the argv above cannot drift into
    // a function no call path uses.
    assert.match(
      src,
      /const repoRoot = resolveGitRepoRoot\(workingDir/,
      'loadPipelineRuntime must resolve repoRoot through resolveGitRepoRoot',
    );
    assert.match(
      src,
      /timeout:\s*GIT_REPO_ROOT_TIMEOUT_MS/,
      'git rev-parse call must use GIT_REPO_ROOT_TIMEOUT_MS timeout',
    );
  });

  test('monorepo: walkDiff with repoRoot=gitToplevel yields toplevel-relative path (correct)', () => {
    const { repoDir } = setupMonorepo();
    const diff = walkDiff('HEAD~1..HEAD', { repoRoot: repoDir });
    assert.equal(diff.changedFiles.length, 1, 'should have 1 changed file');
    const entry = diff.changedFiles[0];
    assert.equal(
      entry.path,
      'packages/api/foo.ts',
      'walkDiff should yield git-toplevel-relative path',
    );
    const resolved = path.join(repoDir, entry.path);
    assert.equal(
      resolved,
      path.join(repoDir, 'packages', 'api', 'foo.ts'),
      'path.join(repoRoot, entry.path) must resolve to correct file',
    );
    assert.ok(fs.existsSync(resolved), 'resolved path must exist on disk');
  });

  test('monorepo: using subpackage dir as repoRoot doubles the path prefix (demonstrates the bug)', () => {
    const { repoDir, pkgDir } = setupMonorepo();
    // Demonstrate the bug: if repoRoot were the subpackage dir, path would be doubled
    const diff = walkDiff('HEAD~1..HEAD', { repoRoot: repoDir });
    const entry = diff.changedFiles[0];
    // This is the doubled path that the bug would produce
    const doubledPath = path.join(pkgDir, entry.path);
    assert.match(
      doubledPath,
      /packages\/api\/packages\/api\/foo\.ts$/,
      'doubled path pattern should contain duplicate segment',
    );
    assert.ok(!fs.existsSync(doubledPath), 'doubled path must NOT exist (it is the bug path)');
  });

  test('single-package: walkDiff with repoRoot=workingDir=gitToplevel yields correct path (no regression)', () => {
    const { repoDir } = setupSinglePackage();
    const diff = walkDiff('HEAD~1..HEAD', { repoRoot: repoDir });
    assert.equal(diff.changedFiles.length, 1, 'should have 1 changed file');
    const entry = diff.changedFiles[0];
    assert.equal(entry.path, 'bar.ts', 'single-package path must not be prefixed');
    const resolved = path.join(repoDir, entry.path);
    assert.ok(fs.existsSync(resolved), 'resolved path must exist on disk');
    // workingDir === repoRoot → no doubling possible
    assert.equal(repoDir, diff.repoRoot, 'repoRoot must equal provided repoRoot');
  });
});
