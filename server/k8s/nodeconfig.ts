// What /etc/kubernetes (and its RKE2 / k3s equivalents) says about a node.
//
// The cluster API tells you what Kubernetes is doing; the files on the node
// tell you how it was BUILT — and most of the failures that arrive "out of
// nowhere" were set up there months earlier:
//
//   * a certificate that expires on a Sunday (the classic one-year kubeadm cliff)
//   * an apiserver with no audit log, no encryption at rest, anonymous auth on
//   * etcd creeping up on its backend quota until every write is refused
//   * a kubelet whose eviction thresholds explain "why do my pods keep dying"
//   * two control-plane nodes that quietly disagree on a flag, or a version
//   * a static-pod manifest edited ten minutes ago
//
// Read-only, and careful about what leaves the host. Certificates are parsed ON
// the node with `openssl x509 -noout`, so only dates, subjects and SANs travel.
// Kubeconfigs contribute their server URL and the expiry of the embedded CLIENT
// certificate — never a key, never a token. Manifest flags whose names smell of
// a secret are redacted on the host by sed and again here.
//
// Pure parsing and judging live in this file and are covered by
// server/__tests__/nodeconfig.test.ts; the router at the bottom does the SSH.

import { Router } from 'express';
import { loadVms, sshRun, type VmEntry } from '../vms.js';
import { splitMarked, mark } from '../hostlogs/router.js';
import { SAFE_NAME } from './kubectl.js';

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

const CERT_GLOBS = [
  '/etc/kubernetes/pki/*.crt', '/etc/kubernetes/pki/etcd/*.crt',
  '/var/lib/rancher/rke2/server/tls/*.crt', '/var/lib/rancher/rke2/server/tls/etcd/*.crt', '/var/lib/rancher/rke2/agent/*.crt',
  '/var/lib/rancher/k3s/server/tls/*.crt', '/var/lib/rancher/k3s/server/tls/etcd/*.crt', '/var/lib/rancher/k3s/agent/*.crt',
  '/var/lib/kubelet/pki/*.crt', '/var/lib/kubelet/pki/kubelet-client-current.pem',
];
const KUBECONFIGS = [
  '/etc/kubernetes/admin.conf', '/etc/kubernetes/super-admin.conf', '/etc/kubernetes/kubelet.conf',
  '/etc/kubernetes/controller-manager.conf', '/etc/kubernetes/scheduler.conf',
  '/etc/rancher/rke2/rke2.yaml', '/etc/rancher/k3s/k3s.yaml',
];
const MANIFEST_GLOBS = ['/etc/kubernetes/manifests/*.yaml', '/etc/kubernetes/manifests/*.yml', '/var/lib/rancher/rke2/agent/pod-manifests/*.yaml'];
const ETCD_DBS = ['/var/lib/etcd/member/snap/db', '/var/lib/rancher/rke2/server/db/etcd/member/snap/db', '/var/lib/rancher/k3s/server/db/etcd/member/snap/db'];

/** Flag names that may carry a secret as their VALUE (paths ending -file/-dir are fine). */
const SECRET_FLAG = /(token|password|secret|credential)/i;
const PATH_FLAG = /-(file|dir|path)$/i;

// `sed` expression that blanks secret-looking flag values on the host itself.
const REDACT_FLAGS = `sed -E '/^FLAG=--[A-Za-z0-9-]*-(file|dir|path)=/!s/^(FLAG=--[A-Za-z0-9-]*(token|password|secret|credential)[A-Za-z0-9-]*)=.*/\\1=<redacted>/I'`;
const REDACT_YAML = `sed -E 's/^([[:space:]-]*[\\"]?[A-Za-z0-9_.-]*(token|password|secret|credential)[A-Za-z0-9_.-]*[\\"]?[[:space:]]*[:=]).*/\\1 <redacted>/I'`;

export const NODECONFIG_CMD = [
  mark('SELF'),
  'echo "HOST=$(hostname)"; echo "UID=$(id -u)"; echo "NOW=$(date +%s)"; ' +
    'command -v openssl >/dev/null 2>&1 && echo "OPENSSL=yes" || echo "OPENSSL=no"; ' +
    'for d in /etc/kubernetes /var/lib/rancher/rke2 /var/lib/rancher/k3s /var/lib/kubelet; do [ -d "$d" ] && echo "DIR=$d"; done',

  mark('CERTS'),
  `for f in ${CERT_GLOBS.join(' ')}; do [ -f "$f" ] || continue; echo "FILE=$f"; ` +
    'openssl x509 -in "$f" -noout -enddate -startdate -subject -issuer 2>/dev/null || echo "UNREADABLE=1"; ' +
    'openssl x509 -in "$f" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | sed "s/^[[:space:]]*/SAN=/"; done',

  mark('KUBECONF'),
  `for f in ${KUBECONFIGS.join(' ')}; do [ -f "$f" ] || continue; echo "FILE=$f"; ` +
    "grep -m1 -E '^[[:space:]]*server:' \"$f\" | sed -E 's/^[[:space:]]*server:[[:space:]]*/SERVER=/'; " +
    "grep -m1 -E '^[[:space:]]*client-certificate:' \"$f\" | sed -E 's/^[[:space:]]*client-certificate:[[:space:]]*/CERTFILE=/'; " +
    "d=$(grep -m1 'client-certificate-data:' \"$f\" | awk '{print $2}'); " +
    '[ -n "$d" ] && echo "$d" | base64 -d 2>/dev/null | openssl x509 -noout -enddate -subject 2>/dev/null; done',

  mark('MANIFESTS'),
  `for f in ${MANIFEST_GLOBS.join(' ')}; do [ -f "$f" ] || continue; echo "FILE=$f"; ` +
    'echo "MTIME=$(stat -c %Y "$f" 2>/dev/null)"; echo "SHA=$(sha256sum "$f" 2>/dev/null | cut -c1-16)"; ' +
    "grep -m1 -E '^[[:space:]]*image:' \"$f\" | sed -E 's/^[[:space:]]*image:[[:space:]]*/IMAGE=/'; " +
    `grep -E '^[[:space:]]*-[[:space:]]+"?--[A-Za-z0-9-]+' "$f" | sed -E 's/^[[:space:]]*-[[:space:]]+"?/FLAG=/; s/"[[:space:]]*$//' | ${REDACT_FLAGS}; done`,

  mark('KUBELET'),
  'f=/var/lib/kubelet/config.yaml; [ -f "$f" ] && { echo "MTIME=$(stat -c %Y "$f" 2>/dev/null)"; head -c 65536 "$f"; }',

  mark('KFLAGS'),
  `for f in /var/lib/kubelet/kubeadm-flags.env /etc/default/kubelet /etc/sysconfig/kubelet; do [ -f "$f" ] && grep -v '^#' "$f" | ${REDACT_YAML}; done`,

  mark('RANCHER'),
  `for f in /etc/rancher/rke2/config.yaml /etc/rancher/k3s/config.yaml; do [ -f "$f" ] || continue; echo "# FILE $f"; head -c 32768 "$f" | ${REDACT_YAML}; done`,

  mark('ETCD'),
  `for f in ${ETCD_DBS.join(' ')}; do [ -f "$f" ] && echo "DB=$f $(stat -c %s "$f" 2>/dev/null)"; done`,

  mark('END'),
].join('; ');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface CertInfo {
  path: string;
  notAfter?: string;   // ISO
  notBefore?: string;  // ISO
  subject?: string;
  issuer?: string;
  sans: string[];
  unreadable?: boolean;
  /** Filled in by analysis: whole days left at `now`. */
  daysLeft?: number;
}

export interface KubeconfigInfo {
  path: string;
  server?: string;
  certFile?: string;
  notAfter?: string;
  subject?: string;
}

export interface ManifestInfo {
  path: string;
  component: string;
  image?: string;
  version?: string;
  mtime?: number; // epoch seconds
  sha?: string;
  flags: Record<string, string>;
}

export interface NodeConfig {
  host?: string;
  uid?: number;
  hostNow?: number; // epoch seconds on the node
  openssl: boolean;
  dirs: string[];
  distro: 'kubeadm' | 'rke2' | 'k3s' | 'none';
  role: 'control-plane' | 'worker' | 'unknown';
  certs: CertInfo[];
  kubeconfigs: KubeconfigInfo[];
  manifests: ManifestInfo[];
  kubelet?: { mtime?: number; config: Record<string, string> };
  kubeletFlags: Record<string, string>;
  rancherConfig: string[];
  etcdDb?: { path: string; bytes: number };
}

const isoOf = (s: string) => {
  const t = Date.parse(s.trim().replace(/\s+/g, ' '));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** `subject=CN = kube-apiserver` (1.1+) or `subject= /CN=kube-apiserver` (1.0) → "CN=kube-apiserver". */
export function cleanDn(s: string): string {
  return s.replace(/^\s*\//, '').replace(/\s*=\s*/g, '=').replace(/\//g, ', ').trim();
}

/** Split a section into items, each starting at a `FILE=` line. */
function items(body: string[]): Array<{ file: string; lines: string[] }> {
  const out: Array<{ file: string; lines: string[] }> = [];
  for (const raw of body) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('FILE=')) out.push({ file: line.slice(5).trim(), lines: [] });
    else if (out.length && line.trim()) out[out.length - 1].lines.push(line);
  }
  return out;
}

const kv = (line: string): [string, string] => {
  const i = line.indexOf('=');
  return i < 0 ? [line.trim(), ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
};

export function parseCertLines(file: string, lines: string[]): CertInfo {
  const c: CertInfo = { path: file, sans: [] };
  for (const l of lines) {
    const [k, v] = kv(l);
    if (k === 'notAfter') c.notAfter = isoOf(v);
    else if (k === 'notBefore') c.notBefore = isoOf(v);
    else if (k === 'subject') c.subject = cleanDn(v);
    else if (k === 'issuer') c.issuer = cleanDn(v);
    else if (k === 'UNREADABLE') c.unreadable = true;
    else if (k === 'SAN') c.sans.push(...v.split(',').map((x) => x.trim()).filter(Boolean));
  }
  return c;
}

/** `kube-apiserver.yaml` → `kube-apiserver`; RKE2 names its manifests the same way. */
export function componentOf(path: string): string {
  return (path.split('/').pop() || path).replace(/\.ya?ml$/, '');
}

/** The tag of `registry.k8s.io/kube-apiserver:v1.30.4` → `v1.30.4`. */
export function imageVersion(image?: string): string | undefined {
  const m = (image || '').match(/:([^:@/]+)(@.*)?$/);
  return m ? m[1] : undefined;
}

/** Redact a secret-looking flag value. Applied again here in case the host's sed differed. */
export function redactFlag(name: string, value: string): string {
  return SECRET_FLAG.test(name) && !PATH_FLAG.test(name) && value ? '<redacted>' : value;
}

export function parseFlags(lines: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const l of lines) {
    if (!l.startsWith('FLAG=')) continue;
    const body = l.slice(5).trim().replace(/^--/, '');
    const i = body.indexOf('=');
    const name = i < 0 ? body : body.slice(0, i);
    const value = i < 0 ? 'true' : body.slice(i + 1).replace(/^"|"$/g, '');
    flags[name] = redactFlag(name, value);
  }
  return flags;
}

/**
 * Flatten simple YAML (maps of scalars, any depth) into dotted keys. Lists are
 * skipped. This is all the kubelet config needs, and avoids pulling a YAML
 * dependency into a tool that installs offline.
 */
export function flattenYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: Array<{ indent: number; key: string }> = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*-/.test(raw) || /^---/.test(raw)) continue;
    const m = raw.match(/^(\s*)("?[A-Za-z0-9_./-]+"?)\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].replace(/"/g, '');
    const value = m[3].replace(/\s+#.*$/, '').trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const full = [...stack.map((s) => s.key), key].join('.');
    if (value === '' || value === '|' || value === '>') stack.push({ indent, key });
    else out[full] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

/** `KUBELET_KUBEADM_ARGS="--a=b --c=d"` → { a: 'b', c: 'd' }. */
export function parseKubeletEnv(lines: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const l of lines) {
    for (const m of l.matchAll(/--([A-Za-z0-9-]+)(?:=("[^"]*"|[^\s"]+))?/g)) {
      flags[m[1]] = redactFlag(m[1], (m[2] || 'true').replace(/^"|"$/g, ''));
    }
  }
  return flags;
}

export function parseNodeConfig(stdout: string): NodeConfig {
  const blocks = splitMarked(stdout);
  const get = (tag: string) => blocks.find((b) => b.tag === tag)?.body || [];

  const cfg: NodeConfig = {
    openssl: true, dirs: [], distro: 'none', role: 'unknown',
    certs: [], kubeconfigs: [], manifests: [], kubeletFlags: {}, rancherConfig: [],
  };

  for (const l of get('SELF')) {
    const [k, v] = kv(l);
    if (k === 'HOST') cfg.host = v;
    else if (k === 'UID') cfg.uid = Number(v);
    else if (k === 'NOW') cfg.hostNow = Number(v) || undefined;
    else if (k === 'OPENSSL') cfg.openssl = v === 'yes';
    else if (k === 'DIR') cfg.dirs.push(v);
  }

  cfg.certs = items(get('CERTS')).map((it) => parseCertLines(it.file, it.lines));

  cfg.kubeconfigs = items(get('KUBECONF')).map((it) => {
    const k: KubeconfigInfo = { path: it.file };
    for (const l of it.lines) {
      const [key, v] = kv(l);
      if (key === 'SERVER') k.server = v;
      else if (key === 'CERTFILE') k.certFile = v;
      else if (key === 'notAfter') k.notAfter = isoOf(v);
      else if (key === 'subject') k.subject = cleanDn(v);
    }
    return k;
  });

  cfg.manifests = items(get('MANIFESTS')).map((it) => {
    const m: ManifestInfo = { path: it.file, component: componentOf(it.file), flags: parseFlags(it.lines) };
    for (const l of it.lines) {
      const [k, v] = kv(l);
      if (k === 'IMAGE') { m.image = v.replace(/^["']|["']$/g, ''); m.version = imageVersion(m.image); }
      else if (k === 'MTIME') m.mtime = Number(v) || undefined;
      else if (k === 'SHA') m.sha = v || undefined;
    }
    return m;
  });

  const kl = get('KUBELET');
  if (kl.some((l) => l.trim())) {
    const mt = kl.find((l) => l.startsWith('MTIME='));
    cfg.kubelet = {
      mtime: mt ? Number(mt.slice(6)) || undefined : undefined,
      config: flattenYaml(kl.filter((l) => !l.startsWith('MTIME=')).join('\n')),
    };
  }
  cfg.kubeletFlags = parseKubeletEnv(get('KFLAGS'));
  cfg.rancherConfig = get('RANCHER').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()).slice(0, 200);

  for (const l of get('ETCD')) {
    const m = l.match(/^DB=(\S+)\s+(\d+)/);
    if (m) cfg.etcdDb = { path: m[1], bytes: Number(m[2]) };
  }

  const has = (p: string) => cfg.dirs.some((d) => d.startsWith(p));
  cfg.distro = has('/var/lib/rancher/rke2') ? 'rke2' : has('/var/lib/rancher/k3s') ? 'k3s' : has('/etc/kubernetes') || has('/var/lib/kubelet') ? 'kubeadm' : 'none';
  const cp = cfg.manifests.some((m) => /kube-apiserver|etcd/.test(m.component)) ||
    cfg.certs.some((c) => /apiserver\.crt$|serving-kube-apiserver\.crt$/.test(c.path));
  cfg.role = cp ? 'control-plane' : cfg.distro !== 'none' ? 'worker' : 'unknown';
  return cfg;
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

export type CheckStatus = 'critical' | 'warning' | 'info' | 'ok';
export type CheckArea = 'certificates' | 'apiserver' | 'etcd' | 'kubelet' | 'changes' | 'access' | 'drift' | 'time';

export interface ConfigCheck {
  id: string;
  status: CheckStatus;
  area: CheckArea;
  title: string;
  detail?: string;
  /** Where it was read — a file, or file + flag. */
  evidence?: string;
  /** Read-only command or next step. Reported, never run. */
  hint?: string;
}

const DAY = 86_400_000;
const CERT_WARN_DAYS = 30;
const CERT_CRIT_DAYS = 7;
const ETCD_DEFAULT_QUOTA = 2 * 1024 ** 3;

const certName = (p: string) => p.replace(/^\/(etc\/kubernetes|var\/lib\/rancher\/(rke2|k3s)|var\/lib\/kubelet)\//, '');

/** Parse quantities like `2147483648`, `8Gi`, `100Mi` into bytes. */
export function parseBytes(v?: string): number | undefined {
  if (!v) return undefined;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!m) return undefined;
  const mult: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(m[1]) * (m[2] ? mult[m[2]] : 1);
}

const gibStr = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GiB`;

function expiryCheck(id: string, label: string, notAfter: string | undefined, evidence: string, hint: string, now: number): ConfigCheck | undefined {
  if (!notAfter) return undefined;
  const left = Date.parse(notAfter) - now;
  const days = Math.floor(left / DAY);
  const when = notAfter.slice(0, 10);
  if (left < 0) return { id, status: 'critical', area: 'certificates', title: `${label} EXPIRED ${Math.floor(-left / DAY)} day(s) ago`, detail: `Expired ${when}. Anything presenting it is being rejected right now.`, evidence, hint };
  if (days < CERT_CRIT_DAYS) return { id, status: 'critical', area: 'certificates', title: `${label} expires in ${days} day(s)`, detail: `Valid until ${when}.`, evidence, hint };
  if (days < CERT_WARN_DAYS) return { id, status: 'warning', area: 'certificates', title: `${label} expires in ${days} days`, detail: `Valid until ${when}.`, evidence, hint };
  return undefined;
}

/** Everything worth saying about one node's configuration. Pure. */
export function analyzeNodeConfig(cfg: NodeConfig, now = Date.now()): ConfigCheck[] {
  const out: ConfigCheck[] = [];
  if (cfg.distro === 'none') {
    out.push({ id: 'none', status: 'info', area: 'access', title: 'Not a Kubernetes node', detail: 'No /etc/kubernetes, /var/lib/kubelet, RKE2 or k3s directories on this host.' });
    return out;
  }
  if (cfg.uid !== undefined && cfg.uid !== 0 && !cfg.certs.length && !cfg.manifests.length) {
    out.push({ id: 'access', status: 'warning', area: 'access', title: 'Not enough access to read the Kubernetes config',
      detail: 'These files are root-only. Give Trinetra root on this host (K8s Nodes tab → shield icon) and scan again.' });
  }
  if (!cfg.openssl && cfg.certs.length) {
    out.push({ id: 'openssl', status: 'info', area: 'certificates', title: 'openssl is not installed on this node', detail: 'Certificate files were found but their dates could not be read.' });
  }

  // ── Certificates ─────────────────────────────────────────────────────────
  const renew = cfg.distro === 'kubeadm' ? 'kubeadm certs check-expiration   (then: kubeadm certs renew all, in a maintenance window)'
    : cfg.distro === 'rke2' ? 'rke2 certificate check   (RKE2 rotates leaf certs on restart within 90 days of expiry)'
      : 'k3s certificate check';
  let soonest: { name: string; days: number } | undefined;
  for (const c of cfg.certs) {
    if (!c.notAfter) continue;
    c.daysLeft = Math.floor((Date.parse(c.notAfter) - now) / DAY);
    if (!soonest || c.daysLeft < soonest.days) soonest = { name: certName(c.path), days: c.daysLeft };
    const chk = expiryCheck(`cert:${c.path}`, `Certificate ${certName(c.path)}`, c.notAfter, c.path, renew, now);
    if (chk) out.push(chk);
    if (c.notBefore && Date.parse(c.notBefore) > now + 60_000) {
      out.push({ id: `cert-future:${c.path}`, status: 'warning', area: 'time', title: `Certificate ${certName(c.path)} is not valid yet`,
        detail: `Valid from ${c.notBefore}. Either it was just issued on a host with a fast clock, or this host's clock is behind.`, evidence: c.path });
    }
  }
  for (const k of cfg.kubeconfigs) {
    const chk = expiryCheck(`kubeconfig:${k.path}`, `Client certificate in ${certName(k.path)}`, k.notAfter, k.path, renew, now);
    if (chk) out.push(chk);
  }
  if (soonest && soonest.days >= CERT_WARN_DAYS) {
    out.push({ id: 'certs-ok', status: 'ok', area: 'certificates', title: `All ${cfg.certs.length} certificates valid for at least ${soonest.days} days`, detail: `Soonest: ${soonest.name}.` });
  }

  // ── API server posture ───────────────────────────────────────────────────
  const api = cfg.manifests.find((m) => m.component === 'kube-apiserver');
  if (api) {
    const f = api.flags;
    const ev = (flag: string) => `${api.path}  --${flag}${f[flag] !== undefined ? `=${f[flag]}` : ' (not set)'}`;
    const check = (id: string, bad: boolean, status: CheckStatus, title: string, okTitle: string, flag: string, detail?: string) =>
      out.push(bad ? { id: `api:${id}`, status, area: 'apiserver', title, detail, evidence: ev(flag) } : { id: `api:${id}`, status: 'ok', area: 'apiserver', title: okTitle, evidence: ev(flag) });

    check('anon', f['anonymous-auth'] !== 'false', 'warning', 'Anonymous requests are allowed', 'Anonymous auth disabled', 'anonymous-auth',
      'Unauthenticated requests reach the API as system:anonymous. Usually harmless with RBAC, but it widens what a scanner can probe.');
    check('authz', /AlwaysAllow/.test(f['authorization-mode'] || ''), 'critical', 'Authorization mode includes AlwaysAllow', `Authorization: ${f['authorization-mode'] || 'default'}`, 'authorization-mode',
      'Every authenticated request is allowed — RBAC is not being enforced.');
    check('audit', !f['audit-log-path'] && !f['audit-webhook-config-file'], 'warning', 'No API audit log', 'API audit logging is on', 'audit-log-path',
      'Without an audit log there is no record of who changed what — the first thing an incident review asks for.');
    check('encrypt', !f['encryption-provider-config'], 'warning', 'Secrets are not encrypted at rest in etcd', 'Encryption at rest configured', 'encryption-provider-config',
      'Secrets sit base64-encoded in etcd and in every etcd backup.');
    check('noderestrict', !/NodeRestriction/.test(f['enable-admission-plugins'] || ''), 'warning', 'NodeRestriction admission plugin not enabled', 'NodeRestriction admission enabled', 'enable-admission-plugins',
      'A compromised kubelet can modify other nodes and pods it does not run.');
    check('profiling', f['profiling'] !== 'false', 'info', 'Profiling endpoint enabled', 'Profiling disabled', 'profiling');
    if (f['insecure-port'] && f['insecure-port'] !== '0') {
      out.push({ id: 'api:insecure-port', status: 'critical', area: 'apiserver', title: `Insecure port ${f['insecure-port']} is open`, detail: 'Unauthenticated, unencrypted full access to the API.', evidence: ev('insecure-port') });
    }
    if (f['service-cluster-ip-range']) {
      out.push({ id: 'api:svc-range', status: 'info', area: 'apiserver', title: `Service CIDR ${f['service-cluster-ip-range']}`, evidence: ev('service-cluster-ip-range') });
    }
  }

  // ── etcd ─────────────────────────────────────────────────────────────────
  const etcd = cfg.manifests.find((m) => m.component === 'etcd');
  if (cfg.etcdDb) {
    const quota = parseBytes(etcd?.flags['quota-backend-bytes']) || ETCD_DEFAULT_QUOTA;
    const pct = (cfg.etcdDb.bytes / quota) * 100;
    const status: CheckStatus = pct >= 95 ? 'critical' : pct >= 80 ? 'warning' : 'ok';
    out.push({
      id: 'etcd:quota', status, area: 'etcd',
      title: `etcd database ${gibStr(cfg.etcdDb.bytes)} of ${gibStr(quota)} quota (${pct.toFixed(0)}%)`,
      detail: status === 'ok' ? undefined : 'At the quota etcd raises a NOSPACE alarm and refuses every write — the cluster goes read-only. Compaction + defrag reclaims space.',
      evidence: `${cfg.etcdDb.path}${etcd?.flags['quota-backend-bytes'] ? `  --quota-backend-bytes=${etcd.flags['quota-backend-bytes']}` : '  (default 2 GiB quota)'}`,
      hint: status === 'ok' ? undefined : 'ETCDCTL_API=3 etcdctl endpoint status -w table   (then compact + defrag, one member at a time)',
    });
  }
  if (etcd && etcd.flags['auto-compaction-retention'] === undefined && cfg.distro === 'kubeadm') {
    out.push({ id: 'etcd:compaction', status: 'info', area: 'etcd', title: 'etcd auto-compaction not set on the command line', detail: 'kube-apiserver compacts every 5 minutes by default, so this is usually fine.', evidence: etcd.path });
  }

  // ── kubelet ──────────────────────────────────────────────────────────────
  const k = cfg.kubelet?.config || {};
  if (cfg.kubelet) {
    const kp = '/var/lib/kubelet/config.yaml';
    if (k['readOnlyPort'] && k['readOnlyPort'] !== '0') {
      out.push({ id: 'kubelet:ro', status: 'warning', area: 'kubelet', title: `Kubelet read-only port ${k['readOnlyPort']} is open`, detail: 'Unauthenticated read access to pods and node info.', evidence: `${kp}  readOnlyPort` });
    }
    if (k['authentication.anonymous.enabled'] === 'true') {
      out.push({ id: 'kubelet:anon', status: 'warning', area: 'kubelet', title: 'Kubelet accepts anonymous requests', evidence: `${kp}  authentication.anonymous.enabled` });
    }
    if (k['authorization.mode'] === 'AlwaysAllow') {
      out.push({ id: 'kubelet:authz', status: 'critical', area: 'kubelet', title: 'Kubelet authorization is AlwaysAllow', detail: 'Anyone who can reach port 10250 can exec into pods.', evidence: `${kp}  authorization.mode` });
    }
    if (k['rotateCertificates'] === 'false') {
      out.push({ id: 'kubelet:rotate', status: 'warning', area: 'kubelet', title: 'Kubelet client certificate rotation is off', detail: 'The node drops out of the cluster when its client certificate expires.', evidence: `${kp}  rotateCertificates` });
    }
    const evictions = Object.entries(k).filter(([key]) => key.startsWith('evictionHard.')).map(([key, v]) => `${key.slice(13)}<${v}`);
    out.push({
      id: 'kubelet:limits', status: 'info', area: 'kubelet',
      title: `Kubelet: max ${k['maxPods'] || '110 (default)'} pods, cgroup driver ${k['cgroupDriver'] || 'cgroupfs (default)'}`,
      detail: `Pods are evicted when ${evictions.length ? evictions.join(', ') : 'memory.available<100Mi, nodefs.available<10%, imagefs.available<15% (defaults)'}.` +
        (k['systemReserved.memory'] || k['kubeReserved.memory'] ? ` Reserved: system ${k['systemReserved.memory'] || '—'}, kube ${k['kubeReserved.memory'] || '—'}.` : ' Nothing reserved for system/kube daemons.'),
      evidence: kp,
    });
  }

  // ── Recent changes ───────────────────────────────────────────────────────
  const nowSec = now / 1000;
  for (const m of cfg.manifests) {
    if (m.mtime && nowSec - m.mtime < 86_400) {
      const mins = Math.round((nowSec - m.mtime) / 60);
      out.push({ id: `changed:${m.path}`, status: mins < 60 ? 'warning' : 'info', area: 'changes',
        title: `${m.component} manifest changed ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`} ago`,
        detail: 'The kubelet restarts a static pod as soon as its manifest changes — a likely cause for anything that started then.', evidence: m.path });
    }
  }
  if (cfg.kubelet?.mtime && nowSec - cfg.kubelet.mtime < 86_400) {
    out.push({ id: 'changed:kubelet', status: 'info', area: 'changes', title: `Kubelet config changed ${Math.round((nowSec - cfg.kubelet.mtime) / 3600)} h ago`, evidence: '/var/lib/kubelet/config.yaml' });
  }

  // ── Clock ────────────────────────────────────────────────────────────────
  if (cfg.hostNow) {
    const skew = Math.round(cfg.hostNow - nowSec);
    if (Math.abs(skew) > 30) {
      out.push({ id: 'time:skew', status: Math.abs(skew) > 300 ? 'critical' : 'warning', area: 'time',
        title: `Clock is ${Math.abs(skew)} s ${skew > 0 ? 'ahead' : 'behind'} of Trinetra`,
        detail: 'Skew breaks TLS validity windows, etcd leader leases and log correlation.', hint: 'timedatectl status; chronyc tracking' });
    }
  }

  const rank: Record<CheckStatus, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status]);
}

// ---------------------------------------------------------------------------
// Across nodes
// ---------------------------------------------------------------------------

/** Flags that legitimately differ per node — comparing them would be noise. */
const PER_NODE_FLAG = /^(advertise-address|bind-address|listen-.*|initial-advertise-peer-urls|advertise-client-urls|name|initial-cluster|initial-cluster-state|etcd-servers|hostname-override|node-ip|kubeconfig|authentication-kubeconfig|authorization-kubeconfig)$/;

export interface DriftItem {
  component: string;
  /** A flag name, `image`, or `kubeconfig server`. */
  what: string;
  values: Record<string, string>;
}

/** Where control-plane nodes disagree: flags, image versions, API endpoints. */
export function findDrift(nodes: Record<string, NodeConfig>): DriftItem[] {
  const out: DriftItem[] = [];
  const cps = Object.entries(nodes).filter(([, c]) => c.role === 'control-plane');
  if (cps.length >= 2) {
    const components = new Set(cps.flatMap(([, c]) => c.manifests.map((m) => m.component)));
    for (const comp of components) {
      const per = cps.map(([h, c]) => [h, c.manifests.find((m) => m.component === comp)] as const).filter(([, m]) => !!m) as Array<readonly [string, ManifestInfo]>;
      if (per.length < 2) continue;
      const images = Object.fromEntries(per.map(([h, m]) => [h, m.version || m.image || '—']));
      if (new Set(Object.values(images)).size > 1) out.push({ component: comp, what: 'image', values: images });
      const names = new Set(per.flatMap(([, m]) => Object.keys(m.flags)));
      for (const n of [...names].sort()) {
        if (PER_NODE_FLAG.test(n)) continue;
        const values = Object.fromEntries(per.map(([h, m]) => [h, m.flags[n] ?? '(not set)']));
        if (new Set(Object.values(values)).size > 1) out.push({ component: comp, what: `--${n}`, values });
      }
    }
  }
  // Every node's kubelet should point at the same API endpoint (the VIP / LB).
  const servers = Object.fromEntries(Object.entries(nodes)
    .map(([h, c]) => [h, c.kubeconfigs.find((k) => /kubelet\.conf$|rke2\.yaml$|k3s\.yaml$/.test(k.path))?.server] as const)
    .filter(([, s]) => !!s) as Array<[string, string]>);
  if (new Set(Object.values(servers)).size > 1) out.push({ component: 'kubelet', what: 'kubeconfig server', values: servers });
  return out;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface NodeConfigResult {
  host: string;
  reachable: boolean;
  error?: string;
  at: string;
  config?: NodeConfig;
  checks: ConfigCheck[];
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, NodeConfigResult>();

/** The last scan of a host, if recent — used by the insight engine without new SSH. */
export function cachedNodeConfig(name: string, maxAgeMs = CACHE_MS): NodeConfigResult | undefined {
  const r = cache.get(name);
  return r && Date.now() - Date.parse(r.at) < maxAgeMs ? r : undefined;
}

export async function collectNodeConfig(vm: VmEntry): Promise<NodeConfigResult> {
  const at = new Date().toISOString();
  const { stdout, stderr, ok } = await sshRun(vm, NODECONFIG_CMD, 45_000, 1024 * 1024 * 4);
  if (!ok && !stdout.includes('===TRINETRA:')) {
    return { host: vm.name, reachable: false, error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 300), at, checks: [] };
  }
  const config = parseNodeConfig(stdout);
  const result: NodeConfigResult = { host: vm.name, reachable: true, at, config, checks: analyzeNodeConfig(config) };
  cache.set(vm.name, result);
  return result;
}

export const nodeConfigRouter = Router();

/**
 * GET /api/nodeconfig?vm=a,b   (default: every inventory VM)
 *   &fresh=1                   ignore the 5-minute cache
 */
nodeConfigRouter.get('/api/nodeconfig', async (req, res) => {
  const wanted = String(req.query.vm || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.some((n) => !SAFE_NAME.test(n))) return res.status(400).json({ error: 'Invalid VM name.' });
  const fresh = req.query.fresh === '1';
  const all = await loadVms();
  const vms = all.filter((v) => !wanted.length || wanted.includes(v.name));
  if (!vms.length) {
    return res.json({
      hosts: [], drift: [], at: new Date().toISOString(),
      note: all.length ? `${wanted.join(', ')} is not in the inventory.` : 'No VMs in the inventory — add the cluster nodes on the K8s Nodes tab.',
    });
  }

  // Three at a time: a ten-node cluster should not open ten SSH sessions at once.
  const results: NodeConfigResult[] = new Array(vms.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, vms.length) }, async () => {
    while (next < vms.length) {
      const i = next++;
      const vm = vms[i];
      results[i] = (!fresh && cachedNodeConfig(vm.name)) || await collectNodeConfig(vm).catch((e) => ({
        host: vm.name, reachable: false, error: String(e?.message || e), at: new Date().toISOString(), checks: [],
      }));
    }
  }));

  const configs: Record<string, NodeConfig> = {};
  for (const r of results) if (r.config && r.config.distro !== 'none') configs[r.host] = r.config;
  res.json({ hosts: results, drift: findDrift(configs), at: new Date().toISOString() });
});
