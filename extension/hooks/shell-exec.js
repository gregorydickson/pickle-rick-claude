/**
 * A REDIRECTION operator glued to the front of the word it redirects — an
 * optional fd number, a run of `<`/`>`, and at most one `&`/`|` modifier.
 *
 * Bash lexes a redirection operator as a token of its own however it is spaced,
 * so `bash <install.sh` runs the script exactly as `bash < install.sh` does
 * (shim-verified). This scanner splits on WHITESPACE, so the unspaced spelling
 * arrives as one word with the operator still on its head and `execName` folded
 * it to `<install.sh` — a name nothing matches (AP-EXT-ITER275-01).
 *
 * The CHARACTER GRAMMAR is declared, not the operator spellings: `<`, `>`, `>>`,
 * `<>`, `<&`, `>&` and `>|` are all runs of the same three character classes, so
 * there is no roster here to be one member short of — the shape this module has
 * paid for repeatedly. An `&`-led form (`&>file`) needs no entry: `&` is a
 * SEGMENT SEPARATOR, so `pushWordBoundaryTokens` has already split it off by the
 * time any word reaches the fold.
 *
 * A HEREDOC is excluded, and the exclusion is bash's own distinction rather than
 * a carve-out: every operator above takes a FILENAME operand, while `<<` takes a
 * DELIMITER word and `<<<` a STRING — neither names a file, so folding the
 * operand to a command name manufactures a name the shell never had. Measured,
 * not predicted: stripping `<<` too made `cat <<TEE <state file>` BLOCK for a
 * worker (approve at baseline), because the delimiter `TEE` folded onto the
 * `WRITE_COMMANDS` member standing beside a protected path — a blocked heredoc
 * artifact write stalls a ticket, the same reliability cost `patternNamesACommand`
 * and `execNamesIn` already refuse to pay. The lookahead costs nothing the fix
 * was for: every measured bypass spells a single `<`.
 *
 * THE FOLD IS THE HOME, not `SHELL_SEGMENT_SEPARATORS`, because a redirection is
 * not a new command — bash does not start one at `<`. Declaring it a separator
 * would sever a redirect from its destination, which is the precise failure
 * `normalizeRedirectOperators` runs BEFORE `splitShellSegments` to avoid
 * (AP-EXT-ITER19-02), and it would break Pass 1's `tokens[i + 1]` destination
 * read in `findWriteTargetInScope`.
 *
 * Strictly WIDENING, by construction: the run must begin with `<` or `>`, and no
 * name any detector holds — `install.sh`, `git`, `node`, the `WRITE_COMMANDS`
 * members — begins with either character, nor can a glob starting with one
 * expand onto a name that does not. So a token that folded to a matching name
 * before still folds to it, and the only fold this changes is one that matched
 * nothing. Quoting is deliberately not consulted, the AP-EXT-ITER64-01 uniform
 * reading: the measured bypasses include `bash <"install.sh"` and
 * `bash <'install.sh'`, where the operator is bare and the NAME is quoted.
 */
const REDIRECT_OPERATOR_PREFIX_RE = /^\d*(?:>>?|<(?!<)>?)[&|]?/;
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
 *
 * AP-EXT-ITER275-01 adds the fourth class, at the word's HEAD: a REDIRECTION
 * operator bash lexes as its own token, which this scanner leaves glued. The
 * fold already de-glues at the TAIL (a trailing `;`), and this is the same act
 * at the other end — see `REDIRECT_OPERATOR_PREFIX_RE` for why the fold is the
 * home rather than the separator set.
 */
export function execName(token) {
    if (!token)
        return '';
    const clean = token.replace(/;+$/, '').replace(REDIRECT_OPERATOR_PREFIX_RE, '');
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
 * The word parts split by whether bash EXPANDS inside them, for the readers
 * that must decide that — today `elideExpansions`. Both are built from the SAME
 * declared span constants as `WORD_PART_SOURCE`, so the grammar has one home
 * and a fifth quoting form cannot be declared in one reader and missed by the
 * other. Sticky, so a scan can ask "does a part begin HERE" without slicing.
 *
 * The split IS bash's rule, not a list: expansion happens inside a span opened
 * by `"` (`"…"`, `$"…"`) and never inside one opened by `'` (`'…'`, `$'…'`) nor
 * after a backslash. `UNQUOTED_ESCAPE` stays FIRST for the same reason it is
 * first in `WORD_PART_SOURCE` — `\"` must be an escaped literal quote before
 * any span pattern can read that `"` as a delimiter.
 *
 * AP-EXT-ITER188-01: `elideExpansions` shipped with a PRIVATE quote reader that
 * knew `'` and `\` and not `"`, so the apostrophe in `git commit -m "don't"` —
 * an ordinary literal to bash — opened a phantom span that ran to the next `'`
 * or, when there is none, to the END of the command. Every expansion after it
 * was copied verbatim and the AP-EXT-ITER187-01 reading was never taken at all.
 */
const LITERAL_PART_RE = new RegExp(`${UNQUOTED_ESCAPE}|${ANSI_C_QUOTED_SPAN}|${SINGLE_QUOTED_SPAN}`, 'y');
const EXPANDING_QUOTED_SPAN_RE = new RegExp(`${LOCALE_QUOTED_SPAN}|${DOUBLE_QUOTED_SPAN}`, 'y');
/** The sticky match at exactly `index`, or null when the pattern is not there. */
function matchAt(sticky, text, index) {
    sticky.lastIndex = index;
    const match = sticky.exec(text);
    return match === null ? null : match[0];
}
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
 * detector, because `shellCommandStringPayloads` is empty for a token this
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
 *
 * The tail is the shape's ONE declaration: the regex is built from it and so is
 * the witness fill below, so the two readings of the shape cannot drift.
 */
const SHELL_INTERPRETER_NAME_TAIL = 'sh';
/** Any lowercase letter satisfies the shape's head, so one stands for all. */
const SHELL_INTERPRETER_HEAD_FILL = 'a';
const SHELL_INTERPRETER_NAME_RE = new RegExp(`^[a-z]*${SHELL_INTERPRETER_NAME_TAIL}$`);
/**
 * One POSITION of a shell word: a wildcard construct, or a single character.
 *
 * A bracket expression and a brace alternation each stand for ONE position, the
 * same reading `shellPatternToRegex` emits for them (`[^/]`, one alternative).
 */
const SHELL_WORD_POSITION_RE = /\[[^\]]*\]|\{[^}]*\}|[\s\S]/g;
/**
 * The wildcards that stand for exactly ONE position, and so may be FILLED with
 * the character the shape wants there. `*` is deliberately absent: it absorbs an
 * arbitrary RUN, which names a short word by accident far more often than by
 * intent, and a shell name is three characters at its shortest.
 *
 * That is the `execNamesIn` bound, re-measured for this predicate on 10126 real
 * worker Bash commands: reading `*` as a fillable position turned markdown
 * emphasis inside a `cat > file <<EOF` artifact body (`**`, `**PASS**`, `/**`)
 * into a shell wrapper, and three worker artifact writes flipped from approve to
 * BLOCK through the install.sh arm — prose naming the deploy script now stood
 * "behind a wrapper". A blocked artifact write stalls a ticket, which is a
 * reliability cost, not a safety margin. With the bound: zero of 10126 flip, and
 * every measured `?` / bracket / brace bypass still blocks.
 *
 * A `*`-bearing word is left unfilled and simply fails the shape, so this needs
 * no arm of its own.
 */
const SINGLE_POSITION_WILDCARD_RE = /^(?:\?|\[[^\]]*\]|\{[^}]*\})$/;
/**
 * The one expansion of a folded word that decides whether ANY expansion of it
 * can name a shell: every pathname-expansion construct filled with the
 * character the shape wants at that position, every other character left as
 * bash reads it.
 *
 * One witness suffices because the shape constrains each position
 * INDEPENDENTLY — an ordinary lowercase run, then the fixed tail — so if the
 * best-case fill fails the shape, no expansion can pass it, and if it passes,
 * that expansion is a shell name. Requiring a witness rather than accepting any
 * wildcard is what keeps the literal characters load-bearing: `install.sh`
 * carries a dot no fill can move, and `pre-install.sh` a hyphen.
 *
 * Only a SINGLE-POSITION wildcard is filled (`SINGLE_POSITION_WILDCARD_RE`), so
 * a `*`-bearing word survives into the witness and fails the shape: `ba*` and
 * `*sh` stay unread. See the RESIDUAL on this pass's trap door.
 *
 * Quoting is not consulted, the same uniform reading `execNameIs` takes: bash
 * does not expand a quoted word, so `'ba?h'` is over-read as a wrapper here.
 * Over-reach is fail-safe in this predicate's direction — see below.
 *
 * `wantedAt` receives the position index and the position COUNT, and answers
 * with the character the caller's shape wants there. Every shape that must be
 * asked of a word bash will expand — the interpreter name below, `sed`'s
 * in-place flag in `config-protection.ts` — asks it through this ONE function,
 * so the reading of "which construct stands for one position, and may be
 * filled" has a single definition and cannot fork per caller.
 */
export function shellWordWitness(folded, wantedAt) {
    const positions = folded.match(SHELL_WORD_POSITION_RE) ?? [];
    return positions
        .map((position, idx) => (SINGLE_POSITION_WILDCARD_RE.test(position) ? wantedAt(idx, positions.length) : position))
        .join('');
}
function shellShapeWitness(folded) {
    return shellWordWitness(folded, (idx, positions) => {
        const head = positions - SHELL_INTERPRETER_NAME_TAIL.length;
        return idx < head ? SHELL_INTERPRETER_HEAD_FILL : SHELL_INTERPRETER_NAME_TAIL[idx - head];
    });
}
/**
 * True when the token is a shell wrapper to be skipped before the real exec.
 *
 * The shape is asked of the WITNESS, not of the raw fold, because bash EXPANDS
 * the command word: `/bin/ba?h -c '<cmd>'` really execs bash (shim-verified)
 * while the fold `ba?h` matches no regex over letters, so the payload stayed ONE
 * opaque token and every detector saw only the wrapper — the AP-EXT-ITER63-06
 * blast radius, reached through the AP-EXT-ITER73-01 seam (expansion is not
 * quoting, so the fold cannot undo it and the TEST has to). ONE uniform test,
 * not a literal arm plus a pattern arm: a word with no wildcards is its own
 * witness.
 */
export function isShellWrapper(token) {
    return SHELL_INTERPRETER_NAME_RE.test(shellShapeWitness(execName(token)));
}
/**
 * The POSIX special builtins that make the CURRENT shell read and execute a
 * file named in their arguments — `.` and its bash spelling `source`. Named
 * rather than shaped because the shell spells them as punctuation and one
 * reserved word, not as a `*sh` program name, and POSIX CLOSES the set: the
 * grammar production has exactly these two spellings, so this is not a roster
 * one member from the next bypass.
 */
const DOT_SOURCE_BUILTINS = ['.', 'source'];
/**
 * True when the token is a command word that hands the word after it to a shell
 * to be EXECUTED — a `*sh` interpreter (`isShellWrapper`) or a dot-source
 * builtin. The prelude's optional-interpreter arm asks THIS, not the interpreter
 * shape alone: `source install.sh` and `. ./install.sh` really run the script
 * (shim-verified) while standing at no interpreter name at all.
 *
 * POSITIONAL by construction, and that is what keeps it from over-blocking. `.`
 * is also the ordinary current-directory operand, so a token-anywhere read of it
 * would block `find . -name install.sh`; the shell only takes `.` as the builtin
 * when it stands at the command word, which is exactly where this is asked.
 */
function execsScriptArgument(token) {
    return isShellWrapper(token) || DOT_SOURCE_BUILTINS.includes(execName(token));
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
 * script-running command word (`execsScriptArgument`) → env assignments. Returns
 * the index of the token the shell will actually exec.
 *
 * AP-EXT-ITER274-01: that middle arm asked for an interpreter NAME shape, which
 * is not the question — the question is whether the command word runs the word
 * behind it. The dot-source builtins do, and answered no, so every spelling of
 * `source install.sh` / `. ./install.sh` stood at its own exec token and the
 * R-WSRC deploy-script ban read the builtin as the executable. Widening this ONE
 * arm rather than adding a second anchor keeps the prelude's single definition:
 * a caller that re-asks "is this an interpreter" separately is the drift the
 * paragraph below already names.
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
    const afterWrapper = execsScriptArgument(tokens[afterEnv]) ? afterEnv + 1 : afterEnv;
    return skipEnvAssignments(tokens, afterWrapper);
}
/**
 * The characters bash reads as PATHNAME-EXPANSION syntax in an unquoted word.
 */
export const SHELL_PATTERN_CHARS = /[*?[\]{}]/;
export function shellPatternToRegex(pattern) {
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '*') {
            // A RUN of stars is ONE `*` to bash — pathname expansion has no globstar,
            // so `**foo` and `*foo` expand identically — and `.*.*` is the same
            // LANGUAGE as `.*`. Only the collapsed form is TRACTABLE: on a FAILING
            // match the engine tries every way to split the subject across the runs,
            // so cost is combinatorial in the run length. Measured on the shipped
            // handler against the four protected basenames: 8 stars 70ms, 12 stars
            // 11.9s, 14 stars 54.8s end-to-end, 16 stars 424s (AP-EXT-ITER97-01).
            // AP-EXT-ITER5-01 closed the door where this translator emits an INVALID
            // regex and the guard fails OPEN through the entrypoint catch; a regex
            // that never RETURNS is the same fail-open by a slower door, and it also
            // stalls the run for the whole hook timeout. Collapsing here rather than
            // pre-passing the whole pattern keeps brace and bracket BODIES untouched:
            // those arms slice their body out before it reaches this one, where a `*`
            // is escaped as a literal character rather than read as a wildcard.
            while (pattern[i + 1] === '*')
                i++;
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
        // A bracket expression matches EXACTLY ONE character, so a single-character
        // wildcard answers the only question asked here ("could this glob name a
        // protected config file?") without reproducing the class body at all.
        // Reproducing it was the SOLE way this translator could emit an INVALID
        // regex: every other arm escapes into provably-constructible output, but a
        // copied class body carries whatever range the token happened to contain,
        // and this repo's own log tags are full of descending ones — `[anatomy-park]`
        // is `y-p`, `[mux-runner]` is `x-r`. `new RegExp` throws `Range out of
        // order`, the SyntaxError unwinds out of `main()` into the entrypoint catch,
        // and that catch calls `approve()` — the config gate fails OPEN over a
        // command it never finished inspecting. Measured across 8925 real worker
        // Bash commands from the live session logs, 6 (0.07%) crashed the shipped
        // guard this way. The wildcard needs no escaping, is always constructible,
        // and errs toward over-block — this module's established direction.
        if (char === '[') {
            const end = pattern.indexOf(']', i + 1);
            if (end > i + 1) {
                regex += '[^/]';
                i = end;
                continue;
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
/**
 * A pattern that is nothing but wildcards names EVERY command equally well, so it
 * names none: `*`, `**`, `???` and `[A-Za-z_$][w$]*` all match `git`, `node` and
 * `install.sh` alike while saying nothing about which one the shell would exec.
 * Requiring one character bash reads LITERALLY is what keeps the pattern read an
 * identification rather than a wildcard that anchors on everything.
 *
 * Measured on 8778 real worker Bash commands from the live session logs: without
 * this, the pattern read raised the config guard's block count on the
 * glob-bearing 3815 from 94 to 217, and 519 of the anchoring tokens were the bare
 * `*` inside a heredoc body. Over-block is this module's direction, but a guard
 * that blocks a worker's `cat > file <<EOF` is a reliability cost paid in stalled
 * runs, not a safety margin.
 *
 * A bracket expression contributes no literal: `shellPatternToRegex` emits the
 * fixed `[^/]` for it (AP-EXT-ITER5-01 — a copied class body throws and the guard
 * fails OPEN), so its body is not read as characters here either. RESIDUAL,
 * recorded rather than claimed closed: an all-bracket spelling (`/usr/bin/[g][i][t]`)
 * therefore reads as unnamed and approves.
 *
 * EXPORTED because the bound is not command-word-specific: it is the tautology
 * test for any read that asks a SET of names "which of you does this word name?".
 * `isProtectedShellPattern` asks that of 39 config filenames and had no bound at
 * all, so a bare `*` named every one of them (AP-EXT-ITER232-01). Sharing the
 * declaration is what keeps the two domains from re-forking the same measurement.
 */
export function patternNamesACommand(pattern) {
    return /[^*?]/.test(pattern.replace(/\[[^\]]*\]/g, ''));
}
/**
 * True when the shell word `token` names the command `name` — literally, or as a
 * PATTERN bash expands to it.
 *
 * Expansion is not quoting, so the FOLD cannot answer this and the COMPARISON has
 * to. Bash applies pathname expansion to the command word like any other word, so
 * `/usr/bin/gi?` really execs git and `bash instal?.sh` really runs the deploy
 * script (both shim-verified), while `execName` folds them to `gi?` / `instal?.sh`
 * and every `=== name` compare missed. Reading the word as the pattern it IS needs
 * no table of expandable spellings.
 *
 * ONE translator, not a private copy: `isProtectedShellPattern` already asks this
 * exact question of a write DESTINATION ("could this glob name a protected
 * file?"), which is why `shellPatternToRegex` moved here rather than being
 * re-inlined beside the exec seam — the drift shape this module has collapsed
 * repeatedly.
 *
 * Fail direction: a pattern that CAN expand to the name counts AS the name, so an
 * argument glob that happens to match one over-blocks, never under-blocks — this
 * module's established direction.
 */
export function execNameIs(token, name) {
    const folded = execName(token);
    if (folded === name)
        return true;
    if (!patternNamesACommand(folded))
        return false;
    return wordExpandsTo(folded, name);
}
/**
 * True when the shell word `word` may pathname-expand onto `name` — literally,
 * or as a pattern bash expands to it. NO domain bound: this is the expansion
 * READ alone.
 *
 * The one shared answer to "could bash turn this word into that name?", which
 * three domains ask with three different measured bounds layered on top:
 * `execNameIs` adds `patternNamesACommand` (a command word must spell one
 * literal char, or `*` inside a heredoc names every command), the state-file arm
 * adds literal COVERAGE (AP-EXT-ITER96-01), and the runtime-root path read adds
 * NOTHING — a wildcard path component really does expand onto the directory it
 * sits beside (AP-EXT-ITER96-02). Each bound was measured in ITS domain; the
 * expansion read underneath them is the same question and lives here once, so a
 * domain cannot re-fork the translator while borrowing another domain's bound.
 */
export function wordExpandsTo(word, name) {
    if (word === name)
        return true;
    if (!SHELL_PATTERN_CHARS.test(word))
        return false;
    return shellPatternToRegex(word).test(name);
}
/**
 * Every member of `names` the shell word `token` may exec as.
 *
 * A SET read, not a loop of `execNameIs` — because asking twelve short names at
 * once is a different question from asking one, and it needs one bound more.
 * `*` is the only construct that absorbs an arbitrary RUN of characters, so a
 * word carrying one names a short member by accident far more often than by
 * intent: measured over 10122 real worker Bash commands, `**No` / `*no` /
 * `s**` / `v*` — markdown emphasis inside a `cat > file <<EOF` artifact body —
 * name `nano`, `sed` and `vi`, and 21 worker artifact writes flipped from
 * approve to BLOCK. A blocked artifact write stalls a ticket, which is the
 * reliability cost `patternNamesACommand` already refuses to pay for the bare
 * `*` inside a heredoc.
 *
 * So a pattern is read here only when every wildcard consumes exactly ONE
 * position (`?`, a bracket expression, a brace alternation) — the word still
 * SPELLS the member, obfuscated, which is what a bypass is, rather than merely
 * matching it. That keeps all ten measured bypasses blocked (`/usr/bin/t?e`,
 * `/bin/c?`, `/bin/m?`, `/usr/bin/s?d -i`, `te?`, `vi?`, `per?`, `rsyn?`,
 * `{t,q}ee`, `[t]ee`) and costs zero of the 21.
 *
 * The bound is NOT pushed down into `execNameIs`: that reads ONE name, where a
 * `*` is affordable and load-bearing (`gi*` really does exec git), and widening
 * this rule to there would under-block the git seam to buy nothing.
 *
 * RESIDUAL, recorded rather than claimed closed: an eliding spelling of a write
 * command (`t*e`, `s*d`, `c*`) reads as unnamed here and approves.
 */
export function execNamesIn(token, names) {
    const folded = execName(token);
    const literal = names.filter((name) => folded === name);
    if (literal.length > 0 || folded.includes('*'))
        return literal;
    return names.filter((name) => execNameIs(token, name));
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
 * ONE uniform test — `execNameIs(value, name)` — and deliberately NO quoting
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
 * `findWriteTargetInScope`'s Pass 2 over `WRITE_COMMANDS` had the identical
 * exception and AP-EXT-ITER64-02 applied the identical collapse to it
 * (2026-08-26): that pass, too, is now one uniform read over every token,
 * reading no exec index and no quoting flag — and AP-EXT-ITER73-02 then routed
 * it through this same `execNameIs`, so both anchors ask bash's question rather
 * than a spelling's. Pass 1's `>`/`>>` REDIRECT anchor keeps its UNQUOTED test,
 * because quoting really does turn a redirect operator back into data
 * (AP-EXT-ITER51-01). The two anchors are asymmetric; only the EXEC one is safe
 * to make quoting-blind, and collapsing both would re-open ITER51-01.
 *
 * Do not restate either collapse as still-pending here. This paragraph asserted
 * the opposite — that Pass 2 still carried the quoting-plus-exec-index arm and
 * was unsafe — for a full pass AFTER ITER64-02 landed, and a fixer acting on it
 * re-adds the arm that mutation-tests at 19 RED (AP-EXT-ITER74-01). Nor may the
 * deleted arm be QUOTED here to say it is gone: this module is graded by token
 * greps, and a backticked corpse reads exactly like a live reference. A claim
 * about a SIBLING module's state belongs in that module, beside the code that
 * can falsify it.
 *
 * Over-reach is fail-safe in this module's established direction: a bare `git`
 * argument to some other program (`echo git reset`, quoted or not) anchors and
 * may over-block, while every prefixed form under-blocked before. Over-block,
 * never under-block.
 */
export function execAnchorIndex(tokens, name) {
    for (let i = 0; i < tokens.length; i++) {
        if (execNameIs(tokens[i].value, name))
            return i;
    }
    return -1;
}
/**
 * git's `alias.<name>` config namespace: a config section whose VALUE git
 * executes as a command, wherever that assignment is written.
 *
 * NOT the only one, and the correction is measured rather than suspected
 * (AP-EXT-ITER281-02): `git -c diff.external='sh -c "git reset --hard"'
 * diff HEAD~1 HEAD` really destroyed a worker's staged and unstaged work in a
 * scratch repo while this predicate read nothing and the guard APPROVED it. The
 * executing namespaces are a SET (`diff.external` confirmed; `core.pager`,
 * `core.editor`, `credential.helper`, `core.sshCommand`,
 * `uploadpack.packObjectsHook` all approve, execution unconfirmed under the
 * spellings probed), so a predicate naming ONE member is one member short by
 * construction — the enumerated-set shape this subsystem has paid for
 * repeatedly. Recorded OPEN on fix SHAPE: the landable direction is to key on
 * the `-c`/`--config-env`/`GIT_CONFIG_KEY_*` CONFIG SURFACE rather than on any
 * namespace roster, which is one predicate instead of a list that rots.
 *
 * Read over the WHOLE segment's tokens, not the argument list after the anchor,
 * because git accepts the assignment in four places and only one of them is a
 * bare argument: `-c alias.zap='reset --hard'`, `--config-env=alias.zap=V`,
 * `git config alias.zap 'reset --hard'`, and `GIT_CONFIG_KEY_0=alias.zap` in the
 * environment — which stands BEFORE the anchor, so an argument-list scan cannot
 * see it. Keying on the namespace rather than on where it was written is what
 * makes that four-way surface one predicate instead of an option table.
 *
 * The leading boundary excludes a longer identifier ending in `alias`, so
 * `myalias.zap` does not match.
 *
 * HOME IS THIS MODULE, beside `execName`, for that fold's own recorded reason
 * (AP-EXT-ITER281-01): git's expansion of the verb word is a question BOTH
 * git-anchor readers must ask, and the two detectors had already re-forked on it
 * exactly as they once forked on case — config-protection read the namespace
 * while tsc-gate read the verb's spelling, so an aliased commit blocked as a git
 * verb and classified NON-commit, skipping the R-WACT tsc gate. ONE home so they
 * cannot re-fork a second time.
 */
const GIT_ALIAS_CONFIG_KEY_RE = /(?:^|[^A-Za-z0-9_.])alias\.[A-Za-z0-9_-]+/;
export function segmentDefinesGitAlias(tokens) {
    return tokens.some(token => GIT_ALIAS_CONFIG_KEY_RE.test(token.value));
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
 *
 * AP-EXT-ITER187-01 CORRECTS the second half of that claim. It holds only while
 * the `$(` STANDS ALONE. Glued to a word it leaves the `$` behind ON that word —
 * `git reset$(true) --hard` segments to `git reset$`, and `reset$` is the
 * executable token no detector matches, so all six prohibited verbs approved.
 * The residue is not removable here (a lone `$` really is inert, and `(` must
 * stay a boundary for the grouped form ITER19-01 closed); it is answered one
 * level up, by `elideExpansions` reading the command a second time with every
 * expansion contributing the empty string.
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
 *
 * `{` and `}` are excluded too, and for bash's own reason: they are reserved
 * WORDS, not metacharacters. Bash recognizes them only when they stand as a
 * whole word — `{git status;}` is a SYNTAX ERROR, not a group (verified), while
 * `{ git status;}` runs, because the opener must be blank-delimited. Splitting
 * them out of a glued word therefore models a construct bash does not have, and
 * it DESTROYS the one bash does: a BRACE EXPANSION (`git {reset,--hard}`) is a
 * single word until `expandBraceWord` expands it. A standalone `{`/`}` is still
 * a boundary — it reaches the segment loop as its own token, which tests
 * `SHELL_SEGMENT_SEPARATORS` directly — so `{ git reset --hard; }` is unchanged.
 */
const GLUED_SEPARATOR_RE = new RegExp(`(${[...SHELL_SEGMENT_SEPARATORS]
    .filter((op) => op !== '\n' && op !== '{' && op !== '}')
    .map((op) => op.replace(/[|\\^$*+?.()[\]{}]/g, '\\$&'))
    .join('|')})`);
/**
 * Bounded so a pathological `bash -c "bash -c ..."` nest cannot spin the hook;
 * three levels is far past any real worker command.
 */
const MAX_SHELL_COMMAND_STRING_DEPTH = 3;
/** The character a bash option cluster must carry to be the command-string flag. */
const SHELL_COMMAND_STRING_FLAG_CHAR = 'c';
/**
 * `-c`, and the combined forms a login/exec shell takes (`-lc`, `-ec`, `-xc`).
 * ONE declaration — the regex is BUILT from the character the witness fills
 * with, so the two readings cannot drift.
 */
const SHELL_COMMAND_STRING_FLAG_RE = new RegExp(`^-[A-Za-z]*${SHELL_COMMAND_STRING_FLAG_CHAR}`);
/**
 * True when the token is the flag that turns the next words into a command
 * STRING.
 *
 * Asked of a WITNESS (`shellWordWitness`), not of the raw token, because bash
 * pathname-expands an option word like any other: with a file named `-c` in
 * cwd, `bash -? '<cmd>'` really runs the payload (shim-verified 2026-08-29 on
 * this box), while a literal shape test saw `-?`, matched nothing, and left the
 * payload as ONE opaque token — the AP-EXT-ITER63-06 blast radius, hiding the
 * whole command string from the git-verb chain, the `install.sh` ban and both
 * R-WSRC-3 write gates at once. Same expansion-is-not-quoting seam
 * `isShellWrapper` and `isInPlaceFlag` already pass through; this is the last
 * expansion-blind SHAPE test on a shell word in this module.
 *
 * The fill is the flag's own character at EVERY position, the `isInPlaceFlag`
 * cluster arm's shape: `-c` is a single-dash cluster, so the flag character may
 * sit anywhere past the dash (`-lc`, `-xc`). The leading `-` is a literal no
 * fill can move, which is what keeps a positional wildcard-bearing FILE
 * argument from reading as a flag.
 */
function isShellCommandStringFlag(token) {
    return SHELL_COMMAND_STRING_FLAG_RE.test(shellWordWitness(token ?? '', () => SHELL_COMMAND_STRING_FLAG_CHAR));
}
/**
 * Bash's brace SEQUENCE form: `{X..Y}` / `{X..Y..N}` over integers or single
 * letters. It is the same grammar production as the comma list, not a second
 * feature — and it is just as exploitable: `git {r..r}eset --hard` really
 * hard-resets (shim-verified). Zero-padding (`{01..03}`, bash 4+) is
 * deliberately not reproduced: a digit cannot spell a gated verb or flag, so
 * the padding cannot change any detector's answer.
 */
const BRACE_SEQUENCE_RE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/;
/**
 * Bounds the expansion so a pathological word cannot spin the hook. Counts
 * RECURSION STEPS, not output words, so it bounds breadth AND depth with one
 * number. On overflow the word is left UNEXPANDED — today's behavior, so an
 * overflow can never lose a block that a non-expanding scanner already had.
 */
const BRACE_EXPANSION_STEP_CAP = 4096;
/**
 * Which positions of `word` are syntactically inert — inside a quoted span or
 * behind a backslash. Bash does not expand braces there (`"{a,b}"` and
 * `\{a,b\}` are literal, verified), so the brace scan must skip them, and it
 * decides that with the SAME `unquoteSpan`/`unquotedEscapeChar` parsers the
 * fold and the boundary splitter use — a second notion of "is this quoted"
 * is the drift AP-EXT-ITER66-01 collapsed one level down.
 */
function braceInertMask(word) {
    const inert = new Array(word.length).fill(false);
    let at = 0;
    for (const part of word.match(WORD_PART_RE) ?? []) {
        if (unquoteSpan(part) !== null || unquotedEscapeChar(part) !== null) {
            for (let k = 0; k < part.length; k++)
                inert[at + k] = true;
        }
        at += part.length;
    }
    return inert;
}
/** The words `{X..Y}` produces, or null when the body is not a sequence. */
function braceSequenceWords(body) {
    const m = BRACE_SEQUENCE_RE.exec(body);
    if (!m)
        return null;
    const [, loDigits, hiDigits, loChar, hiChar, rawStep] = m;
    const numeric = loDigits !== undefined;
    const lo = numeric ? Number(loDigits) : loChar.charCodeAt(0);
    const hi = numeric ? Number(hiDigits) : hiChar.charCodeAt(0);
    const magnitude = Math.abs(rawStep === undefined ? 1 : Number(rawStep)) || 1;
    const step = lo <= hi ? magnitude : -magnitude;
    const words = [];
    for (let v = lo; step > 0 ? v <= hi : v >= hi; v += step) {
        words.push(numeric ? String(v) : String.fromCharCode(v));
        if (words.length > BRACE_EXPANSION_STEP_CAP)
            return null;
    }
    return words;
}
/** The leftmost brace group that actually expands, with its alternatives. */
function findBraceGroup(word) {
    const inert = braceInertMask(word);
    for (let open = 0; open < word.length; open++) {
        if (word[open] !== '{' || inert[open])
            continue;
        let depth = 1;
        const commas = [];
        for (let i = open + 1; i < word.length && depth > 0; i++) {
            if (inert[i])
                continue;
            const ch = word[i];
            if (ch === '{')
                depth++;
            else if (ch === ',' && depth === 1)
                commas.push(i);
            else if (ch === '}' && --depth === 0) {
                const alts = commas.length > 0
                    ? sliceBraceAlternatives(word, open, i, commas)
                    : braceSequenceWords(word.slice(open + 1, i));
                // A group with no comma and no range (`{a}`, `{}`) is LITERAL to bash;
                // keep scanning — a later `{` may still be a real expansion.
                if (alts)
                    return { open, close: i, alts };
            }
        }
    }
    return null;
}
/** Split a comma-list body at its top-level commas. */
function sliceBraceAlternatives(word, open, close, commas) {
    const alts = [];
    let start = open + 1;
    for (const comma of commas) {
        alts.push(word.slice(start, comma));
        start = comma + 1;
    }
    alts.push(word.slice(start, close));
    return alts;
}
/** Depth-first expansion in bash's own order; false once the budget is spent. */
function expandBraceInto(word, out, budget) {
    if (--budget.left < 0)
        return false;
    const group = word.includes('{') ? findBraceGroup(word) : null;
    if (!group) {
        out.push(word);
        return true;
    }
    const prefix = word.slice(0, group.open);
    const suffix = word.slice(group.close + 1);
    for (const alt of group.alts) {
        if (!expandBraceInto(prefix + alt + suffix, out, budget))
            return false;
    }
    return true;
}
/**
 * The words bash's BRACE EXPANSION produces from one word — `git
 * {reset,--hard}` really runs `git reset --hard` (shim-verified: staged work
 * destroyed), and `git commit --{amend,amend}` really amends.
 *
 * This is word EXPANSION, not segmentation, and that distinction is the whole
 * fix: `{` and `}` are bash RESERVED WORDS, recognized only when they stand as
 * a whole word (`{git status;}` is a syntax error, `{ git status;}` runs), so
 * splitting a glued brace out as a boundary modeled a construct bash does not
 * have while destroying the one it does. The verb and every flag were shredded
 * across segments before any detector ran.
 *
 * An unquoted EMPTY word is dropped, as bash drops it (`git {stash,}` passes
 * git exactly one argument). Unlike every pathname-expansion sibling in this
 * family, this needs NO crafted filename — bash expands braces
 * unconditionally — so it is strictly the cheapest bypass of the group.
 */
function expandBraceWord(word) {
    if (!word.includes('{'))
        return [word];
    const out = [];
    if (!expandBraceInto(word, out, { left: BRACE_EXPANSION_STEP_CAP }))
        return [word];
    return out.filter((w) => w.length > 0);
}
/**
 * A character bash allows in a parameter NAME. Everything else inside a `${…}`
 * body is expansion PUNCTUATION.
 */
const PARAMETER_NAME_CHAR_RE = /[A-Za-z0-9_]/;
/**
 * AP-EXT-ITER143-01: `${x:-git}` is not `$VAR` indirection — the word bash
 * substitutes is WRITTEN IN THE COMMAND. Every one of bash's word-carrying
 * parameter expansions (default, assign-default, alternate, error, prefix and
 * suffix removal, replacement) places that word after a run of expansion
 * punctuation, so the word is recovered by reading PAST punctuation and never
 * by naming an operator — the enumerated-declaration shape this module has paid
 * for fifteen times. Every body offset that begins a name run is therefore
 * offered as a candidate word; the real one is always among them.
 *
 * The candidates are extra TOKENS, not a substitution into the word: every
 * detector reads its anchor position-free (`execAnchorIndex`, `findGitVerb`,
 * `findWriteTargetInScope` Pass 2), so a bare `git` in the segment answers the
 * question `/usr/bin/${x:-git}` asks, and gluing (`${x:-git}reset`) can only
 * over-block — this module's established direction.
 *
 * BOUNDED by the same budget brace expansion carries, and spent in CHARACTERS
 * rather than candidates: a candidate is nearly as long as the body it comes
 * from, so counting candidates alone is quadratic in the word — measured, a
 * padded 20 KB body cost 3035 ms against the pre-fix 9 ms, and a 40 KB one
 * drove `shellPatternToRegex` past the engine's regex-size limit, whose
 * SyntaxError unwinds into `dispatch.ts`'s catch and APPROVES the whole command
 * (the AP-EXT-ITER5-01 / ITER66-02 fail-open door). Charging each candidate its
 * length keeps the emitted text linear in the budget. On overflow the surviving
 * candidates stand; nothing is ever REMOVED, so an overflow cannot lose a block
 * a non-expanding scanner had.
 *
 * RESIDUAL, recorded rather than claimed closed: a value-carrying `$NAME` /
 * `${NAME}` (`G=git; $G reset --hard`) stays open. That word spells nothing —
 * recovering it needs assignment tracking, not a grammar read — and it remains
 * the accepted limit the `WRITE_COMMANDS is a speed bump` entry records.
 */
function parameterExpansionWords(word) {
    const out = [];
    let budget = BRACE_EXPANSION_STEP_CAP;
    for (let i = 0; i + 1 < word.length; i++) {
        if (word[i] !== '$' || word[i + 1] !== '{')
            continue;
        const close = word.indexOf('}', i + 2);
        const body = word.slice(i + 2, close === -1 ? word.length : close);
        for (let k = 0; k < body.length; k++) {
            if (k > 0 && PARAMETER_NAME_CHAR_RE.test(body[k - 1]))
                continue;
            budget -= body.length - k;
            if (budget < 0)
                return out;
            out.push(body.slice(k));
        }
        if (close !== -1)
            i = close;
    }
    return out;
}
/**
 * THE word-expansion seam: every word bash may produce from one word, in bash's
 * own order — brace expansion first, then the literal words a parameter
 * expansion may substitute into each result.
 *
 * ONE home, for the reason `execName` and `splitShellSegments` have one: a
 * second expansion taught to half the module is the fork AP-EXT-ITER12-01 and
 * AP-EXT-ITER66-01 each collapsed.
 *
 * NOT strictly widening, contrary to what this docblock claimed until
 * AP-EXT-ITER262-01 measured it: the parameter arm keeps the original word, but
 * `expandBraceWord` REPLACES an alternation with its alternatives and drops the
 * empty ones, so `{a,b}x` returns neither `{a,b}x` nor, for `{,}`, anything at
 * all — 1890 of 790,777 tokens over the live worker corpus. Callers that must
 * not lose a probe name the original word themselves; `pushWordBoundaryTokens`
 * does not, because a token bash will never produce is not a token the segment
 * should carry.
 *
 * EXPORTED for the second slot that reads a single WORD rather than a whole
 * scope: `findWriteTargetInScope`'s redirect destination (AP-EXT-ITER262-01).
 * The flush below widens a word into sibling TOKENS, which every whole-scope
 * read reaches and a single-token adjacency read does not, so the destination
 * slot asks this seam directly instead of growing its own expansion.
 */
export function expandWord(word) {
    const braced = expandBraceWord(word);
    if (!word.includes('${'))
        return braced;
    return braced.flatMap((w) => [w, ...parameterExpansionWords(w)]);
}
/**
 * ONE definition of where bash breaks a whitespace-delimited WORD internally,
 * read by everything that needs those boundaries (AP-EXT-ITER278-01).
 *
 * The pieces PARTITION the word — `pieces.map((p) => p.text).join('') === word`
 * — so a caller that must rebuild the text it walked can, and a caller that only
 * wants the tokens can drop the separators. That property is what lets
 * `inlineAssignedValues` render and record in the same left-to-right walk
 * `pushWordBoundaryTokens` uses to tokenize, so the two cannot disagree about
 * where one command in a glued word ends and the next begins.
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
function splitWordAtGluedSeparators(word) {
    const pieces = [];
    let buffer = '';
    const flush = () => {
        if (buffer.length > 0)
            pieces.push({ text: buffer, separator: false });
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
                pieces.push({ text: piece, separator: true });
                continue;
            }
            buffer += piece;
        }
    }
    flush();
    return pieces;
}
/**
 * Split ONE bash word into boundary tokens, keeping its parts glued.
 *
 * The boundaries are `splitWordAtGluedSeparators`' — see there for why a quoted
 * part can never be one. This adds only the EXPANSION every non-operator piece
 * gets, which is what makes the result tokens rather than text.
 */
function pushWordBoundaryTokens(word, tokens) {
    for (const piece of splitWordAtGluedSeparators(word)) {
        // A non-separator piece is one complete bash WORD — operators already ended
        // it — which is exactly where bash applies its word expansions, so that is
        // where they go (`expandWord`: brace expansion, then parameter expansion).
        if (piece.separator)
            tokens.push(piece.text);
        else
            tokens.push(...expandWord(piece.text));
    }
}
/**
 * Index just past the balanced `open`/`close` pair beginning at `text[start]`,
 * or `text.length` when it never closes. Depth-counted so a nested substitution
 * (`$(git $(id) reset)`) or a nested parameter expansion (`${a:-${b}}`) ends at
 * ITS OWN close, not at the first one.
 */
function balancedSpanEnd(text, start, open, close) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === open)
            depth++;
        else if (text[i] === close && --depth === 0)
            return i + 1;
    }
    return text.length;
}
/**
 * Index just past the EXPANSION beginning at `text[start]`, or -1 when none
 * begins there.
 *
 * Read as bash's grammar, not as a catalog of expansion names: a `$` takes a
 * braced body, a parenthesised body, a parameter-name run, or — failing all
 * three — the single character that names a special parameter (`$?`, `$@`,
 * `$*`, `$$`, `$!`, `$-`). Spelling those out would be the enumerated-set shape
 * this module has paid for repeatedly; asking what FOLLOWS the `$` needs no
 * list and cannot omit a member. `$'…'` and `$"…"` are excluded because they
 * are QUOTING constructs, not expansions — the tokenizer already decodes them
 * (`ANSI_C_QUOTED_SPAN`, `LOCALE_QUOTED_SPAN`), and consuming their opening
 * quote here would leave an unbalanced one behind.
 *
 * A `$` that names nothing — at end of input, or before whitespace — is a
 * LITERAL dollar to bash (`git reset$ --hard` really runs the subcommand
 * `reset$`), so it is not an expansion and is refused. That refusal is the one
 * that matters: whitespace is the only character whose removal could JOIN two
 * words, and joining them would manufacture a gated verb out of two words bash
 * keeps apart (`git rese$ t --hard`).
 */
function expansionSpanEnd(text, start) {
    const ch = text[start];
    if (ch === '`') {
        const close = text.indexOf('`', start + 1);
        return close === -1 ? text.length : close + 1;
    }
    if (ch !== '$')
        return -1;
    const next = text[start + 1];
    if (next === undefined || /\s/.test(next))
        return -1;
    if (next === '\'' || next === '"')
        return -1;
    if (next === '{')
        return balancedSpanEnd(text, start + 1, '{', '}');
    if (next === '(')
        return balancedSpanEnd(text, start + 1, '(', ')');
    if (!PARAMETER_NAME_CHAR_RE.test(next))
        return start + 2;
    let i = start + 1;
    while (i < text.length && PARAMETER_NAME_CHAR_RE.test(text[i]))
        i++;
    return i;
}
/**
 * THE expansion walk: the reading of `command` in which every expansion span
 * contributes whatever `render` answers for it.
 *
 * ONE walk for every reading the segmenter takes, because they differ in that
 * answer and in NOTHING else — a second copy is the fork `execName` and
 * `splitShellSegments` each already collapsed. A new reading is a new `render`
 * argument and nothing else; the walk itself never grows a case. The renderings
 * are `elideExpansions` (the empty string), `inlineSubstitutionOutput` (a
 * command substitution's operands) and `inlineParameterExpansionBody` (a
 * parameter expansion's body); each has its own docblock below.
 *
 * AP-EXT-ITER187-01, the reading that made the walk exist: EVERY expansion
 * contributes the EMPTY string.
 *
 * An expansion GLUED to a literal is a word bash may produce two ways, and only
 * one of them was ever read. `$(true)`, `` `true` ``, `$UNSET` and `${UNSET}`
 * all expand to nothing, so `git reset$(true) --hard`, `git re$(true)set --hard`
 * and `git reset$EMPTY --hard` are the commands `git reset --hard` — measured in
 * a scratch repo, the staged file was really destroyed — yet the shipped
 * handler APPROVED all of them for a worker: 36 of 36 glued forms across all six
 * `PROHIBITED_GIT_VERBS_SIMPLE` verbs, plus `--amend`/`--prune`, while the bare
 * twins blocked. The two halves fail for one reason but by different routes:
 * `$(`/`` ` `` are SEGMENT SEPARATORS, so the split ran through the middle of
 * the word and left `reset$` (or an orphan `set`) behind, while `$NAME` is no
 * separator at all and simply stayed glued.
 *
 * Elision is therefore taken on the RAW command, before any splitting — one
 * uniform additional reading, the same widening `expandShellCommandStrings`
 * already applies to a `-c` payload and `expandWord` to a brace list. It needs
 * no table of which expansions can be empty, because at the scanner's remove
 * every expansion can. QUOTING is honoured by asking the ONE declared word-part
 * grammar which parts bash expands (`partExpands`) rather than re-reading the
 * quotes here — the private re-read is what AP-EXT-ITER188-01 removed, after a
 * literal apostrophe inside `"…"` suppressed this whole reading. A
 * single-quoted `-c` payload is still elided one level down, where
 * `splitShellSegments` sees it unquoted.
 *
 * The one reading bash will NOT produce is a word-carrying expansion read as
 * empty (`${x:-git} reset` also offers the bare `reset`). That is deliberate:
 * separating the forms that can be empty (`$NAME`, `${x-git}`, `${x:+y}`) from
 * the one that cannot means naming bash's expansion OPERATORS, the enumerated
 * shape this module has paid for repeatedly — and `parameterExpansionWords`
 * already recovers the substituted word from the same text, so the elided twin
 * is a spare segment carrying no anchor. It can only over-block, this module's
 * established direction.
 *
 * Strictly ADDITIVE — the un-elided segments are always kept — so no command
 * that blocked before can stop blocking now. The residual the `expandWord`
 * docblock records is unchanged: a value-CARRYING `$NAME` (`G=git; $G reset`)
 * still spells nothing and still needs assignment tracking.
 */
function readExpansions(command, render) {
    let out = '';
    let i = 0;
    while (i < command.length) {
        const literal = matchAt(LITERAL_PART_RE, command, i);
        if (literal !== null) {
            out += literal;
            i += literal.length;
            continue;
        }
        const expanding = matchAt(EXPANDING_QUOTED_SPAN_RE, command, i);
        if (expanding !== null) {
            out += readExpansionsInText(expanding, render);
            i += expanding.length;
            continue;
        }
        const end = expansionSpanEnd(command, i);
        if (end === -1) {
            out += command[i];
            i++;
            continue;
        }
        out += render(command.slice(i, end));
        i = end;
    }
    return out;
}
/**
 * The walk above minus its quoting arms, for the INSIDE of a double-quoted span
 * — a run bash WILL expand, so both renderings apply there too.
 *
 * The backslash pass-through is not a duplicate of `LITERAL_PART_RE`: inside
 * `"…"` the grammar hands the span over whole, and `\$` is still bash's literal
 * dollar there (`"cost \$5 and $(date)"` is `cost $5 and <date>`). At top level
 * it is unreachable — `UNQUOTED_ESCAPE` is the first alternative of
 * `LITERAL_PART_RE`, so every `\<char>` has already been consumed.
 */
function readExpansionsInText(text, render) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] === '\\') {
            out += text.slice(i, i + 2);
            i += 2;
            continue;
        }
        const end = expansionSpanEnd(text, i);
        if (end === -1) {
            out += text[i];
            i++;
            continue;
        }
        out += render(text.slice(i, end));
        i = end;
    }
    return out;
}
/** The AP-EXT-ITER187-01 rendering: every expansion contributes the empty string. */
function elideExpansions(command) {
    return readExpansions(command, () => '');
}
/** The inner text of a command substitution span, or null when the span is not one. */
function substitutionBody(span) {
    if (span.startsWith('`')) {
        return span.length > 1 && span.endsWith('`') ? span.slice(1, -1) : span.slice(1);
    }
    if (!span.startsWith('$('))
        return null;
    return span.endsWith(')') ? span.slice(2, -1) : span.slice(2);
}
/**
 * AP-EXT-ITER260-01: what a COMMAND SUBSTITUTION contributes to the word AROUND
 * it — its operands.
 *
 * The inner text was already read as CODE, and only as code: `$(`, a backtick
 * and `(` are all segment separators, so `$(echo <state file>)` becomes the
 * segment `echo <state file>`, where the path is an operand of `echo` and no
 * write anchor is in sight. Nothing ever read that text as the VALUE of the word
 * it sits in, so a write DESTINATION hidden inside a substitution reached every
 * protected domain unseen — `cp /tmp/a $(echo <state file>)`, its backtick twin
 * and `echo x > $(echo <state file>)` all APPROVED for a worker while the
 * literal-path twins blocked, measured against the shipped handler with both
 * controls live in the same run.
 *
 * The command WORD is dropped and its operands kept. That is structural, not a
 * guess about which commands are used: a command's own name is never part of its
 * output (`echo X` prints `X`, never `echo`), and the code reading above
 * already covers the name. So the two readings PARTITION the inner text rather
 * than overlapping — and the partition is exactly what closes the REDIRECT
 * spelling, whose Pass 1 probes the single token standing after the `>` and
 * would otherwise find the substitution's command name there.
 *
 * Any OTHER expansion contributes its span verbatim: a substitution is the one
 * form whose output is derived from text it carries. A parameter expansion's
 * word is `parameterExpansionWords`' job and stays there — reading `${x:-git}`
 * here would spell its OPERATOR as a word bash never produces.
 *
 * Price, over 8,805 unique real worker Bash calls (9,191 calls, 139 live
 * `tmux_iteration_*.log` NDJSON transcripts, the measuring session excluded, cwd
 * chdir'd to the worker's repo): 3 new blocks, ZERO lost, ZERO domains changed on
 * a command that already blocked. All 3 were read back in full and every one is
 * markdown prose inside a HEREDOC BODY whose backticks pair across the text
 * (`...'none'` then `. Refuted` reads as a redirect to the repo root) — the
 * open AP-EXT-ITER258-03 prose-as-commands defect meeting AP-EXT-ITER259-01's
 * bare-dot ancestor token, not this rendering misreading a real command.
 */
function substitutionOutput(span) {
    const body = substitutionBody(span);
    if (body === null)
        return span;
    const inner = readExpansions(body, substitutionOutput).replace(/^\s+/, '');
    const afterCommandWord = inner.search(/\s/);
    return afterCommandWord === -1 ? '' : inner.slice(afterCommandWord);
}
/** The rendering in which every command substitution contributes its operands. */
function inlineSubstitutionOutput(command) {
    return readExpansions(command, substitutionOutput);
}
/**
 * AP-EXT-ITER264-02: what a PARAMETER EXPANSION contributes to the command
 * AROUND it — the text it carries, with its braces gone.
 *
 * The braces are the whole defect. A `${…}` body is ONE word to bash, but this
 * module's scan reaches it only after `SEGMENT_SCAN_RE` has already cut the
 * command at whitespace, so a body carrying a SEPARATOR is split like ordinary
 * code and its closing `}` glues to the last word of the last piece. `}` cannot
 * be split back out — it is a reserved WORD, not a metacharacter, and
 * `GLUED_SEPARATOR_RE` excludes it for bash's own reason (splitting it destroys
 * a brace EXPANSION) — so the glue is permanent and the last command of the body
 * is unreadable. Measured against the shipped handler with every literal twin
 * live in the same run: `bash <<< ${x:-cd sub && bash install.sh}`, its `;`
 * spelling, its `eval`, `trap`, `bash -s`, `source /dev/stdin`, fd-prefixed and
 * glued twins, and the state-file write in place of the deploy script — 21 of 28
 * forms APPROVED for a worker while all 8 byte-identical literal twins blocked,
 * and a real shell runs every one of them.
 *
 * The reading is taken on the RAW command, before any splitting, for exactly the
 * reason the other two are: by the time segments exist the brace has already
 * glued. It needs no knowledge of the CARRIER — here-string, `eval`, `trap`,
 * `-s`, `source /dev/stdin` and the glued and fd-prefixed spellings are all one
 * reading, because the brace is removed before anything asks what will re-parse
 * the text.
 *
 * The BODY is contributed whole rather than the substituted word alone, because
 * narrowing it to the word means reading PAST the expansion operator, and naming
 * bash's operators is the enumerated-set shape this module has paid for
 * repeatedly. The residue is the leading operator run staying glued to the
 * body's FIRST word (`${x:-cd sub …}` renders `x:-cd` as a word bash never
 * produces). That costs nothing: the operator run only ever precedes the first
 * word, `parameterExpansionWords` already recovers that word from the UNRENDERED
 * reading — which is still taken, this being strictly additive — and an extra
 * segment naming no anchor is this module's established fail-safe direction.
 * Measured: the hazard-in-first-position forms already block without this
 * reading, so the two readings PARTITION the body's positions.
 *
 * Any OTHER expansion contributes its span verbatim. A command substitution's
 * contribution is `substitutionOutput`'s job and stays there — its inner text is
 * CODE, already a segment of its own, and its braces are not the ones that glue.
 *
 * Nested bodies collapse in ONE step by recursing, the same shape
 * `substitutionOutput` uses. A rendering only ever REMOVES characters (the two
 * braces), so a reading that differs is strictly shorter and the recursion in
 * `splitShellSegments` still terminates on that argument.
 */
function parameterExpansionBody(span) {
    if (!span.startsWith('${'))
        return span;
    const body = span.endsWith('}') ? span.slice(2, -1) : span.slice(2);
    return readExpansions(body, parameterExpansionBody);
}
/** The rendering in which every parameter expansion contributes its body. */
function inlineParameterExpansionBody(command) {
    return readExpansions(command, parameterExpansionBody);
}
/** An assignment WORD: `NAME=` followed by the value, which may be empty. */
const ASSIGNMENT_WORD_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
/**
 * A bare parameter REFERENCE — `$NAME`, `${NAME}`, or bash's INDIRECT `${!NAME}`
 * — and nothing else.
 *
 * The braced arm requires the whole body to be a name, so it can never claim a
 * word-carrying expansion: `${x:-git}` is `parameterExpansionWords`' to read and
 * stays untouched here. `$1` and `$$` are not names and are not matched.
 *
 * The `!` is an OPTIONAL PREFIX on that same arm rather than a third
 * alternation (AP-EXT-ITER280-01). The reading's rule is unchanged — an
 * expansion whose body is a name contributes that name's value — and `!` only
 * says how many times the map is consulted, so the reader still holds two
 * shapes, not three. `${!NAME*}` / `${!NAME@}` (bash's name-listing forms) and
 * `${#NAME}` do not match, because the body must be exactly the name.
 */
const PARAMETER_REFERENCE_RE = /\$\{(!?)([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
/**
 * The value a parameter reference contributes: the name's own value, or — for
 * bash's INDIRECT `${!NAME}` — the value of the variable that value NAMES.
 *
 * The indirect arm is ONE extra lookup in the map already built, never a parse,
 * which is what keeps the emitted string a FIXPOINT (AP-EXT-ITER277-01):
 * `recordAssignedValues` never records a value carrying a `$`, so both the
 * intermediate name and the final value are literals holding no reference, and
 * applying the rendering to its own output returns it unchanged.
 */
function resolveParameterReference(values, indirect, name) {
    const value = values.get(name);
    if (!indirect || value === undefined)
        return value;
    return values.get(value);
}
/**
 * Record every `NAME=value` this piece assigns, for the substitution ahead of it.
 *
 * Read from the RENDERED piece, not the raw one (AP-EXT-ITER277-01): in
 * `X=install.sh; T=$X; bash $T` the value of T is written with a reference this
 * very pass has already resolved, and reading the raw text instead left T
 * unrecorded, so the substitution arrived only when `splitShellSegments`
 * re-entered the rendering on its own output — which made the emitted string NOT
 * a fixpoint and handed the input control of the recursion DEPTH. Left-to-right
 * IS bash's rule: it assigns in the same order, so a piece only ever sees values
 * that already exist, and a reference to a name assigned LATER resolves to
 * nothing here exactly as it does in the shell.
 *
 * Through the piece's BOUNDARY tokens, so a separator a SUBSTITUTION glued to
 * the value is not carried into it, and through the FOLD, so `S="install.sh"`
 * records the name bash will use.
 *
 * A value carrying a `$` is never recorded, so substitution can introduce no new
 * reference — the other half of the idempotence `inlineAssignedValues` rests on.
 */
function recordAssignedValues(piece, values) {
    const boundary = [];
    pushWordBoundaryTokens(piece, boundary);
    for (const token of boundary) {
        const assignment = ASSIGNMENT_WORD_RE.exec(foldShellWord(token).value);
        if (!assignment || assignment[2].length === 0 || assignment[2].includes('$'))
            continue;
        values.set(assignment[1], assignment[2]);
    }
}
/**
 * The rendering in which every `$NAME` / `${NAME}` contributes the LITERAL VALUE
 * assigned to that name earlier in the SAME command.
 *
 * AP-EXT-ITER143-01 recorded this as open on the grounds that such a word
 * "spells nothing". That is true of the WORD and false of the COMMAND, which is
 * the unit every reading in this list is taken on: in `S=install.sh; bash $S`
 * the value is written in plain sight one word over. This is that entry's own
 * insight — the substituted word is WRITTEN IN THE COMMAND — applied one level
 * up, where the assignment is in scope.
 *
 * Nearest-preceding assignment wins, which is bash's own rule and needs no
 * choice between first and last: the map is filled and read in ONE left-to-right
 * pass, so a word only ever sees the assignments standing before it.
 *
 * TERMINATION — this is the one reading that can GROW the command, so it cannot
 * lean on the "strictly shorter" argument the others share. It is IDEMPOTENT
 * instead, and idempotence is a PROPERTY OF THE EMITTED STRING, not of the
 * recording rule (AP-EXT-ITER277-01): every reference this pass CAN resolve is
 * resolved in it, because a value is recorded from the RENDERED word, so the
 * output holds no reference whose value stands before it. A value carrying a `$`
 * is never recorded either, so substitution can introduce no new reference.
 * Applying this rendering to its own output therefore returns it unchanged and
 * the `taken` dedup below ends the branch ONE level in, whatever the input.
 *
 * That the dedup ends it is the whole bound, so a recording rule that leaves a
 * resolvable reference standing is not a narrower reading — it hands the INPUT
 * control of the recursion DEPTH, one level per link of an assignment chain,
 * and the branching over the other three readings multiplies it. Measured on the
 * raw-word draft: a 20-link chain beside a `${…}` body and a substitution cost a
 * RangeError out of the segmenter — which `main`'s FATAL catch turns into an
 * APPROVE — so a literal `git reset --hard` standing in the same command was
 * approved for a worker while it blocked alone.
 *
 * What stays open is the LATER-assigned reference (`T=$X; X=install.sh`), and it
 * is bash's own semantics rather than a bound: the shell assigns `T` before `X`
 * exists, so `bash $T` runs an interactive shell and never the named script.
 *
 * BOUNDED in CHARACTERS for the same reason `parameterExpansionWords` is, so a
 * value referenced many times cannot make the emitted string quadratic in the
 * command and drive `shellPatternToRegex` past the engine's regex-size limit,
 * whose SyntaxError is the AP-EXT-ITER5-01 / ITER66-02 fail-OPEN door.
 *
 * Overflow abandons the WHOLE rendering rather than truncating it, and that is
 * load-bearing on TERMINATION, not a style choice. A truncated rendering leaves
 * the un-substituted references standing beside their assignments, so it is NOT
 * idempotent: the recursion below re-enters it, spends a FRESH budget on the
 * next few references, and walks the command one budget at a time. Measured on
 * the truncating draft — 200 references to a 200-char value cost 4.4 ms and 402
 * scopes at baseline against 90.8 ms and 4221 scopes, a ten-level recursion, one
 * level per budget. Returning the command unchanged instead makes the reading a
 * no-op the `taken` dedup drops, so an overflow costs nothing at all. Nothing is
 * ever REMOVED either way, so an overflow cannot lose a block a non-substituting
 * scanner already had.
 *
 * Quoting is deliberately not consulted — the AP-EXT-ITER64-01 uniform reading,
 * the same call `normalizeRedirectOperators` makes. A reference inside single
 * quotes does not expand in bash, so substituting there can only ADD a segment
 * the shell would not run: over-block, never under-block, this module's
 * established direction.
 */
function inlineAssignedValues(command) {
    // No `$` means no reference to substitute, so the whole word walk below can
    // only rebuild the command it was handed. Every reading is taken on every
    // command at every recursion level, so declining early is the difference
    // between charging this rendering to the 12% of commands it reads and
    // charging it to all of them.
    if (!command.includes('$'))
        return command;
    const values = new Map();
    const out = [];
    let budget = BRACE_EXPANSION_STEP_CAP;
    let cursor = 0;
    for (const match of command.matchAll(TOKEN_SCAN_RE)) {
        const word = match[0];
        const start = match.index ?? 0;
        out.push(command.slice(cursor, start));
        cursor = start + word.length;
        // Rendered and recorded PIECE BY PIECE, not once per whitespace word
        // (AP-EXT-ITER278-01): bash starts a new command at a glued separator, so in
        // `S=install.sh;T=$S; bash $T` the assignment to S stands before `T=$S` in
        // the shell's own order while both sit in ONE `TOKEN_SCAN_RE` word. Reading
        // the word whole rendered `T=$S` against a map S had not reached yet, so T
        // went unrecorded and `$T` reached no detector. The pieces PARTITION the
        // word, so emitting each in turn rebuilds it exactly.
        for (const piece of splitWordAtGluedSeparators(word)) {
            const rendered = piece.text.replace(PARAMETER_REFERENCE_RE, (reference, bang, braced, bare) => {
                const value = resolveParameterReference(values, bang === '!', braced ?? bare);
                if (value === undefined)
                    return reference;
                budget -= value.length;
                return value;
            });
            out.push(rendered);
            if (budget < 0)
                return command;
            if (!piece.separator)
                recordAssignedValues(rendered, values);
        }
    }
    out.push(command.slice(cursor));
    return out.join('');
}
/**
 * The values a command hands to the TOOL it runs, as the tool receives them.
 *
 * WHICH words deliver is bash's own question and needs no table of tools or of
 * the options they spell. bash assigns a `<name>=<value>` word only in the
 * ASSIGNMENT PREFIX that opens a simple command; anywhere past that run the word
 * is an ARGUMENT, and bash hands it through untouched to whatever is running —
 * `git -c core.pager=<cmd>`, an ssh proxy-command option, an rsync one — so the
 * value is the TOOL's to interpret, and tools run the commands they are handed.
 * `skipEnvAssignments` is the ONE definition of that prefix run and is read
 * here rather than re-typed. (Measured: real git 2.39.5 rejects the glued
 * `-c<key>=<value>` form with `unknown option`, so a delivery really is its own
 * word.)
 *
 * INSIDE the prefix run bash DOES assign, into the environment, and the tool
 * reads it back only under a name the tool knows — which is a ROSTER, and the
 * only reason one appears here. It holds git's config pair alone and is
 * deliberately not grown: the rest of that surface is recorded OPEN at
 * AP-EXT-ITER283-02 rather than chased one environment variable at a time.
 * Admitting every prefix name instead is not free — it reads the `S=<path>`
 * that opens a third of real worker commands as a delivered command.
 *
 * The NAME is held to a BARE WORD, and that ONE shape carries both exclusions
 * this extractor needs. It is not taste: the tokenizer keeps a quoted span as
 * ONE word, so without it a heredoc writing a test file hands back 1,143
 * characters of JavaScript as a "value" — a prose `const target = …` is
 * rejected on the SPACE in its name. It also carries the OPTION exclusion
 * outright, because a bare word does not open with `-`: `--format=`, `--grep=`
 * and `--stat=` carry operands that routinely spell a command (`git log
 * --format=reset` is a PINNED approve, AP-EXT-ITER53-01), and so does the
 * option-glued `-oName=<cmd>` spelling. AP-EXT-ITER283-01 needed a SECOND,
 * independent `startsWith('-')` test here because its name shape admitted a
 * leading hyphen (`--a.b` satisfies a dotted-key reading); this one does not,
 * so that test became a branch nothing could reach and is GONE rather than
 * kept as a guard with no live arm — measured, deleting it reds no case in the
 * suite that pins it.
 *
 * The values come back RAW, git's leading `!` shell-command marker included.
 * The mark is git's and not bash's, and the two readers ask different questions
 * of it — one reads the value as a SHELL command, for which the mark is not
 * part of the command, the other reads it as a git ARGUMENT LIST, for which the
 * marked spelling is one of two it must try (AP-EXT-ITER282-01). Stripping here
 * would answer one of those questions inside a helper that serves both.
 *
 * ONE home for the extraction, beside `segmentDefinesGitAlias` and for its
 * reason: this module is where the command-surface readers were collapsed so
 * they could not re-fork (AP-EXT-ITER281-01).
 */
const DELIVERED_VALUE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENVIRONMENT_DELIVERY_NAME_RE = /^GIT_CONFIG_[A-Za-z0-9_]+$/;
export function toolDeliveredValues(tokens) {
    const bashAssignsBefore = skipEnvAssignments(tokens.map((token) => token.value));
    const values = [];
    for (let i = 0; i < tokens.length; i++) {
        const word = tokens[i].value;
        const eq = word.indexOf('=');
        if (eq <= 0)
            continue;
        const name = word.slice(0, eq);
        const delivers = i >= bashAssignsBefore
            ? DELIVERED_VALUE_NAME_RE.test(name)
            : ENVIRONMENT_DELIVERY_NAME_RE.test(name);
        if (!delivers)
            continue;
        const value = word.slice(eq + 1);
        if (value.length > 0)
            values.push(value);
    }
    return values;
}
/**
 * The FIFTH reading: the commands a tool runs out of the values it is handed.
 *
 * A tool does not merely accept a command through an option or config value, it
 * RUNS one — measured 2026-09-18 against real git 2.39.5 (`git -c
 * core.sshCommand='<cmd>' fetch ssh://…` really executed `<cmd>`) and against
 * real ssh (a marker script named through the proxy-command option really
 * fired, AP-EXT-ITER283-03). AP-EXT-ITER282-01 taught those values to ONE
 * reader, `detectProhibitedGitVerb`; AP-EXT-ITER283-01 made them a reading of
 * this segmenter so the OTHER five readers — the `install.sh` deploy ban, the
 * expensive-`node --test` gate, the `.git/` path axis, the protected
 * write-target walk and tsc-gate's commit classifier — see them too.
 *
 * WHAT THIS PASS SUBTRACTS is the git ANCHOR that reading carried
 * (AP-EXT-ITER283-03). Anchoring on a git exec token made the reading true of
 * ONE tool, so the identical shape one tool over reached no detector at all:
 * MEASURED against the post-fix shipped handler with PICKLE_ROLE=worker and the
 * literal `bash install.sh` twin BLOCKING in the same run, a deploy command
 * delivered through an ssh option APPROVED, as did the same delivery to scp.
 * A per-tool anchor is a ROSTER of tools that execute what they are handed, and
 * a roster is one member short by construction — the enumerated-set liability
 * this module has paid for repeatedly. The reading now asks bash's question
 * instead: a value handed PAST the assignment prefix is the tool's to run,
 * whichever tool it is (`toolDeliveredValues`).
 *
 * A READING, not a sixth guard, for the reason that list exists: a guard per
 * reader is five edits that rot independently and leaves the next reader
 * unprotected by construction, while a member of this list reaches every reader
 * this segmenter has and every one it grows.
 *
 * MEASURED COST of dropping the anchor, over 5,759 unique real worker commands
 * harvested from 142 live session logs: see the CLAUDE.md entry.
 *
 * TERMINATION is by STRICT SHRINKAGE, the same argument the first three
 * readings carry and not one inherited by standing in the list: every emitted
 * character is a character of some token's value, each contributing token gives
 * up at least its `<name>=` prefix (two characters or more), and the `; ` joiner
 * costs two per gap against a token separator that already cost one. The output
 * is therefore strictly shorter than the input whenever it differs from it, so
 * a differing reading cannot be re-entered without end.
 */
function inlineToolDeliveredValues(command) {
    // Every reading is taken on every command at every recursion level, so the
    // cheap decline keeps this one charged to the commands that can carry a
    // delivery at all. A delivery is spelled `<name>=<value>` in one word, so a
    // command with no `=` has none — the tool anchor that used to stand here is
    // what AP-EXT-ITER283-03 removed.
    if (!command.includes('='))
        return command;
    const values = toolDeliveredValues(tokenizeShellTokens(command));
    if (values.length === 0)
        return command;
    // git's `!` marks the value as a SHELL command; the mark is not part of the
    // command it marks, and leaving it on hides the command from every detector
    // (`!sh -c "git reset --hard"` reads as the executable `!sh`).
    return values.map((value) => (value.startsWith('!') ? value.slice(1) : value)).join('; ');
}
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
    const own = expandShellCommandStrings(segments.length > 0 ? segments : [command], depth);
    // Append the additional READINGS of the same command — ONE list, one member
    // per rendering. Each is taken on the RAW string because the segments above
    // have already cut a glued word in half: `$(`/`` ` `` are separators, and a
    // `${…}` body's closing brace has already fused to its last word
    // (AP-EXT-ITER264-02). `depth` is passed through unchanged so
    // the command-string budget is spent on real nesting only. ONE loop, not a case
    // per reading — a further rendering is a member of this list and nothing else.
    //
    // TERMINATION is per-reading, not one rule for the list (AP-EXT-ITER276-01).
    // The first three only ever REMOVE characters, so a reading that differs is
    // strictly shorter. `inlineAssignedValues` can GROW the command and terminates
    // on IDEMPOTENCE instead — its own output renders to itself, so the `taken`
    // dedup ends that branch one level in. `inlineToolDeliveredValues` pays the FIRST
    // argument: it emits only characters of the values it read, and each
    // contributing token gives up its `<name>=` prefix (AP-EXT-ITER283-01).
    // A SIXTH reading owes this list one of those two arguments; neither is
    // inherited by standing here.
    //
    // The delivery reading is a PLAIN member and re-enters itself like any other,
    // and that was measured rather than assumed. A draft carried a
    // `readGitConfigValues` parameter to stop the re-entry, on the theory that a
    // reading taken at every level is a new branch at every level; with the
    // delivery NAME held to git's config syntax the parameter bought 42 scopes
    // across 5,541 real commands and nothing at all on an adversarial nest (17
    // scopes against 9 at sixteen levels, both linear), while it COST the nested
    // case its block — `git -c core.sshCommand='git -c core.pager="bash
    // install.sh" log' fetch` approved with the parameter and blocks without it,
    // closing a residual AP-EXT-ITER282-01 recorded OPEN. A parameter that buys no
    // measured cost and sells a real block is not a bound, it is a hole with a
    // name.
    //
    // A reading is taken once. The two renderings AGREE whenever the substitution
    // carries no operand (`git reset$(true) --hard` elides and inlines to the same
    // `git reset --hard`), and re-segmenting the identical string a second time
    // buys nothing but a duplicate scope.
    const scopes = [...own];
    const taken = new Set([command]);
    for (const reading of [elideExpansions(command), inlineSubstitutionOutput(command), inlineParameterExpansionBody(command), inlineAssignedValues(command), inlineToolDeliveredValues(command)]) {
        if (taken.has(reading))
            continue;
        taken.add(reading);
        scopes.push(...splitShellSegments(reading, depth));
    }
    return scopes;
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
 * The flag is found wherever it sits in the wrapper's option run — never "the
 * first word that does not start with `-`". Bash options take OPERANDS (`-o
 * pipefail`, `+o histexpand`, `-O extglob`, `--rcfile FILE`, `--init-file
 * FILE`), and each operand is a bare word standing before the `-c`. A scan that
 * stopped at the first bare word therefore quit at `pipefail` and never reached
 * the flag, so `bash -o pipefail -c "git reset --hard"` was never unwrapped and
 * every detector saw only the wrapper (AP-EXT-ITER54-01).
 *
 * EVERY word after the flag is a payload candidate, not just the next one.
 * Bash does not stop parsing options at `-c`: it sets a mode flag and keeps
 * going, then takes the first NON-OPTION argument as the command string. So the
 * flag's neighbour is the payload only when nothing follows the flag in the
 * option run, and a repeated or trailing option walks a single-token read one
 * word too early — `bash -c -c "git reset --hard"`, `bash -c -x "…"`, `bash -lc
 * -c "…"` and `bash -c -o pipefail "git stash"` all really run the payload
 * (shim-verified; the `-x` trace printed `+ git reset --hard` before executing
 * it) while the hook saw only `-c` / `-x` / `pipefail` and APPROVED. That hides
 * the WHOLE command string from every detector at once — the AP-EXT-ITER63-06
 * blast radius, re-opened for the git-verb, `install.sh`, expensive-test and
 * R-WSRC-3 write gates alike (AP-EXT-ITER93-08).
 *
 * Taking the whole tail is what needs no table. "Skip options, take the first
 * non-option" cannot be written without knowing which options consume an
 * operand — the enumerated-declaration shape of AP-EXT-ITER18-01/ITER19-01,
 * one member away from the next bypass, and the very list `bash -c -o pipefail`
 * proves incomplete. Each candidate is scanned as its OWN segment rather than
 * joined, because bash's `-c` does not concatenate its arguments the way `eval`
 * does — `wordToCodeBuiltinPayload` joins for exactly that reason and this must
 * not. The tokenizer has already established these word boundaries and stripped
 * each word's quotes; re-joining them manufactures a word sequence bash never
 * produced. (It would NOT hide the verb: `execAnchorIndex` reads no position, so
 * a joined `-x git reset --hard` still anchors — measured. The reason is
 * faithfulness to the grammar, not reach.)
 *
 * Over-reach is fail-safe in the module's existing direction and is a strict
 * WIDENING of the old read — yesterday's single token is still a member — so no
 * command that blocked before can stop blocking now. The extra candidates are
 * the shell's own option words and the command string's positional arguments
 * (`$0`, `$1`, …); each yields one more benign segment to scan, and the wrapper
 * segment is kept regardless.
 */
function shellCommandStringPayloads(segment) {
    const tokens = tokenizeShellCommand(segment);
    const wrapper = tokens.findIndex((token) => isShellWrapper(token));
    if (wrapper < 0)
        return [];
    for (let idx = wrapper + 1; idx < tokens.length; idx++) {
        if (isShellCommandStringFlag(tokens[idx]))
            return tokens.slice(idx + 1);
    }
    return [];
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
 * `shellCommandStringPayloads` is empty for every `eval` / `trap` form. The
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
 * The text a here-string hands to the command's standard input, or null when
 * the segment carries no here-string.
 *
 * The take is the WHOLE remaining scope, joined — the same take
 * `wordToCodeBuiltinPayload` uses, and for the reason AP-EXT-ITER264-01 measured
 * here: the operand is ONE bash word, but this module's tokenizer ends a word at
 * whitespace, so a `${…}` body carrying a space arrives as several tokens with
 * the closing brace glued to the last one. Joining restores the bytes the shell
 * kept together. The words that FOLLOW the operand are the command's own
 * arguments rather than its stdin; that costs extra scanned tokens and never a
 * lost block — this module's established direction. Reading `tokens[idx + 1]`
 * instead was the last single-token adjacency read, the shape the
 * AP-EXT-ITER262-01 PATTERN_SHAPE forbids.
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
        const rest = tokens.slice(idx + 1).map((rested) => rested.value);
        const words = glued.length > 0 ? [glued, ...rest] : rest;
        return words.length > 0 ? words.join(' ') : null;
    }
    return null;
}
/**
 * Appends each command-string payload's own segments after the segment that
 * carries it — the `-c` operand of a shell wrapper, the arguments of the `eval`
 * builtin, and the operand of a here-string. The carrying segment is KEPT
 * (fail-safe: never removes a segment a detector already saw), so a bare deploy
 * command — which carries none of them — is untouched.
 *
 * Each payload is split as WRITTEN and then as every word `expandWord` may
 * produce from it. That is ONE application of the seam for all three
 * constructs rather than a treatment per construct: a payload is a WORD before
 * it is code, and re-tokenizing the text alone loses the boundary bash kept.
 * AP-EXT-ITER264-01 measured what that costs — a parameter expansion carrying
 * two words fragments and its closing brace glues to the last fragment, so the
 * seam never saw a whole word and the deploy ban and both R-WSRC-3 write gates
 * approved in every here-string, `eval` and `trap` spelling while each literal
 * twin blocked.
 *
 * The payload LEADS its own list because `expandWord` is not strictly widening:
 * `expandBraceWord` REPLACES an alternation with its alternatives, so a payload
 * carrying one would be LOST if the seam alone were pushed.
 */
function expandShellCommandStrings(segments, depth) {
    if (depth >= MAX_SHELL_COMMAND_STRING_DEPTH)
        return segments;
    const expanded = [];
    for (const segment of segments) {
        expanded.push(segment);
        for (const payload of [
            wordToCodeBuiltinPayload(segment),
            ...shellCommandStringPayloads(segment),
            hereStringPayload(segment),
        ]) {
            if (payload === null)
                continue;
            for (const word of [payload, ...expandWord(payload)]) {
                expanded.push(...splitShellSegments(word, depth + 1));
            }
        }
    }
    return expanded;
}
