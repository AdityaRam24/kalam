// Normalizing raw `kubectl -o json` items into the shapes every Kalam view
// reads — with the fields that make a *topology* possible.
//
// The topology map draws relationships, and a relationship can only be drawn
// from data that carries it. Two facts drive almost every edge on that map and
// both were being thrown away before they reached the UI:
//
//   1. A Service selects pods by LABEL, never by name. Without `spec.selector`
//      the map has to guess from name substrings, which invents edges between
//      unrelated objects and misses every correctly-named one.
//   2. A Pod's ownerReferences point at a ReplicaSet, not at the Deployment
//      people think in terms of. Following that one extra hop is the whole
//      difference between "these 14 pods belong to this deployment" and a
//      column of orphans.
//
// Everything here is pure so the rules above are unit-tested from fixtures
// (server/__tests__/workloads.test.ts) rather than trusted.

export interface OwnerRef {
  kind: string;
  name: string;
}

/** JSON-encoded label selector, or 'None'. The UI parses it back. */
export type SelectorString = string;

const encodeSelector = (sel: unknown): SelectorString =>
  sel && typeof sel === 'object' && Object.keys(sel as object).length > 0
    ? JSON.stringify(sel)
    : 'None';

/**
 * Index ReplicaSets (and any other intermediate controller) by
 * `namespace/name` so a pod's owner can be followed to the workload a human
 * would name.
 */
export function indexByKey(items: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const it of items || []) {
    const ns = it?.metadata?.namespace || 'default';
    const name = it?.metadata?.name;
    if (name) map.set(`${ns}/${name}`, it);
  }
  return map;
}

/**
 * Owner map built from a PROJECTED ReplicaSet listing rather than full JSON.
 *
 * This matters at production scale. ReplicaSets are only ever consulted to
 * answer "which Deployment is behind this pod", but Kubernetes keeps ten
 * revisions per Deployment by default, so `kubectl get rs -A -o json` is
 * frequently the single largest object in the cluster — hundreds of megabytes
 * on a busy cluster, fetched over one SSH round trip, to extract two strings
 * per row. The projection below is four columns:
 *
 *   NAMESPACE  NAME  OWNER_KIND  OWNER_NAME
 *
 * kubectl prints `<none>` for a missing column, and names never contain
 * whitespace, so splitting on runs of spaces is exact.
 */
export function parseReplicaSetOwners(text: string): Map<string, any> {
  const map = new Map<string, any>();
  for (const line of (text || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [namespace, name, ownerKind, ownerName] = cols;
    if (!namespace || !name || name === 'NAME') continue;
    if (!ownerKind || ownerKind === '<none>' || !ownerName || ownerName === '<none>') continue;
    // Shaped like a real ReplicaSet object so resolvePodOwner needs no special
    // case for the projected form.
    map.set(`${namespace}/${name}`, {
      kind: 'ReplicaSet',
      metadata: { name, namespace, ownerReferences: [{ kind: ownerKind, name: ownerName, controller: true }] },
    });
  }
  return map;
}

/**
 * The workload that controls this pod.
 *
 * A Deployment's pods are owned by a ReplicaSet, which is in turn owned by the
 * Deployment; resolving only the first hop labels every pod with a ReplicaSet
 * name nobody recognises, so the ReplicaSet is followed through. StatefulSets,
 * DaemonSets and Jobs own their pods directly and need no second hop.
 */
export function resolvePodOwner(pod: any, replicaSets: Map<string, any>): OwnerRef | null {
  const refs = pod?.metadata?.ownerReferences || [];
  const controller = refs.find((r: any) => r?.controller) || refs[0];
  if (!controller?.kind || !controller?.name) return null;

  if (controller.kind !== 'ReplicaSet') {
    return { kind: controller.kind, name: controller.name };
  }

  const ns = pod?.metadata?.namespace || 'default';
  const rs = replicaSets.get(`${ns}/${controller.name}`);
  const rsOwner = (rs?.metadata?.ownerReferences || []).find((r: any) => r?.controller)
    || (rs?.metadata?.ownerReferences || [])[0];
  if (rsOwner?.kind && rsOwner?.name) return { kind: rsOwner.kind, name: rsOwner.name };

  // A bare ReplicaSet with no Deployment above it is legitimate — report it
  // rather than pretending the pod is unowned.
  return { kind: 'ReplicaSet', name: controller.name };
}

export function normalizePod(item: any, replicaSets: Map<string, any> = new Map()): any {
  const metadata = item?.metadata || {};
  const status = item?.status || {};
  const spec = item?.spec || {};
  const cs = status.containerStatuses || [];

  return {
    name: metadata.name,
    namespace: metadata.namespace || 'default',
    status: status.phase || 'Unknown',
    ready: `${cs.filter((c: any) => c.ready).length}/${cs.length}`,
    node: spec.nodeName || 'None',
    restarts: cs.reduce((a: number, c: any) => a + (c.restartCount || 0), 0),
    ip: status.podIP || 'None',
    labels: metadata.labels || {},
    owner: resolvePodOwner(item, replicaSets),
    created: metadata.creationTimestamp,
    containers: (spec.containers || []).map((c: any) => {
      const st = cs.find((s: any) => s.name === c.name) || {};
      return {
        name: c.name,
        image: c.image,
        ready: !!st.ready,
        state: Object.keys(st.state || {})[0] || 'unknown',
      };
    }),
  };
}

export function normalizeService(item: any): any {
  const metadata = item?.metadata || {};
  const spec = item?.spec || {};
  return {
    name: metadata.name,
    namespace: metadata.namespace || 'default',
    type: spec.type || 'ClusterIP',
    clusterIp: spec.clusterIP || '—',
    ports: (spec.ports || [])
      .map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol || 'TCP'}`)
      .join(', '),
    // The field the whole Service→Pod layer of the map is drawn from.
    selector: encodeSelector(spec.selector),
    created: metadata.creationTimestamp,
  };
}

/**
 * Deployments, StatefulSets and DaemonSets share one shape. They are all
 * "the thing that owns these pods", and a map that only knows Deployments
 * leaves every StatefulSet pod (databases, queues — the interesting ones)
 * floating unattached.
 */
export function normalizeWorkload(item: any): any {
  const metadata = item?.metadata || {};
  const spec = item?.spec || {};
  const status = item?.status || {};
  const kind = item?.kind || 'Deployment';

  // A DaemonSet's "desired" is however many nodes it targets, not spec.replicas.
  const desired = kind === 'DaemonSet'
    ? (status.desiredNumberScheduled ?? 0)
    : (spec.replicas ?? 0);
  const ready = kind === 'DaemonSet'
    ? (status.numberReady ?? 0)
    : (status.readyReplicas ?? 0);
  const available = kind === 'DaemonSet'
    ? (status.numberAvailable ?? 0)
    : (status.availableReplicas ?? 0);

  return {
    name: metadata.name,
    namespace: metadata.namespace || 'default',
    kind,
    ready: `${ready}/${desired}`,
    available,
    updated: kind === 'DaemonSet' ? (status.updatedNumberScheduled ?? 0) : (status.updatedReplicas ?? 0),
    replicas: desired,
    selector: encodeSelector(spec.selector?.matchLabels),
    created: metadata.creationTimestamp,
  };
}

export function normalizeNode(item: any): any {
  const metadata = item?.metadata || {};
  const status = item?.status || {};
  const conds = status.conditions || [];
  const ready = conds.find((c: any) => c.type === 'Ready');
  const labels = metadata.labels || {};
  const ip = (status.addresses || []).find((a: any) => a.type === 'InternalIP');

  return {
    name: metadata.name,
    status: ready ? (ready.status === 'True' ? 'Ready' : 'NotReady') : 'Unknown',
    role: 'node-role.kubernetes.io/control-plane' in labels || 'node-role.kubernetes.io/master' in labels
      ? 'control-plane'
      : (labels['kubernetes.io/role'] || 'worker'),
    version: status.nodeInfo?.kubeletVersion || 'Unknown',
    ip: ip?.address || 'Unknown',
    os: status.nodeInfo?.operatingSystem || 'Linux',
    gpus: status.capacity?.['nvidia.com/gpu'] || '0',
    created: metadata.creationTimestamp,
  };
}

export interface ClusterResources {
  pods: any[];
  services: any[];
  deployments: any[];
  nodes: any[];
}

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

/**
 * Turn a flat list of `kubectl get ... -o json` items (any mix of kinds) into
 * the four arrays every view consumes. ReplicaSets are consumed for owner
 * resolution and deliberately not surfaced: nobody wants to look at them.
 */
export function normalizeClusterItems(
  items: any[],
  /** Pre-built owner index (see parseReplicaSetOwners). Falls back to any
   *  full ReplicaSet objects present in `items`. */
  replicaSetOwners?: Map<string, any>,
): ClusterResources {
  const all = items || [];
  const replicaSets = replicaSetOwners && replicaSetOwners.size > 0
    ? replicaSetOwners
    : indexByKey(all.filter((i) => i?.kind === 'ReplicaSet'));

  const pods: any[] = [];
  const services: any[] = [];
  const deployments: any[] = [];
  const nodes: any[] = [];

  for (const item of all) {
    switch (item?.kind) {
      case 'Pod': pods.push(normalizePod(item, replicaSets)); break;
      case 'Service': services.push(normalizeService(item)); break;
      case 'Node': nodes.push(normalizeNode(item)); break;
      default:
        if (WORKLOAD_KINDS.has(item?.kind)) deployments.push(normalizeWorkload(item));
    }
  }

  return { pods, services, deployments, nodes };
}
