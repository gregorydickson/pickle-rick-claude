#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertKnownSuite,
  CALIBRATION_SUITES,
  checkCalibrationDrift,
  writeCalibrationBaseline,
  type CalibrationSuite,
} from '../services/calibration-corpus.js';

interface CalibrateArgs {
  suites: CalibrationSuite[];
  extensionRoot: string;
  write: boolean;
}

function usage(): never {
  process.stderr.write('Usage: node calibrate.js <readiness|correct-course|all> [--check] [--write] [--extension-root <dir>]\n');
  process.exit(1);
}

export function parseArgs(argv: string[]): CalibrateArgs {
  validateFlags(argv);
  const positional = readPositionals(argv);
  const target = positional[0];
  if (!target || positional.length > 1) usage();
  const extensionRoot = readFlag(argv, '--extension-root') ?? path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write && check) usage();
  let suites: CalibrationSuite[];
  if (target === 'all') {
    suites = [...CALIBRATION_SUITES];
  } else {
    assertKnownSuite(target);
    suites = [target];
  }
  return {
    suites,
    extensionRoot: path.resolve(extensionRoot),
    write,
  };
}

function validateFlags(argv: string[]): void {
  const allowedFlags = new Set(['--check', '--write', '--extension-root']);
  for (const value of argv) {
    if (value.startsWith('--') && !allowedFlags.has(value)) usage();
  }
}

function readPositionals(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      if (value === '--extension-root') index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

export function runCalibrate(args: CalibrateArgs): number {
  let exitCode = 0;
  for (const suite of args.suites) {
    if (args.write) {
      const baseline = writeCalibrationBaseline(args.extensionRoot, suite);
      process.stdout.write(`${suite}: wrote ${baseline.fixture_results.length} fixtures, ${Object.keys(baseline.metrics).length} metrics\n`);
      continue;
    }

    const report = checkCalibrationDrift(args.extensionRoot, suite);
    const status = report.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`${suite}: ${status} max_drift_pct=${report.maxDriftPct} threshold_pct=${report.thresholdPct} baseline=${report.baselinePath}\n`);
    if (!report.passed) {
      exitCode = 2;
      for (const entry of report.entries.filter((item) => item.drift_pct > report.thresholdPct)) {
        process.stdout.write(`  ${entry.metric}: baseline=${entry.baseline} current=${entry.current} drift_pct=${entry.drift_pct}\n`);
      }
    }
  }
  return exitCode;
}

export function main(argv = process.argv.slice(2)): void {
  try {
    process.exitCode = runCalibrate(parseArgs(argv));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
