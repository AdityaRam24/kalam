// Turn two snapshots into a changelog.
//
// This module decides what Trinetra will claim happened to the cluster, so it is
// written defensively. Three guards come before any diffing at all, because
// the failure mode of a naive diff is not a missing entry — it is a confident,
// wrong one:
//
//   1. BASELINE. With no previous snapshot there is no change to report. The
//      first capture is a silent baseline; otherwise starting Trinetra would
//      announce that all 500 objects were just created.
//   2. SECTION. A kind is only diffed when the query that produces it
//      succeeded on BOTH sides. Lose RBAC read permission, or run against a
//      cluster with no Ingress API, and the objects vanish from the snapshot —
//      diffing that as deletion would report a catastrophe that never happened.
//   3. SANITY. Even within surviving sections, a capture that lost more than
//      half its objects is treated as a bad read, not a mass deletion.
//
// After that, classification: which FIELD moved decides what the change is
// called. An image string moving is a deploy; `unschedulable` flipping is a
// cordon; `node` moving on a pod is a reschedule. That mapping is the whole
// reason the timeline reads like sentences instead of a JSON diff.
//
// Pure — snapshots in, events out — so all of it is tested from fixtures.

import type { ChangeEvent, ChangeKind, FieldChange, Fingerprint, Severity, Snapshot } from './model.js';
import { meaningOf } from '../k8s/contracts.js';
import { META_PREFIXES } from './fingerprint.js';
import { annotateImpact } from './impact.js';

export interface DiffOptions {
  /** Stop after this many events, adding one marker. Protects the log. */
  maxEvents?: number;
  /** Fraction of objects that may disappear before we call the read bad. */
  sanityFloor?: number;
}

export interface DiffResult {
  events: ChangeEvent[];
  /** Why nothing (or less than expected) was reported, for /status and the UI. */
  notes: string[];
}

const DEFAULTS = { maxEvents: 500, sanityFloor: 0.5 };

// ---------------------------------------------------------------------------
// Classification — which field moved decides what we call the change
// ---------------------------------------------------------------------------

interface Rule {
  /** Field path, or a prefix ending in "." to match a family (image.*). */
  match: string;
  kind: ChangeKind;
  severity?: Severity | ((c: FieldChange, fp: Fingerprint) => Severity);
  /** Overrides the generic "x → y" phrasing. */
  phrase?: (c: FieldChange, fp: Fingerprint) => string;
}

const RULES: Rule[] = [
  // Workloads — the changes people actually deploy.
  { match: 'image.', kind: 'image', severity: 'notice', phrase: (c) => `image ${short(c.from)} → ${short(c.to)}` },
  { match: 'init.image.', kind: 'image', severity: 'notice', phrase: (c) => `init image ${short(c.from)} → ${short(c.to)}` },
  { match: 'replicas', kind: 'scaled', severity: 'notice', phrase: (c) => `scaled ${c.from ?? '?'} → ${c.to ?? '0'}` },
  { match: 'paused', kind: 'spec', severity: 'notice', phrase: (c) => (c.to ? 'rollout paused' : 'rollout resumed') },
  { match: 'env.', kind: 'spec', phrase: (c) => `env changed in ${c.path.slice(4)}` },
  { match: 'envFrom.', kind: 'spec', phrase: (c) => `envFrom changed in ${c.path.slice(8)}` },
  { match: 'requests.', kind: 'spec', phrase: (c) => `requests ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'limits.', kind: 'spec', phrase: (c) => `limits ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'args.', kind: 'spec', phrase: (c) => `command/args changed in ${c.path.slice(5)}` },
  { match: 'probes.', kind: 'spec' },
  { match: 'mounts.', kind: 'spec' },
  { match: 'volumes', kind: 'spec' },
  { match: 'serviceAccount', kind: 'rbac', severity: 'notice', phrase: (c) => `service account ${c.from || 'default'} → ${c.to || 'default'}` },
  // A selector edit silently orphans every pod the workload used to own.
  { match: 'selector', kind: 'network', severity: 'warning', phrase: (c) => `selector ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'strategy', kind: 'spec' },
  { match: 'schedule', kind: 'spec', severity: 'notice', phrase: (c) => `schedule ${c.from} → ${c.to}` },
  { match: 'suspend', kind: 'spec', severity: 'notice' },

  // Pods.
  { match: 'node', kind: 'schedule', severity: 'notice', phrase: (c) => (c.from ? `moved from node ${c.from} to ${c.to}` : `scheduled onto ${c.to}`) },
  { match: 'restarts', kind: 'restarted', severity: 'warning', phrase: (c) => `container restarted (${c.from} → ${c.to})` },
  { match: 'phase', kind: 'lifecycle', phrase: (c) => `phase ${c.from} → ${c.to}` },
  {
    match: 'ready',
    kind: 'lifecycle',
    // Pods carry per-container "true,false"; the CRDs carry the Ready condition.
    severity: (c, fp) => (fp.kind === 'Pod' ? 'info' : c.to === 'True' ? 'notice' : 'warning'),
    phrase: (c, fp) =>
      fp.kind === 'Pod' ? `readiness ${c.from} → ${c.to}`
      : fp.kind === 'Node' ? (c.to === 'True' ? `Ready again (${c.from} → True)` : `NotReady (Ready ${c.from} → ${c.to})`)
      : c.to === 'True' ? 'became Ready'
      : `no longer Ready (Ready=${c.to || 'unknown'})`,
  },
  {
    match: 'waiting',
    kind: 'lifecycle',
    severity: (c) => (c.to ? 'warning' : 'notice'),
    phrase: (c) => (c.to ? `container waiting: ${c.to}` : `recovered from ${c.from}`),
  },

  // Labels and annotations. Keys another component reads (contracts.ts) are
  // raised: they are how a one-word metadata edit breaks something elsewhere.
  { match: 'label.', kind: 'label', severity: (c) => metaSeverity(c.path.slice(6)), phrase: (c) => metaPhrase('label', c.path.slice(6), c) },
  { match: 'annotation.', kind: 'annotation', severity: (c) => metaSeverity(c.path.slice(11)), phrase: (c) => metaPhrase('annotation', c.path.slice(11), c) },
  { match: 'podAnnotation.', kind: 'annotation', severity: (c) => metaSeverity(c.path.slice(14)), phrase: (c) => metaPhrase('pod annotation', c.path.slice(14), c) },

  // cert-manager.
  { match: 'issuer', kind: 'network', severity: 'warning', phrase: (c) => `issuer ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'dnsNames', kind: 'network', severity: 'notice', phrase: (c) => `DNS names ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'secretName', kind: 'network', severity: 'notice', phrase: (c) => `TLS secret ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'caSecret', kind: 'config', severity: 'warning', phrase: (c) => `CA secret ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'server', kind: 'config', severity: 'notice', phrase: (c) => `issuer server ${c.from || 'none'} → ${c.to || 'none'}` },

  // KServe — a new storageUri is a model deploy.
  { match: 'storageUri', kind: 'image', severity: 'notice', phrase: (c) => `model ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'format', kind: 'spec', severity: 'notice', phrase: (c) => `model format ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'formats', kind: 'spec', severity: 'notice', phrase: (c) => `supported formats ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'images', kind: 'image', severity: 'notice', phrase: (c, fp) => (fp.kind === 'Pod' ? `images ${c.from || 'none'} → ${c.to || 'none'}` : `runtime image ${c.from || 'none'} → ${c.to || 'none'}`) },
  { match: 'disabled', kind: 'spec', severity: 'warning', phrase: (c) => (c.to ? 'runtime disabled' : 'runtime enabled') },
  { match: 'minReplicas', kind: 'scaled', severity: 'notice', phrase: (c) => `min replicas ${c.from || 'default'} → ${c.to || 'default'}` },
  { match: 'maxReplicas', kind: 'scaled', severity: 'notice', phrase: (c) => `max replicas ${c.from || 'default'} → ${c.to || 'default'}` },
  { match: 'url', kind: 'network', phrase: (c) => `URL ${c.from || 'none'} → ${c.to || 'none'}` },

  // Istio.
  { match: 'gateways', kind: 'network', severity: 'warning', phrase: (c) => `gateways ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'hosts', kind: 'network', severity: 'notice', phrase: (c) => `hosts ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'routes', kind: 'network', severity: 'notice', phrase: () => 'routes changed' },
  { match: 'servers', kind: 'network', severity: 'notice', phrase: () => 'gateway servers changed' },
  { match: 'controller', kind: 'network', severity: 'notice' },

  // Nodes.
  { match: 'unschedulable', kind: 'cordon', severity: 'warning', phrase: (c) => (c.to ? 'cordoned — no new pods will schedule here' : 'uncordoned') },
  { match: 'taints', kind: 'taint', severity: 'notice', phrase: (c) => `taints ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'kubelet', kind: 'version', severity: 'notice', phrase: (c) => `kubelet ${c.from} → ${c.to}` },
  {
    match: 'runtime',
    kind: 'version',
    severity: 'notice',
    phrase: (c, fp) => (fp.kind === 'InferenceService' ? `serving runtime ${c.from || 'auto'} → ${c.to || 'auto'}` : `container runtime ${c.from} → ${c.to}`),
  },
  { match: 'kernel', kind: 'version', severity: 'notice' },
  { match: 'os', kind: 'version', severity: 'notice' },
  { match: 'gpu', kind: 'version', severity: 'warning', phrase: (c) => `GPU capacity ${c.from || '0'} → ${c.to || '0'}` },
  { match: 'cpu', kind: 'version', severity: 'notice', phrase: (c) => `CPU capacity ${c.from} → ${c.to}` },
  { match: 'memory', kind: 'version', severity: 'notice', phrase: (c) => `memory capacity ${c.from} → ${c.to}` },
  { match: 'pressure', kind: 'lifecycle', severity: 'warning', phrase: (c) => (c.to ? `under ${c.to} pressure` : `${c.from} pressure cleared`) },

  // Networking.
  { match: 'ports', kind: 'network', severity: 'notice', phrase: (c) => `ports ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'type', kind: 'network', severity: 'notice', phrase: (c) => `service type ${c.from} → ${c.to}` },
  { match: 'clusterIP', kind: 'network', severity: 'notice' },
  { match: 'externalIPs', kind: 'network', severity: 'notice' },
  { match: 'loadBalancer', kind: 'network', severity: 'notice', phrase: (c) => `load balancer address ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'rules', kind: 'network', severity: 'notice', phrase: (c, fp) => (fp.kind.includes('Role') ? 'permission rules changed' : 'routing rules changed') },
  { match: 'tls', kind: 'network', severity: 'notice' },
  { match: 'class', kind: 'network' },
  { match: 'ingressRules', kind: 'network', severity: 'notice', phrase: () => 'ingress rules changed' },
  { match: 'egressRules', kind: 'network', severity: 'notice', phrase: () => 'egress rules changed' },
  { match: 'podSelector', kind: 'network', severity: 'warning' },

  // Storage.
  { match: 'capacity', kind: 'storage', severity: 'notice', phrase: (c) => `capacity ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'volume', kind: 'storage', phrase: (c) => `bound to volume ${c.to || 'none'}` },
  { match: 'storageClass', kind: 'storage', severity: 'notice' },
  { match: 'claim', kind: 'storage' },

  // RBAC.
  { match: 'roleRef', kind: 'rbac', severity: 'warning', phrase: (c) => `role reference ${c.from} → ${c.to}` },
  { match: 'subjects', kind: 'rbac', severity: 'warning', phrase: (c) => `subjects ${c.from || 'none'} → ${c.to || 'none'}` },
  { match: 'podSecurity', kind: 'rbac', severity: 'warning', phrase: (c) => `pod security ${c.from || 'none'} → ${c.to || 'none'}` },

  // The resourceVersion-only kinds (ConfigMap, Secret, cluster RBAC). All we
  // know is that something wrote to the object — which, for a Secret or a
  // ClusterRole, is worth saying out loud even without the detail.
  {
    match: 'revision',
    kind: 'config',
    severity: 'notice',
    phrase: (_c, fp) =>
      fp.kind === 'Secret' ? 'secret contents were rewritten'
      : fp.kind.endsWith('Role') || fp.kind.endsWith('Binding') ? 'permission rules were changed'
      : 'contents were rewritten',
  },
  { match: 'detail', kind: 'config' },
];

/** Kinds where a `config` change is really a permissions change. */
const RBAC_KINDS = /Role$|Binding$|^ServiceAccount$/;

/** Trim a registry path so "registry.io/team/app:1.2" reads as "app:1.2". */
function short(image?: string): string {
  if (!image) return 'none';
  const noDigest = image.split('@')[0];
  const parts = noDigest.split('/');
  return parts[parts.length - 1] || noDigest;
}

function metaSeverity(key: string): Severity {
  return meaningOf(key) ? 'warning' : 'info';
}

function metaPhrase(type: string, key: string, c: FieldChange): string {
  if (c.from === undefined) return `${type} ${key}=${c.to} added`;
  if (c.to === undefined) return `${type} ${key} removed (was ${c.from})`;
  return `${type} ${key}: ${c.from} → ${c.to}`;
}

function ruleFor(path: string): Rule | undefined {
  // Longest match wins so "init.image.x" beats "image." and "podSelector"
  // is never swallowed by "selector".
  let best: Rule | undefined;
  for (const r of RULES) {
    const hit = r.match.endsWith('.') ? path.startsWith(r.match) : path === r.match;
    if (hit && (!best || r.match.length > best.match.length)) best = r;
  }
  return best;
}

/** The single most significant change among several on one object. */
function pickPrimary(changes: FieldChange[], fp: Fingerprint): { kind: ChangeKind; severity: Severity; summary: string } {
  const scored = changes.map((c) => {
    const rule = ruleFor(c.path);
    return {
      c,
      rule,
      kind: rule?.kind ?? 'spec',
      severity: (typeof rule?.severity === 'function' ? rule.severity(c, fp) : rule?.severity) ?? 'info',
      text: rule?.phrase ? rule.phrase(c, fp) : `${c.path} ${c.from ?? 'none'} → ${c.to ?? 'none'}`,
    };
  });
  const rank: Record<Severity, number> = { info: 0, notice: 1, warning: 2 };
  scored.sort((a, b) => rank[b.severity] - rank[a.severity]);
  const top = scored[0];
  const extra = scored.length > 1 ? ` (+${scored.length - 1} more)` : '';
  // An opaque write to an RBAC object is a permissions change, whatever the
  // field that revealed it was called.
  const kind = top.kind === 'config' && RBAC_KINDS.test(fp.kind) ? 'rbac' : top.kind;
  const severity = kind === 'rbac' && top.severity === 'info' ? 'notice' : top.severity;
  return { kind, severity, summary: top.text + extra };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

let seq = 0;
function eventId(at: string): string {
  seq = (seq + 1) % 100000;
  return `${Date.parse(at) || 0}-${seq.toString(36)}`;
}

const label = (fp: Fingerprint): string => (fp.namespace ? `${fp.namespace}/${fp.name}` : fp.name);

function base(fp: Fingerprint, next: Snapshot, kind: ChangeKind, severity: Severity, summary: string): ChangeEvent {
  return {
    id: eventId(next.at),
    at: next.at,
    source: next.source,
    kind,
    severity,
    objectKind: fp.kind,
    name: fp.name,
    namespace: fp.namespace,
    summary,
    fields: [],
    // NOTE: `actor` is deliberately not filled in here. The manager recorded on
    // an object is whoever last wrote *some* field of it, which is not the same
    // claim as "this person made this change". It is only attached where that
    // can actually be shown — see the stamp comparison below.
    cause: fp.cause,
    revision: fp.revision,
    owner: fp.owner,
  };
}

export function diffSnapshots(prev: Snapshot | undefined, next: Snapshot, options: DiffOptions = {}): DiffResult {
  const opts = { ...DEFAULTS, ...options };
  const notes: string[] = [];

  // Guard 1 — baseline.
  if (!prev) {
    return { events: [], notes: [`Baseline capture: ${Object.keys(next.objects).length} objects recorded, nothing to compare against yet.`] };
  }

  // Guard 2 — only diff sections that ran on both sides.
  const usable = new Set(next.sections.filter((s) => prev.sections.includes(s)));
  for (const s of prev.sections) {
    if (!usable.has(s)) notes.push(`Skipped "${s}": that query did not return this time, so its objects are unknown rather than deleted.`);
  }
  if (!usable.size) {
    return { events: [], notes: [...notes, 'No comparable sections between the two captures.'] };
  }

  const inScope = (fp: Fingerprint | undefined) => !!fp && usable.has(sectionOf(fp));

  // Field families only one side recorded are dropped from both (see
  // Snapshot.features) — an upgrade must not read as "every label was added".
  const both = (f: string) => !!prev.features?.includes(f) && !!next.features?.includes(f);
  const dropMeta = !both('meta');
  const dropWaiting = !both('podWaiting');
  const gate = (spec: Record<string, string>): Record<string, string> => {
    if (!dropMeta && !dropWaiting) return spec;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec)) {
      if (dropMeta && META_PREFIXES.some((p) => k.startsWith(p))) continue;
      if (dropWaiting && k === 'waiting') continue;
      out[k] = v;
    }
    return out;
  };
  const prevKeys = Object.keys(prev.objects).filter((k) => inScope(prev.objects[k]));
  const nextKeys = Object.keys(next.objects).filter((k) => inScope(next.objects[k]));

  // Guard 3 — a read that lost half the cluster is a bad read.
  if (prevKeys.length > 20 && nextKeys.length < prevKeys.length * opts.sanityFloor) {
    return {
      events: [],
      notes: [
        ...notes,
        `Ignored: this capture saw ${nextKeys.length} objects where the previous one saw ${prevKeys.length}. That looks like a truncated or partially failed read, not ${prevKeys.length - nextKeys.length} deletions.`,
      ],
    };
  }

  const events: ChangeEvent[] = [];
  const nextSet = new Set(nextKeys);
  const prevSet = new Set(prevKeys);

  // --- created / recreated / field changes -------------------------------
  for (const key of nextKeys) {
    const now = next.objects[key];
    const before = prevSet.has(key) ? prev.objects[key] : undefined;

    if (!before) {
      const ev = base(now, next, 'created', now.kind === 'Node' ? 'notice' : 'info', `${now.kind} ${label(now)} created`);
      // Creation is the one case where the cluster tells us the real time, and
      // where the recorded manager unambiguously *is* the author: the object
      // did not exist before, so whoever wrote it first created it.
      ev.actualAt = now.createdAt;
      ev.actor = now.actor;
      ev.actorOp = now.actorOp;
      ev.fields = Object.entries(now.spec).slice(0, 12).map(([path, to]) => ({ path, to }));
      events.push(ev);
      continue;
    }

    // Same name, different object: a delete+create that a plain key diff
    // would miss entirely (StatefulSet pods reuse their names).
    if (before.uid && now.uid && before.uid !== now.uid) {
      const ev = base(now, next, 'created', 'notice', `${now.kind} ${label(now)} was replaced (new instance)`);
      ev.actualAt = now.createdAt;
      events.push(ev);
      continue;
    }

    const changes = fieldChanges(gate(before.spec), gate(now.spec));
    if (!changes.length) continue;

    const { kind, severity, summary } = pickPrimary(changes, now);
    const ev = base(now, next, kind, severity, `${now.kind} ${label(now)}: ${summary}`);
    ev.fields = changes;

    // Attribution without a clock: managedFields carries the API server's own
    // timestamp on both sides, so a NEWER stamp than last capture means this
    // manager performed the write we just noticed. No comparison against
    // Trinetra's clock, so host/cluster skew cannot mislead it.
    //
    // If the stamp did NOT move, the change came from something managedFields
    // does not attribute (a controller writing status, a field the API server
    // does not track). Naming the object's last known writer here would be a
    // plausible-looking guess, so nobody is named at all.
    if (now.actorAt && now.actorAt !== before.actorAt) {
      ev.actualAt = now.actorAt;
      ev.actor = now.actor;
      ev.actorOp = now.actorOp;
    }

    // Intent vs effect: a spec edit the controller has not caught up with yet.
    if (now.generation !== undefined && now.observed !== undefined && now.generation > now.observed) {
      ev.summary += ' (not yet rolled out)';
      if (ev.severity === 'info') ev.severity = 'notice';
    }

    events.push(ev);
  }

  // --- deleted -----------------------------------------------------------
  for (const key of prevKeys) {
    if (nextSet.has(key)) continue;
    const gone = prev.objects[key];
    const ev = base(gone, next, 'deleted', gone.kind === 'Pod' ? 'info' : 'warning', `${gone.kind} ${label(gone)} deleted`);
    ev.fields = Object.entries(gone.spec).slice(0, 12).map(([path, from]) => ({ path, from }));
    events.push(ev);
  }

  // --- fold pod churn under the rollout that caused it -------------------
  attributePodChurn(events);

  // --- what each change does to the rest of the cluster ------------------
  annotateImpact(prev, next, events);

  // --- cap ---------------------------------------------------------------
  const rank: Record<Severity, number> = { info: 0, notice: 1, warning: 2 };
  events.sort((a, b) => rank[b.severity] - rank[a.severity]);
  if (events.length > opts.maxEvents) {
    const dropped = events.length - opts.maxEvents;
    events.length = opts.maxEvents;
    notes.push(`${dropped} lower-severity changes were dropped from this capture (cap ${opts.maxEvents}).`);
  }
  return { events, notes };
}

/**
 * Which capture query an object came from. Sections are named after the query
 * so guard 2 can reason about them; see collect.ts for the tags.
 */
export function sectionOf(fp: Fingerprint): string {
  return SECTION_BY_KIND[fp.kind] || 'OTHER';
}

export const SECTION_BY_KIND: Record<string, string> = {
  Deployment: 'WORKLOADS', StatefulSet: 'WORKLOADS', DaemonSet: 'WORKLOADS', Job: 'WORKLOADS',
  CronJob: 'WORKLOADS', HorizontalPodAutoscaler: 'WORKLOADS', PodDisruptionBudget: 'WORKLOADS',
  Pod: 'PODS',
  Service: 'NET', Ingress: 'NET', NetworkPolicy: 'NET',
  ConfigMap: 'CONFIGMAPS', Secret: 'SECRETS',
  PersistentVolumeClaim: 'STORAGE', ResourceQuota: 'STORAGE', LimitRange: 'STORAGE',
  ServiceAccount: 'RBAC', Role: 'RBAC', RoleBinding: 'RBAC',
  ClusterRole: 'CLUSTERROLES', ClusterRoleBinding: 'CLUSTERROLEBINDINGS',
  Node: 'CLUSTER', Namespace: 'CLUSTER', PersistentVolume: 'CLUSTER',
  StorageClass: 'CLUSTER', PriorityClass: 'CLUSTER',
  CustomResourceDefinition: 'CRDS',
  Certificate: 'CERTS', Issuer: 'CERTS', ClusterIssuer: 'CLUSTERISSUERS',
  InferenceService: 'KSERVE', ServingRuntime: 'KSERVE', ClusterServingRuntime: 'CLUSTERRUNTIMES',
  VirtualService: 'ISTIO', Gateway: 'ISTIO', IngressClass: 'INGRESSCLASSES',
};

/** Field-by-field comparison of two fingerprints' spec maps. */
export function fieldChanges(before: Record<string, string>, after: Record<string, string>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[path];
    const to = after[path];
    if (from === to) continue;
    // Restart counters only ever move up; a lower number means the pod was
    // replaced, which the pod's own created/deleted pair already covers.
    if (path === 'restarts' && Number(to ?? 0) < Number(from ?? 0)) continue;
    out.push({ path, from, to });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A rollout deletes and recreates pods. Reporting ten pod deletions next to
 * one image change buries the only line that matters, so pod events whose
 * owner also changed in this capture are marked as consequences.
 */
function attributePodChurn(events: ChangeEvent[]): void {
  const byOwnerKey = new Map<string, ChangeEvent>();
  for (const e of events) {
    if (e.objectKind === 'Pod') continue;
    byOwnerKey.set(e.namespace ? `${e.objectKind}/${e.namespace}/${e.name}` : `${e.objectKind}/${e.name}`, e);
  }
  for (const e of events) {
    if (e.objectKind !== 'Pod' || !e.owner) continue;
    // Pods are owned by a ReplicaSet; the workload event is on the Deployment.
    const direct = byOwnerKey.get(e.owner);
    const viaDeployment = byOwnerKey.get(e.owner.replace(/^ReplicaSet\//, 'Deployment/').replace(/-[a-z0-9]{6,10}$/, ''));
    const cause = direct || viaDeployment;
    if (!cause) continue;
    e.causedBy = cause.id;
    e.severity = 'info';
    e.summary += ` — from ${cause.objectKind} ${cause.name}`;
  }
}
