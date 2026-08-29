import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { State, ActivityEventType } from '../../types/index.js';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
import { logActivity } from '../../services/activity-logger.js';
import {
  execAnchorIndex,
  execName,
  execNameIs,
  execTokenIndex,
  isShellWrapper,
  SHELL_PATTERN_CHARS,
  shellPatternToRegex,
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
 * Quoting demotes an anchor differently in each pass, because bash treats the two
 * kinds of anchor asymmetrically — and ONLY the redirect arm is quote-sensitive:
 *   - a REDIRECT operator is syntax, and quoting is exactly how you turn it back
 *     into data: `echo '>' x` writes nothing. Pass 1 requires an unquoted `>`.
 *   - a COMMAND is a WORD, and quoting a word changes NOTHING about execing it:
 *     `'tee' state.json` and `"sed" -i '' s/a/b/ state.json` run tee and sed
 *     (shim-verified). Pass 2 therefore has NO quoting arm at all: every token is
 *     tested with the one uniform `WRITE_COMMANDS.has(execName(value))`, wherever
 *     it sits and however it is quoted.
 *
 * Pass 2 asks the ANSWERABLE question — does this scope contain a token the shell
 * may exec as a write command — exactly as `execAnchorIndex` does for `git`
 * (AP-EXT-ITER64-01). It deliberately no longer reads `execTokenIndex`. That
 * prelude answers "which token does the shell exec" POSITIONALLY, and a POSIX
 * command PREFIX (`env` / `command` / `nohup` / `nice` / `sudo` / `timeout` / …)
 * is an ordinary program that stands at that index with the real executable
 * behind it. So `i !== execIndex` was true OF THE REAL EXEC, demoting it to
 * "data": `env 'tee' <session>/state.json`, `nohup 'cp' …`, `command "mv" …`,
 * `env 'sed' -i …`, `nice`/`timeout`/`sudo` forms — 7 of 7 measured APPROVE for a
 * worker while every bare twin blocks, re-opening every R-WSRC-3 write guard to a
 * prefix plus one pair of quotes (shim-verified to really exec). Teaching the
 * prelude the prefixes would need a TABLE — the incomplete-enumeration shape that
 * has failed seven times in this module. The collapse needs none.
 *
 * The exception also bought nothing it claimed to. It existed to spare
 * `git commit -m "sed" -i <file>`, but the byte-identical unquoted twin
 * `git commit -m sed -i <file>` over-blocks anyway (measured, both directions).
 * It suppressed no false positive — it only taught the bypass to add quotes.
 * Over-block, never under-block: this module's established direction.
 *
 * Only the REDIRECT anchor is gated: a DESTINATION is legitimately quoted
 * (`> "state.json"`), so `tokens[i + 1]` and the positional args are probed
 * whatever their quoting.
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
    const name = execName(tokens[i].value);
    if (!WRITE_COMMANDS.has(name)) continue;
    const argsInScope = tokens.slice(i + 1).map((token) => token.value);
    if (!anchorWritesPositionalArg(name, argsInScope)) continue;
    for (const arg of argsInScope) {
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
 * `WRITE_COMMANDS` members whose FILE argument is a write target only in
 * in-place mode. Membership requires a TOTAL implication: "no in-place flag" =>
 * "no positional-arg write". `sed` qualifies — its only file-mutating mode is
 * `-i`, and the redirect form (`sed … > FILE`) is Pass 1's, not Pass 2's.
 *
 * `perl` looks like a sibling and is deliberately absent: `perl -e` runs
 * arbitrary code that can open its own argument for writing with no flag to key
 * on, so the implication is false and narrowing it would be fencing a shell by
 * verb enumeration (see the WRITE_COMMANDS speed-bump trap door). The editors
 * (`vim`/`ed`/…) write whenever a worker runs them at all.
 */
const IN_PLACE_ONLY_WRITERS = new Set(['sed']);

/**
 * True for `--in-place`, `--in-place=.bak`, and any single-dash cluster carrying
 * an `i` (`-i`, `-i.bak`, `-i''`, `-ni`). Long options other than `--in-place`
 * are excluded so a script passed as `--expression='s/a/i/'` is not read as one.
 */
function isInPlaceFlag(arg: string): boolean {
  if (arg.startsWith('--')) return /^--in-place(=|$)/.test(arg);
  return arg.startsWith('-') && arg.slice(1).includes('i');
}

/**
 * Pass 2 anchor validity: given the exec name and every token that follows it in
 * scope, does this invocation write a positional FILE argument at all?
 *
 * Without this, anchoring on the bare command name blocked a pure READ —
 * `sed -n '1,200p' <protected>`, `sed -e … <protected>`, `sed -f prog.sed
 * <protected>` — which is the same over-block the read-only exclusions on
 * `WRITE_COMMANDS` exist to prevent (`grep`/`cat`/`awk` are absent for exactly
 * that reason). Measured against the shipped handler: 6/6 read-only `sed` forms
 * blocked across the state, settings, and config gates while `cat`/`grep`/`head`
 * on the same paths approved.
 *
 * The flag scan spans the whole remaining scope rather than the leading flag run
 * (`sed 's/a/b/' -i FILE` permutes on GNU and must stay blocked). In the raw
 * un-segmented scope that lets a LATER segment's `-i` re-arm an earlier read —
 * fail-closed, the same direction the raw+segment union already fails, and each
 * segment is scanned on its own where the args are correctly bounded.
 */
function anchorWritesPositionalArg(name: string, argsInScope: string[]): boolean {
  if (!IN_PLACE_ONLY_WRITERS.has(name)) return true;
  return argsInScope.some(isInPlaceFlag);
}

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
 * Returns true if a single (already-segmented) shell command EXECS the deploy
 * script install.sh — whether it stands at the exec token or behind a shell wrapper.
 *
 * The wrapper is anchored WHEREVER IT SITS (`isShellWrapper`), the shape
 * `shellCommandStringPayload` already took one level down (AP-EXT-ITER63-06),
 * because the positional read this replaces has no list-free form: a POSIX
 * command PREFIX is an ordinary program that takes a command as its argument
 * and execs it, so it stands at `execTokenIndex` with the wrapper behind it.
 * The prelude folded to the PREFIX and the deploy-script test failed —
 * `env bash install.sh` plus `command`, `nohup`, `nice`, `exec`, `time`, `sudo`,
 * `timeout 600`, `setsid`, `stdbuf -o0` and chained forms: 13 of 13 APPROVED
 * for a worker while both controls BLOCKED (measured 2026-08-26 against the
 * shipped hook).
 *
 * A bare `execAnchorIndex(tokens, 'install.sh')` — the collapse the four sibling
 * detectors took — is NOT available here, and the asymmetry is the point: those
 * detectors anchor on an EXECUTABLE (`git`, `node`) that no read-only command
 * takes as an argument, while this one anchors on a SCRIPT that read-only
 * commands routinely do (`cat`, `vim`, `git log`, all pinned APPROVE). Nothing
 * list-free separates `cat install.sh` from `env bash install.sh` by the script token
 * alone. The WRAPPER is the discriminator that needs no table: a shell
 * interpreter standing before the script means the script is being RUN.
 *
 * Strictly WIDENS what blocks — the old exec-token read is retained as the
 * first arm — so no command that blocked before can stop blocking.
 *
 * RESIDUAL, reported rather than claimed closed: a prefixed DIRECT exec with no
 * wrapper (`env ./install.sh`, `nohup ./install.sh`) still approves. It offers no wrapper
 * to anchor on, and separating it from `cat ./install.sh` provably requires the
 * prefix enumeration this whole family exists to refuse. The unprefixed
 * `./install.sh` blocks via the exec-token arm.
 */
function segmentInvokesInstallSh(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  const tokens = tokenizeShellCommand(trimmed);
  const isDeployScript = (token: string | undefined): boolean => execNameIs(token, 'install.sh');
  if (isDeployScript(tokens[execTokenIndex(tokens)])) return true;
  const wrapper = tokens.findIndex((token) => isShellWrapper(token));
  return wrapper >= 0 && tokens.slice(wrapper + 1).some(isDeployScript);
}

/**
 * R-PIPE-3 / R-WSRC: Explicit detection for `bash install.sh` (and variants)
 * from worker contexts. This is a hard forbidden (manager-only) per the
 * project CLAUDE.md worker rules. The hook must return "block" for workers.
 *
 * Matches when install.sh is the EXECUTABLE token OR stands behind a shell
 * wrapper anywhere in the segment (see `segmentInvokesInstallSh`), not when
 * it appears as an argument to a read-only tool (`cat install.sh`, `vim install.sh`,
 * `git log install.sh`) and not when it is a suffix of a different filename
 * (`pre-install.sh`, `my-install.sh`). Every chained segment is checked so
 * `cd x && bash install.sh` is caught, not just a leading invocation.
 */
function isBashInvokingInstallSh(command: string): boolean {
  if (!command) return false;
  return splitShellSegments(command).some(segmentInvokesInstallSh);
}

const PROHIBITED_GIT_VERBS_SIMPLE = new Set(['reset', 'switch', 'stash', 'rebase', 'pull', 'push']);

/**
 * The verbs `detectProhibitedGitVerb` reacts to at all. `findGitVerb` returns the
 * FIRST bare word matching one of these, wherever it sits in the argument list —
 * which is what lets the verb be read WITHOUT knowing which git global options
 * consume a following operand.
 *
 * That enumeration (`ARG_CONSUMING_GIT_GLOBAL_OPTIONS`: `-C`, `-c`, `--git-dir`,
 * `--work-tree`, `--namespace`, `--super-prefix`, `--exec-path`) was the bug, not
 * the fix: it omitted `--config-env`, whose separate-operand form git really does
 * accept, so `git --config-env core.bare=MYVAL reset --hard` read `core.bare=MYVAL`
 * as the verb and APPROVED a destructive reset for a worker (measured 2026-08-25:
 * 12/12 forms bypassed the shipped handler, all six prohibited verbs plus chained
 * forms). Any table of "options that take an operand" is a set git can extend and
 * we cannot; missing a member fails OPEN. Matching on the verb instead inverts the
 * failure direction — an unrecognised global option is stepped over harmlessly, and
 * an option OPERAND that happens to spell a gated verb (`git -C reset status`) at
 * worst BLOCKS, which is the safe direction.
 *
 * This set is closed by the Git Boundary Rules, not by git's option surface: it is
 * exactly the verbs the checks below can return non-null for. Adding a git global
 * option must never require touching it.
 */
const GATED_GIT_VERBS = new Set([
  ...PROHIBITED_GIT_VERBS_SIMPLE, 'checkout', 'commit', 'fetch',
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
  const tokens = tokenizeShellTokens(command);
  // The git ANCHOR, not the exec-token prelude. A POSIX command PREFIX (`env`,
  // `command`, `nohup`, `nice`, `exec`, `time`, `sudo`, …) stands in exec
  // position and execs the real command behind it, so a positional read saw
  // `env` and this whole chain skipped the segment — `env git reset --hard`
  // APPROVED for a worker while its bare twin blocked (16 of 17 prefixed forms
  // measured against the shipped export). Teaching the prelude those prefixes
  // means enumerating them, the shape that has failed six times in this module;
  // scanning for the anchor needs no table, exactly as the verb scan below
  // needs no git-option table. See `execAnchorIndex`.
  const anchor = execAnchorIndex(tokens, 'git');
  if (anchor === -1) return null;
  const rest = tokens.slice(anchor + 1).map(t => t.value).filter(t => t.length > 0);
  // ONE uniform read: the verb is the first bare word that IS a gated verb.
  // Deliberately no option table and no "stop at the first bare word" — both
  // made the verb position depend on knowing git's operand-taking options, and
  // a global option we had not enumerated silently shifted the read onto its
  // operand (see GATED_GIT_VERBS). Scanning the whole argument list for the verb
  // itself needs no such knowledge.
  let firstBare = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('-')) continue;
    if (firstBare === -1) firstBare = i;
    if (GATED_GIT_VERBS.has(rest[i].toLowerCase())) {
      return { verb: rest[i].toLowerCase(), afterVerb: rest.slice(i + 1) };
    }
  }
  // No gated verb anywhere: fall back to the first bare word so the returned verb
  // still names the real subcommand for non-prohibited commands. Nothing in
  // detectProhibitedGitVerb can fire on it, so this arm cannot under-block.
  if (firstBare === -1) return null;
  return { verb: rest[firstBare].toLowerCase(), afterVerb: rest.slice(firstBare + 1) };
}

export function detectProhibitedGitVerb(command: string): { verb: string } | null {
  if (!command) return null;
  // Evaluate every chained segment, not just the leading command: a worker
  // running `cd sub && git reset` or `git status && git push` must still be
  // caught (the leading token is `cd` / a benign git verb).
  for (const segment of splitShellSegments(command)) {
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
 * R-CSIS-B1: Extract the candidate file path arguments from a `node --test`
 * command. Returns EVERY bare word after `--test`, in order, or `[]` when the
 * segment is not a `node --test` invocation.
 *
 * Every bare word, not "the first one": node options take OPERANDS and an
 * operand is a bare word standing before the positional paths, so a scan that
 * stopped at the first bare word stopped on the operand —
 * `node --test --test-reporter spec <expensive>` yielded `spec`,
 * `--test-name-pattern smoke` yielded `smoke`, `--test-concurrency 4` yielded
 * `4`. `isExpensiveTestFile` then failed its read on that non-path and the
 * guard APPROVED the soak (AP-EXT-ITER54-02; measured 8 of 12 forms, including
 * the second axis `node --test benign.test.js <expensive>` where the first
 * bare word IS a path but the wrong one). Same shape as AP-EXT-ITER54-01 one
 * module over.
 *
 * Handing the caller the whole candidate list needs no operand table, which is
 * the point: an enumerated list of operand-taking node options is the
 * AP-EXT-ITER18-01/ITER19-01 incomplete-declaration shape, one release of node
 * away from the next bypass. Over-reach is fail-safe in this guard's direction
 * — an operand only reaches `block()` if it names a real file whose first line
 * is `// @tier: expensive`, and blocking that is the conservative call.
 *
 * Tokenizes quote-aware via `tokenizeShellTokens` for the same reason the git
 * chain and `segmentInvokesInstallSh` do (the "quoted-token parity" trap door):
 * a bare `split(/\s+/)` reads `"node"`, `"--test"` and `"soak.test.js"` with the
 * quotes attached, so `node --test "<expensive>"` — which the shell runs as the
 * bare twin — read a destination that no longer exists on disk,
 * `isExpensiveTestFile` failed its read, and the guard APPROVED the soak while
 * the unquoted form blocked (measured: 4 of 7 forms). This was the last detector
 * in the file still on the bare split, and the residual the AP-EXT-EXECFOLD trap
 * door left open. `tokenizeShellCommand` is that tokenizer's `.value`
 * projection; this reads the tokens themselves so it can share `execAnchorIndex`.
 *
 * node is located by ANCHOR, not by position (AP-EXT-ITER63-05). The old read
 * was `execName(tokens[skipEnvAssignments(tokens)])`, and a POSIX command PREFIX
 * (`env`, `command`, `nohup`, `nice`, `timeout`, `sudo`, `setsid`, `stdbuf`,
 * `time`, `exec`, `npx`, …) is an ordinary program that stands in exec position
 * and execs the real command behind it — no env assignment, so the prelude
 * walked past nothing and the `!== 'node'` test failed on the PREFIX. The
 * segment yielded NO candidates, `isExpensiveTestFile` was never consulted, and
 * the R-CSIS-B1 soak guard APPROVED: `env node --test <expensive>`,
 * `nohup`/`nice`/`timeout 600`/`exec`/`sudo`/`setsid`/`stdbuf -o0`/`time` and
 * `cd extension && env node --test <expensive>` — 12 of 12 measured against the
 * shipped hook — while the byte-identical bare twin BLOCKED.
 *
 * Teaching the prelude those prefixes means enumerating them, the shape that has
 * now failed ten times in this module; the anchor needs no table, exactly as
 * `findGitVerb` needs none (AP-EXT-ITER63-02) and for the same reason. Scanning
 * from the anchor is a strict SUPERSET of the post-env index the old code read —
 * an env assignment can never fold to `node`, so the anchor lands on the same
 * token whenever the old read fired, and nothing that blocked before can stop
 * blocking now.
 */
function extractNodeTestPathsFromSegment(segment: string): string[] {
  const trimmed = segment.trim();
  if (!trimmed) return [];
  const tokens = tokenizeShellTokens(trimmed);
  // `execAnchorIndex` folds through `execName`, so `NODE --test <expensive>`,
  // `/usr/bin/node --test <expensive>` and a quoted `'node'` all anchor — every
  // one really runs node, and a raw `!== 'node'` let them slip this guard.
  const anchor = execAnchorIndex(tokens, 'node');
  if (anchor === -1) return [];
  const candidates: string[] = [];
  let foundTestFlag = false;
  for (let idx = anchor + 1; idx < tokens.length; idx++) {
    const t = tokens[idx].value;
    if (t === '--test') { foundTestFlag = true; continue; }
    if (foundTestFlag && !t.startsWith('-')) candidates.push(t);
  }
  return candidates;
}

function extractNodeTestPaths(command: string): string[] {
  if (!command) return [];
  // Check every chained segment so `cd x && node --test <expensive>` cannot
  // smuggle the expensive-test invocation past the leading-command check.
  return splitShellSegments(command).flatMap((segment) => extractNodeTestPathsFromSegment(segment));
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
  const candidates = extractNodeTestPaths(command);
  if (candidates.length === 0) return false;
  const extensionDir = getExtensionRoot();
  // The FIRST candidate that is genuinely expensive-tier, not the first
  // candidate: which token is the path and which is an option operand is not
  // knowable without an operand table, so let the on-disk tier marker decide.
  const testPath = candidates.find((candidate) => isExpensiveTestFile(candidate, extensionDir));
  if (!testPath) return false;

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

// CLI guard: only execute the hook entrypoint when invoked directly as a script.
// This module EXPORTS `detectProhibitedGitVerb` and `PROTECTED_WRITE_GLOBS` for
// downstream auditing tools, and without the guard an `import` of it runs the
// whole hook — reading fd 0 and printing a decision into the importer's stdout.
// The two sibling handlers already carry this guard (`tsc-gate.ts`, whose own
// fix commit reads "add CLI guard so test imports do not block on stdin", and
// `stop-hook.ts`).
//
// Basename compare, NEVER a realpath-exact one (AP-EXT-ITER4-01): `dispatch.ts`
// builds argv[1] from an un-realpathed `EXTENSION_DIR`, so through a symlinked
// install root a realpath-exact guard never fires, the hook emits nothing, and
// dispatch's "no valid decision JSON" arm approves — a fail-open strictly worse
// than the bug this guard closes.
if (process.argv[1] && path.basename(process.argv[1]) === 'config-protection.js') {
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
}
