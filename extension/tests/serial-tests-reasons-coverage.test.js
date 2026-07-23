// @tier: integration
// AC-R-ITIH-4 — proves the .serial-tests.reasons.json sidecar stays 1:1 with the
// hand-maintained .serial-tests.json manifest and that every annotation is one of
// the five allowed root-cause classes. The sidecar is read by humans/operators
// only — neither runtime consumer (bin/test-runner.js:readManifestEntries nor the
// audit scripts) reads it — so this test is the sole drift guard.
//
// It also proves every manifest entry is EFFECTIVE. A manifest is only ever passed
// to the tier whose npm script names it, and test-runner selects files by their
// `@tier:` header before applying the manifest — so an entry declaring some other
// tier is silently ignored and keeps running at full concurrency. The governing
// tier is derived from package.json rather than hardcoded, so the check tracks the
// real wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.resolve(__dirname, 'integration', '.serial-tests.json');
const REASONS_PATH = path.resolve(__dirname, 'integration', '.serial-tests.reasons.json');

// manifest path (as written in package.json) -> the --tier it is passed alongside
function manifestGoverningTiers() {
  const pkg = readJson(path.join(EXTENSION_ROOT, 'package.json'));
  const governing = new Map();
  for (const command of Object.values(pkg.scripts ?? {})) {
    const manifest = /--manifest\s+(\S+)/.exec(command);
    const tier = /--tier\s+(\S+)/.exec(command);
    if (!manifest || !tier) continue;
    if (!governing.has(manifest[1])) governing.set(manifest[1], new Set());
    governing.get(manifest[1]).add(tier[1]);
  }
  return governing;
}

function declaredTier(relativePath) {
  const header = fs.readFileSync(path.join(EXTENSION_ROOT, relativePath), 'utf8').split('\n')[0];
  const match = /^\/\/\s*@tier:\s*(\S+)\s*$/.exec(header);
  return match ? match[1] : null;
}

const ALLOWED_CLASSES = new Set([
  'real-repo-isolation',
  'subprocess-timeout-coupling',
  'process-global-state',
  'subprocess-spawn-timing',
  'load-dependent-timeout',
]);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('sanity: .serial-tests.json parses and entries is a non-empty string[]', () => {
  const manifest = readJson(MANIFEST_PATH);
  assert.ok(manifest && typeof manifest === 'object', 'manifest is an object');
  assert.ok(Array.isArray(manifest.entries), 'entries is an array');
  assert.ok(manifest.entries.length > 0, 'entries is non-empty');
  for (const entry of manifest.entries) {
    assert.equal(typeof entry, 'string', `entry must be a string: ${JSON.stringify(entry)}`);
  }
});

test('every manifest entry has exactly one reasons key (no missing)', () => {
  const manifest = readJson(MANIFEST_PATH);
  const reasons = readJson(REASONS_PATH).reasons;
  assert.ok(reasons && typeof reasons === 'object', 'reasons is an object');
  for (const entry of manifest.entries) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(reasons, entry),
      `manifest entry missing a reasons annotation: ${entry}`,
    );
  }
});

test('every reasons key corresponds to an existing manifest entry (no orphan keys)', () => {
  const manifest = readJson(MANIFEST_PATH);
  const reasons = readJson(REASONS_PATH).reasons;
  const entrySet = new Set(manifest.entries);
  for (const key of Object.keys(reasons)) {
    assert.ok(entrySet.has(key), `orphan reasons key not in manifest: ${key}`);
  }
});

test('reasons is exactly 1:1 with manifest entries (counts equal)', () => {
  const manifest = readJson(MANIFEST_PATH);
  const reasons = readJson(REASONS_PATH).reasons;
  assert.equal(
    Object.keys(reasons).length,
    manifest.entries.length,
    'reasons key count must equal manifest entry count',
  );
});

test('every reason value is one of the five allowed class strings', () => {
  const reasons = readJson(REASONS_PATH).reasons;
  for (const [key, value] of Object.entries(reasons)) {
    assert.ok(
      ALLOWED_CLASSES.has(value),
      `reason for ${key} is not an allowed class: ${JSON.stringify(value)}`,
    );
  }
});

test('each serial manifest is passed to exactly one tier', () => {
  const governing = manifestGoverningTiers();
  assert.ok(governing.size > 0, 'no npm script pairs a --manifest with a --tier');
  for (const [manifest, tiers] of governing) {
    assert.equal(
      tiers.size,
      1,
      `${manifest} is passed to multiple tiers (${[...tiers].join(', ')}); an entry cannot conform to all of them`,
    );
  }
});

// AC-ITIH-6 — tsc-gate.test.js starved the fast tier at --test-concurrency=8 (observed
// 2026-07-23: 3 of its 15 tests failed in one run). Two blew their own outer spawn budgets
// (6155ms > 6000ms, 15244ms > 15000ms) and one saw the handler's internal 5s `git` spawn
// time out, reporting `setup_error` where the test asserts `compile_error`.
//
// The R-TFP-C2 audit cannot catch this class here: it matches `spawnSync('bash'|'sh', …)`,
// while this file drives the handler through `spawnSync(process.execPath, …)`. Serialization
// is therefore the ONLY guard on it, which is what this test holds in place.
test('AC-ITIH-6: tsc-gate.test.js is serialized (the R-TFP-C2 audit cannot see its spawn shape)', () => {
  const entry = 'tests/tsc-gate.test.js';
  const source = fs.readFileSync(path.join(EXTENSION_ROOT, entry), 'utf8');

  assert.match(
    source,
    /spawnSync\(\s*process\.execPath\s*,/,
    `${entry} must still drive the gate handler via spawnSync(process.execPath, …). If it now ` +
      `spawns bash/sh instead, audit-subprocess-heavy-tests.sh can see it and this pin should be revisited.`,
  );
  assert.doesNotMatch(
    source,
    /spawnSync\(\s*['"](?:bash|sh)['"]\s*,\s*\[\s*['"][^'"-]/,
    `${entry} gained a bash/sh script spawn — re-evaluate whether the R-TFP-C2 audit now covers it.`,
  );

  const manifest = readJson(MANIFEST_PATH);
  assert.ok(
    manifest.entries.includes(entry),
    `${entry} must stay in ${path.basename(MANIFEST_PATH)}; removing it puts a load-starved ` +
      `subprocess-heavy test back on the c=8 surface with no audit coverage to catch it.`,
  );
  assert.equal(readJson(REASONS_PATH).reasons[entry], 'subprocess-timeout-coupling');
});

test('every serial manifest entry declares the tier that governs its manifest', () => {
  for (const [manifest, tiers] of manifestGoverningTiers()) {
    const [governingTier] = [...tiers];
    for (const entry of readJson(path.join(EXTENSION_ROOT, manifest)).entries) {
      assert.equal(
        declaredTier(entry),
        governingTier,
        `${entry} is listed in ${manifest} but declares @tier: ${declaredTier(entry)}. ` +
          `Only @tier: ${governingTier} files are selected when that manifest is applied, so this ` +
          `entry never serializes — it still runs at full concurrency.`,
      );
    }
  }
});
