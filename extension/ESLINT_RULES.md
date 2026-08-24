# eslint-plugin-pickle — Custom Rule Reference

All rules live in `extension/eslint-plugin-pickle/index.js` (compiled from `extension/src/` via `install.sh`).
Plugin namespace: `pickle/`.

---

## 1. `pickle/no-raw-state-write`

**Type**: `problem`

### What it catches
- `fs.writeFileSync(stateFilePath, ...)` — direct write bypasses atomic write and crash safety
- `writeStateFile(stateFilePath, ...)` — direct call outside of `StateManager` bypasses lock protection

### Why
A raw `writeFileSync` on `state.json` during a crash leaves a partial file. `writeStateFile` in `pickle-utils` uses an atomic tmp-rename dance, but still bypasses the file-based lock that `StateManager` manages. Any write that skips the lock can corrupt state when two processes race.

### Exemptions
`state-manager.ts` and `pickle-utils.ts` are allowed — they are the canonical implementation.

### Violation
```js
// Raw write — no atomicity
fs.writeFileSync(statePath, JSON.stringify(state));

// Direct writeStateFile outside StateManager — no lock
writeStateFile(statePath, state);
```

### Fix
```js
// Use StateManager for all state mutations
const sm = new StateManager();
sm.update(statePath, (s) => { s.iteration = 5; });

// In signal/crash handlers where acquiring a lock is unsafe
sm.forceWrite(statePath, state);
```

---

## 2. `pickle/cli-guard-basename`

**Type**: `problem`

### What it catches
CLI entry-point guards that compare `process.argv[1]` using:
- `.startsWith()`, `.endsWith()`, `.includes()` — brittle against symlinks and path prefixes
- Direct `=== "..."` equality without `path.basename()` — breaks on absolute path invocation

### Why
`process.argv[1]` is the full resolved path to the script. Comparing it directly fails when Node resolves symlinks or when the script is called from a different cwd. `path.basename` normalises to just the filename and is the only portable guard.

### Violation
```js
if (process.argv[1].endsWith('setup.js')) { /* ... */ }
if (process.argv[1] === 'setup.js') { /* ... */ }
```

### Fix
```js
import * as path from 'node:path';
if (process.argv[1] && path.basename(process.argv[1]) === 'setup.js') {
  // CLI entry point
}
```

---

## 3. `pickle/hook-decision-values`

**Type**: `problem`
**Scope**: Files under `hooks/` only

### What it catches
`decision` property values that are not `"approve"` or `"block"`. Specifically catches the common mistake of using `"allow"` (which Claude Code does not recognise).

### Why
Claude Code's hook protocol defines exactly two valid decision strings: `"approve"` and `"block"`. Anything else (including `"allow"`) is silently ignored, which means hooks that should block tool calls may fail open.

### Violation
```js
const result = { decision: 'allow', reason: 'ok' };
const result = { decision: 'permit', reason: 'ok' };
```

### Fix
```js
const result = { decision: 'approve', reason: 'ok' };
const result = { decision: 'block', reason: 'dangerous operation' };
```

---

## 4. `pickle/no-unsafe-error-cast`

**Type**: `problem`

### What it catches
Two patterns inside `catch` blocks:
1. Accessing `.message`, `.stack`, `.code`, or `.cause` on the catch binding without an `instanceof Error` guard
2. Casting the catch binding with `as Error` (TypeScript `TSAsExpression`)

### Why
`catch (err)` types as `unknown` in TypeScript strict mode. Accessing `.message` directly throws at runtime when the thrown value is a string, number, or non-Error object. Casting with `as Error` suppresses the type error but provides no runtime safety.

### Violation
```js
try { /* ... */ } catch (err) {
  console.error(err.message);           // unsafe
  const e = err as Error;               // unsafe cast
}
```

### Fix
```js
try { /* ... */ } catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
}
```

---

## 5. `pickle/no-gemini-path`

**Type**: `problem`

### What it catches
String literals and template literals containing `".gemini"` anywhere in a path.

### Why
The extension path is `~/.claude/pickle-rick/`. An early version of the project used `.gemini`. Any `.gemini` path reference is a stale copy-paste that will silently write to the wrong location.

### Violation
```js
const personaPath = `${os.homedir()}/.gemini/pickle-rick/persona.md`;
const cfgPath = '~/.gemini/pickle-rick/pickle_settings.json';
```

### Fix
```js
const personaPath = `${os.homedir()}/.claude/pickle-rick/persona.md`;
const cfgPath = '~/.claude/pickle-rick/pickle_settings.json';
```

> Note: this rule covers deployed extension files (`~/.claude/pickle-rick/`). Runtime data — sessions, activity, jar queue, worktrees — lives at `~/.local/share/pickle-rick/` (XDG data dir, see `getDataRoot()` in `pickle-utils.ts`).

---

## 6. `pickle/no-deployed-file-edit`

**Type**: `problem`

### What it catches
`fs.writeFileSync`, `fs.writeSync`, `fs.renameSync`, `fs.unlinkSync`, and `fs.appendFileSync` calls where the first argument resolves to a path under `~/.claude/pickle-rick/`.

### Why
Deployed files are managed exclusively by `install.sh`. Editing them directly breaks the source-of-truth invariant: the next `install.sh` run silently overwrites the change. All modifications must go through `extension/src/`.

### Violation
```js
fs.writeFileSync('~/.claude/pickle-rick/pickle_settings.json', JSON.stringify(settings));
fs.appendFileSync(`${homeDir}/.claude/pickle-rick/persona.md`, '\nextra rule\n');
```

### Fix
Edit `extension/src/` source files, then run `bash install.sh` from the repo root to deploy.

---

## 7. `pickle/require-number-validation`

**Type**: `problem`

### What it catches
`Number(state.someField)` (or any `Number()` call on a `MemberExpression`) that is not followed by a `Number.isFinite()` guard somewhere in the same file.

### Why
`Number(undefined)` → `NaN`, `Number(null)` → `0`, `Number("")` → `0`. State fields can be absent or corrupt. Passing an unvalidated `NaN` into iteration comparisons or timeout calculations causes silent logic bugs (e.g. `NaN > 10` is always `false`).

### Violation
```js
const iter = Number(state.iteration);
if (iter > maxIter) { /* NaN > maxIter is always false */ }
```

### Fix
```js
const raw = Number(state.iteration);
const iter = Number.isFinite(raw) ? raw : 0;
if (iter > maxIter) { /* safe */ }
```

---

## 8. `pickle/no-process-exit-in-library`

**Type**: `problem`
**Scope**: Files under `services/` only

### What it catches
`process.exit()` calls in service/library files.

### Why
Service modules are imported by multiple callers (bin scripts, tests, hooks). Calling `process.exit()` inside a service kills the entire process with no chance for the caller to handle the error, clean up state, or log diagnostics. Services should throw; let the top-level entry point decide whether to exit.

### Violation
```js
// In services/circuit-breaker.js
if (tripped) {
  process.exit(1);  // kills everything, no cleanup
}
```

### Fix
```js
// In services/circuit-breaker.js
if (tripped) {
  throw new Error('Circuit breaker tripped');
}
// In bin/spawn-morty.js (caller)
try { /* ... */ } catch (err) { process.exit(1); }
```

---

## 9. `pickle/promise-token-format`

**Type**: `problem`
**Scope**: Excludes `types/index.*` (definition) and `tests/` files

### What it catches
Hardcoded promise token strings (`"EPIC_COMPLETED"`, `"TASK_COMPLETED"`, `"I AM DONE"`, etc.) used directly in string literals or template literals outside the canonical definition file.

### Why
Promise tokens are the inter-process signalling protocol between orchestrator and workers. A typo in a hardcoded string causes a missed signal — the orchestrator hangs waiting for a token that never arrives. Centralising them in `PromiseTokens.*` makes them refactor-safe.

Known tokens: `EPIC_COMPLETED`, `TASK_COMPLETED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, `PRD_COMPLETE`, `TICKET_SELECTED`, `ANALYSIS_DONE`, `I AM DONE`

### Violation
```js
if (output.includes('EPIC_COMPLETED')) { /* ... */ }
const sentinel = 'TASK_COMPLETED';
```

### Fix
```js
import { PromiseTokens, hasToken } from '../types/index.js';
if (hasToken(output, PromiseTokens.EPIC_COMPLETED)) { /* ... */ }
const sentinel = PromiseTokens.TASK_COMPLETED;
```

---

## 10. `pickle/no-sync-in-async`

**Type**: `suggestion`

### What it catches
`fs.*Sync()` calls (readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, statSync, readdirSync, copyFileSync, chmodSync, accessSync, openSync, closeSync, writeSync, readSync, appendFileSync) inside `async` functions.

### Why
Sync I/O blocks the Node.js event loop. Inside an `async` function the caller already supports `await`, so there is no ergonomic reason to block. In CLI scripts this is low-risk, but in services shared by concurrent operations a blocked event loop stalls all pending work.

### Violation
```js
async function loadConfig(p) {
  const raw = fs.readFileSync(p, 'utf-8');   // blocks event loop
  return JSON.parse(raw);
}
```

### Fix
```js
async function loadConfig(p) {
  const raw = await fs.promises.readFile(p, 'utf-8');
  return JSON.parse(raw);
}
```

---

## 11. `pickle/spawn-error-handler`

**Type**: `problem`

### What it catches
`spawn()`, `exec()`, and `execFile()` calls whose return value is stored in a variable that never has a `.on('error', ...)` handler attached (checked statically via source text scan).

### Why
If the spawned binary does not exist or is not executable, Node emits an `'error'` event on the child process object. Without a handler this becomes an unhandled `'error'` event and crashes the parent process with `Error: ENOENT` or `EACCES`. This is a common source of opaque crashes in the orchestrator.

### Violation
```js
const proc = spawn('claude', args);
proc.stdout.on('data', handler);
// No proc.on('error', ...) — ENOENT will crash the process
```

### Fix
```js
const proc = spawn('claude', args);
proc.on('error', (err) => {
  console.error(`spawn failed: ${err.message}`);
});
proc.stdout.on('data', handler);
```

---

## 12. `pickle/no-hardcoded-timeout`

**Type**: `suggestion`

### What it catches
`setTimeout(fn, n)` or `sleep(n)` calls where `n` is a numeric literal greater than `5000` (5 seconds).

### Why
Magic timeout values greater than 5 seconds indicate a configurable delay (rate-limit waits, worker timeouts, polling intervals) that should come from `pickle_settings.json` or a `Defaults.*` constant. Hardcoded values are invisible to operators and untestable without code changes.

### Violation
```js
await sleep(30_000);          // what is this for?
setTimeout(retry, 120_000);   // two minutes — from where?
```

### Fix
```js
import { Defaults } from '../types/index.js';
await sleep(Defaults.RATE_LIMIT_POLL_MS);
setTimeout(retry, settings.worker_timeout_seconds * 1000);
```

---

## 13. `pickle/require-max-buffer-on-capture`

**Type**: `problem`

### What it catches
`spawnSync`/`execSync`/`execFileSync` calls that capture text output (an `encoding` option, or any `execSync` call) but have no `maxBuffer`, where the call is also shaped like an unbounded read: `shell: true`, a `git ls-files`/`status`/`diff`/`log`/`blame`/`grep` enumeration, or an npm/pnpm/yarn `run <script>` invocation.

### Why
Without `maxBuffer`, `spawnSync`/`execSync`/`execFileSync` fall back to Node's 1MB default. Past that ceiling, Node SIGTERMs the child and the caller gets a truncated or absent result it cannot distinguish from a legitimate failure — a fake-RED gate verdict, not a log truncation (did-we-count corpus shas `7e06e8b2`, `e2804228`, `d24cec5e`). Scoped to the unbounded-shape subset deliberately: a blanket "encoding without maxBuffer" check fires on ~80 bounded single-fact probes tree-wide (`git rev-parse`, `lsof -p`, `pgrep`, `--version` checks) that can never approach the ceiling — noise the false-positive budget (AC-4') forbids shipping.

### Violation
```js
const result = spawnSync(packageManager, ['run', 'test:fast'], {
  cwd: extensionDir,
  encoding: 'utf-8',
  timeout: timeoutMs,
});
```

### Fix
```js
const result = spawnSync(packageManager, ['run', 'test:fast'], {
  cwd: extensionDir,
  encoding: 'utf-8',
  timeout: timeoutMs,
  maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
});
```

---

## 14. `pickle/require-spawn-result-error-check`

**Type**: `problem`

### What it catches
An `if` test that references `<spawnSyncResult>.status` but never `<spawnSyncResult>.error`, where the `spawnSync()` call it comes from both captures text output (`encoding` option) and reads an unbounded enumeration (the same shape `require-max-buffer-on-capture` targets).

### Why
A `spawnSync` child that EXITS before Node's `maxBuffer`-overflow `SIGTERM` lands returns `status: 0, signal: null, error.code: 'ENOBUFS'` — a status-only completion check reads this as a complete, successful result even though the read stopped early (did-we-count corpus sha `c7c85ef3`). Scoped to the encoding-plus-unbounded-shape subset for the same AC-4' reason as rule 13: an unscoped `.status`-without-`.error` check fires on 43 whole-tree call sites (mostly bounded probes like `lsof -t`/`pgrep -f` that also happen to set `encoding`); narrowing to the shapes that can actually hit the ENOBUFS-exit-0 truncation drops that to 15 justified hits.

### Violation
```js
const result = spawnSync('git', ['diff', '--staged', '--name-only', '-z'], { encoding: 'utf-8' });
if ((result.status ?? 1) !== 0) return null;
```

### Fix
```js
const result = spawnSync('git', ['diff', '--staged', '--name-only', '-z'], { encoding: 'utf-8' });
if ((result.status ?? 1) !== 0 || result.error) return null;
```

---

## 15. `pickle/no-invalid-checkout-index-stage`

**Type**: `problem`

### What it catches
The literal string `'--stage=0'` anywhere in an array literal (git argv construction).

### Why
`git checkout-index --stage` only accepts `1`, `2`, `3`, or `all`; `--stage=0` always hard-errors (`fatal: stage should be between 1 and 3 or all`, exit 128). Omitting the flag entirely IS stage 0 — the merged index entry (did-we-count corpus sha `0cf3b8e3`). There is no legitimate use of the literal.

### Violation
```js
runTextCommand('git', ['checkout-index', '--prefix', checkoutPrefix, '--stage=0', '-a'], repoRoot, timeout);
```

### Fix
```js
runTextCommand('git', ['checkout-index', '--prefix', checkoutPrefix, '-a'], repoRoot, timeout);
```

---

## 16. `pickle/require-group-kill-for-spawned-child`

**Type**: `problem`

### What it catches
A variable assigned from `spawn(...)` / `<ns>.spawn(...)`, later `.kill(...)`-ed directly, where the enclosing function's source text contains no `killProcessGroup(` call — nor a call to one of the documented delegates that themselves route through it (`killProcessTree(` in `spawn-morty.ts`, `reapChildSubtree(` in `pipeline-runner.ts`, `reapTaskSubtree(` in `jar-runner.ts`).

### Why
If the spawned process is a subtree root (a shell, an npm script, a CLI that shells out — spawns its own children), a bare pid `.kill()` leaves the grandchildren orphaned to re-parent to PID 1 and outlive the caller (did-we-count corpus shas `ff8d4739`, `41b9b255`). Scoped per-function, not per-module, because `killProcessGroup`/its delegates are legitimately called elsewhere in the same file for unrelated pids.

### Violation
```js
function runTask() {
  const proc = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
  setTimeout(() => { proc.kill('SIGTERM'); }, ms);
}
```

### Fix
```js
function runTask() {
  const proc = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
  setTimeout(() => {
    if (!killProcessGroup(proc.pid, 'SIGTERM')) proc.kill('SIGTERM');
  }, ms);
}
```

---

## Rule Summary Table

| Rule | Type | Scope |
|------|------|-------|
| `no-raw-state-write` | problem | all (excl. state-manager, pickle-utils) |
| `cli-guard-basename` | problem | all |
| `hook-decision-values` | problem | `hooks/` only |
| `no-unsafe-error-cast` | problem | all |
| `no-gemini-path` | problem | all |
| `no-deployed-file-edit` | problem | all |
| `require-number-validation` | problem | all |
| `no-process-exit-in-library` | problem | `services/` only |
| `promise-token-format` | problem | all (excl. types/index, tests/) |
| `no-sync-in-async` | suggestion | all |
| `spawn-error-handler` | problem | all |
| `no-hardcoded-timeout` | suggestion | all |
| `require-max-buffer-on-capture` | problem | all |
| `require-spawn-result-error-check` | problem | all |
| `no-invalid-checkout-index-stage` | problem | all |
| `require-group-kill-for-spawned-child` | problem | all |
