// One numeric sample from one host, in one SSH round trip.
//
// Deliberately NOT the Host Logs overview command. That one runs ps, ss and a
// full systemd unit listing and is bounded at 60s with an 8MB buffer — right
// for a page you open, far too heavy to run against every host every 30
// seconds. This reads /proc, one df, one nvidia-smi and a failed-unit count,
// and nothing else.
//
// The parsing of `free` and `df` is NOT reimplemented here: parseFree/parseDf
// in server/hostlogs/system.ts already handle the awkward cases (missing swap
// line, bind mounts, inode columns) and are covered by tests.

import { sshRun, type VmEntry } from '../vms.js';
import { parseFree, parseDf } from '../hostlogs/system.js';
import { splitMarked, mark } from '../hostlogs/router.js';
import type { GpuSample, Sample } from './model.js';

export const SAMPLE_TIMEOUT_MS = 20000;

// `|| true` on the optional probes: a host with no nvidia-smi and no systemctl
// must still return every other block rather than failing the whole sample.
export const SAMPLE_CMD = [
  mark('STAT'), 'head -n 1 /proc/stat 2>/dev/null',
  mark('SELF'),
  'echo "LOAD=$(cut -d\' \' -f1-3 /proc/loadavg 2>/dev/null)"; ' +
    'echo "NCPU=$(nproc 2>/dev/null)"; ' +
    'echo "UPSEC=$(cut -d\' \' -f1 /proc/uptime 2>/dev/null)"',
  mark('FREE'), 'free -b 2>/dev/null',
  mark('DF'), 'df -PT -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2',
  mark('GPU'),
  'command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi ' +
    '--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw ' +
    '--format=csv,noheader,nounits 2>/dev/null || true',
  mark('FAILED'), 'systemctl list-units --state=failed --no-legend --plain 2>/dev/null | wc -l || true',
  mark('END'),
].join('; ');

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : undefined;
};

/** `cpu  user nice system idle iowait irq softirq steal guest guest_nice` */
export function parseCpuStat(lines: string[]): { total?: number; idle?: number } {
  const line = lines.find((l) => /^cpu\s/.test(l));
  if (!line) return {};
  const parts = line.trim().split(/\s+/).slice(1).map(Number).filter((n) => Number.isFinite(n));
  if (parts.length < 4) return {};
  // idle + iowait: time the CPU had nothing to run. Counting iowait as busy
  // makes a disk-bound host look CPU-bound, which sends you after the wrong
  // bottleneck entirely.
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { total, idle };
}

export function parseGpus(lines: string[]): GpuSample[] {
  const out: GpuSample[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 6) continue;
    const index = Number(f[0]);
    if (!Number.isFinite(index)) continue;
    out.push({
      index,
      utilPct: num(f[1]) ?? 0,
      memUsedMb: num(f[2]) ?? 0,
      memTotalMb: num(f[3]) ?? 0,
      tempC: num(f[4]) ?? 0,
      // [N/A] on cards that do not report draw — 0 is the honest reading here.
      powerW: num(f[5]) ?? 0,
    });
  }
  return out;
}

/** Turn one host's raw stdout into a sample. Pure, so it can be tested. */
export function parseSample(source: string, at: number, stdout: string): Sample {
  const blocks = splitMarked(stdout);
  const get = (tag: string) => blocks.find((b) => b.tag === tag)?.body.filter((l) => l.trim()) || [];

  const self: Record<string, string> = {};
  for (const line of get('SELF')) {
    const i = line.indexOf('=');
    if (i > 0) self[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const load = (self.LOAD || '').split(/\s+/).map(Number);
  const cpu = parseCpuStat(get('STAT'));
  const mem = parseFree(get('FREE'));
  const fs = parseDf(get('DF')).map((f) => ({
    mount: f.mount, size: f.size, used: f.used, usePct: f.usePct,
  }));

  return {
    at,
    source,
    reachable: true,
    cpuTotal: cpu.total,
    cpuIdle: cpu.idle,
    load1: Number.isFinite(load[0]) ? load[0] : undefined,
    load5: Number.isFinite(load[1]) ? load[1] : undefined,
    load15: Number.isFinite(load[2]) ? load[2] : undefined,
    cpus: num(self.NCPU),
    memTotal: mem.total,
    memUsed: mem.used,
    memAvailable: mem.available,
    swapTotal: mem.swapTotal,
    swapUsed: mem.swapUsed,
    fs,
    gpus: parseGpus(get('GPU')),
    failedUnits: num(get('FAILED')[0]),
    uptimeSec: num(self.UPSEC),
  };
}

/** Sample one host. Never throws — an unreachable host is a datapoint. */
export async function collectSample(vm: VmEntry, at = Date.now()): Promise<Sample> {
  try {
    const { stdout, stderr, ok } = await sshRun(vm, SAMPLE_CMD, SAMPLE_TIMEOUT_MS);
    if (!ok && !stdout.includes('===KALAM:')) {
      return {
        at, source: vm.name, reachable: false,
        error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 200),
      };
    }
    return parseSample(vm.name, at, stdout);
  } catch (e: any) {
    return { at, source: vm.name, reachable: false, error: String(e?.message || e).slice(0, 200) };
  }
}
