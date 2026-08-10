import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessStartTimeMs(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    if (!output) return null;
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

function shouldSkipLiveTmp(tmpPid: number, tmpPath: string): boolean {
  if (!Number.isFinite(tmpPid) || !isProcessAlive(tmpPid)) return false;
  const processStartTimeMs = readProcessStartTimeMs(tmpPid);
  if (processStartTimeMs === null) return true;
  try {
    return fs.statSync(tmpPath).mtimeMs >= processStartTimeMs;
  } catch {
    return true;
  }
}

function parseJsonObjectFile(filePath: string): object | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonObjectFile(filePath: string): { kind: 'parsed'; parsed: object } | { kind: 'invalid' | 'unreadable' } {
  // Delete authority is "positively proven garbage" = READ succeeded AND the
  // content is unparseable. A read that THREW proves nothing about the content,
  // whatever the errno — so the read and the parse are judged separately here
  // rather than through an errno allowlist. Mirrors `state-manager.ts`
  // `classifyOrphanTmp`, which has always had this shape.
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { kind: 'unreadable' };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { kind: 'parsed', parsed }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function listEntries(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

function parseDeadTmp(
  tmpPath: string,
  baseMtimeMs: number,
): { parsed: object; mtimeMs: number } | null {
  const parsedResult = readJsonObjectFile(tmpPath);
  if (parsedResult.kind === 'unreadable') {
    return null;
  }
  if (parsedResult.kind !== 'parsed') {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore invalid tmp cleanup failure */ }
    return null;
  }
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(tmpPath).mtimeMs;
  } catch {
    return null;
  }
  // R-CIFB-B: an orphan .tmp.<pid> is written AFTER its base, so on a coarse-mtime
  // FS tie (Linux) the tmp is the more-recent intent and MUST win — discard only a
  // STRICTLY-older tmp (`<`, not `<=`). The equal-mtime tmp is kept here and decided
  // by the winner-selection tie-break in readRecoverableJsonObject.
  if (mtimeMs < baseMtimeMs) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore stale tmp cleanup failure */ }
    return null;
  }
  return { parsed: parsedResult.parsed, mtimeMs };
}

export function readRecoverableJsonObject(filePath: string): object | null {
  const base = parseJsonObjectFile(filePath);
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const entries = listEntries(dir);
  if (!entries) return base;

  const tmpPrefix = baseName + '.tmp.';
  const tmpPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)(?:\\..+)?$`);
  let baseMtimeMs: number;
  try {
    baseMtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
  } catch {
    baseMtimeMs = 0;
  }
  let winner: { tmpPath: string; parsed: object; mtimeMs: number } | null = null;

  for (const entry of entries.filter(e => e.startsWith(tmpPrefix))) {
    const match = entry.match(tmpPattern);
    if (!match) continue;
    const tmpPath = path.join(dir, entry);
    const tmpPid = Number(match[1]);
    if (shouldSkipLiveTmp(tmpPid, tmpPath)) continue;

    const candidate = parseDeadTmp(tmpPath, baseMtimeMs);
    // R-CIFB-B PINNED ORDERING: among multiple competing dead tmps, strict `>` means
    // the winner is replaced ONLY by a strictly-newer mtime, so equal-mtime tmps are
    // resolved first-seen-wins (readdir iteration order). This is deterministic and
    // documented — do NOT relax to `>=` (that would make last-seen win on a tie).
    if (candidate && (!winner || candidate.mtimeMs > winner.mtimeMs)) {
      winner = { tmpPath, ...candidate };
    }
  }

  if (!winner) return base;
  try {
    fs.renameSync(winner.tmpPath, filePath);
    return winner.parsed;
  } catch {
    return base;
  }
}
