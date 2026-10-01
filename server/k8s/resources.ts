// Every other kind of cluster object — certificates, InferenceServices, PVCs,
// ingresses, Istio routing, jobs, quotas — in one shape the UI can list.
//
// The core views (pods, workloads, services, nodes) are drawn from
// workloads.ts. This module covers the rest, and has to cope with clusters
// that simply do not have half of these APIs: cert-manager, KServe, Istio and
// Kubeflow are all optional CRDs. Each kind is its own optional query, so a
// missing CRD costs that one kind and is reported as "not installed" rather
// than failing the page.
//
// Secrets and ConfigMaps are read through a projection (name, namespace, type)
// and never as JSON: their contents have no business leaving the cluster just
// to render a list, and their JSON is routinely the bulk of a cluster dump.

import { Router } from 'express';
import { runSteps, parseJson, SAFE_NAME, type Step } from './kubectl.js';
import type { Health } from './workloads.js';

export interface ResourceRow {
  kind: string;
  name: string;
  namespace?: string;
  created?: string;
  /** One word, the way kubectl's STATUS/READY column would put it. */
  status: string;
  health: Health;
  /** Ordered label/value pairs worth a column. */
  info: Array<[string, string]>;
}

export interface KindSpec {
  /** Section tag + stable key. */
  key: string;
  kind: string;
  /** Fully-qualified resource, so `gateways` cannot hit the wrong API group. */
  resource: string;
  group: 'Workloads' | 'AI / ML' | 'Network' | 'Storage' | 'Config' | 'Certificates' | 'Cluster';
  namespaced: boolean;
  /** Projected columns instead of JSON (see header). */
  columns?: string[];
  /** Extra kubectl args, e.g. a field selector. */
  extra?: string[];
  summarize?: (item: any) => Omit<ResourceRow, 'kind' | 'name' | 'namespace' | 'created'>;
  fromColumns?: (cols: string[]) => ResourceRow | null;
}

const cond = (item: any, type: string) =>
  (item?.status?.conditions || []).find((c: any) => c?.type === type);

const none = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));

/** Days from now until an ISO time (negative when it has passed). */
export function daysUntil(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.floor((t - now) / 86_400_000);
}

const readyFromCondition = (item: any, type = 'Ready'): { status: string; health: Health } => {
  const c = cond(item, type);
  if (!c) return { status: 'Unknown', health: 'unknown' };
  if (c.status === 'True') return { status: 'Ready', health: 'healthy' };
  if (c.status === 'False') return { status: c.reason || 'NotReady', health: 'failing' };
  return { status: c.reason || 'Pending', health: 'progressing' };
};

const fmtDuration = (fromIso?: string, toIso?: string): string => {
  const a = Date.parse(fromIso || '');
  const b = toIso ? Date.parse(toIso) : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return '—';
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/** The model a KServe predictor serves: format, storage location, runtime. */
export function isvcModel(item: any): { format?: string; storageUri?: string; runtime?: string } {
  const p = item?.spec?.predictor || {};
  if (p.model) {
    return { format: p.model.modelFormat?.name, storageUri: p.model.storageUri || p.model.storage?.path, runtime: p.model.runtime };
  }
  // Older "framework" form: spec.predictor.<sklearn|tensorflow|pytorch|…>.
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === 'object' && (v as any).storageUri) return { format: k, storageUri: (v as any).storageUri };
  }
  const c = (p.containers || [])[0];
  return c ? { format: 'custom', runtime: c.image } : {};
}

export const KINDS: KindSpec[] = [
  // ── Workloads ────────────────────────────────────────────────────────────
  {
    key: 'JOB', kind: 'Job', resource: 'jobs.batch', group: 'Workloads', namespaced: true,
    summarize: (j) => {
      const s = j.status || {};
      const want = j.spec?.completions ?? 1;
      const done = cond(j, 'Complete')?.status === 'True';
      const failed = cond(j, 'Failed')?.status === 'True';
      return {
        status: done ? 'Complete' : failed ? (cond(j, 'Failed')?.reason || 'Failed') : (s.active ? 'Running' : 'Pending'),
        health: done ? 'completed' : failed ? 'failing' : 'progressing',
        info: [['Completions', `${s.succeeded || 0}/${want}`], ['Active', String(s.active || 0)], ['Failed pods', String(s.failed || 0)],
          ['Duration', fmtDuration(s.startTime, s.completionTime)]],
      };
    },
  },
  {
    key: 'CRONJOB', kind: 'CronJob', resource: 'cronjobs.batch', group: 'Workloads', namespaced: true,
    summarize: (c) => ({
      status: c.spec?.suspend ? 'Suspended' : 'Scheduled',
      health: c.spec?.suspend ? 'unknown' : 'healthy',
      info: [['Schedule', none(c.spec?.schedule)], ['Active', String((c.status?.active || []).length)],
        ['Last run', c.status?.lastScheduleTime ? `${fmtDuration(c.status.lastScheduleTime)} ago` : 'never'],
        ['Last success', c.status?.lastSuccessfulTime ? `${fmtDuration(c.status.lastSuccessfulTime)} ago` : '—']],
    }),
  },
  {
    key: 'HPA', kind: 'HorizontalPodAutoscaler', resource: 'horizontalpodautoscalers.autoscaling', group: 'Workloads', namespaced: true,
    summarize: (h) => {
      const s = h.status || {};
      const able = cond(h, 'AbleToScale');
      const limited = cond(h, 'ScalingLimited')?.status === 'True';
      const failing = able?.status === 'False' || cond(h, 'ScalingActive')?.status === 'False';
      return {
        status: failing ? (cond(h, 'ScalingActive')?.reason || able?.reason || 'CannotScale') : limited ? 'AtLimit' : s.currentReplicas === s.desiredReplicas ? 'Stable' : 'Scaling',
        health: failing ? 'failing' : limited || s.currentReplicas !== s.desiredReplicas ? 'progressing' : 'healthy',
        info: [['Target', `${h.spec?.scaleTargetRef?.kind || ''}/${h.spec?.scaleTargetRef?.name || ''}`],
          ['Replicas', `${s.currentReplicas ?? 0} (want ${s.desiredReplicas ?? 0})`], ['Min/Max', `${h.spec?.minReplicas ?? 1}/${h.spec?.maxReplicas ?? '—'}`]],
      };
    },
  },
  {
    key: 'PDB', kind: 'PodDisruptionBudget', resource: 'poddisruptionbudgets.policy', group: 'Workloads', namespaced: true,
    summarize: (p) => {
      const s = p.status || {};
      const allowed = s.disruptionsAllowed ?? 0;
      return {
        status: allowed > 0 ? 'OK' : 'NoDisruptions',
        health: allowed > 0 ? 'healthy' : 'progressing',
        info: [['Min available', none(p.spec?.minAvailable)], ['Max unavailable', none(p.spec?.maxUnavailable)],
          ['Allowed', String(allowed)], ['Healthy', `${s.currentHealthy ?? 0}/${s.expectedPods ?? 0}`]],
      };
    },
  },

  // ── AI / ML ──────────────────────────────────────────────────────────────
  {
    key: 'ISVC', kind: 'InferenceService', resource: 'inferenceservices.serving.kserve.io', group: 'AI / ML', namespaced: true,
    summarize: (i) => {
      const m = isvcModel(i);
      return {
        ...readyFromCondition(i),
        info: [['URL', none(i.status?.url)], ['Model format', none(m.format)], ['Storage', none(m.storageUri)],
          ['Runtime', none(m.runtime)], ['Latest ready', none(i.status?.components?.predictor?.latestReadyRevision)]],
      };
    },
  },
  {
    key: 'SRT', kind: 'ServingRuntime', resource: 'servingruntimes.serving.kserve.io', group: 'AI / ML', namespaced: true,
    summarize: (r) => ({
      status: r.spec?.disabled ? 'Disabled' : 'Available',
      health: r.spec?.disabled ? 'unknown' : 'healthy',
      info: [['Formats', (r.spec?.supportedModelFormats || []).map((f: any) => f.name).join(', ') || '—'],
        ['Image', none(r.spec?.containers?.[0]?.image)]],
    }),
  },
  {
    key: 'CSRT', kind: 'ClusterServingRuntime', resource: 'clusterservingruntimes.serving.kserve.io', group: 'AI / ML', namespaced: false,
    summarize: (r) => ({
      status: r.spec?.disabled ? 'Disabled' : 'Available',
      health: r.spec?.disabled ? 'unknown' : 'healthy',
      info: [['Formats', (r.spec?.supportedModelFormats || []).map((f: any) => f.name).join(', ') || '—'],
        ['Image', none(r.spec?.containers?.[0]?.image)]],
    }),
  },
  {
    key: 'NOTEBOOK', kind: 'Notebook', resource: 'notebooks.kubeflow.org', group: 'AI / ML', namespaced: true,
    summarize: (n) => {
      const ready = n.status?.readyReplicas ?? 0;
      return {
        status: ready > 0 ? 'Running' : 'Stopped',
        health: ready > 0 ? 'healthy' : 'unknown',
        info: [['Image', none(n.spec?.template?.spec?.containers?.[0]?.image)], ['Ready', String(ready)]],
      };
    },
  },
  {
    key: 'RAYCLUSTER', kind: 'RayCluster', resource: 'rayclusters.ray.io', group: 'AI / ML', namespaced: true,
    summarize: (r) => {
      const st = String(r.status?.state || 'unknown');
      return {
        status: st, health: /ready/i.test(st) ? 'healthy' : /fail|suspend/i.test(st) ? 'failing' : 'progressing',
        info: [['Workers', String(r.status?.availableWorkerReplicas ?? r.status?.readyWorkerReplicas ?? 0)],
          ['Head', none(r.status?.head?.podIP || r.status?.head?.serviceIP)]],
      };
    },
  },

  // ── Network ──────────────────────────────────────────────────────────────
  {
    key: 'INGRESS', kind: 'Ingress', resource: 'ingresses.networking.k8s.io', group: 'Network', namespaced: true,
    summarize: (i) => {
      const addr = (i.status?.loadBalancer?.ingress || []).map((a: any) => a.ip || a.hostname).filter(Boolean);
      return {
        status: addr.length ? 'Active' : 'NoAddress',
        health: addr.length ? 'healthy' : 'progressing',
        info: [['Class', none(i.spec?.ingressClassName)], ['Hosts', (i.spec?.rules || []).map((r: any) => r.host || '*').join(', ') || '*'],
          ['Address', addr.join(', ') || '—'], ['TLS', (i.spec?.tls || []).length ? 'yes' : 'no']],
      };
    },
  },
  {
    key: 'VS', kind: 'VirtualService', resource: 'virtualservices.networking.istio.io', group: 'Network', namespaced: true,
    summarize: (v) => ({
      status: 'Configured', health: 'healthy',
      info: [['Hosts', (v.spec?.hosts || []).join(', ') || '—'], ['Gateways', (v.spec?.gateways || []).join(', ') || 'mesh'],
        ['Routes', String((v.spec?.http || []).length + (v.spec?.tcp || []).length + (v.spec?.tls || []).length)]],
    }),
  },
  {
    key: 'GW', kind: 'Gateway', resource: 'gateways.networking.istio.io', group: 'Network', namespaced: true,
    summarize: (g) => ({
      status: 'Configured', health: 'healthy',
      info: [['Servers', (g.spec?.servers || []).map((s: any) => `${s.port?.protocol || ''}:${s.port?.number || ''}`).join(', ') || '—'],
        ['Hosts', Array.from(new Set((g.spec?.servers || []).flatMap((s: any) => s.hosts || []))).join(', ') || '—']],
    }),
  },
  {
    key: 'DR', kind: 'DestinationRule', resource: 'destinationrules.networking.istio.io', group: 'Network', namespaced: true,
    summarize: (d) => ({
      status: 'Configured', health: 'healthy',
      info: [['Host', none(d.spec?.host)], ['Subsets', String((d.spec?.subsets || []).length)],
        ['TLS mode', none(d.spec?.trafficPolicy?.tls?.mode)]],
    }),
  },
  {
    key: 'NETPOL', kind: 'NetworkPolicy', resource: 'networkpolicies.networking.k8s.io', group: 'Network', namespaced: true,
    summarize: (n) => ({
      status: 'Active', health: 'healthy',
      info: [['Pod selector', Object.entries(n.spec?.podSelector?.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'all pods'],
        ['Types', (n.spec?.policyTypes || []).join(', ') || 'Ingress']],
    }),
  },

  // ── Storage ──────────────────────────────────────────────────────────────
  {
    key: 'PVC', kind: 'PersistentVolumeClaim', resource: 'persistentvolumeclaims', group: 'Storage', namespaced: true,
    summarize: (p) => {
      const phase = p.status?.phase || 'Unknown';
      return {
        status: phase, health: phase === 'Bound' ? 'healthy' : phase === 'Pending' ? 'progressing' : 'failing',
        info: [['Capacity', none(p.status?.capacity?.storage || p.spec?.resources?.requests?.storage)],
          ['Access', (p.spec?.accessModes || []).join(', ') || '—'], ['StorageClass', none(p.spec?.storageClassName)],
          ['Volume', none(p.spec?.volumeName)]],
      };
    },
  },
  {
    key: 'PV', kind: 'PersistentVolume', resource: 'persistentvolumes', group: 'Storage', namespaced: false,
    summarize: (p) => {
      const phase = p.status?.phase || 'Unknown';
      const claim = p.spec?.claimRef ? `${p.spec.claimRef.namespace}/${p.spec.claimRef.name}` : '—';
      return {
        status: phase,
        health: phase === 'Bound' || phase === 'Available' ? 'healthy' : phase === 'Released' || phase === 'Pending' ? 'progressing' : 'failing',
        info: [['Capacity', none(p.spec?.capacity?.storage)], ['Reclaim', none(p.spec?.persistentVolumeReclaimPolicy)],
          ['Claim', claim], ['StorageClass', none(p.spec?.storageClassName)]],
      };
    },
  },
  {
    key: 'SC', kind: 'StorageClass', resource: 'storageclasses.storage.k8s.io', group: 'Storage', namespaced: false,
    summarize: (s) => {
      const isDefault = s.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';
      return {
        status: isDefault ? 'Default' : 'Available', health: 'healthy',
        info: [['Provisioner', none(s.provisioner)], ['Reclaim', none(s.reclaimPolicy)],
          ['Binding', none(s.volumeBindingMode)], ['Expandable', s.allowVolumeExpansion ? 'yes' : 'no']],
      };
    },
  },

  // ── Config (projected — contents never read) ─────────────────────────────
  {
    key: 'CM', kind: 'ConfigMap', resource: 'configmaps', group: 'Config', namespaced: true,
    columns: ['NS:.metadata.namespace', 'NAME:.metadata.name', 'CREATED:.metadata.creationTimestamp'],
    fromColumns: ([ns, name, created]) =>
      name ? { kind: 'ConfigMap', namespace: ns, name, created, status: 'Present', health: 'healthy', info: [] } : null,
  },
  {
    key: 'SECRET', kind: 'Secret', resource: 'secrets', group: 'Config', namespaced: true,
    columns: ['NS:.metadata.namespace', 'NAME:.metadata.name', 'TYPE:.type', 'CREATED:.metadata.creationTimestamp'],
    fromColumns: ([ns, name, type, created]) =>
      name ? { kind: 'Secret', namespace: ns, name, created, status: 'Present', health: 'healthy', info: [['Type', none(type)]] } : null,
  },
  {
    key: 'SA', kind: 'ServiceAccount', resource: 'serviceaccounts', group: 'Config', namespaced: true,
    columns: ['NS:.metadata.namespace', 'NAME:.metadata.name', 'CREATED:.metadata.creationTimestamp'],
    fromColumns: ([ns, name, created]) =>
      name ? { kind: 'ServiceAccount', namespace: ns, name, created, status: 'Present', health: 'healthy', info: [] } : null,
  },

  // ── Certificates (cert-manager) ──────────────────────────────────────────
  {
    key: 'CERT', kind: 'Certificate', resource: 'certificates.cert-manager.io', group: 'Certificates', namespaced: true,
    summarize: (c) => {
      const r = readyFromCondition(c);
      const days = daysUntil(c.status?.notAfter);
      let status = r.status;
      let health = r.health;
      if (days !== undefined && days < 0) { status = 'Expired'; health = 'failing'; }
      else if (r.health === 'healthy' && days !== undefined && days <= 14) { status = 'ExpiringSoon'; health = 'progressing'; }
      return {
        status, health,
        info: [['Expires', c.status?.notAfter ? `${c.status.notAfter.slice(0, 10)}${days !== undefined ? ` (${days}d)` : ''}` : '—'],
          ['Renews', none(c.status?.renewalTime?.slice(0, 10))], ['DNS names', (c.spec?.dnsNames || []).join(', ') || none(c.spec?.commonName)],
          ['Issuer', `${c.spec?.issuerRef?.kind || 'Issuer'}/${c.spec?.issuerRef?.name || '—'}`], ['Secret', none(c.spec?.secretName)]],
      };
    },
  },
  {
    key: 'ISSUER', kind: 'Issuer', resource: 'issuers.cert-manager.io', group: 'Certificates', namespaced: true,
    summarize: (i) => ({ ...readyFromCondition(i), info: [['Type', Object.keys(i.spec || {}).join(', ') || '—']] }),
  },
  {
    key: 'CISSUER', kind: 'ClusterIssuer', resource: 'clusterissuers.cert-manager.io', group: 'Certificates', namespaced: false,
    summarize: (i) => ({ ...readyFromCondition(i), info: [['Type', Object.keys(i.spec || {}).join(', ') || '—']] }),
  },

  // ── Cluster ──────────────────────────────────────────────────────────────
  {
    key: 'NS', kind: 'Namespace', resource: 'namespaces', group: 'Cluster', namespaced: false,
    summarize: (n) => {
      const phase = n.status?.phase || 'Active';
      return { status: phase, health: phase === 'Active' ? 'healthy' : 'progressing', info: [] };
    },
  },
  {
    key: 'QUOTA', kind: 'ResourceQuota', resource: 'resourcequotas', group: 'Cluster', namespaced: true,
    summarize: (q) => {
      const hard = q.status?.hard || {};
      const used = q.status?.used || {};
      const full = Object.keys(hard).filter((k) => String(used[k]) === String(hard[k]) && String(hard[k]) !== '0');
      return {
        status: full.length ? 'AtLimit' : 'OK',
        health: full.length ? 'progressing' : 'healthy',
        info: [['Used / hard', Object.keys(hard).slice(0, 4).map((k) => `${k}: ${used[k] ?? 0}/${hard[k]}`).join(' · ') || '—']],
      };
    },
  },
  {
    key: 'EVENT', kind: 'Event', resource: 'events', group: 'Cluster', namespaced: true,
    extra: ['--field-selector', 'type=Warning'],
    summarize: (e) => ({
      status: e.reason || 'Warning', health: 'progressing',
      info: [['Object', `${e.involvedObject?.kind || ''}/${e.involvedObject?.name || ''}`], ['Count', String(e.count ?? e.series?.count ?? 1)],
        ['Last seen', e.lastTimestamp || e.eventTime ? `${fmtDuration(e.lastTimestamp || e.eventTime)} ago` : '—'],
        ['Message', String(e.message || '').slice(0, 220)]],
    }),
  },
  {
    key: 'CRD', kind: 'CustomResourceDefinition', resource: 'customresourcedefinitions.apiextensions.k8s.io', group: 'Cluster', namespaced: false,
    columns: ['NAME:.metadata.name', 'GROUP:.spec.group', 'SCOPE:.spec.scope', 'CREATED:.metadata.creationTimestamp'],
    fromColumns: ([name, group, scope, created]) =>
      name ? { kind: 'CustomResourceDefinition', name, created, status: 'Established', health: 'healthy', info: [['Group', none(group)], ['Scope', none(scope)]] } : null,
  },
];

export function stepFor(spec: KindSpec): Step {
  const args = ['get', spec.resource];
  if (spec.namespaced) args.push('--all-namespaces');
  if (spec.extra) args.push(...spec.extra);
  if (spec.columns) args.push('--no-headers', '-o', `custom-columns=${spec.columns.join(',')}`);
  else args.push('-o', 'json');
  // Namespaces always exist, so that one query is not optional: if it fails,
  // kubectl's message (unreachable API, no permission) is what gets reported.
  return { tag: spec.key, args, optional: spec.key !== 'NS' };
}

/** Turn one kind's raw kubectl output into rows. `null` = the query produced nothing usable. */
export function rowsFor(spec: KindSpec, raw: string): ResourceRow[] | null {
  if (spec.columns) {
    // These kinds exist on every cluster, so a query that ran and printed
    // nothing ("No resources found" goes to stderr) means zero objects.
    const text = (raw || '').trim();
    if (!text || /^No resources/i.test(text)) return [];
    if (/^error/i.test(text)) return null;
    const rows: ResourceRow[] = [];
    for (const line of text.split('\n')) {
      const cols = line.trim().split(/\s+/).map((c) => (c === '<none>' ? '' : c));
      const r = spec.fromColumns?.(cols);
      if (r) rows.push(r);
    }
    return rows;
  }
  const parsed = parseJson(raw);
  if (!parsed || !Array.isArray(parsed.items)) return null;
  return parsed.items.map((item: any) => {
    const s = spec.summarize ? spec.summarize(item) : { status: 'Present', health: 'unknown' as Health, info: [] };
    return {
      kind: spec.kind,
      name: item?.metadata?.name || '',
      ...(spec.namespaced ? { namespace: item?.metadata?.namespace || 'default' } : {}),
      created: item?.metadata?.creationTimestamp,
      ...s,
    };
  });
}

export const resourcesRouter = Router();

/**
 * GET /api/k8s/extra[?vm=<inventory name>] — every kind above, read-only.
 * `kinds[key]` says per kind whether it was read ('ok') or is absent from this
 * cluster ('absent'), so "no certificates" and "no cert-manager" read differently.
 */
resourcesRouter.get('/api/k8s/extra', async (req, res) => {
  const vm = req.query.vm ? String(req.query.vm) : undefined;
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });
  try {
    const { out, ok, error } = await runSteps(KINDS.map(stepFor), vm, 120_000, 1024 * 1024 * 96);
    if (ok.size === 0) {
      return res.status(200).json({
        error: error || 'kubectl returned nothing for any resource kind — is a cluster reachable from this source?',
        rows: [], kinds: {},
      });
    }
    const kinds: Record<string, { kind: string; group: string; state: 'ok' | 'absent'; count: number }> = {};
    const rows: ResourceRow[] = [];
    for (const spec of KINDS) {
      const r = ok.has(spec.key) ? rowsFor(spec, out[spec.key]) : null;
      kinds[spec.key] = { kind: spec.kind, group: spec.group, state: r ? 'ok' : 'absent', count: r ? r.length : 0 };
      if (r) rows.push(...r);
    }
    res.json({ ok: true, readOnly: true, rows, kinds, at: new Date().toISOString() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Could not read cluster resources.' });
  }
});
