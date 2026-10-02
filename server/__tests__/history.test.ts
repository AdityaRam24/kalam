// Unit tests for the change-history core.
//
// The dangerous failure of a diff engine is not silence — it is confidence.
// A truncated read, a lost permission or a missing API must never be reported
// as "someone deleted 400 objects", so the guards are tested before anything
// else and in more detail than the happy path.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import { attribution, digest, fingerprintObject, parsePodTable, parseRvTable } from '../history/fingerprint.js';
import { diffSnapshots, fieldChanges } from '../history/diff.js';
import { objectKey, type Fingerprint, type Snapshot } from '../history/model.js';
import { appendChanges, listSources, loadSnapshot, paths, readChanges, saveSnapshot } from '../history/store.js';
import { parseSince } from '../history/router.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function deployment(over: { image?: string; replicas?: number; selector?: string; manager?: string; time?: string; gen?: number; obs?: number } = {}) {
  return {
    kind: 'Deployment',
    metadata: {
      name: 'web',
      namespace: 'shop',
      uid: 'uid-web',
      generation: over.gen ?? 4,
      creationTimestamp: '2026-01-01T00:00:00Z',
      annotations: { 'deployment.kubernetes.io/revision': '7', 'kubernetes.io/change-cause': 'kubectl set image …' },
      managedFields: [
        { manager: over.manager || 'helm', operation: 'Apply', time: over.time || '2026-08-09T10:00:00Z' },
        { manager: 'kube-controller-manager', operation: 'Update', subresource: 'status', time: '2026-08-09T11:00:00Z' },
      ],
    },
    spec: {
      replicas: over.replicas ?? 3,
      selector: { matchLabels: { app: over.selector || 'web' } },
      strategy: { type: 'RollingUpdate' },
      template: {
        metadata: { labels: { app: over.selector || 'web' } },
        spec: {
          serviceAccountName: 'web-sa',
          containers: [
            {
              name: 'main',
              image: over.image || 'registry.io/team/web:1.0',
              env: [{ name: 'API_TOKEN', value: 'super-secret-value' }],
              resources: { requests: { cpu: '100m' }, limits: { cpu: '1' } },
            },
          ],
        },
      },
    },
    status: { observedGeneration: over.obs ?? 4 },
  };
}

function node(over: { unschedulable?: boolean; taints?: any[]; kubelet?: string; ready?: string } = {}) {
  return {
    kind: 'Node',
    metadata: { name: 'worker-1', uid: 'uid-n1', labels: { 'node-role.kubernetes.io/worker': '' } },
    spec: { unschedulable: over.unschedulable, taints: over.taints },
    status: {
      conditions: [{ type: 'Ready', status: over.ready || 'True' }],
      capacity: { cpu: '8', memory: '32Gi' },
      nodeInfo: { kubeletVersion: over.kubelet || 'v1.29.4' },
      addresses: [{ type: 'InternalIP', address: '10.0.0.11' }],
    },
  };
}

/** Build a snapshot from fingerprints, declaring the sections they came from. */
function snap(source: string, at: string, fps: Fingerprint[], sections: string[]): Snapshot {
  const objects: Record<string, Fingerprint> = {};
  for (const fp of fps) objects[objectKey(fp.kind, fp.name, fp.namespace)] = fp;
  return { version: 1, source, at, sections, objects };
}

const fp = (obj: any) => fingerprintObject(obj)!;
const WORKLOAD = ['WORKLOADS'];
const summaries = (evs: any[]) => evs.map((e) => e.summary);

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

describe('fingerprinting', () => {
  it('keeps the fields a changelog needs and drops the ones that churn', () => {
    const f = fp(deployment());
    expect(f.spec['image.main']).toBe('registry.io/team/web:1.0');
    expect(f.spec.replicas).toBe('3');
    expect(f.spec.selector).toBe('app=web');
    expect(f.spec.serviceAccount).toBe('web-sa');
    // resourceVersion and status counters must never become fields.
    expect(Object.keys(f.spec).some((k) => /resourceVersion|readyReplicas|observed/i.test(k))).toBe(false);
  });

  it('never writes an inline env value into the history', () => {
    const f = fp(deployment());
    const env = f.spec['env.main'];
    expect(env).toContain('API_TOKEN=');
    expect(env).not.toContain('super-secret-value');
    // …but a changed secret still changes the fingerprint.
    const rotated = JSON.parse(JSON.stringify(deployment()));
    rotated.spec.template.spec.containers[0].env[0].value = 'a-different-secret';
    expect(fp(rotated).spec['env.main']).not.toBe(env);
  });

  it('keeps generation and observedGeneration out of the diffable fields', () => {
    const f = fp(deployment({ gen: 9, obs: 8 }));
    expect(f.generation).toBe(9);
    expect(f.observed).toBe(8);
    expect(f.spec.generation).toBeUndefined();
  });

  it('names the actor from managedFields, ignoring status writers', () => {
    const a = attribution(deployment().metadata);
    // kube-controller-manager wrote later, but only the status subresource.
    expect(a.actor).toBe('helm');
    expect(a.actorOp).toBe('Apply');
    expect(a.actorAt).toBe('2026-08-09T10:00:00Z');
  });

  it('returns no actor rather than a guess when managedFields are absent', () => {
    expect(attribution({ name: 'x' })).toEqual({});
  });

  it('parses the pod column table, including missing values', () => {
    const table = [
      'shop   web-abc   worker-1   Running   ReplicaSet   web-7d9f8b   web:1.0   0   true    2026-08-09T09:00:00Z   uid-1',
      'shop   lone-pod  <none>     Pending   <none>       <none>       web:1.0   <none> <none>  2026-08-09T09:30:00Z   uid-2',
    ].join('\n');
    const pods = parsePodTable(table);
    expect(pods).toHaveLength(2);
    expect(pods[0]).toMatchObject({ kind: 'Pod', name: 'web-abc', namespace: 'shop', owner: 'ReplicaSet/shop/web-7d9f8b' });
    expect(pods[0].spec).toMatchObject({ node: 'worker-1', phase: 'Running', restarts: '0' });
    // An unscheduled, unowned pod keeps its identity without inventing fields.
    expect(pods[1].spec.node).toBeUndefined();
    expect(pods[1].owner).toBeUndefined();
  });

  it('sums restart counts across containers', () => {
    const pods = parsePodTable('ns p node Running <none> <none> a,b 3,4 true,true 2026-01-01T00:00:00Z uid');
    expect(pods[0].spec.restarts).toBe('7');
  });

  it('tracks ConfigMaps and Secrets by resourceVersion and nothing else', () => {
    const cms = parseRvTable('shop|app-config|1234\nshop|other|99', 'ConfigMap');
    expect(cms[0]).toMatchObject({ kind: 'ConfigMap', namespace: 'shop', name: 'app-config' });
    expect(cms[0].spec).toEqual({ revision: '1234' });
    const cluster = parseRvTable('cluster-admin|55', 'ClusterRole', false);
    expect(cluster[0]).toMatchObject({ kind: 'ClusterRole', name: 'cluster-admin', namespace: undefined });
  });

  it('produces a different digest for different content and a stable one for the same', () => {
    expect(digest('a')).toBe(digest('a'));
    expect(digest('a')).not.toBe(digest('b'));
  });
});

// ---------------------------------------------------------------------------
// Guards — the part that must never be wrong
// ---------------------------------------------------------------------------

describe('diff guards', () => {
  it('reports nothing on the first capture', () => {
    const next = snap('local', '2026-08-09T12:00:00Z', [fp(deployment()), fp(node())], ['WORKLOADS', 'CLUSTER']);
    const { events, notes } = diffSnapshots(undefined, next);
    expect(events).toEqual([]);
    expect(notes[0]).toMatch(/Baseline/);
  });

  it('does not report deletions for a section that failed to return', () => {
    const before = snap('local', '2026-08-09T12:00:00Z', [fp(deployment()), fp(node())], ['WORKLOADS', 'CLUSTER']);
    // The workloads query failed this time — its objects are unknown, not gone.
    const after = snap('local', '2026-08-09T12:05:00Z', [fp(node())], ['CLUSTER']);
    const { events, notes } = diffSnapshots(before, after);
    expect(events).toEqual([]);
    expect(notes.join(' ')).toMatch(/Skipped "WORKLOADS"/);
  });

  it('refuses a capture that lost most of the cluster', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      fp({ ...deployment(), metadata: { ...deployment().metadata, name: `app-${i}`, uid: `uid-${i}` } })
    );
    const before = snap('local', '2026-08-09T12:00:00Z', many, WORKLOAD);
    const after = snap('local', '2026-08-09T12:05:00Z', many.slice(0, 5), WORKLOAD);
    const { events, notes } = diffSnapshots(before, after);
    expect(events).toEqual([]);
    expect(notes.join(' ')).toMatch(/truncated or partially failed read/);
  });

  it('still reports a genuine small deletion', () => {
    const a = fp(deployment());
    const b = fp({ ...deployment(), metadata: { ...deployment().metadata, name: 'api', uid: 'uid-api' } });
    const before = snap('local', '2026-08-09T12:00:00Z', [a, b], WORKLOAD);
    const after = snap('local', '2026-08-09T12:05:00Z', [a], WORKLOAD);
    const { events } = diffSnapshots(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'deleted', name: 'api', severity: 'warning' });
  });

  it('says nothing when nothing changed', () => {
    const before = snap('local', '2026-08-09T12:00:00Z', [fp(deployment()), fp(node())], ['WORKLOADS', 'CLUSTER']);
    const after = snap('local', '2026-08-09T12:05:00Z', [fp(deployment()), fp(node())], ['WORKLOADS', 'CLUSTER']);
    expect(diffSnapshots(before, after).events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Classification — does the timeline read like sentences?
// ---------------------------------------------------------------------------

describe('what the change is called', () => {
  const at1 = '2026-08-09T12:00:00Z';
  const at2 = '2026-08-09T12:05:00Z';
  const change = (before: any, after: any, sections = WORKLOAD) =>
    diffSnapshots(snap('local', at1, [fp(before)], sections), snap('local', at2, [fp(after)], sections)).events;

  it('calls an image change an image change, with a readable before and after', () => {
    const evs = change(deployment(), deployment({ image: 'registry.io/team/web:1.1' }));
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe('image');
    expect(evs[0].summary).toContain('web:1.0 → web:1.1');
    expect(evs[0].fields[0]).toMatchObject({ path: 'image.main', from: 'registry.io/team/web:1.0' });
  });

  it('reports scaling as scaling', () => {
    const evs = change(deployment(), deployment({ replicas: 5 }));
    expect(evs[0]).toMatchObject({ kind: 'scaled' });
    expect(evs[0].summary).toContain('3 → 5');
  });

  it('treats a selector edit as a warning, because it silently orphans pods', () => {
    const evs = change(deployment(), deployment({ selector: 'web2' }));
    expect(evs[0].severity).toBe('warning');
    expect(evs[0].kind).toBe('network');
  });

  it('distinguishes cordon from uncordon', () => {
    const cordon = change(node(), node({ unschedulable: true }), ['CLUSTER']);
    expect(cordon[0]).toMatchObject({ kind: 'cordon', severity: 'warning' });
    expect(cordon[0].summary).toContain('cordoned');
    const un = change(node({ unschedulable: true }), node(), ['CLUSTER']);
    expect(un[0].summary).toContain('uncordoned');
  });

  it('reports taints and kubelet upgrades on a node', () => {
    const taint = change(node(), node({ taints: [{ key: 'gpu', value: 'true', effect: 'NoSchedule' }] }), ['CLUSTER']);
    expect(taint[0].kind).toBe('taint');
    expect(taint[0].summary).toContain('gpu=true:NoSchedule');

    const upgrade = change(node(), node({ kubelet: 'v1.30.1' }), ['CLUSTER']);
    expect(upgrade[0]).toMatchObject({ kind: 'version' });
    expect(upgrade[0].summary).toContain('v1.29.4 → v1.30.1');
  });

  it('flags a node going NotReady', () => {
    const evs = change(node(), node({ ready: 'False' }), ['CLUSTER']);
    expect(evs[0].summary).toContain('True → False');
  });

  it('calls a pod moving between nodes a reschedule, not a delete and a create', () => {
    const before = parsePodTable('shop web-abc worker-1 Running <none> <none> web:1.0 0 true 2026-01-01T00:00:00Z uid-1');
    const after = parsePodTable('shop web-abc worker-2 Running <none> <none> web:1.0 0 true 2026-01-01T00:00:00Z uid-1');
    const evs = diffSnapshots(snap('local', at1, before, ['PODS']), snap('local', at2, after, ['PODS'])).events;
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe('schedule');
    expect(evs[0].summary).toContain('worker-1 to worker-2');
  });

  it('reports a restart but ignores a counter that went backwards', () => {
    const p = (restarts: string) =>
      parsePodTable(`shop web-abc worker-1 Running <none> <none> web:1.0 ${restarts} true 2026-01-01T00:00:00Z uid-1`);
    const up = diffSnapshots(snap('local', at1, p('0'), ['PODS']), snap('local', at2, p('2'), ['PODS'])).events;
    expect(up[0]).toMatchObject({ kind: 'restarted', severity: 'warning' });

    // A lower count means a different pod object, which created/deleted covers.
    const down = diffSnapshots(snap('local', at1, p('5'), ['PODS']), snap('local', at2, p('0'), ['PODS'])).events;
    expect(down).toEqual([]);
  });

  it('treats a reused name with a new uid as a replacement', () => {
    const before = snap('local', at1, [fp(deployment())], WORKLOAD);
    const replaced = deployment();
    replaced.metadata.uid = 'uid-different';
    const after = snap('local', at2, [fp(replaced)], WORKLOAD);
    const evs = diffSnapshots(before, after).events;
    expect(evs).toHaveLength(1);
    expect(evs[0].summary).toContain('replaced');
  });

  it('says a Secret was rewritten without ever holding its contents', () => {
    const before = snap('local', at1, parseRvTable('shop|db-cred|10', 'Secret'), ['SECRETS']);
    const after = snap('local', at2, parseRvTable('shop|db-cred|11', 'Secret'), ['SECRETS']);
    const evs = diffSnapshots(before, after).events;
    expect(evs[0].summary).toContain('secret contents were rewritten');
    expect(JSON.stringify(evs)).not.toMatch(/db-cred.*value|password/i);
  });

  it('classifies an opaque write to an RBAC object as a permissions change', () => {
    const before = snap('local', at1, parseRvTable('cluster-admin|1', 'ClusterRole', false), ['CLUSTERROLES']);
    const after = snap('local', at2, parseRvTable('cluster-admin|2', 'ClusterRole', false), ['CLUSTERROLES']);
    const evs = diffSnapshots(before, after).events;
    expect(evs[0]).toMatchObject({ kind: 'rbac' });
    expect(evs[0].summary).toContain('permission rules were changed');
  });

  it('records the real creation time, not the time Trinetra noticed', () => {
    const before = snap('local', at1, [fp(node())], WORKLOAD.concat('CLUSTER'));
    const created = deployment();
    created.metadata.creationTimestamp = '2026-08-09T11:59:00Z';
    const after = snap('local', at2, [fp(node()), fp(created)], WORKLOAD.concat('CLUSTER'));
    const evs = diffSnapshots(before, after).events;
    const createdEvent = evs.find((e) => e.kind === 'created')!;
    expect(createdEvent.actualAt).toBe('2026-08-09T11:59:00Z');
    expect(createdEvent.at).toBe(at2);
  });
});

// ---------------------------------------------------------------------------
// Attribution and noise
// ---------------------------------------------------------------------------

describe('attribution', () => {
  const at1 = '2026-08-09T12:00:00Z';
  const at2 = '2026-08-09T12:05:00Z';

  it('credits the manager whose managedFields stamp moved', () => {
    const before = snap('local', at1, [fp(deployment())], WORKLOAD);
    const after = snap('local', at2, [fp(deployment({ image: 'registry.io/team/web:2.0', manager: 'kubectl-client-side-apply', time: '2026-08-09T12:03:00Z' }))], WORKLOAD);
    const ev = diffSnapshots(before, after).events[0];
    expect(ev.actor).toBe('kubectl-client-side-apply');
    // The cluster's own timestamp beats "whenever we happened to look".
    expect(ev.actualAt).toBe('2026-08-09T12:03:00Z');
  });

  it('names nobody when the managedFields stamp did not move', () => {
    // Same manager and time as before. Something changed, but managedFields
    // does not say this manager did it — and "helm last touched this object"
    // must never be rendered as "helm made this change".
    const before = snap('local', at1, [fp(deployment())], WORKLOAD);
    const after = snap('local', at2, [fp(deployment({ image: 'registry.io/team/web:2.0' }))], WORKLOAD);
    const ev = diffSnapshots(before, after).events[0];
    expect(ev.actualAt).toBeUndefined();
    expect(ev.actor).toBeUndefined();
    expect(ev.actorOp).toBeUndefined();
    // The change itself is still reported in full.
    expect(ev.kind).toBe('image');
  });

  it('credits the creator of a brand-new object', () => {
    const before = snap('local', at1, [fp(node())], ['WORKLOADS', 'CLUSTER']);
    const after = snap('local', at2, [fp(node()), fp(deployment())], ['WORKLOADS', 'CLUSTER']);
    const created = diffSnapshots(before, after).events.find((e) => e.kind === 'created')!;
    expect(created.actor).toBe('helm');
  });

  it('never names an actor on a deletion, since the evidence left with the object', () => {
    const before = snap('local', at1, [fp(deployment()), fp(node())], ['WORKLOADS', 'CLUSTER']);
    const after = snap('local', at2, [fp(node())], ['WORKLOADS', 'CLUSTER']);
    const deleted = diffSnapshots(before, after).events[0];
    expect(deleted.kind).toBe('deleted');
    expect(deleted.actor).toBeUndefined();
  });

  it('carries the change-cause note and revision through', () => {
    const before = snap('local', at1, [fp(deployment())], WORKLOAD);
    const after = snap('local', at2, [fp(deployment({ image: 'registry.io/team/web:2.0' }))], WORKLOAD);
    const ev = diffSnapshots(before, after).events[0];
    expect(ev.cause).toBe('kubectl set image …');
    expect(ev.revision).toBe('7');
  });

  it('marks a spec change the controller has not caught up with', () => {
    const before = snap('local', at1, [fp(deployment({ gen: 4, obs: 4 }))], WORKLOAD);
    const after = snap('local', at2, [fp(deployment({ image: 'registry.io/team/web:2.0', gen: 5, obs: 4 }))], WORKLOAD);
    expect(diffSnapshots(before, after).events[0].summary).toContain('not yet rolled out');
  });

  it('emits nothing when only the managedFields timestamp moved', () => {
    const before = snap('local', at1, [fp(deployment())], WORKLOAD);
    const after = snap('local', at2, [fp(deployment({ time: '2026-08-09T12:04:00Z' }))], WORKLOAD);
    // managedFields is evidence about a change, never a change in itself.
    expect(diffSnapshots(before, after).events).toEqual([]);
  });

  it('folds pod churn under the rollout that caused it', () => {
    const podLine = (name: string) =>
      `shop ${name} worker-1 Running ReplicaSet web-7d9f8b web:1.0 0 true 2026-01-01T00:00:00Z uid-${name}`;
    const sections = ['WORKLOADS', 'PODS'];
    const before = snap('local', at1, [fp(deployment()), ...parsePodTable(podLine('web-old'))], sections);
    const after = snap('local', at2, [fp(deployment({ image: 'registry.io/team/web:2.0' })), ...parsePodTable(podLine('web-new'))], sections);

    const evs = diffSnapshots(before, after).events;
    const rollout = evs.find((e) => e.kind === 'image')!;
    const podEvents = evs.filter((e) => e.objectKind === 'Pod');
    expect(rollout).toBeTruthy();
    // The pods are still recorded, but attributed rather than shouted about.
    expect(podEvents).toHaveLength(2); // one gone, one new — neither invented
    expect(podEvents.every((e) => e.causedBy === rollout.id)).toBe(true);
    expect(podEvents.every((e) => e.severity === 'info')).toBe(true);
    expect(summaries(podEvents).join(' ')).toContain('from Deployment web');
  });

  it('caps a runaway capture and says so', () => {
    const many = (n: number, image: string) =>
      Array.from({ length: n }, (_, i) => {
        const d = deployment({ image });
        d.metadata.name = `app-${i}`;
        d.metadata.uid = `uid-${i}`;
        return fp(d);
      });
    const before = snap('local', at1, many(50, 'a:1'), WORKLOAD);
    const after = snap('local', at2, many(50, 'a:2'), WORKLOAD);
    const { events, notes } = diffSnapshots(before, after, { maxEvents: 10 });
    expect(events).toHaveLength(10);
    expect(notes.join(' ')).toMatch(/40 lower-severity changes were dropped/);
  });
});

describe('field comparison', () => {
  it('reports added, removed and altered fields', () => {
    const changes = fieldChanges({ a: '1', b: '2' }, { a: '9', c: '3' });
    expect(changes).toEqual([
      { path: 'a', from: '1', to: '9' },
      { path: 'b', from: '2', to: undefined },
      { path: 'c', from: undefined, to: '3' },
    ]);
  });
});

describe('since parsing', () => {
  it('understands relative windows and ISO stamps', () => {
    const now = Date.now();
    expect(parseSince('24h')!).toBeGreaterThan(now - 24 * 3600_000 - 5000);
    expect(parseSince('30m')!).toBeGreaterThan(now - 30 * 60_000 - 5000);
    expect(parseSince('7d')!).toBeLessThan(now);
    expect(parseSince('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(parseSince('nonsense')).toBeUndefined();
    expect(parseSince(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Store — real files, in a test-only source so nothing else is touched
// ---------------------------------------------------------------------------

describe('store', () => {
  const SOURCE = '__historytest__';

  afterAll(async () => {
    for (const f of [paths.statePath(SOURCE), paths.logPath(SOURCE), paths.archivePath(SOURCE)]) {
      await fs.rm(f, { force: true });
    }
  });

  const event = (i: number, over: Partial<any> = {}) => ({
    id: `id-${i}`,
    at: new Date(Date.UTC(2026, 7, 9, 12, i)).toISOString(),
    source: SOURCE,
    kind: 'image',
    severity: 'notice',
    objectKind: 'Deployment',
    name: `app-${i}`,
    namespace: 'shop',
    summary: `image bumped ${i}`,
    fields: [],
    ...over,
  });

  it('round-trips a snapshot', async () => {
    const s = snap(SOURCE, '2026-08-09T12:00:00Z', [fp(deployment())], WORKLOAD);
    await saveSnapshot(s);
    const back = await loadSnapshot(SOURCE);
    expect(back?.objects['Deployment/shop/web'].spec['image.main']).toBe('registry.io/team/web:1.0');
  });

  it('returns changes newest first', async () => {
    await fs.rm(paths.logPath(SOURCE), { force: true });
    await appendChanges(SOURCE, [event(1), event(2), event(3)] as any);
    const back = await readChanges(SOURCE, { limit: 10 });
    expect(back.map((e) => e.id)).toEqual(['id-3', 'id-2', 'id-1']);
  });

  it('filters by object, severity, text and time', async () => {
    await fs.rm(paths.logPath(SOURCE), { force: true });
    await appendChanges(SOURCE, [
      event(1, { name: 'web', severity: 'warning', summary: 'cordoned', objectKind: 'Node', namespace: undefined }),
      event(2, { name: 'api' }),
    ] as any);
    expect((await readChanges(SOURCE, { severity: 'warning' })).map((e) => e.name)).toEqual(['web']);
    expect((await readChanges(SOURCE, { objectKind: 'Deployment' })).map((e) => e.name)).toEqual(['api']);
    expect((await readChanges(SOURCE, { q: 'cordon' })).map((e) => e.name)).toEqual(['web']);
    expect(await readChanges(SOURCE, { since: '2030-01-01T00:00:00Z' })).toEqual([]);
  });

  it('survives a torn final line', async () => {
    await fs.rm(paths.logPath(SOURCE), { force: true });
    await appendChanges(SOURCE, [event(1)] as any);
    await fs.appendFile(paths.logPath(SOURCE), '{"id":"broken", "at"', 'utf-8');
    const back = await readChanges(SOURCE, { limit: 10 });
    expect(back.map((e) => e.id)).toEqual(['id-1']);
  });

  it('keeps sources apart', async () => {
    const other = '__historytest2__';
    await appendChanges(other, [event(9, { name: 'elsewhere' })] as any);
    const mine = await readChanges(SOURCE, { limit: 50 });
    expect(mine.some((e) => e.name === 'elsewhere')).toBe(false);
    expect((await listSources()).some((s) => s.source === other)).toBe(true);
    await fs.rm(paths.logPath(other), { force: true });
  });
});
