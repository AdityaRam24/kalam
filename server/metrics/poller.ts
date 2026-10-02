// The background sampling loop.
//
// OFF BY DEFAULT, for the same reason the history poller is (see
// server/history/poller.ts): Trinetra is often pointed at someone else's
// production estate, and it does not get to start SSHing into every host on a
// timer because it was launched. Set TRINETRA_METRICS=1 to opt in.
//
//   TRINETRA_METRICS=1                    enable
//   TRINETRA_METRICS_INTERVAL_SEC=30      how often (default 30s, floor 10s)
//   TRINETRA_METRICS_SOURCES=all          `all` = every inventory VM, or a list
//   TRINETRA_METRICS_RETENTION_HOURS=48   how far back to keep samples
//
// 30 seconds is chosen to be finer than the 5-minute history capture — this is
// what you watch while doing something, not an audit trail — while staying
// cheap: one short SSH command per host per interval.

import { loadVms } from '../vms.js';
import { collectSample } from './sample.js';
import { appendSample, pruneAll } from './store.js';

export interface MetricsPollerState {
  enabled: boolean;
  intervalSec: number;
  sources: string[];
  running: boolean;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  /** Per host: did the most recent sample come back, and why not. */
  last: Record<string, { at: string; reachable: boolean; error?: string }>;
}

const state: MetricsPollerState = {
  enabled: false,
  intervalSec: Number(process.env.TRINETRA_METRICS_INTERVAL_SEC || 30),
  sources: [],
  running: false,
  last: {},
};

export function metricsPollerState(): MetricsPollerState {
  return state;
}

async function resolveSources() {
  const vms = await loadVms();
  const raw = (process.env.TRINETRA_METRICS_SOURCES || 'all').trim();
  if (raw === 'all') return vms;
  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return vms.filter((v) => wanted.has(v.name));
}

/** Sample every selected host once and persist the results. */
export async function sampleOnce(): Promise<number> {
  const vms = await resolveSources();
  state.sources = vms.map((v) => v.name);
  const at = Date.now();
  let written = 0;
  // Sequential on purpose: "all" on a ten-VM inventory must not open ten SSH
  // sessions at once — the same call the history poller makes.
  for (const vm of vms) {
    try {
      const sample = await collectSample(vm, at);
      await appendSample(sample);
      state.last[vm.name] = {
        at: new Date(sample.at).toISOString(),
        reachable: sample.reachable,
        error: sample.error,
      };
      written++;
    } catch (e: any) {
      state.lastError = `${vm.name}: ${e?.message || e}`;
    }
  }
  return written;
}

let pruneCounter = 0;

async function tick(): Promise<void> {
  // A slow host must never stack polls on top of each other.
  if (state.running) return;
  state.running = true;
  const started = Date.now();
  try {
    await sampleOnce();
    // Pruning walks and rewrites every file, so it does not belong on the hot
    // path — roughly every 100 ticks (~50 min at the default interval).
    if (++pruneCounter % 100 === 0) await pruneAll();
    state.lastRunAt = new Date().toISOString();
    state.lastDurationMs = Date.now() - started;
  } catch (e: any) {
    state.lastError = e?.message || String(e);
  } finally {
    state.running = false;
  }
}

let timer: NodeJS.Timeout | undefined;

/** Called once at startup. Returns whether the loop actually started. */
export function startMetricsPoller(): boolean {
  const flag = (process.env.TRINETRA_METRICS || '').toLowerCase();
  state.enabled = flag === '1' || flag === 'true' || flag === 'yes';
  if (!state.enabled || timer) return false;

  const intervalMs = Math.max(10, state.intervalSec) * 1000;
  timer = setInterval(() => void tick(), intervalMs);
  // Never hold the process open for the sake of a poll.
  timer.unref?.();
  void tick(); // take a baseline immediately rather than after the first wait
  return true;
}

export function stopMetricsPoller(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  state.enabled = false;
}
