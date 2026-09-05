// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_ARTIFACT_SCHEMA,
  EXPECTED_BUNDLE_AC_IDS,
  verifyBundle,
} from '../../bin/verify-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'verify-bundle.js');
const REFINED_PRD = path.join(
  REPO_ROOT,
  'prds/archive/bundles/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md',
);
// AC-DR-05 is a LIVE row in the refined PRD that the contract deliberately does not demand:
// 59120b5d deleted its only checker as structurally unfalsifiable, and
// `bundle/section-c-still-needed.json` records Section C as `still_needed: false`, so no
// artifact can ever be produced. Demanding one would pin every full-bundle run at
// INCONCLUSIVE. The PRD row still lacks `status: removed`; until it is marked, this entry is
// what keeps that gap visible. Any OTHER live AC missing from the contract is a false-green
// and reddens `live-acs-still-demanded` below.
const UNDEMANDED_LIVE_AC_IDS = Object.freeze({
  'AC-DR-05': 'checker deleted as unfalsifiable (59120b5d); Section C still_needed:false',
});

// Parses the refined PRD's AC table, e.g.
// `| AC-DR-03 | **REMOVED** (see ...) | status: removed | n/a | ... |`
function acRowsFromRefinedPrd() {
  const prd = readFileSync(REFINED_PRD, 'utf8');
  const rows = [];
  for (const line of prd.split('\n')) {
    const match = /^\|\s*(AC-DR-[0-9a-z]+)\s*\|(.*)$/i.exec(line);
    if (match) rows.push({ acId: match[1], removed: /status:\s*removed/i.test(match[2]) });
  }
  return rows;
}

function removedAcIdsFromRefinedPrd() {
  return acRowsFromRefinedPrd()
    .filter((row) => row.removed)
    .map((row) => row.acId);
}

function liveAcIdsFromRefinedPrd() {
  return acRowsFromRefinedPrd()
    .filter((row) => !row.removed)
    .map((row) => row.acId);
}
function acFileName(acId) {
  return `${acId.toLowerCase()}.json`;
}

function artifact(acId, overrides = {}) {
  return {
    ac_id: acId,
    pass: true,
    checked_at: '2026-05-02T00:00:00.000Z',
    checker: 'verify-bundle.test',
    checker_version: 'test',
    evidence: {},
    failure_reason: null,
    remediation_hint: null,
    ...overrides,
  };
}

function makeFixture(mutator = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-bundle-'));
  const bundleDir = path.join(dir, 'bundle');
  mkdirSync(bundleDir, { recursive: true });
  for (const acId of EXPECTED_BUNDLE_AC_IDS) {
    writeFileSync(
      path.join(bundleDir, acFileName(acId)),
      `${JSON.stringify(artifact(acId), null, 2)}\n`,
    );
  }
  mutator({ dir, bundleDir });
  return dir;
}

function runVerifier(repoRoot, args = [], cli = CLI) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, BUNDLE_REPO_ROOT: repoRoot },
  });
}

function assertBundleArtifactShape(value, acId) {
  assert.equal(value.ac_id, acId);
  assert.equal(typeof value.pass, 'boolean');
  assert.match(value.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$/);
  assert.equal(typeof value.checker, 'string');
  assert.equal(typeof value.checker_version, 'string');
  assert.equal(value.evidence && typeof value.evidence, 'object');
  assert.equal(Array.isArray(value.evidence), false);
  assert.equal(value.failure_reason === null || typeof value.failure_reason === 'string', true);
  assert.equal(value.remediation_hint === null || typeof value.remediation_hint === 'string', true);
}

test('verify-bundle.ac-mapping covers every refined deploy-reversion AC exactly once', () => {
  const live = liveAcIdsFromRefinedPrd();
  // Guards the parser: a PRD table-shape change must not silently empty these sets.
  assert.ok(live.length >= 15, `refined PRD AC table parsed only ${live.length} live rows`);

  // No phantom: nothing is demanded that the PRD does not declare live.
  for (const acId of EXPECTED_BUNDLE_AC_IDS) {
    assert.ok(
      live.includes(acId),
      `${acId} is demanded by EXPECTED_BUNDLE_AC_IDS but is not a live AC row in the refined PRD`,
    );
  }
  assert.equal(new Set(EXPECTED_BUNDLE_AC_IDS).size, EXPECTED_BUNDLE_AC_IDS.length);
});

test('verify-bundle.removed-acs-are-not-demanded by the bundle contract', () => {
  const removed = removedAcIdsFromRefinedPrd();
  // Guards the test itself: if the PRD table shape changes, this must not silently pass.
  assert.deepEqual(removed, ['AC-DR-03', 'AC-DR-07', 'AC-DR-15']);

  // A stripped AC has artifact `n/a` in the PRD, so no artifact can ever exist for it.
  // Demanding one pins the full-bundle run at INCONCLUSIVE forever.
  for (const acId of removed) {
    assert.equal(
      EXPECTED_BUNDLE_AC_IDS.includes(acId),
      false,
      `${acId} is status:removed in the refined PRD but is still demanded by EXPECTED_BUNDLE_AC_IDS`,
    );
    // AC-DR-15's artifact slot was `ac-dr-pre-flight.json`; the alias must not smuggle it back.
    const result = verifyBundle({ repoRoot: REPO_ROOT, ac: acId });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, new RegExp(`unknown AC id ${acId}`));
  }
  assert.equal(EXPECTED_BUNDLE_AC_IDS.includes('AC-DR-PRE-FLIGHT'), false);
});

test('verify-bundle.live-acs-still-demanded so unwritten evidence cannot false-green', () => {
  // Derived from the PRD, not sampled from a hardcoded list: an AC that is never demanded can
  // never report missing, so dropping a live one manufactures a PASS. Sampling four ids is why
  // AC-DR-05 was dropped unnoticed — it was not in the sample.
  const dropped = liveAcIdsFromRefinedPrd().filter((acId) => !EXPECTED_BUNDLE_AC_IDS.includes(acId));
  assert.deepEqual(
    [...dropped].sort(),
    Object.keys(UNDEMANDED_LIVE_AC_IDS).sort(),
    'a live PRD AC is not demanded by EXPECTED_BUNDLE_AC_IDS and has no recorded justification',
  );
  for (const [acId, justification] of Object.entries(UNDEMANDED_LIVE_AC_IDS)) {
    assert.ok(justification.trim().length > 0, `${acId} is undemanded with an empty justification`);
  }

  const result = verifyBundle({ repoRoot: REPO_ROOT });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /AC-DR-16: missing bundle\/ac-dr-16\.json/);
  // ...but never for an AC the PRD stripped, nor for the one whose checker is gone.
  assert.equal(/ac-dr-(03|05|07|pre-flight)\.json/.test(result.stderr), false);
});

// bin/CLAUDE.md's canonical-bundle-schema clause enumerated the required fields by hand and
// omitted `pass` — the ONE field whose absence turns a receipt into a permanent verdict.
// It was false from the commit that authored it: `pass` has been in
// BUNDLE_ARTIFACT_SCHEMA.required since the validator's first commit, so a producer built to
// the clause was rejected for `missing required field: pass`, which is verbatim the BREAKS
// the clause claims to prevent. A trap door that causes its own failure mode is worse than a
// missing one: a reader trusts it.
//
// The list is not deleted — a reader wants it inline — it stops being a SECOND COPY. This
// derives one side from the shipped symbol and parses the other out of the catalog, so the
// two can only disagree for as long as this test is red. Parse failure IS the assertion: a
// clause that loses its shape reddens here rather than comparing an empty list.
test('verify-bundle.AP-BIN-ITER5-01 the canonical-schema clause is a checked projection of BUNDLE_ARTIFACT_SCHEMA.required', () => {
  const catalog = readFileSync(path.join(REPO_ROOT, 'bin', 'CLAUDE.md'), 'utf8');
  const clause = /MUST emit the canonical bundle schema \(([^)]*)\)/.exec(catalog);
  assert.ok(
    clause,
    'bin/CLAUDE.md lost the canonical-bundle-schema INVARIANT clause — the trap door that pins '
    + 'every bundle artifact producer to BUNDLE_ARTIFACT_SCHEMA.required is gone',
  );

  const listed = [...clause[1].matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]);
  // Anti-vacuity: an unparsed list would deepEqual-fail loudly, but an empty one against an
  // empty `required` would not. Floor the parsed unit, not the comparison.
  assert.ok(listed.length > 0, `the clause parsed no field names from: ${clause[1]}`);

  assert.deepEqual(
    listed,
    [...BUNDLE_ARTIFACT_SCHEMA.required],
    'bin/CLAUDE.md enumerates a different canonical bundle schema than verify-bundle enforces; '
    + 'a producer written to the catalog is rejected by validateBundleArtifact',
  );
});

test('verify-bundle.fixture-artifacts satisfy required metadata schema for every AC', () => {
  const fixture = makeFixture();
  try {
    for (const acId of EXPECTED_BUNDLE_AC_IDS) {
      const parsed = JSON.parse(readFileSync(path.join(fixture, 'bundle', acFileName(acId)), 'utf8'));
      assertBundleArtifactShape(parsed, acId);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.valid-pass exits 0 when all expected artifacts pass', () => {
  const fixture = makeFixture();
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
    assert.equal(BUNDLE_ARTIFACT_SCHEMA.required.includes('failure_reason'), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.all-or-pass exits 1 when any artifact has pass false', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-08.json'),
      `${JSON.stringify(artifact('AC-DR-08', {
        pass: false,
        failure_reason: 'test-failure',
        remediation_hint: 'fix test fixture',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AC-DR-08: pass false/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.missing-inconclusive exits 2 when an artifact is missing', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    rmSync(path.join(bundleDir, 'ac-dr-09.json'));
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /AC-DR-09: missing bundle\/ac-dr-09\.json/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.malformed-fail exits 1 and names missing field', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    const bad = artifact('AC-DR-10');
    delete bad.checker_version;
    writeFileSync(path.join(bundleDir, 'ac-dr-10.json'), `${JSON.stringify(bad, null, 2)}\n`);
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required field: checker_version/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.non-canonical-checked-at fails when artifact timestamp is not UTC ISO', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-11.json'),
      `${JSON.stringify(artifact('AC-DR-11', {
        checked_at: '2026-05-02T00:00:00-05:00',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checked_at must be a canonical UTC ISO date string/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.invalid-calendar-checked-at fails when timestamp rolls into a different UTC day', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-11.json'),
      `${JSON.stringify(artifact('AC-DR-11', {
        checked_at: '2026-02-31T00:00:00.000Z',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checked_at must be a canonical UTC ISO date string/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.single-ac validates only requested artifact', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    rmSync(path.join(bundleDir, 'ac-dr-09.json'));
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-08']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /checked=1/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.single-ac rejects a stripped AC even when an artifact file exists', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    // A stray artifact on disk must not resurrect a removed AC: the PRD contract is
    // authoritative, not the filesystem.
    writeFileSync(
      path.join(bundleDir, 'ac-dr-pre-flight.json'),
      `${JSON.stringify(artifact('AC-DR-PRE-FLIGHT'), null, 2)}\n`,
    );
  });
  try {
    for (const acId of ['AC-DR-15', 'AC-DR-PRE-FLIGHT', 'AC-DR-03', 'AC-DR-07']) {
      const result = runVerifier(fixture, ['--ac', acId]);
      assert.equal(result.status, 2, result.stdout);
      assert.match(result.stderr, new RegExp(`unknown AC id ${acId}`));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.single-ac rejects unknown AC ids instead of validating arbitrary bundle files', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-99.json'),
      `${JSON.stringify(artifact('AC-DR-99'), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-99']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown AC id AC-DR-99/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.recovers newer orphan tmp bundle artifacts before reporting missing files', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    const artifactPath = path.join(bundleDir, acFileName('AC-DR-01'));
    const payload = readFileSync(artifactPath, 'utf8');
    rmSync(artifactPath);
    writeFileSync(path.join(bundleDir, `${acFileName('AC-DR-01')}.tmp.999999.recovered`), payload);
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-01']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// The recovery above is scoped to "before treating an artifact as MISSING" — that phrase is
// the whole contract. Run it against a PRESENT artifact and the generic promotion renameSyncs
// the orphan OVER the tracked receipt, so the verifier both destroys committed evidence and
// reports the untracked tmp's `pass` as the AC verdict. A `pass:true` orphan is the same
// mechanism pointed the other way: a permanent false-green on the release-evidence gate.
// Mutation-verified: dropping the `artifactExists` guard makes this exit 1 with
// `GARBAGE FROM ORPHAN TMP` and leaves the base file overwritten.
test('verify-bundle.does not promote an orphan tmp over a present artifact', () => {
  let before;
  const fixture = makeFixture(({ bundleDir }) => {
    const artifactPath = path.join(bundleDir, acFileName('AC-DR-01'));
    before = readFileSync(artifactPath, 'utf8');
    writeFileSync(
      path.join(bundleDir, `${acFileName('AC-DR-01')}.tmp.999999`),
      `${JSON.stringify(artifact('AC-DR-01', {
        pass: false,
        failure_reason: 'GARBAGE FROM ORPHAN TMP',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-01']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
    assert.equal(
      readFileSync(path.join(fixture, 'bundle', acFileName('AC-DR-01')), 'utf8'),
      before,
      'the present artifact must survive the run byte-for-byte',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.repo-ac-dr-04d stays verifier-clean as a tracked artifact', () => {
  const result = runVerifier(REPO_ROOT, ['--ac', 'AC-DR-04d']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bundle PASS/);
});

// Node realpath-resolves `import.meta.url`, but `process.argv[1]` stays the literal path
// the caller typed. A CLI guard that compares the two exactly stops firing the moment the
// script is reached through a symlink (macOS `/tmp`, a symlinked worktree or home), so the
// gate exits 0 having printed nothing — a failing bundle reads as green.
test('verify-bundle.cli-entrypoint still fires when reached through a symlinked path', () => {
  const repoRoot = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, acFileName('AC-DR-04d')),
      `${JSON.stringify(artifact('AC-DR-04d', { pass: false, failure_reason: 'injected' }), null, 2)}\n`,
    );
  });
  const linkRoot = mkdtempSync(path.join(tmpdir(), 'verify-bundle-link-'));
  const linkedRepo = path.join(linkRoot, 'repo');
  symlinkSync(REPO_ROOT, linkedRepo);
  try {
    const linkedCli = path.join(linkedRepo, 'bin', 'verify-bundle.js');
    const result = runVerifier(repoRoot, ['--ac', 'AC-DR-04d'], linkedCli);
    assert.equal(
      result.status,
      1,
      `symlinked CLI must report the failure, got exit=${result.status} stdout=${JSON.stringify(result.stdout)}`,
    );
    assert.match(result.stdout, /bundle FAIL/);
    assert.match(result.stderr, /pass false \(injected\)/);
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Every rejection arm below is load-bearing: with the arm deleted, the malformed artifact
// paired with it reports `bundle PASS` / exit 0 instead of FAIL. Only `missing required field`
// and the `checked_at` arm carried fixtures, so the rest shipped unpinned — deleting one kept
// the suite green while the release-evidence gate silently stopped rejecting that class.
// `pass must be a boolean` and `ac_id must equal` are the two that forge a verdict: a
// `pass:'false'` artifact and an artifact copy-pasted from another AC both read green without
// them. The `artifact` argument is built per-case because several arms need a non-object.
const REJECTION_ARMS = Object.freeze([
  { arm: 'artifact must be an object', acId: 'AC-DR-01', payload: () => [] },
  { arm: 'ac_id must be a string', acId: 'AC-DR-01', payload: (acId) => artifact(acId, { ac_id: 7 }) },
  {
    arm: 'pass must be a boolean',
    acId: 'AC-DR-08',
    payload: (acId) => artifact(acId, { pass: 'false', failure_reason: 'boom' }),
  },
  { arm: 'checker must be a string', acId: 'AC-DR-09', payload: (acId) => artifact(acId, { checker: 42 }) },
  {
    arm: 'checker_version must be a string',
    acId: 'AC-DR-10',
    payload: (acId) => artifact(acId, { checker_version: 3 }),
  },
  { arm: 'evidence must be an object', acId: 'AC-DR-11', payload: (acId) => artifact(acId, { evidence: [] }) },
  {
    arm: 'failure_reason must be a string or null',
    acId: 'AC-DR-12',
    payload: (acId) => artifact(acId, { failure_reason: 42 }),
  },
  {
    arm: 'remediation_hint must be a string or null',
    acId: 'AC-DR-13',
    payload: (acId) => artifact(acId, { remediation_hint: {} }),
  },
  // Identity check in verifyBundle, not validateBundleArtifact: one AC's evidence copied into
  // another AC's slot. Without this arm the forged file satisfies the AC it was never checked for.
  { arm: 'ac_id must equal AC-DR-14', acId: 'AC-DR-14', payload: () => artifact('AC-DR-08') },
]);

test('verify-bundle.rejection-arms each reject their own malformed artifact', () => {
  for (const { arm, acId, payload } of REJECTION_ARMS) {
    const fixture = makeFixture(({ bundleDir }) => {
      writeFileSync(
        path.join(bundleDir, acFileName(acId)),
        `${JSON.stringify(payload(acId), null, 2)}\n`,
      );
    });
    try {
      const result = verifyBundle({ repoRoot: fixture, ac: acId });
      assert.equal(
        result.exitCode,
        1,
        `${arm}: expected exit 1, got ${result.exitCode} — ${result.stdout.trim()}`,
      );
      assert.ok(
        result.stderr.includes(arm),
        `${arm}: arm not named in stderr — ${result.stderr.trim()}`,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

// The in-process cases above prove each arm fires; this proves the arm that matters most
// survives all the way to the process exit code the release gate actually reads. `pass:'false'`
// is caught ONLY by the type arm — `artifact.pass === false` is strict, so a string never
// trips the pass-false branch.
test('verify-bundle.non-boolean pass cannot false-green the CLI gate', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, acFileName('AC-DR-08')),
      `${JSON.stringify(artifact('AC-DR-08', { pass: 'false', failure_reason: 'boom' }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1, `expected FAIL, got exit=${result.status} stdout=${result.stdout}`);
    assert.match(result.stdout, /bundle FAIL/);
    assert.match(result.stderr, /pass must be a boolean/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// Forward-protection: the arms above are a hand-written list, and a hand-written list is
// exactly what let eight arms ship unpinned. This derives the arm set from the verifier's own
// source, so a NEW rejection arm added without a fixture reddens here instead of shipping
// silently. It pins the message literal only — the behavioral cases above are the real guard.
function rejectionArmLiteralsFromSource() {
  const source = readFileSync(path.join(REPO_ROOT, 'bin', 'verify-bundle.js'), 'utf8');
  const literals = [];
  for (const re of [/errors\.push\(\s*(`[^`]*`|'[^']*')\s*\)/g, /return \[\s*(`[^`]*`|'[^']*')\s*\]/g]) {
    for (const match of source.matchAll(re)) {
      // Reduce `a ${x} b` to its longest static run so interpolated arms stay greppable.
      const longestStatic = match[1]
        .slice(1, -1)
        .split(/\$\{[^}]*\}/)
        .reduce((best, part) => (part.length > best.length ? part : best), '');
      if (longestStatic.trim().length > 0) literals.push(longestStatic);
    }
  }
  return literals;
}

test('verify-bundle.every rejection arm in the verifier source has a fixture here', () => {
  const literals = rejectionArmLiteralsFromSource();
  // Guards the extractor: a source-shape change must not silently empty the set.
  assert.ok(literals.length >= 10, `extracted only ${literals.length} rejection arms from the verifier`);

  const testSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const literal of literals) {
    assert.ok(
      testSource.includes(literal),
      `rejection arm ${JSON.stringify(literal)} has no fixture in this file — a deletion of that arm would keep the suite green while the gate stops rejecting that artifact class`,
    );
  }
});

test('verify-bundle.exported-api defaults to repo root instead of caller cwd', () => {
  const originalCwd = process.cwd();
  try {
    process.chdir(path.join(REPO_ROOT, 'extension'));
    const result = verifyBundle({ ac: 'AC-DR-04d' });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
  } finally {
    process.chdir(originalCwd);
  }
});
