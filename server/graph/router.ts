// Graph API — one read-only SSH round trip in, a reasoned dependency graph out.
//
//   POST /api/graph/build   { name }             -> build (and cache) the graph
//   GET  /api/graph/:name                        -> the cached graph
//   POST /api/graph/causes  { name }             -> root causes vs collateral
//   POST /api/graph/blast   { name, id }         -> what breaks if `id` stops
//   POST /api/graph/path    { name, from, to }   -> why `from` affects `to`
//
// Every command run on the host is an inspection command (`kubectl get`,
// `docker ps`, `ss -tuln`) — the graph is built by looking, never by changing.

import { Router } from 'express';
import { loadVms, matchNode, section, sshRun, vmReachable, type VmEntry } from '../vms.js';
import { analyzeCauses, blastRadius, dependencyPath, describePath, graphStats } from './analyze.js';
import { buildInfraGraph, type BuildInput } from './build.js';
import type { InfraGraph } from './model.js';

export const graphRouter = Router();

// One SSH round trip covering both worlds: a Kubernetes control host and a
// plain Docker/systemd box. Every section is optional — `|| true` keeps the
// pipeline alive on hosts that lack the binary.
const GRAPH_CMD = [
  'echo @@SELF@@',
  '(echo HOST:$(hostname); echo IPS:$(hostname -I 2>/dev/null))',
  'echo @@NODES@@',
  '(kubectl get nodes -o json 2>/dev/null || true)',
  'echo @@PODS@@',
  '(kubectl get pods -A -o json 2>/dev/null || true)',
  'echo @@SVCS@@',
  '(kubectl get svc -A -o json 2>/dev/null || true)',
  'echo @@PVCS@@',
  '(kubectl get pvc -A -o json 2>/dev/null || true)',
  'echo @@DOCKER@@',
  "(docker ps -a --format '{{json .}}' 2>/dev/null || true)",
  'echo @@SYSTEMD@@',
  "(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | head -60 || true)",
  'echo @@PORTS@@',
  '(ss -tulnp 2>/dev/null | tail -n +2 | head -60 || netstat -tulnp 2>/dev/null | tail -n +3 | head -60 || true)',
  'echo @@END@@',
].join('; ');

/** Parse a section as JSON, tolerating empty output from a missing binary. */
function json(stdout: string, tag: string): any {
  const raw = section(stdout, tag);
  if (!raw.startsWith('{')) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Built graphs are cached per VM so blast-radius and path queries do not each
// cost an SSH round trip. Rebuild is always explicit (POST /build).
const cache = new Map<string, InfraGraph>();

export function cachedGraph(name: string): InfraGraph | undefined {
  return cache.get(name);
}

export async function buildGraphForVm(vm: VmEntry): Promise<{ graph?: InfraGraph; error?: string }> {
  if (!(await vmReachable(vm))) {
    return { error: vm.via ? `Jump host "${vm.via}" unreachable` : 'SSH port unreachable' };
  }

  const { stdout, stderr, ok } = await sshRun(vm, GRAPH_CMD, 45000);
  if (!ok && !stdout.trim()) {
    return { error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 200) };
  }

  const self: Record<string, string> = {};
  for (const line of section(stdout, 'SELF').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) self[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const k8sNodes = json(stdout, 'NODES');

  const containers: BuildInput['containers'] = [];
  for (const line of section(stdout, 'DOCKER').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const p = JSON.parse(t);
      containers.push({ id: p.ID, name: p.Names, image: p.Image, status: p.Status, state: p.State, ports: p.Ports });
    } catch { /* skip malformed line */ }
  }

  const systemServices: BuildInput['systemServices'] = [];
  for (const line of section(stdout, 'SYSTEMD').split('\n')) {
    const m = line.trim().match(/^(\S+)\.service\s+\S+\s+\S+\s+(\S+)\s*(.*)$/);
    if (m) systemServices.push({ unit: m[1], sub: m[2], description: m[3] || '' });
  }

  const listeningPorts: BuildInput['listeningPorts'] = [];
  for (const line of section(stdout, 'PORTS').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0].toLowerCase();
    if (!/^(tcp|udp)/.test(proto)) continue;
    const local = cols[4].includes(':') ? cols[4] : cols[3];
    const procMatch = line.match(/users:\(\("([^"]+)"/) || line.match(/\d+\/([\w.-]+)\s*$/);
    listeningPorts.push({ proto, local, process: procMatch ? procMatch[1] : '' });
  }

  // Which cluster node IS this VM? Reuse the Node Brain matcher so the graph
  // and the brain report agree on identity.
  const ips = (self.IPS || '').split(/\s+/).filter(Boolean);
  const matched = k8sNodes ? matchNode(k8sNodes.items || [], self.HOST || '', ips) : undefined;

  const inventory = await loadVms();
  const reachability = new Map<string, boolean>([[vm.name, true]]);

  const graph = buildInfraGraph({
    source: vm.name,
    vms: inventory.map((v) => ({
      name: v.name,
      host: v.host,
      via: v.via,
      reachable: reachability.get(v.name),
      k8sNodeName: v.name === vm.name ? matched?.metadata?.name : undefined,
    })),
    k8sNodes,
    pods: json(stdout, 'PODS'),
    services: json(stdout, 'SVCS'),
    pvcs: json(stdout, 'PVCS'),
    containers,
    systemServices,
    listeningPorts,
  });

  cache.set(vm.name, graph);
  return { graph };
}

async function requireVm(name: unknown): Promise<VmEntry | undefined> {
  if (!name || typeof name !== 'string') return undefined;
  return (await loadVms()).find((v) => v.name === name);
}

/** Resolve the cached graph, building it on demand for the first query. */
async function graphFor(name: string): Promise<{ graph?: InfraGraph; error?: string; status?: number }> {
  const cached = cache.get(name);
  if (cached) return { graph: cached };
  const vm = await requireVm(name);
  if (!vm) return { error: 'VM not found.', status: 404 };
  return buildGraphForVm(vm);
}

graphRouter.post('/api/graph/build', async (req, res) => {
  const vm = await requireVm(req.body?.name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });

  const { graph, error } = await buildGraphForVm(vm);
  if (!graph) return res.json({ ok: false, error });

  const causes = analyzeCauses(graph);
  res.json({ ok: true, readOnly: true, graph, stats: graphStats(graph), causes });
});

graphRouter.post('/api/graph/causes', async (req, res) => {
  const { graph, error, status } = await graphFor(String(req.body?.name || ''));
  if (!graph) return res.status(status || 200).json({ ok: false, error });
  res.json({ ok: true, builtAt: graph.builtAt, ...analyzeCauses(graph, Number(req.body?.limit) || 10) });
});

graphRouter.post('/api/graph/blast', async (req, res) => {
  const id = req.body?.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'A node id is required.' });

  const { graph, error, status } = await graphFor(String(req.body?.name || ''));
  if (!graph) return res.status(status || 200).json({ ok: false, error });

  const radius = blastRadius(graph, id);
  if (!radius) return res.status(404).json({ error: `No node "${id}" in the graph for ${graph.source}.` });
  res.json({ ok: true, builtAt: graph.builtAt, ...radius });
});

graphRouter.post('/api/graph/path', async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'Both from and to node ids are required.' });

  const { graph, error, status } = await graphFor(String(req.body?.name || ''));
  if (!graph) return res.status(status || 200).json({ ok: false, error });

  const steps = dependencyPath(graph, String(from), String(to));
  if (!steps) return res.json({ ok: true, connected: false, message: `${from} has no dependency path to ${to}.` });
  res.json({
    ok: true,
    connected: true,
    steps: steps.map((s) => ({ from: s.from.id, to: s.to.id, kind: s.edge.kind, note: s.edge.note })),
    description: describePath(steps),
  });
});

graphRouter.get('/api/graph/:name', async (req, res) => {
  const graph = cache.get(req.params.name);
  if (!graph) return res.status(404).json({ error: 'No graph built yet for this VM. POST /api/graph/build first.' });
  res.json({ ok: true, graph, stats: graphStats(graph) });
});
