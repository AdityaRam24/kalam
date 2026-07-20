// Persistent knowledge base for the PCAI assistant.
// Stores chunks (+ optional embeddings) in a JSON file next to the server.
// Retrieval is hybrid: cosine similarity when embeddings exist, always blended
// with a lexical (token-overlap) score so it works with or without an embedder.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cosineSimilarity, EmbedConfig } from './embed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const KB_PATH = path.join(__dirname, 'kb.json');

export interface Chunk {
  id: string;
  title: string;
  url: string;
  text: string;
  tokens: string[]; // lowercased word tokens, for lexical scoring
  embedding?: number[];
}

export interface KnowledgeBase {
  version: number;
  createdAt: string;
  updatedAt: string;
  embedProvider: string; // provider used to build embeddings (or 'none')
  embedModel: string;
  chunks: Chunk[];
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  'be', 'with', 'as', 'at', 'by', 'it', 'this', 'that', 'from', 'you', 'your',
  'can', 'will', 'if', 'not', 'but', 'has', 'have', 'was', 'were',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_.-]+/g) || []).filter(
    (t) => t.length > 1 && !STOP.has(t)
  );
}

// Split a doc's text into overlapping chunks (~1200 chars, ~150 overlap),
// preferring paragraph boundaries.
export function chunkText(text: string, maxLen = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const paras = clean.split(/\n\s*\n/);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > maxLen && buf) {
      chunks.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - overlap)) + '\n\n' + p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
    // A single huge paragraph: hard-split it.
    while (buf.length > maxLen) {
      chunks.push(buf.slice(0, maxLen).trim());
      buf = buf.slice(maxLen - overlap);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

export async function loadKB(): Promise<KnowledgeBase | null> {
  try {
    const raw = await fs.readFile(KB_PATH, 'utf-8');
    return JSON.parse(raw) as KnowledgeBase;
  } catch {
    return null;
  }
}

export async function saveKB(kb: KnowledgeBase): Promise<void> {
  await fs.writeFile(KB_PATH, JSON.stringify(kb), 'utf-8');
}

export interface SearchHit extends Chunk {
  score: number;
}

// Retrieve the top-K most relevant chunks for a query. `queryEmbedding` may be
// null (no embedder) — lexical scoring is used in that case.
export function searchKB(
  kb: KnowledgeBase,
  query: string,
  queryEmbedding: number[] | null,
  k = 5
): SearchHit[] {
  const qTokens = new Set(tokenize(query));
  const useVectors =
    !!queryEmbedding &&
    kb.chunks.some((c) => Array.isArray(c.embedding) && c.embedding.length);

  const scored: SearchHit[] = kb.chunks.map((c) => {
    // Lexical score: fraction of query tokens present, weighted by frequency.
    let lexHits = 0;
    const ctok = new Set(c.tokens);
    qTokens.forEach((t) => {
      if (ctok.has(t)) lexHits++;
    });
    const lexScore = qTokens.size ? lexHits / qTokens.size : 0;

    let vecScore = 0;
    if (useVectors && queryEmbedding && c.embedding) {
      vecScore = cosineSimilarity(queryEmbedding, c.embedding);
    }

    // Blend: when vectors exist they dominate but lexical still nudges ties.
    const score = useVectors ? vecScore * 0.8 + lexScore * 0.2 : lexScore;
    return { ...c, score };
  });

  return scored
    .filter((s) => s.score > 0.001)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
