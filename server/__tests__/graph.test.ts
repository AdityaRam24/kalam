// Unit tests for the infrastructure graph: how cluster state becomes nodes and
// edges, and whether the analysis can tell a cause from its casualties.
//
// The scenario used throughout is the one Kalam exists to untangle: a SPIRE
// agent dies on one worker, and every application pod on that worker fails to
// start. A flat diagnosis reports seven equal problems; the graph must report
// one cause with six casualties.

import { describe, it, expect } from 'vitest';
import { buildInfraGraph, k8sNodeHealth, ownerOf, podHealth, selectorMatches } from '../graph/build.js';
import { analyzeCauses, blastRadius, dependencyPath, graphStats } from '../graph/analyze.js';
import { index, nodeId } from '../graph/model.js';
import { CLUSTER_CRITICAL, NODE_CRITICAL, tierOf } from '../graph/deps.js';
import { identifyComponent } from '../pcai/components.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pod(opts: {
  name: string;
  ns?: string;
  node?: string;
  image?: string;
  phase?: string;
  waiting?: string;
  restarts?: number;
  ready?: boolean;
  labels?: Record<string, string>;
  owner?: { kind: string; name: string };
  claim?: string;
}) {
  const ready = opts.ready ?? !opts.waiting;
  return {
    metadata: {
      name: opts.name,
      namespace: opts.ns || 'default',
      labels: opts.labels || {},
      ownerReferences: opts.owner ? [{ kind: opts.owner.kind, name: opts.owner.name }] : undefined,
    },
    spec: {
      nodeName: opts.node,
      containers: [{ name: 'main', image: opts.image || 'app:1.0' }],
      volumes: opts.claim ? [{ persistentVolumeClaim: { claimName: opts.claim } }] : [],
    },
    status: {
      phase: opts.phase || 'Running',
      containerStatuses: [
        {
          name: 'main',
          ready,
          restartCount: opts.restarts || 0,
          state: opts.waiting ? { waiting: { reason: opts.waiting } } : { running: {} },
        },
      ],
    },
  };
}

function k8sNode(name: string, ready = true, extra: Record<string, any> = {}) {
  return {
    metadata: { name, labels: extra.labels || {} },
    spec: { taints: [], ...(extra.spec || {}) },
    status: {
      conditions: [
        { type: 'Ready', status: ready ? 'True' : 'False' },
        ...(extra.conditions || []),
      ],
      capacity: { cpu: '16', memory: '64Gi' },
      nodeInfo: { kubeletVersion: 'v1.29.4' },
    },
  };
}

/** A worker whose SPIRE agent is down, plus six app pods stuck behind it. */
function spireOutageCluster() {
  const app = (n: number) =>
    pod({
      name: `query-engine-${n}`,
      ns: 'ezmeral',
      node: 'worker-1',
      waiting: 'CreateContainerConfigError',
      labels: { app: 'query-engine' },
      owner: { kind: 'ReplicaSet', name: 'query-engine-7d9f8b6c4d' },
    });
  return {
    source: 'dsc-vm',
    k8sNodes: { items: [k8sNode('worker-1'), k8sNode('worker-2')] },
    pods: {
      items: [
        pod({ name: 'spire-agent-x9k2', ns: 'spire', node: 'worker-1', image: 'spire-agent:1.9', waiting: 'CrashLoopBackOff', restarts: 9 }),
        pod({ name: 'spire-agent-b3m1', ns: 'spire', node: 'worker-2', image: 'spire-agent:1.9' }),
        ...[1, 2, 3, 4, 5, 6].map(app),
        pod({ name: 'healthy-app-1', ns: 'ezmeral', node: 'worker-2', labels: { app: 'query-engine' } }),
      ],
    },
    services: {
      items: [
        {
          metadata: { name: 'query-engine', namespace: 'ezmeral' },
          spec: { type: 'ClusterIP', clusterIP: '10.96.1.5', selector: { app: 'query-engine' }, ports: [{ port: 8080 }] },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Health interpretation
// ---------------------------------------------------------------------------

describe('podHealth', () => {
  it('treats a waiting reason as a failure but ignores normal startup states', () => {
    expect(podHealth(pod({ name: 'a', waiting: 'ImagePullBackOff' })).health).toBe('failed');
    expect(podHealth(pod({ name: 'a', waiting: 'ContainerCreating' })).health).not.toBe('failed');
    expect(podHealth(pod({ name: 'a', waiting: 'PodInitializing' })).health).not.toBe('failed');
  });

  it('flags heavy restarts on a not-ready container as CrashLoopBackOff', () => {
    const h = podHealth(pod({ name: 'a', restarts: 8, ready: false }));
    expect(h.health).toBe('failed');
    expect(h.reason).toBe('CrashLoopBackOff');
    expect(h.restarts).toBe(8);
  });

  it('calls a Running-but-not-ready pod degraded, not failed', () => {
    expect(podHealth(pod({ name: 'a', ready: false })).health).toBe('degraded');
  });

  it('leaves completed jobs alone', () => {
    expect(podHealth(pod({ name: 'a', phase: 'Succeeded' })).health).toBe('healthy');
  });

  it('detects OOMKilled from the previous termination', () => {
    const p: any = pod({ name: 'a' });
    p.status.containerStatuses[0].lastState = { terminated: { reason: 'OOMKilled', exitCode: 137 } };
    expect(podHealth(p).reason).toBe('OOMKilled');
  });
});

describe('k8sNodeHealth', () => {
  it('fails a NotReady node', () => {
    expect(k8sNodeHealth(k8sNode('n', false))).toEqual({ health: 'failed', reason: 'NotReady' });
  });

  it('degrades a node under pressure', () => {
    const n = k8sNode('n', true, { conditions: [{ type: 'DiskPressure', status: 'True' }] });
    expect(k8sNodeHealth(n)).toEqual({ health: 'degraded', reason: 'DiskPressure' });
  });

  it('degrades a cordoned node', () => {
    expect(k8sNodeHealth(k8sNode('n', true, { spec: { unschedulable: true } })).reason).toBe('Cordoned');
  });
});

describe('ownerOf', () => {
  it('collapses a ReplicaSet owner to its Deployment', () => {
    expect(ownerOf(pod({ name: 'p', owner: { kind: 'ReplicaSet', name: 'query-engine-7d9f8b6c4d' } })))
      .toEqual({ kind: 'Deployment', name: 'query-engine' });
  });

  it('keeps DaemonSet owners as they are', () => {
    expect(ownerOf(pod({ name: 'p', owner: { kind: 'DaemonSet', name: 'spire-agent' } })))
      .toEqual({ kind: 'DaemonSet', name: 'spire-agent' });
  });

  it('returns nothing for a bare pod', () => {
    expect(ownerOf(pod({ name: 'p' }))).toBeUndefined();
  });
});

describe('selectorMatches', () => {
  it('requires every selector label to match', () => {
    expect(selectorMatches({ app: 'x' }, { app: 'x', tier: 'web' })).toBe(true);
    expect(selectorMatches({ app: 'x', tier: 'db' }, { app: 'x', tier: 'web' })).toBe(false);
  });

  it('treats an empty selector as matching nothing (headless services)', () => {
    expect(selectorMatches({}, { app: 'x' })).toBe(false);
    expect(selectorMatches(undefined, { app: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

describe('buildInfraGraph', () => {
  it('survives a host with nothing on it', () => {
    const g = buildInfraGraph({ source: 'bare' });
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.source).toBe('bare');
  });

  it('ignores malformed kubectl output instead of throwing', () => {
    const g = buildInfraGraph({ source: 'x', pods: { items: 'not-an-array' }, k8sNodes: null, services: undefined });
    expect(g.nodes).toEqual([]);
  });

  it('hosts pods on their node and links them to owner and service', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const podId = nodeId('pod', 'query-engine-1', 'ezmeral');

    expect(g.edges).toContainEqual(expect.objectContaining({ from: nodeId('k8sNode', 'worker-1'), to: podId, kind: 'hosts' }));
    expect(g.edges).toContainEqual(expect.objectContaining({ from: podId, to: nodeId('workload', 'query-engine', 'ezmeral'), kind: 'member' }));
    expect(g.edges).toContainEqual(expect.objectContaining({ from: podId, to: nodeId('service', 'query-engine', 'ezmeral'), kind: 'member' }));
  });

  it('matches services by real selector labels, not by name', () => {
    const g = buildInfraGraph({
      source: 'x',
      pods: { items: [pod({ name: 'web-1', labels: { app: 'web' } }), pod({ name: 'web-2', labels: { app: 'other' } })] },
      services: { items: [{ metadata: { name: 'web', namespace: 'default' }, spec: { selector: { app: 'web' } } }] },
    });
    const svc = nodeId('service', 'web', 'default');
    const backing = g.edges.filter((e) => e.to === svc && e.kind === 'member').map((e) => e.from);
    expect(backing).toEqual([nodeId('pod', 'web-1', 'default')]);
  });

  it('draws PVCs as feeding the pods that mount them', () => {
    const g = buildInfraGraph({
      source: 'x',
      pods: { items: [pod({ name: 'db-0', claim: 'data-db-0' })] },
      pvcs: { items: [{ metadata: { name: 'data-db-0', namespace: 'default' }, status: { phase: 'Pending' } }] },
    });
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: nodeId('pvc', 'data-db-0', 'default'), to: nodeId('pod', 'db-0', 'default'), kind: 'mounts' })
    );
    expect(g.nodes.find((n) => n.kind === 'pvc')!.health).toBe('failed');
  });

  it('turns an SSH jump host into a dependency edge', () => {
    const g = buildInfraGraph({
      source: 'dsc',
      vms: [
        { name: 'dsc', host: '10.0.0.1', reachable: true },
        { name: 'vme', host: '10.0.0.2', via: 'dsc', reachable: true },
      ],
    });
    expect(g.edges).toContainEqual(expect.objectContaining({ from: nodeId('vm', 'dsc'), to: nodeId('vm', 'vme'), kind: 'via' }));
  });

  it('attaches catalog knowledge and marks platform components', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const agent = g.nodes.find((n) => n.name === 'spire-agent-x9k2')!;
    expect(agent.component?.id).toBe('spire-agent');
    expect(agent.platform).toBe(true);
    expect(agent.meta.tier).toBe('node');
  });

  it('scopes node-critical dependencies to that node only', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const agent1 = nodeId('pod', 'spire-agent-x9k2', 'spire');
    const requires = g.edges.filter((e) => e.from === agent1 && e.kind === 'requires').map((e) => e.to);

    expect(requires).toHaveLength(6); // the six app pods on worker-1
    expect(requires).toContain(nodeId('pod', 'query-engine-3', 'ezmeral'));
    // Nothing on worker-2 depends on worker-1's agent.
    expect(requires).not.toContain(nodeId('pod', 'healthy-app-1', 'ezmeral'));
    // Platform pods don't depend on each other within the same tier (no cycles).
    expect(requires).not.toContain(nodeId('pod', 'spire-agent-b3m1', 'spire'));
  });

  it('fans cluster-critical components out across the whole cluster', () => {
    const base = spireOutageCluster();
    base.pods.items.push(pod({ name: 'etcd-cp-1', ns: 'kube-system', node: 'worker-2', image: 'etcd:3.5' }));
    const g = buildInfraGraph(base);
    const etcd = g.nodes.find((n) => n.component?.id === 'etcd')!;
    const targets = g.edges.filter((e) => e.from === etcd.id && e.kind === 'requires');

    expect(etcd.meta.tier).toBe('cluster');
    // Reaches workloads on both nodes, and the node-tier agents below it.
    expect(targets.map((e) => e.to)).toContain(nodeId('pod', 'spire-agent-x9k2', 'spire'));
    expect(targets.map((e) => e.to)).toContain(nodeId('pod', 'healthy-app-1', 'ezmeral'));
  });

  it('rolls service and workload health up from their members', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const svc = g.nodes.find((n) => n.kind === 'service')!;
    // Six of seven selected pods are broken -> degraded, not failed.
    expect(svc.health).toBe('degraded');
    expect(svc.meta.brokenMembers).toBe(6);
    expect(svc.meta.members).toBe(7);

    const workload = g.nodes.find((n) => n.kind === 'workload')!;
    expect(workload.health).toBe('failed'); // all its replicas are down
    expect(workload.reason).toBe('AllReplicasDown');
  });

  it('records docker containers and systemd units on non-Kubernetes hosts', () => {
    const g = buildInfraGraph({
      source: 'edge-box',
      vms: [{ name: 'edge-box', host: '10.0.0.9', reachable: true }],
      containers: [
        { name: 'redis', image: 'redis:7', state: 'running' },
        { name: 'old-job', image: 'batch:1', state: 'exited', status: 'Exited (1) 2 hours ago' },
      ],
      systemServices: [{ unit: 'containerd', sub: 'running' }],
      listeningPorts: [{ proto: 'tcp', local: '0.0.0.0:6379', process: 'redis-server' }],
    });
    expect(g.nodes.find((n) => n.name === 'old-job')!.health).toBe('failed');
    expect(g.nodes.find((n) => n.name === 'redis')!.health).toBe('healthy');
    expect(g.edges).toContainEqual(expect.objectContaining({ from: nodeId('vm', 'edge-box'), to: nodeId('container', 'redis'), kind: 'hosts' }));
    expect(g.nodes.some((n) => n.kind === 'port')).toBe(true);
  });

  it('never emits an edge whose endpoints are not both in the graph', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
  });
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

describe('analyzeCauses', () => {
  it('names the SPIRE agent as the single cause of six pod failures', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const { rootCauses, collateral, brokenCount } = analyzeCauses(g);

    const top = rootCauses[0];
    expect(top.name).toBe('spire-agent-x9k2');
    // Six app pods, plus the Deployment and Service they take down with them.
    expect(top.explains).toHaveLength(8);
    expect(top.explains.filter((id) => id.startsWith('pod:'))).toHaveLength(6);
    expect(top.confidence).toBe('high');
    expect(top.component?.id).toBe('spire-agent');
    expect(top.explanation).toContain('failure starts here');

    // Every app pod is attributed back to the agent, not reported as its own cause.
    expect(collateral[nodeId('pod', 'query-engine-4', 'ezmeral')]).toBe(nodeId('pod', 'spire-agent-x9k2', 'spire'));
    expect(rootCauses.some((c) => c.name.startsWith('query-engine-'))).toBe(false);
    expect(brokenCount).toBeGreaterThan(6);
  });

  it('absorbs a node-local failure into a cluster-wide one above it', () => {
    // Cluster DNS is down AND a SPIRE agent is down. DNS sits above the agent in
    // the dependency tiers, so it becomes the single cause and the agent is
    // reported as collateral of it — not as a second, competing root cause.
    const base = spireOutageCluster();
    base.pods.items.push(pod({ name: 'coredns-1', ns: 'kube-system', node: 'worker-2', image: 'coredns:1.11', waiting: 'CrashLoopBackOff', restarts: 6 }));
    const { rootCauses, collateral } = analyzeCauses(buildInfraGraph(base));

    expect(rootCauses[0].name).toBe('coredns-1');
    expect(rootCauses.map((c) => c.name)).not.toContain('spire-agent-x9k2');
    expect(collateral[nodeId('pod', 'spire-agent-x9k2', 'spire')]).toBe(nodeId('pod', 'coredns-1', 'kube-system'));
  });

  it('blames the node, not the pods, when a node goes NotReady', () => {
    const g = buildInfraGraph({
      source: 'x',
      k8sNodes: { items: [k8sNode('worker-1', false)] },
      pods: { items: [pod({ name: 'a', node: 'worker-1', waiting: 'Error' }), pod({ name: 'b', node: 'worker-1', waiting: 'Error' })] },
    });
    const { rootCauses, collateral } = analyzeCauses(g);
    expect(rootCauses[0].id).toBe(nodeId('k8sNode', 'worker-1'));
    expect(collateral[nodeId('pod', 'a', 'default')]).toBe(nodeId('k8sNode', 'worker-1'));
  });

  it('reports independent failures separately', () => {
    const g = buildInfraGraph({
      source: 'x',
      k8sNodes: { items: [k8sNode('w1'), k8sNode('w2')] },
      pods: { items: [pod({ name: 'a', node: 'w1', waiting: 'ImagePullBackOff' }), pod({ name: 'b', node: 'w2', waiting: 'ImagePullBackOff' })] },
    });
    const { rootCauses } = analyzeCauses(g);
    expect(rootCauses).toHaveLength(2);
    expect(rootCauses.every((c) => c.explains.length === 0 && c.confidence === 'low')).toBe(true);
  });

  it('says so plainly when nothing is wrong', () => {
    const g = buildInfraGraph({ source: 'x', pods: { items: [pod({ name: 'ok' })] } });
    const a = analyzeCauses(g);
    expect(a.rootCauses).toEqual([]);
    expect(a.brokenCount).toBe(0);
    expect(a.summary).toContain('Nothing unhealthy');
  });
});

describe('blastRadius', () => {
  it('counts what is already broken separately from what is at risk', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const r = blastRadius(g, nodeId('pod', 'spire-agent-x9k2', 'spire'))!;

    expect(r.alreadyBroken.length).toBe(8); // 6 pods + the Deployment + the Service
    expect(r.byKind.pod).toBe(6);
    expect(r.byKind.service).toBe(1);
    expect(r.byKind.workload).toBe(1);
    expect(r.componentImpact).toContain('identity');
    expect(r.summary).toContain('already unhealthy');
  });

  it('reports healthy dependents as at risk before anything has broken', () => {
    const g = buildInfraGraph({
      source: 'x',
      k8sNodes: { items: [k8sNode('w1')] },
      pods: {
        items: [
          pod({ name: 'spire-agent-ok', ns: 'spire', node: 'w1', image: 'spire-agent:1.9' }),
          pod({ name: 'app-1', node: 'w1' }),
          pod({ name: 'app-2', node: 'w1' }),
        ],
      },
    });
    const r = blastRadius(g, nodeId('pod', 'spire-agent-ok', 'spire'))!;
    expect(r.atRisk.map((n) => n.name).sort()).toEqual(['app-1', 'app-2']);
    expect(r.alreadyBroken).toEqual([]);
  });

  it('measures distance in dependency hops', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const r = blastRadius(g, nodeId('k8sNode', 'worker-1'))!;
    const appPod = r.impacted.find((n) => n.name === 'query-engine-1')!;
    const svc = r.impacted.find((n) => n.kind === 'service')!;
    expect(appPod.distance).toBe(1);   // node hosts the pod
    expect(svc.distance).toBe(2);      // pod backs the service
  });

  it('says nothing depends on a leaf', () => {
    const g = buildInfraGraph({ source: 'x', pods: { items: [pod({ name: 'lonely' })] } });
    const r = blastRadius(g, nodeId('pod', 'lonely', 'default'))!;
    expect(r.impacted).toEqual([]);
    expect(r.summary).toContain('affects nothing');
  });

  it('returns null for an unknown id', () => {
    expect(blastRadius(buildInfraGraph({ source: 'x' }), 'pod:nope/nope')).toBeNull();
  });
});

describe('dependencyPath', () => {
  it('explains why a jump host outage reaches an application pod', () => {
    const input = spireOutageCluster();
    const g = buildInfraGraph({
      ...input,
      vms: [
        { name: 'dsc-vm', host: '10.0.0.1', reachable: true, k8sNodeName: 'worker-1' },
      ],
    });
    const steps = dependencyPath(g, nodeId('vm', 'dsc-vm'), nodeId('service', 'query-engine', 'ezmeral'))!;
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0].edge.kind).toBe('hosts');
    expect(steps[steps.length - 1].to.kind).toBe('service');
    expect(steps.every((s) => typeof s.edge.note === 'string')).toBe(true);
  });

  it('returns null when two resources are unrelated', () => {
    const g = buildInfraGraph(spireOutageCluster());
    expect(dependencyPath(g, nodeId('pod', 'healthy-app-1', 'ezmeral'), nodeId('pod', 'spire-agent-x9k2', 'spire'))).toBeNull();
  });

  it('is empty for a node to itself', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const id = nodeId('pod', 'healthy-app-1', 'ezmeral');
    expect(dependencyPath(g, id, id)).toEqual([]);
  });
});

describe('graph plumbing', () => {
  it('indexes edges in both directions', () => {
    const g = buildInfraGraph(spireOutageCluster());
    const adj = index(g);
    const podId = nodeId('pod', 'query-engine-1', 'ezmeral');
    expect(adj.in.get(podId)!.some((e) => e.kind === 'hosts')).toBe(true);
    expect(adj.out.get(podId)!.some((e) => e.kind === 'member')).toBe(true);
  });

  it('summarises the graph by kind and health', () => {
    const s = graphStats(buildInfraGraph(spireOutageCluster()));
    expect(s.nodes).toBe(s.byKind.pod + s.byKind.k8sNode + s.byKind.service + s.byKind.workload);
    expect(s.byHealth.failed).toBeGreaterThan(0);
  });
});

describe('dependency knowledge stays in sync with the component catalog', () => {
  it('every critical id exists in the catalog and matches itself', () => {
    for (const id of [...Object.keys(CLUSTER_CRITICAL), ...Object.keys(NODE_CRITICAL)]) {
      const found = identifyComponent(id);
      expect(found, `catalog has no component "${id}"`).not.toBeNull();
      expect(found!.id, `"${id}" resolves to a different component`).toBe(id);
    }
  });

  it('no id is both cluster-critical and node-critical', () => {
    const overlap = Object.keys(CLUSTER_CRITICAL).filter((id) => id in NODE_CRITICAL);
    expect(overlap).toEqual([]);
  });

  it('tiers unknown and ordinary components as workloads', () => {
    expect(tierOf(undefined)).toBe('workload');
    expect(tierOf('some-app')).toBe('workload');
    expect(tierOf('etcd')).toBe('cluster');
    expect(tierOf('spire-agent')).toBe('node');
  });
});
