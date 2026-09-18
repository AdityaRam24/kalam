// Read side of the metrics store.
//
// Everything here is read-only except /sample, which takes one reading now —
// the equivalent of the history tab's "Capture now", so the page is useful
// before anyone has opted into the background poller.

import { Router } from 'express';
import {
  METRICS, downsample, levelOf, toSeries, valueAt, worstLevel,
  type Level, type MetricId, type Point, type Sample,
} from './model.js';
import { listSources, readSamples, RETENTION_HOURS } from './store.js';
import { metricsPollerState, sampleOnce } from './poller.js';
import { loadVms } from '../vms.js';

export const metricsRouter = Router();

const ALL_METRICS = Object.keys(METRICS) as MetricId[];

const parseList = (v: unknown): string[] =>
  String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

metricsRouter.get('/api/metrics/status', async (_req, res) => {
  const state = metricsPollerState();
  const [stored, vms] = await Promise.all([listSources(), loadVms()]);
  res.json({
    ...state,
    retentionHours: RETENTION_HOURS,
    storedSources: stored,
    inventory: vms.map((v) => v.name),
    metrics: ALL_METRICS.map((id) => METRICS[id]),
  });
});

/**
 * GET /api/metrics/series
 *   ?sources=a,b        default: every host with stored samples
 *   &metrics=cpuPct,... default: all
 *   &sinceMin=60        window, capped at the retention window
 *   &points=240         max points per series after downsampling
 */
metricsRouter.get('/api/metrics/series', async (req, res) => {
  const wanted = parseList(req.query.sources);
  const sources = wanted.length ? wanted : await listSources();
  const metrics = (parseList(req.query.metrics).filter((m) => m in METRICS) as MetricId[]);
  const chosen = metrics.length ? metrics : ALL_METRICS;

  const sinceMin = clamp(Number(req.query.sinceMin) || 60, 1, RETENTION_HOURS * 60);
  const points = clamp(Number(req.query.points) || 240, 10, 2000);
  const since = Date.now() - sinceMin * 60_000;

  const out: Record<string, { reachable: boolean; error?: string; series: Record<string, Point[]> }> = {};
  for (const source of sources) {
    const samples = await readSamples(source, since);
    const series: Record<string, Point[]> = {};
    for (const m of chosen) series[m] = downsample(toSeries(samples, m), points);
    const newest = samples[samples.length - 1];
    out[source] = {
      reachable: newest?.reachable ?? false,
      error: newest?.error,
      series,
    };
  }
  res.json({ sinceMin, points, sources, metrics: chosen, hosts: out });
});

/**
 * GET /api/metrics/latest — the newest value of every metric per host, with the
 * level it sits at. This is what the stat tiles and the topology health overlay
 * read; it is deliberately one small response rather than a series fetch.
 */
metricsRouter.get('/api/metrics/latest', async (_req, res) => {
  const sources = await listSources();
  const hosts: Record<string, {
    at: string | null;
    reachable: boolean;
    error?: string;
    stale: boolean;
    level: Level;
    values: Record<string, { v: number | null; level: Level }>;
    gpus: number;
    cpus?: number;
    uptimeSec?: number;
    fullest?: { mount: string; usePct: number };
  }> = {};

  // Two samples are enough: CPU is a rate, so the newest reading needs its
  // predecessor to mean anything at all.
  const since = Date.now() - RETENTION_HOURS * 3600_000;
  for (const source of sources) {
    const samples = await readSamples(source, since);
    const cur: Sample | undefined = samples[samples.length - 1];
    const prev: Sample | undefined = samples[samples.length - 2];
    if (!cur) continue;

    const values: Record<string, { v: number | null; level: Level }> = {};
    for (const m of ALL_METRICS) {
      const v = valueAt(m, cur, prev);
      values[m] = { v, level: levelOf(m, v) };
    }
    const fullest = (cur.fs || []).slice().sort((a, b) => b.usePct - a.usePct)[0];
    hosts[source] = {
      at: new Date(cur.at).toISOString(),
      reachable: cur.reachable,
      error: cur.error,
      // Older than four poll intervals: the number on screen is history, and
      // showing it as if it were live is how a dashboard lies during an outage.
      stale: Date.now() - cur.at > Math.max(120_000, metricsPollerState().intervalSec * 4000),
      level: cur.reachable ? worstLevel(ALL_METRICS.map((m) => values[m].level)) : 'critical',
      values,
      gpus: cur.gpus?.length || 0,
      cpus: cur.cpus,
      uptimeSec: cur.uptimeSec,
      fullest: fullest ? { mount: fullest.mount, usePct: fullest.usePct } : undefined,
    };
  }
  res.json({ hosts, at: new Date().toISOString() });
});

/** Take one reading from every host now, whether or not the poller is on. */
metricsRouter.post('/api/metrics/sample', async (_req, res) => {
  try {
    const written = await sampleOnce();
    res.json({ ok: true, sampled: written });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});
