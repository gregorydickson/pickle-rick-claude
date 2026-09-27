/**
 * Pure ticket-wave scheduler: given pending candidates and a cap, decides which ids
 * may run together in the next wave. Does not read ticket files or run anything —
 * callers own disk I/O and execution (see `ticket-declared-files.ts` for the file
 * declarations this module's `WaveCandidate.files` is expected to be populated from).
 */

export interface WaveCandidate {
  id: string;
  order: number;
  parallelSafe: boolean;
  files: string[];
}

/** Matches the sole recognized frontmatter opt-in: `parallel_safe: true`. */
const PARALLEL_SAFE_RE = /^parallel_safe:\s*true\s*$/m;

/** `parallel_safe: true` in frontmatter is the only accepted opt-in. */
export function readParallelSafe(content: string): boolean {
  return PARALLEL_SAFE_RE.test(content);
}

/** `CLAUDE.md`, a nested `CLAUDE.md`, or anything under `.claude/` overlaps everything. */
function isGlobalMarker(token: string): boolean {
  if (token === 'CLAUDE.md' || token.endsWith('/CLAUDE.md')) return true;
  return token === '.claude' || token.startsWith('.claude/');
}

/** Compiled/source mirror pairs canonicalize to their `extension/src/...` `.ts` spelling. */
function normalizeMirror(token: string): string {
  if (token.startsWith('extension/bin/') && token.endsWith('.js')) {
    return `extension/src/bin/${token.slice('extension/bin/'.length, -3)}.ts`;
  }
  if (token.startsWith('extension/services/') && token.endsWith('.js')) {
    return `extension/src/services/${token.slice('extension/services/'.length, -3)}.ts`;
  }
  return token;
}

function basename(token: string): string {
  const idx = token.lastIndexOf('/');
  return idx === -1 ? token : token.slice(idx + 1);
}

function tokensOverlap(a: string, b: string): boolean {
  if (isGlobalMarker(a) || isGlobalMarker(b)) return true;
  if (a.endsWith('/') && (b === a || b.startsWith(a))) return true;
  if (b.endsWith('/') && (a === b || a.startsWith(b))) return true;
  if (normalizeMirror(a) === normalizeMirror(b)) return true;
  if ((!a.includes('/') || !b.includes('/')) && basename(a) === basename(b)) return true;
  return false;
}

/** An empty list overlaps everything (an unknown file set can't be proven disjoint). */
export function filesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const tokenA of a) {
    for (const tokenB of b) {
      if (tokensOverlap(tokenA, tokenB)) return true;
    }
  }
  return false;
}

/**
 * Plans the next wave: sorts by `order`, always starts with the lowest-order pending
 * candidate, and — only when that candidate is `parallelSafe` — appends subsequent
 * candidates while each remains `parallelSafe` and non-overlapping with every wave
 * member so far, stopping at the first candidate that fails either test.
 */
export function planTicketWave(pending: WaveCandidate[], cap: number): string[] {
  if (pending.length === 0) return [];
  const sorted = [...pending].sort((a, b) => a.order - b.order);
  const first = sorted[0];
  if (!first.parallelSafe) return [first.id];

  const limit = Math.max(cap, 1);
  const wave: WaveCandidate[] = [first];
  for (let i = 1; i < sorted.length && wave.length < limit; i++) {
    const candidate = sorted[i];
    if (!candidate.parallelSafe) break;
    if (wave.some(member => filesOverlap(member.files, candidate.files))) break;
    wave.push(candidate);
  }
  return wave.map(w => w.id);
}
