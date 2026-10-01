// Where the history lives on disk.
//
// Two files per source (`local`, or an inventory VM name):
//
//   data/state-<source>.json      the latest fingerprint of every object
//   data/changes-<source>.jsonl   append-only changelog, rotated at a cap
//
// The rest of the repo persists with whole-file `JSON.stringify` rewrites
// (`saveVms`, `saveKB`). That is right for state — it is a single coherent
// document that must be replaced atomically, because a half-written state file
// would read as "most objects disappeared" on the next capture. It is wrong
// for the changelog: rewriting a growing file on every capture is O(n) work
// and, worse, a crash mid-rewrite loses history that was already true. So the
// log is JSON Lines and is only ever appended to — one line per change, safe
// to tail, and a torn final line costs exactly one entry.
//
// Reads come off the TAIL. "The last 200 changes" must not parse 16 MB, so
// readChanges seeks backwards and parses only what it needs.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ChangeEvent, Snapshot } from './model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KALAM_HISTORY_DIR || path.join(__dirname, 'data');

/** Rotate once the log passes this; one archive is kept. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;
/** Entries older than this are dropped when the log rotates. */
const RETENTION_DAYS = Number(process.env.KALAM_HISTORY_RETENTION_DAYS || 30);

/** Source names become filenames, so they are restricted like every other. */
const SAFE_SOURCE = /^[a-zA-Z0-9_.-]+$/;

function assertSource(source: string): string {
  if (!SAFE_SOURCE.test(source)) throw new Error(`Invalid history source "${source}".`);
  return source;
}

const statePath = (source: string) => path.join(DATA_DIR, `state-${assertSource(source)}.json`);
const logPath = (source: string) => path.join(DATA_DIR, `changes-${assertSource(source)}.jsonl`);
const archivePath = (source: string) => path.join(DATA_DIR, `changes-${assertSource(source)}.1.jsonl`);

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// State — the previous snapshot
// ---------------------------------------------------------------------------

export async function loadSnapshot(source: string): Promise<Snapshot | undefined> {
  try {
    const raw = await fs.readFile(statePath(source), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.objects ? (parsed as Snapshot) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write via a temp file and rename. A rename is atomic on both POSIX and
 * Windows-with-same-directory, so a crash mid-write leaves the OLD snapshot
 * intact rather than a truncated one — and a truncated one would produce a
 * fictional mass-deletion on the next capture.
 */
export async function saveSnapshot(snap: Snapshot): Promise<void> {
  await ensureDir();
  const target = statePath(snap.source);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snap), 'utf-8');
  await fs.rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

export async function appendChanges(source: string, events: ChangeEvent[]): Promise<void> {
  if (!events.length) return;
  await ensureDir();
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(logPath(source), lines, 'utf-8');
  await rotateIfNeeded(source);
}

/**
 * Rotate when the log outgrows the cap, dropping anything past the retention
 * window on the way through. Keeps exactly one archive: history that old is
 * better served by whatever the user's real logging stack is.
 */
export async function rotateIfNeeded(source: string): Promise<boolean> {
  const file = logPath(source);
  let size = 0;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return false;
  }
  if (size < MAX_LOG_BYTES) return false;

  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  const kept: string[] = [];
  const raw = await fs.readFile(file, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ChangeEvent;
      if (Date.parse(e.at) >= cutoff) kept.push(line);
    } catch {
      /* torn line — drop it */
    }
  }

  await fs.writeFile(archivePath(source), kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
  await fs.writeFile(file, '', 'utf-8');
  return true;
}

/** Read the last `bytes` of a file without loading the whole thing. */
async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    // A partial first line is the price of seeking; drop it.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

export interface HistoryQuery {
  limit?: number;
  /** ISO or epoch ms — only changes at/after this. */
  since?: string | number;
  kind?: string;          // ChangeKind
  objectKind?: string;
  namespace?: string;
  name?: string;
  severity?: string;
  /** Exact writer, from managedFields (e.g. "helm", "kubectl-edit"). */
  actor?: string;
  /** Free-text across summary/name/actor. */
  q?: string;
  /** Include the rotated archive when the live log is not enough. */
  deep?: boolean;
}

/** Newest first. Reads only the tail unless `deep` is set. */
export async function readChanges(source: string, query: HistoryQuery = {}): Promise<ChangeEvent[]> {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000);
  const sinceMs =
    query.since === undefined ? 0 : typeof query.since === 'number' ? query.since : Date.parse(String(query.since)) || 0;

  const files = query.deep ? [logPath(source), archivePath(source)] : [logPath(source)];
  const out: ChangeEvent[] = [];

  for (const file of files) {
    let text = '';
    try {
      // 512 KB of tail is ~1500 entries: comfortably more than any page.
      text = query.deep ? await fs.readFile(file, 'utf-8') : await readTail(file, 512 * 1024);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let e: ChangeEvent;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // torn or partial line
      }
      if (!matches(e, query, sinceMs)) continue;
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function matches(e: ChangeEvent, q: HistoryQuery, sinceMs: number): boolean {
  if (sinceMs && (Date.parse(e.at) || 0) < sinceMs) return false;
  if (q.kind && e.kind !== q.kind) return false;
  if (q.objectKind && e.objectKind.toLowerCase() !== q.objectKind.toLowerCase()) return false;
  if (q.namespace && e.namespace !== q.namespace) return false;
  if (q.name && e.name !== q.name) return false;
  if (q.severity && e.severity !== q.severity) return false;
  if (q.actor && (e.actor || '') !== q.actor) return false;
  if (q.q) {
    const hay = `${e.summary} ${e.name} ${e.namespace || ''} ${e.actor || ''} ${e.objectKind}`.toLowerCase();
    if (!hay.includes(q.q.toLowerCase())) return false;
  }
  return true;
}

/** Which sources have history on disk, and how much. */
export async function listSources(): Promise<Array<{ source: string; events: number; bytes: number; capturedAt?: string }>> {
  let names: string[] = [];
  try {
    names = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }
  const sources = names
    .filter((n) => n.startsWith('changes-') && n.endsWith('.jsonl') && !n.includes('.1.'))
    .map((n) => n.slice('changes-'.length, -'.jsonl'.length));

  const out = [];
  for (const source of sources) {
    let bytes = 0;
    let events = 0;
    try {
      const st = await fs.stat(logPath(source));
      bytes = st.size;
      // Line count without holding the file: entries average ~400 bytes, but
      // an exact count matters little here, so read the tail and extrapolate
      // only when the file is large.
      if (bytes < 2 * 1024 * 1024) {
        const raw = await fs.readFile(logPath(source), 'utf-8');
        events = raw.split('\n').filter((l) => l.trim()).length;
      } else {
        const tail = await readTail(logPath(source), 256 * 1024);
        const perByte = tail.split('\n').filter((l) => l.trim()).length / (256 * 1024);
        events = Math.round(perByte * bytes);
      }
    } catch {
      /* no log yet */
    }
    const snap = await loadSnapshot(source);
    out.push({ source, events, bytes, capturedAt: snap?.at });
  }
  return out;
}

/** Exposed for tests so they can work in a temp directory. */
export const paths = { DATA_DIR, statePath, logPath, archivePath, MAX_LOG_BYTES, RETENTION_DAYS };
