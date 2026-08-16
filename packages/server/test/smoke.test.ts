import { describe, expect, it } from 'vitest';

import { SERVER_VERSION } from '../src/index.js';
import { SIM_VERSION } from '@deadhead/sim';

describe('@deadhead/server scaffold', () => {
  it('exports a version constant', () => {
    expect(SERVER_VERSION).toBe(0);
  });

  it('resolves its workspace dependency', () => {
    expect(SIM_VERSION).toBe(0);
  });
});
