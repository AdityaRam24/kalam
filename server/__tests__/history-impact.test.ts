// Labels, annotations and the contract CRDs in Change History — and the
// "what this change does" sentence attached to each one.

import { describe, expect, it } from 'vitest';
import { fingerprintObject, parsePodTable } from '../history/fingerprint.js';
import { diffSnapshots } from '../history/diff.js';
import { objectKey, type Fingerprint, type Snapshot } from '../history/model.js';

const ALL = ['WORKLOADS', 'PODS', 'NET', 'STORAGE', 'RBAC', 'CLUSTER', 'CONFIGMAPS', 'SECRETS', 'CERTS', 'CLUSTERISSUERS', 'KSERVE', 'CLUSTERRUNTIMES', 'ISTIO', 'INGRESSCLASSES'];
const FEATURES = ['meta', 'podWaiting'];

function snap(at: string, objs: any[], features: string[] | undefined = FEATURES, extra: Fingerprint[] = []): Snapshot {
  const objects: Record<string, Fingerprint> = {};
  for (const o of objs) {
    const f = fingerprintObject(o)!;
    objects[objectKey(f.kind, f.name, f.namespace)] = f;
  }
  for (const f of extra) objects[objectKey(f.kind, f.name, f.namespace)] = f;
  return { version: 1, source: 'local', at, sections: ALL, objects, features };
}
const T0 = '2026-09-01T10:00:00Z';
const T1 = '2026-09-01T10:05:00Z';

const deploy = (labels: Record<string, string>, extra: any = {}) => ({
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'shop', uid: 'u1', ...(extra.meta || {}) },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'web' } },
    template: { metadata: { labels, annotations: extra.podAnnotations }, spec: { containers: [{ name: 'c', image: 'web:1', envFrom: extra.envFrom }], volumes: extra.volumes } },
  },
});
const service = (selector: Record<string, string>) => ({ kind: 'Service', metadata: { name: 'web', namespace: 'shop', uid: 's1' }, spec: { selector, ports: [{ port: 80 }] } });
const cm = (name: string) => ({ kind: 'ConfigMap', name, namespace: 'shop', spec: { revision: '1' } }) as Fingerprint;

describe('labels and annotations', () => {
  it('a pod-template label edit says which Service lost its pods', () => {
    const prev = snap(T0, [deploy({ app: 'web', tier: 'fe' }), service({ app: 'web', tier: 'fe' })]);
    const next = snap(T1, [deploy({ app: 'web', tier: 'frontend' }), service({ app: 'web', tier: 'fe' })]);
    const ev = diffSnapshots(prev, next).events.find((e) => e.objectKind === 'Deployment')!;
    expect(ev.impact?.[0]).toMatch(/Service web no longer selects these pods/);
  });

  it('an object label with meaning is a warning and explained', () => {
    const ns = (labels: any) => ({ kind: 'Namespace', metadata: { name: 'shop', uid: 'n', labels } });
    const ev = diffSnapshots(snap(T0, [ns({ 'istio-injection': 'enabled' })]), snap(T1, [ns({})])).events[0];
    expect(ev.kind).toBe('label');
    expect(ev.severity).toBe('warning');
    expect(ev.summary).toMatch(/label istio-injection removed \(was enabled\)/);
    expect(ev.impact?.join(' ')).toMatch(/will NOT get an Istio sidecar/);
  });

  it('a cert-manager annotation pointing at a missing ClusterIssuer', () => {
    const ing = (ann: any) => ({ kind: 'Ingress', metadata: { name: 'web', namespace: 'shop', uid: 'i', annotations: ann }, spec: { rules: [] } });
    const ci = { kind: 'ClusterIssuer', metadata: { name: 'letsencrypt', uid: 'c' }, spec: { acme: {} }, status: { conditions: [{ type: 'Ready', status: 'True' }] } };
    const ev = diffSnapshots(snap(T0, [ing({}), ci]), snap(T1, [ing({ 'cert-manager.io/cluster-issuer': 'letsencrypt-prod' }), ci])).events[0];
    expect(ev.kind).toBe('annotation');
    expect(ev.impact).toContain('ClusterIssuer letsencrypt-prod does not exist — cert-manager cannot issue this certificate.');
  });

  it('does not flood after upgrading from a snapshot without metadata', () => {
    const d = deploy({ app: 'web' }, { meta: { labels: { team: 'a' }, annotations: { owner: 'x' } } });
    const prev = snap(T0, [d], undefined);
    expect(diffSnapshots(prev, snap(T1, [d])).events).toEqual([]);
  });

  it('ignores bookkeeping annotations', () => {
    const d = (v: string) => deploy({ app: 'web' }, { meta: { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': v, 'example.com/last-sync': v } } });
    expect(diffSnapshots(snap(T0, [d('1')]), snap(T1, [d('2')])).events).toEqual([]);
  });
});

describe('references and deletions', () => {
  it('a deleted ConfigMap names the workloads still using it', () => {
    const d = deploy({ app: 'web' }, { envFrom: [{ configMapRef: { name: 'web-config' } }] });
    const ev = diffSnapshots(snap(T0, [d], FEATURES, [cm('web-config')]), snap(T1, [d])).events.find((e) => e.kind === 'deleted')!;
    expect(ev.impact?.[0]).toMatch(/Still referenced by Deployment web/);
  });

  it('a new volume pointing at a ConfigMap that does not exist', () => {
    const before = deploy({ app: 'web' });
    const after = deploy({ app: 'web' }, { volumes: [{ name: 'cfg', configMap: { name: 'nope' } }] });
    const ev = diffSnapshots(snap(T0, [before]), snap(T1, [after])).events[0];
    expect(ev.impact?.[0]).toMatch(/References ConfigMap nope \(volume cfg\), which does not exist/);
  });

  it('an issuer going not-Ready lists the certificates it breaks', () => {
    const iss = (st: string) => ({ kind: 'ClusterIssuer', metadata: { name: 'ca', uid: 'c' }, spec: { ca: { secretName: 'k' } }, status: { conditions: [{ type: 'Ready', status: st }] } });
    const cert = { kind: 'Certificate', metadata: { name: 'web-tls', namespace: 'shop', uid: 'x' }, spec: { issuerRef: { kind: 'ClusterIssuer', name: 'ca' }, secretName: 'web-tls' } };
    const ev = diffSnapshots(snap(T0, [iss('True'), cert]), snap(T1, [iss('False'), cert])).events[0];
    expect(ev.summary).toMatch(/no longer Ready/);
    expect(ev.severity).toBe('warning');
    expect(ev.impact?.[0]).toMatch(/1 certificate\(s\) depend on it: shop\/web-tls/);
  });

  it('a model swap on an InferenceService reads as a deploy', () => {
    const isvc = (uri: string) => ({ kind: 'InferenceService', metadata: { name: 'llm', namespace: 'ml', uid: 'i' }, spec: { predictor: { model: { modelFormat: { name: 'vllm' }, storageUri: uri } } } });
    const ev = diffSnapshots(snap(T0, [isvc('pvc://m/v1')]), snap(T1, [isvc('pvc://m/v2')])).events[0];
    expect(ev.kind).toBe('image');
    expect(ev.summary).toMatch(/model pvc:\/\/m\/v1 → pvc:\/\/m\/v2/);
  });
});

describe('pod waiting reason', () => {
  const row = (waiting: string) => `shop web-1 n1 Running ReplicaSet web-abc web:1 0 false 2026-01-01T00:00:00Z uid1 ${waiting}`;
  it('parses the column and reports the moment a pod starts failing', () => {
    expect(parsePodTable(row('ImagePullBackOff'))[0].spec.waiting).toBe('ImagePullBackOff');
    const s = (w: string): Snapshot => ({ version: 1, source: 'local', at: T0, sections: ['PODS'], features: FEATURES, objects: Object.fromEntries(parsePodTable(row(w)).map((f) => [objectKey(f.kind, f.name, f.namespace), f])) });
    const ev = diffSnapshots(s('<none>'), { ...s('ImagePullBackOff'), at: T1 }).events[0];
    expect(ev.summary).toMatch(/container waiting: ImagePullBackOff/);
    expect(ev.severity).toBe('warning');
  });

  it('an old 11-column table still parses', () => {
    expect(parsePodTable('shop web-1 n1 Running ReplicaSet web-abc web:1 0 true 2026-01-01T00:00:00Z uid1')[0].spec.waiting).toBeUndefined();
  });
});
