// The normalizer feeds both the local endpoint and the SSH path, so a bug here
// shows up as an empty or wrongly-wired topology map on every source at once.

import { describe, it, expect } from 'vitest';
import {
  normalizeClusterItems, normalizePod, normalizeService, normalizeWorkload,
  normalizeNode, resolvePodOwner, indexByKey, parseReplicaSetOwners,
  parseCpu, parseMemory, parseResources,
} from '../k8s/workloads.js';

const rs = (name: string, ns: string, ownerKind: string | null, ownerName?: string) => ({
  kind: 'ReplicaSet',
  metadata: {
    name, namespace: ns,
    ownerReferences: ownerKind ? [{ kind: ownerKind, name: ownerName, controller: true }] : [],
  },
});

const podItem = (name: string, ns: string, refs: any[] = []) => ({
  kind: 'Pod',
  metadata: { name, namespace: ns, ownerReferences: refs, labels: { app: 'web' } },
  spec: { nodeName: 'node-1', containers: [{ name: 'c', image: 'nginx:1.25' }] },
  status: { phase: 'Running', podIP: '10.0.0.5', containerStatuses: [{ name: 'c', ready: true, restartCount: 2, state: { running: {} } }] },
});

describe('resolvePodOwner', () => {
  it('follows ReplicaSet → Deployment, the hop that names the real owner', () => {
    const sets = indexByKey([rs('web-7d9f', 'default', 'Deployment', 'web')]);
    const owner = resolvePodOwner(podItem('web-7d9f-abc', 'default', [{ kind: 'ReplicaSet', name: 'web-7d9f', controller: true }]), sets);
    expect(owner).toEqual({ kind: 'Deployment', name: 'web' });
  });

  it('returns StatefulSet / DaemonSet owners directly', () => {
    const owner = resolvePodOwner(podItem('pg-0', 'db', [{ kind: 'StatefulSet', name: 'pg', controller: true }]), new Map());
    expect(owner).toEqual({ kind: 'StatefulSet', name: 'pg' });
  });

  it('reports a bare ReplicaSet rather than claiming the pod is unowned', () => {
    const sets = indexByKey([rs('lonely', 'default', null)]);
    expect(resolvePodOwner(podItem('lonely-1', 'default', [{ kind: 'ReplicaSet', name: 'lonely', controller: true }]), sets))
      .toEqual({ kind: 'ReplicaSet', name: 'lonely' });
  });

  it('does not confuse same-named ReplicaSets in different namespaces', () => {
    const sets = indexByKey([rs('web-1', 'a', 'Deployment', 'web-a'), rs('web-1', 'b', 'Deployment', 'web-b')]);
    expect(resolvePodOwner(podItem('p', 'b', [{ kind: 'ReplicaSet', name: 'web-1', controller: true }]), sets))
      .toEqual({ kind: 'Deployment', name: 'web-b' });
  });

  it('returns null for a bare pod', () => {
    expect(resolvePodOwner(podItem('solo', 'default'), new Map())).toBeNull();
  });
});

describe('normalizeService', () => {
  it('keeps the selector — the field the whole routing layer needs', () => {
    const s = normalizeService({ metadata: { name: 'web', namespace: 'p' }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', selector: { app: 'web' }, ports: [{ port: 80, protocol: 'TCP' }] } });
    expect(s.selector).toBe('{"app":"web"}');
    expect(s.ports).toBe('80/TCP');
  });
  it('marks a selectorless service as None rather than inventing one', () => {
    expect(normalizeService({ metadata: { name: 'ext' }, spec: { type: 'ExternalName' } }).selector).toBe('None');
    expect(normalizeService({ metadata: { name: 'ext' }, spec: { selector: {} } }).selector).toBe('None');
  });
});

describe('normalizeWorkload', () => {
  it('reads DaemonSet counts from their own status fields', () => {
    const w = normalizeWorkload({ kind: 'DaemonSet', metadata: { name: 'cni' }, spec: {}, status: { desiredNumberScheduled: 3, numberReady: 2, numberAvailable: 2 } });
    expect(w.ready).toBe('2/3');
    expect(w.replicas).toBe(3);
    expect(w.kind).toBe('DaemonSet');
  });
  it('reads Deployment counts from replicas', () => {
    const w = normalizeWorkload({ kind: 'Deployment', metadata: { name: 'web' }, spec: { replicas: 4, selector: { matchLabels: { app: 'web' } } }, status: { readyReplicas: 4, availableReplicas: 4 } });
    expect(w.ready).toBe('4/4');
    expect(w.selector).toBe('{"app":"web"}');
  });
  it('reports 0/0 rather than NaN for a scaled-down workload', () => {
    expect(normalizeWorkload({ kind: 'Deployment', metadata: { name: 'x' }, spec: {}, status: {} }).ready).toBe('0/0');
  });
});

describe('normalizePod / normalizeNode', () => {
  it('carries labels, owner, node and restart totals', () => {
    const sets = indexByKey([rs('web-7d9f', 'default', 'Deployment', 'web')]);
    const p = normalizePod(podItem('web-7d9f-abc', 'default', [{ kind: 'ReplicaSet', name: 'web-7d9f', controller: true }]), sets);
    expect(p.labels).toEqual({ app: 'web' });
    expect(p.owner).toEqual({ kind: 'Deployment', name: 'web' });
    expect(p.node).toBe('node-1');
    expect(p.restarts).toBe(2);
    expect(p.ready).toBe('1/1');
    expect(p.containers[0]).toMatchObject({ name: 'c', image: 'nginx:1.25', ready: true, state: 'running' });
  });
  it('recognises a control-plane node', () => {
    const n = normalizeNode({ metadata: { name: 'cp', labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { conditions: [{ type: 'Ready', status: 'True' }], addresses: [{ type: 'InternalIP', address: '10.0.0.1' }], nodeInfo: { kubeletVersion: 'v1.34.1' } } });
    expect(n.role).toBe('control-plane');
    expect(n.status).toBe('Ready');
    expect(n.ip).toBe('10.0.0.1');
  });
});

describe('normalizeClusterItems', () => {
  const items = [
    podItem('web-7d9f-abc', 'default', [{ kind: 'ReplicaSet', name: 'web-7d9f', controller: true }]),
    podItem('pg-0', 'db', [{ kind: 'StatefulSet', name: 'pg', controller: true }]),
    rs('web-7d9f', 'default', 'Deployment', 'web'),
    { kind: 'Deployment', metadata: { name: 'web', namespace: 'default' }, spec: { replicas: 1, selector: { matchLabels: { app: 'web' } } }, status: { readyReplicas: 1 } },
    { kind: 'StatefulSet', metadata: { name: 'pg', namespace: 'db' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } },
    { kind: 'Service', metadata: { name: 'web', namespace: 'default' }, spec: { selector: { app: 'web' } } },
    { kind: 'Node', metadata: { name: 'node-1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
  ];

  it('sorts every kind into the four arrays the UI reads', () => {
    const r = normalizeClusterItems(items);
    expect(r.pods).toHaveLength(2);
    expect(r.services).toHaveLength(1);
    expect(r.nodes).toHaveLength(1);
    // Deployment AND StatefulSet — the StatefulSet used to be invisible.
    expect(r.deployments.map((d) => `${d.kind}/${d.name}`).sort()).toEqual(['Deployment/web', 'StatefulSet/pg']);
  });

  it('consumes ReplicaSets for owner resolution without surfacing them', () => {
    const r = normalizeClusterItems(items);
    expect(r.deployments.some((d) => d.kind === 'ReplicaSet')).toBe(false);
    expect(r.pods.find((p) => p.name === 'web-7d9f-abc')!.owner).toEqual({ kind: 'Deployment', name: 'web' });
  });

  it('handles an empty or junk payload', () => {
    expect(normalizeClusterItems([])).toEqual({ pods: [], services: [], deployments: [], nodes: [], inferenceServices: [] });
    expect(normalizeClusterItems([{}, null, { kind: 'Unknown' }] as any).pods).toEqual([]);
  });
});

// ReplicaSets are fetched as four projected columns, never as full JSON: they
// are consulted only for owner resolution, and Kubernetes retains ten
// revisions per Deployment by default, which makes their JSON routinely the
// largest object in a cluster.
describe('parseReplicaSetOwners (projected kubectl output)', () => {
  const sample = [
    'kube-system   coredns-66bc5c9577         Deployment   coredns',
    'themachine    currency-agent-89b6466b8   Deployment   currency-agent',
    'default       orphan-rs                  <none>       <none>',
  ].join('\n');

  it('maps namespace/name to the workload above the ReplicaSet', () => {
    const m = parseReplicaSetOwners(sample);
    expect(m.size).toBe(2);
    expect(m.get('kube-system/coredns-66bc5c9577').metadata.ownerReferences[0])
      .toEqual({ kind: 'Deployment', name: 'coredns', controller: true });
  });

  it('skips rows with no owner rather than inventing one', () => {
    expect(parseReplicaSetOwners(sample).has('default/orphan-rs')).toBe(false);
  });

  it('resolves a pod through the projected map exactly as through full JSON', () => {
    const owners = parseReplicaSetOwners(sample);
    const pod = { metadata: { name: 'coredns-66bc5c9577-x', namespace: 'kube-system', ownerReferences: [{ kind: 'ReplicaSet', name: 'coredns-66bc5c9577', controller: true }] } };
    expect(resolvePodOwner(pod, owners)).toEqual({ kind: 'Deployment', name: 'coredns' });
  });

  it('is used in preference to any ReplicaSet objects in the item list', () => {
    const owners = parseReplicaSetOwners('ns1   rs1   Deployment   from-projection');
    const items = [
      { kind: 'Pod', metadata: { name: 'p', namespace: 'ns1', ownerReferences: [{ kind: 'ReplicaSet', name: 'rs1', controller: true }] }, spec: {}, status: {} },
    ];
    expect(normalizeClusterItems(items, owners).pods[0].owner)
      .toEqual({ kind: 'Deployment', name: 'from-projection' });
  });

  it('tolerates headers, blank lines and ragged output', () => {
    expect(parseReplicaSetOwners('').size).toBe(0);
    expect(parseReplicaSetOwners('\n\n  \n').size).toBe(0);
    expect(parseReplicaSetOwners('ns  name-only').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resource quantities
//
// These exist so the UI can SUM what a PCAI component is using. Summing the raw
// strings would quietly add "500m" to "2" and report 502 CPUs, so the parsing
// is the correctness boundary.
// ---------------------------------------------------------------------------

describe('parseCpu', () => {
  it('normalises every notation to millicores', () => {
    expect(parseCpu('500m')).toBe(500);
    expect(parseCpu('2')).toBe(2000);
    expect(parseCpu('1.5')).toBe(1500);
    expect(parseCpu('100m')).toBe(100);
    expect(parseCpu(2)).toBe(2000);
  });

  it('treats absent or unparseable values as zero, never NaN', () => {
    expect(parseCpu(undefined)).toBe(0);
    expect(parseCpu('')).toBe(0);
    expect(parseCpu('abc')).toBe(0);
    expect(parseCpu(null)).toBe(0);
  });
});

describe('parseMemory', () => {
  it('handles binary and decimal suffixes', () => {
    expect(parseMemory('1Gi')).toBe(1024 ** 3);
    expect(parseMemory('512Mi')).toBe(512 * 1024 ** 2);
    expect(parseMemory('1G')).toBe(1e9);
    expect(parseMemory('1024')).toBe(1024);
  });

  it('returns zero rather than guessing at junk', () => {
    expect(parseMemory('12Zi')).toBe(0);
    expect(parseMemory('nonsense')).toBe(0);
    expect(parseMemory(undefined)).toBe(0);
  });
});

describe('parseResources', () => {
  it('pulls cpu, memory and GPUs out of one requests block', () => {
    expect(parseResources({ cpu: '250m', memory: '2Gi', 'nvidia.com/gpu': '2' }))
      .toEqual({ cpuMilli: 250, memBytes: 2 * 1024 ** 3, gpu: 2 });
  });

  it('counts non-NVIDIA accelerators too', () => {
    expect(parseResources({ 'amd.com/gpu': '1' }).gpu).toBe(1);
    expect(parseResources({ 'habana.ai/gaudi': '8' }).gpu).toBe(8);
  });

  it('is all zeros for a container that requests nothing', () => {
    expect(parseResources(undefined)).toEqual({ cpuMilli: 0, memBytes: 0, gpu: 0 });
    expect(parseResources({})).toEqual({ cpuMilli: 0, memBytes: 0, gpu: 0 });
  });
});

describe('normalizePod resource + storage fields', () => {
  const gpuPod = {
    kind: 'Pod',
    metadata: { name: 'mlis-predictor-0', namespace: 'mlis', labels: {} },
    spec: {
      nodeName: 'gpu-1',
      containers: [{
        name: 'server', image: 'nvcr.io/nim:1',
        resources: { requests: { cpu: '4', memory: '32Gi', 'nvidia.com/gpu': '2' },
                     limits: { cpu: '8', memory: '64Gi', 'nvidia.com/gpu': '2' } },
      }],
      volumes: [
        { name: 'models', persistentVolumeClaim: { claimName: 'model-store' } },
        { name: 'tmp', emptyDir: {} },
      ],
    },
    status: { phase: 'Running', containerStatuses: [{ name: 'server', ready: true, restartCount: 0, state: { running: {} } }] },
  };

  it('carries what the container asked for', () => {
    const p = normalizePod(gpuPod);
    expect(p.containers[0].requests).toEqual({ cpuMilli: 4000, memBytes: 32 * 1024 ** 3, gpu: 2 });
    expect(p.containers[0].limits.gpu).toBe(2);
  });

  it('lists only real PersistentVolumeClaims, not every volume', () => {
    expect(normalizePod(gpuPod).claims).toEqual(['model-store']);
  });

  it('leaves a pod with no requests at zero rather than undefined', () => {
    const p = normalizePod(podItem('web-1', 'default'));
    expect(p.containers[0].requests).toEqual({ cpuMilli: 0, memBytes: 0, gpu: 0 });
    expect(p.claims).toEqual([]);
  });
});
