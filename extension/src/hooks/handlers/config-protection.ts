import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { State, ActivityEventType } from '../../types/index.js';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
import { logActivity } from '../../services/activity-logger.js';
import {
  execName,
  execTokenIndex,
  skipEnvAssignments,
  splitShellSegments,
  tokenizeShellCommand,
  tokenizeShellTokens,
} from '../shell-exec.js';

interface PreToolUseInput {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    [key: string]: unknown;
  };
}

// `/i` on every pattern for the same case-insensitive-filesystem reason as
// `matchProtectedStateBasename`, and for parity with the sibling config regexes
// in `tsc-gate.ts`, which already carry `/i`.
const PROTECTED_PATTERNS = [
  /^\.eslintrc(\..*)?$/i,
  /^eslint\.config\..+$/i,
  /^\.prettierrc(\..*)?$/i,
  /^biome\.json$/i,
  /^tsconfig(\..*)?\.json$/i,
  /^pyproject\.toml$/i,
  /^\.ruff\.toml$/i,
  /^jest\.config\./i,
  /^vitest\.config\./i,
];

const SHELL_PATTERN_CHARS = /[*?[\]{}]/;
const PROTECTED_BASH_CANDIDATES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'biome.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.base.json',
  'tsconfig.build.json',
  'tsconfig.eslint.json',
  'pyproject.toml',
  '.ruff.toml',
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
  'jest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.ts',
] as const;

/**
 * R-WSRC-3: Runtime state files that workers MUST NOT write directly.
 * Each entry is a basename or `.tmp.<pid>` suffixed variant; the matcher
 * applies them at any directory depth (`**` semantics) plus the deployed-runtime
 * tree under `~/.claude/pickle-rick/**`. The literal glob shapes are documented
 * here so subsystem audits and the R-WSRC-3 trap-door grep can locate them.
 */
const PROTECTED_WRITE_GLOBS = [
  '**/state.json',
  '**/state.json.tmp.*',
  '**/circuit_breaker.json',
  '**/circuit_breaker.json.tmp.*',
  '**/pipeline-status.json',
  '**/pipeline-status.json.tmp.*',
  '~/.claude/pickle-rick/**',
  'pickle_settings.json',
  'pickle_settings.json.tmp.*',
] as const;

const PROTECTED_STATE_BASENAMES = [
  'state.json',
  'circuit_breaker.json',
  'pipeline-status.json',
  'pickle_settings.json',
] as const;

// Surfaces PROTECTED_WRITE_GLOBS at the module level for downstream tools that
// import the handler for auditing (e.g. an analyst grepping compiled mirrors).
export { PROTECTED_WRITE_GLOBS };

const SETTINGS_BASENAMES = new Set(['pickle_settings.json']);

const TMP_SUFFIX_RE = /\.tmp(?:\.\d+)?(?:\..*)?$/;

function getProtectedRuntimeRoot(): string {
  return path.resolve(os.homedir(), '.claude/pickle-rick');
}

function stripTmpSuffix(basename: string): string {
  return basename.replace(TMP_SUFFIX_RE, '');
}

/**
 * Returns the matching protected basename ('state.json' etc.) for the given
 * absolute or relative file path, including `.tmp.<pid>` variants. Returns
 * null when the path does not target a protected runtime state file.
 *
 * Case-folds BEFORE matching: on a case-insensitive filesystem (macOS/APFS
 * default, Windows) `State.json` and `STATE.JSON` resolve to the SAME INODE as
 * `state.json`, so exact-equality against the all-lowercase
 * PROTECTED_STATE_BASENAMES literals approved a write to the real runtime state
 * file — defeating the state, settings, and circuit-breaker gates at once.
 * Folding the input here (rather than adding a second per-candidate compare)
 * keeps ONE comparison, and folding before `stripTmpSuffix` also covers
 * `State.json.TMP.<pid>`. On a case-SENSITIVE filesystem this over-matches a
 * genuinely distinct `STATE.JSON`; that direction is fail-closed and the
 * `allow_state_writes_reason` override remains the escape hatch.
 */
function matchProtectedStateBasename(filePath: string): string | null {
  if (!filePath) return null;
  const base = path.basename(filePath).toLowerCase();
  const stripped = stripTmpSuffix(base);
  for (const candidate of PROTECTED_STATE_BASENAMES) {
    if (base === candidate || stripped === candidate) return candidate;
  }
  return null;
}

/**
 * Expands a leading `~`, `~/`, `$HOME`, or `${HOME}` to the absolute home
 * directory. `path.resolve` does NOT expand these shell forms, so a bash
 * redirect or tool `file_path` like `~/.claude/pickle-rick/...` would otherwise
 * resolve under the cwd (`<cwd>/~/...`) and slip past the runtime-root guard
 * even though the shell expands it to the real runtime tree at exec time.
 */
function expandLeadingHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  const homeVar = filePath.match(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/);
  if (homeVar) return path.join(os.homedir(), filePath.slice(homeVar[0].length));
  return filePath;
}

/**
 * Returns true if `filePath` resolves inside the deployed runtime tree
 * (`~/.claude/pickle-rick/**`). Uses path.resolve (no realpath) because the
 * worker may not have the target on disk yet; symlink resolution is not
 * the threat model here. Leading `~`/`$HOME` forms are expanded first so the
 * shell-expanded destination is checked, not a literal `~` under the cwd.
 *
 * Both sides are case-folded for the same reason as
 * `matchProtectedStateBasename`: `~/.CLAUDE/pickle-rick/**` and
 * `~/.claude/Pickle-Rick/**` are the SAME directory on a case-insensitive
 * filesystem, so a case-sensitive prefix compare let a worker Edit the deployed
 * runtime tree.
 */
function isInsideRuntimeRoot(filePath: string): boolean {
  if (!filePath) return false;
  const runtimeRoot = getProtectedRuntimeRoot().toLowerCase();
  const resolved = path.resolve(expandLeadingHome(filePath)).toLowerCase();
  if (resolved === runtimeRoot) return true;
  return resolved.startsWith(runtimeRoot + path.sep);
}

/** Tool-input file_path match → returns reason string or null. */
function detectProtectedWriteTarget(filePath: string): { matched: string; isSettings: boolean } | null {
  if (!filePath) return null;
  const stateMatch = matchProtectedStateBasename(filePath);
  if (stateMatch) {
    return { matched: filePath, isSettings: SETTINGS_BASENAMES.has(stateMatch) };
  }
  if (isInsideRuntimeRoot(filePath)) {
    return { matched: filePath, isSettings: false };
  }
  return null;
}

function isProtectedFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return PROTECTED_PATTERNS.some(p => p.test(base));
}

function shellPatternToRegex(pattern: string): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      regex += '.*';
      continue;
    }
    if (char === '?') {
      regex += '.';
      continue;
    }
    if (char === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end !== -1) {
        const variants = pattern
          .slice(i + 1, end)
          .split(',')
          .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        regex += `(?:${variants})`;
        i = end;
        continue;
      }
    }
    if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end !== -1) {
        const rawClass = pattern.slice(i + 1, end);
        const isNegated = rawClass.startsWith('!') || rawClass.startsWith('^');
        const classBody = (isNegated ? rawClass.slice(1) : rawClass)
          .replace(/\\/g, '\\\\')
          .replace(/\]/g, '\\]');
        if (classBody.length > 0) {
          regex += isNegated ? `[^${classBody}]` : `[${classBody}]`;
          i = end;
          continue;
        }
      }
    }
    regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  regex += '$';
  // Case-insensitive so a glob written in another case (`TSCONFIG*.json`) still
  // matches the lowercase PROTECTED_BASH_CANDIDATES on a case-insensitive
  // filesystem, matching PROTECTED_PATTERNS above.
  return new RegExp(regex, 'i');
}

function isProtectedShellPattern(token: string): boolean {
  const base = path.basename(token);
  if (!SHELL_PATTERN_CHARS.test(base)) {
    return false;
  }
  const candidatePattern = shellPatternToRegex(base);
  return PROTECTED_BASH_CANDIDATES.some((candidate) => candidatePattern.test(candidate));
}

/** A token names a protected config file directly or via a shell glob/brace/bracket pattern. */
function isProtectedConfigToken(token: string): boolean {
  return isProtectedFile(token) || isProtectedShellPattern(token);
}

/**
 * Shared bash write-target walker (R-WSRC-3 / AC-C1): Pass 1 scans `>`/`>>`
 * redirect destinations; Pass 2 scans non-flag positional args of `WRITE_COMMANDS`.
 * `probe` maps a candidate destination token to a hit (or null) and the first
 * non-null hit wins. Single source of BOTH the traversal and the write-command
 * class, so `detectBashStateWriteTarget` (state files) and
 * `bashWritesProtectedConfig` (config files) cannot drift apart.
 *
 * The walk runs over every scope bash could start a command in: the raw command
 * PLUS each `splitShellSegments` segment. `tokenizeBashCommand` splits on
 * whitespace and quotes only, so in a GROUPED write the destination stays glued
 * to its delimiter — `(echo x > <session>/state.json)` tokenizes its last token
 * as `state.json)`, whose basename matches no protected name, and the write was
 * APPROVED while the bare twin blocked (10/12 forms, AP-EXT-ITER19-02). Feeding
 * the segmenter's output through the same walker restores the boundary for the
 * last two detectors that were still reading the raw command.
 *
 * Union rather than replacement: both scopes are fail-closed and the first hit
 * wins, so scanning more can only find more — a destination that survives only
 * in the raw token stream keeps its existing reach.
 *
 * Redirect operators are normalized ONCE, BEFORE segmenting. Two of them carry a
 * character the segmenter reads as a control operator: `>|` (clobber-override)
 * ends with a pipe and `>&<file>` with a background `&`. Segmenting first splits
 * `(echo x >| f)` into `echo x >` and `f`, severing the redirect from its
 * destination — the operator must already be ` > ` by the time the boundary is
 * drawn. Normalizing here rather than inside `tokenizeBashCommand` also keeps
 * the tokenizer to one job: splitting.
 */
function findBashWriteTarget<T>(
  command: string,
  probe: (token: string) => T | null,
): T | null {
  if (!command) return null;
  // Normalized ONCE, BEFORE segmenting, so `>|` / `>&<file>` no longer carry a
  // `|` / `&` the segmenter would read as a control operator — including inside a
  // `bash -c '<payload>'` payload, whose quotes are still on at this point. That
  // is why the normalizer is quote-blind (see `normalizeRedirectOperators`); the
  // quoted/unquoted decision belongs to `findWriteTargetInScope`, not here.
  const normalized = normalizeRedirectOperators(command);
  for (const scope of [normalized, ...splitShellSegments(normalized)]) {
    const hit = findWriteTargetInScope(scope, probe);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The two-pass token walk over ONE already-scoped command string.
 *
 * Both passes require their ANCHOR token — the redirect operator, the write
 * command — to have come from OUTSIDE quotes. bash redirects only on an unquoted
 * `>` and execs only an unquoted word, so a quoted one is data the worker typed,
 * not syntax the shell will act on. Only the anchor is gated: a DESTINATION is
 * legitimately quoted (`> "state.json"`), so `tokens[i + 1]` and the positional
 * args are probed whatever their quoting.
 */
function findWriteTargetInScope<T>(
  command: string,
  probe: (token: string) => T | null,
): T | null {
  const tokens = tokenizeShellTokens(command);

  // Pass 1: `>` / `>>` redirects — the immediate next token is the destination.
  for (let i = 0; i < tokens.length - 1; i++) {
    const isRedirect = !tokens[i].quoted && (tokens[i].value === '>' || tokens[i].value === '>>');
    if (!isRedirect) continue;
    const hit = probe(tokens[i + 1].value);
    if (hit !== null) return hit;
  }

  // Pass 2: write/editor commands that mutate a positional FILE arg
  // (`tee`/`cp`/`mv`/`rsync` destinations, `sed -i FILE`, `vim FILE`, ...).
  for (let i = 0; i < tokens.length; i++) {
    // execName (not path.basename): folds case and strips a trailing `;`, so
    // `SED -i`, `/usr/bin/sed -i`, and `TEE` all match the lowercase set.
    if (tokens[i].quoted || !WRITE_COMMANDS.has(execName(tokens[i].value))) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j].value;
      if (arg.startsWith('-')) continue;
      const hit = probe(arg);
      if (hit !== null) return hit;
    }
  }

  return null;
}

/**
 * Write-aware config gate (AC-C1 / R-CPRO): returns the protected config
 * basename when `command` WRITES it, or null for read-only commands.
 *
 * The legacy matcher blocked any token matching a protected config file/glob
 * READ OR WRITE, so read-only commands (`grep -l '...' tsconfig.json`,
 * `cat .eslintrc.json`, `awk '{print}' .eslintrc.json`) were over-blocked.
 * Routes through the shared `findBashWriteTarget` walker (same tokenizer and same
 * `WRITE_COMMANDS` class as `detectBashStateWriteTarget`), blocking ONLY when a
 * write targets a protected config path. Fail-closed: any write construct
 * (redirect / tee / cp / mv / rsync / sed -i / editor) over a config token blocks;
 * a config token with no write targeting it approves.
 */
function bashWritesProtectedConfig(command: string): string | null {
  return findBashWriteTarget(
    command,
    (token) => (isProtectedConfigToken(token) ? path.basename(token) : null),
  );
}

/**
 * Isolate every output-redirect-to-file operator into a free-standing ` > ` so
 * it can never glue to its destination filename, and so no redirect still
 * carries a character (`|`, `&`) that the shell segmenter would read as a
 * control operator. Run once by `findBashWriteTarget` before segmenting.
 */
function normalizeRedirectOperators(command: string): string {
  // Isolate redirect operators so they don't glue to filenames.
  // `>|` is the noclobber-override redirect (`>|file` forces truncation even
  // under `set -o noclobber`); semantically it is a `>` redirect. It MUST be
  // normalized BEFORE the `>>`/`>` passes — otherwise the `|` glues to the
  // destination (`>|state.json` → tokens `['>', '|state.json']`), the
  // protected-basename match never sees `state.json`, and the state-write
  // guard is bypassed. Same redirect class as `>`/`>>`, same R-WSRC-3 invariant.
  // `>&word` is bash's dup-or-write fork. When `word` is a filename (not a
  // digit and not `-`), it is the `&>`-equivalent that redirects BOTH stdout
  // and stderr to that file — a real write (`>&state.json`, `>& state.json`).
  // When `word` is a digit or `-` it is an fd-dup/close (`2>&1`, `>&2`, `>&-`,
  // `1>&2`) and MUST NOT be treated as a write. The negative lookahead
  // `(?![\d-])` makes that split: only the file-write form normalizes to ` > `,
  // so the protected basename is no longer glued behind `&` (`>&state.json` →
  // tokens `['>', '&state.json']` pre-fix bypassed the guard) while the
  // ubiquitous fd-dup forms pass through untouched. Same R-WSRC-3 invariant as
  // `>`/`>>`/`>|`; runs BEFORE the general `>` pass so the `&` never glues.
  // Deliberately NOT quote-aware. Isolating `>` inside a quoted span only inserts
  // spaces into a word the scanner already treats as ONE token, so it cannot
  // manufacture an operator — `findWriteTargetInScope` decides operator-hood from
  // the token's QUOTING, not from its spacing. Making this quote-aware instead
  // NARROWS it: a `bash -c '<payload>'` payload is code whose redirects must be
  // isolated BEFORE `splitShellSegments` splits `>|` on its trailing `|`, and the
  // quotes are still on at that point (measured: `sh -lc 'echo x >| state.json'`
  // regressed from block to approve under a quote-aware normalizer).
  return command
    .replace(/>\|/g, ' > ')
    .replace(/>&(?![\d-])/g, ' > ')
    .replace(/>>/g, ' >> ')
    .replace(/(^|[^>])>/g, '$1 > ');
}

/**
 * Commands that write a file passed as a positional argument, which the redirect
 * tokenizer's `>`/`>>` pass does not cover. Two families, one class:
 *   - destination-arg writers: `tee`/`cp`/`mv`/`rsync`
 *   - in-place / editor writers: `sed -i FILE`, `perl -i FILE`, `vim FILE`, ...
 * Read-only commands (`grep`/`ls`/`stat`/`cat`/`awk`) are deliberately absent, so
 * they fall through to approve.
 *
 * EVERY probe over EVERY protected domain walks this one set — a per-caller
 * command class is what let `sed -i state.json` through while `sed -i
 * tsconfig.json` blocked, i.e. the security gate ran narrower than the lint gate.
 */
const WRITE_COMMANDS = new Set([
  'tee', 'cp', 'mv', 'rsync',
  'sed', 'perl', 'vim', 'vi', 'nano', 'emacs', 'ed', 'ex',
]);

/**
 * Detects whether `command` writes to a protected state file (redirect,
 * destination-arg writer, or in-place editor). Returns the matched path, or
 * `null` if none. Routes through the shared `findBashWriteTarget` walker with
 * the `detectProtectedWriteTarget` state-file probe.
 */
function detectBashStateWriteTarget(command: string): { matched: string; isSettings: boolean } | null {
  return findBashWriteTarget(command, detectProtectedWriteTarget);
}

const ALLOW_CONFIG_EDIT_FLAG = '--allow-config-edit';

function hasAllowConfigEditFlag(args: string[]): boolean {
  return args.includes(ALLOW_CONFIG_EDIT_FLAG);
}

function block(reason: string): void {
  console.log(JSON.stringify({ decision: 'block', reason }));
}

function readHookInputData(): string | null {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

function parseHookInput(inputData: string): PreToolUseInput | null {
  if (!inputData.trim()) {
    return null;
  }

  try {
    return JSON.parse(inputData) as PreToolUseInput;
  } catch {
    return null;
  }
}

function isConfigProtectionEnabled(extensionDir: string): boolean {
  try {
    const flagSettings = readRecoverableJsonObject(path.join(extensionDir, 'pickle_settings.json')) as Record<string, unknown> | null;
    return flagSettings?.enable_config_protection !== false;
  } catch { /* default true — continue with protection enabled */ }
  return true;
}

function loadResolvedState(): State | null {
  const stateFile = resolveStateFile(getDataRoot());
  if (!stateFile) return null;
  return loadActiveState(stateFile);
}

function trimmedFlag(flags: Record<string, unknown> | undefined, key: string): string | null {
  if (!flags) return null;
  const v = flags[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function emitStateWriteOverride(blockedPath: string, overrideReason: string, toolName: string): void {
  try {
    logActivity({
      event: 'state_write_override_used',
      source: 'hook',
      gate_payload: {
        blocked_path: blockedPath,
        override_reason: overrideReason,
        tool_name: toolName,
        callsite_pid: process.pid,
      },
    });
  } catch {
    /* activity-logger is already best-effort; never break the hook */
  }
}

function detectTargetedConfigFile(input: PreToolUseInput): string | null {
  const toolName = input.tool_name || '';
  const filePath = input.tool_input?.file_path || '';
  const command = input.tool_input?.command || '';

  if ((toolName === 'Write' || toolName === 'Edit') && filePath) {
    return isProtectedFile(filePath) ? path.basename(filePath) : null;
  }
  if (toolName === 'Bash' && command) {
    return bashWritesProtectedConfig(command);
  }
  return null;
}

/**
 * Detect protected-state-file targets in the tool input. Returns the matched
 * path and whether it is a `pickle_settings.json` write (which uses the
 * `allow_settings_writes_reason` override exclusively).
 */
function detectTargetedStateFile(input: PreToolUseInput): { matched: string; isSettings: boolean } | null {
  const toolName = input.tool_name || '';
  const filePath = input.tool_input?.file_path || '';
  const command = input.tool_input?.command || '';

  if ((toolName === 'Write' || toolName === 'Edit') && filePath) {
    return detectProtectedWriteTarget(filePath);
  }
  if (toolName === 'Bash' && command) {
    return detectBashStateWriteTarget(command);
  }
  return null;
}

/**
 * Returns true if a single (already-segmented) shell command invokes
 * `install.sh` as its executable token, skipping a leading `bash`/`sh` wrapper
 * and any `KEY=value` env prefixes. Does not match read-only references
 * (`cat install.sh`) or suffixed filenames (`pre-install.sh`).
 *
 * Tokenizes quote-aware via `tokenizeShellCommand` for the same reason the git
 * chain does (the "quoted-token parity" trap door): a bare `split(/\s+/)` read
 * `"install.sh"` with the quotes attached, so `bash "install.sh"` — which the
 * shell runs as `bash install.sh` — slipped the guard. This detector was the
 * last of the three leading-command detectors still on the bare split.
 */
function segmentInvokesInstallSh(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  const tokens = tokenizeShellCommand(trimmed);
  const exec = tokens[execTokenIndex(tokens)];
  if (!exec) return false;
  return execName(exec) === 'install.sh';
}

/**
 * R-PIPE-3 / R-WSRC: Explicit detection for `bash install.sh` (and variants)
 * from worker contexts. This is a hard forbidden (manager-only) per the
 * project CLAUDE.md worker rules. The hook must return "block" for workers.
 *
 * Only matches when `install.sh` is the EXECUTABLE token (basename of the
 * binary being invoked), not when it appears as an argument to a read-only
 * tool (`cat install.sh`, `vim install.sh`, `git log install.sh`) and not
 * when it is a suffix of a different filename (`pre-install.sh`,
 * `my-install.sh`). Every chained segment is checked so `cd x && bash
 * install.sh` is caught, not just a leading invocation.
 */
function isBashInvokingInstallSh(command: string): boolean {
  if (!command) return false;
  return splitShellSegments(command).some(segmentInvokesInstallSh);
}

/**
 * Extracts the EXECUTABLE token from a shell command, handling common shell
 * prefixes: `bash`/`sh` wrappers, and KEY=value env-var assignments.
 * Returns the basename of the first actual executable, or null if empty.
 */
function parseFirstShellWord(command: string): string | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  // Quote-aware: the shell strips quotes around the executable, so `"git" reset`
  // runs as `git reset`. A bare split(/\s+/) read the token `"git"` (quotes
  // attached), so `detectProhibitedGitVerb` skipped the segment (`"git"` !== 'git')
  // and the destructive reset slipped the R-WSRC-GR guard. Same root cause and
  // same fix as findGitVerb's quoted-verb gap.
  const tokens = tokenizeShellCommand(trimmed);
  const exec = tokens[execTokenIndex(tokens)];
  if (!exec) return null;
  return execName(exec);
}

const PROHIBITED_GIT_VERBS_SIMPLE = new Set(['reset', 'switch', 'stash', 'rebase', 'pull', 'push']);

/**
 * Git global options that consume the FOLLOWING token as their value when given
 * in space-separated form (`git -C <path> reset`). The verb scan must skip both
 * the option AND its value, otherwise the value token (`<path>`) is mistaken for
 * the verb and a prohibited operation slips the guard. The `=`-glued form
 * (`--git-dir=<path>`) is self-contained — it is already skipped as a flag.
 * Mirrors the option-arg handling in tsc-gate.ts:segmentIsGitCommit.
 */
const ARG_CONSUMING_GIT_GLOBAL_OPTIONS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path',
]);

/**
 * Returns true when `git checkout <args>` is targeting a ref (blocked).
 * Allowed: `git checkout -- <path>`, `git checkout .`, `git checkout` with no positional.
 */
function isCheckoutRefOperation(afterVerb: string[]): boolean {
  for (const t of afterVerb) {
    if (t === '--') return false; // path-mode
    if (t.startsWith('-')) continue; // flag
    if (t === '.') return false; // whole-tree restore
    return true; // first non-flag, non-'.', non-'--' token → ref
  }
  return false; // no positional args
}

/**
 * R-WSRC-GR: Detects prohibited git verbs per the Git Boundary Rules.
 * Returns {verb} when the command is a prohibited git operation, null otherwise.
 *
 * Allowed exceptions (return null):
 *   git checkout -- <path>       (path-mode via --)
 *   git checkout .               (whole-tree restore)
 *   git commit (without --amend) (plain commit is allowed)
 *   git fetch (without --prune)  (plain fetch is allowed)
 */
function findGitVerb(command: string): { verb: string; afterVerb: string[] } | null {
  const tokens = tokenizeShellCommand(command);
  let idx = execTokenIndex(tokens);
  idx++; // skip 'git' itself
  const rest = tokens.slice(idx).filter(t => t.length > 0);
  let verbIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    // Skip a space-separated arg-consuming global option AND its value token
    // (`-C <path>`), so the value is never mistaken for the verb.
    if (ARG_CONSUMING_GIT_GLOBAL_OPTIONS.has(rest[i])) { i++; continue; }
    if (!rest[i].startsWith('-')) { verbIdx = i; break; }
  }
  if (verbIdx === -1) return null;
  return { verb: rest[verbIdx].toLowerCase(), afterVerb: rest.slice(verbIdx + 1) };
}

export function detectProhibitedGitVerb(command: string): { verb: string } | null {
  if (!command) return null;
  // Evaluate every chained segment, not just the leading command: a worker
  // running `cd sub && git reset` or `git status && git push` must still be
  // caught (the leading token is `cd` / a benign git verb).
  for (const segment of splitShellSegments(command)) {
    if (parseFirstShellWord(segment) !== 'git') continue;
    const parsed = findGitVerb(segment);
    if (!parsed) continue;
    const { verb, afterVerb } = parsed;
    if (PROHIBITED_GIT_VERBS_SIMPLE.has(verb)) return { verb };
    if (verb === 'checkout' && isCheckoutRefOperation(afterVerb)) return { verb: 'checkout' };
    if (verb === 'commit' && afterVerb.some(t => t === '--amend')) return { verb: 'commit --amend' };
    if (verb === 'fetch' && afterVerb.some(t => t === '--prune')) return { verb: 'fetch --prune' };
  }
  return null;
}

/**
 * R-CSIS-B1: Extract the file path argument from `node --test <path>` commands.
 * Returns the first non-flag token after `--test`, or null if the pattern doesn't match.
 */
function extractNodeTestPathFromSegment(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  let idx = skipEnvAssignments(tokens);
  // execName, not a raw compare: `NODE --test <expensive>` and
  // `/usr/bin/node --test <expensive>` both really run node, and a raw
  // `!== 'node'` let them slip the expensive-test guard. Same fold as every
  // other exec-token compare in this file.
  if (execName(tokens[idx]) !== 'node') return null;
  idx++;
  let foundTestFlag = false;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (t === '--test') { foundTestFlag = true; idx++; continue; }
    if (foundTestFlag && !t.startsWith('-')) return t;
    idx++;
  }
  return null;
}

function extractNodeTestPath(command: string): string | null {
  if (!command) return null;
  // Check every chained segment so `cd x && node --test <expensive>` cannot
  // smuggle the expensive-test invocation past the leading-command check.
  for (const segment of splitShellSegments(command)) {
    const hit = extractNodeTestPathFromSegment(segment);
    if (hit) return hit;
  }
  return null;
}

/**
 * R-CSIS-B1: Returns true when testPath resolves to a file whose first line
 * is `// @tier: expensive`. Fails safe (returns false) on any read error.
 */
function isExpensiveTestFile(testPath: string, cwd: string): boolean {
  if (!testPath) return false;
  try {
    const resolved = path.isAbsolute(testPath) ? testPath : path.resolve(cwd, testPath);
    const content = fs.readFileSync(resolved, 'utf8');
    const firstLine = content.split('\n')[0] ?? '';
    return firstLine.trim() === '// @tier: expensive';
  } catch {
    return false;
  }
}

/**
 * R-CSIS-B1: Blocks `node --test <path>` when <path> is an expensive-tier test file.
 * Emits `closer_expensive_node_test_blocked` for the audit trail and calls block().
 */
function isExpensiveNodeTestBlockedByRCSIS(input: PreToolUseInput, _state: State): boolean {
  if (input.tool_name !== 'Bash' || !input.tool_input?.command) return false;
  const command = input.tool_input.command;
  const testPath = extractNodeTestPath(command);
  if (!testPath) return false;
  const extensionDir = getExtensionRoot();
  if (!isExpensiveTestFile(testPath, extensionDir)) return false;

  try {
    logActivity({
      event: 'closer_expensive_node_test_blocked',
      source: 'hook',
      gate_payload: { command, blocked_path: testPath },
    });
  } catch { /* best-effort */ }

  block('R-CSIS-B1: Directly running an expensive-tier test file via `node --test <path>` bypasses the RUN_EXPENSIVE_TESTS=1 skip guard and runs the full soak unconditionally. Use `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` instead.');
  return true;
}

/**
 * R-PIPE-3 extracted helper — keeps main() complexity <= 15.
 * Returns true if we handled (blocked or approved via override); caller should return.
 */
function isBashInstallBlockedByRWSRC(input: PreToolUseInput, state: State): boolean {
  if (input.tool_name !== 'Bash' || !input.tool_input?.command) return false;
  if (!isBashInvokingInstallSh(input.tool_input.command)) return false;

  const flags = (state.flags as Record<string, unknown> | undefined) || {};
  const override = trimmedFlag(flags, ALLOW_INSTALL_SH_REASON_FIELD);
  if (override) {
    logActivity({
      event: 'install_sh_override_used',
      source: 'hook',
      gate_payload: { override_reason: override, command: input.tool_input.command },
    });
    approve();
    return true;
  }

  block('R-WSRC: `bash install.sh` (and variants) is FORBIDDEN from worker subprocesses. This is manager-only. See CLAUDE.md "## ⛔ Worker Forbidden Ops". Set state.flags.allow_install_sh_reason only for explicit manager-owned closer steps.');
  return true;
}

const ALLOW_STATE_WRITE_REASON_FIELD = 'allow_state_writes_reason';
const ALLOW_SETTINGS_WRITE_REASON_FIELD = 'allow_settings_writes_reason';
const ALLOW_INSTALL_SH_REASON_FIELD = 'allow_install_sh_reason'; // rare manager override only (R-WSRC)

/** R-WSRC-GR: Per-verb operator override flags. Narrowly scoped — one flag per verb. */
const ALLOW_GIT_VERB_REASON_FIELDS: Record<string, string> = {
  'reset': 'allow_git_reset_reason',
  'checkout': 'allow_git_checkout_reason',
  'switch': 'allow_git_switch_reason',
  'stash': 'allow_git_stash_reason',
  'rebase': 'allow_git_rebase_reason',
  'commit --amend': 'allow_git_commit_amend_reason',
  'pull': 'allow_git_pull_reason',
  'push': 'allow_git_push_reason',
  'fetch --prune': 'allow_git_fetch_prune_reason',
};

function gitVerbEventName(verb: string, suffix: string): ActivityEventType {
  const base = verb.replace(/\s/g, '_').replace(/-+/g, '_');
  return `worker_git_${base}_${suffix}` as unknown as ActivityEventType;
}

/**
 * R-WSRC-GR: Blocks the 9 prohibited git verbs from worker subprocess contexts.
 * Manager / operator invocations (PICKLE_ROLE not set OR matches an allowed role) pass through.
 * R-WSRC-GR-LEAK fix (#76): widen to ALL worker-variant roles, not just 'worker' — the
 * refinement-team workers set PICKLE_ROLE='refinement-worker' and were leaking git resets
 * (B-PNTR 2026-05-25: 2x dropped commits on R-PNTR-1 ticket 373c9deb despite the hook
 * being live).
 */
function isGitVerbBlockedByRWSRCGR(input: PreToolUseInput, state: State): boolean {
  if (input.tool_name !== 'Bash' || !input.tool_input?.command) return false;
  const role = process.env.PICKLE_ROLE;
  if (!role) return false;
  // Worker-class roles that MUST honor Git Boundary Rules.
  const WORKER_ROLES = new Set(['worker', 'refinement-worker']);
  if (!WORKER_ROLES.has(role)) return false;
  const detected = detectProhibitedGitVerb(input.tool_input.command);
  if (!detected) return false;

  const { verb } = detected;
  const flagField = ALLOW_GIT_VERB_REASON_FIELDS[verb];
  const flags = (state.flags as Record<string, unknown> | undefined) || {};
  const override = flagField ? trimmedFlag(flags, flagField) : null;
  const ticketId = (state as unknown as Record<string, unknown>).current_ticket as string | null | undefined;

  if (override) {
    try {
      logActivity({
        event: gitVerbEventName(verb, 'bypass'),
        source: 'hook',
        gate_payload: { command: input.tool_input.command, reason: override, ticket_id: ticketId ?? null },
      });
    } catch { /* activity logging is best-effort */ }
    approve();
    return true;
  }

  try {
    logActivity({
      event: gitVerbEventName(verb, 'blocked'),
      source: 'hook',
      gate_payload: { command: input.tool_input.command, ticket_id: ticketId ?? null },
    });
  } catch { /* best-effort */ }

  block(`R-WSRC-GR: \`git ${verb}\` is FORBIDDEN inside worker subprocesses. PRESERVE WORK first (R-WUWC): commit verified changes scoped, then \`git restore <named-files>\` — NEVER \`git restore .\` or a directory over uncommitted work (restore is not blocked and wipes it all). Operator override: set state.flags.${flagField ?? `allow_git_${verb.replace(/\s/g, '_')}_reason`}="<reason>" to bypass.`);
  return true;
}

function evaluateStateWriteGate(
  input: PreToolUseInput,
  state: State,
): { decision: 'block' | 'approve'; reason?: string } | null {
  const hit = detectTargetedStateFile(input);
  if (!hit) return null;

  const flags = state.flags as Record<string, unknown> | undefined;
  const toolName = input.tool_name || '';

  if (hit.isSettings) {
    const settingsReason = trimmedFlag(flags, ALLOW_SETTINGS_WRITE_REASON_FIELD);
    if (settingsReason) {
      emitStateWriteOverride(hit.matched, settingsReason, toolName);
      return { decision: 'approve' };
    }
    // Settings-only files also accept the broader state-writes flag.
    const stateReason = trimmedFlag(flags, ALLOW_STATE_WRITE_REASON_FIELD);
    if (stateReason) {
      emitStateWriteOverride(hit.matched, stateReason, toolName);
      return { decision: 'approve' };
    }
    return {
      decision: 'block',
      reason: `Runtime settings file protected: ${hit.matched}. Set state.flags.${ALLOW_SETTINGS_WRITE_REASON_FIELD} or state.flags.${ALLOW_STATE_WRITE_REASON_FIELD} to a non-empty reason to override.`,
    };
  }

  const stateReason = trimmedFlag(flags, ALLOW_STATE_WRITE_REASON_FIELD);
  if (stateReason) {
    emitStateWriteOverride(hit.matched, stateReason, toolName);
    return { decision: 'approve' };
  }
  return {
    decision: 'block',
    reason: `Runtime state file protected: ${hit.matched}. Set state.flags.${ALLOW_STATE_WRITE_REASON_FIELD} to a non-empty reason to override.`,
  };
}

function main(): void {
  const inputData = readHookInputData();
  const input = inputData ? parseHookInput(inputData) : null;
  if (!input) {
    approve();
    return;
  }

  if (!isConfigProtectionEnabled(getExtensionRoot())) {
    approve();
    return;
  }

  const state = loadResolvedState();
  if (!state) {
    approve();
    return;
  }

  // R-WSRC-3: state-file write gate runs BEFORE the legacy config-file gate so
  // an `--allow-config-edit` flag cannot accidentally smuggle a state-file
  // write through; state writes require their own explicit override flags.
  const stateDecision = evaluateStateWriteGate(input, state);
  if (stateDecision) {
    if (stateDecision.decision === 'approve') {
      approve();
      return;
    }
    block(stateDecision.reason || 'Runtime state file protected.');
    return;
  }

  // R-PIPE-3 + R-WSRC: Hard block on `bash install.sh` (any variant) from worker context.
  // Extracted to keep main() cyclomatic complexity <= 15.
  if (isBashInstallBlockedByRWSRC(input, state)) {
    return; // block() or approve() already called inside
  }

  // R-CSIS-B1: Block `node --test <expensive-tier-file>` to prevent the bypass
  // of RUN_EXPENSIVE_TESTS=1 that causes a timeout→relaunch→re-soak infinite loop.
  if (isExpensiveNodeTestBlockedByRCSIS(input, state)) {
    return;
  }

  // R-WSRC-GR: Block prohibited git verbs (reset, checkout w/ ref, switch, stash, rebase,
  // commit --amend, pull, push, fetch --prune) from worker subprocess contexts.
  if (isGitVerbBlockedByRWSRCGR(input, state)) {
    return; // block() or approve() already called inside
  }

  const targetedConfigFile = detectTargetedConfigFile(input);
  if (!targetedConfigFile || hasAllowConfigEditFlag(process.argv.slice(2))) {
    approve();
    return;
  }
  block(`Config file protected: ${targetedConfigFile}. Pass ${ALLOW_CONFIG_EDIT_FLAG} to override.`);
}

try {
  main();
} catch (err) {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    const extensionDir = getExtensionRoot();
    fs.appendFileSync(
      path.join(extensionDir, 'debug.log'),
      `[config-protection] FATAL: ${msg}\n`
    );
  } catch {
    /* ignore */
  }
  approve();
}
