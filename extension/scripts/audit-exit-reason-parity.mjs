#!/usr/bin/env node
/**
 * AC-G1 — the (exit_reason x phase) -> action parity table, and the diff between two git refs.
 *
 * Why this exists: a bundle that DELETES exit-reason plumbing can hide a behaviour change inside
 * the deletion, and a hand-written parity table is a mirror that drifts green. So neither table is
 * written down here. Both are derived by EXECUTING the shipped, committed, compiled code at each
 * ref -- `git archive` the tree, import its own `bin/pipeline-runner.js` and `bin/mux-runner.js`,
 * and ask them. The only thing this file asserts is which differences are INTENTIONAL, and each of
 * those carries its evidence.
 *
 * The domain is the UNION of both refs' reason sets, never each ref's own set. A reason DELETED at
 * head must still be probed at head -- otherwise the very deletion under review is invisible to the
 * check, which is the fail-green class this audit exists to catch.
 *
 * Usage:
 *   node scripts/audit-exit-reason-parity.mjs [--base <ref>] [--head <ref>] [--json] [--quiet]
 *
 * Exit 0 = every difference is named-and-occurring. Exit 1 = an unnamed difference, or a named
 * entry that did not occur (a stale name is a rotting catalog and reds the same way).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');

const DEFAULT_BASE = '13d96e1e';
const DEFAULT_HEAD = 'HEAD';

/** Every phase the pipeline can be in (`type PipelinePhase`, pipeline-runner.ts). */
const PHASES = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];

/** Stands for a state.json carrying no exit_reason at all -- a real, reachable state. */
const ABSENT = '<absent>';

const GIT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 180_000;
const SENTINEL_OPEN = '<<<PARITY_JSON>>>';
const SENTINEL_CLOSE = '<<<END_PARITY_JSON>>>';

/**
 * Differences this bundle made ON PURPOSE. A difference not listed here fails the audit; an entry
 * listed here that does NOT occur ALSO fails it. Both directions matter -- one catches an
 * accidental behaviour change, the other catches this ledger going stale.
 */
const NAMED_DIFFERENCES = [
  {
    exit_reason: 'manager_handoff_pending',
    phases: PHASES,
    evidence:
      "TIER-1.2 gh-11: mux-runner no longer stamps 'manager_handoff_pending' as an exit_reason -- "
      + 'it is a non-halting residual now. Removed from EXIT_REASONS (types/index.ts), from '
      + 'isHaltExit (mux-runner.ts, was ":5347" at base), and from PIPELINE_HANDOFF_EXIT_REASONS '
      + '(pipeline-runner.ts:4413). claimPipelineRunnerActive still CLEARS the legacy value so a '
      + 'session resumed across the upgrade is not stranded. Intended: a handoff residual must not '
      + 'halt the pipeline (root CLAUDE.md park-and-flag).',
  },
];

/**
 * Each materialized tree holds a full `extension/` archive, so leaving them behind is how a
 * repeatedly-run audit fills the temp dir. Removed on every exit path, including the throw paths.
 * `node_modules` inside is a SYMLINK -- `rm -rf` on the tree unlinks it without following it.
 */
function cleanupMaterialized() {
  for (const dir of materialized.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function parseArgs(argv) {
  const opts = { base: DEFAULT_BASE, head: DEFAULT_HEAD, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') { opts.base = argv[i += 1]; continue; }
    if (arg === '--head') { opts.head = argv[i += 1]; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--quiet') { opts.quiet = true; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.base || !opts.head) throw new Error('--base and --head each require a value');
  return opts;
}

function resolveSha(ref) {
  return execFileSync('git', ['rev-parse', ref], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
  }).trim();
}

/**
 * Extract `extension/` at `ref` into a temp dir. node_modules is symlinked from the live tree
 * rather than extracted: it is not committed, and a transitive import of the compiled runners
 * needs `typescript` resolvable.
 */
const materialized = [];

function materialize(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-reason-parity-'));
  materialized.push(dir);
  const archive = execFileSync('git', ['archive', ref, 'extension'], {
    cwd: REPO_ROOT, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: GIT_TIMEOUT_MS,
  });
  const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive, timeout: GIT_TIMEOUT_MS });
  if (tar.status !== 0) {
    throw new Error(`tar failed for ${ref}: ${tar.stderr?.toString() ?? 'no stderr'}`);
  }
  fs.symlinkSync(path.join(EXTENSION_ROOT, 'node_modules'), path.join(dir, 'extension', 'node_modules'));
  return path.join(dir, 'extension');
}

/**
 * The probe body, run INSIDE the materialized tree so every import resolves to that ref's own
 * compiled code. Reports the ref's own reason sets; when handed a domain, also evaluates every
 * (phase, reason) cell against that ref's decision functions.
 */
const PROBE_SOURCE = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const domain = process.env.PARITY_DOMAIN ? JSON.parse(process.env.PARITY_DOMAIN) : null;
const phases = JSON.parse(process.env.PARITY_PHASES);
const absent = process.env.PARITY_ABSENT;

const types = await import('./types/index.js');
const out = {
  sets: {
    EXIT_REASONS: [...(types.EXIT_REASONS ?? [])],
    MICROVERSE_EXIT_REASONS: [...(types.MICROVERSE_EXIT_REASONS ?? [])],
    MICROVERSE_FATAL_REASONS: [...(types.MICROVERSE_FATAL_REASONS ?? [])],
  },
  schemaVersion: types.LATEST_SCHEMA_VERSION ?? null,
  cells: null,
};

if (domain) {
  const pipeline = await import('./bin/pipeline-runner.js');
  const mux = await import('./bin/mux-runner.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-state-'));
  const statePath = path.join(dir, 'state.json');
  const runtime = { statePath, repoRoot: dir };
  const cells = {};

  const call = (fn, ...args) => {
    try { return fn(...args); } catch (err) {
      return 'THREW:' + (err instanceof Error ? err.message : String(err));
    }
  };

  for (const reason of domain) {
    const state = { schema_version: out.schemaVersion, start_commit: 'deadbee' };
    if (reason !== absent) state.exit_reason = reason;
    const rowKey = reason;
    cells[rowKey] = {
      // Phase-independent wires (mux-runner). Recorded once per reason.
      isHaltExit: call(mux.isHaltExit, reason === absent ? undefined : reason),
      isFailureExit: call(mux.isFailureExit, reason === absent ? undefined : reason),
      microverseAction: (() => {
        const r = call(pipeline.classifyMicroverseHaltDecision, reason === absent ? undefined : reason);
        return typeof r === 'string' ? r : r?.action ?? null;
      })(),
      phases: {},
    };
    for (const phase of phases) {
      // Rewritten per cell: sm.read may normalise/migrate the file in place, so a reused
      // state.json would leak the previous reason's normalisation into the next probe.
      fs.writeFileSync(statePath, JSON.stringify(state));
      const fatal = call(pipeline.isFatalPhaseFailure, phase, runtime);
      fs.writeFileSync(statePath, JSON.stringify(state));
      const halt1 = call(pipeline.shouldHaltAfterPhase, phase, 1, runtime);
      fs.writeFileSync(statePath, JSON.stringify(state));
      const halt0 = call(pipeline.shouldHaltAfterPhase, phase, 0, runtime);
      cells[rowKey].phases[phase] = { fatal, halt1, halt0 };
    }
  }
  out.cells = cells;
}

process.stdout.write('${SENTINEL_OPEN}' + JSON.stringify(out) + '${SENTINEL_CLOSE}');
`;

function probe(treeDir, domain) {
  const probePath = path.join(treeDir, '__exit_reason_parity_probe.mjs');
  fs.writeFileSync(probePath, PROBE_SOURCE);
  const env = { ...process.env, PARITY_PHASES: JSON.stringify(PHASES), PARITY_ABSENT: ABSENT };
  if (domain) env.PARITY_DOMAIN = JSON.stringify(domain);
  const run = spawnSync(process.execPath, [probePath], {
    cwd: treeDir, encoding: 'utf8', env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`probe failed in ${treeDir} (status ${run.status}): ${run.stderr ?? ''}`);
  }
  const start = run.stdout.indexOf(SENTINEL_OPEN);
  const end = run.stdout.indexOf(SENTINEL_CLOSE);
  if (start < 0 || end < 0) {
    throw new Error(`probe emitted no parity JSON in ${treeDir}: ${run.stdout.slice(0, 500)}`);
  }
  return JSON.parse(run.stdout.slice(start + SENTINEL_OPEN.length, end));
}

/** One comparable string per (reason, phase) cell -- the "action" the table records. */
function actionOf(refResult, reason, phase) {
  const row = refResult.cells[reason];
  const p = row.phases[phase];
  // `halt@0` is constant `false` today -- shouldHaltAfterPhase returns early on exitCode === 0.
  // It is kept deliberately as the NEGATIVE CONTROL for "a phase that succeeded is never halted":
  // it is the column that would differ if that early return were ever removed. Do not delete it
  // as a dead column.
  return [
    `fatal=${p.fatal}`,
    `halt@1=${p.halt1}`,
    `halt@0=${p.halt0}`,
    `mvAction=${row.microverseAction}`,
    `haltExit=${row.isHaltExit}`,
    `failExit=${row.isFailureExit}`,
  ].join(' ');
}

function renderTable(title, result, domain) {
  const lines = [`### ${title}`, '', `| exit_reason | phase | action |`, `|---|---|---|`];
  for (const reason of domain) {
    for (const phase of PHASES) {
      lines.push(`| \`${reason}\` | ${phase} | \`${actionOf(result, reason, phase)}\` |`);
    }
  }
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseSha = resolveSha(opts.base);
  const headSha = resolveSha(opts.head);

  const baseTree = materialize(opts.base);
  const headTree = materialize(opts.head);

  // Pass 1: each ref's OWN reason sets.
  const baseSets = probe(baseTree, null);
  const headSets = probe(headTree, null);

  // Pass 2: both refs evaluated over the SAME union domain.
  const union = new Set([ABSENT]);
  for (const sets of [baseSets.sets, headSets.sets]) {
    for (const list of Object.values(sets)) for (const r of list) union.add(r);
  }
  const domain = [...union].sort();

  const baseResult = probe(baseTree, domain);
  const headResult = probe(headTree, domain);

  const differences = [];
  for (const reason of domain) {
    for (const phase of PHASES) {
      const before = actionOf(baseResult, reason, phase);
      const after = actionOf(headResult, reason, phase);
      if (before !== after) differences.push({ exit_reason: reason, phase, before, after });
    }
  }

  const namedFor = (d) => NAMED_DIFFERENCES.find(
    (n) => n.exit_reason === d.exit_reason && n.phases.includes(d.phase),
  );
  const unnamed = differences.filter((d) => !namedFor(d));
  const stale = NAMED_DIFFERENCES.flatMap((n) => n.phases
    .filter((phase) => !differences.some((d) => d.exit_reason === n.exit_reason && d.phase === phase))
    .map((phase) => ({ exit_reason: n.exit_reason, phase })));

  const report = {
    base: { ref: opts.base, sha: baseSha, sets: baseSets.sets },
    head: { ref: opts.head, sha: headSha, sets: headSets.sets },
    domain,
    phases: PHASES,
    differences,
    unnamed,
    stale,
    ok: unnamed.length === 0 && stale.length === 0,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!opts.quiet) {
    console.log(`# (exit_reason x phase) -> action parity`);
    console.log(`\nbase: ${opts.base} (${baseSha})`);
    console.log(`head: ${opts.head} (${headSha})`);
    console.log(`domain: ${domain.length} reasons x ${PHASES.length} phases = ${domain.length * PHASES.length} cells`);
    console.log(`\n${renderTable(`base @ ${baseSha.slice(0, 8)}`, baseResult, domain)}`);
    console.log(`\n${renderTable(`head @ ${headSha.slice(0, 8)}`, headResult, domain)}`);
    console.log(`\n### diff (${differences.length} differing cells)\n`);
    if (differences.length === 0) {
      console.log('_no differences_');
    } else {
      console.log('| exit_reason | phase | base | head | named? |');
      console.log('|---|---|---|---|---|');
      for (const d of differences) {
        console.log(`| \`${d.exit_reason}\` | ${d.phase} | \`${d.before}\` | \`${d.after}\` | ${namedFor(d) ? 'YES' : '**NO**'} |`);
      }
      console.log('\n### named differences (evidence)\n');
      for (const n of NAMED_DIFFERENCES) console.log(`- \`${n.exit_reason}\`: ${n.evidence}`);
    }
  }

  for (const d of unnamed) {
    console.error(`exit-reason-parity: UNNAMED difference: ${d.exit_reason} x ${d.phase}: "${d.before}" -> "${d.after}"`);
  }
  for (const s of stale) {
    console.error(`exit-reason-parity: STALE named difference (declared, did not occur): ${s.exit_reason} x ${s.phase}`);
  }

  if (!report.ok) {
    console.error(`exit-reason-parity: FAIL (${unnamed.length} unnamed, ${stale.length} stale)`);
    return 1;
  }
  if (!opts.json && !opts.quiet) {
    console.log(`\nexit-reason-parity: OK -- ${differences.length} difference(s), all named with evidence.`);
  }
  return 0;
}

let exitCode = 1;
try {
  exitCode = main();
} finally {
  cleanupMaterialized();
}
process.exit(exitCode);
