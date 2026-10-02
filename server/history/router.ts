// Change-history API.
//
//   GET  /api/history                              the cluster timeline
//   GET  /api/history/object/:kind/:ns/:name       one object's history
//   GET  /api/history/object/:kind/:name           …cluster-scoped form
//   GET  /api/history/summary                      key -> last change (heatmap)
//   GET  /api/history/status                       poller + storage state
//   POST /api/history/capture   { source }         capture now
//   GET  /api/history/why                          current failures + suspect changes
//
// Everything is read-only with respect to the cluster: a capture runs
// `kubectl get` and writes only to Trinetra's own history files.

import { Router } from 'express';
import { loadVms } from '../vms.js';
import { runSteps, parseJson, SAFE_NAME } from '../k8s/kubectl.js';
import { CAPTURED_SECTIONS } from './collect.js';
import { captureOnce, pollerState } from './poller.js';
import { listSources, loadSnapshot, readChanges, type HistoryQuery } from './store.js';
import { objectKey } from './model.js';
import { cachedWhyInput, contractsFor, explainCluster, metadataContracts, rawObject } from '../k8s/why.js';
import { suspectsFor } from './suspects.js';

export const historyRouter = Router();

const sourceOf = (v: unknown): string => {
  const s = String(v || 'local');
  return SAFE_NAME.test(s) ? s : 'local';
};

/** "24h" / "7d" / "90m" / ISO — everything the UI's since-picker can send. */
export function parseSince(raw: unknown): number | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  const rel = s.match(/^(\d+)\s*([mhd])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2].toLowerCase() === 'm' ? 60_000 : rel[2].toLowerCase() === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * ms;
  }
  const t = Date.parse(s);
  return isNaN(t) ? undefined : t;
}

function queryFrom(req: any): HistoryQuery {
  return {
    limit: Number(req.query.limit) || 200,
    since: parseSince(req.query.since),
    kind: req.query.kind ? String(req.query.kind) : undefined,
    objectKind: req.query.objectKind ? String(req.query.objectKind) : undefined,
    namespace: req.query.namespace ? String(req.query.namespace) : undefined,
    name: req.query.name ? String(req.query.name) : undefined,
    severity: req.query.severity ? String(req.query.severity) : undefined,
    actor: req.query.actor ? String(req.query.actor) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    deep: req.query.deep === '1' || req.query.deep === 'true',
  };
}

historyRouter.get('/api/history', async (req, res) => {
  const source = sourceOf(req.query.source);
  try {
    const changes = await readChanges(source, queryFrom(req));
    const snapshot = await loadSnapshot(source);
    res.json({
      ok: true,
      readOnly: true,
      source,
      changes,
      capturedAt: snapshot?.at,
      trackedObjects: snapshot ? Object.keys(snapshot.objects).length : 0,
      sections: snapshot?.sections || [],
      poller: pollerState(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Could not read the history log.' });
  }
});

/**
 * One object's history. Also returns rollout revisions for a Deployment —
 * fetched live rather than snapshotted, because ReplicaSet templates are large
 * and nobody needs them until they are looking at one specific workload.
 */
async function objectHistory(req: any, res: any, kind: string, namespace: string | undefined, name: string) {
  const source = sourceOf(req.query.source || req.query.vm);
  if (!SAFE_NAME.test(name) || (namespace && !SAFE_NAME.test(namespace))) {
    return res.status(400).json({ error: 'Invalid object name.' });
  }

  const objectKind = kind.toLowerCase() === 'k8s-node' ? 'node' : kind.toLowerCase();
  const changes = await readChanges(source, {
    limit: Number(req.query.limit) || 100,
    name,
    namespace,
    deep: true,
  });

  const snapshot = await loadSnapshot(source);
  const canonical = Object.values(snapshot?.objects || {}).find(
    (o) => o.name === name && (o.namespace || undefined) === (namespace || undefined)
  );

  const revisions = objectKind === 'deployment' && namespace
    ? await rolloutRevisions(source, namespace, name)
    : [];

  res.json({
    ok: true,
    readOnly: true,
    source,
    name,
    namespace,
    objectKind,
    changes: changes.filter((c) => c.objectKind.toLowerCase() === objectKind || objectKind === 'any'),
    revisions,
    firstSeen: canonical?.createdAt,
    lastActor: canonical?.actor,
    lastActorAt: canonical?.actorAt,
    trackedSince: snapshot?.at,
    tracked: !!canonical,
  });
}

historyRouter.get('/api/history/object/:kind/:namespace/:name', (req, res) =>
  objectHistory(req, res, req.params.kind, req.params.namespace, req.params.name)
);
historyRouter.get('/api/history/object/:kind/:name', (req, res) =>
  objectHistory(req, res, req.params.kind, undefined, req.params.name)
);

/**
 * A Deployment's revision history, straight from its ReplicaSets.
 *
 * This is the one part of "how did this happen" that Kubernetes actually keeps
 * for you: every rollout leaves a ReplicaSet behind, numbered by the
 * `deployment.kubernetes.io/revision` annotation, and `kubernetes.io/change-cause`
 * carries whatever note the person who did it left. Diffing consecutive
 * revisions' images shows the change even if Trinetra was not running at the time.
 */
export async function rolloutRevisions(source: string, namespace: string, name: string) {
  const vm = source === 'local' ? undefined : source;
  const { out } = await runSteps(
    [{ tag: 'RS', args: ['get', 'rs', '-n', namespace, '-o', 'json'], optional: true }],
    vm,
    30000
  );
  const items: any[] = parseJson(out.RS)?.items || [];
  const mine = items.filter((rs) =>
    (rs?.metadata?.ownerReferences || []).some((o: any) => o.kind === 'Deployment' && o.name === name)
  );

  const rows = mine
    .map((rs) => ({
      revision: rs?.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '',
      cause: rs?.metadata?.annotations?.['kubernetes.io/change-cause'],
      createdAt: rs?.metadata?.creationTimestamp,
      replicas: rs?.spec?.replicas ?? 0,
      active: (rs?.status?.replicas ?? 0) > 0,
      images: (rs?.spec?.template?.spec?.containers || []).map((c: any) => `${c.name}=${c.image}`),
    }))
    .sort((a, b) => Number(b.revision || 0) - Number(a.revision || 0));

  // Say what actually changed between each revision and the one before it.
  return rows.map((r, i) => {
    const prev = rows[i + 1];
    const changed = prev
      ? r.images.filter((img: string) => !prev.images.includes(img)).map((img: string) => {
          const [c, image] = img.split(/=(.*)/);
          const was = prev.images.find((p: string) => p.startsWith(`${c}=`))?.split(/=(.*)/)[1];
          return was ? `${c}: ${was} → ${image}` : `${c}: added ${image}`;
        })
      : [];
    return { ...r, changed };
  });
}

/**
 * Compact "what changed recently" index for the topology heatmap: one entry
 * per object, not one per change.
 */
historyRouter.get('/api/history/summary', async (req, res) => {
  const source = sourceOf(req.query.source);
  const since = parseSince(req.query.since || '24h');
  const changes = await readChanges(source, { limit: 2000, since });
  const byKey: Record<string, { count: number; lastAt: string; kind: string; severity: string; summary: string }> = {};
  for (const c of changes) {
    const key = objectKey(c.objectKind, c.name, c.namespace);
    const cur = byKey[key];
    if (cur) {
      cur.count++;
      if (Date.parse(c.at) > Date.parse(cur.lastAt)) {
        cur.lastAt = c.at;
        cur.kind = c.kind;
        cur.summary = c.summary;
      }
    } else {
      byKey[key] = { count: 1, lastAt: c.at, kind: c.kind, severity: c.severity, summary: c.summary };
    }
  }
  res.json({ ok: true, readOnly: true, source, since: since ? new Date(since).toISOString() : undefined, byKey });
});

/**
 * What the timeline can be sliced by, for one source and window: namespaces
 * (every namespace Trinetra tracks, so a quiet one is still selectable), object
 * kinds, writers, the busiest objects, and an activity histogram.
 *
 * Pure so it is unit-tested; the route below only feeds it.
 */
export function buildFacets(
  changes: Array<{ at: string; actualAt?: string; namespace?: string; objectKind: string; name: string; actor?: string; severity: string; kind: string }>,
  trackedObjects: Array<{ namespace?: string }>,
  sinceMs: number | undefined,
  now = Date.now(),
) {
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
  const ns = new Map<string, number>();
  const tracked = new Map<string, number>();
  const kinds = new Map<string, number>();
  const actors = new Map<string, number>();
  const objects = new Map<string, number>();
  for (const o of trackedObjects) if (o.namespace) count(tracked, o.namespace);
  for (const c of changes) {
    count(ns, c.namespace || '(cluster-scoped)');
    count(kinds, c.objectKind);
    if (c.actor) count(actors, c.actor);
    count(objects, `${c.objectKind}|${c.namespace || ''}|${c.name}`);
  }

  // Hourly buckets for a window up to two days, daily beyond — enough bars to
  // see a spike, few enough to read.
  const start = sinceMs ?? Math.min(now - 86_400_000, ...changes.map((c) => Date.parse(c.at)).filter((t) => !Number.isNaN(t)));
  const span = Math.max(1, now - start);
  const bucketMs = span <= 2 * 86_400_000 ? 3_600_000 : 86_400_000;
  const nBuckets = Math.min(60, Math.max(1, Math.ceil(span / bucketMs)));
  const first = now - nBuckets * bucketMs;
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({ start: new Date(first + i * bucketMs).toISOString(), total: 0, warning: 0 }));
  for (const c of changes) {
    const t = Date.parse(c.at);
    if (Number.isNaN(t) || t < first) continue;
    const i = Math.min(nBuckets - 1, Math.floor((t - first) / bucketMs));
    buckets[i].total++;
    if (c.severity === 'warning') buckets[i].warning++;
  }

  const allNs = new Set([...tracked.keys(), ...ns.keys()]);
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    namespaces: [...allNs]
      .map((name) => ({ name, changes: ns.get(name) || 0, objects: tracked.get(name) || 0 }))
      .sort((a, b) => b.changes - a.changes || a.name.localeCompare(b.name)),
    objectKinds: sorted(kinds).map(([kind, n]) => ({ kind, changes: n })),
    actors: sorted(actors).map(([actor, n]) => ({ actor, changes: n })),
    topObjects: sorted(objects).slice(0, 10).map(([k, n]) => {
      const [objectKind, namespace, name] = k.split('|');
      return { objectKind, namespace: namespace || undefined, name, changes: n };
    }),
    buckets,
    bucketMs,
    total: changes.length,
    warnings: changes.filter((c) => c.severity === 'warning').length,
  };
}

historyRouter.get('/api/history/facets', async (req, res) => {
  const source = sourceOf(req.query.source);
  try {
    const since = parseSince(req.query.since);
    const changes = await readChanges(source, { limit: 2000, since, deep: !since });
    const snapshot = await loadSnapshot(source);
    res.json({ ok: true, readOnly: true, source, ...buildFacets(changes, Object.values(snapshot?.objects || {}), since) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Could not read the history log.' });
  }
});

historyRouter.get('/api/history/status', async (_req, res) => {
  const vms = await loadVms();
  res.json({
    ok: true,
    readOnly: true,
    poller: pollerState(),
    stored: await listSources(),
    availableSources: ['local', ...vms.map((v) => v.name)],
    sections: CAPTURED_SECTIONS,
  });
});

historyRouter.post('/api/history/capture', async (req, res) => {
  const source = sourceOf(req.body?.source);
  try {
    const outcome = await captureOnce(source);
    res.json({ ok: true, readOnly: true, ...outcome });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Capture failed.' });
  }
});

/**
 * What is failing right now, and which recorded changes most likely caused it.
 *
 *   GET /api/history/why?source=                       every current finding
 *   GET /api/history/why?source=&kind=&namespace=&name= one object (drawer)
 *
 * Findings come from the why-engine; suspects are ranked by suspects.ts over
 * the last seven days of this source's history.
 */
historyRouter.get('/api/history/why', async (req, res) => {
  const source = sourceOf(req.query.source);
  const vm = source === 'local' ? undefined : source;
  const kind = req.query.kind ? String(req.query.kind).toLowerCase() : undefined;
  const namespace = req.query.namespace ? String(req.query.namespace) : undefined;
  const name = req.query.name ? String(req.query.name) : undefined;
  try {
    const [input, changes] = await Promise.all([
      cachedWhyInput(vm),
      readChanges(source, { limit: 2000, since: Date.now() - 7 * 86_400_000 }),
    ]);
    if (!input.read.size) {
      return res.json({ ok: false, error: input.error || 'Nothing could be read from the cluster.', findings: [] });
    }
    const report = explainCluster(input);
    const pods = new Map<string, any>();
    for (const p of input.pods || []) pods.set(objectKey('Pod', p?.metadata?.name, p?.metadata?.namespace || 'default'), p);
    const workloads = new Set((input.workloads || []).map((w: any) => objectKey(w?.kind || 'Deployment', w?.metadata?.name, w?.metadata?.namespace)));
    const ctx = {
      ownerOf: (podKey: string) => {
        const p = pods.get(podKey);
        const o = p?.metadata?.ownerReferences?.[0];
        if (!o) return undefined;
        const ns = p.metadata.namespace;
        if (o.kind === 'ReplicaSet') {
          const dep = objectKey('Deployment', String(o.name).replace(/-[a-z0-9]{5,10}$/, ''), ns);
          if (workloads.has(dep)) return dep;
        }
        return objectKey(o.kind, o.name, ns);
      },
      nodeOf: (podKey: string) => pods.get(podKey)?.spec?.nodeName,
    };
    let findings = report.findings;
    let focus: Record<string, unknown> = {};
    if (kind && name) {
      const canon = kind === 'isvc' ? 'inferenceservice' : kind === 'k8s-node' ? 'node' : kind;
      findings = findings.filter((f) => f.object.kind.toLowerCase() === canon && f.object.name === name && (!namespace || canon === 'node' || f.object.namespace === namespace));
      // The chain: findings on the objects that are this one's root cause.
      const causes = report.findings.filter((c) => findings.some((f) => f.rootCause && f.rootCause.kind === c.object.kind && f.rootCause.name === c.object.name));
      const display = canon === 'inferenceservice' ? 'InferenceService' : canon.charAt(0).toUpperCase() + canon.slice(1);
      const obj = rawObject(input, canon, namespace, name);
      focus = {
        causes,
        contracts: contractsFor(input, display, namespace, name),
        metadata: obj ? metadataContracts(obj) : [],
        found: !!obj,
      };
    }
    // Info-level findings (expected states) never need a suspect.
    const withSuspects = findings.slice(0, 300).map((f) => ({ ...f, suspects: f.severity === 'info' ? [] : suspectsFor(f, changes, ctx) }));
    res.json({
      ok: true,
      readOnly: true,
      source,
      ...focus,
      findings: withSuspects,
      counts: report.counts,
      read: report.read,
      historyWindow: { since: new Date(Date.now() - 7 * 86_400_000).toISOString(), changes: changes.length },
      at: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Could not correlate failures with changes.' });
  }
});
