import { describe, expect, it } from 'vitest';
import { suspectsFor } from '../history/suspects.js';
import type { ChangeEvent } from '../history/model.js';
import type { Finding } from '../k8s/why.js';

const ev = (o: Partial<ChangeEvent>): ChangeEvent => ({
  id: Math.random().toString(36), at: '2026-09-01T10:00:00Z', source: 'local', kind: 'spec', severity: 'info',
  objectKind: 'Deployment', name: 'web', namespace: 'shop', summary: '', fields: [], ...o,
});
const finding = (o: Partial<Finding>): Finding => ({
  id: 'f', object: { kind: 'Pod', name: 'web-abc12-xyz', namespace: 'shop' }, severity: 'critical', category: 'image',
  title: 't', why: 'w', evidence: [], fix: [], since: '2026-09-01T10:03:00Z', ...o,
});
const ctx = { ownerOf: () => 'Deployment/shop/web', nodeOf: () => 'n1', now: Date.parse('2026-09-01T12:00:00Z') };

describe('suspectsFor', () => {
  it('ranks the owner’s image change just before the failure first', () => {
    const s = suspectsFor(finding({}), [
      ev({ kind: 'scaled', at: '2026-09-01T09:00:00Z' }),
      ev({ kind: 'image', at: '2026-09-01T10:02:00Z', summary: 'image web:1 → web:2' }),
      ev({ kind: 'config', objectKind: 'ConfigMap', name: 'other', at: '2026-09-01T10:01:00Z' }),
    ], ctx);
    expect(s[0].change.kind).toBe('image');
    expect(s[0].reason).toMatch(/owns this pod; image change; 1 min before it started failing/);
  });

  it('a change after the failure began is demoted', () => {
    const s = suspectsFor(finding({}), [ev({ kind: 'image', at: '2026-09-01T11:00:00Z' })], ctx);
    expect(s).toEqual([]);
  });

  it('the root cause object wins even across namespaces', () => {
    const s = suspectsFor(
      finding({ object: { kind: 'Certificate', name: 'tls', namespace: 'shop' }, category: 'certificate', rootCause: { kind: 'ClusterIssuer', name: 'ca', reason: 'gone' } }),
      [ev({ kind: 'deleted', objectKind: 'ClusterIssuer', name: 'ca', namespace: undefined, at: '2026-09-01T10:00:00Z' })], ctx);
    expect(s[0].reason).toMatch(/ClusterIssuer ca, the root cause/);
  });

  it('a change whose impact names the failing Service is a suspect', () => {
    const s = suspectsFor(
      finding({ object: { kind: 'Service', name: 'web', namespace: 'shop' }, category: 'labels', since: undefined }),
      [ev({ kind: 'spec', objectKind: 'Deployment', name: 'api', impact: ['Service web no longer selects these pods'], at: '2026-09-01T11:30:00Z' })], ctx);
    expect(s[0].reason).toMatch(/impact note names this object/);
  });
});
