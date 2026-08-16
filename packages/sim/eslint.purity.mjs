/**
 * The purity gate — `S-02`.
 *
 * CLAUDE.md hard invariant #1 says `packages/sim` must run byte-identically in
 * the browser, in a Durable Object, and in a replay-validating Worker. This
 * file is what stops that rotting silently. It exports flat-config blocks that
 * the root `eslint.config.mjs` spreads in, so one `eslint .` run covers it.
 *
 * **Why this file is not named `eslint.config.mjs`,** which is what `S-02`'s
 * brief asks for. ESLint 10 resolves the nearest config file starting from the
 * *linted file's* directory, not from the cwd. A file at
 * `packages/sim/eslint.config.mjs` therefore becomes the authoritative config
 * for everything under `packages/sim/`, displacing the root config entirely —
 * and because the `files` globs below are written repo-root-relative, they
 * would resolve against `packages/sim/` and match nothing. The observed result
 * was every sim source file reported as "File ignored because no matching
 * configuration was supplied", with `eslint` still exiting 0.
 *
 * A purity gate that lints zero files passes forever, so
 * `scripts/validate/sim-purity.sh` asserts a non-zero file count rather than
 * trusting the exit code.
 *
 * The shell half of the gate is `scripts/validate/sim-purity.sh`, which scans
 * the *built* output and then proves these rules still bite by feeding ESLint
 * a deliberate violation. Neither half is sufficient alone: lint sees source
 * that might not be what ships, and grep sees output but cannot reason about
 * scope.
 *
 * Scope note: these rules apply to `src/` only. Tests are not shipped, and
 * `test/` legitimately imports `vitest`.
 */

/** Globals that do not exist in every one of the three target runtimes. */
const FORBIDDEN_GLOBALS = [
  ['window', 'no DOM in the sim — this is browser-only'],
  ['document', 'no DOM in the sim — this is browser-only'],
  ['navigator', 'no DOM in the sim — this is browser-only'],
  ['localStorage', 'no DOM in the sim — this is browser-only'],
  ['sessionStorage', 'no DOM in the sim — this is browser-only'],
  ['requestAnimationFrame', 'rendering drives rendering; it never drives the sim'],
  ['performance', 'wall-clock time is not an input to a deterministic sim'],
  ['Date', 'wall-clock time is not an input to a deterministic sim'],
  ['setTimeout', 'the sim advances only via step(); nothing here schedules itself'],
  ['setInterval', 'the sim advances only via step(); nothing here schedules itself'],
  ['queueMicrotask', 'the sim advances only via step(); nothing here schedules itself'],
  ['fetch', 'the sim performs no I/O'],
  ['XMLHttpRequest', 'the sim performs no I/O'],
  ['WebSocket', 'the sim performs no I/O'],
  ['crypto', 'use the seeded PRNG from rng.ts (S-04), never a CSPRNG'],
  ['process', 'no Node built-ins — this must run in workerd and in the browser'],
  ['globalThis', 'reaching for the global object is how a forbidden global sneaks back in'],
].map(([name, why]) => ({
  name,
  message: `${name} is banned in the sim: ${why}. See CLAUDE.md hard invariant #1.`,
}));

/**
 * `Math` members whose results are implementation-approximated by the
 * ECMAScript spec, so two engines may legitimately return different bits, plus
 * `Math.random` which is not a function of its arguments at all.
 *
 * `Math.sqrt` is in the list even though every mainstream engine rounds it per
 * IEEE 754: CLAUDE.md bans it explicitly, and `S-03` ships an integer Newton
 * `fxSqrt` instead. Do not relax this on the grounds that it "works everywhere".
 */
const FORBIDDEN_MATH = [
  'random',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sqrt',
  'cbrt',
  'pow',
  'exp',
  'expm1',
  'log',
  'log2',
  'log10',
  'log1p',
  'hypot',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
];

const FORBIDDEN_PROPERTIES = [
  ...FORBIDDEN_MATH.map((property) => ({
    object: 'Math',
    property,
    message:
      `Math.${property} is implementation-approximated and may differ between engines. ` +
      'Use the fixed-point equivalents in fx.ts (S-03). See CLAUDE.md hard invariant #1.',
  })),
  {
    object: 'Date',
    property: 'now',
    message: 'Wall-clock time is not an input to a deterministic sim. Use world.tick.',
  },
  {
    object: 'performance',
    property: 'now',
    message: 'Wall-clock time is not an input to a deterministic sim. Use world.tick.',
  },
];

/** Import specifiers the sim may reach for: relative paths, and `@deadhead/proto`. */
const ALLOWED_SIM_IMPORT = String.raw`^(\.{1,2}\/|@deadhead\/proto$)`;
/** `packages/proto` has no dependencies at all, so only relative paths. */
const ALLOWED_PROTO_IMPORT = String.raw`^\.{1,2}\/`;

/** Ban every module specifier that is not on the allow-list, in all three forms. */
const importRules = (allowed) =>
  [
    ['ImportDeclaration', 'import'],
    ['ExportNamedDeclaration[source]', 'export … from'],
    ['ExportAllDeclaration', 'export * from'],
  ].map(([node, label]) => ({
    selector: `${node}[source.value!=/${allowed}/]`,
    message:
      `This package takes no runtime dependencies, so a bare ${label} specifier is not allowed. ` +
      'Only relative paths and @deadhead/proto. See CLAUDE.md hard invariant #1.',
  }));

/** Ways to reach a banned `Math` member that a property rule cannot see. */
const MATH_LAUNDERING = [
  {
    selector: 'VariableDeclarator[init.name="Math"]',
    message: 'Aliasing Math defeats the purity gate. Reference Math members directly.',
  },
  {
    selector: 'MemberExpression[computed=true][object.name="Math"]',
    message: 'Computed access to Math defeats the purity gate. Use a static member.',
  },
  {
    selector: 'NewExpression[callee.name="Date"]',
    message: 'Wall-clock time is not an input to a deterministic sim. Use world.tick.',
  },
];

const FORBIDDEN_GLOBAL_BINDINGS = Object.fromEntries(
  FORBIDDEN_GLOBALS.map(({ name }) => [name, 'readonly']),
);

const sharedPurityRules = {
  'no-restricted-globals': ['error', ...FORBIDDEN_GLOBALS],
  'no-restricted-properties': ['error', ...FORBIDDEN_PROPERTIES],
  // Floats are permitted in the renderer and nowhere upstream. `any` in the sim
  // is how one gets into hashed state without anybody noticing.
  '@typescript-eslint/no-explicit-any': 'error',
};

/**
 * Flat-config blocks enforcing sim purity. Spread into the root config **last**,
 * so nothing later relaxes them.
 */
export const simPurityConfig = [
  {
    name: 'deadhead/sim-purity',
    files: ['packages/sim/src/**/*.ts'],
    languageOptions: {
      // Declared so `no-restricted-globals` has real bindings to match against
      // rather than relying on how it treats unresolved references. Declaring
      // them is what makes the rule fire; it does not make them usable.
      globals: FORBIDDEN_GLOBAL_BINDINGS,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    linterOptions: {
      // An `eslint-disable` comment must not be able to switch the purity gate
      // off. Verified: without this, a one-line disable directive suppresses the
      // rule entirely and only the dist scan in scripts/validate/sim-purity.sh
      // still catches it. Determinism is not a per-line judgement call.
      noInlineConfig: true,
    },
    rules: {
      ...sharedPurityRules,
      'no-restricted-syntax': ['error', ...importRules(ALLOWED_SIM_IMPORT), ...MATH_LAUNDERING],
    },
  },
  {
    name: 'deadhead/proto-purity',
    files: ['packages/proto/src/**/*.ts'],
    languageOptions: {
      globals: FORBIDDEN_GLOBAL_BINDINGS,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    linterOptions: { noInlineConfig: true },
    rules: {
      ...sharedPurityRules,
      'no-restricted-syntax': ['error', ...importRules(ALLOWED_PROTO_IMPORT), ...MATH_LAUNDERING],
    },
  },
];

export default simPurityConfig;
