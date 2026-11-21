// Turning the change log into something a person can read.
//
// The backend records one event per object per capture: a rollout of one
// Deployment arrives as an image change, a new ReplicaSet, three pods created,
// three pods deleted and a handful of readiness flips — ten rows for one thing
// someone did. This module folds them back into STORIES ("web was updated to
// 1.1; 3 pods replaced"), names fields the way an operator would ("Image
// (container main)" rather than `image.main`) and writes the digest at the top
// of the page. Pure; tested in server/__tests__/historystory.test.ts.

export type Severity = 'info' | 'notice' | 'warning';

export interface FieldChange { path: string; from?: string; to?: string }

export interface ChangeEventLike {
  id: string;
  at: string;
  actualAt?: string;
  kind: string;
  severity: Severity;
  objectKind: string;
  name: string;
  namespace?: string;
  summary: string;
  fields: FieldChange[];
  actor?: string;
  actorOp?: string;
  cause?: string;
  revision?: string;
  owner?: string;
  causedBy?: string;
  impact?: string[];
}

export interface Story<E extends ChangeEventLike = ChangeEventLike> {
  id: string;
  /** Latest time of anything in the story (when it happened if known, else when seen). */
  at: string;
  /** Earliest. Equal to `at` for single events. */
  start: string;
  title: string;
  /** A second line: the before → after that matters, or what the related changes were. */
  detail?: string;
  kind: string;
  severity: Severity;
  namespace?: string;
  subject: { kind: string; name: string; namespace?: string };
  actor?: string;
  actorOp?: string;
  /** The change someone made, when there is one; synthetic groups (restarts, pod churn) have none. */
  root?: E;
  related: E[];
  /** Everything in the story, root first. */
  events: E[];
  counts: { podsCreated: number; podsDeleted: number; restarts: number; podsRestarted: number; moved: number; other: number };
}

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

const CONTAINER_FIELDS: Record<string, string> = {
  image: 'Image', 'init.image': 'Init container image', args: 'Command / arguments', requests: 'Resource requests',
  limits: 'Resource limits', ports: 'Container ports', env: 'Environment variables', envFrom: 'Env from ConfigMap/Secret',
  probes: 'Health probes', mounts: 'Volume mounts',
};

const FIELDS: Record<string, string> = {
  replicas: 'Replicas', paused: 'Rollout paused', serviceAccount: 'Service account', nodeSelector: 'Node selector',
  tolerations: 'Tolerations', affinity: 'Affinity rules', volumes: 'Volumes', hostNetwork: 'Host network',
  priorityClass: 'Priority class', runtimeClass: 'Runtime class', templateLabels: 'Pod template labels', selector: 'Selector',
  strategy: 'Update strategy', schedule: 'Schedule (cron)', suspend: 'Suspended',
  node: 'Node', phase: 'Phase', restarts: 'Container restarts', ready: 'Ready', waiting: 'Waiting reason', images: 'Images',
  unschedulable: 'Cordoned (unschedulable)', taints: 'Taints', kubelet: 'Kubelet version', runtime: 'Container runtime',
  kernel: 'Kernel', os: 'OS image', gpu: 'GPU capacity', cpu: 'CPU capacity', memory: 'Memory capacity', pressure: 'Node pressure',
  type: 'Service type', clusterIP: 'Cluster IP', externalIPs: 'External IPs', loadBalancer: 'Load balancer address',
  rules: 'Rules', tls: 'TLS', class: 'Ingress class', ingressRules: 'Ingress rules', egressRules: 'Egress rules', podSelector: 'Pod selector',
  capacity: 'Capacity', volume: 'Bound volume', storageClass: 'Storage class', claim: 'Claim',
  roleRef: 'Role reference', subjects: 'Subjects', podSecurity: 'Pod security level',
  revision: 'Contents (resource version)', detail: 'Detail',
  storageUri: 'Model location (storageUri)', format: 'Model format', formats: 'Supported formats', disabled: 'Disabled',
  minReplicas: 'Min replicas', maxReplicas: 'Max replicas', url: 'URL',
  issuer: 'Issuer', dnsNames: 'DNS names', secretName: 'TLS secret', caSecret: 'CA secret', server: 'Issuer server',
  gateways: 'Gateways', hosts: 'Hosts', routes: 'Routes', servers: 'Gateway servers', controller: 'Controller',
};

/** `image.main` → "Image (container main)"; `label.app` → "Label app"; unknown paths come back unchanged. */
export function fieldLabel(path: string): string {
  for (const [pre, label] of Object.entries(CONTAINER_FIELDS).sort((a, b) => b[0].length - a[0].length)) {
    if (path.startsWith(`${pre}.`)) return `${label} (container ${path.slice(pre.length + 1)})`;
  }
  if (path.startsWith('label.')) return `Label ${path.slice(6)}`;
  if (path.startsWith('annotation.')) return `Annotation ${path.slice(11)}`;
  if (path.startsWith('podAnnotation.')) return `Pod annotation ${path.slice(14)}`;
  return FIELDS[path] || path;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

const when = (e: ChangeEventLike) => e.actualAt || e.at;
const ref = (kind: string, name: string, ns?: string) => `${kind} ${ns ? `${ns}/` : ''}${name}`;
const RANK: Record<Severity, number> = { info: 0, notice: 1, warning: 2 };

/** `ReplicaSet/shop/web-5d8f9c7b4` → the Deployment `web` in `shop`; other owners as they are. */
export function workloadOf(owner?: string): { kind: string; name: string; namespace?: string } | undefined {
  if (!owner) return undefined;
  const parts = owner.split('/');
  const [kind, a, b] = parts;
  const ns = b !== undefined ? a : undefined;
  const name = b !== undefined ? b : a;
  if (!kind || !name) return undefined;
  if (kind === 'ReplicaSet') return { kind: 'Deployment', name: name.replace(/-[a-z0-9]{6,10}$/, ''), namespace: ns };
  if (kind === 'Job' && /-\d{8,}$/.test(name)) return { kind: 'CronJob', name: name.replace(/-\d{8,}$/, ''), namespace: ns };
  return { kind, name, namespace: ns };
}

const short = (image?: string) => {
  if (!image) return 'none';
  const p = image.split('@')[0].split('/');
  return p[p.length - 1] || image;
};

/** Pod events that are mechanics of something else: churn, moves, readiness. */
const POD_CHURN = new Set(['created', 'deleted', 'schedule', 'lifecycle', 'image']);

export function buildStories<E extends ChangeEventLike>(events: E[], opts: { group?: boolean } = {}): Story<E>[] {
  const group = opts.group !== false;
  const byId = new Map(events.map((e) => [e.id, e]));
  const stories = new Map<string, { key: string; root?: E; members: E[]; synthetic?: 'restarts' | 'pods'; workload?: { kind: string; name: string; namespace?: string } }>();
  const add = (key: string, e: E, init: () => { root?: E; synthetic?: 'restarts' | 'pods'; workload?: { kind: string; name: string; namespace?: string } }) => {
    let s = stories.get(key);
    if (!s) { s = { key, members: [], ...init() }; stories.set(key, s); }
    if (s.root !== e) s.members.push(e);
    return s;
  };

  for (const e of events) {
    if (!group) { add(e.id, e, () => ({ root: e })); continue; }
    // 1. A consequence of another recorded change joins that change.
    const cause = e.causedBy ? byId.get(e.causedBy) : undefined;
    if (cause) { add(cause.id, e, () => ({ root: cause })); continue; }
    const wl = e.objectKind === 'Pod' ? workloadOf(e.owner) : undefined;
    // 2. Restarts: one line per workload per hour, however many pods and bumps.
    if (e.objectKind === 'Pod' && e.kind === 'restarted') {
      const hour = Math.floor(Date.parse(e.at) / 3600_000);
      const who = wl ? `${wl.kind}/${wl.namespace || ''}/${wl.name}` : `Pod/${e.namespace || ''}/${e.name}`;
      add(`restarts|${who}|${hour}`, e, () => ({ synthetic: 'restarts', workload: wl || { kind: 'Pod', name: e.name, namespace: e.namespace } }));
      continue;
    }
    // 3. Pod churn of one workload in one capture: one line.
    if (e.objectKind === 'Pod' && wl && POD_CHURN.has(e.kind)) {
      add(`pods|${wl.kind}/${wl.namespace || ''}/${wl.name}|${e.at}`, e, () => ({ synthetic: 'pods', workload: wl }));
      continue;
    }
    // 4. Everything else is its own story — and may later collect consequences.
    if (!stories.has(e.id)) stories.set(e.id, { key: e.id, root: e, members: [] });
    else stories.get(e.id)!.root = e;
  }

  const out: Story<E>[] = [];
  for (const s of stories.values()) {
    const all = (s.root ? [s.root, ...s.members.filter((m) => m !== s.root)] : s.members);
    if (!all.length) continue;
    const times = all.map(when).sort();
    const sev = all.reduce<Severity>((a, e) => (RANK[e.severity] > RANK[a] ? e.severity : a), 'info');
    const pods = all.filter((e) => e.objectKind === 'Pod');
    const restartEvents = pods.filter((e) => e.kind === 'restarted');
    const counts = {
      podsCreated: pods.filter((e) => e.kind === 'created').length,
      podsDeleted: pods.filter((e) => e.kind === 'deleted').length,
      restarts: restartEvents.reduce((a, e) => {
        const f = e.fields.find((x) => x.path === 'restarts');
        const d = Number(f?.to ?? 0) - Number(f?.from ?? 0);
        return a + (d > 0 ? d : 1);
      }, 0),
      podsRestarted: new Set(restartEvents.map((e) => e.name)).size,
      moved: pods.filter((e) => e.kind === 'schedule').length,
      other: 0,
    };
    counts.other = all.length - (s.root ? 1 : 0) - counts.podsCreated - counts.podsDeleted - restartEvents.length - counts.moved;
    const subject = s.root
      ? { kind: s.root.objectKind, name: s.root.name, namespace: s.root.namespace }
      : s.workload || { kind: all[0].objectKind, name: all[0].name, namespace: all[0].namespace };
    const actorFrom = s.root?.actor ? s.root : all.find((e) => e.actor);
    const { title, detail } = s.root ? describeRoot(s.root, counts, all) : describeGroup(s.synthetic!, subject, counts, all);
    out.push({
      id: s.root?.id || `${s.key}`,
      at: times[times.length - 1],
      start: times[0],
      title, detail,
      kind: s.root?.kind || (s.synthetic === 'restarts' ? 'restarted' : 'created'),
      severity: sev,
      namespace: subject.namespace,
      subject,
      actor: actorFrom?.actor,
      actorOp: actorFrom?.actorOp,
      root: s.root,
      related: s.root ? all.slice(1) : all,
      events: all,
      counts,
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 pods replaced", "2 pods created", "1 pod moved to another node" — what a rollout did to pods. */
function podLine(c: Story['counts']): string | undefined {
  const parts: string[] = [];
  const replaced = Math.min(c.podsCreated, c.podsDeleted);
  if (replaced) parts.push(`${plural(replaced, 'pod')} replaced`);
  if (c.podsCreated > replaced) parts.push(`${plural(c.podsCreated - replaced, 'pod')} started`);
  if (c.podsDeleted > replaced) parts.push(`${plural(c.podsDeleted - replaced, 'pod')} removed`);
  if (c.moved) parts.push(`${plural(c.moved, 'pod')} moved to another node`);
  if (c.restarts) parts.push(`${plural(c.restarts, 'restart')}`);
  return parts.length ? parts.join(', ') : undefined;
}

function describeRoot(r: ChangeEventLike, c: Story['counts'], all: ChangeEventLike[]): { title: string; detail?: string } {
  const who = ref(r.objectKind, r.name, r.namespace);
  const f = (p: string) => r.fields.find((x) => x.path === p || x.path.startsWith(`${p}.`));
  const others = r.fields.length > 1 ? r.fields.slice(1).map((x) => fieldLabel(x.path)) : [];
  const also = (skip?: FieldChange) => {
    const rest = r.fields.filter((x) => x !== skip).map((x) => fieldLabel(x.path));
    return rest.length ? `also changed: ${rest.slice(0, 4).join(', ')}${rest.length > 4 ? ` +${rest.length - 4} more` : ''}` : undefined;
  };
  const pods = podLine(c);
  const tail = [pods, all.length - 1 - c.podsCreated - c.podsDeleted - c.moved > 0 && !pods ? `${plural(all.length - 1, 'related change')}` : undefined].filter(Boolean).join(' · ') || undefined;
  const join = (...xs: Array<string | undefined>) => xs.filter(Boolean).join(' · ') || undefined;

  switch (r.kind) {
    case 'image': {
      const img = f('image') || f('init.image') || f('images') || f('storageUri');
      if (img?.path === 'storageUri') return { title: `New model deployed to ${who}`, detail: join(`${img.from || 'none'} → ${img.to || 'none'}`, also(img), tail) };
      return { title: `New version rolled out: ${who}`, detail: join(img ? `${short(img.from)} → ${short(img.to)}` : r.summary, also(img), tail) };
    }
    case 'scaled': {
      const rep = f('replicas') || f('minReplicas') || f('maxReplicas');
      const up = Number(rep?.to ?? 0) > Number(rep?.from ?? 0);
      return { title: `${who} scaled ${up ? 'up' : 'down'}`, detail: join(rep ? `${fieldLabel(rep.path)} ${rep.from ?? '?'} → ${rep.to ?? '0'}` : r.summary, also(rep), tail) };
    }
    case 'created':
      return { title: `${r.objectKind} created: ${r.namespace ? `${r.namespace}/` : ''}${r.name}`, detail: tail };
    case 'deleted':
      return { title: `${r.objectKind} deleted: ${r.namespace ? `${r.namespace}/` : ''}${r.name}`, detail: tail };
    case 'config':
      return {
        title: r.objectKind === 'Secret' ? `Secret contents changed: ${r.namespace ? `${r.namespace}/` : ''}${r.name}` : `${r.objectKind} contents changed: ${r.namespace ? `${r.namespace}/` : ''}${r.name}`,
        detail: join(r.objectKind === 'Secret' ? 'Trinetra never reads secret values — only that it was rewritten' : undefined, tail),
      };
    case 'cordon': {
      const on = !!f('unschedulable')?.to;
      return { title: on ? `Node ${r.name} cordoned — no new pods will be scheduled on it` : `Node ${r.name} uncordoned — schedulable again`, detail: tail };
    }
    case 'taint': return { title: `Node ${r.name} taints changed`, detail: join(r.summary.replace(/^[^:]*:\s*/, ''), tail) };
    case 'version': return { title: `${r.objectKind === 'Node' ? `Node ${r.name}` : who}: version or capacity changed`, detail: join(stripRef(r), tail) };
    case 'rbac': return { title: `Permissions changed: ${who}`, detail: join(stripRef(r), tail) };
    case 'network': return { title: `Networking changed: ${who}`, detail: join(stripRef(r), tail) };
    case 'storage': return { title: `Storage changed: ${who}`, detail: join(stripRef(r), tail) };
    case 'schedule': return { title: `${who} moved to another node`, detail: join(stripRef(r), tail) };
    case 'restarted': return { title: `${who} restarted`, detail: join(stripRef(r), tail) };
    case 'lifecycle': return { title: `${who}: ${stripRef(r)}`, detail: tail };
    case 'label': case 'annotation': return { title: `${r.kind === 'label' ? 'Labels' : 'Annotations'} changed on ${who}`, detail: join(stripRef(r), tail) };
    default: {
      const first = r.fields[0];
      return {
        title: `Settings changed: ${who}`,
        detail: join(first ? `${fieldLabel(first.path)}${first.from !== undefined || first.to !== undefined ? `: ${first.from ?? 'none'} → ${first.to ?? 'none'}` : ''}` : stripRef(r),
          others.length ? `also: ${others.slice(0, 4).join(', ')}${others.length > 4 ? ` +${others.length - 4} more` : ''}` : undefined, tail),
      };
    }
  }
}

/** The diff summary without its leading "Kind ns/name:" and trailing "— from …". */
function stripRef(e: ChangeEventLike): string {
  return e.summary.replace(new RegExp(`^${e.objectKind} \\S+:?\\s*`), '').replace(/ — from .*$/, '');
}

function describeGroup(kind: 'restarts' | 'pods', w: { kind: string; name: string; namespace?: string }, c: Story['counts'], all: ChangeEventLike[]): { title: string; detail?: string } {
  const who = ref(w.kind, w.name, w.namespace);
  if (kind === 'restarts') {
    // A restart event often carries the reason too (CrashLoopBackOff, OOMKilled…) — say it, never "+1 more".
    const reasons = [...new Set(all.flatMap((e) => e.fields.filter((f) => f.path === 'waiting' && f.to).map((f) => f.to!)))];
    return {
      title: reasons.length ? `Containers crash-looping in ${who}: ${reasons.join(', ')}` : `Containers restarted in ${who}`,
      detail: `${plural(c.restarts, 'restart')} across ${plural(c.podsRestarted, 'pod')}${all.length > 1 ? ` (${all.length} observations)` : ''}`,
    };
  }
  const waiting = all.filter((e) => e.kind === 'lifecycle' && e.fields.some((f) => f.path === 'waiting' && f.to));
  if (waiting.length) {
    const reasons = [...new Set(waiting.flatMap((e) => e.fields.filter((f) => f.path === 'waiting' && f.to).map((f) => f.to!)))];
    return { title: `Pods of ${who} stuck: ${reasons.join(', ')}`, detail: podLine(c) ? `${podLine(c)} · ${plural(waiting.length, 'pod')} waiting` : `${plural(waiting.length, 'pod')} waiting` };
  }
  return { title: `Pods of ${who} changed`, detail: podLine(c) || `${plural(all.length, 'pod change')}` };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export interface DigestLine {
  /** What a click on the line filters to. */
  filter: { category?: string; search?: string };
  text: string;
  count: number;
  severity: Severity;
}

/** "What happened" in this window, biggest first, as sentences. */
export function digestOf(stories: Story[]): DigestLine[] {
  const lines: DigestLine[] = [];
  const by = (pred: (s: Story) => boolean) => stories.filter(pred);
  const names = (xs: Story[], n = 3) => {
    const u = [...new Set(xs.map((s) => s.subject.name))];
    return `${u.slice(0, n).join(', ')}${u.length > n ? ` and ${u.length - n} more` : ''}`;
  };
  const push = (xs: Story[], text: string, filter: DigestLine['filter']) => {
    if (xs.length) lines.push({ text, count: xs.length, filter, severity: xs.reduce<Severity>((a, s) => (RANK[s.severity] > RANK[a] ? s.severity : a), 'info') });
  };

  const rollouts = by((s) => s.root?.kind === 'image');
  push(rollouts, `${plural(rollouts.length, 'new version')} rolled out (${names(rollouts)})`, { category: 'image' });
  const scaled = by((s) => s.root?.kind === 'scaled');
  push(scaled, `${plural(scaled.length, 'scale change')} (${names(scaled)})`, { category: 'scaled' });
  const created = by((s) => s.root?.kind === 'created');
  push(created, `${plural(created.length, 'object')} created (${names(created)})`, { category: 'created' });
  const deleted = by((s) => s.root?.kind === 'deleted');
  push(deleted, `${plural(deleted.length, 'object')} deleted (${names(deleted)})`, { category: 'deleted' });
  const config = by((s) => s.root?.kind === 'config');
  push(config, `${plural(config.length, 'ConfigMap/Secret edit')} (${names(config)})`, { category: 'config' });
  const spec = by((s) => s.root?.kind === 'spec');
  push(spec, `${plural(spec.length, 'settings change')} (${names(spec)})`, { category: 'spec' });
  const cordoned = by((s) => s.root?.kind === 'cordon' && s.title.includes(' cordoned'));
  push(cordoned, `${plural(cordoned.length, 'node')} cordoned (${names(cordoned)})`, { category: 'cordon' });
  const nodes = by((s) => ['cordon', 'taint', 'version'].includes(s.root?.kind || '') && !cordoned.includes(s));
  push(nodes, `${plural(nodes.length, 'other node change')} (${names(nodes)})`, {});
  const net = by((s) => s.root?.kind === 'network');
  push(net, `${plural(net.length, 'networking change')} (${names(net)})`, { category: 'network' });
  const rbac = by((s) => s.root?.kind === 'rbac');
  push(rbac, `${plural(rbac.length, 'permission change')} (${names(rbac)})`, { category: 'rbac' });
  const restarts = by((s) => !s.root && s.kind === 'restarted');
  if (restarts.length) {
    const total = restarts.reduce((a, s) => a + s.counts.restarts, 0);
    const workloads = new Set(restarts.map((s) => `${s.subject.kind}/${s.subject.namespace}/${s.subject.name}`)).size;
    lines.push({ text: `${plural(total, 'container restart')} in ${plural(workloads, 'workload')} (${names(restarts)})`, count: total, filter: { category: 'restarted' }, severity: 'warning' });
  }
  const stuck = by((s) => !s.root && s.title.startsWith('Pods of') && s.title.includes('stuck'));
  push(stuck, `${plural(stuck.length, 'workload')} with pods stuck (${names(stuck)})`, { category: 'lifecycle' });
  const meta = by((s) => s.root?.kind === 'label' || s.root?.kind === 'annotation');
  push(meta, `${plural(meta.length, 'label/annotation change')}`, {});
  const accounted = new Set([...rollouts, ...scaled, ...created, ...deleted, ...config, ...spec, ...cordoned, ...nodes, ...net, ...rbac, ...restarts, ...stuck, ...meta]);
  const rest = stories.filter((s) => !accounted.has(s));
  push(rest, `${plural(rest.length, 'other change')}`, {});
  return lines.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}
