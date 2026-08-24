/**
 * eslint-plugin-pickle — architectural lint rules for Pickle Rick.
 *
 * Rules:
 *   pickle/no-raw-state-write    — must use writeStateFile(), not raw fs.writeFileSync on state
 *   pickle/cli-guard-basename    — CLI guards must use path.basename(process.argv[1]) === '...'
 *   pickle/hook-decision-values  — hook decisions must be "approve" or "block", never "allow"
 *   pickle/no-unsafe-error-cast  — catch bindings require instanceof Error guard before .message/.stack/.code
 *   pickle/no-bare-extension-dir — EXTENSION_DIR reads must go through getExtensionRoot()
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if a node is `fs.writeFileSync` */
function isFsWriteFileSync(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'fs' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'writeFileSync'
  );
}

/** Check if a node resolves to a string containing "state.json" */
function refersToStateJson(node) {
  if (!node) return false;
  // Literal: "...state.json..."
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value.includes('state.json');
  }
  // Template literal
  if (node.type === 'TemplateLiteral') {
    return node.quasis.some((q) => q.value.raw.includes('state.json'));
  }
  // Variable named statePath, stateFile, etc.
  if (node.type === 'Identifier') {
    return /state/i.test(node.name) && /path|file/i.test(node.name);
  }
  // path.join(..., 'state.json') — any argument containing 'state.json'
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'path' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'join'
  ) {
    return node.arguments.some((arg) => refersToStateJson(arg));
  }
  return false;
}

/** Check if node is `process.argv[1]` */
function isProcessArgv1(node) {
  return (
    node.type === 'MemberExpression' &&
    node.computed === true &&
    node.object.type === 'MemberExpression' &&
    node.object.object.type === 'Identifier' &&
    node.object.object.name === 'process' &&
    node.object.property.type === 'Identifier' &&
    node.object.property.name === 'argv' &&
    node.property.type === 'Literal' &&
    node.property.value === 1
  );
}

/** Check if node is `path.basename(process.argv[1])` */
function isPathBasenameArgv1(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'path' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'basename' &&
    node.arguments.length >= 1 &&
    isProcessArgv1(node.arguments[0])
  );
}

/** Walk up to find enclosing CatchClause */
function getEnclosingCatch(node) {
  let current = node;
  while (current) {
    if (current.type === 'CatchClause') return current;
    current = current.parent;
  }
  return null;
}

/**
 * Check if an instanceof Error guard exists for `name` in the same scope,
 * before the given node. We look for `name instanceof Error` in the
 * condition of an enclosing IfStatement or ConditionalExpression.
 */
function hasInstanceofGuard(node, paramName) {
  let current = node.parent;
  while (current) {
    // Ternary: param instanceof Error ? param.message : ...
    if (current.type === 'ConditionalExpression' && current.consequent) {
      if (isInstanceofErrorCheck(current.test, paramName)) return true;
    }
    // If statement: if (param instanceof Error)
    if (current.type === 'IfStatement') {
      if (isInstanceofErrorCheck(current.test, paramName)) return true;
    }
    // Logical AND: param instanceof Error && param.message
    if (current.type === 'LogicalExpression' && current.operator === '&&') {
      if (isInstanceofErrorCheck(current.left, paramName)) return true;
    }
    current = current.parent;
  }
  return false;
}

function isInstanceofErrorCheck(test, paramName) {
  if (!test) return false;
  if (
    test.type === 'BinaryExpression' &&
    test.operator === 'instanceof' &&
    test.left.type === 'Identifier' &&
    test.left.name === paramName &&
    test.right.type === 'Identifier' &&
    test.right.name === 'Error'
  ) {
    return true;
  }
  // Handle negated or compound: !(x instanceof Error), x instanceof Error || ...
  if (test.type === 'LogicalExpression') {
    return (
      isInstanceofErrorCheck(test.left, paramName) ||
      isInstanceofErrorCheck(test.right, paramName)
    );
  }
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    return isInstanceofErrorCheck(test.argument, paramName);
  }
  return false;
}

function isBareConvergenceHistoryAccess(node) {
  if (node.computed || node.optional) return false;
  if (node.property.type !== 'Identifier' || node.property.name !== 'history') return false;
  const object = node.object;
  if (object.type !== 'MemberExpression') return false;
  if (object.computed || object.optional) return false;
  return object.property.type === 'Identifier' && object.property.name === 'convergence';
}

function isProcessEnvExtensionDir(node) {
  if (node.computed || node.optional) return false;
  if (node.property.type !== 'Identifier' || node.property.name !== 'EXTENSION_DIR') return false;

  const object = node.object;
  if (object.type !== 'MemberExpression') return false;
  if (object.computed || object.optional) return false;
  if (object.property.type !== 'Identifier' || object.property.name !== 'env') return false;
  return object.object.type === 'Identifier' && object.object.name === 'process';
}

// ─── Rules ──────────────────────────────────────────────────────────────────

/** Check if a node is a call to `writeStateFile` (bare identifier) */
function isWriteStateFileCall(callee) {
  return callee.type === 'Identifier' && callee.name === 'writeStateFile';
}

/** Check if a node is sm.forceWrite() or *.forceWrite() */
function isForceWriteCall(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'forceWrite'
  );
}

const noRawStateWrite = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow raw state.json writes — use StateManager.update() / forceWrite()',
    },
    messages: {
      useWriteStateFile:
        'Use writeStateFile() instead of fs.writeFileSync for state.json. Raw writes risk corruption on crash.',
      useStateManager:
        'Use StateManager.update() or StateManager.forceWrite() instead of writeStateFile() for state.json. Direct writes bypass lock protection.',
      forceWriteNeedsComment:
        'StateManager.forceWrite() bypasses lock protection. Add eslint-disable comment explaining why lock cannot be acquired (e.g. signal handler crash path).',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Allow state-manager.ts (uses writeStateFile internally) and pickle-utils.ts (defines it)
    if (/state-manager\.[tj]s$/.test(filename)) return {};
    if (/pickle-utils\.[tj]s$/.test(filename)) return {};

    return {
      CallExpression(node) {
        // Flag fs.writeFileSync on state.json
        if (isFsWriteFileSync(node.callee)) {
          const firstArg = node.arguments[0];
          if (refersToStateJson(firstArg)) {
            context.report({ node, messageId: 'useWriteStateFile' });
          }
          return;
        }
        // Flag writeStateFile() on state.json
        if (isWriteStateFileCall(node.callee)) {
          const firstArg = node.arguments[0];
          if (refersToStateJson(firstArg)) {
            context.report({ node, messageId: 'useStateManager' });
          }
          return;
        }
        // Flag sm.forceWrite() on state.json — requires eslint-disable with justification
        if (isForceWriteCall(node.callee)) {
          const firstArg = node.arguments[0];
          if (refersToStateJson(firstArg)) {
            context.report({ node, messageId: 'forceWriteNeedsComment' });
          }
        }
      },
    };
  },
};

const cliGuardBasename = {
  meta: {
    type: 'problem',
    docs: {
      description: 'CLI entry guards must use path.basename(process.argv[1]) === "file.js"',
    },
    messages: {
      requireBasename:
        'Use `path.basename(process.argv[1]) === "file.js"` for CLI guards. Never use startsWith/endsWith/includes or bare equality on process.argv[1].',
    },
    schema: [],
  },
  create(context) {
    return {
      // Catch: process.argv[1].startsWith / endsWith / includes
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          isProcessArgv1(callee.object) &&
          callee.property.type === 'Identifier' &&
          ['startsWith', 'endsWith', 'includes'].includes(callee.property.name)
        ) {
          context.report({ node, messageId: 'requireBasename' });
        }
      },
      // Catch: process.argv[1] === "..." (without basename)
      BinaryExpression(node) {
        if (node.operator !== '===' && node.operator !== '==') return;
        const leftIsArgv1 = isProcessArgv1(node.left);
        const rightIsArgv1 = isProcessArgv1(node.right);
        if (!leftIsArgv1 && !rightIsArgv1) return;
        // OK if the other side is path.basename(process.argv[1])
        // But if raw process.argv[1] is directly compared to a literal, flag it
        const otherSide = leftIsArgv1 ? node.right : node.left;
        if (otherSide.type === 'Literal' && typeof otherSide.value === 'string') {
          context.report({ node, messageId: 'requireBasename' });
        }
      },
    };
  },
};

const hookDecisionValues = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Hook decisions must be "approve" or "block", never "allow"',
    },
    messages: {
      noAllow:
        'Hook decision "allow" is not recognized by Claude Code. Use "approve" or "block".',
      invalidDecision:
        'Hook decision must be "approve" or "block". Got "{{value}}".',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const inHooks = /hooks[/\\]/.test(filename);
    if (!inHooks) return {};

    return {
      // Flag decision property with wrong value
      Property(node) {
        if (
          node.key.type === 'Identifier' &&
          node.key.name === 'decision' &&
          node.value.type === 'Literal' &&
          typeof node.value.value === 'string'
        ) {
          if (node.value.value === 'allow') {
            context.report({ node: node.value, messageId: 'noAllow' });
          } else if (node.value.value !== 'approve' && node.value.value !== 'block') {
            context.report({
              node: node.value,
              messageId: 'invalidDecision',
              data: { value: node.value.value },
            });
          }
        }
      },
    };
  },
};

const noUnsafeErrorCast = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Catch bindings require instanceof Error guard before accessing .message/.stack/.code',
    },
    messages: {
      requireGuard:
        'Accessing .{{prop}} on catch binding "{{name}}" without `instanceof Error` guard. Use: `{{name}} instanceof Error ? {{name}}.{{prop}} : String({{name}})`',
      noAsCastError:
        'Do not cast catch binding to Error with `as Error`. Use instanceof guard instead.',
    },
    schema: [],
  },
  create(context) {
    const dangerousProps = new Set(['message', 'stack', 'code', 'cause']);

    return {
      // Flag: (err as Error) via TSAsExpression
      TSAsExpression(node) {
        if (
          node.typeAnnotation &&
          node.typeAnnotation.type === 'TSTypeReference' &&
          node.typeAnnotation.typeName &&
          node.typeAnnotation.typeName.name === 'Error' &&
          node.expression.type === 'Identifier'
        ) {
          const catchClause = getEnclosingCatch(node);
          if (catchClause && catchClause.param && catchClause.param.name === node.expression.name) {
            context.report({
              node,
              messageId: 'noAsCastError',
            });
          }
        }
      },
      // Flag: err.message without guard
      MemberExpression(node) {
        if (node.computed) return;
        if (node.property.type !== 'Identifier') return;
        if (!dangerousProps.has(node.property.name)) return;
        if (node.object.type !== 'Identifier') return;

        const catchClause = getEnclosingCatch(node);
        if (!catchClause) return;
        if (!catchClause.param) return; // catch without binding

        const paramName =
          catchClause.param.type === 'Identifier' ? catchClause.param.name : null;
        if (!paramName) return;
        if (node.object.name !== paramName) return;

        if (!hasInstanceofGuard(node, paramName)) {
          context.report({
            node,
            messageId: 'requireGuard',
            data: { prop: node.property.name, name: paramName },
          });
        }
      },
    };
  },
};

const noBareConvergenceHistory = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct .convergence.history reads; worker convergence may omit metric history',
    },
    messages: {
      requireGuard:
        'Use optional chaining or an explicit metric-mode assertion before reading convergence history.',
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isBareConvergenceHistoryAccess(node)) {
          context.report({ node, messageId: 'requireGuard' });
        }
      },
    };
  },
};

const noBareExtensionDir = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct process.env.EXTENSION_DIR reads outside root-resolution bootstrap',
    },
    messages: {
      useHelper: 'Use getExtensionRoot() instead of reading process.env.EXTENSION_DIR directly.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    if (/[\\/]pickle-utils\.[tj]s$/.test(filename)) return {};
    if (/[\\/]dispatch\.[tj]s$/.test(filename)) return {};

    return {
      MemberExpression(node) {
        if (isProcessEnvExtensionDir(node)) {
          context.report({ node, messageId: 'useHelper' });
        }
      },
    };
  },
};

// ─── Rule: no-gemini-path ────────────────────────────────────────────────────

const noGeminiPath = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow ".gemini" in path strings — extension path is ~/.claude/pickle-rick',
    },
    messages: {
      noGemini:
        'Path contains ".gemini". The extension path is ~/.claude/pickle-rick, never .gemini.',
    },
    schema: [],
  },
  create(context) {
    function checkForGemini(node, value) {
      if (typeof value === 'string' && value.includes('.gemini')) {
        context.report({ node, messageId: 'noGemini' });
      }
    }
    return {
      Literal(node) {
        checkForGemini(node, node.value);
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          checkForGemini(node, quasi.value.raw);
        }
      },
    };
  },
};

// ─── Rule: no-deployed-file-edit ─────────────────────────────────────────────

const DEPLOYED_PATH_PATTERN = /~\/\.claude\/pickle-rick\/|\/\.claude\/pickle-rick\//;

const noDeployedFileEdit = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow writing to deployed ~/.claude/pickle-rick/ files — edit source, run install.sh',
    },
    messages: {
      noDeployedWrite:
        'Do not write to deployed files under ~/.claude/pickle-rick/. Edit extension/src/ and run install.sh.',
    },
    schema: [],
  },
  create(context) {
    const writeMethods = new Set(['writeFileSync', 'writeSync', 'renameSync', 'unlinkSync', 'appendFileSync']);

    function refersToDeployedPath(node) {
      if (!node) return false;
      if (node.type === 'Literal' && typeof node.value === 'string') {
        return DEPLOYED_PATH_PATTERN.test(node.value);
      }
      if (node.type === 'TemplateLiteral') {
        return node.quasis.some((q) => DEPLOYED_PATH_PATTERN.test(q.value.raw));
      }
      return false;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'fs' &&
          callee.property.type === 'Identifier' &&
          writeMethods.has(callee.property.name)
        ) {
          const firstArg = node.arguments[0];
          if (refersToDeployedPath(firstArg)) {
            context.report({ node, messageId: 'noDeployedWrite' });
          }
        }
      },
    };
  },
};

// ─── Rule: require-number-validation ─────────────────────────────────────────

const requireNumberValidation = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Number() calls on state fields must be followed by Number.isFinite() guard',
    },
    messages: {
      requireIsFinite:
        'Number({{arg}}) must be guarded with Number.isFinite(). Use: `const raw = Number({{arg}}); const val = Number.isFinite(raw) ? raw : 0;`',
    },
    schema: [],
  },
  create(context) {
    // Track variables assigned from Number() calls
    const numberVars = new Map();

    return {
      // Collect: const raw = Number(state.foo)
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === 'Number' &&
          node.init.arguments.length >= 1
        ) {
          const arg = node.init.arguments[0];
          // Only flag state-related args (state.foo, settings.bar, etc.)
          if (arg.type === 'MemberExpression') {
            const varName = node.id.type === 'Identifier' ? node.id.name : null;
            if (varName) {
              numberVars.set(varName, { node: node.init, arg: context.sourceCode.getText(arg) });
            }
          }
        }
      },
      // Check that the variable is used inside Number.isFinite()
      'Program:exit'() {
        const sourceText = context.sourceCode.getText();
        for (const [varName, info] of numberVars) {
          // Look for Number.isFinite(varName) anywhere in the source
          const pattern = new RegExp(`Number\\.isFinite\\(\\s*${varName}\\s*\\)`);
          if (!pattern.test(sourceText)) {
            context.report({
              node: info.node,
              messageId: 'requireIsFinite',
              data: { arg: info.arg },
            });
          }
        }
      },
    };
  },
};

// ─── Rule: no-process-exit-in-library ────────────────────────────────────────

const noProcessExitInLibrary = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow process.exit() in services/ files — services should throw, only bin/ scripts may exit',
    },
    messages: {
      noExitInService:
        'Do not call process.exit() in service/library files. Throw an error instead — let the caller decide how to exit.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const inServices = /services[/\\]/.test(filename);
    if (!inServices) return {};

    return {
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'process' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'exit'
        ) {
          context.report({ node, messageId: 'noExitInService' });
        }
      },
    };
  },
};

// ─── Rule: promise-token-format ──────────────────────────────────────────────

const KNOWN_TOKENS = [
  'EPIC_COMPLETED', 'TASK_COMPLETED', 'EXISTENCE_IS_PAIN',
  'THE_CITADEL_APPROVES', 'PRD_COMPLETE', 'TICKET_SELECTED',
  'ANALYSIS_DONE', 'I AM DONE',
];

const promiseTokenFormat = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Promise tokens must be referenced via PromiseTokens enum, not hardcoded strings',
    },
    messages: {
      useEnum:
        'Hardcoded promise token "{{token}}" — use PromiseTokens.* from types/index.js instead.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    // Allow the definition files (canonical sources of truth)
    if (/types[/\\]index\./.test(filename)) return {};
    if (/services[/\\]promise-tokens\./.test(filename)) return {};
    // Allow test files
    if (/tests?[/\\]/.test(filename)) return {};

    function checkToken(node, value) {
      if (typeof value !== 'string') return;
      for (const token of KNOWN_TOKENS) {
        if (value === token) {
          context.report({ node, messageId: 'useEnum', data: { token } });
          return;
        }
      }
    }

    return {
      Literal(node) {
        checkToken(node, node.value);
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          for (const token of KNOWN_TOKENS) {
            if (quasi.value.raw.includes(token)) {
              context.report({ node, messageId: 'useEnum', data: { token } });
              return;
            }
          }
        }
      },
    };
  },
};

// ─── Rule: no-sync-in-async ──────────────────────────────────────────────────

const SYNC_FS_METHODS = new Set([
  'readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync',
  'mkdirSync', 'unlinkSync', 'renameSync', 'statSync', 'readdirSync',
  'copyFileSync', 'chmodSync', 'accessSync', 'openSync', 'closeSync',
  'writeSync', 'readSync',
]);

const noSyncInAsync = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Flag synchronous fs calls inside async functions — prefer async alternatives',
    },
    messages: {
      preferAsync:
        'Synchronous fs.{{method}}() inside async function. Consider using fs.promises.{{asyncAlt}}() to avoid blocking the event loop.',
    },
    schema: [],
  },
  create(context) {
    const asyncStack = [];

    function enterFunction(node) {
      asyncStack.push(node.async === true);
    }
    function exitFunction() {
      asyncStack.pop();
    }
    function isInAsync() {
      return asyncStack.length > 0 && asyncStack[asyncStack.length - 1];
    }

    const ASYNC_ALTS = {
      readFileSync: 'readFile', writeFileSync: 'writeFile', appendFileSync: 'appendFile',
      existsSync: 'access', mkdirSync: 'mkdir', unlinkSync: 'unlink',
      renameSync: 'rename', statSync: 'stat', readdirSync: 'readdir',
      copyFileSync: 'copyFile', chmodSync: 'chmod', accessSync: 'access',
      openSync: 'open', closeSync: 'close', writeSync: 'write', readSync: 'read',
    };

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exitFunction,
      CallExpression(node) {
        if (!isInAsync()) return;
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'fs' &&
          callee.property.type === 'Identifier' &&
          SYNC_FS_METHODS.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: 'preferAsync',
            data: {
              method: callee.property.name,
              asyncAlt: ASYNC_ALTS[callee.property.name] || callee.property.name.replace('Sync', ''),
            },
          });
        }
      },
    };
  },
};

// ─── Rule: spawn-error-handler ───────────────────────────────────────────────

const spawnErrorHandler = {
  meta: {
    type: 'problem',
    docs: {
      description: 'spawn()/exec() calls must have a .on("error") handler',
    },
    messages: {
      requireErrorHandler:
        '{{method}}() call must have a .on("error") handler to catch spawn failures (ENOENT, EACCES, etc.).',
    },
    schema: [],
  },
  create(context) {
    const spawnMethods = new Set(['spawn', 'exec', 'execFile']);
    const spawnVars = new Map(); // varName → node

    return {
      // Track: const proc = spawn(...)
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          spawnMethods.has(node.init.callee.name) &&
          node.id.type === 'Identifier'
        ) {
          spawnVars.set(node.id.name, node.init);
        }
      },
      // Track: proc.on('error', ...)
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'on' &&
          node.callee.object.type === 'Identifier' &&
          node.arguments.length >= 2 &&
          node.arguments[0].type === 'Literal' &&
          node.arguments[0].value === 'error'
        ) {
          spawnVars.delete(node.callee.object.name);
        }
      },
      'Program:exit'() {
        for (const [varName, node] of spawnVars) {
          // Check source for .on('error') with this var (handles chaining patterns)
          const sourceText = context.sourceCode.getText();
          const chainPattern = new RegExp(`${varName}\\.on\\(\\s*['"]error['"]`);
          if (!chainPattern.test(sourceText)) {
            context.report({
              node,
              messageId: 'requireErrorHandler',
              data: { method: sourceText.slice(node.range?.[0] ?? 0, (node.range?.[0] ?? 0) + 5).includes('exec') ? 'exec' : 'spawn' },
            });
          }
        }
      },
    };
  },
};

// ─── Rule: no-hardcoded-timeout ──────────────────────────────────────────────

const noHardcodedTimeout = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Timeouts >5000ms should come from settings or Defaults, not magic numbers',
    },
    messages: {
      useConfig:
        'Hardcoded timeout {{value}}ms. Use pickle_settings.json or Defaults.* constant instead of magic numbers.',
    },
    schema: [],
  },
  create(context) {
    const timeoutFunctions = new Set(['setTimeout', 'sleep']);

    return {
      CallExpression(node) {
        let funcName = null;
        if (node.callee.type === 'Identifier') {
          funcName = node.callee.name;
        }
        if (!funcName || !timeoutFunctions.has(funcName)) return;

        // sleep(n) — first arg; setTimeout(fn, n) — second arg
        const argIndex = funcName === 'setTimeout' ? 1 : 0;
        const arg = node.arguments[argIndex];
        if (!arg) return;

        if (arg.type === 'Literal' && typeof arg.value === 'number' && arg.value > 5000) {
          context.report({
            node,
            messageId: 'useConfig',
            data: { value: String(arg.value) },
          });
        }
      },
    };
  },
};

// ─── Rule: require-max-buffer-on-capture ─────────────────────────────────────
//
// did-we-count AC-1'/AC-4' (ticket d7c017ff), covers 7e06e8b2 / e2804228 / d24cec5e:
// a spawnSync/execSync/execFileSync call that captures string output (an `encoding`
// option) but has no `maxBuffer` falls back to Node's 1MB default. Node SIGTERMs the
// child past that ceiling and returns a truncated/absent result the caller cannot
// distinguish from a legitimate failure — see the AP-EXT-ITER8-01 trap door in
// extension/src/services/CLAUDE.md.

const CAPTURE_METHODS = new Set(['spawnSync', 'execSync', 'execFileSync']);

function isCaptureCall(callee) {
  if (callee.type === 'Identifier') return CAPTURE_METHODS.has(callee.name);
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return CAPTURE_METHODS.has(callee.property.name);
  }
  return false;
}

/**
 * Bounded single-fact probes (`git rev-parse`, `ps -p <pid>`, `--version`, ...) are
 * legitimately unbounded-maxBuffer by construction — the codebase's own trap-door
 * catalog names this class repeatedly ("NOT matches: single-line rev-parse/cat-file
 * -e/show -s/--version probes, ps -p <pid>/lsof -t/pgrep reads"). A blanket
 * encoding-without-maxBuffer check fires on ~80 such call sites tree-wide and is
 * exactly the noise AC-4' forbids shipping. This narrows to the shapes the
 * did-we-count corpus's own detectable shas actually are: an arbitrary/templated
 * command (`shell:true`, or execSync's inherently-shelled single-string form) or a
 * known whole-tree/whole-output git enumeration subcommand, or an npm/pnpm/yarn
 * `run <script>` invocation (arbitrary build/test output).
 */
const UNBOUNDED_GIT_SUBCOMMANDS = ['ls-files', 'status', 'diff', 'log', 'blame', 'grep'];
const UNBOUNDED_GIT_SUBCOMMAND_RE = new RegExp(`\\bgit\\s+(${UNBOUNDED_GIT_SUBCOMMANDS.join('|')})\\b`);

/** Best-effort literal text of a string Literal or a no-substitution TemplateLiteral. */
function staticStringValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.raw).join(' ');
  return null;
}

function hasUnboundedShape(node, optionsArg) {
  const calleeName = node.callee.type === 'Identifier' ? node.callee.name : node.callee.property.name;
  if (calleeName === 'execSync') {
    // Single templated/string command, always shell-executed — apply the same
    // enumeration/run-script text shape check rather than treating every execSync
    // call as unbounded (a bounded probe like `execSync('git config user.email')`
    // must not fire).
    const cmdText = staticStringValue(node.arguments[0]) ?? '';
    return UNBOUNDED_GIT_SUBCOMMAND_RE.test(cmdText) || /\brun\b/.test(cmdText);
  }
  if (optionsArg) {
    const shellProp = optionsArg.properties.find(
      (p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'shell',
    );
    if (shellProp && shellProp.value.type === 'Literal' && shellProp.value.value === true) return true;
  }
  const firstArg = node.arguments[0];
  const argvArg = node.arguments[1];
  const isGit = firstArg && firstArg.type === 'Literal' && firstArg.value === 'git';
  if (isGit && argvArg && argvArg.type === 'ArrayExpression') {
    const hasUnboundedSubcommand = argvArg.elements.some(
      (el) => el && el.type === 'Literal' && typeof el.value === 'string' && UNBOUNDED_GIT_SUBCOMMANDS.includes(el.value),
    );
    if (hasUnboundedSubcommand) return true;
  }
  if (argvArg && argvArg.type === 'ArrayExpression') {
    const hasRunLiteral = argvArg.elements.some((el) => el && el.type === 'Literal' && el.value === 'run');
    if (hasRunLiteral) return true;
  }
  return false;
}

const requireMaxBufferOnCapture = {
  meta: {
    type: 'problem',
    docs: {
      description: 'spawnSync/execSync/execFileSync calls that capture unbounded output must set maxBuffer',
    },
    messages: {
      requireMaxBuffer:
        '{{method}}() captures potentially unbounded output (encoding set, shell/enumeration/run-script shape) but has no maxBuffer — Node\'s 1MB default silently truncates large output past the ceiling. Set maxBuffer explicitly (e.g. a shared UNBOUNDED_READ_MAX_BUFFER constant).',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isCaptureCall(node.callee)) return;
        const optionsArg = node.arguments[node.arguments.length - 1];
        const hasOptionsObject = optionsArg && optionsArg.type === 'ObjectExpression';
        const props = hasOptionsObject
          ? optionsArg.properties.filter((p) => p.type === 'Property' && p.key.type === 'Identifier')
          : [];
        const hasEncoding = hasOptionsObject && props.some((p) => p.key.name === 'encoding');
        const hasMaxBuffer = hasOptionsObject && props.some((p) => p.key.name === 'maxBuffer');
        const calleeName = node.callee.type === 'Identifier' ? node.callee.name : node.callee.property.name;
        // execSync captures by default (return value is the output) even without an
        // explicit `encoding` option surviving to a Buffer-vs-string distinction —
        // but scope this rule to the string-capture form to keep the same "how do we
        // know this call reads output at all" signal the other two methods use.
        const capturesOutput = calleeName === 'execSync' ? true : hasEncoding;
        if (!capturesOutput || hasMaxBuffer) return;
        if (!hasUnboundedShape(node, hasOptionsObject ? optionsArg : null)) return;
        context.report({ node, messageId: 'requireMaxBuffer', data: { method: calleeName } });
      },
    };
  },
};

// ─── Rule: require-spawn-result-error-check ──────────────────────────────────
//
// did-we-count AC-1'/AC-4' (ticket d7c017ff), covers c7c85ef3: a spawnSync() result
// completion check that tests only `.status` misses the shape where the child EXITS
// before Node's maxBuffer-overflow SIGTERM lands — `status: 0, signal: null,
// error.code: 'ENOBUFS'` — so a truncated read is reported as a complete, successful
// enumeration. The fix ORs in a `.error` check on the same result object.

const requireSpawnResultErrorCheck = {
  meta: {
    type: 'problem',
    docs: {
      description: 'a spawnSync() result completion check must also test .error, not just .status',
    },
    messages: {
      requireErrorCheck:
        'This check tests {{varName}}.status but never {{varName}}.error — a spawnSync() child that exits before a maxBuffer-overflow SIGTERM lands returns status:0 with error.code:\'ENOBUFS\', which this check would read as a complete, successful result.',
    },
    schema: [],
  },
  create(context) {
    const spawnSyncVars = new Set();

    function referencesProperty(node, varName, propName) {
      let found = false;
      function walk(n) {
        if (!n || typeof n !== 'object' || found) return;
        if (
          n.type === 'MemberExpression' &&
          n.object.type === 'Identifier' &&
          n.object.name === varName &&
          n.property.type === 'Identifier' &&
          n.property.name === propName
        ) {
          found = true;
          return;
        }
        for (const key of Object.keys(n)) {
          if (key === 'parent') continue;
          const value = n[key];
          if (Array.isArray(value)) {
            for (const item of value) {
              if (item && typeof item.type === 'string') walk(item);
            }
          } else if (value && typeof value.type === 'string') {
            walk(value);
          }
        }
      }
      walk(node);
      return found;
    }

    return {
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          isSpawnSyncCallee(node.init.callee) &&
          node.id.type === 'Identifier' &&
          callCapturesTextOutput(node.init)
        ) {
          spawnSyncVars.add(node.id.name);
        }
      },
      IfStatement(node) {
        for (const varName of spawnSyncVars) {
          if (!referencesProperty(node.test, varName, 'status')) continue;
          if (referencesProperty(node.test, varName, 'error')) continue;
          context.report({ node: node.test, messageId: 'requireErrorCheck', data: { varName } });
        }
      },
    };
  },
};

function isSpawnSyncCallee(callee) {
  if (callee.type === 'Identifier') return callee.name === 'spawnSync';
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name === 'spawnSync';
  }
  return false;
}

/**
 * AC-4' narrowing: a bare `.status`-only completion check is only the c7c85ef3 defect
 * shape when the call both captures text output (`encoding` option) AND reads an
 * unbounded enumeration — the same `hasUnboundedShape` signal `require-max-buffer-
 * on-capture` uses, matching c7c85ef3's own `git diff --staged --name-only` shape.
 * `encoding` alone is not enough: bounded single-fact probes (`lsof -t`, `pgrep -f`)
 * also set `encoding` and were 41 of the 43 whole-tree hits measured before this
 * check was added — the exact "fires on more than it can justify" noise AC-4' forbids.
 */
function callCapturesTextOutput(node) {
  const optionsArg = node.arguments[node.arguments.length - 1];
  if (!optionsArg || optionsArg.type !== 'ObjectExpression') return false;
  const hasEncoding = optionsArg.properties.some(
    (p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'encoding',
  );
  if (!hasEncoding) return false;
  return hasUnboundedShape(node, optionsArg);
}

// ─── Rule: no-invalid-checkout-index-stage ────────────────────────────────────
//
// did-we-count AC-1'/AC-4' (ticket d7c017ff), covers 0cf3b8e3: git's `checkout-index
// --stage` flag only accepts 1|2|3|all; `--stage=0` is always a hard error (exit 128,
// "fatal: stage should be between 1 and 3 or all"). Omitting the flag entirely IS
// stage 0 (the merged index entry) — there is no legitimate reason to ever write the
// literal `--stage=0`.

const noInvalidCheckoutIndexStage = {
  meta: {
    type: 'problem',
    docs: {
      description: "git checkout-index's --stage flag only accepts 1|2|3|all; '--stage=0' always hard-errors",
    },
    messages: {
      invalidStage:
        "'--stage=0' is invalid git argv — checkout-index accepts --stage=1|2|3|all only, and always exits 128 on 0. Omit the flag entirely for stage 0 (the merged index entry).",
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (node.value === '--stage=0') {
          context.report({ node, messageId: 'invalidStage' });
        }
      },
    };
  },
};

// ─── Rule: require-group-kill-for-spawned-child ───────────────────────────────
//
// did-we-count AC-1'/AC-4' (ticket d7c017ff), covers ff8d4739 / 41b9b255: a subprocess
// spawned via spawn()/<ns>.spawn() that is later reaped via a bare `.kill(signal)`
// call, with no killProcessGroup() call anywhere in the enclosing function. If the
// spawned process is a subtree root (spawns its own children — a shell, an npm
// script, a CLI that shells out), a bare pid kill leaves the grandchildren orphaned
// to re-parent to PID 1 and outlive the caller. Scoped per-function (not per-module)
// because killProcessGroup is legitimately called elsewhere in the same file for
// unrelated pids.

const requireGroupKillForSpawnedChild = {
  meta: {
    type: 'problem',
    docs: {
      description: 'a spawned child later .kill()-ed directly should be reaped via killProcessGroup if it may be a subtree root',
    },
    messages: {
      requireGroupKill:
        '{{varName}} was spawned via spawn() and is later .kill()-ed directly, but the enclosing function never calls killProcessGroup(). If this process is a subtree root (spawns its own children), a bare kill orphans them. Route through killProcessGroup() first, falling back to a direct kill.',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const functionStack = [];

    function isFunctionNode(node) {
      return (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
      );
    }

    function isSpawnCallee(callee) {
      if (callee.type === 'Identifier') return callee.name === 'spawn';
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        return callee.property.name === 'spawn';
      }
      return false;
    }

    function findOwnerFrame(varName) {
      for (let i = functionStack.length - 1; i >= 0; i--) {
        if (functionStack[i].spawnVars.has(varName)) return functionStack[i];
      }
      return null;
    }

    return {
      ':function'(node) {
        if (isFunctionNode(node)) functionStack.push({ node, spawnVars: new Set(), killCalls: [] });
      },
      VariableDeclarator(node) {
        if (functionStack.length === 0) return;
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          isSpawnCallee(node.init.callee) &&
          node.id.type === 'Identifier'
        ) {
          functionStack[functionStack.length - 1].spawnVars.add(node.id.name);
        }
      },
      'CallExpression:exit'(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'kill' &&
          node.callee.object.type === 'Identifier'
        ) {
          const owner = findOwnerFrame(node.callee.object.name);
          if (owner) owner.killCalls.push({ node, varName: node.callee.object.name });
        }
      },
      ':function:exit'(node) {
        if (!isFunctionNode(node)) return;
        const frame = functionStack.pop();
        if (frame.killCalls.length === 0) return;
        const fnText = sourceCode.getText(frame.node);
        // Accept the documented delegates too (src/bin/CLAUDE.md R-OMTD /
        // R-CXHANG AC-CXHANG-3): killProcessTree (spawn-morty.ts) and
        // reapChildSubtree (pipeline-runner.ts) both internally route through
        // killProcessGroup — a caller of either already gets group-kill safety.
        if (/killProcessGroup\s*\(|killProcessTree\s*\(|reapChildSubtree\s*\(|reapTaskSubtree\s*\(/.test(fnText)) return;
        for (const { node: killNode, varName } of frame.killCalls) {
          context.report({ node: killNode, messageId: 'requireGroupKill', data: { varName } });
        }
      },
    };
  },
};

// ─── Plugin Export ───────────────────────────────────────────────────────────

const plugin = {
  meta: {
    name: 'eslint-plugin-pickle',
    version: '2.0.0',
  },
  rules: {
    'no-raw-state-write': noRawStateWrite,
    'cli-guard-basename': cliGuardBasename,
    'hook-decision-values': hookDecisionValues,
    'no-unsafe-error-cast': noUnsafeErrorCast,
    'no-bare-convergence-history': noBareConvergenceHistory,
    'no-bare-extension-dir': noBareExtensionDir,
    'no-gemini-path': noGeminiPath,
    'no-deployed-file-edit': noDeployedFileEdit,
    'require-number-validation': requireNumberValidation,
    'no-process-exit-in-library': noProcessExitInLibrary,
    'promise-token-format': promiseTokenFormat,
    'no-sync-in-async': noSyncInAsync,
    'spawn-error-handler': spawnErrorHandler,
    'no-hardcoded-timeout': noHardcodedTimeout,
    'require-max-buffer-on-capture': requireMaxBufferOnCapture,
    'require-spawn-result-error-check': requireSpawnResultErrorCheck,
    'no-invalid-checkout-index-stage': noInvalidCheckoutIndexStage,
    'require-group-kill-for-spawned-child': requireGroupKillForSpawnedChild,
  },
};

export default plugin;
