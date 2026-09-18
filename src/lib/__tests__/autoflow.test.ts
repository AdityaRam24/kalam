// Properties the auto flow layout must hold for any cluster.
//
// The failures these exist to prevent, in order of how badly they hurt:
//
//   1. Grouping vanishing. Plain dagre returns a correct flow with no bands at
//      all, so on a 12-namespace cluster you get a beautiful graph of cards you
//      cannot attribute to anything.
//   2. Bands colliding. A band overlapping the one above puts a "ns:" label on
//      top of another namespace's cards, which reads as corruption.
//   3. The canvas reshuffling on a poll. Dagre is insertion-order sensitive, so
//      a reordered API response must not move a single card.

import { describe, it, expect } from 'vitest';
import {
  autoFlowLayout, separateBands, BAND_PAD, BAND_PAD_TOP, MIN_BAND_GAP, MARGIN,
  type FlowNodeInput, type FlowEdgeInput,
} from '../autoflow';

const CARD_W = 190;
const CARD_H = 74;

const n = (id: string, namespace?: string, panel?: string): FlowNodeInput =>
  ({ id, namespace, panel, w: CARD_W, h: CARD_H });

/** A cluster of `nsCount` namespaces, each svc -> deploy -> pods -> shared node. */
function sampleCluster(nsCount: number, podsPer: number) {
  const nodes: FlowNodeInput[] = [];
  const edges: FlowEdgeInput[] = [];
  nodes.push(n('node:worker-1'), n('node:worker-2'));
  for (let i = 0; i < nsCount; i++) {
    const ns = `ns-${i}`;
    nodes.push(n(`svc:${ns}`, ns), n(`deploy:${ns}`, ns));
    edges.push({ source: `svc:${ns}`, target: `deploy:${ns}` });
    for (let p = 0; p < podsPer; p++) {
      nodes.push(n(`pod:${ns}-${p}`, ns));
      edges.push({ source: `deploy:${ns}`, target: `pod:${ns}-${p}` });
      edges.push({ source: `pod:${ns}-${p}`, target: p % 2 ? 'node:worker-2' : 'node:worker-1' });
    }
  }
  return { nodes, edges };
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('separateBands', () => {
  it('opens a labelled gap between bands and carries children with them', () => {
    const positions = new Map([['a1', { x: 0, y: 10 }], ['b1', { x: 0, y: 30 }]]);
    const bands = [
      { id: 'a', box: { x: 0, y: 0, w: 100, h: 20 }, children: ['a1'] },
      { id: 'b', box: { x: 0, y: 20, w: 100, h: 20 }, children: ['b1'] },
    ];
    separateBands(bands, positions);
    expect(bands[1].box.y).toBe(bands[0].box.y + bands[0].box.h + MIN_BAND_GAP);
    // the child moved by exactly the same delta as its band
    expect(positions.get('b1')!.y).toBe(30 + (bands[1].box.y - 20));
    // a band that already clears the one above is left alone
    expect(positions.get('a1')!.y).toBe(10);
  });

  it('is idempotent — running it twice moves nothing further', () => {
    const positions = new Map([['a1', { x: 0, y: 10 }], ['b1', { x: 0, y: 30 }]]);
    const bands = [
      { id: 'a', box: { x: 0, y: 0, w: 100, h: 20 }, children: ['a1'] },
      { id: 'b', box: { x: 0, y: 20, w: 100, h: 20 }, children: ['b1'] },
    ];
    separateBands(bands, positions);
    const after = JSON.stringify([bands, [...positions]]);
    separateBands(bands, positions);
    expect(JSON.stringify([bands, [...positions]])).toBe(after);
  });
});

describe('autoFlowLayout', () => {
  it('keeps every namespace as a labelled band instead of dropping grouping', () => {
    const { nodes, edges } = sampleCluster(4, 3);
    const out = autoFlowLayout(nodes, edges);
    const bands = out.groups.filter((g) => g.kind === 'namespace');
    expect(bands).toHaveLength(4);
    expect(bands.map((b) => b.label).sort()).toEqual(['ns: ns-0', 'ns: ns-1', 'ns: ns-2', 'ns: ns-3']);
    expect(out.groups.some((g) => g.kind === 'k8s')).toBe(true);
  });

  it('never overlaps one band with another', () => {
    for (const [nsCount, podsPer] of [[2, 1], [4, 3], [8, 6], [12, 10]]) {
      const { nodes, edges } = sampleCluster(nsCount, podsPer);
      const bands = autoFlowLayout(nodes, edges).groups.filter((g) => g.kind === 'namespace');
      for (let i = 0; i < bands.length; i++) {
        for (let j = i + 1; j < bands.length; j++) {
          expect(
            overlap(bands[i], bands[j]),
            `${bands[i].label} overlaps ${bands[j].label} at ${nsCount}x${podsPer}`,
          ).toBe(false);
        }
      }
    }
  });

  it('puts every banded card inside its own band', () => {
    const { nodes, edges } = sampleCluster(5, 4);
    const out = autoFlowLayout(nodes, edges);
    const bandById = new Map(out.groups.filter((g) => g.kind === 'namespace').map((g) => [g.id, g]));
    for (const node of nodes) {
      if (!node.namespace) continue;
      const band = bandById.get(`ns-group-${node.namespace}`)!;
      const p = out.positions.get(node.id)!;
      expect(p.x).toBeGreaterThanOrEqual(band.x - 0.5);
      expect(p.y).toBeGreaterThanOrEqual(band.y - 0.5);
      expect(p.x + node.w).toBeLessThanOrEqual(band.x + band.w + 0.5);
      expect(p.y + node.h).toBeLessThanOrEqual(band.y + band.h + 0.5);
    }
  });

  it('is stable when the input order changes', () => {
    const { nodes, edges } = sampleCluster(4, 4);
    const first = autoFlowLayout(nodes, edges);
    const shuffled = autoFlowLayout([...nodes].reverse(), [...edges].reverse());
    for (const node of nodes) {
      expect(shuffled.positions.get(node.id)).toEqual(first.positions.get(node.id));
    }
    expect(shuffled.groups).toEqual(first.groups);
  });

  it('keeps shared cluster nodes out of every band', () => {
    const { nodes, edges } = sampleCluster(4, 3);
    const out = autoFlowLayout(nodes, edges);
    const bands = out.groups.filter((g) => g.kind === 'namespace');
    for (const id of ['node:worker-1', 'node:worker-2']) {
      const p = out.positions.get(id)!;
      const box = { x: p.x, y: p.y, w: CARD_W, h: CARD_H };
      for (const b of bands) {
        expect(overlap(box, b), `${id} sits inside ${b.label}`).toBe(false);
      }
    }
  });

  it('lays the containers panel out beside the cluster, not on top of it', () => {
    const { nodes, edges } = sampleCluster(3, 2);
    nodes.push(n('ctr:a', undefined, 'Containers'), n('ctr:b', undefined, 'Containers'));
    const out = autoFlowLayout(nodes, edges);
    const panel = out.groups.find((g) => g.kind === 'containers')!;
    const k8s = out.groups.find((g) => g.kind === 'k8s')!;
    expect(panel).toBeTruthy();
    expect(overlap(panel, k8s)).toBe(false);
    expect(panel.x + panel.w).toBeLessThanOrEqual(k8s.x);
  });

  it('paints outer panels before the bands nested in them', () => {
    const { nodes, edges } = sampleCluster(3, 2);
    const groups = autoFlowLayout(nodes, edges).groups;
    const k8sAt = groups.findIndex((g) => g.kind === 'k8s');
    const firstBandAt = groups.findIndex((g) => g.kind === 'namespace');
    expect(k8sAt).toBeGreaterThanOrEqual(0);
    expect(k8sAt).toBeLessThan(firstBandAt);
  });

  it('insets the whole canvas to a positive origin', () => {
    const { nodes, edges } = sampleCluster(4, 3);
    const out = autoFlowLayout(nodes, edges);
    const xs = [...out.positions.values()].map((p) => p.x);
    const ys = [...out.positions.values()].map((p) => p.y);
    expect(Math.min(...xs, ...out.groups.map((g) => g.x))).toBeCloseTo(MARGIN, 5);
    expect(Math.min(...ys, ...out.groups.map((g) => g.y))).toBeCloseTo(MARGIN, 5);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  // The regression that motivated packing ranks into blocks: plain dagre put
  // every pod of a namespace in one column, which measured 1432x34440
  // (aspect 0.04) on a 316-card cluster — fit-view then shrinks every card to
  // an unreadable speck. The bar is the one the columns layout holds itself to
  // on a comparable cluster (src/lib/__tests__/layout.test.ts).
  it('stays wide rather than tall on a large cluster', () => {
    const { nodes, edges } = sampleCluster(4, 50);
    const out = autoFlowLayout(nodes, edges);
    expect(out.width / out.height).toBeGreaterThan(0.8);
  });

  it('does not grow one endless column as a namespace fills up', () => {
    const { nodes, edges } = sampleCluster(1, 40);
    const out = autoFlowLayout(nodes, edges);
    expect(out.height).toBeLessThan(1400);
    // the pods must occupy more than one column for that to be true
    const podXs = new Set(
      nodes.filter((n) => n.id.startsWith('pod:')).map((n) => out.positions.get(n.id)!.x),
    );
    expect(podXs.size).toBeGreaterThan(1);
  });

  it('survives degenerate inputs', () => {
    expect(autoFlowLayout([], [])).toEqual({ positions: new Map(), groups: [], width: 0, height: 0 });
    const lone = autoFlowLayout([n('node:only')], []);
    expect(lone.positions.get('node:only')).toBeTruthy();
    // an edge naming a node that was filtered out must not throw
    expect(() => autoFlowLayout([n('a', 'x')], [{ source: 'a', target: 'ghost' }])).not.toThrow();
  });

  it('leaves room above each band for its label', () => {
    const { nodes, edges } = sampleCluster(3, 3);
    const out = autoFlowLayout(nodes, edges);
    for (const band of out.groups.filter((g) => g.kind === 'namespace')) {
      const children = nodes.filter((nd) => `ns-group-${nd.namespace}` === band.id);
      const topMost = Math.min(...children.map((c) => out.positions.get(c.id)!.y));
      expect(topMost - band.y).toBeGreaterThanOrEqual(BAND_PAD_TOP - BAND_PAD - 0.5);
    }
  });
});
