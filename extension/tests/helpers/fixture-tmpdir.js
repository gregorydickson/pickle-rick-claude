/**
 * D6 (R-ORCG): shared fixture-tempdir helper. Suites needing a throwaway directory under
 * TMPDIR should use mkFixtureTmpDir() instead of a bare fs.mkdtempSync — it ties the
 * directory to a crash-surviving cleanup net with the same three-part shape as
 * fixture-lifetime-and-registry.test.js's (D1) PID registry: a startup sweep for
 * SIGKILL/OOM, process.on('exit') for a cancel/throw, and after() for a normal end or a
 * per-test timeout — each covers a death the others cannot.
 *
 * Unlike D1's PID registry, a directory has no liveness signal of its own, so staleness is
 * decided by the OWNING PROCESS's liveness instead: each process keeps its own manifest in
 * a pid-named file (`<REGISTRY_DIR>/<pid>.json`), so registry files never have more than one
 * writer and need no locking.
 */
import { after } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REGISTRY_DIR = path.join(os.tmpdir(), 'pickle-fixture-tmpdir-registry');
const ownedDirs = [];

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeDirQuietly(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    /* already gone, or unremovable — best-effort */
  }
}

function ownRegistryPath() {
  return path.join(REGISTRY_DIR, `${process.pid}.json`);
}

function syncOwnRegistry() {
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.writeFileSync(ownRegistryPath(), JSON.stringify(ownedDirs));
  } catch {
    /* best-effort — a lost registry write only delays the eventual startup-sweep reap */
  }
}

/**
 * Startup sweep: reap every directory recorded by a pid that is no longer alive. Safe to
 * call from any process — each registry file has exactly one writer (its own pid), so
 * there is nothing to lock and no cross-process race to guard against.
 */
export function reapPreviousRunFixtureDirs() {
  let entries;
  try {
    entries = fs.readdirSync(REGISTRY_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isProcessAlive(pid)) continue;
    const registryPath = path.join(REGISTRY_DIR, name);
    let dirs = [];
    try {
      dirs = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch {
      dirs = [];
    }
    if (Array.isArray(dirs)) {
      for (const dir of dirs) {
        if (typeof dir === 'string') removeDirQuietly(dir);
      }
    }
    removeDirQuietly(registryPath);
  }
}

/** Removes every directory this process owns, plus its own registry file. */
export function cleanupOwnedFixtureDirs() {
  for (const dir of ownedDirs.splice(0, ownedDirs.length)) removeDirQuietly(dir);
  removeDirQuietly(ownRegistryPath());
}

process.on('exit', cleanupOwnedFixtureDirs);
after(() => cleanupOwnedFixtureDirs());
reapPreviousRunFixtureDirs();

/**
 * Create a throwaway directory under TMPDIR, tracked for crash-surviving cleanup. Drop-in
 * replacement for fs.mkdtempSync(path.join(os.tmpdir(), prefix)).
 */
export function mkFixtureTmpDir(prefix = 'pickle-fixture-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ownedDirs.push(dir);
  syncOwnRegistry();
  return dir;
}
