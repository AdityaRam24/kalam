// Embedding layer for the PCAI knowledge base.
// Supports Gemini (text-embedding-004) and local OpenAI-compatible servers
// (Ollama / LM Studio, e.g. nomic-embed-text). Both are optional: if no
// embedder is available the store falls back to lexical search, so the
// assistant still works with zero configuration.

import { GoogleGenAI } from '@google/genai';

export interface EmbedConfig {
  provider: 'gemini' | 'local' | 'none';
  model: string;
  apiKey?: string;
  localUrl?: string; // e.g. http://localhost:11434/v1
}

export const DEFAULT_GEMINI_EMBED_MODEL = 'text-embedding-004';
export const DEFAULT_LOCAL_EMBED_MODEL = 'nomic-embed-text';

// Resolve which embedder to use from the caller's chat settings + env.
export function resolveEmbedConfig(opts: {
  provider?: string;
  apiKey?: string;
  localUrl?: string;
  embedModel?: string;
}): EmbedConfig {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (opts.provider === 'local' && opts.localUrl) {
    return {
      provider: 'local',
      model: opts.embedModel || DEFAULT_LOCAL_EMBED_MODEL,
      localUrl: opts.localUrl,
    };
  }
  if (apiKey) {
    return {
      provider: 'gemini',
      model: opts.embedModel || DEFAULT_GEMINI_EMBED_MODEL,
      apiKey,
    };
  }
  // Last resort: a local server if one was given even without provider=local.
  if (opts.localUrl) {
    return {
      provider: 'local',
      model: opts.embedModel || DEFAULT_LOCAL_EMBED_MODEL,
      localUrl: opts.localUrl,
    };
  }
  return { provider: 'none', model: 'lexical' };
}

async function embedGemini(texts: string[], cfg: EmbedConfig): Promise<number[][]> {
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey! });
  const out: number[][] = [];
  // Embed sequentially in small batches to stay well under rate limits.
  for (const text of texts) {
    const resp: any = await ai.models.embedContent({
      model: cfg.model,
      contents: text,
    });
    // @google/genai returns { embeddings: [{ values: [...] }] }
    const values =
      resp?.embeddings?.[0]?.values ||
      resp?.embedding?.values ||
      resp?.embeddings?.values;
    if (!Array.isArray(values)) {
      throw new Error('Gemini embedding response had no vector values');
    }
    out.push(values as number[]);
  }
  return out;
}

// Embed one text via the OpenAI-compatible endpoint (LM Studio, Ollama /v1).
async function embedLocalOpenAI(text: string, base: string, model: string): Promise<number[]> {
  const resp = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  const values = data?.data?.[0]?.embedding || data?.embedding;
  if (!Array.isArray(values)) throw new Error('no vector values');
  return values as number[];
}

// Fallback: Ollama's native embeddings API (works even if /v1 is unavailable).
async function embedLocalOllamaNative(text: string, ollamaBase: string, model: string): Promise<number[]> {
  // Newer /api/embed (batch) first, then legacy /api/embeddings (single).
  try {
    const resp = await fetch(`${ollamaBase}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });
    if (resp.ok) {
      const data: any = await resp.json();
      const v = data?.embeddings?.[0];
      if (Array.isArray(v)) return v as number[];
    }
  } catch { /* try legacy */ }

  const resp = await fetch(`${ollamaBase}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  const values = data?.embedding;
  if (!Array.isArray(values)) throw new Error('no vector values');
  return values as number[];
}

async function embedLocal(texts: string[], cfg: EmbedConfig): Promise<number[][]> {
  const base = cfg.localUrl!.replace(/\/+$/, '');
  const ollamaBase = base.replace(/\/v1$/, '');
  const out: number[][] = [];
  for (const text of texts) {
    try {
      out.push(await embedLocalOpenAI(text, base, cfg.model));
    } catch (openaiErr: any) {
      // Fall back to Ollama's native API before giving up.
      try {
        out.push(await embedLocalOllamaNative(text, ollamaBase, cfg.model));
      } catch (nativeErr: any) {
        throw new Error(`Local embeddings failed (${openaiErr.message}; native: ${nativeErr.message})`);
      }
    }
  }
  return out;
}

// Returns one vector per input string, or null if no embedder is configured.
export async function embedTexts(
  texts: string[],
  cfg: EmbedConfig
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  if (cfg.provider === 'gemini') return embedGemini(texts, cfg);
  if (cfg.provider === 'local') return embedLocal(texts, cfg);
  return null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
