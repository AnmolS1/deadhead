import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { simPurityConfig } from './packages/sim/eslint.purity.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // Vite's bundle output. Separate from `dist` because tsc writes there too.
      '**/dist-app/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Hard invariant #3 in CLAUDE.md. Nothing in this repo — tooling
      // included — reads that directory.
      '_to_ignore/**',
      '.remember/**',
      'docs/**',
      // Generated from packages/server/wrangler.jsonc by `wrangler types`, and
      // kept honest by `npm run types:check`. It carries its own
      // `/* eslint-disable */` plus inline directives that this config has no
      // rules for, which surface as "unused eslint-disable directive"
      // warnings — noise from a file nobody hand-edits.
      'packages/server/src/worker-configuration.d.ts',
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

  // Node/Worker-side packages. The `.mjs` glob is for build-time scripts that
  // are NOT part of the Worker bundle — `scripts/gen-auth-schema.mjs` runs in
  // Node and legitimately uses `process` and `console`, which the Worker code
  // beside it must not.
  {
    files: [
      'packages/server/**/*.ts',
      'packages/server/scripts/**/*.mjs',
      'tools/loadtest/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },

  // The purity gate (S-02). Lives in packages/sim/eslint.config.mjs next to the
  // code it governs, but must be spread in here: ESLint 9+ flat config does not
  // cascade into nested config files, so a config sitting there on its own would
  // never run. Spread LAST so nothing below relaxes it.
  ...simPurityConfig,
);
