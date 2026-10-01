// Status derivation, extra resource kinds, `kubectl top`, GPU readings and
// history facets — the logic behind the Kubernetes, GPU, dashboard-metrics and
// change-history views. All pure, so the rules are asserted rather than trusted.

import { describe, it, expect } from 'vitest';
import { podDisplayStatus, podHealth, workloadStatus, normalizePod, normalizeWorkload, normalizeNode } from '../k8s/workloads.js';
import { KINDS, rowsFor, stepFor, daysUntil, isvcModel } from '../k8s/resources.js';
import { parseTopNodes, parseTopPods } from '../k8s/top.js';
import {
  parseGpuReadings, throttleReasons, detectModel, gpuWorkloads, gpuNodes, gpuCount, servingStack, smiSteps, CORE_FIELDS,
} from '../k8s/gpu.js';
import { buildFacets } from '../history/router.js';
import { kubectlErrorLine } from '../k8s/kubectl.js';

describe('kubectlErrorLine', () => {
  it("prefers kubectl's own summary over klog noise", () => {
    const stderr = [
      'E1001 23:33:59.866725   37164 memcache.go:265] "Unhandled Error" err="couldn\'t get current server API group list"',
      'E1001 23:34:09.866725   37164 memcache.go:265] "Unhandled Error" err="again"',
      'Unable to connect to the server: net/http: TLS handshake timeout',
    ].join('\n');
    expect(kubectlErrorLine(stderr)).toBe('Unable to connect to the server: net/http: TLS handshake timeout');
  });
  it('strips the klog prefix when there is no summary line', () => {
    expect(kubectlErrorLine('E1001 23:33:59.866725   37164 memcache.go:265] something broke')).toBe('something broke');
    expect(kubectlErrorLine('error: the server doesn\'t have a resource type "foo"')).toBe('error: the server doesn\'t have a resource type "foo"');
    expect(kubectlErrorLine('')).toBe('');
  });
});

const pod = (status: any, extra: any = {}) => ({
  metadata: { name: 'p', namespace: 'ns', ...(extra.metadata || {}) },
  spec: { containers: [{ name: 'c' }], ...(extra.spec || {}) },
  status,
});

describe('podDisplayStatus — matches kubectl STATUS', () => {
  it('reports CrashLoopBackOff even though the phase is Running', () => {
    const p = pod({ phase: 'Running', containerStatuses: [{ name: 'c', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] });
    expect(podDisplayStatus(p)).toBe('CrashLoopBackOff');
    expect(normalizePod(p).status).toBe('Running'); // phase is still kept
    expect(normalizePod(p).displayStatus).toBe('CrashLoopBackOff');
    expect(normalizePod(p).health).toBe('failing');
  });

  it('reports image pull failures on a Pending pod', () => {
    const p = pod({ phase: 'Pending', containerStatuses: [{ name: 'c', state: { waiting: { reason: 'ImagePullBackOff' } } }] });
    expect(podDisplayStatus(p)).toBe('ImagePullBackOff');
    expect(podHealth('ImagePullBackOff')).toBe('failing');
  });

  it('reports OOMKilled / Error / ExitCode from a terminated container', () => {
    expect(podDisplayStatus(pod({ phase: 'Running', containerStatuses: [{ state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] }))).toBe('OOMKilled');
    expect(podDisplayStatus(pod({ phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode: 2 } } }] }))).toBe('ExitCode:2');
  });

  it('reports init progress and init failures', () => {
    const spec = { initContainers: [{ name: 'a' }, { name: 'b' }] };
    expect(podDisplayStatus(pod({ phase: 'Pending', initContainerStatuses: [
      { state: { terminated: { exitCode: 0 } } }, { state: { running: {} } },
    ] }, { spec }))).toBe('Init:1/2');
    expect(podDisplayStatus(pod({ phase: 'Pending', initContainerStatuses: [
      { state: { waiting: { reason: 'CrashLoopBackOff' } } },
    ] }, { spec }))).toBe('Init:CrashLoopBackOff');
    expect(podHealth('Init:1/2')).toBe('progressing');
    expect(podHealth('Init:CrashLoopBackOff')).toBe('failing');
  });

  it('reports Terminating, Evicted, Completed and a healthy Running pod', () => {
    expect(podDisplayStatus(pod({ phase: 'Running' }, { metadata: { deletionTimestamp: '2026-01-01T00:00:00Z' } }))).toBe('Terminating');
    expect(podDisplayStatus(pod({ phase: 'Failed', reason: 'Evicted' }))).toBe('Evicted');
    const done = pod({ phase: 'Succeeded', containerStatuses: [{ state: { terminated: { reason: 'Completed', exitCode: 0 } } }] });
    expect(podDisplayStatus(done)).toBe('Completed');
    expect(podHealth('Completed')).toBe('completed');
    const ok = pod({ phase: 'Running', containerStatuses: [{ ready: true, state: { running: {} } }] });
    expect(podDisplayStatus(ok)).toBe('Running');
    expect(normalizePod(ok).health).toBe('healthy');
  });

  it('a running pod with an unready container is progressing, not healthy', () => {
    expect(podHealth('Running', '1/2')).toBe('progressing');
    expect(podHealth('Running', '2/2')).toBe('healthy');
  });

  it('keeps the last termination reason that explains restarts', () => {
    const p = pod({ phase: 'Running', containerStatuses: [{ ready: true, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled' } }, restartCount: 4 }] });
    expect(normalizePod(p).lastReason).toBe('OOMKilled');
  });
});

describe('workloadStatus', () => {
  const base = { desired: 3, ready: 3, available: 3, updated: 3, conditions: [] as any[] };
  it('classifies the rollout states', () => {
    expect(workloadStatus(base)).toEqual({ status: 'Available', health: 'healthy' });
    expect(workloadStatus({ ...base, ready: 0, available: 0 })).toEqual({ status: 'Unavailable', health: 'failing' });
    expect(workloadStatus({ ...base, ready: 2, available: 2 })).toEqual({ status: 'Degraded', health: 'progressing' });
    expect(workloadStatus({ ...base, updated: 1, ready: 2 })).toEqual({ status: 'Updating', health: 'progressing' });
    expect(workloadStatus({ ...base, desired: 0, ready: 0, available: 0 })).toEqual({ status: 'ScaledToZero', health: 'completed' });
    expect(workloadStatus({ ...base, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] }).status).toBe('Failed');
  });

  it('an absent updated count does not read as a rollout in progress', () => {
    const w = normalizeWorkload({ kind: 'StatefulSet', metadata: { name: 'pg' }, spec: { replicas: 2 }, status: { readyReplicas: 2, availableReplicas: 2 } });
    expect(w.status).toBe('Available');
  });
});

describe('normalizeNode capacity', () => {
  it('parses allocatable, pressure and schedulability', () => {
    const n = normalizeNode({
      metadata: { name: 'gpu1', labels: { 'nvidia.com/gpu.product': 'NVIDIA-A100' } },
      spec: { unschedulable: true },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'True' }],
        capacity: { cpu: '64', memory: '512Gi', 'nvidia.com/gpu': '8', pods: '110' },
        allocatable: { cpu: '63500m', memory: '500Gi', 'nvidia.com/gpu': '8', pods: '110' },
      },
    });
    expect(n.allocatable).toEqual({ cpuMilli: 63500, memBytes: 500 * 1024 ** 3, gpu: 8, pods: 110 });
    expect(n.schedulable).toBe(false);
    expect(n.pressure).toEqual(['MemoryPressure']);
    expect(n.gpuProduct).toBe('NVIDIA-A100');
  });
});

describe('extra resource kinds', () => {
  const spec = (key: string) => KINDS.find((k) => k.key === key)!;

  it('never reads Secret or ConfigMap contents', () => {
    for (const key of ['SECRET', 'CM']) {
      const args = stepFor(spec(key)).args.join(' ');
      expect(args).toContain('custom-columns=');
      expect(args).not.toContain('-o json');
      expect(args).not.toMatch(/\.data/);
    }
  });

  it('fully qualifies CRD-backed kinds so the wrong API group cannot answer', () => {
    expect(stepFor(spec('GW')).args[1]).toBe('gateways.networking.istio.io');
    expect(stepFor(spec('CERT')).args[1]).toBe('certificates.cert-manager.io');
    expect(stepFor(spec('ISVC')).args[1]).toBe('inferenceservices.serving.kserve.io');
  });

  it('parses projected columns, including an empty listing', () => {
    const rows = rowsFor(spec('SECRET'), 'kube-system  bootstrap-token  bootstrap.kubernetes.io/token  2026-01-01T00:00:00Z\n')!;
    expect(rows).toEqual([{ kind: 'Secret', namespace: 'kube-system', name: 'bootstrap-token', created: '2026-01-01T00:00:00Z', status: 'Present', health: 'healthy', info: [['Type', 'bootstrap.kubernetes.io/token']] }]);
    expect(rowsFor(spec('CM'), '')).toEqual([]);
  });

  it('a missing CRD (unparseable output) is null, not an empty list', () => {
    expect(rowsFor(spec('CERT'), '')).toBeNull();
    expect(rowsFor(spec('CERT'), 'error: the server doesn\'t have a resource type')).toBeNull();
  });

  it('flags certificates that are expired or expiring soon', () => {
    const now = Date.now();
    const cert = (notAfter: string, ready = 'True') => JSON.stringify({ items: [{
      metadata: { name: 'c', namespace: 'n' }, spec: { dnsNames: ['a.example'] },
      status: { notAfter, conditions: [{ type: 'Ready', status: ready }] },
    }] });
    const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();
    expect(rowsFor(spec('CERT'), cert(iso(60)))![0].status).toBe('Ready');
    expect(rowsFor(spec('CERT'), cert(iso(5)))![0].status).toBe('ExpiringSoon');
    expect(rowsFor(spec('CERT'), cert(iso(-2)))![0]).toMatchObject({ status: 'Expired', health: 'failing' });
    expect(daysUntil(iso(10), now)).toBe(10);
    expect(daysUntil(iso(9.5), now)).toBe(9);
  });

  it('summarizes PVC phases and InferenceService readiness', () => {
    const pvc = JSON.stringify({ items: [{ metadata: { name: 'data', namespace: 'n' }, spec: { storageClassName: 'fast', accessModes: ['ReadWriteOnce'] }, status: { phase: 'Pending' } }] });
    expect(rowsFor(spec('PVC'), pvc)![0]).toMatchObject({ status: 'Pending', health: 'progressing', namespace: 'n' });
    const isvc = JSON.stringify({ items: [{
      metadata: { name: 'llama', namespace: 'ai' },
      spec: { predictor: { model: { modelFormat: { name: 'huggingface' }, storageUri: 'hf://meta/llama' } } },
      status: { url: 'http://llama.ai', conditions: [{ type: 'Ready', status: 'False', reason: 'RevisionMissing' }] },
    }] });
    const row = rowsFor(spec('ISVC'), isvc)![0];
    expect(row).toMatchObject({ status: 'RevisionMissing', health: 'failing' });
    expect(row.info).toContainEqual(['Storage', 'hf://meta/llama']);
  });

  it('reads the model from both KServe predictor forms', () => {
    expect(isvcModel({ spec: { predictor: { sklearn: { storageUri: 's3://m' } } } })).toEqual({ format: 'sklearn', storageUri: 's3://m' });
  });
});

describe('kubectl top parsing', () => {
  it('parses nodes, including one that stopped reporting', () => {
    expect(parseTopNodes('n1   250m   6%   2048Mi   26%\nn2 <unknown> <unknown> <unknown> <unknown>\n')).toEqual([
      { name: 'n1', cpuMilli: 250, cpuPct: 6, memBytes: 2048 * 1024 ** 2, memPct: 26 },
      { name: 'n2', cpuMilli: 0, cpuPct: null, memBytes: 0, memPct: null },
    ]);
  });
  it('parses pods across namespaces', () => {
    expect(parseTopPods('kube-system coredns-1 3m 12Mi\n')).toEqual([{ namespace: 'kube-system', name: 'coredns-1', cpuMilli: 3, memBytes: 12 * 1024 ** 2 }]);
  });
});

describe('GPU readings', () => {
  const core = '0, GPU-aaa, NVIDIA A100-SXM4-80GB, 00000000:07:00.0, 550.54.15, P0, 41, 87, 60, 81920, 61440, 20480, 312.5, 400.00, 1410, 1593, 1410, [N/A], Enabled, Default, 4, 16\n';
  const ext = 'GPU-aaa, Disabled, 0, 0x0000000000000004, 55, 0\n';
  const apps = 'GPU-aaa, 1234, python3, 61000\n';

  it('joins core, extended and process readings by GPU uuid', () => {
    const [g] = parseGpuReadings(core, ext, apps);
    expect(g).toMatchObject({
      index: 0, uuid: 'GPU-aaa', name: 'NVIDIA A100-SXM4-80GB', utilPct: 87, memUsedMiB: 61440, memTotalMiB: 81920,
      powerW: 312.5, fanPct: null, pcie: 'Gen4 x16', mig: 'Disabled', eccUncorrected: 0, throttle: ['SW power cap'],
    });
    expect(g.processes).toEqual([{ pid: '1234', name: 'python3', usedMiB: 61000 }]);
  });

  it('survives a driver that rejects the extended query', () => {
    const [g] = parseGpuReadings(core, 'Field "temperature.memory" is not a valid field to query.', '');
    expect(g.utilPct).toBe(87);
    expect(g.mig).toBeUndefined();
  });

  it('decodes throttle reasons', () => {
    expect(throttleReasons('0x0000000000000000')).toEqual([]);
    expect(throttleReasons('0x0000000000000044')).toEqual(['SW power cap', 'HW thermal']);
  });

  it('queries exactly the declared core fields', () => {
    const q = smiSteps(0, { namespace: 'ai', pod: 'p', container: 'c' })[0].args.find((a) => a.startsWith('--query-gpu='))!;
    expect(q.split('=')[1].split(',')).toHaveLength(CORE_FIELDS.length);
  });
});

describe('GPU workload and model detection', () => {
  const vllmPod = {
    metadata: { name: 'llama-0', namespace: 'ai', labels: { 'serving.kserve.io/inferenceservice': 'llama' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'llama-rs' }] },
    spec: { nodeName: 'gpu1', containers: [
      { name: 'kserve-container', image: 'vllm/vllm-openai:v0.6', args: ['--served-model-name=llama-3-8b', '--model', '/mnt/models'], resources: { limits: { 'nvidia.com/gpu': '2' } } },
      { name: 'queue-proxy', image: 'knative/queue', resources: {} },
    ] },
    status: { phase: 'Running' },
  };

  it('only GPU-requesting containers are GPU workloads', () => {
    const w = gpuWorkloads([vllmPod], new Map());
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ pod: 'llama-0', container: 'kserve-container', gpus: 2, node: 'gpu1' });
  });

  it('prefers the served model name and names the serving stack', () => {
    const m = detectModel(vllmPod, vllmPod.spec.containers[0], new Map());
    expect(m.model).toBe('llama-3-8b');
    expect(m.server).toBe('vLLM');
    expect(m.evidence.map((e) => e.source)).toContain('InferenceService');
  });

  it('falls back to env vars and the positional `vllm serve` model', () => {
    expect(detectModel({ metadata: {} }, { image: 'x', env: [{ name: 'MODEL_ID', value: 'mistral-7b' }] }, new Map()).model).toBe('mistral-7b');
    expect(detectModel({ metadata: {} }, { image: 'vllm', command: ['vllm', 'serve', 'Qwen/Qwen2-7B'] }, new Map()).model).toBe('Qwen/Qwen2-7B');
    expect(servingStack('nvcr.io/nim/meta/llama3-8b')).toBe('NVIDIA NIM');
  });

  it('counts MIG slices and allocation per node', () => {
    expect(gpuCount({ 'nvidia.com/mig-1g.10gb': '3', cpu: '4' })).toBe(3);
    const nodes = gpuNodes([{ metadata: { name: 'gpu1', labels: {} }, status: { capacity: { 'nvidia.com/gpu': '8' }, allocatable: { 'nvidia.com/gpu': '8' } } },
      { metadata: { name: 'cpu1' }, status: { capacity: { cpu: '8' } } }], gpuWorkloads([vllmPod], new Map()));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'gpu1', capacity: 8, allocated: 2 });
  });
});

describe('history facets', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const ch = (h: number, extra: any = {}) => ({
    at: new Date(now - h * 3_600_000).toISOString(), objectKind: 'Deployment', name: 'web', namespace: 'shop',
    severity: 'info', kind: 'image', ...extra,
  });

  it('lists every tracked namespace, even ones with no changes', () => {
    const f = buildFacets([ch(1)], [{ namespace: 'shop' }, { namespace: 'kube-system' }, {}], now - 86_400_000, now);
    expect(f.namespaces).toEqual([
      { name: 'shop', changes: 1, objects: 1 },
      { name: 'kube-system', changes: 0, objects: 1 },
    ]);
  });

  it('counts kinds, actors and builds an hourly histogram for a day', () => {
    const f = buildFacets([ch(1, { actor: 'helm' }), ch(1.5, { severity: 'warning', actor: 'helm' }), ch(5, { objectKind: 'Pod' })], [], now - 86_400_000, now);
    expect(f.objectKinds[0]).toEqual({ kind: 'Deployment', changes: 2 });
    expect(f.actors).toEqual([{ actor: 'helm', changes: 2 }]);
    expect(f.bucketMs).toBe(3_600_000);
    expect(f.buckets).toHaveLength(24);
    expect(f.buckets.reduce((a, b) => a + b.total, 0)).toBe(3);
    expect(f.warnings).toBe(1);
    expect(f.topObjects[0]).toMatchObject({ name: 'web', changes: 2 });
  });

  it('switches to daily buckets for long windows', () => {
    const f = buildFacets([], [], now - 7 * 86_400_000, now);
    expect(f.bucketMs).toBe(86_400_000);
    expect(f.buckets).toHaveLength(7);
  });
});
