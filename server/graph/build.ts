// Build the infrastructure graph from whatever a host was willing to tell us.
//
// Every input is optional and every parser is defensive: this data comes from
// `kubectl -o json`, `docker ps`, `ss -tulnp` and friends over SSH, on hosts
// that may not have kubectl at all. A missing or malformed section degrades the
// graph, it never throws.
//
// This module is PURE — no SSH, no fs, no Express — so the whole edge model is
// unit-testable from fixtures.

import { identifyComponent } from '../pcai/components.js';
import { CLUSTER_CRITICAL, MAX_FANOUT, NODE_CRITICAL, dependencyNote, tierOf } from './deps.js';
import { GraphBuilder, nodeId, type Health, type InfraGraph } from './model.js';

export interface VmInput {
  name: string;
  host: string;
  via?: string;
  reachable?: boolean;
  /** Name of the Kubernetes node this VM *is*, if the caller resolved it. */
  k8sNodeName?: string;
}

export interface DockerContainerInput {
  id?: string;
  name?: string;
  image?: string;
  state?: string;
  status?: string;
  ports?: string;
}

export interface SystemUnitInput {
  unit: string;
  sub?: string;
  description?: string;
}

export interface ListeningPortInput {
  proto: string;
  local: string;
  process?: string;
}

export interface BuildInput {
  /** VM name the data was gathered from — becomes InfraGraph.source. */
  source: string;
  /** Inventory (all VMs) so SSH jump-host paths become edges. */
  vms?: VmInput[];
  /** Parsed `kubectl get nodes -o json`. */
  k8sNodes?: any;
  /** Parsed `kubectl get pods -A -o json`. */
  pods?: any;
  /** Parsed `kubectl get svc -A -o json`. */
  services?: any;
  /** Parsed `kubectl get pvc -A -o json`. */
  pvcs?: any;
  containers?: DockerContainerInput[];
  systemServices?: SystemUnitInput[];
  listeningPorts?: ListeningPortInput[];
}

const items = (raw: any): any[] => (Array.isArray(raw?.items) ? raw.items : []);

/**
 * Health of a pod, using the same rules as the diagnosis engine so the two
 * never disagree about what "broken" means.
 */
export function podHealth(pod: any): { health: Health; reason?: string; restarts: number } {
  const phase = pod?.status?.phase || 'Unknown';
  const statuses = [
    ...(pod?.status?.containerStatuses || []),
    ...(pod?.status?.initContainerStatuses || []),
  ];
  const restarts = statuses.reduce((a: number, c: any) => a + (c.restartCount || 0), 0);

  if (phase === 'Succeeded') return { health: 'healthy', restarts };

  for (const cs of statuses) {
    const waiting = cs.state?.waiting?.reason;
    const lastTerm = cs.lastState?.terminated;
    if (waiting && !['ContainerCreating', 'PodInitializing'].includes(waiting)) {
      return { health: 'failed', reason: waiting, restarts };
    }
    if (lastTerm?.reason === 'OOMKilled' || lastTerm?.exitCode === 137) {
      return { health: 'failed', reason: 'OOMKilled', restarts };
    }
    if ((cs.restartCount || 0) >= 5 && !cs.ready) {
      return { health: 'failed', reason: 'CrashLoopBackOff', restarts };
    }
  }

  if (pod?.status?.reason === 'Evicted') return { health: 'failed', reason: 'Evicted', restarts };
  if (phase === 'Failed') return { health: 'failed', reason: 'Failed', restarts };
  if (phase === 'Pending') return { health: 'failed', reason: 'Pending', restarts };
  // Running but not all containers ready is a real, common half-state.
  if (phase === 'Running' && statuses.length && statuses.some((c: any) => !c.ready)) {
    return { health: 'degraded', reason: 'NotReady', restarts };
  }
  if (phase === 'Running') return { health: 'healthy', restarts };
  return { health: 'unknown', reason: phase, restarts };
}

/** Health of a Kubernetes node from its conditions. */
export function k8sNodeHealth(node: any): { health: Health; reason?: string } {
  const conds: any[] = node?.status?.conditions || [];
  const ready = conds.find((c) => c.type === 'Ready');
  if (ready && ready.status !== 'True') return { health: 'failed', reason: 'NotReady' };
  const pressure = conds.find(
    (c) => ['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(c.type) && c.status === 'True'
  );
  if (pressure) return { health: 'degraded', reason: pressure.type };
  if (node?.spec?.unschedulable) return { health: 'degraded', reason: 'Cordoned' };
  return ready ? { health: 'healthy' } : { health: 'unknown' };
}

/**
 * Resolve a pod's controlling workload. ReplicaSet owners are collapsed to
 * their Deployment by stripping the pod-template hash, which is what an
 * operator actually cares about.
 */
export function ownerOf(pod: any): { kind: string; name: string } | undefined {
  const ref = (pod?.metadata?.ownerReferences || [])[0];
  if (!ref?.name || !ref?.kind) return undefined;
  if (ref.kind === 'ReplicaSet') {
    const m = String(ref.name).match(/^(.*)-[a-z0-9]{6,10}$/);
    return { kind: 'Deployment', name: m ? m[1] : ref.name };
  }
  return { kind: ref.kind, name: ref.name };
}

/** A Service selects a pod when every selector label matches. Empty = matches nothing. */
export function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector || !Object.keys(selector).length) return false;
  const l = labels || {};
  return Object.entries(selector).every(([k, v]) => l[k] === v);
}

export function buildInfraGraph(input: BuildInput): InfraGraph {
  const b = new GraphBuilder(input.source);

  // ---- VMs and their SSH jump paths ---------------------------------------
  for (const vm of input.vms || []) {
    b.node({
      id: nodeId('vm', vm.name),
      kind: 'vm',
      name: vm.name,
      health: vm.reachable === false ? 'failed' : vm.reachable === true ? 'healthy' : 'unknown',
      reason: vm.reachable === false ? 'Unreachable' : undefined,
      meta: { host: vm.host, via: vm.via, source: vm.name === input.source },
    });
  }
  for (const vm of input.vms || []) {
    // The jump host carries the only path to this VM: if it dies, we lose the VM.
    if (vm.via) b.edge(nodeId('vm', vm.via), nodeId('vm', vm.name), 'via', `${vm.name} is only reachable through jump host ${vm.via}.`);
  }

  // ---- Kubernetes nodes ----------------------------------------------------
  for (const n of items(input.k8sNodes)) {
    const name = n?.metadata?.name;
    if (!name) continue;
    const { health, reason } = k8sNodeHealth(n);
    const roles = Object.keys(n?.metadata?.labels || {})
      .filter((l) => l.startsWith('node-role.kubernetes.io/'))
      .map((l) => l.replace('node-role.kubernetes.io/', ''))
      .filter(Boolean);
    b.node({
      id: nodeId('k8sNode', name),
      kind: 'k8sNode',
      name,
      health,
      reason,
      meta: {
        role: roles.join(',') || 'worker',
        kubelet: n?.status?.nodeInfo?.kubeletVersion,
        cpu: n?.status?.capacity?.cpu,
        memory: n?.status?.capacity?.memory,
        gpu: n?.status?.capacity?.['nvidia.com/gpu'],
        taints: (n?.spec?.taints || []).length,
      },
    });
  }

  // Tie the VM we are standing on to its cluster node, when the caller resolved it.
  for (const vm of input.vms || []) {
    if (vm.k8sNodeName) {
      b.edge(nodeId('vm', vm.name), nodeId('k8sNode', vm.k8sNodeName), 'hosts', `${vm.name} is the machine behind cluster node ${vm.k8sNodeName}.`);
    }
  }

  // ---- Pods, their owners, and the node hosting them -----------------------
  interface PodRef { id: string; ns: string; name: string; node?: string; componentId?: string; labels: Record<string, string> }
  const podRefs: PodRef[] = [];

  for (const p of items(input.pods)) {
    const name = p?.metadata?.name;
    if (!name) continue;
    const ns = p?.metadata?.namespace || 'default';
    const image = (p?.spec?.containers || [])[0]?.image || '';
    const owner = ownerOf(p);
    const component = identifyComponent(`${name} ${owner?.name || ''} ${image} ${ns}`.toLowerCase());
    const { health, reason, restarts } = podHealth(p);
    const id = nodeId('pod', name, ns);

    b.node({
      id,
      kind: 'pod',
      name,
      namespace: ns,
      health,
      reason,
      component: component || undefined,
      platform: tierOf(component?.id) !== 'workload',
      meta: {
        node: p?.spec?.nodeName || '',
        image,
        restarts,
        owner: owner ? `${owner.kind}/${owner.name}` : undefined,
        tier: tierOf(component?.id),
      },
    });
    podRefs.push({ id, ns, name, node: p?.spec?.nodeName, componentId: component?.id, labels: p?.metadata?.labels || {} });

    if (p?.spec?.nodeName) {
      b.edge(nodeId('k8sNode', p.spec.nodeName), id, 'hosts', `Pod is scheduled on node ${p.spec.nodeName}.`);
    }

    if (owner) {
      const wid = nodeId('workload', owner.name, ns);
      b.node({ id: wid, kind: 'workload', name: owner.name, namespace: ns, health: 'unknown', meta: { kind: owner.kind } });
      b.edge(id, wid, 'member', `${name} is one of ${owner.kind}/${owner.name}'s pods.`);
    }

    // PVC -> pod: an unbound claim keeps the pod in ContainerCreating.
    for (const v of p?.spec?.volumes || []) {
      const claim = v?.persistentVolumeClaim?.claimName;
      if (claim) {
        const pid = nodeId('pvc', claim, ns);
        b.node({ id: pid, kind: 'pvc', name: claim, namespace: ns, health: 'unknown', meta: {} });
        b.edge(pid, id, 'mounts', `${name} mounts PVC ${claim}.`);
      }
    }
  }

  // ---- PersistentVolumeClaims ---------------------------------------------
  for (const c of items(input.pvcs)) {
    const name = c?.metadata?.name;
    if (!name) continue;
    const ns = c?.metadata?.namespace || 'default';
    const phase = c?.status?.phase || 'Unknown';
    b.node({
      id: nodeId('pvc', name, ns),
      kind: 'pvc',
      name,
      namespace: ns,
      health: phase === 'Bound' ? 'healthy' : phase === 'Pending' ? 'failed' : 'unknown',
      reason: phase === 'Bound' ? undefined : phase,
      meta: { phase, storageClass: c?.spec?.storageClassName, capacity: c?.status?.capacity?.storage },
    });
  }

  // ---- Services: real selector matching, not name guessing -----------------
  for (const s of items(input.services)) {
    const name = s?.metadata?.name;
    if (!name) continue;
    const ns = s?.metadata?.namespace || 'default';
    const sid = nodeId('service', name, ns);
    b.node({
      id: sid,
      kind: 'service',
      name,
      namespace: ns,
      health: 'unknown',
      meta: {
        type: s?.spec?.type || 'ClusterIP',
        clusterIp: s?.spec?.clusterIP,
        ports: (s?.spec?.ports || []).map((p: any) => `${p.port}/${p.protocol || 'TCP'}`).join(', '),
      },
    });
    const selector = s?.spec?.selector;
    for (const pod of podRefs) {
      if (pod.ns === ns && selectorMatches(selector, pod.labels)) {
        b.edge(pod.id, sid, 'member', `Service ${name} selects this pod (${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(', ')}).`);
      }
    }
  }

  // ---- Plain containers and systemd units on the host ----------------------
  const hostVmId = nodeId('vm', input.source);
  for (const c of input.containers || []) {
    const name = c.name || c.id;
    if (!name) continue;
    const running = (c.state || '').toLowerCase() === 'running' || /\bup\b/i.test(c.status || '');
    const component = identifyComponent(`${name} ${c.image || ''}`.toLowerCase());
    const id = nodeId('container', name);
    b.node({
      id,
      kind: 'container',
      name,
      health: running ? 'healthy' : 'failed',
      reason: running ? undefined : c.status || 'exited',
      component: component || undefined,
      meta: { image: c.image, status: c.status },
    });
    b.edge(hostVmId, id, 'hosts', `Container runs on ${input.source}.`);
  }

  for (const u of input.systemServices || []) {
    if (!u?.unit) continue;
    const component = identifyComponent(u.unit.toLowerCase());
    const id = nodeId('unit', u.unit);
    b.node({
      id,
      kind: 'unit',
      name: u.unit,
      health: u.sub === 'running' || !u.sub ? 'healthy' : 'failed',
      reason: u.sub && u.sub !== 'running' ? u.sub : undefined,
      component: component || undefined,
      platform: tierOf(component?.id) !== 'workload',
      meta: { description: u.description, sub: u.sub, tier: tierOf(component?.id) },
    });
    b.edge(hostVmId, id, 'hosts', `systemd unit on ${input.source}.`);
  }

  for (const p of input.listeningPorts || []) {
    if (!p?.local) continue;
    const id = nodeId('port', `${p.proto}/${p.local}`);
    b.node({ id, kind: 'port', name: `${p.local} (${p.proto})`, health: 'healthy', meta: { process: p.process } });
    // Attribute the port to the process holding it, when ss/netstat revealed one.
    const unit = (input.systemServices || []).find((u) => p.process && u.unit.startsWith(p.process));
    if (unit) b.edge(nodeId('unit', unit.unit), id, 'binds', `${unit.unit} listens on ${p.local}.`);
    else b.edge(hostVmId, id, 'binds', `Listening on ${input.source}.`);
  }

  // ---- Platform dependency edges (the catalog knowledge, as edges) ---------
  applyPlatformDependencies(b, podRefs);

  // ---- Roll aggregate health up from members ------------------------------
  rollUpAggregates(b);

  return b.build();
}

/**
 * Turn cluster-critical / node-critical catalog entries into `requires` edges.
 * Tier order (cluster -> node -> workload) guarantees the result is acyclic.
 */
function applyPlatformDependencies(
  b: GraphBuilder,
  pods: Array<{ id: string; node?: string; componentId?: string }>
): void {
  const clusterCritical = pods.filter((p) => p.componentId && p.componentId in CLUSTER_CRITICAL);
  const nodeCritical = pods.filter((p) => p.componentId && p.componentId in NODE_CRITICAL);

  // Node tier: everything sharing the node, excluding other platform pods.
  const byNode = new Map<string, typeof pods>();
  for (const p of pods) {
    if (!p.node) continue;
    const list = byNode.get(p.node);
    if (list) list.push(p);
    else byNode.set(p.node, [p]);
  }
  for (const src of nodeCritical) {
    if (!src.node) continue;
    const note = dependencyNote(src.componentId!);
    for (const target of byNode.get(src.node) || []) {
      if (target.id === src.id) continue;
      if (target.componentId && tierOf(target.componentId) !== 'workload') continue;
      b.edge(src.id, target.id, 'requires', note);
    }
  }

  // Cluster tier: everything else in the cluster, node-critical pods included.
  for (const src of clusterCritical) {
    const note = dependencyNote(src.componentId!);
    const targets = pods.filter(
      (t) => t.id !== src.id && tierOf(t.componentId) !== 'cluster'
    );
    const node = b.get(src.id);
    if (targets.length > MAX_FANOUT) {
      // Too many to draw usefully; record the scope so analysis can still say
      // "cluster-wide" without a half-million edges.
      if (node) node.meta.dependencyScope = `cluster-wide (${targets.length} workloads)`;
      continue;
    }
    if (node) node.meta.dependencyScope = 'cluster-wide';
    for (const t of targets) b.edge(src.id, t.id, 'requires', note);
  }
}

/**
 * Services and workloads have no health of their own — they are exactly as
 * healthy as the pods behind them. All members broken is a real outage;
 * some members broken is degraded.
 */
function rollUpAggregates(b: GraphBuilder): void {
  const members = new Map<string, { total: number; broken: number }>();
  for (const e of b.allEdges()) {
    if (e.kind !== 'member') continue;
    const from = b.get(e.from);
    if (!from) continue;
    const agg = members.get(e.to) ?? { total: 0, broken: 0 };
    agg.total++;
    if (from.health === 'failed' || from.health === 'degraded') agg.broken++;
    members.set(e.to, agg);
  }
  for (const [id, agg] of members) {
    const node = b.get(id);
    if (!node || (node.kind !== 'service' && node.kind !== 'workload')) continue;
    node.meta.members = agg.total;
    node.meta.brokenMembers = agg.broken;
    if (agg.broken === 0) node.health = 'healthy';
    else if (agg.broken >= agg.total) {
      node.health = 'failed';
      node.reason = node.kind === 'service' ? 'NoHealthyEndpoints' : 'AllReplicasDown';
    } else {
      node.health = 'degraded';
      node.reason = `${agg.broken}/${agg.total} replicas unhealthy`;
    }
  }
}
