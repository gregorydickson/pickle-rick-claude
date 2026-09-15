import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

/** Matrix palette shared across all monitor panes. */
export const MatrixStyle = {
  BRIGHT: '\x1b[1;32m',    // bold green
  GREEN: '\x1b[32m',       // normal green
  DIM: '\x1b[2;32m',       // dim green
  CYAN: '\x1b[36m',        // cyan accent
  ERR: '\x1b[1;31m',       // bold red
  WARN: '\x1b[33m',        // yellow
  R: '\x1b[0m',            // reset
} as const;

export const RAIN_CHARS = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ012345789Z:."=*+-<>¦╌╎';

/** Generates a Matrix-styled separator line with random rain characters. */
export function matrixSeparator(width: number): string {
  const line: string[] = [];
  for (let i = 0; i < width; i++) {
    line.push(Math.random() < 0.2
      ? RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)]
      : '─');
  }
  return `${MatrixStyle.DIM}${line.join('')}${MatrixStyle.R}`;
}

/**
 * Ranks one `tmux_iteration_N.log` as `[mtimeMs, iterationNumber]`.
 *
 * mtime is PRIMARY because the iteration-number namespace RESETS at every
 * pipeline phase boundary: `mux-runner.ts` (pickle) and `microverse-runner.ts`
 * (anatomy-park, szechuan-sauce) both write `tmux_iteration_<n>.log` into the
 * SAME session dir, each numbering from 1. A max-by-number pick therefore
 * returns the highest-numbered log of whichever phase ran LONGEST, not the live
 * one. The number stays as a deterministic tiebreak for same-millisecond writes.
 * An unstattable entry ranks last so it is picked only when nothing else exists.
 */
function iterationLogRank(sessionDir: string, name: string): [number, number] {
  const num = parseInt(name.replace('tmux_iteration_', '').replace('.log', ''), 10) || 0;
  try {
    return [fs.statSync(path.join(sessionDir, name)).mtimeMs, num];
  } catch {
    return [-Infinity, num];
  }
}

/** Finds the most recent tmux_iteration_N.log in a session directory. */
export function latestIterationLog(sessionDir: string): string | null {
  try {
    const logs = fs
      .readdirSync(sessionDir)
      .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
      .map((name) => ({ name, rank: iterationLogRank(sessionDir, name) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
    return logs.length > 0 ? path.join(sessionDir, logs[logs.length - 1].name) : null;
  } catch {
    return null;
  }
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const DRAIN_CHUNK = 65536; // 64 KiB

/**
 * Reads stream-json log from `offset`, processes complete lines via the
 * provided `processor`, and emits output. Returns new offset and partial
 * trailing line buffer.
 *
 * AP-EXT-ITER7-01 replay: the read is chunked on a BYTE axis, so decoding must
 * run on the STREAM, never per chunk. A `StringDecoder` holds the incomplete
 * multi-byte sequence that straddles a `DRAIN_CHUNK` boundary until the next
 * chunk supplies its remaining bytes -- a per-chunk `.toString('utf-8')` renders
 * each half as U+FFFD instead. `drainLog` below decodes the same way.
 */
export function drainStreamJsonLines(
  logPath: string,
  offset: number,
  lineBuf: string,
  processor: (line: string) => string | null,
  emit: (text: string) => void,
): { offset: number; lineBuf: string } {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return { offset, lineBuf };
    fd = fs.openSync(logPath, 'r');
    const decoder = new StringDecoder('utf-8');
    let pos = offset;
    let buf = lineBuf;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const raw = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, raw, 0, toRead, pos);
      if (bytesRead === 0) break;
      buf += decoder.write(raw.subarray(0, bytesRead));
      pos += bytesRead;
    }
    buf += decoder.end();
    fs.closeSync(fd);
    fd = null;
    const lines = buf.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
      const result = processor(line);
      if (result !== null) emit(result);
    }
    return { offset: pos, lineBuf: trailing };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return { offset, lineBuf };
  }
}

/**
 * R-MWR-4: detect truncation of a file-tail watcher's current log.
 *
 * When the file at `logPath` is truncated (size shrinks below the
 * caller's recorded `offset`), tail-style watchers must reset their
 * offset and partial-line buffer so post-truncate content is consumed
 * instead of skipped. Without this hook, `drainStreamJsonLines` and
 * `drainLog` early-return on `size <= offset` and the watcher feeds a
 * dead chunk forever.
 *
 * Returns the post-check offset and lineBuf, plus a `truncated` flag
 * the caller uses to print exactly one dim `(reconnecting...)` line
 * per disconnect (R-MWR-6: banner stays reserved for liveness-probe
 * inactive exits, NOT for EOF).
 *
 * Returns the inputs unchanged if the file is missing or unreadable —
 * those cases are owned by the caller's own `latestIterationLog` /
 * worker-log discovery loop.
 */
export function detectLogTruncation(
  logPath: string,
  offset: number,
  lineBuf: string,
): { offset: number; lineBuf: string; truncated: boolean } {
  try {
    const { size } = fs.statSync(logPath);
    if (size < offset) {
      return { offset: 0, lineBuf: '', truncated: true };
    }
  } catch {
    // Missing or unreadable — caller will pick this up on its next
    // discovery iteration. Do not mutate offset.
  }
  return { offset, lineBuf, truncated: false };
}

/** Emits log content to stdout, stripping ANSI codes and truncating long lines. */
function emitLog(content: string): void {
  const width = Math.min((process.stdout.columns || 80) - 2, 120);
  const lines = content.replace(ANSI_REGEX, '').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    process.stdout.write((line.length > width ? line.slice(0, width - 1) + '…' : line) + '\n');
  }
}

/**
 * Reads new bytes from a log file starting at `offset`, emits them to stdout,
 * and returns the new offset. Reads in 64 KiB chunks to limit memory usage.
 */
export function drainLog(logPath: string, offset: number): number {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return offset;
    fd = fs.openSync(logPath, 'r');
    const decoder = new StringDecoder('utf-8');
    let pos = offset;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead === 0) break; // EOF — file was truncated
      emitLog(decoder.write(buf.subarray(0, bytesRead)));
      pos += bytesRead;
    }
    const trailing = decoder.end();
    if (trailing) emitLog(trailing);
    fs.closeSync(fd);
    return pos;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore double-close */ }
    }
    return offset;
  }
}
