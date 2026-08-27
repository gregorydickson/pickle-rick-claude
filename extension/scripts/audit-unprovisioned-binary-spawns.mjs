#!/usr/bin/env node
// Fails when a test spawns a binary the CI/release workflows do not provision.
//
// Motivating defect: `extension/tests/integration/mega-bundle-e2e.test.js` spawned
// `rg` (ripgrep) to enumerate and scan `src`. ripgrep is installed on some dev
// machines and is installed by NEITHER .github/workflows/ci.yml NOR release.yml, so
// the dependency was invisible locally and `spawnSync rg ENOENT` in CI.
//
// The tool list is NOT re-enumerated here. It is imported from
// `services/verify-command-safety.js` (compiled from src/, committed), which the
// runtime already uses to warn about non-guaranteed tools. One list, one place to
// update — a second copy would rot green (root CLAUDE.md: "a hand-maintained
// catalog rots, and rots green").
//
// Matching is over WHOLE FILE CONTENT, never line-by-line. The original defect was
// a multiline call:
//     spawnSync(
//       'rg',
//       ['-n', ...],
// which a line-based grep does not see. A line-based scanner here would have shipped
// green against the very bug it exists to catch.
//
// Covered shapes (argv0 must be a string LITERAL — a computed binary name is out of
// contract and is reported by neither shape):
//   1. argv0 form   : spawn|spawnSync|execFile|execFileSync|execFileAsync('<tool>', ...)
//   2. shell-string : exec|execSync('<tool> ...')  — leading token of the command
//
// Allowlist: a `PROVISIONED-OK` marker on the matching line or the line before it
// (for a call site that legitimately guards on the tool's presence). Deliberately
// NOT the SERIAL allowlist used by the host audit — serialization and binary
// provisioning are orthogonal, and mega-bundle-e2e.test.js is in the serial
// manifest, so sharing that allowlist would blind this audit to the original bug.
//
// Usage: node audit-unprovisioned-binary-spawns.mjs --base <root> <file...>
// Output: one `<file>\t<tool>\t<line>` per finding on stdout. Exit 1 if any.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { NON_GUARANTEED_TOOLS } = await import(
  path.join(__dirname, '../services/verify-command-safety.js')
);

const ARGV0_FNS = 'spawnSync|spawn|execFileSync|execFileAsync|execFile';
const SHELL_FNS = 'execSync|exec';

function escapeForClass(tool) {
  return tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatchers(tools) {
  const alt = tools.map(escapeForClass).join('|');
  return [
    // spawnSync('rg', ...) / spawnSync(\n  'rg', ...)
    new RegExp(String.raw`\b(?:${ARGV0_FNS})\s*\(\s*(['"\`])(${alt})\1`, 'g'),
    // execSync('rg --files src') — tool is the leading token of the command string
    new RegExp(String.raw`\b(?:${SHELL_FNS})\s*\(\s*(['"\`])(${alt})(?=[\s;|&>]|\1)`, 'g'),
  ];
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

// The marker may sit on the match's own line or the line immediately above it.
function isAllowlisted(lines, lineNo) {
  const own = lines[lineNo - 1] ?? '';
  const prev = lines[lineNo - 2] ?? '';
  return own.includes('PROVISIONED-OK') || prev.includes('PROVISIONED-OK');
}

function scanFile(filePath, baseRoot) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const rel = path.relative(baseRoot, filePath).split(path.sep).join('/') || filePath;
  const findings = [];
  const seen = new Set();

  for (const matcher of buildMatchers([...NON_GUARANTEED_TOOLS])) {
    matcher.lastIndex = 0;
    let m;
    while ((m = matcher.exec(content)) !== null) {
      const tool = m[2];
      const lineNo = lineNumberAt(content, m.index);
      const key = `${lineNo}\t${tool}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isAllowlisted(lines, lineNo)) continue;
      findings.push({ rel, tool, lineNo });
    }
  }
  return findings;
}

function main(argv) {
  let baseRoot = process.cwd();
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') { baseRoot = argv[++i]; continue; }
    files.push(argv[i]);
  }

  const findings = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    findings.push(...scanFile(file, baseRoot));
  }

  findings.sort((a, b) => a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo);
  for (const f of findings) process.stdout.write(`${f.rel}\t${f.tool}\t${f.lineNo}\n`);
  return findings.length > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
