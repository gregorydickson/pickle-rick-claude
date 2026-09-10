import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
import { logActivity } from '../../services/activity-logger.js';
import { execAnchorIndex, execNameIs, execNamesIn, wordExpandsTo, execTokenIndex, isShellWrapper, SHELL_PATTERN_CHARS, patternNamesACommand, shellWordWitness, splitShellSegments, tokenizeShellCommand, tokenizeShellTokens, } from '../shell-exec.js';
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
];
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
];
const PROTECTED_STATE_BASENAMES = [
    'state.json',
    'circuit_breaker.json',
    'pipeline-status.json',
    'pickle_settings.json',
];
// Surfaces PROTECTED_WRITE_GLOBS at the module level for downstream tools that
// import the handler for auditing (e.g. an analyst grepping compiled mirrors).
export { PROTECTED_WRITE_GLOBS };
const SETTINGS_BASENAMES = new Set(['pickle_settings.json']);
const TMP_SUFFIX_RE = /\.tmp(?:\.\d+)?(?:\..*)?$/;
function getProtectedRuntimeRoot() {
    return path.resolve(os.homedir(), '.claude/pickle-rick');
}
function stripTmpSuffix(basename) {
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
 *
 * The two spellings are read through the ONE shared `execNamesIn`, not compared
 * as literals, because a write DESTINATION is a shell word and bash pathname-
 * expands it: `echo x > <session>/stat?.json` really clobbers state.json
 * (shim-verified, as do `stat[e].json` and `circuit_break*r.json`). Case-folding
 * answers "spelled differently"; it cannot answer "expands to it", so the
 * COMPARISON has to — the same expansion-is-not-quoting seam `execNameIs` was
 * built for, and the same question `isProtectedShellPattern` asks of the config
 * domain. Measured on the shipped handler pre-fix: 12 of 14 globbed write forms
 * APPROVED for a worker across redirect, `>>`, `>|`, tee/cp/mv and `sed -i`
 * while all three literal twins blocked.
 *
 * AP-EXT-ITER96-01: the bound is COVERAGE, not the command-word matcher's
 * `*`-elision, because this domain's names are not command words. `execNamesIn`
 * refuses to read ANY `*`-bearing spelling — a bound bought for SHORT command
 * names (`**No` names `nano`), where it is correct — and the state domain
 * borrowed it for four long dotted filenames it was never measured against, so
 * `> <session>/stat*.json` APPROVED while its `?` twin blocked and the config
 * sibling blocked the same shape (shim-verified both ends: the handler approves
 * and bash really clobbers state.json through it).
 *
 * `wordSpellsProtectedName` asks the ONE answerable question instead — does the
 * word LITERALLY spell at least half the name it expands to — which subsumes
 * both of `execNamesIn`'s bounds without enumerating a spelling. Measured over
 * 120,737 tokens of real worker Bash: the obfuscated spellings score 0.90–0.95
 * and the accidental globs that bound exists to protect score 0.00–0.35 (`*`
 * x501, `**` x41, `c*` x11, `s**`, `pickle_*`), so closing this costs ZERO
 * worker artifact writes. Do NOT push this bound down into `execNamesIn`: at
 * command-word length it would re-block `v*`/`*no`, the cost that bound bought.
 */
function matchProtectedStateBasename(filePath) {
    if (!filePath)
        return null;
    const base = path.basename(filePath).toLowerCase();
    for (const spelling of [base, stripTmpSuffix(base)]) {
        const named = PROTECTED_STATE_BASENAMES.find((name) => wordSpellsProtectedName(spelling, name));
        if (named)
            return named;
    }
    return null;
}
/**
 * True when the shell word `word` names `name` — literally, or as a pattern bash
 * pathname-expands to it that SPELLS at least half of it.
 *
 * The coverage half is what separates an obfuscated spelling of a protected file
 * from a short glob that reaches one by accident; a wildcard contributes no
 * literal, and neither does a bracket or brace body (`shellPatternToRegex` emits
 * a fixed class for those, so their contents are not read as characters here
 * either — the AP-EXT-ITER5-01 convention).
 */
function wordSpellsProtectedName(word, name) {
    if (word === name)
        return true;
    if (!wordExpandsTo(word, name))
        return false;
    const literals = word.replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '').replace(/[*?]/g, '').length;
    return literals * 2 >= name.length;
}
/**
 * Expands a leading `~`, `~/`, `$HOME`, or `${HOME}` to the absolute home
 * directory. `path.resolve` does NOT expand these shell forms, so a bash
 * redirect or tool `file_path` like `~/.claude/pickle-rick/...` would otherwise
 * resolve under the cwd (`<cwd>/~/...`) and slip past the runtime-root guard
 * even though the shell expands it to the real runtime tree at exec time.
 */
function expandLeadingHome(filePath) {
    if (filePath === '~')
        return os.homedir();
    if (filePath.startsWith('~/'))
        return path.join(os.homedir(), filePath.slice(2));
    const homeVar = filePath.match(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/);
    if (homeVar)
        return path.join(os.homedir(), filePath.slice(homeVar[0].length));
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
 *
 * Read per COMPONENT through the shared expansion reader, which is ONE check where
 * there were two: `resolved === root` and `resolved.startsWith(root + sep)` are
 * the same question asked of a different suffix, and both asked it of a LITERAL.
 * A path component is a shell word bash expands like any other, so
 * `~/.claude/pickle-ric?/extension/bin/setup.js` and `~/.clau?e/...` really
 * write the deployed runtime while the string compare saw an unequal prefix —
 * measured on the shipped handler, both APPROVED for a worker while the literal
 * twin blocked. Comparing components (not a regex over the whole path) keeps the
 * `/` boundary that makes `.claudeX` a different directory.
 *
 * AP-EXT-ITER96-02: read through `wordExpandsTo`, the expansion READ alone, and
 * NOT through `execNameIs` — whose `patternNamesACommand` bound ("a word of pure
 * wildcards names every command equally, so it names none") is true of a command
 * word and FALSE of a path component. A component sits beside a real directory
 * bash is about to list, so a bare star names `pickle-rick` exactly:
 * shim-verified, a pure-wildcard component written in place of `pickle-rick`
 * APPROVED on the shipped handler for a worker while the literal twin and the
 * `pickle-ric?` twin both blocked, and bash really clobbered the deployed
 * runtime file through it. This domain adds no bound
 * at all — the conjunction over every root component IS the bound, and it costs
 * zero: over 10154 real worker Bash commands (482091 words) the read flips one
 * token, `~/.claude/**`, itself a hazard spelling, and no decision (a heredoc
 * BODY is not a write destination, so the artifact writes carrying it approve
 * either way).
 */
function isInsideRuntimeRoot(filePath) {
    if (!filePath)
        return false;
    const rootParts = getProtectedRuntimeRoot().toLowerCase().split(path.sep);
    const parts = path.resolve(expandLeadingHome(filePath)).toLowerCase().split(path.sep);
    if (parts.length < rootParts.length)
        return false;
    return rootParts.every((rootPart, i) => wordExpandsTo(parts[i], rootPart));
}
/** The repository-internal directory the Git Boundary Rules forbid a worker to touch. */
const GIT_INTERNAL_DIR = '.git';
/**
 * True when `filePath` traverses — or IS — a repository's `.git` directory.
 *
 * AP-EXT-ITER254-01: the Git Boundary Rules close the worker's git contract by
 * naming a CATEGORY on both axes. The VERB axis was enumerated (and its
 * plumbing half closed by AP-EXT-ITER252-03); the PATH axis — "direct `.git/`
 * modification (any tool)", carried verbatim in four live prompt files — had no
 * enforcement member anywhere under `src/hooks`, so it failed OPEN exactly as a
 * missing verb does. Measured against the shipped handler with
 * PICKLE_ROLE=worker and both a blocking control (`> <session>/state.json`,
 * `git reset --hard`) and an approving one (`cat`) in the same probe run:
 * `> .git/HEAD`, `> .git/config`, `> .git/packed-refs`, `tee .git/HEAD`,
 * `truncate -s 0 .git/index`, `cp x .git/HEAD`, `sed -i '' … .git/config` and a
 * `Write` tool call at `.git/HEAD` ALL APPROVED while every gated verb blocked.
 * Shim-verified in a scratch repo (`GIT_CONFIG_GLOBAL=/dev/null` +
 * `useConfigOnly`): a plain `echo "ref: refs/heads/other" > .git/HEAD` took the
 * pinned branch from `main` at 3 commits to `other` at 1 with no reflog entry,
 * no warning and no working-tree change — the same silent commit loss
 * `git switch` and `git checkout <ref>` are blocked for, reached by a redirect.
 *
 * A COMPONENT test, not a prefix test: a worker's cwd is not knowable here (the
 * hook sees a token, and `git -C sub`, a submodule and a sibling checkout all
 * put `.git` at a different depth), so anchoring on one repository root would
 * need the enumeration this module has now failed at eight times. "Any path
 * component names `.git`" needs no list and no root. The last component counts
 * too: in a worktree or submodule `.git` is a FILE holding the gitdir pointer,
 * so writing it re-points the whole repository.
 *
 * Read through the shared `wordSpellsProtectedName`, never a `===` on the
 * component, so this domain inherits the ONE expansion reader and the ONE
 * coverage bound rather than growing a second spelling rule (AP-EXT-ITER96-01):
 * `.gi?/HEAD` scores 3*2 >= 4 and blocks, a bare `*` component scores 0 and does
 * not. `.github/` is a literal that is not `.git` and carries no pattern
 * character, so it can never reach this — verified directly, since the repo's
 * own release workflow lives there.
 */
function pathEntersGitDir(filePath) {
    if (!filePath)
        return false;
    return path.resolve(expandLeadingHome(filePath)).toLowerCase()
        .split(path.sep)
        .some((component) => wordSpellsProtectedName(component, GIT_INTERNAL_DIR));
}
/** Tool-input file_path match → returns reason string or null. */
function detectProtectedWriteTarget(filePath) {
    if (!filePath)
        return null;
    const stateMatch = matchProtectedStateBasename(filePath);
    if (stateMatch) {
        return { matched: filePath, isSettings: SETTINGS_BASENAMES.has(stateMatch) };
    }
    if (isInsideRuntimeRoot(filePath)) {
        return { matched: filePath, isSettings: false };
    }
    return null;
}
function isProtectedFile(filePath) {
    const base = path.basename(filePath);
    return PROTECTED_PATTERNS.some(p => p.test(base));
}
/**
 * True when the shell word `token` is a PATTERN bash may expand onto a protected
 * config filename.
 *
 * AP-EXT-ITER232-01: the FOURTH reader of the one glob question, and the one that
 * carried no bound. `matchProtectedStateBasename` keeps COVERAGE, `execNameIs`
 * keeps `patternNamesACommand`, `isInsideRuntimeRoot` deliberately keeps neither
 * — and this arm, alone, translated the pattern itself and asked THIRTY-NINE
 * names at once with nothing bounding the answer. A word of pure wildcards names
 * every member equally, so it names none; unbounded it named all thirty-nine, and
 * `cp -R "$SESS"/* /tmp/fixture/` blocked on the matched name `*` (live block in
 * the 2026-09-06 session log, which cost a worker the copy and a workaround).
 * Over 12180 real worker Bash commands the bound drops 16 blocks to 11 — exactly
 * the five pure-wildcard anchors (`*` x4, `**` x1), none of which names a config
 * file, and zero real spellings: `*.js`, `*.ts` and `*.mjs` still block because
 * they still SPELL something. COVERAGE is deliberately NOT the bound here even
 * though the state domain uses it: measured on the same corpus it drops those six
 * too (`*.js` scores 3*2 < 16 against `eslint.config.js`), and bash really does
 * expand `*.js` onto `eslint.config.js` — the under-block direction this module
 * does not trade into. Third statement of the AP-EXT-ITER96-01 law: a bound is
 * valid only in the domain it was MEASURED in.
 *
 * Reads through the shared `wordExpandsTo` rather than calling
 * `shellPatternToRegex` directly, so this file no longer holds a second direct
 * reader of the translator — the drift shape the ITER73-01 entry named this
 * function as already sharing, and did not.
 */
function isProtectedShellPattern(token) {
    const base = path.basename(token);
    if (!SHELL_PATTERN_CHARS.test(base) || !patternNamesACommand(base)) {
        return false;
    }
    return PROTECTED_BASH_CANDIDATES.some((candidate) => wordExpandsTo(base, candidate));
}
/** A token names a protected config file directly or via a shell glob/brace/bracket pattern. */
function isProtectedConfigToken(token) {
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
function findBashWriteTarget(command, probe) {
    if (!command)
        return null;
    // Normalized ONCE, BEFORE segmenting, so `>|` / `>&<file>` no longer carry a
    // `|` / `&` the segmenter would read as a control operator — including inside a
    // `bash -c '<payload>'` payload, whose quotes are still on at this point. That
    // is why the normalizer is quote-blind (see `normalizeRedirectOperators`); the
    // quoted/unquoted decision belongs to `findWriteTargetInScope`, not here.
    const normalized = normalizeRedirectOperators(command);
    for (const scope of [normalized, ...splitShellSegments(normalized)]) {
        const hit = findWriteTargetInScope(scope, probe);
        if (hit !== null)
            return hit;
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
 *     tested with the one uniform `execNamesIn` read over `WRITE_COMMANDS`,
 *     wherever it sits and however it is quoted.
 *
 * Quoting is not the only thing bash does to a word, and the fold cannot answer
 * for EXPANSION: `/usr/bin/t?e`, `/bin/c?` and `/usr/bin/s?d -i` really exec
 * tee/cp/sed (shim-verified), so a compare that reads the fold as a literal name
 * misses them. `execNamesIn` reads a pattern-bearing word as the pattern it is,
 * through the ONE shared translator, under the tighter bound a TWELVE-member set
 * read needs — see its docblock (AP-EXT-ITER73-01/-02).
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
function findWriteTargetInScope(command, probe) {
    const tokens = tokenizeShellTokens(command);
    // Pass 1: `>` / `>>` redirects — the immediate next token is the destination.
    for (let i = 0; i < tokens.length - 1; i++) {
        const isRedirect = !tokens[i].quoted && (tokens[i].value === '>' || tokens[i].value === '>>');
        if (!isRedirect)
            continue;
        const hit = probe(tokens[i + 1].value);
        if (hit !== null)
            return hit;
    }
    // Pass 2: write/editor commands that mutate a positional FILE arg
    // (`tee`/`cp`/`mv`/`rsync` destinations, `sed -i FILE`, `vim FILE`, ...).
    for (let i = 0; i < tokens.length; i++) {
        // execNamesIn (not a `.has` read of the fold): it carries the whole
        // `execName` normalization — case, a trailing `;`, an absolute path, a
        // backslash escape — AND reads a pattern-bearing word as the PATTERN bash
        // will expand (AP-EXT-ITER73-02). A word may name several members at once
        // (`?e?` names both `tee` and `sed`), so the anchor writes when ANY member
        // it names does; no arbitrary pick, and the ambiguity resolves fail-closed.
        const names = execNamesIn(tokens[i].value, WRITE_COMMANDS);
        if (names.length === 0)
            continue;
        const argsInScope = tokens.slice(i + 1).map((token) => token.value);
        if (!names.some((name) => anchorWritesPositionalArg(name, argsInScope)))
            continue;
        for (const arg of argsInScope) {
            if (arg.startsWith('-'))
                continue;
            const hit = probe(arg);
            if (hit !== null)
                return hit;
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
function bashWritesProtectedConfig(command) {
    return findBashWriteTarget(command, (token) => (isProtectedConfigToken(token) ? path.basename(token) : null));
}
/**
 * Isolate every output-redirect-to-file operator into a free-standing ` > ` so
 * it can never glue to its destination filename, and so no redirect still
 * carries a character (`|`, `&`) that the shell segmenter would read as a
 * control operator. Run once by `findBashWriteTarget` before segmenting.
 */
function normalizeRedirectOperators(command) {
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
 * Commands that MUTATE a file passed as a positional argument, which the redirect
 * tokenizer's `>`/`>>` pass does not cover.
 *
 * ONE membership criterion, not a roster of families (AP-EXT-ITER256-01): a
 * command belongs here when EVERY invocation of it over a positional file
 * operand mutates that operand — creating it, rewriting it, removing it, or
 * changing who may read it. That single question settles `tee`/`cp`/`mv`/`rsync`,
 * the in-place editors, the `dd`/`truncate`/`install`/`ln`/`touch` writers and
 * the destroyers `rm`/`shred`/`unlink`/`chmod`/`chown` alike, and it is the same
 * question that keeps `grep`/`ls`/`stat`/`cat`/`awk` out — they have no mutating
 * invocation at all, so no separate read-only exclusion rule is needed. The one
 * member whose implication is merely PARTIAL is `sed`, and it is not spared by a
 * second list: `IN_PLACE_ONLY_WRITERS` narrows the ANCHOR, never the set.
 *
 * The criterion is also what stops the set growing by theme. A command with a
 * read-only mode over the SAME operand fails it and stays out — `gzip -l`/`-t`,
 * `xz -l`, `tar -t` — because admitting one would need that command's own flag
 * grammar, the enumeration-fence trap this module has been bitten by repeatedly.
 * `mkdir` fails it for a different reason: it cannot touch an existing file at
 * all. Those exclusions are DECLARED RESIDUALS with a stated test, not gaps
 * nobody looked at.
 *
 * EVERY probe over EVERY protected domain walks this one class — a per-caller
 * command class is what let `sed -i state.json` through while `sed -i
 * tsconfig.json` blocked, i.e. the security gate ran narrower than the lint gate.
 *
 * A LIST, not a Set: the only question asked of it is "which members does this
 * shell word NAME?", which `execNamesIn` answers because bash expands
 * the command word. `.has` answered a different, weaker question — "is the fold
 * spelled exactly like a member" — and a Set exists to make exactly that read
 * fast, so keeping one would preserve the seam the bypass came through.
 *
 * AP-EXT-ITER252-01 — WHY THIS STAYS AN ENUMERATION, and what that costs. The
 * list-free formulation was written and MEASURED, not argued: invert the pass to
 * "a protected basename standing as a positional operand is a write UNLESS the
 * anchor is a known reader". Over 9,191 real worker Bash calls (139 live
 * `tmux_iteration_*.log` NDJSON transcripts), 215 name a protected basename and
 * 83 of those carry one as a bare positional under a READ anchor — `cat
 * "$S/state.json"`, `grep … state.json`, `head`, `find`. Inverting blocks 34% of
 * real protected-file traffic, nearly all of it reads, which is the over-block
 * the read-only exclusions on this very list exist to prevent. So no formulation
 * needs no list here: the shell gives the scanner no syntax that separates
 * `truncate FILE` from `head FILE`, only the command's identity. Do not
 * re-litigate the inversion — re-measure it if you must, the corpus is still
 * there.
 *
 * The cost of KEEPING the list is that its failure direction is SILENT: a
 * mutator absent from it approves, and nothing says so. `dd`/`truncate`/
 * `install`/`ln`/`touch` were absent and measured APPROVE against
 * `<session>/state.json` on the shipped handler while every listed twin blocked.
 * Their over-block cost over the same 9,191-call corpus is ZERO. A new member is
 * a one-line addition here — never a new code path — and it must arrive with
 * both halves measured.
 *
 * AP-EXT-ITER256-01 — DESTRUCTION is mutation, and the family name "writers" hid
 * that: the gap was raised on this subsystem's pass 2 and carried open through
 * passes 3 and 4 before this one closed it. `rm`, `rm -f`, `rm -rf`, `shred -u`, `unlink` and
 * `chmod 000` over `<session>/state.json` and `<session>/pickle_settings.json`
 * ALL measured APPROVE on the shipped handler while the `>` redirect and `tee`
 * twins blocked in the same probe run. Deleting the state file is strictly worse
 * than rewriting it: a rewrite risks a wrong value, a delete reaches the
 * state-unreadable crash floor. Closing them here also closes the `rm -rf .git`
 * residual the AP-EXT-ITER254-01 path gate declared, for free, because the class
 * is shared — that is the whole point of there being one class.
 *
 * Both halves measured over 8,805 unique real worker Bash calls (9,191 calls,
 * 139 live `tmux_iteration_*.log` NDJSON transcripts, the measuring session's own
 * logs excluded). The pre-fix and post-fix hit SETS are identical BY COMMAND
 * INDEX except for FOUR additions and ZERO losses, and `shred`/`unlink`/`chmod`/
 * `chown` contribute NONE of the four — every one comes from `rm`. Reported
 * rather than excused: those four are real commands that now block. Their cause
 * is measured, not guessed — each is an `rm -rf <scratch> && … <protected>`
 * chain whose `rm` anchor reaches a protected operand belonging to a LATER
 * segment, because `findWriteTargetInScope`'s Pass 2 walks the RAW un-segmented
 * scope as one of its scopes. NONE of the four survives segment-only scoping
 * (0 of 4, measured), so the over-block belongs to the scope union rather than
 * to these members, and closing it is AP-EXT-ITER256-02's job, not this one's.
 */
const WRITE_COMMANDS = [
    'tee', 'cp', 'mv', 'rsync', 'install', 'dd',
    'sed', 'perl', 'vim', 'vi', 'nano', 'emacs', 'ed', 'ex',
    'truncate', 'ln', 'touch',
    'rm', 'shred', 'unlink', 'chmod', 'chown',
];
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
/** The long spelling of sed's in-place flag — ONE declaration, the regex is built from it. */
const IN_PLACE_LONG_OPTION = '--in-place';
const IN_PLACE_LONG_RE = new RegExp(`^${IN_PLACE_LONG_OPTION}(=|$)`);
/** The character a single-dash option cluster must carry to be in-place mode. */
const IN_PLACE_CLUSTER_CHAR = 'i';
/**
 * True for `--in-place`, `--in-place=.bak`, and any single-dash cluster carrying
 * an `i` (`-i`, `-i.bak`, `-i''`, `-ni`). Long options other than `--in-place`
 * are excluded so a script passed as `--expression='s/a/i/'` is not read as one.
 *
 * Both arms are asked of a WITNESS (`shellWordWitness`), not of the raw word,
 * because bash pathname-expands an option word like any other: with a file named
 * `-i` in cwd, `sed -? '' s/a/b/ <state.json>` really rewrites the file
 * (shim-verified 2026-08-29 on this box — the target's contents were replaced),
 * while a literal `.includes('i')` saw `-?`, matched nothing, and APPROVED a
 * worker write through both R-WSRC-3 write gates. Same expansion-is-not-quoting
 * seam as `isShellWrapper` and `execNameIs`; this predicate is a SHAPE test, so
 * only the shared witness could reach it.
 *
 * The two arms want different fills — the long arm the option's own character at
 * that index, the cluster arm an `i` anywhere past the dash — so each supplies
 * its own `wantedAt`. What must NOT fork is the reading of "which construct
 * stands for one position", and that stays in `shellWordWitness`.
 */
function isInPlaceFlag(arg) {
    if (arg.startsWith('--')) {
        return IN_PLACE_LONG_RE.test(shellWordWitness(arg, idx => IN_PLACE_LONG_OPTION[idx] ?? '='));
    }
    return arg.startsWith('-')
        && shellWordWitness(arg, () => IN_PLACE_CLUSTER_CHAR).slice(1).includes(IN_PLACE_CLUSTER_CHAR);
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
function anchorWritesPositionalArg(name, argsInScope) {
    if (!IN_PLACE_ONLY_WRITERS.has(name))
        return true;
    return argsInScope.some(isInPlaceFlag);
}
/**
 * Detects whether `command` writes to a protected state file (redirect,
 * destination-arg writer, or in-place editor). Returns the matched path, or
 * `null` if none. Routes through the shared `findBashWriteTarget` walker with
 * the `detectProtectedWriteTarget` state-file probe.
 */
function detectBashStateWriteTarget(command) {
    return findBashWriteTarget(command, detectProtectedWriteTarget);
}
const ALLOW_CONFIG_EDIT_FLAG = '--allow-config-edit';
function hasAllowConfigEditFlag(args) {
    return args.includes(ALLOW_CONFIG_EDIT_FLAG);
}
function block(reason) {
    console.log(JSON.stringify({ decision: 'block', reason }));
}
function readHookInputData() {
    try {
        return fs.readFileSync(0, 'utf8');
    }
    catch {
        return null;
    }
}
function parseHookInput(inputData) {
    if (!inputData.trim()) {
        return null;
    }
    try {
        return JSON.parse(inputData);
    }
    catch {
        return null;
    }
}
function isConfigProtectionEnabled(extensionDir) {
    try {
        const flagSettings = readRecoverableJsonObject(path.join(extensionDir, 'pickle_settings.json'));
        return flagSettings?.enable_config_protection !== false;
    }
    catch { /* default true — continue with protection enabled */ }
    return true;
}
function loadResolvedState() {
    const stateFile = resolveStateFile(getDataRoot());
    if (!stateFile)
        return null;
    return loadActiveState(stateFile);
}
function trimmedFlag(flags, key) {
    if (!flags)
        return null;
    const v = flags[key];
    if (typeof v !== 'string')
        return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function emitStateWriteOverride(blockedPath, overrideReason, toolName) {
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
    }
    catch {
        /* activity-logger is already best-effort; never break the hook */
    }
}
function detectTargetedConfigFile(input) {
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
function detectTargetedStateFile(input) {
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
 * The `.git/` half of the Git Boundary Rules (AP-EXT-ITER254-01): returns the
 * write destination that reaches a repository-internal path, or null.
 *
 * Routes the Bash arm through the SHARED `findBashWriteTarget` walker with a
 * `.git`-path probe — the third `probe` caller beside the state and config ones,
 * and deliberately not a fourth traversal. The walker's arity is unchanged, so
 * the `single write-command class` invariant still holds by construction: this
 * domain gets the SAME `WRITE_COMMANDS` class, the same segment union and the
 * same redirect normalization as the other two, and cannot drift narrower.
 *
 * That sharing paid out: AP-EXT-ITER256-01 admitted the destroyers to the ONE
 * class for the STATE domain's sake, and `rm -rf .git`, `shred -u .git/HEAD`,
 * `unlink .git/index.lock` and `chmod 000 .git/config` — the residual this
 * docblock reported OPEN for a full pass — closed here at the same instant, with
 * no edit to this function. That is what a single class buys and a per-domain
 * one would not have.
 *
 * RESIDUAL, reported rather than claimed closed: the domain is closed by PATH,
 * so removing a repository's PARENT directory reaches `.git` without naming it,
 * exactly as `rm -rf <session dir>` reaches the state file — one granularity
 * gap, both domains, tracked as AP-EXT-ITER256-03. No member of any list can
 * express it, so do not try to close it by growing one.
 */
function detectGitDirWriteTarget(input) {
    const toolName = input.tool_name || '';
    const filePath = input.tool_input?.file_path || '';
    const command = input.tool_input?.command || '';
    if ((toolName === 'Write' || toolName === 'Edit') && filePath) {
        return pathEntersGitDir(filePath) ? filePath : null;
    }
    if (toolName === 'Bash' && command) {
        return findBashWriteTarget(command, (token) => (pathEntersGitDir(token) ? token : null));
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
 * The wrapper arm takes the anchor token ITSELF, not just what follows it,
 * because one word can be BOTH readings at once now that `isShellWrapper` reads
 * an expanded command word (AP-EXT-ITER93-01): `./install?sh` and `./*sh` name
 * the deploy script AND fill the interpreter shape, so the `execTokenIndex`
 * SKIP in the first arm walks straight past the script and the second arm's
 * `slice(wrapper + 1)` started one token too late. Both blocked before that
 * predicate learned to expand, so including the anchor is what keeps this a
 * widening rather than a trade.
 *
 * RESIDUAL, reported rather than claimed closed: a prefixed DIRECT exec with no
 * wrapper (`env ./install.sh`, `nohup ./install.sh`) still approves. It offers no wrapper
 * to anchor on, and separating it from `cat ./install.sh` provably requires the
 * prefix enumeration this whole family exists to refuse. The unprefixed
 * `./install.sh` blocks via the exec-token arm.
 */
function segmentInvokesInstallSh(segment) {
    const trimmed = segment.trim();
    if (!trimmed)
        return false;
    const tokens = tokenizeShellCommand(trimmed);
    const isDeployScript = (token) => execNameIs(token, 'install.sh');
    if (isDeployScript(tokens[execTokenIndex(tokens)]))
        return true;
    const wrapper = tokens.findIndex((token) => isShellWrapper(token));
    return wrapper >= 0 && tokens.slice(wrapper).some(isDeployScript);
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
function isBashInvokingInstallSh(command) {
    if (!command)
        return false;
    return splitShellSegments(command).some(segmentInvokesInstallSh);
}
/**
 * The verbs `detectProhibitedGitVerb` blocks with NO argument test at all.
 *
 * AP-EXT-ITER252-03 added the three REF-MUTATION plumbing spellings
 * (`update-ref`, `symbolic-ref`, `branch`). The Git Boundary Rules close this
 * set by naming a CATEGORY — "branch / HEAD mutation" — and the porcelain
 * members were the only ones ever enumerated, so the plumbing that reaches the
 * SAME ref approved: measured against the shipped handler with
 * PICKLE_ROLE=worker, `git update-ref HEAD <sha>`, `git symbolic-ref HEAD <ref>`
 * and `git branch -f|-D|-m` all APPROVED while `git reset --hard`,
 * `git checkout <ref>`, `git switch`, `git commit --amend` and
 * `git fetch --prune` blocked. Shim-verified in a scratch repo that each really
 * mutates what the blocked verbs mutate: `git update-ref HEAD HEAD~2` took the
 * branch from 3 commits to 1 with no reflog warning and no working-tree change,
 * `git symbolic-ref HEAD refs/heads/other` re-pointed HEAD off the pinned
 * branch, and `git branch -m` renamed the pinned branch out from under the run.
 * Losing commits silently is the B-PNTR failure this whole seam exists for.
 *
 * They are UNCONDITIONAL members rather than three new argument-tested arms
 * beside `checkout`/`commit`/`fetch`. That is the W5b subtract-before-add call,
 * not a shortcut: this function already carries four same-theme checks, so a
 * fifth is the guard-piling shape, and set membership is a one-line addition
 * that adds no branch and no complexity. The cost is paid in the OVER-block
 * direction, this module's established one.
 *
 * Both halves measured over 9,191 real worker Bash calls (139 live
 * `tmux_iteration_*.log` NDJSON transcripts, this session's own logs excluded):
 * blocks before 12, blocks after 12 — ZERO real commands flip. Reported rather
 * than claimed: that zero is partly an artifact. The corpus holds exactly ONE
 * real `git branch --show-current`, and it survives only because it sits inside
 * a `$(…)` substitution within a double-quoted string; the standalone form DOES
 * block now, as do `git symbolic-ref --short HEAD` and any `git <verb> … branch`
 * whose bare word folds to one of these names. The approved substitutes are
 * `git rev-parse --abbrev-ref HEAD` and `git status -sb`, both still APPROVE.
 * Blocking a read costs a worker one turn; approving a ref mutation costs the
 * bundle its commits.
 */
const PROHIBITED_GIT_VERBS_SIMPLE = new Set([
    'reset', 'switch', 'stash', 'rebase', 'pull', 'push',
    'update-ref', 'symbolic-ref', 'branch',
]);
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
 *
 * It is read as PATTERNS, via the shared `execNamesIn` (AP-EXT-ITER93-02), because
 * bash applies pathname expansion to EVERY word of a command, not only the command
 * word: with a file named `reset` in cwd, `git rese? --hard` really hard-resets
 * (shim-verified 2026-08-29 — staged work destroyed, `HEAD is now at ...`), yet a
 * `.has()` read of the raw word saw `rese?`, matched no member, and APPROVED for a
 * worker while its literal twin blocked. `git res[e]t`, `git {r,x}eset`, `git pus?`,
 * `git stas?`, `git rebas?`, `git swit?h`, `git pul?` and `git checkou? <ref>` all
 * measured APPROVE against the shipped handler. The exec-word seams learned this at
 * AP-EXT-ITER73-01/93-01; the verb is the same question one word to the right, and
 * asking it needs no table of expandable spellings.
 *
 * ORDER IS LOAD-BEARING: `execNamesIn` filters `names` in declaration order, so
 * spreading `PROHIBITED_GIT_VERBS_SIMPLE` FIRST means a word that spells several
 * gated verbs at once (`{stash,fetch}`, `????h`) yields the unconditionally
 * prohibited one, whose check needs no argument — never the conditional
 * `checkout`/`commit`/`fetch` reading that could approve. Re-sorting this list
 * would silently pick the approving member; the ENFORCE test pins it.
 */
const GATED_GIT_VERBS = [
    ...PROHIBITED_GIT_VERBS_SIMPLE, 'checkout', 'commit', 'fetch',
];
/**
 * Returns true when `git checkout <args>` is targeting a ref (blocked).
 * Allowed: `git checkout -- <path>`, `git checkout .`, `git checkout` with no positional.
 */
function isCheckoutRefOperation(afterVerb) {
    for (const t of afterVerb) {
        if (t === '--')
            return false; // path-mode
        if (t.startsWith('-'))
            continue; // flag
        if (t === '.')
            return false; // whole-tree restore
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
function findGitVerb(command) {
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
    if (anchor === -1)
        return null;
    const rest = tokens.slice(anchor + 1).map(t => t.value).filter(t => t.length > 0);
    // ONE uniform read: the verb is the first bare word the shell may expand to a
    // gated verb (`execNamesIn`, the same predicate the write-command seam reads
    // with, carrying the same measured `*` bound).
    // Deliberately no option table and no "stop at the first bare word" — both
    // made the verb position depend on knowing git's operand-taking options, and
    // a global option we had not enumerated silently shifted the read onto its
    // operand (see GATED_GIT_VERBS). Scanning the whole argument list for the verb
    // itself needs no such knowledge.
    let firstBare = -1;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i].startsWith('-'))
            continue;
        if (firstBare === -1)
            firstBare = i;
        const named = execNamesIn(rest[i], GATED_GIT_VERBS);
        if (named.length > 0)
            return { verb: named[0], afterVerb: rest.slice(i + 1) };
    }
    // No gated verb anywhere: fall back to the first bare word so the returned verb
    // still names the real subcommand for non-prohibited commands. Nothing in
    // detectProhibitedGitVerb can fire on it, so this arm cannot under-block.
    if (firstBare === -1)
        return null;
    return { verb: rest[firstBare].toLowerCase(), afterVerb: rest.slice(firstBare + 1) };
}
export function detectProhibitedGitVerb(command) {
    if (!command)
        return null;
    // Evaluate every chained segment, not just the leading command: a worker
    // running `cd sub && git reset` or `git status && git push` must still be
    // caught (the leading token is `cd` / a benign git verb).
    for (const segment of splitShellSegments(command)) {
        const parsed = findGitVerb(segment);
        if (!parsed)
            continue;
        const { verb, afterVerb } = parsed;
        if (PROHIBITED_GIT_VERBS_SIMPLE.has(verb))
            return { verb };
        if (verb === 'checkout' && isCheckoutRefOperation(afterVerb))
            return { verb: 'checkout' };
        // The gating FLAG is read through the same `execNameIs` the verb and the
        // exec word already read with (AP-EXT-ITER93-05): bash expands an option
        // word like any other, so with a file named `--amend` in cwd
        // `git commit --amen? -m x` really AMENDS (shim-verified 2026-08-29 in a
        // scratch repo: one commit still, HEAD sha replaced, subject overwritten)
        // while a `=== '--amend'` compare saw `--amen?`, matched nothing, and
        // APPROVED a history rewrite for a worker. `--prun?` and `--amen[d]`
        // measured the same and block now; the BRACE spelling `--{amend,amend}`
        // does NOT, and is not this seam's to fix — `splitShellSegments` reads its
        // `{`/`}` as command-group delimiters and splits the word before any flag
        // test runs (AP-EXT-ITER93-06, open). The `--` of `isCheckoutRefOperation`
        // deliberately stays literal: that arm returns FALSE (path-mode is
        // ALLOWED), so widening it is the under-block direction, the same reason
        // `NEGATIVE_GIT_SUBCOMMANDS` stays literal.
        if (verb === 'commit' && afterVerb.some(t => execNameIs(t, '--amend')))
            return { verb: 'commit --amend' };
        if (verb === 'fetch' && afterVerb.some(t => execNameIs(t, '--prune')))
            return { verb: 'fetch --prune' };
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
function extractNodeTestPathsFromSegment(segment) {
    const trimmed = segment.trim();
    if (!trimmed)
        return [];
    const tokens = tokenizeShellTokens(trimmed);
    // `execAnchorIndex` folds through `execName`, so `NODE --test <expensive>`,
    // `/usr/bin/node --test <expensive>` and a quoted `'node'` all anchor — every
    // one really runs node, and a raw `!== 'node'` let them slip this guard.
    const anchor = execAnchorIndex(tokens, 'node');
    if (anchor === -1)
        return [];
    const candidates = [];
    let foundTestFlag = false;
    for (let idx = anchor + 1; idx < tokens.length; idx++) {
        const t = tokens[idx].value;
        // Same `execNameIs` read as the git gating flags (AP-EXT-ITER93-05): the
        // anchor learned that bash expands the command word, but the FLAG one token
        // right was still a literal compare, so `node --tes? <expensive>` (a file
        // named `--test` in cwd) never set this and the R-CSIS-B1 soak guard
        // APPROVED, while its literal twin blocked. Measured over 10135 real worker
        // Bash commands: zero candidate lists change.
        if (execNameIs(t, '--test')) {
            foundTestFlag = true;
            continue;
        }
        if (foundTestFlag && !t.startsWith('-'))
            candidates.push(t);
    }
    return candidates;
}
function extractNodeTestPaths(command) {
    if (!command)
        return [];
    // Check every chained segment so `cd x && node --test <expensive>` cannot
    // smuggle the expensive-test invocation past the leading-command check.
    return splitShellSegments(command).flatMap((segment) => extractNodeTestPathsFromSegment(segment));
}
/**
 * R-CSIS-B1: the directories a RELATIVE `node --test` operand could resolve
 * against.
 *
 * Pre-fix the ONE base was `getExtensionRoot()` — the DEPLOYED install root
 * (`~/.claude/pickle-rick`), which carries no `tests/` directory at all, so
 * every relative spelling failed its read and the guard APPROVED the soak while
 * the byte-equivalent absolute twin BLOCKED (AP-EXT-ITER255-01: measured on the
 * shipped handler, 5 of 5 relative forms approved with the absolute form
 * blocking as a live control in the same run). The base a command actually runs
 * from is the session's working dir, which the hook already holds.
 *
 * A `cd` moves that base, and enumerating the movers (`cd`, `pushd`, a
 * subshell, `bash -c 'cd …'`) is the incomplete-declaration shape that has
 * failed in this module ten times — so nothing is enumerated: ANY token of the
 * command that names a real directory is taken as a plausible base. Over-reach
 * is fail-safe in exactly this guard's documented direction, the same reasoning
 * `extractNodeTestPathsFromSegment` records for its operands — a base only
 * reaches `block()` when `<base>/<candidate>` is a real file whose first line is
 * the expensive-tier marker, and blocking that is the conservative call.
 */
function resolveExpensiveTestBases(command, workingDir) {
    const bases = [workingDir];
    // The SAME token universe `extractNodeTestPaths` draws its candidates from,
    // for free: `splitShellSegments` expands a `bash -c '<cmd>'` payload, so the
    // wrapper form's `cd` is a bare token here exactly as its unwrapped twin is.
    // Read off the raw command instead and the payload stays one glued token —
    // measured: `bash -c 'cd extension && node --test <expensive>'` APPROVED
    // while the unwrapped twin BLOCKED.
    const tokens = splitShellSegments(command).flatMap((segment) => tokenizeShellCommand(segment));
    for (const token of tokens) {
        const base = path.resolve(workingDir, token);
        if (bases.includes(base))
            continue;
        try {
            if (fs.statSync(base).isDirectory())
                bases.push(base);
        }
        catch { /* not a directory on disk — not a cwd the shell could reach */ }
    }
    return bases;
}
/**
 * R-CSIS-B1: Returns true when testPath resolves to a file whose first line
 * is `// @tier: expensive`. Fails safe (returns false) on any read error.
 */
function isExpensiveTestFile(testPath, cwd) {
    if (!testPath)
        return false;
    try {
        const resolved = path.isAbsolute(testPath) ? testPath : path.resolve(cwd, testPath);
        const content = fs.readFileSync(resolved, 'utf8');
        const firstLine = content.split('\n')[0] ?? '';
        return firstLine.trim() === '// @tier: expensive';
    }
    catch {
        return false;
    }
}
/**
 * R-CSIS-B1: Blocks `node --test <path>` when <path> is an expensive-tier test file.
 * Emits `closer_expensive_node_test_blocked` for the audit trail and calls block().
 */
function isExpensiveNodeTestBlockedByRCSIS(input, state) {
    if (input.tool_name !== 'Bash' || !input.tool_input?.command)
        return false;
    const command = input.tool_input.command;
    const candidates = extractNodeTestPaths(command);
    if (candidates.length === 0)
        return false;
    const bases = resolveExpensiveTestBases(command, state.working_dir);
    // The FIRST candidate that is genuinely expensive-tier, not the first
    // candidate: which token is the path and which is an option operand is not
    // knowable without an operand table, so let the on-disk tier marker decide.
    const testPath = candidates.find((candidate) => bases.some((base) => isExpensiveTestFile(candidate, base)));
    if (!testPath)
        return false;
    try {
        logActivity({
            event: 'closer_expensive_node_test_blocked',
            source: 'hook',
            gate_payload: { command, blocked_path: testPath },
        });
    }
    catch { /* best-effort */ }
    block('R-CSIS-B1: Directly running an expensive-tier test file via `node --test <path>` bypasses the RUN_EXPENSIVE_TESTS=1 skip guard and runs the full soak unconditionally. Use `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` instead.');
    return true;
}
/**
 * R-PIPE-3 extracted helper — keeps main() complexity <= 15.
 * Returns true if we handled (blocked or approved via override); caller should return.
 */
function isBashInstallBlockedByRWSRC(input, state) {
    if (input.tool_name !== 'Bash' || !input.tool_input?.command)
        return false;
    if (!isBashInvokingInstallSh(input.tool_input.command))
        return false;
    const flags = state.flags || {};
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
/** Worker-class roles that MUST honor Git Boundary Rules. */
const WORKER_ROLES = new Set(['worker', 'refinement-worker']);
/**
 * The ONE read of `PICKLE_ROLE` behind the Git Boundary Rules gates.
 *
 * Both R-WSRC-GR arms — the verb gate and the `.git/` write gate — ask the same
 * question of the same env var, so it is asked once here rather than re-spelled
 * per arm; a second copy is how one arm ends up honouring `refinement-worker`
 * and the other not (the R-WSRC-GR-LEAK shape, B-PNTR 2026-05-25).
 *
 * Manager / operator invocations (PICKLE_ROLE unset, or a non-worker role) pass
 * through deliberately. `mux-runner.ts` and `jar-runner.ts` DELETE the variable,
 * so the operator session that legitimately reaches `.git` for a recovery is
 * never gated, and the runtime's own git callers go through `execFileSync` and
 * raise no Bash PreToolUse event at all.
 */
function isWorkerRole() {
    const role = process.env.PICKLE_ROLE;
    return !!role && WORKER_ROLES.has(role);
}
/**
 * `GIT_VERB_GATE`'s key for the PATH axis of the Git Boundary Rules. Carries a
 * `/`, which no git verb can, so it is unreachable by the verb detector.
 */
const GIT_DIR_WRITE_KEY = '.git/ write';
const GIT_VERB_GATE = {
    [GIT_DIR_WRITE_KEY]: { flag: 'allow_git_dir_write_reason', blocked: 'worker_git_dir_write_blocked', bypass: 'worker_git_dir_write_bypass' },
    'reset': { flag: 'allow_git_reset_reason', blocked: 'worker_git_reset_blocked', bypass: 'worker_git_reset_bypass' },
    'checkout': { flag: 'allow_git_checkout_reason', blocked: 'worker_git_checkout_blocked', bypass: 'worker_git_checkout_bypass' },
    'switch': { flag: 'allow_git_switch_reason', blocked: 'worker_git_switch_blocked', bypass: 'worker_git_switch_bypass' },
    'stash': { flag: 'allow_git_stash_reason', blocked: 'worker_git_stash_blocked', bypass: 'worker_git_stash_bypass' },
    'rebase': { flag: 'allow_git_rebase_reason', blocked: 'worker_git_rebase_blocked', bypass: 'worker_git_rebase_bypass' },
    'commit --amend': { flag: 'allow_git_commit_amend_reason', blocked: 'worker_git_commit__amend_blocked', bypass: 'worker_git_commit__amend_bypass' },
    'pull': { flag: 'allow_git_pull_reason', blocked: 'worker_git_pull_blocked', bypass: 'worker_git_pull_bypass' },
    'push': { flag: 'allow_git_push_reason', blocked: 'worker_git_push_blocked', bypass: 'worker_git_push_bypass' },
    'fetch --prune': { flag: 'allow_git_fetch_prune_reason', blocked: 'worker_git_fetch__prune_blocked', bypass: 'worker_git_fetch__prune_bypass' },
    'update-ref': { flag: 'allow_git_update_ref_reason', blocked: 'worker_git_update_ref_blocked', bypass: 'worker_git_update_ref_bypass' },
    'symbolic-ref': { flag: 'allow_git_symbolic_ref_reason', blocked: 'worker_git_symbolic_ref_blocked', bypass: 'worker_git_symbolic_ref_bypass' },
    'branch': { flag: 'allow_git_branch_reason', blocked: 'worker_git_branch_blocked', bypass: 'worker_git_branch_bypass' },
};
/**
 * The R-WSRC-GR audit line, best-effort. Lives here rather than inline so the two arms of
 * `isGitVerbBlockedByRWSRCGR` share ONE emitter and neither the try/catch nor the
 * gate-present check is re-spelled per arm.
 */
function logGitVerbGateEvent(gate, arm, gatePayload) {
    if (!gate)
        return; // total over detectProhibitedGitVerb's returns; an unknown verb loses only its audit line
    try {
        logActivity({ event: gate[arm], source: 'hook', gate_payload: gatePayload });
    }
    catch { /* activity logging is best-effort */ }
}
/** Exported for the ENFORCE test: every name this seam can emit, for a registry check. */
export function gitVerbGateEventNames() {
    return Object.values(GIT_VERB_GATE).flatMap((entry) => (entry ? [entry.blocked, entry.bypass] : []));
}
/**
 * R-WSRC-GR: Blocks the 9 prohibited git verbs from worker subprocess contexts.
 * Manager / operator invocations (PICKLE_ROLE not set OR matches an allowed role) pass through.
 * R-WSRC-GR-LEAK fix (#76): widen to ALL worker-variant roles, not just 'worker' — the
 * refinement-team workers set PICKLE_ROLE='refinement-worker' and were leaking git resets
 * (B-PNTR 2026-05-25: 2x dropped commits on R-PNTR-1 ticket 373c9deb despite the hook
 * being live).
 */
function isGitVerbBlockedByRWSRCGR(input, state) {
    if (input.tool_name !== 'Bash' || !input.tool_input?.command)
        return false;
    if (!isWorkerRole())
        return false;
    const detected = detectProhibitedGitVerb(input.tool_input.command);
    if (!detected)
        return false;
    const { verb } = detected;
    const gate = GIT_VERB_GATE[verb];
    const flagField = gate?.flag;
    const flags = state.flags || {};
    const override = flagField ? trimmedFlag(flags, flagField) : null;
    const ticketId = state.current_ticket;
    if (override) {
        logGitVerbGateEvent(gate, 'bypass', { command: input.tool_input.command, reason: override, ticket_id: ticketId ?? null });
        approve();
        return true;
    }
    logGitVerbGateEvent(gate, 'blocked', { command: input.tool_input.command, ticket_id: ticketId ?? null });
    block(`R-WSRC-GR: \`git ${verb}\` is FORBIDDEN inside worker subprocesses. PRESERVE WORK first (R-WUWC): commit verified changes scoped, then \`git restore <named-files>\` — NEVER \`git restore .\` or a directory over uncommitted work (restore is not blocked and wipes it all). Operator override: set state.flags.${flagField ?? `allow_git_${verb.replace(/\s/g, '_')}_reason`}="<reason>" to bypass.`);
    return true;
}
/**
 * R-WSRC-GR PATH axis (AP-EXT-ITER254-01): blocks a worker WRITE that lands inside a
 * repository's `.git/` directory, by any tool.
 *
 * A sibling of `isGitVerbBlockedByRWSRCGR`, not an arm inside it. That function already
 * carries the four same-theme verb checks the W5b subtract-before-add rule (Override 1.6)
 * forbids adding a fifth to, and its complexity sits close to the eslint ceiling; folding
 * a PATH question into a VERB detector would raise the count while making one symbol
 * answer two questions. Everything the two arms genuinely share is shared instead — the
 * role read (`isWorkerRole`), the gate table (`GIT_VERB_GATE`), the audit emitter
 * (`logGitVerbGateEvent`) and the write-target walker (`findBashWriteTarget`) — so the
 * only thing this adds is the question itself.
 */
function isGitDirWriteBlockedByRWSRCGR(input, state) {
    if (!isWorkerRole())
        return false;
    const target = detectGitDirWriteTarget(input);
    if (!target)
        return false;
    const gate = GIT_VERB_GATE[GIT_DIR_WRITE_KEY];
    const flags = state.flags || {};
    const override = gate ? trimmedFlag(flags, gate.flag) : null;
    const ticketId = state.current_ticket;
    if (override) {
        // Records the bypass and DECLINES to block — deliberately NOT `approve()`.
        // Every other gate in `main()` approves and returns on its override, which
        // ends the dispatch and skips the gates below it: with
        // `allow_git_reset_reason` set, `git reset --hard && cp x tsconfig.json`
        // approves, and the config gate that would have blocked the second half
        // never runs. Verified pre-existing on the shipped handler; not a shape to
        // copy. An override says "this worker may write `.git/`" and says nothing
        // about `tsconfig.json`, so falling through is both narrower and one case
        // SMALLER — there is no second approve site to keep in step.
        logGitVerbGateEvent(gate, 'bypass', { blocked_path: target, reason: override, ticket_id: ticketId ?? null });
        return false;
    }
    logGitVerbGateEvent(gate, 'blocked', { blocked_path: target, ticket_id: ticketId ?? null });
    block(`R-WSRC-GR: writing into a repository's \`${GIT_INTERNAL_DIR}/\` directory is FORBIDDEN inside worker subprocesses — it reaches the SAME branch/HEAD state the gated git verbs defend, with no reflog entry and no warning (a plain \`> .git/HEAD\` re-points the pinned branch). Blocked path: ${target}. Use the allowed porcelain instead: \`git add <paths>\`, \`git commit\`, \`git restore <named-files>\`. Operator override: set state.flags.${gate?.flag ?? 'allow_git_dir_write_reason'}="<reason>" to bypass.`);
    return true;
}
function evaluateStateWriteGate(input, state) {
    const hit = detectTargetedStateFile(input);
    if (!hit)
        return null;
    const flags = state.flags;
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
function main() {
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
    // R-WSRC-GR PATH axis: the same Rules forbid direct `.git/` modification by ANY tool,
    // which no verb member can express. Runs after the verb gate so a command that is both
    // (`git ... > .git/HEAD`) still reports the verb the worker actually typed.
    if (isGitDirWriteBlockedByRWSRCGR(input, state)) {
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
    }
    catch (err) {
        try {
            const msg = err instanceof Error ? err.message : String(err);
            const extensionDir = getExtensionRoot();
            fs.appendFileSync(path.join(extensionDir, 'debug.log'), `[config-protection] FATAL: ${msg}\n`);
        }
        catch {
            /* ignore */
        }
        approve();
    }
}
