#!/usr/bin/env node
// B-OFFREPO ticket 40 (69cdb73b) — emits prds/research/offrepo-field-result.json from a REAL
// execution of the off-repo worker gate against self-created, non-pickle-rick fixtures.
//
// This script must never be run against a real sibling repo: every fixture is a temp dir this
// script creates and destroys. The output is transcribed from what `runWorkerGate` (the actual
// deployed entry point, `extension/bin/spawn-morty.js`) and `detectProjectType` (the actual
// deployed project-type resolver, `extension/services/convergence-gate.js`) report and leave on
// disk — never hand-typed.
//
// Usage: node extension/scripts/emit-offrepo-field-result.mjs   (run from the repo root or
// extension/; output path is resolved relative to this file, not to cwd)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { runWorkerGate } from '../bin/spawn-morty.js';
import { detectProjectType } from '../services/convergence-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'prds', 'research', 'offrepo-field-result.json');
const DIMENSIONS = ['typecheck', 'lint', 'test'];

const tmpRoots = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offrepo-field-'));
  tmpRoots.push(dir);
  return fs.realpathSync(dir);
}

function cleanup() {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function writeState(root) {
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 5,
    working_dir: root,
    session_dir: root,
    active: true,
    activity: [],
  }));
  return statePath;
}

function writeTicket(root, ticketId) {
  const dir = path.join(root, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: In Progress\n---\n# t\n`,
  );
}

function frontmatterField(root, ticketId, field) {
  const raw = fs.readFileSync(path.join(root, ticketId, `rick_ticket_${ticketId}.md`), 'utf8');
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

/** A probe script that writes a `<name>.ran` side-effect file BEFORE exiting, so its execution
 * is verifiable from disk state rather than merely from the gate's returned verdict. */
function probeScript(name, exitCode) {
  return `node -e "require('fs').writeFileSync('${name}.ran','1');process.exit(${exitCode})"`;
}

function makeFixture(label, { scripts, withPackageJson = true } = {}) {
  const root = makeTmp();
  if (withPackageJson) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: `offrepo-field-${label}`,
      version: '1.0.0',
      scripts: scripts ?? {},
    }, null, 2));
  }
  return root;
}

async function runFixture(label, workingDir) {
  const slug = label.replace(/[^a-z0-9]/gi, '');
  const ticketId = `f${slug}`.padEnd(8, '0').slice(0, 8);
  writeState(workingDir);
  writeTicket(workingDir, ticketId);
  const statePath = path.join(workingDir, 'state.json');

  await runWorkerGate([], {
    workingDir,
    ticketId,
    statePath,
    preWorkerHead: null,
  });

  const verdict = frontmatterField(workingDir, ticketId, 'worker_gate_verdict') ?? 'not_run';
  const projectType = detectProjectType(workingDir);
  const checksRun = DIMENSIONS.filter(dim => fs.existsSync(path.join(workingDir, `${dim}.ran`)));

  return {
    label,
    working_dir: workingDir,
    project_type: projectType,
    gate_executed: projectType !== null,
    checks_run: checksRun,
    verdict,
  };
}

async function main() {
  const records = [];

  // 1. fully-green: a real npm project, all three checks pass.
  {
    const root = makeFixture('fully-green', {
      scripts: {
        typecheck: probeScript('typecheck', 0),
        lint: probeScript('lint', 0),
        test: probeScript('test', 0),
      },
    });
    records.push(await runFixture('fully-green', root));
  }

  // 2. target-red: the project's own test suite genuinely fails.
  {
    const root = makeFixture('target-red', {
      scripts: {
        typecheck: probeScript('typecheck', 0),
        lint: probeScript('lint', 0),
        test: probeScript('test', 1),
      },
    });
    records.push(await runFixture('target-red', root));
  }

  // 3. missing-scripts: package.json resolves a project type, but declares none of the three
  // checks — each dimension is `not_run` (ENOENT/"Missing script"), not a failure.
  {
    const root = makeFixture('missing-scripts', { scripts: { build: 'echo noop' } });
    records.push(await runFixture('missing-scripts', root));
  }

  // 4. no-manifest: nothing for detectProjectType to resolve at all.
  {
    const root = makeFixture('no-manifest', { withPackageJson: false });
    records.push(await runFixture('no-manifest', root));
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(records, null, 2)}\n`);

  console.log(`Wrote ${records.length} records to ${OUTPUT_PATH}`);
  for (const r of records) {
    console.log(`  ${r.label}: project_type=${r.project_type} gate_executed=${r.gate_executed} checks_run=[${r.checks_run.join(',')}] verdict=${r.verdict}`);
  }

  cleanup();
}

main().catch(err => {
  cleanup();
  console.error(err);
  process.exit(1);
});
