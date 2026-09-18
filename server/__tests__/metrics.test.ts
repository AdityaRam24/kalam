// What the metrics pipeline must get right.
//
// The two that matter most are both about not lying:
//   * CPU is a rate over counters, so a reboot must produce a GAP, never a
//     spike computed from a counter that went backwards.
//   * Downsampling must not interpolate across an outage — a smooth line
//     through a hole is a claim the host was fine when it was unreachable.

import { describe, it, expect } from 'vitest';
import {
  cpuPctBetween, downsample, levelOf, toSeries, valueAt, worstLevel,
  type Sample,
} from '../metrics/model.js';
import { parseCpuStat, parseGpus, parseSample } from '../metrics/sample.js';

const mk = (over: Partial<Sample> = {}): Sample =>
  ({ at: 1_000, source: 'vm-a', reachable: true, ...over });

describe('parseCpuStat', () => {
  it('counts idle and iowait as idle, everything else as busy', () => {
    // user nice system idle iowait irq softirq steal
    const r = parseCpuStat(['cpu  100 0 50 800 40 5 5 0', 'cpu0 ...']);
    expect(r.total).toBe(1000);
    expect(r.idle).toBe(840);
  });

  it('returns nothing usable rather than guessing on a short or missing line', () => {
    expect(parseCpuStat([])).toEqual({});
    expect(parseCpuStat(['cpu 1 2'])).toEqual({});
    expect(parseCpuStat(['intr 123'])).toEqual({});
  });
});

describe('parseGpus', () => {
  it('reads the nvidia-smi csv', () => {
    const g = parseGpus(['0, 42, 8192, 81920, 61, 210.55', '1, 0, 12, 81920, 35, 58.2']);
    expect(g).toHaveLength(2);
    expect(g[0]).toEqual({ index: 0, utilPct: 42, memUsedMb: 8192, memTotalMb: 81920, tempC: 61, powerW: 210.55 });
    expect(g[1].utilPct).toBe(0);
  });

  it('survives [N/A] fields and junk lines', () => {
    const g = parseGpus(['0, 10, 100, 1000, 50, [N/A]', '', 'no GPUs found', 'x, y']);
    expect(g).toHaveLength(1);
    expect(g[0].powerW).toBe(0);
  });
});

describe('parseSample', () => {
  const stdout = [
    '===KALAM:STAT===',
    'cpu  100 0 50 800 40 5 5 0',
    '===KALAM:SELF===',
    'LOAD=1.50 1.20 0.90',
    'NCPU=8',
    'UPSEC=123456.78',
    '===KALAM:FREE===',
    '              total        used        free      shared  buff/cache   available',
    'Mem:     16000000000  8000000000  2000000000    10000000   6000000000  7000000000',
    'Swap:     2000000000   500000000  1500000000',
    '===KALAM:DF===',
    '/dev/sda1 ext4 100000000000 85000000000 15000000000 85% /',
    '/dev/sdb1 xfs  50000000000  5000000000 45000000000 10% /data',
    '===KALAM:GPU===',
    '0, 77, 40960, 81920, 70, 300.5',
    '===KALAM:FAILED===',
    '2',
    '===KALAM:END===',
  ].join('\n');

  it('pulls every block into one numeric sample', () => {
    const s = parseSample('vm-a', 5000, stdout);
    expect(s.source).toBe('vm-a');
    expect(s.reachable).toBe(true);
    expect(s.cpuTotal).toBe(1000);
    expect(s.cpuIdle).toBe(840);
    expect(s.load1).toBe(1.5);
    expect(s.cpus).toBe(8);
    expect(s.memTotal).toBe(16_000_000_000);
    expect(s.swapUsed).toBe(500_000_000);
    expect(s.fs?.map((f) => f.mount)).toEqual(['/', '/data']);
    expect(s.gpus?.[0].utilPct).toBe(77);
    expect(s.failedUnits).toBe(2);
    expect(Math.round(s.uptimeSec!)).toBe(123457);
  });

  it('leaves fields undefined rather than zero when a tool is missing', () => {
    const bare = ['===KALAM:STAT===', '===KALAM:SELF===', '===KALAM:GPU===', '===KALAM:END==='].join('\n');
    const s = parseSample('vm-b', 1, bare);
    expect(s.cpuTotal).toBeUndefined();
    expect(s.cpus).toBeUndefined();
    expect(s.failedUnits).toBeUndefined();
    expect(s.gpus).toEqual([]);
    expect(s.reachable).toBe(true); // it answered; it just has no nvidia-smi
  });
});

describe('cpuPctBetween', () => {
  it('computes busy time between two readings', () => {
    const a = mk({ at: 0, cpuTotal: 1000, cpuIdle: 800 });
    const b = mk({ at: 30_000, cpuTotal: 2000, cpuIdle: 1500 });
    // 1000 jiffies passed, 700 of them idle -> 30% busy
    expect(cpuPctBetween(a, b)).toBeCloseTo(30, 6);
  });

  it('reports a gap, not a spike, when the counters reset', () => {
    const before = mk({ at: 0, cpuTotal: 9_000_000, cpuIdle: 8_000_000 });
    const afterReboot = mk({ at: 30_000, cpuTotal: 500, cpuIdle: 400 });
    expect(cpuPctBetween(before, afterReboot)).toBeNull();
  });

  it('has no answer without a predecessor or without elapsed time', () => {
    const s = mk({ cpuTotal: 100, cpuIdle: 50 });
    expect(cpuPctBetween(undefined, s)).toBeNull();
    expect(cpuPctBetween(s, s)).toBeNull();
  });
});

describe('valueAt', () => {
  it('reports the FULLEST filesystem, not an average', () => {
    const s = mk({ fs: [
      { mount: '/', size: 100, used: 20, usePct: 20 },
      { mount: '/var', size: 100, used: 97, usePct: 97 },
    ] });
    expect(valueAt('diskUsedPct', s)).toBe(97);
  });

  it('derives percentages and per-cpu load', () => {
    const s = mk({ memTotal: 1000, memUsed: 250, swapTotal: 100, swapUsed: 50, load1: 4, cpus: 8 });
    expect(valueAt('memUsedPct', s)).toBe(25);
    expect(valueAt('swapUsedPct', s)).toBe(50);
    expect(valueAt('loadPerCpu', s)).toBe(0.5);
  });

  it('averages GPU utilisation but takes the hottest card', () => {
    const s = mk({ gpus: [
      { index: 0, utilPct: 100, memUsedMb: 8000, memTotalMb: 16000, tempC: 60, powerW: 100 },
      { index: 1, utilPct: 0, memUsedMb: 4000, memTotalMb: 16000, tempC: 85, powerW: 50 },
    ] });
    expect(valueAt('gpuUtilPct', s)).toBe(50);
    expect(valueAt('gpuMemPct', s)).toBeCloseTo(37.5, 6);
    expect(valueAt('gpuTempC', s)).toBe(85);
    expect(valueAt('gpuPowerW', s)).toBe(150);
  });

  it('yields nothing at all for an unreachable host', () => {
    const down = mk({ reachable: false, memTotal: 1000, memUsed: 500 });
    expect(valueAt('memUsedPct', down)).toBeNull();
  });

  it('yields null, not 0, for hardware that is not there', () => {
    expect(valueAt('gpuUtilPct', mk({ gpus: [] }))).toBeNull();
    expect(valueAt('diskUsedPct', mk({ fs: [] }))).toBeNull();
  });
});

describe('toSeries', () => {
  it('orders by time and leaves the first rate point empty', () => {
    const s = toSeries(
      [
        mk({ at: 60_000, cpuTotal: 2000, cpuIdle: 1500 }),
        mk({ at: 0, cpuTotal: 1000, cpuIdle: 800 }),
      ],
      'cpuPct',
    );
    expect(s.map((p) => p.t)).toEqual([0, 60_000]);
    expect(s[0].v).toBeNull();
    expect(s[1].v).toBeCloseTo(30, 6);
  });
});

describe('downsample', () => {
  it('leaves a short series alone', () => {
    const pts = [{ t: 1, v: 1 }, { t: 2, v: 2 }];
    expect(downsample(pts, 10)).toBe(pts);
  });

  it('thins a long series to the cap', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: i }));
    const out = downsample(pts, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0].v).toBeGreaterThanOrEqual(0);
  });

  it('keeps an outage as a hole instead of drawing through it', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ t: i, v: i < 10 ? null : 50 }));
    const out = downsample(pts, 2);
    expect(out[0].v).toBeNull();
    expect(out[1].v).toBe(50);
  });
});

describe('levels', () => {
  it('grades a value against its own thresholds', () => {
    expect(levelOf('memUsedPct', 10)).toBe('ok');
    expect(levelOf('memUsedPct', 90)).toBe('warn');
    expect(levelOf('memUsedPct', 99)).toBe('critical');
    expect(levelOf('memUsedPct', null)).toBe('unknown');
    expect(levelOf('gpuUtilPct', 100)).toBe('ok'); // a busy GPU is the point
  });

  it('takes the worst, and only claims ok when something was actually read', () => {
    expect(worstLevel(['ok', 'warn', 'critical'])).toBe('critical');
    expect(worstLevel(['ok', 'warn'])).toBe('warn');
    expect(worstLevel(['unknown', 'ok'])).toBe('ok');
    expect(worstLevel(['unknown'])).toBe('unknown');
    expect(worstLevel([])).toBe('unknown');
  });
});
