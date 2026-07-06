// @tier: integration
//
// R-APBN-5 — End-to-end regression for the anatomy-park silent-skip-baseline
// failure mode (PRD: prds/p1-anatomy-park-detectproject-null-skips-baseline.md).
//
// Synthesizes a minimal repo layout that mimics this repo's failure mode: no
// project-type marker at the workingDir root, but an `extension/package.json`
// nested one level down. Invokes runGate({mode:'baseline', ...}) directly
// (lighter than the full pipeline-runner) and asserts baseline capture WRITES
// `gate/baseline.json` so downstream pathExists(baselinePath) consumers
// (microverse-runner trap door) survive — the core silent-skip invariant.
//
// R-SZGB-A (convergence-gate.ts detectProjectTypeWithRootResolution) SUPERSEDES
// the original R-APBN-1 partial fix for THIS fixture shape: a no-project-type
// root with EXACTLY ONE package child now resolves DOWN to that child and
// captures its REAL checks, instead of writing a vacuously-empty baseline. The
// empty-baseline path for GENUINELY unresolvable targets (zero or 2+ package
// children, or a detected-but-cmdMap-less type) is still covered by the unit
// suite tests/services/convergence-gate-baseline-no-project-type.test.js and by
// R-SZGB-A's own AC-SZGB-02a/02b. This end-to-end test therefore now pins the
// FULL fix: resolution succeeds and real checks are captured through runGate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runGate } = await import(
  path.resolve(__dirname, '../../services/convergence-gate.js')
);

function makeFixtureRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Repo root mimics pickle-rick-claude: bin/ at root with placeholders, no
  // package.json or lockfile here, no Cargo.toml, no go.mod. The only project
  // marker lives under extension/.
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'foo.js'), '// placeholder\n');
  fs.writeFileSync(path.join(dir, 'bin', 'bar.js'), '// placeholder\n');
  fs.writeFileSync(path.join(dir, 'bin', 'baz.js'), '// placeholder\n');

  fs.mkdirSync(path.join(dir, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension', 'package.json'),
    JSON.stringify({
      name: 'fixture-extension',
      private: true,
      version: '0.0.1',
      // R-SZGB-D-A: all three checks must be runnable (exit 0) so this fixture proves
      // R-SZGB-A root resolution, not the separate unrunnable-check-uncertifiable path
      // (a missing script here now marks the baseline uncertifiable, not a normal
      // subtractable failure — see convergence-gate-unrunnable-check.test.js).
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'extension', 'src', 'hello.ts'),
    'export const hello = () => "world";\n',
  );

  fs.mkdirSync(path.join(dir, 'prds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prds', 'sample.md'), '# placeholder\n');

  return dir;
}

test('R-APBN-5: runGate({mode:baseline}) at no-project-type root with one package child RESOLVES + WRITES baseline.json', async () => {
  const tmpdir = makeFixtureRepo('ap-no-project-root-');
  const baselinePath = path.join(tmpdir, 'gate', 'baseline.json');

  try {
    const result = await runGate({
      mode: 'baseline',
      workingDir: tmpdir,
      baselinePath,
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
    });

    // (1) Gate succeeded — early-return path treats a no-project-type tree
    // as a vacuously green baseline.
    assert.equal(
      result.status,
      'green',
      `gate must return green for no-project-type workingDir, got: ${JSON.stringify(result)}`,
    );

    // (2) No failures recorded.
    assert.equal(
      result.failures.length,
      0,
      `gate must report zero failures for no-project-type workingDir, got: ${JSON.stringify(result.failures)}`,
    );

    // (3) baseline.json file MUST exist on disk post-write — this is the
    // operative assertion that catches the original silent-skip bug. Without
    // the R-APBN-1 fix, runGate's early-return path returns a green result
    // without ever writing baselinePath, and the microverse-runner trap door
    // throws gate_baseline_init_failed downstream.
    assert.ok(
      fs.existsSync(baselinePath),
      `gate/baseline.json MUST exist on disk after baseline-mode runGate, expected at ${baselinePath}`,
    );

    // (4) The written baseline.json is parseable JSON. Post-R-SZGB-A, the
    // no-project-type root with exactly one package child (extension/) RESOLVES
    // down to that child, so the baseline captures the child's REAL checks
    // rather than a vacuously-empty set. checks is therefore NON-empty and
    // project_type is non-null (the fixture's scripts all exit 0, so none of
    // them trip the separate R-SZGB-D-A unrunnable-check-uncertifiable path).
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.ok(
      Array.isArray(baseline.checks),
      `baseline.checks must be an array, got: ${JSON.stringify(baseline.checks)}`,
    );
    assert.ok(
      baseline.checks.length > 0,
      `baseline.checks must be non-empty once R-SZGB-A resolves the one package child, got: ${JSON.stringify(baseline.checks)}`,
    );
    assert.notEqual(
      baseline.project_type,
      null,
      `project_type must be non-null after R-SZGB-A resolves the child package, got: ${JSON.stringify(baseline.project_type)}`,
    );
    assert.ok(
      Array.isArray(baseline.failures),
      `baseline.failures must be an array, got: ${JSON.stringify(baseline.failures)}`,
    );
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});
