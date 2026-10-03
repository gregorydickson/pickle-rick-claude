#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeActivityEntry } from '../services/state-manager.js';

export const COVERAGE_EXCEPTION_TRAILER_RE = /^Coverage-Exception: ([^:]+):(.+)$/;

function normalizeException(pathValue, reasonValue) {
  return {
    path: pathValue.trim(),
    reason: reasonValue.trim(),
  };
}

export function parseCoverageExceptionText(text, opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : null;
  const warnings = [];
  const exceptions = [];

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.startsWith('Coverage-Exception: ')) continue;

    const match = COVERAGE_EXCEPTION_TRAILER_RE.exec(line);
    if (!match) {
      const warning = `WARN: malformed Coverage-Exception trailer skipped: ${line}`;
      warnings.push(warning);
      warn?.(warning);
      continue;
    }

    exceptions.push(normalizeException(match[1], match[2]));
  }

  return { exceptions, warnings };
}

function runGit(args, options) {
  return spawnSync('git', args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveMergeBase(options) {
  if (options.mergeBase) return options.mergeBase;
  if (options.env?.MERGE_BASE) return options.env.MERGE_BASE;

  const result = runGit(['merge-base', 'HEAD', 'origin/main'], options);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function readCoverageExceptionsFromGit(opts = {}) {
  const options = {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    mergeBase: opts.mergeBase ?? null,
  };
  const mergeBase = resolveMergeBase(options);
  if (!mergeBase) return { exceptions: [], warnings: [] };

  const result = runGit(['log', '--format=%B', `${mergeBase}..HEAD`], options);
  if (result.status !== 0) return { exceptions: [], warnings: [] };
  return parseCoverageExceptionText(result.stdout, opts);
}

export function createCoverageExceptionActivityEvent(exception, opts = {}) {
  const file = String(exception.file ?? exception.path ?? '').trim();
  const reason = String(exception.reason ?? '').trim();
  const ts = opts.ts ?? new Date().toISOString();

  return {
    event: 'coverage_exception',
    kind: 'coverage_exception',
    file,
    reason,
    ts,
  };
}

export function appendCoverageExceptionActivity(statePath, exception, opts = {}) {
  writeActivityEntry(statePath, createCoverageExceptionActivityEvent(exception, opts));
}

function readStdinIfProvided() {
  try {
    if (process.stdin.isTTY === false) return fs.readFileSync(0, 'utf8');
    const stat = fs.fstatSync(0);
    if (stat.isFIFO() || stat.isFile() || stat.isSocket()) return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
  return '';
}

export function main() {
  const stdin = readStdinIfProvided();
  const result = stdin.length > 0
    ? parseCoverageExceptionText(stdin)
    : readCoverageExceptionsFromGit();

  for (const warning of result.warnings) {
    process.stderr.write(`${warning}\n`);
  }
  process.stdout.write(`${JSON.stringify(result.exceptions)}\n`);
  return 0;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'parse-coverage-exception.js') {
  try {
    process.exitCode = main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`WARN: coverage exception parser failed: ${message}\n`);
    process.stdout.write('[]\n');
    process.exitCode = 0;
  }
}
