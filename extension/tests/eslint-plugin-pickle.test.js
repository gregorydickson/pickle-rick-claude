// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import pickle from '../eslint-plugin-pickle/index.js';
import eslintConfig from '../eslint.config.js';

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
