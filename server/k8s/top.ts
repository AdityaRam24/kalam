// Live CPU / memory usage from the metrics API (`kubectl top`).
//
// Requests and limits say what workloads ASKED for; this says what they are
// actually burning. It needs metrics-server, which many clusters lack — that
// is reported as `available: false` with kubectl's own reason, and the UI falls
// back to requests-vs-allocatable instead of showing an empty panel.

import { Router } from 'express';
import { runSteps, SAFE_NAME } from './kubectl.js';
import { parseCpu, parseMemory } from './workloads.js';

export interface NodeTop { name: string; cpuMilli: number; cpuPct: number | null; memBytes: number; memPct: number | null }
export interface PodTop { namespace: string; name: string; cpuMilli: number; memBytes: number }

const pct = (s: string): number | null => {
  const n = Number(String(s).replace('%', ''));
  return Number.isFinite(n) ? n : null;
};

/** `kubectl top nodes --no-headers`: NAME CPU(cores) CPU% MEMORY(bytes) MEMORY% */
export function parseTopNodes(text: string): NodeTop[] {
  const out: NodeTop[] = [];
  for (const line of (text || '').split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length < 5 || c[0] === 'NAME') continue;
    // A node whose kubelet stopped reporting prints <unknown> in every column.
    if (c[1] === '<unknown>') { out.push({ name: c[0], cpuMilli: 0, cpuPct: null, memBytes: 0, memPct: null }); continue; }
    out.push({ name: c[0], cpuMilli: parseCpu(c[1]), cpuPct: pct(c[2]), memBytes: parseMemory(c[3]), memPct: pct(c[4]) });
  }
  return out;
}

/** `kubectl top pods -A --no-headers`: NAMESPACE NAME CPU(cores) MEMORY(bytes) */
export function parseTopPods(text: string): PodTop[] {
  const out: PodTop[] = [];
  for (const line of (text || '').split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length < 4 || c[0] === 'NAMESPACE') continue;
    out.push({ namespace: c[0], name: c[1], cpuMilli: parseCpu(c[2]), memBytes: parseMemory(c[3]) });
  }
  return out;
}

export const topRouter = Router();

topRouter.get('/api/k8s/top', async (req, res) => {
  const vm = req.query.vm ? String(req.query.vm) : undefined;
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });
  const { out, ok, error } = await runSteps(
    [
      // Not optional: when it fails, kubectl's own message is the reason shown
      // (metrics API missing vs. the cluster being unreachable read differently).
      { tag: 'TOPN', args: ['top', 'nodes', '--no-headers'] },
      { tag: 'TOPP', args: ['top', 'pods', '--all-namespaces', '--no-headers'], optional: true },
    ],
    vm,
    45_000,
  );
  const nodes = ok.has('TOPN') ? parseTopNodes(out.TOPN) : [];
  const pods = ok.has('TOPP') ? parseTopPods(out.TOPP) : [];
  const available = nodes.length > 0 || pods.length > 0;
  res.json({
    ok: true,
    readOnly: true,
    available,
    reason: available ? undefined : (error || 'The metrics API is not available on this cluster (metrics-server is not installed or not ready).'),
    nodes,
    pods,
    at: new Date().toISOString(),
  });
});
