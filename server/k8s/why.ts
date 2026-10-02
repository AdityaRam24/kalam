// Why is it failing?
//
// A status says THAT something is broken: CrashLoopBackOff, Pending, Not Ready.
// Operators need the cause, and the cause is usually somewhere else — an Issuer
// that does not exist, a ConfigMap that was never created, a label that no
// longer matches a selector, a taint nothing tolerates, a registry that refuses
// the credentials. This module reads the cluster the way a senior operator
// would and writes that down: what is failing, why, the evidence, the object
// that is the real cause, and the fix.
//
// Two kinds of output:
//   * Findings — something is wrong (or about to be). Each names its root cause
//     object when there is one, so the UI can jump to it.
//   * Contracts — the NON-NEGOTIABLES of an object: every reference and label/
//     annotation contract it depends on, each one ok / violated / unknown.
//     "unknown" is honest: if Trinetra could not read Secrets (RBAC), it says it
//     cannot tell, rather than claiming a Secret is missing.
//
// Pure: lists in, findings out — tested from fixtures in
// server/__tests__/why.test.ts. The router at the bottom only gathers data.

import { Router } from 'express';
import { runSteps, parseJson, SAFE_NAME, type Step } from './kubectl.js';
import { meaningOf, type KeyMeaning } from './contracts.js';

export type Severity = 'critical' | 'warning' | 'info';
export type Category =
  | 'image' | 'crash' | 'config' | 'scheduling' | 'storage' | 'probe' | 'network' | 'labels'
  | 'annotations' | 'certificate' | 'model' | 'node' | 'rollout' | 'quota' | 'lifecycle' | 'events';

export interface ObjRef { kind: string; name: string; namespace?: string }

export interface Finding {
  id: string;
  object: ObjRef;
  severity: Severity;
  category: Category;
  /** One line — the card shows this. */
  title: string;
  /** Plain-language explanation of the cause. */
  why: string;
  /** Facts that support it, quoted from the cluster. */
  evidence: string[];
  /** What to do / what to check, most likely first. */
  fix: string[];
  /** The object that is the real cause, when it is not the failing one. */
  rootCause?: ObjRef & { reason: string };
  /** Objects this one breaks in turn. */
  affects?: ObjRef[];
  /** Set when a non-negotiable contract is what is violated. */
  contract?: string;
  /** Label/annotation semantics, when the cause is a metadata key. */
  key?: { name: string } & KeyMeaning;
  /** When the cluster says it started, if it does. */
  since?: string;
}

export interface Contract {
  object: ObjRef;
  type: 'reference' | 'selector' | 'label' | 'annotation';
  rule: string;
  status: 'ok' | 'violated' | 'unknown';
  detail: string;
  key?: { name: string } & KeyMeaning;
}

export interface WhyInput {
  pods?: any[]; services?: any[]; endpoints?: any[]; workloads?: any[]; nodes?: any[]; namespaces?: any[];
  events?: any[]; certificates?: any[]; issuers?: any[]; clusterIssuers?: any[]; ingresses?: any[];
  ingressClasses?: any[]; isvcs?: any[]; servingRuntimes?: any[]; clusterServingRuntimes?: any[];
  pvcs?: any[]; storageClasses?: any[]; hpas?: any[]; virtualServices?: any[]; gateways?: any[];
  /** Names only — contents are never read. */
  configMaps?: Array<{ namespace: string; name: string }>;
  secrets?: Array<{ namespace: string; name: string; type?: string }>;
  serviceAccounts?: Array<{ namespace: string; name: string }>;
  /** Which of the lists above were actually read (others are "unknown"). */
  read: Set<string>;
  now?: number;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const key = (kind: string, ns: string | undefined, name: string) => `${kind}/${ns || ''}/${name}`;
const meta = (o: any) => o?.metadata || {};
const nsOf = (o: any) => meta(o).namespace || 'default';
const nameOf = (o: any) => meta(o).name || '';
const refOf = (kind: string, o: any, namespaced = true): ObjRef =>
  namespaced ? { kind, name: nameOf(o), namespace: nsOf(o) } : { kind, name: nameOf(o) };
const conds = (o: any): any[] => (Array.isArray(o?.status?.conditions) ? o.status.conditions : []);
const cond = (o: any, type: string) => conds(o).find((c) => c?.type === type);
const pairs = (o: any) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join(', ');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const trunc = (s: unknown, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export class Index {
  readonly input: WhyInput;
  private sets = new Map<string, Set<string>>();
  private byKey = new Map<string, any>();
  readonly eventsByObj = new Map<string, any[]>();
  readonly podsByNs = new Map<string, any[]>();

  constructor(input: WhyInput) {
    this.input = input;
    const add = (kind: string, list: any[] | undefined, namespaced = true) => {
      const s = new Set<string>();
      for (const o of list || []) {
        if (!o) continue;
        const name = o?.metadata ? nameOf(o) : o.name;
        const ns = namespaced ? (o?.metadata ? nsOf(o) : o.namespace) : undefined;
        if (!name) continue;
        s.add(key(kind, ns, name));
        this.byKey.set(key(kind, ns, name), o);
      }
      this.sets.set(kind, s);
    };
    add('Pod', input.pods); add('Service', input.services); add('Endpoints', input.endpoints);
    add('Node', input.nodes, false); add('Namespace', input.namespaces, false);
    add('Certificate', input.certificates); add('Issuer', input.issuers); add('ClusterIssuer', input.clusterIssuers, false);
    add('Ingress', input.ingresses); add('IngressClass', input.ingressClasses, false);
    add('InferenceService', input.isvcs); add('ServingRuntime', input.servingRuntimes);
    add('ClusterServingRuntime', input.clusterServingRuntimes, false);
    add('PersistentVolumeClaim', input.pvcs); add('StorageClass', input.storageClasses, false);
    add('HorizontalPodAutoscaler', input.hpas); add('VirtualService', input.virtualServices); add('Gateway', input.gateways);
    add('ConfigMap', input.configMaps); add('Secret', input.secrets); add('ServiceAccount', input.serviceAccounts);
    // One list, three kinds.
    for (const k of ['Deployment', 'StatefulSet', 'DaemonSet']) add(k, (input.workloads || []).filter((w) => (w?.kind || 'Deployment') === k));
    for (const e of input.events || []) {
      const io = e?.involvedObject || e?.regarding || {};
      if (!io.name) continue;
      const k = key(io.kind, io.namespace || (io.kind === 'Node' ? undefined : e?.metadata?.namespace), io.name);
      (this.eventsByObj.get(k) || this.eventsByObj.set(k, []).get(k)!).push(e);
    }
    for (const p of input.pods || []) {
      const ns = nsOf(p);
      (this.podsByNs.get(ns) || this.podsByNs.set(ns, []).get(ns)!).push(p);
    }
  }

  /** Was this kind actually read? If not, its absence proves nothing. */
  known(listName: keyof WhyInput): boolean {
    return this.input.read.has(listName as string);
  }
  has(kind: string, ns: string | undefined, name: string): boolean {
    return !!this.sets.get(kind)?.has(key(kind, ns, name));
  }
  get(kind: string, ns: string | undefined, name: string): any {
    return this.byKey.get(key(kind, ns, name));
  }
  events(kind: string, ns: string | undefined, name: string): any[] {
    return this.eventsByObj.get(key(kind, ns, name)) || [];
  }
}

const eventLine = (e: any) =>
  `${e?.reason || 'Event'}${(e?.count || e?.series?.count || 1) > 1 ? ` ×${e.count || e.series.count}` : ''}: ${trunc(e?.message || e?.note, 260)}`;
const warnings = (evs: any[]) => evs.filter((e) => e?.type === 'Warning');
const firstSeen = (evs: any[]): string | undefined =>
  evs.map((e) => e?.firstTimestamp || e?.eventTime || e?.metadata?.creationTimestamp).filter(Boolean).sort()[0];

let seq = 0;
const fid = (o: ObjRef, tag: string) => `${o.kind}/${o.namespace || ''}/${o.name}#${tag}#${(seq++).toString(36)}`;

// ---------------------------------------------------------------------------
// Image pulls — the message decides the cause
// ---------------------------------------------------------------------------

export function classifyPull(message: string): { title: string; why: string; fix: string[]; cause: 'auth' | 'missing' | 'tls' | 'network' | 'ratelimit' | 'other' } {
  const m = message || '';
  if (/unauthorized|authentication required|pull access denied|denied|forbidden|403|401|no basic auth credentials|requested access to the resource is denied/i.test(m)) {
    return {
      cause: 'auth',
      title: 'Registry refused the image pull (credentials)',
      why: 'The registry answered, but rejected the request: the image is private and the node presented no credentials, or the wrong ones.',
      fix: [
        'Create a pull secret: kubectl create secret docker-registry <name> --docker-server=<registry> --docker-username=<user> --docker-password=<token> -n <namespace>',
        'Reference it in the pod spec (imagePullSecrets) or on the ServiceAccount the pod uses.',
        'If a pull secret is already referenced, check its registry host matches the image and the token has not expired.',
      ],
    };
  }
  if (/not found|manifest unknown|does not exist|404|repository .* not exist|name unknown/i.test(m)) {
    return {
      cause: 'missing',
      title: 'Image or tag does not exist',
      why: 'The registry has no image under that name and tag (typo, tag never pushed, or pushed to another registry/project).',
      fix: ['Check the exact image reference against the registry.', 'Push the tag, or roll back to the last tag that exists.'],
    };
  }
  if (/x509|certificate|tls/i.test(m)) {
    return {
      cause: 'tls',
      title: 'Node does not trust the registry’s TLS certificate',
      why: 'The container runtime on the node rejected the registry certificate (self-signed or private CA).',
      fix: ['Install the registry CA on the nodes (containerd: /etc/containerd/certs.d/<registry>/ca.crt).', 'Or mark the registry insecure in the runtime config — not recommended.'],
    };
  }
  if (/toomanyrequests|rate limit/i.test(m)) {
    return {
      cause: 'ratelimit', title: 'Registry rate limit hit',
      why: 'The registry (typically Docker Hub) throttled anonymous or free-tier pulls.',
      fix: ['Use an authenticated pull secret, or mirror the image to a private registry.'],
    };
  }
  if (/timeout|i\/o timeout|no such host|connection refused|dial tcp|network is unreachable|context deadline/i.test(m)) {
    return {
      cause: 'network', title: 'Node cannot reach the registry',
      why: 'DNS, proxy or firewall: the node never got an answer from the registry.',
      fix: ['From the node: crictl pull <image> (or curl -v https://<registry>/v2/).', 'Check HTTP(S)_PROXY / NO_PROXY in the container runtime config and DNS resolution.'],
    };
  }
  return { cause: 'other', title: 'Image cannot be pulled', why: 'The runtime could not pull the image.', fix: ['kubectl describe pod to read the full pull error.'] };
}

// ---------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------

/** Every object a pod spec cannot start without. */
function podReferences(spec: any): Array<{ kind: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim'; name: string; optional: boolean; where: string }> {
  const out: Array<{ kind: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim'; name: string; optional: boolean; where: string }> = [];
  const containers = [...(spec?.initContainers || []), ...(spec?.containers || [])];
  for (const c of containers) {
    for (const e of c?.env || []) {
      const cm = e?.valueFrom?.configMapKeyRef;
      const sec = e?.valueFrom?.secretKeyRef;
      if (cm?.name) out.push({ kind: 'ConfigMap', name: cm.name, optional: !!cm.optional, where: `env ${e.name} in ${c.name}` });
      if (sec?.name) out.push({ kind: 'Secret', name: sec.name, optional: !!sec.optional, where: `env ${e.name} in ${c.name}` });
    }
    for (const f of c?.envFrom || []) {
      if (f?.configMapRef?.name) out.push({ kind: 'ConfigMap', name: f.configMapRef.name, optional: !!f.configMapRef.optional, where: `envFrom in ${c.name}` });
      if (f?.secretRef?.name) out.push({ kind: 'Secret', name: f.secretRef.name, optional: !!f.secretRef.optional, where: `envFrom in ${c.name}` });
    }
  }
  for (const v of spec?.volumes || []) {
    if (v?.configMap?.name) out.push({ kind: 'ConfigMap', name: v.configMap.name, optional: !!v.configMap.optional, where: `volume ${v.name}` });
    if (v?.secret?.secretName) out.push({ kind: 'Secret', name: v.secret.secretName, optional: !!v.secret.optional, where: `volume ${v.name}` });
    if (v?.persistentVolumeClaim?.claimName) out.push({ kind: 'PersistentVolumeClaim', name: v.persistentVolumeClaim.claimName, optional: false, where: `volume ${v.name}` });
    for (const s of v?.projected?.sources || []) {
      if (s?.configMap?.name) out.push({ kind: 'ConfigMap', name: s.configMap.name, optional: !!s.configMap.optional, where: `projected volume ${v.name}` });
      if (s?.secret?.name) out.push({ kind: 'Secret', name: s.secret.name, optional: !!s.secret.optional, where: `projected volume ${v.name}` });
    }
  }
  return out;
}

const LIST_FOR: Record<string, keyof WhyInput> = {
  ConfigMap: 'configMaps', Secret: 'secrets', PersistentVolumeClaim: 'pvcs', ServiceAccount: 'serviceAccounts',
  Node: 'nodes', Service: 'services', Issuer: 'issuers', ClusterIssuer: 'clusterIssuers', IngressClass: 'ingressClasses',
  StorageClass: 'storageClasses', ServingRuntime: 'servingRuntimes', ClusterServingRuntime: 'clusterServingRuntimes',
  Gateway: 'gateways', Deployment: 'workloads', StatefulSet: 'workloads',
};

/** Exists / missing / cannot tell — for one referenced object. */
function refStatus(ix: Index, kind: string, ns: string | undefined, name: string): 'ok' | 'violated' | 'unknown' {
  if (ix.has(kind, ns, name)) return 'ok';
  const list = LIST_FOR[kind];
  return list && ix.known(list) ? 'violated' : 'unknown';
}

/** Nodes whose labels satisfy a nodeSelector. */
function nodesMatching(ix: Index, selector: Record<string, string>): any[] {
  return (ix.input.nodes || []).filter((n) => Object.entries(selector).every(([k, v]) => meta(n).labels?.[k] === v));
}


export function podContracts(pod: any, ix: Index): Contract[] {
  const ns = nsOf(pod);
  const object = refOf('Pod', pod);
  const out: Contract[] = [];
  const seen = new Set<string>();
  for (const r of podReferences(pod?.spec)) {
    const k = `${r.kind}/${r.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let status = refStatus(ix, r.kind, ns, r.name);
    let detail = status === 'ok' ? 'exists' : status === 'violated' ? 'does not exist in this namespace' : 'could not be checked (not readable)';
    if (status === 'violated' && r.optional) { status = 'ok'; detail = 'missing, but marked optional'; }
    if (r.kind === 'PersistentVolumeClaim' && status === 'ok') {
      const pvc = ix.get('PersistentVolumeClaim', ns, r.name);
      const phase = pvc?.status?.phase;
      if (phase && phase !== 'Bound') { status = 'violated'; detail = `exists but is ${phase}`; }
    }
    out.push({ object, type: 'reference', rule: `${r.kind} ${r.name} exists (${r.where})`, status, detail });
  }
  const sa = pod?.spec?.serviceAccountName || pod?.spec?.serviceAccount || 'default';
  const saStatus = refStatus(ix, 'ServiceAccount', ns, sa);
  out.push({ object, type: 'reference', rule: `ServiceAccount ${sa} exists`, status: saStatus, detail: saStatus === 'violated' ? 'pods using it cannot be created' : saStatus === 'ok' ? 'exists' : 'could not be checked' });
  for (const s of pod?.spec?.imagePullSecrets || []) {
    if (!s?.name) continue;
    const st = refStatus(ix, 'Secret', ns, s.name);
    out.push({ object, type: 'reference', rule: `Image pull secret ${s.name} exists`, status: st, detail: st === 'violated' ? 'private images will fail to pull' : st === 'ok' ? 'exists' : 'could not be checked' });
  }
  const sel = pod?.spec?.nodeSelector;
  if (sel && Object.keys(sel).length && ix.known('nodes')) {
    const m = nodesMatching(ix, sel);
    out.push({
      object, type: 'label', rule: `nodeSelector ${pairs(sel)} matches a node`,
      status: m.length ? 'ok' : 'violated',
      detail: m.length ? `${plural(m.length, 'node')} match` : 'no node carries these labels — the pod can never be scheduled',
      key: (() => { const k = Object.keys(sel)[0]; const mm = meaningOf(k); return mm ? { name: k, ...mm } : undefined; })(),
    });
  }
  const istioOff = meta(pod).annotations?.['sidecar.istio.io/inject'] ?? meta(pod).labels?.['sidecar.istio.io/inject'];
  if (istioOff === 'false') {
    const nsObj = ix.get('Namespace', undefined, ns);
    if (meta(nsObj).labels?.['istio-injection'] === 'enabled') {
      out.push({ object, type: 'annotation', rule: 'Pod joins the mesh of its namespace', status: 'violated',
        detail: 'sidecar.istio.io/inject=false on a pod in an istio-injection=enabled namespace — it gets no sidecar',
        key: { name: 'sidecar.istio.io/inject', ...meaningOf('sidecar.istio.io/inject')! } });
    }
  }
  return out;
}

function containerFinding(pod: any, ix: Index, cs: any, isInit: boolean): Finding | undefined {
  const object = refOf('Pod', pod);
  const ns = nsOf(pod);
  const w = cs?.state?.waiting;
  const t = cs?.state?.terminated;
  const last = cs?.lastState?.terminated;
  const evs = ix.events('Pod', ns, nameOf(pod));
  const where = `${isInit ? 'init container' : 'container'} ${cs?.name}`;
  const specC = [...(pod?.spec?.initContainers || []), ...(pod?.spec?.containers || [])].find((c: any) => c?.name === cs?.name);

  if (w?.reason && /ImagePull|ErrImage|InvalidImageName|RegistryUnavailable/.test(w.reason)) {
    const pullEvent = warnings(evs).find((e) => /Failed|ErrImage|BackOff/.test(e?.reason || '') && /pull|image/i.test(e?.message || ''));
    const msg = w.message || pullEvent?.message || '';
    const c = classifyPull(msg);
    const f: Finding = {
      id: fid(object, 'pull'), object, severity: 'critical', category: 'image',
      title: cs?.image || specC?.image ? `${c.title} — ${cs?.image || specC?.image}` : c.title,
      why: c.why, evidence: [`${where}: ${w.reason}${msg ? ` — ${trunc(msg)}` : ''}`], fix: c.fix, since: firstSeen(evs),
    };
    if (c.cause === 'auth') {
      const secrets = (pod?.spec?.imagePullSecrets || []).map((s: any) => s?.name).filter(Boolean);
      const missing = secrets.find((s: string) => refStatus(ix, 'Secret', ns, s) === 'violated');
      if (missing) {
        f.rootCause = { kind: 'Secret', name: missing, namespace: ns, reason: 'referenced as imagePullSecret but does not exist' };
        f.contract = `Image pull secret ${missing} exists`;
        f.why = `The pod references image pull secret "${missing}", but no such Secret exists in ${ns} — so the node pulls with no credentials and the private registry refuses.`;
      } else if (!secrets.length) {
        f.evidence.push('The pod references no imagePullSecrets (and none come from its ServiceAccount, if this list is complete).');
      } else {
        f.evidence.push(`Pull secrets in use: ${secrets.join(', ')} — they exist, so their credentials are wrong, expired, or for another registry host.`);
      }
    }
    return f;
  }

  if (w?.reason === 'CreateContainerConfigError' || w?.reason === 'CreateContainerError') {
    const msg = w.message || warnings(evs).find((e) => /Failed/.test(e?.reason || ''))?.message || '';
    const ref = /(configmap|secret)s? "([^"]+)" not found/i.exec(msg);
    const keyMiss = /couldn't find key (\S+) in (ConfigMap|Secret) ([^/\s]+)\/(\S+)/i.exec(msg);
    const f: Finding = {
      id: fid(object, 'config'), object, severity: 'critical', category: 'config',
      title: ref ? `${/secret/i.test(ref[1]) ? 'Secret' : 'ConfigMap'} "${ref[2]}" is missing` : keyMiss ? `Key "${keyMiss[1]}" missing from ${keyMiss[2]} ${keyMiss[4]}` : 'Container cannot be configured',
      why: ref
        ? `The ${where} reads configuration from ${ref[1]} "${ref[2]}", which does not exist in namespace ${ns}. Kubernetes will not start a container whose configuration source is missing.`
        : keyMiss ? `The ${where} reads key "${keyMiss[1]}" from ${keyMiss[2]} ${keyMiss[4]}, which exists but has no such key.`
          : `The runtime could not create the ${where} from its spec.`,
      evidence: [`${where}: ${w.reason}${msg ? ` — ${trunc(msg)}` : ''}`],
      fix: ref
        ? [`Create the ${ref[1]}: kubectl -n ${ns} create ${ref[1].toLowerCase()} ${ref[1].toLowerCase() === 'secret' ? 'generic ' : ''}${ref[2]} …`, 'Or fix the reference in the workload spec, or mark it optional: true if the app can run without it.']
        : keyMiss ? [`kubectl -n ${keyMiss[3]} get ${keyMiss[2].toLowerCase()} ${keyMiss[4]} -o yaml — add the key "${keyMiss[1]}".`] : ['kubectl describe pod for the full error.'],
      since: firstSeen(evs),
    };
    if (ref) { f.rootCause = { kind: ref[1].toLowerCase() === 'secret' ? 'Secret' : 'ConfigMap', name: ref[2], namespace: ns, reason: 'does not exist' }; f.contract = `${f.rootCause.kind} ${ref[2]} exists`; }
    if (keyMiss) f.rootCause = { kind: keyMiss[2], name: keyMiss[4], namespace: keyMiss[3], reason: `has no key ${keyMiss[1]}` };
    return f;
  }

  if (w?.reason === 'CrashLoopBackOff' || (t && t.exitCode !== 0 && !isInit) || (isInit && (t?.exitCode ?? 0) !== 0)) {
    const term = t && t.exitCode !== 0 ? t : last;
    const code = term?.exitCode;
    const reason = term?.reason;
    const restarts = cs?.restartCount || 0;
    const limit = specC?.resources?.limits?.memory;
    let title = 'Container keeps crashing';
    let why = `The ${where} starts and exits${restarts ? ` (${plural(restarts, 'restart')})` : ''}; Kubernetes backs off between restarts.`;
    const fix = [`kubectl -n ${ns} logs ${nameOf(pod)} -c ${cs?.name} --previous   # the output of the run that died`];
    let category: Category = 'crash';
    if (reason === 'OOMKilled' || code === 137) {
      title = `Killed for running out of memory${limit ? ` (limit ${limit})` : ''}`;
      why = `The ${where} used more memory than its limit${limit ? ` of ${limit}` : ''} and the kernel killed it (exit 137).`;
      fix.unshift(limit ? `Raise resources.limits.memory above ${limit} (current usage: kubectl top pod ${nameOf(pod)} -n ${ns}).` : 'Set a realistic memory limit/request; the node itself ran out of memory.');
      category = 'crash';
    } else if (code === 0) {
      title = 'Container exits successfully — and is restarted';
      why = `The ${where} finishes with exit code 0, but the pod restarts it forever (restartPolicy Always). Its command is a one-off task, not a server.`;
      fix.unshift('Run it as a Job, or fix the command so the process stays in the foreground.');
    } else if (code === 127 || code === 126) {
      title = code === 127 ? 'Command not found in the image' : 'Command is not executable';
      why = `Exit code ${code}: the container’s command/args point at something that does not exist (or is not executable) in the image.`;
      fix.unshift('Check command/args against the image: kubectl -n ' + ns + ' get pod ' + nameOf(pod) + ' -o jsonpath="{.spec.containers[*].command}"');
    } else if (code === 139) {
      title = 'Container crashed with a segmentation fault';
      why = 'Exit code 139 (SIGSEGV): the process crashed — usually a binary/library mismatch with the image or the node CPU.';
    } else if (code === 143) {
      title = 'Container was terminated (SIGTERM) — usually a failing liveness probe';
      why = 'Exit code 143: something stopped the container. When the liveness probe fails, the kubelet does exactly this.';
    } else if (code !== undefined) {
      title = `Container exits with code ${code}`;
      why = `The ${where} exits with code ${code} shortly after starting. The reason is in its own output.`;
    }
    const probeKill = warnings(evs).find((e) => e?.reason === 'Unhealthy' && /Liveness/i.test(e?.message || ''));
    if (probeKill) {
      category = 'probe';
      title = 'Liveness probe fails, so the kubelet keeps killing it';
      why = `The liveness probe on ${cs?.name} keeps failing, and each failure restarts the container. ${trunc(probeKill.message, 200)}`;
      fix.unshift('Check the probe path/port/initialDelaySeconds against how long the app takes to start; a startupProbe is often the fix.');
    }
    const ev = [`${where}: ${w?.reason || 'terminated'}${reason ? `, last exit ${reason}` : ''}${code !== undefined ? ` (code ${code})` : ''}${restarts ? `, ${plural(restarts, 'restart')}` : ''}`];
    if (term?.message) ev.push(`Termination message: ${trunc(term.message)}`);
    if (probeKill) ev.push(eventLine(probeKill));
    return { id: fid(object, 'crash'), object, severity: 'critical', category, title, why, evidence: ev, fix, since: firstSeen(evs) };
  }
  return undefined;
}

export function analyzePod(pod: any, ix: Index): Finding[] {
  const out: Finding[] = [];
  const object = refOf('Pod', pod);
  const ns = nsOf(pod);
  const st = pod?.status || {};
  const evs = ix.events('Pod', ns, nameOf(pod));
  const now = ix.input.now ?? Date.now();

  // Init containers first: nothing else runs until they finish.
  for (const cs of st.initContainerStatuses || []) {
    const f = containerFinding(pod, ix, cs, true);
    if (f) { out.push(f); return out; }
  }
  for (const cs of st.containerStatuses || []) {
    const f = containerFinding(pod, ix, cs, false);
    if (f) out.push(f);
  }

  // Scheduling.
  const sched = cond(pod, 'PodScheduled');
  if (st.phase === 'Pending' && sched?.status === 'False') {
    const msg = sched.message || warnings(evs).find((e) => e?.reason === 'FailedScheduling')?.message || '';
    const parts: string[] = [];
    const fix: string[] = [];
    let rootCause: Finding['rootCause'];
    let contract: string | undefined;
    const insuff = [...msg.matchAll(/Insufficient ([\w./-]+)/g)].map((m) => m[1]);
    if (insuff.length) {
      parts.push(`no node has enough free ${[...new Set(insuff)].join(', ')}`);
      fix.push(`Lower the pod’s requests for ${[...new Set(insuff)].join(', ')}, free capacity, or add nodes. Check: kubectl describe nodes | grep -A6 "Allocated resources"`);
    }
    if (/untolerated taint|had taint/i.test(msg)) {
      const taints = [...msg.matchAll(/taint \{([^}]+)\}/g)].map((m) => m[1]);
      parts.push(`nodes carry taints it does not tolerate${taints.length ? ` (${[...new Set(taints)].join('; ')})` : ''}`);
      fix.push('Add a matching toleration to the workload, or schedule onto nodes without that taint.');
      contract = 'Tolerates the taints of a node it can run on';
    }
    if (/didn't match (Pod's )?node (affinity|selector)/i.test(msg)) {
      parts.push('no node matches its nodeSelector/affinity');
      const sel = pod?.spec?.nodeSelector;
      fix.push(sel ? `No node carries ${pairs(sel)} — label a node (kubectl label node <node> …) or fix the selector.` : 'Check spec.affinity.nodeAffinity against node labels: kubectl get nodes --show-labels');
      contract = sel ? `nodeSelector ${pairs(sel)} matches a node` : 'Node affinity matches a node';
    }
    if (/unbound immediate PersistentVolumeClaims|persistentvolumeclaim .* not found/i.test(msg)) {
      const claim = (pod?.spec?.volumes || []).map((v: any) => v?.persistentVolumeClaim?.claimName).filter(Boolean)
        .find((c: string) => ix.get('PersistentVolumeClaim', ns, c)?.status?.phase !== 'Bound');
      parts.push('a PersistentVolumeClaim it needs is not bound');
      if (claim) rootCause = { kind: 'PersistentVolumeClaim', name: claim, namespace: ns, reason: ix.has('PersistentVolumeClaim', ns, claim) ? 'not Bound' : 'does not exist' };
      fix.push('See why the PVC is not bound (its own finding), then the pod schedules by itself.');
    }
    if (/volume node affinity conflict/i.test(msg)) {
      parts.push('its volume lives in a zone/node it cannot be scheduled into');
      fix.push('The PV is pinned to another zone/node; schedule there or recreate the volume.');
    }
    if (/node\(s\) were unschedulable/i.test(msg)) parts.push('some nodes are cordoned');
    if (/Too many pods/i.test(msg)) { parts.push('nodes are at their pod limit'); fix.push('Nodes hit max pods; add nodes or raise kubelet maxPods.'); }
    out.push({
      id: fid(object, 'sched'), object, severity: 'critical', category: 'scheduling',
      title: parts.length ? `Cannot be scheduled: ${parts[0]}` : 'Cannot be scheduled',
      why: parts.length ? `The scheduler found no node for this pod: ${parts.join('; ')}.` : 'The scheduler found no node for this pod.',
      evidence: [msg ? `PodScheduled=False: ${trunc(msg, 400)}` : 'PodScheduled=False'],
      fix: fix.length ? fix : ['kubectl describe pod for the scheduler’s full reasoning.'],
      rootCause, contract, since: sched.lastTransitionTime || firstSeen(evs),
    });
  }

  // Mount failures (stuck ContainerCreating).
  const mountFail = warnings(evs).find((e) => /FailedMount|FailedAttachVolume/.test(e?.reason || ''));
  if (mountFail && !out.length) {
    const msg = mountFail.message || '';
    const ref = /(configmap|secret|persistentvolumeclaim)s? "([^"]+)" not found/i.exec(msg);
    out.push({
      id: fid(object, 'mount'), object, severity: 'critical', category: 'storage',
      title: ref ? `Volume source ${ref[1]} "${ref[2]}" is missing` : 'A volume cannot be mounted',
      why: ref ? `The pod mounts ${ref[1]} "${ref[2]}", which does not exist — the container is never created.` : 'The kubelet cannot attach or mount one of the pod’s volumes, so its containers never start.',
      evidence: [eventLine(mountFail)],
      fix: ref ? [`Create ${ref[1]} ${ref[2]} in ${ns}, or fix the volume reference.`] : ['kubectl describe pod; check the PV/CSI driver on the node (kubectl get volumeattachments).'],
      rootCause: ref ? { kind: /secret/i.test(ref[1]) ? 'Secret' : /claim/i.test(ref[1]) ? 'PersistentVolumeClaim' : 'ConfigMap', name: ref[2], namespace: ns, reason: 'does not exist' } : undefined,
      since: firstSeen([mountFail]),
    });
  }

  // Running but not ready: readiness probe.
  const ready = cond(pod, 'Ready');
  if (st.phase === 'Running' && ready?.status === 'False' && !out.length) {
    const probe = warnings(evs).find((e) => e?.reason === 'Unhealthy' && /Readiness/i.test(e?.message || ''));
    out.push({
      id: fid(object, 'ready'), object, severity: 'warning', category: 'probe',
      title: probe ? 'Readiness probe failing — receives no traffic' : 'Running but not Ready',
      why: probe
        ? 'The readiness probe keeps failing, so the pod is removed from every Service’s endpoints: it runs, but gets no traffic.'
        : 'The pod runs but is not Ready, so Services do not send it traffic.',
      evidence: [probe ? eventLine(probe) : `Ready=False${ready?.message ? `: ${trunc(ready.message)}` : ''}`],
      fix: ['Check the probe target from inside the pod: kubectl exec -it <pod> -- wget -qO- localhost:<port><path>', 'Compare the probe port with the port the app actually listens on.'],
      since: ready?.lastTransitionTime,
    });
  }

  if (st.reason === 'Evicted') {
    out.push({
      id: fid(object, 'evicted'), object, severity: 'warning', category: 'lifecycle', title: 'Evicted by the node',
      why: `The kubelet evicted the pod to protect the node: ${trunc(st.message || 'resource pressure')}.`,
      evidence: [`status.reason=Evicted: ${trunc(st.message)}`],
      fix: ['Set requests/limits so the pod is not the first to go; clean up node disk (ephemeral-storage) or memory pressure.'],
    });
  }
  if (meta(pod).deletionTimestamp && now - Date.parse(meta(pod).deletionTimestamp) > 5 * 60_000) {
    out.push({
      id: fid(object, 'terminating'), object, severity: 'warning', category: 'lifecycle', title: 'Stuck terminating',
      why: 'Deletion was requested over five minutes ago and the pod is still here — a finalizer has not finished, or its node stopped reporting.',
      evidence: [`deletionTimestamp ${meta(pod).deletionTimestamp}`, ...(meta(pod).finalizers?.length ? [`finalizers: ${meta(pod).finalizers.join(', ')}`] : [])],
      fix: ['Check the node is Ready; check which controller owns the finalizer.'],
    });
  }

  // Violated references that explain a not-yet-started pod.
  if (!out.length && (st.phase === 'Pending' || st.phase === 'Unknown')) {
    const bad = podContracts(pod, ix).find((c) => c.status === 'violated');
    if (bad) {
      out.push({
        id: fid(object, 'contract'), object, severity: 'critical', category: bad.type === 'reference' ? 'config' : 'labels',
        title: `${bad.rule.split(' (')[0]} — violated`, why: `This pod cannot start: ${bad.rule} is not true (${bad.detail}).`,
        evidence: [bad.detail], fix: ['Create the missing object or fix the reference.'], contract: bad.rule, key: bad.key,
      });
    }
  }

  // High restarts on an otherwise running pod.
  const restarts = (st.containerStatuses || []).reduce((a: number, c: any) => a + (c?.restartCount || 0), 0);
  if (!out.length && restarts >= 5) {
    const lastReason = (st.containerStatuses || []).map((c: any) => c?.lastState?.terminated?.reason).find(Boolean);
    out.push({
      id: fid(object, 'restarts'), object, severity: 'warning', category: 'crash',
      title: `Restarted ${restarts} times${lastReason ? ` (last: ${lastReason})` : ''}`,
      why: st.phase === 'Running'
        ? 'It is running now, but keeps restarting — a recurring crash or memory limit that will come back.'
        : 'It keeps restarting — a recurring crash or memory limit.',
      evidence: [`${plural(restarts, 'restart')}${lastReason ? `; last termination: ${lastReason}` : ''}`],
      fix: [`kubectl -n ${ns} logs ${nameOf(pod)} --previous`],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

export function analyzeWorkload(w: any, ix: Index, podFindings: Map<string, Finding[]>): Finding[] {
  const out: Finding[] = [];
  const kind = w?.kind || 'Deployment';
  const object = refOf(kind, w);
  const ns = nsOf(w);
  const desired = kind === 'DaemonSet' ? (w?.status?.desiredNumberScheduled ?? 0) : (w?.spec?.replicas ?? 1);
  const ready = kind === 'DaemonSet' ? (w?.status?.numberReady ?? 0) : (w?.status?.readyReplicas ?? 0);

  const rf = cond(w, 'ReplicaFailure');
  if (rf?.status === 'True') {
    const msg = rf.message || '';
    const quota = /exceeded quota|forbidden: exceeded/i.test(msg);
    out.push({
      id: fid(object, 'replicafailure'), object, severity: 'critical', category: quota ? 'quota' : 'rollout',
      title: quota ? 'Pods are rejected: namespace quota exceeded' : 'Pods cannot be created',
      why: quota
        ? 'The ResourceQuota of the namespace rejects new pods — the requested CPU/memory/GPU/pod count would exceed it.'
        : `The controller cannot create pods: ${trunc(msg, 240)}`,
      evidence: [`ReplicaFailure: ${trunc(msg, 400)}`],
      fix: quota ? [`kubectl -n ${ns} describe resourcequota — raise the quota or lower requests.`] : ['Admission webhooks and PodSecurity reject pods with this kind of message; check the namespace’s policies.'],
    });
  }
  const prog = cond(w, 'Progressing');
  if (prog?.status === 'False' && prog?.reason === 'ProgressDeadlineExceeded') {
    out.push({
      id: fid(object, 'deadline'), object, severity: 'critical', category: 'rollout', title: 'Rollout stuck (progress deadline exceeded)',
      why: 'The new version never became ready within progressDeadlineSeconds; the old pods (if any) are still serving.',
      evidence: [`Progressing=False: ${trunc(prog.message, 300)}`],
      fix: [`kubectl -n ${ns} rollout status ${kind.toLowerCase()}/${nameOf(w)}`, `Roll back if needed: kubectl -n ${ns} rollout undo ${kind.toLowerCase()}/${nameOf(w)}`],
    });
  }

  if (desired > 0 && ready < desired) {
    // Pods this workload owns that have a finding: the workload's cause is theirs.
    const sel = w?.spec?.selector?.matchLabels || {};
    const mine = (ix.podsByNs.get(ns) || []).filter((p) => Object.keys(sel).length && Object.entries(sel).every(([k, v]) => meta(p).labels?.[k] === v));
    const failing = mine.flatMap((p) => podFindings.get(key('Pod', ns, nameOf(p))) || []);
    if (failing.length) {
      const top = failing.find((f) => f.severity === 'critical') || failing[0];
      out.push({
        id: fid(object, 'pods'), object, severity: ready === 0 ? 'critical' : 'warning', category: top.category,
        title: `${ready}/${desired} ready — ${top.title}`,
        why: `${plural(failing.length, 'pod finding')} on this workload’s pods. The most significant: ${top.why}`,
        evidence: [...new Set(failing.slice(0, 4).map((f) => `${f.object.name}: ${f.title}`))],
        fix: top.fix, rootCause: top.rootCause || { ...top.object, reason: top.title }, contract: top.contract, key: top.key, since: top.since,
      });
    } else if (!out.length && !mine.length) {
      out.push({
        id: fid(object, 'nopods'), object, severity: 'critical', category: 'rollout', title: `${ready}/${desired} ready — no pods exist`,
        why: 'The workload wants pods but none exist and the controller reports no failure — check events on the ReplicaSet/StatefulSet.',
        evidence: [`desired ${desired}, ready ${ready}`], fix: [`kubectl -n ${ns} describe ${kind.toLowerCase()} ${nameOf(w)}`],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Services — the label contract
// ---------------------------------------------------------------------------

export function serviceContracts(svc: any, ix: Index): { contracts: Contract[]; nearMiss: string[] } {
  const object = refOf('Service', svc);
  const ns = nsOf(svc);
  const sel: Record<string, string> = svc?.spec?.selector || {};
  const contracts: Contract[] = [];
  const nearMiss: string[] = [];
  if (!Object.keys(sel).length || svc?.spec?.type === 'ExternalName') return { contracts, nearMiss };
  const pods = ix.podsByNs.get(ns) || [];
  const matching = pods.filter((p) => Object.entries(sel).every(([k, v]) => meta(p).labels?.[k] === v));
  const firstKey = Object.keys(sel)[0];
  contracts.push({
    object, type: 'selector', rule: `Selector ${pairs(sel)} matches pods`,
    status: !ix.known('pods') ? 'unknown' : matching.length ? 'ok' : 'violated',
    detail: matching.length ? `${plural(matching.length, 'pod')} match` : 'no pod in the namespace carries these labels — the Service has no backends',
    key: meaningOf(firstKey) ? { name: firstKey, ...meaningOf(firstKey)! } : undefined,
  });
  if (!matching.length && pods.length) {
    // Pods that match all but one key: the classic "someone renamed a label".
    for (const p of pods) {
      const labels = meta(p).labels || {};
      const off = Object.entries(sel).filter(([k, v]) => labels[k] !== v);
      if (off.length === 1) {
        const [k, v] = off[0];
        nearMiss.push(`${nameOf(p)} has ${k}=${labels[k] ?? '(absent)'} — the Service wants ${k}=${v}`);
      }
    }
  }
  // Named targetPorts must exist on the selected pods' containers.
  for (const port of svc?.spec?.ports || []) {
    if (typeof port?.targetPort === 'string' && matching.length) {
      const named = matching.some((p) => (p?.spec?.containers || []).some((c: any) => (c?.ports || []).some((cp: any) => cp?.name === port.targetPort)));
      contracts.push({
        object, type: 'reference', rule: `Named targetPort "${port.targetPort}" exists on the pods`,
        status: named ? 'ok' : 'violated', detail: named ? 'found on a container port' : 'no container declares a port with this name — traffic is dropped',
      });
    }
  }
  return { contracts, nearMiss: nearMiss.slice(0, 5) };
}

function endpointsReady(ix: Index, ns: string, name: string): { ready: number; notReady: number } | undefined {
  const ep = ix.get('Endpoints', ns, name);
  if (!ep) return undefined;
  let ready = 0, notReady = 0;
  for (const s of ep?.subsets || []) { ready += (s?.addresses || []).length; notReady += (s?.notReadyAddresses || []).length; }
  return { ready, notReady };
}

export function analyzeService(svc: any, ix: Index, podFindings: Map<string, Finding[]>): Finding[] {
  const object = refOf('Service', svc);
  const ns = nsOf(svc);
  const { contracts, nearMiss } = serviceContracts(svc, ix);
  const out: Finding[] = [];
  const sel = contracts.find((c) => c.type === 'selector');
  if (sel?.status === 'violated') {
    out.push({
      id: fid(object, 'selector'), object, severity: 'critical', category: 'labels',
      title: `Selector matches no pods — no traffic reaches anything`,
      why: `The Service routes to pods labelled ${pairs(svc?.spec?.selector)}, and no pod in ${ns} has those labels. Requests to it fail (connection refused / 503).${nearMiss.length ? ' Some pods differ by exactly one label — a renamed or edited label is the likely cause.' : ''}`,
      evidence: nearMiss.length ? nearMiss : [`selector: ${pairs(svc?.spec?.selector)}`],
      fix: ['Make the pod template labels and the Service selector agree (fix whichever was changed).', `kubectl -n ${ns} get pods --show-labels`],
      contract: sel.rule, key: sel.key,
    });
  } else if (sel?.status === 'ok' && ix.known('endpoints')) {
    const ep = endpointsReady(ix, ns, nameOf(svc));
    if (ep && ep.ready === 0) {
      const podsSel = (ix.podsByNs.get(ns) || []).filter((p) => Object.entries(svc?.spec?.selector || {}).every(([k, v]) => meta(p).labels?.[k] === v));
      const pf = podsSel.flatMap((p) => podFindings.get(key('Pod', ns, nameOf(p))) || []);
      const top = pf[0];
      out.push({
        id: fid(object, 'endpoints'), object, severity: 'critical', category: 'network',
        title: top ? `No ready backends — ${top.title}` : 'No ready backends',
        why: top ? `The selector matches ${plural(podsSel.length, 'pod')}, but none is Ready, so the Service has nowhere to send traffic. ${top.why}`
          : `The selector matches ${plural(podsSel.length, 'pod')}, but none is Ready (${ep.notReady} not ready).`,
        evidence: [`endpoints: ${ep.ready} ready, ${ep.notReady} not ready`],
        fix: top ? top.fix : ['Fix the pods (their readiness), then endpoints fill automatically.'],
        rootCause: top ? { ...top.object, reason: top.title } : undefined,
      });
    }
  }
  for (const c of contracts.filter((x) => x.type === 'reference' && x.status === 'violated')) {
    out.push({
      id: fid(object, 'port'), object, severity: 'critical', category: 'network', title: c.rule.replace('exists on the pods', 'is not declared by the pods'),
      why: `The Service forwards to a named port the selected pods do not declare, so connections fail.`, evidence: [c.detail],
      fix: ['Name the container port the same as the Service targetPort, or use the port number.'], contract: c.rule,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// cert-manager
// ---------------------------------------------------------------------------

function issuerReady(o: any): { ready: boolean; reason?: string; message?: string } {
  const c = cond(o, 'Ready');
  return { ready: c?.status === 'True', reason: c?.reason, message: c?.message };
}

export function certificateContracts(cert: any, ix: Index): Contract[] {
  const object = refOf('Certificate', cert);
  const ns = nsOf(cert);
  const ref = cert?.spec?.issuerRef || {};
  const kind = ref.kind || 'Issuer';
  if (ref.group && ref.group !== 'cert-manager.io') {
    return [{ object, type: 'reference', rule: `External issuer ${ref.group}/${kind} ${ref.name}`, status: 'unknown', detail: 'not a cert-manager issuer — not checked' }];
  }
  const issuerNs = kind === 'ClusterIssuer' ? undefined : ns;
  const exists = refStatus(ix, kind, issuerNs, ref.name || '');
  const out: Contract[] = [{
    object, type: 'reference', rule: `${kind} ${ref.name} exists`, status: exists,
    detail: exists === 'ok' ? 'found' : exists === 'violated' ? (kind === 'ClusterIssuer' ? 'no ClusterIssuer with that name' : `no Issuer with that name in ${ns}`) : 'could not be checked',
  }];
  if (exists === 'ok') {
    const r = issuerReady(ix.get(kind, issuerNs, ref.name));
    out.push({ object, type: 'reference', rule: `${kind} ${ref.name} is Ready`, status: r.ready ? 'ok' : 'violated', detail: r.ready ? 'Ready' : `${r.reason || 'Not Ready'}${r.message ? `: ${trunc(r.message, 200)}` : ''}` });
  }
  return out;
}

export function analyzeCertificate(cert: any, ix: Index): Finding[] {
  const object = refOf('Certificate', cert);
  const ns = nsOf(cert);
  const ready = cond(cert, 'Ready');
  const ref = cert?.spec?.issuerRef || {};
  const kind = ref.kind || 'Issuer';
  const out: Finding[] = [];
  const contracts = certificateContracts(cert, ix);
  const exists = contracts[0];
  const now = ix.input.now ?? Date.now();

  if (exists?.status === 'violated') {
    // The commonest mistake: right name, wrong kind.
    const otherKind = kind === 'Issuer' ? 'ClusterIssuer' : 'Issuer';
    const otherExists = ix.has(otherKind, otherKind === 'ClusterIssuer' ? undefined : ns, ref.name);
    out.push({
      id: fid(object, 'issuer-missing'), object, severity: 'critical', category: 'certificate',
      title: `Issuer not found: ${kind} "${ref.name}"`,
      why: `The certificate asks ${kind} "${ref.name}" to issue it${kind === 'Issuer' ? ` (namespaced, so it must exist in ${ns})` : ''}, and there is no such ${kind}. cert-manager cannot get an issuer, so nothing is ever issued and anything using the TLS secret fails.${otherExists ? ` A ${otherKind} named "${ref.name}" does exist — the issuerRef kind is wrong.` : ''}`,
      evidence: [`issuerRef: ${kind}/${ref.name}`, ...(ready?.message ? [`Ready=${ready.status}: ${trunc(ready.message, 300)}`] : [])],
      fix: otherExists
        ? [`Set spec.issuerRef.kind: ${otherKind} (the ${otherKind} "${ref.name}" exists).`]
        : [`Create the ${kind} "${ref.name}"${kind === 'Issuer' ? ` in ${ns}` : ''}, or point issuerRef at one that exists: kubectl get issuers,clusterissuers -A`],
      rootCause: { kind, name: ref.name, namespace: kind === 'ClusterIssuer' ? undefined : ns, reason: 'does not exist' },
      contract: exists.rule,
    });
    return out;
  }
  const issuerOk = contracts[1];
  if (issuerOk?.status === 'violated') {
    out.push({
      id: fid(object, 'issuer-notready'), object, severity: 'critical', category: 'certificate',
      title: `Issuer "${ref.name}" is not Ready — certificate cannot be issued`,
      why: `The ${kind} exists, but is not ready to sign: ${issuerOk.detail}. Every certificate it should issue is stuck until it is.`,
      evidence: [`issuerRef: ${kind}/${ref.name}`, `issuer status: ${issuerOk.detail}`],
      fix: ['Fix the issuer first (its own finding lists why), then cert-manager retries automatically.'],
      rootCause: { kind, name: ref.name, namespace: kind === 'ClusterIssuer' ? undefined : ns, reason: issuerOk.detail },
      contract: issuerOk.rule,
    });
  } else if (ready && ready.status !== 'True') {
    out.push({
      id: fid(object, 'notready'), object, severity: ready.status === 'False' ? 'critical' : 'warning', category: 'certificate',
      title: `Certificate not Ready: ${ready.reason || 'unknown reason'}`,
      why: `cert-manager reports: ${trunc(ready.message || ready.reason || 'no message', 300)}`,
      evidence: [`Ready=${ready.status} (${ready.reason || '—'})`],
      fix: [`kubectl -n ${ns} describe certificate ${nameOf(cert)}`, `kubectl -n ${ns} get certificaterequests,orders,challenges`],
      since: ready.lastTransitionTime,
    });
  }
  const notAfter = cert?.status?.notAfter ? Date.parse(cert.status.notAfter) : NaN;
  if (!Number.isNaN(notAfter)) {
    const days = Math.floor((notAfter - now) / 86_400_000);
    if (days < 0) {
      out.push({ id: fid(object, 'expired'), object, severity: 'critical', category: 'certificate', title: `Expired ${-days} day(s) ago`,
        why: 'Clients reject the TLS certificate. cert-manager should have renewed it — its renewal is failing.', evidence: [`notAfter ${cert.status.notAfter}`],
        fix: [`kubectl -n ${ns} describe certificate ${nameOf(cert)} — see why renewal fails.`] });
    } else if (days <= 14) {
      out.push({ id: fid(object, 'expiring'), object, severity: 'warning', category: 'certificate', title: `Expires in ${days} day(s)`,
        why: 'Renewal normally happens well before this point; check it is not failing.', evidence: [`notAfter ${cert.status.notAfter}`, ...(cert?.status?.renewalTime ? [`renewalTime ${cert.status.renewalTime}`] : [])], fix: [`kubectl -n ${ns} describe certificate ${nameOf(cert)}`] });
    }
  }
  return out;
}

export function analyzeIssuer(issuer: any, ix: Index, kind: 'Issuer' | 'ClusterIssuer'): Finding[] {
  const object = refOf(kind, issuer, kind === 'Issuer');
  const r = issuerReady(issuer);
  if (r.ready || !cond(issuer, 'Ready')) return [];
  const affected = (ix.input.certificates || []).filter((c) => {
    const ref = c?.spec?.issuerRef || {};
    return (ref.kind || 'Issuer') === kind && ref.name === nameOf(issuer) && (kind === 'ClusterIssuer' || nsOf(c) === nsOf(issuer));
  }).map((c) => refOf('Certificate', c));
  const caSecret = issuer?.spec?.ca?.secretName;
  const f: Finding = {
    id: fid(object, 'issuer'), object, severity: 'critical', category: 'certificate',
    title: `${kind} not Ready: ${r.reason || 'unknown'}`,
    why: `cert-manager cannot use this ${kind}: ${trunc(r.message || r.reason || 'no message', 300)}.${affected.length ? ` ${plural(affected.length, 'certificate')} depend on it.` : ''}`,
    evidence: [`Ready=False (${r.reason || '—'})`, ...(r.message ? [trunc(r.message, 300)] : [])],
    fix: ['ACME: check the account email/server and network egress to the ACME server.', 'CA: the CA keypair secret must exist in the cert-manager namespace (ClusterIssuer) or the Issuer’s namespace.'],
    affects: affected,
  };
  if (caSecret && /secret|not found/i.test(r.message || '')) {
    f.rootCause = { kind: 'Secret', name: caSecret, namespace: kind === 'Issuer' ? nsOf(issuer) : 'cert-manager', reason: 'CA keypair secret is missing or invalid' };
  }
  return [f];
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

export function ingressContracts(ing: any, ix: Index): Contract[] {
  const object = refOf('Ingress', ing);
  const ns = nsOf(ing);
  const out: Contract[] = [];
  const ann = meta(ing).annotations || {};
  const cls = ing?.spec?.ingressClassName || ann['kubernetes.io/ingress.class'];
  if (cls && ix.known('ingressClasses') && (ix.input.ingressClasses || []).length) {
    const st = ix.has('IngressClass', undefined, cls) ? 'ok' : 'violated';
    out.push({ object, type: ing?.spec?.ingressClassName ? 'reference' : 'annotation', rule: `IngressClass ${cls} exists`, status: st,
      detail: st === 'ok' ? 'found' : 'no controller serves this class — the Ingress gets no address',
      key: !ing?.spec?.ingressClassName ? { name: 'kubernetes.io/ingress.class', ...meaningOf('kubernetes.io/ingress.class')! } : undefined });
  }
  const backends: Array<{ svc: string; port: any }> = [];
  if (ing?.spec?.defaultBackend?.service?.name) backends.push({ svc: ing.spec.defaultBackend.service.name, port: ing.spec.defaultBackend.service.port });
  for (const r of ing?.spec?.rules || []) for (const p of r?.http?.paths || []) {
    const s = p?.backend?.service;
    if (s?.name) backends.push({ svc: s.name, port: s.port });
  }
  const seen = new Set<string>();
  for (const b of backends) {
    if (seen.has(b.svc)) continue;
    seen.add(b.svc);
    const st = refStatus(ix, 'Service', ns, b.svc);
    let detail = st === 'ok' ? 'found' : st === 'violated' ? 'no such Service — requests get 503/404' : 'could not be checked';
    let status = st;
    if (st === 'ok' && b.port) {
      const svc = ix.get('Service', ns, b.svc);
      const ok = (svc?.spec?.ports || []).some((p: any) => (b.port.number && p?.port === b.port.number) || (b.port.name && p?.name === b.port.name));
      if (!ok) { status = 'violated'; detail = `Service has no port ${b.port.number ?? b.port.name}`; }
    }
    out.push({ object, type: 'reference', rule: `Backend Service ${b.svc} exists${b.port ? ` with port ${b.port.number ?? b.port.name}` : ''}`, status, detail });
  }
  for (const [annKey, kind] of [['cert-manager.io/cluster-issuer', 'ClusterIssuer'], ['cert-manager.io/issuer', ann['cert-manager.io/issuer-kind'] || 'Issuer']] as const) {
    const name = ann[annKey];
    if (!name) continue;
    const issuerNs = kind === 'ClusterIssuer' ? undefined : ns;
    let st = refStatus(ix, kind, issuerNs, name);
    let detail = st === 'ok' ? 'found' : st === 'violated' ? `no ${kind} "${name}" — the TLS certificate is never issued` : 'could not be checked';
    if (st === 'ok') {
      const r = issuerReady(ix.get(kind, issuerNs, name));
      if (!r.ready) { st = 'violated'; detail = `${kind} exists but is not Ready (${r.reason || 'unknown'})`; }
    }
    out.push({ object, type: 'annotation', rule: `${annKey}: ${name} points at a Ready ${kind}`, status: st, detail, key: { name: annKey, ...meaningOf(annKey)! } });
  }
  for (const t of ing?.spec?.tls || []) {
    if (!t?.secretName) continue;
    const hasShim = ann['cert-manager.io/cluster-issuer'] || ann['cert-manager.io/issuer'];
    const st = refStatus(ix, 'Secret', ns, t.secretName);
    out.push({ object, type: 'reference', rule: `TLS secret ${t.secretName} exists`, status: st === 'violated' && hasShim ? 'unknown' : st,
      detail: st === 'ok' ? 'found' : st === 'violated' ? (hasShim ? 'not yet — cert-manager should create it (see the issuer check)' : 'missing — HTTPS serves the controller’s default certificate') : 'could not be checked' });
  }
  return out;
}

export function analyzeIngress(ing: any, ix: Index): Finding[] {
  const object = refOf('Ingress', ing);
  return ingressContracts(ing, ix).filter((c) => c.status === 'violated').map((c) => {
    const issuer = /points at a Ready (ClusterIssuer|Issuer)/.exec(c.rule);
    const svc = /^Backend Service (\S+)/.exec(c.rule);
    return {
      id: fid(object, 'contract'), object, severity: 'critical' as Severity,
      category: (issuer ? 'certificate' : c.type === 'annotation' ? 'annotations' : 'network') as Category,
      title: issuer ? `TLS issuer unusable: ${c.detail}` : `${c.rule} — violated`,
      why: issuer
        ? `This Ingress asks cert-manager (annotation ${c.key?.name}) to issue its TLS certificate, but ${c.detail}. HTTPS for its hosts will not get a valid certificate.`
        : `Broken reference: ${c.rule.toLowerCase()} is not true — ${c.detail}.`,
      evidence: [c.detail], fix: issuer ? ['Point the annotation at a Ready issuer, or fix the issuer.', 'kubectl get clusterissuers,issuers -A'] : ['Fix the reference in the Ingress spec.'],
      contract: c.rule, key: c.key,
      rootCause: svc && c.detail.startsWith('no such') ? { kind: 'Service', name: svc[1], namespace: nsOf(ing), reason: 'does not exist' } : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// KServe
// ---------------------------------------------------------------------------

const MODES = new Set(['Serverless', 'RawDeployment', 'ModelMesh']);

export function isvcContracts(isvc: any, ix: Index): Contract[] {
  const object = refOf('InferenceService', isvc);
  const ns = nsOf(isvc);
  const out: Contract[] = [];
  const p = isvc?.spec?.predictor || {};
  const format = p?.model?.modelFormat?.name;
  const runtime = p?.model?.runtime;
  if (runtime) {
    const ok = ix.has('ServingRuntime', ns, runtime) || ix.has('ClusterServingRuntime', undefined, runtime);
    const known = ix.known('servingRuntimes') || ix.known('clusterServingRuntimes');
    out.push({ object, type: 'reference', rule: `ServingRuntime ${runtime} exists`, status: ok ? 'ok' : known ? 'violated' : 'unknown', detail: ok ? 'found' : 'no ServingRuntime/ClusterServingRuntime with that name' });
  } else if (format && (ix.known('servingRuntimes') || ix.known('clusterServingRuntimes'))) {
    const all = [...(ix.input.servingRuntimes || []).filter((r) => nsOf(r) === ns), ...(ix.input.clusterServingRuntimes || [])];
    const supports = all.filter((r) => !r?.spec?.disabled && (r?.spec?.supportedModelFormats || []).some((f: any) => f?.name === format && f?.autoSelect !== false));
    out.push({ object, type: 'reference', rule: `A runtime supports model format "${format}"`, status: supports.length ? 'ok' : 'violated',
      detail: supports.length ? supports.map((r) => nameOf(r)).join(', ') : 'no enabled ServingRuntime auto-selects this format — the predictor is never created' });
  }
  const uri: string = p?.model?.storageUri || '';
  const pvc = /^pvc:\/\/([^/]+)/.exec(uri);
  if (pvc) {
    let st = refStatus(ix, 'PersistentVolumeClaim', ns, pvc[1]);
    let detail = st === 'ok' ? 'exists' : st === 'violated' ? 'does not exist — the storage initializer cannot load the model' : 'could not be checked';
    if (st === 'ok' && ix.get('PersistentVolumeClaim', ns, pvc[1])?.status?.phase !== 'Bound') { st = 'violated'; detail = 'exists but is not Bound'; }
    out.push({ object, type: 'reference', rule: `Model PVC ${pvc[1]} exists and is Bound`, status: st, detail });
  }
  const mode = meta(isvc).annotations?.['serving.kserve.io/deploymentMode'];
  if (mode) {
    out.push({ object, type: 'annotation', rule: 'serving.kserve.io/deploymentMode is a valid mode', status: MODES.has(mode) ? 'ok' : 'violated',
      detail: MODES.has(mode) ? mode : `"${mode}" is not one of Serverless, RawDeployment, ModelMesh`, key: { name: 'serving.kserve.io/deploymentMode', ...meaningOf('serving.kserve.io/deploymentMode')! } });
  }
  return out;
}

export function analyzeIsvc(isvc: any, ix: Index, podFindings: Map<string, Finding[]>): Finding[] {
  const object = refOf('InferenceService', isvc);
  const ns = nsOf(isvc);
  const out: Finding[] = [];
  for (const c of isvcContracts(isvc, ix).filter((x) => x.status === 'violated')) {
    out.push({
      id: fid(object, 'contract'), object, severity: 'critical', category: c.type === 'annotation' ? 'annotations' : 'model',
      title: `${c.rule} — violated`, why: `The model cannot be served: ${c.detail}.`, evidence: [c.detail],
      fix: c.rule.startsWith('A runtime') ? ['Install/enable a ServingRuntime for this format, or set spec.predictor.model.runtime explicitly.', 'kubectl get servingruntimes,clusterservingruntimes -A'] : ['Fix the referenced object or the annotation.'],
      contract: c.rule, key: c.key,
    });
  }
  const ready = cond(isvc, 'Ready');
  if (ready && ready.status !== 'True') {
    const failing = conds(isvc).filter((c) => c?.status === 'False' && c?.type !== 'Ready');
    const pods = (ix.podsByNs.get(ns) || []).filter((p) => meta(p).labels?.['serving.kserve.io/inferenceservice'] === nameOf(isvc));
    const pf = pods.flatMap((p) => podFindings.get(key('Pod', ns, nameOf(p))) || []);
    const top = pf.find((f) => f.severity === 'critical') || pf[0];
    if (!out.length || top) {
      out.push({
        id: fid(object, 'notready'), object, severity: ready.status === 'False' ? 'critical' : 'warning', category: 'model',
        title: top ? `Model not Ready — predictor pod: ${top.title}` : `Model not Ready: ${ready.reason || failing[0]?.reason || 'unknown'}`,
        why: top ? `The predictor pod${pods.length > 1 ? 's' : ''} cannot run. ${top.why}`
          : `KServe reports: ${trunc(failing.map((c) => `${c.type}: ${c.message || c.reason}`).join('; ') || ready.message || ready.reason || 'not ready', 400)}`,
        evidence: [...failing.slice(0, 4).map((c) => `${c.type}=False (${c.reason || '—'}): ${trunc(c.message, 200)}`), ...(top ? [`${top.object.name}: ${top.title}`] : [])],
        fix: top ? top.fix : [`kubectl -n ${ns} describe inferenceservice ${nameOf(isvc)}`, `kubectl -n ${ns} get pods -l serving.kserve.io/inferenceservice=${nameOf(isvc)}`],
        rootCause: top ? (top.rootCause || { ...top.object, reason: top.title }) : undefined, since: ready.lastTransitionTime,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage, nodes, HPAs, Istio
// ---------------------------------------------------------------------------

export function analyzePvc(pvc: any, ix: Index): Finding[] {
  const object = refOf('PersistentVolumeClaim', pvc);
  const ns = nsOf(pvc);
  const phase = pvc?.status?.phase;
  if (phase === 'Bound') return [];
  const sc = pvc?.spec?.storageClassName;
  const evs = warnings(ix.events('PersistentVolumeClaim', ns, nameOf(pvc)));
  if (phase === 'Lost') {
    return [{ id: fid(object, 'lost'), object, severity: 'critical', category: 'storage', title: 'Volume lost',
      why: 'The PersistentVolume this claim was bound to no longer exists. Data on it may be gone.', evidence: ['phase Lost'], fix: ['Restore from backup or recreate the volume.'] }];
  }
  if (phase !== 'Pending') return [];
  const scObj = sc ? ix.get('StorageClass', undefined, sc) : undefined;
  if (sc && ix.known('storageClasses') && !scObj) {
    return [{ id: fid(object, 'sc'), object, severity: 'critical', category: 'storage', title: `StorageClass "${sc}" does not exist`,
      why: `The claim asks for StorageClass "${sc}", which is not defined, so no volume is ever provisioned and every pod using it stays Pending.`,
      evidence: [`storageClassName: ${sc}`], fix: ['kubectl get storageclass — use one that exists.'], rootCause: { kind: 'StorageClass', name: sc, reason: 'does not exist' }, contract: `StorageClass ${sc} exists` }];
  }
  if (!sc && ix.known('storageClasses')) {
    const defaults = (ix.input.storageClasses || []).filter((s) => meta(s).annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
    if (defaults.length !== 1) {
      return [{ id: fid(object, 'default-sc'), object, severity: 'critical', category: 'storage',
        title: defaults.length ? 'Two default StorageClasses — claim is ambiguous' : 'No storageClassName and no default StorageClass',
        why: defaults.length ? 'More than one StorageClass is marked default; the claim names none.' : 'The claim names no StorageClass and the cluster has no default one, so nothing provisions it.',
        evidence: [`defaults: ${defaults.map((s) => nameOf(s)).join(', ') || 'none'}`],
        fix: ['Set storageClassName on the claim, or mark exactly one StorageClass default (storageclass.kubernetes.io/is-default-class=true).'],
        contract: 'Exactly one default StorageClass', key: { name: 'storageclass.kubernetes.io/is-default-class', ...meaningOf('storageclass.kubernetes.io/is-default-class')! } }];
    }
  }
  if (scObj?.volumeBindingMode === 'WaitForFirstConsumer' && !evs.length) {
    return [{ id: fid(object, 'wffc'), object, severity: 'info', category: 'storage', title: 'Waiting for a pod to use it',
      why: `StorageClass ${sc} provisions only once a pod using the claim is scheduled — Pending is expected until then.`, evidence: ['volumeBindingMode: WaitForFirstConsumer'], fix: [] }];
  }
  const ev = evs.find((e) => /ProvisioningFailed|FailedBinding/.test(e?.reason || '')) || evs[0];
  return [{ id: fid(object, 'pending'), object, severity: 'critical', category: 'storage', title: 'Volume not provisioned',
    why: ev ? `The provisioner reports: ${trunc(ev.message, 300)}` : 'The claim is Pending and no provisioner has created a volume.',
    evidence: ev ? [eventLine(ev)] : [`storageClassName: ${sc || '(default)'}`],
    fix: ['Check the CSI provisioner pods and its quota/capacity.', `kubectl -n ${ns} describe pvc ${nameOf(pvc)}`], since: firstSeen(evs) }];
}

export function analyzeNode(node: any): Finding[] {
  const object = refOf('Node', node, false);
  const ready = cond(node, 'Ready');
  const out: Finding[] = [];
  if (ready && ready.status !== 'True') {
    out.push({ id: fid(object, 'notready'), object, severity: 'critical', category: 'node', title: `Node NotReady: ${ready.reason || 'unknown'}`,
      why: `The kubelet on this node is not reporting healthy${ready.message || ready.reason ? `: ${trunc(ready.message || ready.reason, 300)}` : ' (it stopped posting status — network, kubelet or the machine itself)'}. Pods on it are being (or will be) evicted.`,
      evidence: [`Ready=${ready.status}: ${trunc(ready.message, 300)}`], fix: ['systemctl status kubelet containerd on the node (K8s Nodes page → terminal).'], since: ready.lastTransitionTime });
  }
  for (const c of conds(node).filter((c) => c?.type !== 'Ready' && c?.status === 'True' && /Pressure|Unavailable/.test(c?.type || ''))) {
    out.push({ id: fid(object, c.type), object, severity: 'warning', category: 'node', title: `${c.type}`,
      why: `${trunc(c.message || c.type, 300)} — the kubelet will evict pods and refuse new ones until it clears.`, evidence: [`${c.type}=True`],
      fix: c.type === 'DiskPressure' ? ['Free disk: crictl rmi --prune; check /var/log and /var/lib/containerd.'] : ['Reduce load or add capacity.'] });
  }
  return out;
}

export function analyzeHpa(hpa: any, ix: Index): Finding[] {
  const object = refOf('HorizontalPodAutoscaler', hpa);
  const t = hpa?.spec?.scaleTargetRef || {};
  if ((t.kind === 'Deployment' || t.kind === 'StatefulSet') && ix.known('workloads') && !ix.has(t.kind, nsOf(hpa), t.name)) {
    return [{ id: fid(object, 'target'), object, severity: 'warning', category: 'rollout', title: `Scale target ${t.kind}/${t.name} does not exist`,
      why: 'The autoscaler points at a workload that is not there, so it scales nothing.', evidence: [`scaleTargetRef: ${t.kind}/${t.name}`],
      fix: ['Fix scaleTargetRef or delete the HPA.'], rootCause: { kind: t.kind, name: t.name, namespace: nsOf(hpa), reason: 'does not exist' }, contract: `Scale target ${t.kind}/${t.name} exists` }];
  }
  const active = cond(hpa, 'ScalingActive');
  if (active?.status === 'False') {
    return [{ id: fid(object, 'inactive'), object, severity: 'warning', category: 'rollout', title: `Autoscaling inactive: ${active.reason}`,
      why: trunc(active.message || active.reason, 300), evidence: [`ScalingActive=False`],
      fix: ['FailedGetResourceMetric usually means metrics-server is missing or the pods declare no CPU/memory requests.'] }];
  }
  return [];
}

export function analyzeVirtualService(vs: any, ix: Index): Finding[] {
  const object = refOf('VirtualService', vs);
  const ns = nsOf(vs);
  const out: Finding[] = [];
  if (ix.known('gateways')) {
    for (const g of vs?.spec?.gateways || []) {
      if (g === 'mesh') continue;
      const [gns, gname] = g.includes('/') ? g.split('/') : [ns, g];
      if (!ix.has('Gateway', gns, gname)) {
        out.push({ id: fid(object, 'gw'), object, severity: 'critical', category: 'network', title: `Gateway ${gns}/${gname} does not exist`,
          why: 'The VirtualService binds to a Gateway that is not there, so its routes are never served from outside the mesh.',
          evidence: [`spec.gateways: ${g}`], fix: ['kubectl get gateways.networking.istio.io -A — point at the right one (PCAI: istio-system/ezaf-gateway).'],
          rootCause: { kind: 'Gateway', name: gname, namespace: gns, reason: 'does not exist' }, contract: `Gateway ${g} exists` });
      }
    }
  }
  if (ix.known('services')) {
    const hosts = new Set<string>();
    for (const r of [...(vs?.spec?.http || []), ...(vs?.spec?.tcp || []), ...(vs?.spec?.tls || [])]) for (const d of r?.route || []) if (d?.destination?.host) hosts.add(d.destination.host);
    for (const h of hosts) {
      const m = /^([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?)?$/.exec(h);
      if (!m || h.split('.').length > 5) continue;
      const sns = m[2] || ns;
      if ((h.includes('.') && !h.includes('.svc') && h.split('.').length !== 2)) continue;
      if (!ix.has('Service', sns, m[1])) {
        out.push({ id: fid(object, 'dest'), object, severity: 'critical', category: 'network', title: `Route destination ${h} has no Service`,
          why: `Traffic is routed to ${h}, but there is no Service ${m[1]} in ${sns} — Istio answers 503 (no healthy upstream).`,
          evidence: [`destination.host: ${h}`], fix: ['Fix the destination host or create the Service.'],
          rootCause: { kind: 'Service', name: m[1], namespace: sns, reason: 'does not exist' }, contract: `Destination Service ${h} exists` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole cluster
// ---------------------------------------------------------------------------

export interface WhyReport {
  findings: Finding[];
  /** "Kind/ns/name" (or "Kind/name" when cluster-scoped) → worst finding, for cards. */
  byObject: Record<string, { severity: Severity; title: string; count: number }>;
  counts: Record<Severity, number>;
  read: string[];
}

const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function explainCluster(input: WhyInput): WhyReport {
  const ix = new Index(input);
  const findings: Finding[] = [];
  const podFindings = new Map<string, Finding[]>();
  for (const p of input.pods || []) {
    const f = analyzePod(p, ix);
    if (f.length) { podFindings.set(key('Pod', nsOf(p), nameOf(p)), f); findings.push(...f); }
  }
  for (const w of input.workloads || []) findings.push(...analyzeWorkload(w, ix, podFindings));
  for (const s of input.services || []) findings.push(...analyzeService(s, ix, podFindings));
  for (const c of input.certificates || []) findings.push(...analyzeCertificate(c, ix));
  for (const i of input.issuers || []) findings.push(...analyzeIssuer(i, ix, 'Issuer'));
  for (const i of input.clusterIssuers || []) findings.push(...analyzeIssuer(i, ix, 'ClusterIssuer'));
  for (const i of input.ingresses || []) findings.push(...analyzeIngress(i, ix));
  for (const i of input.isvcs || []) findings.push(...analyzeIsvc(i, ix, podFindings));
  for (const p of input.pvcs || []) findings.push(...analyzePvc(p, ix));
  for (const n of input.nodes || []) findings.push(...analyzeNode(n));
  for (const h of input.hpas || []) findings.push(...analyzeHpa(h, ix));
  for (const v of input.virtualServices || []) findings.push(...analyzeVirtualService(v, ix));

  findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const byObject: WhyReport['byObject'] = {};
  const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity]++;
    // Same key shape as the history (objectKey) so the UI joins them directly.
    const k = f.object.namespace ? `${f.object.kind}/${f.object.namespace}/${f.object.name}` : `${f.object.kind}/${f.object.name}`;
    const cur = byObject[k];
    if (!cur) byObject[k] = { severity: f.severity, title: f.title, count: 1 };
    else cur.count++;
  }
  return { findings, byObject, counts, read: [...input.read] };
}

/** The raw object behind a (kind, namespace, name), from the gathered lists. */
export function rawObject(input: WhyInput, kind: string, namespace: string | undefined, name: string): any {
  const lists: Record<string, any[] | undefined> = {
    pod: input.pods, service: input.services, certificate: input.certificates, ingress: input.ingresses,
    inferenceservice: input.isvcs, isvc: input.isvcs, persistentvolumeclaim: input.pvcs, node: input.nodes,
    namespace: input.namespaces, issuer: input.issuers, clusterissuer: input.clusterIssuers,
    deployment: input.workloads, statefulset: input.workloads, daemonset: input.workloads,
  };
  const k = kind.toLowerCase();
  const clusterScoped = k === 'node' || k === 'namespace' || k === 'clusterissuer';
  return (lists[k] || []).find((o) => nameOf(o) === name && (clusterScoped || !namespace || nsOf(o) === namespace)
    && (!['deployment', 'statefulset', 'daemonset'].includes(k) || (o?.kind || 'Deployment').toLowerCase() === k));
}

/**
 * The labels/annotations on an object (and its pod template) that another
 * component reads — each with who reads it and what breaks if it is wrong.
 */
export function metadataContracts(obj: any): Array<{ key: string; value: string; where: 'label' | 'annotation' | 'pod label' | 'pod annotation' } & KeyMeaning> {
  const out: Array<{ key: string; value: string; where: 'label' | 'annotation' | 'pod label' | 'pod annotation' } & KeyMeaning> = [];
  const add = (m: any, where: 'label' | 'annotation' | 'pod label' | 'pod annotation') => {
    for (const [k, v] of Object.entries(m || {})) {
      const meaning = meaningOf(k);
      if (meaning) out.push({ key: k, value: trunc(v, 160), where, ...meaning });
    }
  };
  add(meta(obj).labels, 'label');
  add(meta(obj).annotations, 'annotation');
  add(obj?.spec?.template?.metadata?.labels, 'pod label');
  add(obj?.spec?.template?.metadata?.annotations, 'pod annotation');
  return out;
}

/** Every contract of one object — the drawer's "non-negotiables" checklist. */
export function contractsFor(input: WhyInput, kind: string, namespace: string | undefined, name: string): Contract[] {
  const ix = new Index(input);
  const k = kind.toLowerCase();
  const find = (list: any[] | undefined, namespaced = true) =>
    (list || []).find((o) => nameOf(o) === name && (!namespaced || nsOf(o) === (namespace || 'default')));
  if (k === 'pod') { const p = find(input.pods); return p ? podContracts(p, ix) : []; }
  if (k === 'service') { const s = find(input.services); return s ? serviceContracts(s, ix).contracts : []; }
  if (k === 'certificate') { const c = find(input.certificates); return c ? certificateContracts(c, ix) : []; }
  if (k === 'ingress') { const i = find(input.ingresses); return i ? ingressContracts(i, ix) : []; }
  if (k === 'isvc' || k === 'inferenceservice') { const i = find(input.isvcs); return i ? isvcContracts(i, ix) : []; }
  if (k === 'deployment' || k === 'statefulset' || k === 'daemonset') {
    const w = (input.workloads || []).find((o) => nameOf(o) === name && nsOf(o) === (namespace || 'default'));
    if (!w) return [];
    // A workload's non-negotiables are its pod template's.
    const tmpl = { metadata: { ...(w?.spec?.template?.metadata || {}), namespace: nsOf(w), name: nameOf(w) }, spec: w?.spec?.template?.spec || {}, status: {} };
    const out = podContracts(tmpl, ix).map((c) => ({ ...c, object: refOf(w.kind || 'Deployment', w) }));
    const services = (input.services || []).filter((s) => nsOf(s) === nsOf(w) && Object.keys(s?.spec?.selector || {}).length);
    const labels = w?.spec?.template?.metadata?.labels || {};
    for (const s of services) {
      const sel = s.spec.selector;
      const hits = Object.entries(sel).filter(([kk, v]) => labels[kk] === v).length;
      if (hits && hits < Object.keys(sel).length) {
        out.push({ object: refOf(w.kind || 'Deployment', w), type: 'label', rule: `Pod labels satisfy Service ${nameOf(s)}’s selector`, status: 'violated',
          detail: `partially match ${pairs(sel)} — the Service ignores these pods` });
      } else if (hits === Object.keys(sel).length) {
        out.push({ object: refOf(w.kind || 'Deployment', w), type: 'label', rule: `Pod labels satisfy Service ${nameOf(s)}’s selector`, status: 'ok', detail: pairs(sel) });
      }
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

const COLS_NS_NAME = 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name';
const parseCols = (raw: string): Array<{ namespace: string; name: string }> =>
  (raw || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0] !== 'NS' && !/^No$/.test(c[0])).map(([namespace, name]) => ({ namespace, name }));

const STEPS: Array<Step & { list: keyof WhyInput; cols?: boolean }> = [
  { tag: 'PODS', list: 'pods', args: ['get', 'pods', '--all-namespaces', '-o', 'json'] },
  { tag: 'SVC', list: 'services', args: ['get', 'services', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'EP', list: 'endpoints', args: ['get', 'endpoints', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'WL', list: 'workloads', args: ['get', 'deployments,statefulsets,daemonsets', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'NODES', list: 'nodes', args: ['get', 'nodes', '-o', 'json'], optional: true },
  { tag: 'NS', list: 'namespaces', args: ['get', 'namespaces', '-o', 'json'], optional: true },
  { tag: 'EV', list: 'events', args: ['get', 'events', '--all-namespaces', '--field-selector', 'type=Warning', '-o', 'json'], optional: true },
  { tag: 'CERT', list: 'certificates', args: ['get', 'certificates.cert-manager.io', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'ISS', list: 'issuers', args: ['get', 'issuers.cert-manager.io', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'CISS', list: 'clusterIssuers', args: ['get', 'clusterissuers.cert-manager.io', '-o', 'json'], optional: true },
  { tag: 'ING', list: 'ingresses', args: ['get', 'ingresses.networking.k8s.io', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'INGC', list: 'ingressClasses', args: ['get', 'ingressclasses.networking.k8s.io', '-o', 'json'], optional: true },
  { tag: 'ISVC', list: 'isvcs', args: ['get', 'inferenceservices.serving.kserve.io', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'SRT', list: 'servingRuntimes', args: ['get', 'servingruntimes.serving.kserve.io', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'CSRT', list: 'clusterServingRuntimes', args: ['get', 'clusterservingruntimes.serving.kserve.io', '-o', 'json'], optional: true },
  { tag: 'PVC', list: 'pvcs', args: ['get', 'persistentvolumeclaims', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'SC', list: 'storageClasses', args: ['get', 'storageclasses.storage.k8s.io', '-o', 'json'], optional: true },
  { tag: 'HPA', list: 'hpas', args: ['get', 'horizontalpodautoscalers.autoscaling', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'VS', list: 'virtualServices', args: ['get', 'virtualservices.networking.istio.io', '--all-namespaces', '-o', 'json'], optional: true },
  { tag: 'GW', list: 'gateways', args: ['get', 'gateways.networking.istio.io', '--all-namespaces', '-o', 'json'], optional: true },
  // Names only. The contents of ConfigMaps and Secrets are never read.
  { tag: 'CM', list: 'configMaps', cols: true, args: ['get', 'configmaps', '--all-namespaces', '--no-headers', '-o', COLS_NS_NAME], optional: true },
  { tag: 'SEC', list: 'secrets', cols: true, args: ['get', 'secrets', '--all-namespaces', '--no-headers', '-o', COLS_NS_NAME], optional: true },
  { tag: 'SA', list: 'serviceAccounts', cols: true, args: ['get', 'serviceaccounts', '--all-namespaces', '--no-headers', '-o', COLS_NS_NAME], optional: true },
];

/** Read everything the engine reasons over. Missing APIs/permissions shrink `read`. */
export async function gatherWhyInput(vm?: string): Promise<WhyInput & { error?: string }> {
  const { out, ok, error } = await runSteps(STEPS, vm, 120_000, 1024 * 1024 * 160);
  const input: any = { read: new Set<string>() };
  for (const s of STEPS) {
    if (!ok.has(s.tag)) continue;
    if (s.cols) {
      input[s.list] = parseCols(out[s.tag]);
      input.read.add(s.list);
      continue;
    }
    const parsed = parseJson(out[s.tag]);
    if (parsed && Array.isArray(parsed.items)) {
      input[s.list] = parsed.items;
      input.read.add(s.list);
    }
  }
  return { ...input, error };
}

// One read serves the map, the drawer and Change History for a few seconds.
const cache = new Map<string, { at: number; input: Promise<WhyInput & { error?: string }> }>();
const TTL_MS = 15_000;
export function cachedWhyInput(vm?: string): Promise<WhyInput & { error?: string }> {
  const k = vm || 'local';
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.input;
  const p = gatherWhyInput(vm).catch((e) => ({ read: new Set<string>(), error: e?.message || String(e) }) as WhyInput & { error?: string });
  cache.set(k, { at: Date.now(), input: p });
  return p;
}

export const whyRouter = Router();

/**
 * GET /api/k8s/why[?vm=]                          — every finding in the cluster
 * GET /api/k8s/why?kind=&namespace=&name=[&vm=]   — one object: findings + non-negotiables
 */
whyRouter.get('/api/k8s/why', async (req, res) => {
  const vm = req.query.vm && req.query.vm !== 'local' ? String(req.query.vm) : undefined;
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  const namespace = req.query.namespace ? String(req.query.namespace) : undefined;
  const name = req.query.name ? String(req.query.name) : undefined;
  if ((name && !SAFE_NAME.test(name)) || (namespace && !SAFE_NAME.test(namespace))) return res.status(400).json({ error: 'Invalid object reference.' });
  try {
    const input = await cachedWhyInput(vm);
    if (!input.read.size) return res.json({ error: input.error || 'Nothing could be read from the cluster.', findings: [], byObject: {}, counts: { critical: 0, warning: 0, info: 0 }, read: [] });
    const report = explainCluster(input);
    if (!kind || !name) return res.json({ ok: true, readOnly: true, ...report, at: new Date().toISOString() });
    const lk = kind.toLowerCase();
    const canon = lk === 'k8s-node' || lk === 'node' ? 'Node' : lk === 'isvc' ? 'InferenceService' : kind.charAt(0).toUpperCase() + kind.slice(1);
    const mine = report.findings.filter((f) => f.object.kind.toLowerCase() === canon.toLowerCase() && f.object.name === name && (canon === 'Node' || !namespace || f.object.namespace === namespace));
    // Findings on objects that are this one's root cause, so the drawer can explain the chain.
    const causes = report.findings.filter((f) => mine.some((m) => m.rootCause && m.rootCause.kind === f.object.kind && m.rootCause.name === f.object.name));
    res.json({ ok: true, readOnly: true, findings: mine, causes, contracts: contractsFor(input, canon, namespace, name), read: report.read, at: new Date().toISOString() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Could not analyse the cluster.' });
  }
});
