#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getExtensionRoot } from '../extension/services/pickle-utils.js';

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

function removePath(targetPath, dryRun) {
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

// `check-update.ts` writes this cache through `<path>.tmp.<pid>` + rename (`writeCache`) and
// reads it back through `readRecoverableJsonObject` (`readCache`), which PROMOTES a dead orphan
// tmp whenever the base is gone — `baseMtimeMs` is 0 once it is, so the `mtimeMs < baseMtimeMs`
// discard can never fire and EVERY parseable orphan qualifies. Removing the base NAME alone
// therefore purges nothing: measured, the next read renameSyncs the orphan into place and returns
// its `latest_version`, while this script has already printed `Removed` and logged a CACHE_PURGE
// row naming the path — a false-clean purge, the same class the `pickle-extract-` sibling above
// exists to close for interrupted upgrades. The target is the whole PROMOTABLE SET, not one name.
//
// `isFile()` for the same reason `collectPrefixMatches` takes `isDirectory()`: purge only the
// shape the producer creates (`fs.writeFileSync`), never a same-prefix entry of another shape.
function collectPromotableTmpSiblings(targetPath) {
  const dir = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.tmp.`;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
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

function appendAudit(dryRun) {
  if (removedPaths.length === 0) return;
  const event = {
    event: 'CACHE_PURGE',
    removed_paths: removedPaths,
    ts: new Date().toISOString(),
  };
  if (!dryRun) {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const auditExisted = pathExists(auditPath);
    fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (!auditExisted) fs.chmodSync(auditPath, 0o600);
  }
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const unexpected = argv.filter((arg) => arg !== '--dry-run');

  if (unexpected.length > 0) {
    process.stderr.write(`Usage: purge-update-cache.js [--dry-run]\n`);
    process.exit(2);
  }

  // Siblings FIRST: `removePath` deletes, and a purge that dies partway must not leave the base
  // gone with a promotable orphan still beside it — that is precisely the defective state.
  for (const targetPath of collectPromotableTmpSiblings(cachePath)) {
    removePath(targetPath, dryRun);
  }
  removePath(cachePath, dryRun);

  const tmpRoot = process.env.TMPDIR || os.tmpdir();
  for (const targetPath of collectTmpRootMatches(tmpRoot)) {
    removePath(targetPath, dryRun);
  }

  const varFoldersRoot = process.env.PICKLE_PURGE_VAR_FOLDERS_ROOT || '/var/folders';
  if (process.platform === 'darwin') {
    for (const targetPath of collectVarFolderMatches(varFoldersRoot)) {
      removePath(targetPath, dryRun);
    }
  }

  appendAudit(dryRun);
}

// The CLAUDE.md Required Pattern, which both sibling `bin/*.js` scripts already carry and this
// one shipped without: the argument parse and the `rm -rf` ran at MODULE TOP LEVEL, so `import`
// alone performed them. Measured on the shipped file against a hermetic HOME/TMPDIR fixture, two
// arms: `await import(...)` from an ordinary `.mjs` (and from `node -e`) DELETED the update cache
// and every `pickle-update-`/`pickle-extract-` root and wrote a CACHE_PURGE row, returning
// control to the importer as if nothing happened; an importer whose own process carried any
// extra argv token instead got `process.exit(2)` and another program's usage line — the module
// terminating its host, which is the shape `node --test <file>` hands it. Both are invocation
// modes, not argument shapes, so they belong behind ONE entry guard rather than a second check
// beside the argument one.
if (process.argv[1] && path.basename(process.argv[1]) === 'purge-update-cache.js') {
  main(process.argv.slice(2));
}
