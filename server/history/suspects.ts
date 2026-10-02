// Which recent change most likely explains a current failure?
//
// The why-engine (k8s/why.ts) knows what is broken and why, from the cluster
// as it is now. The history knows what changed. Joined, they answer the
// question an operator actually asks: "what did we do that broke this?"
//
// Each candidate change gets a score from three independent judgements:
//
//   relation   — how the changed object relates to the failing one: the same
//                object, its root cause, its owner, its node, its namespace,
//                or a change whose impact note names it.
//   relevance  — whether that KIND of change can cause that KIND of failure:
//                an image change explains an image pull error, a taint
//                explains an unschedulable pod, a label edit explains a
//                selector that matches nothing.
//   timing     — a change just before the failure began is a strong suspect;
//                one after it began cannot have caused it (it may be a fix).
//
// The product is ranked and every suspect carries a sentence saying why it
// was picked, so the ranking can be checked rather than trusted.

import type { ChangeEvent, ChangeKind } from './model.js';
import { objectKey } from './model.js';
import type { Category, Finding, ObjRef } from '../k8s/why.js';

export interface Suspect {
  change: ChangeEvent;
  score: number;
  reason: string;
}

export interface SuspectContext {
  /** Workload behind a pod: "Pod/ns/name" → "Deployment/ns/name". */
  ownerOf?: (podKey: string) => string | undefined;
  /** Node a pod runs on: "Pod/ns/name" → node name. */
  nodeOf?: (podKey: string) => string | undefined;
  now?: number;
}

const k = (o: ObjRef) => objectKey(o.kind, o.name, o.kind === 'Node' || o.kind.startsWith('Cluster') || o.kind === 'StorageClass' || o.kind === 'IngressClass' ? undefined : o.namespace);
const evKey = (e: ChangeEvent) => objectKey(e.objectKind, e.name, e.namespace);

/** Can a change of this kind cause a failure of that category? 0..1 */
const RELEVANCE: Partial<Record<Category, Partial<Record<ChangeKind, number>>>> = {
  image: { image: 1, config: 0.7, rbac: 0.8, spec: 0.5, deleted: 0.9, created: 0.4 },
  crash: { image: 1, spec: 0.9, config: 0.9, annotation: 0.4, scaled: 0.2, deleted: 0.7, lifecycle: 0.3 },
  config: { config: 1, deleted: 1, spec: 0.9, image: 0.4, created: 0.5 },
  probe: { spec: 1, image: 0.9, config: 0.7, network: 0.5 },
  scheduling: { taint: 1, cordon: 1, label: 1, spec: 0.8, storage: 0.7, scaled: 0.6, version: 0.5, deleted: 0.6 },
  storage: { storage: 1, deleted: 1, annotation: 0.7, spec: 0.6, created: 0.5 },
  labels: { label: 1, network: 1, spec: 0.9, annotation: 0.4 },
  annotations: { annotation: 1, label: 0.6, spec: 0.5 },
  network: { network: 1, label: 0.9, deleted: 0.9, spec: 0.6, lifecycle: 0.6 },
  certificate: { annotation: 1, network: 0.9, config: 0.9, deleted: 1, lifecycle: 0.8, created: 0.6 },
  model: { image: 1, spec: 0.9, storage: 0.8, deleted: 0.9, annotation: 0.8, scaled: 0.4 },
  node: { version: 1, taint: 0.8, cordon: 0.8, lifecycle: 0.9, label: 0.6 },
  rollout: { image: 1, spec: 0.9, scaled: 0.7, config: 0.7, rbac: 0.8, deleted: 0.7 },
  quota: { scaled: 1, spec: 0.9, created: 0.5 },
  lifecycle: { lifecycle: 0.8, spec: 0.5 },
};

function relevance(cat: Category, kind: ChangeKind): number {
  return RELEVANCE[cat]?.[kind] ?? 0.3;
}

const HOUR = 3_600_000;

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just before';
  if (m < 90) return `${m} min`;
  const h = Math.round(ms / HOUR);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** Rank the changes that may explain one finding. */
export function suspectsFor(f: Finding, changes: ChangeEvent[], ctx: SuspectContext = {}, max = 3): Suspect[] {
  const now = ctx.now ?? Date.now();
  const self = k(f.object);
  const root = f.rootCause ? k(f.rootCause) : undefined;
  const owner = f.object.kind === 'Pod' ? ctx.ownerOf?.(self) : undefined;
  const node = f.object.kind === 'Pod' ? ctx.nodeOf?.(self) : undefined;
  const since = f.since ? Date.parse(f.since) : NaN;
  const names = [f.object, ...(f.rootCause ? [f.rootCause] : [])].map((o) => `${o.kind} ${o.name}`);

  const out: Suspect[] = [];
  for (const c of changes) {
    if (c.causedBy) continue;
    const key = evKey(c);
    let rel = 0;
    let how = '';
    if (root && key === root) { rel = 1; how = `it changed ${c.objectKind} ${c.name}, the root cause`; }
    else if (key === self) { rel = 1; how = 'it changed this object'; }
    else if (owner && key === owner) { rel = 0.95; how = `it changed ${c.objectKind} ${c.name}, which owns this pod`; }
    else if (c.impact?.some((line) => names.some((n) => line.includes(n)))) { rel = 0.9; how = 'its impact note names this object'; }
    else if (node && c.objectKind === 'Node' && c.name === node) { rel = 0.6; how = `it changed node ${node}, where this pod runs`; }
    else if (f.object.namespace && c.namespace === f.object.namespace && c.objectKind !== 'Pod') { rel = 0.3; how = `same namespace (${c.namespace})`; }
    else if (!c.namespace && c.objectKind !== 'Node' && (c.kind === 'deleted' || c.severity === 'warning')) { rel = 0.15; how = 'cluster-wide change'; }
    if (!rel) continue;

    const rv = relevance(f.category, c.kind);
    const t = Date.parse(c.actualAt || c.at) || 0;
    let timing: number;
    let when: string;
    if (!Number.isNaN(since)) {
      if (t <= since + 2 * 60_000) {
        const gap = Math.max(0, since - t);
        timing = Math.max(0.1, Math.exp(-gap / (6 * HOUR)));
        when = gap < 60_000 ? 'right when it started failing' : `${ago(gap)} before it started failing`;
      } else {
        timing = 0.1;
        when = `${ago(t - since)} after it started failing (a fix attempt?)`;
      }
    } else {
      const age = Math.max(0, now - t);
      timing = Math.max(0.05, Math.exp(-age / (24 * HOUR)));
      when = `${ago(age)} ago`;
    }
    const score = rel * rv * timing;
    if (score < 0.12) continue;
    out.push({ change: c, score: Math.round(score * 100) / 100, reason: `${how}; ${c.kind} change; ${when}` });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
