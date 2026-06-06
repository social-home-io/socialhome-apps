// ESLint flat config (ESLint 9+/10). Mirrors the socialhome SPA's lint
// contract, minus the preact-specific rules — the apps + SDK here are vanilla
// TypeScript (no preact / no @preact/signals), so react-hooks and the
// signal-in-component rule don't apply.
import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import globals from 'globals'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'dist-tars/**',
      '**/*.config.ts',
      '**/*.config.mjs',
      '**/*.config.js',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  {
    // `no-useless-assignment` (new in eslint:recommended) false-positives on
    // the init-then-conditionally-reassign pattern (`let x = ""` then set in
    // every if/else branch). Disabled to match the socialhome SPA's contract.
    rules: { 'no-useless-assignment': 'off' },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Test files run under Vitest globals.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
]
