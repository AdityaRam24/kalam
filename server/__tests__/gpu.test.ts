// The GPU page must show what is running NOW. These cover the two ways it
// used to show the past instead: probing the first N pods in kubectl's
// alphabetical order (so a new model was never read), and running every remote
// exec one after another in one SSH call (so a timeout cut off the tail).

import { describe, it, expect } from 'vitest';
import { gpuWorkloads, probeTargets, byNewest, type GpuWorkload } from '../k8s/gpu.js';
import { buildRemoteScript } from '../k8s/kubectl.js';

const pod = (name: string, startTime: string, extra: { phase?: string; deleting?: boolean; ns?: string } = {}) => ({
  metadata: {
    name, namespace: extra.ns || 'models', creationTimestamp: startTime,
    ...(extra.deleting ? { deletionTimestamp: '2026-10-07T10:00:00Z' } : {}),
  },
  spec: { nodeName: 'gpu-1', containers: [{ name: 'srv', image: 'vllm/vllm-openai', resources: { limits: { 'nvidia.com/gpu': '1' } } }] },
  status: { phase: extra.phase || 'Running', startTime },
});

describe('gpuWorkloads ordering', () => {
  const pods = [
    pod('a-old', '2026-10-01T00:00:00Z', { ns: 'aaa' }),
    pod('z-new', '2026-10-07T09:00:00Z', { ns: 'zzz' }),
    pod('m-done', '2026-10-07T09:30:00Z', { phase: 'Succeeded' }),
    pod('b-going', '2026-10-05T00:00:00Z', { deleting: true }),
    pod('p-wait', '2026-10-07T09:45:00Z', { phase: 'Pending' }),
  ];
  const w = gpuWorkloads(pods, new Map());

  it('lists running pods newest first, then pending, terminating, finished', () => {
    expect(w.map((x) => x.pod)).toEqual(['z-new', 'a-old', 'p-wait', 'b-going', 'm-done']);
  });

  it('records start time and terminating state', () => {
    expect(w.find((x) => x.pod === 'z-new')?.startedAt).toBe('2026-10-07T09:00:00Z');
    expect(w.find((x) => x.pod === 'b-going')?.terminating).toBe(true);
    expect(w.find((x) => x.pod === 'a-old')?.terminating).toBe(false);
  });

  it('probes the newest running pods, never terminating or finished ones', () => {
    expect(probeTargets(w, 1).map((x) => x.pod)).toEqual(['z-new']);
    expect(probeTargets(w, 10).map((x) => x.pod)).toEqual(['z-new', 'a-old']);
  });

  it('falls back to name order when start times tie', () => {
    const base = { container: 'c', node: 'n', phase: 'Running', gpus: 1, image: '', model: { server: 'x', evidence: [] } };
    const a = { ...base, namespace: 'ns', pod: 'a', startedAt: '2026-10-07T00:00:00Z' } as GpuWorkload;
    const b = { ...base, namespace: 'ns', pod: 'b', startedAt: '2026-10-07T00:00:00Z' } as GpuWorkload;
    expect([b, a].sort(byNewest).map((x) => x.pod)).toEqual(['a', 'b']);
  });
});

describe('buildRemoteScript', () => {
  const steps = [
    { tag: 'Q0', args: ['exec', 'p0', '--', 'nvidia-smi'] },
    { tag: 'Q1', args: ['exec', 'p1', '--', 'nvidia-smi'] },
    { tag: 'Q2', args: ['exec', 'p2', '--', 'nvidia-smi'] },
  ];

  it('stays sequential by default (unchanged for every other caller)', () => {
    expect(buildRemoteScript(steps)).toBe(
      'echo @@Q0@@; (kubectl exec p0 -- nvidia-smi 2>/dev/null || true) | sed "s/@@/@ @/g"; ' +
      'echo @@Q1@@; (kubectl exec p1 -- nvidia-smi 2>/dev/null || true) | sed "s/@@/@ @/g"; ' +
      'echo @@Q2@@; (kubectl exec p2 -- nvidia-smi 2>/dev/null || true) | sed "s/@@/@ @/g"; ' +
      'echo @@END@@');
  });

  it('runs batches in the background and prints each batch once it finishes', () => {
    const s = buildRemoteScript(steps, { parallel: 2, stepTimeoutSec: 20 });
    expect(s).toContain('_to 20 kubectl exec p0');
    expect(s).toContain('> "$_T/0" & ');
    expect(s).not.toMatch(/&\s*;/); // `& ;` is a shell syntax error
    // Batch 1 (Q0,Q1) is printed before batch 2 (Q2) even starts.
    expect(s.indexOf('echo @@Q1@@')).toBeLessThan(s.indexOf('"$_T/2" &'));
    expect(s.trim().endsWith('rm -rf "$_T"')).toBe(true);
  });
});
