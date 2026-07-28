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
//   POST   /api/vms/explain           -> { name } "what is this node" brain report

import { Router } from 'express';
import { identifyComponent, type ComponentInfo } from './pcai/components.js';
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

// ---------------------------------------------------------------------------
// "Node brain": explain a discovered node to a human.
//
// POST /api/vms/explain { name } — read-only. Answers three questions:
//   1. What IS this node? (role, hardware, cluster membership)
//   2. What is running on it and WHY? (each workload matched against the
//      component catalog: what it is, why it must run here, what breaks if it
//      stops) — e.g. "spire-agent runs on every node because a workload can
//      only be attested by something on its own machine".
//   3. What changed recently? (reboots, service restarts, pods created or
//      restarted in the last week, host package installs, warning events)
// ---------------------------------------------------------------------------

const EXPLAIN_CMD = [
  'echo @@SELF@@',
  '(echo HOST:$(hostname); ' +
    'echo IPS:$(hostname -I 2>/dev/null); ' +
    'echo KERNEL:$(uname -r); ' +
    'echo OS:$(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME); ' +
    'echo BOOT:$(uptime -s 2>/dev/null); ' +
    'echo UP:$(uptime -p 2>/dev/null))',
  'echo @@NODES@@',
  '(kubectl get nodes -o json 2>/dev/null || true)',
  'echo @@PODS@@',
  '(kubectl get pods -A -o json 2>/dev/null || true)',
  'echo @@EVENTS@@',
  '(kubectl get events -A --sort-by=.lastTimestamp 2>/dev/null | tail -30 || true)',
  'echo @@UNITS@@',
  "(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | head -60 || true)",
  'echo @@SVCTIME@@',
  '(for u in kubelet containerd docker crio spire-agent; do t=$(systemctl show $u -p ActiveEnterTimestamp --value 2>/dev/null); ' +
    '[ -n "$t" ] && echo "$u|$t"; done || true)',
  'echo @@PKG@@',
  "((grep -E ' (install|upgrade) ' /var/log/dpkg.log 2>/dev/null | tail -10) || true; (rpm -qa --last 2>/dev/null | head -10) || true)",
  'echo @@END@@',
].join('; ');

export interface NodeComponent extends ComponentInfo {
  workloads: Array<{ name: string; namespace?: string; status?: string; restarts?: number; image?: string; age?: string }>;
  unhealthy: number;
}

export interface NodeChange {
  at?: string;   // ISO timestamp when known
  age: string;   // human "3d ago"
  kind: 'reboot' | 'service' | 'pod-new' | 'pod-restart' | 'package' | 'event';
  text: string;
}

// "2026-07-20T10:00:00Z" -> "8d ago". Returns '' for unparseable input.
export function humanAge(iso?: string, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Which inventory VM is which cluster node? SSH gives us a hostname and IPs;
// the node's Kubernetes name is often neither, so match on both.
export function matchNode(nodes: any[], hostname: string, ips: string[]): any | undefined {
  const host = (hostname || '').toLowerCase();
  const short = host.split('.')[0];
  return nodes.find((n) => {
    const nm = String(n.metadata?.name || '').toLowerCase();
    if (nm === host || nm.split('.')[0] === short) return true;
    return (n.status?.addresses || []).some((a: any) =>
      (a.type === 'InternalIP' && ips.includes(a.address)) ||
      (a.type === 'Hostname' && String(a.address).toLowerCase().split('.')[0] === short));
  });
}

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toUpperCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Bytes-ish Kubernetes quantity ("128974848Ki") -> "123 GiB".
function humanMem(q?: string): string {
  if (!q) return '—';
  const m = q.match(/^(\d+)(Ki|Mi|Gi|Ti)?$/);
  if (!m) return q;
  const mult: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  const bytes = parseInt(m[1], 10) * (m[2] ? mult[m[2]] : 1);
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(gib < 10 ? 1 : 0)} GiB` : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

vmsRouter.post('/api/vms/explain', async (req, res) => {
  const { name } = req.body || {};
  const vm = (await loadVms()).find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });

  if (!(await vmReachable(vm))) {
    return res.json({ reachable: false, error: vm.via ? `Jump host "${vm.via}" unreachable` : 'SSH port unreachable' });
  }

  const { stdout, stderr, ok } = await sshRun(vm, EXPLAIN_CMD, 45000);
  if (!ok && !stdout.trim()) {
    return res.json({ reachable: true, error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 200) });
  }

  const now = Date.now();
  const self = kv(section(stdout, 'SELF'));
  const hostname = self.HOST || vm.host;
  const ips = (self.IPS || '').split(/\s+/).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));

  // ---- 1. What is this node? ----------------------------------------------
  let nodes: any[] = [];
  try {
    const raw = section(stdout, 'NODES');
    if (raw.startsWith('{')) nodes = JSON.parse(raw).items || [];
  } catch { /* kubectl output unusable — host-only report below */ }
  const kubectlAvailable = nodes.length > 0;
  const node = kubectlAvailable ? matchNode(nodes, hostname, ips) : undefined;

  const labels: Record<string, string> = node?.metadata?.labels || {};
  const isControlPlane = 'node-role.kubernetes.io/control-plane' in labels || 'node-role.kubernetes.io/master' in labels;
  const gpuCount = parseInt(node?.status?.capacity?.['nvidia.com/gpu'] || '0', 10) || 0;
  const readyCond = (node?.status?.conditions || []).find((c: any) => c.type === 'Ready');
  const taints = (node?.spec?.taints || []).map((t: any) => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`);

  const identity = {
    hostname,
    ips,
    nodeName: node?.metadata?.name || null,
    role: !kubectlAvailable ? 'unknown (kubectl not available here)' : !node ? 'not a member of the cluster this host can see' : isControlPlane ? 'control-plane node' : 'worker node',
    os: self.OS || '—',
    kernel: self.KERNEL || '—',
    uptime: self.UP || '—',
    bootedAt: self.BOOT || '',
    joinedCluster: node?.metadata?.creationTimestamp || '',
    joinedAge: humanAge(node?.metadata?.creationTimestamp, now),
    kubelet: node?.status?.nodeInfo?.kubeletVersion || '',
    runtime: node?.status?.nodeInfo?.containerRuntimeVersion || '',
    cpu: node?.status?.capacity?.cpu || '',
    memory: humanMem(node?.status?.capacity?.memory),
    gpus: gpuCount,
    ready: readyCond ? readyCond.status === 'True' : null,
    schedulable: node ? !node.spec?.unschedulable : null,
    taints,
    notableLabels: Object.entries(labels)
      .filter(([k]) => /gpu|accelerator|instance-type|zone|region|node-role|storage|worker|nvidia/i.test(k))
      .slice(0, 12)
      .map(([k, v]) => (v ? `${k}=${v}` : k)),
  };

  // ---- 2. What runs here, and why? ----------------------------------------
  let allPods: any[] = [];
  try {
    const raw = section(stdout, 'PODS');
    if (raw.startsWith('{')) allPods = JSON.parse(raw).items || [];
  } catch { /* ignore */ }
  // Only this node's pods. Without a node match, fall back to the whole cluster
  // view so the report is still useful (flagged via identity.role).
  const myPods = node ? allPods.filter((p) => p.spec?.nodeName === node.metadata?.name) : [];

  const byComponent = new Map<string, NodeComponent>();
  const addWorkload = (info: ComponentInfo, w: NodeComponent['workloads'][number], healthy: boolean) => {
    let entry = byComponent.get(info.id);
    if (!entry) { entry = { ...info, workloads: [], unhealthy: 0 }; byComponent.set(info.id, entry); }
    entry.workloads.push(w);
    if (!healthy) entry.unhealthy++;
  };

  const otherWorkloads: NodeComponent['workloads'][number][] = [];
  for (const p of myPods) {
    const ns = p.metadata?.namespace || 'default';
    const podName = p.metadata?.name || '?';
    const images: string[] = (p.spec?.containers || []).map((c: any) => c.image).filter(Boolean);
    const owner = (p.metadata?.ownerReferences || [])[0]?.name || '';
    const cs = p.status?.containerStatuses || [];
    const restarts = cs.reduce((a: number, c: any) => a + (c.restartCount || 0), 0);
    const phase = p.status?.phase || 'Unknown';
    const healthy = phase === 'Running' || phase === 'Succeeded';
    const w = { name: podName, namespace: ns, status: phase, restarts, image: images[0], age: humanAge(p.metadata?.creationTimestamp, now) };

    const info = identifyComponent(`${podName} ${owner} ${images.join(' ')} ${ns}`);
    if (info) addWorkload(info, w, healthy);
    else otherWorkloads.push(w);
  }

  // Host-level services matter too — kubelet/containerd/spire-agent may run
  // under systemd rather than as pods.
  for (const unit of section(stdout, 'UNITS').split('\n').map((s) => s.trim()).filter(Boolean)) {
    const info = identifyComponent(unit);
    if (!info) continue;
    const already = byComponent.get(info.id);
    if (already && already.workloads.some((w) => w.name === unit)) continue;
    addWorkload(info, { name: unit, status: 'running (systemd)' }, true);
  }

  const components = Array.from(byComponent.values()).sort((a, b) =>
    (b.unhealthy - a.unhealthy) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));

  // ---- 3. What changed recently? ------------------------------------------
  const changes: NodeChange[] = [];
  if (self.BOOT) {
    // `uptime -s` prints local time without a zone; treat it as-is.
    const iso = self.BOOT.replace(' ', 'T');
    changes.push({ at: iso, age: humanAge(iso, now) || self.BOOT, kind: 'reboot', text: `Host booted (${self.UP || 'uptime unknown'})` });
  }
  for (const line of section(stdout, 'SVCTIME').split('\n')) {
    const [unit, ts] = line.split('|');
    if (!unit || !ts) continue;
    // systemd prints "Mon 2026-07-20 10:00:00 UTC" — drop the weekday so Date can parse it.
    const parsed = Date.parse(ts.trim().replace(/^[A-Za-z]{3}\s+/, ''));
    if (isNaN(parsed)) continue;
    const iso = new Date(parsed).toISOString();
    changes.push({ at: iso, age: humanAge(iso, now), kind: 'service', text: `systemd service ${unit.trim()} (re)started` });
  }
  const WEEK = 7 * 24 * 3600 * 1000;
  for (const p of myPods) {
    const created = p.metadata?.creationTimestamp;
    const ns = p.metadata?.namespace || 'default';
    const pn = p.metadata?.name || '?';
    if (created && now - Date.parse(created) < WEEK) {
      const img = (p.spec?.containers || [])[0]?.image || '';
      changes.push({ at: created, age: humanAge(created, now), kind: 'pod-new', text: `Pod ${ns}/${pn} scheduled here${img ? ` (image ${img})` : ''}` });
    }
    for (const c of p.status?.containerStatuses || []) {
      const fin = c.lastState?.terminated?.finishedAt;
      if (fin && now - Date.parse(fin) < WEEK) {
        changes.push({
          at: fin, age: humanAge(fin, now), kind: 'pod-restart',
          text: `Container ${ns}/${pn}/${c.name} restarted — last exit ${c.lastState.terminated.reason || 'unknown'}${c.lastState.terminated.exitCode != null ? ` (code ${c.lastState.terminated.exitCode})` : ''}, ${c.restartCount || 0} restarts total`,
        });
      }
    }
  }
  for (const line of section(stdout, 'PKG').split('\n').map((s) => s.trim()).filter(Boolean)) {
    changes.push({ age: '', kind: 'package', text: line.slice(0, 200) });
  }
  changes.sort((a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0));

  // ---- Narrative summary ---------------------------------------------------
  const podCount = myPods.length;
  const unhealthyPods = myPods.filter((p) => !['Running', 'Succeeded'].includes(p.status?.phase)).length;
  const summary = !kubectlAvailable
    ? `${hostname} is reachable over SSH but kubectl is not available here, so this report covers the host only (OS, kernel, systemd services and recent host changes).`
    : !node
      ? `${hostname} could not be matched to a node in the cluster kubectl talks to — it may be outside that cluster. Host details and any recognized systemd services are still reported.`
      : `${identity.nodeName} is a ${isControlPlane ? 'control-plane' : 'worker'} node with ${identity.cpu || '?'} CPUs, ${identity.memory} RAM${gpuCount ? ` and ${gpuCount} GPU(s)` : ' and no GPUs'}, running ${identity.os}. ` +
        `It joined the cluster ${identity.joinedAge || 'at an unknown time'} and is currently ${identity.ready ? 'Ready' : 'NOT Ready'}${identity.schedulable === false ? ' and cordoned (unschedulable)' : ''}. ` +
        `${podCount} pod(s) run here across ${components.length} recognized platform component(s)${otherWorkloads.length ? ` plus ${otherWorkloads.length} application workload(s)` : ''}` +
        `${unhealthyPods ? `; ${unhealthyPods} pod(s) are not Running` : '; all pods are Running'}.`;

  res.json({
    reachable: true,
    reportOnly: true,
    kubectlAvailable,
    identity,
    summary,
    components,
    otherWorkloads,
    changes: changes.slice(0, 30),
    warningEvents: section(stdout, 'EVENTS') || undefined,
  });
});
