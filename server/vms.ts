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

function sshBaseArgs(vm: VmEntry, interactive = false): string[] {
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-p', String(vm.port)];
  if (!interactive) args.unshift('-o', 'BatchMode=yes'); // never hang on a password prompt for probes
  if (vm.keyPath) args.push('-i', vm.keyPath);
  args.push(`${vm.user}@${vm.host}`);
  return args;
}

// Run a remote command over ssh. Resolves with combined result — never rejects.
function sshRun(vm: VmEntry, command: string, timeoutMs = 20000): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile('ssh', [...sshBaseArgs(vm), command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || (err ? err.message : ''), ok: !err });
    });
  });
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
  const { name, host, user, port = 22, keyPath } = req.body || {};
  if (!name || !NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid VM name (letters, numbers, . _ - only).' });
  if (!host || !HOST_RE.test(host)) return res.status(400).json({ error: 'Invalid host/IP.' });
  if (!user || !NAME_RE.test(user)) return res.status(400).json({ error: 'Invalid SSH user.' });
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1 || p > 65535) return res.status(400).json({ error: 'Invalid port.' });

  const vms = await loadVms();
  if (vms.some((v) => v.name === name)) return res.status(409).json({ error: `A VM named "${name}" already exists.` });
  const entry: VmEntry = { name, host, user, port: p };
  if (keyPath && typeof keyPath === 'string') entry.keyPath = keyPath.trim();
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

  const reachable = await tcpReachable(vm.host, vm.port);
  const out: any = { name: vm.name, host: vm.host, port: vm.port, reachable };
  if (!reachable) {
    out.error = 'SSH port unreachable';
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
  const cmd = ['ssh', ...sshBaseArgs(vm, true)].join(' ');
  res.json({ command: cmd });
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
function diagnoseReason(reason: string, extra: { exitCode?: number; restarts?: number } = {}): { detail: string; fixes: string[]; severity: Finding['severity'] } {
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

  if (!(await tcpReachable(vm.host, vm.port))) {
    return res.json({ reachable: false, error: 'SSH port unreachable' });
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
  "echo @@CRICTL@@",
  "(sudo -n crictl ps -o json 2>/dev/null || crictl ps -o json 2>/dev/null || true)",
  "echo @@END@@",
].join('; ');

function section(text: string, tag: string): string {
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

  if (!(await tcpReachable(vm.host, vm.port))) {
    return res.status(200).json({ reachable: false, error: 'SSH port unreachable' });
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

  res.json({ reachable: true, engines, containers, pods, crictl });
});
