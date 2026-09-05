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
// settles an enclosing `new Promise` executor may be `.unref()`'d.
//
// THE WALK COVERS `tests/` AS WELL AS `src/`, AND THAT IS THE WHOLE POINT (AP-EXT-ITER213-01).
// A `src/`-only walk reproduces the very mistake it replaced: beta.20's three misses were in
// TEST-harness poll code, so scoping the replacement to `src/` generalises on the wrong axis —
// it widens within `src/` while the actual miss lived outside it. Replayed at base sha
// `58dbe500` this matcher recovers, over `extension/tests`, exactly the three sites owning the
// three cancelled tests — integration/process-cleanup.test.js:158, :587 and :683 — plus the
// still-unfixed mux-silent-worker-exit.test.js:93. Over `extension/src` at that same sha it
// recovers two entirely different sites (bin/jar-runner.ts:231, services/codegraph-service.ts:407)
// and NONE of the three. The oracle claim is only reproducible with `tests/` in the walk.
//
// The property is about promise settlement, not about which directory a file sits in, so the
// scan carries no src-vs-tests distinction to get wrong.
// ---------------------------------------------------------------------------

const EXT_ROOT = path.resolve(__dirname, '..');
const TIMER_FNS = new Set(['setTimeout', 'setInterval']);

// One row per scanned root. `minSettling` is a PER-ROOT anti-vacuity floor rather than one
// global number: a single total cannot notice one root going dark (src/ contributes 10 of the
// 86 matches, so a global floor of 5 stays green with the whole `tests/` walk broken — exactly
// the silent under-count this file exists to refuse).
//
// `.mjs` IS DELIBERATELY NOT SCANNED. tests/fixtures/sole-settle-path-repro.mjs is this file's
// own negative control and reproduces the violating shape ON PURPOSE; adding `.mjs` reds the
// gate on its own fixture. Extend the extensions only with that fixture excluded.
const SCAN_ROOTS = [
  { dir: 'src', exts: ['.ts'], minSettling: 5 },     // measured 10 at c75ba623
  { dir: 'tests', exts: ['.ts', '.js'], minSettling: 30 }, // measured 76 at c75ba623
];

/** Every file with one of `exts` under `dir`. Throws rather than returning [] — an empty walk must not pass. */
function collectSourceFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const isTimerCall = (node) =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TIMER_FNS.has(node.expression.text);

/**
 * The settler name this timer callback reaches, or null. Both spellings count: the settler passed
 * DIRECTLY (`setTimeout(resolve, ms)` — the shape that stranded PC-4) and a call in the body
 * (`setTimeout(() => resolve(v), ms)`).
 */
function settlerReachedBy(callback, inScope) {
  if (!callback || inScope.size === 0) { return null; }
  if (ts.isIdentifier(callback)) { return inScope.has(callback.text) ? callback.text : null; }

  let settles = null;
  (function scanBody(n) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && inScope.has(n.expression.text)) {
      settles = n.expression.text;
    }
    ts.forEachChild(n, scanBody);
  })(callback);
  return settles;
}

/** Unref'd either by chaining onto the call, or via the name the timer is bound to. */
function isUnrefd(node, unrefdNames) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'unref') { return true; }

  const boundTo = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text
    : ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left) ? parent.left.text
      : null;
  return boundTo !== null && unrefdNames.has(boundTo);
}

/**
 * Timers whose callback settles an ENCLOSING `new Promise` executor, each tagged with whether it
 * is unref'd. Matching is `settlerReachedBy` (which callback shapes count) and `isUnrefd` (which
 * unref spellings count); both are documented above.
 *
 * KNOWN LIMITS — this matcher UNDER-detects, and the gaps are named so the next reader does not
 * read the test title as broader than the check.
 *   1. SETTLE-THROUGH-A-LOCAL-HELPER is invisible. Only DIRECT calls to the executor's own
 *      parameters count, so `const settle = r => resolve(r); setTimeout(() => settle(x), ms)`
 *      does not match. Live examples: `src/services/codegraph-query-runner.ts:190` and
 *      `src/bin/jar-runner.ts:252`, both unref'd timers settling via `settle()` — absent from
 *      this scan's census. jar-runner is the cautionary one: the SAME site WAS flagged at
 *      58dbe500 and left the census only when a refactor routed it through the helper, so this
 *      limit demonstrably loses true positives over time. (Believed benign at both: a live
 *      child-process handle holds the loop open so the timer still fires. But they are
 *      unflagged because they were never examined, NOT because that argument was checked.)
 *   2. PROPERTY-RECEIVER `unref` is invisible. `collectUnrefs` requires an identifier receiver,
 *      so `this.timer.unref()` is not collected — e.g. `src/bin/mux-runner.ts:4389`, `:4530`.
 *      Neither is a settling timer per `settlerReachedBy` today, so nothing is missed at present.
 *
 * The bias throughout is toward a FALSE RED, never a false green: `unrefdNames` is file-global
 * and ignores shadowing, so a reused timer name over-flags rather than under-flags. An over-flag
 * gets investigated; an under-flag ships.
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

    const settles = isTimerCall(node) ? settlerReachedBy(node.arguments?.[0], inScope) : null;
    if (settles) {
      found.push({
        file: path.relative(EXT_ROOT, file).split(path.sep).join('/'),
        line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
        settles,
        unrefd: isUnrefd(node, unrefdNames),
      });
    }

    ts.forEachChild(node, n => visit(n, inScope));
  })(src, new Set());

  return found;
}

const describeViolation = (v) => `${v.file}:${v.line} (settles ${v.settles}())`;

/**
 * Scan every root once. Memoised because both tests below consume it and the widened walk
 * parses ~1070 files (~0.8s); paying that twice would push a @tier: fast file toward the
 * load-sensitive band that audit-subprocess-heavy-tests.sh flags.
 */
let scanCache = null;
function scanTree() {
  if (scanCache) { return scanCache; }
  scanCache = SCAN_ROOTS.map((root) => {
    const files = collectSourceFiles(path.join(EXT_ROOT, root.dir), root.exts);
    if (files.length === 0) {
      throw new Error(`no ${root.exts.join('/')} files found under ${root.dir}/ — the walk is broken, not the tree clean`);
    }
    return { ...root, files, timers: files.flatMap(findSettlingTimers) };
  });
  return scanCache;
}

// The one violation this ticket cannot close, named rather than silently tolerated.
//
// tests/mux-silent-worker-exit.test.js:93 unref's `boundTimer`, the sole settle path of the
// `Promise.race` watchdog in a test whose subject IS a 0%-CPU hang — so the watchdog is
// disarmed in exactly the case it guards. It predates c75ba623 (present at 58dbe500) and that
// file is outside this ticket's scope fence, so fixing it belongs to a bundle that can edit it.
//
// This entry ROTS RED, not green: the test below asserts it is still PRESENT in the scan, so
// the day someone ref's that timer this constant reds and must be deleted. A stale member
// cannot sit here quietly granting permission.
const KNOWN_UNFIXED = ['tests/mux-silent-worker-exit.test.js:93 (settles reject())'];

test('no promise\'s sole settle path is an unref\'d timer, anywhere under src/ or tests/', () => {
  const violations = scanTree().flatMap(r => r.timers).filter(t => t.unrefd).map(describeViolation);

  assert.deepEqual(
    violations.filter(v => !KNOWN_UNFIXED.includes(v)),
    [],
    'a timer that settles an enclosing `new Promise` executor must NOT be unref\'d: when the '
    + 'other settle path hangs — the case the timer exists for — it is the SOLE settle path, and '
    + 'an unref\'d timer lets the loop drain with the promise forever pending',
  );
});

test('every KNOWN_UNFIXED entry is still a real violation — the exception list rots red, not green', () => {
  const violations = scanTree().flatMap(r => r.timers).filter(t => t.unrefd).map(describeViolation);

  assert.deepEqual(
    KNOWN_UNFIXED.filter(k => !violations.includes(k)),
    [],
    'a KNOWN_UNFIXED entry the scan no longer reports is either fixed (delete the entry) or has '
    + 'moved line (update it) — either way it is now silently excusing nothing, or worse, '
    + 'excusing a site that has drifted somewhere else',
  );
});

test('the sole-settle-path scan is not vacuous: it finds settling timers under EVERY root', () => {
  // "Zero violations" is exactly what a broken walk, an empty file list or a desynced parse also
  // produce, so the scan must additionally PROVE it looked at something — per root, because one
  // dark root is invisible in a combined total.
  const shortfalls = scanTree()
    .filter(r => r.timers.length < r.minSettling)
    .map(r => `${r.dir}/: found ${r.timers.length} settling timers across ${r.files.length} files, expected >= ${r.minSettling}`);

  assert.deepEqual(
    shortfalls,
    [],
    'a root came up short — the walk or the AST match is broken for it, and a broken scan '
    + 'reports zero violations exactly like a clean tree does',
  );
});
