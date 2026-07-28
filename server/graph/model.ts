// The infrastructure graph — Kalam's shared model of "what depends on what".
//
// Until now Kalam *drew* graphs (TopologyGraph, VmTopology) but never *reasoned*
// over one: each view built its own nodes/edges in the browser, and the backend
// had no idea that a failing SPIRE agent is why six unrelated pods on the same
// node cannot start. This module is the single typed model both views and the
// diagnosis engine can share.
//
// EDGE DIRECTION IS THE WHOLE CONTRACT:
//
//     from --kind--> to    means    "`to` depends on `from`"
//
// so failure flows FORWARD along the arrow. A node hosts a pod, therefore
// `k8sNode --hosts--> pod`: when the node dies, the pod dies. Everything in
// analyze.ts follows from this one rule — blast radius is the set reachable
// forward from a node, and a root cause is a failure with no failed ancestor.

import type { ComponentInfo } from '../pcai/components.js';

export type NodeKind =
  | 'vm'         // an inventory VM Kalam can SSH into
  | 'k8sNode'    // a Kubernetes node object
  | 'pod'
  | 'workload'   // Deployment / DaemonSet / StatefulSet / Job (pod owner)
  | 'service'
  | 'pvc'
  | 'container'  // plain Docker/containerd container (no pod)
  | 'unit'       // systemd unit
  | 'port';      // a listening host port

export type EdgeKind =
  | 'hosts'    // machine hosts workload:   vm -> k8sNode -> pod
  | 'via'      // SSH jump path:            jumpHost -> vm
  | 'member'   // pod backs an aggregate:   pod -> service | pod -> workload
  | 'mounts'   // storage feeds a pod:      pvc -> pod
  | 'binds'    // process owns a port:      pod|container|unit -> port
  | 'requires'; // platform dependency:     spire-agent -> every pod on its node

export type Health = 'healthy' | 'degraded' | 'failed' | 'unknown';

export interface GraphNode {
  id: string;              // stable, kind-prefixed: "pod:ezmeral/spire-agent-x9k2"
  kind: NodeKind;
  name: string;
  namespace?: string;
  health: Health;
  reason?: string;         // CrashLoopBackOff, NotReady, Unreachable, ...
  /** Catalog knowledge (what it is / why it runs here / what breaks) if matched. */
  component?: ComponentInfo;
  /** True for platform pieces other workloads depend on (see deps.ts). */
  platform?: boolean;
  meta: Record<string, string | number | boolean | undefined>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Human reason this edge exists — shown when explaining a dependency path. */
  note?: string;
}

export interface InfraGraph {
  source: string;    // VM name the graph was built from
  builtAt: string;   // ISO timestamp
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const HEALTH_RANK: Record<Health, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  failed: 3,
};

export function isBroken(h: Health): boolean {
  return h === 'failed' || h === 'degraded';
}

/** Compose a stable node id. Ids are the only thing edges ever reference. */
export function nodeId(kind: NodeKind, name: string, namespace?: string): string {
  return namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`;
}

// ---------------------------------------------------------------------------
// Builder — accumulates nodes/edges while tolerating duplicates and dangling
// references, because the inputs are best-effort SSH output from a live cluster.
// ---------------------------------------------------------------------------

export class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  constructor(private source: string) {}

  /**
   * Add a node, or merge into an existing one. Merging keeps the WORSE health
   * (a pod seen healthy by one probe and failing in another is failing) and
   * fills in any field the earlier sighting left blank.
   */
  node(n: Omit<GraphNode, 'meta'> & { meta?: GraphNode['meta'] }): GraphNode {
    const existing = this.nodes.get(n.id);
    if (!existing) {
      const created: GraphNode = { ...n, meta: n.meta ?? {} };
      this.nodes.set(n.id, created);
      return created;
    }
    if (HEALTH_RANK[n.health] > HEALTH_RANK[existing.health]) {
      existing.health = n.health;
      existing.reason = n.reason ?? existing.reason;
    }
    existing.component ??= n.component;
    existing.namespace ??= n.namespace;
    existing.platform ||= n.platform;
    Object.assign(existing.meta, n.meta ?? {});
    return existing;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  get(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Ids of every node of a kind — used to fan platform dependencies out. */
  idsOfKind(kind: NodeKind): string[] {
    return [...this.nodes.values()].filter((n) => n.kind === kind).map((n) => n.id);
  }

  /** Live views for post-processing passes (health roll-up); not copies. */
  allNodes(): IterableIterator<GraphNode> {
    return this.nodes.values();
  }

  allEdges(): IterableIterator<GraphEdge> {
    return this.edges.values();
  }

  /**
   * Add an edge. Silently ignored when either endpoint is unknown or when it
   * would be a self-loop, so callers never have to pre-check the other side.
   */
  edge(from: string, to: string, kind: EdgeKind, note?: string): void {
    if (from === to) return;
    if (!this.nodes.has(from) || !this.nodes.has(to)) return;
    const key = `${from}|${to}|${kind}`;
    if (!this.edges.has(key)) this.edges.set(key, { from, to, kind, note });
  }

  build(): InfraGraph {
    return {
      source: this.source,
      builtAt: new Date().toISOString(),
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }
}

// ---------------------------------------------------------------------------
// Adjacency — built once per query instead of scanning edges repeatedly.
// ---------------------------------------------------------------------------

export interface Adjacency {
  byId: Map<string, GraphNode>;
  /** id -> nodes that depend on it (follow the arrow). */
  out: Map<string, GraphEdge[]>;
  /** id -> nodes it depends on (against the arrow). */
  in: Map<string, GraphEdge[]>;
}

export function index(graph: InfraGraph): Adjacency {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  const push = (m: Map<string, GraphEdge[]>, key: string, e: GraphEdge) => {
    const list = m.get(key);
    if (list) list.push(e);
    else m.set(key, [e]);
  };
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    push(out, e.from, e);
    push(inn, e.to, e);
  }
  return { byId, out, in: inn };
}
