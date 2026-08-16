import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Hard invariant #3 in CLAUDE.md. Nothing in this repo — tooling
      // included — reads that directory.
      '_to_ignore/**',
      '.remember/**',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Match tsconfig's noUnusedLocals/noUnusedParameters, which already treat
      // a leading underscore as "declared on purpose, not read yet". Without
      // this the two tools disagree and `_inputs` fails lint while passing
      // typecheck.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Browser-side packages.
  {
    files: ['packages/client/**/*.ts', 'tools/cityedit/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },

  // Node/Worker-side packages.
  {
    files: ['packages/server/**/*.ts', 'tools/loadtest/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // The pure packages. `any` is banned outright here, not merely discouraged —
  // an `any` in the sim is how a float sneaks into hashed state.
  //
  // S-02 layers the real purity gate on top of this block: no-restricted-globals,
  // no-restricted-properties for Date.now/Math.random/Math.sin/…, and
  // no-restricted-imports for anything outside @deadhead/sim and @deadhead/proto.
  {
    files: ['packages/sim/**/*.ts', 'packages/proto/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
