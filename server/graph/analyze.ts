// Reasoning over the infrastructure graph.
//
// Three questions an operator actually asks, none of which a flat list of
// findings can answer:
//
//   1. "Which of these 14 red things is the ONE I should fix?"  -> rankRootCauses
//   2. "If I restart this, what do I take down?"                -> blastRadius
//   3. "Why does that affect this?"                             -> dependencyPath
//
// All three are graph walks over the edge direction defined in model.ts:
// `from -> to` means failure flows forward, so descendants are casualties and
// ancestors are suspects.

import { index, isBroken, type Adjacency, type GraphEdge, type GraphNode, type InfraGraph } from './model.js';

export interface ImpactedNode {
  id: string;
  kind: GraphNode['kind'];
  name: string;
  namespace?: string;
  health: GraphNode['health'];
  reason?: string;
  /** Hops from the origin — 1 is a direct dependent. */
  distance: number;
}

export interface BlastRadius {
  origin: { id: string; name: string; kind: GraphNode['kind']; namespace?: string; health: GraphNode['health'] };
  impacted: ImpactedNode[];
  /** Impacted counts per node kind, for a one-line summary. */
  byKind: Record<string, number>;
  /** Impacted things that are ALREADY broken — i.e. damage this has done. */
  alreadyBroken: ImpactedNode[];
  /** Impacted things still healthy — i.e. damage stopping it WOULD do. */
  atRisk: ImpactedNode[];
  /** The catalog's prose impact statement, when the origin is a known component. */
  componentImpact?: string;
  summary: string;
}

/**
 * Everything that depends on `id`, directly or transitively, with hop distance.
 * Breadth-first so `distance` is the shortest dependency chain.
 */
export function blastRadius(graph: InfraGraph, id: string, adj: Adjacency = index(graph)): BlastRadius | null {
  const origin = adj.byId.get(id);
  if (!origin) return null;

  const impacted: ImpactedNode[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  let distance = 0;

  while (frontier.length) {
    distance++;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of adj.out.get(cur) || []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const n = adj.byId.get(e.to)!;
        impacted.push({ id: n.id, kind: n.kind, name: n.name, namespace: n.namespace, health: n.health, reason: n.reason, distance });
        next.push(n.id);
      }
    }
    frontier = next;
  }

  const byKind: Record<string, number> = {};
  for (const n of impacted) byKind[n.kind] = (byKind[n.kind] || 0) + 1;

  const alreadyBroken = impacted.filter((n) => n.health === 'failed' || n.health === 'degraded');
  const atRisk = impacted.filter((n) => n.health === 'healthy');

  const kinds = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${c} ${k}${c > 1 ? 's' : ''}`)
    .join(', ');

  const summary = impacted.length === 0
    ? `Nothing depends on ${origin.name}: stopping it affects nothing Kalam can see.`
    : `${origin.name} is depended on by ${impacted.length} thing(s) — ${kinds}. ` +
      `${alreadyBroken.length} of them are already unhealthy; ${atRisk.length} are healthy and would be at risk.`;

  return {
    origin: { id: origin.id, name: origin.name, kind: origin.kind, namespace: origin.namespace, health: origin.health },
    impacted,
    byKind,
    alreadyBroken,
    atRisk,
    componentImpact: origin.component?.impact,
    summary,
  };
}

export interface RootCause {
  id: string;
  kind: GraphNode['kind'];
  name: string;
  namespace?: string;
  health: GraphNode['health'];
  reason?: string;
  /** Broken things downstream that this failure explains. */
  explains: string[];
  /** Healthy things downstream that are one failure away. */
  atRisk: number;
  /** Ranking score — higher is more likely to be the thing worth fixing first. */
  score: number;
  confidence: 'high' | 'medium' | 'low';
  /** Plain-English statement of why this is the root cause. */
  explanation: string;
  component?: { id: string; title: string; impact: string };
}

export interface CausalAnalysis {
  rootCauses: RootCause[];
  /** brokenId -> id of the root cause that explains it (nearest broken ancestor). */
  collateral: Record<string, string>;
  brokenCount: number;
  summary: string;
}

/**
 * Separate causes from casualties.
 *
 * A broken node is a ROOT CAUSE when nothing it depends on is also broken —
 * i.e. it has no broken ancestor. Everything else is collateral, attributed to
 * the nearest broken ancestor. Causes are then ranked by how much breakage they
 * explain, so "one SPIRE agent down" outranks "six pods CrashLoopBackOff".
 */
export function analyzeCauses(graph: InfraGraph, limit = 10): CausalAnalysis {
  const adj = index(graph);
  const broken = graph.nodes.filter((n) => isBroken(n.health));
  const brokenIds = new Set(broken.map((n) => n.id));

  const collateral: Record<string, string> = {};
  const roots: GraphNode[] = [];

  for (const n of broken) {
    const culprit = nearestBrokenAncestor(adj, n.id, brokenIds);
    if (culprit) collateral[n.id] = culprit;
    else roots.push(n);
  }

  const causes: RootCause[] = roots.map((n) => {
    const radius = blastRadius(graph, n.id, adj)!;
    const explains = radius.alreadyBroken.map((i) => i.id);
    const tier = String(n.meta.tier || 'workload');
    // Explained breakage dominates; platform tier breaks ties (a cluster-wide
    // component failing is a bigger deal than an app pod with equal fan-out);
    // at-risk healthy dependents contribute a little.
    const score =
      explains.length * 10 +
      (tier === 'cluster' ? 25 : tier === 'node' ? 12 : 0) +
      (n.health === 'failed' ? 5 : 0) +
      Math.min(radius.atRisk.length, 20) * 0.5;

    const confidence: RootCause['confidence'] =
      explains.length >= 2 && n.platform ? 'high' : explains.length >= 1 ? 'medium' : 'low';

    return {
      id: n.id,
      kind: n.kind,
      name: n.name,
      namespace: n.namespace,
      health: n.health,
      reason: n.reason,
      explains,
      atRisk: radius.atRisk.length,
      score,
      confidence,
      explanation: explainCause(n, explains.length, radius.atRisk.length),
      component: n.component ? { id: n.component.id, title: n.component.title, impact: n.component.impact } : undefined,
    };
  });

  causes.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = causes.slice(0, limit);

  const summary = broken.length === 0
    ? 'Nothing unhealthy in the graph.'
    : top.length === 0
      ? `${broken.length} unhealthy resource(s), none of which explains another.`
      : `${broken.length} unhealthy resource(s) trace back to ${causes.length} independent cause(s). ` +
        `Start with ${top[0].name}${top[0].explains.length ? ` — it explains ${top[0].explains.length} of them` : ''}.`;

  return { rootCauses: top, collateral, brokenCount: broken.length, summary };
}

function explainCause(n: GraphNode, explains: number, atRisk: number): string {
  const what = n.component ? `${n.component.title} (${n.kind} ${n.name})` : `${n.kind} ${n.name}`;
  const state = n.reason ? `is ${n.health} (${n.reason})` : `is ${n.health}`;
  const nothingUpstream = 'Nothing it depends on is unhealthy, so the failure starts here.';
  const downstream = explains
    ? ` ${explains} other unhealthy resource(s) depend on it, so fixing this may clear them too.`
    : atRisk
      ? ` ${atRisk} healthy resource(s) depend on it and are at risk.`
      : ' Nothing else depends on it, so the impact is contained.';
  return `${what} ${state}. ${nothingUpstream}${downstream}`;
}

/**
 * Walk against the arrows to the closest broken ancestor. BFS, so the answer is
 * the nearest explanation rather than an arbitrary one.
 */
function nearestBrokenAncestor(adj: Adjacency, id: string, brokenIds: Set<string>): string | undefined {
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of adj.in.get(cur) || []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        if (brokenIds.has(e.from)) return e.from;
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return undefined;
}

export interface PathStep {
  from: GraphNode;
  to: GraphNode;
  edge: GraphEdge;
}

/**
 * Shortest dependency chain from `from` to `to`, following the arrows — the
 * answer to "why would that break this?". Returns null when unrelated.
 */
export function dependencyPath(graph: InfraGraph, from: string, to: string, adj: Adjacency = index(graph)): PathStep[] | null {
  if (!adj.byId.has(from) || !adj.byId.has(to)) return null;
  if (from === to) return [];

  const prev = new Map<string, GraphEdge>();
  const seen = new Set<string>([from]);
  let frontier = [from];

  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of adj.out.get(cur) || []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        prev.set(e.to, e);
        if (e.to === to) {
          const steps: PathStep[] = [];
          let node = to;
          while (node !== from) {
            const edge = prev.get(node)!;
            steps.unshift({ from: adj.byId.get(edge.from)!, to: adj.byId.get(edge.to)!, edge });
            node = edge.from;
          }
          return steps;
        }
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return null;
}

/** Render a dependency path as the sentence a human would say. */
export function describePath(steps: PathStep[]): string {
  if (!steps.length) return 'Same resource.';
  return steps
    .map((s) => `${s.from.name} → ${s.to.name}${s.edge.note ? ` (${s.edge.note})` : ''}`)
    .join('\n');
}

/** Small counts for UI headers, computed in one pass. */
export function graphStats(graph: InfraGraph): {
  nodes: number;
  edges: number;
  byKind: Record<string, number>;
  byHealth: Record<string, number>;
} {
  const byKind: Record<string, number> = {};
  const byHealth: Record<string, number> = {};
  for (const n of graph.nodes) {
    byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    byHealth[n.health] = (byHealth[n.health] || 0) + 1;
  }
  return { nodes: graph.nodes.length, edges: graph.edges.length, byKind, byHealth };
}
