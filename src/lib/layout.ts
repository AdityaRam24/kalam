// Where every card sits on the topology canvas.
//
// Kept pure and separate from the renderer for one reason: a layout is either
// correct or it is not, and "correct" means facts you can check — no card
// overlaps another, every namespace occupies its own band, each stage owns a
// distinct column range, and the whole thing fits a sane aspect ratio. Those
// are assertions against real cluster data (src/lib/__tests__/layout.test.ts),
// not something to eyeball once and hope about.
//
// The arrangement is a left-to-right pipeline, banded by namespace:
//
//   ┌ Containers ┐  ┌──────────────── Kubernetes ────────────────┐
//   │            │  │ ns: kube-system                            │
//   │  [ctr]     │  │  [svc]    [workload]   [pod][pod][pod]     │  [node]
//   │  [ctr]     │  │                        [pod][pod]          │
//   │            │  ├────────────────────────────────────────────┤
//   │            │  │ ns: themachine                             │
//   └────────────┘  └────────────────────────────────────────────┘
//
// Two properties do most of the work for legibility:
//
//   * A stage never becomes one long line. Thirty pods is a 5x6 block inside
//     its namespace band, not a 3,600px column that stretches every other
//     stage to match it.
//   * Pods are ordered by the workload that owns them, so the "manages" edges
//     leave a workload as one bundle instead of crossing the whole canvas.

import { podId, svcId, deployId, k8sNodeId, containerId } from './relations';

export type CardKind = 'container' | 'port' | 'service' | 'workload' | 'pod' | 'node';

export interface LayoutCard {
  id: string;
  kind: CardKind;
  namespace?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutGroup {
  id: string;
  kind: 'containers' | 'k8s' | 'namespace';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  cards: Map<string, LayoutCard>;
  groups: LayoutGroup[];
  width: number;
  height: number;
}

export interface LayoutInput {
  containers: any[];
  pods: any[];
  services: any[];
  deployments: any[];
  nodes: any[];
}

// ── Geometry ────────────────────────────────────────────────────────────────
export const CARD_W = 190;
export const CARD_H = 74;
export const ROW_H = 120;      // vertical pitch between cards in a stage
export const COL_W = 210;      // horizontal pitch between wrapped sub-columns
/** Stages up to this size stay a single readable column. */
const SINGLE_COLUMN_MAX = 6;
/**
 * Hard cap on a stage's height. Past this a stage grows sideways instead of
 * down, which is what keeps a 500-pod namespace from making the canvas so tall
 * that fit-view shrinks every card to an unreadable speck.
 */
const MAX_ROWS = 6;
const STAGE_GAP = 90;          // clear space between one stage and the next
const BAND_GAP = 90;           // clear space between namespace bands
const BAND_PAD_TOP = 46;       // room for the "ns: name" label
const BAND_PAD = 24;
const CONTAINERS_X = 90;
const K8S_X_GAP = 130;         // between the containers panel and Kubernetes

/**
 * How a stage of `count` cards wraps.
 *
 * Blocks are biased WIDER than tall. A dashboard panel is wide and short, and
 * the canvas is scaled to fit it — so a tall block is what makes every card on
 * screen shrink until the text is unreadable. Trading height for width costs
 * nothing and keeps the cards legible.
 *
 * Small stages stay a single column: four services read better as a list than
 * as a 2x2 block.
 */
export function stageShape(count: number): { rows: number; cols: number } {
  if (count <= 0) return { rows: 0, cols: 0 };
  if (count <= SINGLE_COLUMN_MAX) return { rows: count, cols: 1 };
  // Aim for a block whose pixel width is ~1.6x its height.
  const target = Math.ceil(Math.sqrt(count * (ROW_H / COL_W) * 1.6));
  const cols = Math.ceil(count / Math.min(MAX_ROWS, Math.max(2, target)));
  return { rows: Math.ceil(count / cols), cols };
}

export const stageCols = (count: number) => stageShape(count).cols;
export const stageRows = (count: number) => stageShape(count).rows;

/**
 * Grid slot for card `idx` of `count`, filling column by column.
 *
 * Columns are BALANCED and top-aligned: 22 cards across 5 columns is 5/5/4/4/4,
 * every column starting at the same row. Packing them 5/5/5/5/2 instead leaves
 * a stray pair floating beside a full block, which reads as a mistake rather
 * than as a grid.
 */
export function stageSlot(idx: number, count: number): { col: number; row: number } {
  const { cols } = stageShape(count);
  const base = Math.floor(count / cols);
  const wider = count % cols; // the first `wider` columns carry one extra
  let col = 0;
  let row = idx;
  for (; col < cols - 1; col++) {
    const size = base + (col < wider ? 1 : 0);
    if (row < size) break;
    row -= size;
  }
  return { col, row };
}

const byName = (a: any, b: any) => String(a?.name || '').localeCompare(String(b?.name || ''));

/**
 * Pods grouped so that everything one workload owns is contiguous, with
 * unowned pods last. This is what keeps a workload's edges together instead of
 * fanning them across the whole band.
 */
export function orderPods(pods: any[]): any[] {
  const key = (p: any) => (p?.owner?.name ? `0:${p.owner.name}` : '1:');
  return [...pods].sort((a, b) => {
    const k = key(a).localeCompare(key(b));
    return k !== 0 ? k : byName(a, b);
  });
}

export function layoutCluster(input: LayoutInput): LayoutResult {
  const containers = [...(input.containers || [])].sort(byName);
  const pods = input.pods || [];
  const services = [...(input.services || [])].sort(byName);
  const workloads = [...(input.deployments || [])].sort(byName);
  const nodes = [...(input.nodes || [])].sort(byName);

  const cards = new Map<string, LayoutCard>();
  const groups: LayoutGroup[] = [];
  const put = (c: LayoutCard) => cards.set(c.id, c);

  // Namespaces in a stable order, and only those that actually hold something.
  const namespaces = Array.from(
    new Set([...pods, ...services, ...workloads].map((o: any) => o?.namespace).filter(Boolean)),
  ).sort();

  const inNs = <T,>(arr: T[], ns: string) => arr.filter((o: any) => o?.namespace === ns);

  // ── Stage widths: a stage sits at one x across every band, so its width is
  //    the widest it gets in any single namespace. Positions chain left to
  //    right, which is what stops a wide Services stage from landing on top of
  //    the Deployments beside it.
  const widthOf = (pick: (ns: string) => number) =>
    Math.max(0, ...namespaces.map((ns) => Math.max(0, stageCols(pick(ns)) - 1) * COL_W), 0);

  const svcW = widthOf((ns) => inNs(services, ns).length);
  const depW = widthOf((ns) => inNs(workloads, ns).length);
  const podW = widthOf((ns) => inNs(pods, ns).length);

  const ctrShape = stageShape(containers.length);
  const containersW = containers.length > 0
    ? CARD_W + (ctrShape.cols - 1) * COL_W + 2 * BAND_PAD
    : 0;
  const k8sX = CONTAINERS_X + (containers.length > 0 ? containersW + K8S_X_GAP : 0);

  const xSvc = k8sX + BAND_PAD;
  const xDep = xSvc + CARD_W + svcW + STAGE_GAP;
  const xPod = xDep + CARD_W + depW + STAGE_GAP;
  const xNode = xPod + CARD_W + podW + STAGE_GAP;
  const k8sW = xNode + CARD_W + BAND_PAD - k8sX;

  // ── Namespace bands ───────────────────────────────────────────────────────
  const bandHeights = new Map<string, number>();
  const bandTops = new Map<string, number>();
  let cursorY = 0;
  for (const ns of namespaces) {
    const rows = Math.max(
      stageRows(inNs(services, ns).length),
      stageRows(inNs(workloads, ns).length),
      stageRows(inNs(pods, ns).length),
      1,
    );
    const h = BAND_PAD_TOP + rows * ROW_H - (ROW_H - CARD_H) + BAND_PAD;
    bandTops.set(ns, cursorY);
    bandHeights.set(ns, h);
    cursorY += h + BAND_GAP;
  }
  const k8sHeight = Math.max(0, cursorY - BAND_GAP);

  // ── Containers column, vertically centred against the Kubernetes side ─────
  const containersHeight = containers.length > 0 ? ctrShape.rows * ROW_H - (ROW_H - CARD_H) : 0;
  const canvasHeight = Math.max(k8sHeight, containersHeight, CARD_H);
  const containersTop = (canvasHeight - containersHeight) / 2;
  const k8sTop = (canvasHeight - k8sHeight) / 2;

  containers.forEach((c, i) => {
    const { col, row } = stageSlot(i, containers.length);
    put({
      id: containerId(c.id),
      kind: 'container',
      x: CONTAINERS_X + BAND_PAD + col * COL_W,
      y: containersTop + row * ROW_H,
      w: CARD_W,
      h: CARD_H,
    });
  });

  if (containers.length > 0) {
    groups.push({
      id: 'docker-group', kind: 'containers', label: 'Containers',
      x: CONTAINERS_X, y: containersTop - BAND_PAD,
      w: containersW, h: containersHeight + 2 * BAND_PAD,
    });
  }

  // ── Kubernetes stages, band by band ───────────────────────────────────────
  const placeStage = (
    items: any[], ns: string, x: number, bandTop: number, bandRows: number,
    kind: CardKind, idFor: (o: any) => string,
  ) => {
    const count = items.length;
    if (count === 0) return;
    // Centre this stage against the tallest stage in the band, so a band with
    // two services and twelve pods does not look top-heavy.
    const rows = stageRows(count);
    const centreOffset = ((bandRows - rows) * ROW_H) / 2;
    items.forEach((o, i) => {
      const { col, row } = stageSlot(i, count);
      put({
        id: idFor(o),
        kind,
        namespace: ns,
        x: x + col * COL_W,
        y: bandTop + BAND_PAD_TOP + centreOffset + row * ROW_H,
        w: CARD_W,
        h: CARD_H,
      });
    });
  };

  for (const ns of namespaces) {
    const bandTop = k8sTop + (bandTops.get(ns) ?? 0);
    const nsSvcs = inNs(services, ns);
    const nsDeps = inNs(workloads, ns);
    const nsPods = orderPods(inNs(pods, ns));
    const bandRows = Math.max(stageRows(nsSvcs.length), stageRows(nsDeps.length), stageRows(nsPods.length), 1);

    placeStage(nsSvcs, ns, xSvc, bandTop, bandRows, 'service', (o) => svcId(ns, o.name));
    placeStage(nsDeps, ns, xDep, bandTop, bandRows, 'workload', (o) => deployId(ns, o.name));
    placeStage(nsPods, ns, xPod, bandTop, bandRows, 'pod', (o) => podId(ns, o.name));

    groups.push({
      id: `ns-group-${ns}`, kind: 'namespace', label: `ns: ${ns}`,
      x: xSvc - BAND_PAD, y: bandTop,
      w: xPod + CARD_W + podW + BAND_PAD - (xSvc - BAND_PAD),
      h: bandHeights.get(ns) ?? CARD_H,
    });
  }

  // ── Cluster nodes: one column on the right, shared by every namespace ─────
  const nodesHeight = nodes.length * ROW_H - (ROW_H - CARD_H);
  const nodesTop = k8sTop + Math.max(0, (k8sHeight - nodesHeight) / 2);
  nodes.forEach((n, i) => {
    put({ id: k8sNodeId(n.name), kind: 'node', x: xNode, y: nodesTop + i * ROW_H, w: CARD_W, h: CARD_H });
  });

  if (namespaces.length > 0 || nodes.length > 0) {
    groups.push({
      id: 'k8s-group', kind: 'k8s', label: 'Kubernetes Cluster',
      x: k8sX, y: k8sTop - BAND_PAD,
      w: k8sW, h: Math.max(k8sHeight, nodesHeight) + 2 * BAND_PAD,
    });
  }

  let width = 0;
  let height = 0;
  for (const c of cards.values()) {
    width = Math.max(width, c.x + c.w);
    height = Math.max(height, c.y + c.h);
  }

  return { cards, groups, width, height };
}
