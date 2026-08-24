import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pickle from './eslint-plugin-pickle/index.js';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { pickle },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      complexity: ['error', { max: 15 }],
      'max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true }],
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'preserve-caught-error': 'off',
      'pickle/no-raw-state-write': 'error',
      'pickle/cli-guard-basename': 'error',
      'pickle/hook-decision-values': 'error',
      'pickle/no-unsafe-error-cast': 'error',
      'pickle/no-bare-convergence-history': 'error',
      'pickle/no-bare-extension-dir': 'error',
      'pickle/no-gemini-path': 'error',
      'pickle/no-deployed-file-edit': 'error',
      'pickle/require-number-validation': 'error',
      'pickle/no-process-exit-in-library': 'error',
      'pickle/promise-token-format': 'error',
      'pickle/no-sync-in-async': 'warn',
      'pickle/spawn-error-handler': 'error',
      'pickle/no-hardcoded-timeout': 'error',
      // 'warn' not 'error': 10 (resp. 15) whole-tree hits exist today outside the
      // did-we-count corpus's already-fixed shas — real defects, but out of this
      // ticket's file-scope allowlist to fix. 'error' here would break the
      // `--max-warnings=-1` release gate on unrelated files this ticket cannot touch.
      'pickle/require-max-buffer-on-capture': 'warn',
      'pickle/require-spawn-result-error-check': 'warn',
      // 0 whole-tree hits for both — safe at 'error'.
      'pickle/no-invalid-checkout-index-stage': 'error',
      'pickle/require-group-kill-for-spawned-child': 'error',
    },
  },
  {
    files: ['src/services/dot-builder.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/bin/microverse-runner.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    ignores: ['bin/**', 'services/**', 'tests/**', '*.js', 'eslint.config.js', 'eslint-plugin-pickle/**'],
  },
);
