// What a change DOES — the consequence, not the diff.
//
// "label app: web → web-v2" is accurate and useless at 3am. What the operator
// needs is "Service web no longer selects these pods — its traffic stops".
// This module works that out at capture time, from the same snapshot the diff
// came from, so the sentence is true of the cluster at the moment the change
// was seen (later fixes do not rewrite history).
//
// Rules of the house:
//   * Only claim what the snapshot proves. Existence checks run only when the
//     section holding that kind was actually read; otherwise say nothing.
//   * Name the other object. Every line points at something the operator can
//     go and look at.
//   * Contracts (contracts.ts) explain metadata keys in one line each.

import { meaningOf } from '../k8s/contracts.js';
import { objectKey, type ChangeEvent, type FieldChange, type Fingerprint, type Snapshot } from './model.js';
import { SECTION_BY_KIND } from './diff.js';

const MAX_LINES = 6;

/** "a=b,c=d" → { a: 'b', c: 'd' } (the fingerprint's sortedPairs format). */
export function pairsOf(s?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const subset = (sel: Record<string, string>, labels: Record<string, string>) =>
  Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']);

class View {
  constructor(private snap: Snapshot) {}
  read(kind: string): boolean {
    const sec = SECTION_BY_KIND[kind];
    return !!sec && this.snap.sections.includes(sec);
  }
  has(kind: string, name: string, ns?: string): boolean {
    return !!this.snap.objects[objectKey(kind, name, ns)];
  }
  get(kind: string, name: string, ns?: string): Fingerprint | undefined {
    return this.snap.objects[objectKey(kind, name, ns)];
  }
  all(pred: (fp: Fingerprint) => boolean): Fingerprint[] {
    return Object.values(this.snap.objects).filter(pred);
  }
}

const field = (e: ChangeEvent, path: string): FieldChange | undefined => e.fields.find((f) => f.path === path);
const label = (fp: Fingerprint) => `${fp.kind} ${fp.name}`;

/** ConfigMaps/Secrets/PVCs a workload fingerprint references. */
export function referencesOf(spec: Record<string, string>): Array<{ kind: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim'; name: string; where: string }> {
  const out: Array<{ kind: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim'; name: string; where: string }> = [];
  for (const [k, v] of Object.entries(spec)) {
    if (k === 'volumes') {
      for (const part of v.split(',')) {
        const m = /=(cm|secret|pvc):(.+)$/.exec(part);
        if (m) out.push({ kind: m[1] === 'cm' ? 'ConfigMap' : m[1] === 'secret' ? 'Secret' : 'PersistentVolumeClaim', name: m[2], where: `volume ${part.split('=')[0]}` });
      }
    }
    // envFrom does not say which kind; both are checked by the caller.
    if (/^(init\.)?envFrom\./.test(k)) for (const n of v.split(',')) if (n) out.push({ kind: 'ConfigMap', name: n, where: `envFrom in ${k.split('.').pop()}` });
  }
  return out;
}

function exists(view: View, kind: string, name: string, ns?: string): boolean | undefined {
  if (!view.read(kind)) return undefined;
  return view.has(kind, name, ns);
}

export function impactOf(e: ChangeEvent, prev: Snapshot, next: Snapshot): string[] {
  if (e.causedBy) return [];
  const now = new View(next);
  const before = new View(prev);
  const lines: string[] = [];
  const ns = e.namespace;
  const fp = now.get(e.objectKind, e.name, ns) || before.get(e.objectKind, e.name, ns);

  // --- Workload pod labels vs Service selectors ---------------------------
  const tl = field(e, 'templateLabels');
  if (tl && WORKLOADS.has(e.objectKind) && now.read('Service')) {
    const was = pairsOf(tl.from);
    const is = pairsOf(tl.to);
    for (const svc of now.all((x) => x.kind === 'Service' && x.namespace === ns && !!x.spec.selector)) {
      const sel = pairsOf(svc.spec.selector);
      const a = subset(sel, was);
      const b = subset(sel, is);
      if (a && !b) lines.push(`Service ${svc.name} no longer selects these pods (it wants ${svc.spec.selector}) — its traffic stops reaching them.`);
      if (!a && b) lines.push(`Service ${svc.name} now also routes to these pods.`);
    }
  }

  // --- Service selector vs workloads --------------------------------------
  const sel = field(e, 'selector');
  if (sel && e.objectKind === 'Service' && now.read('Deployment')) {
    const match = (s?: string) =>
      now.all((x) => WORKLOADS.has(x.kind) && x.namespace === ns && subset(pairsOf(s), pairsOf(x.spec.templateLabels))).map(label);
    const was = match(sel.from);
    const is = match(sel.to);
    if (sel.to && !is.length) lines.push(`The new selector matches no workload’s pods in ${ns} — the Service has no backends${was.length ? ` (it used to reach ${was.join(', ')})` : ''}.`);
    else if (is.join() !== was.join()) lines.push(`Now routes to ${is.join(', ') || 'nothing'}${was.length ? ` instead of ${was.join(', ')}` : ''}.`);
  }

  // --- Things that were deleted, and who depended on them -----------------
  if (e.kind === 'deleted') {
    if (e.objectKind === 'ConfigMap' || e.objectKind === 'Secret') {
      const users = now.all((x) => WORKLOADS.has(x.kind) && x.namespace === ns && usesConfig(x.spec, e.objectKind as 'ConfigMap' | 'Secret', e.name));
      if (users.length) lines.push(`Still referenced by ${users.slice(0, 4).map(label).join(', ')}${users.length > 4 ? '…' : ''} — their new pods fail with CreateContainerConfigError (or stay ContainerCreating) until it is back.`);
    }
    if (e.objectKind === 'Service') {
      const ings = now.all((x) => x.kind === 'Ingress' && x.namespace === ns && (x.spec.rules || '').includes(`->${e.name}:`));
      if (ings.length) lines.push(`Ingress ${ings.map((i) => i.name).join(', ')} still routes to it — those paths now return 503.`);
    }
    if (e.objectKind === 'Issuer' || e.objectKind === 'ClusterIssuer') {
      const certs = now.all((x) => x.kind === 'Certificate' && x.spec.issuer === `${e.objectKind}/${e.name}` && (e.objectKind === 'ClusterIssuer' || x.namespace === ns));
      if (certs.length) lines.push(`Certificates ${certs.map((c) => `${c.namespace}/${c.name}`).slice(0, 5).join(', ')} are issued by it — they cannot renew.`);
    }
    if (e.objectKind === 'Gateway') {
      const vss = now.all((x) => x.kind === 'VirtualService' && (x.spec.gateways || '').split(',').some((g) => g === `${ns}/${e.name}` || (g === e.name && x.namespace === ns)));
      if (vss.length) lines.push(`VirtualService ${vss.map((v) => `${v.namespace}/${v.name}`).join(', ')} bind to it — their routes are no longer served.`);
    }
    if (e.objectKind === 'PersistentVolumeClaim') {
      const users = now.all((x) => WORKLOADS.has(x.kind) && x.namespace === ns && (x.spec.volumes || '').includes(`=pvc:${e.name}`));
      if (users.length) lines.push(`Mounted by ${users.map(label).join(', ')} — their pods cannot schedule.`);
    }
    if (e.objectKind === 'ServingRuntime' || e.objectKind === 'ClusterServingRuntime') {
      const isvcs = now.all((x) => x.kind === 'InferenceService' && x.spec.runtime === e.name);
      if (isvcs.length) lines.push(`InferenceService ${isvcs.map((i) => i.name).join(', ')} name this runtime — they cannot be (re)deployed.`);
    }
  }

  // --- New references that point at nothing --------------------------------
  if ((e.kind !== 'deleted') && fp && WORKLOADS.has(e.objectKind) && e.fields.some((f) => /^(init\.)?(envFrom|env)\.|^volumes$/.test(f.path))) {
    for (const r of referencesOf(fp.spec)) {
      const missing = r.kind === 'ConfigMap'
        ? exists(now, 'ConfigMap', r.name, ns) === false && exists(now, 'Secret', r.name, ns) === false
        : exists(now, r.kind, r.name, ns) === false;
      if (missing) lines.push(`References ${r.kind === 'ConfigMap' && r.where.startsWith('envFrom') ? 'ConfigMap/Secret' : r.kind} ${r.name} (${r.where}), which does not exist — new pods will not start.`);
    }
  }
  const sa = field(e, 'serviceAccount');
  if (sa?.to && exists(now, 'ServiceAccount', sa.to, ns) === false) {
    lines.push(`ServiceAccount ${sa.to} does not exist in ${ns} — the controller cannot create pods.`);
  }

  // --- Issuers ---------------------------------------------------------------
  const issuerRef = (ref?: string, certNs?: string) => {
    if (!ref) return;
    const [kind, name] = ref.split('/');
    const ok = exists(now, kind, name, kind === 'ClusterIssuer' ? undefined : certNs);
    if (ok === false) lines.push(`${kind} ${name} does not exist — cert-manager cannot issue this certificate.`);
    else if (ok && now.get(kind, name, kind === 'ClusterIssuer' ? undefined : certNs)?.spec.ready === 'False') lines.push(`${kind} ${name} exists but is not Ready — issuance will fail until it is.`);
  };
  if (e.objectKind === 'Certificate' && (field(e, 'issuer') || e.kind === 'created')) issuerRef(fp?.spec.issuer, ns);
  for (const f of e.fields) {
    if (f.path === 'annotation.cert-manager.io/cluster-issuer' && f.to) issuerRef(`ClusterIssuer/${f.to}`);
    if (f.path === 'annotation.cert-manager.io/issuer' && f.to) issuerRef(`${fp?.spec['annotation.cert-manager.io/issuer-kind'] || 'Issuer'}/${f.to}`, ns);
  }
  const ready = field(e, 'ready');
  if (ready && (e.objectKind === 'Issuer' || e.objectKind === 'ClusterIssuer') && ready.to !== 'True') {
    const certs = now.all((x) => x.kind === 'Certificate' && x.spec.issuer === `${e.objectKind}/${e.name}` && (e.objectKind === 'ClusterIssuer' || x.namespace === ns));
    if (certs.length) lines.push(`${certs.length} certificate(s) depend on it: ${certs.slice(0, 4).map((c) => `${c.namespace}/${c.name}`).join(', ')}.`);
  }

  // --- KServe -----------------------------------------------------------------
  const rt = field(e, 'runtime');
  if (e.objectKind === 'InferenceService' && rt?.to) {
    const ok = exists(now, 'ServingRuntime', rt.to, ns) || exists(now, 'ClusterServingRuntime', rt.to);
    if (ok === false) lines.push(`No ServingRuntime or ClusterServingRuntime named ${rt.to} — the predictor cannot be created.`);
  }
  if (e.objectKind === 'InferenceService' && field(e, 'storageUri')) lines.push('The predictor pods are replaced and the new model is downloaded by the storage initializer — expect a cold start.');

  // --- Namespaces, nodes, storage --------------------------------------------
  if (e.objectKind === 'Namespace') {
    const inj = field(e, 'label.istio-injection');
    if (inj) {
      lines.push(inj.to === 'enabled'
        ? `New pods in ${e.name} will get an Istio sidecar; running pods only after they restart.`
        : `New pods in ${e.name} will NOT get an Istio sidecar — mesh routing and mTLS to them break as pods restart.`);
    }
  }
  if (e.objectKind === 'Node' && now.read('Deployment')) {
    for (const f of e.fields.filter((x) => x.path.startsWith('label.') && x.from !== undefined)) {
      const k = f.path.slice(6);
      const needs = now.all((x) => WORKLOADS.has(x.kind) && pairsOf(x.spec.nodeSelector)[k] === f.from);
      if (needs.length) lines.push(`${needs.slice(0, 4).map(label).join(', ')} require ${k}=${f.from} — this node no longer qualifies for them.`);
    }
  }
  if (e.objectKind === 'StorageClass' && field(e, 'default') && !field(e, 'default')?.to) {
    const other = now.all((x) => x.kind === 'StorageClass' && x.spec.default === 'true');
    if (!other.length) lines.push('The cluster now has no default StorageClass — PVCs that name none stay Pending.');
  }

  // --- What the metadata keys mean ------------------------------------------
  const seen = new Set<string>();
  for (const f of e.fields) {
    const m = /^(label|annotation|podAnnotation)\.(.+)$/.exec(f.path);
    if (!m) continue;
    const meaning = meaningOf(m[2]);
    if (!meaning || seen.has(meaning.readBy)) continue;
    seen.add(meaning.readBy);
    lines.push(`${m[2]} is read by ${meaning.readBy}. ${meaning.ifWrong}`);
  }

  return [...new Set(lines)].slice(0, MAX_LINES);
}

function usesConfig(spec: Record<string, string>, kind: 'ConfigMap' | 'Secret', name: string): boolean {
  const tag = kind === 'ConfigMap' ? 'cm' : 'secret';
  if ((spec.volumes || '').split(',').some((v) => v.endsWith(`=${tag}:${name}`))) return true;
  for (const [k, v] of Object.entries(spec)) {
    if (/^(init\.)?envFrom\./.test(k) && v.split(',').includes(name)) return true;
    if (/^(init\.)?env\./.test(k) && (v.includes(`<${name}/`) || v.includes(`<${name}>`))) return true;
  }
  return false;
}

/** Fill `impact` on every event in place. */
export function annotateImpact(prev: Snapshot, next: Snapshot, events: ChangeEvent[]): void {
  for (const e of events) {
    try {
      const lines = impactOf(e, prev, next);
      if (lines.length) e.impact = lines;
    } catch {
      // An impact note is a bonus; it must never cost the change itself.
    }
  }
}
