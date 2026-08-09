// Unit tests for the inspect panel's connection reasoning.
//
// The question these rules answer is the one an operator asks after clicking a
// card: "what else is this wired to, and is the wiring actually working?" So
// the tests care less about field plumbing and more about the judgements —
// a pod that a Service selects but that is missing from Endpoints is NOT
// serving traffic, and the panel has to say so.

import { describe, it, expect } from 'vitest';
import {
  configRefs,
  endpointsFor,
  factsFor,
  factsForNode,
  factsForPod,
  factsForService,
  factsForWorkload,
  ingressesForServices,
  parseEvents,
} from '../k8s/relate.js';

const list = (items: any[]) => ({ items });

function pod(opts: {
  name: string;
  ns?: string;
  labels?: Record<string, string>;
  node?: string;
  phase?: string;
  waiting?: string;
  ready?: boolean;
  owner?: { kind: string; name: string };
  volumes?: any[];
  containers?: any[];
  sa?: string;
}) {
  const ready = opts.ready ?? !opts.waiting;
  return {
    kind: 'Pod',
    metadata: {
      name: opts.name,
      namespace: opts.ns || 'shop',
      labels: opts.labels || { app: 'web' },
      ownerReferences: opts.owner ? [{ kind: opts.owner.kind, name: opts.owner.name }] : undefined,
    },
    spec: {
      nodeName: opts.node || 'worker-1',
      serviceAccountName: opts.sa,
      volumes: opts.volumes || [],
      containers: opts.containers || [{ name: 'main', image: 'web:1.0', ports: [{ containerPort: 8080 }] }],
    },
    status: {
      phase: opts.phase || 'Running',
      podIP: '10.1.0.5',
      hostIP: '192.168.0.11',
      qosClass: 'Burstable',
      containerStatuses: [
        {
          name: 'main',
          ready,
          restartCount: 0,
          state: opts.waiting ? { waiting: { reason: opts.waiting } } : { running: {} },
        },
      ],
    },
  };
}

const service = (name: string, selector: Record<string, string> | undefined, ns = 'shop') => ({
  kind: 'Service',
  metadata: { name, namespace: ns },
  spec: { selector, type: 'ClusterIP', clusterIP: '10.96.0.7', ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }] },
});

const endpoints = (name: string, ready: string[], notReady: string[] = [], ns = 'shop') => ({
  metadata: { name, namespace: ns },
  subsets: [
    {
      addresses: ready.map((n) => ({ ip: '10.1.0.5', targetRef: { name: n } })),
      notReadyAddresses: notReady.map((n) => ({ ip: '10.1.0.6', targetRef: { name: n } })),
    },
  ],
});

const ingress = (name: string, host: string, svc: string, ns = 'shop') => ({
  metadata: { name, namespace: ns },
  spec: { rules: [{ host, http: { paths: [{ path: '/', backend: { service: { name: svc } } }] } }] },
});

const deployment = (name: string, ns = 'shop') => ({
  kind: 'Deployment',
  metadata: { name, namespace: ns, generation: 3 },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'web' } },
    strategy: { type: 'RollingUpdate' },
    template: {
      metadata: { labels: { app: 'web' } },
      spec: {
        containers: [{ name: 'main', image: 'web:1.0', envFrom: [{ configMapRef: { name: 'web-config' } }] }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'web-data' } }],
      },
    },
  },
  status: { replicas: 3, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 3, observedGeneration: 3 },
});

const group = (facts: { groups: Array<{ title: string; items: any[] }> }, match: string) =>
  facts.groups.find((g) => g.title.toLowerCase().includes(match.toLowerCase()));

describe('pod relations', () => {
  const ctx = {
    services: list([service('web', { app: 'web' }), service('api', { app: 'api' })]),
    endpoints: list([endpoints('web', ['web-abc'])]),
    ingresses: list([ingress('shop-ing', 'shop.example.com', 'web')]),
    pods: list([pod({ name: 'web-abc', owner: { kind: 'ReplicaSet', name: 'web-7d9f8b6c4d' } }),
                pod({ name: 'web-def', node: 'worker-2', owner: { kind: 'ReplicaSet', name: 'web-7d9f8b6c4d' } })]),
  };

  it('lists only the services whose selector actually matches', () => {
    const facts = factsForPod(pod({ name: 'web-abc' }), ctx);
    const svcs = group(facts, 'Services')!.items;
    expect(svcs.map((s) => s.name)).toEqual(['web']);
    expect(svcs[0].via).toContain('app=web');
  });

  it('says whether this pod is a live endpoint of the service', () => {
    const serving = group(factsForPod(pod({ name: 'web-abc' }), ctx), 'Services')!.items[0];
    expect(serving.detail).toContain('ready endpoint');
    expect(serving.health).toBe('healthy');

    // Selected by the label, but the kubelet never marked it ready: the
    // Service exists and still sends this pod nothing.
    const dark = group(factsForPod(pod({ name: 'web-xyz', waiting: 'CrashLoopBackOff' }), ctx), 'Services')!.items[0];
    expect(dark.detail).toContain('not in the endpoint list');
    expect(dark.health).toBe('failed');
  });

  it('collapses a ReplicaSet owner to the Deployment an operator would act on', () => {
    const owner = group(factsForPod(pod({ name: 'web-abc', owner: { kind: 'ReplicaSet', name: 'web-7d9f8b6c4d' } }), ctx), 'Owned by')!.items[0];
    expect(owner).toMatchObject({ kind: 'Deployment', name: 'web', focus: 'deployment' });
  });

  it('follows the service through to the ingress that publishes it', () => {
    const ing = group(factsForPod(pod({ name: 'web-abc' }), ctx), 'Ingress')!.items[0];
    expect(ing.name).toBe('shop-ing');
    expect(ing.via).toContain('shop.example.com');
  });

  it('reports the node and the sibling replicas that share the workload', () => {
    const facts = factsForPod(pod({ name: 'web-abc', owner: { kind: 'ReplicaSet', name: 'web-7d9f8b6c4d' } }), ctx);
    expect(group(facts, 'Runs on')!.items[0]).toMatchObject({ kind: 'Node', name: 'worker-1' });
    const siblings = group(facts, 'Sibling')!.items;
    expect(siblings.map((s) => s.name)).toEqual(['web-def']);
  });

  it('surfaces the pod-level facts a describe would show', () => {
    const facts = factsForPod(pod({ name: 'web-abc', sa: 'web-sa' }), ctx);
    const summary = Object.fromEntries(facts.summary.map((r) => [r.label, r.value]));
    expect(summary.Node).toBe('worker-1');
    expect(summary['Pod IP']).toBe('10.1.0.5');
    expect(summary.QoS).toBe('Burstable');
    expect(facts.containers[0]).toMatchObject({ name: 'main', image: 'web:1.0', ports: '8080/TCP' });
  });
});

describe('config references', () => {
  it('finds every ConfigMap, Secret, PVC and ServiceAccount a pod spec pulls in', () => {
    const refs = configRefs({
      serviceAccountName: 'web-sa',
      imagePullSecrets: [{ name: 'registry-cred' }],
      volumes: [
        { name: 'data', persistentVolumeClaim: { claimName: 'web-data' } },
        { name: 'conf', configMap: { name: 'web-config' } },
        { name: 'tls', secret: { secretName: 'web-tls' } },
      ],
      containers: [
        {
          name: 'main',
          envFrom: [{ configMapRef: { name: 'shared-env' } }],
          env: [{ name: 'PASS', valueFrom: { secretKeyRef: { name: 'db-cred', key: 'password' } } }],
        },
      ],
    });
    const byKind = (k: string) => refs.filter((r) => r.kind === k).map((r) => r.name);
    expect(byKind('PersistentVolumeClaim')).toEqual(['web-data']);
    expect(byKind('ConfigMap').sort()).toEqual(['shared-env', 'web-config']);
    expect(byKind('Secret').sort()).toEqual(['db-cred', 'registry-cred', 'web-tls']);
    expect(byKind('ServiceAccount')).toEqual(['web-sa']);
  });

  it('does not list the same object twice when two containers share it', () => {
    const refs = configRefs({
      containers: [
        { name: 'a', envFrom: [{ configMapRef: { name: 'shared' } }] },
        { name: 'b', envFrom: [{ configMapRef: { name: 'shared' } }] },
      ],
    });
    expect(refs.filter((r) => r.name === 'shared')).toHaveLength(1);
  });
});

describe('service relations', () => {
  const ctx = {
    services: list([service('web', { app: 'web' })]),
    endpoints: list([endpoints('web', ['web-abc'], ['web-def'])]),
    ingresses: list([ingress('shop-ing', 'shop.example.com', 'web')]),
    pods: list([
      pod({ name: 'web-abc', owner: { kind: 'ReplicaSet', name: 'web-7d9f8b6c4d' } }),
      pod({ name: 'web-def', ready: false, owner: { kind: 'ReplicaSet', name: 'web-7d9f8b6c4d' } }),
    ]),
  };

  it('separates pods that receive traffic from pods that merely match', () => {
    const pods = group(factsForService(service('web', { app: 'web' }), ctx), 'Routes to')!.items;
    expect(pods.find((p) => p.name === 'web-abc')!.via).toContain('receiving traffic');
    expect(pods.find((p) => p.name === 'web-def')!.via).toContain('NOT ready');
  });

  it('is degraded while some endpoints are down and failed when none are left', () => {
    expect(factsForService(service('web', { app: 'web' }), ctx).health).toBe('degraded');

    const dead = { ...ctx, endpoints: list([endpoints('web', [], ['web-abc'])]) };
    const facts = factsForService(service('web', { app: 'web' }), dead);
    expect(facts.health).toBe('failed');
    expect(facts.reason).toBe('NoHealthyEndpoints');
  });

  it('names the workload behind the service, not just the pods', () => {
    const workloads = group(factsForService(service('web', { app: 'web' }), ctx), 'Backed by')!.items;
    expect(workloads).toEqual([expect.objectContaining({ kind: 'Deployment', name: 'web', detail: '2 backing pods' })]);
  });
});

describe('workload relations', () => {
  const ctx = {
    services: list([service('web', { app: 'web' })]),
    endpoints: list([endpoints('web', ['web-abc'])]),
    ingresses: list([ingress('shop-ing', 'shop.example.com', 'web')]),
    pods: list([
      pod({ name: 'web-abc' }),
      pod({ name: 'web-def', node: 'worker-2', waiting: 'ImagePullBackOff' }),
      pod({ name: 'other', labels: { app: 'api' } }),
    ]),
  };

  it('matches its pods by selector rather than by name prefix', () => {
    const pods = group(factsForWorkload(deployment('web'), ctx), 'Pods it manages')!.items;
    expect(pods.map((p) => p.name).sort()).toEqual(['web-abc', 'web-def']);
  });

  it('reports partial replica failure as degraded', () => {
    const facts = factsForWorkload(deployment('web'), ctx);
    expect(facts.health).toBe('degraded');
    expect(facts.reason).toBe('1/2 replicas unhealthy');
  });

  it('shows how the replicas are spread across nodes', () => {
    const nodes = group(factsForWorkload(deployment('web'), ctx), 'Spread across')!.items;
    expect(nodes.map((n) => `${n.name}:${n.detail}`).sort()).toEqual(['worker-1:1 pod', 'worker-2:1 pod']);
  });

  it('derives services and config from the pod template', () => {
    const facts = factsForWorkload(deployment('web'), ctx);
    expect(group(facts, 'Exposed by')!.items.map((s) => s.name)).toEqual(['web']);
    expect(group(facts, 'Config & storage')!.items.map((c) => c.name).sort()).toEqual(['web-config', 'web-data']);
  });
});

describe('node relations', () => {
  const node = {
    kind: 'Node',
    metadata: { name: 'worker-1', labels: { 'node-role.kubernetes.io/worker': '' } },
    spec: { taints: [{ key: 'gpu', value: 'true', effect: 'NoSchedule' }] },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'True' }],
      addresses: [{ type: 'InternalIP', address: '192.168.0.11' }],
      capacity: { cpu: '8', memory: '32Gi' },
      nodeInfo: { kubeletVersion: 'v1.29.4' },
    },
  };
  const ctx = {
    services: list([service('web', { app: 'web' })]),
    endpoints: list([endpoints('web', ['web-abc'])]),
    pods: list([pod({ name: 'web-abc' }), pod({ name: 'web-def', node: 'worker-2' })]),
  };

  it('lists only the pods scheduled on it, plus the services they serve', () => {
    const facts = factsForNode(node, ctx);
    expect(group(facts, 'Pods on this node')!.items.map((p) => p.name)).toEqual(['web-abc']);
    expect(group(facts, 'Services depending')!.items.map((s) => s.name)).toEqual(['web']);
  });

  it('treats a Ready node under memory pressure as degraded, not healthy', () => {
    expect(factsForNode(node, ctx).health).toBe('degraded');
  });

  it('keeps the taints an operator needs to explain scheduling', () => {
    const summary = Object.fromEntries(factsForNode(node, ctx).summary.map((r) => [r.label, r.value]));
    expect(summary.Taints).toBe('gpu=true:NoSchedule');
    expect(summary.Capacity).toContain('cpu 8');
  });
});

describe('ingress matching', () => {
  it('ignores ingresses that route somewhere else', () => {
    const ings = list([ingress('a', 'a.example.com', 'web'), ingress('b', 'b.example.com', 'api')]);
    expect(ingressesForServices(['web'], ings).map((i) => i.name)).toEqual(['a']);
  });

  it('matches a default backend as well as path rules', () => {
    const ings = list([{ metadata: { name: 'fallback' }, spec: { defaultBackend: { service: { name: 'web' } } } }]);
    expect(ingressesForServices(['web'], ings)[0].via).toContain('default backend');
  });
});

describe('endpoints and events', () => {
  it('splits ready from not-ready addresses', () => {
    const { ready, notReady } = endpointsFor('web', list([endpoints('web', ['a'], ['b'])]));
    expect(ready).toEqual(['a']);
    expect(notReady).toEqual(['b']);
  });

  it('returns events newest first', () => {
    const parsed = parseEvents(list([
      { type: 'Normal', reason: 'Pulled', message: 'old', lastTimestamp: '2026-01-01T00:00:00Z' },
      { type: 'Warning', reason: 'BackOff', message: 'new', lastTimestamp: '2026-01-02T00:00:00Z', count: 4 },
    ]));
    expect(parsed.map((e) => e.reason)).toEqual(['BackOff', 'Pulled']);
    expect(parsed[0].count).toBe(4);
  });
});

describe('dispatch', () => {
  it('routes each kind to its own fact sheet', () => {
    const ctx = { pods: list([]), services: list([]), endpoints: list([]), ingresses: list([]) };
    expect(factsFor(pod({ name: 'p' }), ctx).summary.some((r) => r.label === 'Phase')).toBe(true);
    expect(factsFor(deployment('web'), ctx).summary.some((r) => r.label === 'Ready')).toBe(true);
    expect(factsFor({ kind: 'CustomThing', metadata: {} }, ctx).groups).toEqual([]);
  });
});
