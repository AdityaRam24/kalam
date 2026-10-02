import { describe, expect, it } from 'vitest';
import { adoptLegacyEnv } from '../legacy-env.js';

describe('adoptLegacyEnv', () => {
  it('adopts old names under the new ones; an explicit new value wins', () => {
    const env: NodeJS.ProcessEnv = { KALAM_HISTORY: '1', KALAM_METRICS: '1', TRINETRA_METRICS: '0' };
    adoptLegacyEnv(env);
    expect(env.TRINETRA_HISTORY).toBe('1');
    expect(env.TRINETRA_METRICS).toBe('0');
  });
});
