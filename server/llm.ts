// LLM provider utilities for Trinetra: discover locally-installed Ollama / LM Studio
// models so the user can *choose* one (no more typing a model name by hand), and
// pull new models on demand with live progress. Also classifies models into
// chat / embed / vision so the UI can offer the right model in the right place.
//
// Endpoints (mounted in server/index.ts):
//   GET  /api/llm/models?localUrl=...   -> list installed models (+ classification)
//   POST /api/llm/pull  { localUrl, name } (SSE) -> pull a model, stream progress

import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';

export const llmRouter = Router();

export interface DiscoveredModel {
  name: string;                 // e.g. "qwen2.5-coder:7b"
  size: number;                 // bytes (0 if unknown)
  sizeLabel: string;            // e.g. "4.7 GB"
  family: string;               // e.g. "qwen2"
  paramSize: string;            // e.g. "7.6B"
  quant: string;                // e.g. "Q4_K_M"
  kind: 'chat' | 'embed' | 'vision';
  modified: string | null;
}

// ---------------------------------------------------------------------------
// SSRF guard for caller-supplied model endpoints.
//
// Several routes fetch a URL the request chose (localUrl / authKey). Left open,
// the server is a proxy an unauthenticated caller can aim at internal services
// or the cloud metadata endpoint. This blocks the metadata address outright and,
// when TRINETRA_LLM_ALLOWED_HOSTS is set, restricts endpoints to that allowlist
// (comma-separated hostnames; a leading dot matches a domain and subdomains).
// ---------------------------------------------------------------------------
const BLOCKED_LLM_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', '[fd00:ec2::254]', 'fd00:ec2::254']);

export function llmUrlError(rawUrl: string | undefined): string | null {
  const url = (rawUrl || '').trim();
  if (!url) return null; // empty → the route falls back to its own default
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'Invalid endpoint URL.';
  }
  if (BLOCKED_LLM_HOSTS.has(host)) return 'That endpoint host is not permitted.';
  const allow = (process.env.TRINETRA_LLM_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allow.length) {
    const ok = allow.some((p) => (p.startsWith('.') ? host === p.slice(1) || host.endsWith(p) : host === p));
    if (!ok) return 'This endpoint host is not on the allowed list (TRINETRA_LLM_ALLOWED_HOSTS).';
  }
  return null;
}

// An endpoint may be given as http://host:11434/v1 (OpenAI-compatible) or the
// bare Ollama root http://host:11434. Return the bare root for native calls.
export function ollamaBase(localUrl?: string): string {
  const url = (localUrl || 'http://localhost:11434/v1').trim().replace(/\/+$/, '');
  return url.replace(/\/v1$/, '');
}

function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const EMBED_RE = /(embed|nomic|bge|minilm|mxbai|gte|e5|snowflake|arctic)/i;
const VISION_RE = /(moondream|llava|vision|clip|bakllava|llama-?3\.?2-vision|minicpm-?v)/i;

export function classifyModel(name: string, families: string[] = []): 'chat' | 'embed' | 'vision' {
  const hay = `${name} ${families.join(' ')}`;
  if (EMBED_RE.test(hay)) return 'embed';
  if (VISION_RE.test(hay)) return 'vision';
  return 'chat';
}

// Query the Ollama native tags API. Returns null if the endpoint isn't Ollama /
// isn't reachable, so callers can fall back to the OpenAI-compatible list.
async function listOllamaTags(base: string, authKey?: string, timeoutMs = 5000): Promise<DiscoveredModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/api/tags`, { signal: controller.signal, headers: authHeaders(authKey) });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (!Array.isArray(data?.models)) return null;
    return data.models.map((m: any): DiscoveredModel => {
      const families: string[] = m.details?.families || (m.details?.family ? [m.details.family] : []);
      const size = Number(m.size) || 0;
      return {
        name: m.name || m.model,
        size,
        sizeLabel: humanSize(size),
        family: m.details?.family || families[0] || '',
        paramSize: m.details?.parameter_size || '',
        quant: m.details?.quantization_level || '',
        kind: classifyModel(m.name || m.model || '', families),
        modified: m.modified_at || null,
      };
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI-compatible /models fallback (LM Studio, vLLM, or Ollama's /v1).
async function listOpenAIModels(localUrl: string, authKey?: string, timeoutMs = 5000): Promise<DiscoveredModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = localUrl.replace(/\/+$/, '');
    const resp = await fetch(`${base}/models`, { signal: controller.signal, headers: authHeaders(authKey) });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const rows = data?.data || data?.models || [];
    if (!Array.isArray(rows)) return null;
    return rows.map((m: any): DiscoveredModel => {
      const name = m.id || m.name || String(m);
      return {
        name,
        size: 0,
        sizeLabel: '—',
        family: '',
        paramSize: '',
        quant: '',
        kind: classifyModel(name),
        modified: null,
      };
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Bearer auth for hosted OpenAI-compatible endpoints (OpenAI, Groq, OpenRouter,
// Together, vLLM with --api-key, HPE MLIS...). Local servers just ignore it.
function authHeaders(authKey?: string): Record<string, string> {
  return authKey ? { Authorization: `Bearer ${authKey}` } : {};
}

export async function discoverModels(localUrl?: string, authKey?: string): Promise<{
  endpointUp: boolean;
  source: 'ollama' | 'openai' | 'none';
  models: DiscoveredModel[];
}> {
  const base = ollamaBase(localUrl);
  // Prefer the richer Ollama tags API (has sizes/params), then OpenAI /models.
  const ollama = await listOllamaTags(base, authKey);
  if (ollama) return { endpointUp: true, source: 'ollama', models: sortModels(ollama) };

  const openai = await listOpenAIModels(localUrl || `${base}/v1`, authKey);
  if (openai) return { endpointUp: true, source: 'openai', models: sortModels(openai) };

  return { endpointUp: false, source: 'none', models: [] };
}

function sortModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const kindRank = { chat: 0, embed: 1, vision: 2 } as const;
  return [...models].sort((a, b) => {
    if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
    return a.name.localeCompare(b.name);
  });
}

llmRouter.get('/api/llm/models', async (req, res) => {
  const localUrl = (req.query.localUrl as string) || undefined;
  const authKey = (req.query.authKey as string) || undefined;
  const blocked = llmUrlError(localUrl);
  if (blocked) return res.status(400).json({ ok: false, error: blocked, endpointUp: false, models: [] });
  try {
    const result = await discoverModels(localUrl, authKey);
    const chat = result.models.filter((m) => m.kind !== 'embed');
    const embed = result.models.filter((m) => m.kind === 'embed');
    res.json({
      ok: true,
      endpointUp: result.endpointUp,
      source: result.source,
      models: result.models,
      chatModels: chat,
      embedModels: embed,
      hasEmbed: embed.length > 0,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message, endpointUp: false, models: [] });
  }
});

// Pull an Ollama model, streaming progress as Server-Sent Events so the UI/CLI
// can show a live download bar. Body: { localUrl?, name }.
llmRouter.post('/api/llm/pull', async (req, res) => {
  const { localUrl, name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'A model name is required (e.g. "nomic-embed-text").' });
  }
  const blocked = llmUrlError(localUrl);
  if (blocked) return res.status(400).json({ error: blocked });
  const base = ollamaBase(localUrl);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const upstream = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });

    if (!upstream.ok || !upstream.body) {
      const t = upstream.body ? await upstream.text() : '';
      sse({ status: 'error', error: `Pull failed: HTTP ${upstream.status} ${t}`.trim() });
      sse('[DONE]');
      return res.end();
    }

    const reader = (upstream.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          // Ollama sends {status, digest?, total?, completed?}
          const pct =
            evt.total && evt.completed ? Math.round((evt.completed / evt.total) * 100) : undefined;
          sse({ status: evt.status || 'downloading', pct, total: evt.total, completed: evt.completed });
        } catch {
          /* ignore non-JSON keepalive lines */
        }
      }
    }
    sse({ status: 'success', pct: 100 });
    sse('[DONE]');
    res.end();
  } catch (e: any) {
    sse({ status: 'error', error: `Could not reach Ollama at ${base}: ${e.message}` });
    sse('[DONE]');
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Connection test: prove the configured AI engine actually answers, end to end,
// before the user discovers otherwise mid-conversation. Every failure comes
// back with the specific thing that went wrong (unreachable, token rejected,
// model missing) rather than a generic "error".
//
//   POST /api/llm/test { provider: 'gemini' | 'local', apiKey?, localUrl?, localModel?, authKey? }

interface LlmTestResult {
  ok: boolean;
  provider: 'gemini' | 'local';
  latencyMs: number;
  endpoint?: string;
  model?: string;
  reply?: string;
  modelsSeen?: number;
  error?: string;
  hint?: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Turn a raw fetch failure into what actually went wrong on the wire. The
// endpoint is often on a network the user has to join first (VPN, the PCAI
// management network), and "fetch failed" tells them nothing about that.
export function describeConnectError(base: string, err: any): { error: string; hint: string } {
  let host = base;
  let isLocal = false;
  let https = false;
  try {
    const u = new URL(base);
    host = u.host;
    https = u.protocol === 'https:';
    isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|$)/.test(u.host);
  } catch { /* leave defaults */ }

  const cause = err?.cause || err;
  const code: string = String(cause?.code || '').toUpperCase();
  const raw = String(cause?.message || err?.message || err || '');

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      error: `Cannot resolve host "${host}" (${code}).`,
      hint: isLocal
        ? 'Local DNS is broken - try 127.0.0.1 instead of localhost.'
        : 'This machine cannot look up that hostname. Connect to the network that hosts the endpoint (VPN / PCAI network) and test again, or use its IP address.',
    };
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || err?.name === 'AbortError') {
    return {
      error: `No answer from ${host} (${code || 'timeout'}).`,
      hint: isLocal
        ? 'The local server is not responding. Check it is running and not stuck.'
        : 'The host exists but nothing came back - typical when you are not on its network or a firewall is between you. Check the VPN, then the port.',
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      error: `${host} refused the connection (ECONNREFUSED).`,
      hint: isLocal
        ? `Nothing is listening at ${base}. Start the server (e.g. "ollama serve") or fix the URL.`
        : 'The host is reachable but nothing is listening on that port. Check the port in the URL and that the model server is up.',
    };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return {
      error: `Connection to ${host} was dropped (${code}).`,
      hint: 'The server closed the connection mid-request. If the URL is http:// but the server expects https:// (or the reverse), fix the scheme.',
    };
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|certificate/i.test(code + ' ' + raw)) {
    return {
      error: `TLS certificate for ${host} was rejected (${code || 'certificate error'}).`,
      hint: 'The endpoint uses a certificate this machine does not trust - common for internal MLIS deployments. Point NODE_EXTRA_CA_CERTS at your CA bundle when starting Trinetra, or (lab only) set NODE_TLS_REJECT_UNAUTHORIZED=0.',
    };
  }
  if (/wrong version number|ssl|tls/i.test(raw) && !https) {
    return {
      error: `${host} answered with TLS on a plain http:// URL.`,
      hint: 'Change the URL scheme to https://.',
    };
  }
  return {
    error: raw.slice(0, 300) || 'fetch failed',
    hint: isLocal
      ? `Nothing is listening at ${base}. Start the server (e.g. "ollama serve") or fix the URL.`
      : `Could not reach ${host}. Make sure you are on the network that hosts the endpoint (VPN / PCAI network) and that the URL and port are right.`,
  };
}

export async function testGemini(apiKey: string): Promise<LlmTestResult> {
  const started = Date.now();
  const model = 'gemini-3-flash-preview';
  if (!apiKey?.trim()) {
    return { ok: false, provider: 'gemini', latencyMs: 0, model, error: 'No Gemini API key entered.', hint: 'Paste the key from Google AI Studio (it starts with "AIzaSy").' };
  }
  try {
    const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
    const resp: any = await withTimeout(
      ai.models.generateContent({ model, contents: 'Reply with the single word OK.' }),
      20000,
      'Gemini',
    );
    const reply = String(resp?.text ?? resp?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    return { ok: true, provider: 'gemini', latencyMs: Date.now() - started, model, reply: reply.slice(0, 80) };
  } catch (e: any) {
    // The SDK wraps the API's JSON error body in the message; surface the
    // human sentence inside it rather than the whole envelope.
    let msg = String(e?.message || e);
    try {
      const inner = JSON.parse(msg)?.error?.message;
      if (typeof inner === 'string' && inner) msg = inner;
    } catch { /* not JSON, keep as-is */ }
    const lower = msg.toLowerCase();
    let hint = 'Check the key and that this machine can reach generativelanguage.googleapis.com.';
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('401') || lower.includes('403')) {
      hint = 'The key was rejected. Re-copy it from Google AI Studio and make sure the Generative Language API is enabled.';
    } else if (lower.includes('quota') || lower.includes('429')) {
      hint = 'The key works but is rate-limited or out of quota right now.';
    } else if (lower.includes('fetch failed') || lower.includes('enotfound') || lower.includes('econnrefused') || lower.includes('did not answer')) {
      hint = 'No route to Google. Expected on an air-gapped PCAI network - use a Local or Custom endpoint instead.';
    }
    return { ok: false, provider: 'gemini', latencyMs: Date.now() - started, model, error: msg.slice(0, 300), hint };
  }
}

export async function testLocal(localUrl: string, localModel: string, authKey?: string): Promise<LlmTestResult> {
  const started = Date.now();
  const base = (localUrl || 'http://localhost:11434/v1').trim().replace(/\/+$/, '');
  const endpoint = `${base}/chat/completions`;
  const model = (localModel || '').trim();
  if (!model) {
    return { ok: false, provider: 'local', latencyMs: 0, endpoint, error: 'No model name selected.', hint: 'Pick or type a model name first.' };
  }

  // Step 1: is anything listening, and does the token get past the door?
  const discovered = await discoverModels(base, authKey);
  const modelsSeen = discovered.models.length;
  const listed = discovered.models.some((m) => m.name === model || m.name.split(':')[0] === model.split(':')[0]);

  // Step 2: an actual completion with the chosen model - the only test that
  // proves chat will work. Tiny prompt, a handful of tokens, cheap anywhere.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...authHeaders(authKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: 5,
        temperature: 0,
        stream: false,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      let detail: string = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || (typeof parsed?.error === 'string' ? parsed.error : detail);
      } catch { /* keep raw */ }
      let hint = 'The endpoint answered but refused the request.';
      if (resp.status === 401 || resp.status === 403) hint = 'Token rejected. Check the API key / bearer token for this endpoint.';
      else if (resp.status === 404) hint = modelsSeen
        ? `Model "${model}" is not served here.${listed ? '' : ' Click "Detect models" and pick one of the listed names.'}`
        : `Nothing at ${endpoint}. Make sure the URL ends in /v1 for OpenAI-compatible servers.`;
      else if (resp.status === 400 && /model/i.test(detail)) hint = `Model "${model}" was not accepted. Use the exact name the server lists.`;
      return { ok: false, provider: 'local', latencyMs: Date.now() - started, endpoint, model, modelsSeen, error: `HTTP ${resp.status}: ${detail}`, hint };
    }
    let reply = '';
    try { reply = String(JSON.parse(text)?.choices?.[0]?.message?.content ?? '').trim(); } catch { reply = text.slice(0, 80); }
    return { ok: true, provider: 'local', latencyMs: Date.now() - started, endpoint, model, modelsSeen, reply: reply.slice(0, 80) };
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError';
    // The listing succeeded a moment ago, so the wire is fine and the problem
    // is the model itself; otherwise say what the network actually did.
    if (discovered.endpointUp) {
      const msg = timedOut ? 'The model did not answer within 30s.' : String(e?.message || e);
      const hint = timedOut
        ? 'The server is up but slow to load the model. Try once more; the first call after a cold start can take a minute.'
        : 'The server is up but the completion call failed. If this is Ollama, the model may still be loading - try again.';
      return { ok: false, provider: 'local', latencyMs: Date.now() - started, endpoint, model, modelsSeen, error: msg.slice(0, 300), hint };
    }
    const { error, hint } = describeConnectError(base, e);
    return { ok: false, provider: 'local', latencyMs: Date.now() - started, endpoint, model, modelsSeen, error, hint };
  } finally {
    clearTimeout(timer);
  }
}

// TRINETRA_LLM_ENABLED=false (Helm llm.enabled) turns every AI feature off for a
// deployment that has no model to talk to: the UI hides them and the server
// refuses their routes. Anything other than "false" leaves them on.
export function llmEnabled(): boolean {
  return process.env.TRINETRA_LLM_ENABLED !== 'false';
}

// Routes that reach a model. /api/llm/defaults stays open because it is how
// the UI learns the features are off.
export const LLM_ROUTES = [
  '/api/agent',
  '/api/pcai/chat',
  '/api/pcai/ingest',
  '/api/pcai/learn',
  // The learned-doc store is part of the PCAI brain: listing and deleting it
  // must be off when AI is off, not just the write path above. ('/api/pcai/learn'
  // does not prefix-match '/api/pcai/learned' — the segment differs — so it is
  // listed separately on purpose.)
  '/api/pcai/learned',
  '/api/llm/test',
  '/api/llm/models',
  '/api/llm/pull',
];

// Deployment-level engine defaults (TRINETRA_PROVIDER / TRINETRA_LOCAL_URL /
// TRINETRA_LOCAL_MODEL, set by the Helm chart). The UI applies them only where
// the browser has no saved choice, so an operator can point every fresh
// browser at the in-cluster model without anyone opening Settings.
llmRouter.get('/api/llm/defaults', (_req, res) => {
  const provider = process.env.TRINETRA_PROVIDER;
  res.json({
    enabled: llmEnabled(),
    provider: provider === 'gemini' || provider === 'local' ? provider : undefined,
    localUrl: process.env.TRINETRA_LOCAL_URL || undefined,
    localModel: process.env.TRINETRA_LOCAL_MODEL || undefined,
    geminiKeyConfigured: !!process.env.GEMINI_API_KEY,
  });
});

llmRouter.post('/api/llm/test', async (req, res) => {
  const { provider = 'gemini', apiKey, localUrl, localModel, authKey } = req.body || {};
  if (provider === 'local') {
    const blocked = llmUrlError(localUrl);
    if (blocked) return res.status(400).json({ ok: false, provider, latencyMs: 0, error: blocked });
  }
  try {
    const result = provider === 'local'
      ? await testLocal(String(localUrl || ''), String(localModel || ''), authKey ? String(authKey) : undefined)
      : await testGemini(String(apiKey || process.env.GEMINI_API_KEY || ''));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, provider, latencyMs: 0, error: String(e?.message || e) });
  }
});
