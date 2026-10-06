// Shapes of /api/vme/snapshot (server/vme/model.ts), as the page uses them.

export type VmeSub = 'overview' | 'topology' | 'hosts' | 'vms' | 'storage' | 'networks' | 'events' | 'capacity' | 'connections';

export const VME_SUBPAGES: Array<{ id: VmeSub; label: string; hint: string }> = [
  { id: 'overview', label: 'Overview', hint: 'Headline numbers and everything that needs attention' },
  { id: 'topology', label: 'Topology', hint: 'Manager → clusters → hosts → VMs → Kubernetes nodes, with datastores' },
  { id: 'hosts', label: 'Hosts', hint: 'Hypervisor hosts: load, memory, storage, VMs placed' },
  { id: 'vms', label: 'Virtual Machines', hint: 'Every VM, its host, power, size, IPs and the Kubernetes node it is' },
  { id: 'storage', label: 'Storage', hint: 'Datastores: capacity, free space, state' },
  { id: 'networks', label: 'Networks', hint: 'Networks / VLANs the Manager knows' },
  { id: 'events', label: 'Alarms & Activity', hint: 'Open alarms and the last 24 h of changes' },
  { id: 'capacity', label: 'Capacity', hint: 'Per cluster: free CPU, memory, storage, and whether it survives losing a host' },
  { id: 'connections', label: 'Connections', hint: 'VME Managers Trinetra reads from' },
];

export type Severity = 'critical' | 'warning' | 'info';

export interface Cluster { id: number; name: string; type: string; status: string; cloud?: string; hostIds: number[]; cpuPct: number | null }
export interface Host {
  id: number; name: string; clusterId?: number; cluster?: string; cloud?: string; ip?: string; status: string; power: string;
  cores: number | null; cpuPct: number | null; memTotal: number | null; memUsed: number | null; storageTotal: number | null; storageUsed: number | null;
  agentLastSeen?: string; os?: string; vmIds: number[];
}
export interface Vm {
  id: number; name: string; hostname?: string; hostId?: number; host?: string; clusterId?: number; cluster?: string; status: string; power: string;
  cores: number | null; cpuPct: number | null; memTotal: number | null; memUsed: number | null; storageTotal: number | null; storageUsed: number | null;
  gpus: number | null; ips: string[]; os?: string; plan?: string; instanceId?: number; instance?: string; k8sNode?: string;
}
export interface Datastore { id: number; name: string; type: string; total: number | null; free: number | null; active: boolean; online: boolean; clusterId?: number; cloud?: string }
export interface Network { id: number; name: string; type: string; cidr?: string; vlan?: number | null; gateway?: string; active: boolean; cloud?: string }
export interface Alarm { id: number; name: string; severity: Severity; status: string; acknowledged: boolean; resource?: string; refType?: string; started?: string }
export interface Activity { id: string; at: string; type: string; name: string; message: string; user?: string; objectType?: string; objectId?: number; success: boolean }
export interface K8sNode { name: string; addresses: string[]; ready: boolean; roles: string[]; gpus: number; pods: number }

export interface Finding {
  id: string; severity: Severity; area: string; title: string; detail: string;
  subject?: { kind: 'cluster' | 'host' | 'vm' | 'datastore' | 'k8s'; id: number | string; name: string };
}
export interface Capacity {
  id: number | string; name: string; hosts: number; vms: number; cores: number; vcpus: number; memTotal: number; memUsed: number; memAllocated: number;
  storageTotal: number; storageUsed: number; largestFit: number; biggestHost?: string; memOnBiggest: number; memFreeAfterLoss: number; survivesHostLoss: boolean;
}
export interface TopoNode { id: string; kind: 'manager' | 'cluster' | 'host' | 'vm' | 'k8s' | 'datastore'; label: string; sub?: string; level: 'ok' | 'warning' | 'critical' | 'off' | 'unknown'; cpu?: number | null; mem?: number | null; parent?: string }
export interface TopoEdge { from: string; to: string; kind: 'contains' | 'runs' | 'is' | 'storage' }

export interface VmeView {
  snapshot: {
    connection: string; demo?: boolean; at: string; manager?: { user?: string; version?: string; appliance?: string };
    clusters: Cluster[]; hosts: Host[]; vms: Vm[]; datastores: Datastore[]; networks: Network[]; alarms: Alarm[]; activity: Activity[];
    k8s?: { source: string; nodes: K8sNode[]; unmatched: string[]; error?: string };
    sources: Record<string, { ok: boolean; count?: number; error?: string }>;
  };
  findings: Finding[];
  capacity: Capacity[];
  topology: { nodes: TopoNode[]; edges: TopoEdge[] };
  insecureTls?: boolean;
  cached?: boolean;
  error?: string;
}

const GiB = 1024 ** 3;
export const gib = (b: number | null | undefined) => (b === null || b === undefined ? '—' : b >= 1024 * GiB ? `${(b / 1024 / GiB).toFixed(1)} TiB` : `${(b / GiB).toFixed(b >= 100 * GiB ? 0 : 1)} GiB`);
export const pct = (used: number | null | undefined, total: number | null | undefined) => (used !== null && used !== undefined && total ? (used / total) * 100 : null);
export const pctColor = (p: number | null | undefined) =>
  p === null || p === undefined ? 'var(--text-muted)' : p >= 90 ? 'var(--status-error)' : p >= 75 ? 'var(--status-warning)' : 'var(--status-success)';
export const sevColor = (s: Severity | 'ok' | 'off' | 'unknown') =>
  s === 'critical' ? 'var(--status-error)' : s === 'warning' ? 'var(--status-warning)' : s === 'ok' ? 'var(--status-success)' : 'var(--text-muted)';
export const isOff = (p: string) => /^(off|stopped|poweredoff|suspended)$/i.test(p);
export const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
