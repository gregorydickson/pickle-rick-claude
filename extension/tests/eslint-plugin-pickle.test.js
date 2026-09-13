// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import pickle from '../eslint-plugin-pickle/index.js';
import eslintConfig from '../eslint.config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2025, sourceType: 'module' },
});

// ─── no-raw-state-write ─────────────────────────────────────────────────────

describe('pickle/no-raw-state-write', () => {
  it('catches raw fs.writeFileSync and writeStateFile on state.json, allows StateManager', () => {
    ruleTester.run('no-raw-state-write', pickle.rules['no-raw-state-write'], {
      valid: [
        // Non-state file
        { code: `import * as fs from 'fs'; fs.writeFileSync('/tmp/config.json', '{}');` },
        // writeStateFile on non-state file (e.g. meta.json)
        { code: `writeStateFile(metaPath, meta);` },
        // StateManager.update is the correct approach
        { code: `sm.update(statePath, s => { s.active = false; });` },
        // StateManager.forceWrite on non-state file is allowed
        { code: `sm.forceWrite(metaPath, state);` },
        // StateManager.update on state is the correct approach
        { code: `sm.update(path.join(sessionDir, 'state.json'), s => { s.active = false; });` },
        // fs.readFileSync on state is fine
        { code: `import * as fs from 'fs'; fs.readFileSync(statePath, 'utf-8');` },
        // writeStateFile on path.join with non-state file is fine
        { code: `writeStateFile(path.join(sessionDir, 'meta.json'), meta);` },
      ],
      invalid: [
        // Literal state.json path via fs.writeFileSync
        {
          code: `import * as fs from 'fs'; fs.writeFileSync('/tmp/state.json', '{}');`,
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // statePath variable via fs.writeFileSync
        {
          code: `import * as fs from 'fs'; const statePath = 'x'; fs.writeFileSync(statePath, '{}');`,
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // stateFile variable via fs.writeFileSync
        {
          code: `import * as fs from 'fs'; const stateFile = 'x'; fs.writeFileSync(stateFile, '{}');`,
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // Template literal with state.json via fs.writeFileSync
        {
          code: 'import * as fs from \'fs\'; fs.writeFileSync(`${dir}/state.json`, \'{}\');',
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // writeStateFile on statePath — should use StateManager
        {
          code: `writeStateFile(statePath, state);`,
          errors: [{ messageId: 'useStateManager' }],
        },
        // writeStateFile on stateFile — should use StateManager
        {
          code: `writeStateFile(stateFile, state);`,
          errors: [{ messageId: 'useStateManager' }],
        },
        // path.join with 'state.json' via writeStateFile — should use StateManager
        {
          code: `writeStateFile(path.join(sessionDir, 'state.json'), state);`,
          errors: [{ messageId: 'useStateManager' }],
        },
        // path.join with 'state.json' via fs.writeFileSync — should use writeStateFile
        {
          code: `import * as fs from 'fs'; fs.writeFileSync(path.join(dir, 'state.json'), '{}');`,
          errors: [{ messageId: 'useWriteStateFile' }],
        },
        // sm.forceWrite on statePath — needs eslint-disable justification
        {
          code: `sm.forceWrite(statePath, state);`,
          errors: [{ messageId: 'forceWriteNeedsComment' }],
        },
        // sm.forceWrite on path.join state.json — needs eslint-disable justification
        {
          code: `sm.forceWrite(path.join(dir, 'state.json'), state);`,
          errors: [{ messageId: 'forceWriteNeedsComment' }],
        },
      ],
    });
  });
});

// ─── cli-guard-basename ─────────────────────────────────────────────────────

describe('pickle/cli-guard-basename', () => {
  it('requires path.basename for process.argv[1] comparisons', () => {
    ruleTester.run('cli-guard-basename', pickle.rules['cli-guard-basename'], {
      valid: [
        // Correct: path.basename
        { code: `import * as path from 'path'; if (path.basename(process.argv[1]) === 'setup.js') {}` },
        // Non-comparison use is fine
        { code: `const script = process.argv[1];` },
        // process.argv[2] is fine
        { code: `if (process.argv[2] === 'foo') {}` },
      ],
      invalid: [
        // Bare comparison
        {
          code: `if (process.argv[1] === 'setup.js') {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
        // startsWith
        {
          code: `if (process.argv[1].startsWith('/usr')) {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
        // endsWith
        {
          code: `if (process.argv[1].endsWith('.js')) {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
        // includes
        {
          code: `if (process.argv[1].includes('setup')) {}`,
          errors: [{ messageId: 'requireBasename' }],
        },
      ],
    });
  });
});

// ─── hook-decision-values ───────────────────────────────────────────────────

describe('pickle/hook-decision-values', () => {
  it('enforces approve/block in hooks/ files', () => {
    ruleTester.run('hook-decision-values', pickle.rules['hook-decision-values'], {
      valid: [
        // Correct decisions in hooks/
        { code: `const r = { decision: "approve" };`, filename: 'src/hooks/stop.ts' },
        { code: `const r = { decision: "block", reason: "nope" };`, filename: 'src/hooks/stop.ts' },
        // "allow" outside hooks/ is fine
        { code: `const x = "allow";`, filename: 'src/bin/setup.ts' },
        // Non-decision property in hooks/ is fine
        { code: `const r = { status: "allow" };`, filename: 'src/hooks/stop.ts' },
      ],
      invalid: [
        // decision: "allow" in hooks/
        {
          code: `const r = { decision: "allow" };`,
          filename: 'src/hooks/handlers/stop-hook.ts',
          errors: [{ messageId: 'noAllow' }],
        },
        // decision: "permit" in hooks/
        {
          code: `const r = { decision: "permit" };`,
          filename: 'src/hooks/handlers/stop-hook.ts',
          errors: [{ messageId: 'invalidDecision' }],
        },
        // JSON.stringify({ decision: "allow" }) in hooks/
        {
          code: `const x = JSON.stringify({ decision: "allow" });`,
          filename: 'src/hooks/stop.ts',
          errors: [{ messageId: 'noAllow' }],
        },
      ],
    });
  });
});

// ─── no-unsafe-error-cast ───────────────────────────────────────────────────

describe('pickle/no-unsafe-error-cast', () => {
  it('requires instanceof guard for catch binding property access', () => {
    ruleTester.run('no-unsafe-error-cast', pickle.rules['no-unsafe-error-cast'], {
      valid: [
        // Ternary guard
        { code: `try { x(); } catch (err) { const m = err instanceof Error ? err.message : String(err); }` },
        // If guard
        { code: `try { x(); } catch (err) { if (err instanceof Error) { console.log(err.message); } }` },
        // && guard
        { code: `try { x(); } catch (err) { const m = err instanceof Error && err.message; }` },
        // Not a catch binding
        { code: `const err = new Error('x'); console.log(err.message);` },
        // Catch without binding
        { code: `try { x(); } catch { console.log('failed'); }` },
        // Safe property (not in dangerous list)
        { code: `try { x(); } catch (err) { console.log(err.name); }` },
        // String(err) is safe
        { code: `try { x(); } catch (err) { console.log(String(err)); }` },
      ],
      invalid: [
        // Bare .message
        {
          code: `try { x(); } catch (err) { console.log(err.message); }`,
          errors: [{ messageId: 'requireGuard' }],
        },
        // Bare .stack
        {
          code: `try { x(); } catch (err) { console.log(err.stack); }`,
          errors: [{ messageId: 'requireGuard' }],
        },
        // Bare .code
        {
          code: `try { x(); } catch (e) { console.log(e.code); }`,
          errors: [{ messageId: 'requireGuard' }],
        },
      ],
    });
  });
});

// ─── no-bare-convergence-history ─────────────────────────────────────────────

describe('pickle/no-bare-convergence-history', () => {
  it('requires optional chaining or asserted metric convergence before history access', () => {
    ruleTester.run('no-bare-convergence-history', pickle.rules['no-bare-convergence-history'], {
      valid: [
        { code: `const history = state.convergence?.history ?? [];` },
        { code: `const metricConv = assertMetricConvergence(state, 'helper'); const history = metricConv.history;` },
        { code: `const history = state.other.history;` },
      ],
      invalid: [
        {
          code: `const history = state.convergence.history;`,
          errors: [{ messageId: 'requireGuard' }],
        },
        {
          code: `const scores = mvState.convergence.history.map(h => h.score);`,
          errors: [{ messageId: 'requireGuard' }],
        },
      ],
    });
  });
});

// ─── no-bare-extension-dir ────────────────────────────────────────────────────

describe('pickle/no-bare-extension-dir', () => {
  it('requires getExtensionRoot outside approved bootstrap files', () => {
    ruleTester.run('no-bare-extension-dir', pickle.rules['no-bare-extension-dir'], {
      valid: [
        { code: `const root = getExtensionRoot();`, filename: 'src/bin/setup.ts' },
        { code: `const nodeEnv = process.env.NODE_ENV;`, filename: 'src/bin/setup.ts' },
        { code: `const root = process.env.EXTENSION_DIR;`, filename: 'src/services/pickle-utils.ts' },
        { code: `const root = process.env.EXTENSION_DIR || fallback;`, filename: 'src/hooks/dispatch.ts' },
      ],
      invalid: [
        {
          code: `const root = process.env.EXTENSION_DIR;`,
          filename: 'src/bin/setup.ts',
          errors: [{ messageId: 'useHelper' }],
        },
        {
          code: `const root = process.env.EXTENSION_DIR || getExtensionRoot();`,
          filename: 'src/services/activity-logger.ts',
          errors: [{ messageId: 'useHelper' }],
        },
      ],
    });
  });
});

// ─── no-gemini-path ──────────────────────────────────────────────────────────

describe('pickle/no-gemini-path', () => {
  it('flags .gemini in path strings', () => {
    ruleTester.run('no-gemini-path', pickle.rules['no-gemini-path'], {
      valid: [
        { code: `const p = '~/.claude/pickle-rick';` },
        { code: `const p = '/home/user/.claude/pickle-rick/extension';` },
        { code: 'const p = `${home}/.claude/pickle-rick`;' },
      ],
      invalid: [
        {
          code: `const p = '~/.gemini/pickle-rick';`,
          errors: [{ messageId: 'noGemini' }],
        },
        {
          code: 'const p = `${home}/.gemini/extension`;',
          errors: [{ messageId: 'noGemini' }],
        },
      ],
    });
  });
});

// ─── no-deployed-file-edit ───────────────────────────────────────────────────

describe('pickle/no-deployed-file-edit', () => {
  it('flags writes to deployed ~/.claude/pickle-rick/ paths', () => {
    ruleTester.run('no-deployed-file-edit', pickle.rules['no-deployed-file-edit'], {
      valid: [
        { code: `import * as fs from 'fs'; fs.writeFileSync('/tmp/foo.json', '{}');` },
        { code: `import * as fs from 'fs'; fs.readFileSync('/home/.claude/pickle-rick/state.json');` },
        { code: `import * as fs from 'fs'; fs.writeFileSync('./extension/src/foo.ts', 'code');` },
      ],
      invalid: [
        {
          code: `import * as fs from 'fs'; fs.writeFileSync('/home/user/.claude/pickle-rick/state.json', '{}');`,
          errors: [{ messageId: 'noDeployedWrite' }],
        },
        {
          code: `import * as fs from 'fs'; fs.appendFileSync('~/.claude/pickle-rick/debug.log', 'msg');`,
          errors: [{ messageId: 'noDeployedWrite' }],
        },
        {
          code: 'import * as fs from \'fs\'; fs.unlinkSync(`${home}/.claude/pickle-rick/foo`);',
          errors: [{ messageId: 'noDeployedWrite' }],
        },
      ],
    });
  });
});

// ─── require-number-validation ───────────────────────────────────────────────

describe('pickle/require-number-validation', () => {
  it('requires Number.isFinite() guard after Number() on state fields', () => {
    ruleTester.run('require-number-validation', pickle.rules['require-number-validation'], {
      valid: [
        // Properly guarded
        { code: `const raw = Number(state.iteration); const val = Number.isFinite(raw) ? raw : 0;` },
        // Non-member arg (plain variable) — not flagged
        { code: `const n = Number(someString);` },
        // Number on a literal — not flagged
        { code: `const n = Number('42');` },
      ],
      invalid: [
        {
          code: `const raw = Number(state.iteration); const val = raw > 0 ? raw : 0;`,
          errors: [{ messageId: 'requireIsFinite' }],
        },
        {
          code: `const rawMax = Number(settings.maxRetries); console.log(rawMax);`,
          errors: [{ messageId: 'requireIsFinite' }],
        },
      ],
    });
  });
});

// ─── no-process-exit-in-library ──────────────────────────────────────────────

describe('pickle/no-process-exit-in-library', () => {
  it('flags process.exit() in services/ files', () => {
    ruleTester.run('no-process-exit-in-library', pickle.rules['no-process-exit-in-library'], {
      valid: [
        // process.exit in bin/ is fine
        { code: `process.exit(1);`, filename: 'src/bin/setup.ts' },
        // process.exit in hooks/ is fine
        { code: `process.exit(0);`, filename: 'src/hooks/dispatch.ts' },
        // Non-exit call in services/ is fine
        { code: `process.cwd();`, filename: 'src/services/utils.ts' },
      ],
      invalid: [
        {
          code: `process.exit(1);`,
          filename: 'src/services/pickle-utils.ts',
          errors: [{ messageId: 'noExitInService' }],
        },
        {
          code: `if (bad) { process.exit(0); }`,
          filename: 'src/services/circuit-breaker.ts',
          errors: [{ messageId: 'noExitInService' }],
        },
      ],
    });
  });
});

// ─── promise-token-format ────────────────────────────────────────────────────

describe('pickle/promise-token-format', () => {
  it('flags hardcoded promise tokens outside types/index', () => {
    ruleTester.run('promise-token-format', pickle.rules['promise-token-format'], {
      valid: [
        // Using enum reference is fine
        { code: `const t = PromiseTokens.EPIC_COMPLETED;`, filename: 'src/bin/setup.ts' },
        // Token in definition file is fine
        { code: `const EPIC_COMPLETED = 'EPIC_COMPLETED';`, filename: 'src/types/index.ts' },
        // Token in canonical promise-tokens module is fine
        { code: `const TOKENS = ['EPIC_COMPLETED', 'TASK_COMPLETED'];`, filename: 'src/services/promise-tokens.ts' },
        // Token in test file is fine
        { code: `const r = 'EPIC_COMPLETED';`, filename: 'tests/stop-hook.test.js' },
        // Non-token string is fine
        { code: `const s = 'some_other_string';`, filename: 'src/bin/setup.ts' },
      ],
      invalid: [
        {
          code: `const t = 'EPIC_COMPLETED';`,
          filename: 'src/bin/mux-runner.ts',
          errors: [{ messageId: 'useEnum' }],
        },
        {
          code: `if (text.includes('TASK_COMPLETED')) {}`,
          filename: 'src/hooks/handlers/stop-hook.ts',
          errors: [{ messageId: 'useEnum' }],
        },
        {
          code: 'const x = `token: EXISTENCE_IS_PAIN`;',
          filename: 'src/bin/setup.ts',
          errors: [{ messageId: 'useEnum' }],
        },
      ],
    });
  });
});

// ─── no-sync-in-async ────────────────────────────────────────────────────────

describe('pickle/no-sync-in-async', () => {
  it('flags synchronous fs calls inside async functions', () => {
    ruleTester.run('no-sync-in-async', pickle.rules['no-sync-in-async'], {
      valid: [
        // Sync fs in sync function is fine
        { code: `import * as fs from 'fs'; function foo() { fs.readFileSync('x'); }` },
        // Async fs.promises in async function is fine
        { code: `import * as fs from 'fs'; async function foo() { await fs.promises.readFile('x'); }` },
        // Non-fs sync call in async is fine
        { code: `async function foo() { JSON.parse('{}'); }` },
      ],
      invalid: [
        {
          code: `import * as fs from 'fs'; async function foo() { fs.readFileSync('x'); }`,
          errors: [{ messageId: 'preferAsync' }],
        },
        {
          code: `import * as fs from 'fs'; const foo = async () => { fs.writeFileSync('x', 'y'); };`,
          errors: [{ messageId: 'preferAsync' }],
        },
        {
          code: `import * as fs from 'fs'; async function foo() { fs.existsSync('x'); }`,
          errors: [{ messageId: 'preferAsync' }],
        },
      ],
    });
  });
});

// ─── spawn-error-handler ─────────────────────────────────────────────────────

describe('pickle/spawn-error-handler', () => {
  it('requires .on("error") handler for spawn/exec calls', () => {
    ruleTester.run('spawn-error-handler', pickle.rules['spawn-error-handler'], {
      valid: [
        // Has error handler
        { code: `const proc = spawn('node', []); proc.on('error', (e) => console.error(e));` },
        // exec with error handler
        { code: `const p = exec('ls'); p.on('error', (e) => {});` },
        // Not a spawn call
        { code: `const x = foo('bar');` },
      ],
      invalid: [
        {
          code: `const proc = spawn('node', []); proc.on('close', () => {});`,
          errors: [{ messageId: 'requireErrorHandler' }],
        },
        {
          code: `const p = exec('ls');`,
          errors: [{ messageId: 'requireErrorHandler' }],
        },
      ],
    });
  });
});

// ─── no-hardcoded-timeout ────────────────────────────────────────────────────

describe('pickle/no-hardcoded-timeout', () => {
  it('flags hardcoded timeouts >5000ms', () => {
    ruleTester.run('no-hardcoded-timeout', pickle.rules['no-hardcoded-timeout'], {
      valid: [
        // Small timeout is fine
        { code: `sleep(1000);` },
        { code: `setTimeout(fn, 5000);` },
        // Variable timeout is fine
        { code: `sleep(configTimeout);` },
        { code: `setTimeout(fn, settings.timeout);` },
        // Boundary: exactly 5000 is fine
        { code: `sleep(5000);` },
      ],
      invalid: [
        {
          code: `sleep(10000);`,
          errors: [{ messageId: 'useConfig' }],
        },
        {
          code: `setTimeout(fn, 60000);`,
          errors: [{ messageId: 'useConfig' }],
        },
        {
          code: `sleep(30000);`,
          errors: [{ messageId: 'useConfig' }],
        },
      ],
    });
  });
});

// ─── require-max-buffer-on-capture (ticket d7c017ff, did-we-count AC-1'/AC-4') ──
// Covers 7e06e8b2 / e2804228 / d24cec5e — 0 live call sites at HEAD (all three
// already carry maxBuffer). 10 OTHER whole-tree call sites still miss it (see
// conformance_2026-08-24.md AC-4' hit count).

describe('pickle/require-max-buffer-on-capture', () => {
  it('flags encoding-capturing calls with an unbounded shape and no maxBuffer', () => {
    ruleTester.run('require-max-buffer-on-capture', pickle.rules['require-max-buffer-on-capture'], {
      valid: [
        // Fixed shape (7e06e8b2 post-fix): maxBuffer present alongside encoding.
        { code: `spawnSync(pm, ['run', 'test:fast'], { cwd, encoding: 'utf-8', timeout: timeout, maxBuffer: UNBOUNDED_READ_MAX_BUFFER });` },
        // Bounded single-fact probe (lsof -t <path>) — encoding set, but not an
        // unbounded enumeration shape; the trap-door catalog names this class
        // explicitly as NOT matching (extension/src/services/CLAUDE.md AP-EXT-ITER8-01).
        { code: `spawnSync('lsof', ['-t', lockPath], { encoding: 'utf-8', timeout: 5000 });` },
        // No encoding option at all — result is a Buffer, not a capture-and-parse read.
        { code: `spawnSync('git', ['rev-parse', 'HEAD'], { timeout: 5000 });` },
        // execFileSync with a bounded single-fact probe.
        { code: `execFileSync('git', ['cat-file', '-e', sha], { cwd, timeout: timeout });` },
      ],
      invalid: [
        // 7e06e8b2 shape: npm/pnpm/yarn `run <script>` capture, no maxBuffer.
        {
          code: `spawnSync(packageManager, ['run', 'test:fast'], { cwd: extensionDir, encoding: 'utf-8', timeout: timeoutMs, env: scrubGateEnv() });`,
          errors: [{ messageId: 'requireMaxBuffer' }],
        },
        // e2804228 / d24cec5e shape: whole-repo git enumeration capture, no maxBuffer.
        {
          code: `const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8', timeout: 30000 });`,
          errors: [{ messageId: 'requireMaxBuffer' }],
        },
        // execSync form of the same unbounded-enumeration shape (template literal,
        // matching the actual standup.ts callsite this pattern is drawn from).
        {
          code: 'const output = execSync(`git log --after="${since}"`, { encoding: \'utf-8\', timeout: 10000 });',
          errors: [{ messageId: 'requireMaxBuffer' }],
        },
      ],
    });
  });
});

// ─── require-spawn-result-error-check (ticket d7c017ff, did-we-count AC-1'/AC-4') ──
// Covers c7c85ef3 — 0 live call sites at HEAD (both `check-scope-diff.ts` and
// `microverse-runner.ts` already OR in `.error`). 15 OTHER whole-tree call sites
// still test `.status` alone on an unbounded git-enumeration capture (see
// conformance_2026-08-24.md AC-4' hit count).

describe('pickle/require-spawn-result-error-check', () => {
  it('flags a .status-only completion check on an unbounded-capture spawnSync result', () => {
    ruleTester.run('require-spawn-result-error-check', pickle.rules['require-spawn-result-error-check'], {
      valid: [
        // Fixed shape (c7c85ef3 post-fix): predicate ORs in .error.
        { code: `function f() { const result = spawnSync('git', ['diff', '--staged', '--name-only', '-z'], { encoding: 'utf-8', timeout: 5000 }); if ((result.status ?? 1) !== 0 || result.error) return null; }` },
        // .status-only check is fine when the call does not capture unbounded text
        // (no encoding option — matches AC-4' narrowing, avoids the 43-hit noise
        // surface measured on bounded probes like lsof/pgrep before this filter).
        { code: `function f() { const lsof = spawnSync('lsof', ['-t', lockPath], { encoding: 'utf-8', timeout: 5000 }); if (lsof.status === 0) { return true; } }` },
        // .status-only check on a non-enumeration capturing call (bounded single-fact probe).
        { code: `function f() { const res = spawnSync('git', ['cat-file', '-e', sha], { encoding: 'utf-8', timeout: 5000 }); if (res.status !== 0) return false; }` },
      ],
      invalid: [
        // c7c85ef3 pre-fix shape: unbounded git enumeration capture, status-only check.
        {
          code: `function f() { const result = spawnSync('git', ['diff', '--staged', '--name-only', '--no-renames', '-z'], { encoding: 'utf-8', timeout: 15000 }); if ((result.status ?? 1) !== 0) return null; }`,
          errors: [{ messageId: 'requireErrorCheck' }],
        },
        // git ls-files enumeration, status-only check (15-hit sibling shape).
        {
          code: `function f() { const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 }); if (result.status !== 0) return []; }`,
          errors: [{ messageId: 'requireErrorCheck' }],
        },
      ],
    });
  });
});

// ─── no-invalid-checkout-index-stage (ticket d7c017ff, did-we-count AC-1'/AC-4') ──
// Covers 0cf3b8e3 — 0 live call sites at HEAD (materializeStagedTree omits the
// flag entirely). 0 OTHER whole-tree hits — no live sites for this sub-pattern
// anywhere in the tree (see conformance_2026-08-24.md AC-4' hit count).

describe('pickle/no-invalid-checkout-index-stage', () => {
  it('flags the literal --stage=0 argv element to git checkout-index', () => {
    ruleTester.run('no-invalid-checkout-index-stage', pickle.rules['no-invalid-checkout-index-stage'], {
      valid: [
        // Fixed shape (0cf3b8e3 post-fix): flag omitted entirely (IS stage 0).
        { code: `runTextCommand('git', ['checkout-index', '--prefix', checkoutPrefix, '-a'], repoRoot, timeout);` },
        // Any valid --stage value is fine.
        { code: `runTextCommand('git', ['checkout-index', '--stage=1', '-a'], repoRoot, timeout);` },
        { code: `runTextCommand('git', ['checkout-index', '--stage=all', '-a'], repoRoot, timeout);` },
      ],
      invalid: [
        // 0cf3b8e3 pre-fix shape: the literal always hard-errors (git accepts 1|2|3|all only).
        {
          code: `runTextCommand('git', ['checkout-index', '--prefix', checkoutPrefix, '--stage=0', '-a'], repoRoot, timeout);`,
          errors: [{ messageId: 'invalidStage' }],
        },
      ],
    });
  });
});

// ─── require-group-kill-for-spawned-child (ticket d7c017ff, did-we-count AC-1'/AC-4') ──
// Covers ff8d4739 / 41b9b255 — 0 live call sites at HEAD (both route through
// killProcessGroup via reapTaskSubtree/killJudgeSubtree). 0 OTHER whole-tree hits
// — no live sites for this sub-pattern anywhere in the tree (see
// conformance_2026-08-24.md AC-4' hit count; the rule also recognizes the
// documented killProcessTree/reapChildSubtree/reapTaskSubtree delegates that
// themselves route through killProcessGroup, per src/bin/CLAUDE.md R-OMTD).

describe('pickle/require-group-kill-for-spawned-child', () => {
  it('flags a bare .kill() on a spawned child with no group-kill routing in the enclosing function', () => {
    ruleTester.run('require-group-kill-for-spawned-child', pickle.rules['require-group-kill-for-spawned-child'], {
      valid: [
        // Fixed shape (ff8d4739 post-fix): routes through killProcessGroup first.
        { code: `function runTask() { const proc = spawn(cmd, args, { cwd, env, stdio: 'inherit', timeout: 5000 }); function reapTaskSubtree(signal) { if (!killProcessGroup(proc.pid, signal)) proc.kill(signal); } reapTaskSubtree('SIGTERM'); }` },
        // Delegate wrapper (spawn-morty.ts killProcessTree) internally routes through
        // killProcessGroup — a caller of the wrapper already gets group-kill safety.
        { code: `function spawnWorker() { const proc = spawn(cmd, args, { cwd, env, detached: true, timeout: 5000 }); const timeoutHandle = setTimeout(() => { if (!killProcessTree(proc, 'SIGTERM')) { try { proc.kill('SIGTERM'); } catch {} } }, ms); }` },
        // A spawn call with no later .kill() at all is fine.
        { code: `function fireAndForget() { const proc = spawn(cmd, args, { timeout: 5000 }); proc.on('exit', () => {}); }` },
      ],
      invalid: [
        // ff8d4739 pre-fix shape: bare .kill() in the timeout handler, no group-kill anywhere.
        {
          code: `function runTask() { const proc = spawn(cmd, args, { cwd, env, stdio: 'inherit', timeout: 5000 }); const timeoutHandle = setTimeout(() => { proc.kill('SIGTERM'); }, ms); }`,
          errors: [{ messageId: 'requireGroupKill' }],
        },
        // 41b9b255 pre-fix shape: the _deps spawn wrapper later .kill()-ed directly, no killProcessGroup.
        {
          code: `function spawnWithClosedStdin() { const child = _deps.spawn(cmd, args, { cwd, env, timeout: 5000 }); function killJudgeSubtree(signal) { child.kill(signal); } killJudgeSubtree('SIGTERM'); }`,
          errors: [{ messageId: 'requireGroupKill' }],
        },
      ],
    });
  });
});

// ─── AC-6': every exported rule must be wired in eslint.config.js ───────────

/** Collect the `pickle/<name>` rule keys wired across every flat-config entry's `rules` block. */
function collectWiredPickleRuleNames(flatConfig) {
  const wired = new Set();
  for (const entry of flatConfig) {
    if (!entry || typeof entry.rules !== 'object' || entry.rules === null) continue;
    for (const key of Object.keys(entry.rules)) {
      if (key.startsWith('pickle/')) wired.add(key.slice('pickle/'.length));
    }
  }
  return wired;
}

describe('AC-6’: eslint-plugin-pickle exports are wired in eslint.config.js', () => {
  it('every rule exported from eslint-plugin-pickle/index.js appears in eslint.config.js', () => {
    const exported = new Set(Object.keys(pickle.rules));
    const wired = collectWiredPickleRuleNames(eslintConfig);

    // Real set comparison (exported minus wired), never a count equality —
    // two matching counts can resolve a different question than "is every
    // exported rule wired" (see AC-6' / the 14-vs-15 grep discrepancy).
    const unwired = [...exported].filter((name) => !wired.has(name));

    assert.deepEqual(
      unwired,
      [],
      `rule(s) exported from eslint-plugin-pickle but not wired in eslint.config.js: ${unwired.join(', ')}`,
    );
  });

  it('the set comparison catches a rule that is exported but not wired', () => {
    const wired = collectWiredPickleRuleNames(eslintConfig);
    // Simulate a newly-exported rule that has not been wired yet — the
    // assertion above must be able to catch this, not just pass on today's
    // already-wired 14.
    const exportedWithUnwiredAddition = new Set([...Object.keys(pickle.rules), 'no-future-unwired-rule']);

    const unwired = [...exportedWithUnwiredAddition].filter((name) => !wired.has(name));

    assert.deepEqual(unwired, ['no-future-unwired-rule']);
  });
});

// ─── V6-1 (GitHub #18): the eslint leg FAILS on a fresh warn-level finding ────
// `--max-warnings=-1` is ESLint's NO-LIMIT value, which made every 'warn' rule free.
// The flag is READ from the root CLAUDE.md release gate (release-gate-parity pins the
// workflows and check-wired.sh to it), and the eslint CLI's EXIT CODE is asserted, not a
// printed count. V6-5 mutation: set that flag back to -1 and every case here reds.

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESLINT_BIN = path.join(EXTENSION_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

function releaseGateEslintFlag() {
  const md = fs.readFileSync(path.join(EXTENSION_ROOT, '..', 'CLAUDE.md'), 'utf8');
  const match = md.match(/npx eslint src\/ (--max-warnings=-?\d+)/);
  assert.ok(match, 'root CLAUDE.md release gate names no `npx eslint src/ --max-warnings=<N>` leg');
  return match[1];
}

/** Rules the real config leaves at 'warn', derived (later flat-config entries win). */
function warnLevelRules(flatConfig) {
  const levels = {};
  for (const entry of flatConfig) {
    if (!entry || entry.files || typeof entry.rules !== 'object' || entry.rules === null) continue;
    for (const [name, value] of Object.entries(entry.rules)) {
      levels[name] = Array.isArray(value) ? value[0] : value;
    }
  }
  return Object.keys(levels).filter((name) => levels[name] === 'warn' || levels[name] === 1).sort();
}

const WARN_RULE_VIOLATIONS = {
  '@typescript-eslint/no-explicit-any': {
    ext: 'ts',
    code: 'export const value: any = 1;\n',
  },
  'pickle/no-sync-in-async': {
    ext: 'js',
    code: "import * as fs from 'fs';\nexport async function foo() { fs.readFileSync('x'); }\n",
  },
  'pickle/require-max-buffer-on-capture': {
    ext: 'js',
    code: "import { spawnSync } from 'child_process';\nexport const result = spawnSync('git', ['ls-files'], { cwd: '.', encoding: 'utf-8', timeout: 30000 });\n",
  },
  'pickle/require-spawn-result-error-check': {
    ext: 'js',
    code: "import { spawnSync } from 'child_process';\nexport function f() { const result = spawnSync('git', ['ls-files'], { cwd: '.', encoding: 'utf-8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 }); if (result.status !== 0) return []; return result.stdout; }\n",
  },
};

describe('V6-1: the release-gate eslint leg fails on a fresh warn-level finding', () => {
  it('every warn-level rule in eslint.config.js has a violation fixture here', () => {
    assert.deepEqual(Object.keys(WARN_RULE_VIOLATIONS).sort(), warnLevelRules(eslintConfig));
  });

  it('the release gate eslint flag is a finite ceiling', () => {
    const flag = releaseGateEslintFlag();
    assert.notEqual(flag, '--max-warnings=-1', '-1 is ESLint NO LIMIT: warn-level rules could never fail the gate');
  });

  for (const [rule, violation] of Object.entries(WARN_RULE_VIOLATIONS)) {
    it(`a fresh ${rule} finding makes the eslint CLI exit non-zero under the gate flag`, () => {
      // realpath: macOS os.tmpdir() is a /var -> /private/var symlink, and eslint ignores a
      // file whose spelling falls outside its (realpath) cwd base path.
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-v6-eslint-')));
      try {
        const pluginUrl = pathToFileURL(path.join(EXTENSION_ROOT, 'eslint-plugin-pickle', 'index.js')).href;
        const configPath = path.join(dir, 'eslint.config.mjs');
        fs.writeFileSync(configPath, [
          `import pickle from ${JSON.stringify(pluginUrl)};`,
          `import tseslint from ${JSON.stringify(import.meta.resolve('typescript-eslint'))};`,
          'export default [{',
          "  files: ['**/*.js', '**/*.ts'],",
          "  languageOptions: { parser: tseslint.parser, sourceType: 'module' },",
          "  plugins: { pickle, '@typescript-eslint': tseslint.plugin },",
          `  rules: ${JSON.stringify({ [rule]: 'warn' })},`,
          '}];',
          '',
        ].join('\n'));
        const filePath = path.join(dir, `violation.${violation.ext}`);
        fs.writeFileSync(filePath, violation.code);

        const result = spawnSync(
          process.execPath,
          [ESLINT_BIN, '--config', configPath, '--format', 'json', releaseGateEslintFlag(), filePath],
          { cwd: dir, encoding: 'utf-8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
        );
        assert.equal(result.error, undefined, `eslint could not run: ${result.error?.message}`);
        const [report] = JSON.parse(result.stdout);
        assert.ok(
          report.messages.some((m) => m.ruleId === rule && m.severity === 1),
          `fixture did not trigger ${rule} at warn level: ${JSON.stringify(report.messages)}`,
        );
        assert.equal(report.errorCount, 0, 'the fixture must produce warnings only, so the ceiling alone decides the exit');
        assert.equal(result.status, 1, `eslint exited ${result.status} on a fresh ${rule} warning — the gate would pass it`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// ─── M3 (GitHub #21): no rule-less eslint-disable directive ───────────────────
// A disable naming no rule silences every rule on its range, including rules added later.
// ESLint applies directives to the rule that inspects them, so `x; // eslint-disable-line` and a
// file-wide `/* eslint-disable */` silence pickle/no-unlimited-disable in the lint leg itself.
// These cases re-run the SAME rule with noInlineConfig, which no directive can reach.

/** Lines the rule reports for `code`; throws when the file did not parse (unparsed is not clean). */
function unlimitedDisableLines(code, { filePath = 'fixture.ts', noInlineConfig = true } = {}) {
  const messages = new Linter({ configType: 'flat', cwd: EXTENSION_ROOT }).verify(code, [{
    files: ['**/*.ts', '**/*.js'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { noInlineConfig, reportUnusedDisableDirectives: 'off' },
    plugins: { pickle },
    rules: { 'pickle/no-unlimited-disable': 'error' },
  }], filePath);
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`${filePath} did not parse, so it was not measured: ${fatal.message}`);
  return messages.filter((m) => m.ruleId === 'pickle/no-unlimited-disable').map((m) => m.line);
}

const RULE_LESS_DISABLES = {
  'line comment, next-line, with reason': { code: '// eslint-disable-next-line -- why\nconst a = 1;\n', line: 1 },
  'block comment, next-line': { code: '/* eslint-disable-next-line */\nconst a = 1;\n', line: 1 },
  'line comment, same line': { code: 'const a = 1; // eslint-disable-line\n', line: 1 },
  'block comment, same line, with reason': { code: 'const a = 1; /* eslint-disable-line -- why */\n', line: 1 },
  'block comment, file-wide': { code: 'const b = 2;\n/* eslint-disable */\nconst a = 1;\n', line: 2 },
  'after a directive naming this rule': {
    code: '/* eslint-disable pickle/no-unlimited-disable */\nconst b = 2;\n// eslint-disable-next-line\nconst a = 1;\n',
    line: 3,
  },
};

describe('M3 (GitHub #21): pickle/no-unlimited-disable', () => {
  it('M3-2: a fresh rule-less disable is flagged on its own line in every directive shape', () => {
    for (const [shape, { code, line }] of Object.entries(RULE_LESS_DISABLES)) {
      assert.deepEqual(unlimitedDisableLines(code), [line], `rule-less disable not flagged: ${shape}`);
    }
  });

  it('M3-2: the lint-leg rule reports a rule-less next-line directive under normal inline config', () => {
    for (const shape of ['line comment, next-line, with reason', 'block comment, next-line']) {
      const { code, line } = RULE_LESS_DISABLES[shape];
      assert.deepEqual(unlimitedDisableLines(code, { noInlineConfig: false }), [line], shape);
    }
  });

  it('M3-3: a scoped directive, a bare enable, and a JSDoc lookalike are not flagged', () => {
    const scoped = [
      '// eslint-disable-next-line no-console -- why\nconsole.log(1);\n',
      'console.log(1); // eslint-disable-line no-console\n',
      '/* eslint-disable no-console, complexity */\nconsole.log(1);\n',
      '/* eslint-disable no-console */\nconsole.log(1);\n/* eslint-enable */\n',
      '/** eslint-disable */\nconst a = 1;\n',
    ];
    for (const code of scoped) assert.deepEqual(unlimitedDisableLines(code), [], code);
  });

  it('M3-3: no rule-less eslint-disable directive exists anywhere under src/', () => {
    const files = fs.readdirSync(path.join(EXTENSION_ROOT, 'src'), { recursive: true })
      .filter((rel) => rel.endsWith('.ts'))
      .map((rel) => path.join('src', rel));
    assert.ok(files.length > 100, `scanned only ${files.length} src/ files — the census is not measuring the tree`);
    const offenders = files.flatMap((rel) =>
      unlimitedDisableLines(fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8'), { filePath: rel })
        .map((line) => `${rel}:${line}`));
    assert.deepEqual(offenders, [], `rule-less eslint-disable directive(s): ${offenders.join(', ')}`);
  });

  it('M3-5: stripping the rule list above either mux-runner ceiling function reds the scan there and nowhere else', () => {
    const rel = path.join('src', 'bin', 'mux-runner.ts');
    const lines = fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8').split('\n');
    const mutatedLines = ['export function correctPhantomDoneTickets(', 'async function runMuxRunnerMain('].map((head) => {
      const at = lines.findIndex((l) => l.startsWith(head));
      assert.ok(at > 0, `${head} not found in ${rel}`);
      const scoped = lines[at - 1];
      lines[at - 1] = scoped.replace(/(eslint-disable-next-line) .+? (--)/, '$1 $2');
      assert.notEqual(lines[at - 1], scoped, `${head} is not preceded by a scoped disable directive`);
      return at;
    });
    assert.deepEqual(unlimitedDisableLines(lines.join('\n'), { filePath: rel }), mutatedLines);
  });
});
