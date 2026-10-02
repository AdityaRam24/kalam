// One gate between the network and every view.
//
// Every page reads the same cluster payload, and a single malformed record —
// a pod without a name, a container whose name is null, a status that arrived
// as a number — used to throw inside a render and take the whole app down
// ("hit a rendering error"). A real API server rarely sends such a thing, but
// SSH discovery, older backends, partial reads and proxies can, and a console
// that crashes on the cluster it is meant to explain is useless exactly when
// it is needed.
//
// So the payload is coerced ONCE, here, into the shapes the views are written
// against: strings are strings, numbers are numbers, arrays are arrays, records
// without an identity are dropped, and duplicates (same host/namespace/name)
// are collapsed. Valid data passes through unchanged.

type Rec = Record<string, any>;

const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** A string, or the fallback. Numbers/booleans are stringified; objects are not. */
export function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return fallback;
}
const optStr = (v: unknown): string | undefined => {
  const s = str(v);
  return s ? s : undefined;
};
export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
/** A string→string map (labels). Non-string values are dropped. */
function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}
const amounts = (v: unknown) => {
  const o = isObj(v) ? v : {};
  return { cpuMilli: num(o.cpuMilli), memBytes: num(o.memBytes), gpu: num(o.gpu), ...(o.pods !== undefined ? { pods: num(o.pods) } : {}) };
};
/** A selector as the API encodes it: JSON object text, or 'None'. */
function selector(v: unknown): string {
  if (typeof v !== 'string' || v === 'None' || !v.trim()) return 'None';
  try {
    const parsed = JSON.parse(v);
    return isObj(parsed) && Object.keys(parsed).length ? v : 'None';
  } catch {
    return 'None';
  }
}
const health = (v: unknown) =>
  v === 'healthy' || v === 'progressing' || v === 'failing' || v === 'completed' || v === 'unknown' ? v : undefined;

/** Keep the first of each identity; the rest would collide on the canvas. */
function dedupe<T extends Rec>(items: T[], key: (o: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((o) => {
    const k = key(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const idOf = (o: Rec) => `${o.host || ''}|${o.namespace || ''}|${o.name}`;
const withHost = (o: Rec) => (o.host !== undefined ? { host: str(o.host) } : {});

export function sanitizePod(p: Rec): Rec {
  return {
    ...p,
    ...withHost(p),
    name: str(p.name),
    namespace: str(p.namespace, 'default') || 'default',
    status: str(p.status, 'Unknown') || 'Unknown',
    displayStatus: optStr(p.displayStatus),
    health: health(p.health),
    lastReason: optStr(p.lastReason),
    ready: str(p.ready, '0/0') || '0/0',
    ip: str(p.ip, 'None') || 'None',
    node: str(p.node, 'None') || 'None',
    restarts: num(p.restarts),
    labels: strMap(p.labels),
    owner: isObj(p.owner) && str(p.owner.name) ? { kind: str(p.owner.kind, 'Unknown'), name: str(p.owner.name) } : null,
    containers: arr(p.containers).filter(isObj).map((c) => ({
      ...c,
      name: str(c.name, '?') || '?',
      image: str(c.image),
      ready: c.ready === true,
      state: str(c.state, 'unknown') || 'unknown',
      requests: amounts(c.requests),
      limits: amounts(c.limits),
    })),
    claims: arr(p.claims).map((c) => str(c)).filter(Boolean),
    created: optStr(p.created),
  };
}

export function sanitizeService(s: Rec): Rec {
  return {
    ...s,
    ...withHost(s),
    name: str(s.name),
    namespace: str(s.namespace, 'default') || 'default',
    type: str(s.type, 'ClusterIP') || 'ClusterIP',
    clusterIp: str(s.clusterIp, '—'),
    externalIp: str(s.externalIp),
    ports: str(s.ports),
    selector: selector(s.selector),
    health: health(s.health),
    created: optStr(s.created),
  };
}

export function sanitizeWorkload(d: Rec): Rec {
  return {
    ...d,
    ...withHost(d),
    name: str(d.name),
    namespace: str(d.namespace, 'default') || 'default',
    kind: str(d.kind, 'Deployment') || 'Deployment',
    status: optStr(d.status),
    health: health(d.health),
    ready: str(d.ready, '0/0') || '0/0',
    available: num(d.available),
    updated: num(d.updated),
    replicas: num(d.replicas),
    selector: selector(d.selector),
    created: optStr(d.created),
  };
}

export function sanitizeNode(n: Rec): Rec {
  return {
    ...n,
    ...withHost(n),
    name: str(n.name),
    status: str(n.status, 'Unknown') || 'Unknown',
    role: str(n.role, 'worker') || 'worker',
    version: str(n.version, 'Unknown'),
    ip: str(n.ip, 'Unknown'),
    os: str(n.os, 'Linux'),
    gpus: str(n.gpus, '0'),
    pressure: arr(n.pressure).map((x) => str(x)).filter(Boolean),
    schedulable: n.schedulable !== false,
    capacity: amounts(n.capacity),
    allocatable: amounts(n.allocatable),
    gpuProduct: optStr(n.gpuProduct),
    created: optStr(n.created),
  };
}

export function sanitizeIsvc(i: Rec): Rec {
  return {
    ...i,
    ...withHost(i),
    name: str(i.name),
    namespace: str(i.namespace, 'default') || 'default',
    status: str(i.status, 'Unknown') || 'Unknown',
    health: health(i.health) || 'unknown',
    url: str(i.url),
    modelFormat: str(i.modelFormat),
    storageUri: str(i.storageUri),
    runtime: str(i.runtime),
    traffic: str(i.traffic),
    created: optStr(i.created),
  };
}

const clean = <T extends Rec>(list: unknown, fn: (o: Rec) => T): T[] =>
  dedupe(arr(list).filter(isObj).map(fn).filter((o) => !!o.name), idOf);

export function sanitizeK8s(raw: unknown): { pods: any[]; services: any[]; deployments: any[]; nodes: any[]; inferenceServices: any[] } {
  const r = isObj(raw) ? raw : {};
  return {
    pods: clean(r.pods, sanitizePod),
    services: clean(r.services, sanitizeService),
    deployments: dedupe(arr(r.deployments).filter(isObj).map(sanitizeWorkload).filter((o) => !!o.name),
      (o) => `${o.host || ''}|${o.namespace}|${o.kind}|${o.name}`),
    nodes: dedupe(arr(r.nodes).filter(isObj).map(sanitizeNode).filter((o) => !!o.name), (o) => `${o.host || ''}|${o.name}`),
    inferenceServices: clean(r.inferenceServices, sanitizeIsvc),
  };
}

export function sanitizeContainers(raw: unknown): any[] {
  return dedupe(
    arr(raw).filter(isObj).map((c) => {
      const id = str(c.id);
      return {
        ...c,
        ...withHost(c),
        id,
        name: str(c.name) || id.slice(0, 12),
        image: str(c.image),
        status: str(c.status),
        state: str(c.state, 'unknown') || 'unknown',
        ports: str(c.ports),
        created: optStr(c.created),
        runtime: optStr(c.runtime),
      };
    }).filter((c) => !!c.id),
    (c) => `${c.host || ''}|${c.id}`,
  );
}

// ── Drawer payloads ─────────────────────────────────────────────────────────
// The inspect, object-history and change-summary responses feed the detail
// drawer and the heatmap; they get the same treatment as the cluster read.

/** Text for a requests/limits block in either shape (string, or {cpuMilli, memBytes, gpu}). */
export function amountsText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  const parts: string[] = [];
  const cpu = num(v.cpuMilli);
  const mem = num(v.memBytes);
  const gpu = num(v.gpu);
  if (cpu) parts.push(cpu >= 1000 ? `cpu ${+(cpu / 1000).toFixed(2)}` : `cpu ${cpu}m`);
  if (mem) parts.push(`mem ${mem >= 1024 ** 3 ? `${+(mem / 1024 ** 3).toFixed(1)}Gi` : `${Math.round(mem / 1024 ** 2)}Mi`}`);
  if (gpu) parts.push(`gpu ${gpu}`);
  return parts.join(', ');
}

const anyMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'string' ? val : val === null || val === undefined ? '' : JSON.stringify(val);
  return out;
};

export function sanitizeContainerDetail(c: Rec): Rec {
  return {
    ...c,
    name: str(c.name, '?') || '?',
    image: str(c.image),
    state: optStr(c.state),
    reason: optStr(c.reason),
    restarts: num(c.restarts),
    ports: optStr(c.ports),
    requests: amountsText(c.requests) || undefined,
    limits: amountsText(c.limits) || undefined,
    probes: optStr(c.probes),
    command: optStr(c.command),
    mounts: optStr(c.mounts),
  };
}

export function sanitizeInspect(d: unknown): Rec {
  const o = isObj(d) ? d : {};
  return {
    ...o,
    summary: arr(o.summary).filter(isObj).map((r) => ({ label: str(r.label), value: str(r.value) })).filter((r) => r.label),
    labels: anyMap(o.labels),
    annotations: anyMap(o.annotations),
    containers: arr(o.containers).filter(isObj).map(sanitizeContainerDetail),
    groups: arr(o.groups).filter(isObj).map((g) => ({
      title: str(g.title, 'Related') || 'Related',
      items: arr(g.items).filter(isObj).map((i) => ({
        ...i, kind: str(i.kind, '?') || '?', name: str(i.name), namespace: optStr(i.namespace),
        via: str(i.via), detail: optStr(i.detail), health: health(i.health), focus: optStr(i.focus),
      })).filter((i) => i.name),
    })),
    events: arr(o.events).filter(isObj).map((e) => ({
      type: str(e.type, 'Normal') || 'Normal', reason: str(e.reason), message: str(e.message), count: num(e.count, 1), time: str(e.time),
    })),
    yaml: str(o.yaml),
    describe: str(o.describe),
    error: optStr(o.error),
  };
}

export function sanitizeObjectHistory(d: unknown): Rec {
  const o = isObj(d) ? d : {};
  return {
    ...o,
    changes: arr(o.changes).filter(isObj).map((c) => ({
      ...c, id: str(c.id), at: str(c.at), actualAt: optStr(c.actualAt), kind: str(c.kind, 'spec'),
      severity: str(c.severity, 'info'), summary: str(c.summary), actor: optStr(c.actor),
      impact: arr(c.impact).map((x) => str(x)).filter(Boolean),
      fields: arr(c.fields).filter(isObj).map((f) => ({ path: str(f.path), from: optStr(f.from), to: optStr(f.to) })),
    })),
    revisions: arr(o.revisions).filter(isObj).map((r) => ({
      ...r, revision: str(r.revision), cause: optStr(r.cause), createdAt: optStr(r.createdAt), replicas: num(r.replicas),
      active: r.active === true, images: arr(r.images).map((x) => str(x)).filter(Boolean), changed: arr(r.changed).map((x) => str(x)).filter(Boolean),
    })),
  };
}

export function sanitizeChangeIndex(d: unknown): Record<string, { count: number; lastAt: string; kind: string; severity: string; summary: string }> {
  const out: Record<string, { count: number; lastAt: string; kind: string; severity: string; summary: string }> = {};
  if (!isObj(d)) return out;
  for (const [k, v] of Object.entries(d)) {
    if (!isObj(v)) continue;
    const lastAt = str(v.lastAt);
    if (Number.isNaN(Date.parse(lastAt))) continue;
    out[k] = { count: num(v.count, 1), lastAt, kind: str(v.kind, 'spec'), severity: str(v.severity, 'info'), summary: str(v.summary) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Why-engine payloads (/api/k8s/why, /api/history/why)
// ---------------------------------------------------------------------------

export interface WhyRef { kind: string; name: string; namespace?: string; reason?: string }
export interface WhyKey { name: string; readBy: string; meaning: string; ifWrong: string }
export interface WhySuspect { score: number; reason: string; change: { id: string; at: string; actualAt?: string; kind: string; severity: string; summary: string; objectKind: string; name: string; namespace?: string; actor?: string; impact: string[] } }
export interface WhyFinding {
  id: string; object: WhyRef; severity: 'critical' | 'warning' | 'info'; category: string; title: string; why: string;
  evidence: string[]; fix: string[]; rootCause?: WhyRef; affects: WhyRef[]; contract?: string; key?: WhyKey; since?: string;
  suspects: WhySuspect[];
}
export interface WhyContract { type: string; rule: string; status: 'ok' | 'violated' | 'unknown'; detail: string; key?: WhyKey }
export interface WhyMeta { key: string; value: string; where: string; readBy: string; meaning: string; ifWrong: string }
export interface WhyFocus { ok: boolean; error?: string; findings: WhyFinding[]; causes: WhyFinding[]; contracts: WhyContract[]; metadata: WhyMeta[]; read: string[]; at?: string }

const strList = (v: unknown) => arr(v).map((x) => str(x)).filter(Boolean);
const ref = (v: unknown): WhyRef | undefined =>
  isObj(v) && str(v.name) ? { kind: str(v.kind, '?'), name: str(v.name), namespace: optStr(v.namespace), reason: optStr(v.reason) } : undefined;
const whyKey = (v: unknown): WhyKey | undefined =>
  isObj(v) && str(v.name) ? { name: str(v.name), readBy: str(v.readBy), meaning: str(v.meaning), ifWrong: str(v.ifWrong) } : undefined;
const sev = (v: unknown): WhyFinding['severity'] => (v === 'critical' || v === 'warning' || v === 'info' ? v : 'warning');

export function sanitizeFinding(v: unknown): WhyFinding | undefined {
  if (!isObj(v)) return undefined;
  const object = ref(v.object);
  if (!object) return undefined;
  return {
    id: str(v.id, `${object.kind}/${object.name}`), object, severity: sev(v.severity), category: str(v.category, 'events'),
    title: str(v.title, 'Problem'), why: str(v.why), evidence: strList(v.evidence), fix: strList(v.fix),
    rootCause: ref(v.rootCause), affects: arr(v.affects).map(ref).filter((x): x is WhyRef => !!x),
    contract: optStr(v.contract), key: whyKey(v.key), since: optStr(v.since),
    suspects: arr(v.suspects).filter(isObj).filter((s) => isObj(s.change)).map((s) => {
      const c = s.change as Rec;
      return {
        score: num(s.score), reason: str(s.reason),
        change: {
          id: str(c.id), at: str(c.at), actualAt: optStr(c.actualAt), kind: str(c.kind, 'spec'), severity: str(c.severity, 'info'),
          summary: str(c.summary), objectKind: str(c.objectKind), name: str(c.name), namespace: optStr(c.namespace),
          actor: optStr(c.actor), impact: strList(c.impact),
        },
      };
    }),
  };
}

export function sanitizeWhyFocus(d: unknown): WhyFocus {
  const o = isObj(d) ? d : {};
  const findings = (list: unknown) => arr(list).map(sanitizeFinding).filter((x): x is WhyFinding => !!x);
  return {
    ok: o.ok === true, error: optStr(o.error), findings: findings(o.findings), causes: findings(o.causes),
    contracts: arr(o.contracts).filter(isObj).map((c) => ({
      type: str(c.type, 'reference'), rule: str(c.rule), detail: str(c.detail), key: whyKey(c.key),
      status: c.status === 'ok' || c.status === 'violated' ? c.status : 'unknown',
    })).filter((c) => c.rule),
    metadata: arr(o.metadata).filter(isObj).map((m) => ({
      key: str(m.key), value: str(m.value), where: str(m.where, 'label'), readBy: str(m.readBy), meaning: str(m.meaning), ifWrong: str(m.ifWrong),
    })).filter((m) => m.key),
    read: strList(o.read), at: optStr(o.at),
  };
}

/** /api/k8s/why byObject → card index. */
export function sanitizeWhyIndex(d: unknown): Record<string, { severity: 'critical' | 'warning' | 'info'; title: string; count: number }> {
  const out: Record<string, { severity: 'critical' | 'warning' | 'info'; title: string; count: number }> = {};
  if (!isObj(d)) return out;
  for (const [k, v] of Object.entries(d)) if (isObj(v) && str(v.title)) out[k] = { severity: sev(v.severity), title: str(v.title), count: num(v.count, 1) };
  return out;
}
