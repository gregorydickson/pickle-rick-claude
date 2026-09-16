import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ChangedFileSummary } from './diff-walker.js';

export interface SkepticFinding {
  defect: string;
  file: string;
  line?: number;
  why: string;
  shape: string;
}

export interface SkepticReport {
  findings: SkepticFinding[];
}

// Identity comparison with object/array literal: e.g. `x === {}` always false
const SEMANTIC_IDENTITY_RE = /===\s*[[{]|[[{]\s*===/;
// Optional chain without null coalescing fallback on the same line
const OPTIONAL_CHAIN_RE = /\?\.\w/;
const NULL_COALESCE_RE = /\?\?/;
// Resource construction without visible lifecycle close/destroy
const RESOURCE_CTOR_RE = /\bnew\s+\w*(?:ReadStream|WriteStream|Client|Connection|Socket|Handle)\b/;
// Dead guard: if (false) / if (true)
const DEAD_GUARD_RE = /\bif\s*\(\s*(?:false|true)\s*\)/;
// No-op assignment: x = x;
const NOOP_ASSIGN_RE = /\b(\w+)\s*=\s*\1\s*[;,]/;
// Function declaration for cross-file repetition check (name must be 5+ chars to avoid noise)
const FN_DECL_RE = /\bfunction\s+(\w{5,})\s*\(/;

// Table-driven per-line detectors: collapses the 4 sequential defect checks into one loop.
const LINE_DETECTORS: ReadonlyArray<{
  defect: string;
  why: string;
  match: (line: string) => boolean;
}> = [
  {
    defect: 'semantic-identity',
    why: 'Identity comparison with object/array literal always evaluates to false',
    match: (line) => SEMANTIC_IDENTITY_RE.test(line),
  },
  {
    defect: 'fallback-null-flow',
    why: 'Optional chaining result consumed without null coalescing fallback',
    match: (line) => OPTIONAL_CHAIN_RE.test(line) && !NULL_COALESCE_RE.test(line),
  },
  {
    defect: 'resource-lifecycle',
    why: 'Resource construction without visible close/destroy in changed context',
    match: (line) => RESOURCE_CTOR_RE.test(line),
  },
  {
    defect: 'dead-guard-no-op-flag-behavior-parity',
    why: 'Dead guard condition or no-op assignment detected',
    match: (line) => DEAD_GUARD_RE.test(line) || NOOP_ASSIGN_RE.test(line),
  },
];

function detectLineDefects(line: string, file: string, ln: number): SkepticFinding[] {
  const out: SkepticFinding[] = [];
  for (const detector of LINE_DETECTORS) {
    if (detector.match(line)) {
      out.push({ defect: detector.defect, file, line: ln, why: detector.why, shape: line.trim() });
    }
  }
  return out;
}

function readLines(repoRoot: string, filePath: string): string[] | null {
  try {
    return readFileSync(path.join(repoRoot, filePath), 'utf-8').split('\n');
  } catch {
    return null;
  }
}

// Compiled-twin exclusion: derives the generated-output mapping from the governing
// tsconfig.json's own rootDir/outDir rather than a hand-maintained directory list.
interface TsconfigMapping {
  dir: string;
  rootDir: string;
  outDir: string;
}

function findTsconfigDir(repoRoot: string, fileRelPath: string): string | null {
  const rootAbs = path.resolve(repoRoot);
  let dir = path.dirname(path.join(repoRoot, fileRelPath));
  for (;;) {
    if (existsSync(path.join(dir, 'tsconfig.json'))) return dir;
    if (path.resolve(dir) === rootAbs) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadTsconfigMapping(tsconfigDir: string): TsconfigMapping | null {
  try {
    const raw = readFileSync(path.join(tsconfigDir, 'tsconfig.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const opts = (parsed as { compilerOptions?: { rootDir?: unknown; outDir?: unknown } })?.compilerOptions;
    if (typeof opts?.rootDir === 'string' && typeof opts?.outDir === 'string') {
      return { dir: tsconfigDir, rootDir: opts.rootDir, outDir: opts.outDir };
    }
    return null;
  } catch {
    return null;
  }
}

function isGeneratedCompiledTwin(repoRoot: string, filePath: string): boolean {
  if (!filePath.endsWith('.js')) return false;
  const tsconfigDir = findTsconfigDir(repoRoot, filePath);
  if (!tsconfigDir) return false;
  const mapping = loadTsconfigMapping(tsconfigDir);
  if (!mapping) return false;

  const outDirAbs = path.resolve(mapping.dir, mapping.outDir);
  const rootDirAbs = path.resolve(mapping.dir, mapping.rootDir);
  const relFromOut = path.relative(outDirAbs, path.join(repoRoot, filePath));
  if (relFromOut.startsWith('..')) return false;

  const candidateTs = path.join(rootDirAbs, relFromOut).replace(/\.js$/, '.ts');
  return existsSync(candidateTs);
}

export function runSkepticLens(
  changedFiles: ChangedFileSummary[],
  repoRoot: string,
): SkepticReport {
  const findings: SkepticFinding[] = [];
  // Locator per occurrence (not just the file), so a cross-file finding below
  // can point at a real declaration line instead of dropping to file-only.
  const fnsByName = new Map<string, Array<{ file: string; line: number }>>();

  for (const file of changedFiles) {
    if (isGeneratedCompiledTwin(repoRoot, file.path)) continue;

    const lines = readLines(repoRoot, file.path);
    if (!lines) continue;

    for (const range of file.changedLines) {
      for (let ln = range.start; ln <= range.end; ln++) {
        const line = lines[ln - 1] ?? '';

        findings.push(...detectLineDefects(line, file.path, ln));

        const fnMatch = FN_DECL_RE.exec(line);
        if (fnMatch) {
          const name = fnMatch[1];
          const occurrences = fnsByName.get(name) ?? [];
          if (!occurrences.some((o) => o.file === file.path)) {
            occurrences.push({ file: file.path, line: ln });
            fnsByName.set(name, occurrences);
          }
        }
      }
    }
  }

  for (const [name, occurrences] of fnsByName) {
    if (occurrences.length >= 2) {
      const fileList = occurrences.map((o) => o.file).join(', ');
      findings.push({
        defect: 'cross-file-repetition-exhaustiveness',
        file: occurrences[0].file,
        line: occurrences[0].line,
        why: `Function '${name}' defined in ${occurrences.length} changed files (${fileList}) — potential duplication or missing exhaustiveness`,
        shape: `function ${name}(`,
      });
    }
  }

  return { findings };
}
