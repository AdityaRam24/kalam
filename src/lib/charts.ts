// One "Charts" switch for every page that has graphics. The choice is kept in
// this browser and shared live between pages, so turning charts off on Model
// Usage also turns them off on Hardware, VME Readiness and Change History.

import { useCallback, useEffect, useState } from 'react';

const KEY = 'trinetra_charts';
const EVENT = 'trinetra-charts';

function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

export function useCharts(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    const storage = (e: StorageEvent) => { if (e.key === KEY) setOn(read()); };
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', storage); };
  }, []);
  const set = useCallback((v: boolean) => {
    setOn(v);
    try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: v }));
  }, []);
  return [on, set];
}

/** Categorical slots in their fixed, colour-blind-validated order. Never cycled. */
export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
export const SERIES_OTHER = 'var(--series-other)';

/** 0 → max rounded up to 1, 2, 2.5 or 5 × 10^n so axis ticks land on round numbers. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
