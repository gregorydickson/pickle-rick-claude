/**
 * THE shell-executable-token normalizer for the hooks subsystem.
 *
 * Folds a shell executable token to its comparable form: trailing `;` stripped,
 * basename taken, lowercased. Every "is this token command X?" comparison in
 * `handlers/config-protection.ts` and `handlers/tsc-gate.ts` routes through it.
 *
 * Three bug classes collapse into this one fold:
 *   - case: the filesystem is case-insensitive on macOS/Windows, so `GIT commit`
 *     and `bash INSTALL.SH` really do execute git / install.sh (verified —
 *     `GIT --version` prints the git version). A `=== 'git'` compare approved
 *     them.
 *   - path: `tokens[0] === 'bash'` missed `/bin/bash`; taking the basename fixes
 *     the wrapper skip for absolute-path interpreters.
 *   - duplication: config-protection and tsc-gate each carried their own
 *     strip-`;`-then-basename logic and drifted apart — config-protection folded
 *     case while tsc-gate did not, so `GIT commit` blocked as a git verb but
 *     classified non-commit and skipped the R-WACT tsc gate. ONE home for the
 *     fold so the two detectors cannot re-fork.
 *
 * Undefined-tolerant: callers index directly into token arrays, and a prelude
 * that consumes every token yields `undefined`. Returns `''` there so a
 * comparison is simply false rather than a hook crash (hooks fail open).
 */
export function execName(token) {
    if (!token)
        return '';
    const clean = token.replace(/;+$/, '');
    const base = clean.includes('/') ? clean.substring(clean.lastIndexOf('/') + 1) : clean;
    return base.toLowerCase();
}
/** Leading `KEY=value` env assignment, written before the interpreter by the shell. */
export const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * THE quoted-span patterns for the subsystem's two token scanners.
 *
 * The double-quoted span honors backslash escapes (`\\.`), because bash does:
 * `"a \" b"` is ONE word. A naive `"[^"]*"` stops at the escaped quote and
 * desynchronizes every span after it. The single-quoted span deliberately does
 * NOT — inside `'…'` bash treats a backslash as a literal character, so
 * escape-awareness there would be wrong, not merely unnecessary.
 *
 * Both scanners consume these so a fix to one cannot skip the other; that
 * private-copy drift is exactly what AP-EXT-ITER12-01 collapsed one level up.
 */
const DOUBLE_QUOTED_SPAN = '"(?:\\\\.|[^"\\\\])*"';
const SINGLE_QUOTED_SPAN = '\'[^\']*\'';
/** `String.match` with a `/g` regex resets `lastIndex`, so these are reusable. */
const TOKEN_SCAN_RE = new RegExp(`${DOUBLE_QUOTED_SPAN}|${SINGLE_QUOTED_SPAN}|\\S+`, 'g');
const SEGMENT_SCAN_RE = new RegExp(`${DOUBLE_QUOTED_SPAN}|${SINGLE_QUOTED_SPAN}|\\n|\\S+`, 'g');
/**
 * Inside a double-quoted bash span a backslash escapes ONLY `"`, `\`, `$`, and
 * a backtick; before anything else it stays literal (`"a\nb"` really is `a\nb`).
 * Unescaping exactly that set turns a `-c` payload back into the command the
 * shell will run, so the recursive unwrap sees `git commit`, not `\"git`.
 */
const DOUBLE_QUOTE_ESCAPE_RE = /\\(["\\$`])/g;
/**
 * Tokenize a single (already-segmented) shell command, quote-aware: a quoted
 * span stays one token and its surrounding matching quotes are stripped, so
 * `git "reset"` tokenizes to `['git', 'reset']`.
 *
 * Without quote-stripping, a bare `split(/\s+/)` reads the token `"reset"` with
 * the quotes attached, so `git "reset" --hard` — which the shell runs as
 * `git reset --hard` — slipped the R-WSRC-GR guard.
 *
 * A double-quoted span is additionally UNESCAPED, so a nested payload survives
 * the round trip. Only the quoted form is unescaped: bash turns a bare
 * `git \"reset\"` into the word `"reset"` WITH the quotes, which git rejects as
 * an unknown subcommand — unescaping there would invent a block for a command
 * that never runs a reset.
 */
export function tokenizeShellCommand(command) {
    const raw = command.match(TOKEN_SCAN_RE) ?? [];
    return raw.map((token) => {
        if (token.length >= 2) {
            const first = token[0];
            const last = token[token.length - 1];
            if (first === '"' && last === '"') {
                return token.slice(1, -1).replace(DOUBLE_QUOTE_ESCAPE_RE, '$1');
            }
            if (first === '\'' && last === '\'') {
                return token.slice(1, -1);
            }
        }
        return token;
    });
}
/** True when the token is a `bash`/`sh` wrapper to be skipped before the real exec. */
export function isShellWrapper(token) {
    const name = execName(token);
    return name === 'bash' || name === 'sh';
}
/**
 * Index of the first token past a run of `KEY=value` env assignments.
 *
 * The shell writes assignments BEFORE the interpreter, so every exec-token read
 * begins here. Exported so no caller re-inlines the `ENV_ASSIGNMENT_RE` loop: a
 * private copy is what let `tsc-gate.ts` carry its own regex LITERAL under a
 * comment claiming it was "the identical regex".
 */
export function skipEnvAssignments(tokens, start = 0) {
    let idx = start;
    while (idx < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[idx]))
        idx++;
    return idx;
}
/**
 * THE exec-token prelude for the hooks subsystem: env assignments → optional
 * `bash`/`sh` wrapper → env assignments. Returns the index of the token the
 * shell will actually exec.
 *
 * ONE home for the same reason `execName` and `splitShellSegments` have one
 * (AP-EXT-EXECFOLD, AP-EXT-ITER12-01): the two handlers re-forked it and DRIFTED
 * — config-protection routed all three of its detectors through this prelude
 * while tsc-gate hand-rolled the env arm alone and never skipped the wrapper.
 * The order is load-bearing: a wrapper-skip-then-env-skip prelude never
 * recognizes `PICKLE_ROLE=x bash install.sh`.
 */
export function execTokenIndex(tokens) {
    const afterEnv = skipEnvAssignments(tokens);
    const afterWrapper = isShellWrapper(tokens[afterEnv]) ? afterEnv + 1 : afterEnv;
    return skipEnvAssignments(tokens, afterWrapper);
}
/**
 * Every operator at which bash starts a new command.
 *
 * Beyond the control operators (`&&`, `||`, `|`, `&`, `;`, newline) this
 * includes the GROUPING and COMMAND-SUBSTITUTION delimiters `(`, `)`, `{`, `}`
 * and a backtick. Those four also begin a command: bash runs the `git reset`
 * in `(git reset --hard)`, `{ git reset --hard; }`, `$(git reset --hard)` and
 * `` `git reset --hard` `` exactly as it runs the bare twin (shim-verified).
 * Leaving them out let the grouped form's leading token read as `(git` — which
 * `execName` folds to `(git`, matching no detector — so every prohibited verb
 * slipped simply by being wrapped in parens.
 *
 * `$` needs no entry: splitting on `(` already strips `$(` down to a lone `$`
 * segment, which is not an executable token in any detector.
 */
const SHELL_SEGMENT_SEPARATORS = new Set([
    '&&', '||', '|', '&', ';', '\n',
    '(', ')', '{', '}', '`',
]);
/**
 * A control operator glued to its neighbors (`git status&&git reset`) is one
 * `\S+` token, so the scanner alone never yields it as a boundary. This splits
 * it back out, DERIVED from `SHELL_SEGMENT_SEPARATORS` so an operator cannot be
 * declared a separator without the tokenizer honoring it — hardcoding one
 * character is what left `&&`/`||`/`|`/`&` glued-only-detectable-if-spaced.
 *
 * Alternation order is deliberately NOT curated: if `&` is tried before `&&`,
 * the two-character operator degrades into two adjacent one-character ones —
 * both already separators, so the boundary lands in the same place. `\n` is
 * excluded because `\S` cannot match one; the scanner matches it directly.
 */
const GLUED_SEPARATOR_RE = new RegExp(`(${[...SHELL_SEGMENT_SEPARATORS]
    .filter((op) => op !== '\n')
    .map((op) => op.replace(/[|\\^$*+?.()[\]{}]/g, '\\$&'))
    .join('|')})`);
/**
 * Bounded so a pathological `bash -c "bash -c ..."` nest cannot spin the hook;
 * three levels is far past any real worker command.
 */
const MAX_SHELL_COMMAND_STRING_DEPTH = 3;
/** `-c`, and the combined forms a login/exec shell takes (`-lc`, `-ec`, `-xc`). */
const SHELL_COMMAND_STRING_FLAG_RE = /^-[A-Za-z]*c/;
/**
 * THE shell segmenter for the hooks subsystem. Splits a command into segments
 * at every operator where bash starts a new command — the control operators
 * `&&`, `||`, `|`, `&`, `;`, an unquoted newline (a top-level command
 * terminator, semantically identical to `;`), and the grouping /
 * command-substitution delimiters `(`, `)`, `{`, `}`, and a backtick (see
 * `SHELL_SEGMENT_SEPARATORS`), so a command nested in a subshell, brace group,
 * or substitution is a segment of its own rather than part of its parent's.
 * Quote-aware: a separator inside single or double quotes (a commit message
 * `-m 'fix && reset bug'`, or a multi-line `-m "line1\nline2"`) is preserved and
 * never a split point. Whitespace around an operator is NOT required — bash
 * runs `git status&&git reset --hard` exactly as its spaced twin (shim-verified)
 * — so a glued operator is split back out via `GLUED_SEPARATOR_RE`.
 *
 * Every leading-command detector in the subsystem consumes it, because each one
 * inspects only the FIRST executable token of the string it receives. Without
 * segmentation, `cd sub && git reset --hard` and `git status\ngit reset --hard`
 * slip the worker-forbidden-op guards, and `git add -A && git commit` reads its
 * subcommand as `add` and skips the R-WACT tsc gate — yet the project CLAUDE.md
 * mandates the `cd <subdir> && git <verb>` pattern AND a worker naturally emits
 * sequential commands one per line, making both forms the common case.
 * Over-segmentation is fail-safe: detectors match only prohibited verbs /
 * `install.sh` / the `commit` subcommand, so benign chained commands still pass.
 *
 * Finally, a `bash -c '<cmd>'` / `sh -lc "<cmd>"` payload is itself expanded
 * into segments (`expandShellCommandStrings`). The quote-preserving tokenizer
 * keeps `<cmd>` as ONE token, so without the unwrap the only executable a
 * detector ever sees is the `-c` FLAG.
 *
 * ONE home for the split so the handlers cannot re-fork: config-protection and
 * tsc-gate each carried a private near-identical copy and DID drift —
 * config-protection gained the `-c` unwrap (AP-EXT-ITER10-01) while tsc-gate's
 * copy did not, so `bash -c "git commit -m x"` was classified non-commit and the
 * R-WACT tsc gate was skipped for it (AP-EXT-ITER12-01). Same failure shape, and
 * same fix, as the `execName` fold above.
 */
export function splitShellSegments(command, depth = 0) {
    // `\n` is matched as its own alternative BEFORE `\S+` so an unquoted newline
    // becomes a boundary token; the quoted spans match newlines too (their negated
    // classes include `\n`), so a newline inside a quoted commit message is kept.
    const rawTokens = command.match(SEGMENT_SCAN_RE) ?? [];
    const tokens = [];
    for (const raw of rawTokens) {
        const quoted = (raw.startsWith('"') && raw.endsWith('"')) ||
            (raw.startsWith('\'') && raw.endsWith('\''));
        if (quoted) {
            tokens.push(raw);
            continue;
        }
        // Separate a glued control operator (e.g. `git status&&git reset`) into its
        // own token so it acts as a boundary; quoted operators were preserved above.
        for (const part of raw.split(GLUED_SEPARATOR_RE)) {
            if (part.length > 0)
                tokens.push(part);
        }
    }
    const segments = [];
    let current = [];
    for (const token of tokens) {
        if (SHELL_SEGMENT_SEPARATORS.has(token)) {
            if (current.length > 0)
                segments.push(current.join(' '));
            current = [];
            continue;
        }
        current.push(token);
    }
    if (current.length > 0)
        segments.push(current.join(' '));
    return expandShellCommandStrings(segments.length > 0 ? segments : [command], depth);
}
/**
 * Returns the command-string payload of a `bash -c '<cmd>'` segment, or null
 * when the segment is not a shell command-string invocation. Uses the same
 * env-assignment prelude and `isShellWrapper` fold as every other exec-token
 * read, so `PICKLE_ROLE=x /bin/bash -lc '<cmd>'` resolves like the rest.
 */
function shellCommandStringPayload(segment) {
    const tokens = tokenizeShellCommand(segment);
    let idx = skipEnvAssignments(tokens);
    if (!isShellWrapper(tokens[idx]))
        return null;
    let sawCommandStringFlag = false;
    for (idx++; idx < tokens.length; idx++) {
        if (tokens[idx].startsWith('-')) {
            sawCommandStringFlag ||= SHELL_COMMAND_STRING_FLAG_RE.test(tokens[idx]);
            continue;
        }
        return sawCommandStringFlag ? tokens[idx] : null;
    }
    return null;
}
/**
 * Appends each `-c` payload's own segments after the wrapper segment. The
 * wrapper is KEPT (fail-safe: never removes a segment a detector already saw),
 * so `bash install.sh` — which carries no `-c` — is untouched.
 */
function expandShellCommandStrings(segments, depth) {
    if (depth >= MAX_SHELL_COMMAND_STRING_DEPTH)
        return segments;
    const expanded = [];
    for (const segment of segments) {
        expanded.push(segment);
        const payload = shellCommandStringPayload(segment);
        if (payload !== null)
            expanded.push(...splitShellSegments(payload, depth + 1));
    }
    return expanded;
}
