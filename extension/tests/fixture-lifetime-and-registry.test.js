// @tier: fast
/**
 * Ticket 7011cd90: sigterm-ignoring-sleeper.js self-terminates on a bounded
 * lifetime (env-overridable, falls back to the compiled default on
 * absent/garbage input) and registers its own PID in a run-scoped registry
 * file (also env-gated, best-effort, existing callers unaffected when unset).
 *
 * D1 (R-ORCG): the fixtures spawned here are released through the SHARED
 * suite-level registry seam (`services/orphan-reaper.js`), not only through each
 * test's `finally`. A `finally` is unreachable on timeout / OOM / cancel, and
 * this fixture ignores SIGTERM by design (`fixtures/sigterm-ignoring-sleeper.js`),
 * so an abandoned instance outlives its runner for the whole of its 120s default
 * bound — and the two spawns below that exercise that default are the ones whose
 * assertion REQUIRES them to still be alive. Note also that the `timeout:` option
 * on these spawns is inert: Node's timeout kills with SIGTERM, which this fixture
 * ignores.
 *
 * The seam is three parts because each covers a different death, and no one part
 * covers another's: `after()` for a normal end or a test timeout,
 * `process.on('exit')` for cancel or an uncaught throw, and the startup sweep for
 * SIGKILL/OOM — under which neither callback runs at all.
 *
 * Every spawn passes `detached: true` so the child is its own process-group
 * leader (pgid === pid). The registry escalation signals a process GROUP
 * (`killProcessGroup(pid)` -> `kill(-pid)`), which addresses nothing when a child
 * merely inherits the runner's group: the registry would faithfully record four
 * pids it could never signal, burn the full grace+verify budget, and report zero
 * reaps while the orphans stayed alive.
 */
import { test, after } from 'node:test';
import * as ts from 'typescript';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reapPreviousRunFixtures,
  initFixturePidRegistry,
  recordFixturePid,
  reapFixtures,
  reapFixturesSync,
} from '../services/orphan-reaper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures/sigterm-ignoring-sleeper.js');

// Suite-level net: see the identical block in
// integration/orphan-worker-reaper-tmp-prefix-drain.test.js for the rationale.
const FIXTURE_REGISTRY_DIR = path.join(os.tmpdir(), 'pickle-orphan-reaper-registry-fixture-lifetime');
reapPreviousRunFixtures(FIXTURE_REGISTRY_DIR);
const FIXTURE_REGISTRY_PATH = initFixturePidRegistry(FIXTURE_REGISTRY_DIR);
process.on('exit', () => reapFixturesSync(FIXTURE_REGISTRY_PATH));
after(async () => { await reapFixtures(FIXTURE_REGISTRY_PATH); });

/**
 * Spawn the fixture as its own process-group leader and record it in the registry
 * before the test can fail, so the crash nets have it even if nothing below runs.
 */
function spawnFixture(env) {
  const child = spawn(process.execPath, [FIXTURE], {
    stdio: 'ignore',
    timeout: 30_000,
    detached: true,
    env: { ...process.env, ...env },
  });
  recordFixturePid(FIXTURE_REGISTRY_PATH, child.pid);
  return child;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Best-effort teardown: by this point the fixture has usually already self-exited. */
function killQuietly(child) {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

test('fixture self-exits unaided once its env-set lifetime bound elapses', async () => {
  const child = spawnFixture({ PICKLE_FIXTURE_MAX_LIFETIME_MS: '300' });
  try {
    await waitFor(() => !isAlive(child.pid), 5_000, 'fixture exited unaided past its 300ms bound');
  } finally {
    killQuietly(child);
  }
});

test('fixture falls back to the compiled default when the lifetime env is absent or garbage', async () => {
  const children = [
    spawnFixture({}),
    spawnFixture({ PICKLE_FIXTURE_MAX_LIFETIME_MS: 'not-a-number' }),
  ];
  try {
    // Neither should have self-exited within a window far below the 120s default.
    await new Promise(r => setTimeout(r, 500));
    for (const child of children) {
      assert.ok(isAlive(child.pid), `pid=${child.pid} must still be alive under the default bound`);
    }
  } finally {
    children.forEach(killQuietly);
  }
});

test('fixture appends its PID to the run-scoped registry when the env var is set', async () => {
  const registryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-registry-')), 'pids.txt');
  const child = spawnFixture({
    PICKLE_FIXTURE_MAX_LIFETIME_MS: '300',
    PICKLE_FIXTURE_PID_REGISTRY: registryPath,
  });
  try {
    await waitFor(() => !isAlive(child.pid), 5_000, 'fixture exited unaided past its bound');
    const lines = fs.readFileSync(registryPath, 'utf-8').trim().split('\n');
    assert.ok(lines.includes(String(child.pid)), `registry must contain spawned pid=${child.pid}; got: ${lines}`);
  } finally {
    killQuietly(child);
  }
});

/**
 * Read the candidate test sources with the LANGUAGE's own parser. Every question
 * the pin below asks — is this a call, where does this name come from, which
 * module is this — is grammar, and every hand-rolled lexical answer to it
 * measured wrong: a stripper that removes only block comments and comment-ONLY
 * lines lets a TRAILING comment name a call, a needle keyed on an identifier's
 * spelling reds a legal alias, and a selector keyed on the `node:` prefix drops
 * a whole file out of the scan. `ts` draws all three lines by construction, so
 * no enumeration of lexical contexts, name spellings or specifier forms is
 * needed or wanted.
 *
 * NOTE: a third copy of these readers (see tests/tsc-gate.test.js and
 * tests/worker-gate-offrepo-runs.test.js). A shared test helper is the right
 * home; see AP-EXT-ITER174-01.
 */
const parseSource = (source, fileName) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

/**
 * The source with its comments removed — exactly, by the parser, rather than by
 * a regex that approximates it. Every leaf token's text in source order, so a
 * path spelled inside a string still reads as code and prose reads as nothing.
 */
function codeText(sourceFile) {
  let out = '';
  const visit = (node) => {
    let leaf = true;
    ts.forEachChild(node, (child) => { leaf = false; visit(child); });
    if (leaf) out += node.getText(sourceFile);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/**
 * Every module this file names, as an IDENTITY rather than a spelling: relative
 * specifiers resolved against `fromDir`, bare ones stripped of any `node:`
 * prefix. `import` and `require()` are both how JavaScript names a module, so
 * both are walked — reading one of the two would be an enumeration missing a
 * member. Each entry keeps its declaring statement so a caller can ask for the
 * bindings of one particular module.
 */
function moduleRefs(sourceFile, fromDir) {
  const refs = [];
  const record = (specifier, statement) => {
    const target = specifier.startsWith('.')
      ? path.resolve(fromDir, specifier)
      : specifier.replace(/^node:/, '');
    refs.push({ target, statement });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, node);
    } else if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])) {
      record(node.arguments[0].text, node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return refs;
}

/**
 * One `{ imported, local }` per named binding of the module resolving to
 * `target`. Aliasing, quote style, how many directories up the specifier
 * climbs, splitting one import into two and reflowing it are all legal
 * refactors that must not red a pin about WHERE a name comes from.
 */
function namedImportsOfModule(sourceFile, fromDir, target) {
  const bindings = [];
  for (const { target: seen, statement } of moduleRefs(sourceFile, fromDir)) {
    if (seen !== target || !ts.isImportDeclaration(statement)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      bindings.push({
        imported: (element.propertyName ?? element.name).text,
        local: element.name.text,
      });
    }
  }
  return bindings;
}

/**
 * True only for a real call of `local` as an identifier callee. A mention of
 * that name followed by a paren in a comment, string or template literal is not
 * a call site.
 *
 * RESIDUE, stated rather than claimed away: a call reached through a namespace
 * import (`reaper.recordFixturePid()`) has a property-access callee and reads
 * false here. `namedImportsOfModule` above would not have bound the local
 * either, so the pair fails CLOSED on that form — a false RED, never a false
 * green.
 */
function callsIdentifier(sourceFile, local) {
  let called = false;
  const visit = (node) => {
    if (called) return;
    if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === local) {
      called = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return called;
}

/**
 * The seam calls a real spawner must make. A MENTION is not a call — an imported
 * but uncalled `recordFixturePid` records nothing — so the check below tests for
 * an invocation, and these names are stored WITHOUT their paren so that this
 * declaration cannot satisfy the very scan it defines.
 */
const REQUIRED_SEAM_CALLS = [
  { name: 'recordFixturePid', consequence: 'its orphans survive a killed run' },
  { name: 'reapPreviousRunFixtures', consequence: 'nothing collects them after a SIGKILL' },
];

/** Every `*.test.js` under `tests/`, including subdirectories. */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/**
 * D1 (R-ORCG): pin the INVARIANT, not the consumer list. The ticket shipped a
 * four-row table of fixture consumers that was already wrong by one row —
 * orphan-worker-reaper.test.js names the fixture only inside fabricated `ps`
 * strings and spawns nothing at all. A pin encoding that table would need
 * maintaining and would rot green, one consumer away from the next silent leak.
 *
 * So the set is DERIVED: a file is a spawner if it names the fixture and can
 * actually spawn. Files that only mention it are exempt BECAUSE they cannot leak,
 * which is checked on every run rather than asserted once in a review artifact —
 * add a real spawn to one and this fails immediately.
 */
/**
 * The one home of the seam, as a resolved path so that a specifier's depth
 * (`../` vs `../../`) is not part of the fact. If the module ever moves, every
 * spawner reds on the import half below rather than quietly matching nothing.
 */
const SEAM_MODULE = path.resolve(__dirname, '../services/orphan-reaper.js');

test('D1 (R-ORCG): every real spawner of the sleeper fixture releases it through the shared registry seam', () => {
  const spawners = collectTestFiles(__dirname)
    .map(file => ({ file, ast: parseSource(fs.readFileSync(file, 'utf-8'), file) }))
    .map(({ file, ast }) => ({ file, ast, dir: path.dirname(file) }))
    .filter(({ ast, dir }) => codeText(ast).includes('sigterm-ignoring-sleeper')
      && moduleRefs(ast, dir).some(({ target }) => target === 'child_process'));

  // Non-vacuity: a selector that admits nothing passes trivially and pins nothing.
  assert.ok(spawners.length > 0, 'the selector must admit the real spawners, else this test proves nothing');

  for (const { file, ast, dir } of spawners) {
    const rel = path.relative(__dirname, file);
    const bindings = namedImportsOfModule(ast, dir, SEAM_MODULE);
    for (const { name, consequence } of REQUIRED_SEAM_CALLS) {
      const bound = bindings.filter(binding => binding.imported === name);
      assert.ok(
        bound.length > 0,
        `${rel} spawns the sleeper fixture but never imports ${name} from the shared seam — ${consequence}`,
      );
      assert.ok(
        bound.some(binding => callsIdentifier(ast, binding.local)),
        `${rel} spawns the sleeper fixture and imports ${name} but never calls it — ${consequence}`,
      );
    }
  }
});

/**
 * The readers above are the D1 pin's whole reason to be believed, and until this
 * test they had none of their own — the catalog recorded that gap as VACUOUS.
 * Each case is a spelling the pre-fix lexical scan measured WRONG in one
 * direction or the other, asserted here against the readers directly so a future
 * simplification back to a regex reds here first.
 */
test('AP-EXT-ITER175-01 the D1 seam pin reads calls from the grammar, not from the text', () => {
  const at = (source) => parseSource(source, 'probe.js');
  const dir = path.resolve('/repo/tests');
  const seam = path.resolve('/repo/services/orphan-reaper.js');

  // A mention is not a call, in either lexical context the old stripper left behind.
  assert.equal(callsIdentifier(at('void 0; // recordFixturePid(a, b)'), 'recordFixturePid'), false);
  assert.equal(callsIdentifier(at('const doc = "recordFixturePid(a, b)";'), 'recordFixturePid'), false);
  assert.equal(callsIdentifier(at('const doc = `recordFixturePid(a, b)`;'), 'recordFixturePid'), false);
  // ...and a real call still is one, however it is reflowed.
  assert.equal(callsIdentifier(at('recordFixturePid(a, b);'), 'recordFixturePid'), true);
  assert.equal(callsIdentifier(at('recordFixturePid(\n  a,\n  b,\n);'), 'recordFixturePid'), true);

  // An alias is the same import; the local name is what gets called.
  const aliased = at("import { recordFixturePid as note } from '../services/orphan-reaper.js';\nnote(a, b);");
  assert.deepEqual(namedImportsOfModule(aliased, dir, seam), [{ imported: 'recordFixturePid', local: 'note' }]);
  assert.equal(callsIdentifier(aliased, 'note'), true);

  // Quote style and specifier depth are spellings, not facts.
  const deep = at('import { recordFixturePid } from "../services/../services/orphan-reaper.js";');
  assert.deepEqual(namedImportsOfModule(deep, dir, seam), [{ imported: 'recordFixturePid', local: 'recordFixturePid' }]);

  // An import naming a DIFFERENT module never satisfies a seam question.
  const elsewhere = at("import { recordFixturePid } from '../services/other.js';");
  assert.deepEqual(namedImportsOfModule(elsewhere, dir, seam), []);

  // The `node:` prefix is not part of a builtin's identity, and `require` names
  // a module exactly as `import` does — the selector must see through both.
  const targets = (source) => moduleRefs(at(source), dir).map(({ target }) => target);
  assert.ok(targets("import { spawn } from 'node:child_process';").includes('child_process'));
  assert.ok(targets("import { spawn } from 'child_process';").includes('child_process'));
  assert.ok(targets("const { spawn } = require('node:child_process');").includes('child_process'));
  // A quoted spawn line inside a generated worker script is text, not an import.
  assert.deepEqual(targets('const worker = "const { spawn } = require(\'node:child_process\');";'), []);

  // codeText keeps string contents — the fixture is named by a path literal —
  // while dropping prose, so the selector cannot be answered by a docblock.
  assert.ok(codeText(at("const f = 'fixtures/sigterm-ignoring-sleeper.js';")).includes('sigterm-ignoring-sleeper'));
  assert.equal(codeText(at('// spawns fixtures/sigterm-ignoring-sleeper.js\nvoid 0;')).includes('sigterm-ignoring-sleeper'), false);
});
