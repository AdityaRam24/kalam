// Virtual Machine monitoring + SSH for Kalam.
//
// A manual SSH inventory (persisted to server/vms.json, git-ignored) plus live
// health probing. No hypervisor API and no extra npm deps: reachability is a raw
// TCP connect, metrics/commands shell out to the system `ssh` binary via
// execFile (arg-array form, so host/user/port are never shell-interpolated).
//
//   GET    /api/vms                 -> list inventory
//   POST   /api/vms                 -> add a VM  { name, host, user, port?, keyPath? }
//   DELETE /api/vms/:name           -> remove a VM
//   POST   /api/vms/metrics         -> { name } live load/cpu/mem/disk/uptime
//   POST   /api/vms/exec            -> { name, command } run a remote command
//   GET    /api/vms/ssh-command/:name -> the ssh command string (to copy/paste)

import { Router } from 'express';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

export const vmsRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VMS_PATH = path.join(__dirname, 'vms.json');

const NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const HOST_RE = /^[a-zA-Z0-9_.:-]+$/; // hostname or IPv4/IPv6-ish

export interface VmEntry {
  name: string;
  host: string;
  user: string;
  port: number;
  keyPath?: string;
  via?: string; // name of another inventory VM to use as an SSH jump host
}

async function loadVms(): Promise<VmEntry[]> {
  try {
    return JSON.parse(await fs.readFile(VMS_PATH, 'utf-8')) as VmEntry[];
  } catch {
    return [];
  }
}

async function saveVms(vms: VmEntry[]): Promise<void> {
  await fs.writeFile(VMS_PATH, JSON.stringify(vms, null, 2), 'utf-8');
}

// Fast liveness check: can we open a TCP socket to the SSH port?
function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function sshBaseArgs(vm: VmEntry, interactive = false, jump?: VmEntry): string[] {
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-p', String(vm.port)];
  if (!interactive) args.unshift('-o', 'BatchMode=yes'); // never hang on a password prompt for probes
  if (vm.keyPath) args.push('-i', vm.keyPath);
  if (jump) {
    // Hop through the jump VM (e.g. reach a VME host only visible from the DSC
    // VM). ProxyCommand instead of -J so the jump hop can use its own key/port.
    const proxy = ['ssh', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-p', String(jump.port)];
    if (jump.keyPath) proxy.push('-i', jump.keyPath);
    proxy.push('-W', '%h:%p', `${jump.user}@${jump.host}`);
    args.push('-o', `ProxyCommand=${proxy.join(' ')}`);
  }
  args.push(`${vm.user}@${vm.host}`);
  return args;
}

async function getJump(vm: VmEntry): Promise<VmEntry | undefined> {
  if (!vm.via) return undefined;
  return (await loadVms()).find((v) => v.name === vm.via && v.name !== vm.name);
}

// Run a remote command over ssh (hopping through vm.via if set).
// Resolves with combined result — never rejects.
async function sshRun(vm: VmEntry, command: string, timeoutMs = 20000): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const jump = await getJump(vm);
  return new Promise((resolve) => {
    execFile('ssh', [...sshBaseArgs(vm, false, jump), command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || (err ? err.message : ''), ok: !err });
    });
  });
}

// A jumped VM can't be TCP-probed from here — treat "jump host reachable" as
// the liveness signal instead.
async function vmReachable(vm: VmEntry): Promise<boolean> {
  if (vm.via) {
    const jump = await getJump(vm);
    return jump ? tcpReachable(jump.host, jump.port) : false;
  }
  return tcpReachable(vm.host, vm.port);
}

// One shell snippet returning parseable KEY:value lines.
const METRIC_CMD =
  "echo HOST:$(hostname); " +
  "echo LOAD:$(cat /proc/loadavg 2>/dev/null | awk '{print $1}'); " +
  "echo NCPU:$(nproc 2>/dev/null); " +
  "echo MEM:$(free -m 2>/dev/null | awk 'NR==2{print $3\"/\"$2\" MB\"}'); " +
  "echo DISK:$(df -h / 2>/dev/null | awk 'NR==2{print $5\" (\"$3\"/\"$2\")\"}'); " +
  "echo GPU:$(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | paste -sd, - || echo none); " +
  "echo UP:$(uptime -p 2>/dev/null)";

vmsRouter.get('/api/vms', async (_req, res) => {
  res.json({ vms: await loadVms() });
});

vmsRouter.post('/api/vms', async (req, res) => {
  const { name, host, user, port = 22, keyPath, via } = req.body || {};
  if (!name || !NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid VM name (letters, numbers, . _ - only).' });
  if (!host || !HOST_RE.test(host)) return res.status(400).json({ error: 'Invalid host/IP.' });
  if (!user || !NAME_RE.test(user)) return res.status(400).json({ error: 'Invalid SSH user.' });
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) return res.status(400).json({ error: 'Invalid port.' });

  const vms = await loadVms();
  if (vms.some((v) => v.name === name)) return res.status(409).json({ error: `A VM named "${name}" already exists.` });
  if (via && !vms.some((v) => v.name === via)) return res.status(400).json({ error: `Jump host "${via}" is not in the inventory.` });
  const entry: VmEntry = { name, host, user, port: p };
  if (keyPath && typeof keyPath === 'string') entry.keyPath = keyPath.trim();
  if (via && typeof via === 'string') entry.via = via;
  vms.push(entry);
  await saveVms(vms);
  res.json({ ok: true, vm: entry });
});

vmsRouter.delete('/api/vms/:name', async (req, res) => {
  const { name } = req.params;
  const vms = await loadVms();
  const next = vms.filter((v) => v.name !== name);
  if (next.length === vms.length) return res.status(404).json({ error: 'VM not found.' });
  await saveVms(next);
  res.json({ ok: true });
});

vmsRouter.post('/api/vms/metrics', async (req, res) => {
  const { name } = req.body || {};
  const vm = (await loadVms()).find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });

  const reachable = await vmReachable(vm);
  const out: any = { name: vm.name, host: vm.host, port: vm.port, reachable, via: vm.via };
  if (!reachable) {
    out.error = vm.via ? `Jump host "${vm.via}" unreachable` : 'SSH port unreachable';
    return res.json(out);
  }
  const { stdout, stderr, ok } = await sshRun(vm, METRIC_CMD);
  if (!ok && !stdout.trim()) {
    out.error = (stderr.split('\n')[0] || 'SSH command failed').slice(0, 200);
    return res.json(out);
  }
  for (const line of stdout.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  res.json(out);
});

vmsRouter.post('/api/vms/exec', async (req, res) => {
  const { name, command } = req.body || {};
  if (!command || !String(command).trim()) return res.status(400).json({ error: 'A command is required.' });
  const vm = (await loadVms()).find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });

  const { stdout, stderr, ok } = await sshRun(vm, String(command), 30000);
  res.json({ ok, output: stdout, error: stderr });
});

vmsRouter.get('/api/vms/ssh-command/:name', async (req, res) => {
  const vm = (await loadVms()).find((v) => v.name === req.params.name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const jump = await getJump(vm);
  const args = sshBaseArgs(vm, true, jump).map((a) => (a.startsWith('ProxyCommand=') ? `"${a}"` : a));
  res.json({ command: ['ssh', ...args].join(' ') });
});

// ---------------------------------------------------------------------------
// Peer VM discovery: from a connected VM, find other hosts it can see (K8s
// cluster nodes, /etc/hosts entries, ARP neighbors) so they can be added to
// the inventory — using this VM as the SSH jump host when needed.
// ---------------------------------------------------------------------------
const NEIGHBOR_CMD = [
  'echo @@SELF@@',
  "(hostname; hostname -I 2>/dev/null || true)",
  'echo @@KNODES@@',
  "(kubectl get nodes -o wide --no-headers 2>/dev/null || true)",
  'echo @@HOSTS@@',
  "(grep -vE '^\\s*(#|$)' /etc/hosts 2>/dev/null | grep -vE '(^127\\.|^::1|^255\\.|^ff0|localhost)' || true)",
  'echo @@NEIGH@@',
  "(ip neigh show 2>/dev/null | grep -vE '(FAILED|INCOMPLETE)' || arp -an 2>/dev/null || true)",
  'echo @@END@@',
].join('; ');

vmsRouter.post('/api/vms/neighbors', async (req, res) => {
  const { name } = req.body || {};
  const vms = await loadVms();
  const vm = vms.find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  if (!(await vmReachable(vm))) return res.json({ reachable: false, error: 'SSH unreachable' });

  const { stdout, stderr, ok } = await sshRun(vm, NEIGHBOR_CMD, 30000);
  if (!ok && !stdout.trim()) {
    return res.json({ reachable: true, error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 200) });
  }

  const ownIps = new Set(section(stdout, 'SELF').split(/\s+/).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s)));
  const known = new Set(vms.map((v) => v.host));
  const found = new Map<string, { ip: string; hostname?: string; source: string }>();
  const add = (ip: string, hostname: string | undefined, source: string) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ownIps.has(ip) || known.has(ip)) return;
    const prev = found.get(ip);
    // Prefer entries that come with a hostname (K8s nodes / hosts file).
    if (!prev || (!prev.hostname && hostname)) found.set(ip, { ip, hostname, source });
  };

  // Kubernetes cluster nodes: NAME STATUS ROLES AGE VERSION INTERNAL-IP ...
  for (const line of section(stdout, 'KNODES').split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length >= 6 && /^\d+\.\d+\.\d+\.\d+$/.test(c[5])) add(c[5], c[0], 'k8s-node');
  }
  // /etc/hosts: IP hostname [aliases...]
  for (const line of section(stdout, 'HOSTS').split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length >= 2) add(c[0], c[1], 'hosts-file');
  }
  // ARP / ip neigh: "10.0.0.7 dev eth0 lladdr ... REACHABLE" or "? (10.0.0.7) at ..."
  for (const line of section(stdout, 'NEIGH').split('\n')) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (m) add(m[1], undefined, 'arp');
  }

  res.json({ reachable: true, via: vm.name, neighbors: Array.from(found.values()) });
});

// ---------------------------------------------------------------------------
// Read-only Kubernetes diagnosis over SSH.
//
// POST /api/vms/diagnose { name } — SSH into the VM and run ONLY inspection
// commands (kubectl get / describe / logs / events). It finds unhealthy nodes
// and pods, pulls their logs and events, matches them against known failure
// patterns, and reports the likely cause plus suggested fix commands.
// IT NEVER EXECUTES A FIX: every suggestion is returned as text for a human.
// ---------------------------------------------------------------------------

// Phase 1: one SSH round trip gathering cluster state (all read-only).
const DIAG_CMD = [
  'echo @@KVER@@',
  '(kubectl version --client=true 2>/dev/null | head -1 || true)',
  'echo @@NODES@@',
  '(kubectl get nodes -o json 2>/dev/null || true)',
  'echo @@PODS@@',
  '(kubectl get pods -A -o json 2>/dev/null || true)',
  'echo @@EVENTS@@',
  "(kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp 2>/dev/null | tail -25 || true)",
  'echo @@END@@',
].join('; ');

interface Finding {
  severity: 'critical' | 'warning' | 'info';
  kind: string;            // Pod | Node
  namespace?: string;
  name: string;
  reason: string;          // CrashLoopBackOff, OOMKilled, ...
  detail: string;          // human explanation of the likely cause
  logExcerpt?: string;     // tail of the failing container's logs
  events?: string;         // relevant describe/event lines
  suggestedFixes: string[]; // commands/actions to REPORT ONLY — never run
}

// Known failure patterns → likely cause + suggested (not executed) fixes.
export function diagnoseReason(reason: string, extra: { exitCode?: number; restarts?: number } = {}): { detail: string; fixes: string[]; severity: Finding['severity'] } {
  switch (reason) {
    case 'CrashLoopBackOff':
      return {
        severity: 'critical',
        detail: `Container keeps crashing after start (${extra.restarts ?? '?'} restarts). Usually a bad config/env var, a failing dependency (DB, service), or the process exiting on error. Check the log excerpt below for the actual error.`,
        fixes: [
          'Fix the root error shown in the logs (config/env/dependency), then: kubectl rollout restart deployment/<name> -n <ns>',
          'If config changed recently: kubectl rollout undo deployment/<name> -n <ns>',
        ],
      };
    case 'OOMKilled':
      return {
        severity: 'critical',
        detail: `Container was killed by the kernel for exceeding its memory limit${extra.exitCode === 137 ? ' (exit code 137)' : ''}. The workload needs more memory than its limit allows, or it has a memory leak.`,
        fixes: [
          'Raise the memory limit: kubectl set resources deployment/<name> -n <ns> --limits=memory=<bigger, e.g. 2Gi>',
          'Or investigate a leak: compare "kubectl top pod" over time against the limit.',
        ],
      };
    case 'ImagePullBackOff':
    case 'ErrImagePull':
      return {
        severity: 'critical',
        detail: 'Kubernetes cannot pull the container image. Either the image name/tag is wrong, the registry needs credentials (imagePullSecret), or the node has no network path to the registry.',
        fixes: [
          'Verify the image exists: docker pull <image> (or check the registry UI).',
          'If private registry: kubectl create secret docker-registry regcred ... and reference it in imagePullSecrets.',
          'Fix a typo in the tag: kubectl set image deployment/<name> <container>=<correct-image> -n <ns>',
        ],
      };
    case 'CreateContainerConfigError':
      return {
        severity: 'critical',
        detail: 'The container references a ConfigMap or Secret that does not exist (or a missing key in one).',
        fixes: ['Check the describe/events output for the missing name, then create it: kubectl create configmap/secret <name> -n <ns> ...'],
      };
    case 'Pending':
      return {
        severity: 'warning',
        detail: 'Pod cannot be scheduled. Common causes: not enough CPU/memory/GPU on any node, node selector/taint mismatch, or an unbound PersistentVolumeClaim.',
        fixes: [
          'See the exact reason in the events (FailedScheduling line).',
          'If resources: lower requests, or add capacity. If PVC: check kubectl get pvc -n <ns>. If taints: add a toleration or remove the taint.',
        ],
      };
    case 'Evicted':
      return {
        severity: 'warning',
        detail: 'Pod was evicted, typically because the node ran out of disk or memory (node pressure).',
        fixes: ['Free disk on the node (old images: crictl rmi --prune / docker system prune), then delete the evicted pod record: kubectl delete pod <name> -n <ns>'],
      };
    case 'NotReady':
      return {
        severity: 'critical',
        detail: 'Node is NotReady — kubelet is not reporting healthy. Causes: kubelet/containerd down, disk pressure, network partition.',
        fixes: [
          'On the node: systemctl status kubelet && journalctl -u kubelet -n 50',
          'Check pressure conditions in the node describe output (DiskPressure/MemoryPressure).',
        ],
      };
    default:
      return {
        severity: 'warning',
        detail: `Container/pod is unhealthy (reason: ${reason || 'unknown'}). See logs and events below.`,
        fixes: ['Inspect: kubectl describe pod <name> -n <ns> and kubectl logs <name> -n <ns> --previous'],
      };
  }
}

function shq(s: string): string {
  // Values come from the cluster's own JSON but quote them anyway.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

vmsRouter.post('/api/vms/diagnose', async (req, res) => {
  const { name } = req.body || {};
  const vm = (await loadVms()).find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });

  if (!(await vmReachable(vm))) {
    return res.json({ reachable: false, error: vm.via ? `Jump host "${vm.via}" unreachable` : 'SSH port unreachable' });
  }

  const { stdout, stderr, ok } = await sshRun(vm, DIAG_CMD, 45000);
  if (!ok && !stdout.trim()) {
    return res.json({ reachable: true, error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 200) });
  }

  const kubectlAvailable = section(stdout, 'KVER').length > 0 || section(stdout, 'PODS').startsWith('{');
  if (!kubectlAvailable) {
    return res.json({ reachable: true, kubectlAvailable: false, error: 'kubectl is not available (or not configured) on this host.' });
  }

  const findings: Finding[] = [];

  // ---- Nodes -------------------------------------------------------------
  try {
    const nraw = section(stdout, 'NODES');
    if (nraw.startsWith('{')) {
      for (const n of JSON.parse(nraw).items || []) {
        const conds = n.status?.conditions || [];
        const ready = conds.find((c: any) => c.type === 'Ready');
        if (ready && ready.status !== 'True') {
          const d = diagnoseReason('NotReady');
          findings.push({ severity: d.severity, kind: 'Node', name: n.metadata?.name || '?', reason: 'NotReady', detail: d.detail, events: ready.message || '', suggestedFixes: d.fixes });
        }
        for (const c of conds) {
          if (['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(c.type) && c.status === 'True') {
            findings.push({
              severity: 'warning', kind: 'Node', name: n.metadata?.name || '?', reason: c.type,
              detail: `Node reports ${c.type}: ${c.message || ''}`.trim(),
              suggestedFixes: [c.type === 'DiskPressure' ? 'Free disk space on the node (prune unused images/logs).' : 'Reduce workload on this node or add capacity.'],
            });
          }
        }
      }
    }
  } catch { /* ignore node parse errors */ }

  // ---- Pods --------------------------------------------------------------
  interface ProblemPod { ns: string; pod: string; container?: string; reason: string; restarts: number; exitCode?: number; }
  const problems: ProblemPod[] = [];
  try {
    const praw = section(stdout, 'PODS');
    if (praw.startsWith('{')) {
      for (const p of JSON.parse(praw).items || []) {
        const ns = p.metadata?.namespace || 'default';
        const pod = p.metadata?.name || '?';
        const phase = p.status?.phase || 'Unknown';
        if (phase === 'Succeeded') continue; // completed jobs are fine
        const statuses = [...(p.status?.containerStatuses || []), ...(p.status?.initContainerStatuses || [])];
        let flagged = false;
        for (const cs of statuses) {
          const waiting = cs.state?.waiting?.reason;
          const lastTerm = cs.lastState?.terminated;
          if (waiting && !['ContainerCreating', 'PodInitializing'].includes(waiting)) {
            problems.push({ ns, pod, container: cs.name, reason: waiting, restarts: cs.restartCount || 0, exitCode: lastTerm?.exitCode });
            flagged = true;
          } else if (lastTerm?.reason === 'OOMKilled' || lastTerm?.exitCode === 137) {
            problems.push({ ns, pod, container: cs.name, reason: 'OOMKilled', restarts: cs.restartCount || 0, exitCode: lastTerm?.exitCode });
            flagged = true;
          } else if ((cs.restartCount || 0) >= 5 && !cs.ready) {
            problems.push({ ns, pod, container: cs.name, reason: 'CrashLoopBackOff', restarts: cs.restartCount });
            flagged = true;
          }
        }
        if (!flagged && (phase === 'Pending' || phase === 'Failed')) {
          problems.push({ ns, pod, reason: p.status?.reason === 'Evicted' ? 'Evicted' : phase === 'Pending' ? 'Pending' : (p.status?.reason || 'Failed'), restarts: 0 });
        }
      }
    }
  } catch { /* ignore pod parse errors */ }

  // ---- Phase 2: pull evidence (describe events + logs) for up to 5 pods --
  const evidenceTargets = problems.slice(0, 5);
  if (evidenceTargets.length) {
    const cmd = evidenceTargets.map((t, i) => {
      const base = `kubectl -n ${shq(t.ns)}`;
      const logs = t.reason === 'Pending' || t.reason === 'Evicted'
        ? 'true' // no logs for unscheduled/evicted pods
        : `(${base} logs ${shq(t.pod)}${t.container ? ` -c ${shq(t.container)}` : ''} --tail=40 2>/dev/null || ${base} logs ${shq(t.pod)}${t.container ? ` -c ${shq(t.container)}` : ''} --previous --tail=40 2>/dev/null || true)`;
      return `echo @@EV${i}@@; (${base} describe pod ${shq(t.pod)} 2>/dev/null | sed -n '/^Events:/,$p' | tail -15 || true); echo @@LOG${i}@@; ${logs}`;
    }).join('; ') + '; echo @@END@@';

    const ev = await sshRun(vm, cmd, 60000);
    evidenceTargets.forEach((t, i) => {
      const d = diagnoseReason(t.reason, { restarts: t.restarts, exitCode: t.exitCode });
      findings.push({
        severity: d.severity, kind: 'Pod', namespace: t.ns, name: t.pod + (t.container ? ` / ${t.container}` : ''),
        reason: t.reason, detail: d.detail,
        events: section(ev.stdout, `EV${i}`).slice(0, 2000) || undefined,
        logExcerpt: section(ev.stdout, `LOG${i}`).slice(0, 3000) || undefined,
        suggestedFixes: d.fixes,
      });
    });
  }
  // Any problems beyond the evidence limit still get a finding (without logs).
  for (const t of problems.slice(5)) {
    const d = diagnoseReason(t.reason, { restarts: t.restarts, exitCode: t.exitCode });
    findings.push({ severity: d.severity, kind: 'Pod', namespace: t.ns, name: t.pod, reason: t.reason, detail: d.detail, suggestedFixes: d.fixes });
  }

  const critical = findings.filter((f) => f.severity === 'critical').length;
  res.json({
    reachable: true,
    kubectlAvailable: true,
    reportOnly: true, // this endpoint never mutates anything
    summary: findings.length === 0
      ? 'No problems detected: all nodes Ready and all pods healthy.'
      : `${findings.length} issue(s) found (${critical} critical). Suggested fixes are reported only — nothing was executed.`,
    findings,
    warningEvents: section(stdout, 'EVENTS') || undefined,
  });
});

// Discover the container/pod workloads actually running ON a VM, over SSH.
// Probes Docker, Kubernetes (kubectl), and containerd (crictl) — whichever the
// host has — in a single SSH round trip using section delimiters.
const DISCOVER_CMD = [
  "echo @@ENGINES@@",
  "for b in docker kubectl crictl nerdctl podman; do command -v $b >/dev/null 2>&1 && echo $b; done",
  "echo @@DOCKER@@",
  "(docker ps -a --format '{{json .}}' 2>/dev/null || true)",
  "echo @@KPODS@@",
  "(kubectl get pods -A -o json 2>/dev/null || true)",
  "echo @@KSVCS@@",
  "(kubectl get svc -A -o json 2>/dev/null || true)",
  "echo @@CRICTL@@",
  "(sudo -n crictl ps -o json 2>/dev/null || crictl ps -o json 2>/dev/null || true)",
  "echo @@SYSTEMD@@",
  "(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | head -50 || true)",
  "echo @@PORTS@@",
  "(ss -tulnp 2>/dev/null | tail -n +2 | head -50 || netstat -tulnp 2>/dev/null | tail -n +3 | head -50 || true)",
  "echo @@END@@",
].join('; ');

export function section(text: string, tag: string): string {
  const start = text.indexOf(`@@${tag}@@`);
  if (start < 0) return '';
  const from = start + tag.length + 4;
  const nextIdx = text.indexOf('@@', from);
  return text.slice(from, nextIdx < 0 ? undefined : nextIdx).trim();
}

vmsRouter.post('/api/vms/discover', async (req, res) => {
  const { name } = req.body || {};
  const vm = (await loadVms()).find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });

  if (!(await vmReachable(vm))) {
    return res.status(200).json({ reachable: false, error: vm.via ? `Jump host "${vm.via}" unreachable` : 'SSH port unreachable' });
  }

  const { stdout, stderr, ok } = await sshRun(vm, DISCOVER_CMD, 30000);
  if (!ok && !stdout.trim()) {
    return res.status(200).json({ reachable: true, error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 200) });
  }

  const engines = section(stdout, 'ENGINES').split('\n').map((s) => s.trim()).filter(Boolean);

  // Docker containers (one JSON object per line).
  const containers: any[] = [];
  for (const line of section(stdout, 'DOCKER').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const p = JSON.parse(t);
      containers.push({
        id: p.ID, name: p.Names, image: p.Image, status: p.Status,
        state: p.State || (String(p.Status || '').toLowerCase().includes('up') ? 'running' : 'exited'),
        ports: p.Ports || '',
      });
    } catch { /* skip bad line */ }
  }

  // Kubernetes pods (kubectl -o json).
  const pods: any[] = [];
  try {
    const kraw = section(stdout, 'KPODS');
    if (kraw.startsWith('{')) {
      for (const it of JSON.parse(kraw).items || []) {
        const cs = it.status?.containerStatuses || [];
        pods.push({
          name: it.metadata?.name, namespace: it.metadata?.namespace || 'default',
          status: it.status?.phase || 'Unknown',
          ready: `${cs.filter((c: any) => c.ready).length}/${cs.length}`,
          node: it.spec?.nodeName || '', restarts: cs.reduce((a: number, c: any) => a + (c.restartCount || 0), 0),
        });
      }
    }
  } catch { /* ignore parse errors */ }

  // containerd via crictl (fallback container view on K8s nodes without docker).
  const crictl: any[] = [];
  try {
    const craw = section(stdout, 'CRICTL');
    if (craw.startsWith('{')) {
      for (const c of JSON.parse(craw).containers || []) {
        crictl.push({
          id: (c.id || '').slice(0, 12),
          name: c.metadata?.name || '',
          state: (c.state || '').replace('CONTAINER_', ''),
          image: c.image?.image || c.imageRef || '',
          pod: c.labels?.['io.kubernetes.pod.name'] || '',
        });
      }
    }
  } catch { /* ignore parse errors */ }

  // Kubernetes services (kubectl get svc -A -o json).
  const services: any[] = [];
  try {
    const sraw = section(stdout, 'KSVCS');
    if (sraw.startsWith('{')) {
      for (const s of JSON.parse(sraw).items || []) {
        services.push({
          name: s.metadata?.name,
          namespace: s.metadata?.namespace || 'default',
          type: s.spec?.type || 'ClusterIP',
          clusterIp: s.spec?.clusterIP || '—',
          ports: (s.spec?.ports || []).map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol || 'TCP'}`).join(', '),
        });
      }
    }
  } catch { /* ignore parse errors */ }

  // Running systemd services (name + description).
  const systemServices: any[] = [];
  for (const line of section(stdout, 'SYSTEMD').split('\n')) {
    const m = line.trim().match(/^(\S+\.service)\s+\S+\s+\S+\s+(\S+)\s*(.*)$/);
    if (m) systemServices.push({ unit: m[1].replace(/\.service$/, ''), sub: m[2], description: m[3] || '' });
  }

  // Listening ports (ss/netstat): proto, local address, owning process if visible.
  const listeningPorts: any[] = [];
  for (const line of section(stdout, 'PORTS').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0].toLowerCase();
    if (!/^(tcp|udp)/.test(proto)) continue;
    const local = cols[4].includes(':') ? cols[4] : cols[3];
    const procMatch = line.match(/users:\(\("([^"]+)"/) || line.match(/\d+\/([\w.-]+)\s*$/);
    listeningPorts.push({ proto, local, process: procMatch ? procMatch[1] : '' });
  }

  res.json({ reachable: true, engines, containers, pods, services, crictl, systemServices, listeningPorts });
});
