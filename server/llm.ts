// LLM provider utilities for Kalam: discover locally-installed Ollama / LM Studio
// models so the user can *choose* one (no more typing a model name by hand), and
// pull new models on demand with live progress. Also classifies models into
// chat / embed / vision so the UI can offer the right model in the right place.
//
// Endpoints (mounted in server/index.ts):
//   GET  /api/llm/models?localUrl=...   -> list installed models (+ classification)
//   POST /api/llm/pull  { localUrl, name } (SSE) -> pull a model, stream progress

import { Router } from 'express';

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
async function listOllamaTags(base: string, timeoutMs = 5000): Promise<DiscoveredModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/api/tags`, { signal: controller.signal });
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
async function listOpenAIModels(localUrl: string, timeoutMs = 5000): Promise<DiscoveredModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = localUrl.replace(/\/+$/, '');
    const resp = await fetch(`${base}/models`, { signal: controller.signal });
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

export async function discoverModels(localUrl?: string): Promise<{
  endpointUp: boolean;
  source: 'ollama' | 'openai' | 'none';
  models: DiscoveredModel[];
}> {
  const base = ollamaBase(localUrl);
  // Prefer the richer Ollama tags API (has sizes/params), then OpenAI /models.
  const ollama = await listOllamaTags(base);
  if (ollama) return { endpointUp: true, source: 'ollama', models: sortModels(ollama) };

  const openai = await listOpenAIModels(localUrl || `${base}/v1`);
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
  try {
    const result = await discoverModels(localUrl);
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
