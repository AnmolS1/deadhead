import { describe, expect, it } from 'vitest';

import { PROTO_VERSION } from '../src/index.js';

describe('@deadhead/proto scaffold', () => {
  it('exports a version constant', () => {
    expect(PROTO_VERSION).toBe(0);
  });
});
