import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecord } from '../lib/is-record.js';

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

/**
 * The wrapper fields `ReverseLedger` declares. `satisfies` makes the compiler the
 * owner of this list: a field added to the interface without being added here is a
 * type error, so it cannot silently become the one shape the parser fails to see.
 */
const REVERSE_LEDGER_WRAPPER_KEYS = ['entries', 'actions', 'steps'] as const satisfies readonly (keyof ReverseLedger)[];

/**
 * AP-EXT-ITER197-01: `null` means "this text is NOT a ledger container", which is
 * a different fact from "this container is empty". Returning `[]` for a
 * non-container is what let a one-entry ledger resolve to zero entries.
 */
function resolveLedgerEntries(parsed: unknown): ReverseLedgerEntry[] | null {
  if (Array.isArray(parsed)) return parsed as ReverseLedgerEntry[];
  if (!isRecord(parsed)) return null;
  const key = REVERSE_LEDGER_WRAPPER_KEYS.find(candidate => Array.isArray(parsed[candidate]));
  if (key !== undefined) return parsed[key] as ReverseLedgerEntry[];
  // Carries a wrapper field but no usable array: an EMPTY container, never a record.
  return REVERSE_LEDGER_WRAPPER_KEYS.some(candidate => candidate in parsed) ? [] : null;
}

function parseJsonDocumentOrNull(trimmed: string): unknown {
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * AP-EXT-ITER197-01: the container-vs-JSONL decision reads the PARSED STRUCTURE,
 * never the text's shape. The prior discriminator asked whether the trimmed text
 * started with `{` and held no newline — a LINE COUNT, which a one-entry JSONL
 * apply ledger satisfies exactly. It then resolved that lone entry as a wrapper,
 * found no `entries`/`actions`/`steps` key, and returned `[]`, so the
 * single-step crash window reversed NOTHING and reported success.
 */
function parseLedgerContent(raw: string): ReverseLedgerEntry[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const wrapped = resolveLedgerEntries(parseJsonDocumentOrNull(trimmed));
  return wrapped ?? trimmed
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as ReverseLedgerEntry);
}

function resolveLedgerPath(sessionRoot: string, entryPath: string): string {
  const targetPath = path.isAbsolute(entryPath) ? entryPath : path.join(sessionRoot, entryPath);
  return assertWithinRoot(targetPath, sessionRoot);
}

function restoreContent(entry: ReverseLedgerEntry): string | null | undefined {
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
function planReversal(entry: ReverseLedgerEntry): LedgerReversal {
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
