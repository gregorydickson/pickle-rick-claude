import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { CitadelFinding } from './reporter.js';
import { DiffSummary } from './diff-walker.js';
import { extractTrapDoorsSection } from './trap-doors-section.js';

export interface CitadelContext {
  projectRoot: string;
  claudeFiles?: string[];
  testFiles?: string[];
}

export interface AnalyzerResult {
  findings: CitadelFinding[];
}

export interface TrapDoorCoverageResult {
  findings: CitadelFinding[];
}

interface ScopeContext {
  hasScope: boolean;
  scopedClaudeFiles: Set<string>;
  scopedTestFiles: Set<string>;
}

interface EnforceRef {
  filePath: string;
  anchor?: string;
}

export const ENFORCE_REF_RE =
  /(?<=ENFORCE:\s*)((?:[`]?[\w./*-]+\.(?:test\.js|sh)[`]?(?:#[\w_-]+)?(?:,\s*)?)+)/g;

export function auditTrapDoorCoverage(diff: DiffSummary): TrapDoorCoverageResult {
  return runT6TrapDoorCoverage({
    projectRoot: diff.repoRoot,
    claudeFiles: diff.claudeFiles,
    testFiles: diff.changedFiles
      .filter((file) => file.kind === 'test')
      .map((file) => file.path),
  });
}

export function runT6TrapDoorCoverage(context: CitadelContext): AnalyzerResult {
  const { projectRoot } = context;
  const findings: CitadelFinding[] = [];
  const allClaudeFiles = collectClaudeMdFiles(projectRoot);
  const scope = createScopeContext(context);
  const referencedFiles = new Set<string>();

  for (const claudeFile of allClaudeFiles) {
    findings.push(...auditClaudeTrapDoorRefs(projectRoot, claudeFile, scope, referencedFiles));
  }

  findings.push(...collectOrphanTestFileFindings(projectRoot, scope, referencedFiles));

  return { findings };
}

function collectClaudeMdFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const primary = path.join(projectRoot, 'extension', 'CLAUDE.md');
  if (existsSync(primary)) files.push(primary);
  const srcDir = path.join(projectRoot, 'extension', 'src');
  if (existsSync(srcDir)) files.push(...walkForClaudeMd(srcDir));
  return files;
}

function walkForClaudeMd(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkForClaudeMd(fullPath));
      } else if (entry.name === 'CLAUDE.md') {
        results.push(fullPath);
      }
    }
  } catch {
    // non-fatal: subsystem CLAUDE.md may be missing (Open Finding #5)
  }
  return results;
}

function createScopeContext(context: CitadelContext): ScopeContext {
  const scopedClaudeFiles = new Set((context.claudeFiles ?? []).map(normalizeRelativePath));
  const scopedTestFiles = new Set((context.testFiles ?? []).map(normalizeRelativePath));
  return {
    hasScope: scopedClaudeFiles.size > 0 || scopedTestFiles.size > 0,
    scopedClaudeFiles,
    scopedTestFiles,
  };
}

function auditClaudeTrapDoorRefs(
  projectRoot: string,
  claudeFile: string,
  scope: ScopeContext,
  referencedFiles: Set<string>,
): CitadelFinding[] {
  const content = readTextFile(claudeFile);
  if (content === null) return [];
  const section = extractTrapDoorsSection(content);
  if (!section) return [];

  const findings: CitadelFinding[] = [];
  const relClaude = normalizeRelativePath(path.relative(projectRoot, claudeFile));
  const claudeInScope = !scope.hasScope || scope.scopedClaudeFiles.has(relClaude);
  let barePathWarned = false;

  for (const match of section.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))) {
    const refs = parseEnforceRefs(match[1]);

    for (const ref of refs) {
      const refFindings = auditEnforceRef({
        projectRoot,
        ref,
        relClaude,
        claudeInScope,
        scope,
        barePathWarned,
      });
      barePathWarned ||= refFindings.warnedBarePath;
      referencedFiles.add(refFindings.canonicalPath);
      findings.push(...refFindings.findings);
    }
  }

  return findings;
}

function auditEnforceRef(input: {
  projectRoot: string;
  ref: EnforceRef;
  relClaude: string;
  claudeInScope: boolean;
  scope: ScopeContext;
  barePathWarned: boolean;
}): { canonicalPath: string; findings: CitadelFinding[]; warnedBarePath: boolean } {
  const { projectRoot, ref, relClaude, claudeInScope, scope, barePathWarned } = input;
  const { canonicalPath, absPath } = resolveEnforceRef(projectRoot, ref.filePath);
  const findings: CitadelFinding[] = [];
  const refInScope = !scope.hasScope || claudeInScope || scope.scopedTestFiles.has(canonicalPath);
  let warned = barePathWarned;

  if (!ref.anchor && !warned && claudeInScope) {
    findings.push({
      id: `trap-door-bare-path:${relClaude}`,
      severity: 'Low',
      message: `ENFORCE ref without #anchor in ${relClaude}; adding #test-case-name improves precision.`,
      file: relClaude,
    });
    warned = true;
  }

  if (!existsSync(absPath)) {
    if (refInScope) {
      findings.push({
        id: `orphan-enforce:${canonicalPath}`,
        severity: 'High',
        message: `ENFORCE ref points to nonexistent file: ${canonicalPath} (in ${relClaude})`,
        file: relClaude,
      });
    }
    return { canonicalPath, findings, warnedBarePath: warned };
  }

  if (ref.anchor) {
    const testContent = readTextFile(absPath);
    if (testContent !== null && refInScope && !hasTestCase(testContent, ref.anchor)) {
      findings.push({
        id: `orphan-test-case:${canonicalPath}#${ref.anchor}`,
        severity: 'High',
        message: `ENFORCE anchor #${ref.anchor} not found in ${canonicalPath}`,
        file: canonicalPath,
      });
    }
  }

  return { canonicalPath, findings, warnedBarePath: warned };
}

function collectOrphanTestFileFindings(
  projectRoot: string,
  scope: ScopeContext,
  referencedFiles: Set<string>,
): CitadelFinding[] {
  const scopedTestCandidates = scope.hasScope
    ? [...scope.scopedTestFiles].map((filePath) => path.resolve(projectRoot, filePath))
    : collectTestFiles(projectRoot);

  return scopedTestCandidates.flatMap((absTestFile) => {
    const relPath = normalizeRelativePath(path.relative(projectRoot, absTestFile));
    if (referencedFiles.has(relPath)) return [];
    return [{
      id: `orphan-test-file:${relPath}`,
      severity: 'Medium',
      message: `Test file has no inbound ENFORCE ref: ${relPath}`,
      file: relPath,
    }];
  });
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function parseEnforceRefs(raw: string): EnforceRef[] {
  return raw.split(/,\s*/).flatMap((part) => {
    const cleaned = part.trim().replace(/^`|`$/g, '');
    if (!cleaned) return [];
    const hashIdx = cleaned.indexOf('#');
    if (hashIdx === -1) return [{ filePath: cleaned }];
    return [{ filePath: cleaned.slice(0, hashIdx), anchor: cleaned.slice(hashIdx + 1) }];
  });
}

function resolveEnforceRef(projectRoot: string, filePath: string): { canonicalPath: string; absPath: string } {
  const normalized = normalizeRelativePath(filePath);
  const canonicalPath = normalized.startsWith('extension/')
    ? normalized
    : normalized.startsWith('tests/')
      ? `extension/${normalized}`
      : `extension/tests/${normalized}`;
  return {
    canonicalPath,
    absPath: path.resolve(projectRoot, canonicalPath),
  };
}

function hasTestCase(content: string, anchor: string): boolean {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:it|test)\\s*\\(\\s*['"\`]${escaped}['"\`]`).test(content);
}

function collectTestFiles(projectRoot: string): string[] {
  const testsDir = path.join(projectRoot, 'extension', 'tests');
  return existsSync(testsDir) ? walkForTestFiles(testsDir) : [];
}

function walkForTestFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkForTestFiles(fullPath));
      } else if (entry.name.endsWith('.test.js')) {
        results.push(fullPath);
      }
    }
  } catch {
    // non-fatal
  }
  return results;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
