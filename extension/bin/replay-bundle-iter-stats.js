#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataRoot } from '../services/pickle-utils.js';

function parseArgs(argv) {
  const opts = {
    activityDir: path.join(getDataRoot(), 'activity'),
    output: path.join(process.cwd(), 'bundle', 'wasted-iter-baseline.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--activity-dir') opts.activityDir = argv[++i];
    else if (arg === '--output') opts.output = argv[++i];
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function emptyStats() {
  return { iterations: 0, wasted: 0 };
}

function addEvent(target, event) {
  target.iterations += 1;
  if (event.wasted === true) target.wasted += 1;
}

function readActivityEvents(activityDir) {
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const file of fs.readdirSync(activityDir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    const content = fs.readFileSync(path.join(activityDir, file), 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore malformed historical activity rows; replay should be best-effort.
      }
    }
  }
  return events;
}

export function buildWastedIterBaseline(events) {
  const baseline = {
    generated_at: new Date().toISOString(),
    totals: emptyStats(),
    per_session: {},
    per_runner: {},
  };

  for (const event of events) {
    if (!event || event.event !== 'wasted_iter') continue;
    const session = typeof event.session === 'string' && event.session ? event.session : 'unknown';
    const runner = typeof event.runner === 'string' && event.runner ? event.runner : 'unknown';
    baseline.per_session[session] ??= emptyStats();
    baseline.per_runner[runner] ??= emptyStats();
    addEvent(baseline.totals, event);
    addEvent(baseline.per_session[session], event);
    addEvent(baseline.per_runner[runner], event);
  }

  return baseline;
}

export function replayWastedIterBaseline(opts) {
  const baseline = buildWastedIterBaseline(readActivityEvents(opts.activityDir));
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'replay-bundle-iter-stats.js') {
  try {
    const baseline = replayWastedIterBaseline(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(baseline, null, 2) + '\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
