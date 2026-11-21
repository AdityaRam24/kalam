// Change History, readable: one rollout is one story, restarts are one line
// per workload, field names read like English, and the digest says what
// happened. The main case runs a real rollout through the real diff engine.

import { describe, it, expect } from 'vitest';
import { fingerprintObject, parsePodTable } from '../history/fingerprint.js';
import { diffSnapshots } from '../history/diff.js';
import { objectKey, type Fingerprint, type Snapshot } from '../history/model.js';
import { buildStories, digestOf, fieldLabel, workloadOf, type ChangeEventLike } from '../../src/lib/historyStory.js';

function snap(at: string, fps: Fingerprint[], sections: string[]): Snapshot {
  const objects: Record<string, Fingerprint> = {};
  for (const fp of fps) objects[objectKey(fp.kind, fp.name, fp.namespace)] = fp;
  return { version: 1, source: 'local', at, sections, objects };
}

const deployment = (image: string, replicas = 3) => fingerprintObject({
  kind: 'Deployment',
  metadata: {
    name: 'web', namespace: 'shop', uid: 'uid-web', generation: 4, creationTimestamp: '2026-01-01T00:00:00Z',
    managedFields: [{ manager: 'helm', operation: 'Apply', time: '2026-11-20T10:00:00Z' }],
  },
  spec: {
    replicas, selector: { matchLabels: { app: 'web' } },
    template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'main', image }] } },
  },
  status: { observedGeneration: 4 },
})!;
const pods = (rs: string, names: string[], image: string, restarts = '0') => parsePodTable(names.map((n) =>
  `shop ${n} worker-1 Running ReplicaSet ${rs} ${image} ${restarts} true 2026-11-20T09:00:00Z uid-${n}`).join('\n'));

describe('fieldLabel', () => {
  it('names fingerprint paths the way an operator would', () => {
    expect(fieldLabel('image.main')).toBe('Image (container main)');
    expect(fieldLabel('init.image.migrate')).toBe('Init container image (container migrate)');
    expect(fieldLabel('limits.main')).toBe('Resource limits (container main)');
    expect(fieldLabel('replicas')).toBe('Replicas');
    expect(fieldLabel('unschedulable')).toBe('Cordoned (unschedulable)');
    expect(fieldLabel('label.app')).toBe('Label app');
    expect(fieldLabel('podAnnotation.sidecar.istio.io/inject')).toBe('Pod annotation sidecar.istio.io/inject');
    expect(fieldLabel('storageUri')).toBe('Model location (storageUri)');
    expect(fieldLabel('somethingNew')).toBe('somethingNew');
  });
});

describe('workloadOf', () => {
  it('follows a ReplicaSet back to its Deployment', () => {
    expect(workloadOf('ReplicaSet/shop/web-7d9f8b6c4')).toEqual({ kind: 'Deployment', name: 'web', namespace: 'shop' });
    expect(workloadOf('StatefulSet/db/pg')).toEqual({ kind: 'StatefulSet', name: 'pg', namespace: 'db' });
    expect(workloadOf('Job/batch/report-29012345')).toEqual({ kind: 'CronJob', name: 'report', namespace: 'batch' });
    expect(workloadOf(undefined)).toBeUndefined();
  });
});

describe('buildStories on real diff output', () => {
  const S = ['WORKLOADS', 'PODS'];
  const before = snap('2026-11-20T10:00:00Z', [deployment('registry.io/team/web:1.0'), ...pods('web-7d9f8b6c4', ['web-7d9f8b6c4-a', 'web-7d9f8b6c4-b', 'web-7d9f8b6c4-c'], 'web:1.0')], S);
  const after = snap('2026-11-20T10:05:00Z', [deployment('registry.io/team/web:1.1'), ...pods('web-5c6d7e8f9', ['web-5c6d7e8f9-x', 'web-5c6d7e8f9-y', 'web-5c6d7e8f9-z'], 'web:1.1')], S);
  const events = diffSnapshots(before, after).events as ChangeEventLike[];

  it('the diff engine emits one row per object…', () => {
    expect(events.length).toBe(7); // the Deployment + 3 pods created + 3 pods deleted
  });

  it('…and the story view folds the rollout into one entry', () => {
    const stories = buildStories(events);
    expect(stories).toHaveLength(1);
    const s = stories[0];
    expect(s.title).toBe('New version rolled out: Deployment shop/web');
    expect(s.detail).toBe('web:1.0 → web:1.1 · 3 pods replaced');
    expect(s.counts).toMatchObject({ podsCreated: 3, podsDeleted: 3 });
    expect(s.related).toHaveLength(6);
    expect(s.root!.objectKind).toBe('Deployment');
  });

  it('can still show every raw event', () => {
    expect(buildStories(events, { group: false })).toHaveLength(7);
  });

  it('pod churn without a workload change becomes one line per workload', () => {
    const b = snap('2026-11-20T11:00:00Z', [deployment('registry.io/team/web:1.1'), ...pods('web-5c6d7e8f9', ['web-5c6d7e8f9-x'], 'web:1.1')], S);
    const a = snap('2026-11-20T11:05:00Z', [deployment('registry.io/team/web:1.1'), ...pods('web-5c6d7e8f9', ['web-5c6d7e8f9-q'], 'web:1.1')], S);
    const st = buildStories(diffSnapshots(b, a).events as ChangeEventLike[]);
    expect(st).toHaveLength(1);
    expect(st[0].title).toBe('Pods of Deployment shop/web changed');
    expect(st[0].detail).toBe('1 pod replaced');
    expect(st[0].root).toBeUndefined();
  });

  it('restarts across pods and captures add up per workload', () => {
    const b = snap('2026-11-20T12:00:00Z', [...pods('api-6f7a8b9c0', ['api-6f7a8b9c0-1', 'api-6f7a8b9c0-2'], 'api:2', '0')], ['PODS']);
    const a = snap('2026-11-20T12:05:00Z', [...pods('api-6f7a8b9c0', ['api-6f7a8b9c0-1', 'api-6f7a8b9c0-2'], 'api:2', '4')], ['PODS']);
    const st = buildStories(diffSnapshots(b, a).events as ChangeEventLike[]);
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ title: 'Containers restarted in Deployment shop/api', severity: 'warning' });
    expect(st[0].detail).toBe('8 restarts across 2 pods (2 observations)');
  });

  it('names the crash reason a restart event carries instead of hiding it as "+1 more"', () => {
    const b = snap('2026-11-20T12:00:00Z', [...pods('api-6f7a8b9c0', ['api-6f7a8b9c0-1'], 'api:2', '0')], ['PODS']);
    const crash = parsePodTable('shop api-6f7a8b9c0-1 worker-1 Running ReplicaSet api-6f7a8b9c0 api:2 3 false 2026-11-20T09:00:00Z uid-api-6f7a8b9c0-1 CrashLoopBackOff');
    const a = { ...snap('2026-11-20T12:05:00Z', crash, ['PODS']), features: ['podWaiting'] };
    const evs = diffSnapshots({ ...b, features: ['podWaiting'] }, a).events as ChangeEventLike[];
    expect(evs[0].summary).toMatch(/\(\+\d more\)$/); // what the raw log shows
    const [s] = buildStories(evs);
    expect(s.title).toBe('Containers crash-looping in Deployment shop/api: CrashLoopBackOff');
  });
});

describe('titles for other kinds of change', () => {
  const ev = (over: Partial<ChangeEventLike>): ChangeEventLike => ({
    id: over.id || Math.random().toString(36), at: '2026-11-20T10:00:00Z', kind: 'spec', severity: 'info', objectKind: 'Deployment',
    name: 'web', namespace: 'shop', summary: '', fields: [], ...over,
  });

  it('scale, cordon, ConfigMap, Secret, settings', () => {
    const t = (e: ChangeEventLike) => { const s = buildStories([e])[0]; return [s.title, s.detail]; };
    expect(t(ev({ kind: 'scaled', fields: [{ path: 'replicas', from: '3', to: '5' }] }))).toEqual(['Deployment shop/web scaled up', 'Replicas 3 → 5']);
    expect(t(ev({ kind: 'cordon', objectKind: 'Node', name: 'gpu-2', namespace: undefined, fields: [{ path: 'unschedulable', to: 'true' }] }))[0])
      .toBe('Node gpu-2 cordoned — no new pods will be scheduled on it');
    expect(t(ev({ kind: 'config', objectKind: 'ConfigMap', name: 'api-config', fields: [{ path: 'revision', from: '1', to: '2' }] }))[0]).toBe('ConfigMap contents changed: shop/api-config');
    expect(t(ev({ kind: 'config', objectKind: 'Secret', name: 'db', fields: [{ path: 'revision', from: '1', to: '2' }] }))[1]).toMatch(/never reads secret values/);
    expect(t(ev({ kind: 'spec', fields: [{ path: 'limits.main', from: 'cpu=1', to: 'cpu=2' }, { path: 'env.main', from: 'a', to: 'b' }] })))
      .toEqual(['Settings changed: Deployment shop/web', 'Resource limits (container main): cpu=1 → cpu=2 · also: Environment variables (container main)']);
    expect(t(ev({ kind: 'image', objectKind: 'InferenceService', name: 'llama', fields: [{ path: 'storageUri', from: 's3://m/v1', to: 's3://m/v2' }] })))
      .toEqual(['New model deployed to InferenceService shop/llama', 's3://m/v1 → s3://m/v2']);
  });

  it('pods stuck in CrashLoopBackOff name the reason', () => {
    const e = ev({ kind: 'lifecycle', severity: 'warning', objectKind: 'Pod', name: 'api-1', owner: 'ReplicaSet/shop/api-6f7a8b9c0', fields: [{ path: 'waiting', to: 'CrashLoopBackOff' }] });
    const [s] = buildStories([e]);
    expect(s.title).toBe('Pods of Deployment shop/api stuck: CrashLoopBackOff');
    expect(s.severity).toBe('warning');
  });
});

describe('digestOf', () => {
  it('says what happened, warnings first, with a filter for each line', () => {
    const ev = (id: string, kind: string, name: string, severity: 'info' | 'notice' | 'warning' = 'notice', extra: Partial<ChangeEventLike> = {}): ChangeEventLike =>
      ({ id, at: '2026-11-20T10:00:00Z', kind, severity, objectKind: 'Deployment', name, namespace: 'shop', summary: '', fields: [], ...extra });
    const stories = buildStories([
      ev('1', 'image', 'web'), ev('2', 'image', 'api'), ev('3', 'scaled', 'web'),
      ev('4', 'cordon', 'gpu-2', 'warning', { objectKind: 'Node', namespace: undefined, fields: [{ path: 'unschedulable', to: 'true' }] }),
      ev('5', 'restarted', 'api-1', 'warning', { objectKind: 'Pod', owner: 'ReplicaSet/shop/api-6f7a8b9c0', fields: [{ path: 'restarts', from: '0', to: '3' }] }),
    ]);
    const d = digestOf(stories);
    expect(d.map((x) => x.text)).toEqual([
      '1 node cordoned (gpu-2)',
      '3 container restarts in 1 workload (api)',
      '2 new versions rolled out (web, api)',
      '1 scale change (web)',
    ]);
    expect(d[1].filter).toEqual({ category: 'restarted' });
  });
});
