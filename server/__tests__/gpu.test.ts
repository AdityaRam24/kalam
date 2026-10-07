// The GPU page must show what is running NOW. These cover the two ways it
// used to show the past instead: probing the first N pods in kubectl's
// alphabetical order (so a new model was never read), and running every remote
// exec one after another in one SSH call (so a timeout cut off the tail).

import { describe, it, expect } from 'vitest';
import { gpuWorkloads, probeTargets, byNewest, workloadsFromDcgm, matchVisibleGpus, nodeSmiHosts, type GpuWorkload, type GpuReading } from '../k8s/gpu.js';
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

describe('new deployments that hold a GPU without a plain nvidia.com/gpu request', () => {
  const base = (name: string, c: any, extra: any = {}) => ({
    metadata: { name, namespace: 'models', creationTimestamp: '2026-10-07T09:00:00Z', ...extra.meta },
    spec: { nodeName: 'gpu-1', containers: [c], ...extra.spec },
    status: { phase: 'Running' },
  });

  it('counts time-sliced (gpu.shared) and pod-level requests', () => {
    const w = gpuWorkloads([
      base('shared', { name: 'srv', image: 'vllm/vllm-openai', resources: { limits: { 'nvidia.com/gpu.shared': '1' } } }),
      base('podlevel', { name: 'srv', image: 'vllm/vllm-openai' }, { spec: { resources: { limits: { 'nvidia.com/gpu': '2' } } } }),
      base('hami', { name: 'srv', image: 'x', resources: { limits: { 'nvidia.com/gpumem': '4000' } } }),
    ], new Map());
    expect(w.map((x) => [x.pod, x.gpus, x.via])).toEqual([['podlevel', 2, 'request'], ['shared', 1, 'request']]);
  });

  it('picks up NVIDIA_VISIBLE_DEVICES in the spec but not GPU Operator plumbing', () => {
    const w = gpuWorkloads([
      base('direct', { name: 'srv', image: 'my/llm', env: [{ name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' }] }),
      base('nvidia-device-plugin-daemonset-x', { name: 'p', image: 'nvcr.io/nvidia/k8s-device-plugin:v0.17', env: [{ name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' }] }),
      base('hidden', { name: 'srv', image: 'my/llm', env: [{ name: 'NVIDIA_VISIBLE_DEVICES', value: 'void' }] }),
    ], new Map());
    expect(w.map((x) => [x.pod, x.via])).toEqual([['direct', 'env']]);
  });

  it('adds pods DCGM maps to a GPU that nothing else revealed', () => {
    const pods = [base('dra-llm', { name: 'srv', image: 'my/llm' })];
    const gpus = [{ pod: 'dra-llm', namespace: 'models', container: 'srv', uuid: 'GPU-1' }, { pod: 'gone', namespace: 'models' }] as any;
    const w = workloadsFromDcgm(pods, gpus, [], new Map());
    expect(w.map((x) => [x.pod, x.container, x.gpus, x.via])).toEqual([['dra-llm', 'srv', 1, 'dcgm']]);
    expect(workloadsFromDcgm(pods, gpus, w, new Map())).toEqual([]);
  });

  it('names an otherwise unidentified model after its workload', () => {
    const p = base('llama-5d8f9c7b4-abcde', { name: 'srv', image: 'my/llm' }, { meta: { ownerReferences: [{ kind: 'ReplicaSet', name: 'llama-70b-5d8f9c7b4' }] } });
    expect(gpuWorkloads([{ ...p, spec: { ...p.spec, containers: [{ name: 'srv', image: 'my/llm', resources: { limits: { 'nvidia.com/gpu': 1 } } }] } }], new Map())[0].model.model).toBe('llama-70b');
  });
});

describe('node fallback for images without nvidia-smi', () => {
  const g = (index: number, uuid: string) => ({ index, uuid }) as GpuReading;
  const node = [g(0, 'GPU-a'), g(1, 'GPU-b'), g(2, 'GPU-c')];

  it('matches the container\'s devices by UUID, index, all, or /dev listing', () => {
    expect(matchVisibleGpus(node, 'PATH=/bin\nNVIDIA_VISIBLE_DEVICES=GPU-b,GPU-c\n', '').map((x) => x.index)).toEqual([1, 2]);
    expect(matchVisibleGpus(node, 'NVIDIA_VISIBLE_DEVICES=0\n', '').map((x) => x.index)).toEqual([0]);
    expect(matchVisibleGpus(node, 'NVIDIA_VISIBLE_DEVICES=all\n', '')).toHaveLength(3);
    expect(matchVisibleGpus(node, '', 'null\nnvidia2\nnvidia-uvm\nnvidiactl\n').map((x) => x.index)).toEqual([2]);
    expect(matchVisibleGpus(node, '', '')).toEqual([]);
  });

  it('prefers the driver pod on each node', () => {
    const op = (name: string, app: string, node: string, container: string) => ({
      metadata: { name, namespace: 'gpu-operator', labels: { app } }, spec: { nodeName: node, containers: [{ name: container }] }, status: { phase: 'Running' },
    });
    const h = nodeSmiHosts([
      op('nvidia-dcgm-exporter-1', 'nvidia-dcgm-exporter', 'gpu-1', 'nvidia-dcgm-exporter'),
      op('nvidia-driver-daemonset-1', 'nvidia-driver-daemonset', 'gpu-1', 'nvidia-driver-ctr'),
      op('nvidia-device-plugin-daemonset-1', 'nvidia-device-plugin-daemonset', 'gpu-1', 'nvidia-device-plugin'),
      op('unrelated', 'web', 'gpu-1', 'web'),
    ]);
    expect(h.get('gpu-1')?.map((x) => x.container)).toEqual(['nvidia-driver-ctr', 'nvidia-device-plugin']);
  });
});
