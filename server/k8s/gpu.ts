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
  model: ModelInfo;
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
        model: detectModel(p, c, isvcs),
      });
    }
  }
  return out;
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
const MAX_PROBES = Number(process.env.KALAM_GPU_MAX_PROBES || 24);

export const gpuRouter = Router();

gpuRouter.get('/api/gpu/overview', async (req, res) => {
  const vm = req.query.vm ? String(req.query.vm) : undefined;
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });
  const probe = req.query.probe !== '0';

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
    return res.json({ error: inv.error || 'Could not list pods on this cluster.', workloads: [], nodes: [] });
  }
  const isvcs = new Map<string, any>();
  for (const i of parseJson(inv.out.ISVC)?.items || []) isvcs.set(`${i?.metadata?.namespace}/${i?.metadata?.name}`, i);

  const workloads = gpuWorkloads(pods, isvcs);
  const nodes = gpuNodes(parseJson(inv.out.NODES)?.items || [], workloads);

  // Live readings: running GPU containers only, bounded.
  const targets = probe ? workloads.filter((w) => w.phase === 'Running').slice(0, MAX_PROBES) : [];
  const readings: Record<string, { gpus: GpuReading[]; error?: string }> = {};
  if (targets.length) {
    // Local: a few pods at a time (each step is its own process). Remote: one
    // SSH round trip for everything, because the SSH handshake is the cost.
    const key = (w: GpuWorkload) => `${w.namespace}/${w.pod}/${w.container}`;
    const collect = (out: Record<string, string>, i: number, w: GpuWorkload) => {
      const gpus = parseGpuReadings(out[`Q${i}`], out[`X${i}`], out[`A${i}`]);
      readings[key(w)] = gpus.length
        ? { gpus }
        : { gpus: [], error: 'nvidia-smi gave no reading in this container (not installed, or no NVIDIA runtime utilities mounted).' };
    };
    if (vm) {
      const r = await runSteps(targets.flatMap((w, i) => smiSteps(i, w)), vm, Math.min(180_000, 20_000 + targets.length * 8_000));
      targets.forEach((w, i) => collect(r.out, i, w));
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

  res.json({
    ok: true,
    readOnly: true,
    workloads,
    nodes,
    readings,
    probed: targets.length,
    skipped: Math.max(0, workloads.filter((w) => w.phase === 'Running').length - targets.length),
    at: new Date().toISOString(),
  });
});

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
