import { defineConfig } from 'vite';

/**
 * Dev/build config for the city editor.
 *
 * A development tool, not a shipped artefact — it never enters the ponderance
 * site's `dist/`, so the site's CI gates (CLAUDE.md §4) do not apply to it. The
 * conventions are kept anyway, because a tool that quietly diverges from the
 * game's build is one that stops representing it: no inline script, everything
 * bundled, nothing from a CDN.
 */
export default defineConfig({
  build: {
    // NOT `dist` — `tsc --build` emits declarations there for the composite
    // project graph, and two tools writing to one directory is a race that
    // surfaces as a mysteriously stale build.
    outDir: 'dist-app',
    target: 'es2022',
    sourcemap: true,
  },
  // Serve the repo root as well, so `?city=/packages/client/assets/cities/01.json`
  // resolves against the real generated file rather than a copy.
  server: { port: 4322, fs: { allow: ['../..'] } },
  publicDir: false,
});
