/**
 * Vite's `?raw` import suffix, which vitest honours too.
 *
 * Declared here rather than pulling in `vite/client`, which would bring the
 * whole ambient environment along for one string.
 */
declare module '*?raw' {
  const contents: string;
  export default contents;
}
