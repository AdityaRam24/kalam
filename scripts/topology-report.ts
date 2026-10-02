// Prints the topology layout the UI will draw, for a real cluster.
//
// The canvas is geometry, so it can be checked rather than eyeballed: this
// renders the computed positions as an ASCII map and then asserts the things
// that make a dashboard readable — no card overlapping another, one column
// range per stage, one band per namespace, and a sane aspect ratio.
//
//   npx tsx scripts/topology-report.ts              # live cluster via kubectl
//   npx tsx scripts/topology-report.ts snapshot.json
//   npx tsx scripts/topology-report.ts http://localhost:3001/api/k8s/resources
//
// Exits non-zero if any check fails, so it can gate a release.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { normalizeClusterItems, parseReplicaSetOwners } from '../server/k8s/workloads.js';
import { buildRelations } from '../src/lib/relations.js';
import { layoutCluster, stageRows, type LayoutCard, type LayoutResult } from '../src/lib/layout.js';

const execFileAsync = promisify(execFile);

async function loadCluster() {
  const arg = process.argv[2];

  // A running Trinetra: checks the layout for exactly the payload the browser
  // gets, including a remote source (?vm=<name>) read over SSH.
  if (arg && /^https?:\/\//.test(arg)) {
    const res = await fetch(arg);
    const d: any = await res.json();
    if (d.error) throw new Error(`${arg}: ${d.error}`);
    return { pods: d.pods || [], services: d.services || [], deployments: d.deployments || [], nodes: d.nodes || [] };
  }

  if (arg) {
    const raw = JSON.parse(fs.readFileSync(arg, 'utf8'));
    // Either a raw `kubectl -o json` dump or an already-normalized payload.
    return raw.items ? normalizeClusterItems(raw.items) : {
      pods: raw.pods || [], services: raw.services || [],
      deployments: raw.deployments || [], nodes: raw.nodes || [],
    };
  }
  const { stdout } = await execFileAsync(
    'kubectl',
    ['get', 'pods,svc,deploy,sts,ds,nodes', '-o', 'json', '--all-namespaces'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  let owners;
  try {
    const { stdout: rs } = await execFileAsync('kubectl', [
      'get', 'rs', '--all-namespaces', '--no-headers', '-o',
      'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,OKIND:.metadata.ownerReferences[0].kind,ONAME:.metadata.ownerReferences[0].name',
    ], { maxBuffer: 32 * 1024 * 1024 });
    owners = parseReplicaSetOwners(rs);
  } catch { /* pod→Deployment edges only */ }
  return normalizeClusterItems(JSON.parse(stdout).items || [], owners);
}

const overlaps = (a: LayoutCard, b: LayoutCard) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Draw the canvas as text, one glyph per card, so the shape is visible. */
function asciiMap(layout: LayoutResult, cols = 110, rows = 46): string {
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
  const glyph: Record<string, string> = {
    container: 'C', service: 'S', workload: 'W', pod: 'p', node: 'N', port: '.',
  };
  const sx = cols / Math.max(1, layout.width);
  const sy = rows / Math.max(1, layout.height);
  for (const c of layout.cards.values()) {
    const x = Math.min(cols - 1, Math.max(0, Math.round(c.x * sx)));
    const y = Math.min(rows - 1, Math.max(0, Math.round(c.y * sy)));
    const g = glyph[c.kind] || '?';
    // Never let one card erase another: show a collision instead of hiding it.
    grid[y][x] = grid[y][x] === ' ' || grid[y][x] === g ? g : '#';
  }
  return grid.map((r) => r.join('').replace(/\s+$/, '')).join('\n');
}

async function main() {
  const cluster = await loadCluster();
  const layout = layoutCluster({ containers: [], ...cluster });
  const rels = buildRelations({ containers: [], ...cluster });
  const cards = [...layout.cards.values()];

  console.log('CLUSTER');
  console.log(`  pods ${cluster.pods.length}  services ${cluster.services.length}  ` +
    `workloads ${cluster.deployments.length}  nodes ${cluster.nodes.length}`);
  const kinds: Record<string, number> = {};
  for (const w of cluster.deployments) kinds[w.kind] = (kinds[w.kind] || 0) + 1;
  console.log(`  workload kinds: ${JSON.stringify(kinds)}`);

  console.log('\nCANVAS');
  console.log(`  ${Math.round(layout.width)} x ${Math.round(layout.height)} px` +
    `  (aspect ${(layout.width / Math.max(1, layout.height)).toFixed(2)})`);
  console.log(`  cards ${cards.length}   groups ${layout.groups.length}   edges ${rels.length}`);

  console.log('\nSTAGE COLUMNS (x ranges must not interleave)');
  const byKind = new Map<string, LayoutCard[]>();
  for (const c of cards) (byKind.get(c.kind) ?? byKind.set(c.kind, []).get(c.kind)!).push(c);
  const order = ['container', 'service', 'workload', 'pod', 'node'];
  const ranges: Array<[string, number, number]> = [];
  for (const k of order) {
    const list = byKind.get(k);
    if (!list?.length) continue;
    const lo = Math.min(...list.map((c) => c.x));
    const hi = Math.max(...list.map((c) => c.x + c.w));
    ranges.push([k, lo, hi]);
    console.log(`  ${k.padEnd(9)} x ${String(Math.round(lo)).padStart(5)} .. ${String(Math.round(hi)).padStart(5)}   (${list.length} cards)`);
  }

  console.log('\nNAMESPACE BANDS');
  for (const g of layout.groups.filter((g) => g.kind === 'namespace')) {
    console.log(`  ${g.label.padEnd(28)} y ${String(Math.round(g.y)).padStart(5)} .. ${String(Math.round(g.y + g.h)).padStart(5)}`);
  }

  console.log('\nMAP  (C container  S service  W workload  p pod  N node  # OVERLAP)');
  console.log(asciiMap(layout));

  // ── Checks ────────────────────────────────────────────────────────────────
  const problems: string[] = [];

  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (overlaps(cards[i], cards[j])) {
        problems.push(`cards overlap: ${cards[i].id} and ${cards[j].id}`);
      }
    }
  }

  for (let i = 1; i < ranges.length; i++) {
    const [prevK, , prevHi] = ranges[i - 1];
    const [k, lo] = ranges[i];
    if (lo < prevHi) problems.push(`stage "${k}" starts at ${Math.round(lo)} before "${prevK}" ends at ${Math.round(prevHi)}`);
  }

  const bands = layout.groups.filter((g) => g.kind === 'namespace').sort((a, b) => a.y - b.y);
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].y < bands[i - 1].y + bands[i - 1].h) {
      problems.push(`namespace bands overlap: ${bands[i - 1].label} / ${bands[i].label}`);
    }
  }

  for (const c of cards) {
    const band = bands.find((b) => b.label === `ns: ${c.namespace}`);
    if (!band) continue;
    if (c.y < band.y || c.y + c.h > band.y + band.h) {
      problems.push(`card ${c.id} sits outside its namespace band`);
    }
  }

  // A stage that is one long line is the failure this layout exists to avoid.
  for (const k of ['pod', 'service', 'workload'] as const) {
    for (const band of bands) {
      const inBand = cards.filter((c) => c.kind === k && `ns: ${c.namespace}` === band.label);
      if (inBand.length <= stageRows(inBand.length)) continue;
      const colCount = new Set(inBand.map((c) => Math.round(c.x))).size;
      if (colCount < 2) problems.push(`${inBand.length} ${k}s in ${band.label} are in a single column`);
    }
  }

  const aspect = layout.width / Math.max(1, layout.height);
  if (aspect < 0.15 || aspect > 12) problems.push(`canvas aspect ratio ${aspect.toFixed(2)} is unusable`);

  console.log('');
  if (problems.length) {
    console.log(`FAILED — ${problems.length} problem(s):`);
    for (const p of [...new Set(problems)].slice(0, 20)) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('OK — no overlaps, stages in distinct columns, namespaces banded, no single-column stages.');
}


main().catch((e) => { console.error(e); process.exit(1); });
