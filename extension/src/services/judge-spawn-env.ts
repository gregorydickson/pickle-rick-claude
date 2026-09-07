/**
 * judge-spawn-env.ts — R-SJET-3
 *
 * Purpose: Produce a sanitized env for the LLM judge `claude` / `codex` spawns
 * inside microverse-runner / szechuan / plumbus / microverse.
 *
 * Goals:
 * - Prevent nested-claude auth/session contamination (H2 in the SJET PRD).
 * - Strip PICKLE_* and, by DEFAULT-DENY, every CLAUDE-namespace variable that is not
 *   provider routing or the child's own key — the outer session's id, pid, exec path and
 *   messaging socket all live in that namespace.
 * - Preserve auth/routing env: `ANTHROPIC_*` and the CLAUDE_CODE_USE_<PROVIDER> family.
 * - Provide a single place for future "judge backend specific" pruning.
 *
 * Used by: microverse-runner.ts (measureLlmMetricAttempt + probeJudgeCliAvailability)
 * and any future convergence judge paths.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backendEnvOverrides } from './backend-spawn.js';

export type JudgeBackend = 'claude' | 'codex' | 'auto';

/**
 * Returns true when the current process is running inside a Claude Code session.
 * Detects both CLAUDE_CODE (set by Claude Code CLI) and CLAUDECODE (legacy marker).
 */
export function isNestedClaude(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env['CLAUDE_CODE'] || env['CLAUDECODE']);
}

/**
 * Build a sanitized env for the judge spawn.
 *
 * - `isNested && backend === 'claude'`: drop every CLAUDE-namespace variable that
 *   `isPreservedClaudeVar` does not vouch for, drop pickle's own run context, and replace
 *   XDG_RUNTIME_DIR with an isolated tmpdir.
 * - Otherwise: return baseEnv merged with backendEnvOverrides(backend).
 *   Env values are never logged — callers may log Object.keys(result) only.
 */
export function buildJudgeEnv(
  backend: 'claude' | 'codex',
  isNested: boolean,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (isNested && backend === 'claude') {
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(baseEnv)) {
      if (v === undefined) continue;
      // Default-deny across the whole CLAUDE namespace (see isPreservedClaudeVar).
      if (k.startsWith('CLAUDE') && !isPreservedClaudeVar(k, baseEnv)) continue;
      // Pickle's own outer-run context, which the child must not inherit either.
      if (DANGEROUS_PREFIXES.some(p => k.startsWith(p))) continue;
      out[k] = v;
    }
    // Replace XDG_RUNTIME_DIR to prevent the nested claude from sharing the outer
    // session's runtime socket/state directory.
    out['XDG_RUNTIME_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-judge-'));
    return out;
  }
  return { ...baseEnv, ...backendEnvOverrides(backend) };
}

/**
 * Decides which CLAUDE-namespace variables survive into the nested judge.
 *
 * The child needs exactly two things from that namespace, and both are stated as what they
 * ARE rather than as a list of what to remove:
 *   - provider ROUTING, spelled CLAUDE_CODE_USE_<PROVIDER> by every provider selector the
 *     CLI has (VERTEX, BEDROCK, and whatever it adds next);
 *   - its own API key, and only when ANTHROPIC_API_KEY is absent — with that key present the
 *     child authenticates directly and CLAUDE_API_KEY is redundant outer key material.
 *
 * Everything else the CLI puts in this namespace names the OUTER session or hands the child a
 * live handle to it (its session id, pid, exec path, and the messaging socket WITH its auth
 * token). DEFAULT-DENY is the load-bearing property: a marker the CLI introduces tomorrow is
 * stripped with no code change here.
 *
 * WHY NOT AN ENUMERATION OF SESSION MARKERS: that was the prior shape, and it never once
 * matched. It listed three prefixes the CLI does not emit and nothing in this repo sets,
 * while the markers it meant to catch all sit under the CLAUDE_CODE_ prefix it deliberately
 * exempted to protect the routing vars. Every member was dead on the day it was written.
 *
 * SAFETY OF THE WIDER STRIP: the set this removes is exactly the set that does not exist when
 * the runner is launched outside Claude Code — the non-nested path, which is supported and
 * works. Stripping makes the nested judge's env resemble that control, not something new.
 */
function isPreservedClaudeVar(key: string, baseEnv: NodeJS.ProcessEnv): boolean {
  if (key.startsWith('CLAUDE_CODE_USE_')) return true;
  return key === 'CLAUDE_API_KEY' && !baseEnv['ANTHROPIC_API_KEY'];
}

// Pickle's own run context. The CLAUDE namespace is NOT listed here — it is governed by the
// default-deny rule above, so this list can never be the place a session marker is forgotten.
const DANGEROUS_PREFIXES = [
  'PICKLE_',
  'SESSION_ROOT',
  'TICKET_DIR',
];

/**
 * Convenience wrapper used at the two judge spawn sites in microverse-runner.ts.
 * Delegates to buildJudgeEnv with isNestedClaude() detection.
 * cwd is accepted for API stability; not used (no repo .env loading at judge spawn time).
 */
export function getJudgeEnvForAttempt(
  backend: JudgeBackend,
  cwd: string,
): NodeJS.ProcessEnv {
  void cwd;
  const narrowed = (backend === 'claude' || backend === 'codex') ? backend : 'claude';
  return buildJudgeEnv(narrowed, isNestedClaude());
}

/**
 * The explicit, repo-owned value for `claude --setting-sources`: load NO ambient setting
 * source (`user`, `project`, or `local`).
 *
 * WHY an empty string rather than a curated list: the judge needs none of them. Everything the
 * judge spawn depends on is already passed explicitly on its own command line (model, system
 * prompt, tool allowlist, add-dirs, permission posture). Anything it would inherit is, by
 * definition, an input nobody in this repo controls.
 */
export const JUDGE_DECOUPLED_SETTING_SOURCES = '';

/**
 * Appends the ambient-settings decoupling flag to a judge invocation's args.
 *
 * B-CLIBRITTLE. The judge spawn is phase-critical, so an unrelated change in the operator's
 * environment must not be able to make a phase fail. Without this flag the child CLI reads the
 * operator's `user`/`project`/`local` settings hierarchy, which makes every rule in it — however
 * old and however benign — a live input to this repo's pipeline.
 *
 * DECOUPLE, DO NOT DETECT: this needs no list of known-bad rules. A detector would be an
 * enumerated set with a maintenance schedule, correct only until the next CLI release
 * reinterprets a rule nobody has touched in months.
 *
 * Measured basis (claude 2.1.260, judge invocation shape, workspace carrying an ambient
 * `permissions.allow` rule): WITHOUT the flag the child reports reading `.claude/settings.json`;
 * WITH `--setting-sources ''` its stderr is empty and the file is never consulted. The flag is
 * accepted by every version in the band spanning the update that motivated this fix
 * (2.1.248 / 2.1.251 / 2.1.252 / 2.1.260), so no capability probe is warranted.
 *
 * Pure: returns a new array and never mutates `args`. Same shape as `scrubGateEnv`
 * (services/pickle-utils.ts) — a named constant plus a pure transform returning a copy.
 */
export function decoupleJudgeSettingSources(args: readonly string[]): string[] {
  return [...args, '--setting-sources', JUDGE_DECOUPLED_SETTING_SOURCES];
}

const JUDGE_TMPDIR_PREFIX = 'pickle-judge-';

/**
 * Removes the `XDG_RUNTIME_DIR` directory created by buildJudgeEnv, if any.
 *
 * Only removes directories buildJudgeEnv itself created (a `pickle-judge-`-prefixed
 * child of os.tmpdir()) — never a real ambient XDG_RUNTIME_DIR that could be passed
 * through unmodified in the non-nested branch. Best-effort: cleanup failure never
 * throws into the judge spawn path (R-ORCG — pickle-judge-* was 72% of leaked tmpdirs
 * in a measured production census).
 */
export function cleanupJudgeRuntimeDir(env: NodeJS.ProcessEnv): void {
  const dir = env['XDG_RUNTIME_DIR'];
  if (!dir) { return; }
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith(JUDGE_TMPDIR_PREFIX)) { return; }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; cleanup failure must never propagate into the judge spawn path.
  }
}

export default { getJudgeEnvForAttempt, buildJudgeEnv, isNestedClaude, cleanupJudgeRuntimeDir, decoupleJudgeSettingSources };