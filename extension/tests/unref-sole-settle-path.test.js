// @tier: fast
//
// Pins the mechanism behind ticket 228e5fb8 (ROOT 1): an `.unref()`'d timer that is the
// SOLE settle path for a hung async operation does not reliably fire, because its firing
// becomes conditional on some UNRELATED handle happening to hold the event loop open. This
// is the exact reproduction shape `5cce7f5d` (microverse-runner.ts spawnWithClosedStdin) and
// `3b2c0205` (monitor.ts writeWithWatchdog) used to prove their fixes — a handle-free child
// (no real spawn, no other timer, nothing else keeping the loop alive) with a `settled` flag
// and a single `setTimeout` as the only handle in the process. Every timer this ticket ref'd
// (mux-runner.ts hangGuard/outputStallGuard/timeoutResolveTimer/exitDrainTimer, spawn-morty.ts
// runCommand's timeoutHandle and armWorkerHangGuard's hangGuard, convergence-gate.ts
// runCheckCommand's timer) shares this exact shape; a regression back to `.unref()` on any of
// them reproduces the failure asserted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sole-settle-path-repro.mjs');

test('ref\'d sole-settle-path timer: fires reliably with no other handle holding the loop', () => {
  const result = spawnSync(process.execPath, [FIXTURE], {
    encoding: 'utf-8',
    timeout: 5000,
    env: { ...process.env, PICKLE_TEST_UNREF_TIMER: '0' },
  });
  assert.equal(result.status, 0, `expected clean exit, got status=${result.status} stderr=${result.stderr}`);
  assert.ok(result.stdout.includes('SETTLED true'), `expected the settle path to fire: ${result.stdout}`);
});

test('negative control: an unref\'d sole-settle-path timer does NOT reliably fire (proves the mechanism)', () => {
  const result = spawnSync(process.execPath, [FIXTURE], {
    encoding: 'utf-8',
    timeout: 5000,
    env: { ...process.env, PICKLE_TEST_UNREF_TIMER: '1' },
  });
  assert.notEqual(result.status, 0, `expected the unref'd timer to leave the await unsettled, got status=${result.status}`);
  assert.ok(!result.stdout.includes('SETTLED true'), `the settle path must NOT have fired: ${result.stdout}`);
});

// ---------------------------------------------------------------------------
// The property, checked mechanically — no per-site list
//
// The two tests above pin the MECHANISM against a fixture. They cannot tell you whether the
// mechanism is present in the tree, so the knowledge of WHERE it applies lived in this file's
// header as prose and in B-DRAIN13's PRD as a four-file census: "13 `.unref()` sites remain on
// the runner surface — mux-runner.ts x6, spawn-morty.ts x3, microverse-runner.ts x3,
// convergence-gate.ts x1 ... Across all of `extension/src` the count is 23, not 13".
//
// That enumeration is why ticket c75ba623 exists. beta.20's serial tier reported `cancelled 3`
// from three timers the census never looked at, because they were in test-harness poll code
// rather than in one of the four listed modules. The criterion was right; the enumerated set
// was one member short, and a missing member looks exactly like a member that does not apply.
//
// So this asserts the PROPERTY instead of a list: no `setTimeout`/`setInterval` whose callback
// settles an enclosing `new Promise` executor may be `.unref()`'d. Validated as an oracle
// against the base sha `58dbe500`, where it recovers exactly the three sites owning the three
// cancelled tests (process-cleanup.test.js:158, :587, :683) with no misses and no false
// positives — it needed no knowledge of which tests failed.
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const TIMER_FNS = new Set(['setTimeout', 'setInterval']);

/** Every `.ts` file under `src/`. Throws rather than returning [] — an empty walk must not pass. */
function collectSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Timers whose callback settles an ENCLOSING `new Promise` executor.
 *
 * Both callback spellings count, because both occur in the sites this guard exists for:
 * `setTimeout(() => resolve(v), ms)` (codegraph-service.ts, microverse-runner.ts) and
 * `setTimeout(resolve, ms)` — the settler passed DIRECTLY, which is the exact shape of the
 * `sleep()` helper that stranded PC-4.
 *
 * A timer counts as unref'd if it is chained (`setTimeout(...).unref()`, incl. `?.()`) or if the
 * name it is bound to is unref'd anywhere in the same file.
 */
function findSettlingTimers(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  const unrefdNames = new Set();
  (function collectUnrefs(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'unref'
      && ts.isIdentifier(node.expression.expression)
    ) {
      unrefdNames.add(node.expression.expression.text);
    }
    ts.forEachChild(node, collectUnrefs);
  })(src);

  const found = [];
  (function visit(node, settlers) {
    let inScope = settlers;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Promise') {
      const executor = node.arguments?.[0];
      if (executor && (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) {
        const names = executor.parameters.filter(p => ts.isIdentifier(p.name)).map(p => p.name.text);
        inScope = new Set([...settlers, ...names]);
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TIMER_FNS.has(node.expression.text)) {
      const callback = node.arguments?.[0];
      if (callback && inScope.size > 0) {
        let settles = null;
        if (ts.isIdentifier(callback) && inScope.has(callback.text)) {
          settles = callback.text;
        } else {
          (function scanBody(n) {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && inScope.has(n.expression.text)) {
              settles = n.expression.text;
            }
            ts.forEachChild(n, scanBody);
          })(callback);
        }

        if (settles) {
          const parent = node.parent;
          let unrefd = ts.isPropertyAccessExpression(parent) && parent.name.text === 'unref';
          let boundTo = null;
          if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) boundTo = parent.name.text;
          else if (ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)) boundTo = parent.left.text;
          if (!unrefd && boundTo !== null && unrefdNames.has(boundTo)) unrefd = true;

          found.push({
            file: path.relative(SRC_ROOT, file),
            line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
            settles,
            unrefd,
          });
        }
      }
    }

    ts.forEachChild(node, n => visit(n, inScope));
  })(src, new Set());

  return found;
}

function scanSrc() {
  const files = collectSourceFiles(SRC_ROOT);
  if (files.length === 0) {
    throw new Error(`no .ts files found under ${SRC_ROOT} — the walk is broken, not the tree clean`);
  }
  return { files, timers: files.flatMap(findSettlingTimers) };
}

// The floor is the anti-vacuity guard, and it is the reason this test cannot green for free.
// "Zero violations" is exactly what a broken walk, an empty file list or a desynced parse also
// produce, so the scan must additionally PROVE it looked at something. Measured 10 at
// c75ba623; 5 leaves room to delete half of them without a spurious red.
const MIN_SETTLING_TIMERS = 5;

test('no promise\'s sole settle path is an unref\'d timer, anywhere under src/', () => {
  const { timers } = scanSrc();
  const violations = timers.filter(t => t.unrefd);

  assert.deepEqual(
    violations.map(v => `${v.file}:${v.line} (settles ${v.settles}())`),
    [],
    'a timer that settles an enclosing `new Promise` executor must NOT be unref\'d: when the '
    + 'other settle path hangs — the case the timer exists for — it is the SOLE settle path, and '
    + 'an unref\'d timer lets the loop drain with the promise forever pending',
  );
});

test('the sole-settle-path scan is not vacuous: it actually finds settling timers in src/', () => {
  const { files, timers } = scanSrc();

  assert.ok(
    files.length > 0,
    'the src/ walk returned no files — a zero-violation verdict would be meaningless',
  );
  assert.ok(
    timers.length >= MIN_SETTLING_TIMERS,
    `expected at least ${MIN_SETTLING_TIMERS} promise-settling timers under src/, found `
    + `${timers.length} across ${files.length} files — the walk or the AST match is broken, and `
    + 'a broken scan reports zero violations exactly like a clean tree does',
  );
});
