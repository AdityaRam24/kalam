// GPU history and the findings that need it.
//
// One reading says how busy a GPU is NOW. The questions that cost money need
// time: "this model has held two H100s for six hours at 2%", "memory has sat at
// 98% all afternoon", "three pods are queued for a GPU while allocated ones
// idle". Every overview read appends one compact line per source, in the same
// append-only JSONL style as server/metrics/store.ts, under the same directory
// and retention. Optional background polling: TRINETRA_GPU_POLL_SEC.
//
// Pure judging (`gpuFindings`) is separate from the store and tested.

import fs from 'fs/promises';
import path from 'path';
import { METRICS_DIR, RETENTION_HOURS } from '../metrics/store.js';

export interface GpuHistPoint {
  /** Epoch ms. */
  t: number;
  /** Mean compute util across the workload's GPUs, %. */
  util: number | null;
  /** Memory used / total across them, %. */
  mem: number | null;
}

export interface GpuHistLine {
  at: number;
  /** key = namespace/pod/container → reading */
  w: Record<string, { model?: string; gpus: number; util: number | null; mem: number | null }>;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'local';
const fileFor = (source: string) => path.join(METRICS_DIR, `gpu-${safe(source)}.jsonl`);

export async function appendGpuHistory(source: string, line: GpuHistLine): Promise<void> {
  if (!Object.keys(line.w).length) return;
  await fs.mkdir(METRICS_DIR, { recursive: true }).catch(() => {});
  await fs.appendFile(fileFor(source), JSON.stringify(line) + '\n', 'utf-8');
}

export async function readGpuHistory(source: string, sinceMs: number): Promise<GpuHistLine[]> {
  let raw = '';
  try { raw = await fs.readFile(fileFor(source), 'utf-8'); } catch { return []; }
  const out: GpuHistLine[] = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try {
      const x = JSON.parse(l) as GpuHistLine;
      if (typeof x?.at === 'number' && x.at >= sinceMs) out.push(x);
    } catch { /* torn line */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Drop lines older than retention. Called occasionally, not per read. */
export async function pruneGpuHistory(source: string, now = Date.now()): Promise<void> {
  const keep = await readGpuHistory(source, now - RETENTION_HOURS * 3600_000);
  const tmp = `${fileFor(source)}.tmp`;
  await fs.writeFile(tmp, keep.map((l) => JSON.stringify(l)).join('\n') + (keep.length ? '\n' : ''), 'utf-8');
  await fs.rename(tmp, fileFor(source));
}

/** Per-workload series, at most `max` points each (bucket means; gaps stay gaps). */
export function seriesByWorkload(lines: GpuHistLine[], max = 60): Record<string, GpuHistPoint[]> {
  const raw: Record<string, GpuHistPoint[]> = {};
  for (const l of lines) for (const [k, v] of Object.entries(l.w)) (raw[k] ||= []).push({ t: l.at, util: v.util, mem: v.mem });
  const out: Record<string, GpuHistPoint[]> = {};
  for (const [k, pts] of Object.entries(raw)) {
    if (pts.length <= max) { out[k] = pts; continue; }
    const step = Math.ceil(pts.length / max);
    const mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const res: GpuHistPoint[] = [];
    for (let i = 0; i < pts.length; i += step) {
      const s = pts.slice(i, i + step);
      res.push({ t: s[Math.floor(s.length / 2)].t, util: mean(s.map((p) => p.util)), mem: mean(s.map((p) => p.mem)) });
    }
    out[k] = res;
  }
  return out;
}

export interface GpuFinding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  /** workload key (namespace/pod/container) or node, when it is about one. */
  subject?: string;
}

export interface FindingInput {
  now: number;
  workloads: Array<{ key: string; model?: string; phase: string; terminating?: boolean; gpus: number; node: string }>;
  /** Latest reading per workload key. */
  latest: Record<string, { util: number | null; mem: number | null; xid?: number | null; throttle?: string[] }>;
  history: Record<string, GpuHistPoint[]>;
  nodes: Array<{ name: string; allocatable: number; allocated: number }>;
  /** GPUs the DCGM exporter sees that no pod holds, per node. */
  unassigned?: Record<string, number>;
}

/** Idle threshold: below this compute util for the whole window counts as idle. */
export const IDLE_PCT = 5;
/** Window that must be covered before calling something idle. */
export const IDLE_WINDOW_MS = 60 * 60_000;

/** Waste, risk and queueing — what a GPU platform owner acts on. Pure. */
export function gpuFindings(input: FindingInput): GpuFinding[] {
  const out: GpuFinding[] = [];
  const label = (w: FindingInput['workloads'][number]) => w.model || w.key;
  const running = input.workloads.filter((w) => w.phase === 'Running' && !w.terminating);

  let idleGpus = 0;
  for (const w of running) {
    const r = input.latest[w.key];
    // XID errors: the driver reporting a GPU fault — the hardware equivalent of a kernel panic.
    if (r?.xid) {
      out.push({ id: `xid:${w.key}`, severity: 'critical', subject: w.key, title: `GPU fault (XID ${r.xid}) under ${label(w)}`,
        detail: `On node ${w.node}. XID 48/63/64/74/79/94/95 usually mean a reset or replacement; check dmesg on the node for "NVRM: Xid".` });
    }
    if (r?.mem !== null && r?.mem !== undefined && r.mem >= 95) {
      out.push({ id: `mem:${w.key}`, severity: 'warning', subject: w.key, title: `${label(w)} is using ${Math.round(r.mem)}% of GPU memory`,
        detail: 'One larger batch or a longer context and it fails with CUDA out-of-memory. vLLM pre-allocates (gpu-memory-utilization), so check whether this is by design.' });
    }
    const hot = (r?.throttle || []).filter((t) => /thermal|power brake|HW slowdown/i.test(t));
    if (hot.length) {
      out.push({ id: `throttle:${w.key}`, severity: 'warning', subject: w.key, title: `${label(w)} is being slowed down by the hardware`, detail: `${hot.join(', ')} on node ${w.node}.` });
    }
    const pts = (input.history[w.key] || []).filter((p) => p.t >= input.now - 6 * 3600_000);
    const withUtil = pts.filter((p) => p.util !== null);
    if (withUtil.length >= 3 && withUtil[withUtil.length - 1].t - withUtil[0].t >= IDLE_WINDOW_MS && withUtil.every((p) => (p.util as number) < IDLE_PCT)) {
      const hours = (withUtil[withUtil.length - 1].t - withUtil[0].t) / 3600_000;
      idleGpus += w.gpus;
      out.push({ id: `idle:${w.key}`, severity: 'warning', subject: w.key,
        title: `${label(w)} has held ${w.gpus} GPU${w.gpus === 1 ? '' : 's'} at under ${IDLE_PCT}% for ${hours >= 2 ? `${Math.round(hours)} h` : `${Math.round(hours * 60)} min`}`,
        detail: 'Allocated but idle: no one else can schedule on these GPUs. Scale it to zero, or share the GPU (MIG / time-slicing) if it serves light traffic.' });
    }
  }

  const pending = input.workloads.filter((w) => w.phase === 'Pending');
  if (pending.length) {
    const free = input.nodes.reduce((a, n) => a + Math.max(0, n.allocatable - n.allocated), 0);
    const wanted = pending.reduce((a, w) => a + w.gpus, 0);
    out.push({
      id: 'pending', severity: idleGpus > 0 ? 'warning' : 'info',
      title: `${pending.length} pod${pending.length === 1 ? '' : 's'} waiting for ${wanted} GPU${wanted === 1 ? '' : 's'}`,
      detail: `${free} GPU${free === 1 ? '' : 's'} free across nodes${idleGpus ? `, while ${idleGpus} allocated GPU${idleGpus === 1 ? ' sits' : 's sit'} idle` : ''}. ` +
        (free >= wanted ? 'There is capacity, so look at node selectors, taints, or a per-node fit problem (kubectl describe pod → Events).' : 'Not enough free GPUs — reclaim idle ones or add capacity.'),
    });
  }

  for (const [node, n] of Object.entries(input.unassigned || {})) {
    if (n > 0) out.push({ id: `unassigned:${node}`, severity: 'info', subject: node, title: `${n} GPU${n === 1 ? '' : 's'} on ${node} held by no pod`, detail: 'Free capacity as DCGM sees it.' });
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
