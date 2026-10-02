// Whole-host overview for the Host Logs page: parsers for one SSH round-trip of
// system facts, a health checklist derived from them, and the rules that link a
// log finding back to the systemd unit that produced it (so the UI can offer a
// restart). Pure — the router does the SSH.

export type HealthStatus = 'ok' | 'warning' | 'critical' | 'info';

export interface HealthCheck {
  id: string;
  status: HealthStatus;
  title: string;
  detail: string;
  unit?: string;          // a service the user can act on from this check
}

export interface Filesystem {
  source: string; type: string; mount: string;
  size: number; used: number; avail: number; usePct: number;
  inodesPct?: number;
}

export interface ServiceUnit {
  unit: string;           // kubelet.service
  load: string;           // loaded | not-found | masked
  active: string;         // active | inactive | failed | activating
  sub: string;            // running | exited | dead | failed | auto-restart
  description: string;
  critical: boolean;      // the node is degraded if this one is down
  access: boolean;        // restarting it can drop SSH access to the host
}

export interface ProcessRow { pid: number; user: string; cpu: number; mem: number; rssKb: number; command: string }
export interface ListenPort { proto: string; address: string; port: string; process: string }

export interface SystemOverview {
  hostname: string; os: string; kernel: string; arch: string; virt: string;
  uptime: string; bootedAt: string; uptimeSec: number;
  cpus: number; load: [number, number, number];
  memory: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  filesystems: Filesystem[];
  services: ServiceUnit[];
  topMemory: ProcessRow[];
  topCpu: ProcessRow[];
  ports: ListenPort[];
  timeSynced: boolean | null;
  timezone: string;
  journalDisk: string;
  reboots: string[];
  runsAsRoot: boolean;
  health: HealthCheck[];
}

// Units whose failure takes the node (or access to it) down. A failed one is
// critical, and restarting one gets an extra warning in the UI.
export const CRITICAL_UNITS = new Set([
  'kubelet', 'containerd', 'docker', 'crio', 'cri-docker', 'rke2-server', 'rke2-agent', 'k3s', 'k3s-agent', 'etcd',
  'sshd', 'ssh', 'systemd-networkd', 'NetworkManager', 'networking', 'systemd-resolved', 'chronyd', 'chrony', 'ntpd',
  'nvidia-persistenced', 'nvidia-fabricmanager', 'multipathd', 'iscsid',
]);

// Restarting these can cut the SSH session Kalam itself is using.
export const ACCESS_UNITS = new Set(['sshd', 'ssh', 'systemd-networkd', 'NetworkManager', 'networking', 'firewalld', 'iptables', 'nftables']);

const UNIT_RE = /^[A-Za-z0-9@_.:\\-]{1,200}$/;

// Normalize and validate a unit name from the browser. Only services.
export function safeServiceUnit(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const name = u.trim().endsWith('.service') ? u.trim() : `${u.trim()}.service`;
  if (!UNIT_RE.test(name) || name.startsWith('-') || name === '.service') return null;
  return name;
}

export const baseName = (unit: string) => unit.replace(/\.service$/, '');

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// `KEY=value` lines (the SELF block and `timedatectl show`).
export function parseKv(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

// `free -b`
export function parseFree(lines: string[]): SystemOverview['memory'] {
  const mem = { total: 0, used: 0, available: 0, swapTotal: 0, swapUsed: 0 };
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (/^Mem:/i.test(p[0])) {
      mem.total = num(p[1]);
      mem.used = num(p[2]);
      // Older procps has no "available" column; free+buff/cache approximates it.
      mem.available = p.length >= 7 ? num(p[6]) : num(p[3]) + num(p[5]);
    } else if (/^Swap:/i.test(p[0])) {
      mem.swapTotal = num(p[1]);
      mem.swapUsed = num(p[2]);
    }
  }
  return mem;
}

// `df -PT -B1` and `df -Pi` (inode %, keyed by mount point).
export function parseDf(lines: string[], inodeLines: string[] = []): Filesystem[] {
  const inodes = new Map<string, number>();
  for (const l of inodeLines) {
    const p = l.trim().split(/\s+/);
    if (p.length >= 6 && /%$/.test(p[4])) inodes.set(p.slice(5).join(' '), num(p[4].replace('%', '')));
  }
  const out: Filesystem[] = [];
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p.length < 7 || !/%$/.test(p[5])) continue;
    const mount = p.slice(6).join(' ');
    out.push({
      source: p[0], type: p[1], mount,
      size: num(p[2]), used: num(p[3]), avail: num(p[4]),
      usePct: num(p[5].replace('%', '')),
      inodesPct: inodes.get(mount),
    });
  }
  return out;
}

// `systemctl list-units --type=service --all --no-legend --plain`
export function parseUnits(lines: string[]): ServiceUnit[] {
  const out: ServiceUnit[] = [];
  for (const raw of lines) {
    // Some systemd versions prefix failed rows with "●" even with --plain.
    const l = raw.replace(/^[●*×\s]+/, '');
    const p = l.split(/\s+/);
    if (p.length < 4 || !p[0].endsWith('.service')) continue;
    out.push({
      unit: p[0], load: p[1], active: p[2], sub: p[3],
      description: p.slice(4).join(' '),
      critical: CRITICAL_UNITS.has(baseName(p[0])),
      access: ACCESS_UNITS.has(baseName(p[0])),
    });
  }
  return out;
}

// `ps -eo pid,user,pcpu,pmem,rss,comm --no-headers`
export function parsePs(lines: string[]): ProcessRow[] {
  return lines
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 6 && /^\d+$/.test(p[0]))
    .map((p) => ({ pid: num(p[0]), user: p[1], cpu: num(p[2]), mem: num(p[3]), rssKb: num(p[4]), command: p.slice(5).join(' ') }));
}

// `ss -tulnpH` — Netid State Recv-Q Send-Q Local:Port Peer:Port Process
export function parseSs(lines: string[]): ListenPort[] {
  const out: ListenPort[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p.length < 5) continue;
    const local = p[4];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = local.slice(idx + 1);
    const address = local.slice(0, idx);
    const process = (l.match(/users:\(\("([^"]+)"/) || [])[1] || '';
    const key = `${p[0]}|${port}|${process}`;
    if (seen.has(key)) continue; // same socket on IPv4 and IPv6
    seen.add(key);
    out.push({ proto: p[0], address, port, process });
  }
  return out.sort((a, b) => num(a.port) - num(b.port));
}

const GB = 1024 ** 3;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

// The checklist shown at the top of the page: every resource and service
// signal reduced to ok / warning / critical with a one-line reason.
export function buildHealth(o: Omit<SystemOverview, 'health'>): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck) => checks.push(c);

  // Disks — pseudo and read-only image mounts (snaps, ISOs) are always 100%.
  const realFs = o.filesystems.filter((f) => f.size > 0 && !/^\/(snap|media\/cdrom)/.test(f.mount) && !/iso9660|squashfs/.test(f.type));
  const fullest = [...realFs].sort((a, b) => b.usePct - a.usePct);
  const hot = fullest.filter((f) => f.usePct >= 80);
  if (!realFs.length) add({ id: 'disk', status: 'info', title: 'Disk usage', detail: 'No filesystem data returned.' });
  else if (!hot.length) add({ id: 'disk', status: 'ok', title: 'Disk usage', detail: `Fullest is ${fullest[0].mount} at ${fullest[0].usePct}%.` });
  else for (const f of hot) {
    add({
      id: `disk:${f.mount}`, status: f.usePct >= 90 ? 'critical' : 'warning', title: `Disk ${f.mount} ${f.usePct}% full`,
      detail: `${(f.avail / GB).toFixed(1)} GB free of ${(f.size / GB).toFixed(1)} GB. Above ~85% kubelet starts image GC and evictions (DiskPressure).`,
    });
  }
  for (const f of realFs.filter((x) => (x.inodesPct ?? 0) >= 80)) {
    add({ id: `inode:${f.mount}`, status: (f.inodesPct ?? 0) >= 90 ? 'critical' : 'warning', title: `Inodes on ${f.mount} ${f.inodesPct}% used`, detail: 'Running out of inodes fails writes even with free space — usually millions of small files (container layers, mail queues, sessions).' });
  }

  // Memory
  const m = o.memory;
  if (m.total > 0) {
    const availPct = pct(m.available, m.total);
    add({
      id: 'memory', status: availPct < 10 ? 'critical' : availPct < 20 ? 'warning' : 'ok',
      title: `Memory ${100 - availPct}% in use`,
      detail: `${(m.available / GB).toFixed(1)} GB available of ${(m.total / GB).toFixed(1)} GB.${availPct < 20 ? ' Low available memory precedes OOM kills.' : ''}`,
    });
    if (m.swapTotal > 0 && pct(m.swapUsed, m.swapTotal) >= 50) {
      add({ id: 'swap', status: 'warning', title: `Swap ${pct(m.swapUsed, m.swapTotal)}% used`, detail: 'Heavy swapping slows everything; Kubernetes nodes normally run with swap off.' });
    }
  }

  // CPU load
  if (o.cpus > 0) {
    const ratio = o.load[1] / o.cpus;
    add({
      id: 'load', status: ratio > 2 ? 'critical' : ratio > 1 ? 'warning' : 'ok',
      title: `Load ${o.load.map((x) => x.toFixed(2)).join(' / ')}`,
      detail: `${o.cpus} CPUs — 5-minute load is ${(ratio * 100).toFixed(0)}% of capacity.${ratio > 1 ? ' Processes are queueing; check top CPU consumers and I/O wait.' : ''}`,
    });
  }

  // Services
  const failed = o.services.filter((s) => s.active === 'failed');
  if (!o.services.length) {
    add({ id: 'services', status: 'info', title: 'Services', detail: 'systemd not available (or no permission to list units).' });
  } else if (!failed.length) {
    add({ id: 'services', status: 'ok', title: 'Services', detail: `${o.services.filter((s) => s.active === 'active').length} active, none failed.` });
  } else {
    for (const s of failed) {
      add({ id: `failed:${s.unit}`, status: s.critical ? 'critical' : 'warning', title: `${s.unit} failed`, detail: s.description || 'Service is in failed state.', unit: s.unit });
    }
  }
  // Core node services that exist but are not running.
  for (const s of o.services.filter((x) => x.critical && x.load === 'loaded' && x.active === 'inactive' && x.sub === 'dead')) {
    if (/sshd?$|networking|chrony|ntpd/.test(baseName(s.unit))) continue; // commonly socket-activated / alternates
    add({ id: `inactive:${s.unit}`, status: 'warning', title: `${s.unit} is not running`, detail: `${s.description || s.unit} is installed but inactive.`, unit: s.unit });
  }
  for (const s of o.services.filter((x) => x.sub === 'auto-restart' || x.active === 'activating')) {
    add({ id: `restarting:${s.unit}`, status: 'warning', title: `${s.unit} is restarting`, detail: 'The unit keeps exiting and systemd is restarting it — check its logs.', unit: s.unit });
  }

  // Time
  if (o.timeSynced === false) {
    add({ id: 'time', status: 'warning', title: 'Clock not synchronized', detail: 'NTP sync is off or failing. Clock skew breaks TLS, etcd and log correlation.' });
  } else if (o.timeSynced) {
    add({ id: 'time', status: 'ok', title: 'Clock synchronized', detail: o.timezone ? `Timezone ${o.timezone}.` : 'NTP in sync.' });
  }

  if (o.uptimeSec > 0 && o.uptimeSec < 3600) {
    add({ id: 'reboot', status: 'info', title: 'Recently rebooted', detail: `Up for ${o.uptime || `${Math.round(o.uptimeSec / 60)} minutes`}. Look for the cause in the previous boot's logs.` });
  }
  if (!o.runsAsRoot) {
    add({ id: 'root', status: 'info', title: 'Not running as root', detail: 'Some logs, process owners and all service restarts need root. Enable root access on the K8s Nodes page.' });
  }

  const rank: Record<HealthStatus, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  return checks.sort((a, b) => rank[a.status] - rank[b.status]);
}

// ---- finding → unit --------------------------------------------------------

// Which systemd units a log finding points at, given the host's unit list.
// Sources, strongest first: an explicit "foo.service" in the line, the syslog
// identifier ("host kubelet[900]:"), and systemd's "Failed to start <Description>".
export function unitsForLines(lines: string[], units: ServiceUnit[]): string[] {
  const byUnit = new Map(units.map((u) => [u.unit, u]));
  const byDesc = new Map(units.filter((u) => u.description).map((u) => [u.description.toLowerCase(), u.unit]));
  const found: string[] = [];
  const push = (u?: string) => { if (u && byUnit.has(u) && !found.includes(u)) found.push(u); };

  for (const line of lines) {
    for (const m of line.matchAll(/\b([A-Za-z0-9@_.:-]+\.service)\b/g)) push(m[1]);

    const ident = line.match(/^(?:\S+\s+\d+\s+[\d:]+|\d{4}-\d{2}-\d{2}T\S+)\s+\S+\s+([A-Za-z0-9@_.-]+)(?:\[\d+\])?:/);
    if (ident && !['kernel', 'systemd', 'sudo', 'su', 'CRON', 'cron'].includes(ident[1])) {
      const id = ident[1];
      push(`${id}.service`);
      if (id === 'sshd') push('ssh.service');
      if (id === 'dockerd') push('docker.service');
      if (id === 'chronyd') push('chrony.service');
    }

    const desc = line.match(/(?:Failed to start|Stopped|Started|Starting) (.+?)\.?$/);
    if (desc) push(byDesc.get(desc[1].trim().toLowerCase()));
  }
  return found;
}
