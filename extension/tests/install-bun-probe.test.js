// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { simulateBinaryAbsent } from './helpers/simulate-binary-absent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.resolve(__dirname, '..', '..', 'install.sh');
const BANNER = 'Plumbus generative audit is running in degraded mode';

function getProbeLines() {
  const src = readFileSync(INSTALL_SH, 'utf8');
  return src
    .split('\n')
    .filter(l => l.includes('bun --version'))
    .join('\n');
}

describe('install.sh bun probe', () => {
  test('install.sh contains bun probe with correct banner text', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(src.includes(BANNER), `install.sh must contain banner: "${BANNER}"`);
    assert.ok(src.includes('bun --version'), 'install.sh must probe bun --version');
  });

  test('bun probe emits banner when bun is absent', () => {
    const probeLines = getProbeLines();
    const filteredPath = simulateBinaryAbsent(process.env.PATH || '', 'bun');

    const stdout = execSync(`bash -c ${JSON.stringify(probeLines)}`, {
      encoding: 'utf8',
      env: { ...process.env, PATH: filteredPath },
    });

    assert.ok(stdout.includes(BANNER), `expected banner "${BANNER}" in stdout, got: ${stdout}`);
  });

  test('bun probe emits banner when bun lives in a directory without "bun" in its name (pins deterministic resolution over substring matching)', () => {
    const probeLines = getProbeLines();

    // Homebrew installs bun at /opt/homebrew/bin — a directory whose name contains no "bun"
    // substring. Reproduce that class here with a throwaway fake binary so the pin does not
    // depend on this host's actual bun install location.
    const fakeBunDir = mkdtempSync(path.join(os.tmpdir(), 'toolchain-'));
    const fakeBunPath = path.join(fakeBunDir, 'bun');
    writeFileSync(fakeBunPath, '#!/bin/sh\necho "bun 1.0.0"\n');
    chmodSync(fakeBunPath, 0o755);

    const rawPath = `${fakeBunDir}:${process.env.PATH || ''}`;
    const filteredPath = simulateBinaryAbsent(rawPath, 'bun');

    const stdout = execSync(`bash -c ${JSON.stringify(probeLines)}`, {
      encoding: 'utf8',
      env: { ...process.env, PATH: filteredPath },
    });

    assert.ok(stdout.includes(BANNER), `expected banner "${BANNER}" in stdout, got: ${stdout}`);
  });

  test('no chmod +x applied to registry JSON', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      !src.includes('chmod +x') || !src.includes('engine-injected-keys.json'),
      'install.sh must not chmod +x engine-injected-keys.json',
    );
    const badLine = src
      .split('\n')
      .find(l => l.includes('chmod +x') && l.includes('engine-injected-keys.json'));
    assert.strictEqual(badLine, undefined, `found forbidden line: ${badLine}`);
  });

  test('chmod +x applied to plumbus-frame-analyzer.js', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const hasChmod = src
      .split('\n')
      .some(l => l.includes('chmod +x') && l.includes('plumbus-frame-analyzer.js'));
    assert.ok(hasChmod, 'install.sh must chmod +x plumbus-frame-analyzer.js');
  });
});
