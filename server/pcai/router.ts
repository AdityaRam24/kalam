// Express router for the HPE PCAI assistant.
//   GET  /api/pcai/status       -> knowledge base state
//   POST /api/pcai/ingest       -> build/refresh the knowledge base ("train")
//   POST /api/pcai/chat         -> grounded Q&A / error diagnosis over the KB
//   POST /api/pcai/chat/stream  -> same, streamed token-by-token (SSE)

import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { resolveEmbedConfig, embedTexts, EmbedConfig } from './embed.js';
import { loadKB, saveKB, searchKB, SearchHit, KnowledgeBase, chunkText, tokenize, loadLearned, saveLearned, LearnedDoc } from './store.js';
import { runIngest } from './ingest.js';

export const pcaiRouter = Router();

let ingesting = false;
let lastIngestLog: string[] = [];

pcaiRouter.get('/api/pcai/status', async (_req, res) => {
  const kb = await loadKB();
  res.json({
    ready: !!kb,
    ingesting,
    chunks: kb?.chunks.length || 0,
    embedProvider: kb?.embedProvider || 'none',
    embedModel: kb?.embedModel || 'lexical',
    updatedAt: kb?.updatedAt || null,
    sources: kb ? uniqueSources(kb.chunks) : [],
    lastIngestLog,
  });
});

function uniqueSources(chunks: { title: string; url: string }[]) {
  const seen = new Map<string, { title: string; url: string; chunks: number }>();
  for (const c of chunks) {
    const key = c.url;
    if (!seen.has(key)) seen.set(key, { title: c.title, url: c.url, chunks: 0 });
    seen.get(key)!.chunks++;
  }
  return Array.from(seen.values());
}

pcaiRouter.post('/api/pcai/ingest', async (req, res) => {
  if (ingesting) {
    return res.status(409).json({ error: 'Ingestion already in progress' });
  }
  const {
    provider,
    apiKey,
    localUrl,
    embedModel,
    crawl = true,
    maxPages = 40,
  } = req.body || {};

  const embed = resolveEmbedConfig({ provider, apiKey, localUrl, embedModel });

  ingesting = true;
  lastIngestLog = [];
  try {
    const result = await runIngest({
      embed,
      crawl,
      maxPages,
      onProgress: (m) => {
        lastIngestLog.push(m);
        if (lastIngestLog.length > 500) lastIngestLog.shift();
      },
    });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('PCAI ingest error:', e);
    res.status(500).json({ error: 'Ingestion failed', details: e.message, log: lastIngestLog });
  } finally {
    ingesting = false;
  }
});

// ---------------------------------------------------------------------------
// Learning loop: absorb any document the user gives us (runbook, log dump,
// activity diagram exported as text/mermaid, postmortem...) directly into the
// live knowledge base, and persist it so retrains keep it. Solved diagnoses
// are auto-captured through the same path (kind: 'case').
// ---------------------------------------------------------------------------
export function guessKind(title: string, text: string): string {
  const hay = `${title}\n${text.slice(0, 2000)}`.toLowerCase();
  if (/```mermaid|flowchart|sequencediagram|activity diagram|graph (td|lr)/.test(hay)) return 'diagram';
  if (/runbook|standard operating|sop\b|procedure|step 1|remediation/.test(hay)) return 'runbook';
  if (/traceback|exception|error|crashloop|oomkilled|\bwarn\b|\bfatal\b|stack trace/.test(hay)) return 'log';
  return 'note';
}

export async function learnDocument(opts: {
  title: string; text: string; kind?: string;
  apiKey?: string; localUrl?: string;
}): Promise<{ ok: boolean; chunksAdded: number; kind: string; embedded: boolean; error?: string }> {
  const title = (opts.title || 'Untitled').slice(0, 160);
  const text = (opts.text || '').trim();
  if (text.length < 20) return { ok: false, chunksAdded: 0, kind: 'note', embedded: false, error: 'Document too short to learn from.' };

  const kind = opts.kind || guessKind(title, text);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'doc';
  const url = `learned://${kind}/${slug}-${Date.now().toString(36)}`;

  // Persist the raw doc so retrains re-include it.
  const learned = await loadLearned();
  learned.push({ title, url, text, kind, addedAt: new Date().toISOString() });
  // Keep the store bounded: uploads are precious, auto-cases rotate at 200.
  const cases = learned.filter((d) => d.kind === 'case');
  if (cases.length > 200) {
    const drop = new Set(cases.slice(0, cases.length - 200).map((d) => d.url));
    await saveLearned(learned.filter((d) => !drop.has(d.url)));
  } else {
    await saveLearned(learned);
  }

  // Hot-append chunks to the live KB (create a lexical-only KB if none yet).
  let kb = await loadKB();
  if (!kb) {
    const now = new Date().toISOString();
    kb = { version: 1, createdAt: now, updatedAt: now, embedProvider: 'none', embedModel: 'lexical', chunks: [] };
  }
  const parts = chunkText(text);
  const newChunks = parts.map((t, i) => ({
    id: `learn-${Date.now().toString(36)}-${i}`,
    title, url, text: t,
    tokens: tokenize(`${title} ${t}`),
  }));

  // Embed with the same provider the KB uses, best effort.
  let embedded = false;
  if (kb.embedProvider !== 'none') {
    const cfg: EmbedConfig = kb.embedProvider === 'gemini'
      ? { provider: 'gemini', model: kb.embedModel, apiKey: opts.apiKey || process.env.GEMINI_API_KEY }
      : { provider: 'local', model: kb.embedModel, localUrl: opts.localUrl };
    try {
      const vectors = await embedTexts(newChunks.map((c) => c.text), cfg);
      if (vectors) { vectors.forEach((v, i) => ((newChunks[i] as any).embedding = v)); embedded = true; }
    } catch { /* lexical still works */ }
  }

  kb.chunks.push(...(newChunks as any));
  kb.updatedAt = new Date().toISOString();
  await saveKB(kb);
  return { ok: true, chunksAdded: newChunks.length, kind, embedded };
}

pcaiRouter.post('/api/pcai/learn', async (req, res) => {
  const { title, text, kind, apiKey, localUrl } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Provide the document text to learn.' });
  try {
    const result = await learnDocument({ title: title || 'Untitled', text: String(text), kind, apiKey, localUrl });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: `Learning failed: ${e.message}` });
  }
});

pcaiRouter.get('/api/pcai/learned', async (_req, res) => {
  const docs = await loadLearned();
  res.json({
    count: docs.length,
    docs: docs.map((d) => ({ title: d.title, url: d.url, kind: d.kind, addedAt: d.addedAt, chars: d.text.length })).reverse(),
  });
});

pcaiRouter.delete('/api/pcai/learned', async (req, res) => {
  const { url } = req.body || {};
  const docs = await loadLearned();
  const next = url ? docs.filter((d) => d.url !== url) : [];
  await saveLearned(next);
  res.json({ ok: true, removed: docs.length - next.length, note: 'Run /train to rebuild the KB without the removed docs.' });
});

// Embed the query using the same provider the KB was built with, so vectors
// are comparable. Falls back to null (lexical search) on any problem.
async function embedQuery(
  query: string,
  kbProvider: string,
  kbModel: string,
  creds: { apiKey?: string; localUrl?: string }
): Promise<number[] | null> {
  if (kbProvider === 'none') return null;
  const cfg: EmbedConfig =
    kbProvider === 'gemini'
      ? { provider: 'gemini', model: kbModel, apiKey: creds.apiKey || process.env.GEMINI_API_KEY }
      : { provider: 'local', model: kbModel, localUrl: creds.localUrl };
  if (cfg.provider === 'gemini' && !cfg.apiKey) return null;
  if (cfg.provider === 'local' && !cfg.localUrl) return null;
  try {
    const v = await embedTexts([query], cfg);
    return v ? v[0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared retrieval + prompt building (used by both /chat and /chat/stream).
// ---------------------------------------------------------------------------
interface RetrievalResult {
  hits: SearchHit[];
  context: string;
  sources: Array<{ ref: number; title: string; url: string; score: number }>;
  weakContext: boolean;
}

// Diversify results so a single long doc can't monopolise the context: cap the
// number of chunks kept per source URL, then take the top `k`.
function diversify(hits: SearchHit[], perSourceCap = 3, k = 8): SearchHit[] {
  const perSource = new Map<string, number>();
  const kept: SearchHit[] = [];
  for (const h of hits) {
    const n = perSource.get(h.url) || 0;
    if (n >= perSourceCap) continue;
    perSource.set(h.url, n + 1);
    kept.push(h);
    if (kept.length >= k) break;
  }
  return kept;
}

async function retrieve(
  kb: KnowledgeBase,
  prompt: string,
  creds: { apiKey?: string; localUrl?: string }
): Promise<RetrievalResult> {
  const qEmbed = await embedQuery(prompt, kb.embedProvider, kb.embedModel, creds);
  const raw: SearchHit[] = searchKB(kb, prompt, qEmbed, 16);
  const hits = diversify(raw, 3, 8);

  const context = hits
    .map((h, i) => `[[${i + 1}]] Source: ${h.title} (${h.url})\n${h.text}`)
    .join('\n\n---\n\n');

  const sources = hits.map((h, i) => ({
    ref: i + 1,
    title: h.title,
    url: h.url,
    score: Number(h.score.toFixed(3)),
  }));

  const topScore = hits.length ? hits[0].score : 0;
  // Vector cosine and lexical scores live on different scales; use per-mode
  // thresholds to decide whether the retrieved context is actually relevant.
  const weakContext =
    hits.length === 0 ||
    (kb.embedProvider !== 'none' ? topScore < 0.35 : topScore < 0.12);

  return { hits, context, sources, weakContext };
}

function buildSystemInstruction(mode: string, context: string, weakContext: boolean): string {
  const weakNote = weakContext
    ? `\nIMPORTANT: The retrieved documentation is a weak match for this query. Lead with an honest caveat that your indexed HPE docs may not directly cover this, answer with general HPE PCAI / Kubernetes best practice, and recommend the exact HPE doc, GreenLake screen, or command the user should check to confirm. Do NOT fabricate HPE-specific specifics.\n`
    : '';

  const diagnoseExtra =
    mode === 'diagnose'
      ? `\nThe user has pasted an ERROR, log, or stack trace. Do this:
1. State the most likely root cause in one line.
2. Give concrete, ordered fix steps (include exact kubectl / GreenLake / AI Essentials actions where relevant).
3. Note what to check to confirm the fix.
Be specific to HPE PCAI (Kubernetes-based). If the error clearly isn't PCAI-related, say so.`
      : '';

  return `You are the HPE Private Cloud AI (PCAI) Assistant inside the Kalam console. You are an expert on HPE Private Cloud AI, HPE AI Essentials (MLDE, MLDM, MLIS), the data lakehouse, NVIDIA AI Enterprise/NIM, HPE GreenLake management, and the Kubernetes platform PCAI runs on.

Answer ONLY using the HPE documentation context below plus well-established Kubernetes/NVIDIA general knowledge. Ground every specific claim in the context. Cite sources inline using the [[n]] markers that correspond to the numbered context entries. If the context does not contain the answer, say clearly what you don't have and suggest which HPE doc or command would resolve it — do NOT invent HPE-specific details, version numbers, or menu paths.
${weakNote}${diagnoseExtra}

=== HPE PCAI DOCUMENTATION CONTEXT ===
${context}
=== END CONTEXT ===

Formatting: use concise markdown. Use headings/bullets for steps. Put shell commands in code blocks. End with a "Sources" list of the [[n]] references you actually used.`;
}

// Fallback text when no LLM is reachable: return the retrieved HPE docs directly
// so the assistant is ALWAYS useful (never a hard error).
function docFallback(hits: SearchHit[], reason: string): string {
  return `> ${reason}\n\nHere is the most relevant HPE PCAI documentation I found for your query:\n\n${hits
    .map((h, i) => `### [${i + 1}] ${h.title}\n${h.text}\n\n_Source: ${h.url}_`)
    .join('\n\n')}`;
}

function buildGeminiPrompt(systemInstruction: string, chatHistory: any[], prompt: string): string {
  return `${systemInstruction}

Conversation so far:
${chatHistory.map((h: any) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n')}
User: ${prompt}
Assistant:`;
}

// ---------------------------------------------------------------------------
// Non-streaming chat (kept for programmatic callers / backward compatibility).
// ---------------------------------------------------------------------------
pcaiRouter.post('/api/pcai/chat', async (req, res) => {
  const {
    prompt,
    mode = 'ask',
    chatHistory = [],
    apiKey,
    provider = 'gemini',
    localUrl = 'http://localhost:11434/v1',
    localModel = 'qwen2.5-coder:7b',
    authKey,
  } = req.body || {};

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'A question or error text is required.' });
  }

  const kb = await loadKB();
  if (!kb || kb.chunks.length === 0) {
    return res.status(409).json({
      error: 'Knowledge base is empty.',
      details: 'Click "Train / Refresh Knowledge Base" first to build the PCAI brain.',
    });
  }

  const { hits, context, sources, weakContext } = await retrieve(kb, prompt, { apiKey, localUrl });
  const systemInstruction = buildSystemInstruction(mode, context, weakContext);

  try {
    if (provider === 'local') {
      const endpoint = `${localUrl.replace(/\/$/, '')}/chat/completions`;
      const messages = [
        { role: 'system', content: systemInstruction },
        ...chatHistory.map((h: any) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })),
        { role: 'user', content: prompt },
      ];
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}) },
          body: JSON.stringify({ model: localModel, messages, temperature: 0.2, options: { num_ctx: 8192 } }),
        });
        if (!response.ok) {
          return res.json({ content: docFallback(hits, `Local LLM at ${localUrl} returned HTTP ${response.status}. Showing the retrieved docs instead (start Ollama or set a Gemini key for composed answers).`), sources });
        }
        const data: any = await response.json();
        const content = data.choices?.[0]?.message?.content;
        return res.json({ content: content || docFallback(hits, 'Local LLM returned an empty response.'), sources });
      } catch (localErr: any) {
        return res.json({ content: docFallback(hits, `Could not reach the local LLM at ${localUrl} (${localErr.message}). Showing the retrieved HPE docs instead — start Ollama/LM Studio or set a Gemini key for composed answers.`), sources });
      }
    }

    const finalKey = apiKey || process.env.GEMINI_API_KEY;
    if (!finalKey) {
      return res.json({ content: docFallback(hits, 'No AI engine is configured (add a Gemini API key to .env or run a local LLM). Showing the retrieved HPE documentation directly:'), sources });
    }

    try {
      const ai = new GoogleGenAI({ apiKey: finalKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: buildGeminiPrompt(systemInstruction, chatHistory, prompt),
      });
      const content = response.text;
      return res.json({ content: content || docFallback(hits, 'The model returned an empty response.'), sources });
    } catch (gemErr: any) {
      return res.json({ content: docFallback(hits, `Gemini call failed (${gemErr.message}). Showing the retrieved HPE docs instead.`), sources });
    }
  } catch (e: any) {
    console.error('PCAI chat error:', e);
    return res.json({ content: docFallback(hits, `Unexpected error (${e.message}).`), sources });
  }
});

// ---------------------------------------------------------------------------
// Streaming chat (SSE) — powers the "types as it responds" experience.
// Protocol:  data: {"type":"sources", sources:[...]}
//            data: {"type":"delta", text:"..."}   (repeated)
//            data: {"type":"done"}   then   data: [DONE]
// It NEVER hard-errors: if no LLM is reachable it streams the retrieved docs.
// ---------------------------------------------------------------------------
pcaiRouter.post('/api/pcai/chat/stream', async (req, res) => {
  const {
    prompt,
    mode = 'ask',
    chatHistory = [],
    apiKey,
    provider = 'gemini',
    localUrl = 'http://localhost:11434/v1',
    localModel = 'qwen2.5-coder:7b',
    authKey,
  } = req.body || {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const done = () => { sse({ type: 'done' }); res.write('data: [DONE]\n\n'); res.end(); };

  if (!prompt || !prompt.trim()) {
    sse({ type: 'delta', text: 'A question or error text is required.' });
    return done();
  }

  const kb = await loadKB();
  if (!kb || kb.chunks.length === 0) {
    sse({ type: 'delta', text: '**Knowledge base is empty.** Run `kalam train` (or click Train in the UI) to build the PCAI brain first.' });
    return done();
  }

  const { hits, context, sources, weakContext } = await retrieve(kb, prompt, { apiKey, localUrl });
  const systemInstruction = buildSystemInstruction(mode, context, weakContext);
  sse({ type: 'sources', sources });

  // Emit a block of text as one delta (used for the doc fallback).
  const emitFallback = (reason: string) => sse({ type: 'delta', text: docFallback(hits, reason) });

  // Self-learning loop: a completed diagnosis becomes a "solved case" the KB
  // remembers, so the next similar error retrieves this resolution too.
  let answerText = '';
  const captureDelta = (t: string) => { answerText += t; sse({ type: 'delta', text: t }); };
  const captureCase = () => {
    if (mode !== 'diagnose' || answerText.trim().length < 300) return;
    const firstLine = prompt.trim().split('\n')[0].slice(0, 120);
    learnDocument({
      title: `Solved case: ${firstLine}`,
      kind: 'case',
      text: `PROBLEM (as reported):\n${prompt.slice(0, 3000)}\n\nDIAGNOSIS & RESOLUTION:\n${answerText.slice(0, 6000)}`,
      apiKey, localUrl,
    }).catch(() => { /* learning is best-effort, never blocks the answer */ });
  };

  try {
    if (provider === 'local') {
      const ok = await streamLocalChat({
        localUrl,
        localModel,
        systemInstruction,
        chatHistory,
        prompt,
        authKey,
        onDelta: captureDelta,
      });
      if (!ok.success) emitFallback(ok.reason);
      else captureCase();
      return done();
    }

    const finalKey = apiKey || process.env.GEMINI_API_KEY;
    if (!finalKey) {
      emitFallback('No AI engine is configured (add a Gemini API key to .env or run a local LLM). Showing the retrieved HPE documentation directly:');
      return done();
    }

    const ok = await streamGemini({
      apiKey: finalKey,
      contents: buildGeminiPrompt(systemInstruction, chatHistory, prompt),
      onDelta: captureDelta,
    });
    if (!ok.success) emitFallback(ok.reason);
    else captureCase();
    return done();
  } catch (e: any) {
    emitFallback(`Unexpected error (${e.message}).`);
    return done();
  }
});

// ---------------------------------------------------------------------------
// Streaming helpers (exported so the DevOps agent can reuse them too).
// ---------------------------------------------------------------------------
export interface StreamResult { success: boolean; reason: string }

export async function streamLocalChat(opts: {
  localUrl: string;
  localModel: string;
  systemInstruction: string;
  chatHistory: any[];
  prompt: string;
  onDelta: (text: string) => void;
  numCtx?: number;
  authKey?: string; // Bearer token for custom OpenAI-compatible endpoints (e.g. HPE MLIS)
}): Promise<StreamResult> {
  const endpoint = `${opts.localUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [
    { role: 'system', content: opts.systemInstruction },
    ...opts.chatHistory.map((h: any) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })),
    { role: 'user', content: opts.prompt },
  ];
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.authKey ? { Authorization: `Bearer ${opts.authKey}` } : {}) },
      body: JSON.stringify({ model: opts.localModel, messages, temperature: 0.2, stream: true, options: { num_ctx: opts.numCtx ?? 8192 } }),
    });
    if (!response.ok || !response.body) {
      return { success: false, reason: `Local LLM at ${opts.localUrl} returned HTTP ${response.status}. Showing the retrieved docs instead (start Ollama or set a Gemini key for composed answers).` };
    }
    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let got = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { got = true; opts.onDelta(delta); }
        } catch { /* ignore keepalive */ }
      }
    }
    if (!got) return { success: false, reason: 'Local LLM returned an empty response.' };
    return { success: true, reason: '' };
  } catch (e: any) {
    return { success: false, reason: `Could not reach the local LLM at ${opts.localUrl} (${e.message}). Showing the retrieved HPE docs instead — start Ollama/LM Studio or set a Gemini key.` };
  }
}

export async function streamGemini(opts: {
  apiKey: string;
  contents: string;
  onDelta: (text: string) => void;
}): Promise<StreamResult> {
  try {
    const ai = new GoogleGenAI({ apiKey: opts.apiKey });
    const stream = await ai.models.generateContentStream({
      model: 'gemini-3-flash-preview',
      contents: opts.contents,
    });
    let got = false;
    for await (const chunk of stream) {
      const t = (chunk as any).text;
      if (t) { got = true; opts.onDelta(t); }
    }
    if (!got) return { success: false, reason: 'The model returned an empty response.' };
    return { success: true, reason: '' };
  } catch (e: any) {
    return { success: false, reason: `Gemini call failed (${e.message}). Showing the retrieved HPE docs instead.` };
  }
}
