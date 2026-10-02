// InferenceServices on the topology: where they sit, and what they connect to.
// The model-serving path must read ISVC → Service → workload → pods, from the
// label KServe actually sets — and a cluster without KServe must lay out
// exactly as it did before.

import { describe, it, expect } from 'vitest';
import { layoutCluster, CARD_W, type LayoutCard } from '../layout';
import { buildRelations, isvcId, svcId, deployId, podId, ISVC_LABEL } from '../relations';
import { canvasSignature } from '../topology';

const isvc = (name: string, ns = 'ai') => ({ name, namespace: ns, status: 'Ready', health: 'healthy', modelFormat: 'huggingface' });
const pod = (name: string, ns: string, labels: Record<string, string>, owner?: string) => ({
  name, namespace: ns, status: 'Running', ready: '1/1', node: 'gpu-1', restarts: 0, labels,
  owner: owner ? { kind: 'Deployment', name: owner } : null,
});
const svc = (name: string, ns: string, selector: Record<string, string> | null) =>
  ({ name, namespace: ns, type: 'ClusterIP', selector: selector ? JSON.stringify(selector) : 'None' });
const wl = (name: string, ns: string) => ({ name, namespace: ns, kind: 'Deployment', ready: '1/1', replicas: 1 });

const overlap = (a: LayoutCard, b: LayoutCard) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('InferenceService relations', () => {
  const predictorPod = pod('llama-predictor-00001-deployment-abc', 'ai',
    { [ISVC_LABEL]: 'llama', app: 'llama-predictor' }, 'llama-predictor-00001-deployment');
  const input = {
    containers: [], nodes: [{ name: 'gpu-1' }],
    inferenceServices: [isvc('llama')],
    pods: [predictorPod, pod('other-1', 'ai', { app: 'other' }, 'other')],
    services: [svc('llama-predictor', 'ai', { app: 'llama-predictor' }), svc('other', 'ai', { app: 'other' })],
    deployments: [wl('llama-predictor-00001-deployment', 'ai'), wl('other', 'ai')],
  };

  it('connects the ISVC to the Service and workload of its labelled pods', () => {
    const rels = buildRelations(input);
    const from = rels.filter((r) => r.source === isvcId('ai', 'llama'));
    expect(from.map((r) => `${r.kind}:${r.target}`).sort()).toEqual([
      `deploys:${deployId('ai', 'llama-predictor-00001-deployment')}`,
      `serves:${svcId('ai', 'llama-predictor')}`,
    ]);
    expect(from.every((r) => !r.inferred)).toBe(true);
  });

  it('forms one continuous request path down to the node', () => {
    const rels = buildRelations(input);
    const has = (s: string, t: string) => rels.some((r) => r.source === s && r.target === t);
    const p = podId('ai', predictorPod.name);
    expect(has(isvcId('ai', 'llama'), svcId('ai', 'llama-predictor'))).toBe(true);
    expect(has(svcId('ai', 'llama-predictor'), p)).toBe(true);
    expect(has(deployId('ai', 'llama-predictor-00001-deployment'), p)).toBe(true);
    expect(has(p, 'k8snode-gpu_1')).toBe(true);
  });

  it('never connects an ISVC to unrelated objects', () => {
    const rels = buildRelations(input);
    expect(rels.some((r) => r.source === isvcId('ai', 'llama') && (r.target.includes('other')))).toBe(false);
  });

  it('falls back to KServe naming, marked inferred, when no predictor pod exists', () => {
    const rels = buildRelations({ ...input, pods: [] });
    const from = rels.filter((r) => r.source === isvcId('ai', 'llama'));
    expect(from.length).toBe(2);
    expect(from.every((r) => r.inferred)).toBe(true);
  });

  it('stays out of other namespaces', () => {
    const rels = buildRelations({ ...input, inferenceServices: [isvc('llama', 'elsewhere')] });
    expect(rels.some((r) => r.source.startsWith('isvc-'))).toBe(false);
  });
});

describe('InferenceService layout', () => {
  const base = {
    containers: [], nodes: [{ name: 'gpu-1' }],
    pods: [pod('p1', 'ai', {}), pod('p2', 'web', {})],
    services: [svc('s1', 'ai', null)],
    deployments: [wl('d1', 'ai')],
  };

  it('puts InferenceServices in their own stage, left of Services, without overlaps', () => {
    const l = layoutCluster({ ...base, inferenceServices: [isvc('a'), isvc('b'), isvc('c')] });
    const cards = [...l.cards.values()];
    const isvcCards = cards.filter((c) => c.kind === 'isvc');
    const svcCard = cards.find((c) => c.kind === 'service')!;
    expect(isvcCards).toHaveLength(3);
    for (const c of isvcCards) expect(c.x + CARD_W).toBeLessThan(svcCard.x);
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) expect(overlap(cards[i], cards[j])).toBe(false);
    }
  });

  it('gives a namespace holding only an InferenceService its own band', () => {
    const l = layoutCluster({ ...base, inferenceServices: [isvc('solo', 'models-only')] });
    expect(l.groups.some((g) => g.id === 'ns-group-models-only')).toBe(true);
    expect(l.cards.get(isvcId('models-only', 'solo'))).toBeTruthy();
  });

  it('lays out a cluster without KServe exactly as before', () => {
    const without = layoutCluster(base);
    const empty = layoutCluster({ ...base, inferenceServices: [] });
    expect([...empty.cards.entries()]).toEqual([...without.cards.entries()]);
    expect(empty.groups).toEqual(without.groups);
  });
});

describe('canvas signature', () => {
  it('changes when an InferenceService changes state', () => {
    const k = (status: string) => ({ pods: [], services: [], deployments: [], nodes: [], inferenceServices: [{ ...isvc('a'), status }] });
    expect(canvasSignature([], k('Ready'))).not.toBe(canvasSignature([], k('RevisionMissing')));
  });
});
