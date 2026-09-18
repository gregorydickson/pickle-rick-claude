import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runGate, filterByScope, isCheckUnmeasured, resolveLexicalRepoRoot, type RunGateOpts } from '../services/convergence-gate.js';
import { spawnGateRemediatorMain } from './spawn-gate-remediator.js';
import { readMicroverseState, readRecoverableJsonObject } from '../services/microverse-state.js';
import { logActivity } from '../services/activity-logger.js';
import { getExtensionRoot, isoCompactStamp, safeErrorMessage, writeStateFile } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { runAcPhaseGate } from '../services/ac-phase-gate.js';
import {
  buildWorkerInvocation,
  backendEnvOverrides,
  resolveBackend,
} from '../services/backend-spawn.js';
import type { GateResult, GateFailure, Backend, ActivityEventType } from '../types/index.js';

const VALID_SKILLS = new Set(['szechuan', 'anatomy-park']);
const sm = new StateManager();

export interface FinalizeGateSettings {
  szechuan_max_remediation_cycles: number;
  anatomy_park_max_remediation_cycles: number;
  // R-HRP-1: citadel feeds findings to the remediator (it no longer halts); this bounds the
  // citadel remediation loop. Lives alongside the other *_max_remediation_cycles caps and reuses
  // the shared remediator_timeout_s.
  citadel_max_remediation_cycles: number;
  remediator_timeout_s: number;
}

const DEFAULT_FINALIZE_GATE_SETTINGS: FinalizeGateSettings = {
  szechuan_max_remediation_cycles: 3,
  anatomy_park_max_remediation_cycles: 5,
  citadel_max_remediation_cycles: 3,
  remediator_timeout_s: 600,
};

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeFinalizeGateSettings(raw: Partial<FinalizeGateSettings> | null | undefined): FinalizeGateSettings {
  return {
    szechuan_max_remediation_cycles: positiveIntegerOrDefault(raw?.szechuan_max_remediation_cycles, DEFAULT_FINALIZE_GATE_SETTINGS.szechuan_max_remediation_cycles),
    anatomy_park_max_remediation_cycles: positiveIntegerOrDefault(raw?.anatomy_park_max_remediation_cycles, DEFAULT_FINALIZE_GATE_SETTINGS.anatomy_park_max_remediation_cycles),
    citadel_max_remediation_cycles: positiveIntegerOrDefault(raw?.citadel_max_remediation_cycles, DEFAULT_FINALIZE_GATE_SETTINGS.citadel_max_remediation_cycles),
    remediator_timeout_s: positiveIntegerOrDefault(raw?.remediator_timeout_s, DEFAULT_FINALIZE_GATE_SETTINGS.remediator_timeout_s),
  };
}

export function loadFinalizeGateSettings(extRoot: string): FinalizeGateSettings {
  try {
    const raw = readRecoverableJsonObject(path.join(extRoot, 'pickle_settings.json')) as Record<string, unknown> | null;
    if (!raw) return DEFAULT_FINALIZE_GATE_SETTINGS;
    const cg = raw.convergence_gate as Record<string, unknown> | undefined;
    if (!cg || typeof cg !== 'object') return DEFAULT_FINALIZE_GATE_SETTINGS;
    return normalizeFinalizeGateSettings(cg as Partial<FinalizeGateSettings>);
  } catch {
    return DEFAULT_FINALIZE_GATE_SETTINGS;
  }
}

export function resolveFinalizeSettingsRoot(): string {
  const resolvedRoot = getExtensionRoot();
  const requestedRoot = (process.env as Record<string, string | undefined>)['EXTENSION_DIR'];
  if (requestedRoot && fs.existsSync(path.join(requestedRoot, 'pickle_settings.json'))) {
    return requestedRoot;
  }
  return resolvedRoot;
}

/**
 * AP-EXT-ITER272-01: `allowed_paths` is REPO-ROOT-relative — `resolve-scope.ts` anchors it at
 * `--show-toplevel` REGARDLESS of which `working_dir` invoked it (R-RSBI-2), and
 * `scope-resolver.ts:computeAllowedFromDiff` emits repo-relative paths. `workingDir` here is
 * `state.working_dir`, i.e. `process.cwd()` at setup — whatever directory the operator launched
 * from. Relativizing an absolute failure against THAT base put the two in different path spaces
 * whenever the launch dir sat below the git root: every failure missed the fence, `inScope`
 * emptied, and the cycle printed `all failures are out-of-scope` and EXITED 0 over a RED gate —
 * ran-to-completion reported as closed-within-scope. One shared base, via the same
 * `resolveLexicalRepoRoot` the sibling reader `selectWorkspaceTargetDirs` uses (AP-EXT-ITER34-01),
 * so reader and fence cannot disagree. Lexical, never `--show-toplevel`: toplevel is
 * realpath-resolved and would escape a lexical `failure.file` into `../../..`.
 */
function splitByScope(
  failures: GateFailure[],
  allowedPaths: string[] | undefined,
  workingDir: string
): { inScope: GateFailure[]; outOfScope: GateFailure[] } {
  if (!allowedPaths || allowedPaths.length === 0) {
    return { inScope: failures, outOfScope: [] };
  }
  const inScope: GateFailure[] = [];
  const scopeCandidates: { failure: GateFailure; relFile: string }[] = [];
  const scopeRoot = resolveLexicalRepoRoot(workingDir);

  for (const failure of failures) {
    if (/^<[^>]+>$/.test(failure.file) || !path.isAbsolute(failure.file)) {
      inScope.push(failure);
      continue;
    }
    scopeCandidates.push({
      failure,
      relFile: path.relative(scopeRoot, failure.file),
    });
  }

  const inScopeRel = new Set(filterByScope(scopeCandidates.map(({ relFile }) => relFile), { scope: 'full', allowedPaths }));
  for (const candidate of scopeCandidates) {
    if (inScopeRel.has(candidate.relFile)) {
      inScope.push(candidate.failure);
    }
  }
  const outOfScope = scopeCandidates
    .filter(candidate => !inScopeRel.has(candidate.relFile))
    .map(candidate => candidate.failure);
  return { inScope, outOfScope };
}

export interface FinalizeGateOpts {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  triggerExitReason?: string;
  runGateFn?: (opts: RunGateOpts) => Promise<GateResult>;
  spawnGateRemediatorMainFn?: typeof spawnGateRemediatorMain;
  spawnRemediatorFn?: (cmd: string, args: string[], opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }) => void;
  readMicroverseStateFn?: typeof readMicroverseState;
  readStateForWorkingDirFn?: (sessionRoot: string) => { workingDir: string; backend: string } | null;
  loadSettingsFn?: () => FinalizeGateSettings;
  mkdirSyncFn?: (p: string) => void;
  writeFileFn?: (p: string, data: string) => void;
  logActivityFn?: typeof logActivity;
  isoFn?: () => string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

function defaultReadStateForWorkingDir(sessionRoot: string): { workingDir: string; backend: string } | null {
  const statePath = path.join(sessionRoot, 'state.json');
  try {
    const state = sm.read(statePath);
    const workingDir: string = typeof state.working_dir === 'string' ? state.working_dir : process.cwd();
    const backend = resolveBackend(state);
    return { workingDir, backend };
  } catch {
    return null;
  }
}

interface FinalizeRuntime {
  env: NodeJS.ProcessEnv;
  out: (msg: string) => void;
  err: (msg: string) => void;
  doLogActivity: typeof logActivity;
  iso: () => string;
  mkdir: (p: string) => void;
  writeFile: (p: string, data: string) => void;
  runGateFn: (opts: RunGateOpts) => Promise<GateResult>;
  spawnBriefPrep: typeof spawnGateRemediatorMain;
  spawnRemediator: (cmd: string, args: string[], opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }) => void;
}

interface FinalizeContext {
  sessionRoot: string;
  skill: string;
  skillKey: 'szechuan' | 'anatomy_park';
  workingDir: string;
  backend: string;
  allowedPaths: string[] | undefined;
  gateDir: string;
  cap: number;
  remediatorTimeoutMs: number;
}

function buildFinalizeRuntime(opts: FinalizeGateOpts): FinalizeRuntime {
  return {
    env: opts.env ?? process.env,
    out: opts.stdout ?? ((msg: string) => process.stdout.write(msg + '\n')),
    err: opts.stderr ?? ((msg: string) => process.stderr.write(msg + '\n')),
    doLogActivity: opts.logActivityFn ?? logActivity,
    iso: opts.isoFn ?? isoCompactStamp,
    mkdir: opts.mkdirSyncFn ?? ((p: string) => fs.mkdirSync(p, { recursive: true })),
    writeFile: opts.writeFileFn ?? ((p: string, data: string) => fs.writeFileSync(p, data, 'utf-8')),
    runGateFn: opts.runGateFn ?? runGate,
    spawnBriefPrep: opts.spawnGateRemediatorMainFn ?? spawnGateRemediatorMain,
    spawnRemediator: opts.spawnRemediatorFn ?? defaultSpawnRemediator,
  };
}

function parseFinalizeArgs(opts: FinalizeGateOpts, rt: FinalizeRuntime): { sessionRoot: string; skill: string } | null {
  const [sessionRoot, skill] = opts.argv;
  if (!sessionRoot || !skill) {
    rt.err('Usage: finalize-gate <session-root> <skill>');
    rt.err('  skill: szechuan | anatomy-park');
    return null;
  }
  if (!VALID_SKILLS.has(skill)) {
    rt.err(`Invalid skill "${skill}". Must be: ${[...VALID_SKILLS].join(' | ')}`);
    return null;
  }
  return { sessionRoot, skill };
}

function loadFinalizeContext(opts: FinalizeGateOpts, rt: FinalizeRuntime, sessionRoot: string, skill: string): FinalizeContext | null {
  const mvState = (opts.readMicroverseStateFn ?? readMicroverseState)(sessionRoot);
  if (!mvState) {
    rt.err(`[finalize-gate] microverse.json not found in ${sessionRoot}`);
    return null;
  }
  const stateInfo = (opts.readStateForWorkingDirFn ?? defaultReadStateForWorkingDir)(sessionRoot);
  if (!stateInfo) {
    rt.err(`[finalize-gate] state.json not found or unreadable in ${sessionRoot}`);
    return null;
  }
  const settings = normalizeFinalizeGateSettings(opts.loadSettingsFn
    ? opts.loadSettingsFn()
    : loadFinalizeGateSettings(resolveFinalizeSettingsRoot()));
  const skillKey = skill.replace(/-/g, '_') as 'szechuan' | 'anatomy_park';
  const cap = skillKey === 'szechuan'
    ? settings.szechuan_max_remediation_cycles
    : settings.anatomy_park_max_remediation_cycles;
  return {
    sessionRoot,
    skill,
    skillKey,
    workingDir: stateInfo.workingDir,
    backend: stateInfo.backend,
    allowedPaths: mvState.allowed_paths,
    gateDir: path.join(sessionRoot, 'gate'),
    cap,
    remediatorTimeoutMs: settings.remediator_timeout_s * 1000,
  };
}

function writeOutOfScopeFailures(ctx: FinalizeContext, rt: FinalizeRuntime, cycle: number, outOfScope: GateFailure[]): void {
  if (outOfScope.length === 0) return;
  const oosPath = path.join(ctx.gateDir, `out_of_scope_failures_${rt.iso()}.md`);
  const oosLines = outOfScope.map(
    f => `- \`${f.file}\` [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 200)}`
  );
  rt.writeFile(
    oosPath,
    `# Out-of-Scope Gate Failures\n\nCycle: ${cycle + 1}\nSkill: ${ctx.skill}\nTimestamp: ${new Date().toISOString()}\n\n${oosLines.join('\n')}\n`
  );
  rt.doLogActivity({
    event: 'gate_out_of_scope_failures_present',
    source: 'pickle',
    gate_payload: { count: outOfScope.length, cycle: cycle + 1 },
  });
  rt.out(`[finalize-gate] ${outOfScope.length} out-of-scope failure(s) — written to ${oosPath}`);
}

async function prepareRemediationBrief(ctx: FinalizeContext, rt: FinalizeRuntime, cycle: number, result: GateResult): Promise<string | null> {
  const gateResultPath = path.join(ctx.gateDir, `gate_result_cycle_${rt.iso()}.json`);
  writeStateFile(gateResultPath, result);
  const briefLines: string[] = [];
  let briefCode: number;
  try {
    briefCode = await rt.spawnBriefPrep({
      argv: ['--gate-result', gateResultPath, '--session-root', ctx.sessionRoot, '--reason', 'strict'],
      stdout: (msg: string) => briefLines.push(msg),
      stderr: (msg: string) => rt.err(`[gate-remediator] ${msg}`),
    });
  } catch (e) {
    rt.err(`[finalize-gate] brief-prep threw on cycle ${cycle + 1}: ${safeErrorMessage(e)}`);
    return null;
  }
  if (briefCode !== 0) {
    rt.err(`[finalize-gate] brief-prep exited ${briefCode} on cycle ${cycle + 1} — skipping remediator`);
    return null;
  }
  const briefPathLine = briefLines.find(l => l.startsWith('BRIEF_PATH='));
  if (!briefPathLine) {
    rt.err(`[finalize-gate] no BRIEF_PATH from brief-prep on cycle ${cycle + 1}`);
    return null;
  }
  return briefPathLine.slice('BRIEF_PATH='.length);
}

function readBriefContent(briefPath: string, rt: FinalizeRuntime): string | null {
  try {
    return fs.readFileSync(briefPath, 'utf-8');
  } catch (e) {
    rt.err(`[finalize-gate] cannot read brief at ${briefPath}: ${safeErrorMessage(e)}`);
    return null;
  }
}

function spawnStrictRemediator(ctx: FinalizeContext, rt: FinalizeRuntime, cycle: number, briefContent: string): void {
  const invocation = buildWorkerInvocation(ctx.backend as Backend, {
    prompt: briefContent,
    addDirs: [ctx.workingDir],
  });
  rt.out(`[finalize-gate] spawning remediator (cycle ${cycle + 1})`);
  try {
    rt.spawnRemediator(invocation.cmd, invocation.args, {
      cwd: ctx.workingDir,
      timeout: ctx.remediatorTimeoutMs,
      env: { ...process.env, ...backendEnvOverrides(invocation.backend) },
    });
  } catch (e) {
    rt.err(`[finalize-gate] remediator exited non-zero or timed out: ${safeErrorMessage(e)}`);
  }
}

/**
 * V3: a failure the remediator cannot act on — its check produced no measurement
 * (`isCheckUnmeasured`, e.g. a timeout) AND it names no editable path (the same non-absolute arm
 * `splitByScope` already forces in-scope). The path conjunct keeps a REAL failure of a check that
 * timed out in a sibling target dir remediable, since check status escalates across dirs.
 */
function isUnmeasuredFailure(result: GateResult, failure: GateFailure): boolean {
  return isCheckUnmeasured(result.check_status, failure.check) && !path.isAbsolute(failure.file);
}

/**
 * The gate never measured what it reports, so a remediation cycle would only rediscover that. Report
 * it and stop with a non-success code — the same disposition as cap exhaustion, reached without
 * spending the cap.
 */
function reportUnmeasuredGate(ctx: FinalizeContext, rt: FinalizeRuntime, cycle: number, unmeasured: GateFailure[]): number {
  const reportPath = path.join(ctx.gateDir, `unmeasured_${rt.iso()}.md`);
  const lines = unmeasured.map(f => `- [${f.check}] \`${f.file}\` ${f.ruleOrCode}: ${f.message.slice(0, 200)}`);
  rt.writeFile(
    reportPath,
    `# Gate Unmeasured\n\nCycle: ${cycle + 1}\nSkill: ${ctx.skill}\nTimestamp: ${new Date().toISOString()}\n\n${lines.join('\n')}\n`
  );
  rt.err(`[finalize-gate] gate UNMEASURED on cycle ${cycle + 1} (${unmeasured.length} non-actionable failure(s)) — no remediation cycle spent, exit 2 (report: ${reportPath})`);
  return 2;
}

async function runStrictGateCycle(ctx: FinalizeContext, rt: FinalizeRuntime, cycle: number): Promise<{ code: number | null; result?: GateResult }> {
  rt.out(`[finalize-gate] cycle ${cycle + 1}/${ctx.cap} — running strict gate`);
  let result: GateResult;
  try {
    result = await rt.runGateFn({
      workingDir: ctx.workingDir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      allowedPaths: ctx.allowedPaths,
      onEvent: (event, data) => rt.doLogActivity({ event: event as ActivityEventType, source: 'pickle', gate_payload: data }),
    });
  } catch (e) {
    rt.err(`[finalize-gate] gate threw on cycle ${cycle + 1}: ${safeErrorMessage(e)}`);
    return { code: 1 };
  }
  if (result.status === 'green' || result.status === 'green-with-known-flake-warnings') {
    rt.out(`[finalize-gate] gate green on cycle ${cycle + 1} — exit 0`);
    return { code: 0, result };
  }
  const { inScope, outOfScope } = splitByScope(result.failures, ctx.allowedPaths, ctx.workingDir);
  writeOutOfScopeFailures(ctx, rt, cycle, outOfScope);
  if (inScope.length === 0) {
    rt.out('[finalize-gate] all failures are out-of-scope — exit 0 (closed within scope)');
    return { code: 0, result };
  }
  const remediable = inScope.filter(f => !isUnmeasuredFailure(result, f));
  if (remediable.length === 0) return { code: reportUnmeasuredGate(ctx, rt, cycle, inScope), result };
  const briefPath = await prepareRemediationBrief(ctx, rt, cycle, { ...result, failures: remediable });
  if (!briefPath) return { code: null, result };
  const briefContent = readBriefContent(briefPath, rt);
  if (!briefContent) return { code: null, result };
  spawnStrictRemediator(ctx, rt, cycle, briefContent);
  return { code: null, result };
}

function writeEscalation(ctx: FinalizeContext, rt: FinalizeRuntime, lastResult: GateResult | undefined): string {
  const escalationPath = path.join(ctx.gateDir, `escalation_${rt.iso()}.md`);
  const failures = lastResult?.failures ?? [];
  // R-FGNC-3: the escalation must show what the gate actually saw. With the
  // R-FGNC-1/2 classifier fix `failures` enumerates the REAL TS/lint errors
  // (no longer just `.npmrc` WARN noise) — group them by check so the operator
  // sees the true shape, and keep messages long enough to be actionable.
  const byCheck = new Map<string, number>();
  for (const f of failures) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
  const checkSummary = [...byCheck.entries()].map(([c, n]) => `${c}: ${n}`).join(', ') || 'none';
  const failureLines = failures.map(
    f => `- \`${f.file}\`${f.line ? `:${f.line}` : ''} [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 400)}`
  );
  rt.writeFile(
    escalationPath,
    [
      `# Gate Escalation: Cap Exhausted`,
      ``,
      `Skill: ${ctx.skill}`,
      `Cap: ${ctx.cap} cycles`,
      `Timestamp: ${new Date().toISOString()}`,
      `Remaining failures: ${failures.length} (${checkSummary})`,
      ``,
      `## Failures`,
      ``,
      ...(failureLines.length > 0
        ? failureLines
        : ['(none enumerated — inspect gate/ per-cycle result files for raw output)']),
      ``,
      `Manual remediation required. Check gate/ for per-cycle result files.`,
    ].join('\n')
  );
  return escalationPath;
}

export async function finalizeGateMain(opts: FinalizeGateOpts): Promise<number> {
  const rt = buildFinalizeRuntime(opts);
  const args = parseFinalizeArgs(opts, rt);
  if (!args) return 1;

  if (rt.env.PICKLE_GATE_DISABLED === '1') {
    rt.doLogActivity({ event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'kill_switch' } });
    rt.out('[finalize-gate] PICKLE_GATE_DISABLED=1 — skipping post-runner gate');
    return 0;
  }

  if (opts.triggerExitReason) {
    rt.out(`[finalize-gate] triggered by exit_reason=${opts.triggerExitReason}`);
  }

  const ctx = loadFinalizeContext(opts, rt, args.sessionRoot, args.skill);
  if (!ctx) return 1;
  rt.mkdir(ctx.gateDir);

  const bundleEndGate = runAcPhaseGate({
    sessionDir: ctx.sessionRoot,
    evaluationPhase: 'bundle-end',
    cwd: ctx.workingDir,
    stdout: rt.out,
    stderr: rt.err,
  });
  if (bundleEndGate.status !== 'pass') return 2;

  let lastResult: GateResult | undefined;

  for (let cycle = 0; cycle < ctx.cap; cycle++) {
    const cycleResult = await runStrictGateCycle(ctx, rt, cycle);
    if (cycleResult.result) lastResult = cycleResult.result;
    if (cycleResult.code !== null) return cycleResult.code;
  }

  const escalationPath = writeEscalation(ctx, rt, lastResult);
  rt.err(`[finalize-gate] cap exhausted after ${ctx.cap} cycles — exit 2 (escalation: ${escalationPath})`);
  return 2;
}

function defaultSpawnRemediator(
  cmd: string,
  args: string[],
  spawnOpts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }
): void {
  execFileSync(cmd, args, {
    cwd: spawnOpts.cwd,
    timeout: spawnOpts.timeout,
    stdio: 'pipe',
    env: spawnOpts.env,
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'finalize-gate.js') {
  finalizeGateMain({ argv: process.argv.slice(2) })
    .then(code => process.exit(code))
    .catch(e => {
      process.stderr.write(`finalize-gate fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
