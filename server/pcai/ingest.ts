// Build (or rebuild) the PCAI knowledge base:
//   seed knowledge + crawled HPE docs  ->  chunks  ->  (optional) embeddings  ->  kb.json
// This is the "train yourself" step. Safe to re-run any time.

import { crawl } from './crawler.js';
import { CRAWL_TARGETS, SEED_KNOWLEDGE } from './sources.js';
import { embedTexts, EmbedConfig } from './embed.js';
import { Chunk, chunkText, KnowledgeBase, saveKB, tokenize } from './store.js';

export interface IngestOptions {
  embed: EmbedConfig;
  crawl: boolean; // whether to hit the live HPE docs
  maxPages?: number;
  onProgress?: (msg: string) => void;
}

export interface IngestResult {
  chunks: number;
  embedded: boolean;
  embedProvider: string;
  embedModel: string;
  crawledPages: number;
  log: string[];
}

export async function runIngest(opts: IngestOptions): Promise<IngestResult> {
  const log: string[] = [];
  const progress = (m: string) => {
    log.push(m);
    opts.onProgress?.(m);
  };

  // 1) Gather source docs (seed always included).
  const docs = SEED_KNOWLEDGE.map((d) => ({ title: d.title, url: d.url, text: d.text }));
  progress(`Loaded ${docs.length} curated seed documents.`);

  let crawledPages = 0;
  if (opts.crawl) {
    progress('Crawling public HPE PCAI documentation...');
    try {
      const pages = await crawl(CRAWL_TARGETS, opts.maxPages ?? 40, progress);
      crawledPages = pages.length;
      for (const p of pages) docs.push({ title: p.title, url: p.url, text: p.text });
      progress(`Crawl captured ${pages.length} pages.`);
    } catch (e: any) {
      progress(`Crawl error (continuing with seed only): ${e.message}`);
    }
  } else {
    progress('Crawl disabled — using curated seed knowledge only.');
  }

  // 2) Chunk everything.
  const chunks: Chunk[] = [];
  for (const d of docs) {
    const parts = chunkText(d.text);
    parts.forEach((text, i) => {
      chunks.push({
        id: `${chunks.length}`,
        title: d.title,
        url: d.url,
        text,
        tokens: tokenize(`${d.title} ${text}`),
      });
    });
  }
  progress(`Produced ${chunks.length} chunks from ${docs.length} documents.`);

  // 3) Embed (best effort — falls back to lexical if unavailable).
  let embedded = false;
  let embedProvider = 'none';
  let embedModel = 'lexical';
  if (opts.embed.provider !== 'none') {
    try {
      progress(`Embedding ${chunks.length} chunks via ${opts.embed.provider} (${opts.embed.model})...`);
      const vectors = await embedTexts(chunks.map((c) => c.text), opts.embed);
      if (vectors) {
        vectors.forEach((v, i) => (chunks[i].embedding = v));
        embedded = true;
        embedProvider = opts.embed.provider;
        embedModel = opts.embed.model;
        progress('Embeddings complete.');
      }
    } catch (e: any) {
      progress(`Embedding failed (${e.message}). Falling back to lexical search.`);
    }
  } else {
    progress('No embedder configured — knowledge base will use lexical search.');
  }

  // 4) Persist.
  const now = new Date().toISOString();
  const kb: KnowledgeBase = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    embedProvider,
    embedModel,
    chunks,
  };
  await saveKB(kb);
  progress('Knowledge base saved.');

  return {
    chunks: chunks.length,
    embedded,
    embedProvider,
    embedModel,
    crawledPages,
    log,
  };
}
