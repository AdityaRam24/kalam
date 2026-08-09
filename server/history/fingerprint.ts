// Reduce live cluster objects to fingerprints — the small set of fields whose
// change is worth telling somebody about.
//
// This is the judgement layer of the history feature. Every field included
// here becomes a line an operator may be woken up by; every field left out is
// a change Kalam will never notice. The bar is: "would I want this in a
// changelog?" So `spec.template.spec.containers[0].image` is in, and
// `metadata.resourceVersion`, `status.observedGeneration` and the churn of
// pod-template hashes are deliberately out.
//
// Two rules keep the output honest:
//
//   1. NO STATUS CHURN. Fields that flap on their own (readyReplicas, endpoint
//      counts, resourceVersion, lastHeartbeatTime) are excluded. The exceptions
//      are transitions an operator treats as an event in their own right — a
//      node going NotReady, a pod landing on a different node.
//   2. TRUNCATION NEVER HIDES A CHANGE. Long values (env blocks, RBAC rules)
//      are capped for storage, but the cap appends a digest of the WHOLE value,
//      so an edit past the cutoff still shows up as a different string.
//
// The module is PURE — parsed JSON in, plain data out — so all of it is
// testable from fixtures without a cluster.

import type { Fingerprint } from './model.js';
import { objectKey } from './model.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Stable short digest. Not cryptographic — it only has to notice difference. */
export function digest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  let h2 = 52711;
  for (let i = s.length - 1; i >= 0; i--) h2 = ((h2 << 5) + h2 + s.charCodeAt(i)) | 0;
  return ((h >>> 0).toString(16) + (h2 >>> 0).toString(16)).slice(0, 12);
}

/** Cap a value for storage while keeping it change-sensitive (see header). */
export function capped(s: string, n = 180): string {
  return s.length <= n ? s : `${s.slice(0, n)}…#${digest(s)}`;
}

const str = (v: any): string | undefined =>
  v === undefined || v === null || v === '' ? undefined : String(v);

const sortedPairs = (o: any): string =>
  o && typeof o === 'object'
    ? Object.entries(o)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(',')
    : '';

/** Drop empty entries so an absent field and an empty one compare equal. */
function clean(spec: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Who last wrote this object, from `metadata.managedFields`.
 *
 * This is the closest thing to an audit trail a cluster gives you for free:
 * the API server records, per writer, which fields it owns and when it last
 * set them. Writers of the *status* subresource are skipped — a controller
 * updating status is not "who changed this".
 *
 * Note kubectl hides managedFields unless `--show-managed-fields=true` is
 * passed, so this returns nothing on captures that did not ask for them.
 */
export function attribution(meta: any): { actor?: string; actorOp?: string; actorAt?: string } {
  const fields: any[] = Array.isArray(meta?.managedFields) ? meta.managedFields : [];
  let best: any;
  for (const f of fields) {
    if (f?.subresource === 'status') continue;
    if (!f?.time) continue;
    if (!best || Date.parse(f.time) > Date.parse(best.time)) best = f;
  }
  if (!best) return {};
  return { actor: str(best.manager), actorOp: str(best.operation), actorAt: str(best.time) };
}

// ---------------------------------------------------------------------------
// Pod template — shared by every workload kind
// ---------------------------------------------------------------------------

function containerFields(prefix: string, containers: any[], out: Record<string, string | undefined>): void {
  for (const c of containers || []) {
    const n = c?.name || '?';
    out[`${prefix}image.${n}`] = str(c?.image);
    out[`${prefix}args.${n}`] = capped([...(c?.command || []), ...(c?.args || [])].join(' '));
    out[`${prefix}requests.${n}`] = sortedPairs(c?.resources?.requests) || undefined;
    out[`${prefix}limits.${n}`] = sortedPairs(c?.resources?.limits) || undefined;
    out[`${prefix}ports.${n}`] =
      (c?.ports || []).map((p: any) => `${p.containerPort}/${p.protocol || 'TCP'}`).sort().join(',') || undefined;
    // Env is where most "why did behaviour change" edits hide, so we track it —
    // but INLINE VALUES ARE HASHED, NEVER STORED. People put tokens and
    // passwords in plain `env.value`, and the history log is a plaintext file
    // on disk. A hash still changes when the value changes, which is all the
    // diff needs; the variable NAME stays readable so the timeline can say
    // which setting moved. References name their source, not their contents.
    const env = (c?.env || [])
      .map((e: any) => {
        const ref = e?.valueFrom?.configMapKeyRef || e?.valueFrom?.secretKeyRef || e?.valueFrom?.fieldRef;
        if (ref) return `${e?.name}=<${ref.name || ref.fieldPath}${ref.key ? `/${ref.key}` : ''}>`;
        return `${e?.name}=${e?.value === undefined || e.value === '' ? '' : `#${digest(String(e.value))}`}`;
      })
      .sort()
      .join(';');
    out[`${prefix}env.${n}`] = env ? capped(env) : undefined;
    out[`${prefix}envFrom.${n}`] =
      (c?.envFrom || [])
        .map((f: any) => f?.configMapRef?.name || f?.secretRef?.name)
        .filter(Boolean)
        .sort()
        .join(',') || undefined;
    out[`${prefix}probes.${n}`] =
      [c?.livenessProbe && 'liveness', c?.readinessProbe && 'readiness', c?.startupProbe && 'startup']
        .filter(Boolean)
        .join(',') || undefined;
    out[`${prefix}mounts.${n}`] =
      (c?.volumeMounts || []).map((m: any) => `${m.name}:${m.mountPath}${m.readOnly ? ':ro' : ''}`).sort().join(',') ||
      undefined;
  }
}

/** Everything in a pod template that an operator would call "the deployment". */
export function templateFields(template: any): Record<string, string | undefined> {
  const spec = template?.spec || {};
  const out: Record<string, string | undefined> = {};
  containerFields('', spec.containers || [], out);
  containerFields('init.', spec.initContainers || [], out);
  out['serviceAccount'] = str(spec.serviceAccountName || spec.serviceAccount);
  out['nodeSelector'] = sortedPairs(spec.nodeSelector) || undefined;
  out['tolerations'] =
    (spec.tolerations || [])
      .map((t: any) => `${t.key || '*'}${t.value ? `=${t.value}` : ''}:${t.effect || '*'}`)
      .sort()
      .join(',') || undefined;
  out['affinity'] = spec.affinity ? digest(JSON.stringify(spec.affinity)) : undefined;
  out['volumes'] =
    (spec.volumes || [])
      .map((v: any) => {
        const src =
          v?.persistentVolumeClaim?.claimName ? `pvc:${v.persistentVolumeClaim.claimName}`
          : v?.configMap?.name ? `cm:${v.configMap.name}`
          : v?.secret?.secretName ? `secret:${v.secret.secretName}`
          : Object.keys(v || {}).find((k) => k !== 'name') || '?';
        return `${v?.name}=${src}`;
      })
      .sort()
      .join(',') || undefined;
  out['hostNetwork'] = spec.hostNetwork ? 'true' : undefined;
  out['priorityClass'] = str(spec.priorityClassName);
  out['runtimeClass'] = str(spec.runtimeClassName);
  out['templateLabels'] = sortedPairs(template?.metadata?.labels) || undefined;
  return out;
}

// ---------------------------------------------------------------------------
// Per-kind extraction
// ---------------------------------------------------------------------------

type Extract = (o: any) => Record<string, string | undefined>;

const workload: Extract = (o) => ({
  replicas: str(o?.spec?.replicas),
  paused: o?.spec?.paused ? 'true' : undefined,
  strategy: str(o?.spec?.strategy?.type || o?.spec?.updateStrategy?.type),
  selector: sortedPairs(o?.spec?.selector?.matchLabels) || undefined,
  ...templateFields(o?.spec?.template),
});

const EXTRACT: Record<string, Extract> = {
  Deployment: workload,
  StatefulSet: (o) => ({
    ...workload(o),
    serviceName: str(o?.spec?.serviceName),
    volumeClaims:
      (o?.spec?.volumeClaimTemplates || [])
        .map((v: any) => `${v?.metadata?.name}:${v?.spec?.resources?.requests?.storage}`)
        .sort()
        .join(',') || undefined,
  }),
  DaemonSet: workload,
  ReplicaSet: workload,
  Job: (o) => ({
    ...workload(o),
    completions: str(o?.spec?.completions),
    parallelism: str(o?.spec?.parallelism),
    suspend: o?.spec?.suspend ? 'true' : undefined,
  }),
  CronJob: (o) => ({
    schedule: str(o?.spec?.schedule),
    suspend: o?.spec?.suspend ? 'true' : undefined,
    concurrency: str(o?.spec?.concurrencyPolicy),
    ...templateFields(o?.spec?.jobTemplate?.spec?.template),
  }),

  Service: (o) => ({
    type: str(o?.spec?.type) || 'ClusterIP',
    clusterIP: str(o?.spec?.clusterIP),
    externalName: str(o?.spec?.externalName),
    externalIPs: (o?.spec?.externalIPs || []).slice().sort().join(',') || undefined,
    loadBalancer:
      (o?.status?.loadBalancer?.ingress || []).map((i: any) => i.ip || i.hostname).filter(Boolean).sort().join(',') ||
      undefined,
    ports:
      (o?.spec?.ports || [])
        .map((p: any) => `${p.name || p.port}:${p.port}->${p.targetPort ?? p.port}/${p.protocol || 'TCP'}${p.nodePort ? `@${p.nodePort}` : ''}`)
        .sort()
        .join(',') || undefined,
    selector: sortedPairs(o?.spec?.selector) || undefined,
    sessionAffinity: o?.spec?.sessionAffinity && o.spec.sessionAffinity !== 'None' ? o.spec.sessionAffinity : undefined,
  }),

  Ingress: (o) => ({
    class: str(o?.spec?.ingressClassName || o?.metadata?.annotations?.['kubernetes.io/ingress.class']),
    rules: capped(
      (o?.spec?.rules || [])
        .flatMap((r: any) =>
          (r?.http?.paths || []).map(
            (p: any) => `${r.host || '*'}${p.path || '/'}->${p?.backend?.service?.name || p?.backend?.serviceName}:${p?.backend?.service?.port?.number ?? p?.backend?.service?.port?.name ?? ''}`
          )
        )
        .sort()
        .join(',')
    ) || undefined,
    defaultBackend: str(o?.spec?.defaultBackend?.service?.name),
    tls: (o?.spec?.tls || []).flatMap((t: any) => t?.hosts || []).sort().join(',') || undefined,
    address:
      (o?.status?.loadBalancer?.ingress || []).map((i: any) => i.ip || i.hostname).filter(Boolean).sort().join(',') ||
      undefined,
  }),

  NetworkPolicy: (o) => ({
    podSelector: sortedPairs(o?.spec?.podSelector?.matchLabels) || '(all pods)',
    policyTypes: (o?.spec?.policyTypes || []).slice().sort().join(','),
    ingressRules: o?.spec?.ingress ? digest(JSON.stringify(o.spec.ingress)) : undefined,
    egressRules: o?.spec?.egress ? digest(JSON.stringify(o.spec.egress)) : undefined,
  }),

  Node: (o) => {
    const conds: any[] = o?.status?.conditions || [];
    const ready = conds.find((c) => c.type === 'Ready');
    const pressure = conds
      .filter((c) => c.type !== 'Ready' && c.status === 'True')
      .map((c) => c.type)
      .sort()
      .join(',');
    const roles = Object.keys(o?.metadata?.labels || {})
      .filter((l) => l.startsWith('node-role.kubernetes.io/'))
      .map((l) => l.replace('node-role.kubernetes.io/', '') || 'master')
      .sort()
      .join(',');
    const cap = o?.status?.capacity || {};
    return {
      ready: str(ready?.status),
      pressure: pressure || undefined,
      unschedulable: o?.spec?.unschedulable ? 'true' : undefined,
      taints:
        (o?.spec?.taints || [])
          .map((t: any) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`)
          .sort()
          .join(',') || undefined,
      roles: roles || undefined,
      kubelet: str(o?.status?.nodeInfo?.kubeletVersion),
      runtime: str(o?.status?.nodeInfo?.containerRuntimeVersion),
      kernel: str(o?.status?.nodeInfo?.kernelVersion),
      os: str(o?.status?.nodeInfo?.osImage),
      cpu: str(cap.cpu),
      memory: str(cap.memory),
      gpu: str(cap['nvidia.com/gpu']),
      internalIP: str((o?.status?.addresses || []).find((a: any) => a.type === 'InternalIP')?.address),
    };
  },

  Namespace: (o) => ({
    phase: str(o?.status?.phase),
    // Pod Security Admission lives entirely in namespace labels: a change here
    // silently changes what every workload in the namespace may do.
    podSecurity:
      Object.entries(o?.metadata?.labels || {})
        .filter(([k]) => k.startsWith('pod-security.kubernetes.io/'))
        .map(([k, v]) => `${k.replace('pod-security.kubernetes.io/', '')}=${v}`)
        .sort()
        .join(',') || undefined,
  }),

  PersistentVolume: (o) => ({
    phase: str(o?.status?.phase),
    capacity: str(o?.spec?.capacity?.storage),
    storageClass: str(o?.spec?.storageClassName),
    reclaim: str(o?.spec?.persistentVolumeReclaimPolicy),
    claim: o?.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : undefined,
  }),

  PersistentVolumeClaim: (o) => ({
    phase: str(o?.status?.phase),
    capacity: str(o?.status?.capacity?.storage || o?.spec?.resources?.requests?.storage),
    storageClass: str(o?.spec?.storageClassName),
    volume: str(o?.spec?.volumeName),
    accessModes: (o?.spec?.accessModes || []).slice().sort().join(','),
  }),

  StorageClass: (o) => ({
    provisioner: str(o?.provisioner),
    reclaim: str(o?.reclaimPolicy),
    binding: str(o?.volumeBindingMode),
    default: o?.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'true' : undefined,
    params: sortedPairs(o?.parameters) ? capped(sortedPairs(o.parameters)) : undefined,
  }),

  PriorityClass: (o) => ({ value: str(o?.value), globalDefault: o?.globalDefault ? 'true' : undefined }),

  HorizontalPodAutoscaler: (o) => ({
    target: `${o?.spec?.scaleTargetRef?.kind}/${o?.spec?.scaleTargetRef?.name}`,
    min: str(o?.spec?.minReplicas),
    max: str(o?.spec?.maxReplicas),
    metrics: o?.spec?.metrics ? capped(JSON.stringify(o.spec.metrics)) : str(o?.spec?.targetCPUUtilizationPercentage),
  }),

  PodDisruptionBudget: (o) => ({
    minAvailable: str(o?.spec?.minAvailable),
    maxUnavailable: str(o?.spec?.maxUnavailable),
    selector: sortedPairs(o?.spec?.selector?.matchLabels) || undefined,
  }),

  ResourceQuota: (o) => ({ hard: capped(sortedPairs(o?.spec?.hard)) || undefined }),
  LimitRange: (o) => ({ limits: o?.spec?.limits ? digest(JSON.stringify(o.spec.limits)) : undefined }),

  ServiceAccount: (o) => ({
    secrets: (o?.secrets || []).map((s: any) => s?.name).filter(Boolean).sort().join(',') || undefined,
    imagePullSecrets: (o?.imagePullSecrets || []).map((s: any) => s?.name).filter(Boolean).sort().join(',') || undefined,
    automount: o?.automountServiceAccountToken === false ? 'false' : undefined,
  }),

  Role: (o) => ({ rules: `${(o?.rules || []).length} rules #${digest(JSON.stringify(o?.rules || []))}` }),
  ClusterRole: (o) => ({ rules: `${(o?.rules || []).length} rules #${digest(JSON.stringify(o?.rules || []))}` }),

  RoleBinding: (o) => ({
    roleRef: `${o?.roleRef?.kind}/${o?.roleRef?.name}`,
    subjects:
      (o?.subjects || [])
        .map((s: any) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ''}${s.name}`)
        .sort()
        .join(',') || undefined,
  }),
  ClusterRoleBinding: (o) => ({
    roleRef: `${o?.roleRef?.kind}/${o?.roleRef?.name}`,
    subjects: capped(
      (o?.subjects || [])
        .map((s: any) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ''}${s.name}`)
        .sort()
        .join(',')
    ) || undefined,
  }),

  CustomResourceDefinition: (o) => ({
    group: str(o?.spec?.group),
    names: str(o?.spec?.names?.kind),
    scope: str(o?.spec?.scope),
    versions: (o?.spec?.versions || []).map((v: any) => `${v.name}${v.served ? '' : '(unserved)'}`).sort().join(','),
  }),
};

/** Anything we have no opinion about still gets tracked, by spec digest. */
const genericExtract: Extract = (o) => ({
  spec: o?.spec ? digest(JSON.stringify(o.spec)) : undefined,
  data: o?.data ? `${Object.keys(o.data).length} keys #${digest(JSON.stringify(o.data))}` : undefined,
});

/** Turn one live object into its fingerprint. */
export function fingerprintObject(obj: any, kindHint?: string): Fingerprint | undefined {
  const kind = obj?.kind || kindHint;
  const name = obj?.metadata?.name;
  if (!kind || !name) return undefined;
  const meta = obj.metadata || {};
  const extract = EXTRACT[kind] || genericExtract;
  const owner = (meta.ownerReferences || [])[0];

  return {
    kind,
    name,
    namespace: meta.namespace || undefined,
    uid: meta.uid,
    createdAt: meta.creationTimestamp,
    generation: typeof meta.generation === 'number' ? meta.generation : undefined,
    observed: typeof obj?.status?.observedGeneration === 'number' ? obj.status.observedGeneration : undefined,
    spec: clean(extract(obj)),
    ...attribution(meta),
    cause: meta.annotations?.['kubernetes.io/change-cause'],
    revision: meta.annotations?.['deployment.kubernetes.io/revision'],
    owner: owner ? objectKey(owner.kind, owner.name, meta.namespace) : undefined,
  };
}

/**
 * Fingerprint every item of a `kubectl get ... -o json` List. Mixed-kind lists
 * (`kubectl get deploy,sts,ds -o json`) work because each item carries its own
 * kind — which is exactly why captures batch kinds into one call.
 */
export function fingerprintList(raw: any, kindHint?: string): Fingerprint[] {
  const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  const out: Fingerprint[] = [];
  for (const item of items) {
    const fp = fingerprintObject(item, kindHint);
    if (fp) out.push(fp);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compact formats
//
// Pods, ConfigMaps and Secrets are the three kinds where full JSON is both
// enormous and mostly irrelevant — and, for Secrets, something we would rather
// never transfer at all. They are captured through narrow column/template
// queries instead, and parsed here.
// ---------------------------------------------------------------------------

const NONE = new Set(['<none>', '<nil>', '', '-']);
const col = (v: string | undefined): string | undefined => (v && !NONE.has(v) ? v : undefined);

/**
 * Parse the pod table produced by `kubectl get pods -A -o custom-columns=…`.
 * Column order is fixed by POD_COLUMNS in collect.ts.
 */
export function parsePodTable(text: string): Fingerprint[] {
  const out: Fingerprint[] = [];
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('NS ') || t.startsWith('No resources')) continue;
    const c = t.split(/\s+/);
    if (c.length < 10) continue;
    const [ns, name, node, phase, ownerKind, ownerName, images, restarts, ready, created, uid] = c;
    const restartTotal = (col(restarts) || '')
      .split(',')
      .reduce((a, n) => a + (parseInt(n, 10) || 0), 0);
    out.push({
      kind: 'Pod',
      name,
      namespace: ns,
      uid: col(uid),
      createdAt: col(created),
      owner: col(ownerName) ? objectKey(col(ownerKind) || 'Controller', ownerName, ns) : undefined,
      spec: clean({
        node: col(node),
        phase: col(phase),
        images: col(images),
        restarts: String(restartTotal),
        ready: col(ready),
      }),
    });
  }
  return out;
}

/**
 * Parse `ns|name|resourceVersion[|extra]` lines from a jsonpath query.
 *
 * ConfigMaps and Secrets are tracked by resourceVersion alone: it moves on
 * every write and on nothing else, so it answers "was this edited?" without
 * Kalam ever reading — let alone storing — the contents.
 */
export function parseRvTable(text: string, kind: string, namespaced = true): Fingerprint[] {
  const out: Fingerprint[] = [];
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t || !t.includes('|')) continue;
    const parts = t.split('|');
    const ns = namespaced ? parts.shift() : undefined;
    const [name, rv, extra] = parts;
    if (!name) continue;
    out.push({
      kind,
      name,
      namespace: ns || undefined,
      spec: clean({ revision: col(rv), detail: col(extra) }),
    });
  }
  return out;
}
