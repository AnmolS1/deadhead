import { describe, expect, it } from 'vitest';

import { SIM_VERSION } from '../src/index.js';
import { PROTO_VERSION } from '@deadhead/proto';

describe('@deadhead/sim scaffold', () => {
  it('exports a version constant', () => {
    expect(SIM_VERSION).toBe(0);
  });

  it('resolves its workspace dependency', () => {
    expect(PROTO_VERSION).toBe(0);
  });
});
