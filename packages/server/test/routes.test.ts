import { describe, expect, it } from 'vitest';

import { API_PREFIX, routePath } from '../src/routes.js';

/**
 * The prefix strip is two lines and could hardly be simpler, which is exactly
 * why it is worth pinning: `B-04` will forward the *original* request, so every
 * route in this Worker is reached under two different paths for the rest of the
 * project's life. If this drifts, every endpoint 404s in production while
 * passing locally.
 */
describe('routePath', () => {
  it('passes a bare path through', () => {
    expect(routePath('https://example.com/health')).toBe('/health');
  });

  it('strips the proxy prefix the site mounts this Worker at', () => {
    expect(routePath(`https://ponderance.dev${API_PREFIX}/health`)).toBe('/health');
  });

  it('resolves both spellings to the same route', () => {
    expect(routePath(`https://ponderance.dev${API_PREFIX}/run/submit`)).toBe(
      routePath('http://localhost:8787/run/submit'),
    );
  });

  it('maps the prefix itself, with or without a trailing slash, to the root', () => {
    expect(routePath(`https://ponderance.dev${API_PREFIX}`)).toBe('/');
    expect(routePath(`https://ponderance.dev${API_PREFIX}/`)).toBe('/');
  });

  it('drops a trailing slash but never empties the root', () => {
    expect(routePath('http://localhost:8787/health/')).toBe('/health');
    expect(routePath('http://localhost:8787/')).toBe('/');
    expect(routePath('http://localhost:8787')).toBe('/');
  });

  it('does not strip a prefix that merely starts the same way', () => {
    // `/play/apiary` shares every character of the prefix but is a different
    // path. A `startsWith(API_PREFIX)` without the separator would eat it.
    expect(routePath('https://ponderance.dev/play/apiary')).toBe('/play/apiary');
  });

  it('ignores the query string and the fragment', () => {
    expect(routePath('http://localhost:8787/health?verbose=1')).toBe('/health');
  });

  it('leaves an unrelated path alone', () => {
    expect(routePath('http://localhost:8787/nope')).toBe('/nope');
  });
});
