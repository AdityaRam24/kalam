// The gate every view reads through: malformed records must never reach a
// render, and well-formed ones must pass through untouched.

import { describe, it, expect } from 'vitest';
import { sanitizeK8s, sanitizeContainers, str, num } from '../sanitize';

const goodPod = {
  name: 'web-1', namespace: 'shop', status: 'Running', displayStatus: 'Running', health: 'healthy',
  ready: '1/1', ip: '10.0.0.1', node: 'n1', restarts: 2, labels: { app: 'web' },
  owner: { kind: 'Deployment', name: 'web' },
  containers: [{ name: 'c', image: 'nginx', ready: true, state: 'running', requests: { cpuMilli: 100, memBytes: 1, gpu: 0 }, limits: { cpuMilli: 0, memBytes: 0, gpu: 0 } }],
  claims: ['data'], created: '2026-01-01T00:00:00Z',
};

describe('sanitizeK8s', () => {
  it('passes valid data through unchanged', () => {
    const out = sanitizeK8s({ pods: [goodPod], services: [], deployments: [], nodes: [], inferenceServices: [] });
    expect(out.pods[0]).toEqual(goodPod);
  });

  it('drops records without a name and nulls inside lists', () => {
    const out = sanitizeK8s({ pods: [null, { namespace: 'x' }, goodPod, 7, 'x'], nodes: [{ name: undefined }, null] });
    expect(out.pods.map((p) => p.name)).toEqual(['web-1']);
    expect(out.nodes).toEqual([]);
  });

  it('coerces wrong types into the shapes the views expect', () => {
    const out = sanitizeK8s({
      pods: [{ name: 'p', status: 7, ready: null, restarts: 'x', labels: { a: 1, b: 'ok' }, containers: [null, { name: null }], owner: 'weird' }],
      services: [{ name: 's', selector: '{not json', ports: 80 }],
      deployments: [{ name: 'd', ready: {}, available: '3', health: 'bogus' }],
      nodes: [{ name: 'n', status: null, pressure: 'DiskPressure', schedulable: 'no' }],
      inferenceServices: [{ name: 'i', health: 3 }],
    });
    const p = out.pods[0];
    expect(p.status).toBe('7');
    expect(p.ready).toBe('0/0');
    expect(p.restarts).toBe(0);
    expect(p.labels).toEqual({ b: 'ok' });
    expect(p.containers).toEqual([expect.objectContaining({ name: '?', state: 'unknown' })]);
    expect(p.owner).toBeNull();
    expect(out.services[0]).toMatchObject({ selector: 'None', ports: '80' });
    expect(out.deployments[0]).toMatchObject({ ready: '0/0', available: 3, health: undefined });
    expect(out.nodes[0]).toMatchObject({ status: 'Unknown', pressure: [], schedulable: true });
    expect(out.inferenceServices[0].health).toBe('unknown');
  });

  it('collapses duplicates that would collide on the canvas, keeping hosts apart', () => {
    const out = sanitizeK8s({ pods: [
      { name: 'dup', namespace: 'a' }, { name: 'dup', namespace: 'a' },
      { name: 'dup', namespace: 'a', host: 'vm2' },
    ] });
    expect(out.pods).toHaveLength(2);
  });

  it('survives a payload that is not an object at all', () => {
    for (const bad of [null, undefined, 7, 'x', []]) {
      expect(sanitizeK8s(bad)).toEqual({ pods: [], services: [], deployments: [], nodes: [], inferenceServices: [] });
    }
  });
});

describe('sanitizeContainers', () => {
  it('drops id-less containers and names unnamed ones by id', () => {
    const out = sanitizeContainers([{ id: null, name: null }, { id: 'abcdef1234567890', name: null, status: 7 }, null]);
    expect(out).toEqual([expect.objectContaining({ id: 'abcdef1234567890', name: 'abcdef123456', status: '7' })]);
  });
});

describe('helpers', () => {
  it('str and num never throw and never return the wrong type', () => {
    expect(str({})).toBe('');
    expect(str(null, 'd')).toBe('d');
    expect(num('12')).toBe(12);
    expect(num('abc', 5)).toBe(5);
    expect(num(Infinity)).toBe(0);
  });
});

import { amountsText, sanitizeInspect, sanitizeObjectHistory, sanitizeChangeIndex, sanitizeContainerDetail } from '../sanitize';

describe('drawer payloads', () => {
  it('formats the list-shaped requests/limits as text (the pod-click crash)', () => {
    expect(amountsText({ cpuMilli: 250, memBytes: 512 * 1024 ** 2, gpu: 0 })).toBe('cpu 250m, mem 512Mi');
    expect(amountsText({ cpuMilli: 4000, memBytes: 32 * 1024 ** 3, gpu: 2 })).toBe('cpu 4, mem 32Gi, gpu 2');
    expect(amountsText('cpu=1')).toBe('cpu=1');
    expect(amountsText(null)).toBe('');
    const c = sanitizeContainerDetail({ name: 'x', requests: { cpuMilli: 100, memBytes: 0, gpu: 0 }, limits: {} });
    expect(typeof c.requests).toBe('string');
    expect(c.limits).toBeUndefined();
  });

  it('makes a malformed inspect payload renderable', () => {
    const d = sanitizeInspect({ summary: [{ label: 'x', value: null }, null], labels: null, annotations: { a: 1 },
      containers: [{ name: null, ports: 3 }], groups: [{ title: 'S', items: [{ kind: null, name: 5 }] }, { items: null }],
      events: [{ type: null, message: 7 }], yaml: null, describe: 5 });
    expect(d.summary).toEqual([{ label: 'x', value: '' }]);
    expect(d.labels).toEqual({});
    expect(d.annotations).toEqual({ a: '1' });
    expect(d.containers[0]).toMatchObject({ name: '?', ports: '3' });
    expect(d.groups[0].items[0]).toMatchObject({ kind: '?', name: '5' });
    expect(d.groups[1].items).toEqual([]);
    expect(d.events[0]).toMatchObject({ type: 'Normal', message: '7' });
    expect(d.yaml).toBe('');
    expect(d.describe).toBe('5');
  });

  it('normalizes history and heatmap payloads', () => {
    expect(sanitizeObjectHistory({ changes: [{ at: null, fields: null }], revisions: [{ images: null }] }))
      .toMatchObject({ changes: [{ at: '', fields: [] }], revisions: [{ images: [], changed: [] }] });
    expect(sanitizeChangeIndex({ a: { count: 'x', lastAt: 'bad' }, b: { lastAt: '2026-01-01T00:00:00Z', count: '3' } }))
      .toEqual({ b: { count: 3, lastAt: '2026-01-01T00:00:00Z', kind: 'spec', severity: 'info', summary: '' } });
  });
});
