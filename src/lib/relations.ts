// Every relationship the topology map draws, derived from real Kubernetes
// semantics rather than guessed from names.
//
// This is the part that decides whether the map is a picture of a cluster or a
// column of disconnected boxes. It used to guess:
//
//   * "Deployment owns pod" was `pod.name.startsWith(deploy.name)` — which also
//     hands every `api-worker-xxx` pod to the `api` Deployment, and gives
//     StatefulSet pods (`postgres-0`, `kafka-0`) no owner at all.
//   * "Service routes to pod" fell back to `pod.name.includes(svc.name)`
//     whenever the selector was missing — and the SSH path always stripped the
//     selector, so on a VM it was ALWAYS the fallback.
//
// Both now read the fields Kubernetes actually uses (ownerReferences, label
// selectors, spec.nodeName), and the name-based guesses survive only as a
// clearly-marked last resort for payloads that carry nothing better.
//
// Pure and framework-free so every rule is unit-tested from fixtures in
// src/lib/__tests__/relations.test.ts.

export type RelationKind =
  | 'exposes'   // host port  → container
  | 'manages'   // workload   → pod
  | 'routes'    // service    → pod
  | 'runs-on'   // pod        → cluster node
  | 'backs'     // pod        → the container actually running it
  | 'hosts';    // cluster node → container

export interface Relation {
  id: string;
  source: string;
  target: string;
  kind: RelationKind;
  /** True when the edge came from a name heuristic, not from cluster data. */
  inferred?: boolean;
}

export interface RelationInput {
  containers: any[];
  pods: any[];
  services: any[];
  deployments: any[];
  nodes: any[];
}

// ── Node ids ────────────────────────────────────────────────────────────────
// Shared with the renderer so an edge can never point at an id that no card
// uses. Namespaces contain '-', so ids are only ever *built*, never parsed.

export const cleanId = (s: string) => (s || '').replace(/[^a-zA-Z0-9]/g, '_');
export const podId = (ns: string, name: string) => `pod-${ns}-${cleanId(name)}`;
export const svcId = (ns: string, name: string) => `svc-${ns}-${cleanId(name)}`;
export const deployId = (ns: string, name: string) => `deploy-${ns}-${cleanId(name)}`;
export const k8sNodeId = (name: string) => `k8snode-${cleanId(name)}`;
export const containerId = (id: string) => `docker-${(id || '').slice(0, 12)}`;

/** Does this pod's label set satisfy every key/value in the selector? */
export function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const keys = Object.keys(selector || {});
  if (keys.length === 0) return false; // an empty selector selects nothing here
  return keys.every((k) => labels?.[k] === selector[k]);
}

/** Parse the JSON-encoded selector the API sends; 'None'/garbage → null. */
export function parseSelector(raw: unknown): Record<string, string> | null {
  if (!raw || raw === 'None' || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The pod a container is running, when the container is part of one.
 *
 * Two runtimes, two ways of saying it: crictl reports the pod directly on the
 * container, while Docker only encodes it in the conventional
 * `k8s_<container>_<pod>_<namespace>_<uid>_<attempt>` name. Reading the crictl
 * field matters because a normal Kubernetes node has no Docker at all.
 */
export function containerPod(c: any): { name: string; namespace?: string } | null {
  if (c?.pod) return { name: String(c.pod) };
  const name = String(c?.name || '');
  if (!name.startsWith('k8s_')) return null;
  const parts = name.split('_');
  if (parts.length < 4) return null;
  return { name: parts[2], namespace: parts[3] };
}

export function buildRelations(input: RelationInput): Relation[] {
  const containers = input.containers || [];
  const pods = input.pods || [];
  const services = input.services || [];
  const deployments = input.deployments || [];
  const nodes = input.nodes || [];

  const rels: Relation[] = [];
  const seen = new Set<string>();
  const add = (r: Relation) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    rels.push(r);
  };

  // ── Workload → Pod ────────────────────────────────────────────────────────
  // ownerReferences first (exact, and the only thing that works for
  // StatefulSets and DaemonSets); the name prefix only where none exists.
  const workloadByKey = new Map<string, any>();
  for (const d of deployments) workloadByKey.set(`${d.namespace}/${d.name}`, d);

  for (const p of pods) {
    if (!p?.name) continue; // a nameless object cannot be drawn or pointed at
    const target = podId(p.namespace, p.name);
    const owner = p.owner;

    if (owner?.name && workloadByKey.has(`${p.namespace}/${owner.name}`)) {
      const source = deployId(p.namespace, owner.name);
      add({ id: `edge-${source}-${target}`, source, target, kind: 'manages' });
      continue;
    }

    // The pod states an owner that is not on the canvas — a static pod owned by
    // its Node, or a workload the current filter removed. That is a known
    // answer, not a missing one, so guessing a different parent from names
    // would be inventing a relationship the cluster does not have.
    if (owner?.name) continue;

    // Genuinely unowned: fall back to the longest matching workload name, so
    // `api-worker-7d9f-x` prefers the `api-worker` workload over `api`.
    const candidates = deployments
      .filter((d) => d?.name && d.namespace === p.namespace && p.name.startsWith(d.name))
      .sort((a, b) => b.name.length - a.name.length);
    if (candidates.length > 0) {
      const source = deployId(p.namespace, candidates[0].name);
      add({ id: `edge-${source}-${target}`, source, target, kind: 'manages', inferred: true });
    }
  }

  // ── Service → Pod ─────────────────────────────────────────────────────────
  for (const s of services) {
    if (!s?.name) continue;
    const source = svcId(s.namespace, s.name);
    const selector = parseSelector(s.selector);
    const nsPods = pods.filter((p) => p.namespace === s.namespace);

    if (selector) {
      for (const p of nsPods) {
        if (selectorMatches(selector, p.labels || {})) {
          const target = podId(p.namespace, p.name);
          add({ id: `edge-${source}-${target}`, source, target, kind: 'routes' });
        }
      }
      continue;
    }

    // A headless/selectorless Service is real (ExternalName, manual Endpoints)
    // — draw nothing rather than inventing routes to unrelated pods. The name
    // heuristic applies only when pods carry no labels at all, i.e. a payload
    // too thin to do better.
    const labelsUnavailable = nsPods.every((p) => Object.keys(p.labels || {}).length === 0);
    if (!labelsUnavailable) continue;
    for (const p of nsPods) {
      if (p.name && p.name.includes(s.name)) {
        const target = podId(p.namespace, p.name);
        add({ id: `edge-${source}-${target}`, source, target, kind: 'routes', inferred: true });
      }
    }
  }

  // ── Pod → Node ────────────────────────────────────────────────────────────
  const nodeNames = new Set(nodes.filter((n) => n?.name).map((n) => n.name));
  for (const p of pods) {
    if (!p?.name || !p.node || p.node === 'None' || !nodeNames.has(p.node)) continue;
    const source = podId(p.namespace, p.name);
    const target = k8sNodeId(p.node);
    add({ id: `edge-${source}-${target}`, source, target, kind: 'runs-on' });
  }

  // ── Pod → Container ───────────────────────────────────────────────────────
  const podByName = new Map<string, any>();
  for (const p of pods) {
    if (!p?.name) continue;
    podByName.set(`${p.namespace}/${p.name}`, p);
    // crictl gives a pod name without its namespace; keep a name-only index too.
    if (!podByName.has(p.name)) podByName.set(p.name, p);
  }

  for (const c of containers) {
    if (!c?.id) continue;
    const ref = containerPod(c);
    if (!ref) continue;
    const pod = ref.namespace
      ? podByName.get(`${ref.namespace}/${ref.name}`)
      : podByName.get(ref.name);
    if (!pod) continue;
    const source = podId(pod.namespace, pod.name);
    const target = containerId(c.id);
    add({ id: `edge-${source}-${target}`, source, target, kind: 'backs' });
  }

  // ── Node → Container ──────────────────────────────────────────────────────
  // Only for containers that are NOT already attached to a pod: a pod's
  // container is reached through its pod, and drawing both makes a hairball.
  const attached = new Set(rels.filter((r) => r.kind === 'backs').map((r) => r.target));
  for (const n of nodes) {
    if (!n?.name) continue;
    for (const c of containers) {
      if (!c?.id) continue;
      const cid = containerId(c.id);
      if (attached.has(cid)) continue;
      const cname = String(c.name || '');
      if (!cname || (cname !== n.name && !cname.includes(n.name) && !n.name.includes(cname))) continue;
      const source = k8sNodeId(n.name);
      add({ id: `edge-${source}-${cid}`, source, target: cid, kind: 'hosts', inferred: true });
    }
  }

  return rels;
}
