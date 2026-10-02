import { describe, expect, it } from 'vitest';
import { migrateLegacyStorage } from '../legacy';

function memStore(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

describe('migrateLegacyStorage', () => {
  it('moves pre-rename keys and never overwrites a new one', () => {
    const s = memStore({ kalam_theme: 'dark', kalam_source: 'vm1', trinetra_source: 'local', other: 'x' });
    expect(migrateLegacyStorage(s)).toBe(2);
    expect(s.getItem('trinetra_theme')).toBe('dark');
    expect(s.getItem('trinetra_source')).toBe('local');
    expect(s.getItem('kalam_theme')).toBeNull();
    expect(s.getItem('other')).toBe('x');
  });
});
