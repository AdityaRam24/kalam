// Properties the topology canvas must hold for any cluster, at any size.
//
// The failure this layout exists to prevent is a stage collapsing into one
// endless vertical line — every pod in a single column, stretching the canvas
// until fit-view shrinks the cards past readability. These assert the shape of
// the result, not the implementation.

import { describe, it, expect } from 'vitest';
import {
  layoutCluster, stageShape, stageSlot, stageRows, stageCols, orderPods,
  CARD_W, CARD_H, ROW_H, COL_W, type LayoutCard,
} from '../layout';

const pod = (name: string, ns = 'default', owner?: string) => ({
  name, namespace: ns, status: 'Running', ready: '1/1', node: 'node-1',
  restarts: 0, labels: {}, owner: owner ? { kind: 'Deployment', name: owner } : null,
});
const svc = (name: string, ns = 'default') => ({ name, namespace: ns, type: 'ClusterIP', selector: 'None' });
const wl = (name: string, ns = 'default') => ({ name, namespace: ns, kind: 'Deployment', ready: '1/1', replicas: 1 });
const node = (name: string) => ({ name, status: 'Ready', role: 'worker' });

const overlap = (a: LayoutCard, b: LayoutCard) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const noOverlaps = (cards: LayoutCard[]) => {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (overlap(cards[i], cards[j])) return `${cards[i].id} overlaps ${cards[j].id}`;
    }
  }
  return null;
};

const many = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

describe('stageShape', () => {
  it('keeps a small stage as one readable column', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(stageShape(n)).toEqual({ rows: n, cols: 1 });
    }
  });

  it('wraps a large stage instead of growing one endless column', () => {
    for (const n of [7, 12, 21, 33, 60, 120, 400]) {
      const { rows, cols } = stageShape(n);
      expect(cols).toBeGreaterThan(1);
      expect(rows * cols).toBeGreaterThanOrEqual(n);
      expect(rows).toBeLessThanOrEqual(6);
    }
  });

  it('biases blocks wider than tall, so the canvas suits a wide panel', () => {
    for (const n of [12, 21, 33, 60]) {
      const { rows, cols } = stageShape(n);
      expect(cols * COL_W).toBeGreaterThanOrEqual(rows * ROW_H);
    }
  });

  it('reports the row count the slots actually use', () => {
    for (let n = 1; n <= 200; n++) {
      const used = Math.max(...many(n, (i) => stageSlot(i, n).row)) + 1;
      expect(stageRows(n)).toBe(used);
      const usedCols = new Set(many(n, (i) => stageSlot(i, n).col)).size;
      expect(stageCols(n)).toBe(usedCols);
    }
  });
});

describe('stageSlot', () => {
  it('gives every card a distinct, top-aligned slot', () => {
    for (const n of [1, 7, 21, 22, 33, 100]) {
      const seen = new Set(many(n, (i) => { const s = stageSlot(i, n); return `${s.col}:${s.row}`; }));
      expect(seen.size).toBe(n);
      expect(many(n, (i) => stageSlot(i, n).row).includes(0)).toBe(true);
    }
  });

  it('balances columns to within one card', () => {
    for (const n of [22, 33, 47, 100]) {
      const counts = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const { col } = stageSlot(i, n);
        counts.set(col, (counts.get(col) || 0) + 1);
      }
      const sizes = [...counts.values()];
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });
});

describe('orderPods', () => {
  it('groups a workload\'s pods together so its edges stay bundled', () => {
    const ordered = orderPods([
      pod('b-1', 'ns', 'beta'), pod('a-1', 'ns', 'alpha'),
      pod('b-2', 'ns', 'beta'), pod('a-2', 'ns', 'alpha'),
    ]).map((p) => p.name);
    expect(ordered).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);
  });

  it('puts unowned pods last', () => {
    const ordered = orderPods([pod('zz'), pod('a-1', 'default', 'alpha')]).map((p) => p.name);
    expect(ordered).toEqual(['a-1', 'zz']);
  });
});

describe('layoutCluster', () => {
  it('produces nothing for an empty cluster without throwing', () => {
    const l = layoutCluster({ containers: [], pods: [], services: [], deployments: [], nodes: [] });
    expect(l.cards.size).toBe(0);
    expect(l.width).toBe(0);
  });

  it('never overlaps cards, at any size', () => {
    for (const n of [1, 9, 30, 120]) {
      const l = layoutCluster({
        containers: many(n, (i) => ({ id: `c${i}`.padEnd(12, '0'), name: `ctr-${i}` })),
        pods: many(n, (i) => pod(`pod-${i}`, i % 3 === 0 ? 'a' : 'b', `w-${i % 5}`)),
        services: many(Math.ceil(n / 3), (i) => svc(`svc-${i}`, i % 2 ? 'a' : 'b')),
        deployments: many(Math.ceil(n / 4), (i) => wl(`w-${i}`, i % 2 ? 'a' : 'b')),
        nodes: many(3, (i) => node(`node-${i}`)),
      });
      expect(noOverlaps([...l.cards.values()])).toBeNull();
    }
  });

  it('keeps each stage in its own column range', () => {
    const l = layoutCluster({
      containers: many(5, (i) => ({ id: `c${i}`.padEnd(12, '0'), name: `ctr-${i}` })),
      pods: many(30, (i) => pod(`pod-${i}`, 'a', `w-${i % 4}`)),
      services: many(9, (i) => svc(`svc-${i}`, 'a')),
      deployments: many(12, (i) => wl(`w-${i}`, 'a')),
      nodes: [node('n1')],
    });
    const span = (kind: string) => {
      const cs = [...l.cards.values()].filter((c) => c.kind === kind);
      return [Math.min(...cs.map((c) => c.x)), Math.max(...cs.map((c) => c.x + c.w))];
    };
    const [, ctrHi] = span('container');
    const [svcLo, svcHi] = span('service');
    const [depLo, depHi] = span('workload');
    const [podLo, podHi] = span('pod');
    const [nodeLo] = span('node');
    expect(svcLo).toBeGreaterThanOrEqual(ctrHi);
    expect(depLo).toBeGreaterThanOrEqual(svcHi);
    expect(podLo).toBeGreaterThanOrEqual(depHi);
    expect(nodeLo).toBeGreaterThanOrEqual(podHi);
  });

  it('gives every namespace its own band, and keeps its cards inside it', () => {
    const l = layoutCluster({
      containers: [],
      pods: [...many(12, (i) => pod(`x-${i}`, 'alpha')), ...many(20, (i) => pod(`y-${i}`, 'beta'))],
      services: [svc('s1', 'alpha'), svc('s2', 'beta')],
      deployments: [wl('w1', 'alpha'), wl('w2', 'beta')],
      nodes: [node('n1')],
    });
    const bands = l.groups.filter((g) => g.kind === 'namespace').sort((a, b) => a.y - b.y);
    expect(bands.map((b) => b.label)).toEqual(['ns: alpha', 'ns: beta']);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].y).toBeGreaterThanOrEqual(bands[i - 1].y + bands[i - 1].h);
    }
    for (const c of l.cards.values()) {
      if (!c.namespace) continue;
      const band = bands.find((b) => b.label === `ns: ${c.namespace}`)!;
      expect(c.y).toBeGreaterThanOrEqual(band.y);
      expect(c.y + c.h).toBeLessThanOrEqual(band.y + band.h);
    }
  });

  it('never lets a big stage become one vertical line', () => {
    const l = layoutCluster({
      containers: [], services: [], deployments: [], nodes: [],
      pods: many(40, (i) => pod(`p-${i}`, 'ns')),
    });
    const xs = new Set([...l.cards.values()].filter((c) => c.kind === 'pod').map((c) => c.x));
    expect(xs.size).toBeGreaterThan(1);
    // 40 pods must not be taller than a few screens.
    expect(l.height).toBeLessThan(1400);
  });

  it('stays wide rather than tall on a large cluster', () => {
    const l = layoutCluster({
      containers: [],
      pods: many(200, (i) => pod(`p-${i}`, `ns-${i % 4}`, `w-${i % 20}`)),
      services: many(40, (i) => svc(`s-${i}`, `ns-${i % 4}`)),
      deployments: many(20, (i) => wl(`w-${i}`, `ns-${i % 4}`)),
      nodes: many(6, (i) => node(`n-${i}`)),
    });
    expect(noOverlaps([...l.cards.values()])).toBeNull();
    expect(l.width / l.height).toBeGreaterThan(0.8);
  });

  it('lays out cards at the declared card size', () => {
    const l = layoutCluster({ containers: [], pods: [pod('p')], services: [], deployments: [], nodes: [] });
    const c = [...l.cards.values()][0];
    expect(c.w).toBe(CARD_W);
    expect(c.h).toBe(CARD_H);
  });

  it('is deterministic — the same input gives byte-identical positions', () => {
    const input = {
      containers: [], nodes: [node('n')],
      pods: many(15, (i) => pod(`p-${i}`, 'ns', `w-${i % 3}`)),
      services: many(4, (i) => svc(`s-${i}`, 'ns')),
      deployments: many(3, (i) => wl(`w-${i}`, 'ns')),
    };
    const a = layoutCluster(input);
    // Same objects in a different order must still land in the same places.
    const b = layoutCluster({ ...input, pods: [...input.pods].reverse(), services: [...input.services].reverse() });
    expect([...b.cards.entries()].map(([k, v]) => `${k}@${v.x},${v.y}`).sort())
      .toEqual([...a.cards.entries()].map(([k, v]) => `${k}@${v.x},${v.y}`).sort());
  });
});
