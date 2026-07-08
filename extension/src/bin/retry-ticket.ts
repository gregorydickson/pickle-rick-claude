#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionRoot, extractFrontmatter, updateState, safeErrorMessage, findSessionPathForCwd, clearTicketResolutionTimestamps, getTicketStatus } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { State, Defaults, ARTIFACT_PREFIXES } from '../types/index.js';

const sm = new StateManager();

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function normalizeTicketStatus(status: string | null): string {
  return (status || '').toLowerCase().replace(/["']/g, '').trim();
}

function isLifecycleArtifact(fileName: string): boolean {
  return Object.values(ARTIFACT_PREFIXES).some((prefixes) =>
    prefixes.some((prefix) => fileName === `${prefix}.md` || fileName.startsWith(`${prefix}_`))
  );
}

export function retryTicket(ticketId: string, cwd: string): void {
  // Validate ticketId to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }

  const sessionPath = findSessionPathForCwd(cwd);
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    throw new Error('No active session found for this directory.');
  }

  const statePath = path.join(sessionPath, 'state.json');
  try {
    sm.read(statePath);
  } catch {
    throw new Error(`state.json is corrupt or unreadable in ${sessionPath}`);
  }
  const sessionDir = sessionPath;

  const ticketDir = path.join(sessionDir, ticketId);
  const ticketFile = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  if (!fs.existsSync(ticketDir) || !fs.existsSync(ticketFile)) {
    throw new Error(`Ticket ${ticketId} not found in session ${sessionDir}`);
  }

  // Archive partial artifacts
  const artifacts = fs.readdirSync(ticketDir).filter(isLifecycleArtifact);
  if (artifacts.length > 0) {
    const archiveDir = path.join(ticketDir, `_retry_${Date.now()}`);
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const artifact of artifacts) {
      fs.renameSync(path.join(ticketDir, artifact), path.join(archiveDir, artifact));
    }
    console.log(`📦 Archived ${artifacts.length} artifact(s) to ${path.basename(archiveDir)}/`);
  }

  // Reset ticket status to Todo — scope replacement to YAML frontmatter only
  const ticketContent = fs.readFileSync(ticketFile, 'utf-8');
  const fmResult = extractFrontmatter(ticketContent);
  let updatedContent: string;
  if (fmResult) {
    const fmSection = ticketContent.slice(0, fmResult.end).replace(/^status:.*$/m, 'status: "Todo"');
    updatedContent = clearTicketResolutionTimestamps(fmSection) + ticketContent.slice(fmResult.end);
  } else {
    updatedContent = ticketContent.replace(/^status:.*$/m, 'status: "Todo"');
  }
  const tmpTicket = ticketFile + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpTicket, updatedContent);
    fs.renameSync(tmpTicket, ticketFile);
  } catch (err) {
    try { fs.unlinkSync(tmpTicket); } catch { /* ignore cleanup failure */ }
    throw err;
  }
  if (normalizeTicketStatus(getTicketStatus(sessionDir, ticketId)) !== 'todo') {
    throw new Error(`Ticket ${ticketId} did not reset to Todo in ${sessionDir}`);
  }

  // Re-activate session and set current ticket
  sm.update(statePath, s => {
    s.active = true;
    s.session_dir = sessionPath;
  });
  updateState('current_ticket', ticketId, sessionDir);

  // Read final state for timeout/prompt values
  let finalState: State;
  try {
    finalState = sm.read(statePath);
  } catch {
    throw new Error(`state.json became unreadable after update in ${sessionPath}`);
  }
  const timeout = positiveIntegerOrDefault(finalState.worker_timeout_seconds, Defaults.WORKER_TIMEOUT_SECONDS);

  // Shell-safe escaping: single-quote escaping + collapse newlines to spaces
  const safePrompt = (finalState.original_prompt || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/'/g, "'\\''");

  // Task is first positional arg (spawn-morty.js:13 expects args[0] as task)
  // Use single-quoting for sessionDir to prevent shell expansion of $, `, etc.
  const safeSessionDir = sessionDir.replace(/'/g, "'\\''");
  const spawnCmd = `node "${getExtensionRoot()}/extension/bin/spawn-morty.js" '${safePrompt}' --ticket-id '${ticketId}' --ticket-path '${safeSessionDir}/${ticketId}/' --ticket-file '${safeSessionDir}/${ticketId}/rick_ticket_${ticketId}.md' --timeout ${timeout}`;
  console.log(`\n✅ Ticket ${ticketId} reset to Todo. Run this command to re-spawn Morty:\n\n${spawnCmd}\n`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'retry-ticket.js') {
  const ticketId = process.argv[2];
  if (!ticketId) {
    console.error('Usage: node retry-ticket.js <ticket-id>');
    process.exit(1);
  }
  try {
    retryTicket(ticketId, process.cwd());
  } catch (err) {
    console.error(safeErrorMessage(err));
    process.exit(1);
  }
}
