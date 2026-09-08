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
import * as os from 'node:os';
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
  { dir: 'src', exts: ['.ts'], minSettling: 5 },     // measured 15 at ROOT E (was 10 at c75ba623)
  { dir: 'tests', exts: ['.ts', '.js'], minSettling: 30 }, // measured 78 at ROOT E (was 76 at c75ba623)
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
 * Grow `settlers` by the executor's OWN local helpers: a function declared inside the executor
 * whose body calls a known settler settles the promise just as surely as calling `resolve`
 * directly does. Iterated to a fixpoint so an `a() -> b() -> resolve()` chain is followed;
 * it terminates because every pass either adds a name from a finite set or stops.
 *
 * Scoped to the executor subtree on purpose: a same-named helper elsewhere in the file is a
 * different function, and treating it as a settler would over-flag across unrelated promises.
 */
function withLocalSettlers(executor, settlers) {
  const inScope = new Set(settlers);
  const callsAKnownSettler = (body) => {
    let hit = false;
    (function walk(n) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && inScope.has(n.expression.text)) { hit = true; }
      ts.forEachChild(n, walk);
    })(body);
    return hit;
  };

  let grew = true;
  while (grew) {
    const before = inScope.size;
    (function scan(node) {
      const declared = ts.isFunctionDeclaration(node) && node.name ? { name: node.name.text, body: node.body }
        : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ? { name: node.name.text, body: node.initializer.body }
          : null;
      if (declared && declared.body && !inScope.has(declared.name) && callsAKnownSettler(declared.body)) {
        inScope.add(declared.name);
      }
      ts.forEachChild(node, scan);
    })(executor);
    grew = inScope.size > before;
  }
  return inScope;
}

/**
 * Timers whose callback settles an ENCLOSING `new Promise` executor, each tagged with whether it
 * is unref'd. Matching is `settlerReachedBy` (which callback shapes count) and `isUnrefd` (which
 * unref spellings count); both are documented above.
 *
 * LIMIT 1 — SETTLE-THROUGH-A-LOCAL-HELPER — is now CLOSED by `withLocalSettlers` (ROOT E).
 * It used to be invisible: only DIRECT calls to the executor's own parameters counted, so
 * `const settle = r => resolve(r); setTimeout(() => settle(x), ms)` did not match. That gap hid
 * three unref'd hang guards, each the sole settle path of its promise, all now ref'd:
 * `src/bin/jar-runner.ts`, `src/bin/spawn-refinement-team.ts`, `src/services/codegraph-query-runner.ts`.
 * jar-runner is the cautionary one: the SAME site WAS flagged at 58dbe500 and left the census
 * only when a refactor routed it through the helper — the limit demonstrably lost true positives
 * over time. The prior note excused two of them as "benign, a live child-process handle holds the
 * loop open", while stating they were unflagged because they had never been examined. Examined:
 * the excuse is backwards. A hang guard fires only when `'close'` never arrives, and the usual
 * reason `'close'` never arrives is that the child is gone and its handle already released —
 * the same state in which the loop drains and an unref'd timer never fires. spawn-refinement-team
 * was not in that note at all; the widened matcher found it, which is the argument for widening
 * rather than hand-patching the two sites someone had already thought to write down.
 *
 * KNOWN LIMIT 2 — this matcher still UNDER-detects here, named so the next reader does not read
 * the test title as broader than the check.
 *   PROPERTY-RECEIVER `unref` is invisible. `collectUnrefs` requires an identifier receiver, so
 *   `this.timer.unref()` is not collected — e.g. `src/bin/mux-runner.ts:4452`, `:4593`. MEASURED,
 *   not assumed: a replica with this arm closed as well flags zero additional sites at HEAD, and
 *   neither of those two is a settling timer per `settlerReachedBy` (`:4452` is a pure-telemetry
 *   heartbeat that must STAY unref'd, `:4593` is armed after `this.settled` is already true).
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
        inScope = withLocalSettlers(executor, [...settlers, ...names]);
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

// ---------------------------------------------------------------------------
// The widening, verified in BOTH directions
//
// A widened matcher that only ever finds MORE is not thereby correct: under-trigger alone would
// pass a carry-anything bug, and over-trigger has a specific victim here — a heartbeat. Ref'ing a
// heartbeat holds the event loop open forever, which is a NEW hang and strictly worse than the
// defect being fixed, so "does not flag a heartbeat" is a load-bearing property, not a nicety.
//
// The probes are assembled at runtime into `os.tmpdir()`, NEVER into `tests/`. A probe file
// committed under the walk would be scanned like any other file and would red this suite on its
// own fixture — the same trap the `.mjs` exclusion above records.
// ---------------------------------------------------------------------------

const PROBE_SETTLES_VIA_HELPER = `
export function run(): Promise<number> {
  return new Promise((resolve) => {
    const settle = (v: number) => { resolve(v); };
    const guard = setTimeout(() => settle(1), 1000);
    guard.unref();
  });
}
`;

// The mux-runner.ts:4452 shape: an interval whose callback settles NOTHING, unref'd on purpose.
const PROBE_HEARTBEAT = `
let touched = 0;
export function run(done: { on: (e: string, f: () => void) => void }): Promise<number> {
  return new Promise((resolve) => {
    const bump = () => { touched += 1; };
    const heartbeat = setInterval(() => bump(), 100);
    heartbeat.unref();
    done.on('close', () => resolve(touched));
  });
}
`;

test('the helper widening flags a helper-settled unref\'d timer and spares a heartbeat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unref-scan-probe-'));
  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return findSettlingTimers(file);
  };

  try {
    // DIRECTION 1 — it must newly FLAG a real sole-settle-path site. This shape is invisible to
    // the pre-widening matcher (the callback calls `settle`, not `resolve`), and it is exactly
    // the shape the three ref'd hang guards have.
    const settling = write('settles-via-helper.ts', PROBE_SETTLES_VIA_HELPER);
    assert.deepEqual(
      settling.map(t => ({ settles: t.settles, unrefd: t.unrefd })),
      [{ settles: 'settle', unrefd: true }],
      'a timer settling through a local helper must be seen, and seen as unref\'d — this is the '
      + 'gap that hid jar-runner.ts, spawn-refinement-team.ts and codegraph-query-runner.ts',
    );

    // Non-vacuity: the flag must track `.unref()`, not merely matching. Drop the unref and the
    // same source must still MATCH but no longer be FLAGGED.
    const refd = write('settles-via-helper-refd.ts', PROBE_SETTLES_VIA_HELPER.replace('guard.unref();', ''));
    assert.deepEqual(
      refd.map(t => ({ settles: t.settles, unrefd: t.unrefd })),
      [{ settles: 'settle', unrefd: false }],
      'ref\'ing the timer must clear the violation while keeping the match — otherwise the scan '
      + 'is reporting "is a settling timer", not "is an unref\'d settling timer"',
    );

    // DIRECTION 2 — it must NOT flag a heartbeat. `bump` never reaches a settler, so the fixpoint
    // in `withLocalSettlers` must refuse to promote it however many passes it runs.
    assert.deepEqual(
      write('heartbeat.ts', PROBE_HEARTBEAT),
      [],
      'a heartbeat settles nothing and must stay unref\'d: flagging it would push someone to ref '
      + 'an interval that is never cleared, holding the event loop open forever — a new hang, '
      + 'strictly worse than the defect this scan exists to catch',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
