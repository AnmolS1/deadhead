import { defineConfig } from 'vite';

/**
 * Dev/build config for the game client.
 *
 * `P-01` ships the built bundle into the Astro site at `/play/deadhead`, so the
 * constraints that matter here are the site's CI gates (CLAUDE.md §4):
 *
 * - **No inline script.** The site ships `script-src 'self'`, so the entry is an
 *   external module and `index.html` carries no inline `<script>`.
 * - **No CDN.** `no-thirdparty.sh` fails the build on any external origin, so
 *   everything is bundled.
 * - **Plain `?worker`, never `?worker&inline`.** An inline worker is a `blob:`
 *   worker, and `worker-src` does not allow `blob:`.
 */
export default defineConfig({
  build: {
    // NOT `dist`. `tsc --build` emits declarations there for the composite
    // project graph, and two tools writing to one directory is a race that
    // shows up as a mysteriously stale build.
    outDir: 'dist-app',
    target: 'es2022',
    // Sourcemaps ship: the bundle is small, and a stack trace from a player is
    // worth more than the bytes.
    sourcemap: true,
  },
});
