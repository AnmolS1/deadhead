/**
 * Host globals that the test runner provides but TypeScript's ES2022 lib does
 * not declare.
 *
 * `packages/sim` deliberately omits `"DOM"` from its `lib` so browser globals do
 * not typecheck in the sim (CLAUDE.md hard invariant #1). That also hides a few
 * genuinely universal globals from the *tests*, which run in Node, in workerd
 * and in the browser alike. Declare them here rather than widening the sim's
 * `lib`, so the src-side guarantee stays intact.
 */
declare function structuredClone<T>(value: T): T;
