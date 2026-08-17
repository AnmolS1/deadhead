import { describe, expect, it } from 'vitest';

import { CITYEDIT_VERSION } from '../src/index.js';
import { PROTO_VERSION } from '@deadhead/proto';

describe('@deadhead/cityedit scaffold', () => {
  it('exports a version constant', () => {
    expect(CITYEDIT_VERSION).toBe(0);
  });

  it('resolves its workspace dependency', () => {
    expect(PROTO_VERSION).toBe(0);
  });
});
