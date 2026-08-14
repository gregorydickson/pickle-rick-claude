#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const GIT_TIMEOUT_MS = 5000;

export function resolveDataRoot() {
  if (process.env.PICKLE_DATA_ROOT) return process.env.PICKLE_DATA_ROOT;
  if (process.env.PICKLE_DATA_DIR) return process.env.PICKLE_DATA_DIR;
  return path.join(os.homedir(), '.local/share/pickle-rick');
}

function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return match ? match[1] : '';
}

function readScalar(frontmatter, key) {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter);
  if (!match) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function findTicketFiles(dataRoot) {
  const sessionsDir = path.join(dataRoot, 'sessions');
  const files = [];
  let sessionDirs;
  try {
    sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const sessionEnt of sessionDirs) {
    if (!sessionEnt.isDirectory()) continue;
    const sessionPath = path.join(sessionsDir, sessionEnt.name);
    let ticketDirs;
    try {
      ticketDirs = fs.readdirSync(sessionPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ticketEnt of ticketDirs) {
      if (!ticketEnt.isDirectory()) continue;
      const ticketDir = path.join(sessionPath, ticketEnt.name);
      let ticketFiles;
      try {
        ticketFiles = fs.readdirSync(ticketDir);
      } catch {
        continue;
      }
      for (const f of ticketFiles) {
        if (/^rick_ticket_.*\.md$/.test(f)) {
          files.push({ session: sessionEnt.name, path: path.join(ticketDir, f) });
        }
      }
    }
  }
  return files;
}

function checkBranchReachability(workingDir, sha) {
  if (!workingDir || !fs.existsSync(workingDir)) {
    return { branch_reachable: 'unmeasurable', note: 'working_dir missing — cannot verify' };
  }
  const catFile = spawnSync('git', ['-C', workingDir, 'cat-file', '-e', `${sha}^{commit}`], {
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf-8',
  });
  if (catFile.status !== 0) {
    return { branch_reachable: 'unmeasurable', note: 'commit not found in repo' };
  }
  const branchCheck = spawnSync('git', ['-C', workingDir, 'branch', '--contains', sha], {
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf-8',
  });
  if (branchCheck.status !== 0) {
    return { branch_reachable: 'unmeasurable', note: 'git branch --contains failed' };
  }
  const reachable = branchCheck.stdout.trim().length > 0;
  return { branch_reachable: reachable ? 'reachable' : 'unreachable', note: '' };
}

export function runCensus(dataRoot) {
  const ticketFiles = findTicketFiles(dataRoot);
  const rows = [];
  let unmeasurableCount = 0;

  for (const { session, path: ticketPath } of ticketFiles) {
    let content;
    try {
      content = fs.readFileSync(ticketPath, 'utf-8');
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(content);
    const workerGateVerdict = readScalar(frontmatter, 'worker_gate_verdict');
    const workerGateTestsVerdict = readScalar(frontmatter, 'worker_gate_tests_verdict');

    if (workerGateVerdict !== 'green' || workerGateTestsVerdict !== 'red') continue;

    const ticketId = readScalar(frontmatter, 'id') ?? path.basename(ticketPath);
    const completionCommit = readScalar(frontmatter, 'completion_commit') ?? null;
    const workingDir = readScalar(frontmatter, 'working_dir') ?? null;

    let reachability;
    if (!completionCommit) {
      reachability = { branch_reachable: 'unmeasurable', note: 'no completion_commit recorded' };
    } else {
      reachability = checkBranchReachability(workingDir, completionCommit);
    }
    if (reachability.branch_reachable === 'unmeasurable') unmeasurableCount += 1;

    rows.push({
      ticket_id: ticketId,
      session,
      completion_commit: completionCommit,
      worker_gate_verdict: workerGateVerdict,
      worker_gate_tests_verdict: workerGateTestsVerdict,
      branch_reachable: reachability.branch_reachable,
      note: reachability.note,
    });
  }

  return {
    rows,
    scanned_session_count: new Set(ticketFiles.map((t) => t.session)).size,
    unmeasurable_count: unmeasurableCount,
  };
}

export function formatReportMarkdown(result) {
  const lines = [];
  lines.push('# Corpus census — worker_gate_tests_verdict: red under worker_gate_verdict: green');
  lines.push('');
  lines.push(
    `Scanned ${result.scanned_session_count} session dir(s); found ${result.rows.length} affected ticket(s); ${result.unmeasurable_count} row(s) unmeasurable.`,
  );
  lines.push('');
  lines.push(
    '**Note:** a red test verdict does NOT by itself prove the commit is bad — only that it was never verified.',
  );
  lines.push(
    '**Note:** this census covers only surviving session dirs under the current data root; pruned/deleted session state (e.g. older `state.json` files) is not represented, so the true historical count is unmeasurable and certainly higher.',
  );
  lines.push('');
  lines.push('| Ticket | Session | Completion Commit | Gate Verdict | Tests Verdict | Branch Reachable | Note |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of result.rows) {
    lines.push(
      `| ${row.ticket_id} | ${row.session} | ${row.completion_commit ?? '(none)'} | ${row.worker_gate_verdict} | ${row.worker_gate_tests_verdict} | ${row.branch_reachable} | ${row.note} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'census-worker-gate-red-tests.js') {
  const args = process.argv.slice(2);
  let dataRootOverride = null;
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--data-root') dataRootOverride = args[++i];
    else if (args[i] === '--out') outPath = args[++i];
  }
  const dataRoot = dataRootOverride ?? resolveDataRoot();
  const result = runCensus(dataRoot);
  const report = formatReportMarkdown(result);
  if (outPath) {
    fs.writeFileSync(outPath, report);
  } else {
    process.stdout.write(report);
  }
}
