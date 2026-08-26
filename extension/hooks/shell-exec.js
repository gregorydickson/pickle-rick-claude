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
/**
 * AP-EXT-ITER66-01: bash has FOUR word-quoting forms, not two. Beyond `'…'` and
 * `"…"` it takes the `$`-introduced spans `$'…'` (ANSI-C) and `$"…"` (locale),
 * and in both the `$` is SYNTAX — bash discards it, so `$'git'` IS the word
 * `git`. Declaring only the bare pair left the `$` to be scanned as an ordinary
 * character GLUED to the span, so the fold produced `$git`: every `execName`
 * compare missed, and `$'git' reset --hard`, `$'bash' install.sh`,
 * `$'tee' <session>/state.json` and `$'sed' -i … pickle_settings.json` all
 * APPROVED for a worker while their bare twins blocked (10/10 measured,
 * shim-verified to really exec). A two-member declaration of a four-member
 * grammar is the incomplete-declaration shape that has now failed eight times in
 * this module — the fix declares the grammar, it does not add a case.
 *
 * `$'…'` honors backslash escapes (bash: `\'` is a literal quote inside it), so
 * it needs the escape-aware span body; `$"…"` is `"…"` with the `$` dropped.
 */
const ANSI_C_QUOTED_SPAN = '\\$\'(?:\\\\.|[^\'\\\\])*\'';
const LOCALE_QUOTED_SPAN = '\\$"(?:\\\\.|[^"\\\\])*"';
/**
 * AP-EXT-ITER72-01: a BACKSLASH is bash's fourth quoting mechanism, and the
 * cheapest one. Outside quotes `\<char>` quotes exactly that character — for
 * every character that is not special it is a pure NO-OP on execution (it only
 * suppresses alias lookup), so `\git`, `g\it` and `gi\t` ALL really exec git
 * (shim-verified). The grammar had no escape part, so the backslash fell into
 * `UNQUOTED_RUN` as an ordinary character and `execName` folded `\git` to
 * `\git` — matching no detector.
 *
 * This is the ONE part that must be tried FIRST: `\"` has to be consumed as an
 * escaped literal quote before `DOUBLE_QUOTED_SPAN` can mistake that `"` for a
 * span opener.
 *
 * `[\s\S]` rather than `.` so an escaped NEWLINE is a part too — bash's line
 * continuation, which the fold must DELETE (see `unquotedEscapeChar`). Reading
 * it as an ordinary character instead would leave `gi\<newline>t` unfolded,
 * which is the same bypass wearing a different escape.
 */
const UNQUOTED_ESCAPE = '\\\\[\\s\\S]';
/**
 * A run of ordinary characters. It stops before a `$` that INTRODUCES a quoted
 * span, because that `$` belongs to the span, not to the run — without the
 * bound, `/usr/bin/$'git'` folds to `/usr/bin/$git` (basename `$git`) where bash
 * runs `/usr/bin/git`.
 *
 * It also stops before a backslash, which `UNQUOTED_ESCAPE` owns: a run that
 * could swallow the `\` would re-glue the escape to the word and undo the fold.
 */
const UNQUOTED_RUN = '(?:(?!\\$[\'"])[^\\s\'"\\\\])+';
/**
 * One PART of a bash word: an unquoted backslash escape, a complete quoted
 * span, a run of ordinary characters, or a lone unmatched quote.
 *
 * The escape alternative is FIRST so `\"`/`\'`/`\$` are consumed as escaped
 * literals before any span pattern can read their quote character as a
 * delimiter — the same reason a complete span is tried before the lone quote.
 *
 * The lone-quote alternative is last so a complete span always wins, and it
 * exists so an unterminated quote (`git commit -m "oops`) still yields its
 * characters rather than being skipped — the pre-adjacency scanner kept those
 * bytes via `\S+` and detectors compare against them. A trailing lone backslash
 * joins it for the same reason: no byte of a word may be silently dropped.
 */
const WORD_PART_SOURCE = `${UNQUOTED_ESCAPE}` +
    `|${ANSI_C_QUOTED_SPAN}|${LOCALE_QUOTED_SPAN}|${DOUBLE_QUOTED_SPAN}|${SINGLE_QUOTED_SPAN}` +
    `|${UNQUOTED_RUN}|['"$\\\\]`;
/**
 * `String.match` with a `/g` regex resets `lastIndex`, so these are reusable.
 *
 * `TOKEN_SCAN_RE` matches a whole bash WORD — one or more ADJACENT parts with
 * no whitespace between them — because bash concatenates them into a single
 * word: `ba"sh"` is the word `bash`. A scanner that instead offered a quoted
 * span OR a bare `\S+` run read `ba"sh"` as one un-unquoted token and every
 * `execName`/verb/write-anchor compare missed it (AP-EXT-ITER53-01).
 */
const TOKEN_SCAN_RE = new RegExp(`(?:${WORD_PART_SOURCE})+`, 'g');
const WORD_PART_RE = new RegExp(WORD_PART_SOURCE, 'g');
const SEGMENT_SCAN_RE = new RegExp(`\\n|(?:${WORD_PART_SOURCE})+`, 'g');
/**
 * Inside a double-quoted bash span a backslash escapes ONLY `"`, `\`, `$`, and
 * a backtick; before anything else it stays literal (`"a\nb"` really is `a\nb`).
 * Unescaping exactly that set turns a `-c` payload back into the command the
 * shell will run, so the recursive unwrap sees `git commit`, not `\"git`.
 */
const DOUBLE_QUOTE_ESCAPE_RE = /\\(["\\$`])/g;
/**
 * Inside `$'…'` a backslash escape may NAME a character numerically, so stripping
 * the delimiters is not enough to recover the word: bash runs `$'\\x67it'` and
 * `$'\\147it'` as `git` (shim-verified). Decoding the numeric forms is what makes
 * the fold agree with the shell; every other `\\<char>` yields `<char>`, which needs
 * no table of control letters and errs toward MATCHING a detector — this module's
 * established over-block-never-under-block direction.
 */
const ANSI_C_ESCAPE_RE = /\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|([\s\S]))/g;
function decodeAnsiCEscapes(body) {
    return body.replace(ANSI_C_ESCAPE_RE, (match, hex, u, bigU, octal, literal) => {
        if (literal !== undefined)
            return literal;
        const digits = hex ?? u ?? bigU ?? octal;
        const code = Number.parseInt(digits, octal === undefined ? 16 : 8);
        // An escape that names NO character stands as written — which is both what
        // bash does (3.2 leaves `$'\UFFFFFFFF'` as literal text) and the only
        // non-throwing answer. `String.fromCodePoint` raises RangeError past
        // U+10FFFF, and a throw inside this scanner is not a crash: `dispatch.ts`
        // fails OPEN, so the handler answers `approve` for the WHOLE command.
        // `$'\UFFFFFFFF' ; git reset --hard` disarmed every guard in the file at
        // once (measured, shim-verified to really run the reset). The resolvable
        // range is the guard; no per-escape table is involved.
        return code <= 0x10FFFF ? String.fromCodePoint(code) : match;
    });
}
/**
 * The character an unquoted backslash escape contributes, or null when the part
 * is not one.
 *
 * Two rules, both bash's, neither an enumeration: `\<newline>` is a line
 * CONTINUATION and contributes NOTHING (bash splices the word back together, so
 * `gi\<newline>t reset --hard` really runs git — shim-verified), and `\<char>`
 * contributes that character. There is no table of "special" characters
 * because bash needs none here: quoting a character that was not special is
 * simply a no-op, which is precisely why `\git` executes.
 *
 * Shared by the fold and the boundary splitter so the two cannot disagree about
 * which parts are escapes — the private-copy drift AP-EXT-ITER12-01 collapsed
 * one level up, and AP-EXT-ITER66-01 collapsed again for the quoting forms.
 */
function unquotedEscapeChar(part) {
    if (part.length !== 2 || part[0] !== '\\')
        return null;
    return part[1] === '\n' ? '' : part[1];
}
/**
 * The word a complete quoted span contributes, or null when the part is not one
 * (an ordinary run, or a lone unmatched quote).
 *
 * ONE parser for all FOUR of bash's word-quoting forms, so the grammar
 * (`WORD_PART_SOURCE`), the delimiter strip, and the per-form unescape cannot
 * drift apart — three copies of "which forms exist" is how `$'…'`/`$"…"` came to
 * be declared in none of them (AP-EXT-ITER66-01).
 */
function unquoteSpan(part) {
    const dollar = part.startsWith('$') ? 1 : 0;
    const open = part[dollar];
    if (open !== '"' && open !== '\'')
        return null;
    if (part.length < dollar + 2 || part[part.length - 1] !== open)
        return null;
    const body = part.slice(dollar + 1, -1);
    if (open === '"')
        return body.replace(DOUBLE_QUOTE_ESCAPE_RE, '$1');
    // `'…'` is bash's ONE literal form; its `$'…'` sibling processes escapes.
    return dollar === 1 ? decodeAnsiCEscapes(body) : body;
}
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
    return tokenizeShellTokens(command).map(token => token.value);
}
/**
 * `tokenizeShellCommand` carrying each word's quoted-ness, for the scanners that
 * must tell an OPERATOR from a character that merely looks like one. A `>` bash
 * read out of `"…"` is data, never a redirect; a `sed` inside quotes is an
 * argument, never an exec. `tokenizeShellCommand` is defined in terms of this so
 * the value half cannot drift from the quoting half — the same one-home rule the
 * rest of this module carries.
 */
export function tokenizeShellTokens(command) {
    return (command.match(TOKEN_SCAN_RE) ?? []).map(foldShellWord);
}
/**
 * Concatenate one word's parts the way bash does, unquoting each quoted span.
 *
 * `quoted` stays true only when EVERY part came from inside quotes. That is the
 * reading the redirect pass needs: a word whose value is exactly `>` is data
 * only if the `>` character itself was quoted, and a partially-quoted word's
 * lone unquoted part IS that character (quoted parts contribute the rest). The
 * looser "any part quoted" reading would demote the operator in `''>state.json`
 * — which bash really does run as a redirect — and re-open the write guard.
 *
 * For the exec-anchor pass the same rule errs fail-closed: a mixed-quoting word
 * in argument position (`git commit -m s"ed" -i x`) is treated as unquoted and
 * may over-block, never under-block.
 */
function foldShellWord(word) {
    const parts = word.match(WORD_PART_RE) ?? [];
    let value = '';
    let sawUnquoted = false;
    for (const part of parts) {
        // An escaped character DOES quote in bash's sense (`\>` is literal), but it
        // is counted UNQUOTED here on purpose: the redirect pass would then read
        // `\>` as an operator and over-block a command bash would not redirect.
        // That is this module's established direction — over-block, never
        // under-block — and the opposite reading would demote a real operator the
        // moment an attacker escaped it.
        const escaped = unquotedEscapeChar(part);
        if (escaped !== null) {
            value += escaped;
            sawUnquoted = true;
            continue;
        }
        const unquoted = unquoteSpan(part);
        if (unquoted === null) {
            value += part;
            sawUnquoted = true;
            continue;
        }
        value += unquoted;
    }
    return { value, quoted: parts.length > 0 && !sawUnquoted };
}
/**
 * A POSIX shell binary is NAMED `…sh` — `sh`, `bash`, `zsh`, `dash`, `ksh`,
 * `csh`, `tcsh`, `ash`, `fish`. That naming shape IS the test, so there is no
 * wrapper list to keep current.
 *
 * `name === 'bash' || name === 'sh'` was the same incomplete-declaration shape
 * AP-EXT-ITER54-01 removed one level down when it stopped enumerating
 * operand-taking bash options: a two-member set, one member away from a bypass.
 * It reached that bypass. Every non-bash shell on this box (`/bin/zsh`,
 * `/bin/dash`, `/bin/ksh` all present) hid its whole `-c` payload from every
 * detector, because `shellCommandStringPayload` returns null for a token this
 * predicate rejects and the payload is ONE quoted token — so
 * `zsh -c 'git reset --hard'` was APPROVED while its `bash`/`sh` twins blocked,
 * and `zsh install.sh` read its exec token as `zsh`. Collapsing to the shape
 * closes the whole family at once instead of adding a third member.
 *
 * Dot-bearing names are excluded by construction, which is load-bearing in the
 * `execTokenIndex` arm: `install.sh` must stay the EXEC token of
 * `bash install.sh`, never a wrapper skipped on the way to its argument.
 *
 * Over-reach is fail-safe in this module's established direction. `ssh` matches
 * the shape; treating it as a wrapper only moves the exec-token read one token
 * to the right (onto the host), which no detector fires on, and an `ssh -c
 * <cipher>` yields one extra benign segment to scan. Over-block, never
 * under-block.
 */
const SHELL_INTERPRETER_NAME_RE = /^[a-z]*sh$/;
/** True when the token is a shell wrapper to be skipped before the real exec. */
export function isShellWrapper(token) {
    return SHELL_INTERPRETER_NAME_RE.test(execName(token));
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
 * shell wrapper (`isShellWrapper`) → env assignments. Returns the index of the
 * token the shell will actually exec.
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
 * Index of the first token this segment may EXEC as `name`, or -1.
 *
 * The exec-token PRELUDE (`execTokenIndex`) answers "which token does the shell
 * exec" positionally, and that question has no list-free answer: a POSIX command
 * PREFIX is an ordinary program that takes a command as its argument and execs
 * it, so `env` / `command` / `nohup` / `nice` / `exec` / `time` / `sudo` /
 * `timeout` / `setsid` / `stdbuf` / `xargs` all stand in exec position while the
 * real executable stands behind them. Teaching the prelude to skip them means
 * enumerating them — the incomplete-declaration shape that has now failed six
 * times in this module (AP-EXT-ITER10-01/12-01/18-01/19-01/54-01/63-01), one
 * member from the next bypass.
 *
 * So this asks the ANSWERABLE question instead: does the segment contain a
 * token the shell may exec as `name`, wherever it sits? That needs no prefix
 * table, exactly as `findGitVerb` needs no git-global-option table since it
 * stopped reading the verb POSITIONALLY (see `GATED_GIT_VERBS`).
 *
 * ONE uniform test — `execName(value) === name` — and deliberately NO quoting
 * exception (AP-EXT-ITER64-01). The exception this had said a quoted word only
 * anchors AT `execTokenIndex`, which re-admitted the positional read this
 * function exists to retire: a command prefix stands at that index, so the real
 * quoted exec one token later was demoted to "data" and vanished. `env 'git'
 * reset --hard`, `nohup "git" push`, `command 'git' stash`, `nice 'git' rebase`,
 * `exec`/`sudo`/env-prefixed forms — 8 of 8 measured APPROVE for a worker while
 * their unquoted twins block, every one shim-verified to really run git.
 *
 * The exception also bought nothing it claimed to: it existed to spare an
 * argument-position `echo 'git' reset`, but the byte-identical `echo git reset`
 * over-blocks anyway (measured). It suppressed no false positive — it only
 * taught the bypass to add quotes.
 *
 * This is NOT the AP-EXT-ITER51-02 rule and never shared code with it. That rule
 * governs `findWriteTargetInScope`'s Pass 2 over `WRITE_COMMANDS`, still reads
 * `tokens[i].quoted && i !== execIndex` there, and is left untouched HERE only
 * because one fix ships per pass — NOT because it is safe. The replay measured
 * it defeated identically: `env 'tee' <session>/state.json`, `nohup 'cp' …`,
 * `command "mv" …` and `env 'sed' -i '' … ` all APPROVE for a worker while both
 * their bare and their merely-quoted twins block, re-opening every R-WSRC-3
 * protected-state-file write guard (shim-verified to really exec). Tracked as
 * AP-EXT-ITER64-02; the same collapse applies there, but Pass 2 must keep its
 * UNQUOTED test on the `>`/`>>` REDIRECT anchor, which quoting really does turn
 * back into data (AP-EXT-ITER51-01). The two anchors are asymmetric; only the
 * exec one is safe to make quoting-blind.
 *
 * Over-reach is fail-safe in this module's established direction: a bare `git`
 * argument to some other program (`echo git reset`, quoted or not) anchors and
 * may over-block, while every prefixed form under-blocked before. Over-block,
 * never under-block.
 */
export function execAnchorIndex(tokens, name) {
    for (let i = 0; i < tokens.length; i++) {
        if (execName(tokens[i].value) === name)
            return i;
    }
    return -1;
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
 * Finally, every command string bash will re-parse as CODE is itself expanded
 * into segments (`expandShellCommandStrings`): a `bash -c '<cmd>'` / `sh -lc
 * "<cmd>"` payload, the arguments of the `eval` builtin (`eval "<cmd>"`), and
 * the operand of a here-string (`bash <<< '<cmd>'`, AP-EXT-ITER70-02).
 * The quote-preserving tokenizer keeps `<cmd>` as ONE token, so without the
 * unwrap the only executable a detector ever sees is the `-c` FLAG — or, for
 * `eval`, the builtin's own name (AP-EXT-ITER70-01), or, for a here-string, the
 * shell that will read it.
 *
 * ONE home for the split so the handlers cannot re-fork: config-protection and
 * tsc-gate each carried a private near-identical copy and DID drift —
 * config-protection gained the `-c` unwrap (AP-EXT-ITER10-01) while tsc-gate's
 * copy did not, so `bash -c "git commit -m x"` was classified non-commit and the
 * R-WACT tsc gate was skipped for it (AP-EXT-ITER12-01). Same failure shape, and
 * same fix, as the `execName` fold above.
 */
/**
 * Split ONE bash word into boundary tokens, keeping its parts glued.
 *
 * A quoted part is appended verbatim (quotes included, for the tokenizer that
 * reads the segment later) and can never be a boundary — that is how `-m "a &&
 * b"` keeps its operator as data. An unquoted part is split on
 * `GLUED_SEPARATOR_RE`, so an operator glued to its neighbors still ends the
 * accumulating word and stands alone.
 *
 * Deciding quoted-ness per PART, not per whole raw token, is load-bearing in
 * both directions: `ba"sh"` must stay ONE token (a `"`-delimited-ends test
 * would split the word and lose the adjacency the tokenizer needs), and
 * `"a"&&"git" reset` must still break at the unquoted `&&` (a whole-token test
 * sees a word that starts and ends with `"` and would swallow the boundary,
 * hiding the reset).
 */
function pushWordBoundaryTokens(word, tokens) {
    let buffer = '';
    const flush = () => {
        if (buffer.length > 0)
            tokens.push(buffer);
        buffer = '';
    };
    for (const part of word.match(WORD_PART_RE) ?? []) {
        // An ESCAPED separator is data, exactly like a quoted one: bash runs
        // `echo A \; echo B` as ONE command printing `A ; echo B` (verified). The
        // part is appended verbatim — backslash included — because the segment is
        // re-tokenized later, where the fold decodes it once.
        if (unquoteSpan(part) !== null || unquotedEscapeChar(part) !== null) {
            buffer += part;
            continue;
        }
        for (const piece of part.split(GLUED_SEPARATOR_RE)) {
            if (piece.length === 0)
                continue;
            if (SHELL_SEGMENT_SEPARATORS.has(piece)) {
                flush();
                tokens.push(piece);
                continue;
            }
            buffer += piece;
        }
    }
    flush();
}
export function splitShellSegments(command, depth = 0) {
    // `\n` is matched as its own alternative BEFORE the word pattern so an
    // unquoted newline becomes a boundary token; the quoted spans match newlines
    // too (their negated classes include `\n`), so a newline inside a quoted
    // commit message is kept.
    const rawTokens = command.match(SEGMENT_SCAN_RE) ?? [];
    const tokens = [];
    for (const raw of rawTokens) {
        if (raw === '\n') {
            tokens.push(raw);
            continue;
        }
        pushWordBoundaryTokens(raw, tokens);
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
 * when the segment is not a shell command-string invocation.
 *
 * The WRAPPER is anchored wherever it sits, not read positionally. Gating on
 * `isShellWrapper(tokens[skipEnvAssignments(tokens)])` asked the unanswerable
 * positional question `execAnchorIndex` already retired one level up: a POSIX
 * command PREFIX (`env`, `nohup`, `command`, `nice`, `timeout`, `sudo`, …) is an
 * ordinary program standing in exec position while the shell stands behind it,
 * so the env-assignment prelude walked past nothing and the wrapper test failed
 * on the PREFIX. The payload is ONE quoted token, so a failed test hid the
 * ENTIRE command string from every detector at once: `env bash -c "git reset
 * --hard"`, `nohup sh -c "git push origin main"` and `env bash -c "bash
 * install.sh"` all APPROVED for a worker while their unprefixed twins blocked
 * (AP-EXT-ITER63-06). This is the shared root of the positional-exec-read family
 * — it re-opened the git-verb, install.sh, expensive-test and R-WSRC-3
 * state-write guards in a single stroke.
 *
 * Scanning for the wrapper strictly WIDENS what unwraps — the old post-env index
 * is still scanned, it is simply no longer the only one — so no command that
 * blocked before can stop blocking now. Env assignments need no separate skip:
 * `KEY=value` cannot match the interpreter naming shape, so
 * `PICKLE_ROLE=x /bin/bash -lc '<cmd>'` still resolves. That collapse is the
 * point — two same-theme guards for one concern were the smell (Override 1.6).
 *
 * The payload is the word immediately AFTER the command-string flag, found
 * wherever that flag sits in the wrapper's option run — never "the first word
 * that does not start with `-`". Bash options take OPERANDS (`-o pipefail`,
 * `+o histexpand`, `-O extglob`, `--rcfile FILE`, `--init-file FILE`), and each
 * operand is a bare word standing before the `-c`. A scan that stopped at the
 * first bare word therefore quit at `pipefail` and never reached the flag, so
 * `bash -o pipefail -c "git reset --hard"` was never unwrapped and every
 * detector saw only the wrapper (AP-EXT-ITER54-01).
 *
 * Reading forward from the flag needs no operand table, which is the point: an
 * enumerated list of operand-taking options is the same incomplete-declaration
 * shape as AP-EXT-ITER18-01/ITER19-01, one more member away from a bypass.
 * Over-reach is fail-safe in the module's existing direction — an unusual
 * `bash script.sh -c arg` yields one extra segment to scan, and the wrapper
 * segment is kept regardless.
 */
function shellCommandStringPayload(segment) {
    const tokens = tokenizeShellCommand(segment);
    const wrapper = tokens.findIndex((token) => isShellWrapper(token));
    if (wrapper < 0)
        return null;
    for (let idx = wrapper + 1; idx < tokens.length; idx++) {
        if (SHELL_COMMAND_STRING_FLAG_RE.test(tokens[idx]))
            return tokens[idx + 1] ?? null;
    }
    return null;
}
/**
 * The bash BUILTINS that take a WORD and re-parse it as CODE: `eval` and
 * `trap`. Two members, ONE extractor — `trap` arrived as AP-EXT-ITER71-01 and
 * was absorbed by generalizing this function rather than adding a fourth
 * payload extractor beside it, because the two builtins share BOTH halves of
 * the shape: the same anchor (a builtin has no binary to name, so
 * `isShellWrapper` cannot reach either) and the same take (every following
 * token, joined). A second function would have been the same check written
 * twice — the guard-family fork this module has already paid for once
 * (AP-EXT-ITER12-01).
 *
 * This is a GRAMMAR declaration, not a carrier catalog: bash's word-to-code
 * builtins are fixed by the language. `source`/`.` take a FILE, `alias` needs
 * an interactive / `expand_aliases` path a hook-fronted `Bash` call never
 * takes, and a pipeline's upstream hands the shell a program's OUTPUT
 * (`… | sh`) — none of those leaves a word to unwrap.
 */
const WORD_TO_CODE_BUILTINS = ['eval', 'trap'];
/**
 * The command string a word-to-code builtin will re-parse and run, or null when
 * the segment carries none.
 *
 * `-c` is not the only place a bash WORD becomes CODE. These builtins are the
 * shell's other one — no binary, no PATH lookup, nothing to install — so
 * `isShellWrapper`'s naming shape can never reach them and
 * `shellCommandStringPayload` returns null for every `eval` / `trap` form. The
 * payload is then ONE quoted token, which is exactly the AP-EXT-ITER63-06
 * failure mode: a single missed unwrap hides the WHOLE command from every
 * detector at once. Measured 2026-08-26 against the shipped mirror — the
 * `eval` family of AP-EXT-ITER70-01 (all 9 gated verbs, the `install.sh` ban,
 * both R-WSRC-3 write gates) and `trap '<cmd>' EXIT` in its single-quoted,
 * double-quoted, `--`-separated, `env`-prefixed and non-EXIT-signal forms
 * (AP-EXT-ITER71-01, 8/8) ALL APPROVED for a worker while their byte-identical
 * bare twins blocked — shim-verified: the trap handler really execs git when
 * the shell exits.
 *
 * Bash's word-to-code constructs are a CLOSED set fixed by the language — the
 * `-c` operand of a shell, the arguments of a word-to-code builtin, and the
 * operand of a here-string (`hereStringPayload`) — which is why declaring them
 * is a grammar declaration (the AP-EXT-ITER66-01 move) and NOT the open-ended
 * carrier catalog the module keeps refusing. A pipeline's upstream hands the
 * shell the OUTPUT of a program (`… | sh`), which leaves no word to unwrap;
 * that fd-data family is a different class and stays open — see the
 * AP-EXT-ITER70-01 trap door's RESIDUAL.
 *
 * The anchor is the shared `execAnchorIndex`, so the builtin is located wherever
 * it sits (`env eval "git reset --hard"` and `env trap 'git stash' EXIT` both
 * block) and quoting cannot demote it — the same one uniform test
 * AP-EXT-ITER64-01 collapsed the git chain onto. The EARLIEST anchor wins so a
 * segment carrying both folds from its first word-to-code word. ALL following
 * tokens join with a space because that IS the builtins' contract: `eval`
 * concatenates its arguments before re-parsing, so `eval git reset` and
 * `eval "git reset"` are the same command and must fold to the same payload.
 * For `trap` the join also sweeps up the signal spec (`… EXIT`) and a leading
 * `--`, which is harmless: the detectors locate their verb wherever it sits, so
 * the extra words cost one scanned token, not a lost block.
 *
 * Over-reach is fail-safe in this module's established direction: a builtin name
 * standing in argument position (`grep eval file`) yields one extra benign
 * segment to scan, never a lost block.
 */
function wordToCodeBuiltinPayload(segment) {
    const tokens = tokenizeShellTokens(segment);
    let anchor = -1;
    for (const builtin of WORD_TO_CODE_BUILTINS) {
        const idx = execAnchorIndex(tokens, builtin);
        if (idx >= 0 && (anchor < 0 || idx < anchor))
            anchor = idx;
    }
    if (anchor < 0 || anchor === tokens.length - 1)
        return null;
    return tokens.slice(anchor + 1).map((token) => token.value).join(' ');
}
/**
 * A here-string redirection operator: `<<<`, optionally carrying the fd prefix
 * bash allows on every redirect (`0<<<`). Matched against a token's folded
 * VALUE, so the glued `<<<'<cmd>'` — one word to the tokenizer — is the same
 * operator as the spaced form.
 */
const HERE_STRING_OPERATOR_RE = /^\d*<<</;
/**
 * The word a here-string hands to the command's standard input, or null when
 * the segment carries no here-string.
 *
 * AP-EXT-ITER70-02. AP-EXT-ITER70-01 declared bash's word-to-code set as `-c`
 * plus `eval` and filed the rest as a fd family whose code "arrives as DATA on
 * stdin, never as a word". That boundary was drawn in the wrong place: a
 * here-string's operand IS a word standing on the command line — bash merely
 * spools it to fd 0 before the shell parses it — so it is recoverable by
 * exactly the unwrap the other two constructs already get. Measured against the
 * post-ITER70-01 shipped mirror: `bash <<< 'git reset --hard'`, its glued
 * `bash <<<'…'` and fd-prefixed `bash 0<<<'…'` twins, `sh <<<`, `bash -s <<<`,
 * `source /dev/stdin <<<` and `. /dev/stdin <<<` ALL APPROVED for a worker —
 * git verbs, the `install.sh` ban and the R-WSRC-3 state-write gate alike —
 * while every bare twin blocked (shim-verified: all six forms really exec git).
 * A here-DOCUMENT was never in the family: its body is separated by newlines,
 * which the segmenter already treats as a boundary, so it blocks today.
 *
 * The consumer is deliberately NOT tested. Asking "is the program reading this
 * stdin a shell?" is the positional/naming question `execAnchorIndex` and
 * `isShellWrapper` were each burned by — and here it needs a LIST, because
 * `source`, `.` and `/dev/stdin` are not shell-interpreter names at all. Bash's
 * ONE here-string operator is a closed grammar fact; the consumer set is not.
 * Over-reach is fail-safe in the module's established direction: `cat <<< foo`
 * yields one extra benign segment. Measured 2 new blocks over 6930 real worker
 * commands from 12 prior sessions, both of them reviewer probe scripts whose
 * TEXT contains `bash <<< 'git reset --hard'` — the same true-positive-in-prose
 * cost heredoc bodies already pay, and 50x cheaper than the reject-every-quoted-
 * word collapse ITER70-01 measured at +111.
 *
 * A quoted token can never be the operator: bash reads `"<<<x"` as data, the
 * same asymmetry `foldShellWord` documents for `>`.
 *
 * Making `<<<` a SHELL_SEGMENT_SEPARATORS member instead was rejected: it would
 * REPLACE the carrying segment's text rather than add to it, and every fix in
 * this module rests on the unwrap being monotone — no command that blocked
 * before can stop blocking now.
 */
function hereStringPayload(segment) {
    const tokens = tokenizeShellTokens(segment);
    for (let idx = 0; idx < tokens.length; idx++) {
        const token = tokens[idx];
        if (token.quoted || !HERE_STRING_OPERATOR_RE.test(token.value))
            continue;
        const glued = token.value.replace(HERE_STRING_OPERATOR_RE, '');
        return glued.length > 0 ? glued : (tokens[idx + 1]?.value ?? null);
    }
    return null;
}
/**
 * Appends each command-string payload's own segments after the segment that
 * carries it — the `-c` operand of a shell wrapper, the arguments of the `eval`
 * builtin, and the operand of a here-string. The carrying segment is KEPT
 * (fail-safe: never removes a segment a detector already saw), so `bash
 * install.sh` — which carries none of them — is untouched.
 */
function expandShellCommandStrings(segments, depth) {
    if (depth >= MAX_SHELL_COMMAND_STRING_DEPTH)
        return segments;
    const expanded = [];
    for (const segment of segments) {
        expanded.push(segment);
        for (const payload of [
            wordToCodeBuiltinPayload(segment),
            shellCommandStringPayload(segment),
            hereStringPayload(segment),
        ]) {
            if (payload !== null)
                expanded.push(...splitShellSegments(payload, depth + 1));
        }
    }
    return expanded;
}
