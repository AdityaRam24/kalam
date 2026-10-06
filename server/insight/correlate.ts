// Turning four separate lists into one understanding of a system.
//
// Trinetra already knows four things about a host, and until now it told you them
// four times, in four places, in four vocabularies:
//
//   * the health checklist   ("Disk /var 93% full")            — hostlogs/system.ts
//   * the /var/log findings  ("No space left on device" x412)  — hostlogs/rules.ts
//   * the metric levels      (diskUsedPct critical)            — metrics/model.ts
//   * the dependency graph   (this node's pods are casualties) — graph/analyze.ts
//
// Those are not four problems. They are one problem seen four ways, and the
// thing a person actually wants is the sentence "/var is full on vm-a, which is
// why kubelet is restarting and fourteen pods are pending".
//
// So this file maps every signal onto a shared vocabulary of CONCERNS and
// merges them. The payoff is corroboration: a concern backed by two independent
// kinds of signal is `confirmed`, and one backed by a single kind is `likely`.
// That distinction is the whole point — a log line saying "No space left on
// device" could be an hour-old transient, but a log line PLUS a metric at 97%
// PLUS a failing health check is a fact about right now.
//
// Pure functions only; every input is data. The gathering lives in router.ts.

import type { LogFinding, LogSeverity } from '../hostlogs/rules.js';
import type { HealthCheck } from '../hostlogs/system.js';
import type { Level, MetricId } from '../metrics/model.js';

export type Concern =
  | 'storage' | 'memory' | 'cpu' | 'kernel' | 'hardware' | 'gpu'
  | 'services' | 'kubernetes' | 'security' | 'time' | 'network' | 'general';

export type Severity = 'critical' | 'warning' | 'info';

export interface Evidence {
  /** Which of Trinetra's eyes saw this. `config` = the node's Kubernetes files. */
  kind: 'log' | 'health' | 'metric' | 'graph' | 'config';
  severity: Severity;
  summary: string;
  detail?: string;
  /** How many times a log group matched — 400 hits is not the same as one. */
  count?: number;
  unit?: string;
}

export interface Issue {
  id: string;
  concern: Concern;
  severity: Severity;
  title: string;
  subject: string;
  /** Corroborated by more than one kind of signal, or seen by only one. */
  confidence: 'confirmed' | 'likely';
  why: string;
  evidence: Evidence[];
  /** Read-only commands worth running next. Reported, never executed. */
  checks: string[];
  /** systemd units the UI can offer status/restart for. */
  units: string[];
}

const CONCERN_TITLE: Record<Concern, string> = {
  storage: 'Storage is running out',
  memory: 'Memory pressure',
  cpu: 'CPU saturation',
  kernel: 'Kernel instability',
  hardware: 'Hardware errors',
  gpu: 'GPU trouble',
  services: 'Services are down or flapping',
  kubernetes: 'Kubernetes node problems',
  security: 'Security and certificates',
  time: 'Clock problems',
  network: 'Network errors',
  general: 'Errors in the logs',
};

// Why this concern matters — the sentence that turns a reading into a reason.
const CONCERN_WHY: Record<Concern, string> = {
  storage: 'A full filesystem fails writes, stops logging, and makes kubelet evict pods under DiskPressure.',
  memory: 'When memory runs out the kernel kills processes; on a node that usually means workloads, not the cause.',
  cpu: 'Sustained saturation queues every process, so timeouts appear in unrelated components first.',
  kernel: 'Lockups, oopses and panics are the platform failing underneath everything running on it.',
  hardware: 'Machine-check and memory errors precede real failure; they are not software problems.',
  gpu: 'A GPU that has fallen over takes every accelerated workload on the node with it.',
  services: 'A failed or flapping unit takes its dependants down, often far from where the symptom shows.',
  kubernetes: 'When kubelet or the runtime is unhealthy the node stops being trustworthy even if it is Ready.',
  security: 'Expired certificates and auth failures break components that were working yesterday.',
  time: 'Clock skew breaks TLS, etcd and every attempt to correlate logs across hosts.',
  network: 'Packet and interface errors show up as random timeouts in everything above them.',
  general: 'Errors that did not match a specific rule but are worth a look.',
};

const LOG_RULE_CONCERN: Record<string, Concern> = {
  'kernel-panic': 'kernel', segfault: 'kernel',
  oom: 'memory',
  'disk-full': 'storage', 'fs-error': 'storage', 'io-error': 'storage',
  'hardware-mce': 'hardware',
  'gpu-xid': 'gpu',
  'systemd-failed': 'services',
  kubelet: 'kubernetes',
  cert: 'security', 'auth-failure': 'security', sudo: 'security',
  'time-sync': 'time',
  network: 'network',
  'generic-critical': 'general', 'generic-error': 'general', 'generic-warning': 'general',
};

const METRIC_CONCERN: Partial<Record<MetricId, Concern>> = {
  diskUsedPct: 'storage',
  memUsedPct: 'memory', swapUsedPct: 'memory',
  cpuPct: 'cpu', loadPerCpu: 'cpu', load1: 'cpu',
  gpuTempC: 'gpu', gpuMemPct: 'gpu', gpuUtilPct: 'gpu',
  failedUnits: 'services',
};

/** Health-check ids are either bare (`memory`) or `prefix:subject` (`disk:/var`). */
export function healthConcern(id: string): Concern | null {
  const head = id.split(':')[0];
  switch (head) {
    case 'disk': case 'inode': return 'storage';
    case 'memory': case 'swap': return 'memory';
    case 'load': return 'cpu';
    case 'services': case 'failed': case 'inactive': case 'restarting': return 'services';
    case 'time': return 'time';
    default: return null; // reboot, root — context, not a problem
  }
}

const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const worst = (a: Severity, b: Severity): Severity => (SEV_RANK[a] <= SEV_RANK[b] ? a : b);

const levelToSeverity = (l: Level): Severity | null =>
  l === 'critical' ? 'critical' : l === 'warn' ? 'warning' : null;

export interface CorrelateInput {
  subject: string;
  health?: HealthCheck[];
  findings?: LogFinding[];
  /** Latest metric values with the level each sits at. */
  metrics?: Partial<Record<MetricId, { v: number | null; level: Level; label?: string }>>;
  /** Root causes the dependency graph found, already ranked. */
  graph?: Array<{ title: string; detail?: string; casualties?: number; severity?: Severity }>;
  /** Checks from the node's /etc/kubernetes (server/k8s/nodeconfig.ts). */
  config?: Array<{ status: string; area: string; title: string; detail?: string; evidence?: string; hint?: string }>;
  /** A host that did not answer at all. */
  unreachable?: string;
}

/** Which concern a node-config check belongs to. */
export function configConcern(area: string): Concern {
  switch (area) {
    case 'certificates': case 'apiserver': return 'security';
    case 'time': return 'time';
    case 'etcd': return 'storage';
    default: return 'kubernetes'; // kubelet, changes, drift, access
  }
}

/**
 * Fuse every signal about one subject into ranked issues.
 *
 * Ordering is by severity, then by corroboration, then by how loud the evidence
 * is — so a confirmed critical with 400 log hits outranks a lone warning, which
 * is the order a person would triage in anyway.
 */
export function correlate(input: CorrelateInput): Issue[] {
  const { subject } = input;

  if (input.unreachable) {
    return [{
      id: `${subject}:unreachable`,
      concern: 'network',
      severity: 'critical',
      title: 'Host is unreachable',
      subject,
      confidence: 'confirmed',
      why: 'Nothing else can be judged about a host that will not answer, so every other signal here is stale by definition.',
      evidence: [{ kind: 'metric', severity: 'critical', summary: input.unreachable }],
      checks: [`ping -c 3 ${subject}`, `ssh ${subject} 'uptime'`],
      units: [],
    }];
  }

  const buckets = new Map<Concern, { evidence: Evidence[]; checks: Set<string>; units: Set<string> }>();
  const bucket = (c: Concern) => {
    let b = buckets.get(c);
    if (!b) { b = { evidence: [], checks: new Set(), units: new Set() }; buckets.set(c, b); }
    return b;
  };

  // ── Health checks ─────────────────────────────────────────────────────────
  for (const h of input.health || []) {
    if (h.status === 'ok' || h.status === 'info') continue;
    const concern = healthConcern(h.id);
    if (!concern) continue;
    const b = bucket(concern);
    b.evidence.push({
      kind: 'health',
      severity: h.status === 'critical' ? 'critical' : 'warning',
      summary: h.title,
      detail: h.detail,
      unit: h.unit,
    });
    if (h.unit) b.units.add(h.unit);
  }

  // ── Log findings ──────────────────────────────────────────────────────────
  for (const f of input.findings || []) {
    const concern = LOG_RULE_CONCERN[f.ruleId] || 'general';
    // The generic buckets are noise unless nothing specific matched, so they
    // never get to invent a concern of their own at info level.
    if (concern === 'general' && f.severity === 'info') continue;
    const b = bucket(concern);
    b.evidence.push({
      kind: 'log',
      severity: f.severity as Exclude<LogSeverity, never> as Severity,
      summary: f.title,
      detail: f.message,
      count: f.count,
    });
    for (const c of f.checks || []) b.checks.add(c);
    for (const u of (f as any).units || []) b.units.add(u);
  }

  // ── Metric levels ─────────────────────────────────────────────────────────
  for (const [id, val] of Object.entries(input.metrics || {})) {
    const concern = METRIC_CONCERN[id as MetricId];
    if (!concern || !val) continue;
    const sev = levelToSeverity(val.level);
    if (!sev) continue;
    bucket(concern).evidence.push({
      kind: 'metric',
      severity: sev,
      summary: `${val.label || id} at ${val.v === null ? '—' : val.v.toFixed(0)}`,
    });
  }

  // ── Dependency graph ──────────────────────────────────────────────────────
  for (const g of input.graph || []) {
    bucket('kubernetes').evidence.push({
      kind: 'graph',
      severity: g.severity || 'critical',
      summary: g.title,
      detail: g.casualties ? `${g.casualties} dependent object(s) affected` : g.detail,
      count: g.casualties,
    });
  }

  // ── Node configuration (/etc/kubernetes) ────────────────────────────────
  for (const c of input.config || []) {
    if (c.status !== 'critical' && c.status !== 'warning') continue;
    const b = bucket(configConcern(c.area));
    b.evidence.push({
      kind: 'config',
      severity: c.status,
      summary: c.title,
      detail: [c.detail, c.evidence].filter(Boolean).join(' — '),
    });
    if (c.hint) b.checks.add(c.hint);
  }

  // ── Compose ───────────────────────────────────────────────────────────────
  const issues: Issue[] = [];
  for (const [concern, b] of buckets) {
    if (!b.evidence.length) continue;
    const severity = b.evidence.map((e) => e.severity).reduce(worst, 'info' as Severity);
    const kinds = new Set(b.evidence.map((e) => e.kind));
    issues.push({
      id: `${subject}:${concern}`,
      concern,
      severity,
      title: CONCERN_TITLE[concern],
      subject,
      confidence: kinds.size > 1 ? 'confirmed' : 'likely',
      why: CONCERN_WHY[concern],
      // Loudest evidence first, so the headline of an issue is its worst part.
      evidence: b.evidence.sort(
        (x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity] || (y.count || 0) - (x.count || 0),
      ),
      checks: [...b.checks].slice(0, 6),
      units: [...b.units].slice(0, 6),
    });
  }

  const loudness = (i: Issue) => i.evidence.reduce((n, e) => n + (e.count || 1), 0);
  return issues.sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1) ||
      loudness(b) - loudness(a) ||
      a.concern.localeCompare(b.concern),
  );
}

/** One line summarising a host's state, for a fleet roll-up. */
export function verdict(issues: Issue[]): { severity: Severity | 'ok'; summary: string } {
  if (!issues.length) return { severity: 'ok', summary: 'Nothing is wrong that Trinetra can see.' };
  const top = issues[0];
  const others = issues.length - 1;
  return {
    severity: top.severity,
    summary: `${top.title}${others > 0 ? ` (+${others} other${others > 1 ? 's' : ''})` : ''}`,
  };
}
