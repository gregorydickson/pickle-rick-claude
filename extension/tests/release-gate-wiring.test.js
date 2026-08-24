// @tier: fast
//
// E8 (ticket 087731c7): every canonical FULL_CMD mirror invokes the flake-tolerant release
// gate (`check-flake-budget` via `npm run test:fast:budget`) and NO mirror retains the
// single-pass `npm run test:fast` segment. Teeth: the flake-tolerant mechanism reds the gate on
// a genuinely-broken (every-run) failure but tolerates flakes within budget.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const BIN = path.resolve(EXTENSION_ROOT, 'bin/check-flake-budget.js');

// The flake-tolerant gate token that every mirror must invoke, and the single-pass token that no
// mirror may retain in the gate position. Built from segments so this test file's own source does
// not contain the literal forbidden string and thus does not self-trip its own assertion.
const FAST = 'npm run test:fast';
const BUDGET_TOKEN = `${FAST}:budget`;
// Matches single-pass test:fast NOT immediately followed by ":budget".
const SINGLE_PASS_RE = new RegExp(`${FAST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!:budget)`);

// Each mirror -> the file that carries its copy of the canonical gate command.
const MIRRORS = {
  'CLAUDE.md': path.join(REPO_ROOT, 'CLAUDE.md'),
  'ci.yml': path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
  'release.yml': path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
  'check-wired.sh': path.join(EXTENSION_ROOT, 'scripts', 'check-wired.sh'),
  'release-gate-wiring.test.js': fileURLToPath(import.meta.url),
};

describe('canonical FULL_CMD mirrors invoke the flake-tolerant release gate', () => {
  for (const [mirror, filePath] of Object.entries(MIRRORS)) {
    test(`${mirror} invokes ${BUDGET_TOKEN}`, () => {
      const text = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        text.includes(BUDGET_TOKEN),
        `${mirror} must invoke the flake-tolerant gate (${BUDGET_TOKEN})`,
      );
    });

    test(`${mirror} retains no single-pass ${FAST} gate segment`, () => {
      const text = fs.readFileSync(filePath, 'utf8');
      // This test file legitimately names the single-pass token in comments/segments; assert on
      // the gate-position lines only (lines that wire the gate command), not arbitrary prose.
      const gateLines = text
        .split(/\r?\n/)
        .filter((line) => line.includes('audit-guarded-reset.sh') || line.includes('audit-did-we-count.sh') || line.includes(BUDGET_TOKEN));
      for (const line of gateLines) {
        assert.ok(
          !SINGLE_PASS_RE.test(line),
          `${mirror} gate line must not retain single-pass ${FAST}: ${line.trim().slice(0, 120)}`,
        );
      }
    });
  }
});

// --- Teeth: the flake-tolerant mechanism reds on a real failure, tolerates flakes in budget ---

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rgw-flake-')));
}

// Synthetic test that fails on the first `FLAKE_FAIL_RUNS` runs, then passes — mirrors the
// flake-budget.test.js fixture. With FLAKE_FAIL_RUNS >= runs it fails EVERY run (real breakage).
function writeSyntheticTest(dir) {
  const stateFile = path.join(dir, 'state.txt');
  const testFile = path.join(dir, 'synthetic-flake.test.js');
  const source = `import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';

const stateFile = process.env.FLAKE_STATE_FILE;
const failRuns = Number.parseInt(process.env.FLAKE_FAIL_RUNS ?? '0', 10);
let count = 0;
try { count = Number.parseInt(fs.readFileSync(stateFile, 'utf8'), 10); } catch {}
count += 1;
fs.writeFileSync(stateFile, String(count));

test('synthetic flake budget probe', () => {
  assert.ok(count > failRuns, 'forced failure for run ' + count);
});
`;
  fs.writeFileSync(testFile, source);
  return { stateFile, testFile };
}

function runBudget({ runs, failBudget, failRuns }) {
  const dir = makeTmpDir();
  const { stateFile, testFile } = writeSyntheticTest(dir);
  const result = spawnSync(
    process.execPath,
    [BIN, `--runs=${runs}`, `--fail-budget=${failBudget}`, '--timeout=30000'],
    {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 45000,
      env: {
        ...process.env,
        PICKLE_FLAKE_BUDGET_TEST_FILE: testFile,
        FLAKE_STATE_FILE: stateFile,
        FLAKE_FAIL_RUNS: String(failRuns),
      },
    },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('flake-tolerant gate keeps its teeth', () => {
  test('a genuinely-broken (every-run) failure reds the gate', () => {
    // failRuns >= runs => fails all 4 runs => 4 failures > budget 1 => exit 1.
    const result = runBudget({ runs: 4, failBudget: 1, failRuns: 4 });
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /FAIL_BUDGET_EXCEEDED/);
  });

  test('flakes within budget do NOT red the gate', () => {
    // fails first 2 runs, passes the rest => 2 failures <= budget 2 => exit 0.
    const result = runBudget({ runs: 5, failBudget: 2, failRuns: 2 });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /flake-budget OK/);
  });
});
