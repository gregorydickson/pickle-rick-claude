import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  StateManager,
  acquireLockFile,
  reclaimDeadLock,
  releaseLockFile,
} from './state-manager.js';
import type { ActivityLogEntry, State } from '../types/index.js';

export type TicketStatus = 'Todo' | 'In Progress' | 'Done' | 'Skipped' | string;

export interface TicketTransactionContext {
  now?: Date | string;
}

export interface PlannedFileWrite {
  path: string;
  content: string;
}

export type PlannedTicketWrite = PlannedFileWrite;

export interface MaterializeTicketFileSpec {
  path?: string;
  name?: string;
  content: string;
}

export interface MaterializeTicketSpec {
  ticketId: string;
  sessionDir?: string;
  sessionRoot?: string;
  dirPath?: string;
  ticketFileName?: string;
  content?: string;
  files?: MaterializeTicketFileSpec[];
  frontmatter?: Record<string, string | number | boolean | null>;
  body?: string;
}

export interface MaterializedTicketPlan {
  dirPath: string;
  files: PlannedFileWrite[];
}

export type ReverseLedgerEntry =
  | {
      action: 'create' | 'created';
      path: string;
    }
  | {
      action: 'write' | 'update' | 'delete' | 'deleted';
      path: string;
      beforeContent?: string | null;
      previousContent?: string | null;
      backupContent?: string | null;
    };

export interface ReverseLedger {
  entries?: ReverseLedgerEntry[];
  actions?: ReverseLedgerEntry[];
  steps?: ReverseLedgerEntry[];
}

export type CourseCorrectionBranch = 'a' | 'b' | 'c';
export type CourseCorrectionRecoveryClass = 'delete-created' | 'restore-previous-content';

export interface CourseCorrectionApplyLedgerEntry {
  step: number;
  action: 'create' | 'write';
  operation: 'add_ticket' | 'kill_ticket';
  ticket_id: string;
  path: string;
  status: 'started' | 'applied' | 'failed' | 'reversed';
  recovery_class: CourseCorrectionRecoveryClass;
  beforeContent?: string | null;
  previousContent?: string | null;
  afterContent?: string;
  content?: string;
  error?: string;
  createdAt: string;
}

export interface ApplyCourseCorrectionRestructureInput {
  sessionRoot: string;
  proposalPath: string;
  restartTicketId: string | null;
  killedTicketIds?: string[];
  addedTickets?: MaterializeTicketSpec[];
  now?: Date | string;
  stateManager?: StateManager;
  ledgerPath?: string;
  autoApply?: boolean;
}

export interface ApplyCourseCorrectionRestructureResult {
  ledgerPath: string;
  branch: CourseCorrectionBranch;
  ticketsVersion: number;
  appliedSteps: number;
}

export type CourseCorrectionRecoveryMode = 'reverse' | 'forward';

export interface RecoverCourseCorrectionInput {
  sessionRoot: string;
  ledgerPath?: string;
  mode: CourseCorrectionRecoveryMode;
  force?: boolean;
  now?: Date | string;
  stateManager?: StateManager;
}

export interface RecoverCourseCorrectionResult {
  ledgerPath: string;
  mode: CourseCorrectionRecoveryMode;
  lastSuccessfulStep: number;
  recoveredSteps: number[];
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertWithinRoot(targetPath: string, rootPath: string): string {
  if (!isWithinRoot(targetPath, rootPath)) {
    throw new Error(`Path escapes ticket transaction root: ${targetPath}`);
  }
  return targetPath;
}

function resolveTicketDir(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, ticketId);
}

function findRickTicketFile(ticketDir: string): string {
  const ticketFile = fs
    .readdirSync(ticketDir)
    .find(file => file.startsWith('rick_ticket_') && file.endsWith('.md'));
  if (!ticketFile) throw new Error(`No rick ticket file found in ${ticketDir}`);
  return path.join(ticketDir, ticketFile);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFrontmatter(content: string): { body: string; start: number; end: number } | null {
  const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
  if (openLen === 0) return null;
  const closeIdx = content.indexOf('\n---', openLen);
  if (closeIdx === -1) return null;
  const rawEnd = closeIdx + 4;
  const end = content[rawEnd] === '\n'
    ? rawEnd + 1
    : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n'
      ? rawEnd + 2
      : rawEnd;
  return { body: content.slice(openLen, closeIdx), start: 0, end };
}

function setFrontmatterField(content: string, field: string, value: string): string {
  const fm = extractFrontmatter(content);
  if (!fm) return content;

  const existingField = new RegExp(`^${escapeRegExp(field)}:\\s*.*$`, 'm');
  if (existingField.test(fm.body)) {
    return content.replace(existingField, `${field}: "${value}"`);
  }

  const closingNewline = content.lastIndexOf('\n---', fm.end - 1);
  if (closingNewline === -1) return content;
  const insertPoint = closingNewline + 1;
  return content.slice(0, insertPoint) + `${field}: "${value}"\n` + content.slice(insertPoint);
}

function statusTimestampField(status: TicketStatus): 'completed_at' | 'skipped_at' | null {
  const normalized = String(status).toLowerCase();
  if (normalized === 'done') return 'completed_at';
  if (normalized === 'skipped') return 'skipped_at';
  return null;
}

function timestamp(ctx?: TicketTransactionContext): string {
  if (ctx?.now instanceof Date) return ctx.now.toISOString();
  if (typeof ctx?.now === 'string') return ctx.now;
  return new Date().toISOString();
}

function assertStatusWasUpdated(before: string, after: string, filePath: string): void {
  if (before === after) {
    throw new Error(`Ticket status could not be updated in ${filePath}`);
  }
}

export function updateTicketStatusInTransaction(
  ticketId: string,
  newStatus: TicketStatus,
  sessionDir: string,
  txCtx?: TicketTransactionContext,
): PlannedTicketWrite {
  const ticketDir = resolveTicketDir(sessionDir, ticketId);
  const filePath = findRickTicketFile(ticketDir);
  const content = fs.readFileSync(filePath, 'utf-8');
  let updated = content.replace(/^(status:\s*).*$/m, `$1"${newStatus}"`);
  assertStatusWasUpdated(content, updated, filePath);

  const timestampField = statusTimestampField(newStatus);
  if (timestampField) {
    updated = setFrontmatterField(updated, timestampField, timestamp(txCtx));
  }

  return { path: filePath, content: updated };
}

function defaultTicketContent(spec: MaterializeTicketSpec): string {
  const frontmatter = {
    id: spec.ticketId,
    status: 'Todo',
    ...spec.frontmatter,
  };
  const lines = Object.entries(frontmatter).map(([key, value]) => {
    if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`;
    if (value === null) return `${key}: null`;
    return `${key}: "${value}"`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${spec.body ?? ''}`;
}

export function materializeNewTicket(spec: MaterializeTicketSpec): MaterializedTicketPlan {
  const root = spec.dirPath ?? path.join(spec.sessionDir ?? spec.sessionRoot ?? '', spec.ticketId);
  if (!root || root === spec.ticketId) {
    throw new Error('materializeNewTicket requires dirPath, sessionDir, or sessionRoot');
  }

  const files = spec.files && spec.files.length > 0
    ? spec.files
    : [{
        name: spec.ticketFileName ?? `rick_ticket_${spec.ticketId}.md`,
        content: spec.content ?? defaultTicketContent(spec),
      }];

  return {
    dirPath: root,
    files: files.map(file => ({
      path: assertWithinRoot(
        file.path ?? path.join(root, file.name ?? `rick_ticket_${spec.ticketId}.md`),
        root,
      ),
      content: file.content,
    })),
  };
}

function resolveLedgerEntries(parsed: ReverseLedger | ReverseLedgerEntry[]): ReverseLedgerEntry[] {
  if (Array.isArray(parsed)) return parsed;
  return parsed.entries ?? parsed.actions ?? parsed.steps ?? [];
}

function parseLedgerContent(raw: string): ReverseLedgerEntry[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n'))) {
    return resolveLedgerEntries(JSON.parse(trimmed) as ReverseLedger | ReverseLedgerEntry[]);
  }
  return trimmed
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as ReverseLedgerEntry);
}

function parseApplyLedgerContent(raw: string): CourseCorrectionApplyLedgerEntry[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parsed = trimmed.startsWith('[')
    ? JSON.parse(trimmed) as CourseCorrectionApplyLedgerEntry[]
    : trimmed
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as CourseCorrectionApplyLedgerEntry);
  return parsed.filter(entry => Number.isInteger(entry.step) && typeof entry.path === 'string');
}

function resolveLedgerPath(sessionRoot: string, entryPath: string): string {
  const targetPath = path.isAbsolute(entryPath) ? entryPath : path.join(sessionRoot, entryPath);
  return assertWithinRoot(targetPath, sessionRoot);
}

/** Minimal shape both ledger entry kinds satisfy at the reversal decision. */
type ContentBearingLedgerEntry = {
  action?: string;
  beforeContent?: string | null;
  previousContent?: string | null;
  backupContent?: string | null;
};

function restoreContent(entry: ContentBearingLedgerEntry): string | null | undefined {
  if ('beforeContent' in entry) return entry.beforeContent;
  if ('previousContent' in entry) return entry.previousContent;
  if ('backupContent' in entry) return entry.backupContent;
  return undefined;
}

type LedgerReversal =
  | { kind: 'delete' }
  | { kind: 'restore'; content: string }
  | { kind: 'unrestorable' };

/**
 * AP-EXT-ITER8-02: the reversal decision comes from the entry's `action`
 * discriminant, NEVER from "prior content is null/absent". Only an entry that
 * says the apply CREATED the file may delete it; everything else restores, and
 * a non-create entry with no recorded content is unrestorable — leave it alone
 * rather than destroying a file that pre-dated the transaction.
 */
function planReversal(entry: ContentBearingLedgerEntry): LedgerReversal {
  if (entry.action === 'create' || entry.action === 'created') return { kind: 'delete' };
  const priorContent = restoreContent(entry);
  if (typeof priorContent === 'string') return { kind: 'restore', content: priorContent };
  return { kind: 'unrestorable' };
}

function warnUnrestorable(targetPath: string): void {
  process.stderr.write(
    `[transaction-ticket-ops] ledger entry for ${targetPath} records no prior content under a non-create action; leaving the file in place\n`,
  );
}

function removeEmptyParents(startDir: string, stopDir: string): void {
  let current = startDir;
  while (isWithinRoot(current, stopDir) && path.resolve(current) !== path.resolve(stopDir)) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export function replayReverseLedger(ledgerPath: string, sessionRoot: string): PlannedFileWrite[] {
  const entries = parseLedgerContent(fs.readFileSync(ledgerPath, 'utf-8'));
  const restored: PlannedFileWrite[] = [];

  for (const entry of [...entries].reverse()) {
    const targetPath = resolveLedgerPath(sessionRoot, entry.path);
    const reversal = planReversal(entry);

    if (reversal.kind === 'delete') {
      if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true, recursive: true });
      removeEmptyParents(path.dirname(targetPath), sessionRoot);
      continue;
    }

    if (reversal.kind === 'unrestorable') {
      warnUnrestorable(targetPath);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, reversal.content);
    restored.push({ path: targetPath, content: reversal.content });
  }

  return restored;
}

function timestampForLedger(now?: Date | string): string {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'string') return now;
  return new Date().toISOString();
}

function proposalApplyLedgerPath(sessionRoot: string, proposalPath: string): string {
  const base = path.basename(proposalPath).replace(/\.md$/i, '');
  return path.join(sessionRoot, `${base}_apply.log`);
}

function latestApplyLedgerPath(sessionRoot: string): string {
  const ledgers = fs
    .readdirSync(sessionRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^change_proposal_.*_apply\.log$/.test(entry.name))
    .map(entry => {
      const filePath = path.join(sessionRoot, entry.name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath));
  if (ledgers.length === 0) throw new Error(`No course-correction apply ledger found in ${sessionRoot}`);
  return ledgers[0].filePath;
}

/**
 * Reclaims the restructure lock from a holder we can PROVE is dead — never an age verdict: a
 * restructure legitimately holds while it rewrites every ticket in the session, so an age arm
 * (the one `withRetryLock` carries) would evict a LIVE holder mid-transaction. Both rules live in
 * the shared `reclaimDeadLock` composition this delegates to.
 */
function reclaimDeadRestructureLock(lockFile: string): void {
  reclaimDeadLock(lockFile);
}

function acquireFileLock(lockFile: string): () => void {
  // Payload is the BARE holder pid — the one encoding `isDeadPidPayload` reads. The prior
  // `{pid,ts}` JSON parsed to NaN there, so any steal bolted onto it would silently never fire.
  let acquired = acquireLockFile(lockFile, String(process.pid));
  if (acquired === null) {
    reclaimDeadRestructureLock(lockFile);
    acquired = acquireLockFile(lockFile, String(process.pid));
  }
  if (acquired === null) {
    const err = new Error(`EEXIST: restructure lock is held, open '${lockFile}'`) as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    err.path = lockFile;
    throw err;
  }

  // Release is identity-bound: a lock we no longer own (ours was stolen) is left for its new holder.
  const held = acquired;
  return () => { releaseLockFile(lockFile, held); };
}

function appendApplyLedger(ledgerPath: string, entry: CourseCorrectionApplyLedgerEntry): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectTicketDirectoryIds(sessionRoot: string): string[] {
  return fs
    .readdirSync(sessionRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

function resolveCurrentTicketBranch(state: State, killedSet: Set<string>, addedSet: Set<string>): CourseCorrectionBranch {
  const current = state.current_ticket;
  if (current && killedSet.has(current)) return 'a';
  if (current && addedSet.has(current)) return 'c';
  return 'b';
}

function resolveAddedCurrentTicket(state: State, addedSet: Set<string>): string | null {
  const current = state.current_ticket;
  if (current && addedSet.has(current)) return current;
  return null;
}

function appendActivity(state: State, entry: ActivityLogEntry): void {
  const existing = Array.isArray(state.activity) ? state.activity : [];
  state.activity = [...existing, entry];
}

function applyPlannedWrite(
  ledgerPath: string,
  step: number,
  operation: 'add_ticket' | 'kill_ticket',
  ticketId: string,
  file: PlannedFileWrite,
  nowIso: string,
): void {
  assertWithinRoot(file.path, path.dirname(ledgerPath));
  const existed = fs.existsSync(file.path);
  let beforeContent: string | null = null;
  let beforeReadError: string | null = null;
  if (existed) {
    try {
      beforeContent = fs.readFileSync(file.path, 'utf-8');
    } catch (error) {
      beforeReadError = safeErrorMessage(error);
    }
  }
  const action = existed ? 'write' : 'create';
  const ledgerEntry = (
    status: CourseCorrectionApplyLedgerEntry['status'],
    error?: string,
  ): CourseCorrectionApplyLedgerEntry => ({
    step,
    action,
    operation,
    ticket_id: ticketId,
    path: file.path,
    status,
    recovery_class: existed ? 'restore-previous-content' : 'delete-created',
    beforeContent,
    previousContent: beforeContent,
    afterContent: file.content,
    content: file.content,
    ...(error !== undefined ? { error } : {}),
    createdAt: nowIso,
  });

  // AP-EXT-ITER8-02: an existing file we could not read has no recoverable prior
  // content, so overwriting it is unreversible. Refuse the write instead of
  // recording a `beforeContent: null` the reversal cannot honor.
  if (beforeReadError !== null) {
    const message = `Refusing to overwrite ${file.path}: prior content is unreadable (${beforeReadError})`;
    appendApplyLedger(ledgerPath, ledgerEntry('failed', message));
    throw new Error(message);
  }

  appendApplyLedger(ledgerPath, ledgerEntry('started'));
  try {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content, 'utf-8');
  } catch (error) {
    appendApplyLedger(ledgerPath, ledgerEntry('failed', safeErrorMessage(error)));
    throw error;
  }
  appendApplyLedger(ledgerPath, ledgerEntry('applied'));
}

function writeHaltFile(sessionRoot: string, ledgerPath: string, failedStep: number, cause: string, nowIso: string): string {
  const haltPath = path.join(sessionRoot, `HALT_${isoSafeStamp(nowIso)}.md`);
  const content = [
    '# Course Correction Apply Halted',
    '',
    `Failed step: ${failedStep}`,
    `Cause: ${cause}`,
    `Ledger path: ${ledgerPath}`,
    '',
    '## Recovery Options',
    '',
    '1. Run `/pickle-correct-course --recover-from-ledger` to replay-reverse the partial apply.',
    '2. Run `/pickle-correct-course --recover --force` to forward-replay the ledger after fixing a transient cause.',
    '3. Run `/pickle-status --reset-current-ticket` to abandon this correction and force ticket selection.',
    '',
    '## If You Do Nothing',
    '',
    'The runner remains halted at the next iteration boundary until an operator chooses a recovery option.',
    '',
  ].join('\n');
  fs.writeFileSync(haltPath, content, 'utf-8');
  return haltPath;
}

function isoSafeStamp(nowIso: string): string {
  return nowIso.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function appendStateActivity(sessionRoot: string, stateManager: StateManager, entry: ActivityLogEntry): void {
  const statePath = path.join(sessionRoot, 'state.json');
  if (!fs.existsSync(statePath)) return;
  stateManager.update(statePath, (state) => {
    appendActivity(state, entry);
  });
}

function lastSuccessfulStep(entries: CourseCorrectionApplyLedgerEntry[]): number {
  return entries.reduce((max, entry) => entry.status === 'applied' ? Math.max(max, entry.step) : max, 0);
}

function reverseAppliedEntries(entries: CourseCorrectionApplyLedgerEntry[], sessionRoot: string): number[] {
  const reversedSteps: number[] = [];
  for (const entry of [...selectForwardEntries(entries)].reverse()) {
    const targetPath = resolveLedgerPath(sessionRoot, entry.path);
    const reversal = planReversal(entry);
    if (reversal.kind === 'delete') {
      if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true, recursive: true });
      removeEmptyParents(path.dirname(targetPath), sessionRoot);
    } else if (reversal.kind === 'unrestorable') {
      warnUnrestorable(targetPath);
      continue;
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, reversal.content, 'utf-8');
    }
    reversedSteps.push(entry.step);
  }
  return reversedSteps;
}

function selectForwardEntries(entries: CourseCorrectionApplyLedgerEntry[]): CourseCorrectionApplyLedgerEntry[] {
  const byStep = new Map<number, CourseCorrectionApplyLedgerEntry>();
  for (const entry of entries) {
    if (entry.status === 'started' || entry.status === 'applied' || entry.status === 'failed') {
      byStep.set(entry.step, entry);
    }
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

function forwardReplayEntries(entries: CourseCorrectionApplyLedgerEntry[], sessionRoot: string): number[] {
  const replayedSteps: number[] = [];
  for (const entry of selectForwardEntries(entries)) {
    const nextContent = entry.afterContent ?? entry.content;
    if (nextContent === undefined) {
      throw new Error(`Ledger step ${entry.step} is missing replay content`);
    }
    const targetPath = resolveLedgerPath(sessionRoot, entry.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, nextContent, 'utf-8');
    replayedSteps.push(entry.step);
  }
  return replayedSteps;
}

export function recoverCourseCorrectionFromLedger(input: RecoverCourseCorrectionInput): RecoverCourseCorrectionResult {
  const sessionRoot = path.resolve(input.sessionRoot);
  const ledgerPath = assertWithinRoot(input.ledgerPath ? path.resolve(input.ledgerPath) : latestApplyLedgerPath(sessionRoot), sessionRoot);
  const nowIso = timestampForLedger(input.now);
  const stateManager = input.stateManager ?? new StateManager();
  const releaseRestructureLock = acquireFileLock(path.join(sessionRoot, 'restructure.lock'));

  try {
    const entries = parseApplyLedgerContent(fs.readFileSync(ledgerPath, 'utf-8'));
    const lastStep = lastSuccessfulStep(entries);
    if (input.mode === 'forward' && !input.force) {
      throw new Error('--recover requires --force for forward ledger replay');
    }
    const recoveredSteps = input.mode === 'reverse'
      ? reverseAppliedEntries(entries, sessionRoot)
      : forwardReplayEntries(entries, sessionRoot);

    appendStateActivity(sessionRoot, stateManager, {
      event: 'course_correct_recovered',
      timestamp: nowIso,
      mode: input.mode,
      ledger_path: ledgerPath,
      last_successful_step: lastStep,
      recovered_steps: recoveredSteps,
    });
    return { ledgerPath, mode: input.mode, lastSuccessfulStep: lastStep, recoveredSteps };
  } finally {
    releaseRestructureLock();
  }
}

function latestFailedEntry(ledgerPath: string): CourseCorrectionApplyLedgerEntry | undefined {
  if (!fs.existsSync(ledgerPath)) return undefined;
  const entries = parseApplyLedgerContent(fs.readFileSync(ledgerPath, 'utf-8'));
  return entries.filter(entry => entry.status === 'failed').at(-1);
}

/**
 * R-CNAR-8: single source of truth for the per-ticket cache fields that MUST be
 * cleared atomically whenever a course-correction transition re-points
 * `current_ticket`. Stale values here let the new ticket inherit the killed
 * ticket's tier/budget/max-iter and skew budget calculations. Kept local
 * (mirrors the private helper in state-manager.ts) — importing pickle-utils'
 * canonical `clearTicketCacheFields` here would create a new
 * transaction-ticket-ops → pickle-utils module cycle.
 */
function clearCurrentTicketCache(s: State): void {
  delete s.current_ticket_tier;
  delete s.current_ticket_budget;
  delete s.current_ticket_max_iterations;
  delete s.current_ticket_worker_timeout_seconds;
  delete s.current_ticket_budget_start_iteration;
}

interface CourseCorrectionApplyContext {
  sessionRoot: string;
  ledgerPath: string;
  nowIso: string;
  proposalPath: string;
  restartTicketId: string | null;
  killedTicketIds: string[];
  addedTickets: MaterializeTicketSpec[];
  killedSet: Set<string>;
  addedSet: Set<string>;
}

function buildApplyContext(input: ApplyCourseCorrectionRestructureInput): CourseCorrectionApplyContext {
  const sessionRoot = path.resolve(input.sessionRoot);
  const killedTicketIds = input.killedTicketIds ?? [];
  const addedTickets = input.addedTickets ?? [];
  return {
    sessionRoot,
    ledgerPath: assertWithinRoot(
      input.ledgerPath ? path.resolve(input.ledgerPath) : proposalApplyLedgerPath(sessionRoot, input.proposalPath),
      sessionRoot,
    ),
    nowIso: timestampForLedger(input.now),
    proposalPath: input.proposalPath,
    restartTicketId: input.restartTicketId,
    killedTicketIds,
    addedTickets,
    killedSet: new Set(killedTicketIds),
    addedSet: new Set(addedTickets.map(ticket => ticket.ticketId)),
  };
}

/** Kills then adds, numbering every ledger step from one running counter. Returns the step count. */
function applyTicketFileWrites(ctx: CourseCorrectionApplyContext): number {
  const { sessionRoot, ledgerPath, nowIso } = ctx;
  let step = 0;

  for (const ticketId of ctx.killedTicketIds) {
    step += 1;
    const planned = updateTicketStatusInTransaction(ticketId, 'Killed', sessionRoot, { now: nowIso });
    applyPlannedWrite(ledgerPath, step, 'kill_ticket', ticketId, planned, nowIso);
  }

  for (const ticket of ctx.addedTickets) {
    const plan = materializeNewTicket({ ...ticket, sessionRoot });
    for (const file of plan.files) {
      step += 1;
      applyPlannedWrite(ledgerPath, step, 'add_ticket', ticket.ticketId, file, nowIso);
    }
  }

  return step;
}

function applyBranchCurrentTicket(state: State, branch: CourseCorrectionBranch, ctx: CourseCorrectionApplyContext): void {
  // R-CNAR-8: every course-correct current_ticket transition MUST clear the cache
  // fields. Pre-fix, the new ticket inherited tier/budget/max-iter from the killed
  // ticket and skewed budget calculations.
  if (branch === 'a') {
    state.current_ticket = ctx.restartTicketId ?? null;
    clearCurrentTicketCache(state);
    return;
  }
  if (branch !== 'c') return;

  const previousTicket = state.current_ticket;
  const redirectedTicket = resolveAddedCurrentTicket(state, ctx.addedSet);
  state.current_ticket = redirectedTicket;
  clearCurrentTicketCache(state);
  appendActivity(state, {
    event: 'current_ticket_redirected_to_new',
    from_ticket_id: previousTicket,
    to_ticket_id: redirectedTicket,
    ticket_id: redirectedTicket,
    timestamp: ctx.nowIso,
  });
}

/** Bumps tickets_version and records the correction. Call AFTER the writes — after_count reads the new tree. */
function recordCourseCorrectionApplied(
  state: State,
  branch: CourseCorrectionBranch,
  beforeCount: number,
  ctx: CourseCorrectionApplyContext,
): number {
  const currentVersion = typeof state.tickets_version === 'number' && Number.isFinite(state.tickets_version)
    ? state.tickets_version
    : 0;
  const ticketsVersion = currentVersion + 1;

  state.tickets_version = ticketsVersion;
  state.last_course_correction = {
    proposal_path: ctx.proposalPath,
    applied_iso: ctx.nowIso,
    restart_ticket_id: ctx.restartTicketId,
    before_count: beforeCount,
    after_count: collectTicketDirectoryIds(ctx.sessionRoot).length,
  };
  appendActivity(state, {
    event: 'course_corrected',
    timestamp: ctx.nowIso,
    proposal_path: ctx.proposalPath,
    killed_ticket_ids: ctx.killedTicketIds,
    added_ticket_ids: [...ctx.addedSet],
    branch,
    tickets_version: ticketsVersion,
  });
  appendActivity(state, {
    event: 'readiness_delta_requested',
    timestamp: ctx.nowIso,
    reason: 'course_corrected',
    tickets_version: ticketsVersion,
  });

  return ticketsVersion;
}

function rollbackAndHaltApply(
  error: unknown,
  ctx: CourseCorrectionApplyContext,
  stateManager: StateManager,
  autoApply: boolean,
): void {
  const { sessionRoot, ledgerPath, nowIso } = ctx;
  if (fs.existsSync(ledgerPath)) replayReverseLedger(ledgerPath, sessionRoot);

  const failedEntry = latestFailedEntry(ledgerPath);
  if (!autoApply || !failedEntry) return;

  const cause = failedEntry.error ?? safeErrorMessage(error);
  const haltPath = writeHaltFile(sessionRoot, ledgerPath, failedEntry.step, cause, nowIso);
  appendStateActivity(sessionRoot, stateManager, {
    event: 'course_correct_apply_failed',
    timestamp: nowIso,
    failed_step: failedEntry.step,
    cause,
    ledger_path: ledgerPath,
    halt_path: haltPath,
  });
}

export function applyCourseCorrectionRestructure(
  input: ApplyCourseCorrectionRestructureInput,
): ApplyCourseCorrectionRestructureResult {
  const ctx = buildApplyContext(input);
  const stateManager = input.stateManager ?? new StateManager();
  const statePath = path.join(ctx.sessionRoot, 'state.json');
  let branch: CourseCorrectionBranch = 'b';
  let ticketsVersion = 0;
  let appliedSteps = 0;
  const releaseRestructureLock = acquireFileLock(path.join(ctx.sessionRoot, 'restructure.lock'));

  try {
    stateManager.transaction([statePath], ([state]) => {
      const beforeCount = collectTicketDirectoryIds(ctx.sessionRoot).length;
      branch = resolveCurrentTicketBranch(state, ctx.killedSet, ctx.addedSet);
      appliedSteps = applyTicketFileWrites(ctx);
      applyBranchCurrentTicket(state, branch, ctx);
      ticketsVersion = recordCourseCorrectionApplied(state, branch, beforeCount, ctx);
    });

    return { ledgerPath: ctx.ledgerPath, branch, ticketsVersion, appliedSteps };
  } catch (error) {
    rollbackAndHaltApply(error, ctx, stateManager, input.autoApply === true);
    throw error;
  } finally {
    releaseRestructureLock();
  }
}
