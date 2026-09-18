// Auto flow layout — the pipeline discovered from the edges, not assumed.
//
// The columns layout (src/lib/layout.ts) arranges the cluster as a FIXED
// pipeline: Services -> Workloads -> Pods -> Nodes. Auto flow answers a
// different question — "given the edges that actually exist, what shape is this
// system?" — so a service wired across namespaces, or a pod on an unexpected
// node, changes the picture instead of being folded into a preset stage.
//
// Three things this gets right that plain dagre does not:
//
//   * Namespaces survive. A flat dagre graph produces a correct flow with no
//     grouping at all, so on a real cluster you get a beautiful graph of cards
//     you cannot attribute to anything. Bands are kept.
//   * Ranks are PACKED, not stacked. Dagre puts every pod of a namespace in one
//     endless column: measured on a 316-card cluster that produced a canvas
//     1432x34440 (aspect 0.04), which is precisely the failure layout.ts was
//     written to prevent — fit-view shrinks every card to an unreadable speck.
//     So dagre is used for what it is good at (ranking nodes from the real
//     edges) and the within-rank packing reuses the balanced-grid helpers the
//     columns layout already proves out.
//   * The result is stable. Dagre's output depends on insertion order, so a
//     poll that merely reorders the API response would otherwise reshuffle the
//     whole canvas. Everything is inserted in sorted order.

import dagre from '@dagrejs/dagre';
import { stageShape, stageSlot, CARD_W, CARD_H, ROW_H, COL_W } from './layout';

export interface FlowNodeInput {
  id: string;
  /** Namespace band this node belongs in. Absent = shared by every band. */
  namespace?: string;
  /** A separate top-level panel, e.g. containers, laid out outside the cluster. */
  panel?: string;
  w: number;
  h: number;
}

export interface FlowEdgeInput { source: string; target: string }

export interface FlowGroupBox {
  id: string;
  kind: 'namespace' | 'containers' | 'k8s';
  label: string;
  x: number; y: number; w: number; h: number;
}

export interface AutoFlowResult {
  positions: Map<string, { x: number; y: number }>;
  groups: FlowGroupBox[];
  width: number;
  height: number;
}

// Kept in step with src/lib/layout.ts so the two modes feel like one product.
export const BAND_PAD = 24;
export const BAND_PAD_TOP = 46;   // room for the "ns: name" strip
export const MIN_BAND_GAP = 90;   // clear space between one band and the next
export const RANK_GAP = 90;       // clear space between one rank and the next
export const MARGIN = 40;
const CONTAINERS_GAP = 130;       // between the containers panel and the cluster
const COL_GAP = COL_W - CARD_W;   // horizontal gap between wrapped sub-columns
const ROW_GAP = ROW_H - CARD_H;   // vertical gap between rows in a block

const nsGroupId = (ns: string) => `ns-group-${ns}`;

interface Box { x: number; y: number; w: number; h: number }

const bboxOf = (boxes: Box[]): Box | null => {
  if (boxes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * Push bands apart until each clears the one above by `minGap`, moving every
 * child with its band.
 *
 * Bands are already stacked with a gap when they are built, so this is a
 * backstop rather than the mechanism — it is what makes "no band ever overlaps
 * another" true by construction instead of by assumption.
 */
export function separateBands(
  bands: Array<{ id: string; box: Box; children: string[] }>,
  positions: Map<string, { x: number; y: number }>,
  minGap = MIN_BAND_GAP,
): void {
  const ordered = [...bands].sort((a, b) => a.box.y - b.box.y || a.id.localeCompare(b.id));
  let prevBottom = -Infinity;
  for (const band of ordered) {
    const needed = prevBottom === -Infinity ? band.box.y : prevBottom + minGap;
    const delta = needed - band.box.y;
    if (delta > 0) {
      band.box.y += delta;
      for (const id of band.children) {
        const p = positions.get(id);
        if (p) p.y += delta;
      }
    }
    prevBottom = band.box.y + band.box.h;
  }
}

/**
 * Rank every node from the real edges.
 *
 * Dagre is used purely as a ranker here: `rank` is how far along the flow a
 * node sits, `order` is its position within that rank. Both are read back and
 * the actual geometry is computed below, because dagre's own coordinates are
 * what produce the endless-column problem.
 */
function rankNodes(
  nodes: FlowNodeInput[],
  edges: FlowEdgeInput[],
): Map<string, { rank: number; order: number }> {
  const out = new Map<string, { rank: number; order: number }>();
  if (nodes.length === 0) return out;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 130 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(nodes.map((n) => n.id));
  // Sorted insertion: dagre is order-sensitive, and a reshuffled canvas on
  // every poll is the bug this avoids.
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of sorted) g.setNode(n.id, { width: n.w, height: n.h });
  const sortedEdges = [...edges]
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .sort((a, b) => (a.source + '->' + a.target).localeCompare(b.source + '->' + b.target));
  for (const e of sortedEdges) g.setEdge(e.source, e.target);

  dagre.layout(g);
  for (const n of sorted) {
    const p: any = g.node(n.id);
    out.set(n.id, { rank: Number.isFinite(p?.rank) ? p.rank : 0, order: Number.isFinite(p?.order) ? p.order : 0 });
  }
  return out;
}

/** Place `items` as a balanced block whose top-left is (x, y). Returns its size. */
function placeBlock(
  items: FlowNodeInput[],
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  positions: Map<string, { x: number; y: number }>,
): { w: number; h: number } {
  const count = items.length;
  if (count === 0) return { w: 0, h: 0 };
  const { rows, cols } = stageShape(count);
  items.forEach((n, i) => {
    const slot = stageSlot(i, count);
    positions.set(n.id, {
      x: x + slot.col * (cellW + COL_GAP),
      y: y + slot.row * (cellH + ROW_GAP),
    });
  });
  return {
    w: cols * cellW + (cols - 1) * COL_GAP,
    h: rows * cellH + (rows - 1) * ROW_GAP,
  };
}

/**
 * Lay out `nodes` from `edges`, preserving namespace grouping.
 *
 * Nodes carrying a `panel` are laid out as their own flow to the left (the
 * containers column, where ports are satellites pinned to their container);
 * nodes with a `namespace` are banded; the rest are treated as shared by every
 * band and stacked in a centred block on the right, the same convention the
 * columns layout uses for cluster nodes.
 */
export function autoFlowLayout(
  nodes: FlowNodeInput[],
  edges: FlowEdgeInput[],
  opts: { clusterLabel?: string } = {},
): AutoFlowResult {
  const positions = new Map<string, { x: number; y: number }>();
  const groups: FlowGroupBox[] = [];
  if (nodes.length === 0) return { positions, groups, width: 0, height: 0 };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const panelNodes = nodes.filter((n) => n.panel);
  const flowNodes = nodes.filter((n) => !n.panel);

  const ranked = rankNodes(flowNodes, edges);
  const rankOf = (n: FlowNodeInput) => ranked.get(n.id)?.rank ?? 0;
  const orderOf = (n: FlowNodeInput) => ranked.get(n.id)?.order ?? 0;
  // Within a rank, dagre's ordering is what keeps an owner's children together;
  // id breaks ties so the result never depends on input order.
  const inFlowOrder = (a: FlowNodeInput, b: FlowNodeInput) =>
    orderOf(a) - orderOf(b) || a.id.localeCompare(b.id);

  const banded = flowNodes.filter((n) => n.namespace);
  const shared = flowNodes.filter((n) => !n.namespace);

  const cellW = Math.max(CARD_W, ...flowNodes.map((n) => n.w));
  const cellH = Math.max(CARD_H, ...flowNodes.map((n) => n.h));

  const namespaces = Array.from(new Set(banded.map((n) => n.namespace as string))).sort();

  // ── Rank columns, densified and shared across every band ──────────────────
  // A rank sits at one x for every namespace, so the same stage lines up down
  // the canvas instead of each band inventing its own column positions.
  const bandedRanks = Array.from(new Set(banded.map(rankOf))).sort((a, b) => a - b);
  const cellsFor = (ns: string, rank: number) =>
    banded.filter((n) => n.namespace === ns && rankOf(n) === rank).sort(inFlowOrder);

  const rankX = new Map<number, number>();
  const rankW = new Map<number, number>();
  let cursorX = 0;
  for (const r of bandedRanks) {
    const cols = Math.max(1, ...namespaces.map((ns) => stageShape(cellsFor(ns, r).length).cols));
    const w = cols * cellW + (cols - 1) * COL_GAP;
    rankX.set(r, cursorX);
    rankW.set(r, w);
    cursorX += w + RANK_GAP;
  }
  const bandedWidth = Math.max(0, cursorX - RANK_GAP);

  // ── Bands, stacked top to bottom ──────────────────────────────────────────
  const bands: Array<{ id: string; ns: string; box: Box; children: string[] }> = [];
  let cursorY = 0;
  for (const ns of namespaces) {
    const bandRows = Math.max(1, ...bandedRanks.map((r) => stageShape(cellsFor(ns, r).length).rows));
    const contentH = bandRows * cellH + (bandRows - 1) * ROW_GAP;
    const bandTop = cursorY;
    const children: string[] = [];

    for (const r of bandedRanks) {
      const items = cellsFor(ns, r);
      if (items.length === 0) continue;
      const { rows } = stageShape(items.length);
      const blockH = rows * cellH + (rows - 1) * ROW_GAP;
      // Centre a short block against the tallest one in the band, so a band with
      // two services and twelve pods does not look top-heavy.
      const y = bandTop + BAND_PAD_TOP + (contentH - blockH) / 2;
      placeBlock(items, rankX.get(r)!, y, cellW, cellH, positions);
      for (const n of items) children.push(n.id);
    }

    const h = BAND_PAD_TOP + contentH + BAND_PAD;
    bands.push({
      id: nsGroupId(ns), ns, children,
      box: { x: -BAND_PAD, y: bandTop, w: bandedWidth + 2 * BAND_PAD, h },
    });
    cursorY += h + MIN_BAND_GAP;
  }
  separateBands(bands, positions);

  const bandSpan = bboxOf(bands.map((b) => b.box));

  // ── Shared nodes: one block to the right, centred against the band stack ──
  let sharedBox: Box | null = null;
  if (shared.length > 0) {
    const ordered = [...shared].sort((a, b) => rankOf(a) - rankOf(b) || inFlowOrder(a, b));
    const { rows, cols } = stageShape(ordered.length);
    const blockW = cols * cellW + (cols - 1) * COL_GAP;
    const blockH = rows * cellH + (rows - 1) * ROW_GAP;
    const x = bandSpan ? bandSpan.x + bandSpan.w + RANK_GAP : 0;
    const y = bandSpan ? bandSpan.y + (bandSpan.h - blockH) / 2 : 0;
    placeBlock(ordered, x, y, cellW, cellH, positions);
    sharedBox = { x, y, w: blockW, h: blockH };
  }

  const boxFor = (ids: string[]): Box | null =>
    bboxOf(
      ids
        .map((id) => ({ p: positions.get(id), n: byId.get(id) }))
        .filter((o): o is { p: { x: number; y: number }; n: FlowNodeInput } => !!o.p && !!o.n)
        .map((o) => ({ x: o.p.x, y: o.p.y, w: o.n.w, h: o.n.h })),
    );

  // ── Containers panel: plain dagre is right here ───────────────────────────
  // It is small, and ports are satellites pinned beside their container rather
  // than flow participants, so the packing problem above does not arise.
  if (panelNodes.length > 0) {
    const pg = new dagre.graphlib.Graph();
    pg.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 130, marginx: 0, marginy: 0 });
    pg.setDefaultEdgeLabel(() => ({}));
    const sortedPanel = [...panelNodes].sort((a, b) => a.id.localeCompare(b.id));
    for (const n of sortedPanel) pg.setNode(n.id, { width: n.w, height: n.h });
    const panelIds = new Set(sortedPanel.map((n) => n.id));
    const panelEdges = [...edges]
      .filter((e) => panelIds.has(e.source) && panelIds.has(e.target))
      .sort((a, b) => (a.source + '->' + a.target).localeCompare(b.source + '->' + b.target));
    for (const e of panelEdges) pg.setEdge(e.source, e.target);
    dagre.layout(pg);
    for (const n of sortedPanel) {
      const p: any = pg.node(n.id);
      if (p) positions.set(n.id, { x: p.x - n.w / 2, y: p.y - n.h / 2 });
    }
  }

  // ── Compose: cluster box around the flow side, panel to its left ──────────
  const clusterContent = bboxOf([...bands.map((b) => b.box), ...(sharedBox ? [sharedBox] : [])]);
  const panelContent = boxFor(panelNodes.map((n) => n.id));

  if (panelContent && clusterContent) {
    const dx = clusterContent.x - CONTAINERS_GAP - BAND_PAD - (panelContent.x + panelContent.w);
    const dy = clusterContent.y + (clusterContent.h - panelContent.h) / 2 - panelContent.y;
    for (const n of panelNodes) {
      const p = positions.get(n.id);
      if (p) { p.x += dx; p.y += dy; }
    }
    panelContent.x += dx; panelContent.y += dy;
  }

  if (panelContent) {
    groups.push({
      id: 'docker-group', kind: 'containers', label: panelNodes[0]?.panel || 'Containers',
      x: panelContent.x - BAND_PAD, y: panelContent.y - BAND_PAD_TOP,
      w: panelContent.w + 2 * BAND_PAD, h: panelContent.h + BAND_PAD_TOP + BAND_PAD,
    });
  }
  if (clusterContent) {
    groups.push({
      id: 'k8s-group', kind: 'k8s', label: opts.clusterLabel || 'Kubernetes Cluster',
      x: clusterContent.x - BAND_PAD, y: clusterContent.y - BAND_PAD_TOP,
      w: clusterContent.w + 2 * BAND_PAD, h: clusterContent.h + BAND_PAD_TOP + BAND_PAD,
    });
  }
  // Bands last: React Flow paints in array order, so inner panels must follow
  // the cluster box that contains them.
  for (const b of bands) {
    groups.push({ id: b.id, kind: 'namespace', label: 'ns: ' + b.ns, x: b.box.x, y: b.box.y, w: b.box.w, h: b.box.h });
  }

  // ── Normalise to a margin-inset origin ────────────────────────────────────
  const all = bboxOf([
    ...groups.map((gr) => ({ x: gr.x, y: gr.y, w: gr.w, h: gr.h })),
    ...nodes
      .map((n) => ({ p: positions.get(n.id), n }))
      .filter((o): o is { p: { x: number; y: number }; n: FlowNodeInput } => !!o.p)
      .map((o) => ({ x: o.p.x, y: o.p.y, w: o.n.w, h: o.n.h })),
  ]);
  if (!all) return { positions, groups, width: 0, height: 0 };

  const dx = MARGIN - all.x;
  const dy = MARGIN - all.y;
  for (const p of positions.values()) { p.x += dx; p.y += dy; }
  for (const gr of groups) { gr.x += dx; gr.y += dy; }
  return { positions, groups, width: all.w + 2 * MARGIN, height: all.h + 2 * MARGIN };
}
