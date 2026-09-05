#!/usr/bin/env node
// Fails when a test spawns a binary the CI/release workflows do not provision.
//
// Motivating defect: `extension/tests/integration/mega-bundle-e2e.test.js` spawned
// `rg` (ripgrep) to enumerate and scan `src`. ripgrep is installed on some dev
// machines and is installed by NEITHER .github/workflows/ci.yml NOR release.yml, so
// the dependency was invisible locally and `spawnSync rg ENOENT` in CI.
//
// The CANDIDATE tool list is NOT re-enumerated here. It is imported from
// `services/verify-command-safety.js` (compiled from src/, committed), which the
// runtime already uses to warn about non-guaranteed tools. One list, one place to
// update — a second copy would rot green (root CLAUDE.md: "a hand-maintained
// catalog rots, and rots green").
//
// The PROVISIONED set is not a list at all: it is DERIVED, per run, from
// `.github/workflows/*.yml` (see `deriveProvisionedTools`). A candidate is reported
// only if the workflows do not install it:
//
//     finding  <=>  tool in NON_GUARANTEED_TOOLS  AND  tool not in derived provisioned set
//
// This matters because the mirror had already rotted exactly as predicted. Commit
// 29b4ecc9 added `Install ripgrep` to BOTH workflows (audit-trap-door-enforcement.sh
// needs it), but `NON_GUARANTEED_TOOLS` still lists `rg` — so this audit was emitting
// "not installed by ci.yml/release.yml" about a package both workflows install. One
// commit of drift, in the direction root CLAUDE.md predicts for an enumerated set.
// Deriving means deleting the `Install ripgrep` step re-reds `rg` spawners on its own,
// and adding an `Install jq` step un-reds `jq` spawners on its own. Nobody updates a list.
//
// Honest limit: this removes the PROVISIONING mirror, not every enumeration. The
// candidate set is still hand-maintained — but it is shared with the runtime and is
// not a copy of anything, so it cannot disagree with a second source the way the
// provisioning verdict just did.
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
// `exec` is deliberately NOT receiver-qualified. `RegExp.prototype.exec` shares the
// name, so `someRegex.exec('rg')` is a possible false positive. Excluding `.exec(`
// would fix that but would blind this audit to the legitimate namespace-import form
// `cp.exec('rg ...')` — trading a LOUD false positive for a SILENT false negative.
// A red gate gets fixed; a silent pass ships. The noisier choice is the right one.
//
// Allowlist: a `PROVISIONED-OK` marker on the matching line or the line before it
// (for a call site that legitimately guards on the tool's presence). Deliberately
// NOT the SERIAL allowlist used by the host audit — serialization and binary
// provisioning are orthogonal, and mega-bundle-e2e.test.js is in the serial
// manifest, so sharing that allowlist would blind this audit to the original bug.
//
// Usage: node audit-unprovisioned-binary-spawns.mjs --base <root> [--workflows <dir>] <file...>
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

function escapeForRegex(tool) {
  return tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A step whose command installs packages. Anchored on the install VERB, so a step
// that merely mentions a tool is not mistaken for one that provisions it.
const INSTALL_CMD =
  /(?:apt-get|apt)\s+install|apk\s+add|(?:yum|dnf)\s+install|brew\s+install|npm\s+(?:i|install)\s+(?:-g|--global)|pip3?\s+install|cargo\s+install|go\s+install/g;

// A token in backticks. Inside a provisioning step this is read as a declaration of
// the BINARY that step provides — see deriveProvisionedTools.
const BACKTICKED = /`([A-Za-z0-9_.+-]+)`/g;

// Operands of an install command: everything up to the next shell separator, minus
// flags. `sudo apt-get update && sudo apt-get install -y ripgrep` -> ['ripgrep'].
function installOperands(afterVerb) {
  return afterVerb
    .split(/&&|\|\||[;|\n]/)[0]
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'));
}

// What ONE step block declares as provisioned. Returns [] for a step that does not
// install, which is precisely what keeps source 2 scoped: a backticked tool in a
// non-installing step is not a declaration, and treating it as one would silently
// mark a candidate provisioned on the strength of unrelated prose.
function provisionedByBlock(block) {
  INSTALL_CMD.lastIndex = 0;
  const tokens = [];
  let installs = false;
  let install;
  while ((install = INSTALL_CMD.exec(block)) !== null) {
    installs = true; // the VERB is the trigger, even if it names no operand
    tokens.push(...installOperands(block.slice(install.index + install[0].length)));
  }
  if (!installs) { return []; }
  BACKTICKED.lastIndex = 0;
  let tick;
  while ((tick = BACKTICKED.exec(block)) !== null) { tokens.push(tick[1]); }
  return tokens;
}

// The set of things `.github/workflows/*.yml` installs, derived per run — never stored.
//
// Two token sources are unioned, because a package name is NOT a binary name:
//   1. install-command operands  -> the PACKAGE (`ripgrep`)
//   2. backticked tokens in that same step block -> the BINARY it provides (`rg`)
//
// Source 2 is load-bearing, not decoration. Measured at HEAD: `rg` occurs as a word
// in ci.yml exactly once, in the Install step's own comment ("shells out to `rg`").
// Nothing in any `run:` string contains it. So operand extraction ALONE cannot bridge
// ripgrep->rg, and a scanner that does not bridge it keeps reporting `rg` as
// unprovisioned — the very drift this derivation exists to end. The alternative, a
// package->binary mapping table, is the enumerated-set shape we are removing.
//
// Source 2 is scoped to provisioning step blocks; provisionedByBlock above owns that
// rule and explains why a wider read would be a false-green generator.
//
// Fail-closed: an absent or unreadable workflows dir yields the EMPTY set, so every
// candidate stays a candidate. The degrade direction is more findings, never fewer.
export function deriveProvisionedTools(workflowsDir) {
  const provisioned = new Set();
  let entries;
  try {
    entries = fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return provisioned; // no workflows readable -> provision nothing
  }
  for (const entry of entries) {
    let content;
    try {
      content = fs.readFileSync(path.join(workflowsDir, entry), 'utf8');
    } catch {
      continue;
    }
    // Split into step blocks on the YAML sequence dash, so a step's `name:`, its
    // comments and its `run:` all land in one chunk — that adjacency is what lets
    // provisionedByBlock keep source 2 scoped to the step that does the installing.
    for (const token of content.split(/^\s*-\s+/m).flatMap(provisionedByBlock)) {
      provisioned.add(token);
    }
  }
  return provisioned;
}

// Candidates are the non-guaranteed tools the workflows do NOT install.
export function buildMatchers(provisioned) {
  const candidates = [...NON_GUARANTEED_TOOLS].filter((t) => !provisioned.has(t));
  // An empty alternation `()` matches the empty string at every position, which would
  // report a finding on every line of every file. No candidates means no matchers.
  if (candidates.length === 0) { return []; }
  const TOOL_ALT = candidates.map(escapeForRegex).join('|');
  return [
    // spawnSync('jq', ...) / spawnSync(\n  'jq', ...)
    new RegExp(String.raw`\b(?:${ARGV0_FNS})\s*\(\s*(['"\`])(${TOOL_ALT})\1`, 'g'),
    // execSync('jq -r .x') — tool is the leading token of the command string
    new RegExp(String.raw`\b(?:${SHELL_FNS})\s*\(\s*(['"\`])(${TOOL_ALT})(?=[\s;|&>]|\1)`, 'g'),
  ];
}

// Workflows live at the REPO root; --base is the extension root, one level down.
export function defaultWorkflowsDir(baseRoot) {
  return path.join(baseRoot, '..', '.github', 'workflows');
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') { line++; }
  return line;
}

// The marker may sit on the match's own line or the line immediately above it.
function isAllowlisted(lines, lineNo) {
  const own = lines[lineNo - 1] ?? '';
  const prev = lines[lineNo - 2] ?? '';
  return own.includes('PROVISIONED-OK') || prev.includes('PROVISIONED-OK');
}

export function scanFile(filePath, baseRoot, matchers) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const rel = path.relative(baseRoot, filePath).split(path.sep).join('/') || filePath;
  const findings = [];
  const seen = new Set();

  for (const matcher of matchers) {
    matcher.lastIndex = 0;
    let m;
    while ((m = matcher.exec(content)) !== null) {
      const tool = m[2];
      const lineNo = lineNumberAt(content, m.index);
      const key = `${lineNo}\t${tool}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      if (isAllowlisted(lines, lineNo)) { continue; }
      findings.push({ rel, tool, lineNo });
    }
  }
  return findings;
}

export function main(argv) {
  let baseRoot = process.cwd();
  let workflowsDir;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' || argv[i] === '--workflows') {
      const flag = argv[i];
      const value = argv[++i];
      if (value === undefined) {
        process.stderr.write(`usage: ${flag} requires a directory argument\n`);
        return 2;
      }
      if (flag === '--base') baseRoot = value;
      else workflowsDir = value;
      continue;
    }
    files.push(argv[i]);
  }

  const matchers = buildMatchers(deriveProvisionedTools(workflowsDir ?? defaultWorkflowsDir(baseRoot)));
  const findings = [];
  for (const file of files) {
    if (!fs.existsSync(file)) { continue; }
    findings.push(...scanFile(file, baseRoot, matchers));
  }

  findings.sort((a, b) => a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo);
  for (const f of findings) process.stdout.write(`${f.rel}\t${f.tool}\t${f.lineNo}\n`);
  return findings.length > 0 ? 1 : 0;
}

// CLI guard: the tests import this module to drive `deriveProvisionedTools` directly,
// and a bare top-level exit would kill the test runner on import.
if (process.argv[1] && path.basename(process.argv[1]) === 'audit-unprovisioned-binary-spawns.mjs') {
  process.exit(main(process.argv.slice(2)));
}
