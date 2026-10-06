// /api/vme/* — connections to VME Managers, and one snapshot per connection
// that the whole VME page (overview, topology, hosts, VMs, storage, networks,
// alarms & activity, capacity) is drawn from.
//
// Toward the Manager: GET only (see client.ts). Toward Kubernetes: two reads
// (`get nodes`, pod → node names) to join VMs to the nodes they are.

import { Router } from 'express';
import { runSteps, parseJson, SAFE_NAME } from '../k8s/kubectl.js';
import { fetchAll, forgetToken, vmeGet, friendlyError } from './client.js';
import { loadConnections, saveConnections, publicConnection, validateConnection, NAME_RE, type VmeConnection } from './store.js';
import { normalize, joinKubernetes, k8sNodesFrom, vmeFindings, capacity, topology, type VmeSnapshot, type K8sNodeInfo } from './model.js';
import { demoRaw } from './demo.js';

export const vmeRouter = Router();

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; body: any }>();
const inFlight = new Map<string, Promise<any>>();

async function k8sFor(source: string | undefined): Promise<{ source: string; nodes: K8sNodeInfo[]; error?: string } | undefined> {
  if (!source) return undefined;
  const vm = source === 'local' ? undefined : source;
  const r = await runSteps([
    { tag: 'NODES', args: ['get', 'nodes', '-o', 'json'] },
    { tag: 'PODNODES', args: ['get', 'pods', '--all-namespaces', '-o', 'jsonpath={range .items[*]}{.spec.nodeName}{"\\n"}{end}'], optional: true },
  ], vm, 60_000, 1024 * 1024 * 32);
  const nodes = parseJson(r.out.NODES);
  if (!nodes?.items) return { source, nodes: [], error: r.error || 'Could not list Kubernetes nodes.' };
  return { source, nodes: k8sNodesFrom(nodes, r.out.PODNODES || '') };
}

/** Normalize + join + judge + lay out. Shared by real connections and demo. */
export function buildView(base: Omit<VmeSnapshot, 'at' | 'sources'>, sources: VmeSnapshot['sources'], k8s?: { source: string; nodes: K8sNodeInfo[]; error?: string }, now = Date.now()) {
  const snapshot: VmeSnapshot = { ...base, at: new Date(now).toISOString(), sources };
  if (k8s) snapshot.k8s = { ...k8s, unmatched: k8s.nodes.length ? joinKubernetes(snapshot.vms, k8s.nodes) : [] };
  const findings = vmeFindings(snapshot, now);
  return { snapshot, findings, capacity: capacity(snapshot), topology: topology(snapshot, findings) };
}

async function collect(conn: VmeConnection, k8sSource?: string) {
  const [{ raw, sources }, k8s] = await Promise.all([fetchAll(conn), k8sFor(k8sSource).catch((e) => ({ source: k8sSource!, nodes: [], error: String(e?.message || e) }))]);
  const okCount = Object.values(sources).filter((s) => s.ok).length;
  const view = buildView(normalize(raw, conn.name), sources, k8s);
  return { ...view, insecureTls: !!conn.insecureTls, error: okCount === 0 ? Object.values(sources)[0]?.error || 'The Manager did not answer.' : undefined };
}

vmeRouter.get('/api/vme/connections', async (_req, res) => {
  res.json({ connections: (await loadConnections()).map(publicConnection) });
});

vmeRouter.post('/api/vme/connections', async (req, res) => {
  const list = await loadConnections();
  const original = typeof req.body?.originalName === 'string' ? req.body.originalName : req.body?.name;
  const existing = list.find((c) => c.name === original);
  const v = validateConnection(req.body, existing);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  if (v.name !== original && list.some((c) => c.name === v.name)) return res.status(400).json({ error: `A connection named ${v.name} already exists.` });
  const next = list.filter((c) => c.name !== original);
  next.push(v);
  await saveConnections(next);
  forgetToken(v.name);
  if (original) forgetToken(original);
  for (const k of cache.keys()) if (k.startsWith(`${original}|`) || k.startsWith(`${v.name}|`)) cache.delete(k);
  res.json({ ok: true, connection: publicConnection(v) });
});

vmeRouter.delete('/api/vme/connections/:name', async (req, res) => {
  const name = String(req.params.name);
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name.' });
  const list = await loadConnections();
  await saveConnections(list.filter((c) => c.name !== name));
  forgetToken(name);
  res.json({ ok: true });
});

/** Check URL + credentials: one /api/whoami. */
vmeRouter.post('/api/vme/test', async (req, res) => {
  const conn = (await loadConnections()).find((c) => c.name === req.body?.name);
  if (!conn) return res.status(404).json({ error: 'No such connection.' });
  try {
    const w = await vmeGet(conn, '/api/whoami');
    res.json({ ok: true, user: w?.user?.username, version: w?.appliance?.buildVersion || w?.buildVersion });
  } catch (e: any) {
    res.json({ ok: false, error: friendlyError(e) });
  }
});

/**
 * GET /api/vme/snapshot?name=<connection>[&k8s=local|<vm>][&fresh=1]
 * GET /api/vme/snapshot?demo=1[&k8s=...]   built-in demo estate (labelled)
 */
vmeRouter.get('/api/vme/snapshot', async (req, res) => {
  const k8sParam = req.query.k8s ? String(req.query.k8s) : undefined;
  if (k8sParam && k8sParam !== 'none' && k8sParam !== 'local' && !SAFE_NAME.test(k8sParam)) return res.status(400).json({ error: 'Invalid Kubernetes source.' });

  if (req.query.demo === '1') {
    const { raw, k8sNodes, podNodes } = demoRaw();
    const sources = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { ok: true, count: Array.isArray(v) ? v.length : undefined }]));
    const view = buildView(normalize(raw, 'demo'), sources, { source: 'demo', nodes: k8sNodesFrom(k8sNodes, podNodes) });
    view.snapshot.demo = true;
    return res.json(view);
  }

  const name = String(req.query.name || '');
  const conn = (await loadConnections()).find((c) => c.name === name);
  if (!conn) return res.status(404).json({ error: name ? `No connection named ${name}.` : 'Pick a connection, or open the demo.' });
  const k8sSource = k8sParam === 'none' ? undefined : k8sParam || conn.k8sSource;
  const key = `${conn.name}|${k8sSource || ''}`;

  const hit = cache.get(key);
  if (hit && req.query.fresh !== '1' && Date.now() - hit.at < CACHE_MS) return res.json({ ...hit.body, cached: true });
  let p = inFlight.get(key);
  if (!p) {
    p = collect(conn, k8sSource).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  try {
    const body = await p;
    if (!body.error) cache.set(key, { at: Date.now(), body });
    res.json(body);
  } catch (e: any) {
    res.status(500).json({ error: friendlyError(e) });
  }
});
