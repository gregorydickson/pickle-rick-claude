#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getExtensionRoot } from '../extension/services/pickle-utils.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unexpected = args.filter((arg) => arg !== '--dry-run');

if (unexpected.length > 0) {
  process.stderr.write(`Usage: purge-update-cache.js [--dry-run]\n`);
  process.exit(2);
}

const runtimeRoot = getExtensionRoot();
const cachePath = path.join(runtimeRoot, 'update-check.json');
const auditPath = path.join(runtimeRoot, 'deploy-audit.log');
const removedPaths = [];

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function removePath(targetPath) {
  if (!pathExists(targetPath)) return;
  removedPaths.push(targetPath);
  if (!dryRun) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
  process.stderr.write(`[purge-update-cache] ${dryRun ? 'Would remove' : 'Removed'} ${targetPath}\n`);
}

function collectPrefixMatches(dir, prefix) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function collectTmpRootMatches(dir) {
  return [
    ...collectPrefixMatches(dir, 'pickle-update-'),
    ...collectPrefixMatches(dir, 'pickle-extract-'),
  ];
}

function collectVarFolderMatches(rootDir) {
  const matches = [];
  const stack = [rootDir];
  const prefixes = ['pickle-update-', 'pickle-extract-'];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix))) {
        matches.push(fullPath);
      } else if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return matches;
}

function appendAudit() {
  if (removedPaths.length === 0) return;
  const event = {
    event: 'CACHE_PURGE',
    removed_paths: removedPaths,
    ts: new Date().toISOString(),
  };
  if (!dryRun) {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`);
  }
}

removePath(cachePath);

const tmpRoot = process.env.TMPDIR || os.tmpdir();
for (const targetPath of collectTmpRootMatches(tmpRoot)) {
  removePath(targetPath);
}

const varFoldersRoot = process.env.PICKLE_PURGE_VAR_FOLDERS_ROOT || '/var/folders';
if (process.platform === 'darwin') {
  for (const targetPath of collectVarFolderMatches(varFoldersRoot)) {
    removePath(targetPath);
  }
}

appendAudit();
