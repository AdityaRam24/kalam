// Deep-inspect API for the topology map.
//
//   GET /api/k8s/inspect/:kind/:namespace/:name[?vm=<name>]
//   GET /api/docker/inspect/:id[?vm=<name>]
//
// Clicking a card in the topology used to show the handful of fields the list
// endpoint happened to carry. This route goes back to the cluster for the whole
// object — its YAML, its `describe`, its events — and, from the same snapshot,
// works out what it is connected to: the Services that route to it, the
// workload that owns it, the Ingress that publishes it, the ConfigMaps,
// Secrets, PVCs and ServiceAccount it depends on, and the node it landed on.
//
// Everything here is READ-ONLY (`kubectl get` / `describe` / `docker inspect`)
// and works against either the local kubeconfig or an SSH-reachable VM, so the
// panel behaves the same whichever source the map is pointed at.

import { execFile } from 'child_process';
import { Router } from 'express';
import { loadVms, sshRun } from '../vms.js';
import { SAFE_NAME, parseJson, runSteps, type Step } from './kubectl.js';
import { factsFor, parseEvents } from './relate.js';

export const inspectRouter = Router();

/**
 * Kinds the panel can open. Secrets are deliberately absent: this endpoint
 * returns raw YAML, and nothing here needs to hand back secret data.
 */
const KINDS: Record<string, { kubectl: string; namespaced: boolean }> = {
  pod: { kubectl: 'pod', namespaced: true },
  deployment: { kubectl: 'deployment', namespaced: true },
  statefulset: { kubectl: 'statefulset', namespaced: true },
  daemonset: { kubectl: 'daemonset', namespaced: true },
  replicaset: { kubectl: 'replicaset', namespaced: true },
  job: { kubectl: 'job', namespaced: true },
  cronjob: { kubectl: 'cronjob', namespaced: true },
  service: { kubectl: 'service', namespaced: true },
  ingress: { kubectl: 'ingress', namespaced: true },
  pvc: { kubectl: 'pvc', namespaced: true },
  configmap: { kubectl: 'configmap', namespaced: true },
  node: { kubectl: 'node', namespaced: false },
  // The topology names its node cards "k8s-node" — accept that spelling too.
  'k8s-node': { kubectl: 'node', namespaced: false },
};

async function handleInspect(req: any, res: any, kindKey: string, nsParam: string, nameParam: string) {
  const kind = KINDS[kindKey.toLowerCase()];
  if (!kind) {
    return res.status(400).json({ error: `Cannot inspect "${kindKey}".` });
  }

  const name = String(nameParam || '');
  const namespace = kind.namespaced ? String(nsParam || '') : '';
  const vm = req.query.vm && req.query.vm !== 'local' ? String(req.query.vm) : undefined;

  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'Invalid resource name.' });
  if (kind.namespaced && !SAFE_NAME.test(namespace)) return res.status(400).json({ error: 'Invalid namespace.' });
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });

  const ns = kind.namespaced ? ['-n', namespace] : [];
  const target = [kind.kubectl, name, ...ns];

  const steps: Step[] = [
    { tag: 'SELF', args: ['get', ...target, '-o', 'json'] },
    { tag: 'YAML', args: ['get', ...target, '-o', 'yaml'], optional: true },
    { tag: 'DESCRIBE', args: ['describe', ...target], optional: true },
    {
      tag: 'EVENTS',
      args: kind.namespaced
        ? ['get', 'events', '-n', namespace, `--field-selector=involvedObject.name=${name}`, '-o', 'json']
        : ['get', 'events', '-A', `--field-selector=involvedObject.name=${name}`, '-o', 'json'],
      optional: true,
    },
    // Neighbourhood snapshot the relation rules reason over. For a node that
    // means every pod scheduled on it; otherwise the object's own namespace.
    {
      tag: 'PODS',
      args: kind.namespaced
        ? ['get', 'pods', '-n', namespace, '-o', 'json']
        : ['get', 'pods', '-A', `--field-selector=spec.nodeName=${name}`, '-o', 'json'],
      optional: true,
    },
    { tag: 'SVCS', args: kind.namespaced ? ['get', 'svc', '-n', namespace, '-o', 'json'] : ['get', 'svc', '-A', '-o', 'json'], optional: true },
    { tag: 'ENDPOINTS', args: kind.namespaced ? ['get', 'endpoints', '-n', namespace, '-o', 'json'] : ['get', 'endpoints', '-A', '-o', 'json'], optional: true },
    { tag: 'INGRESS', args: kind.namespaced ? ['get', 'ingress', '-n', namespace, '-o', 'json'] : ['get', 'ingress', '-A', '-o', 'json'], optional: true },
  ];

  const { out, error } = await runSteps(steps, vm);
  const self = parseJson(out.SELF);
  if (!self) {
    return res.status(404).json({
      error: error || `${kind.kubectl}/${name} not found${namespace ? ` in namespace ${namespace}` : ''}.`,
    });
  }

  // kubectl omits `kind` on some paths; the relation dispatcher needs it.
  if (!self.kind) self.kind = kind.kubectl.charAt(0).toUpperCase() + kind.kubectl.slice(1);

  const facts = factsFor(self, {
    pods: parseJson(out.PODS),
    services: parseJson(out.SVCS),
    endpoints: parseJson(out.ENDPOINTS),
    ingresses: parseJson(out.INGRESS),
  });

  res.json({
    ok: true,
    readOnly: true,
    source: vm || 'local',
    kind: self.kind,
    name,
    namespace: namespace || undefined,
    fetchedAt: new Date().toISOString(),
    yaml: (out.YAML || '').trim(),
    describe: (out.DESCRIBE || '').trim(),
    events: parseEvents(parseJson(out.EVENTS)),
    ...facts,
  });
}

// Namespaced objects: /api/k8s/inspect/pod/<ns>/<name>
// Cluster-scoped objects take "-" in the namespace slot, and may also be
// addressed without it: /api/k8s/inspect/node/<name>
inspectRouter.get('/api/k8s/inspect/:kind/:namespace/:name', (req, res) =>
  handleInspect(req, res, req.params.kind, req.params.namespace, req.params.name)
);

inspectRouter.get('/api/k8s/inspect/:kind/:name', (req, res, next) => {
  const kind = KINDS[String(req.params.kind || '').toLowerCase()];
  if (!kind || kind.namespaced) return next();
  return handleInspect(req, res, req.params.kind, '-', req.params.name);
});

/** The Docker equivalent: the full `docker inspect` object for a container. */
inspectRouter.get('/api/docker/inspect/:id', async (req, res) => {
  const id = String(req.params.id || '');
  const vm = req.query.vm && req.query.vm !== 'local' ? String(req.query.vm) : undefined;
  if (!SAFE_NAME.test(id)) return res.status(400).json({ error: 'Invalid container id.' });
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });

  let raw = '';
  if (vm) {
    const entry = (await loadVms()).find((v) => v.name === vm);
    if (!entry) return res.status(404).json({ error: `VM "${vm}" is not in the inventory.` });
    const { stdout } = await sshRun(entry, `docker inspect ${id} 2>/dev/null || true`, 20000);
    raw = stdout;
  } else {
    raw = await new Promise<string>((resolve) => {
      execFile('docker', ['inspect', id], { timeout: 20000, maxBuffer: 1024 * 1024 * 8 }, (_e, stdout) => resolve(stdout || ''));
    });
  }

  const parsed = parseJson(raw);
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj) return res.status(404).json({ error: `No container "${id}" on ${vm || 'this machine'}.` });

  res.json({
    ok: true,
    readOnly: true,
    source: vm || 'local',
    id: obj.Id,
    name: (obj.Name || '').replace(/^\//, ''),
    fetchedAt: new Date().toISOString(),
    // Pretty JSON is this world's equivalent of the YAML tab.
    yaml: JSON.stringify(obj, null, 2),
  });
});
