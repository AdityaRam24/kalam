// Model usage: four servers name the same numbers four ways, the endpoint has
// to be found without guessing wildly, and windows must survive a restart.

import { describe, it, expect } from 'vitest';
import {
  parseServingMetrics, histQuantile, histMean, mergeHist, metricsEndpoints, servingTargets, growth, tokenSeries,
  buildRows, usageFindings, replicaKey, counters, type UsageLine, type ServingTarget,
} from '../k8s/modelusage.js';

const L = 'meta-llama/Llama-3.1-8B-Instruct';
const VLLM = `
# HELP vllm:num_requests_running Number of requests currently running on GPU.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="${L}"} 3.0
vllm:num_requests_waiting{model_name="${L}"} 0.0
vllm:gpu_cache_usage_perc{model_name="${L}"} 0.42
vllm:num_preemptions_total{model_name="${L}"} 0.0
# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total{model_name="${L}"} 1234567.0
vllm:generation_tokens_total{model_name="${L}"} 345678.0
vllm:request_success_total{finished_reason="stop",model_name="${L}"} 1500.0
vllm:request_success_total{finished_reason="length",model_name="${L}"} 20.0
vllm:time_to_first_token_seconds_bucket{le="0.1",model_name="${L}"} 800.0
vllm:time_to_first_token_seconds_bucket{le="0.25",model_name="${L}"} 1200.0
vllm:time_to_first_token_seconds_bucket{le="0.5",model_name="${L}"} 1450.0
vllm:time_to_first_token_seconds_bucket{le="1.0",model_name="${L}"} 1500.0
vllm:time_to_first_token_seconds_bucket{le="2.5",model_name="${L}"} 1515.0
vllm:time_to_first_token_seconds_bucket{le="+Inf",model_name="${L}"} 1520.0
vllm:time_to_first_token_seconds_sum{model_name="${L}"} 380.0
vllm:time_to_first_token_seconds_count{model_name="${L}"} 1520.0
vllm:e2e_request_latency_seconds_bucket{le="1.0",model_name="${L}"} 200.0
vllm:e2e_request_latency_seconds_bucket{le="2.5",model_name="${L}"} 900.0
vllm:e2e_request_latency_seconds_bucket{le="5.0",model_name="${L}"} 1400.0
vllm:e2e_request_latency_seconds_bucket{le="10.0",model_name="${L}"} 1510.0
vllm:e2e_request_latency_seconds_bucket{le="+Inf",model_name="${L}"} 1520.0
vllm:e2e_request_latency_seconds_sum{model_name="${L}"} 4500.0
vllm:e2e_request_latency_seconds_count{model_name="${L}"} 1520.0
python_gc_objects_collected_total{generation="0"} 12345.0
`;

const NIM = `
num_requests_running{model_name="meta/llama-3.1-70b-instruct"} 1
num_requests_waiting{model_name="meta/llama-3.1-70b-instruct"} 7
gpu_cache_usage_perc{model_name="meta/llama-3.1-70b-instruct"} 0.97
prompt_tokens_total{model_name="meta/llama-3.1-70b-instruct"} 5000
generation_tokens_total{model_name="meta/llama-3.1-70b-instruct"} 2000
request_success_total{model_name="meta/llama-3.1-70b-instruct"} 90
request_failure_total{model_name="meta/llama-3.1-70b-instruct"} 30
`;

const TGI = `
tgi_request_success 100
tgi_request_failure{err="validation"} 2
tgi_request_input_length_bucket{le="+Inf"} 102
tgi_request_input_length_sum 52000
tgi_request_input_length_count 102
tgi_request_generated_tokens_sum 21000
tgi_request_generated_tokens_count 100
tgi_queue_size 0
tgi_batch_current_size 2
tgi_request_duration_bucket{le="0.5"} 10
tgi_request_duration_bucket{le="1"} 60
tgi_request_duration_bucket{le="+Inf"} 100
tgi_request_duration_sum 95
tgi_request_duration_count 100
`;

const TRITON = `
nv_inference_request_success{model="resnet50",version="1"} 400
nv_inference_request_failure{model="resnet50",version="1"} 0
nv_inference_count{model="resnet50",version="1"} 800
nv_inference_pending_request_count{model="resnet50",version="1"} 0
nv_gpu_utilization{gpu_uuid="GPU-1"} 0.3
`;

describe('parseServingMetrics', () => {
  it('vLLM: tokens, requests across finish reasons, gauges, histograms', () => {
    const [m] = parseServingMetrics(VLLM);
    expect(m).toMatchObject({
      model: L, family: 'vllm', promptTokens: 1234567, generationTokens: 345678, requestsOk: 1520,
      running: 3, waiting: 0, kvCachePct: 42, preemptions: 0,
    });
    expect(m.ttft).toMatchObject({ sum: 380, count: 1520 });
    expect(m.ttft!.buckets.at(-1)).toEqual({ le: Infinity, count: 1520 });
    // p50: rank 760 inside (0, 0.1] → 0.095 s ; p95: rank 1444 inside (0.25, 0.5] → 0.494 s
    expect(histQuantile(0.5, m.ttft)).toBeCloseTo(0.095, 3);
    expect(histQuantile(0.95, m.ttft)).toBeCloseTo(0.494, 3);
    expect(histMean(m.ttft)).toBeCloseTo(0.25);
    expect(histQuantile(0.95, m.e2e)).toBeCloseTo(7, 3); // rank 1444 inside (5, 10]
  });

  it('NIM: the same names without the vllm: prefix', () => {
    expect(parseServingMetrics(NIM)).toEqual([expect.objectContaining({
      model: 'meta/llama-3.1-70b-instruct', family: 'nim', promptTokens: 5000, generationTokens: 2000,
      requestsOk: 90, requestsFailed: 30, waiting: 7, running: 1, kvCachePct: 97,
    })]);
  });

  it('TGI: token totals come from histogram sums; no model label', () => {
    const [m] = parseServingMetrics(TGI);
    expect(m).toMatchObject({ family: 'tgi', promptTokens: 52000, generationTokens: 21000, requestsOk: 100, requestsFailed: 2, waiting: 0, running: 2 });
    expect(m.model).toBeUndefined();
    expect(histQuantile(0.5, m.e2e)).toBeCloseTo(0.9, 3); // rank 50 inside (0.5, 1]
  });

  it('Triton: requests and inferences, no tokens', () => {
    const [m] = parseServingMetrics(TRITON);
    expect(m).toMatchObject({ model: 'resnet50', family: 'triton', requestsOk: 400, requestsFailed: 0, inferences: 800, waiting: 0 });
    expect(m.promptTokens).toBeUndefined();
  });

  it('ignores endpoints that are not model servers', () => {
    expect(parseServingMetrics('process_cpu_seconds_total 12\ngo_goroutines 40\n')).toEqual([]);
    expect(parseServingMetrics('')).toEqual([]);
    expect(parseServingMetrics('<html>404</html>')).toEqual([]);
  });

  it('keeps several served models apart (LoRA adapters, multi-model servers)', () => {
    const two = parseServingMetrics(`
vllm:prompt_tokens_total{model_name="base"} 10
vllm:prompt_tokens_total{model_name="base-lora-sql"} 7
vllm:num_requests_running 2
`);
    expect(two.map((x) => [x.model, x.promptTokens])).toEqual([['base', 10], ['base-lora-sql', 7]]);
  });

  it('folds unlabelled process gauges into the single labelled model', () => {
    const [m, ...rest] = parseServingMetrics(`vllm:prompt_tokens_total{model_name="x"} 10\nvllm:num_requests_waiting 4\n`);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ model: 'x', promptTokens: 10, waiting: 4 });
  });
});

describe('histograms', () => {
  it('mergeHist adds buckets by bound', () => {
    const a = { sum: 1, count: 2, buckets: [{ le: 1, count: 1 }, { le: Infinity, count: 2 }] };
    const b = { sum: 3, count: 4, buckets: [{ le: 1, count: 3 }, { le: Infinity, count: 4 }] };
    expect(mergeHist(a, b)).toEqual({ sum: 4, count: 6, buckets: [{ le: 1, count: 4 }, { le: Infinity, count: 6 }] });
    expect(histQuantile(0.5, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const pod = (over: any = {}) => ({
  metadata: { name: 'llama-8b-7d9f-abcde', namespace: 'ai', labels: {}, annotations: {}, ownerReferences: [{ kind: 'ReplicaSet', name: 'llama-8b-7d9f' }], ...over.metadata },
  spec: { nodeName: 'gpu-1', containers: over.containers || [{ name: 'vllm', image: 'vllm/vllm-openai:v0.6.3', args: ['--model', L, '--port', '8080'], resources: { limits: { 'nvidia.com/gpu': '1' } } }] },
  status: { phase: over.phase || 'Running', startTime: '2026-11-20T08:00:00Z' },
});

describe('finding serving pods and their metrics endpoint', () => {
  it('vLLM honours --port', () => {
    const [t] = servingTargets([pod()], new Map());
    expect(t).toMatchObject({ namespace: 'ai', container: 'vllm', server: 'vLLM', gpus: 1, node: 'gpu-1' });
    expect(t.model.model).toBe(L);
    expect(t.endpoints[0]).toEqual({ port: 8080, path: '/metrics', why: 'vLLM default' });
  });

  it('KServe: the model container, its own metrics annotation first, never the queue-proxy', () => {
    const p = pod({
      metadata: { name: 'llama-predictor-00001-x', labels: { 'serving.kserve.io/inferenceservice': 'llama' },
        annotations: { 'prometheus.kserve.io/port': '8080', 'prometheus.kserve.io/path': '/metrics', 'prometheus.io/port': '9088' } },
      containers: [
        { name: 'queue-proxy', image: 'gcr.io/knative-releases/queue', ports: [{ name: 'http-queueadm', containerPort: 8022 }] },
        { name: 'kserve-container', image: 'kserve/huggingfaceserver:v0.14', ports: [{ containerPort: 8080, name: 'user-port' }], resources: { limits: { 'nvidia.com/gpu': 2 } } },
      ],
    });
    const [t] = servingTargets([p], new Map());
    expect(t).toMatchObject({ container: 'kserve-container', server: 'KServe', gpus: 2 });
    expect(t.endpoints.map((e) => `${e.port}${e.path}`)).toEqual(['8080/metrics', '9088/metrics']);
  });

  it('NIM tries /v1/metrics then /metrics on its server port', () => {
    const c = { name: 'nim', image: 'nvcr.io/nim/meta/llama-3.1-70b-instruct:1.3', env: [{ name: 'NIM_SERVER_PORT', value: '8000' }], resources: { limits: { 'nvidia.com/gpu': 4 } } };
    expect(metricsEndpoints({ metadata: {} }, c, 'NVIDIA NIM').map((e) => `${e.port}${e.path}`)).toEqual(['8000/v1/metrics', '8000/metrics']);
  });

  it('skips notebooks, pending pods and plain web servers; marks Ollama as unreadable', () => {
    const nb = pod({ containers: [{ name: 'nb', image: 'jupyter/pytorch-notebook', resources: { limits: { 'nvidia.com/gpu': 1 } } }] });
    const pending = pod({ phase: 'Pending' });
    const web = pod({ containers: [{ name: 'web', image: 'nginx:1.27', ports: [{ containerPort: 80 }] }] });
    const ollama = pod({ containers: [{ name: 'ollama', image: 'ollama/ollama:0.4', resources: { limits: { 'nvidia.com/gpu': 1 } } }] });
    const t = servingTargets([nb, pending, web, ollama], new Map());
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ server: 'Ollama', endpoints: [] });
    expect(t[0].unsupported).toMatch(/no Prometheus metrics/);
  });

  it('refuses annotation paths that are not plain paths', () => {
    const e = metricsEndpoints({ metadata: { annotations: { 'prometheus.io/port': '9000', 'prometheus.io/path': '/metrics?x=1&y=/../../secrets' } } }, { ports: [] }, 'Container');
    expect(e).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const H = 3600_000;
const line = (at: number, c: Record<string, number[]>): UsageLine => ({ at, c: c as any });

describe('windows from Trinetra\'s own samples', () => {
  it('growth sums deltas and treats a drop as a restart', () => {
    const lines = [
      line(0, { k: [100, 50, 10, 0, 1, 10] }),
      line(H, { k: [300, 150, 30, 1, 3, 30] }),
      line(2 * H, { k: [40, 20, 5, 0, 1, 5] }), // restarted: all of it is new
    ];
    expect(growth(lines, 'k')).toEqual({ delta: [240, 120, 25, 1, 3, 25], coveredMs: 2 * H });
  });

  it('does not bridge a long gap', () => {
    const lines = [line(0, { k: [0, 0, 0, 0, 0, 0] }), line(10 * H, { k: [1000, 1000, 1, 0, 0, 0] })];
    expect(growth(lines, 'k')).toEqual({ delta: [0, 0, 0, 0, 0, 0], coveredMs: 0 });
  });

  it('tokenSeries gives generation tokens per second per bucket', () => {
    const lines = [line(0, { k: [0, 0, 0, 0, 0, 0] }), line(1000_000, { k: [0, 100_000, 0, 0, 0, 0] })];
    const s = tokenSeries(lines, ['k'], 0, 2000_000, 2);
    expect(s).toEqual([{ t: 0, v: null }, { t: 1000_000, v: 100 }]);
  });
});

describe('rows and findings', () => {
  const target = (podName: string, gpus = 1): ServingTarget => ({
    namespace: 'ai', pod: podName, container: 'vllm', node: 'gpu-1', gpus, image: 'vllm/vllm-openai', server: 'vLLM',
    model: { model: L, server: 'vLLM', evidence: [] }, endpoints: [{ port: 8000, path: '/metrics', why: 'vLLM default' }],
  });

  it('folds replicas of one model into one row, with rate now and 24 h window', () => {
    const now = 100 * H;
    const [m] = parseServingMetrics(VLLM);
    const a = target('llama-a'), b = target('llama-b');
    const ka = replicaKey(a, L), kb = replicaKey(b, L);
    const prev = counters(m).map((x, i) => (i === 1 ? x - 60_000 : x)) as any; // 60k tokens ago
    const history = [line(now - 20 * H, { [ka]: [0, 0, 0, 0, 0, 0] }), line(now - 60_000, { [ka]: prev, [kb]: prev })];
    const rows = buildRows([a, b], [{ target: a, served: [m] }, { target: b, served: [m] }], history, now);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ model: L, namespace: 'ai', gpus: 2, readable: 2, tokensReported: true });
    expect(r.replicas).toHaveLength(2);
    expect(r.lifetime.generationTokens).toBe(2 * 345678);
    expect(r.now).toMatchObject({ running: 6, waiting: 0, kvCachePct: 42, outTokPerSec: 2000 }); // 2 × 60k / 60 s
    expect(r.latency.ttftP95Ms).toBe(494);
    // The 20 h gap before a's second sample is not bridged; the last minute is, for both replicas.
    expect(r.day!.generationTokens).toBe(120_000);
    expect(r.hour!.generationTokens).toBe(120_000);
  });

  it('flags queueing with a full KV cache, failures, idle GPUs and unreadable models', () => {
    const now = 100 * H;
    const nim = parseServingMetrics(NIM);
    const t1 = { ...target('nim-0', 4), model: { model: 'nim', server: 'NVIDIA NIM', evidence: [] } };
    const idle = target('idle-0', 2);
    const [vm] = parseServingMetrics(VLLM);
    const k = replicaKey(idle, L);
    const flat = counters(vm);
    const hist = Array.from({ length: 13 }, (_, i) => line(now - 12 * H + i * H, { [k]: flat }));
    const blind = { ...target('blind-0'), model: { model: 'mystery', server: 'Container', evidence: [] } };
    const rows = buildRows([t1, idle, blind], [
      { target: t1, served: nim },
      { target: idle, served: [vm] },
      { target: blind, served: [], error: 'No answer from :8000/metrics.' },
    ], hist, now);
    const f = usageFindings(rows);
    const ids = f.map((x) => x.id.split(':')[0]);
    expect(ids).toContain('queue-kv');
    expect(f.find((x) => x.id.startsWith('fail:'))!.severity).toBe('critical'); // 30 of 120 = 25%
    expect(f.find((x) => x.id.startsWith('idle:'))!.title).toMatch(/no requests in 12 h while holding 2 GPUs/);
    expect(f.find((x) => x.id.startsWith('nometrics:'))!.detail).toBe('No answer from :8000/metrics.');
    expect(f[0].severity).toBe('critical');
  });
});
