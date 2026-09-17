// Deterministic /var/log scanner.
//
// Pure functions only: the router fetches lines over SSH, this file decides what
// they mean. Every rule carries its own explanation and a list of read-only
// checks, so "Explain" works on an air-gapped box with no LLM configured. The
// checks are REPORTED to the user, never executed — same contract as
// diagnoseReason in server/vms.ts.

import path from 'path';

export type LogSeverity = 'critical' | 'warning' | 'info';

export interface LogRule {
  id: string;
  severity: LogSeverity;
  category: string;
  pattern: RegExp;
  title: string;
  explain: string;
  checks: string[];
}

export interface LogFinding {
  key: string;
  ruleId: string;
  severity: LogSeverity;
  category: string;
  title: string;
  explain: string;
  checks: string[];
  message: string;       // normalized message the group was keyed on
  count: number;
  files: string[];
  samples: string[];     // up to MAX_SAMPLES raw lines
  firstSeen?: string;
  lastSeen?: string;
}

// Order matters: the first matching rule wins, so specific rules sit above the
// generic error/warning fallbacks at the bottom.
export const LOG_RULES: LogRule[] = [
  {
    id: 'kernel-panic', severity: 'critical', category: 'Kernel',
    pattern: /kernel panic|\bBUG: |soft lockup|hard LOCKUP|hung_task|blocked for more than \d+ seconds|general protection fault|Call Trace:/i,
    title: 'Kernel panic, lockup or oops',
    explain: 'The kernel hit an unrecoverable or stalled state. Soft lockups and hung tasks usually mean a CPU was starved (heavy I/O wait, a stuck driver, or an overcommitted hypervisor); an oops/BUG is a driver or kernel bug.',
    checks: ['dmesg -T | grep -iE "lockup|hung_task|BUG|panic" | tail -50', 'uname -r', 'vmstat 1 5', 'journalctl -k -b -1 | tail -100'],
  },
  {
    id: 'oom', severity: 'critical', category: 'Memory',
    pattern: /Out of memory|oom-kill|oom_reaper|invoked oom-killer|Killed process \d+|Memory cgroup out of memory/i,
    title: 'Out-of-memory killer fired',
    explain: 'The kernel ran out of memory (host-wide or inside a cgroup/container limit) and killed a process. Repeated hits mean a memory leak, an undersized limit, or too many workloads on the node.',
    checks: ['dmesg -T | grep -iE "killed process|out of memory" | tail -20', 'free -m', 'ps aux --sort=-%mem | head -15', 'kubectl describe node $(hostname) | grep -A8 "Allocated resources"'],
  },
  {
    id: 'disk-full', severity: 'critical', category: 'Storage',
    pattern: /No space left on device|ENOSPC|disk quota exceeded|filesystem (is )?full|DiskPressure|evicting .* ephemeral-storage/i,
    title: 'Disk or inode space exhausted',
    explain: 'A filesystem ran out of blocks or inodes. Writes fail, logs stop, and kubelet starts evicting pods under DiskPressure. Common culprits: container images, /var/log growth, core dumps.',
    checks: ['df -h', 'df -i', 'du -xh /var --max-depth=2 2>/dev/null | sort -h | tail -20', 'crictl images | wc -l', 'journalctl --disk-usage'],
  },
  {
    id: 'fs-error', severity: 'critical', category: 'Storage',
    pattern: /EXT4-fs error|XFS .*(corrupt|error|shutdown)|Remounting filesystem read-only|read-only file system|btrfs.*(error|corrupt)|journal commit I\/O error/i,
    title: 'Filesystem error / read-only remount',
    explain: 'The filesystem detected corruption or an I/O failure and may have remounted itself read-only to protect data. Anything writing to it (databases, containerd, etcd) will fail.',
    checks: ['mount | grep "(ro,"', 'dmesg -T | grep -iE "ext4|xfs|remount" | tail -30', 'lsblk -f', 'smartctl -H /dev/sdX'],
  },
  {
    id: 'io-error', severity: 'critical', category: 'Storage',
    pattern: /blk_update_request: I\/O error|Buffer I\/O error|I\/O error, dev|medium error|SMART.*(fail|error)|ata\d+.*(failed command|exception)|nvme.*(timeout|reset|I\/O error)|end_request: I\/O error/i,
    title: 'Block device I/O errors',
    explain: 'The disk or its controller returned I/O errors or timeouts. This is typically failing hardware, a flaky cable/backplane, or a SAN/multipath path dropping.',
    checks: ['dmesg -T | grep -iE "i/o error|ata|nvme" | tail -30', 'smartctl -a /dev/sdX', 'multipath -ll 2>/dev/null', 'lsblk'],
  },
  {
    id: 'hardware-mce', severity: 'critical', category: 'Hardware',
    pattern: /Machine check|\bMCE\b|mce: \[Hardware Error\]|EDAC .*(error|CE|UE)|Hardware Error|PCIe Bus Error|AER:.*(error|Uncorrected)/i,
    title: 'Hardware error (MCE / EDAC / PCIe AER)',
    explain: 'The CPU, memory controller or PCIe bus reported a hardware fault. Corrected errors that keep climbing predict a DIMM or card failure; uncorrected errors usually crash workloads.',
    checks: ['dmesg -T | grep -iE "mce|edac|aer|hardware error" | tail -30', 'ras-mc-ctl --summary 2>/dev/null', 'ipmitool sel list 2>/dev/null | tail -20'],
  },
  {
    id: 'gpu-xid', severity: 'critical', category: 'GPU',
    pattern: /NVRM: Xid|GPU has fallen off the bus|nvidia.*(error|fail)|NVLink.*error|RmInitAdapter failed/i,
    title: 'NVIDIA GPU error (Xid)',
    explain: 'The NVIDIA driver logged an Xid event. Xid 13/31/43 are usually application faults; 48/63/64/74/79/92/94/95 point at ECC, NVLink or the GPU dropping off the bus and often need a reset or RMA.',
    checks: ['dmesg -T | grep -i xid | tail -20', 'nvidia-smi', 'nvidia-smi -q -d ECC,PAGE_RETIREMENT | head -60', 'kubectl describe node $(hostname) | grep -i nvidia.com/gpu'],
  },
  {
    id: 'segfault', severity: 'warning', category: 'Process',
    pattern: /segfault at|general protection|core dumped|traps: .* trap|dumped core|systemd-coredump/i,
    title: 'Process crashed (segfault / core dump)',
    explain: 'A process died on a memory access violation. One-off crashes are application bugs; the same binary crashing repeatedly after an upgrade suggests a bad library or incompatible build.',
    checks: ['coredumpctl list 2>/dev/null | tail -20', 'dmesg -T | grep -i segfault | tail -20'],
  },
  {
    id: 'systemd-failed', severity: 'warning', category: 'Services',
    pattern: /Failed to start|entered failed state|Main process exited, code=(exited|killed|dumped), status=[1-9]|Start request repeated too quickly|failed with result|Unit .* failed/i,
    title: 'systemd service failed',
    explain: 'A systemd unit failed to start or exited with an error and may be in a restart loop. Look at that unit’s own journal for the underlying reason (config error, missing dependency, port in use).',
    checks: ['systemctl --failed', 'systemctl status <unit> --no-pager -l', 'journalctl -u <unit> -n 100 --no-pager'],
  },
  {
    id: 'kubelet', severity: 'warning', category: 'Kubernetes',
    pattern: /(kubelet|containerd|rke2|k3s|dockerd|crio).*(error|failed|E\d{4} )|PLEG is not healthy|node not found|failed to (pull|create|sync) |CrashLoopBackOff|ImagePullBackOff|Container runtime network not ready/i,
    title: 'Kubelet / container runtime errors',
    explain: 'The node agent or container runtime reported errors. PLEG unhealthy and runtime-not-ready mean the node itself is sick; pull/sync failures are usually registry, CNI or volume problems for specific pods.',
    checks: ['systemctl status kubelet containerd --no-pager', 'journalctl -u kubelet -n 200 --no-pager | grep -E "E[0-9]{4}"', 'crictl ps -a | head -30', 'kubectl get node $(hostname) -o wide'],
  },
  {
    id: 'cert', severity: 'warning', category: 'Security',
    pattern: /certificate (has )?expired|x509: certificate|tls: (bad certificate|handshake failure)|SSL.*(verify|handshake) (failed|error)|certificate verify failed/i,
    title: 'TLS / certificate failure',
    explain: 'A TLS handshake failed because a certificate is expired, not yet valid, or not trusted. Expired kubelet/etcd/API server certs take whole nodes out; clock skew can cause the same symptom.',
    checks: ['kubeadm certs check-expiration 2>/dev/null', 'openssl x509 -noout -dates -in <cert.pem>', 'timedatectl'],
  },
  {
    id: 'auth-failure', severity: 'warning', category: 'Security',
    pattern: /Failed password for|Invalid user|authentication failure|Connection closed by authenticating user|maximum authentication attempts|pam_unix\(.*\): auth.*fail|BREAK-IN ATTEMPT|Did not receive identification string/i,
    title: 'SSH / PAM authentication failures',
    explain: 'Logins are failing. A handful is a mistyped password; hundreds from unfamiliar IPs or for users like root/admin/test is a brute-force attempt against an exposed SSH port.',
    checks: ['grep -E "Failed password|Invalid user" /var/log/auth.log /var/log/secure 2>/dev/null | awk \'{print $(NF-3)}\' | sort | uniq -c | sort -rn | head', 'lastb -n 20 2>/dev/null', 'last -n 20'],
  },
  {
    id: 'sudo', severity: 'warning', category: 'Security',
    pattern: /user NOT in sudoers|incorrect password attempts|sudo:.*(auth|command not allowed)/i,
    title: 'sudo denied',
    explain: 'Someone attempted privileged commands without permission or with the wrong password. Expected occasionally; unexpected users or repetition warrants a look.',
    checks: ['grep -i sudo /var/log/auth.log /var/log/secure 2>/dev/null | tail -30'],
  },
  {
    id: 'time-sync', severity: 'warning', category: 'Time',
    pattern: /clock (skew|step|unsynchron)|time jump|System clock wrong|chronyd.*(no|unreachable|can't synchronise)|ntpd.*(no servers|unreachable)|Time has been changed/i,
    title: 'Clock skew / NTP problems',
    explain: 'The system clock drifted or jumped, or no time source is reachable. etcd leader elections, TLS validation and log correlation all break when node clocks disagree.',
    checks: ['timedatectl', 'chronyc tracking 2>/dev/null || ntpq -p 2>/dev/null'],
  },
  {
    id: 'network', severity: 'warning', category: 'Network',
    pattern: /NIC Link is Down|link is not ready|Link is Down|carrier lost|bond.*(link status down|no active)|DHCP.*(fail|timeout)|nf_conntrack: table full|neighbour table overflow|Temporary failure in name resolution|dropping packet/i,
    title: 'Network link / connectivity problems',
    explain: 'A NIC or bond lost link, DHCP/DNS failed, or the kernel is dropping packets (conntrack/ARP tables full). Flapping links cause intermittent pod and storage timeouts.',
    checks: ['ip -br link', 'ethtool <iface> | grep -E "Speed|Link"', 'cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null', 'resolvectl status 2>/dev/null | head -20'],
  },
  {
    id: 'generic-critical', severity: 'critical', category: 'General',
    pattern: /\b(fatal|panic|emerg(ency)?|crit(ical)?)\b/i,
    title: 'Fatal / critical message',
    explain: 'A program logged at fatal or critical level. No specific rule matched, so read the sample lines and the surrounding context in the viewer.',
    checks: ['grep -n "<message>" <file> | tail'],
  },
  {
    id: 'generic-error', severity: 'warning', category: 'General',
    pattern: /\b(error|err|failed|failure|denied|refused|timed? ?out|exception|unable to)\b/i,
    title: 'Error message',
    explain: 'A generic error line that no specific rule recognises. Frequency matters: a steady stream from one component is worth investigating, a single occurrence usually is not.',
    checks: ['grep -n "<message>" <file> | tail'],
  },
  {
    id: 'generic-warning', severity: 'info', category: 'General',
    pattern: /\b(warn|warning|deprecated)\b/i,
    title: 'Warning message',
    explain: 'A warning-level line. Usually informational, but repeated warnings frequently precede the errors above.',
    checks: ['grep -n "<message>" <file> | tail'],
  },
];

const MAX_SAMPLES = 3;
const SEVERITY_RANK: Record<LogSeverity, number> = { critical: 0, warning: 1, info: 2 };

// Timestamps Kalam sees in /var/log: syslog ("Sep 17 10:02:03"), ISO-8601
// (journal short-iso, most apps) and dmesg -T ("[Wed Sep 17 10:02:03 2026]").
const TS_RES: RegExp[] = [
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
  /^[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}/,
  /^\[[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}\]/,
];

export function extractTimestamp(line: string): string | undefined {
  for (const re of TS_RES) {
    const m = line.match(re);
    if (m) return m[0].replace(/^\[|\]$/g, '');
  }
  return undefined;
}

// Collapse lines that differ only in volatile parts (time, host PID, addresses,
// counters) so 400 identical sshd failures become one finding with count 400.
export function normalizeMessage(line: string): string {
  let s = line;
  for (const re of TS_RES) s = s.replace(re, '');
  return s
    .replace(/^\s*\[\s*\d+\.\d+\]\s*/, '')                 // dmesg uptime stamp
    .replace(/^\s*\S+\s+(?=[\w.@/-]+(\[\d+\])?:)/, '')     // syslog hostname
    .replace(/\[\d+\]/g, '[N]')                             // pid
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function matchRule(line: string): LogRule | undefined {
  return LOG_RULES.find((r) => r.pattern.test(line));
}

// Scan a set of files' lines into grouped findings, most severe and most
// frequent first. `sources` maps a display name (path or "journal"/"dmesg") to
// its lines.
export function scanSources(sources: Array<{ file: string; lines: string[] }>): LogFinding[] {
  const groups = new Map<string, LogFinding>();
  for (const { file, lines } of sources) {
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line) continue;
      const rule = matchRule(line);
      if (!rule) continue;
      const message = normalizeMessage(line);
      const key = `${rule.id}|${message}`;
      const ts = extractTimestamp(line);
      let g = groups.get(key);
      if (!g) {
        g = {
          key, ruleId: rule.id, severity: rule.severity, category: rule.category,
          title: rule.title, explain: rule.explain, checks: rule.checks,
          message, count: 0, files: [], samples: [],
        };
        groups.set(key, g);
      }
      g.count++;
      if (!g.files.includes(file)) g.files.push(file);
      if (g.samples.length < MAX_SAMPLES) g.samples.push(line.slice(0, 500));
      else g.samples[MAX_SAMPLES - 1] = line.slice(0, 500); // keep the latest
      if (ts) {
        if (!g.firstSeen) g.firstSeen = ts;
        g.lastSeen = ts;
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count
  );
}

// Paths the API will read or bundle. Everything is confined to /var/log, and the
// charset excludes anything a shell would interpret even though callers quote.
const SAFE_PATH_RE = /^[A-Za-z0-9_.@:+/-]+$/;

export function safeLogPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 512) return null;
  if (!SAFE_PATH_RE.test(p)) return null;
  if (p.split('/').includes('..')) return null;
  const norm = path.posix.normalize(p);
  if (norm !== '/var/log' && !norm.startsWith('/var/log/')) return null;
  return norm;
}

export function isCompressed(p: string): boolean {
  return /\.(gz|xz|bz2|zst|lz4)$/.test(p);
}

// Files that are binary databases rather than text logs (wtmp, journal files,
// lastlog). Shown in the file list, never grepped or tailed as text.
export function isBinaryLog(p: string): boolean {
  return /\/(wtmp|btmp|lastlog|faillog|utmp)(\.\d+)?$/.test(p) || /\.journal~?$/.test(p) || /\/journal\//.test(p);
}
