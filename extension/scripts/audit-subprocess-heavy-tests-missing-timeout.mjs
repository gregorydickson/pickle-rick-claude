#!/usr/bin/env node
// R-TFP-C2 extension: missing-timeout predicate over the whole child_process
// family (exec, execSync, execFile, execFileSync, spawn, spawnSync, fork).
//
// A callsite is a "candidate" when it invokes one of those functions WITHOUT
// an explicit `timeout:` option in its argument list. Candidates are compared
// against a committed baseline (`subprocess-heavy-missing-timeout-baseline.json`)
// keyed by file + function name + a content hash of the call's argument text
// (stable across line drift elsewhere in the file, unstable if the call's own
// text changes — an acceptable narrowing since a rewritten callsite deserves a
// fresh look). Only NEW candidates (absent from the baseline) are reported.
//
// Usage: node audit-subprocess-heavy-tests-missing-timeout.mjs --baseline <path> <file> [<file> ...]
// Prints one line per NEW finding to stdout: "<fileRel>\t<fn>\t<key>"
// Exit code: 0 if no new findings, 1 if any new findings.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const FN_NAMES = ['execFileSync', 'execSync', 'execFile', 'exec', 'spawnSync', 'spawn', 'fork'];
// Longest-first so the alternation doesn't stop at a shorter prefix match
// (e.g. matching `exec` inside `execFileSync`).
//
// The optional leading group captures a property-access receiver, so a call is
// classified by WHAT it is called on, not just by its name:
//   m[1] = receiver ('child_process' in `child_process.exec(...)`), or undefined
//          for a bare call (`exec(...)` — the destructured-import form)
//   m[2] = function name
// The leading `(?<![\w$.])` also stops a bare match from being claimed off the
// tail of a property access whose receiver isn't a plain identifier
// (`arr[0].exec(` is no longer a match at all).
const CALL_RE = new RegExp(
  `(?<![\\w$.])(?:([\\w$]+)\\s*\\.\\s*)?(${FN_NAMES.join('|')})\\s*\\(`,
  'g',
);

// Receivers that plausibly hold a child_process binding, for the one function
// name that collides with a builtin prototype method.
const CP_RECEIVER_RE = /^(?:cp|child_?process|_?deps)$/i;

// `exec` is the only name in FN_NAMES that collides with a widely-used builtin
// prototype method (`RegExp.prototype.exec`), so it is the only one that needs
// its receiver qualified: `re.exec(text)` spawns nothing and "missing timeout"
// is meaningless on it. The other six have no builtin collision and DO appear
// behind opaque receivers that are genuine child_process bindings (e.g.
// `_deps.execFileSync(...)`), so qualifying them would delete real coverage.
function isChildProcessCandidate(receiver, fn) {
  if (receiver === undefined) return true; // bare `exec(...)`: destructured import
  if (fn !== 'exec') return true;
  return CP_RECEIVER_RE.test(receiver);
}

function findMatchingClose(content, openIdx) {
  let depth = 0;
  let inString = null; // "'" | '"' | '`' | null
  let escaped = false;
  for (let i = openIdx; i < content.length; i++) {
    const c = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === inString) {
        inString = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanFileForMissingTimeout(absPath, fileRel) {
  const content = fs.readFileSync(absPath, 'utf-8');
  const firstLine = content.split('\n')[0];
  if (firstLine.includes('@tier: expensive')) return [];

  const findings = [];
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(content)) !== null) {
    const fn = m[2];
    if (!isChildProcessCandidate(m[1], fn)) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingClose(content, openIdx);
    if (closeIdx === -1) continue;
    const argsText = content.slice(openIdx + 1, closeIdx);
    if (/\btimeout\s*:/.test(argsText)) continue;
    const normalized = argsText.replace(/\s+/g, ' ').trim().slice(0, 300);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
    const key = `${fileRel}::${fn}::${hash}`;
    findings.push({ file: fileRel, fn, key });
  }
  return findings;
}

function loadBaseline(baselinePath) {
  if (!baselinePath || !fs.existsSync(baselinePath)) return new Set();
  const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  return new Set(Array.isArray(parsed.entries) ? parsed.entries : []);
}

function main(argv) {
  let baselinePath = null;
  let base = process.cwd();
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline') {
      baselinePath = argv[++i];
    } else if (argv[i] === '--base') {
      base = argv[++i];
    } else {
      files.push(argv[i]);
    }
  }

  const baseline = loadBaseline(baselinePath);
  const newFindings = [];

  for (const file of files) {
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;
    const fileRel = path.relative(base, absPath).replace(/\\/g, '/');
    const findings = scanFileForMissingTimeout(absPath, fileRel);
    for (const f of findings) {
      if (!baseline.has(f.key)) newFindings.push(f);
    }
  }

  for (const f of newFindings) {
    process.stdout.write(`${f.file}\t${f.fn}\t${f.key}\n`);
  }

  process.exit(newFindings.length > 0 ? 1 : 0);
}

main(process.argv.slice(2));
