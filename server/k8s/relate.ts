// "What is this object actually wired to?" — the connection reasoning behind
// the topology's inspect panel.
//
// The topology graph draws the *shape* of the cluster; this module answers the
// follow-up question an operator asks after clicking a card: which Services
// route to this pod, which Deployment owns it, which ConfigMaps/Secrets/PVCs it
// mounts, which Ingress publishes it, and which node it landed on — each with
// the reason the link exists ("selector app=web", "ownerReference", "volume").
//
// It is PURE: it takes already-parsed `kubectl get -o json` objects and returns
// plain data, so every relationship rule is unit-testable from fixtures.

import { ownerOf, podHealth, selectorMatches } from '../graph/build.js';
import type { Health } from '../graph/model.js';

/** UI node kinds the topology graph can focus when a relation is clicked. */
export type FocusKind = 'pod' | 'service' | 'deployment' | 'k8s-node' | 'docker' | undefined;

export interface RelatedItem {
  /** Kubernetes kind, as displayed: Service, Deployment, Pod, ConfigMap, ... */
  kind: string;
  name: string;
  namespace?: string;
  /** Why this link exists — the whole point of the panel. */
  via: string;
  /** Ports, phase, ready counts: the one line worth showing next to the name. */
  detail?: string;
  health?: Health;
  /** Set when the topology canvas has a card for this object. */
  focus?: FocusKind;
}

export interface RelationGroup {
  title: string;
  items: RelatedItem[];
}

export interface ContainerDetail {
  name: string;
  image: string;
  init?: boolean;
  ready?: boolean;
  state?: string;
  reason?: string;
  restarts?: number;
  ports?: string;
  requests?: string;
  limits?: string;
  probes?: string;
  command?: string;
  mounts?: string;
}

export interface InspectFacts {
  /** Label/value rows for the details pane, in display order. */
  summary: Array<{ label: string; value: string }>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  containers: ContainerDetail[];
  groups: RelationGroup[];
  health?: Health;
  reason?: string;
}

export interface RelateContext {
  /** Services in the object's namespace (`kubectl get svc -n ns -o json`). */
  services?: any;
  /** Endpoints in the namespace — tells us which pods are actually serving. */
  endpoints?: any;
  ingresses?: any;
  /** Pods in the namespace, or (for a Node) pods on that node. */
  pods?: any;
}

const items = (raw: any): any[] => (Array.isArray(raw?.items) ? raw.items : []);
const rec = (v: any): Record<string, string> => (v && typeof v === 'object' ? v : {});
const selectorText = (sel: Record<string, string> | undefined): string =>
  sel && Object.keys(sel).length ? Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(',') : '';

function quantity(res: any): string {
  if (!res || typeof res !== 'object') return '';
  const parts = [res.cpu && `cpu ${res.cpu}`, res.memory && `mem ${res.memory}`];
  for (const [k, v] of Object.entries(res)) {
    if (k !== 'cpu' && k !== 'memory') parts.push(`${k} ${v}`);
  }
  return parts.filter(Boolean).join(' · ');
}

function probeText(c: any): string {
  const kinds = [
    c.livenessProbe && 'liveness',
    c.readinessProbe && 'readiness',
    c.startupProbe && 'startup',
  ].filter(Boolean);
  return kinds.join(', ');
}

/** Flatten a container spec (plus its live status, when the object is a Pod). */
function containerDetail(spec: any, status: any | undefined, init = false): ContainerDetail {
  const st = status?.state || {};
  const stateName = Object.keys(st)[0] || '';
  const cur = st[stateName] || {};
  const last = status?.lastState?.terminated;
  const reason =
    cur.reason ||
    (last?.reason ? `last: ${last.reason}${last.exitCode !== undefined ? ` (exit ${last.exitCode})` : ''}` : '');

  return {
    name: spec?.name || status?.name || '',
    image: spec?.image || status?.image || '',
    init: init || undefined,
    ready: status?.ready,
    state: stateName,
    reason: reason || undefined,
    restarts: status?.restartCount,
    ports: (spec?.ports || []).map((p: any) => `${p.containerPort}/${p.protocol || 'TCP'}${p.name ? ` (${p.name})` : ''}`).join(', '),
    requests: quantity(spec?.resources?.requests),
    limits: quantity(spec?.resources?.limits),
    probes: probeText(spec || {}),
    command: [...(spec?.command || []), ...(spec?.args || [])].join(' ').slice(0, 200),
    mounts: (spec?.volumeMounts || []).map((m: any) => `${m.name}:${m.mountPath}${m.readOnly ? ' (ro)' : ''}`).join(', '),
  };
}

/**
 * Every ConfigMap / Secret / PVC / ServiceAccount a pod spec pulls in, whether
 * through a volume, envFrom, a single env key, or an image pull secret. These
 * are the references that silently break a pod when the object is missing.
 */
export function configRefs(podSpec: any): RelatedItem[] {
  const out: RelatedItem[] = [];
  const seen = new Set<string>();
  const add = (kind: string, name: string, via: string) => {
    if (!name) return;
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name, via });
  };

  for (const v of podSpec?.volumes || []) {
    if (v?.persistentVolumeClaim?.claimName) add('PersistentVolumeClaim', v.persistentVolumeClaim.claimName, `volume "${v.name}"`);
    if (v?.configMap?.name) add('ConfigMap', v.configMap.name, `volume "${v.name}"`);
    if (v?.secret?.secretName) add('Secret', v.secret.secretName, `volume "${v.name}"`);
    for (const p of v?.projected?.sources || []) {
      if (p?.configMap?.name) add('ConfigMap', p.configMap.name, `projected volume "${v.name}"`);
      if (p?.secret?.name) add('Secret', p.secret.name, `projected volume "${v.name}"`);
    }
  }

  const containers = [...(podSpec?.containers || []), ...(podSpec?.initContainers || [])];
  for (const c of containers) {
    for (const f of c?.envFrom || []) {
      if (f?.configMapRef?.name) add('ConfigMap', f.configMapRef.name, `envFrom in ${c.name}`);
      if (f?.secretRef?.name) add('Secret', f.secretRef.name, `envFrom in ${c.name}`);
    }
    for (const e of c?.env || []) {
      const cm = e?.valueFrom?.configMapKeyRef;
      const sec = e?.valueFrom?.secretKeyRef;
      if (cm?.name) add('ConfigMap', cm.name, `env ${e.name} in ${c.name}`);
      if (sec?.name) add('Secret', sec.name, `env ${e.name} in ${c.name}`);
    }
  }

  for (const s of podSpec?.imagePullSecrets || []) add('Secret', s?.name, 'imagePullSecret');
  const sa = podSpec?.serviceAccountName || podSpec?.serviceAccount;
  if (sa) add('ServiceAccount', sa, 'pod runs as this service account');

  return out;
}

/** Endpoint readiness for a service, keyed by the pods actually behind it. */
export function endpointsFor(serviceName: string, endpoints: any): { ready: string[]; notReady: string[] } {
  const ep = items(endpoints).find((e) => e?.metadata?.name === serviceName);
  const ready: string[] = [];
  const notReady: string[] = [];
  for (const sub of ep?.subsets || []) {
    for (const a of sub?.addresses || []) ready.push(a?.targetRef?.name || a?.ip);
    for (const a of sub?.notReadyAddresses || []) notReady.push(a?.targetRef?.name || a?.ip);
  }
  return { ready: ready.filter(Boolean), notReady: notReady.filter(Boolean) };
}

/** Ingress rules that route to any of these service names. */
export function ingressesForServices(serviceNames: string[], ingresses: any): RelatedItem[] {
  const wanted = new Set(serviceNames);
  const out: RelatedItem[] = [];
  for (const ing of items(ingresses)) {
    const routes: string[] = [];
    const backendName = ing?.spec?.defaultBackend?.service?.name;
    if (backendName && wanted.has(backendName)) routes.push('default backend');
    for (const rule of ing?.spec?.rules || []) {
      for (const p of rule?.http?.paths || []) {
        const svc = p?.backend?.service?.name || p?.backend?.serviceName;
        if (svc && wanted.has(svc)) routes.push(`${rule.host || '*'}${p.path || '/'}`);
      }
    }
    if (!routes.length) continue;
    const addr = (ing?.status?.loadBalancer?.ingress || []).map((i: any) => i.ip || i.hostname).filter(Boolean).join(', ');
    out.push({
      kind: 'Ingress',
      name: ing?.metadata?.name,
      namespace: ing?.metadata?.namespace,
      via: `routes ${routes.join(', ')}`,
      detail: addr ? `address ${addr}` : (ing?.spec?.ingressClassName || ''),
    });
  }
  return out;
}

/** Services whose selector matches these labels, with live endpoint health. */
function servicesForLabels(labels: Record<string, string>, ctx: RelateContext, podName?: string): RelatedItem[] {
  const out: RelatedItem[] = [];
  for (const s of items(ctx.services)) {
    const sel = s?.spec?.selector;
    if (!selectorMatches(sel, labels)) continue;
    const name = s?.metadata?.name;
    const { ready, notReady } = endpointsFor(name, ctx.endpoints);
    const ports = (s?.spec?.ports || [])
      .map((p: any) => `${p.port}→${p.targetPort ?? p.port}/${p.protocol || 'TCP'}`)
      .join(', ');

    let health: Health = ready.length ? 'healthy' : 'failed';
    let detail = `${s?.spec?.type || 'ClusterIP'} ${s?.spec?.clusterIP || ''} ${ports}`.trim();
    if (podName) {
      // The sharpest signal on a pod card: is *this* pod actually serving?
      const serving = ready.includes(podName);
      health = serving ? 'healthy' : notReady.includes(podName) ? 'degraded' : 'failed';
      detail += serving
        ? ' · this pod is a ready endpoint'
        : notReady.includes(podName)
          ? ' · this pod is a NOT-READY endpoint (no traffic)'
          : ' · this pod is not in the endpoint list yet';
    } else {
      detail += ` · ${ready.length} ready / ${ready.length + notReady.length} endpoints`;
      if (!ready.length) health = 'failed';
      else if (notReady.length) health = 'degraded';
    }

    out.push({
      kind: 'Service',
      name,
      namespace: s?.metadata?.namespace,
      via: `selector ${selectorText(sel) || '(none)'}`,
      detail,
      health,
      focus: 'service',
    });
  }
  return out;
}

const group = (title: string, items: RelatedItem[]): RelationGroup[] => (items.length ? [{ title, items }] : []);

// ---------------------------------------------------------------------------
// Per-kind fact sheets
// ---------------------------------------------------------------------------

export function factsForPod(pod: any, ctx: RelateContext): InspectFacts {
  const meta = pod?.metadata || {};
  const spec = pod?.spec || {};
  const status = pod?.status || {};
  const labels = rec(meta.labels);
  const { health, reason, restarts } = podHealth(pod);

  const statuses: any[] = status.containerStatuses || [];
  const initStatuses: any[] = status.initContainerStatuses || [];
  const containers = [
    ...(spec.containers || []).map((c: any) => containerDetail(c, statuses.find((s) => s.name === c.name))),
    ...(spec.initContainers || []).map((c: any) => containerDetail(c, initStatuses.find((s) => s.name === c.name), true)),
  ];

  const conditions = (status.conditions || [])
    .filter((c: any) => c.status !== 'True')
    .map((c: any) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`)
    .join('; ');

  const summary = [
    { label: 'Phase', value: `${status.phase || 'Unknown'}${reason ? ` — ${reason}` : ''}` },
    { label: 'Ready', value: `${statuses.filter((c) => c.ready).length}/${statuses.length} containers` },
    { label: 'Restarts', value: String(restarts) },
    { label: 'Pod IP', value: status.podIP || 'none' },
    { label: 'Host IP', value: status.hostIP || '' },
    { label: 'Node', value: spec.nodeName || 'unscheduled' },
    { label: 'QoS', value: status.qosClass || '' },
    { label: 'Priority', value: spec.priorityClassName || '' },
    { label: 'Service account', value: spec.serviceAccountName || spec.serviceAccount || '' },
    { label: 'Restart policy', value: spec.restartPolicy || '' },
    { label: 'Node selector', value: selectorText(rec(spec.nodeSelector)) },
    { label: 'Tolerations', value: (spec.tolerations || []).length ? `${spec.tolerations.length} configured` : '' },
    { label: 'Started', value: status.startTime || meta.creationTimestamp || '' },
    { label: 'Failing conditions', value: conditions },
  ].filter((r) => r.value);

  // Owner chain: pod -> ReplicaSet -> Deployment (collapsed by ownerOf).
  const owner = ownerOf(pod);
  const workloads: RelatedItem[] = owner
    ? [{
        kind: owner.kind,
        name: owner.name,
        namespace: meta.namespace,
        via: 'ownerReference — this workload created the pod',
        detail: 'restart/scale it here, not the pod',
        focus: owner.kind === 'Deployment' ? 'deployment' : undefined,
      }]
    : [];

  const services = servicesForLabels(labels, ctx, meta.name);
  const ingresses = ingressesForServices(services.map((s) => s.name), ctx.ingresses);

  const nodeItems: RelatedItem[] = spec.nodeName
    ? [{ kind: 'Node', name: spec.nodeName, via: 'scheduled onto this node', detail: status.hostIP || '', focus: 'k8s-node' }]
    : [];

  // Sibling pods of the same owner — the replicas sharing this pod's fate.
  const siblings: RelatedItem[] = [];
  if (owner) {
    for (const p of items(ctx.pods)) {
      if (p?.metadata?.name === meta.name) continue;
      const po = ownerOf(p);
      if (!po || po.name !== owner.name || po.kind !== owner.kind) continue;
      const h = podHealth(p);
      siblings.push({
        kind: 'Pod',
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        via: `replica of ${owner.kind}/${owner.name}`,
        detail: `${p.status?.phase || ''} on ${p.spec?.nodeName || '?'}${h.reason ? ` — ${h.reason}` : ''}`,
        health: h.health,
        focus: 'pod',
      });
    }
  }

  const config = configRefs(spec);

  return {
    summary,
    labels,
    annotations: rec(meta.annotations),
    containers,
    health,
    reason,
    groups: [
      ...group('Owned by', workloads),
      ...group('Reached through these Services', services),
      ...group('Published by Ingress', ingresses),
      ...group('Runs on', nodeItems),
      ...group('Config & storage it depends on', config),
      ...group('Sibling replicas', siblings),
    ],
  };
}

export function factsForWorkload(obj: any, ctx: RelateContext): InspectFacts {
  const meta = obj?.metadata || {};
  const spec = obj?.spec || {};
  const status = obj?.status || {};
  const template = spec.template || {};
  const templateLabels = rec(template?.metadata?.labels);
  const selector = rec(spec.selector?.matchLabels);

  const containers = [
    ...(template?.spec?.containers || []).map((c: any) => containerDetail(c, undefined)),
    ...(template?.spec?.initContainers || []).map((c: any) => containerDetail(c, undefined, true)),
  ];

  const desired = spec.replicas ?? status.desiredNumberScheduled ?? status.replicas ?? 0;
  const ready = status.readyReplicas ?? status.numberReady ?? 0;
  const badConditions = (status.conditions || [])
    .filter((c: any) => c.status !== 'True' || c.type === 'ReplicaFailure')
    .map((c: any) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`)
    .join('; ');

  const summary = [
    { label: 'Kind', value: obj?.kind || '' },
    { label: 'Ready', value: `${ready}/${desired} replicas` },
    { label: 'Updated', value: status.updatedReplicas !== undefined ? String(status.updatedReplicas) : '' },
    { label: 'Available', value: status.availableReplicas !== undefined ? String(status.availableReplicas) : '' },
    { label: 'Unavailable', value: status.unavailableReplicas ? String(status.unavailableReplicas) : '' },
    { label: 'Strategy', value: spec.strategy?.type || spec.updateStrategy?.type || '' },
    { label: 'Selector', value: selectorText(selector) },
    { label: 'Generation', value: meta.generation ? `${meta.generation} (observed ${status.observedGeneration ?? '?'})` : '' },
    { label: 'Created', value: meta.creationTimestamp || '' },
    { label: 'Conditions', value: badConditions },
  ].filter((r) => r.value);

  // Pods this workload actually produced (selector match, not name prefix).
  const pods: RelatedItem[] = [];
  for (const p of items(ctx.pods)) {
    if (!selectorMatches(selector, rec(p?.metadata?.labels))) continue;
    const h = podHealth(p);
    pods.push({
      kind: 'Pod',
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      via: `matches selector ${selectorText(selector)}`,
      detail: `${p.status?.phase || ''} · ${p.spec?.nodeName || 'unscheduled'}${h.reason ? ` — ${h.reason}` : ''}${h.restarts ? ` · ${h.restarts} restarts` : ''}`,
      health: h.health,
      focus: 'pod',
    });
  }

  const services = servicesForLabels(templateLabels, ctx);
  const ingresses = ingressesForServices(services.map((s) => s.name), ctx.ingresses);
  const config = configRefs(template?.spec);

  // Where the replicas landed — a one-line spread that explains node-local blast radius.
  const nodes = new Map<string, number>();
  for (const p of items(ctx.pods)) {
    if (!selectorMatches(selector, rec(p?.metadata?.labels))) continue;
    const n = p?.spec?.nodeName;
    if (n) nodes.set(n, (nodes.get(n) || 0) + 1);
  }
  const nodeItems: RelatedItem[] = [...nodes].map(([name, count]) => ({
    kind: 'Node',
    name,
    via: 'hosts replicas of this workload',
    detail: `${count} pod${count === 1 ? '' : 's'}`,
    focus: 'k8s-node',
  }));

  const brokenPods = pods.filter((p) => p.health === 'failed' || p.health === 'degraded').length;
  const health: Health = !pods.length ? 'unknown' : brokenPods === 0 ? 'healthy' : brokenPods >= pods.length ? 'failed' : 'degraded';

  return {
    summary,
    labels: rec(meta.labels),
    annotations: rec(meta.annotations),
    containers,
    health,
    reason: brokenPods ? `${brokenPods}/${pods.length} replicas unhealthy` : undefined,
    groups: [
      ...group('Exposed by these Services', services),
      ...group('Published by Ingress', ingresses),
      ...group('Pods it manages', pods),
      ...group('Spread across nodes', nodeItems),
      ...group('Config & storage it depends on', config),
    ],
  };
}

export function factsForService(svc: any, ctx: RelateContext): InspectFacts {
  const meta = svc?.metadata || {};
  const spec = svc?.spec || {};
  const selector = rec(spec.selector);
  const { ready, notReady } = endpointsFor(meta.name, ctx.endpoints);

  const summary = [
    { label: 'Type', value: spec.type || 'ClusterIP' },
    { label: 'Cluster IP', value: spec.clusterIP || '' },
    { label: 'External', value: [...(spec.externalIPs || []), ...((svc?.status?.loadBalancer?.ingress || []).map((i: any) => i.ip || i.hostname))].filter(Boolean).join(', ') },
    { label: 'Ports', value: (spec.ports || []).map((p: any) => `${p.name ? `${p.name} ` : ''}${p.port}→${p.targetPort ?? p.port}/${p.protocol || 'TCP'}${p.nodePort ? ` (nodePort ${p.nodePort})` : ''}`).join(', ') },
    { label: 'Selector', value: selectorText(selector) || '(none — endpoints managed manually)' },
    { label: 'Endpoints', value: `${ready.length} ready, ${notReady.length} not ready` },
    { label: 'Session affinity', value: spec.sessionAffinity && spec.sessionAffinity !== 'None' ? spec.sessionAffinity : '' },
    { label: 'Created', value: meta.creationTimestamp || '' },
  ].filter((r) => r.value);

  // Backing pods: selector match, annotated with whether they are serving.
  const pods: RelatedItem[] = [];
  const owners = new Map<string, { kind: string; count: number }>();
  for (const p of items(ctx.pods)) {
    if (!selectorMatches(selector, rec(p?.metadata?.labels))) continue;
    const name = p.metadata.name;
    const h = podHealth(p);
    const serving = ready.includes(name);
    pods.push({
      kind: 'Pod',
      name,
      namespace: p.metadata.namespace,
      via: serving ? 'ready endpoint — receiving traffic' : notReady.includes(name) ? 'endpoint NOT ready — no traffic' : 'selected, but absent from endpoints',
      detail: `${p.status?.phase || ''} · ${p.spec?.nodeName || 'unscheduled'}${h.reason ? ` — ${h.reason}` : ''}`,
      health: serving ? h.health : h.health === 'healthy' ? 'degraded' : h.health,
      focus: 'pod',
    });
    const o = ownerOf(p);
    if (o) {
      const cur = owners.get(o.name);
      if (cur) cur.count++;
      else owners.set(o.name, { kind: o.kind, count: 1 });
    }
  }

  const workloads: RelatedItem[] = [...owners].map(([name, o]) => ({
    kind: o.kind,
    name,
    namespace: meta.namespace,
    via: 'owns the pods behind this Service',
    detail: `${o.count} backing pod${o.count === 1 ? '' : 's'}`,
    focus: o.kind === 'Deployment' ? 'deployment' : undefined,
  }));

  const ingresses = ingressesForServices([meta.name], ctx.ingresses);

  const health: Health = !Object.keys(selector).length
    ? 'unknown'
    : ready.length === 0
      ? 'failed'
      : notReady.length
        ? 'degraded'
        : 'healthy';

  return {
    summary,
    labels: rec(meta.labels),
    annotations: rec(meta.annotations),
    containers: [],
    health,
    reason: health === 'failed' ? 'NoHealthyEndpoints' : health === 'degraded' ? `${notReady.length} endpoints not ready` : undefined,
    groups: [
      ...group('Published by Ingress', ingresses),
      ...group('Backed by workloads', workloads),
      ...group('Routes to these pods', pods),
    ],
  };
}

export function factsForNode(node: any, ctx: RelateContext): InspectFacts {
  const meta = node?.metadata || {};
  const status = node?.status || {};
  const labels = rec(meta.labels);
  const conds: any[] = status.conditions || [];
  const readyCond = conds.find((c) => c.type === 'Ready');
  const pressure = conds.filter((c) => c.type !== 'Ready' && c.status === 'True').map((c) => c.type);
  const roles = Object.keys(labels)
    .filter((l) => l.startsWith('node-role.kubernetes.io/'))
    .map((l) => l.replace('node-role.kubernetes.io/', '') || 'master');

  const addr = (t: string) => (status.addresses || []).find((a: any) => a.type === t)?.address || '';

  const summary = [
    { label: 'Ready', value: readyCond ? readyCond.status : 'Unknown' },
    { label: 'Roles', value: roles.join(', ') || 'worker' },
    { label: 'Internal IP', value: addr('InternalIP') },
    { label: 'Hostname', value: addr('Hostname') },
    { label: 'Kubelet', value: status.nodeInfo?.kubeletVersion || '' },
    { label: 'Runtime', value: status.nodeInfo?.containerRuntimeVersion || '' },
    { label: 'OS', value: `${status.nodeInfo?.osImage || ''} ${status.nodeInfo?.kernelVersion || ''}`.trim() },
    { label: 'Capacity', value: quantity(status.capacity) },
    { label: 'Allocatable', value: quantity(status.allocatable) },
    { label: 'Pressure', value: pressure.join(', ') },
    { label: 'Schedulable', value: node?.spec?.unschedulable ? 'NO — cordoned' : 'yes' },
    { label: 'Taints', value: (node?.spec?.taints || []).map((t: any) => `${t.key}=${t.value ?? ''}:${t.effect}`).join(', ') },
  ].filter((r) => r.value);

  const pods: RelatedItem[] = [];
  const services = new Set<string>();
  for (const p of items(ctx.pods)) {
    if (p?.spec?.nodeName && p.spec.nodeName !== meta.name) continue;
    const h = podHealth(p);
    pods.push({
      kind: 'Pod',
      name: p?.metadata?.name,
      namespace: p?.metadata?.namespace,
      via: 'scheduled on this node',
      detail: `${p?.status?.phase || ''}${h.reason ? ` — ${h.reason}` : ''}${h.restarts ? ` · ${h.restarts} restarts` : ''}`,
      health: h.health,
      focus: 'pod',
    });
    for (const s of servicesForLabels(rec(p?.metadata?.labels), ctx)) services.add(s.name);
  }

  const serviceItems: RelatedItem[] = [...services].map((name) => ({
    kind: 'Service',
    name,
    via: 'has endpoints running on this node',
    focus: 'service' as FocusKind,
  }));

  const health: Health = readyCond?.status === 'True' ? (pressure.length ? 'degraded' : 'healthy') : 'failed';

  return {
    summary,
    labels,
    annotations: rec(meta.annotations),
    containers: [],
    health,
    reason: readyCond?.status !== 'True' ? 'NotReady' : pressure[0],
    groups: [
      ...group(`Pods on this node (${pods.length})`, pods),
      ...group('Services depending on this node', serviceItems),
    ],
  };
}

/** Dispatch on the object's own `kind` — the caller never has to map names. */
export function factsFor(obj: any, ctx: RelateContext): InspectFacts {
  switch (obj?.kind) {
    case 'Pod':
      return factsForPod(obj, ctx);
    case 'Service':
      return factsForService(obj, ctx);
    case 'Node':
      return factsForNode(obj, ctx);
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
    case 'CronJob':
      return factsForWorkload(obj, ctx);
    default:
      return {
        summary: [
          { label: 'Kind', value: obj?.kind || 'Unknown' },
          { label: 'Created', value: obj?.metadata?.creationTimestamp || '' },
        ].filter((r) => r.value),
        labels: rec(obj?.metadata?.labels),
        annotations: rec(obj?.metadata?.annotations),
        containers: [],
        groups: [],
      };
  }
}

/** Recent events for the object, newest first — the "why" behind a bad state. */
export function parseEvents(raw: any, limit = 25): Array<{ type: string; reason: string; message: string; count: number; time: string }> {
  return items(raw)
    .map((e) => ({
      type: e?.type || 'Normal',
      reason: e?.reason || '',
      message: (e?.message || '').slice(0, 400),
      count: e?.count || 1,
      time: e?.lastTimestamp || e?.eventTime || e?.firstTimestamp || e?.metadata?.creationTimestamp || '',
    }))
    .sort((a, b) => Date.parse(b.time || '') - Date.parse(a.time || ''))
    .slice(0, limit);
}
