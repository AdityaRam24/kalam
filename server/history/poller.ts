// The background capture loop.
//
// OFF BY DEFAULT. Kalam is a dashboard people run on a laptop against someone
// else's production cluster; it does not get to start polling a cluster every
// five minutes because it was launched. Set KALAM_HISTORY=1 to opt in.
//
//   KALAM_HISTORY=1                    enable
//   KALAM_HISTORY_INTERVAL_SEC=300     how often (default 5 min)
//   KALAM_HISTORY_SOURCES=local,vm-a   what to capture; `all` = local + every VM
//
// Five minutes is chosen against the Kubernetes event TTL (~1 hour): frequent
// enough that events are still alive when a change is noticed, rare enough to
// be invisible in apiserver load.

import { loadVms } from '../vms.js';
import { captureCluster } from './collect.js';
import { diffSnapshots } from './diff.js';
import { appendChanges, loadSnapshot, saveSnapshot } from './store.js';

export interface CaptureOutcome {
  source: string;
  at: string;
  objects: number;
  sections: string[];
  missing: string[];
  changes: number;
  notes: string[];
  degraded?: string;
  error?: string;
  durationMs: number;
}

export interface PollerState {
  enabled: boolean;
  intervalSec: number;
  sources: string[];
  running: boolean;
  lastRunAt?: string;
  lastError?: string;
  last: Record<string, CaptureOutcome>;
}

const state: PollerState = {
  enabled: false,
  intervalSec: Number(process.env.KALAM_HISTORY_INTERVAL_SEC || 300),
  sources: [],
  running: false,
  last: {},
};

export function pollerState(): PollerState {
  return state;
}

/**
 * Capture one source, diff it against the stored snapshot, persist both.
 *
 * The new snapshot is saved even when nothing changed, so the next diff always
 * compares against the most recent reality. It is NOT saved when the capture
 * was judged unusable — overwriting good state with a bad read would make the
 * next capture report the recovery as a flood of creations.
 */
export async function captureOnce(source: string): Promise<CaptureOutcome> {
  const result = await captureCluster(source);
  const previous = await loadSnapshot(source);
  const { events, notes } = diffSnapshots(previous, result.snapshot);

  const unusable = !result.snapshot.sections.length;
  if (!unusable) {
    await saveSnapshot(result.snapshot);
    if (events.length) await appendChanges(source, events);
  }

  const outcome: CaptureOutcome = {
    source,
    at: result.snapshot.at,
    objects: Object.keys(result.snapshot.objects).length,
    sections: result.snapshot.sections,
    missing: result.missing,
    changes: events.length,
    notes: unusable
      ? [...notes, `Nothing readable came back from ${source}${result.error ? `: ${result.error}` : ''}. Kept the previous snapshot.`]
      : notes,
    degraded: result.degraded,
    error: result.error,
    durationMs: result.durationMs,
  };
  state.last[source] = outcome;
  return outcome;
}

async function resolveSources(): Promise<string[]> {
  const raw = (process.env.KALAM_HISTORY_SOURCES || 'local').trim();
  if (raw !== 'all') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const vms = await loadVms();
  return ['local', ...vms.map((v) => v.name)];
}

async function tick(): Promise<void> {
  // A slow cluster must never stack captures on top of each other.
  if (state.running) return;
  state.running = true;
  try {
    const sources = await resolveSources();
    state.sources = sources;
    // Sequential on purpose: "all" on a ten-VM inventory should not open ten
    // SSH sessions at once.
    for (const source of sources) {
      try {
        await captureOnce(source);
      } catch (e: any) {
        state.lastError = `${source}: ${e?.message || e}`;
      }
    }
    state.lastRunAt = new Date().toISOString();
  } catch (e: any) {
    state.lastError = e?.message || String(e);
  } finally {
    state.running = false;
  }
}

let timer: NodeJS.Timeout | undefined;

/** Called once at startup. Returns whether the loop actually started. */
export function startHistoryPoller(): boolean {
  const flag = (process.env.KALAM_HISTORY || '').toLowerCase();
  state.enabled = flag === '1' || flag === 'true' || flag === 'yes';
  if (!state.enabled || timer) return false;

  const intervalMs = Math.max(60, state.intervalSec) * 1000;
  // Never hold the process open for the sake of a poll.
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick(); // take a baseline immediately rather than after the first wait
  return true;
}

export function stopHistoryPoller(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  state.enabled = false;
}
