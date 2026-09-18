// What a host sample is, and how a series is derived from a run of them.
//
// Pure functions only — the sampler fetches, this file decides what the numbers
// mean, and server/__tests__/metrics.test.ts asserts it. That split matters
// most for CPU: there is no such thing as "current CPU%" on a Linux box, only
// cumulative jiffies in /proc/stat. Reading them twice 300ms apart inside one
// SSH call would work but bills every host 300ms of dead time per poll, so
// instead the COUNTER is stored and the rate is computed between adjacent
// samples — the same counter-plus-rate model Prometheus uses, and the reason a
// restarted host shows a gap rather than a nonsense spike.

export interface GpuSample {
  index: number;
  utilPct: number;
  memUsedMb: number;
  memTotalMb: number;
  tempC: number;
  powerW: number;
}

export interface FsSample {
  mount: string;
  size: number;
  used: number;
  usePct: number;
}

export interface Sample {
  /** Epoch ms, taken on the Kalam server so hosts with skewed clocks still align. */
  at: number;
  source: string;
  reachable: boolean;
  error?: string;

  // Counters (monotonic, in jiffies) — rates are derived, never stored.
  cpuTotal?: number;
  cpuIdle?: number;

  load1?: number;
  load5?: number;
  load15?: number;
  cpus?: number;

  memTotal?: number;
  memUsed?: number;
  memAvailable?: number;
  swapTotal?: number;
  swapUsed?: number;

  fs?: FsSample[];
  gpus?: GpuSample[];
  failedUnits?: number;
  uptimeSec?: number;
}

export interface Point { t: number; v: number | null }

export type MetricId =
  | 'cpuPct'
  | 'load1'
  | 'loadPerCpu'
  | 'memUsedPct'
  | 'swapUsedPct'
  | 'diskUsedPct'
  | 'gpuUtilPct'
  | 'gpuMemPct'
  | 'gpuTempC'
  | 'gpuPowerW'
  | 'failedUnits';

export interface MetricMeta {
  id: MetricId;
  label: string;
  unit: '%' | '' | '°C' | 'W';
  /** Above this a value is worth looking at; above `critical` it is not fine. */
  warn?: number;
  critical?: number;
  /** A ratio metric is clamped to 0..100 when charted. */
  ratio: boolean;
}

export const METRICS: Record<MetricId, MetricMeta> = {
  cpuPct: { id: 'cpuPct', label: 'CPU', unit: '%', warn: 80, critical: 95, ratio: true },
  load1: { id: 'load1', label: 'Load (1m)', unit: '', ratio: false },
  loadPerCpu: { id: 'loadPerCpu', label: 'Load per CPU', unit: '', warn: 1, critical: 2, ratio: false },
  memUsedPct: { id: 'memUsedPct', label: 'Memory', unit: '%', warn: 85, critical: 95, ratio: true },
  swapUsedPct: { id: 'swapUsedPct', label: 'Swap', unit: '%', warn: 40, critical: 80, ratio: true },
  diskUsedPct: { id: 'diskUsedPct', label: 'Disk (fullest)', unit: '%', warn: 85, critical: 95, ratio: true },
  gpuUtilPct: { id: 'gpuUtilPct', label: 'GPU', unit: '%', ratio: true },
  gpuMemPct: { id: 'gpuMemPct', label: 'GPU memory', unit: '%', warn: 90, critical: 98, ratio: true },
  gpuTempC: { id: 'gpuTempC', label: 'GPU temp', unit: '°C', warn: 80, critical: 90, ratio: false },
  gpuPowerW: { id: 'gpuPowerW', label: 'GPU power', unit: 'W', ratio: false },
  failedUnits: { id: 'failedUnits', label: 'Failed units', unit: '', warn: 1, critical: 1, ratio: false },
};

const pct = (used?: number, total?: number): number | null =>
  total && total > 0 && used !== undefined ? (used / total) * 100 : null;

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/**
 * CPU busy percentage between two samples.
 *
 * Returns null rather than a number whenever the answer would be a lie: a
 * reboot resets the counters (delta goes negative), and two samples taken at
 * the same instant have no rate at all.
 */
export function cpuPctBetween(prev: Sample | undefined, cur: Sample): number | null {
  if (!prev || prev.cpuTotal === undefined || prev.cpuIdle === undefined) return null;
  if (cur.cpuTotal === undefined || cur.cpuIdle === undefined) return null;
  const dTotal = cur.cpuTotal - prev.cpuTotal;
  const dIdle = cur.cpuIdle - prev.cpuIdle;
  if (dTotal <= 0 || dIdle < 0) return null; // counter reset, or no time passed
  const busy = ((dTotal - dIdle) / dTotal) * 100;
  return Math.max(0, Math.min(100, busy));
}

/** The value of one metric at one sample, given its predecessor (for rates). */
export function valueAt(metric: MetricId, cur: Sample, prev?: Sample): number | null {
  if (!cur.reachable) return null;
  switch (metric) {
    case 'cpuPct': return cpuPctBetween(prev, cur);
    case 'load1': return cur.load1 ?? null;
    case 'loadPerCpu': return cur.load1 !== undefined && cur.cpus ? cur.load1 / cur.cpus : null;
    case 'memUsedPct': return pct(cur.memUsed, cur.memTotal);
    case 'swapUsedPct': return pct(cur.swapUsed, cur.swapTotal);
    // The fullest filesystem is the one that takes the host down, so a single
    // "disk" number that averaged mounts would hide exactly the failure it is
    // meant to catch.
    case 'diskUsedPct': return cur.fs?.length ? Math.max(...cur.fs.map((f) => f.usePct)) : null;
    case 'gpuUtilPct': return mean((cur.gpus || []).map((g) => g.utilPct));
    case 'gpuMemPct': return mean((cur.gpus || []).map((g) => (g.memTotalMb > 0 ? (g.memUsedMb / g.memTotalMb) * 100 : 0)));
    case 'gpuTempC': return cur.gpus?.length ? Math.max(...cur.gpus.map((g) => g.tempC)) : null;
    case 'gpuPowerW': return cur.gpus?.length ? cur.gpus.reduce((a, g) => a + g.powerW, 0) : null;
    case 'failedUnits': return cur.failedUnits ?? null;
    default: return null;
  }
}

/** One metric across a run of samples, oldest first. */
export function toSeries(samples: Sample[], metric: MetricId): Point[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  return sorted.map((s, i) => ({ t: s.at, v: valueAt(metric, s, sorted[i - 1]) }));
}

/**
 * Thin a series to at most `max` points by averaging within buckets.
 *
 * A day of 30-second samples is 2,880 points per host per metric; a sparkline
 * 200px wide cannot show them and the JSON is pure waste. Gaps stay gaps —
 * a bucket with no readable value yields null rather than being interpolated
 * over, because a smooth line across an outage is a lie about the outage.
 */
export function downsample(points: Point[], max: number): Point[] {
  if (max <= 0 || points.length <= max) return points;
  const bucket = Math.ceil(points.length / max);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += bucket) {
    const slice = points.slice(i, i + bucket);
    const vals = slice.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v));
    out.push({
      t: slice[Math.floor(slice.length / 2)].t,
      v: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    });
  }
  return out;
}

export type Level = 'ok' | 'warn' | 'critical' | 'unknown';

/** Where a value sits against the metric's thresholds. */
export function levelOf(metric: MetricId, v: number | null): Level {
  if (v === null || !Number.isFinite(v)) return 'unknown';
  const m = METRICS[metric];
  if (m.critical !== undefined && v >= m.critical) return 'critical';
  if (m.warn !== undefined && v >= m.warn) return 'warn';
  return 'ok';
}

/** The worst level across several — used to colour a host row from its metrics. */
export function worstLevel(levels: Level[]): Level {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warn')) return 'warn';
  if (levels.includes('ok')) return 'ok';
  return 'unknown';
}
