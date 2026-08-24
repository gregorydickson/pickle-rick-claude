// @tier: fast
// Regression guard for anatomy-park finding
// `extension-trapdoor-afcc-deep-pattern-shape-drift`.
//
// R-AFCC-DEEP-4A migrated mux-runner.ts off `hasCompletionCommit` /
// `autoFillCompletionCommit` onto `readEvidence` / `persistEvidence` (B-DURA T70
// then deleted the `hasCompletionCommit` shim entirely and collapsed EvidenceKind
// to `committed | absent`), but the
// R-WUWC SOFT-variant and R-CCRC-2 trap-door entries in extension/CLAUDE.md kept
// pointing their PATTERN_SHAPE replay anchors at the deleted `autoFillCompletionCommit(`
// symbol. A replay anchor that names a symbol absent from the file can never match,
// so the trap door's second line of defense silently dies. This test pins the two
// trap-door entries to the symbols that actually implement the invariant in the
// source — it fails if either the prose drifts back to the stale symbol OR the
// source loses the real auto-promotion wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const claudeMdPath = path.join(repoRoot, 'extension', 'CLAUDE.md');
const servicesClaudeMdPath = path.join(repoRoot, 'extension', 'src', 'services', 'CLAUDE.md');
const muxRunnerPath = path.join(repoRoot, 'extension', 'src', 'bin', 'mux-runner.ts');

const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
const servicesClaudeMd = fs.readFileSync(servicesClaudeMdPath, 'utf8');
const muxRunner = fs.readFileSync(muxRunnerPath, 'utf8');

/** Pull a single trap-door bullet (one `- ...` line) by a unique substring. */
function trapDoorEntry(needle, source = claudeMd, label = 'extension/CLAUDE.md') {
  const line = source
    .split('\n')
    .find((l) => l.trimStart().startsWith('- ') && l.includes(needle));
  assert.ok(line, `trap-door entry containing "${needle}" not found in ${label}`);
  return line;
}

test('R-WUWC SOFT-variant trap door names the live persistEvidence anchor, not the migrated-away autoFillCompletionCommit', () => {
  const entry = trapDoorEntry('R-WUWC SOFT-variant auto-promote');
  assert.ok(
    !entry.includes('autoFillCompletionCommit'),
    'R-WUWC trap door still references the R-AFCC-DEEP-4A-removed autoFillCompletionCommit symbol',
  );
  assert.ok(
    entry.includes('persistEvidence('),
    'R-WUWC trap door must reference the current persistEvidence( auto-promotion call',
  );
  assert.ok(
    entry.includes("committed"),
    'R-WUWC trap door must reference the current committed evidence kind (B-DURA T70 collapse)',
  );
});

test('R-CCRC-2 trap door names the inline upsertFrontmatterField anchor, not autoFillCompletionCommit', () => {
  const entry = trapDoorEntry('R-CCRC-2 done-flip guard routing');
  assert.ok(
    !entry.includes('autoFillCompletionCommit'),
    'R-CCRC-2 trap door still references the R-AFCC-DEEP-4A-removed autoFillCompletionCommit symbol',
  );
  assert.ok(
    entry.includes('upsertFrontmatterField('),
    'R-CCRC-2 trap door must reference the inline upsertFrontmatterField( completion_commit persist',
  );
});

test('R-CCQF trap door names the live readEvidence anchor, not the deprecated hasCompletionCommit shim', () => {
  const entry = trapDoorEntry('R-CCQF quoted-form completion_commit parser');
  assert.ok(
    entry.includes('ticket-completion-evidence.ts'),
    'R-CCQF trap door must anchor to ticket-completion-evidence.ts (readEvidence), not the deprecated pickle-utils hasCompletionCommit shim',
  );
  assert.ok(
    !entry.includes('inside `hasCompletionCommit`'),
    'R-CCQF PATTERN_SHAPE still anchors its replay marker inside the deprecated hasCompletionCommit shim',
  );
});

test('R-CCRC-1 trap door is marked RETIRED and no longer claims a live r_code fallback', () => {
  const entry = trapDoorEntry('R-CCRC-1');
  assert.ok(
    entry.includes('RETIRED'),
    'R-CCRC-1 trap door must be marked RETIRED — the r_code/ref-token fallback it pinned was deleted by B-GITATTR WS-3',
  );
  assert.ok(
    !entry.includes("readFrontmatterField(content, 'r_code')"),
    'R-CCRC-1 trap door must not claim readEvidence still reads r_code — that fallback is gone',
  );
});

test('R-RIC-EXPLICIT trap door names the live readEvidence anchor in ticket-completion-evidence.ts, not the deprecated pickle-utils hasCompletionCommit shim', () => {
  // R-RIC-EXPLICIT lives in src/services/CLAUDE.md, not the top-level extension/CLAUDE.md.
  const entry = trapDoorEntry(
    'R-RIC-EXPLICIT',
    servicesClaudeMd,
    'extension/src/services/CLAUDE.md',
  );
  assert.ok(
    entry.includes('ticket-completion-evidence.ts'),
    'R-RIC-EXPLICIT trap door must anchor to ticket-completion-evidence.ts (readEvidence), not the deprecated pickle-utils hasCompletionCommit shim',
  );
  assert.ok(
    entry.includes('readEvidence'),
    'R-RIC-EXPLICIT trap door must reference readEvidence (the live explicit-source home)',
  );
  assert.ok(
    !/`hasCompletionCommit` MUST honor/.test(entry),
    'R-RIC-EXPLICIT INVARIANT still anchors explicit-source honoring to the deprecated hasCompletionCommit shim',
  );
  assert.ok(
    !/PATTERN_SHAPE: `readFrontmatterField` call against/.test(entry),
    'R-RIC-EXPLICIT PATTERN_SHAPE still uses the pre-migration grep-on-message-body anchor',
  );
});

test('ticket-completion-evidence.ts implements the R-CCQF/R-RIC-EXPLICIT invariants the trap doors point at (post R-AFCC-DEEP-4A)', () => {
  const evidenceSrc = fs.readFileSync(
    path.join(repoRoot, 'extension', 'src', 'services', 'ticket-completion-evidence.ts'),
    'utf8',
  );
  for (const symbol of [
    "normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit')",
    "normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit_inferred')",
    'export function readEvidence',
  ]) {
    assert.ok(
      evidenceSrc.includes(symbol),
      `ticket-completion-evidence.ts missing R-CCQF anchor: ${symbol}`,
    );
  }
  // B-GITATTR WS-3: the r_code ref-token scan fallback (R-CCRC-1) is deleted — readEvidence's
  // scan is trailer-only now. `readFrontmatterField(content, 'r_code')` legitimately
  // SURVIVES inside isForeignAttributedExplicitSha's own-attribution check (R-OMA/R-PDUP),
  // so the extractRCodeTokens symbol is the precise anchor for the deleted scan fallback.
  assert.ok(
    !evidenceSrc.includes('extractRCodeTokens'),
    'R-CCRC-1 extractRCodeTokens ref-token helper must stay deleted (B-GITATTR WS-3)',
  );
  // R-RIC-EXPLICIT: the explicit completion_commit field MUST be honored before
  // the git-log scan. Pin the source ordering so the explicit branch can never
  // silently regress below scanGitLog (which would re-open the MASTER_PLAN #83 fatal).
  const explicitIdx = evidenceSrc.indexOf(
    "normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit')",
  );
  const scanIdx = evidenceSrc.indexOf('scanGitLog({');
  assert.ok(explicitIdx !== -1 && scanIdx !== -1, 'readEvidence missing explicit-source or scanGitLog anchors');
  assert.ok(
    explicitIdx < scanIdx,
    'R-RIC-EXPLICIT: explicit completion_commit read must precede scanGitLog in readEvidence',
  );
  // B-DURA T70 deleted the deprecated hasCompletionCommit shim — pickle-utils.ts
  // must NOT re-grow it (the single oracle is readEvidence).
  const pickleUtils = fs.readFileSync(
    path.join(repoRoot, 'extension', 'src', 'services', 'pickle-utils.ts'),
    'utf8',
  );
  assert.ok(
    !/export function hasCompletionCommit\b/.test(pickleUtils),
    'hasCompletionCommit shim must stay deleted (B-DURA T70); readEvidence is the sole oracle',
  );
});

test('mux-runner.ts implements completion-evidence auto-promotion via persistEvidence/upsertFrontmatterField (post R-AFCC-DEEP-4A)', () => {
  // The migrated-away symbol must be gone from THIS file (it legitimately still
  // lives in spawn-morty.ts / auto-fill-completion-commit.ts).
  assert.ok(
    !muxRunner.includes('autoFillCompletionCommit'),
    'mux-runner.ts unexpectedly references autoFillCompletionCommit — trap doors assume it was migrated out',
  );
  // The live anchors the trap-door PATTERN_SHAPEs now point at must be present.
  for (const symbol of [
    'persistEvidence(',
    'upsertFrontmatterField(',
    'guardCompletionCommitBeforeDone',
    'clearStaleDoneWithoutCommitEvidence',
    'markTicketDone',
    "'committed'",
  ]) {
    assert.ok(
      muxRunner.includes(symbol),
      `mux-runner.ts missing trap-door PATTERN_SHAPE anchor: ${symbol}`,
    );
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER2-01: the same "an anchor that can never match" failure mode, one
// level up. The PATTERN_SHAPE arms above pin replay anchors against SOURCE
// symbols; this arm pins ENFORCE anchors against TEST-CASE names.
//
// `scripts/audit-trap-door-enforcement.sh` sweeps every catalog's ENFORCE refs
// and prints "N ENFORCE reference(s) verified", but until this bundle its regex
// stopped at `.test.js` — the `#anchor` was parsed and dropped, so a trap door
// could name a test case that never existed and the release gate still called it
// verified. Citadel's independent reader (`trap-door-coverage-audit.ts`) demands
// an EXACT full test-name literal, which no anchor in this repo is authored as,
// so it reported all 13 as orphans — noise that buries a genuine orphan.
//
// The catalogs author anchors three ways, so one uniform rule admits all three:
// slug both sides and require SEGMENT-BOUNDARY containment.
// ---------------------------------------------------------------------------

/**
 * Every subsystem catalog on disk, by the SAME two-root rule the release-gate
 * audit uses: `extension/src/*​/CLAUDE.md` for the compiled-source subsystems and
 * `<repoRoot>/*​/CLAUDE.md` for the ones anatomy-park reviews outside them (repo-root
 * `bin/`). Derived, never hand-listed — a hand list is what let `bin/CLAUDE.md` sit
 * outside both readers while the audit's own comment claimed it could not drift.
 */
function discoverCatalogsOnDisk() {
  const found = ['extension/CLAUDE.md'];
  for (const [rootRel, skipDir] of [['extension/src', null], ['', 'extension']]) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, rootRel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === skipDir) continue;
      const rel = path.posix.join(rootRel, entry.name, 'CLAUDE.md');
      if (fs.existsSync(path.join(repoRoot, rel)) && !found.includes(rel)) found.push(rel);
    }
  }
  return found;
}

const CATALOGS = discoverCatalogsOnDisk();

const AUDIT_PATH = path.join(repoRoot, 'extension/scripts/audit-trap-door-enforcement.sh');

/**
 * THE anchor rule, LOADED from the release-gate audit rather than mirrored here.
 *
 * A hand-copied twin is what this whole arm exists to prevent one level up: the audit
 * is the gate that blocks a release, and a second copy living in the test means the
 * audit's rule can be weakened while every assertion below keeps passing against the
 * copy. Same derive-don't-mirror move as `deriveGateBaselineFileKeys` in
 * tests/services/convergence-gate-baseline-schema-parity.test.js — there the
 * authoritative source is an interface body, here it is a function body.
 *
 * Extraction failure IS the "the audit lost its rule" assertion, so no separate
 * source-text pin for `function anchorResolves(` is needed.
 */
function readAuditAnchorRuleSource() {
  const audit = fs.readFileSync(AUDIT_PATH, 'utf8');
  const start = audit.indexOf('const slugify =');
  const fnStart = audit.indexOf('function anchorResolves(', start);
  const end = fnStart === -1 ? -1 : audit.indexOf('\n}', fnStart);
  assert.ok(
    start !== -1 && fnStart !== -1 && end !== -1,
    `audit-trap-door-enforcement.sh lost the anchorResolves rule ` +
      `(slugify@${start}, anchorResolves@${fnStart}, close@${end}) — the release gate's ` +
      `anchor verification is gone and every assertion below would have been checking a local twin`,
  );
  return audit.slice(start, end + 2);
}

function compileAnchorRule(source) {
  return new Function(`${source}\nreturn anchorResolves;`)();
}

const anchorResolves = compileAnchorRule(readAuditAnchorRuleSource());

/** Every `(?:extension/)?tests/….test.js#anchor` ref across all six catalogs. */
function collectAnchoredEnforceRefs() {
  const refs = [];
  for (const catalog of CATALOGS) {
    const catalogPath = path.join(repoRoot, catalog);
    if (!fs.existsSync(catalogPath)) continue;
    const text = fs.readFileSync(catalogPath, 'utf8');
    // A discovered catalog need not have a trap-door section at all (`prds/CLAUDE.md`
    // is prose). `slice(-1)` on a miss would scan its last character instead.
    const sectionStart = text.indexOf('## Trap Doors');
    if (sectionStart === -1) continue;
    const section = text.slice(sectionStart);
    const re = /\b((?:extension\/)?tests\/[A-Za-z0-9_./-]+\.test\.js)\b#([A-Za-z0-9_.:-]+)/g;
    for (const m of section.matchAll(re)) {
      const rel = m[1].startsWith('extension/') ? m[1] : `extension/${m[1]}`;
      refs.push({ catalog, rel, anchor: m[2] });
    }
  }
  return refs;
}

test('AP-EXT-ITER2-01: every anchored ENFORCE ref resolves to a real test case', () => {
  const refs = collectAnchoredEnforceRefs();
  assert.ok(
    refs.length > 0,
    'no anchored ENFORCE refs found — the extraction regex drifted from the catalogs',
  );

  const unresolved = [];
  for (const ref of refs) {
    const absPath = path.join(repoRoot, ref.rel);
    if (!fs.existsSync(absPath)) {
      unresolved.push(`${ref.catalog} -> ${ref.rel} (file missing)`);
      continue;
    }
    if (!anchorResolves(fs.readFileSync(absPath, 'utf8'), ref.anchor)) {
      unresolved.push(`${ref.catalog} -> ${ref.rel}#${ref.anchor}`);
    }
  }

  assert.deepEqual(
    unresolved,
    [],
    `ENFORCE anchors naming no test case (the trap door's enforcement is dead):\n  ${unresolved.join('\n  ')}`,
  );
});

test('AP-EXT-ITER2-01: the anchor rule rejects a phantom and honors segment boundaries', () => {
  // Negative controls — without these the arm above is satisfied by any rule that
  // always returns true, which is exactly the fake-green it exists to prevent.
  const refinement = fs.readFileSync(
    path.join(repoRoot, 'extension/tests/spawn-refinement-team-checker.test.js'),
    'utf8',
  );

  assert.equal(anchorResolves(refinement, 'AP-RMS-12'), true, 'a real anchor must resolve');
  assert.equal(
    anchorResolves(refinement, 'zzz-no-such-anchor'),
    false,
    'a phantom anchor must NOT resolve',
  );
  // Segment boundary: `AP-RMS-1` is a prefix of the real `AP-RMS-12` but names no
  // test case of its own, so a bare substring rule would green over a phantom.
  assert.equal(
    anchorResolves(refinement, 'AP-RMS-1'),
    false,
    'a prefix of a real anchor must NOT resolve — the rule is segment-boundary, not substring',
  );
});

test('AP-EXT-ITER2-01: the release-gate audit verifies anchors, not just files', () => {
  // The rule above is a second reader; the GATE is the shell audit. If the audit
  // loses the anchor arm, the mirrored rule here keeps passing while the gate that
  // actually blocks a release goes blind again.
  const audit = fs.readFileSync(AUDIT_PATH, 'utf8');
  assert.match(
    audit,
    /anchor #\$\{anchor\} matches no test case in/,
    'audit-trap-door-enforcement.sh lost its ENFORCE-anchor verification arm',
  );
});

test('AP-EXT-ITER2-01: weakening the AUDIT rule reaches this test — the rule is loaded, not mirrored', () => {
  // Mutation control for the loader above. The historic weakening is dropping the
  // `-…-` segment wrapping, collapsing the rule to bare substring containment. Against a
  // hand-copied twin that mutation was invisible here: the audit greened a phantom while
  // these assertions kept passing on the local copy. This arm proves the mutation now lands.
  const shipped = readAuditAnchorRuleSource();
  const weakened = shipped.replace(/`-\$\{(slugify\([^)]*\))\}-`/g, '$1');
  assert.notEqual(
    weakened,
    shipped,
    'mutation precondition: the segment-boundary wrapping was not found in the audit rule',
  );

  const refinement = fs.readFileSync(
    path.join(repoRoot, 'extension/tests/spawn-refinement-team-checker.test.js'),
    'utf8',
  );
  assert.equal(
    compileAnchorRule(weakened)(refinement, 'AP-RMS-1'),
    true,
    'mutation precondition: the weakened rule must green the phantom prefix',
  );
  assert.equal(
    anchorResolves(refinement, 'AP-RMS-1'),
    false,
    'the SHIPPED audit rule must still reject the phantom prefix',
  );
});

// ---------------------------------------------------------------------------
// AP-BIN-ITER15-01. `discoverCatalogs` walked `extension/src/*​/` only, so repo-root
// `bin/CLAUDE.md` — the catalog anatomy-park writes for the ONE subsystem it reviews
// outside `extension/src/` (`discoverSubsystems` enumerates repo-root `bin/`, per the
// R-APBS-1..3 trap door) — was invisible to the release gate. Its 8 ENFORCE refs were
// never checked for a missing file, a bad `@tier`, or a phantom anchor, while the gate
// printed "430 ENFORCE reference(s) verified" and exited 0. Deleting a spec together
// with the source it covers is the NORMAL shape here (980656c7 dropped
// `bin/section-c-still-needed.js` and `tests/section-c-gate.test.js` in one commit),
// and that is exactly what turns an unswept catalog's ENFORCE into a phantom.
//
// The pin is BEHAVIORAL — it runs the shipped audit and reads that audit's OWN
// per-catalog census. A source grep asserting the walk exists would stay green over a
// walk that is present but unreachable, which is the shape this repo keeps getting
// burned by. Counting is load-bearing too: a catalog admitted with zero collected refs
// is byte-indistinguishable from one the sweep skipped.
// ---------------------------------------------------------------------------
test('AP-BIN-ITER15-01: the release-gate sweep reads every subsystem catalog on disk, including repo-root bin/', () => {
  const catalogsWithRefs = discoverCatalogsOnDisk().filter((rel) =>
    fs.readFileSync(path.join(repoRoot, rel), 'utf8').includes('ENFORCE:'),
  );
  assert.ok(
    catalogsWithRefs.includes('bin/CLAUDE.md'),
    'discovery drifted: bin/CLAUDE.md carries ENFORCE refs but was not discovered — this test would pass vacuously',
  );

  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: path.join(repoRoot, 'extension'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `audit-trap-door-enforcement.sh failed:\n${result.stderr}`);

  const census = /ENFORCE reference\(s\) verified across \d+ catalog\(s\) \(([^)]*)\)/.exec(
    result.stdout,
  );
  assert.ok(census, `audit printed no per-catalog census:\n${result.stdout}`);

  const counted = new Map(
    census[1].split(', ').map((pair) => {
      const at = pair.lastIndexOf('=');
      return [pair.slice(0, at), Number(pair.slice(at + 1))];
    }),
  );

  const unswept = catalogsWithRefs.filter((rel) => !(counted.get(rel) > 0));
  assert.deepEqual(
    unswept,
    [],
    `catalogs carrying ENFORCE refs that the release gate collected nothing from `
      + `(their trap doors' enforcement is unverified):\n  ${unswept.join('\n  ')}\n`
      + `census: ${census[1]}`,
  );
});
