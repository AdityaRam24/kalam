// Model usage: tokens, requests, latency and queueing, per served model.
//
// The GPU page answers "which model is on which GPU, and how hard is it
// working". This answers the next question — "what is that model actually
// DOING for people": how many tokens in and out, how many requests, how fast
// (time to first token, end-to-end latency), whether requests are queuing,
// and whether the KV cache is full. Every mainstream LLM server publishes
// these as Prometheus counters on its own /metrics endpoint:
//
//   vLLM         vllm:prompt_tokens_total, vllm:generation_tokens_total, …
//   NVIDIA NIM   prompt_tokens_total, generation_tokens_total, … (vLLM/TRT-LLM inside)
//   TGI          tgi_request_input_length_sum, tgi_request_generated_tokens_sum, …
//   Triton       nv_inference_request_success, … (requests, not tokens)
//
// The endpoint is read through the API server's pod proxy — the same route,
// and the same `get pods/proxy` permission, the DCGM exporter read already uses.
// No exec, nothing written to the cluster.
//
// Counters run from the server's start. Windows ("last hour", "last 24 h") and
// "tokens/s now" come from Trinetra's own samples of those counters, kept in
// the metrics directory like the GPU history. Pure parsing and judging are in
// this file and covered by server/__tests__/modelusage.test.ts.

import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { runSteps, parseJson, SAFE_NAME, type Step } from './kubectl.js';
import { parsePromText, type PromSample } from './dcgm.js';
import { detectModel, servingStack, gpuCount, type ModelInfo } from './gpu.js';
import { METRICS_DIR } from '../metrics/store.js';

// ---------------------------------------------------------------------------
// Which pods serve models, and where their metrics live
// ---------------------------------------------------------------------------

export interface Endpoint { port: number; path: string; why: string }

export interface ServingTarget {
  namespace: string;
  pod: string;
  container: string;
  node: string;
  gpus: number;
  image: string;
  server: string;
  model: ModelInfo;
  startedAt?: string;
  owner?: string;
  endpoints: Endpoint[];
  /** Set when the server is known to publish no metrics (Ollama). */
  unsupported?: string;
}

const SERVING = new Set(['vLLM', 'NVIDIA NIM', 'TGI', 'Triton', 'KServe', 'TorchServe', 'Ollama']);
/** Sidecars and helpers that sit in serving pods but never serve. */
const SIDECAR = /^(queue-proxy|istio-proxy|linkerd-proxy|storage-initializer|agent|kserve-agent|envoy|oauth2-proxy|modelcar)$/;

const argValue = (args: string[], flag: string): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
};

/**
 * Where a serving container's /metrics most likely is, best guess first:
 * the pod's own Prometheus annotations, then the server's documented default,
 * then its declared ports.
 */
export function metricsEndpoints(pod: any, container: any, server: string): Endpoint[] {
  const out: Endpoint[] = [];
  const add = (port: unknown, p: unknown, why: string) => {
    const n = Number(port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) return;
    let pth = String(p || '/metrics');
    if (!pth.startsWith('/')) pth = `/${pth}`;
    if (!/^\/[A-Za-z0-9/_.-]*$/.test(pth)) return; // a path that could smuggle anything is not followed
    if (!out.some((e) => e.port === n && e.path === pth)) out.push({ port: n, path: pth, why });
  };
  const ann = pod?.metadata?.annotations || {};
  // KServe's own annotation points at the model container, not the aggregating queue-proxy.
  add(ann['prometheus.kserve.io/port'], ann['prometheus.kserve.io/path'], 'prometheus.kserve.io annotation');
  add(ann['prometheus.io/port'], ann['prometheus.io/path'], 'prometheus.io annotation');

  const args: string[] = [...(container?.command || []), ...(container?.args || [])].map(String);
  const env = (name: string) => (container?.env || []).find((e: any) => e?.name === name)?.value;
  const ports: any[] = container?.ports || [];
  const flagPort = argValue(args, '--port');

  switch (server) {
    case 'vLLM': add(flagPort || 8000, '/metrics', 'vLLM default'); break;
    case 'NVIDIA NIM': {
      const p = env('NIM_SERVER_PORT') || 8000;
      add(p, '/v1/metrics', 'NIM default'); add(p, '/metrics', 'NIM default');
      break;
    }
    case 'TGI': add(flagPort || env('PORT') || ports[0]?.containerPort || 80, '/metrics', 'TGI default'); break;
    case 'Triton': add(argValue(args, '--metrics-port') || 8002, '/metrics', 'Triton metrics port'); break;
    case 'KServe': add(ports[0]?.containerPort || 8080, '/metrics', 'KServe model server'); break;
    case 'TorchServe': add(8082, '/metrics', 'TorchServe metrics port'); break;
  }
  for (const p of ports) {
    if (/metric|http|api|serv/i.test(String(p?.name || ''))) add(p?.containerPort, '/metrics', `port "${p.name}"`);
  }
  if (!out.length && ports[0]) add(ports[0].containerPort, '/metrics', 'first declared port');
  return out.slice(0, 3);
}

/** One serving container per running pod that serves a model (or holds a GPU). */
export function servingTargets(pods: any[], isvcs: Map<string, any>): ServingTarget[] {
  const out: ServingTarget[] = [];
  for (const p of pods || []) {
    if (p?.status?.phase !== 'Running' || p?.metadata?.deletionTimestamp) continue;
    const containers: any[] = (p?.spec?.containers || []).filter((c: any) => !SIDECAR.test(String(c?.name || '')));
    if (!containers.length) continue;
    const isvc = !!p?.metadata?.labels?.['serving.kserve.io/inferenceservice'];
    const podGpus = Math.max(gpuCount(p?.spec?.resources?.limits), gpuCount(p?.spec?.resources?.requests));
    const scored = containers.map((c) => {
      const server = servingStack(c?.image || '');
      const gpus = Math.max(gpuCount(c?.resources?.limits), gpuCount(c?.resources?.requests));
      const score = (SERVING.has(server) ? 4 : 0) + (gpus ? 2 : 0) + (c?.name === 'kserve-container' ? 3 : 0);
      return { c, server, gpus, score };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0];
    const serves = SERVING.has(best.server) || isvc || best.gpus > 0 || podGpus > 0;
    if (!serves || /jupyter|notebook/i.test(best.c?.image || '')) continue;
    const model = detectModel(p, best.c, isvcs);
    const server = isvc && !SERVING.has(best.server) ? 'KServe' : (best.server === 'Container' ? model.server : best.server);
    const ref = (p?.metadata?.ownerReferences || [])[0];
    out.push({
      namespace: p?.metadata?.namespace || 'default',
      pod: p?.metadata?.name,
      container: best.c?.name,
      node: p?.spec?.nodeName || '—',
      gpus: best.gpus || podGpus,
      image: best.c?.image || '',
      server,
      model,
      startedAt: p?.status?.startTime || p?.metadata?.creationTimestamp,
      owner: ref ? `${ref.kind}/${ref.name}` : undefined,
      endpoints: server === 'Ollama' ? [] : metricsEndpoints(p, best.c, server),
      unsupported: server === 'Ollama' ? 'Ollama publishes no Prometheus metrics, so tokens cannot be counted from outside.' : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing: one normalized shape out of four servers' metric names
// ---------------------------------------------------------------------------

export interface Hist { sum: number; count: number; buckets: Array<{ le: number; count: number }> }

export interface ServedMetrics {
  /** From the metric labels (model_name / model); undefined when the server does not label. */
  model?: string;
  family: 'vllm' | 'nim' | 'tgi' | 'triton';
  promptTokens?: number;
  generationTokens?: number;
  requestsOk?: number;
  requestsFailed?: number;
  running?: number;
  waiting?: number;
  /** KV-cache utilization, 0–100. */
  kvCachePct?: number;
  preemptions?: number;
  /** Triton: inferences (a request may batch several). */
  inferences?: number;
  ttft?: Hist;
  e2e?: Hist;
  tpot?: Hist;
  queue?: Hist;
}

type Field = 'promptTokens' | 'generationTokens' | 'requestsOk' | 'requestsFailed' | 'preemptions' | 'inferences' | 'running' | 'waiting' | 'kvCachePct';
type HistField = 'ttft' | 'e2e' | 'tpot' | 'queue';

/** Normalized metric name (vllm: prefix removed) → field. Counters and gauges are summed across label variants. */
const SCALARS: Record<string, Field> = {
  prompt_tokens_total: 'promptTokens',
  generation_tokens_total: 'generationTokens',
  request_success_total: 'requestsOk',
  request_failure_total: 'requestsFailed',
  num_preemptions_total: 'preemptions',
  num_requests_running: 'running',
  num_requests_waiting: 'waiting',
  gpu_cache_usage_perc: 'kvCachePct',
  kv_cache_usage_perc: 'kvCachePct',
  tgi_request_input_length_sum: 'promptTokens',
  tgi_request_generated_tokens_sum: 'generationTokens',
  tgi_request_success: 'requestsOk',
  tgi_request_failure: 'requestsFailed',
  tgi_queue_size: 'waiting',
  tgi_batch_current_size: 'running',
  nv_inference_request_success: 'requestsOk',
  nv_inference_request_failure: 'requestsFailed',
  nv_inference_count: 'inferences',
  nv_inference_pending_request_count: 'waiting',
};
const HISTS: Record<string, HistField> = {
  time_to_first_token_seconds: 'ttft',
  e2e_request_latency_seconds: 'e2e',
  time_per_output_token_seconds: 'tpot',
  inter_token_latency_seconds: 'tpot',
  request_queue_time_seconds: 'queue',
  tgi_request_duration: 'e2e',
  tgi_request_mean_time_per_token_duration: 'tpot',
  tgi_request_queue_duration: 'queue',
};
const MODEL_LABELS = ['model_name', 'model', 'served_model_name'];

const familyOf = (raw: string): ServedMetrics['family'] | undefined =>
  raw.startsWith('vllm:') ? 'vllm' : raw.startsWith('tgi_') ? 'tgi' : raw.startsWith('nv_inference') ? 'triton' : undefined;

/** Turn one /metrics body into one entry per served model. Empty when nothing recognizable is there. */
export function parseServingMetrics(text: string): ServedMetrics[] {
  const samples: PromSample[] = parsePromText(text);
  const groups = new Map<string, ServedMetrics & { _h: Partial<Record<HistField, Map<number, number> & { sum?: number; count?: number }>> }>();
  let fam: ServedMetrics['family'] | undefined;
  for (const s of samples) {
    const f = familyOf(s.name);
    if (f && !fam) fam = f;
  }
  const group = (labels: Record<string, string>) => {
    const model = MODEL_LABELS.map((k) => labels[k]).find((v) => v);
    const key = model || '';
    let g = groups.get(key);
    if (!g) { g = { model, family: fam || 'nim', _h: {} }; groups.set(key, g); }
    return g;
  };

  for (const s of samples) {
    const name = s.name.replace(/^vllm:/, '');
    const scalar = SCALARS[name];
    if (scalar) {
      const g = group(s.labels);
      if (scalar === 'kvCachePct') g.kvCachePct = Math.max(g.kvCachePct ?? 0, s.value <= 1 ? s.value * 100 : s.value);
      else g[scalar] = (g[scalar] ?? 0) + s.value;
      continue;
    }
    const m = name.match(/^(.*)_(bucket|sum|count)$/);
    const h = m && HISTS[m[1]];
    if (!h) continue;
    const g = group(s.labels);
    const acc = (g._h[h] ||= Object.assign(new Map<number, number>(), { sum: 0, count: 0 }));
    if (m![2] === 'sum') acc.sum = (acc.sum || 0) + s.value;
    else if (m![2] === 'count') acc.count = (acc.count || 0) + s.value;
    else {
      const le = s.labels.le === '+Inf' ? Infinity : Number(s.labels.le);
      if (!Number.isNaN(le)) acc.set(le, (acc.get(le) || 0) + s.value);
    }
  }

  const out: ServedMetrics[] = [];
  for (const g of groups.values()) {
    const { _h, ...rest } = g;
    for (const [k, acc] of Object.entries(_h) as Array<[HistField, Map<number, number> & { sum?: number; count?: number }]>) {
      rest[k] = { sum: acc.sum || 0, count: acc.count || 0, buckets: [...acc.entries()].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le) };
    }
    const meaningful = rest.promptTokens !== undefined || rest.generationTokens !== undefined || rest.requestsOk !== undefined ||
      rest.running !== undefined || rest.waiting !== undefined || rest.ttft || rest.e2e;
    if (meaningful) out.push(rest);
  }
  // A labelled group and an unlabelled one from the same server: the unlabelled one is
  // usually process-wide gauges. Fold it into the single labelled model when there is one.
  // With several labelled models they cannot be attributed, and are dropped rather than
  // shown as a phantom extra "model".
  const unl = out.find((x) => !x.model);
  const lab = out.filter((x) => x.model);
  if (unl && lab.length) {
    if (lab.length === 1) for (const k of ['running', 'waiting', 'kvCachePct', 'preemptions'] as const) if (lab[0][k] === undefined && unl[k] !== undefined) lab[0][k] = unl[k];
    if (unl.promptTokens === undefined && unl.generationTokens === undefined && unl.requestsOk === undefined) out.splice(out.indexOf(unl), 1);
  }
  return out;
}

/** Prometheus' histogram_quantile: linear interpolation inside the bucket the rank falls in. */
export function histQuantile(q: number, h?: Hist): number | undefined {
  if (!h || !h.buckets.length) return undefined;
  const b = [...h.buckets].sort((a, c) => a.le - c.le);
  const total = b[b.length - 1].count;
  if (!total) return undefined;
  const rank = q * total;
  let prevLe = 0, prevCount = 0;
  for (const x of b) {
    if (x.count >= rank) {
      if (x.le === Infinity) return prevLe || undefined;
      const inBucket = x.count - prevCount;
      return inBucket > 0 ? prevLe + (x.le - prevLe) * ((rank - prevCount) / inBucket) : x.le;
    }
    prevLe = x.le; prevCount = x.count;
  }
  return prevLe;
}

export const histMean = (h?: Hist) => (h && h.count > 0 ? h.sum / h.count : undefined);

export function mergeHist(a?: Hist, b?: Hist): Hist | undefined {
  if (!a) return b && { ...b, buckets: [...b.buckets] };
  if (!b) return a;
  const m = new Map<number, number>();
  for (const x of [...a.buckets, ...b.buckets]) m.set(x.le, (m.get(x.le) || 0) + x.count);
  return { sum: a.sum + b.sum, count: a.count + b.count, buckets: [...m.entries()].map(([le, count]) => ({ le, count })).sort((x, y) => x.le - y.le) };
}

// ---------------------------------------------------------------------------
// History: Trinetra's own samples of the counters, for windows and rates
// ---------------------------------------------------------------------------

/** Per replica-model key: [promptTokens, generationTokens, requestsOk, requestsFailed, ttftSum, ttftCount]. */
export type Counters = [number, number, number, number, number, number];
export interface UsageLine { at: number; c: Record<string, Counters> }

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'local';
const fileFor = (source: string) => path.join(METRICS_DIR, `models-${safe(source)}.jsonl`);
export const USAGE_RETENTION_DAYS = Math.max(1, Number(process.env.TRINETRA_MODEL_RETENTION_DAYS || 8));

export async function appendUsage(source: string, line: UsageLine): Promise<void> {
  if (!Object.keys(line.c).length) return;
  await fs.mkdir(METRICS_DIR, { recursive: true }).catch(() => {});
  await fs.appendFile(fileFor(source), JSON.stringify(line) + '\n', 'utf-8');
}

export async function readUsage(source: string, sinceMs: number): Promise<UsageLine[]> {
  let raw = '';
  try { raw = await fs.readFile(fileFor(source), 'utf-8'); } catch { return []; }
  const out: UsageLine[] = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { const x = JSON.parse(l) as UsageLine; if (typeof x?.at === 'number' && x.at >= sinceMs) out.push(x); } catch { /* torn line */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function pruneUsage(source: string, now = Date.now()): Promise<void> {
  const keep = await readUsage(source, now - USAGE_RETENTION_DAYS * 86_400_000);
  const tmp = `${fileFor(source)}.tmp`;
  await fs.writeFile(tmp, keep.map((l) => JSON.stringify(l)).join('\n') + (keep.length ? '\n' : ''), 'utf-8');
  await fs.rename(tmp, fileFor(source));
}

/**
 * How much each counter grew over a run of samples. A counter that went DOWN
 * means the server restarted: its new value is all growth since then. Gaps
 * longer than `maxGapMs` are not bridged — growth across an unobserved day is
 * unknown, not zero, and is reported through `coveredMs`.
 */
export function growth(lines: UsageLine[], key: string, maxGapMs = 3 * 3600_000): { delta: Counters; coveredMs: number } {
  const delta: Counters = [0, 0, 0, 0, 0, 0];
  let prev: { at: number; c: Counters } | undefined;
  let coveredMs = 0;
  for (const l of lines) {
    const c = l.c[key];
    if (!c) continue;
    if (prev && l.at - prev.at <= maxGapMs) {
      for (let i = 0; i < 6; i++) delta[i] += c[i] >= prev.c[i] ? c[i] - prev.c[i] : c[i];
      coveredMs += l.at - prev.at;
    }
    prev = { at: l.at, c };
  }
  return { delta, coveredMs };
}

/** Generation tokens per second over time, `max` buckets, for a sparkline. */
export function tokenSeries(lines: UsageLine[], keys: string[], sinceMs: number, nowMs: number, max = 48): Array<{ t: number; v: number | null }> {
  const span = Math.max(1, nowMs - sinceMs);
  const width = span / max;
  const tokens = new Array(max).fill(0);
  const seen = new Array(max).fill(0);
  const last = new Map<string, { at: number; g: number }>();
  for (const l of lines) {
    for (const k of keys) {
      const c = l.c[k];
      if (!c) continue;
      const p = last.get(k);
      if (p && l.at - p.at <= 3 * 3600_000 && l.at >= sinceMs) {
        const i = Math.min(max - 1, Math.max(0, Math.floor((l.at - sinceMs) / width)));
        tokens[i] += c[1] >= p.g ? c[1] - p.g : c[1];
        seen[i] += (l.at - p.at) / 1000;
      }
      last.set(k, { at: l.at, g: c[1] });
    }
  }
  return tokens.map((t, i) => ({ t: Math.round(sinceMs + i * width), v: seen[i] ? Math.round((t / seen[i]) * 10) / 10 : null }));
}

// ---------------------------------------------------------------------------
// Rows: one per served model, replicas folded in
// ---------------------------------------------------------------------------

export interface ReplicaUsage {
  key: string;
  namespace: string;
  pod: string;
  container: string;
  node: string;
  gpus: number;
  server: string;
  startedAt?: string;
  endpoint?: string;
  error?: string;
  metrics?: ServedMetrics;
}

export interface WindowUsage { promptTokens: number; generationTokens: number; requestsOk: number; requestsFailed: number; ttftMs?: number; coveredHours: number }

export interface ModelRow {
  id: string;
  model: string;
  namespace: string;
  server: string;
  replicas: ReplicaUsage[];
  gpus: number;
  readable: number;
  /** Since each replica's server started. */
  lifetime: { promptTokens: number; generationTokens: number; requestsOk: number; requestsFailed: number; inferences?: number };
  now: { running: number; waiting: number; kvCachePct?: number; outTokPerSec?: number; inTokPerSec?: number };
  latency: { ttftP50Ms?: number; ttftP95Ms?: number; ttftAvgMs?: number; e2eP50Ms?: number; e2eP95Ms?: number; tpotMs?: number; queueP95Ms?: number };
  hour?: WindowUsage;
  day?: WindowUsage;
  week?: WindowUsage;
  series: Array<{ t: number; v: number | null }>;
  tokensReported: boolean;
}

export interface ModelFinding { id: string; severity: 'critical' | 'warning' | 'info'; model: string; title: string; detail: string; hint?: string }

const ms = (s?: number) => (s === undefined ? undefined : Math.round(s * 1000));

export function counters(m: ServedMetrics): Counters {
  return [m.promptTokens ?? 0, m.generationTokens ?? 0, m.requestsOk ?? 0, m.requestsFailed ?? 0, m.ttft?.sum ?? 0, m.ttft?.count ?? 0];
}

/** Key for history: one replica serving one model. */
export const replicaKey = (r: { namespace: string; pod: string }, model: string) => `${r.namespace}/${r.pod}|${model}`;

/** This read's counters as one more sample, so windows run up to now rather than to the last stored line. */
export function currentLine(scraped: Array<{ target: ServingTarget; served: ServedMetrics[] }>, now: number): UsageLine {
  const line: UsageLine = { at: now, c: {} };
  for (const s of scraped) for (const m of s.served) line.c[replicaKey(s.target, m.model || s.target.model.model || s.target.pod)] = counters(m);
  return line;
}

export function buildRows(
  targets: ServingTarget[],
  scraped: Array<{ target: ServingTarget; endpoint?: string; served: ServedMetrics[]; error?: string }>,
  history: UsageLine[],
  now: number,
): ModelRow[] {
  const rows = new Map<string, ModelRow & { _ttft?: Hist; _e2e?: Hist; _tpot?: Hist; _queue?: Hist; _keys: string[] }>();
  const rowFor = (t: ServingTarget, model: string) => {
    const id = `${t.namespace}/${model}`;
    let r = rows.get(id);
    if (!r) {
      r = {
        id, model, namespace: t.namespace, server: t.server, replicas: [], gpus: 0, readable: 0,
        lifetime: { promptTokens: 0, generationTokens: 0, requestsOk: 0, requestsFailed: 0 },
        now: { running: 0, waiting: 0 }, latency: {}, series: [], tokensReported: false, _keys: [],
      };
      rows.set(id, r);
    }
    return r;
  };

  const last = history[history.length - 1];
  for (const s of scraped) {
    const t = s.target;
    const detected = t.model.model || t.pod;
    const served = s.served.length ? s.served : [undefined];
    served.forEach((m, i) => {
      const model = m?.model || detected;
      const r = rowFor(t, model);
      const key = replicaKey(t, model);
      r.replicas.push({
        key, namespace: t.namespace, pod: t.pod, container: t.container, node: t.node, gpus: i === 0 ? t.gpus : 0,
        server: t.server, startedAt: t.startedAt, endpoint: s.endpoint, error: m ? undefined : s.error, metrics: m,
      });
      if (i === 0) r.gpus += t.gpus;
      if (!m) return;
      r.readable++;
      r._keys.push(key);
      if (m.family === 'triton') r.server = r.server === 'Container' ? 'Triton' : r.server;
      r.tokensReported ||= m.promptTokens !== undefined || m.generationTokens !== undefined;
      r.lifetime.promptTokens += m.promptTokens ?? 0;
      r.lifetime.generationTokens += m.generationTokens ?? 0;
      r.lifetime.requestsOk += m.requestsOk ?? 0;
      r.lifetime.requestsFailed += m.requestsFailed ?? 0;
      if (m.inferences !== undefined) r.lifetime.inferences = (r.lifetime.inferences ?? 0) + m.inferences;
      r.now.running += m.running ?? 0;
      r.now.waiting += m.waiting ?? 0;
      if (m.kvCachePct !== undefined) r.now.kvCachePct = Math.max(r.now.kvCachePct ?? 0, Math.round(m.kvCachePct * 10) / 10);
      r._ttft = mergeHist(r._ttft, m.ttft);
      r._e2e = mergeHist(r._e2e, m.e2e);
      r._tpot = mergeHist(r._tpot, m.tpot);
      r._queue = mergeHist(r._queue, m.queue);
      // Rate right now: this read against the last stored sample of the same counters.
      const p = last?.c[key];
      if (p && now - last.at >= 10_000 && now - last.at <= 20 * 60_000) {
        const secs = (now - last.at) / 1000;
        const c = counters(m);
        const dOut = c[1] >= p[1] ? c[1] - p[1] : c[1];
        const dIn = c[0] >= p[0] ? c[0] - p[0] : c[0];
        r.now.outTokPerSec = Math.round(((r.now.outTokPerSec ?? 0) + dOut / secs) * 10) / 10;
        r.now.inTokPerSec = Math.round(((r.now.inTokPerSec ?? 0) + dIn / secs) * 10) / 10;
      }
    });
  }

  const withNow = [...history, currentLine(scraped, now)];
  const window = (keys: string[], sinceMs: number): WindowUsage | undefined => {
    const lines = withNow.filter((l) => l.at >= sinceMs);
    let covered = 0;
    const sum: Counters = [0, 0, 0, 0, 0, 0];
    for (const k of keys) {
      const g = growth(lines, k);
      for (let i = 0; i < 6; i++) sum[i] += g.delta[i];
      covered = Math.max(covered, g.coveredMs);
    }
    if (!covered) return undefined;
    return {
      promptTokens: sum[0], generationTokens: sum[1], requestsOk: sum[2], requestsFailed: sum[3],
      ttftMs: sum[5] ? Math.round((sum[4] / sum[5]) * 1000) : undefined,
      coveredHours: Math.round((covered / 3600_000) * 10) / 10,
    };
  };

  return [...rows.values()].map(({ _ttft, _e2e, _tpot, _queue, _keys, ...r }) => ({
    ...r,
    latency: {
      ttftP50Ms: ms(histQuantile(0.5, _ttft)), ttftP95Ms: ms(histQuantile(0.95, _ttft)), ttftAvgMs: ms(histMean(_ttft)),
      e2eP50Ms: ms(histQuantile(0.5, _e2e)), e2eP95Ms: ms(histQuantile(0.95, _e2e)),
      tpotMs: ms(histMean(_tpot)), queueP95Ms: ms(histQuantile(0.95, _queue)),
    },
    hour: window(_keys, now - 3600_000),
    day: window(_keys, now - 86_400_000),
    week: window(_keys, now - 7 * 86_400_000),
    series: tokenSeries(withNow, _keys, now - 6 * 3600_000, now, 48),
  })).sort((a, b) => (b.day?.generationTokens ?? b.lifetime.generationTokens) - (a.day?.generationTokens ?? a.lifetime.generationTokens) || a.model.localeCompare(b.model));
}

/** What deserves a person's attention in the usage numbers. */
export function usageFindings(rows: ModelRow[]): ModelFinding[] {
  const out: ModelFinding[] = [];
  for (const r of rows) {
    const label = `${r.model} (${r.namespace})`;
    if (!r.readable) {
      const why = r.replicas.map((x) => x.error).find(Boolean) || 'no metrics endpoint answered';
      out.push({ id: `nometrics:${r.id}`, severity: 'info', model: r.model, title: `${label}: usage not readable`, detail: why,
        hint: 'Expose /metrics on the serving container (vLLM, NIM and TGI do by default) and allow get on pods/proxy.' });
      continue;
    }
    if (r.now.waiting > 0 && (r.now.kvCachePct ?? 0) >= 90) {
      out.push({ id: `queue-kv:${r.id}`, severity: 'warning', model: r.model, title: `${label}: requests are queuing and the KV cache is full`,
        detail: `${r.now.waiting} waiting, ${r.now.running} running, KV cache ${r.now.kvCachePct}%. New requests wait until running ones finish.`,
        hint: 'Add replicas, or lower max context / max concurrent sequences.' });
    } else if (r.now.waiting >= 5) {
      out.push({ id: `queue:${r.id}`, severity: 'warning', model: r.model, title: `${label}: ${r.now.waiting} requests waiting`,
        detail: `${r.now.running} running. Users see this as slow first tokens.`, hint: 'Add replicas or GPUs to this model.' });
    }
    const w = r.day && r.day.requestsOk + r.day.requestsFailed >= 20 ? r.day : undefined;
    const ok = w ? w.requestsOk : r.lifetime.requestsOk;
    const bad = w ? w.requestsFailed : r.lifetime.requestsFailed;
    if (ok + bad >= 20 && bad / (ok + bad) >= 0.05) {
      out.push({ id: `fail:${r.id}`, severity: bad / (ok + bad) >= 0.2 ? 'critical' : 'warning', model: r.model,
        title: `${label}: ${Math.round((bad / (ok + bad)) * 100)}% of requests fail`,
        detail: `${bad} failed of ${ok + bad} ${w ? 'in the last 24 h' : 'since the server started'}.`, hint: 'Check the serving container logs (Host Logs / kubectl logs).' });
    }
    if (r.gpus > 0 && r.day && r.day.coveredHours >= 6 && r.day.requestsOk + r.day.requestsFailed === 0 && r.day.generationTokens === 0) {
      out.push({ id: `idle:${r.id}`, severity: 'warning', model: r.model, title: `${label}: no requests in ${r.day.coveredHours} h while holding ${r.gpus} GPU${r.gpus === 1 ? '' : 's'}`,
        detail: 'The GPUs are reserved for a model nobody is calling.', hint: 'Scale it to zero (KServe minReplicas: 0) or remove it.' });
    }
    if ((r.latency.ttftP95Ms ?? 0) >= 5000) {
      out.push({ id: `ttft:${r.id}`, severity: 'warning', model: r.model, title: `${label}: slow first token (p95 ${(r.latency.ttftP95Ms! / 1000).toFixed(1)} s)`,
        detail: 'Since the server started. Long prompts, queueing or a full KV cache are the usual causes.' });
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

const PARALLEL = Math.max(1, Number(process.env.TRINETRA_GPU_PARALLEL || 8));
const MAX_TARGETS = Math.max(1, Number(process.env.TRINETRA_MODEL_MAX || 64));
let writes = 0;

async function collectUsage(vm: string | undefined) {
  const inv = await runSteps(
    [
      { tag: 'PODS', args: ['get', 'pods', '--all-namespaces', '-o', 'json'] },
      { tag: 'ISVC', args: ['get', 'inferenceservices.serving.kserve.io', '--all-namespaces', '-o', 'json'], optional: true },
    ],
    vm, 90_000, 1024 * 1024 * 128,
  );
  const pods = parseJson(inv.out.PODS)?.items;
  if (!Array.isArray(pods)) return { error: inv.error || 'Could not list pods on this cluster.', models: [], findings: [] };
  const isvcs = new Map<string, any>();
  for (const i of parseJson(inv.out.ISVC)?.items || []) isvcs.set(`${i?.metadata?.namespace}/${i?.metadata?.name}`, i);

  const targets = servingTargets(pods, isvcs).slice(0, MAX_TARGETS);
  const scraped: Array<{ target: ServingTarget; endpoint?: string; served: ServedMetrics[]; error?: string }> =
    targets.map((target) => ({ target, served: [], error: target.unsupported || (target.endpoints.length ? undefined : 'No port declared to read /metrics from.') }));

  // Up to three rounds: each target's next candidate endpoint, only for those still unread.
  for (let round = 0; round < 3; round++) {
    const todo = scraped.map((s, i) => ({ s, i })).filter(({ s }) => !s.served.length && !s.target.unsupported && s.target.endpoints[round]);
    if (!todo.length) break;
    const steps: Step[] = todo.map(({ s, i }) => {
      const e = s.target.endpoints[round];
      return { tag: `M${i}`, args: ['get', '--raw', `/api/v1/namespaces/${s.target.namespace}/pods/${s.target.pod}:${e.port}/proxy${e.path}`], optional: true };
    });
    const r = await runSteps(steps, vm, 60_000, 1024 * 1024 * 32, { parallel: PARALLEL, stepTimeoutSec: 15 });
    for (const { s, i } of todo) {
      const e = s.target.endpoints[round];
      const body = r.out[`M${i}`] || '';
      const served = parseServingMetrics(body);
      if (served.length) { s.served = served; s.endpoint = `:${e.port}${e.path} (${e.why})`; s.error = undefined; }
      else s.error = body.trim()
        ? `:${e.port}${e.path} answered, but with no recognizable model-server metrics.`
        : `No answer from :${e.port}${e.path}${r.error && !Object.keys(r.out).length ? ` (${r.error.split('\n')[0].slice(0, 160)})` : ''}.`;
    }
  }

  const source = vm || 'local';
  const now = Date.now();
  let history: UsageLine[] = [];
  try { history = await readUsage(source, now - 7 * 86_400_000); } catch { /* history is a bonus */ }
  const rows = buildRows(targets, scraped, history, now);

  const line = currentLine(scraped, now);
  try {
    await appendUsage(source, line);
    if (++writes % 100 === 0) await pruneUsage(source);
  } catch { /* a read-only disk must not fail the page */ }

  const findings = usageFindings(rows);
  const sum = (f: (r: ModelRow) => number | undefined) => rows.reduce((a, r) => a + (f(r) || 0), 0);
  const firstSample = history[0]?.at;
  return {
    ok: true, readOnly: true,
    models: rows,
    findings,
    totals: {
      models: rows.length,
      readable: rows.filter((r) => r.readable).length,
      replicas: sum((r) => r.replicas.length),
      gpus: sum((r) => r.gpus),
      lifetime: { promptTokens: sum((r) => r.lifetime.promptTokens), generationTokens: sum((r) => r.lifetime.generationTokens), requestsOk: sum((r) => r.lifetime.requestsOk), requestsFailed: sum((r) => r.lifetime.requestsFailed) },
      day: rows.some((r) => r.day) ? { promptTokens: sum((r) => r.day?.promptTokens), generationTokens: sum((r) => r.day?.generationTokens), requestsOk: sum((r) => r.day?.requestsOk), requestsFailed: sum((r) => r.day?.requestsFailed), coveredHours: Math.max(0, ...rows.map((r) => r.day?.coveredHours || 0)) } : undefined,
      now: { running: sum((r) => r.now.running), waiting: sum((r) => r.now.waiting), outTokPerSec: rows.some((r) => r.now.outTokPerSec !== undefined) ? Math.round(sum((r) => r.now.outTokPerSec) * 10) / 10 : undefined },
    },
    history: { since: firstSample ? new Date(firstSample).toISOString() : undefined, samples: history.length + 1 },
    at: new Date(now).toISOString(),
  };
}

const inFlight = new Map<string, ReturnType<typeof collectUsage>>();
export function modelUsage(vm: string | undefined) {
  const k = vm || 'local';
  let p = inFlight.get(k);
  if (!p) { p = collectUsage(vm).finally(() => inFlight.delete(k)); inFlight.set(k, p); }
  return p;
}

export const modelUsageRouter = Router();

/** GET /api/models/usage[?vm=name] — tokens, requests, latency per served model. */
modelUsageRouter.get('/api/models/usage', async (req, res) => {
  const vm = req.query.vm ? String(req.query.vm) : undefined;
  if (vm && !SAFE_NAME.test(vm)) return res.status(400).json({ error: 'Invalid VM name.' });
  try {
    res.json(await modelUsage(vm));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e), models: [], findings: [] });
  }
});

/**
 * Background sampling so "tokens in the last 24 h" covers hours nobody had the
 * page open. Cheap — one pod list plus one HTTP GET per model through the API
 * server, no exec — but still off unless asked for:
 * TRINETRA_MODEL_POLL_SEC=300, TRINETRA_MODEL_POLL_SOURCES=local,vm1
 */
let timer: NodeJS.Timeout | undefined;
export function startModelUsagePoller(): boolean {
  const sec = Number(process.env.TRINETRA_MODEL_POLL_SEC || 0);
  if (!sec || timer) return false;
  const sources = (process.env.TRINETRA_MODEL_POLL_SOURCES || 'local').split(',').map((s) => s.trim()).filter((s) => s === 'local' || SAFE_NAME.test(s));
  const tick = async () => { for (const s of sources) await modelUsage(s === 'local' ? undefined : s).catch(() => undefined); };
  timer = setInterval(() => void tick(), Math.max(60, sec) * 1000);
  timer.unref?.();
  void tick();
  return true;
}
