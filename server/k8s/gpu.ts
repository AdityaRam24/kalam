// GPU utilization, per model.
//
// The question an AI platform operator asks is not "how busy is GPU 3" but
// "which MODEL is on which GPU, and how hard is it working". Kubernetes knows
// the first half (who requested nvidia.com/gpu, on which node); nvidia-smi
// inside the pod knows the second (the GPUs that container can see, their
// load, memory, temperature, power and processes). This module joins the two.
//
// nvidia-smi runs INSIDE each GPU pod via `kubectl exec`, so it reports only
// the devices allocated to that container — which is exactly the per-model
// view wanted. Everything here is read-only; the raw modes are a fixed
// allow-list, never a free-form command.

import { Router } from 'express';
import { runSteps, parseJson, SAFE_NAME, type Step } from './kubectl.js';
import { isvcModel } from './resources.js';
import { parseDcgm, dcgmExporters, type DcgmGpu } from './dcgm.js';
import {
  appendGpuHistory, readGpuHistory, pruneGpuHistory, seriesByWorkload, gpuFindings,
  type GpuHistLine, type GpuHistPoint,
} from './gpuhistory.js';

// Long-standing fields (driver 450+). Kept separate from EXT_FIELDS so that a
// driver rejecting one newer field cannot blank the whole reading.
export const CORE_FIELDS = [
  'index', 'uuid', 'name', 'pci.bus_id', 'driver_version', 'pstate', 'temperature.gpu',
  'utilization.gpu', 'utilization.memory', 'memory.total', 'memory.used', 'memory.free',
  'power.draw', 'power.limit', 'clocks.sm', 'clocks.mem', 'clocks.max.sm', 'fan.speed',
  'persistence_mode', 'compute_mode', 'pcie.link.gen.current', 'pcie.link.width.current',
] as const;
export const EXT_FIELDS = [
  'uuid', 'mig.mode.current', 'ecc.errors.uncorrected.volatile.total', 'clocks_throttle_reasons.active',
  'temperature.memory', 'encoder.stats.sessionCount',
] as const;
export const APP_FIELDS = ['gpu_uuid', 'pid', 'process_name', 'used_memory'] as const;

export interface GpuReading {
  index: number;
  uuid: string;
  name: string;
  busId: string;
  driver: string;
  pstate: string;
  tempC: number | null;
  utilPct: number | null;
  memUtilPct: number | null;
  memTotalMiB: number | null;
  memUsedMiB: number | null;
  memFreeMiB: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  smClockMHz: number | null;
  memClockMHz: number | null;
  maxSmClockMHz: number | null;
  fanPct: number | null;
  persistence: string;
  computeMode: string;
  pcie: string;
  mig?: string;
  eccUncorrected?: number | null;
  throttle?: string[];
  memTempC?: number | null;
  encoderSessions?: number | null;
  processes: Array<{ pid: string; name: string; usedMiB: number | null }>;
  /** Where the reading came from: the DCGM exporter, or nvidia-smi exec'd in the pod. */
  source?: 'dcgm' | 'nvidia-smi';
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const t = v.trim();
  if (!t || /N\/A|Not Supported|Unknown|ERR/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | undefined): string => {
  const t = (v || '').trim();
  return /^\[?(N\/A|Not Supported)\]?$/i.test(t) ? '' : t;
};

/** Split nvidia-smi `--format=csv,noheader,nounits` output into rows of cells. */
export function csvRows(text: string): string[][] {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(error|failed|nvidia-smi has failed|No devices|Field .* is not a valid)/i.test(l))
    .map((l) => l.split(',').map((c) => c.trim()));
}

// The throttle bitmask nvidia-smi reports, as words an operator recognises.
const THROTTLE_BITS: Array<[number, string]> = [
  [0x1, 'GPU idle'], [0x2, 'app clocks setting'], [0x4, 'SW power cap'], [0x8, 'HW slowdown'],
  [0x10, 'sync boost'], [0x20, 'SW thermal'], [0x40, 'HW thermal'], [0x80, 'HW power brake'], [0x100, 'display clocks'],
];
export function throttleReasons(mask: string | undefined): string[] {
  const n = parseInt(String(mask || '').trim(), 16);
  if (!Number.isFinite(n) || n === 0) return [];
  return THROTTLE_BITS.filter(([bit]) => (n & bit) !== 0).map(([, label]) => label);
}

export function parseGpuReadings(core: string, ext: string, apps: string): GpuReading[] {
  const extByUuid = new Map(csvRows(ext).map((r) => [r[0], r]));
  const appsByUuid = new Map<string, GpuReading['processes']>();
  for (const r of csvRows(apps)) {
    if (r.length < 4) continue;
    const list = appsByUuid.get(r[0]) || [];
    list.push({ pid: r[1], name: r[2], usedMiB: num(r[3]) });
    appsByUuid.set(r[0], list);
  }
  return csvRows(core)
    .filter((r) => r.length >= CORE_FIELDS.length)
    .map((r) => {
      const x = extByUuid.get(r[1]);
      return {
        index: num(r[0]) ?? 0, uuid: r[1], name: r[2], busId: r[3], driver: r[4], pstate: str(r[5]),
        tempC: num(r[6]), utilPct: num(r[7]), memUtilPct: num(r[8]),
        memTotalMiB: num(r[9]), memUsedMiB: num(r[10]), memFreeMiB: num(r[11]),
        powerW: num(r[12]), powerLimitW: num(r[13]), smClockMHz: num(r[14]), memClockMHz: num(r[15]),
        maxSmClockMHz: num(r[16]), fanPct: num(r[17]), persistence: str(r[18]), computeMode: str(r[19]),
        pcie: [str(r[20]), str(r[21])].every(Boolean) ? `Gen${str(r[20])} x${str(r[21])}` : '',
        ...(x ? {
          mig: str(x[1]), eccUncorrected: num(x[2]), throttle: throttleReasons(x[3]),
          memTempC: num(x[4]), encoderSessions: num(x[5]),
        } : {}),
        processes: appsByUuid.get(r[1]) || [],
      };
    });
}

// ---------------------------------------------------------------------------
// Which model is this pod serving?
// ---------------------------------------------------------------------------

const MODEL_FLAGS = ['--model', '--model-name', '--served-model-name', '--model_name', '--model-id', '--model_id', '--model-path', '--model_path', '--model-repository', '--model-store'];
const MODEL_ENVS = ['SERVED_MODEL_NAME', 'NIM_SERVED_MODEL_NAME', 'NIM_MODEL_NAME', 'MODEL_NAME', 'MODEL_ID', 'HF_MODEL_ID', 'MODEL', 'MODEL_PATH', 'STORAGE_URI'];

export interface ModelInfo {
  model?: string;
  server: string;
  evidence: Array<{ source: string; value: string }>;
}

/** Name the serving stack from the image — vLLM, NIM, Triton and friends. */
export function servingStack(image: string): string {
  const i = (image || '').toLowerCase();
  if (/vllm/.test(i)) return 'vLLM';
  if (/nvcr\.io\/nim|\/nim\/|nim-/.test(i)) return 'NVIDIA NIM';
  if (/triton/.test(i)) return 'Triton';
  if (/text-generation-inference|\/tgi/.test(i)) return 'TGI';
  if (/ollama/.test(i)) return 'Ollama';
  if (/kserve|huggingfaceserver/.test(i)) return 'KServe';
  if (/ray/.test(i)) return 'Ray';
  if (/torchserve/.test(i)) return 'TorchServe';
  if (/jupyter|notebook/.test(i)) return 'Notebook';
  return 'Container';
}

export function detectModel(pod: any, container: any, isvcs: Map<string, any>): ModelInfo {
  const evidence: ModelInfo['evidence'] = [];
  const labels = pod?.metadata?.labels || {};
  const ns = pod?.metadata?.namespace || 'default';

  const isvcName = labels['serving.kserve.io/inferenceservice'];
  if (isvcName) {
    const m = isvcModel(isvcs.get(`${ns}/${isvcName}`));
    evidence.push({ source: 'InferenceService', value: isvcName });
    if (m.format) evidence.push({ source: 'model format', value: m.format });
    if (m.storageUri) evidence.push({ source: 'storageUri', value: m.storageUri });
  }

  const args: string[] = [...(container?.command || []), ...(container?.args || [])].map(String);
  for (let i = 0; i < args.length; i++) {
    for (const flag of MODEL_FLAGS) {
      if (args[i] === flag && args[i + 1]) evidence.push({ source: flag, value: args[i + 1] });
      else if (args[i].startsWith(`${flag}=`)) evidence.push({ source: flag, value: args[i].slice(flag.length + 1) });
    }
  }
  // `vllm serve <model>` names the model positionally.
  const serve = args.findIndex((a) => a === 'serve');
  if (serve >= 0 && args[serve + 1] && !args[serve + 1].startsWith('-')) evidence.push({ source: 'serve', value: args[serve + 1] });

  for (const env of container?.env || []) {
    if (MODEL_ENVS.includes(env?.name) && typeof env.value === 'string' && env.value) {
      evidence.push({ source: `env ${env.name}`, value: env.value });
    }
  }

  // Most specific first: a served name beats a path, a path beats an isvc name.
  const pick = (re: RegExp) => evidence.find((e) => re.test(e.source))?.value;
  const model = pick(/served|NIM_MODEL_NAME|MODEL_NAME|--model-name|--model_name/)
    || pick(/^--model$|serve|MODEL_ID|HF_MODEL_ID|--model-id|--model_id|^env MODEL$/)
    || pick(/path|storageUri|STORAGE_URI|repository|store/)
    || isvcName;

  return { model, server: isvcName && servingStack(container?.image) === 'Container' ? 'KServe' : servingStack(container?.image), evidence };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const GPU_KEY = /^(nvidia\.com\/(gpu|mig-.+)|amd\.com\/gpu|gpu\.intel\.com\/.+|habana\.ai\/gaudi)$/;

export function gpuCount(block: any): number {
  let n = 0;
  for (const [k, v] of Object.entries(block || {})) {
    if (GPU_KEY.test(k)) {
      const x = Number(v);
      if (Number.isFinite(x)) n += x;
    }
  }
  return n;
}

export interface GpuWorkload {
  namespace: string;
  pod: string;
  container: string;
  node: string;
  phase: string;
  gpus: number;
  image: string;
  owner?: string;
  /** When the pod started (status.startTime, else creation) — ISO string. */
  startedAt?: string;
  /** Being deleted: still holds its GPUs, but is on its way out. */
  terminating?: boolean;
  model: ModelInfo;
}

const startOf = (w: Pick<GpuWorkload, 'startedAt'>) => (w.startedAt ? Date.parse(w.startedAt) || 0 : 0);

/**
 * What to show first and probe first: live pods before finished ones, and
 * within each, the NEWEST first. `kubectl get pods` sorts by namespace/name,
 * so taking its first N meant a freshly deployed model in a late-sorting
 * namespace was never probed — the page kept showing the old pods only.
 */
export function byNewest(a: GpuWorkload, b: GpuWorkload): number {
  const rank = (w: GpuWorkload) => (w.phase === 'Running' && !w.terminating ? 0 : w.phase === 'Pending' ? 1 : w.terminating ? 2 : 3);
  return rank(a) - rank(b) || startOf(b) - startOf(a) || `${a.namespace}/${a.pod}`.localeCompare(`${b.namespace}/${b.pod}`);
}

/** Running containers worth exec-ing into, newest first, at most `max`. */
export function probeTargets(workloads: GpuWorkload[], max: number): GpuWorkload[] {
  return workloads.filter((w) => w.phase === 'Running' && !w.terminating).sort(byNewest).slice(0, Math.max(0, max));
}

export function gpuWorkloads(pods: any[], isvcs: Map<string, any>): GpuWorkload[] {
  const out: GpuWorkload[] = [];
  for (const p of pods || []) {
    for (const c of p?.spec?.containers || []) {
      const gpus = Math.max(gpuCount(c?.resources?.limits), gpuCount(c?.resources?.requests));
      if (gpus <= 0) continue;
      const ref = (p?.metadata?.ownerReferences || [])[0];
      out.push({
        namespace: p?.metadata?.namespace || 'default',
        pod: p?.metadata?.name,
        container: c.name,
        node: p?.spec?.nodeName || '—',
        phase: p?.status?.phase || 'Unknown',
        gpus,
        image: c.image || '',
        owner: ref ? `${ref.kind}/${ref.name}` : undefined,
        startedAt: p?.status?.startTime || p?.metadata?.creationTimestamp || undefined,
        terminating: !!p?.metadata?.deletionTimestamp,
        model: detectModel(p, c, isvcs),
      });
    }
  }
  return out.sort(byNewest);
}

export function gpuNodes(nodes: any[], workloads: GpuWorkload[]) {
  return (nodes || [])
    .map((n) => {
      const labels = n?.metadata?.labels || {};
      const name = n?.metadata?.name;
      const capacity = gpuCount(n?.status?.capacity);
      const allocatable = gpuCount(n?.status?.allocatable);
      const allocated = workloads.filter((w) => w.node === name && w.phase === 'Running').reduce((a, w) => a + w.gpus, 0);
      return {
        name,
        capacity,
        allocatable,
        allocated,
        product: labels['nvidia.com/gpu.product'] || '',
        memoryMiB: Number(labels['nvidia.com/gpu.memory']) || null,
        migStrategy: labels['nvidia.com/mig.strategy'] || '',
        driver: [labels['nvidia.com/cuda.driver.major'], labels['nvidia.com/cuda.driver.minor'], labels['nvidia.com/cuda.driver.rev']].filter(Boolean).join('.'),
        cuda: [labels['nvidia.com/cuda.runtime.major'], labels['nvidia.com/cuda.runtime.minor']].filter(Boolean).join('.'),
      };
    })
    .filter((n) => n.capacity > 0 || n.allocated > 0);
}

/** nvidia-smi steps for one container, tagged by its index in the probe list. */
export function smiSteps(i: number, w: Pick<GpuWorkload, 'namespace' | 'pod' | 'container'>): Step[] {
  const base = ['exec', '-n', w.namespace, w.pod, '-c', w.container, '--', 'nvidia-smi'];
  return [
    { tag: `Q${i}`, args: [...base, `--query-gpu=${CORE_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], optional: true },
    { tag: `X${i}`, args: [...base, `--query-gpu=${EXT_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], optional: true },
    { tag: `A${i}`, args: [...base, `--query-compute-apps=${APP_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], optional: true },
  ];
}

/** How many GPU containers are probed live per request — keeps one call bounded. */
const MAX_PROBES = Number(process.env.TRINETRA_GPU_MAX_PROBES || 64);
/** Concurrent `kubectl exec`s on a remote host, and the cap on any one of them. */
const REMOTE_PARALLEL = Math.max(1, Number(process.env.TRINETRA_GPU_PARALLEL || 8));
const EXEC_TIMEOUT_SEC = 20;
/** Set TRINETRA_GPU_DCGM=off to never use the DCGM exporter. */
const USE_DCGM = (process.env.TRINETRA_GPU_DCGM || '').toLowerCase() !== 'off';

const wkey = (w: Pick<GpuWorkload, 'namespace' | 'pod' | 'container'>) => `${w.namespace}/${w.pod}/${w.container}`;

/**
 * Hand DCGM's GPUs to the workloads holding them. A series without a
 * container label goes to the pod's first GPU-requesting container.
 */
export function assignDcgm(workloads: GpuWorkload[], gpus: DcgmGpu[]): { byKey: Record<string, DcgmGpu[]>; unassigned: Record<string, number> } {
  const byKey: Record<string, DcgmGpu[]> = {};
  const unassigned: Record<string, number> = {};
  const exact = new Map(workloads.map((w) => [wkey(w), w]));
  const firstOfPod = new Map<string, GpuWorkload>();
  for (const w of workloads) if (!firstOfPod.has(`${w.namespace}/${w.pod}`)) firstOfPod.set(`${w.namespace}/${w.pod}`, w);
  for (const g of gpus) {
    const w = g.pod ? (exact.get(`${g.namespace}/${g.pod}/${g.container}`) || firstOfPod.get(`${g.namespace}/${g.pod}`)) : undefined;
    if (w) (byKey[wkey(w)] ||= []).push(g);
    else if (!g.pod) unassigned[g.node] = (unassigned[g.node] || 0) + 1;
  }
  return { byKey, unassigned };
}

const meanOf = (xs: Array<number | null | undefined>) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

let historyWrites = 0;

async function collectGpuOverview(vm: string | undefined, probe: boolean) {
  const inv = await runSteps(
    [
      { tag: 'PODS', args: ['get', 'pods', '--all-namespaces', '-o', 'json'] },
      { tag: 'NODES', args: ['get', 'nodes', '-o', 'json'], optional: true },
      { tag: 'ISVC', args: ['get', 'inferenceservices.serving.kserve.io', '--all-namespaces', '-o', 'json'], optional: true },
    ],
    vm,
    90_000,
    1024 * 1024 * 128,
  );
  const pods = parseJson(inv.out.PODS)?.items;
  if (!Array.isArray(pods)) {
    return { error: inv.error || 'Could not list pods on this cluster.', workloads: [], nodes: [] };
  }
  const isvcs = new Map<string, any>();
  for (const i of parseJson(inv.out.ISVC)?.items || []) isvcs.set(`${i?.metadata?.namespace}/${i?.metadata?.name}`, i);

  const workloads = gpuWorkloads(pods, isvcs);
  const nodes = gpuNodes(parseJson(inv.out.NODES)?.items || [], workloads);
  const readings: Record<string, { gpus: GpuReading[]; error?: string; source?: 'dcgm' | 'nvidia-smi' }> = {};

  // 1. DCGM exporter: one GET per GPU node through the pod proxy, no exec.
  let dcgm: { exporters: number; read: number; gpus: DcgmGpu[]; unassigned: Record<string, number>; error?: string } | undefined;
  if (probe && USE_DCGM) {
    const exporters = dcgmExporters(pods);
    if (exporters.length) {
      const steps: Step[] = exporters.map((e, i) => ({
        tag: `D${i}`, args: ['get', '--raw', `/api/v1/namespaces/${e.namespace}/pods/${e.pod}:${e.port}/proxy/metrics`], optional: true,
      }));
      const r = await runSteps(steps, vm, 60_000, 1024 * 1024 * 32, { parallel: REMOTE_PARALLEL, stepTimeoutSec: EXEC_TIMEOUT_SEC });
      const gpus = exporters.flatMap((e, i) => parseDcgm(r.out[`D${i}`] || '', e.node));
      const read = exporters.filter((_, i) => (r.out[`D${i}`] || '').includes('DCGM_FI_')).length;
      const { byKey, unassigned } = assignDcgm(workloads, gpus);
      for (const [k, g] of Object.entries(byKey)) readings[k] = { gpus: g, source: 'dcgm' };
      dcgm = {
        exporters: exporters.length, read, gpus, unassigned,
        error: read === 0 ? 'DCGM exporter pods were found but their /metrics could not be read (needs get on pods/proxy).' : undefined,
      };
    }
  }

  // 2. nvidia-smi in the pod, for running containers DCGM did not cover:
  // newest first, bounded. Terminating pods are skipped — an exec into one can
  // hang until it is gone.
  const uncovered = workloads.filter((w) => !readings[wkey(w)]);
  const targets = probe ? probeTargets(uncovered, MAX_PROBES) : [];
  if (targets.length) {
    const collect = (out: Record<string, string>, i: number, w: GpuWorkload, missing?: Set<string>) => {
      const gpus = parseGpuReadings(out[`Q${i}`], out[`X${i}`], out[`A${i}`]).map((g) => ({ ...g, source: 'nvidia-smi' as const }));
      readings[wkey(w)] = gpus.length
        ? { gpus, source: 'nvidia-smi' }
        : missing?.has(`Q${i}`)
          ? { gpus: [], error: 'The probe ran out of time before reaching this pod — refresh, or raise TRINETRA_GPU_PARALLEL.' }
          : { gpus: [], error: 'nvidia-smi gave no reading in this container (not installed, or no NVIDIA runtime utilities mounted).' };
    };
    if (vm) {
      // One SSH call, execs run in parallel batches on the remote host, each
      // bounded — one slow pod no longer starves every pod after it.
      const steps = targets.flatMap((w, i) => smiSteps(i, w));
      const batches = Math.ceil(steps.length / REMOTE_PARALLEL);
      const r = await runSteps(steps, vm, Math.min(240_000, 20_000 + batches * (EXEC_TIMEOUT_SEC + 2) * 1000), 1024 * 1024 * 16,
        { parallel: REMOTE_PARALLEL, stepTimeoutSec: EXEC_TIMEOUT_SEC });
      if (!Object.keys(r.out).length && r.error) {
        for (const w of targets) readings[wkey(w)] = { gpus: [], error: r.error };
      } else {
        targets.forEach((w, i) => collect(r.out, i, w, r.missing));
      }
    } else {
      for (let start = 0; start < targets.length; start += 4) {
        const batch = targets.slice(start, start + 4);
        await Promise.all(batch.map(async (w, j) => {
          const i = start + j;
          const r = await runSteps(smiSteps(i, w), undefined, 30_000);
          collect(r.out, i, w);
        }));
      }
    }
  }

  // 3. History + findings.
  const now = Date.now();
  const source = vm || 'local';
  const latest: Record<string, { util: number | null; mem: number | null; xid?: number | null; throttle?: string[] }> = {};
  const line: GpuHistLine = { at: now, w: {} };
  for (const w of workloads) {
    const g = readings[wkey(w)]?.gpus || [];
    if (!g.length) continue;
    const used = g.reduce((a, x) => a + (x.memUsedMiB || 0), 0);
    const total = g.reduce((a, x) => a + (x.memTotalMiB || 0), 0);
    const util = meanOf(g.map((x) => x.utilPct));
    const mem = total ? (used / total) * 100 : null;
    latest[wkey(w)] = {
      util, mem,
      xid: Math.max(0, ...g.map((x) => Number((x as DcgmGpu).xid) || 0)) || null,
      throttle: g.flatMap((x) => x.throttle || []),
    };
    line.w[wkey(w)] = { model: w.model.model, gpus: w.gpus, util: util === null ? null : Math.round(util * 10) / 10, mem: mem === null ? null : Math.round(mem * 10) / 10 };
  }
  let history: Record<string, GpuHistPoint[]> = {};
  try {
    if (probe) await appendGpuHistory(source, line);
    if (++historyWrites % 200 === 0) await pruneGpuHistory(source);
    history = seriesByWorkload(await readGpuHistory(source, now - 6 * 3600_000), 60);
  } catch { /* history is a bonus; a read-only disk must not fail the page */ }

  const findings = gpuFindings({
    now,
    workloads: workloads.map((w) => ({ key: wkey(w), model: w.model.model, phase: w.phase, terminating: w.terminating, gpus: w.gpus, node: w.node })),
    latest, history, nodes, unassigned: dcgm?.unassigned,
  });

  return {
    ok: true,
    readOnly: true,
    workloads,
    nodes,
    readings,
    dcgm: dcgm && { exporters: dcgm.exporters, read: dcgm.read, error: dcgm.error, unassigned: dcgm.unassigned, gpus: dcgm.gpus.length },
    history,
    findings,
    probed: targets.length,
    skipped: Math.max(0, uncovered.filter((w) => w.phase === 'Running' && !w.terminating).length - targets.length),
    at: new Date().toISOString(),
  };
}

// Several viewers (or one with auto-refresh) asking for the same source at
// once share one read instead of each exec-ing into every GPU pod.
const inFlight = new Map<string, ReturnType<typeof collectGpuOverview>>();
export function gpuOverview(vm: string | undefined, probe: boolean) {
  const k = `${vm || 'local'}|${probe}`;
  let p = inFlight.get(k);
  if (!p) {
    p = collectGpuOverview(vm, probe).finally(() => inFlight.delete(k));
    inFlight.set(k, p);
  }
  return p;
}

export const gpuRouter = Router();

gpuRouter.get('/api/gpu/overview', async (req, res) => {
  const vm = req.query.vm ? String(req.query.vm) : undefined;
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });
  try {
    res.json(await gpuOverview(vm, req.query.probe !== '0'));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e), workloads: [], nodes: [] });
  }
});

// Optional background sampling so idle-GPU findings have history even when
// nobody has the page open. Off by default: each poll execs into GPU pods
// that DCGM does not cover. TRINETRA_GPU_POLL_SEC=300, TRINETRA_GPU_POLL_SOURCES=local,vm1
let gpuTimer: NodeJS.Timeout | undefined;
export function startGpuPoller(): boolean {
  const sec = Number(process.env.TRINETRA_GPU_POLL_SEC || 0);
  if (!sec || gpuTimer) return false;
  const sources = (process.env.TRINETRA_GPU_POLL_SOURCES || 'local').split(',').map((s) => s.trim()).filter((s) => s === 'local' || SAFE_NAME.test(s));
  const tick = async () => {
    for (const s of sources) await gpuOverview(s === 'local' ? undefined : s, true).catch(() => undefined);
  };
  gpuTimer = setInterval(() => void tick(), Math.max(60, sec) * 1000);
  gpuTimer.unref?.();
  void tick();
  return true;
}

/** Fixed nvidia-smi invocations for the "raw output" panel — never free-form. */
export const RAW_MODES: Record<string, string[]> = {
  summary: [],
  query: ['-q'],
  topology: ['topo', '-m'],
  list: ['-L'],
  clocks: ['-q', '-d', 'CLOCK,PERFORMANCE'],
  memory: ['-q', '-d', 'MEMORY,ECC'],
  power: ['-q', '-d', 'POWER,TEMPERATURE'],
  processes: ['-q', '-d', 'PIDS'],
  help: ['--help'],
};

gpuRouter.post('/api/gpu/raw', async (req, res) => {
  const { vm, namespace, pod, container, mode } = req.body || {};
  for (const v of [namespace, pod, container]) {
    if (typeof v !== 'string' || !SAFE_NAME.test(v)) return res.status(400).json({ error: 'Invalid pod reference.' });
  }
  if (vm !== undefined && vm !== '' && (typeof vm !== 'string' || !SAFE_NAME.test(vm))) return res.status(400).json({ error: 'Invalid VM name.' });
  const extra = RAW_MODES[String(mode)];
  if (!extra) return res.status(400).json({ error: `Unknown mode "${mode}".` });

  const { out, ok, error } = await runSteps(
    // Not optional: when exec fails locally, kubectl's own message is the answer.
    [{ tag: 'RAW', args: ['exec', '-n', namespace, pod, '-c', container, '--', 'nvidia-smi', ...extra] }],
    vm || undefined,
    45_000,
  );
  const text = out.RAW || '';
  res.json({
    ok: ok.has('RAW') || !!text.trim(),
    command: `kubectl exec -n ${namespace} ${pod} -c ${container} -- nvidia-smi ${extra.join(' ')}`.trim(),
    output: text || error || 'nvidia-smi produced no output in this container.',
  });
});
