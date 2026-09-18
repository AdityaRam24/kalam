// Where samples live.
//
// One append-only JSONL file per host, pruned by age. Same shape as the change
// history store (server/history/store.ts) and for the same reason: an append is
// one write with no read-modify-write window, so a sampler that dies mid-poll
// costs you one line rather than the file.
//
// Deliberately not a database. At the default 30s interval a host produces
// ~2,880 lines/day; 48 hours of a ten-host inventory is a few MB of text you
// can read with `tail`. Reaching for SQLite here would buy nothing and add a
// native dependency to a tool that installs offline.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Sample } from './model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const METRICS_DIR = process.env.KALAM_METRICS_DIR || path.join(__dirname, 'data');
export const RETENTION_HOURS = Math.max(1, Number(process.env.KALAM_METRICS_RETENTION_HOURS || 48));

/** Host names become file names, so anything path-like has to go. */
const safeName = (source: string) => source.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
const fileFor = (source: string) => path.join(METRICS_DIR, `samples-${safeName(source)}.jsonl`);

async function ensureDir(): Promise<void> {
  await fs.mkdir(METRICS_DIR, { recursive: true }).catch(() => {});
}

export async function appendSample(sample: Sample): Promise<void> {
  await ensureDir();
  await fs.appendFile(fileFor(sample.source), JSON.stringify(sample) + '\n', 'utf-8');
}

/**
 * Samples for one host, oldest first, optionally only those at/after `sinceMs`.
 *
 * A corrupt line is skipped rather than thrown on: a half-written final line
 * after a hard kill must not make the whole dashboard 500.
 */
export async function readSamples(source: string, sinceMs = 0): Promise<Sample[]> {
  let raw: string;
  try {
    raw = await fs.readFile(fileFor(source), 'utf-8');
  } catch {
    return [];
  }
  const out: Sample[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as Sample;
      if (typeof s?.at === 'number' && s.at >= sinceMs) out.push(s);
    } catch { /* skip a torn line */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function listSources(): Promise<string[]> {
  try {
    const files = await fs.readdir(METRICS_DIR);
    return files
      .filter((f) => f.startsWith('samples-') && f.endsWith('.jsonl'))
      .map((f) => f.slice('samples-'.length, -'.jsonl'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Drop samples older than the retention window.
 *
 * Rewrites via a temp file and rename so a crash mid-prune leaves the old file
 * intact rather than a truncated one.
 */
export async function pruneSource(source: string, now = Date.now()): Promise<number> {
  const cutoff = now - RETENTION_HOURS * 3600_000;
  const kept = await readSamples(source, cutoff);
  const file = fileFor(source);
  let existing = 0;
  try {
    existing = (await fs.readFile(file, 'utf-8')).split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
  if (kept.length === existing) return 0;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, kept.map((s) => JSON.stringify(s)).join('\n') + (kept.length ? '\n' : ''), 'utf-8');
  await fs.rename(tmp, file);
  return existing - kept.length;
}

export async function pruneAll(now = Date.now()): Promise<number> {
  let dropped = 0;
  for (const source of await listSources()) dropped += await pruneSource(source, now);
  return dropped;
}
