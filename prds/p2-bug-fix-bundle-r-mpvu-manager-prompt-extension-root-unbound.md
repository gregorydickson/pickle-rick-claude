# P2 Bug-Fix Bundle — R-MPVU: the manager prompt ships `${EXTENSION_ROOT}` unbound, so a codex manager resolves it by filesystem search and finds a foreign runtime

**Priority:** P2 (HIGH — `--backend codex` is 100% non-functional at the first worker spawn. No data
loss and no bad commits: the run makes zero progress and burns ~38K codex tokens per iteration
declaring `<promise>I AM DONE</promise>`. The Claude backend is unaffected, which is exactly why this
survived — Claude infers the path, codex searches for it.)
**Code:** R-MPVU (Manager-Prompt Variable Unbound).
**Backend:** codex (fatal) / claude (latent — see *Why this never surfaced* below).

**Build-safety note (pipeline-safe).** The fix lives in the manager-prompt render path plus
`backendEnvOverrides` — it does NOT touch `salvage-ticket.ts`, `reconcile-ticket-truth.ts`,
`ticket-completion-evidence.ts`, or any Done-flip / completion-evidence oracle. Not R-PSRB. The running
pipeline executes DEPLOYED JS, so the source diff cannot self-apply mid-build; it lands at
`install.sh`. **Self-exposure:** if this bundle is itself built on `--backend codex`, it cannot start —
build it on claude, or apply the env-export workaround below first.

**Source anchor:** verified 2026-08-03 against `release/v2.1-beta` HEAD `a3945bbd`, deployed runtime
`2.1.0-beta.7`. Template `extension/templates/_pickle-manager-prompt.md:142`; the already-correct
resolver `extension/src/services/pickle-utils.ts:301` (`getExtensionRoot`), its canonical constant
`:221`, its sentinel `:222`; `backendEnvOverrides` at `extension/src/services/backend-spawn.ts:819`.

---

## Context — the forensics

Live incident, session `2026-08-03-2d5b3820` (a 16-ticket LOA-2190 bundle in a `loanlight-api`
worktree, launched `--backend codex`). The run advanced iteration 1 → 2 → and would have advanced
forever, producing nothing. Two iterations, ~38K codex tokens each, **zero** on-disk artifacts — no
`research_*.md`, no commits, ticket `372eddc7` still `In Progress`.

What the manager actually did, from `tmux_iteration_1.log`:

```
exec /bin/zsh -lc "node '/Users/…/.codex/pickle-rick/extension/bin/spawn-morty.js' \
  '/Users/…/.local/share/pickle-rick/sessions/2026-08-03-2d5b3820' 372eddc7"
exited 1 in 0ms:
State schema 5 at …/state.json is newer than supported 1.
```

Preceded by the manager reasoning its way there:

> The installed CLI is simple: `spawn-morty.js <session-dir> <ticket-id>`. I'm retrying with that exact
> contract in the foreground now.

That is not our CLI. Our contract is
`spawn-morty.js "<DESC>" --ticket-id <ID> --ticket-path … --ticket-file … --timeout …`. The manager had
read the **source of a different `spawn-morty.js`** and adopted its usage string.

Then it gave up, correctly and politely, twice:

> The deployed Pickle Rick runtime is blocked by a version mismatch. … I did complete the mandatory
> queue check and confirmed not all tickets are done; the active ticket remains `372eddc7` in
> `research`. The failure is at the installed runtime boundary, not ticket state.
> `<promise>I AM DONE</promise>`

## Root cause — the variable is bound nowhere

`extension/templates/_pickle-manager-prompt.md:142`:

```
2. **Delegate**: `node "${EXTENSION_ROOT}/extension/bin/spawn-morty.js" "<DESC>" --ticket-id <ID> …`
```

Measured against the prompt the manager actually received (`tmux_iteration_1.log`):

| Token | Occurrences | Meaning |
| --- | ---: | --- |
| literal `${EXTENSION_ROOT}` | **8** | never substituted at render |
| literal `${SESSION_ROOT}` | **28** | never substituted at render |
| `EXTENSION_ROOT=` | **0** | never assigned anywhere in the transcript |

And it is not supplied out-of-band either:

- `grep -n EXTENSION_ROOT extension/src/bin/mux-runner.ts` → **zero hits**. The runner never exports it.
- The manager env is `{ ...process.env, ...backendEnvOverrides(backend, …), ...(invocation.env ?? {}),
  PICKLE_STATE_FILE }` (`mux-runner.ts`, manager spawn). `backendEnvOverrides`
  (`backend-spawn.ts:819`) does not add `EXTENSION_ROOT`.

So the template emits a shell variable that nothing in the process tree defines. `"${EXTENSION_ROOT}/…"`
expands to `"/extension/bin/spawn-morty.js"` — a path that does not exist — and the manager is left to
work out what was meant.

**A Claude manager infers it** (from the session path, the `Extension:` banner, or prior knowledge) and
proceeds. **A codex manager searches the filesystem**, and on this machine the first hit is
`~/.codex/pickle-rick/extension/bin/spawn-morty.js` — codex's own home directory, an obviously
plausible place for a codex-backend runtime to live. That install is `0.2.17-beta.3` with
`STATE_SCHEMA_VERSION = 1` (its own source agrees; it is not a stale deploy), while
`~/.claude/pickle-rick` is `2.1.0-beta.7` and writes schema 5. `readiness.ts` demands **equality**, not
forward-compatibility, so the mismatch is terminal.

> ⚠️ The foreign install is a **contributing factor, not the bug**. Deleting it would change the failure
> from "runs the wrong runtime" to "fails to find any runtime" — still a failure, just a louder one.
> The bug is the unbound variable.

## Why this never surfaced

Two properties hid it for the entire life of the template:

1. **Claude tolerates unbound template variables by inferring them.** Every green Claude run has been
   papering over this. *(Inferred from the asymmetry — Claude runs succeed with the identical prompt —
   not directly measured. AC-MPVU-4 measures it.)*
2. **The failure is a polite no-op.** The manager completed its queue check, reported honestly, and
   emitted `<promise>I AM DONE</promise>`. No fatal, no halt, no `exit_reason` — so nothing in the
   runner's failure surface fires. The run looks like it is iterating.

## The fix is already written — it just isn't wired to the template

`extension/src/services/pickle-utils.ts` already contains exactly the right resolver:

```ts
const CANONICAL_EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick');   // :221
const EXTENSION_ROOT_SENTINEL  = path.join('extension', 'bin', 'log-watcher.js');  // :222

export function getExtensionRoot(): string {                                        // :301
  return resolveExtensionRoot(process.env.EXTENSION_DIR);
}

function resolveExtensionRoot(requestedRoot: string | undefined): string {
  if (!requestedRoot) return CANONICAL_EXTENSION_ROOT;
  if (extensionRootSentinelExists(requestedRoot)) return requestedRoot;
  …
  return CANONICAL_EXTENSION_ROOT;                                  // sentinel missing → canonical
}
```

**The sentinel would have rejected the foreign install outright.** Measured 2026-08-03:

| candidate root | `extension/bin/log-watcher.js` | resolver verdict |
| --- | --- | --- |
| `~/.claude/pickle-rick` | **PRESENT** | accepted |
| `~/.codex/pickle-rick` | **ABSENT** | rejected → falls back to canonical |

So the defense against precisely this incident exists, is exported, and is never applied to the manager
prompt.

### WS-1 — bind the variables at render time (primary)

Substitute `${EXTENSION_ROOT}` and `${SESSION_ROOT}` with concrete absolute paths when rendering
`_pickle-manager-prompt.md`, sourcing the former from `getExtensionRoot()`. This removes the dependence
on shell expansion entirely and is backend-agnostic — no manager, of any model, is asked to guess.

Prefer this over WS-2. A rendered literal cannot be mis-expanded by a login shell, a different `$HOME`,
or an agent that resolves paths itself before shelling out (which is what codex did).

### WS-2 — export as belt-and-braces

Add `EXTENSION_ROOT: getExtensionRoot()` (and the session dir) to `backendEnvOverrides` so any
*other* `${EXTENSION_ROOT}` reference in any prompt or script expands correctly. Cheap, and it closes
the class rather than the instance.

### WS-3 — fail loud instead of guessing

If a manager's spawn command resolves to a `spawn-morty.js` outside `getExtensionRoot()`, that is a
hard error, not a fallback. Today the only signal was a polite `I AM DONE` and an iteration bump.

## Acceptance criteria

- [ ] **AC-MPVU-1** The rendered manager prompt contains **zero** literal `${EXTENSION_ROOT}` and zero
      literal `${SESSION_ROOT}`. Verify: render the template for a fixture session and assert the
      absence of `/\$\{[A-Z_]+\}/` anywhere in the output.
- [ ] **AC-MPVU-2** Every path the rendered prompt names for `spawn-morty.js` is absolute and equals
      `getExtensionRoot()`. Verify: parse the rendered prompt, assert `path.isAbsolute` and prefix-match.
- [ ] **AC-MPVU-3** With `EXTENSION_DIR` pointed at a sentinel-less directory (e.g. a tmpdir, or
      `~/.codex/pickle-rick`), the rendered prompt still names the canonical root. Verify: a unit test
      driving `resolveExtensionRoot` through the render path.
- [ ] **AC-MPVU-4** Confirm-or-refute the *Why this never surfaced* claim: run one Claude-backend
      manager turn against the **unfixed** template and record whether it resolves the path by
      inference. This is the only unmeasured premise in this bundle; if Claude also mis-resolves, the
      priority rises and the blast radius widens beyond codex.
- [ ] **AC-MPVU-5** A codex-backend manager spawns a worker successfully against a schema-5 session —
      the end-to-end regression. Verify: relaunch session `2026-08-03-2d5b3820` (or an equivalent
      fixture) on `--backend codex` and assert `research_*.md` appears in the ticket directory.
- [ ] **AC-MPVU-6** Mutation check: revert WS-1 only, and AC-MPVU-1 must fail. A green suite against
      the unfixed template means the test is pinning nothing.

## Trap door (to add on landing)

`extension/templates/CLAUDE.md` (or the nearest owning `CLAUDE.md`) — INVARIANT: every `${VAR}` in a
prompt template MUST be substituted at render time or exported into the manager env; a template
variable that survives to the delivered prompt is a latent path-guess. BREAKS: a Claude manager infers
and proceeds (silent); a codex manager searches the filesystem and can bind a foreign runtime, which
fails at the state-schema check with no fatal, no halt, and an iteration bump that looks like progress
(R-MPVU, live 2026-08-03). ENFORCE: AC-MPVU-1's no-unbound-variable assertion over every rendered
template. PATTERN_SHAPE: a `${[A-Z_]+}` surviving into rendered prompt text.

## Workaround until this lands

Export the variables into the launching shell before starting `mux-runner`; the literal then expands
correctly because codex shells out via `/bin/zsh -lc` and inherits the environment:

```bash
export EXTENSION_ROOT="$HOME/.claude/pickle-rick"
export SESSION_ROOT="<session dir>"
```

Unverified — it addresses the measured root cause but has not been run end-to-end. Building this bundle
on `--backend claude` is the reliable path.

## NOT in scope

Deleting or repairing `~/.codex/pickle-rick` (a machine-local artifact, and per operator: Claude Code
never uses `pickle-rick-codex`). Porting the codex repo to schema 5. Any change to the state-schema
equality check in `readiness.ts` — that check behaved correctly here.
