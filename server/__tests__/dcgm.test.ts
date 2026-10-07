// DCGM exporter parsing, GPU → pod assignment, and the findings that need
// history (idle GPUs, memory at the edge, pods queued for GPUs).

import { describe, it, expect } from 'vitest';
import { parsePromText, parseDcgm, dcgmExporters } from '../k8s/dcgm.js';
import { gpuFindings, seriesByWorkload, IDLE_WINDOW_MS } from '../k8s/gpuhistory.js';
import { assignDcgm, gpuWorkloads } from '../k8s/gpu.js';

// Shape of a real GPU Operator dcgm-exporter scrape (trimmed).
const L0 = 'gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:3B:00.0",device="nvidia0",modelName="NVIDIA H100 NVL",Hostname="gpu-node-1",DCGM_FI_DRIVER_VERSION="550.90.07",container="vllm",namespace="models",pod="llama-0"';
const L1 = 'gpu="1",UUID="GPU-bbb",pci_bus_id="00000000:86:00.0",device="nvidia1",modelName="NVIDIA H100 NVL",Hostname="gpu-node-1",DCGM_FI_DRIVER_VERSION="550.90.07"';
const METRICS = `# HELP DCGM_FI_DEV_GPU_UTIL GPU utilization (in %).
# TYPE DCGM_FI_DEV_GPU_UTIL gauge
DCGM_FI_DEV_GPU_UTIL{${L0}} 87
DCGM_FI_DEV_GPU_UTIL{${L1}} 0
DCGM_FI_DEV_FB_USED{${L0}} 90000
DCGM_FI_DEV_FB_FREE{${L0}} 3000
DCGM_FI_DEV_FB_RESERVED{${L0}} 1000
DCGM_FI_DEV_FB_USED{${L1}} 1
DCGM_FI_DEV_FB_FREE{${L1}} 93999
DCGM_FI_DEV_GPU_TEMP{${L0}} 71
DCGM_FI_DEV_POWER_USAGE{${L0}} 301.5
DCGM_FI_DEV_SM_CLOCK{${L0}} 1755
DCGM_FI_DEV_XID_ERRORS{${L0}} 0
DCGM_FI_DEV_XID_ERRORS{${L1}} 79
DCGM_FI_PROF_GR_ENGINE_ACTIVE{${L0}} 0.62
DCGM_FI_DEV_UNKNOWN_THING{${L0}} 5
`;

describe('parsePromText', () => {
  it('reads names, labels (with escapes) and values; skips comments', () => {
    const s = parsePromText('# HELP x\nfoo{a="1",b="say \\"hi\\""} 3.5\nbar 7\nbad line\n');
    expect(s).toEqual([
      { name: 'foo', labels: { a: '1', b: 'say "hi"' }, value: 3.5 },
      { name: 'bar', labels: {}, value: 7 },
    ]);
  });
});

describe('parseDcgm', () => {
  const g = parseDcgm(METRICS, 'gpu-node-1');

  it('folds every series for a GPU into one reading', () => {
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({
      node: 'gpu-node-1', index: 0, uuid: 'GPU-aaa', name: 'NVIDIA H100 NVL', driver: '550.90.07',
      utilPct: 87, memUsedMiB: 90000, memFreeMiB: 3000, memTotalMiB: 94000, tempC: 71, powerW: 301.5, smClockMHz: 1755,
      namespace: 'models', pod: 'llama-0', container: 'vllm', source: 'dcgm',
    });
    expect(g[0].engineActivePct).toBeCloseTo(62);
  });

  it('keeps a GPU no pod holds, with its XID', () => {
    expect(g[1]).toMatchObject({ uuid: 'GPU-bbb', xid: 79, utilPct: 0 });
    expect(g[1].pod).toBeUndefined();
  });
});

describe('dcgmExporters', () => {
  it('finds running exporters by GPU Operator or chart labels, with the metrics port', () => {
    const pods = [
      { metadata: { name: 'nvidia-dcgm-exporter-x', namespace: 'gpu-operator', labels: { app: 'nvidia-dcgm-exporter' } }, spec: { nodeName: 'n1', containers: [{ ports: [{ name: 'metrics', containerPort: 9400 }] }] }, status: { phase: 'Running' } },
      { metadata: { name: 'dcgm-y', namespace: 'mon', labels: { 'app.kubernetes.io/name': 'dcgm-exporter' } }, spec: { nodeName: 'n2', containers: [{ ports: [{ name: 'metrics', containerPort: 9500 }] }] }, status: { phase: 'Running' } },
      { metadata: { name: 'nvidia-dcgm-exporter-z', namespace: 'gpu-operator', labels: { app: 'nvidia-dcgm-exporter' } }, spec: { nodeName: 'n3', containers: [] }, status: { phase: 'Pending' } },
      { metadata: { name: 'web', namespace: 'default', labels: { app: 'web' } }, spec: { containers: [] }, status: { phase: 'Running' } },
    ];
    expect(dcgmExporters(pods)).toEqual([
      { namespace: 'gpu-operator', pod: 'nvidia-dcgm-exporter-x', node: 'n1', port: 9400 },
      { namespace: 'mon', pod: 'dcgm-y', node: 'n2', port: 9500 },
    ]);
  });
});

describe('assignDcgm', () => {
  it('maps GPUs to the workload holding them and counts free ones per node', () => {
    const workloads = gpuWorkloads([{
      metadata: { name: 'llama-0', namespace: 'models', creationTimestamp: '2026-10-07T00:00:00Z' },
      spec: { nodeName: 'gpu-node-1', containers: [{ name: 'vllm', image: 'vllm/vllm-openai', resources: { limits: { 'nvidia.com/gpu': '1' } } }] },
      status: { phase: 'Running' },
    }], new Map());
    const { byKey, unassigned } = assignDcgm(workloads, parseDcgm(METRICS, 'gpu-node-1'));
    expect(Object.keys(byKey)).toEqual(['models/llama-0/vllm']);
    expect(byKey['models/llama-0/vllm'][0].uuid).toBe('GPU-aaa');
    expect(unassigned).toEqual({ 'gpu-node-1': 1 });
  });
});

describe('gpuFindings', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const w = (key: string, phase = 'Running', gpus = 1) => ({ key, model: key.split('/')[1], phase, gpus, node: 'gpu-node-1' });
  const flat = (util: number, n = 5, spanMs = IDLE_WINDOW_MS + 60_000) =>
    Array.from({ length: n }, (_, i) => ({ t: now - spanMs + (i * spanMs) / (n - 1), util, mem: 40 }));

  it('calls a GPU idle only after the whole window is under the threshold', () => {
    const f = gpuFindings({
      now, nodes: [{ name: 'gpu-node-1', allocatable: 4, allocated: 2 }],
      workloads: [w('m/idle/c', 'Running', 2), w('m/busy/c'), w('m/new/c')],
      latest: { 'm/idle/c': { util: 1, mem: 40 }, 'm/busy/c': { util: 80, mem: 40 }, 'm/new/c': { util: 0, mem: 10 } },
      history: { 'm/idle/c': flat(2), 'm/busy/c': flat(80), 'm/new/c': flat(0, 3, 10 * 60_000) },
    });
    expect(f.map((x) => x.id)).toEqual(['idle:m/idle/c']);
    expect(f[0].title).toMatch(/held 2 GPUs at under 5% for 61 min/);
  });

  it('flags XID faults, full memory, and pods queued while allocated GPUs idle', () => {
    const f = gpuFindings({
      now, nodes: [{ name: 'gpu-node-1', allocatable: 2, allocated: 2 }],
      workloads: [w('m/idle/c'), w('m/full/c'), w('m/broken/c'), w('m/waiting/c', 'Pending', 2)],
      latest: { 'm/idle/c': { util: 0, mem: 10 }, 'm/full/c': { util: 50, mem: 97 }, 'm/broken/c': { util: 0, mem: 0, xid: 79 } },
      history: { 'm/idle/c': flat(0) },
      unassigned: { 'gpu-node-2': 3 },
    });
    expect(f[0]).toMatchObject({ id: 'xid:m/broken/c', severity: 'critical' });
    expect(f.find((x) => x.id === 'mem:m/full/c')?.severity).toBe('warning');
    expect(f.find((x) => x.id === 'pending')).toMatchObject({ severity: 'warning', title: '1 pod waiting for 2 GPUs' });
    expect(f.find((x) => x.id === 'pending')?.detail).toMatch(/0 GPUs free across nodes, while 1 allocated GPU sits idle/);
    expect(f.find((x) => x.id === 'unassigned:gpu-node-2')?.severity).toBe('info');
  });
});

describe('seriesByWorkload', () => {
  it('groups per workload and thins long runs', () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({ at: i, w: { a: { gpus: 1, util: i, mem: null } } }));
    const s = seriesByWorkload(lines, 60);
    expect(s.a).toHaveLength(60);
    expect(s.a[0].util).toBe(0.5);
    expect(s.a[0].mem).toBeNull();
  });
});

describe('parseDcgm relabelled pod labels', () => {
  it('reads exported_pod / exported_namespace / exported_container', () => {
    const [g] = parseDcgm('DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-z",exported_pod="new-0",exported_namespace="m",exported_container="c"} 5\n', 'n1');
    expect([g.pod, g.namespace, g.container, g.utilPct]).toEqual(['new-0', 'm', 'c', 5]);
  });
});
