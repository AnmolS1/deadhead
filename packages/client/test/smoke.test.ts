import { describe, expect, it } from 'vitest';

import { CLIENT_VERSION } from '../src/index.js';
import { SIM_VERSION } from '@deadhead/sim';

describe('@deadhead/client scaffold', () => {
  it('exports a version constant', () => {
    expect(CLIENT_VERSION).toBe(0);
  });

  it('resolves its workspace dependency', () => {
    expect(SIM_VERSION).toBe(0);
  });
});
