// HPE VM Essentials (VME) — what the Manager's API says, in Trinetra's terms.
//
// The VME Manager speaks the Morpheus REST API (HPE's OpenAPI spec:
// github.com/HewlettPackard/morpheus-openapi). It knows the layer Trinetra
// otherwise cannot see without SSH-ing host by host: which hypervisor hosts
// exist, which VMs run on each, how full the datastores are, what alarms are
// open, and who changed what. The point of this module is the JOIN: a
// Kubernetes node is a VM, the VM sits on a host, the host sits in a cluster
// with datastores — so "why is this pod slow" can be answered with "its node's
// host is at 96% memory".
//
// Pure functions only (normalize, join, judge, lay out); server/vme/client.ts
// fetches, server/vme/router.ts serves, server/__tests__/vme.test.ts asserts.

// ---------------------------------------------------------------------------
// Normalized shapes
// ---------------------------------------------------------------------------

export interface VmeCluster {
  id: number;
  name: string;
  type: string;
  status: string;
  cloud?: string;
  hostIds: number[];
  /** Worker stats as the Manager reports them, when present. */
  cpuPct: number | null;
}

export interface VmeHost {
  id: number;
  name: string;
  clusterId?: number;
  cluster?: string;
  cloud?: string;
  ip?: string;
  status: string;
  power: string;
  cores: number | null;
  cpuPct: number | null;
  memTotal: number | null;
  memUsed: number | null;
  storageTotal: number | null;
  storageUsed: number | null;
  agentLastSeen?: string;
  os?: string;
  vmIds: number[];
}

export interface VmeVm {
  id: number;
  name: string;
  hostname?: string;
  hostId?: number;
  host?: string;
  clusterId?: number;
  cluster?: string;
  cloud?: string;
  status: string;
  power: string;
  cores: number | null;
  cpuPct: number | null;
  memTotal: number | null;
  memUsed: number | null;
  storageTotal: number | null;
  storageUsed: number | null;
  gpus: number | null;
  ips: string[];
  os?: string;
  plan?: string;
  instanceId?: number;
  instance?: string;
  /** Kubernetes node this VM is, once joined (see joinKubernetes). */
  k8sNode?: string;
}

export interface VmeDatastore {
  id: number;
  name: string;
  type: string;
  total: number | null;
  free: number | null;
  active: boolean;
  online: boolean;
  /** The cluster it is attached to, when the API says so. */
  clusterId?: number;
  cloud?: string;
}

export interface VmeNetwork {
  id: number;
  name: string;
  type: string;
  cidr?: string;
  vlan?: number | null;
  gateway?: string;
  active: boolean;
  cloud?: string;
}

export interface VmeAlarm {
  id: number;
  name: string;
  severity: 'critical' | 'warning' | 'info';
  status: string;
  acknowledged: boolean;
  resource?: string;
  refType?: string;
  refId?: number;
  started?: string;
}

export interface VmeActivity {
  id: string;
  at: string;
  type: string;
  name: string;
  message: string;
  user?: string;
  objectType?: string;
  objectId?: number;
  success: boolean;
}

export interface K8sNodeInfo {
  name: string;
  addresses: string[];
  ready: boolean;
  roles: string[];
  gpus: number;
  pods: number;
}

export interface VmeSnapshot {
  connection: string;
  demo?: boolean;
  at: string;
  manager?: { user?: string; version?: string; appliance?: string };
  clusters: VmeCluster[];
  hosts: VmeHost[];
  vms: VmeVm[];
  datastores: VmeDatastore[];
  networks: VmeNetwork[];
  alarms: VmeAlarm[];
  activity: VmeActivity[];
  k8s?: { source: string; nodes: K8sNodeInfo[]; unmatched: string[]; error?: string };
  /** Which endpoints answered, and why the others did not. */
  sources: Record<string, { ok: boolean; count?: number; error?: string }>;
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: any): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const lower = (v: any) => str(v).toLowerCase();

/** Is this server a hypervisor host rather than a VM? */
export function isHost(s: any, parentIds: Set<number>, clusterHostIds: Set<number>): boolean {
  const t = s?.computeServerType || {};
  if (t.vmHypervisor === true || t.containerHypervisor === true) return true;
  if (parentIds.has(s?.id) || clusterHostIds.has(s?.id)) return true;
  const code = lower(t.code) + ' ' + lower(t.name);
  // Last resort, by type name — but a server with a parent is always a VM.
  return !s?.parentServer && /hypervisor|\bhost\b|esxi|bare ?metal/.test(code);
}

/** Server IPs: management IPs plus every interface address, de-duplicated. */
export function ipsOf(s: any): string[] {
  const out = new Set<string>();
  for (const v of [s?.externalIp, s?.internalIp, s?.sshHost]) if (v && /^[\d.:a-fA-F]+$/.test(v)) out.add(v);
  for (const i of s?.interfaces || []) for (const v of [i?.ipAddress, i?.publicIpAddress, i?.ipv6Address]) if (v) out.add(v);
  return [...out];
}

export interface RawVme {
  whoami?: any;
  servers?: any[];
  instances?: any[];
  clusters?: any[];
  datastores?: any[];
  networks?: any[];
  alarms?: any[];
  activity?: any[];
}

export function normalize(raw: RawVme, connection: string): Omit<VmeSnapshot, 'at' | 'sources'> {
  const servers = raw.servers || [];
  const parentIds = new Set<number>(servers.map((s) => s?.parentServer?.id).filter((x) => typeof x === 'number'));

  // Clusters that hold hypervisors, not Kubernetes clusters Morpheus also manages.
  const clusters: VmeCluster[] = (raw.clusters || []).map((c) => ({
    id: c.id,
    name: str(c.name),
    type: str(c?.type?.name || c?.type?.code || c?.layout?.name),
    status: str(c.status) || 'unknown',
    cloud: c?.zone?.name || c?.cloud?.name,
    hostIds: (c.servers || []).map((s: any) => s?.id).filter((x: any) => typeof x === 'number'),
    cpuPct: num(c?.workerStats?.cpuUsage),
  }));
  const hostCluster = new Map<number, VmeCluster>();
  for (const c of clusters) {
    if (/kubernetes|docker|k8s/i.test(c.type)) continue;
    for (const id of c.hostIds) hostCluster.set(id, c);
  }
  const clusterHostIds = new Set(hostCluster.keys());

  const hosts: VmeHost[] = [];
  const vms: VmeVm[] = [];
  for (const s of servers) {
    const st = s?.stats || {};
    const base = {
      id: s.id,
      name: str(s.name),
      status: str(s.status) || 'unknown',
      power: str(s.powerState) || 'unknown',
      cores: num(s.maxCores),
      cpuPct: num(st.cpuUsage),
      memTotal: num(st.maxMemory) ?? num(s.maxMemory),
      memUsed: num(st.usedMemory),
      storageTotal: num(st.maxStorage) ?? num(s.maxStorage),
      storageUsed: num(st.usedStorage),
      os: s?.serverOs?.name || s?.osType || undefined,
      cloud: s?.zone?.name || s?.cloud?.name,
    };
    if (isHost(s, parentIds, clusterHostIds)) {
      const c = hostCluster.get(s.id);
      hosts.push({ ...base, clusterId: c?.id, cluster: c?.name, ip: ipsOf(s)[0], agentLastSeen: s.lastAgentUpdate || undefined, vmIds: [] });
    } else {
      vms.push({
        ...base,
        hostname: s.hostname || undefined,
        hostId: s?.parentServer?.id,
        host: s?.parentServer?.name,
        gpus: num(s.maxGpus),
        ips: ipsOf(s),
        plan: s?.plan?.name,
      });
    }
  }

  // Instances name the workload; servers carry the placement. Join by server id.
  const instByServer = new Map<number, any>();
  for (const i of raw.instances || []) for (const sid of i?.servers || []) instByServer.set(sid, i);
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  for (const v of vms) {
    const i = instByServer.get(v.id);
    if (i) {
      v.instanceId = i.id;
      v.instance = str(i.name);
      v.plan = v.plan || i?.plan?.name;
      for (const c of i?.connectionInfo || []) if (c?.ip && !v.ips.includes(c.ip)) v.ips.push(c.ip);
    }
    const h = v.hostId !== undefined ? hostById.get(v.hostId) : undefined;
    if (h) {
      h.vmIds.push(v.id);
      v.host = h.name;
      v.clusterId = h.clusterId;
      v.cluster = h.cluster;
    }
  }

  const datastores: VmeDatastore[] = (raw.datastores || []).map((d) => {
    const total = num(d.storageSize);
    const free = num(d.freeSpace);
    return {
      id: d.id,
      name: str(d.name),
      type: str(d?.datastoreType?.name || d.type),
      total, free,
      active: d.active !== false,
      online: d.online !== false,
      clusterId: d.refType === 'ComputeServerGroup' ? d.refId : undefined,
      cloud: d?.zone?.name,
    };
  });

  const networks: VmeNetwork[] = (raw.networks || []).map((n) => ({
    id: n.id,
    name: str(n.displayName || n.name),
    type: str(n?.type?.name || n?.type?.code),
    cidr: n.cidr || undefined,
    vlan: num(n.vlanId),
    gateway: n.gateway || undefined,
    active: n.active !== false,
    cloud: n?.zone?.name || n?.cloud?.name,
  }));

  const alarms: VmeAlarm[] = (raw.alarms || []).map((a) => {
    const sev = lower(a.severity || a.level || a.status);
    return {
      id: a.id,
      name: str(a.name || a.message),
      severity: /crit|error|fail|down|emergency/.test(sev) ? 'critical' : /warn/.test(sev) ? 'warning' : 'info',
      status: str(a.status) || 'open',
      acknowledged: !!(a.acknowledged ?? a.acknowledgedDate),
      resource: a.refName || a.resourceName || a?.ref?.name,
      refType: a.refType,
      refId: num(a.refId) ?? undefined,
      started: a.startDate || a.dateCreated,
    };
  });

  const activity: VmeActivity[] = (raw.activity || []).map((a, i) => ({
    id: str(a._id || a.id || i),
    at: str(a.ts || a.dateCreated),
    type: str(a.activityType),
    name: str(a.name),
    message: str(a.message),
    user: a.userName || a?.user?.username || (typeof a.user === 'string' ? a.user : undefined),
    objectType: a.objectType || undefined,
    objectId: num(a.objectId) ?? undefined,
    success: a.success !== false,
  })).sort((a, b) => b.at.localeCompare(a.at));

  const w = raw.whoami || {};
  return {
    connection,
    manager: {
      user: w?.user?.username,
      version: w?.appliance?.buildVersion || w?.buildVersion,
      appliance: w?.appliance?.url || w?.appliance?.name,
    },
    clusters, hosts, vms, datastores, networks, alarms, activity,
  };
}

// ---------------------------------------------------------------------------
// Join to Kubernetes
// ---------------------------------------------------------------------------

const short = (n?: string) => lower(n).split('.')[0];

/** Parse `kubectl get nodes -o json` + a newline list of pod nodeNames. */
export function k8sNodesFrom(nodesJson: any, podNodeNames = ''): K8sNodeInfo[] {
  const pods = new Map<string, number>();
  for (const n of podNodeNames.split('\n').map((x) => x.trim()).filter(Boolean)) pods.set(n, (pods.get(n) || 0) + 1);
  return (nodesJson?.items || []).map((n: any) => {
    const labels = n?.metadata?.labels || {};
    return {
      name: n?.metadata?.name,
      addresses: (n?.status?.addresses || []).map((a: any) => a?.address).filter(Boolean),
      ready: (n?.status?.conditions || []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
      roles: Object.keys(labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]),
      gpus: Number(n?.status?.capacity?.['nvidia.com/gpu'] || 0) || 0,
      pods: pods.get(n?.metadata?.name) || 0,
    };
  });
}

/**
 * Mark each VM with the Kubernetes node it is. IP match first (exact), then
 * name/hostname (short names, case-insensitive). Returns the nodes no VM claims.
 */
export function joinKubernetes(vms: VmeVm[], nodes: K8sNodeInfo[]): string[] {
  const unmatched: string[] = [];
  for (const n of nodes) {
    const addr = new Set(n.addresses);
    const byIp = vms.find((v) => v.ips.some((ip) => addr.has(ip)));
    const byName = byIp || vms.find((v) => [v.name, v.hostname, v.instance].some((x) => x && (short(x) === short(n.name) || n.addresses.some((a) => short(a) === short(x)))));
    if (byName) byName.k8sNode = n.name;
    else unmatched.push(n.name);
  }
  return unmatched;
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'warning' | 'info';

export interface VmeFinding {
  id: string;
  severity: Severity;
  area: 'host' | 'vm' | 'storage' | 'capacity' | 'alarm' | 'kubernetes' | 'change' | 'manager';
  title: string;
  detail: string;
  subject?: { kind: 'cluster' | 'host' | 'vm' | 'datastore' | 'k8s'; id: number | string; name: string };
}

const pctOf = (used: number | null, total: number | null) => (used !== null && total ? (used / total) * 100 : null);
const GiB = 1024 ** 3;
export const gib = (b: number | null | undefined) => (b === null || b === undefined ? '—' : `${(b / GiB).toFixed(b >= 100 * GiB ? 0 : 1)} GiB`);
const STALE_AGENT_MS = 15 * 60_000;

const isOn = (p: string) => /^(on|running|poweredon)$/i.test(p);
const isOff = (p: string) => /^(off|stopped|poweredoff|suspended)$/i.test(p);
const isBad = (s: string) => /fail|error|down|offline|denied|unknown/i.test(s);

export function vmeFindings(s: Pick<VmeSnapshot, 'hosts' | 'vms' | 'datastores' | 'alarms' | 'activity' | 'clusters' | 'k8s'>, now = Date.now()): VmeFinding[] {
  const out: VmeFinding[] = [];
  const hostById = new Map(s.hosts.map((h) => [h.id, h]));
  const hot = new Set<number>();

  for (const h of s.hosts) {
    const subject = { kind: 'host' as const, id: h.id, name: h.name };
    if (isOff(h.power) || /down|offline|fail/i.test(h.status)) {
      out.push({ id: `host-down:${h.id}`, severity: 'critical', area: 'host', subject, title: `Host ${h.name} is ${isOff(h.power) ? 'powered off' : h.status}`,
        detail: `${h.vmIds.length} VM${h.vmIds.length === 1 ? '' : 's'} placed on it${h.cluster ? ` in cluster ${h.cluster}` : ''}.` });
      continue;
    }
    if (h.agentLastSeen && now - Date.parse(h.agentLastSeen) > STALE_AGENT_MS) {
      const mins = Math.round((now - Date.parse(h.agentLastSeen)) / 60_000);
      out.push({ id: `host-agent:${h.id}`, severity: 'warning', area: 'host', subject, title: `No agent update from ${h.name} for ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}`,
        detail: 'The Manager has stopped hearing from this host — its stats below are stale. Check the VME agent service and the management network.' });
    }
    const mem = pctOf(h.memUsed, h.memTotal);
    if (mem !== null && mem >= 90) {
      hot.add(h.id);
      out.push({ id: `host-mem:${h.id}`, severity: mem >= 95 ? 'critical' : 'warning', area: 'host', subject, title: `Host ${h.name} memory at ${Math.round(mem)}%`,
        detail: `${gib(h.memUsed)} of ${gib(h.memTotal)}. VMs here will balloon or swap; live-migrate one, or stop placing new VMs here.` });
    }
    if (h.cpuPct !== null && h.cpuPct >= 90) {
      hot.add(h.id);
      out.push({ id: `host-cpu:${h.id}`, severity: h.cpuPct >= 97 ? 'critical' : 'warning', area: 'host', subject, title: `Host ${h.name} CPU at ${Math.round(h.cpuPct)}%`,
        detail: 'Every VM on it waits for CPU (steal time). Latency-sensitive VMs, like Kubernetes nodes, feel it first.' });
    }
    const disk = pctOf(h.storageUsed, h.storageTotal);
    if (disk !== null && disk >= 90) {
      out.push({ id: `host-disk:${h.id}`, severity: disk >= 95 ? 'critical' : 'warning', area: 'host', subject, title: `Host ${h.name} local storage at ${Math.round(disk)}%`, detail: `${gib(h.storageUsed)} of ${gib(h.storageTotal)}.` });
    }
    // Overcommit: what the VMs were promised versus what the host has.
    const vmsHere = s.vms.filter((v) => v.hostId === h.id && !isOff(v.power));
    const promisedMem = vmsHere.reduce((a, v) => a + (v.memTotal || 0), 0);
    const promisedCpu = vmsHere.reduce((a, v) => a + (v.cores || 0), 0);
    if (h.memTotal && promisedMem / h.memTotal > 1.5) {
      out.push({ id: `host-overcommit-mem:${h.id}`, severity: 'warning', area: 'capacity', subject, title: `Host ${h.name} memory overcommitted ${(promisedMem / h.memTotal).toFixed(1)}×`,
        detail: `Running VMs are allotted ${gib(promisedMem)} on a ${gib(h.memTotal)} host. Fine while they idle; a simultaneous peak means swapping.` });
    }
    if (h.cores && promisedCpu / h.cores > 4) {
      out.push({ id: `host-overcommit-cpu:${h.id}`, severity: 'info', area: 'capacity', subject, title: `Host ${h.name} has ${promisedCpu} vCPUs on ${h.cores} cores (${(promisedCpu / h.cores).toFixed(1)}:1)`,
        detail: 'High vCPU ratios show up as CPU-ready / steal time inside the VMs.' });
    }
  }

  const k8sByName = new Map((s.k8s?.nodes || []).map((n) => [n.name, n]));
  for (const v of s.vms) {
    const subject = { kind: 'vm' as const, id: v.id, name: v.name };
    const node = v.k8sNode ? k8sByName.get(v.k8sNode) : undefined;
    if (v.k8sNode && isOff(v.power)) {
      out.push({ id: `k8s-vm-off:${v.id}`, severity: 'critical', area: 'kubernetes', subject, title: `Kubernetes node ${v.k8sNode} — its VM ${v.name} is powered off`,
        detail: `${node?.pods ?? 0} pod(s) were scheduled there. The node will go NotReady and its pods are evicted after the toleration timeout.` });
    } else if (isBad(v.status) && !/unknown/i.test(v.status)) {
      out.push({ id: `vm-status:${v.id}`, severity: 'warning', area: 'vm', subject, title: `VM ${v.name} is in state "${v.status}"`, detail: v.host ? `On host ${v.host}.` : 'Host unknown.' });
    }
    if (v.k8sNode && v.hostId !== undefined && hot.has(v.hostId)) {
      const h = hostById.get(v.hostId)!;
      out.push({ id: `k8s-hot-host:${v.id}`, severity: 'warning', area: 'kubernetes', subject, title: `Kubernetes node ${v.k8sNode} runs on a saturated host (${h.name})`,
        detail: `Host memory ${Math.round(pctOf(h.memUsed, h.memTotal) ?? 0)}%, CPU ${Math.round(h.cpuPct ?? 0)}%. Slowness in its ${node?.pods ?? 0} pod(s) may be the host, not the workload.` });
    }
    if (node && !node.ready && isOn(v.power)) {
      out.push({ id: `k8s-notready:${v.id}`, severity: 'warning', area: 'kubernetes', subject, title: `Kubernetes node ${node.name} is NotReady although its VM is on`,
        detail: 'The VM is up, so look inside it: kubelet, container runtime, disk pressure or the network to the API server.' });
    }
  }

  // Two Kubernetes control-plane / worker VMs on one host is a single point of failure.
  const k8sPerHost = new Map<number, VmeVm[]>();
  for (const v of s.vms) if (v.k8sNode && v.hostId !== undefined) k8sPerHost.set(v.hostId, [...(k8sPerHost.get(v.hostId) || []), v]);
  for (const [hid, list] of k8sPerHost) {
    const cps = list.filter((v) => (k8sByName.get(v.k8sNode!)?.roles || []).some((r) => /control-plane|master/.test(r)));
    if (cps.length >= 2) {
      const h = hostById.get(hid);
      out.push({ id: `k8s-cp-colocated:${hid}`, severity: 'warning', area: 'kubernetes', subject: { kind: 'host', id: hid, name: h?.name || String(hid) },
        title: `${cps.length} Kubernetes control-plane nodes share host ${h?.name || hid}`,
        detail: `${cps.map((v) => v.k8sNode).join(', ')} — losing this one host loses etcd quorum. Add an anti-affinity rule so they spread across hosts.` });
    }
  }

  for (const d of s.datastores) {
    const subject = { kind: 'datastore' as const, id: d.id, name: d.name };
    if (!d.online || !d.active) {
      out.push({ id: `ds-offline:${d.id}`, severity: 'critical', area: 'storage', subject, title: `Datastore ${d.name} is ${!d.online ? 'offline' : 'inactive'}`, detail: 'VMs with disks here cannot read or write them.' });
      continue;
    }
    if (d.total && d.free !== null) {
      const used = ((d.total - d.free) / d.total) * 100;
      if (used >= 85) {
        out.push({ id: `ds-full:${d.id}`, severity: used >= 95 ? 'critical' : 'warning', area: 'storage', subject, title: `Datastore ${d.name} is ${Math.round(used)}% full`,
          detail: `${gib(d.free)} free of ${gib(d.total)}. Thin-provisioned disks and snapshots keep growing; at 100% VMs pause on write.` });
      }
    }
  }

  for (const a of s.alarms) {
    if (a.acknowledged) continue;
    out.push({ id: `alarm:${a.id}`, severity: a.severity, area: 'alarm', title: `Alarm: ${a.name}`, detail: `${a.resource ? `${a.resource} · ` : ''}${a.status}${a.started ? ` since ${a.started.slice(0, 16).replace('T', ' ')}` : ''}` });
  }

  // Changes in the last hour to a VM that is a Kubernetes node: the usual answer to "what changed?".
  const k8sVmIds = new Set(s.vms.filter((v) => v.k8sNode).map((v) => v.id));
  const instToVm = new Map(s.vms.filter((v) => v.instanceId !== undefined).map((v) => [v.instanceId!, v]));
  for (const e of s.activity) {
    if (!e.at || now - Date.parse(e.at) > 3600_000) continue;
    const vm = e.objectType === 'Instance' && e.objectId !== undefined ? instToVm.get(e.objectId)
      : e.objectId !== undefined && k8sVmIds.has(e.objectId) ? s.vms.find((v) => v.id === e.objectId) : undefined;
    if (!vm?.k8sNode) continue;
    out.push({ id: `change:${e.id}`, severity: e.success ? 'info' : 'warning', area: 'change', subject: { kind: 'vm', id: vm.id, name: vm.name },
      title: `${e.name || e.type} on ${vm.name} (Kubernetes node ${vm.k8sNode}) ${Math.round((now - Date.parse(e.at)) / 60_000)} min ago`,
      detail: `${e.message}${e.user ? ` — by ${e.user}` : ''}` });
  }

  for (const n of s.k8s?.unmatched || []) {
    out.push({ id: `k8s-unmatched:${n}`, severity: 'info', area: 'kubernetes', subject: { kind: 'k8s', id: n, name: n }, title: `Kubernetes node ${n} matches no VME VM`,
      detail: 'Either it runs elsewhere (bare metal, another hypervisor) or its IP/name differs from the VM record.' });
  }

  // N+1: can each hypervisor cluster lose its biggest host?
  for (const c of capacity(s)) {
    if (c.hosts >= 2 && !c.survivesHostLoss) {
      out.push({ id: `nplus1:${c.id}`, severity: 'warning', area: 'capacity', subject: { kind: 'cluster', id: c.id, name: c.name },
        title: `Cluster ${c.name} cannot absorb the loss of one host`,
        detail: `Losing ${c.biggestHost} would leave ${gib(c.memFreeAfterLoss)} for ${gib(c.memOnBiggest)} of running VMs. HA restarts would fail for some of them.` });
    }
  }

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface ClusterCapacity {
  id: number | string;
  name: string;
  hosts: number;
  vms: number;
  cores: number;
  vcpus: number;
  memTotal: number;
  memUsed: number;
  memAllocated: number;
  storageTotal: number;
  storageUsed: number;
  /** Largest free memory on any single host — the biggest VM that still fits. */
  largestFit: number;
  biggestHost?: string;
  memOnBiggest: number;
  memFreeAfterLoss: number;
  survivesHostLoss: boolean;
}

export function capacity(s: Pick<VmeSnapshot, 'hosts' | 'vms' | 'clusters'>): ClusterCapacity[] {
  const groups = new Map<string, { id: number | string; name: string; hosts: VmeHost[] }>();
  for (const h of s.hosts) {
    const key = h.clusterId !== undefined ? String(h.clusterId) : 'unclustered';
    const g = groups.get(key) || { id: h.clusterId ?? 'unclustered', name: h.cluster || 'Not in a cluster', hosts: [] };
    g.hosts.push(h);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const up = g.hosts.filter((h) => !isOff(h.power));
    const vmsOn = s.vms.filter((v) => g.hosts.some((h) => h.id === v.hostId) && !isOff(v.power));
    const memUsedOf = (h: VmeHost) => h.memUsed ?? 0;
    const memTotal = up.reduce((a, h) => a + (h.memTotal || 0), 0);
    const memUsed = up.reduce((a, h) => a + memUsedOf(h), 0);
    const biggest = [...up].sort((a, b) => memUsedOf(b) - memUsedOf(a))[0];
    const freeAfter = up.filter((h) => h !== biggest).reduce((a, h) => a + Math.max(0, (h.memTotal || 0) - memUsedOf(h)), 0);
    const onBiggest = biggest ? memUsedOf(biggest) : 0;
    return {
      id: g.id,
      name: g.name,
      hosts: g.hosts.length,
      vms: vmsOn.length,
      cores: up.reduce((a, h) => a + (h.cores || 0), 0),
      vcpus: vmsOn.reduce((a, v) => a + (v.cores || 0), 0),
      memTotal, memUsed,
      memAllocated: vmsOn.reduce((a, v) => a + (v.memTotal || 0), 0),
      storageTotal: up.reduce((a, h) => a + (h.storageTotal || 0), 0),
      storageUsed: up.reduce((a, h) => a + (h.storageUsed || 0), 0),
      largestFit: Math.max(0, ...up.map((h) => (h.memTotal || 0) - memUsedOf(h))),
      biggestHost: biggest?.name,
      memOnBiggest: onBiggest,
      memFreeAfterLoss: freeAfter,
      survivesHostLoss: up.length < 2 ? false : freeAfter >= onBiggest,
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

export type TopoKind = 'manager' | 'cluster' | 'host' | 'vm' | 'k8s' | 'datastore';
export interface TopoNode {
  id: string;
  kind: TopoKind;
  label: string;
  sub?: string;
  level: 'ok' | 'warning' | 'critical' | 'off' | 'unknown';
  /** Metric bars for host/vm cards, 0–100. */
  cpu?: number | null;
  mem?: number | null;
  parent?: string;
}
export interface TopoEdge { from: string; to: string; kind: 'contains' | 'runs' | 'is' | 'storage' }

/**
 * The layered picture: Manager → cluster → host → VM → Kubernetes node, with
 * datastores hanging off their cluster. Health levels come from the findings,
 * so the map and the lists can never disagree.
 */
export function topology(s: VmeSnapshot, findings: VmeFinding[]): { nodes: TopoNode[]; edges: TopoEdge[] } {
  const worst = new Map<string, TopoNode['level']>();
  const bump = (key: string, sev: Severity) => {
    const lv = sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : undefined;
    if (!lv) return;
    if (worst.get(key) !== 'critical') worst.set(key, lv);
  };
  for (const f of findings) if (f.subject) bump(`${f.subject.kind}:${f.subject.id}`, f.severity);

  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const mgr = 'manager';
  nodes.push({ id: mgr, kind: 'manager', label: s.manager?.appliance || s.connection, sub: s.manager?.version ? `VME ${s.manager.version}` : 'VME Manager', level: 'ok' });

  const clusterIds = new Set<string>();
  for (const h of s.hosts) {
    const cid = h.clusterId !== undefined ? `cluster:${h.clusterId}` : 'cluster:none';
    if (!clusterIds.has(cid)) {
      clusterIds.add(cid);
      const c = s.clusters.find((x) => x.id === h.clusterId);
      nodes.push({ id: cid, kind: 'cluster', label: h.cluster || 'Not in a cluster', sub: c?.type || undefined, level: worst.get(cid) || (c && isBad(c.status) ? 'warning' : 'ok') });
      edges.push({ from: mgr, to: cid, kind: 'contains' });
    }
    const hid = `host:${h.id}`;
    nodes.push({
      id: hid, kind: 'host', label: h.name, sub: `${h.vmIds.length} VM${h.vmIds.length === 1 ? '' : 's'}${h.ip ? ` · ${h.ip}` : ''}`,
      level: isOff(h.power) ? 'off' : worst.get(hid) || 'ok', cpu: h.cpuPct, mem: pctOf(h.memUsed, h.memTotal), parent: cid,
    });
    edges.push({ from: cid, to: hid, kind: 'contains' });
  }
  for (const v of s.vms) {
    const vid = `vm:${v.id}`;
    const parent = v.hostId !== undefined && s.hosts.some((h) => h.id === v.hostId) ? `host:${v.hostId}` : mgr;
    nodes.push({
      id: vid, kind: 'vm', label: v.name, sub: [v.cores ? `${v.cores} vCPU` : '', v.memTotal ? gib(v.memTotal) : '', v.gpus ? `${v.gpus} GPU` : ''].filter(Boolean).join(' · '),
      level: isOff(v.power) ? 'off' : worst.get(vid) || 'ok', cpu: v.cpuPct, mem: pctOf(v.memUsed, v.memTotal), parent,
    });
    edges.push({ from: parent, to: vid, kind: 'runs' });
    if (v.k8sNode) {
      const n = s.k8s?.nodes.find((x) => x.name === v.k8sNode);
      const kid = `k8s:${v.k8sNode}`;
      nodes.push({ id: kid, kind: 'k8s', label: v.k8sNode, sub: n ? `${n.roles.join(',') || 'worker'} · ${n.pods} pods${n.gpus ? ` · ${n.gpus} GPU` : ''}` : undefined,
        level: n && !n.ready ? 'critical' : worst.get(kid) || 'ok', parent: vid });
      edges.push({ from: vid, to: kid, kind: 'is' });
    }
  }
  for (const d of s.datastores) {
    const did = `datastore:${d.id}`;
    const cid = d.clusterId !== undefined && clusterIds.has(`cluster:${d.clusterId}`) ? `cluster:${d.clusterId}` : mgr;
    const used = d.total && d.free !== null ? ((d.total - d.free) / d.total) * 100 : null;
    nodes.push({ id: did, kind: 'datastore', label: d.name, sub: `${d.type}${d.total ? ` · ${gib(d.total)}` : ''}`, level: worst.get(did) || (d.online ? 'ok' : 'critical'), mem: used, parent: cid });
    edges.push({ from: cid, to: did, kind: 'storage' });
  }
  return { nodes, edges };
}
