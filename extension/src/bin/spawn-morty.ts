#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  printMinimalPanel,
  Style,
  formatTime,
  getExtensionRoot,
  getDataRoot,
  runCmd,
  safeErrorMessage,
  parseTicketFrontmatter,
  getTicketTierBudgetWithOverrides,
  resolveWorkerTestGateTimeoutMs,
  classifyTicketTier,
  VALID_TICKET_COMPLEXITY_TIERS,
  extractFrontmatter,
  loadPickleSettingsBag,
  resolveCodegraphSettings,
  upsertFrontmatterField,
  ticketFilePath,
  TIER_LIFECYCLE,
  TIER_DIFF_ENVELOPE,
  type LifecyclePhase,
  type TicketClassifierInfo,
  type TicketComplexityTier,
} from '../services/pickle-utils.js';
import { spawn } from 'child_process';
import { PromiseTokens, hasToken, Defaults, hasLifecycleArtifact, BACKENDS, WORKER_GATE_TSC_OK_FIELD, type ActivityLogEntry, type Backend, type BackendResolutionSource, type CodegraphContextSkipReason, type CodegraphSettings, type LastToolErrorState, type PickleSettings, type State } from '../types/index.js';
import { CodegraphService } from '../services/codegraph-service.js';
import { isRecord } from '../lib/is-record.js';
import { ArchiveAbortError, getDiffFiles, getHeadSha, listWorkingTreeDirtyPaths, resetToSha, updateTicketFrontmatter, updateTicketStatus } from '../services/git-utils.js';
import { assertBackendPreSpawn, buildWorkerInvocation, isBackend, backendEnvOverrides, resolveWorkerBackendFromState, resolveWorkerBackendFromStateFile, sessionStampEnv, shouldIsolateSessionGroup, shouldForceDetachForLargeTier } from '../services/backend-spawn.js';
import { scrubForbiddenWorkerTokens } from '../services/promise-tokens.js';
import { StateManager, writeActivityEntry } from '../services/state-manager.js';
import { autoFillCompletionCommit } from './auto-fill-completion-commit.js';
// 7eb9fa20: shared Failed-flip suppression policy. Runtime-only usage — safe
// despite mux-runner's own import of `resolveCodexModel` from this module
// (neither module touches the other's bindings during module evaluation).
import { evaluateFailedFlipSuppression } from './mux-runner.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { loadAgentMd, type AgentModel } from '../services/agent-md-loader.js';
import { flushAndExit } from '../services/worker-shutdown.js';

const TIER_MODEL_MAP: Record<string, string> = {
  trivial: 'haiku',
  small: 'sonnet',
  medium: 'sonnet',
  large: 'opus',
};
const sm = new StateManager();
const MIN_TIMEOUT_SECONDS = 30;
const VALID_AGENT_MODELS = new Set<AgentModel>(['sonnet', 'opus', 'haiku']);
const LAST_TOOL_ERROR_FILE = 'last-tool-error.json';
const HANDOFF_NOTES_FILE = 'handoff_notes.md';
const TOOL_RETRY_ANALYZE_THRESHOLD = 2;
const TOOL_RETRY_STOP_THRESHOLD = 4;
const COMPLETION_COMMIT_ACK_RE = /^COMPLETION_COMMIT_RECORDED:\s*([0-9a-f]{7,40})\s*$/gim;

export type ParsedArgs = {
  ticket: string;
  ticketId: string;
  ticketPath: string;
  ticketFilePath: string | null;
  ticketContent: string;
  sessionRoot: string;
  sessionLogPath: string;
  backend: Backend;
  /**
   * R-XBL-2: optional `--backend <name>` CLI override. When set, replaces the
   * state/env-resolved backend at exec time and emits a
   * `worker_spawn_backend_override` activity event. PICKLE_REFINEMENT_LOCK=1
   * still wins (refinement carve-out is non-overridable).
   */
  backendOverride: Backend | null;
  timeout: number;
  outputFormat: string;
  isReviewTicket: boolean;
};

export type TicketSpec = {
  task: string;
  ticketContent: string;
  ticketId: string;
  ticketPath: string;
  sessionRoot: string;
  backend: Backend;
  isReviewTicket: boolean;
};

export type BuildWorkerPromptOptions = {
  ticket: TicketSpec;
  model: string;
  repoRoot?: string;
  extensionRoot?: string;
  agentsDir?: string;
  complexityTier?: TicketComplexityTier;
  /**
   * Pre-rendered `## Code Graph Context` section (from `buildCodegraphContextSection`),
   * injected adjacent to the tier lifecycle sections. Empty/absent = no section.
   */
  codegraphSection?: string;
};

export type WorkerProcessContext = {
  args: ParsedArgs;
  prompt: string;
  ticketPath: string;
  ticketId: string;
  sessionRoot: string;
  sessionLog: fs.WriteStream;
  sessionLogPath: string;
  sessionWorkingDir: string;
  timeoutStatePath: string | null;
  workerStatePath: string;
  effectiveTimeoutMs: number;
  mutableState: { finalized: boolean; timedOut: boolean };
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  hermesOptions?: HermesWorkerOptions;
  preWorkerHead: string | null;
};

export function tierToModel(tier: string | undefined): string {
  if (!tier) return 'sonnet';
  return TIER_MODEL_MAP[tier] ?? 'sonnet';
}

function isAgentModel(value: unknown): value is AgentModel {
  return typeof value === 'string' && VALID_AGENT_MODELS.has(value as AgentModel);
}

type PhasePersonaEntry = {
  subagent_type: string;
  model?: AgentModel;
};

const PHASE_PERSONAS_DISABLED_MESSAGE = '[phase-personas] feature available but disabled (calibration in progress); enable with: pickle settings set bmad_hardening.phase_personas_enabled true OR PICKLE_PHASE_PERSONAS=on';

function readBasePersona(extensionRoot: string): string {
  try {
    const personaPath = path.join(extensionRoot, 'persona.md');
    if (!fs.existsSync(personaPath)) return '';
    return fs.readFileSync(personaPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function readPhasePersonaEntry(sessionRoot: string, extensionRoot: string): PhasePersonaEntry | null {
  try {
    const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json')) as State | null;
    const step = state?.step;
    if (!step) return null;
    const configPath = path.join(extensionRoot, 'extension', 'data', 'phase-personas.json');
    const config = readRecoverableJsonObject(configPath) as Record<string, unknown> | null;
    const rawEntry = config?.[step];
    if (!rawEntry || typeof rawEntry !== 'object') return null;
    const entry = rawEntry as Record<string, unknown>;
    const subagentType = entry.subagent_type;
    if (typeof subagentType !== 'string' || !subagentType.trim()) return null;
    return {
      subagent_type: subagentType,
      ...(isAgentModel(entry.model) ? { model: entry.model } : {}),
    };
  } catch {
    return null;
  }
}

function readBmadHardeningSettings(extensionRoot: string): Record<string, unknown> | null {
  try {
    const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json')) as Record<string, unknown> | null;
    const hardening = settings?.bmad_hardening;
    return hardening && typeof hardening === 'object' && !Array.isArray(hardening)
      ? hardening as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isPhasePersonasEnabled(extensionRoot: string): boolean {
  const envValue = process.env.PICKLE_PHASE_PERSONAS;
  if (envValue === 'on') return true;
  if (envValue === 'off') return false;
  const hardening = readBmadHardeningSettings(extensionRoot);
  return hardening?.phase_personas_enabled === true;
}

function hasSeenDisabledPhasePersonas(sessionRoot: string): boolean {
  try {
    const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json')) as State | null;
    return Array.isArray(state?.activity)
      && state.activity.some((entry) => entry.event === 'phase_personas_disabled_seen');
  } catch {
    return false;
  }
}

function recordPhasePersonasDisabledSeen(sessionRoot: string): void {
  if (hasSeenDisabledPhasePersonas(sessionRoot)) return;
  console.log(PHASE_PERSONAS_DISABLED_MESSAGE);
  writeActivityEntry(path.join(sessionRoot, 'state.json'), {
    event: 'phase_personas_disabled_seen',
    ts: new Date().toISOString(),
  });
}

function readActivePersonaBlock(opts: {
  sessionRoot: string;
  extensionRoot: string;
  agentsDir?: string;
}): string {
  try {
    const entry = readPhasePersonaEntry(opts.sessionRoot, opts.extensionRoot);
    if (!entry) return '';
    if (!isPhasePersonasEnabled(opts.extensionRoot)) {
      recordPhasePersonasDisabledSeen(opts.sessionRoot);
      return '';
    }
    const agent = loadAgentMd(entry.subagent_type, { agentsDir: opts.agentsDir });
    if (!agent) return '';
    const parts = [readBasePersona(opts.extensionRoot), agent.body.trim()].filter(Boolean);
    return parts.length > 0 ? `\n\n## Active Persona\n${parts.join('\n\n')}` : '';
  } catch {
    return '';
  }
}

export function resolvePhasePersonaModel(sessionRoot: string, extensionRoot: string): AgentModel | undefined {
  if (!isPhasePersonasEnabled(extensionRoot)) return undefined;
  return readPhasePersonaEntry(sessionRoot, extensionRoot)?.model;
}

export function resolveWorkerModelFromTierAndPersona(
  ticketTier: string | undefined,
  personaModel: AgentModel | undefined
): string {
  if (ticketTier) return tierToModel(ticketTier);
  return personaModel ?? 'sonnet';
}

function readProjectContextBlock(sessionRoot: string): string {
  try {
    if (isArchaeologyDisabled(sessionRoot)) return '';
    const projectContextPath = path.join(sessionRoot, 'project-context.md');
    if (!fs.existsSync(projectContextPath)) return '';
    const projectContext = fs.readFileSync(projectContextPath, 'utf-8').trim();
    return projectContext ? `\n\n## Project Context\n${projectContext}` : '';
  } catch {
    return '';
  }
}

function isLastToolErrorState(value: unknown): value is LastToolErrorState {
  if (!isRecord(value)) return false;
  return typeof value.ts === 'string'
    && typeof value.tool === 'string'
    && typeof value.error_signature === 'string'
    && typeof value.retry_count === 'number'
    && Number.isInteger(value.retry_count)
    && value.retry_count > 0;
}

function readLastToolErrorState(sessionRoot: string): LastToolErrorState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionRoot, LAST_TOOL_ERROR_FILE), 'utf-8'));
    return isLastToolErrorState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordToolRetryCircuitOpen(sessionRoot: string, ticketId: string, toolError: LastToolErrorState): void {
  try {
    writeActivityEntry(path.join(sessionRoot, 'state.json'), {
      event: 'tool_retry_circuit_open',
      ts: new Date().toISOString(),
      source: 'pickle',
      session: path.basename(sessionRoot),
      ticket: ticketId,
      tool: toolError.tool,
      retry_count: toolError.retry_count,
      error_signature: toolError.error_signature,
    });
  } catch {
    /* fail open; guidance still reaches the worker */
  }
}

function buildToolRetryGuidanceBlock(ticket: TicketSpec): string {
  const toolError = readLastToolErrorState(ticket.sessionRoot);
  if (!toolError) return '';

  if (toolError.retry_count >= TOOL_RETRY_STOP_THRESHOLD) {
    recordToolRetryCircuitOpen(ticket.sessionRoot, ticket.ticketId, toolError);
    return `# TOOL RETRY CIRCUIT OPEN

STOP. You have hit the same ${toolError.tool} failure ${toolError.retry_count} times.
Do not retry the same command, edit, or test path again.
Use a completely different approach: inspect the failure cause, change the implementation strategy, reduce the repro, or choose another verification path before using the failing tool again.

`;
  }

  if (toolError.retry_count >= TOOL_RETRY_ANALYZE_THRESHOLD) {
    return `# TOOL RETRY GUIDANCE

You have hit the same ${toolError.tool} failure ${toolError.retry_count} times.
Analyze and fix the root cause before retrying. Do not repeat the same tool call until you can explain what changed and why it should succeed.

`;
  }

  return '';
}

function readHandoffNotesBlock(ticketPath: string): string {
  try {
    const notesPath = path.join(ticketPath, HANDOFF_NOTES_FILE);
    if (!fs.existsSync(notesPath)) return '';
    const notes = fs.readFileSync(notesPath, 'utf-8').trim();
    return notes ? `# PRIOR ITERATION HANDOFF\n${notes}\n\n` : '';
  } catch {
    return '';
  }
}

function isArchaeologyDisabled(sessionRoot: string): boolean {
  try {
    const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json')) as State | null;
    return state?.flags?.no_archaeology === true;
  } catch {
    return false;
  }
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireFlagValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) die('Error: --ticket-id and --ticket-path require non-empty values.');
  return value;
}

function parseTimeoutArg(argv: string[]): number {
  const timeoutIndex = argv.indexOf('--timeout');
  if (timeoutIndex === -1) return Defaults.WORKER_TIMEOUT_SECONDS;
  const rawTimeout = argv[timeoutIndex + 1];
  if (!rawTimeout || !/^[1-9]\d*$/.test(rawTimeout)) {
    die(`Error: --timeout requires a positive integer, got: ${rawTimeout ?? 'missing'}`);
  }
  const parsed = Number(rawTimeout);
  if (!Number.isSafeInteger(parsed)) {
    die(`Error: --timeout requires a positive integer, got: ${rawTimeout}`);
  }
  return parsed;
}

function parseOutputFormatArg(argv: string[]): string {
  const formatIndex = argv.indexOf('--output-format');
  const rawFormat = formatIndex !== -1 ? argv[formatIndex + 1] : undefined;
  return rawFormat && !rawFormat.startsWith('--') ? rawFormat : 'text';
}

function readTicketFileArg(argv: string[]): { ticketFilePath: string | null; ticketContent: string } {
  const ticketFileIndex = argv.indexOf('--ticket-file');
  const rawTicketFile = ticketFileIndex !== -1 ? argv[ticketFileIndex + 1] : undefined;
  if (!rawTicketFile || rawTicketFile.startsWith('--') || !fs.existsSync(rawTicketFile)) {
    return { ticketFilePath: null, ticketContent: '' };
  }
  return { ticketFilePath: rawTicketFile, ticketContent: fs.readFileSync(rawTicketFile, 'utf-8') };
}

function normalizeTicketPath(ticketPath: string): string {
  if (ticketPath.endsWith('.md') || (fs.existsSync(ticketPath) && fs.statSync(ticketPath).isFile())) {
    return path.dirname(ticketPath);
  }
  return ticketPath;
}

export function parseAndValidateArgs(argv: string[]): ParsedArgs {
  if (argv.length < 1) {
    die('Usage: node spawn-morty.js <task> --ticket-id <id> --ticket-path <path> [--timeout <sec>] [--output-format <fmt>]');
  }

  const ticketIdIndex = argv.indexOf('--ticket-id');
  const ticketPathIndex = argv.indexOf('--ticket-path');
  if (ticketIdIndex === -1 || ticketPathIndex === -1) {
    die('Error: --ticket-id and --ticket-path are required.');
  }

  const ticketId = requireFlagValue(argv, ticketIdIndex);
  const ticketPath = normalizeTicketPath(requireFlagValue(argv, ticketPathIndex));
  if (!/^[a-zA-Z0-9_-]+$/.test(ticketId)) die('Error: --ticket-id contains invalid characters.');
  const explicitTicketFile = readTicketFileArg(argv);
  const inferredTicketFilePath = explicitTicketFile.ticketFilePath ?? path.join(ticketPath, `linear_ticket_${ticketId}.md`);
  const ticketFilePath = fs.existsSync(inferredTicketFilePath) ? inferredTicketFilePath : null;
  const ticketContent = ticketFilePath ? fs.readFileSync(ticketFilePath, 'utf-8') : '';
  fs.mkdirSync(ticketPath, { recursive: true });

  return {
    ticket: argv[0],
    ticketId,
    ticketPath,
    ticketFilePath,
    ticketContent,
    sessionRoot: path.dirname(ticketPath),
    sessionLogPath: path.join(ticketPath, `worker_session_${process.pid}.log`),
    backend: 'claude',
    backendOverride: parseBackendOverrideArg(argv),
    timeout: parseTimeoutArg(argv),
    outputFormat: parseOutputFormatArg(argv),
    isReviewTicket: argv.includes('--review'),
  };
}

export function parseBackendOverrideArg(argv: string[]): Backend | null {
  const idx = argv.indexOf('--backend');
  if (idx === -1) return null;
  const value = requireFlagValue(argv, idx);
  if (!isBackend(value)) {
    die(`Error: --backend must be one of claude, codex, hermes, grok, kimi, gemini (got ${JSON.stringify(value)}).`);
  }
  return value;
}

export function resolveEffectiveTimeout(
  configuredTimeoutSec: number,
  parentState: State | null,
  wallClockNowMs: number
): number {
  const maxMins = Number(parentState?.max_time_minutes);
  const startEpoch = Number(parentState?.start_time_epoch);
  if (!Number.isFinite(maxMins) || maxMins <= 0 || !Number.isFinite(startEpoch) || startEpoch <= 0) {
    return configuredTimeoutSec;
  }

  const remaining = Math.floor(maxMins * 60 - (Math.floor(wallClockNowMs / 1000) - startEpoch));
  if (remaining <= 0) return Math.max(MIN_TIMEOUT_SECONDS, configuredTimeoutSec);
  if (remaining < configuredTimeoutSec) return Math.max(MIN_TIMEOUT_SECONDS, remaining);
  return configuredTimeoutSec;
}

const ALL_LIFECYCLE_PHASES: LifecyclePhase[] = [
  'research', 'research_review', 'plan', 'plan_review',
  'implement', 'conformance', 'code_review', 'simplify',
];

export function buildTierResumeTable(phases: LifecyclePhase[]): string {
  const phaseSet = new Set<LifecyclePhase>(phases);
  const rows: string[] = [];
  let step = 1;

  if (phaseSet.has('research')) {
    rows.push(`| (none, or \`research_*.md\` missing) | ${step++} (Research) |`);
    if (phaseSet.has('research_review')) {
      rows.push(`| \`research_*.md\` exists; no \`research_review.md\` | ${step++} (Research Review) |`);
    }
  }

  if (phaseSet.has('plan')) {
    if (phaseSet.has('research_review')) {
      rows.push(`| \`research_*.md\` exists; \`research_review.md\` says \`APPROVED\`; no \`plan_*.md\` | ${step++} (Plan) |`);
    } else {
      rows.push(`| (none, or \`plan_*.md\` missing) | ${step++} (Plan) |`);
    }
    if (phaseSet.has('plan_review')) {
      rows.push(`| \`plan_*.md\` exists; no \`plan_review.md\` | ${step++} (Plan Review) |`);
      rows.push(`| \`plan_*.md\` exists; \`plan_review.md\` says \`APPROVED\`; no implementation diff | ${step++} (Implement) |`);
    } else {
      rows.push(`| \`plan_*.md\` exists; no implementation diff | ${step++} (Implement) |`);
    }
  } else {
    rows.push(`| (none, or no implementation diff) | ${step++} (Implement) |`);
  }

  if (phaseSet.has('conformance')) {
    rows.push(`| Implementation diff exists; no \`conformance_*.md\` | ${step++} (Conformance) |`);
    if (phaseSet.has('code_review')) {
      rows.push(`| \`conformance_*.md\` says \`ALL_PASS\`; no \`code_review_*.md\` | ${step++} (Code Review) |`);
    }
  } else if (phaseSet.has('code_review')) {
    rows.push(`| Implementation diff exists; no \`code_review_*.md\` | ${step++} (Code Review) |`);
  }

  if (phaseSet.has('simplify')) {
    rows.push(`| \`code_review_*.md\` says \`PASS\`; no Simplify pass evidence | ${step} (Simplify) |`);
  }

  return `| Files in \`\${TICKET_DIR}\` | Enter at step |\n|---|---|\n${rows.join('\n')}`;
}

export function buildTierLifecycleSections(phases: LifecyclePhase[], tier: string): string {
  const phaseSet = new Set<LifecyclePhase>(phases);
  const isReduced = phases.length < ALL_LIFECYCLE_PHASES.length;
  let out = `**Tier: ${tier} | Active phases: ${phases.join(', ')}**\n`;

  if (isReduced) {
    out += `\n> **Plan/Research source for skipped phases**: The ticket body (\`## Problem\`, \`## Solution\`, \`## Research Seeds\`) is the specification — read it directly in place of research/plan artifacts. No new artifact format is needed for skipped phases.\n`;
  }

  let n = 1;

  if (phaseSet.has('research')) {
    out += `\n### ${n++}. Research\nWhat IS, not SHOULD BE. No solutioning. Every claim = \`file:line\` ref.\n- Read \`\${TICKET_DIR}/linear_ticket_\${TICKET_ID}.md\`\n- **Glob**, **Grep** (not bash grep), **Read** to trace code\n- Write \`\${TICKET_DIR}/research_[date].md\`: Summary, Context (file:line), Findings, Constraints\n`;
  }

  if (phaseSet.has('research_review')) {
    out += `\n### ${n++}. Research Review\nFAIL if: proposes solutions, claims lack refs, incomplete.\n- Write \`\${TICKET_DIR}/research_review.md\`: APPROVED/NEEDS REVISION/REJECTED + feedback\n- APPROVED → next. Otherwise → redo previous.\n`;
  }

  if (phaseSet.has('plan')) {
    out += `\n### ${n++}. Plan\nRead research${phaseSet.has('research') ? '' : ' (use ticket body ## Problem / ## Solution)'}. No guessing.\n- Write \`\${TICKET_DIR}/plan_[date].md\`: Scope, Current State (file:line), Phases with Goal/Steps/Verify command\n- Self-check: strict scope? No magic steps? Every phase has verification?\n`;
  }

  if (phaseSet.has('plan_review')) {
    out += `\n### ${n++}. Plan Review\nFAIL if: vague steps, no verify commands, generic paths.\n- Write \`\${TICKET_DIR}/plan_review.md\`: APPROVED/RISKY/REJECTED\n- APPROVED → next. RISKY → revise. REJECTED → redo previous.\n`;
  }

  out += `\n### ${n++}. Implement\nNo plan = no code. Execute steps, mark \`[x]\`, verify after each phase.\n`;

  if (phaseSet.has('conformance')) {
    out += `\n### ${n++}. Spec Conformance\nWrite \`\${TICKET_DIR}/conformance_[date].md\`:\n\n1. **Acceptance Criteria**: Run each verify command from ticket's \`## Acceptance Criteria\`. For \`llm-conformance\` type: read impl, quote code, PASS/FAIL + justification. Table: \`| Criterion | Type | Command | Result | P/F |\`\n2. **Interface Contracts**: Read ticket's \`## Interface Contracts\`. Find impl signatures, resolve type aliases, compare field-by-field. Mismatch = fail.\n3. **Type Check**: Project type checker (tsc/mypy/equivalent) — no new errors in touched files.\n4. **Test Expectations**: Read ticket's \`## Test Expectations\`. Each expected test exists and passes. Table: \`| Test | File | Status |\`\n5. **Project Checks**: Read ticket's \`## Conformance Check\`. Run any additional checks listed.\n6. **Verdict**: ALL_PASS / FAIL (failures with file:line refs)\n\nALL_PASS → next. FAIL → fix, re-run.\n`;
  }

  out += `\n### ${n++}. Code Review\n\`git diff\` self-review. Write \`\${TICKET_DIR}/code_review_[date].md\`:\n1. Correctness (logic, off-by-one, null paths)\n2. Security (injection, auth, secrets, OWASP)\n3. Tests (coverage, fragile assertions, error paths)\n4. Architecture (coupling, abstraction leaks, contracts)\n5. Verdict: PASS / NEEDS_FIX (file:line refs)\n\nPASS → next. NEEDS_FIX → fix, re-verify.\n`;

  if (phaseSet.has('simplify')) {
    out += `\n### ${n}. Simplify\nModified files only (\`git diff --name-only\`). Delete dead code, merge dupes, flatten nesting (max 2), purge slop comments, replace \`any\` with project types. Verify after each file — revert if broken.\n`;
  }

  return out;
}

// --- Code Graph Context section (C5) ----------------------------------------
//
// A tier-conditional `## Code Graph Context` block injected adjacent to the tier
// lifecycle sections. The async service work lives in `buildCodegraphContextSection`
// (awaited at the spawn call site); `buildWorkerPrompt` stays synchronous and just
// injects the pre-rendered string. The builder owns the tier gate, so a trivial-tier
// ticket always yields `''` and its prompt is byte-identical with codegraph on or off.

const CODEGRAPH_SECTION_HEADER = '\n## Code Graph Context\n';
const CODEGRAPH_TRUNCATED_MARKER = '[truncated]';
const CODEGRAPH_GRAPH_PHASES: readonly LifecyclePhase[] = ['research', 'plan'];
const CODEGRAPH_MAX_TERMS = 8;
const CODEGRAPH_CALLER_HITS = 3;
const CODEGRAPH_TERM_STOPWORDS = new Set<string>([
  'into', 'with', 'from', 'this', 'that', 'when', 'then', 'tier', 'code', 'graph',
  'context', 'worker', 'prompt', 'build', 'inject', 'section', 'only', 'over',
  'each', 'them', 'their', 'must', 'should',
]);

/** True when the tier's lifecycle includes research or plan (small/medium/large; not trivial). */
export function tierUsesGraphContext(tier: string): boolean {
  const phases = (TIER_LIFECYCLE as Record<string, LifecyclePhase[]>)[tier] ?? [];
  return CODEGRAPH_GRAPH_PHASES.some((p) => phases.includes(p));
}

/**
 * Derive search terms: backticked symbols from title+ACs ∪ title nouns, deduped
 * (case-sensitive, first-occurrence wins), capped at `max` (default 8).
 */
export function deriveCodegraphTerms(title: string, acText: string, max = CODEGRAPH_MAX_TERMS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const v = raw.trim();
    if (v.length > 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const m of `${title}\n${acText}`.matchAll(/`([^`\n]+)`/g)) {
    push(m[1]);
  }
  for (const w of title.split(/[^A-Za-z0-9_]+/)) {
    if (w.length >= 4 && !CODEGRAPH_TERM_STOPWORDS.has(w.toLowerCase())) push(w);
  }
  return out.slice(0, max);
}

/**
 * Render `entries` (each a single symbol-boundary line) under the section header,
 * capped so the WHOLE returned section is ≤ `maxBytes`. Truncation drops whole
 * trailing entries and appends a `[truncated]` line — a symbol entry is never split.
 * Returns `''` when nothing (even one entry) fits.
 */
export function renderCodegraphSection(entries: string[], maxBytes: number): string {
  const sectionBytes = (lines: string[], withMarker: boolean): number => {
    const body = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    const marker = withMarker ? `${CODEGRAPH_TRUNCATED_MARKER}\n` : '';
    return Buffer.byteLength(CODEGRAPH_SECTION_HEADER + body + marker, 'utf-8');
  };
  const accepted: string[] = [];
  let truncated = false;
  for (const entry of entries) {
    accepted.push(entry);
    if (sectionBytes(accepted, false) > maxBytes) {
      accepted.pop();
      truncated = true;
      break;
    }
  }
  if (truncated) {
    while (accepted.length > 0 && sectionBytes(accepted, true) > maxBytes) {
      accepted.pop();
    }
  }
  if (accepted.length === 0) return '';
  const body = accepted.join('\n') + '\n';
  const marker = truncated ? `${CODEGRAPH_TRUNCATED_MARKER}\n` : '';
  return CODEGRAPH_SECTION_HEADER + body + marker;
}

interface CodegraphNodeLike {
  id?: unknown;
  name?: unknown;
  file?: unknown;
  filePath?: unknown;
  line?: unknown;
  startLine?: unknown;
}

function asNode(value: unknown): CodegraphNodeLike | null {
  if (!isRecord(value)) return null;
  const node = isRecord(value.node) ? value.node : value;
  return node as CodegraphNodeLike;
}

function nodeName(node: CodegraphNodeLike): string | null {
  return typeof node.name === 'string' && node.name.trim().length > 0 ? node.name.trim() : null;
}

function nodeLocation(node: CodegraphNodeLike): string {
  const file = typeof node.file === 'string' ? node.file : typeof node.filePath === 'string' ? node.filePath : null;
  const line = typeof node.line === 'number' ? node.line : typeof node.startLine === 'number' ? node.startLine : null;
  if (!file) return '';
  return line !== null ? ` (${file}:${line})` : ` (${file})`;
}

export interface CodegraphContextOptions {
  tier: string;
  title: string;
  ticketContent: string;
  service: CodegraphService | null;
  settings: CodegraphSettings;
  /** b1089e97: activity dir holding `state.json` (= `path.dirname(statePath)`) for best-effort telemetry. */
  sessionDir: string;
  /** b1089e97: ticket id stamped into `codegraph_context_injected.ticket`. */
  ticketId: string;
}

/** Collect deduped search hits (by node id, highest score wins), ranked by score desc. */
async function collectCodegraphHits(
  service: CodegraphService,
  terms: string[],
): Promise<{ node: CodegraphNodeLike }[]> {
  const hitsById = new Map<string, { node: CodegraphNodeLike; score: number }>();
  for (const term of terms) {
    const result = await service.searchNodes(term);
    if (!Array.isArray(result)) continue;
    for (const raw of result) {
      const node = asNode(raw);
      if (!node || typeof node.id !== 'string') continue;
      const score = isRecord(raw) && typeof raw.score === 'number' ? raw.score : 0;
      const prev = hitsById.get(node.id);
      if (!prev || score > prev.score) hitsById.set(node.id, { node, score });
    }
  }
  return [...hitsById.values()].sort((a, b) => b.score - a.score);
}

/** First-degree caller names for a node, or '' when none. */
async function codegraphCallerSuffix(service: CodegraphService, nodeId: string): Promise<string> {
  const callers = await service.getCallers(nodeId);
  if (!Array.isArray(callers)) return '';
  const names = callers
    .map((c) => asNode(c))
    .map((n) => (n ? nodeName(n) : null))
    .filter((n): n is string => n !== null);
  return names.length > 0 ? ` ← callers: ${names.join(', ')}` : '';
}

/** Render one symbol-boundary line per ranked hit; the top hits also get caller suffixes. */
async function buildCodegraphEntries(
  service: CodegraphService,
  ranked: { node: CodegraphNodeLike }[],
  summary: unknown,
): Promise<string[]> {
  const entries: string[] = [];
  if (typeof summary === 'string') {
    for (const line of summary.split('\n')) {
      const t = line.trim();
      if (t.length > 0) entries.push(`Summary: ${t}`);
    }
  }
  for (let i = 0; i < ranked.length; i++) {
    const node = ranked[i].node;
    const name = nodeName(node);
    if (!name) continue;
    let entry = `- \`${name}\`${nodeLocation(node)}`;
    if (i < CODEGRAPH_CALLER_HITS && typeof node.id === 'string') {
      entry += await codegraphCallerSuffix(service, node.id);
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Build the `## Code Graph Context` section, or `''` when absent. Absent on:
 * disabled settings, null service, non-graph tier (trivial), no derived terms,
 * or zero search hits. The service itself returns null on kill-switch / degraded /
 * unavailable, which collapses into the zero-hits path. Never throws.
 *
 * b1089e97: emits `codegraph_context_skipped` on the four productive-skip branches
 * (`no_service` / `non_graph_tier` / `no_terms` / `zero_hits`) and
 * `codegraph_context_injected` on success. The steady-state `disabled` branch is
 * SUPPRESSED (no emit) to avoid per-spawn flooding while the default is OFF.
 * Emission is best-effort: telemetry must never break the spawn.
 */
export async function buildCodegraphContextSection(opts: CodegraphContextOptions): Promise<string> {
  const { tier, title, ticketContent, service, settings, sessionDir, ticketId } = opts;
  const start = Date.now();

  // Best-effort telemetry sink. writeActivityEntry does NOT auto-stamp `ts`
  // (R-WSE-2) — every emit stamps it explicitly. Guarded on a usable sessionDir
  // so callers that omit it (e.g. unit tests) skip emission without throwing.
  const emit = (entry: ActivityLogEntry): void => {
    if (typeof sessionDir !== 'string' || sessionDir.length === 0) return;
    try {
      writeActivityEntry(path.join(sessionDir, 'state.json'), entry);
    } catch { /* telemetry best-effort */ }
  };
  const emitSkipped = (reason: CodegraphContextSkipReason): void => {
    try { service?.recordContextSkipped(); } catch { /* best-effort */ }
    emit({ event: 'codegraph_context_skipped', ts: new Date().toISOString(), reason });
  };

  // Branch precedence (top wins): disabled → no_service → non_graph_tier → no_terms → zero_hits.
  if (!settings.enabled) return '';                                    // disabled — SUPPRESSED, no emit
  if (!service) { emitSkipped('no_service'); return ''; }
  if (!tierUsesGraphContext(tier)) { emitSkipped('non_graph_tier'); return ''; }

  const terms = deriveCodegraphTerms(title, ticketContent);
  if (terms.length === 0) { emitSkipped('no_terms'); return ''; }

  const ranked = await collectCodegraphHits(service, terms);
  if (ranked.length === 0) { emitSkipped('zero_hits'); return ''; }

  const summary = await service.buildContext({ title, description: ticketContent.slice(0, 500) });
  const entries = await buildCodegraphEntries(service, ranked, summary);
  if (entries.length === 0) { emitSkipped('zero_hits'); return ''; }

  const section = renderCodegraphSection(entries, settings.context_max_bytes);
  // Nothing fit under context_max_bytes (renderCodegraphSection returns '') → no
  // context reaches the prompt, so this is a productive skip, not an injection
  // (mirrors the post-hits `entries.length === 0` zero_hits branch above). Without
  // this guard the injected counter + event fire with bytes:0, inflating the
  // codegraph efficacy metric the default-on decision depends on.
  if (section.length === 0) { emitSkipped('zero_hits'); return ''; }
  try { service.recordContextInjected(); } catch { /* best-effort */ }
  emit({
    event: 'codegraph_context_injected',
    ts: new Date().toISOString(),
    ticket: ticketId,
    tier,
    terms_count: terms.length,
    hits_count: ranked.length,
    bytes: Buffer.byteLength(section, 'utf-8'),
    build_ms: Math.max(0, Date.now() - start),
  });
  return section;
}

export function buildWorkerPrompt(opts: BuildWorkerPromptOptions): string {
  const { ticket } = opts;
  const extensionRoot = opts.extensionRoot ?? getExtensionRoot();
  const toolRetryGuidance = buildToolRetryGuidanceBlock(ticket);
  const handoffNotes = readHandoffNotesBlock(ticket.ticketPath);
  const promptFilename = ticket.isReviewTicket ? 'send-to-morty-review.md' : 'send-to-morty.md';
  const mortyPromptPath = path.join(os.homedir(), '.claude', 'commands', promptFilename);
  let workerPrompt: string;
  if (fs.existsSync(mortyPromptPath)) {
    workerPrompt = fs.readFileSync(mortyPromptPath, 'utf-8').replace(/\$ARGUMENTS/g, ticket.task);
  } else {
    workerPrompt = ticket.isReviewTicket
      ? `# **REVIEW REQUEST**\n${ticket.task}\n\nYou are a Review Worker. Review the preceding implementation tickets for correctness, architecture, and code quality.`
      : `# **TASK REQUEST**\n${ticket.task}\n\nYou are a Morty Worker (Pickle Rick's assistant). Implement the request above.`;
  }

  if (!ticket.isReviewTicket) {
    const tier = opts.complexityTier ?? 'medium';
    const activePhases = TIER_LIFECYCLE[tier];
    workerPrompt = workerPrompt
      .replace('{{TIER_RESUME_TABLE}}', buildTierResumeTable(activePhases))
      .replace(
        '{{TIER_LIFECYCLE_SECTIONS}}',
        buildTierLifecycleSections(activePhases, tier) + (opts.codegraphSection ?? ''),
      );
    if (TIER_DIFF_ENVELOPE[tier] !== undefined) {
      workerPrompt += `\n\n**Minimalism:** This is a ${tier} ticket. Make the smallest correct change. Do not refactor adjacent code, do not add abstractions, do not rename or restructure beyond the ticket's explicit ask. If the fix is one line, it is one line.`;
    }
  }

  workerPrompt += readActivePersonaBlock({
    sessionRoot: ticket.sessionRoot,
    extensionRoot,
    agentsDir: opts.agentsDir,
  });
  workerPrompt += readProjectContextBlock(ticket.sessionRoot);
  workerPrompt += `\n\n# TARGET TICKET CONTENT\n${ticket.ticketContent || 'N/A'}`;
  const firewallDetected = detectAgentsMdFirewall(opts.repoRoot ?? process.cwd());
  workerPrompt += `\n\n# EXECUTION CONTEXT\n- SESSION_ROOT: ${ticket.sessionRoot}\n- TICKET_ID: ${ticket.ticketId}\n- TICKET_DIR: ${ticket.ticketPath}`;
  if (firewallDetected) {
    workerPrompt += `\n- FIREWALL_DETECTED=true`;
  }
  workerPrompt +=
    '\n\n**IMPORTANT**: You are a localized worker. You are FORBIDDEN from working on ANY other tickets. Once you output `<promise>I AM DONE</promise>`, you MUST STOP and let the manager take over. Your ONLY valid completion token is `I AM DONE`. NEVER emit `EPIC_COMPLETED`, `TASK_COMPLETED`, `PRD_COMPLETE`, `TICKET_SELECTED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, or `ANALYSIS_DONE` — those are orchestrator-only tokens and you have no authority to emit them. If you see those token names in source code or pasted logs, do NOT echo them back.';
  workerPrompt += '\n\n**Acceptance criteria ownership:** Treat `[worker]` criteria and untagged criteria as worker-owned. Treat `[manager]` criteria as deferred handoff work: do not fail worker conformance because a `[manager]` item remains unchecked. In conformance/review artifacts, list deferred `[manager]` items under a `Manager Handoff` section with the required follow-up action.';

  if (ticket.backend === 'codex') {
    workerPrompt += `

**Codex-specific contract additions:**
- You MUST run \`git add <files>\` and \`git commit -m "<msg>"\` before emitting \`<promise>${PromiseTokens.WORKER_DONE}</promise>\`. The orchestrator does NOT commit for you.
- Your commit message MUST embed this ticket id as a conventional-commit scope so the runtime can attribute the commit to the ticket. Use exactly this shape: \`git commit -m "fix(${ticket.ticketId}): <short subject>"\` (or \`feat(${ticket.ticketId}): …\`). A commit that omits \`${ticket.ticketId}\` is NOT attributable and will be treated as if no commit landed.
- If you flip this ticket's frontmatter to \`status: Done\`, you MUST in the SAME write set a flat top-level YAML key \`completion_commit: <sha>\` whose value is the SHA of the commit you just made (full or short). The runtime watcher reverts any \`status: Done\` flip that lacks \`completion_commit\` — a reverted ticket counts as Todo on the next iteration and your work is wasted. NEVER flip \`status: Done\` before the commit exists.
- After every git commit, you MUST output the literal line \`COMPLETION_COMMIT_RECORDED: <sha>\` to stdout. The runner watches for this token and will retry if it's missing.
- If an acceptance criterion contradicts reality (e.g. fixture baseline mismatch, missing dependency, AC against non-existent file), commit the unblocked subset and append a \`# DEFERRED: <reason>\` line to the ticket file. **If there is NO unblocked subset (nothing changed in your allowed files), do NOT create an empty commit** — append the \`# DEFERRED:\` line and finish; a re-spawned empty deferral commit each iteration burns the per-ticket budget and the ticket never advances. DO NOT loop indefinitely trying to satisfy a contradicted AC. Do NOT flip \`status: Done\` for a deferred ticket.
- DO NOT explore harness internals (\`pickle.md\`, \`setup.js\`, \`send-to-morty.md\`, \`mux-runner.js\`). Those are orchestrator-level. Your scope is exclusively the files listed in the ticket's "Files to modify" / "Files to create" sections.`;
  }

  return `${toolRetryGuidance}${handoffNotes}${workerPrompt}`;
}

function detectAgentsMdFirewall(workingDir: string): boolean {
  const agentsPath = path.join(workingDir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) return false;
  try {
    const content = fs.readFileSync(agentsPath, 'utf-8');
    return /firewall|Stay inside the assigned working directory/i.test(content);
  } catch {
    return false;
  }
}

/**
 * P2: Post-flush guard helper. Returns true when the working dir has
 * uncommitted changes, staged changes, or commits whose committer date is
 * strictly greater than `sinceEpochSec`. Returns false on any error
 * (non-git dir, missing git binary, etc.) so the caller can fall through
 * to the original log-size heuristic for safe degradation.
 *
 * Uses `%ct` (committer epoch seconds) and a JS strict-greater comparison
 * because `git log --since=@<sec>` is not strictly greater-than — it can
 * include commits at the same second, leading to false positives when the
 * worker started immediately after a setup commit.
 */
export function checkGitEdits(workingDir: string, sinceEpochSec: number): boolean {
  try {
    const uncommitted = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    if (uncommitted.length > 0) return true;
    const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
    if (staged.length > 0) return true;
    // Inspect the last 10 commits' committer-epoch and accept iff any is
    // strictly greater than sinceEpochSec. 10 is a generous bound: a worker
    // that produced more than 10 commits is unambiguously productive.
    const cts = runCmd(['git', 'log', '-n', '10', '--pretty=format:%ct'], { cwd: workingDir, check: false });
    if (!cts) return false;
    // Accept commits whose committer-epoch is >= sinceEpochSec. The caller
    // is expected to subtract a small leniency before passing — see how
    // spawn-morty derives `startEpochSec` from `startTime` (Date.now()).
    for (const line of cts.split('\n')) {
      const ct = parseInt(line.trim(), 10);
      if (Number.isFinite(ct) && ct >= sinceEpochSec) return true;
    }
    return false;
  } catch {
    return false;
  }
}

type SessionRuntime = {
  timeoutStatePath: string | null;
  workerStatePath: string;
  state: State | null;
  sessionWorkingDir: string;
  sessionEffort?: 'low' | 'medium' | 'high' | 'xhigh';
};

type HermesWorkerOptions = {
  toolsets?: string[];
  provider?: string;
  model?: string;
  maxTurns?: number;
};

type WorkerGateTestFailure = {
  name: string;
  file: string;
  message: string;
};

type WorkerGateTier = 'narrow' | 'fast' | 'full';
type WorkerGatePhase = 'lint' | 'tsc' | 'test:fast' | 'test:integration';

type WorkerGateResult = {
  ok: boolean;
  fileList: string[];
  lintErrors: number;
  tscErrors: number;
  testFailures: WorkerGateTestFailure[];
  gatePhase: WorkerGatePhase | null;
  retryCount: number;
  autofixApplied: boolean;
  completionCommitSha: string | null;
  /**
   * 7eb9fa20: true when the gate failed but the Failed flip (and the gate-fail
   * reset) was suppressed because evidence of real work exists — fresh ticket
   * artifacts in the [spawn, exit] window OR a ticket-scoped commit. The
   * caller must preserve the ticket's frontmatter status (no Failed flip);
   * the manager-side non-runnable hold parks the ticket for triage.
   */
  failedFlipSuppressed: boolean;
};

type CommandResult = {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutMessage: string | null;
};

type WorkerGateCheckResult = {
  lintOk: boolean;
  tscOk: boolean;
  testsOk: boolean;
  lintErrors: number;
  tscErrors: number;
  testFailures: WorkerGateTestFailure[];
  gateFailures: WorkerGateTestFailure[];
  gatePhase: WorkerGatePhase | null;
};

export function resolveWorkerGateTier(
  extensionRoot: string,
  settings?: PickleSettings | null,
): WorkerGateTier {
  const settingsBag = settings ?? (() => {
    try {
      return readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json')) as PickleSettings | null;
    } catch {
      return null;
    }
  })();
  const tier = settingsBag?.worker_gate_tier;
  if (tier === 'narrow' || tier === 'fast' || tier === 'full') return tier;
  if (tier !== undefined) {
    console.warn(`[spawn-morty] WARNING: invalid worker_gate_tier "${String(tier)}"; defaulting to "fast"`);
  }
  return 'fast';
}

function killProcessTree(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  const pid = proc.pid;
  if (!pid) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }
  try {
    proc.kill(signal);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(cmd: string, args: string[], cwd: string, opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let settled = false;
    let sigtermSent = false;
    let sigkillSent = false;
    let killEscalation: ReturnType<typeof setTimeout> | null = null;

    const finalize = (status: number | null, signal: NodeJS.Signals | null, extraStderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      const stdout = stdoutChunks.join('');
      const stderr = `${stderrChunks.join('')}${extraStderr}`;
      const timeoutMessage = timedOut
        ? [
          `timed out after ${timeoutMs}ms`,
          sigkillSent
            ? 'sent SIGTERM to process tree and escalated to SIGKILL after 2000ms'
            : sigtermSent
              ? 'sent SIGTERM to process tree'
              : 'failed to signal process tree',
        ].join('; ')
        : null;
      resolve({
        ok: status === 0 && !timedOut,
        status,
        stdout,
        stderr,
        signal,
        timedOut,
        timeoutMessage,
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr?.on('data', chunk => stderrChunks.push(chunk));

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      sigtermSent = killProcessTree(child, 'SIGTERM');
      killEscalation = setTimeout(() => {
        sigkillSent = killProcessTree(child, 'SIGKILL');
      }, 2000);
      killEscalation.unref();
    }, timeoutMs);
    timeoutHandle.unref();

    child.on('error', (error) => {
      const message = safeErrorMessage(error);
      finalize(null, null, message ? `${message}\n` : '');
    });

    child.on('close', (status, signal) => {
      finalize(status, signal);
    });
  });
}

function countLintErrors(output: string): number {
  return (output.match(/\berror\b/gi) ?? []).length;
}

function countTscErrors(output: string): number {
  return (output.match(/\berror TS\d+:/g) ?? []).length;
}

function buildFallbackGateFailure(name: string, file: string, message: string): WorkerGateTestFailure[] {
  return [{ name, file, message }];
}

function normalizeTestFailureFile(locationValue: string, extensionDir: string): string {
  const trimmed = locationValue.trim().replace(/^['"]|['"]$/g, '');
  const filePath = trimmed.replace(/:\d+:\d+$/, '');
  if (!path.isAbsolute(filePath)) return filePath;
  const relativePath = path.relative(extensionDir, filePath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? relativePath
    : filePath;
}

function parseWorkerGateTestFailures(output: string, extensionDir: string): WorkerGateTestFailure[] {
  const failures: WorkerGateTestFailure[] = [];
  const lines = output.split(/\r?\n/);
  let activeFailure: WorkerGateTestFailure | null = null;

  const flushFailure = () => {
    if (!activeFailure) return;
    failures.push({
      name: activeFailure.name,
      file: activeFailure.file,
      message: activeFailure.message || activeFailure.name,
    });
    activeFailure = null;
  };

  for (const line of lines) {
    const failureStart = line.match(/^not ok(?:\s+\d+)?\s+-\s+(.+)$/);
    if (failureStart) {
      flushFailure();
      activeFailure = { name: failureStart[1].trim(), file: '', message: '' };
      continue;
    }
    if (!activeFailure) continue;
    if (line.trim() === '...') {
      flushFailure();
      continue;
    }
    const locationMatch = line.match(/location:\s*'([^']+)'/) ?? line.match(/location:\s*"([^"]+)"/);
    if (locationMatch && !activeFailure.file) {
      activeFailure.file = normalizeTestFailureFile(locationMatch[1], extensionDir);
      continue;
    }
    const errorMatch = line.match(/error:\s*'([^']+)'/) ?? line.match(/error:\s*"([^"]+)"/) ?? line.match(/error:\s*(.+)$/);
    if (errorMatch && !activeFailure.message) {
      activeFailure.message = errorMatch[1].trim();
    }
  }

  flushFailure();
  if (failures.length > 0) return failures;

  const fallbackMessage = lines.map(line => line.trim()).find(line => line.length > 0) ?? 'npm run test:fast failed';
  return [{
    name: 'npm run test:fast',
    file: '',
    message: fallbackMessage,
  }];
}

function parseWorkerGateLintFailures(output: string, extensionDir: string): WorkerGateTestFailure[] {
  const failures: WorkerGateTestFailure[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?):\d+:\d+:\s+(.+)$/);
    if (!match) continue;
    failures.push({
      name: 'eslint',
      file: normalizeTestFailureFile(match[1], extensionDir),
      message: match[2].trim(),
    });
  }
  if (failures.length > 0) return failures;
  const fallbackMessage = output.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? 'eslint failed';
  return buildFallbackGateFailure('eslint', '', fallbackMessage);
}

function parseWorkerGateTscFailures(output: string, extensionDir: string): WorkerGateTestFailure[] {
  const failures: WorkerGateTestFailure[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\(\d+,\d+\):\s+error\s+TS\d+:\s+(.+)$/);
    if (!match) continue;
    failures.push({
      name: 'tsc',
      file: normalizeTestFailureFile(match[1], extensionDir),
      message: match[2].trim(),
    });
  }
  if (failures.length > 0) return failures;
  const fallbackMessage = output.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? 'tsc failed';
  return buildFallbackGateFailure('tsc', '', fallbackMessage);
}

export async function runWorkerGateTestCommand(
  scriptName: 'test:fast' | 'test:integration',
  extensionDir: string,
  workerTestGateTimeoutMs: number,
): Promise<{
  ok: boolean;
  failures: WorkerGateTestFailure[];
  gatePhase: WorkerGatePhase;
}> {
  const commandName = `npm run ${scriptName}` as const;
  const testResult = await runCommand('npm', ['run', scriptName], extensionDir, { timeoutMs: workerTestGateTimeoutMs });
  const failures = testResult.ok
    ? []
    : testResult.timedOut
      ? [{
        name: '__timeout__',
        file: commandName,
        message: testResult.timeoutMessage ?? `killed after ${workerTestGateTimeoutMs}ms`,
      }]
      : parseWorkerGateTestFailures(`${testResult.stdout}\n${testResult.stderr}`, extensionDir);
  return {
    ok: testResult.ok,
    failures,
    gatePhase: scriptName,
  };
}

function collectChangedFilesForLintGate(workingDir: string, preWorkerHead: string | null): string[] {
  const files = new Set<string>();
  if (preWorkerHead) {
    try {
      const currentHead = getHeadSha(workingDir);
      for (const entry of getDiffFiles(preWorkerHead, currentHead, workingDir)) files.add(entry.path);
    } catch { /* best-effort */ }
  }
  try {
    for (const file of listWorkingTreeDirtyPaths(workingDir)) files.add(file);
  } catch { /* best-effort */ }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function toExtensionLintTargets(workingDir: string, fileList: string[]): string[] {
  return fileList
    .filter(file =>
      file.startsWith('extension/src/')
      && /\.(?:[cm]?[jt]sx?)$/.test(file)
      && fs.existsSync(path.join(workingDir, file))
    )
    .map(file => file.replace(/^extension\//, ''));
}

function toRepoRelativePath(workingDir: string, targetPath: string): string | null {
  const relativePath = path.relative(workingDir, targetPath);
  if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath;
}

function stageAndCommitLintAutofix(workingDir: string, ticketId: string, fileList: string[]): string | null {
  const dirtyPaths = listWorkingTreeDirtyPaths(workingDir).filter(file => fileList.includes(file));
  if (dirtyPaths.length === 0) return null;
  runCmd(['git', 'add', '--', ...dirtyPaths], { cwd: workingDir });
  runCmd(['git', 'commit', '-m', `fix(${ticketId}): worker lint autofix`, '--no-gpg-sign'], { cwd: workingDir });
  return getHeadSha(workingDir);
}

async function runWorkerGateChecks(args: {
  lintTargets: string[];
  extensionDir: string;
  workerTestGateTimeoutMs: number;
  workerGateTier: WorkerGateTier;
  ticketTier?: string;
}): Promise<WorkerGateCheckResult> {
  let lintOk = true;
  let lintErrors = 0;
  let gateFailures: WorkerGateTestFailure[] = [];
  let gatePhase: WorkerGatePhase | null = null;

  if (args.lintTargets.length > 0) {
    const lintResult = await runCommand('npx', ['eslint', ...args.lintTargets, '--max-warnings=-1'], args.extensionDir);
    const lintOutput = `${lintResult.stdout}\n${lintResult.stderr}`;
    lintErrors = countLintErrors(lintOutput);
    lintOk = lintResult.ok;
    if (!lintOk) {
      gatePhase = 'lint';
      gateFailures = parseWorkerGateLintFailures(lintOutput, args.extensionDir);
    }
  }

  const tscResult = await runCommand('npx', ['tsc', '--noEmit'], args.extensionDir);
  const tscOutput = `${tscResult.stdout}\n${tscResult.stderr}`;
  const tscErrors = countTscErrors(tscOutput);
  if (lintOk && !tscResult.ok) {
    gatePhase = 'tsc';
    gateFailures = parseWorkerGateTscFailures(tscOutput, args.extensionDir);
  }

  // Pre-test exits (lint/tsc fail, narrow tier, small tier) all report the same
  // shape: tests were not run, so testsOk:true and testFailures empty. The closure
  // captures the live lint/tsc bindings so each site reports its own settled values.
  const preTestResult = (): WorkerGateCheckResult => ({
    lintOk,
    tscOk: tscResult.ok,
    testsOk: true,
    lintErrors,
    tscErrors,
    testFailures: [],
    gateFailures,
    gatePhase,
  });

  if (!lintOk || !tscResult.ok) return preTestResult();
  if (args.workerGateTier === 'narrow') return preTestResult();
  if (args.ticketTier === 'small') return preTestResult();

  const fastTierResult = await runWorkerGateTestCommand('test:fast', args.extensionDir, args.workerTestGateTimeoutMs);
  if (!fastTierResult.ok) {
    gatePhase = fastTierResult.gatePhase;
    gateFailures = fastTierResult.failures;
  }

  if (!fastTierResult.ok || args.workerGateTier !== 'full') {
    return {
      lintOk,
      tscOk: tscResult.ok,
      testsOk: fastTierResult.ok,
      lintErrors,
      tscErrors,
      testFailures: fastTierResult.failures,
      gateFailures,
      gatePhase,
    };
  }

  const integrationTierResult = await runWorkerGateTestCommand('test:integration', args.extensionDir, args.workerTestGateTimeoutMs);
  if (!integrationTierResult.ok) {
    gatePhase = integrationTierResult.gatePhase;
    gateFailures = integrationTierResult.failures;
  }

  return {
    lintOk,
    tscOk: tscResult.ok,
    testsOk: integrationTierResult.ok,
    lintErrors,
    tscErrors,
    testFailures: integrationTierResult.failures,
    gateFailures,
    gatePhase,
  };
}

function shouldRetryWorkerGate(lintOk: boolean, tscOk: boolean, lintTargetCount: number): boolean {
  return (!lintOk || !tscOk) && lintTargetCount > 0;
}

function didWorkerGateFail(lintOk: boolean, tscOk: boolean, testsOk: boolean): boolean {
  return !lintOk || !tscOk || !testsOk;
}

/**
 * B-PXBO WS-2 (R-DOTR): persist the worker gate's already-computed `tscOk`
 * verdict into the ticket frontmatter (`WORKER_GATE_TSC_OK_FIELD`) so the
 * Done-flip guard (`guardCompletionCommitBeforeDone`) can consult it on a
 * SALVAGE / no_progress_timeout disposition WITHOUT re-running tsc (AC-DOTR-1).
 * Best-effort: the ticket frontmatter file lives under the session root (never
 * touched by the gate-fail tree reset), so the value survives. Reuses the
 * existing `upsertFrontmatterField` write path — no new schema field, no second
 * tsc invocation. Silent on any FS error so a write hiccup never blocks the
 * gate.
 */
function persistWorkerGateTscOk(statePath: string, ticketId: string, tscOk: boolean): void {
  try {
    const fp = ticketFilePath(path.dirname(statePath), ticketId);
    const raw = fs.readFileSync(fp, 'utf8');
    const upd = upsertFrontmatterField(raw, WORKER_GATE_TSC_OK_FIELD, tscOk ? 'true' : 'false');
    if (upd) fs.writeFileSync(fp, upd);
  } catch { /* best-effort — guard treats an absent field as no tsc signal */ }
}

/** R-PIAP-A3: Count total changed LOC (additions + deletions) between preWorkerHead and current HEAD. */
export function computeChangedLoc(preWorkerHead: string, workingDir: string): number {
  try {
    const currentHead = getHeadSha(workingDir);
    const out = runCmd(['git', 'diff', '--numstat', preWorkerHead, currentHead], { cwd: workingDir });
    let total = 0;
    for (const line of out.split('\n')) {
      const match = line.match(/^(\d+)\s+(\d+)\s+/);
      if (match) total += parseInt(match[1], 10) + parseInt(match[2], 10);
    }
    return total;
  } catch {
    return 0;
  }
}

// TODO(R-LINT): refactor — pre-existing 123 lines / complexity 16 introduced
// 2026-05-11 (c5e7f92a7); extract per-phase helpers in a focused PR.
// eslint-disable-next-line max-lines-per-function, complexity -- HT-1 reviewed: pre-existing length/complexity tracked by R-LINT; per-phase helper extraction deferred to a focused refactor PR.
export async function runWorkerGate(changedFiles: string[], args: {
  workingDir: string;
  ticketId: string;
  statePath: string;
  preWorkerHead: string | null;
  preservePaths?: string[];
  ticketTier?: string;
  /** 7eb9fa20: worker spawn timestamp (epoch ms) — opens the artifact-evidence window for Failed-flip suppression. */
  spawnTsMs?: number | null;
}): Promise<WorkerGateResult> {
  const fileList = [...changedFiles];
  // R-PIAP-A3: soft diff-envelope check — never hard-blocks, never reverts
  if (args.preWorkerHead && args.ticketTier) {
    const envelope = TIER_DIFF_ENVELOPE[args.ticketTier as TicketComplexityTier];
    if (envelope !== undefined) {
      try {
        const changedLoc = computeChangedLoc(args.preWorkerHead, args.workingDir);
        if (changedLoc > envelope) {
          writeActivityEntry(args.statePath, {
            event: 'tier_diff_envelope_exceeded',
            ts: new Date().toISOString(),
            ticket_id: args.ticketId,
            tier: args.ticketTier as TicketComplexityTier,
            changed_loc: changedLoc,
            envelope,
          });
          console.warn(`[spawn-morty] ⚠️  Diff envelope exceeded for ${args.ticketTier} ticket: ${changedLoc} LOC changed (envelope: ${envelope}). Soft signal — run continues.`);
        }
      } catch { /* best-effort */ }
    }
  }
  const extensionDir = path.join(args.workingDir, 'extension');
  if (!fs.existsSync(extensionDir)) {
    return {
      ok: true,
      fileList,
      lintErrors: 0,
      tscErrors: 0,
      testFailures: [],
      gatePhase: null,
      retryCount: 0,
      autofixApplied: false,
      completionCommitSha: null,
      failedFlipSuppressed: false,
    };
  }
  const lintTargets = toExtensionLintTargets(args.workingDir, fileList);
  const reportedFileList = lintTargets.length > 0
    ? lintTargets.map(target => `extension/${target}`)
    : fileList;
  let retryCount = 0;
  let autofixApplied = false;
  const workerGateTier = resolveWorkerGateTier(args.workingDir);
  const workerTestGateTimeoutMs = resolveWorkerTestGateTimeoutMs(args.workingDir);
  if (workerGateTier === 'narrow') {
    console.warn('[spawn-morty] worker gate tier downgraded to "narrow"; skipping test:fast and test:integration');
  }
  const skippedPhases = args.ticketTier === 'small'
    ? (workerGateTier === 'full' ? ['test:fast', 'test:integration'] : ['test:fast'])
    : [];
  if (skippedPhases.length > 0) {
    writeActivityEntry(args.statePath, {
      event: 'tier_phase_skipped',
      ticket_id: args.ticketId,
      tier: 'small',
      skipped_phases: skippedPhases,
      ts: new Date().toISOString(),
    });
  }
  let gateResult = await runWorkerGateChecks({
    lintTargets,
    extensionDir,
    workerTestGateTimeoutMs,
    workerGateTier,
    ticketTier: args.ticketTier,
  });
  let { lintOk, tscOk, testsOk } = gateResult;
  if (shouldRetryWorkerGate(lintOk, tscOk, lintTargets.length)) {
    autofixApplied = true;
    retryCount = 1;
    await runCommand('npx', ['eslint', '--fix', ...lintTargets, '--max-warnings=-1'], extensionDir);
    writeActivityEntry(args.statePath, {
      event: 'worker_lint_autofix_applied',
      ticket_id: args.ticketId,
      file_list: reportedFileList,
      ts: new Date().toISOString(),
    });
    gateResult = await runWorkerGateChecks({
      lintTargets,
      extensionDir,
      workerTestGateTimeoutMs,
      workerGateTier,
      ticketTier: args.ticketTier,
    });
    ({ lintOk, tscOk, testsOk } = gateResult);
  }

  // B-PXBO WS-2 (R-DOTR): persist the already-computed tscOk so the Done-flip
  // guard can read it on a salvage/no_progress_timeout disposition without
  // re-running tsc. Written on BOTH the pass and fail paths below.
  persistWorkerGateTscOk(args.statePath, args.ticketId, tscOk);

  if (didWorkerGateFail(lintOk, tscOk, testsOk)) {
    writeActivityEntry(args.statePath, {
      event: 'worker_gate_failed',
      ticket_id: args.ticketId,
      gate_phase: gateResult.gatePhase ?? (gateResult.lintErrors > 0 ? 'lint' : gateResult.tscErrors > 0 ? 'tsc' : 'test:fast'),
      failures: gateResult.gateFailures,
      retry_count: retryCount,
      ts: new Date().toISOString(),
    });
    // 7eb9fa20: before the gate-fail reset destroys the worker's tree, check
    // for evidence of real work (fresh ticket artifacts OR a ticket-scoped
    // commit). Evidence present → suppress BOTH the reset and the downstream
    // Failed flip (the manager-side non-runnable hold parks the ticket). The
    // worker cannot halt the manager loop, so a cap escalation here also just
    // preserves the work — the cap_exhausted ledger entry and the manager-side
    // callsites own the actual recovery_exhausted halt. Evidence-check errors
    // fail open (existing reset + flip behavior).
    let failedFlipSuppressed = false;
    try {
      const sessionDir = path.dirname(args.statePath);
      const parentState = readRecoverableJsonObject(args.statePath) as State | null;
      const decision = evaluateFailedFlipSuppression({
        sessionDir,
        statePath: args.statePath,
        ticketId: args.ticketId,
        workingDir: args.workingDir,
        iteration: typeof parentState?.iteration === 'number' ? parentState.iteration : 0,
        callsite: 'worker_gate_fail',
        windowStartMs: args.spawnTsMs ?? null,
        windowEndMs: Date.now(),
        preSha: args.preWorkerHead,
        log: msg => console.error(`[spawn-morty] ${msg}`),
      });
      failedFlipSuppressed = decision.action === 'suppress' || decision.action === 'escalate';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[spawn-morty] failed-flip suppression check errored (fail-open): ${msg}`);
    }
    if (failedFlipSuppressed) {
      console.error(`[spawn-morty] gate-fail reset and Failed flip suppressed for ${args.ticketId} — work preserved for triage`);
    } else if (args.preWorkerHead) {
      try {
        const preservePrefixes = (args.preservePaths ?? [])
          .map(preservePath => toRepoRelativePath(args.workingDir, preservePath))
          .filter((prefix): prefix is string => prefix !== null);
        const sessionDir = path.dirname(args.statePath);
        const ticketDir = path.join(sessionDir, args.ticketId);
        resetToSha(args.preWorkerHead, args.workingDir, preservePrefixes, {
          cwd: args.workingDir,
          sessionDir,
          ticketDir: fs.existsSync(ticketDir) ? ticketDir : null,
          reason: 'pre_reset',
        });
      } catch (err) {
        if (err instanceof ArchiveAbortError) {
          // Fail-closed: archival failed, so resetToSha never ran the reset.
          // Leave the dirty tree in place and surface the abort loudly.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[spawn-morty] gate-fail reset ABORTED (pre-reset archive failed): ${msg} — uncommitted work left in place`);
        }
        /* reset is best-effort; gate result below still reports the failure */
      }
    }
    return {
      ok: false,
      fileList,
      lintErrors: gateResult.lintErrors,
      tscErrors: gateResult.tscErrors,
      testFailures: gateResult.testFailures,
      gatePhase: gateResult.gatePhase,
      retryCount,
      autofixApplied,
      completionCommitSha: null,
      failedFlipSuppressed,
    };
  }

  const completionCommitSha = autofixApplied
    ? stageAndCommitLintAutofix(args.workingDir, args.ticketId, fileList)
    : null;
  writeActivityEntry(args.statePath, {
    event: 'worker_lint_gate_passed',
    ticket_id: args.ticketId,
    file_list: reportedFileList,
    ts: new Date().toISOString(),
  });
  return {
    ok: true,
    fileList,
    lintErrors: gateResult.lintErrors,
    tscErrors: gateResult.tscErrors,
    testFailures: gateResult.testFailures,
    gatePhase: null,
    retryCount,
    autofixApplied,
    completionCommitSha,
    failedFlipSuppressed: false,
  };
}

type WorkerFinalizeArgs = {
  ctx: WorkerProcessContext;
  exitCode: number | null;
  flushTimeout: ReturnType<typeof setTimeout>;
  startTime: number;
  resolve: (value: { exitCode: number; isSuccess: boolean }) => void;
};

/**
 * Persist the worker-turn outcome to ticket frontmatter. 7eb9fa20: a
 * suppressed gate-fail preserves the existing status — no Failed flip.
 */
function persistWorkerOutcomeStatus(input: {
  ticketId: string;
  sessionRoot: string;
  sessionWorkingDir: string;
  isSuccess: boolean;
  flipSuppressed: boolean;
  completionCommitSha: string | null;
}): void {
  try {
    if (input.isSuccess) {
      updateTicketFrontmatter(input.ticketId, input.sessionRoot, { status: 'Done', completion_commit: input.completionCommitSha ?? getHeadSha(input.sessionWorkingDir) });
    } else if (!input.flipSuppressed) {
      updateTicketFrontmatter(input.ticketId, input.sessionRoot, { status: 'Failed', completion_commit: null });
    }
  } catch {
    /* best-effort */
  }
}

function workerValidationLabel(isSuccess: boolean, flipSuppressed: boolean): string {
  if (isSuccess) return 'successful';
  return flipSuppressed ? 'failed (flip suppressed — work preserved)' : 'failed';
}

async function finalizeWorkerTurn(params: WorkerFinalizeArgs): Promise<void> {
  const { ctx, exitCode, flushTimeout, startTime, resolve } = params;
  if (ctx.mutableState.finalized) return;
  ctx.mutableState.finalized = true;
  clearTimeout(flushTimeout);

  const { ticketId, sessionRoot, sessionLogPath, sessionWorkingDir } = ctx;
  const logContent = scrubWorkerLog(sessionLogPath, readWorkerLog(sessionLogPath));
  let { isSuccess } = evaluateWorkerOutcome({ ctx, logContent, startTime });
  let completionCommitSha: string | null = null;

  let flipSuppressed = false;
  if (isSuccess) {
    const changedFiles = collectChangedFilesForLintGate(sessionWorkingDir, ctx.preWorkerHead);
    const workerGate = await runWorkerGate(changedFiles, {
      workingDir: sessionWorkingDir,
      ticketId,
      statePath: path.join(sessionRoot, 'state.json'),
      preWorkerHead: ctx.preWorkerHead,
      preservePaths: [sessionRoot],
      ticketTier: readTicketInfo(ctx.args.ticketFilePath)?.complexity_tier,
      spawnTsMs: startTime,
    });
    isSuccess = workerGate.ok;
    completionCommitSha = workerGate.completionCommitSha;
    // 7eb9fa20: suppressed gate-fail — preserve the ticket's frontmatter
    // status (no Failed flip); the worker still exits non-zero below and the
    // manager-side non-runnable hold parks the ticket for triage.
    flipSuppressed = !workerGate.ok && workerGate.failedFlipSuppressed;
  }

  persistWorkerOutcomeStatus({ ticketId, sessionRoot, sessionWorkingDir, isSuccess, flipSuppressed, completionCommitSha });

  if (isSuccess) {
    // R-CCC-2: Auto-fill completion_commit: for Done tickets that missed the ACK.
    // Kept as autoFillCompletionCommit (preserved CLI shim) — its git-log scan
    // handles the no-ACK case where completionCommitSha is null but the worker
    // committed with the ticket-id in the message. R-AFCC-DEEP-3A inlined the
    // explicit-SHA-known callsites in mux-runner.ts.
    try {
      autoFillCompletionCommit({
        sessionDir: sessionRoot,
        workingDir: sessionWorkingDir,
        ticketId,
        statePath: ctx.workerStatePath,
      });
    } catch {
      /* best-effort */
    }
  }

  printMinimalPanel('Worker Report', { status: ctx.mutableState.timedOut ? 'timeout' : `exit:${exitCode}`, validation: workerValidationLabel(isSuccess, flipSuppressed) }, isSuccess ? 'GREEN' : 'RED', '🥒');
  if (!isSuccess) {
    // The worker log stream has already been ended in the proc.close path, so
    // waiting for flushAndExit() here can miss the close event and let Node
    // fall through with exit 0 after a failed worker gate.
    process.exit(1);
  }
  resolve({ exitCode: exitCode ?? 0, isSuccess });
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function pickValidEffort(value: unknown): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  return typeof value === 'string' && VALID_EFFORTS.has(value)
    ? (value as 'low' | 'medium' | 'high' | 'xhigh')
    : undefined;
}

function readSessionRuntime(args: ParsedArgs): SessionRuntime {
  const parentStatePath = path.join(args.sessionRoot, 'state.json');
  const workerStatePath = path.join(args.ticketPath, 'state.json');
  let timeoutStatePath: string | null = null;
  if (fs.existsSync(parentStatePath)) timeoutStatePath = parentStatePath;
  else if (fs.existsSync(workerStatePath)) timeoutStatePath = workerStatePath;

  try {
    const state = timeoutStatePath ? sm.read(timeoutStatePath) : null;
    const sessionWorkingDir = state?.working_dir?.trim() ? state.working_dir : process.cwd();
    const sessionEffort = pickValidEffort(state?.effort);
    return { timeoutStatePath, workerStatePath, state, sessionWorkingDir, sessionEffort };
  } catch {
    return { timeoutStatePath, workerStatePath, state: null, sessionWorkingDir: process.cwd() };
  }
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
  return items.length > 0 ? items : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function readHermesWorkerOptions(state: State | null): HermesWorkerOptions {
  const record = state as (State & Record<string, unknown>) | null;
  if (!record) return {};
  return {
    toolsets: readStringArray(record.hermes_toolsets),
    ...(typeof record.hermes_provider === 'string' && record.hermes_provider.trim() ? { provider: record.hermes_provider } : {}),
    ...(typeof record.hermes_model === 'string' && record.hermes_model.trim() ? { model: record.hermes_model } : {}),
    maxTurns: readPositiveInteger(record.hermes_max_turns) ?? readPositiveInteger(record.max_iterations),
  };
}

function readTicketInfo(ticketFilePath: string | null): ReturnType<typeof parseTicketFrontmatter> | null {
  try {
    return ticketFilePath ? parseTicketFrontmatter(ticketFilePath) : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spawn-morty] WARNING: ticket frontmatter parse failed: ${msg}`);
    return null;
  }
}

/** Build classifier inputs from raw ticket file content. */
function buildClassifierInfoFromContent(content: string): TicketClassifierInfo {
  // Count AC bullet points after the Acceptance Criteria heading
  const acSection = /##\s+Acceptance Criteria\b([\s\S]*?)(?=\n##|$)/i.exec(content)?.[1] ?? '';
  const acCount = (acSection.match(/^\s*[-*•]\s+\S/gm) ?? []).length;
  // Count distinct backtick-enclosed file references
  const fileRefs = new Set<string>();
  for (const m of content.matchAll(/`([^`]+)`/g)) {
    const t = m[1];
    if (/\//.test(t) || /\.[a-zA-Z]{1,8}$/.test(t)) fileRefs.add(t);
  }
  // Extract LOC estimate from patterns like "~100 LOC" or "50 lines"
  const locMatch = /\b~?(\d+)(?:\s*[-–]\s*\d+)?\s*(?:LOC|lines?)\b/i.exec(content);
  const locEstimate = locMatch ? parseInt(locMatch[1], 10) : 0;
  return { fileCount: fileRefs.size, acCount, locEstimate, text: content };
}

/**
 * R-PIAP-A5: Resolve the effective complexity tier for a ticket.
 * If the frontmatter has a valid explicit `complexity_tier`, use it.
 * Otherwise, run the deterministic classifier on the ticket content.
 * Never falls back to the bare `medium` default-without-classification.
 *
 * Returns null when the ticket file cannot be read (caller falls back to
 * the parsed frontmatter value from parseTicketFrontmatter).
 */
export function resolveEffectiveTierForTicket(ticketFilePath: string | null): TicketComplexityTier | null {
  if (!ticketFilePath) return null;
  let content: string;
  try {
    content = fs.readFileSync(ticketFilePath, 'utf-8');
  } catch {
    return null;
  }
  const fm = extractFrontmatter(content);
  if (fm) {
    const rawTierMatch = /^complexity_tier:\s*(.+)$/m.exec(fm.body);
    const rawTier = rawTierMatch?.[1]?.trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (rawTier && (VALID_TICKET_COMPLEXITY_TIERS as readonly string[]).includes(rawTier)) {
      return rawTier as TicketComplexityTier;
    }
  }
  // No explicit tier — classify from content (never bare default)
  return classifyTicketTier(buildClassifierInfoFromContent(content));
}

type BackendResolution = {
  backend: Backend;
  source: BackendResolutionSource;
};

function deriveBaseSource(
  resolvedSource: 'worker_backend' | 'backend' | 'env_lock',
  state: State | { backend?: unknown } | null,
): BackendResolutionSource {
  if (resolvedSource === 'env_lock') return 'refinement-lock';
  if (resolvedSource === 'worker_backend') return 'state';
  // resolvedSource === 'backend': state.backend was used if valid; otherwise env/default
  const raw = state ? (state as { backend?: unknown }).backend : undefined;
  if (typeof raw === 'string' && (BACKENDS as readonly string[]).includes(raw)) {
    return 'state';
  }
  const env = process.env.PICKLE_BACKEND;
  if (typeof env === 'string' && (BACKENDS as readonly string[]).includes(env)) {
    return 'env';
  }
  return 'default';
}

function resolveWorkerBackendBase(sessionRoot: string): BackendResolution {
  const statePath = path.join(sessionRoot, 'state.json');
  let preloaded: State | null = null;
  try {
    preloaded = sm.read(statePath) as State | null;
  } catch { /* use null fallback */ }
  const resolved = resolveWorkerBackendFromStateFile(statePath);
  return {
    backend: resolved.backend,
    source: deriveBaseSource(resolved.source, preloaded),
  };
}

/**
 * Variant of `resolveWorkerBackendBase` that takes an already-loaded `State`
 * object instead of re-reading the state file from disk. Each `_sm.read()`
 * call triggers `recoverable-json` tmp recovery which `readdirSync`'s the
 * state's data root; on macOS test fixtures rooted at `/var/folders/.../T`
 * (the system temp dir with 70k+ entries) that single readdir takes ~6.7s,
 * so the pre-spawn flow's cumulative reads can blow past the test's 45s
 * spawnSync timeout. Manager-spawn callers without a pre-loaded state still
 * use the file-reading variant above.
 */
function resolveWorkerBackendBaseFromState(state: State | null): BackendResolution {
  const resolved = resolveWorkerBackendFromState(state);
  return {
    backend: resolved.backend,
    source: deriveBaseSource(resolved.source, state),
  };
}

function applyHeuristicBackendRouting(
  sessionBackend: BackendResolution,
  ticketInfo: ReturnType<typeof parseTicketFrontmatter> | null
): BackendResolution {
  const { backend } = sessionBackend;
  let routedReason: string | null = null;
  try {
    const settings = readRecoverableJsonObject(path.join(getExtensionRoot(), 'pickle_settings.json')) as Record<string, unknown> | null;
    if (settings?.enable_backend_routing_heuristic !== true || backend !== 'codex') return sessionBackend;
    if (ticketInfo?.complexity_tier === 'large') {
      routedReason = 'complexity_tier=large';
    } else if (ticketInfo?.title && /\b(UI|Wire|Audit)\b/i.test(ticketInfo.title)) {
      routedReason = `title-signal:${ticketInfo.title}`;
    }
  } catch { /* settings missing or unreadable: no override */ }

  if (!routedReason) return sessionBackend;
  console.error(`[spawn-morty] backend routed: codex → claude (reason: ${routedReason})`);
  return { backend: 'claude', source: 'settings' };
}

function routeBackend(
  sessionRoot: string,
  ticketInfo: ReturnType<typeof parseTicketFrontmatter> | null,
  backendOverride: Backend | null,
  preloadedState?: State | null,
): BackendResolution {
  // Refinement lock is non-overridable. Preserves the
  // refinement-team-claude-only carve-out (R-XBL-2 spec).
  if (process.env.PICKLE_REFINEMENT_LOCK === '1') {
    return { backend: 'claude', source: 'refinement-lock' };
  }
  // R-XBL-2: `--backend <name>` CLI flag wins over state/env/heuristic. The
  // caller emits a `worker_spawn_backend_override` activity event so the
  // bypass is auditable.
  if (backendOverride) {
    return { backend: backendOverride, source: 'cli-flag-override' };
  }
  // When the caller has already read state via StateManager, prefer the
  // in-memory variant to avoid a second `_sm.read()`. Each redundant read
  // re-runs `recoverable-json` tmp recovery (full `readdirSync` of the
  // data root) which is the dominant cost on macOS test fixtures rooted
  // in `/var/folders/.../T`.
  const base = preloadedState !== undefined
    ? resolveWorkerBackendBaseFromState(preloadedState)
    : resolveWorkerBackendBase(sessionRoot);
  return applyHeuristicBackendRouting(base, ticketInfo);
}

/**
 * Resolve the codex `-m <model>` flag for worker/manager spawns.
 *
 * Precedence:
 *   1. `state.codex_model` (trimmed, non-empty) — per-session override.
 *   2. `pickle_settings.default_codex_model` — global default.
 *   3. `undefined` — codex CLI falls back to its compiled-in default.
 *
 * Combined with `--ignore-user-config`, absent values mean codex never sees a
 * `-m` flag. This is a TRAP DOOR: see extension/CLAUDE.md
 * `src/bin/spawn-morty.ts (codex model resolution)`.
 */
export function resolveCodexModel(extensionRoot: string, state: State | null): string | undefined {
  const stateModel = state?.codex_model;
  if (typeof stateModel === 'string' && stateModel.trim().length > 0) {
    return stateModel.trim();
  }
  try {
    const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json')) as PickleSettings | null;
    const settingsModel = settings?.default_codex_model;
    if (typeof settingsModel === 'string' && settingsModel.trim().length > 0) {
      return settingsModel.trim();
    }
  } catch { /* settings missing or unreadable: codex CLI default */ }
  return undefined;
}

function resolveBackendModel(
  state: State | null,
  field: 'grok_model' | 'kimi_model' | 'gemini_model'
): string | undefined {
  const m = (state as (State & Record<string, unknown>) | null)?.[field];
  if (typeof m === 'string' && m.trim().length > 0) return m.trim();
  return undefined;
}

// Named per-backend adapters over the shared resolver. The names are the documented
// resolution contract for the `grok_model`/`kimi_model`/`gemini_model` state fields
// (see extension/CLAUDE.md state.json Field Invariants), so they stay as live symbols.
function resolveGrokModel(state: State | null): string | undefined {
  return resolveBackendModel(state, 'grok_model');
}

function resolveKimiModel(state: State | null): string | undefined {
  return resolveBackendModel(state, 'kimi_model');
}

function resolveGeminiModel(state: State | null): string | undefined {
  return resolveBackendModel(state, 'gemini_model');
}

function resolveWorkerModel(
  backend: Backend,
  extensionRoot: string,
  sessionRoot: string,
  ticketInfo: ReturnType<typeof parseTicketFrontmatter> | null,
  state: State | null
): string | undefined {
  if (backend === 'codex') return resolveCodexModel(extensionRoot, state);
  if (backend === 'grok') return resolveGrokModel(state);
  if (backend === 'kimi') return resolveKimiModel(state);
  if (backend === 'gemini') return resolveGeminiModel(state);
  if (backend !== 'claude') return undefined;
  let enableComplexityTiers = true;
  try {
    const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json')) as PickleSettings | null;
    if (settings?.enable_complexity_tiers === false) enableComplexityTiers = false;
  } catch { /* default true */ }
  try {
    const personaModel = resolvePhasePersonaModel(sessionRoot, extensionRoot);
    return enableComplexityTiers
      ? resolveWorkerModelFromTierAndPersona(ticketInfo?.complexity_tier, personaModel)
      : 'sonnet';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spawn-morty] WARNING: complexity tier subsystem failed: ${msg}`);
    return 'sonnet';
  }
}

function readWorkerLog(sessionLogPath: string): string {
  try {
    return fs.readFileSync(sessionLogPath, 'utf-8');
  } catch (err) {
    console.error(`${Style.YELLOW}⚠️  Could not read worker log: ${safeErrorMessage(err)}${Style.RESET}`);
    return '';
  }
}

function scrubWorkerLog(sessionLogPath: string, logContent: string): string {
  if (!logContent) return logContent;
  const scrub = scrubForbiddenWorkerTokens(logContent);
  const replacedTokens = Object.keys(scrub.replacements);
  if (replacedTokens.length === 0) return logContent;
  const summary = replacedTokens.map(t => `${t}=${scrub.replacements[t]}`).join(', ');
  console.error(`${Style.YELLOW}⚠️  Worker emitted forbidden orchestrator token(s) — scrubbed to ${PromiseTokens.WORKER_DONE}: ${summary}${Style.RESET}`);
  try {
    fs.writeFileSync(sessionLogPath, scrub.scrubbed, 'utf-8');
  } catch (err) {
    console.error(`${Style.YELLOW}⚠️  Could not persist scrubbed worker log: ${safeErrorMessage(err)}${Style.RESET}`);
  }
  return scrub.scrubbed;
}

function readTicketFiles(ticketPath: string): string[] {
  try {
    return fs.readdirSync(ticketPath);
  } catch {
    return [];
  }
}

function buildValidationFailureReasons(checks: {
  timedOut: boolean;
  tokenPresent: boolean;
  hasArtifact: boolean;
  role: string;
  logContentLength: number;
  logNonTrivial: boolean;
  hasEdits: boolean;
}): string {
  return [
    checks.timedOut ? 'timeout' : null,
    !checks.tokenPresent ? 'no WORKER_DONE token' : null,
    !checks.hasArtifact ? `no ${checks.role} lifecycle artifact` : null,
    (!checks.logNonTrivial && !checks.hasEdits) ? `log ${checks.logContentLength}B < 200B and no git edits` : null,
  ].filter(Boolean).join(', ');
}

function bestEffortFdatasync(logPath: string) {
  try {
    const fd = fs.openSync(logPath, 'a');
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
  } catch { /* best-effort */ }
}

function attachCompletionCommitAckListener(
  proc: ReturnType<typeof spawn>,
  ticketId: string,
  workerActivityStatePath: string,
) {
  // R-CCC-1: Detect COMPLETION_COMMIT_RECORDED: <sha> token in worker stdout.
  // The announced SHA is recorded as a `worker_completion_commit_announced`
  // activity event; the manager's Done-flip guard (mux-runner
  // `guardCompletionCommitBeforeDone`) consults it on the absent-evidence path
  // (R-CCEM #126). NOTE: attribution is done MANAGER-side (only on the legitimate
  // Done-flip path), NOT here — persisting evidence at announce-time would also
  // feed the worker-gate failed-flip-suppression and wrongly preserve a
  // gate-failing ticket's commit.
  let ackLineBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    ackLineBuf += chunk.toString('utf8');
    const newlineIdx = ackLineBuf.lastIndexOf('\n');
    if (newlineIdx < 0) return;
    const toScan = ackLineBuf.slice(0, newlineIdx + 1);
    ackLineBuf = ackLineBuf.slice(newlineIdx + 1);
    COMPLETION_COMMIT_ACK_RE.lastIndex = 0;
    const match = COMPLETION_COMMIT_ACK_RE.exec(toScan);
    if (match?.[1]) {
      try {
        writeActivityEntry(workerActivityStatePath, {
          event: 'worker_completion_commit_announced',
          source: 'pickle',
          ticket_id: ticketId,
          sha: match[1],
          ts: new Date().toISOString(),
        });
      } catch { /* best-effort */ }
    }
  });
}

function evaluateWorkerOutcome(params: {
  ctx: WorkerProcessContext;
  logContent: string;
  startTime: number;
}): { isSuccess: boolean; role: 'review' | 'implementation' } {
  const { ctx, logContent, startTime } = params;
  const role = ctx.args.isReviewTicket ? 'review' : 'implementation';
  const ticketFiles = readTicketFiles(ctx.ticketPath);
  const tokenPresent = hasToken(logContent, PromiseTokens.WORKER_DONE);
  const logNonTrivial = logContent.length > 200;
  const hasArtifact = hasLifecycleArtifact(ticketFiles, role);
  const hasEdits = checkGitEdits(ctx.sessionWorkingDir, Math.floor(startTime / 1000));
  const isSuccess = !ctx.mutableState.timedOut && tokenPresent && hasArtifact && (logNonTrivial || hasEdits);
  if (!isSuccess) {
    const reasons = buildValidationFailureReasons({
      timedOut: ctx.mutableState.timedOut, tokenPresent, hasArtifact, role,
      logContentLength: logContent.length, logNonTrivial, hasEdits,
    });
    console.error(`${Style.RED}Worker validation failed: ${reasons}${Style.RESET}`);
  }
  return { isSuccess, role };
}

// Native-CLI backends whose missing binary surfaces as ENOENT → exit 127 + a
// `<backend>_binary_missing` log line. Single source of truth for both the exit-code
// mapping and the emission below; add a new native-CLI backend here only.
const NATIVE_CLI_BINARY_MISSING_BACKENDS: readonly Backend[] = ['hermes', 'grok', 'kimi', 'gemini'];

export async function runWorkerProcess(ctx: WorkerProcessContext): Promise<{ exitCode: number; isSuccess: boolean }> {
  const { args, ticketPath, ticketId, sessionRoot, sessionLog, sessionLogPath, sessionWorkingDir } = ctx;
  // C7: resolve session-merged worker MCP config (expose_mcp_to_workers).
  // The file is materialized by setup.ts:materializeWorkerMcpConfig at session
  // init.  Only forwarded for the claude backend — other backends don't accept
  // --mcp-config and buildWorkerInvocation routes them away from the clause
  // that reads this field.
  const sessionMcpPath = path.join(sessionRoot, 'mcp', 'worker-mcp.json');
  const resolvedMcpConfig =
    args.backend === 'claude' && fs.existsSync(sessionMcpPath)
      ? sessionMcpPath
      : undefined;
  const invocation = buildWorkerInvocation(args.backend, {
    prompt: ctx.prompt,
    addDirs: [getExtensionRoot(), getDataRoot(), sessionWorkingDir, ticketPath],
    model: ctx.model,
    outputFormat: args.outputFormat,
    effort: ctx.effort,
    mcpConfig: resolvedMcpConfig,
    ...(args.backend === 'hermes' ? ctx.hermesOptions : {}),
  });
  try { updateTicketStatus(ticketId, 'In Progress', sessionRoot); } catch { /* best-effort */ }
  sessionLog.on('error', err => console.error(`${Style.RED}❌ Log stream error: ${safeErrorMessage(err)}${Style.RESET}`));
  const env: NodeJS.ProcessEnv = { ...process.env, ...backendEnvOverrides(args.backend), ...(invocation.env ?? {}), ...sessionStampEnv(path.basename(sessionRoot), sessionWorkingDir), PICKLE_STATE_FILE: ctx.timeoutStatePath || ctx.workerStatePath, PICKLE_ROLE: 'worker', PYTHONUNBUFFERED: '1' };
  delete env['CLAUDECODE'];
  // R-CSI / W2.R1: detach so the worker subtree leads its own process group;
  // killProcessTree's existing `process.kill(-pid, sig)` then reaps exactly this
  // session's group and cannot reach a concurrent session's healthy workers.
  // PICKLE_RECOVERY_CONSOLIDATION=off reverts to the per-seam (non-detached) path.
  //
  // H2 DATA-FLOW FIX (aee2767b): the DETACHED large-tier lifecycle worker is the
  // EXCEPTION — it must INHERIT spawn-morty's (already session-scoped) process group,
  // NOT lead its own. mux-runner spawns THIS spawn-morty process `detached:true`, so
  // spawn-morty is itself the session group leader and `state.detached_worker.worker_pid`
  // is spawn-morty's pid. The orchestrator timeout-reap does `process.kill(-worker_pid)`
  // (mux-runner.ts:reapTimedOutDetachedWorker) — a group kill of spawn-morty's group.
  // If this claude grandchild led its OWN group (the prior `detached:true` here) it would
  // ESCAPE spawn-morty's group, so `-worker_pid` would kill only the spawn-morty wrapper
  // and ORPHAN the runaway worker (empirically: grandchild survives the reap) — defeating
  // the timeout backstop and letting salvage mutate git while the worker still runs.
  // Keeping the grandchild in spawn-morty's group makes the single `-worker_pid` group
  // kill reap the WHOLE subtree. spawn-morty's own timeout reap still works: with the
  // grandchild non-detached, `killProcessTree(proc)` falls back to the single-proc
  // `proc.kill()` (spawn-morty.ts:killProcessTree). Cross-session isolation is preserved
  // because spawn-morty's group is itself session-scoped.
  const detachWorker = shouldForceDetachForLargeTier() ? false : shouldIsolateSessionGroup();
  const proc = spawn(invocation.cmd, invocation.args, { cwd: sessionWorkingDir, env, stdio: ['inherit', 'pipe', 'pipe'], detached: detachWorker });
  proc.stdout?.pipe(sessionLog, { end: false });
  proc.stderr?.pipe(sessionLog, { end: false });
  attachCompletionCommitAckListener(proc, ticketId, path.join(sessionRoot, 'state.json'));

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  const startTime = Date.now();
  const interval = setInterval(() => {
    if (!process.stdout.isTTY) return;
    const spinChar = spinner[idx % spinner.length];
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   ${Style.CYAN}${spinChar}${Style.RESET} Worker Active... ${Style.DIM}[${formatTime(elapsed)}]${Style.RESET}\x1b[K`);
    idx++;
  }, 100);
  let killEscalation: ReturnType<typeof setTimeout> | null = null;
  const timeoutHandle = setTimeout(() => {
    ctx.mutableState.timedOut = true;
    console.log(`\n${Style.RED}❌ Worker timed out after ${Math.floor(ctx.effectiveTimeoutMs / 1000)}s${Style.RESET}`);
    // R-CSI / W2.R1: reap the whole session-scoped worker group (detached →
    // `process.kill(-pid)`); fall back to the leader-only kill when the group is
    // gone or the kill-switch reverted to the non-detached per-seam path.
    if (!killProcessTree(proc, 'SIGTERM')) { try { proc.kill('SIGTERM'); } catch { /* already dead */ } }
    killEscalation = setTimeout(() => {
      if (!killProcessTree(proc, 'SIGKILL')) { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }
    }, 2000);
  }, ctx.effectiveTimeoutMs);
  const hangGuard = setTimeout(async () => {
    console.error(`${Style.RED}❌ Worker hang detected — forcing exit${Style.RESET}`);
    bestEffortFdatasync(sessionLogPath);
    try { updateTicketStatus(ticketId, 'Failed', sessionRoot); } catch { /* best-effort */ }
    await flushAndExit(sessionLog, 1);
  }, ctx.effectiveTimeoutMs + 30_000);
  hangGuard.unref();

  return new Promise(resolve => {
    let spawnErrorHandled = false;
    const clearLifecycleTimers = () => {
      clearInterval(interval);
      clearTimeout(timeoutHandle);
      if (killEscalation) clearTimeout(killEscalation);
      clearTimeout(hangGuard);
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    };
    const _spawnCrumb = (label: string) => { if (process.env.PICKLE_DEBUG_SPAWN_MORTY === '1') process.stderr.write(`[SMTEST-1:SPAWN] ${label}\n`); };
    proc.on('error', async err => {
      _spawnCrumb(`proc.error fired — code=${(err as NodeJS.ErrnoException).code}`);
      spawnErrorHandled = true;
      clearLifecycleTimers();
      const errorCode = (err as NodeJS.ErrnoException).code;
      const isNativeCliEnoent = NATIVE_CLI_BINARY_MISSING_BACKENDS.includes(args.backend) && errorCode === 'ENOENT';
      const exitCode = isNativeCliEnoent ? 127 : 1;
      if (isNativeCliEnoent) {
        sessionLog.write(JSON.stringify({
          event: `${args.backend}_binary_missing`,
          ts: new Date().toISOString(),
          ticket: ticketId,
          backend: args.backend,
          command: invocation.cmd,
        }) + '\n');
      }
      console.error(`${Style.RED}[pickle-rick] Failed to spawn '${invocation.cmd}' (backend=${args.backend}): ${safeErrorMessage(err)}${Style.RESET}`);
      _spawnCrumb('before updateTicketStatus');
      try { updateTicketStatus(ticketId, 'Failed', sessionRoot); } catch { /* best-effort */ }
      _spawnCrumb('after updateTicketStatus — before printMinimalPanel');
      printMinimalPanel('Worker Report', { status: 'spawn-error', validation: 'failed' }, 'RED', '🥒');
      _spawnCrumb('before flushAndExit');
      await flushAndExit(sessionLog, exitCode);
      _spawnCrumb('after flushAndExit — should never reach here');
    });
    proc.on('close', code => {
      _spawnCrumb(`proc.close fired — code=${code} spawnErrorHandled=${spawnErrorHandled}`);
      // When spawn fails with ENOENT, node emits both 'error' and 'close' events.
      // The 'error' handler owns the exit semantics (e.g. 127 for hermes missing);
      // skip the normal close flow so it cannot race ahead with `process.exit(1)`.
      if (spawnErrorHandled) return;
      clearLifecycleTimers();
      const flushTimeout = setTimeout(() => {
        console.error(`${Style.YELLOW}⚠️  Log flush timed out — reading partial log${Style.RESET}`);
        finalize(code);
      }, 5000);
      sessionLog.once('finish', () => {
        clearTimeout(flushTimeout);
        finalize(code);
      });
      sessionLog.end();

      async function finalize(exitCode: number | null) {
        await finalizeWorkerTurn({ ctx, exitCode, flushTimeout, startTime, resolve });
      }
    });
  });
}

// eslint-disable-next-line max-lines-per-function, complexity -- HT-1 reviewed: R-SMTEST-1 (ticket 1b57ef57) diagnostic breadcrumb instrumentation env-gated by PICKLE_DEBUG_SPAWN_MORTY; R-SMTEST-2 (ticket 910ae36c) early-exit invariant guard appended.
async function main() {
  // R-SMTEST early-exit invariant — see ticket 1b57ef57
  const _smDebug = process.env.PICKLE_DEBUG_SPAWN_MORTY === '1';
  function _smCrumb(label: string): void { if (_smDebug) process.stderr.write(`[SMTEST-1:CRUMB] ${label}\n`); }
  _smCrumb('main() entered');
  const parsed = parseAndValidateArgs(process.argv.slice(2));
  _smCrumb(`parseAndValidateArgs done — sessionRoot=${parsed.sessionRoot} ticketPath=${parsed.ticketPath}`);
  // R-SMTEST early-exit invariant — see prds/p1-bug-fix-bundle-b-release-drift-2026-05-26.md
  const _dataRoot = getDataRoot();
  if (!path.resolve(parsed.ticketPath).startsWith(_dataRoot + path.sep)) {
    process.stderr.write(JSON.stringify({
      event: 'spawn_morty_invalid_ticket_path',
      ts: new Date().toISOString(),
      ticket_path: parsed.ticketPath,
      data_root: _dataRoot,
    }) + '\n');
    console.error(`[spawn-morty] --ticket-path "${parsed.ticketPath}" is outside data root "${_dataRoot}". Aborting.`);
    process.exit(1);
  }
  const runtime = readSessionRuntime(parsed);
  _smCrumb(`readSessionRuntime done — state=${runtime.state ? 'loaded' : 'null'}`);
  const ticketInfo = readTicketInfo(parsed.ticketFilePath);
  _smCrumb('readTicketInfo done');
  // R-PIAP-A5: classify if no explicit tier was set (never bare medium default)
  if (ticketInfo) {
    const resolvedTier = resolveEffectiveTierForTicket(parsed.ticketFilePath);
    if (resolvedTier) ticketInfo.complexity_tier = resolvedTier;
  }
  // R-PIAP-A2: resolve effective tier for prompt injection and lifecycle-skip telemetry
  const effectiveTier: TicketComplexityTier = (ticketInfo?.complexity_tier ?? 'medium') as TicketComplexityTier;
  const requestedTimeout = ticketInfo
    ? getTicketTierBudgetWithOverrides(runtime.state, ticketInfo.complexity_tier).worker_timeout_seconds
    : parsed.timeout;
  const effectiveTimeout = resolveEffectiveTimeout(requestedTimeout, runtime.state, Date.now());
  if (runtime.state && effectiveTimeout > requestedTimeout) {
    console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
  } else if (effectiveTimeout < requestedTimeout) {
    console.log(`${Style.YELLOW}⚠️  Worker timeout clamped: ${effectiveTimeout}s${Style.RESET}`);
  }

  const statePath = path.join(parsed.sessionRoot, 'state.json');
  // R-PIAP-A2: emit tier_phase_skipped for lifecycle phases pruned by the tier
  if (!parsed.isReviewTicket) {
    const lifecycleSkipped = ALL_LIFECYCLE_PHASES.filter(p => !TIER_LIFECYCLE[effectiveTier].includes(p));
    if (lifecycleSkipped.length > 0) {
      try {
        writeActivityEntry(statePath, {
          event: 'tier_phase_skipped',
          ticket_id: parsed.ticketId,
          tier: effectiveTier,
          skipped_phases: lifecycleSkipped,
          ts: new Date().toISOString(),
        });
      } catch { /* best-effort */ }
    }
  }
  // Reuse `runtime.state` (already loaded via `_sm.read()` in `readSessionRuntime`)
  // for downstream backend resolution. Each fresh `_sm.read()` re-runs
  // `recoverable-json` tmp recovery, which `readdirSync`'s the data root;
  // on macOS test fixtures landing in `/var/folders/.../T` (~70k entries)
  // a single readdir is ~6.7s and the pre-spawn flow used to do three of them.
  const workerBackendResolution = resolveWorkerBackendFromState(runtime.state);
  _smCrumb('resolveWorkerBackendFromState done');
  const { backend, source } = routeBackend(parsed.sessionRoot, ticketInfo, parsed.backendOverride, runtime.state);
  _smCrumb(`routeBackend done — backend=${backend} source=${source}`);
  const preSpawn = assertBackendPreSpawn({
    statePath,
    resolvedBackend: backend,
    source,
  });
  _smCrumb(`assertBackendPreSpawn done — mode=${preSpawn.mode}`);
  if (preSpawn.mode === 'mismatch') {
    try {
      writeActivityEntry(path.join(parsed.sessionRoot, 'state.json'), {
        event: 'worker_spawn_backend_mismatch',
        ts: new Date().toISOString(),
        source,
        pid: process.pid,
        ticket: parsed.ticketId,
        session: path.basename(parsed.sessionRoot),
        resolved_backend: preSpawn.resolvedBackend,
        state_backend: preSpawn.stateBackend,
      } as {
        event: 'worker_spawn_backend_mismatch';
        ts: string;
        source: 'pickle' | 'hook' | 'persona' | BackendResolutionSource;
        pid: number;
        ticket: string;
        session: string;
        resolved_backend: Backend;
        state_backend?: Backend;
      });
    } catch {
      /* best-effort telemetry */
    }
    console.error(`[spawn-morty] backend mismatch: resolved=${preSpawn.resolvedBackend}, state=${preSpawn.stateBackend}; aborting worker spawn`);
    process.exit(1);
  }
  _smCrumb(`entering writeActivityEntry block — statePath=${statePath}`);
  try {
    _smCrumb('before writeActivityEntry worker_backend_resolved');
    writeActivityEntry(statePath, {
      event: 'worker_backend_resolved',
      ts: new Date().toISOString(),
      ticket_id: parsed.ticketId,
      backend: workerBackendResolution.managerBackend,
      worker_backend: workerBackendResolution.workerBackend,
      source: workerBackendResolution.source,
    });
    _smCrumb('after writeActivityEntry worker_backend_resolved');
    writeActivityEntry(statePath, {
      event: 'worker_spawn_backend_resolved',
      ts: new Date().toISOString(),
      backend,
      source,
      pid: process.pid,
      ticket: parsed.ticketId,
      session: path.basename(parsed.sessionRoot),
    });
    _smCrumb('after writeActivityEntry worker_spawn_backend_resolved');
    if (source === 'cli-flag-override' && parsed.backendOverride) {
      writeActivityEntry(statePath, {
        event: 'worker_spawn_backend_override',
        ts: new Date().toISOString(),
        backend: parsed.backendOverride,
        source,
        pid: process.pid,
        ticket: parsed.ticketId,
        session: path.basename(parsed.sessionRoot),
      });
    }
  } catch {
    /* best-effort telemetry */
  }
  _smCrumb('writeActivityEntry block done');
  const args = { ...parsed, backend };
  const extensionRoot = getExtensionRoot();
  _smCrumb(`getExtensionRoot done — extensionRoot=${extensionRoot}`);
  const model = resolveWorkerModel(backend, extensionRoot, parsed.sessionRoot, ticketInfo, runtime.state);
  _smCrumb(`resolveWorkerModel done — model=${model}`);
  _smCrumb('before printMinimalPanel');
  printMinimalPanel(
    args.isReviewTicket ? 'Spawning Review Worker' : 'Spawning Morty Worker',
    { Request: args.ticket, Ticket: args.ticketId, Type: args.isReviewTicket ? 'review' : 'implementation', Format: args.outputFormat, Backend: backend, Timeout: `${effectiveTimeout}s (Req: ${requestedTimeout}s)`, PID: process.pid },
    args.isReviewTicket ? 'MAGENTA' : 'CYAN',
    '🥒'
  );
  _smCrumb('after printMinimalPanel — before codegraph context');
  // Fail-open: codegraph context is best-effort and must never block a worker spawn.
  let codegraphSection = '';
  if (!args.isReviewTicket) {
    try {
      const cgSettings = resolveCodegraphSettings(loadPickleSettingsBag());
      const cgService = CodegraphService.create(runtime.sessionWorkingDir, cgSettings, {});
      try {
        codegraphSection = await buildCodegraphContextSection({
          tier: effectiveTier,
          title: args.ticket,
          ticketContent: args.ticketContent,
          service: cgService,
          settings: cgSettings,
          // Activity dir = the session root that holds state.json (the
          // `path.dirname(statePath)` per the b1089e97 contract; in main() the
          // state file lives at `<sessionRoot>/state.json`).
          sessionDir: args.sessionRoot,
          ticketId: args.ticketId,
        });
      } finally {
        cgService.close();
      }
    } catch (err) {
      _smCrumb(`codegraph context skipped (ignored): ${safeErrorMessage(err)}`);
      codegraphSection = '';
    }
  }
  _smCrumb('after codegraph context — before buildWorkerPrompt');
  const prompt = buildWorkerPrompt({
    ticket: { task: args.ticket, ticketContent: args.ticketContent, ticketId: args.ticketId, ticketPath: args.ticketPath, sessionRoot: args.sessionRoot, backend, isReviewTicket: args.isReviewTicket },
    model: model ?? 'sonnet',
    repoRoot: runtime.sessionWorkingDir,
    complexityTier: effectiveTier,
    codegraphSection,
  });
  _smCrumb('buildWorkerPrompt done — before runWorkerProcess');
  const sessionLog = fs.createWriteStream(args.sessionLogPath, { flags: 'w' });
  await runWorkerProcess({
    args, prompt, ticketPath: args.ticketPath, ticketId: args.ticketId, sessionRoot: args.sessionRoot, sessionLog,
    sessionLogPath: args.sessionLogPath, sessionWorkingDir: runtime.sessionWorkingDir,
    timeoutStatePath: runtime.timeoutStatePath, workerStatePath: runtime.workerStatePath,
    effectiveTimeoutMs: effectiveTimeout * 1000, mutableState: { finalized: false, timedOut: false },
    model, effort: runtime.sessionEffort, hermesOptions: readHermesWorkerOptions(runtime.state),
    preWorkerHead: (() => {
      try { return getHeadSha(runtime.sessionWorkingDir); } catch { return null; }
    })(),
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-morty.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}${msg}${Style.RESET}`);
    process.exit(1);
  });
}
