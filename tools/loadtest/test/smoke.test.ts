import { describe, expect, it } from 'vitest';

import { LOADTEST_VERSION } from '../src/index.js';
import { SIM_VERSION } from '@deadhead/sim';

describe('@deadhead/loadtest scaffold', () => {
  it('exports a version constant', () => {
    expect(LOADTEST_VERSION).toBe(0);
  });

  it('resolves its workspace dependency', () => {
    expect(SIM_VERSION).toBe(0);
  });
});
