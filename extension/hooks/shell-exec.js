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
 * Tokenize a single (already-segmented) shell command, quote-aware: a quoted
 * span stays one token and its surrounding matching quotes are stripped, so
 * `git "reset"` tokenizes to `['git', 'reset']`.
 *
 * Without quote-stripping, a bare `split(/\s+/)` reads the token `"reset"` with
 * the quotes attached, so `git "reset" --hard` — which the shell runs as
 * `git reset --hard` — slipped the R-WSRC-GR guard.
 */
export function tokenizeShellCommand(command) {
    const raw = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return raw.map((token) => {
        if (token.length >= 2) {
            const first = token[0];
            const last = token[token.length - 1];
            if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
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
const SHELL_SEGMENT_SEPARATORS = new Set(['&&', '||', '|', '&', ';', '\n']);
/**
 * Bounded so a pathological `bash -c "bash -c ..."` nest cannot spin the hook;
 * three levels is far past any real worker command.
 */
const MAX_SHELL_COMMAND_STRING_DEPTH = 3;
/** `-c`, and the combined forms a login/exec shell takes (`-lc`, `-ec`, `-xc`). */
const SHELL_COMMAND_STRING_FLAG_RE = /^-[A-Za-z]*c/;
/**
 * THE shell segmenter for the hooks subsystem. Splits a command into top-level
 * segments on the control operators `&&`, `||`, `|`, `&`, `;`, and an unquoted
 * newline (a top-level command terminator, semantically identical to `;`).
 * Quote-aware: a separator inside single or double quotes (a commit message
 * `-m 'fix && reset bug'`, or a multi-line `-m "line1\nline2"`) is preserved and
 * never a split point.
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
    // becomes a boundary token; `"[^"]*"`/`'[^']*'` span newlines (negated class
    // includes `\n`), so a newline inside a quoted commit message is preserved.
    const rawTokens = command.match(/"[^"]*"|'[^']*'|\n|\S+/g) ?? [];
    const tokens = [];
    for (const raw of rawTokens) {
        const quoted = (raw.startsWith('"') && raw.endsWith('"')) ||
            (raw.startsWith('\'') && raw.endsWith('\''));
        if (quoted) {
            tokens.push(raw);
            continue;
        }
        // Separate glued `;` (e.g. `git status;git reset`) into its own token so
        // it acts as a boundary; quoted `;` was already preserved above.
        for (const part of raw.split(/(;)/)) {
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
    let idx = 0;
    while (idx < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[idx]))
        idx++;
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
