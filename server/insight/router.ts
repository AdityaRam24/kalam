// Gather every signal about a host and hand back one understanding of it.
//
// Cost discipline matters here, because the whole point is that this is a thing
// you press rather than a thing you wait for:
//
//   * the metric levels come from samples already on disk — free
//   * the dependency graph is used ONLY if one is already cached — free
//   * the system overview is one SSH round trip — ~1s
//   * the /var/log scan is 120s and 48MB, so it is opt-in (`deep: true`)
//
// So the default answer is fast, and the deep answer is something you asked for.

import { Router } from 'express';
import { loadVms } from '../vms.js';
import { collectOverview, collectScan } from '../hostlogs/router.js';
import { cachedGraph } from '../graph/router.js';
import { analyzeCauses } from '../graph/analyze.js';
import { levelOf, valueAt, METRICS, type MetricId } from '../metrics/model.js';
import { readSamples, listSources } from '../metrics/store.js';
import { correlate, verdict, type CorrelateInput, type Issue } from './correlate.js';
import { cachedNodeConfig, collectNodeConfig } from '../k8s/nodeconfig.js';

export const insightRouter = Router();

const ALL_METRICS = Object.keys(METRICS) as MetricId[];

/** Latest metric values for one host, with the level each sits at. */
async function metricsFor(source: string): Promise<CorrelateInput['metrics']> {
  const samples = await readSamples(source, Date.now() - 6 * 3600_000);
  const cur = samples[samples.length - 1];
  const prev = samples[samples.length - 2];
  if (!cur) return undefined;
  const out: NonNullable<CorrelateInput['metrics']> = {};
  for (const m of ALL_METRICS) {
    const v = valueAt(m, cur, prev);
    if (v === null) continue;
    out[m] = { v, level: levelOf(m, v), label: METRICS[m].label };
  }
  return out;
}

/** Root causes from an already-built graph. Never builds one — that costs SSH. */
function graphFor(name: string): CorrelateInput['graph'] {
  const g = cachedGraph(name);
  if (!g) return undefined;
  const { rootCauses } = analyzeCauses(g, 5);
  return rootCauses.map((rc) => ({
    title: `${rc.kind} ${rc.name}${rc.reason ? ` — ${rc.reason}` : ''}`,
    detail: rc.explanation,
    casualties: rc.explains.length,
    severity: rc.confidence === 'high' ? ('critical' as const) : ('warning' as const),
  }));
}

/**
 * POST /api/insight/host { name, deep?, hours?, findings? }
 *
 * Returns the fused issue list plus what was actually gathered, so the page can
 * say "no log scan was run" instead of implying the logs were clean.
 *
 * `findings` lets a caller hand over a scan it has ALREADY run. The Host Logs
 * page has usually just done exactly that, and a scan is a 120s / 48MB
 * operation — re-running it here so the server could feel authoritative would
 * make pressing "Understand this host" cost two minutes for data already on
 * screen. They are display data that gets merged and ranked, never executed.
 */
insightRouter.post('/api/insight/host', async (req, res) => {
  const { name, deep = false, hours = 168, findings: givenFindings } = req.body || {};
  const vm = (await loadVms()).find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });

  const started = Date.now();
  const gathered = { overview: false, scan: false, scanReused: false, metrics: false, graph: false, config: false };

  try {
    const overview: any = await collectOverview(vm);
    if (!overview.reachable) {
      const issues = correlate({ subject: vm.name, unreachable: overview.error || 'Host unreachable' });
      return res.json({
        subject: vm.name, issues, verdict: verdict(issues), gathered,
        durationMs: Date.now() - started,
      });
    }
    gathered.overview = true;

    const metrics = await metricsFor(vm.name);
    gathered.metrics = !!metrics;
    const graph = graphFor(vm.name);
    gathered.graph = !!graph;
    // One more ~1s SSH round trip (or the 5-minute cache): the node's
    // Kubernetes files. A host that is not a node simply contributes nothing.
    const nodeCfg = cachedNodeConfig(vm.name) || await collectNodeConfig(vm).catch(() => undefined);
    const config = nodeCfg?.reachable ? nodeCfg.checks : undefined;
    gathered.config = !!config && nodeCfg?.config?.distro !== 'none';

    let findings;
    if (Array.isArray(givenFindings)) {
      findings = givenFindings;
      gathered.scan = true;
      gathered.scanReused = true;
    } else if (deep) {
      const scan: any = await collectScan(vm, Number(hours));
      if (scan.reachable && scan.findings) { findings = scan.findings; gathered.scan = true; }
    }

    const issues = correlate({
      subject: vm.name,
      health: overview.health,
      findings,
      metrics,
      graph,
      config,
    });

    res.json({
      subject: vm.name,
      issues,
      verdict: verdict(issues),
      gathered,
      host: {
        hostname: overview.hostname, os: overview.os, kernel: overview.kernel,
        uptime: overview.uptime, cpus: overview.cpus, runsAsRoot: overview.runsAsRoot,
      },
      durationMs: Date.now() - started,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/insight/fleet — every host Trinetra has samples for, understood from
 * stored data alone. No SSH at all, so the Observability page can lead with it.
 */
insightRouter.get('/api/insight/fleet', async (_req, res) => {
  const sources = await listSources();
  const hosts: Record<string, { verdict: ReturnType<typeof verdict>; issues: Issue[] }> = {};
  for (const source of sources) {
    const metrics = await metricsFor(source);
    const samples = await readSamples(source, Date.now() - 6 * 3600_000);
    const cur = samples[samples.length - 1];
    const issues = correlate({
      subject: source,
      metrics,
      graph: graphFor(source),
      config: cachedNodeConfig(source, 30 * 60_000)?.checks,
      unreachable: cur && !cur.reachable ? (cur.error || 'Host unreachable') : undefined,
    });
    hosts[source] = { verdict: verdict(issues), issues };
  }
  res.json({ hosts, at: new Date().toISOString() });
});
