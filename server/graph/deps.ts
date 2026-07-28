// Platform dependency knowledge — the part of the component catalog that was
// only ever prose.
//
// `server/pcai/components.ts` already knows that if the SPIRE agent stops,
// "newly scheduled pods on this node never get an identity and hang or crash at
// startup". A human reads that; nothing consumed it. Here that sentence becomes
// edges: spire-agent gets a `requires` edge to every other pod on its own node,
// so the analysis can say "these 6 CrashLoopBackOffs are downstream of one
// failing SPIRE agent" instead of listing seven equal-looking problems.
//
// Tiers exist to keep the fan-out acyclic and honest:
//
//   tier 0 (cluster)  — the whole cluster depends on it (etcd, apiserver, DNS)
//   tier 1 (node)     — every workload on the SAME node depends on it
//   tier 2 (workload) — ordinary application pods; depend, are not depended on
//
// Edges only ever run from a lower tier to a higher one, so `requires` can never
// form a cycle, and a cluster-critical failure correctly ranks above a
// node-critical one.

export type DepTier = 'cluster' | 'node' | 'workload';

/**
 * Catalog ids whose failure takes the whole cluster with it. Every id must
 * exist in components.ts CATALOG (enforced by the graph tests).
 */
export const CLUSTER_CRITICAL: Record<string, string> = {
  etcd: 'etcd holds all cluster state; when it is unavailable the API server cannot read or write anything.',
  'kube-apiserver': 'Every controller, kubelet and kubectl call goes through the API server.',
  coredns: 'In-cluster DNS: Service names stop resolving, so pods fail to reach their dependencies.',
  'spire-server': 'Agents cannot renew SVIDs anywhere; service-to-service mTLS fails cluster-wide as certificates expire.',
  'cert-manager': 'TLS certificates stop being issued or renewed cluster-wide.',
};

/**
 * Catalog ids whose failure breaks only the workloads sharing their node — the
 * DaemonSet tier. These are the ones that produce confusing diagnoses, because
 * the symptom shows up in unrelated application pods.
 */
export const NODE_CRITICAL: Record<string, string> = {
  kubelet: 'kubelet runs and reports every pod on this node; without it the node goes NotReady and its pods are not managed.',
  containerd: 'The container runtime on this node — no container can start, stop or restart.',
  'kube-proxy': 'Service ClusterIP routing on this node stops working; pods here cannot reach Services.',
  calico: 'Pod networking on this node: new pods get no network and existing traffic breaks.',
  cilium: 'Pod networking and network policy on this node.',
  'flannel-canal': 'Pod networking on this node.',
  multus: 'Secondary network interfaces on this node fail to attach, so multi-NIC pods stay in ContainerCreating.',
  'spire-agent': 'Workloads on this node cannot obtain or renew a SPIFFE identity, so they fail mTLS or hang at startup.',
  'spiffe-csi': 'Pods on this node cannot mount the SPIRE agent socket and stay in ContainerCreating.',
  'hpe-csi': 'Volumes cannot be attached or mounted on this node; pods needing storage stay in ContainerCreating.',
  'csi-generic': 'Volumes cannot be attached or mounted on this node.',
  'nvidia-device-plugin': 'GPUs on this node stop being advertised, so GPU workloads become unschedulable here.',
};

export function tierOf(componentId: string | undefined): DepTier {
  if (!componentId) return 'workload';
  if (componentId in CLUSTER_CRITICAL) return 'cluster';
  if (componentId in NODE_CRITICAL) return 'node';
  return 'workload';
}

/** The one-line reason a dependency edge exists, for path explanations. */
export function dependencyNote(componentId: string): string {
  return CLUSTER_CRITICAL[componentId] ?? NODE_CRITICAL[componentId] ?? 'Platform dependency.';
}

/**
 * Safety valve: a cluster-critical component depends-on edge to every pod in a
 * very large cluster would bloat the graph without adding insight. Past this
 * many targets the builder records the scope on the node instead of drawing
 * every edge.
 */
export const MAX_FANOUT = 500;
