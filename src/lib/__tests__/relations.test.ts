// The topology map is only trustworthy if its edges are. These tests pin down
// every rule in buildRelations, including the ones that used to be name
// guesses: a Service reaching pods it does not select, a Deployment claiming
// another Deployment's pods, and StatefulSet pods having no owner at all.

import { describe, it, expect } from 'vitest';
import {
  buildRelations, selectorMatches, parseSelector, containerPod,
  podId, svcId, deployId, k8sNodeId, containerId,
} from '../relations';

const pod = (o: Partial<any> = {}) => ({
  name: 'p', namespace: 'default', status: 'Running', ready: '1/1',
  node: 'node-1', restarts: 0, ip: '10.0.0.1', labels: {}, owner: null,
  containers: [], ...o,
});
const svc = (o: Partial<any> = {}) => ({
  name: 's', namespace: 'default', type: 'ClusterIP', clusterIp: '10.96.0.1',
  ports: '80/TCP', selector: 'None', ...o,
});
const workload = (o: Partial<any> = {}) => ({
  name: 'w', namespace: 'default', kind: 'Deployment', ready: '1/1',
  replicas: 1, available: 1, selector: 'None', ...o,
});
const node = (o: Partial<any> = {}) => ({ name: 'node-1', status: 'Ready', role: 'worker', ip: '1.2.3.4', ...o });

const empty = { containers: [], pods: [], services: [], deployments: [], nodes: [] };
const kinds = (rels: any[], kind: string) => rels.filter((r) => r.kind === kind);

describe('selectorMatches', () => {
  it('needs every selector key to match', () => {
    expect(selectorMatches({ app: 'web' }, { app: 'web', tier: 'x' })).toBe(true);
    expect(selectorMatches({ app: 'web', tier: 'y' }, { app: 'web', tier: 'x' })).toBe(false);
  });
  it('treats an empty selector as selecting nothing', () => {
    expect(selectorMatches({}, { app: 'web' })).toBe(false);
  });
});

describe('parseSelector', () => {
  it('accepts a JSON object and rejects the placeholders', () => {
    expect(parseSelector('{"app":"web"}')).toEqual({ app: 'web' });
    expect(parseSelector('None')).toBeNull();
    expect(parseSelector('{}')).toBeNull();
    expect(parseSelector('not json')).toBeNull();
    expect(parseSelector(undefined)).toBeNull();
  });
});

describe('containerPod', () => {
  it('reads the crictl pod field — the only source on a containerd node', () => {
    expect(containerPod({ name: 'coredns', pod: 'coredns-abc' })).toEqual({ name: 'coredns-abc' });
  });
  it('parses the conventional docker k8s_ name', () => {
    expect(containerPod({ name: 'k8s_api_api-7d9_prod_uid_3' })).toEqual({ name: 'api-7d9', namespace: 'prod' });
  });
  it('ignores an ordinary container', () => {
    expect(containerPod({ name: 'themachine-redis-1' })).toBeNull();
  });
});

describe('workload → pod', () => {
  it('uses ownerReferences, so a StatefulSet pod is owned like any other', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'postgres-0', owner: { kind: 'StatefulSet', name: 'postgres' } })],
      deployments: [workload({ name: 'postgres', kind: 'StatefulSet' })],
    });
    expect(kinds(rels, 'manages')).toHaveLength(1);
    expect(rels[0].source).toBe(deployId('default', 'postgres'));
    expect(rels[0].inferred).toBeUndefined();
  });

  it('does NOT give one workload another workload\'s pods', () => {
    // The old name-prefix rule handed api-worker's pods to `api` as well.
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'api-worker-7d9f-x', owner: { kind: 'Deployment', name: 'api-worker' } })],
      deployments: [workload({ name: 'api' }), workload({ name: 'api-worker' })],
    });
    const manages = kinds(rels, 'manages');
    expect(manages).toHaveLength(1);
    expect(manages[0].source).toBe(deployId('default', 'api-worker'));
  });

  it('does not guess a parent for a static pod owned by its Node', () => {
    // Control-plane pods (etcd, kube-apiserver) are owned by the Node. Their
    // owner is known and simply has no card — inventing an edge from a name
    // match would be a relationship the cluster does not have.
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'etcd-node-1', namespace: 'kube-system', owner: { kind: 'Node', name: 'node-1' } })],
      deployments: [workload({ name: 'etcd', namespace: 'kube-system' })],
    });
    expect(kinds(rels, 'manages')).toHaveLength(0);
  });

  it('prefers the longest name match when no owner is recorded', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'api-worker-7d9f-x', owner: null })],
      deployments: [workload({ name: 'api' }), workload({ name: 'api-worker' })],
    });
    const manages = kinds(rels, 'manages');
    expect(manages).toHaveLength(1);
    expect(manages[0].source).toBe(deployId('default', 'api-worker'));
    expect(manages[0].inferred).toBe(true);
  });

  it('never crosses a namespace boundary', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'web-1', namespace: 'prod', owner: { kind: 'Deployment', name: 'web' } })],
      deployments: [workload({ name: 'web', namespace: 'staging' })],
    });
    expect(kinds(rels, 'manages')).toHaveLength(0);
  });
});

describe('service → pod', () => {
  it('routes by label selector', () => {
    const rels = buildRelations({
      ...empty,
      pods: [
        pod({ name: 'web-1', labels: { app: 'web' } }),
        pod({ name: 'db-1', labels: { app: 'db' } }),
      ],
      services: [svc({ name: 'web-svc', selector: '{"app":"web"}' })],
    });
    const routes = kinds(rels, 'routes');
    expect(routes).toHaveLength(1);
    expect(routes[0].target).toBe(podId('default', 'web-1'));
  });

  it('routes to a pod whose name shares nothing with the service', () => {
    // Name matching would have missed this entirely.
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'zzz-runner-1', labels: { app: 'web' } })],
      services: [svc({ name: 'frontend', selector: '{"app":"web"}' })],
    });
    expect(kinds(rels, 'routes')).toHaveLength(1);
  });

  it('draws nothing for a selectorless service when labels are available', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'web-1', labels: { app: 'web' } })],
      services: [svc({ name: 'web', selector: 'None' })],
    });
    expect(kinds(rels, 'routes')).toHaveLength(0);
  });

  it('falls back to names only when no pod carries labels', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'web-1', labels: {} })],
      services: [svc({ name: 'web', selector: 'None' })],
    });
    const routes = kinds(rels, 'routes');
    expect(routes).toHaveLength(1);
    expect(routes[0].inferred).toBe(true);
  });
});

describe('pod → node', () => {
  it('links a pod to the node it is scheduled on', () => {
    const rels = buildRelations({ ...empty, pods: [pod({ node: 'node-1' })], nodes: [node()] });
    expect(kinds(rels, 'runs-on')).toHaveLength(1);
    expect(rels[0].target).toBe(k8sNodeId('node-1'));
  });
  it('skips unscheduled pods and unknown nodes', () => {
    expect(buildRelations({ ...empty, pods: [pod({ node: 'None' })], nodes: [node()] })).toHaveLength(0);
    expect(buildRelations({ ...empty, pods: [pod({ node: 'ghost' })], nodes: [node()] })).toHaveLength(0);
  });
});

describe('pod → container', () => {
  it('links a containerd container to its pod via the crictl pod field', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'coredns-abc', namespace: 'kube-system' })],
      containers: [{ id: 'aaaabbbbcccc', name: 'coredns', pod: 'coredns-abc', runtime: 'containerd' }],
    });
    const backs = kinds(rels, 'backs');
    expect(backs).toHaveLength(1);
    expect(backs[0].source).toBe(podId('kube-system', 'coredns-abc'));
    expect(backs[0].target).toBe(containerId('aaaabbbbcccc'));
  });

  it('links a docker k8s_ container to its pod in the right namespace', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'api-7d9', namespace: 'prod' })],
      containers: [{ id: '111122223333', name: 'k8s_api_api-7d9_prod_uid_3', runtime: 'docker' }],
    });
    expect(kinds(rels, 'backs')).toHaveLength(1);
  });

  it('leaves a standalone container unattached', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'api-7d9' })],
      containers: [{ id: '999988887777', name: 'themachine-redis-1', runtime: 'docker' }],
    });
    expect(kinds(rels, 'backs')).toHaveLength(0);
  });
});

describe('node → container', () => {
  it('never double-attaches a container that already belongs to a pod', () => {
    const rels = buildRelations({
      ...empty,
      pods: [pod({ name: 'node-1-thing' })],
      nodes: [node({ name: 'node-1' })],
      containers: [{ id: 'abcabcabcabc', name: 'node-1-thing', pod: 'node-1-thing' }],
    });
    expect(kinds(rels, 'backs')).toHaveLength(1);
    expect(kinds(rels, 'hosts')).toHaveLength(0);
  });
});

describe('output hygiene', () => {
  it('emits no duplicate edge ids', () => {
    const rels = buildRelations({
      containers: [{ id: 'aaaaaaaaaaaa', name: 'k8s_c_web-1_default_u_0' }],
      pods: [pod({ name: 'web-1', labels: { app: 'web' }, owner: { kind: 'Deployment', name: 'web' } })],
      services: [svc({ name: 'web', selector: '{"app":"web"}' }), svc({ name: 'web2', selector: '{"app":"web"}' })],
      deployments: [workload({ name: 'web' })],
      nodes: [node()],
    });
    expect(new Set(rels.map((r) => r.id)).size).toBe(rels.length);
    expect(rels.length).toBeGreaterThan(3);
  });

  it('survives empty and malformed input without throwing', () => {
    expect(buildRelations(empty)).toEqual([]);
    expect(buildRelations({ containers: [{}], pods: [{}], services: [{}], deployments: [{}], nodes: [{}] } as any)).toBeInstanceOf(Array);
  });

  it('builds ids the renderer can match', () => {
    expect(podId('kube-system', 'coredns-1')).toBe('pod-kube-system-coredns_1');
    expect(svcId('default', 'web')).toBe('svc-default-web');
    expect(containerId('0123456789abcdef')).toBe('docker-0123456789ab');
  });
});
