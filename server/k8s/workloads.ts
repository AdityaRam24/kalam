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

// ---------------------------------------------------------------------------
// Resource quantities
//
// "What is this component actually using?" cannot be answered from counts of
// pods, and on a GPU platform it is the question that matters most — a
// namespace with three pods holding eight A100s is a very different tenant from
// one with thirty pods holding none.
//
// Kubernetes quantities are strings in several notations ("500m", "2", "1Gi",
// "1.5", "512Mi", "1e3"), so they are parsed to one canonical unit here rather
// than in the UI, where summing "500m" + "2" would silently produce nonsense.
// ---------------------------------------------------------------------------

/** CPU quantity -> millicores. "500m" -> 500, "2" -> 2000. */
export function parseCpu(q: unknown): number {
  if (typeof q === 'number') return Math.round(q * 1000);
  if (typeof q !== 'string' || !q.trim()) return 0;
  const t = q.trim();
  if (t.endsWith('m')) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

const MEM_SUFFIX: Record<string, number> = {
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};

/** Memory quantity -> bytes. "1Gi" -> 1073741824, "512Mi" -> 536870912. */
export function parseMemory(q: unknown): number {
  if (typeof q === 'number') return Math.round(q);
  if (typeof q !== 'string' || !q.trim()) return 0;
  const m = q.trim().match(/^([0-9.eE+-]+)\s*([A-Za-z]*)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const suffix = m[2];
  if (!suffix) return Math.round(n);
  const mult = MEM_SUFFIX[suffix];
  return mult ? Math.round(n * mult) : 0;
}

export interface ResourceAmounts {
  cpuMilli: number;
  memBytes: number;
  /** nvidia.com/gpu, plus the AMD/Intel equivalents so the count is honest. */
  gpu: number;
}

const GPU_KEYS = ['nvidia.com/gpu', 'amd.com/gpu', 'gpu.intel.com/i915', 'habana.ai/gaudi'];

export function parseResources(block: any): ResourceAmounts {
  const b = block || {};
  let gpu = 0;
  for (const k of GPU_KEYS) {
    const n = Number(b[k]);
    if (Number.isFinite(n)) gpu += n;
  }
  return { cpuMilli: parseCpu(b.cpu), memBytes: parseMemory(b.memory), gpu };
}

// ---------------------------------------------------------------------------
// Status as an operator reads it
//
// `status.phase` is "Running" for a pod whose container is in CrashLoopBackOff,
// and "Pending" for one stuck on ImagePullBackOff — the phase alone hides
// exactly the failures people go looking for. `kubectl get pods` prints a
// derived STATUS column instead; podDisplayStatus reproduces that derivation
// (kubectl's printPod) so Kalam says what kubectl would say.
// ---------------------------------------------------------------------------

export type Health = 'healthy' | 'progressing' | 'failing' | 'completed' | 'unknown';

export function podDisplayStatus(item: any): string {
  const metadata = item?.metadata || {};
  const status = item?.status || {};
  const spec = item?.spec || {};
  let reason: string = status.reason || status.phase || 'Unknown';

  // Init containers run first, in order; the first one not finished cleanly
  // is what the pod is waiting on.
  const initStatuses: any[] = status.initContainerStatuses || [];
  const initTotal = (spec.initContainers || []).length || initStatuses.length;
  let initializing = false;
  for (let i = 0; i < initStatuses.length; i++) {
    const st = initStatuses[i]?.state || {};
    if (st.terminated && st.terminated.exitCode === 0) continue;
    initializing = true;
    if (st.terminated) {
      reason = st.terminated.reason
        ? `Init:${st.terminated.reason}`
        : st.terminated.signal ? `Init:Signal:${st.terminated.signal}` : `Init:ExitCode:${st.terminated.exitCode}`;
    } else if (st.waiting?.reason && st.waiting.reason !== 'PodInitializing') {
      reason = `Init:${st.waiting.reason}`;
    } else {
      reason = `Init:${i}/${initTotal}`;
    }
    break;
  }

  if (!initializing) {
    let hasRunning = false;
    const cs: any[] = status.containerStatuses || [];
    for (let i = cs.length - 1; i >= 0; i--) {
      const st = cs[i]?.state || {};
      if (st.waiting?.reason) reason = st.waiting.reason;
      else if (st.terminated?.reason) reason = st.terminated.reason;
      else if (st.terminated) reason = st.terminated.signal ? `Signal:${st.terminated.signal}` : `ExitCode:${st.terminated.exitCode}`;
      else if (cs[i]?.ready && st.running) hasRunning = true;
    }
    // A pod with one finished and one running container is still running.
    if (reason === 'Completed' && hasRunning) {
      const ready = (status.conditions || []).some((c: any) => c.type === 'Ready' && c.status === 'True');
      reason = ready ? 'Running' : 'NotReady';
    }
  }

  if (metadata.deletionTimestamp) reason = status.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
  return reason;
}

const FAILING_POD = /BackOff|Err|Error|OOMKilled|Evicted|Failed|Invalid|ExitCode|Signal|ContainerCannotRun|DeadlineExceeded|NodeLost|Unknown/i;

/** Health bucket for a pod's display status. Restarts alone never fail a pod. */
export function podHealth(displayStatus: string, ready?: string): Health {
  const s = displayStatus || '';
  if (s === 'Completed' || s === 'Succeeded') return 'completed';
  if (FAILING_POD.test(s)) return 'failing';
  if (s === 'Running') {
    const [r, t] = String(ready || '').split('/').map(Number);
    return Number.isFinite(r) && Number.isFinite(t) && t > 0 && r < t ? 'progressing' : 'healthy';
  }
  if (/Pending|ContainerCreating|PodInitializing|Init:|Terminating/i.test(s)) return 'progressing';
  return 'unknown';
}

export function normalizePod(item: any, replicaSets: Map<string, any> = new Map()): any {
  const metadata = item?.metadata || {};
  const status = item?.status || {};
  const spec = item?.spec || {};
  const cs = status.containerStatuses || [];
  const ready = `${cs.filter((c: any) => c.ready).length}/${cs.length}`;
  const displayStatus = podDisplayStatus(item);
  // Why the last restart happened — "OOMKilled" explains a crash loop at a glance.
  const lastReason = cs
    .map((c: any) => c?.lastState?.terminated?.reason)
    .find((r: any) => typeof r === 'string' && r) || undefined;

  return {
    name: metadata.name,
    namespace: metadata.namespace || 'default',
    status: status.phase || 'Unknown',
    displayStatus,
    health: podHealth(displayStatus, ready),
    ...(lastReason ? { lastReason } : {}),
    ready,
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
        requests: parseResources(c.resources?.requests),
        limits: parseResources(c.resources?.limits),
      };
    }),
    // Which PersistentVolumeClaims this pod mounts — the storage half of
    // "what is it using", and the thing that explains a pod stuck Pending.
    claims: (spec.volumes || [])
      .map((v: any) => v?.persistentVolumeClaim?.claimName)
      .filter((n: any): n is string => typeof n === 'string' && !!n),
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
 * One word for a workload's rollout state, from the same numbers
 * `kubectl rollout status` reads. A Deployment whose rollout hit its progress
 * deadline is Failed even while old pods keep it partly available.
 */
export function workloadStatus(w: {
  desired: number; ready: number; available: number; updated: number; conditions: any[];
}): { status: string; health: Health } {
  const deadline = w.conditions.some(
    (c: any) => c?.type === 'Progressing' && c?.status === 'False' && c?.reason === 'ProgressDeadlineExceeded',
  );
  if (deadline) return { status: 'Failed', health: 'failing' };
  if (w.desired === 0) return { status: 'ScaledToZero', health: 'completed' };
  if (w.ready >= w.desired && w.available >= w.desired && w.updated >= w.desired) return { status: 'Available', health: 'healthy' };
  if (w.ready === 0) return { status: 'Unavailable', health: 'failing' };
  if (w.updated < w.desired) return { status: 'Updating', health: 'progressing' };
  return { status: 'Degraded', health: 'progressing' };
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
  const updated = kind === 'DaemonSet' ? (status.updatedNumberScheduled ?? 0) : (status.updatedReplicas ?? 0);
  // An absent "updated" count (older API servers, OnDelete StatefulSets) is not
  // evidence of a rollout in progress, so it does not drive the verdict.
  const updatedRaw = kind === 'DaemonSet' ? status.updatedNumberScheduled : status.updatedReplicas;
  const { status: rollout, health } = workloadStatus({
    desired, ready, available,
    updated: typeof updatedRaw === 'number' ? updatedRaw : desired,
    conditions: status.conditions || [],
  });

  return {
    name: metadata.name,
    namespace: metadata.namespace || 'default',
    kind,
    status: rollout,
    health,
    ready: `${ready}/${desired}`,
    available,
    updated,
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

  const cap = status.capacity || {};
  const alloc = status.allocatable || {};
  // Pressure conditions are what make a Ready node still a problem.
  const pressure = conds
    .filter((c: any) => c.type !== 'Ready' && c.status === 'True')
    .map((c: any) => String(c.type));

  return {
    name: metadata.name,
    status: ready ? (ready.status === 'True' ? 'Ready' : 'NotReady') : 'Unknown',
    schedulable: !item?.spec?.unschedulable,
    pressure,
    capacity: { cpuMilli: parseCpu(cap.cpu), memBytes: parseMemory(cap.memory), gpu: parseResources(cap).gpu, pods: Number(cap.pods) || 0 },
    allocatable: { cpuMilli: parseCpu(alloc.cpu), memBytes: parseMemory(alloc.memory), gpu: parseResources(alloc).gpu, pods: Number(alloc.pods) || 0 },
    kernel: status.nodeInfo?.kernelVersion,
    runtime: status.nodeInfo?.containerRuntimeVersion,
    osImage: status.nodeInfo?.osImage,
    gpuProduct: labels['nvidia.com/gpu.product'],
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
