// @tier: fast
//
// B-OFFREPO ticket 20 (0454370b) — the worker gate must actually RUN off-repo.
//
// Ticket 10 made the off-repo exit stop CLAIMING a pass. It still issued no
// command, so on every repo without an `extension/` tree — i.e. every repo that
// is not pickle-rick, i.e. the entire autonomy use case — the gate performed no
// lint, no typecheck and no tests. These specs pin that it now executes the
// TARGET's own toolchain and derives its verdict from the real result.
//
// Every fixture is a temp dir with NO `extension/` directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { runWorkerGate } from '../bin/spawn-morty.js';
import { isAdvisoryWorkerGateVerdict } from '../bin/mux-runner.js';

const TMP_ROOTS = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offrepo-gate-'));
  TMP_ROOTS.push(dir);
  return fs.realpathSync(dir);
}

process.on('exit', () => {
  for (const dir of TMP_ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function writeState(root) {
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 5,
    working_dir: root,
    session_dir: root,
    active: true,
    activity: [],
  }));
  return statePath;
}

function writeTicket(root, ticketId) {
  const dir = path.join(root, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: In Progress\n---\n# t\n`,
  );
}

function frontmatterField(root, ticketId, field) {
  const raw = fs.readFileSync(path.join(root, ticketId, `rick_ticket_${ticketId}.md`), 'utf8');
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

/**
 * A target repo: `package.json` + `package-lock.json` (so `detectProjectType`
 * resolves `npm`) and NO `extension/` dir. Scripts are real node commands, so the
 * gate's execution is observable through the side effects they leave on disk.
 */
function makeNpmFixture({ typecheckExit = 0, lintExit = 0, testExit = 0, scripts = null } = {}) {
  const root = makeTmp();
  const ticketId = 'bbb22222';
  const probe = (name, exitCode) =>
    `node -e "require('fs').writeFileSync('${name}.ran','1');process.exit(${exitCode})"`;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'target-repo',
    version: '1.0.0',
    scripts: scripts ?? {
      typecheck: probe('typecheck', typecheckExit),
      lint: probe('lint', lintExit),
      test: probe('test', testExit),
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  writeTicket(root, ticketId);
  return { root, ticketId, statePath: writeState(root) };
}

function gateArgs({ root, ticketId, statePath }) {
  return { workingDir: root, ticketId, statePath, preWorkerHead: null };
}

const ranProbe = (root, name) => fs.existsSync(path.join(root, `${name}.ran`));

/**
 * A monorepo target: `workingDir` itself has NO manifest, but exactly one depth-1
 * child does. Exercises `resolveWorkerGateProject`'s second resolution branch
 * (probe children when the root itself doesn't resolve) end-to-end through the
 * real `runWorkerGate` entry point.
 */
function makeMonorepoNpmFixture(childNames = ['app']) {
  const root = makeTmp();
  const ticketId = 'eee55555';
  for (const childName of childNames) {
    const childDir = path.join(root, childName);
    fs.mkdirSync(childDir, { recursive: true });
    const probe = (name) =>
      `node -e "require('fs').writeFileSync('${name}.ran','1');process.exit(0)"`;
    fs.writeFileSync(path.join(childDir, 'package.json'), JSON.stringify({
      name: `target-${childName}`,
      version: '1.0.0',
      scripts: { typecheck: probe('typecheck'), lint: probe('lint'), test: probe('test') },
    }, null, 2));
    fs.writeFileSync(path.join(childDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  }
  writeTicket(root, ticketId);
  return { root, ticketId, statePath: writeState(root), childDir: path.join(root, childNames[0]) };
}

// ---------------------------------------------------------------------------
// AC-OFFREPO-2a — the gate EXECUTES the target's own toolchain.
// ---------------------------------------------------------------------------

test('off-repo: a resolvable npm project has its OWN lint/typecheck/test executed', async () => {
  const fixture = makeNpmFixture();
  const result = await runWorkerGate([], gateArgs(fixture));

  // The load-bearing assertion: real commands ran in the TARGET repo. Before this
  // ticket every one of these was false — the gate returned without spawning
  // anything at all.
  assert.equal(ranProbe(fixture.root, 'typecheck'), true, 'target typecheck must execute');
  assert.equal(ranProbe(fixture.root, 'lint'), true, 'target lint must execute');
  assert.equal(ranProbe(fixture.root, 'test'), true, 'target test must execute');

  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'green',
    'a verdict derived from a genuinely passing target toolchain is green',
  );
  assert.equal(frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'), 'green');
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2b — unresolvable project => not_run, NEVER green.
// ---------------------------------------------------------------------------

test('off-repo: a repo with no manifest yields not_run, never green', async () => {
  const root = makeTmp();
  const ticketId = 'ccc33333';
  writeTicket(root, ticketId);
  const statePath = writeState(root);

  const result = await runWorkerGate([], gateArgs({ root, ticketId, statePath }));

  const verdict = frontmatterField(root, ticketId, 'worker_gate_verdict');
  assert.equal(verdict, 'not_run');
  assert.notEqual(verdict, 'green', 'nothing was checked, so nothing may be reported as passing');
  assert.equal(frontmatterField(root, ticketId, 'worker_gate_tests_verdict'), 'not_run');
  // Not a halt: an unrunnable gate must never block the local action.
  assert.equal(result.ok, true);
});

test('off-repo: a project type with no command-map entry (bun) is not_run, not green and not a crash', async () => {
  const root = makeTmp();
  const ticketId = 'ddd44444';
  // `detectProjectType` resolves `bun`, but `gate-commands.json` carries no bun
  // entry. Adding one would be the per-stack adapter matrix the repo-agnostic
  // invariant forbids; the honest answer is that this gate cannot run here.
  fs.writeFileSync(path.join(root, 'bun.lockb'), '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bun-repo' }));
  writeTicket(root, ticketId);
  const statePath = writeState(root);

  const result = await runWorkerGate([], gateArgs({ root, ticketId, statePath }));

  assert.equal(frontmatterField(root, ticketId, 'worker_gate_verdict'), 'not_run');
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// G1 (e7501535) — the monorepo-child resolution branch of resolveWorkerGateProject,
// driven end-to-end through the real runWorkerGate entry point. Every prior fixture
// puts the manifest directly in `workingDir`; a real non-pickle-rick target is often
// a monorepo whose manifest lives one directory down, and that branch had no
// coverage proving the gate actually runs the CHILD's toolchain.
// ---------------------------------------------------------------------------

test('off-repo: a monorepo with ONE resolvable child package has the CHILD toolchain executed', async () => {
  const fixture = makeMonorepoNpmFixture(['app']);
  const result = await runWorkerGate([], gateArgs(fixture));

  // The load-bearing assertion: the probe files land in the CHILD directory, proving
  // the gate resolved and ran the child's own scripts — not a phantom root-level
  // command and not a no-op that happens to report green.
  assert.equal(fs.existsSync(path.join(fixture.childDir, 'typecheck.ran')), true);
  assert.equal(fs.existsSync(path.join(fixture.childDir, 'lint.ran')), true);
  assert.equal(fs.existsSync(path.join(fixture.childDir, 'test.ran')), true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'typecheck.ran')), false, 'no phantom root-level command');

  assert.equal(frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'), 'green');
  assert.equal(result.ok, true);
});

test('off-repo: an AMBIGUOUS monorepo (two resolvable children) is not_run, never guessed', async () => {
  const fixture = makeMonorepoNpmFixture(['app', 'api']);
  const result = await runWorkerGate([], gateArgs(fixture));

  // Neither child's scripts may have run — resolveWorkerGateProject refuses to guess
  // when 2+ candidates resolve.
  assert.equal(fs.existsSync(path.join(fixture.root, 'app', 'typecheck.ran')), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'api', 'typecheck.ran')), false);

  assert.equal(frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'), 'not_run');
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2c — a failing target suite FLAGS and CONTINUES; it does not halt.
// ---------------------------------------------------------------------------

test('off-repo: a failing target suite is recorded red but does NOT halt the pipeline', async () => {
  const fixture = makeNpmFixture({ testExit: 1 });
  const result = await runWorkerGate([], gateArgs(fixture));

  assert.equal(ranProbe(fixture.root, 'test'), true, 'the failing suite must actually have run');
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'red',
    'the verdict is honest: the target suite genuinely failed',
  );
  assert.equal(frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'), 'red');

  // The whole point of AC-5. `ok:false` would trip the gate-fail tree reset and
  // flip the ticket Failed on a target repo whose suite may well have been red
  // before this worker touched it — a gate STOPPING the system.
  assert.equal(result.ok, true, 'a red target suite must not block the local action');
  assert.equal(result.failedFlipSuppressed, false);
  assert.equal(result.gatePhase, 'test:fast', 'the failing phase is flagged, not swallowed');
});

test('off-repo: a missing script is not_run, not a failure', async () => {
  // "Missing script" is an absent capability, not a code defect — the gate's own
  // `isUnrunnableCheckResult` classifier reaches that verdict from the command's
  // ACTUAL result. (Whether the command was safe to spawn AT ALL is a different
  // question, asked before this one — see the unsafe-test-script spec below.)
  const fixture = makeNpmFixture({
    scripts: { typecheck: `node -e "require('fs').writeFileSync('typecheck.ran','1')"` },
  });
  const result = await runWorkerGate([], gateArgs(fixture));

  assert.equal(ranProbe(fixture.root, 'typecheck'), true);
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'green',
    'one dimension genuinely ran and passed; the absent ones are exempt, not red',
  );
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'),
    'not_run',
    'an absent test script never reports as verified',
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER14-01 — an unsafe target test script is never SPAWNED.
//
// The off-repo gate resolves the target's `test` command from the same
// `data/gate-commands.json` the convergence gate uses, and the convergence gate
// refuses to spawn an e2e/playwright/hardhat leaf. Running it here would launch
// browsers / chain nodes / real services once per ticket on an arbitrary repo —
// and no exit-code classifier can un-launch them.
// ---------------------------------------------------------------------------

test('off-repo: an unsafe (smoke/e2e-class) target test script is NOT spawned — not_run, never launched', async () => {
  const fixture = makeNpmFixture({
    scripts: {
      typecheck: `node -e "require('fs').writeFileSync('typecheck.ran','1')"`,
      // Spawnable and would succeed — the ONLY thing stopping it is the safety
      // classifier. A non-existent binary (`playwright`) would prove nothing here:
      // it reads not_run via ENOENT whether or not the guard exists.
      test: 'node ./run-smoke.js',
    },
  });
  fs.writeFileSync(
    path.join(fixture.root, 'run-smoke.js'),
    `require('fs').writeFileSync('test.ran','1');\n`,
  );

  const result = await runWorkerGate([], gateArgs(fixture));

  assert.equal(ranProbe(fixture.root, 'typecheck'), true, 'the safe dimensions still execute');
  assert.equal(
    ranProbe(fixture.root, 'test'), false,
    'the unsafe test script must never have been spawned — this file exists only if it ran',
  );
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'),
    'not_run',
    'a script we declined to spawn is not_run — never green, never red',
  );
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'green',
    'typecheck genuinely ran and passed; the declined dimension is exempt, not a failure',
  );
  assert.equal(result.ok, true, 'declining to spawn must not block the local action');
});

test('off-repo: the spawn decision uses the convergence gate ONE classifier, not a second copy', () => {
  const spawnMorty = parseSource(
    fs.readFileSync(new URL('../src/bin/spawn-morty.ts', import.meta.url), 'utf8'),
    'spawn-morty.ts',
  );

  // The classifier must be BOUND from the gate service AND CALLED. Do NOT grep
  // the raw source for the call form: prose can answer that. MEASURED before
  // this collapse — a privately named local classifier whose
  // unsafe-leaf list had silently dropped the browser and chain runners, with a
  // comment left naming the shared call form, was GREEN 13/13. That is a second
  // copy that SPAWNS a leaf the convergence gate refuses.
  const classifier = namedImportsOf(spawnMorty, '../services/convergence-gate.js')
    .find((binding) => binding.imported === 'classifyTestScriptSafety');
  assert.ok(
    classifier,
    'the off-repo test dimension must bind the shared safety classifier',
  );
  assert.ok(
    callsIdentifier(spawnMorty, classifier.local),
    'the off-repo test dimension must CALL the shared classifier, not just import it',
  );

  // A local unsafe-pattern list here is the divergence this fix removes: the two
  // gates would then answer the same question about the same script differently.
  // Comment-blindness is the parser's, not a regex's: the `^\s*//` stripper this
  // replaces only removed WHOLE-LINE comments, so appending `// e.g. a
  // playwright leaf` to the call — a comment, changing nothing the invariant
  // asserts — measured 11 pass / 2 fail.
  assert.equal(
    /playwright|cypress|hardhat/.test(codeText(spawnMorty)), false,
    'no second unsafe-test-script pattern may be declared on the gate path',
  );
});

// AP-EXT-ITER15-01 — the anchor above must stay executable AS WRITTEN. The
// catalog entry tells a replaying reviewer to grep for the unsafe-runner tokens
// outside convergence-gate.ts; spawn-morty's own JSDoc names them in prose, so a
// bare grep counts ITSELF and reports a guard that is fully intact as deleted.
test('AP-EXT-ITER15-01: the ONE-classifier anchor is comment-scoped, not self-matching', () => {
  const raw = fs.readFileSync(new URL('../src/bin/spawn-morty.ts', import.meta.url), 'utf8');

  // The self-match is real — this is WHY the anchor must say "non-comment lines".
  assert.equal(
    /playwright|cypress|hardhat/.test(raw), true,
    'precondition: spawn-morty names the tokens in prose, so a bare grep self-matches',
  );
  assert.equal(
    /playwright|cypress|hardhat/.test(codeText(parseSource(raw, 'spawn-morty.ts'))), false,
    'the real invariant: no unsafe-runner pattern is DECLARED outside convergence-gate.ts',
  );

  // Therefore the catalog anchor must carry the comment-stripping caveat, or the
  // next replay burns a fix budget re-deriving intact code from a phantom hit.
  const catalog = fs.readFileSync(new URL('../src/services/CLAUDE.md', import.meta.url), 'utf8');
  const entry = catalog.split('\n').find((line) => line.includes('AP-EXT-ITER14-01'));
  assert.ok(entry, 'the AP-EXT-ITER14-01 catalog entry must exist');
  assert.match(
    entry, /NON-comment lines/,
    'the anchor must scope its count to non-comment lines — a bare grep returns 1, not 0',
  );
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2c — the Done-flip policy split. This is what keeps an honest red
// from fail-closing the guard and halting the pipeline.
// ---------------------------------------------------------------------------

test('isAdvisoryWorkerGateVerdict: a TARGET-repo red is advisory, pickle-rick red stays fail-closed', () => {
  const offRepo = makeTmp();                                   // no extension/
  const selfRepo = makeTmp();
  fs.mkdirSync(path.join(selfRepo, 'extension'));              // pickle-rick shape

  assert.equal(
    isAdvisoryWorkerGateVerdict('red', offRepo), true,
    'a red authored by a target repo flags and continues',
  );
  assert.equal(
    isAdvisoryWorkerGateVerdict('red', selfRepo), false,
    'pickle-rick own red MUST stay fail-closed — this is the R-CWGE protection',
  );

  // not_run stays advisory everywhere (ticket 10's contract).
  assert.equal(isAdvisoryWorkerGateVerdict('not_run', offRepo), true);
  assert.equal(isAdvisoryWorkerGateVerdict('not_run', selfRepo), true);

  // `absent` is "the gate never reported" — fail-closed everywhere, off-repo included.
  assert.equal(
    isAdvisoryWorkerGateVerdict('absent', offRepo), false,
    'absent is not the same fact as a gate that ran and failed',
  );
  assert.equal(isAdvisoryWorkerGateVerdict('green', offRepo), false);
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2 / repo-agnostic invariant — no new package-manager matrix.
// ---------------------------------------------------------------------------

// Read the gate-path sources with the LANGUAGE's own parser. Both halves of
// the one-home invariant below are grammar, and both were hand-rolled lexical
// guesses that measured wrong in BOTH directions (see the test's own comments).
// `ts` draws the code/prose line by construction, so no comment stripper —
// itself an enumeration of lexical contexts — is needed or wanted.
//
// NOTE: a second copy of the readers in tests/tsc-gate.test.js. Hoisting them
// into a shared test helper is the right home; see AP-EXT-ITER174-01.
const parseSource = (source, fileName) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

// One `{ imported, local }` per binding of `specifier`, across every import
// statement naming it. Splitting one import into two, reflowing it, indenting
// it, aliasing it and quote style are all legal refactors that must not red a
// pin about WHERE a name comes from.
function namedImportsOf(sourceFile, specifier) {
  const bindings = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
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

// True only for a real call of `local` as an identifier callee. A mention of
// `local(` in a comment, string or template literal is not a call site.
// RESIDUE, stated rather than claimed away: a call reached through a namespace
// import (`gate.loadGateCommands()`) has a property-access callee and reads
// false here. `namedImportsOf` above would not have bound the local either, so
// the pair fails CLOSED on that form — a false RED, never a false green.
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

// The source with its comments removed — exactly, by the parser, rather than by
// a regex that approximates it. Every leaf token's text in source order, so a
// name spelled across a concatenation or inside a template still reads as one
// run of code text, and prose reads as nothing.
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

test('no per-stack adapter matrix: the gate path declares no package-manager name list', () => {
  const gatePath = [
    ['spawn-morty.ts', fs.readFileSync(new URL('../src/bin/spawn-morty.ts', import.meta.url), 'utf8')],
    ['mux-runner.ts', fs.readFileSync(new URL('../src/bin/mux-runner.ts', import.meta.url), 'utf8')],
  ].map(([name, source]) => ({ name, source, ast: parseSource(source, name) }));
  const sources = gatePath.map((file) => file.source).join('\n');

  // A literal array/set enumerating package managers is the adapter matrix this
  // invariant forbids: `detectProjectType`'s return type and the shared
  // `gate-commands.json` map are the only sanctioned enumerations.
  const managerListLiteral = /\[\s*(['"])(?:pnpm|npm|yarn|bun|cargo|go)\1\s*,\s*(['"])(?:pnpm|npm|yarn|bun|cargo|go)\2/;
  assert.equal(
    managerListLiteral.test(sources), false,
    'no literal package-manager list may be introduced on the gate path',
  );

  // The command map must be CONSUMED through the ONE loader that owns it — the
  // binding must come from the gate service AND be called. Asserting only the
  // import statement is not the invariant: an import kept for show while a
  // private fork takes over the call sites reads clean to it. MEASURED before
  // this collapse: a `loadGateCommandsPrivately()` re-deriving the map's path
  // from a variable-held filename, with the shared import left in place, was
  // GREEN 12/12 — the exact second reader the assertion below forbids.
  const [spawnMorty] = gatePath;
  const loader = namedImportsOf(spawnMorty.ast, '../services/convergence-gate.js')
    .find((binding) => binding.imported === 'loadGateCommands');
  assert.ok(
    loader,
    'the off-repo gate must bind loadGateCommands from the shared gate service',
  );
  assert.ok(
    callsIdentifier(spawnMorty.ast, loader.local),
    'the off-repo gate must CALL the shared loader, not just import it',
  );

  // A second reader re-derives the module-relative path by hand, so the two
  // silently disagree the moment either file changes depth. Do NOT assert this
  // by grepping the raw source: both files name `gate-commands.json` in PROSE,
  // so a bare grep counts the comment (the AP-EXT-ITER15-01 self-matching-anchor
  // mode). Do not grep one `readFileSync(...)` spelling either — that names ONE
  // way to spell a read, and a filename held in a const walks past it. Spelling
  // the map's name in CODE AT ALL is the re-derivation.
  for (const file of gatePath) {
    assert.equal(
      codeText(file.ast).includes('gate-commands'), false,
      `${file.name} must not re-derive the command map's path — read it through loadGateCommands`,
    );
  }
});

test('AP-EXT-ITER173-02 the gate-path source readers are comment-blind and refactor-tolerant', () => {
  // The regression this holds: the import half was `assert.match(source,
  // /import \{[^}]*loadGateCommands[^}]*\} from '...'/)`, which demanded single
  // quotes on a single line — changing ONLY the quote style on
  // spawn-morty.ts:48, a refactor altering nothing the pin asserts, measured
  // 11 pass / 1 fail. Pin the readers themselves so they cannot re-fork a
  // lexical guess.
  const importForms = [
    ['indented', "  import { loadGateCommands } from '../services/convergence-gate.js';"],
    ['double-quoted', 'import { loadGateCommands } from "../services/convergence-gate.js";'],
    ['reflowed', "import {\n  loadGateCommands,\n} from '../services/convergence-gate.js';"],
    ['no semicolon', "import { loadGateCommands } from '../services/convergence-gate.js'"],
    ['beside other bindings', "import { detectProjectType, loadGateCommands } from '../services/convergence-gate.js';"],
  ];
  for (const [label, form] of importForms) {
    assert.deepEqual(
      namedImportsOf(parseSource(form, 'f.ts'), '../services/convergence-gate.js')
        .map((binding) => binding.imported)
        .filter((imported) => imported === 'loadGateCommands'),
      ['loadGateCommands'],
      `a ${label} import must still bind loadGateCommands`,
    );
  }
  assert.deepEqual(
    namedImportsOf(
      parseSource("import { loadGateCommands as load } from '../services/convergence-gate.js';", 'f.ts'),
      '../services/convergence-gate.js',
    ),
    [{ imported: 'loadGateCommands', local: 'load' }],
    'an alias must report the imported name and the local separately',
  );
  assert.deepEqual(
    namedImportsOf(parseSource("import { loadGateCommands } from './other.js';", 'f.ts'), '../services/convergence-gate.js'),
    [],
    'a different specifier must bind nothing',
  );

  // The call-site half: prose naming the call form is not a call.
  const forged = (body) => parseSource(`import { load } from './m.js';\n${body}\n`, 'f.ts');
  const notCalls = [
    ['line comment', '// load() reads the shared map'],
    ['block comment', '/* load() reads the shared map */'],
    ['jsdoc', '/** the map is read by `load()`. */'],
    ['string literal', "const s = 'load()';"],
    ['template literal', 'const s = `load()`;'],
    ['bare reference, never invoked', 'export const f = [load];'],
  ];
  for (const [label, body] of notCalls) {
    assert.equal(callsIdentifier(forged(body), 'load'), false,
      `a ${label} must not answer the call-site check`);
  }
  assert.equal(callsIdentifier(forged('export const y = load();'), 'load'), true,
    'a real call must still satisfy the call-site check');

  // The path-spelling half: prose is not a re-derivation, and every way of
  // spelling the name in code is. The variable-held and concatenated forms are
  // what the `readFileSync(...gate-commands.json)` grep walked past.
  const spells = (body) => codeText(parseSource(body, 'f.ts')).includes('gate-commands');
  const prose = [
    ['line comment', '// gate-commands.json is the table\nexport const x = 1;'],
    ['block comment', '/* gate-commands.json is the table */\nexport const x = 1;'],
    ['jsdoc', '/** reads `data/gate-commands.json`. */\nexport const x = 1;'],
  ];
  for (const [label, body] of prose) {
    assert.equal(spells(body), false, `a ${label} must not read as a re-derivation`);
  }
  const code = [
    ['inline read', "export const p = readFileSync('gate-commands.json');"],
    ['variable-held filename', "const F = 'gate-commands.json';\nexport const p = readFileSync(join(d, F));"],
    ['concatenated', "export const F = 'gate-commands' + '.json';"],
    ['template with substitution', 'export const p = `${d}/gate-commands.json`;'],
    ['template without substitution', 'export const p = `data/gate-commands.json`;'],
  ];
  for (const [label, body] of code) {
    assert.equal(spells(body), true, `a ${label} must read as a re-derivation`);
  }
});

test('AP-EXT-ITER174-02 the ONE-classifier pin reads a fork as uncalled and a comment as prose', () => {
  // The two mutants this holds, both MEASURED against the pin as it stood.
  //
  // FALSE GREEN — a real second copy of the classifier, its unsafe-leaf list
  // diverged (missing the browser and chain runners) so the gate would spawn a
  // leaf the convergence gate refuses, with the shared call form left in a
  // comment: 13 pass / 0 fail. The old positive half grepped
  // `classifyTestScriptSafety(project.projectType, project.dir)` in the raw
  // source, and prose answered it.
  const forkedSource = [
    "import { classifyTestScriptSafety } from '../services/convergence-gate.js';",
    'const LOCAL_UNSAFE_LEAF_RE = /integration|e2e|golden|smoke|baseline/i;',
    '// Was: await classifyTestScriptSafety(project.projectType, project.dir);',
    'export const runnable = (script) => !LOCAL_UNSAFE_LEAF_RE.test(script);',
  ].join('\n');
  const forked = parseSource(forkedSource, 'spawn-morty.ts');
  assert.deepEqual(
    namedImportsOf(forked, '../services/convergence-gate.js').map((b) => b.imported),
    ['classifyTestScriptSafety'],
    'precondition: the fork keeps the shared import, so the binding half still passes',
  );
  assert.match(
    forkedSource, /classifyTestScriptSafety\(project\.projectType, project\.dir\)/,
    'precondition: the raw-source call-form grep the pin used is satisfied by the comment',
  );
  assert.equal(
    callsIdentifier(forked, 'classifyTestScriptSafety'), false,
    'a fork that only NAMES the call form in prose must read as uncalled',
  );

  // FALSE RED — a trailing comment naming a runner. The `^\s*//` stripper both
  // halves shared removed only WHOLE-LINE comments, so this measured 11 pass /
  // 2 fail: a comment reddened the invariant and the anchor test whose entire
  // subject is that comments must not answer it.
  const trailing = 'export const s = await classifyTestScriptSafety(t, d); // e.g. a playwright leaf';
  assert.match(trailing, /playwright/, 'precondition: the token is present in the raw source');
  assert.equal(
    /playwright|cypress|hardhat/.test(codeText(parseSource(trailing, 'spawn-morty.ts'))), false,
    'a TRAILING comment naming a runner is prose, not a declared pattern',
  );
  assert.equal(
    /playwright|cypress|hardhat/.test(codeText(parseSource(
      'const UNSAFE = /playwright|cypress/i;', 'spawn-morty.ts',
    ))), true,
    'a declared unsafe-runner pattern must still read as a second copy',
  );
});
