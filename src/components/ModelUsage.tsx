// Model usage — what each served model is doing for people: tokens in and
// out, requests, failures, time to first token, latency, queueing and KV
// cache. Read from each model server's own /metrics (vLLM, NVIDIA NIM, TGI,
// Triton) through the API server's pod proxy; the backend is
// server/k8s/modelusage.ts. Counters run from each server's start; the
// 1 h / 24 h / 7 d columns come from Trinetra's own samples of them.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cpu, RefreshCw, AlertTriangle, Info, XCircle, ChevronDown, ChevronRight, Download, ArrowDownToLine, ArrowUpFromLine,
  Gauge, Timer, Users, Boxes, CheckCircle2,
} from 'lucide-react';
import { downloadText, stamp, toCsv } from '../lib/health';
import { useCharts, SERIES, SERIES_OTHER } from '../lib/charts';
import { BarList, ChartCard, ChartGrid, ChartsToggle, LineChart, RangeList, foldSeries } from './Charts';

interface Hist { sum: number; count: number }
interface Served {
  model?: string; family: string; promptTokens?: number; generationTokens?: number; requestsOk?: number; requestsFailed?: number;
  running?: number; waiting?: number; kvCachePct?: number; preemptions?: number; inferences?: number; ttft?: Hist; e2e?: Hist;
}
interface Replica { key: string; namespace: string; pod: string; container: string; node: string; gpus: number; server: string; startedAt?: string; endpoint?: string; error?: string; metrics?: Served }
interface Win { promptTokens: number; generationTokens: number; requestsOk: number; requestsFailed: number; ttftMs?: number; coveredHours: number }
interface Row {
  id: string; model: string; namespace: string; server: string; replicas: Replica[]; gpus: number; readable: number; tokensReported: boolean;
  lifetime: { promptTokens: number; generationTokens: number; requestsOk: number; requestsFailed: number; inferences?: number };
  now: { running: number; waiting: number; kvCachePct?: number; outTokPerSec?: number; inTokPerSec?: number };
  latency: { ttftP50Ms?: number; ttftP95Ms?: number; ttftAvgMs?: number; e2eP50Ms?: number; e2eP95Ms?: number; tpotMs?: number; queueP95Ms?: number };
  hour?: Win; day?: Win; week?: Win;
  series: Array<{ t: number; v: number | null }>;
  host?: string;
}
interface Finding { id: string; severity: 'critical' | 'warning' | 'info'; model: string; title: string; detail: string; hint?: string; host?: string }

type WindowKey = 'hour' | 'day' | 'week' | 'lifetime';
const WINDOWS: Array<[WindowKey, string]> = [['hour', 'Last hour'], ['day', 'Last 24 h'], ['week', 'Last 7 days'], ['lifetime', 'Since server start']];

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const n = (v?: number) => (v === undefined || v === null ? '—' : v < 1000 ? String(Math.round(v)) : compact.format(v));
const msText = (v?: number) => (v === undefined ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`);
const ago = (iso?: string) => {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};

const SEV: Record<Finding['severity'], { color: string; icon: React.ComponentType<any> }> = {
  critical: { color: 'var(--status-error)', icon: XCircle },
  warning: { color: 'var(--status-warning)', icon: AlertTriangle },
  info: { color: 'var(--text-secondary)', icon: Info },
};

const Tile: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; color?: string; title?: string }> = ({ icon, label, value, sub, color, title }) => (
  <div title={title} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>{icon}{label}</div>
    <div style={{ fontSize: 22, fontWeight: 650, color: color || 'var(--text-heading)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
  </div>
);

/** Output tokens per second over the last 6 h. One series, so no legend; the hover says what it is. */
const Sparkline: React.FC<{ points: Row['series'] }> = ({ points }) => {
  const W = 96, H = 26;
  const vals = points.filter((p) => p.v !== null) as Array<{ t: number; v: number }>;
  if (vals.length < 2) return <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>collecting…</span>;
  const max = Math.max(1, ...vals.map((p) => p.v));
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 2) + 1;
  const y = (v: number) => H - 2 - (v / max) * (H - 5);
  const d = points.map((p, i) => (p.v === null ? '' : `${i && points[i - 1].v !== null ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)).join('');
  const avg = vals.reduce((a, p) => a + p.v, 0) / vals.length;
  return (
    <svg width={W} height={H} role="img" aria-label={`Output tokens per second, last 6 hours: average ${avg.toFixed(1)}, peak ${max.toFixed(1)}`}
      style={{ display: 'block' }}>
      <title>{`Output tokens/s, last 6 h — avg ${avg.toFixed(1)}, peak ${max.toFixed(1)}`}</title>
      <path d={d} fill="none" stroke="var(--hpe-green, #01A982)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

const rowKey = (r: Row) => `${r.host || ''}${r.id}`;
const rowName = (r: Row) => (r.host ? `${r.host}: ${r.model}` : r.model);

/** Graphics for the same numbers the table shows. Colours follow the model (alphabetical), not its rank, so switching window never repaints a line. */
const UsageCharts: React.FC<{ rows: Row[]; win: WindowKey; winLabel: string; usage: (r: Row) => Win | Row['lifetime'] | undefined }> = ({ rows, win, winLabel, usage }) => {
  const readable = rows.filter((r) => r.readable);
  const colorOf = new Map<string, string>();
  [...readable].map(rowKey).sort().forEach((k, i) => colorOf.set(k, i < 7 ? SERIES[i] : SERIES_OTHER));

  const withTokens = readable.filter((r) => r.tokensReported)
    .map((r) => ({ r, u: usage(r) }))
    .sort((a, b) => ((b.u?.promptTokens || 0) + (b.u?.generationTokens || 0)) - ((a.u?.promptTokens || 0) + (a.u?.generationTokens || 0)));
  const tokenRows = withTokens.slice(0, 10).map(({ r, u }) => ({
    key: rowKey(r), label: rowName(r), sub: `${r.server} · ${r.replicas.length} replica${r.replicas.length === 1 ? '' : 's'}`,
    valueText: u ? n(u.promptTokens + u.generationTokens) : 'no samples',
    segs: [
      { label: 'Tokens in (prompt)', value: u?.promptTokens || 0, color: SERIES[0], text: n(u?.promptTokens) },
      { label: 'Tokens out (generated)', value: u?.generationTokens || 0, color: SERIES[1], text: n(u?.generationTokens) },
    ],
  }));

  const lines = foldSeries(readable.filter((r) => r.tokensReported && r.series.some((p) => p.v !== null))
    .sort((a, b) => rowKey(a).localeCompare(rowKey(b)))
    .map((r) => ({ key: rowKey(r), label: rowName(r), color: colorOf.get(rowKey(r)) || SERIES_OTHER, points: r.series })));

  const kv = readable.filter((r) => r.now.kvCachePct !== undefined).sort((a, b) => (b.now.kvCachePct || 0) - (a.now.kvCachePct || 0));
  const kvColor = (p: number) => (p >= 90 ? 'var(--status-error)' : p >= 75 ? 'var(--status-warning)' : 'var(--status-success)');
  const kvIcon = (p: number) => (p >= 90 ? <XCircle size={12} color="var(--status-error)" /> : p >= 75 ? <AlertTriangle size={12} color="var(--status-warning)" /> : <CheckCircle2 size={12} color="var(--status-success)" />);

  return (
    <ChartGrid>
      <ChartCard icon={<ArrowUpFromLine size={14} />} title={`Tokens per model · ${winLabel}`}
        note={win === 'lifetime' ? 'since each server started' : "from Trinetra's samples"}
        legend={[{ label: 'Tokens in (prompt)', color: SERIES[0] }, { label: 'Tokens out (generated)', color: SERIES[1] }]}>
        <BarList rows={tokenRows} empty={win === 'lifetime' ? 'No model reports token counters.' : 'No samples in this window yet — try "Since server start".'} />
        {withTokens.length > 10 && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Top 10 of {withTokens.length}; the table has all.</div>}
      </ChartCard>

      <ChartCard icon={<Gauge size={14} />} title="Output tokens per second · last 6 h" note="per model, 7.5-min steps">
        <LineChart series={lines} fmt={(v) => (v >= 1000 ? compact.format(v) : v >= 10 ? String(Math.round(v)) : v.toFixed(1))}
          empty="Collecting — the line appears after a few samples (every refresh, or the background poller)." />
      </ChartCard>

      <ChartCard icon={<Boxes size={14} />} title="KV cache in use now" note="past ~90% new requests start to queue">
        <BarList max={100} empty="No model reports KV-cache use (vLLM and NIM do)."
          rows={kv.map((r) => ({
            key: rowKey(r), label: rowName(r), icon: kvIcon(r.now.kvCachePct!),
            sub: `${r.now.running} running · ${r.now.waiting} waiting`,
            valueText: `${r.now.kvCachePct}%`,
            segs: [{ label: r.now.kvCachePct! >= 90 ? 'KV cache — full' : r.now.kvCachePct! >= 75 ? 'KV cache — filling' : 'KV cache — fine', value: r.now.kvCachePct!, color: kvColor(r.now.kvCachePct!), text: `${r.now.kvCachePct}%` }],
          }))} />
      </ChartCard>

      <ChartCard icon={<Timer size={14} />} title="Time to first token" note="since each server started">
        <RangeList color={SERIES[0]} fmt={(v) => msText(Math.round(v))} loLabel="typical (p50)" hiLabel="slowest 5% (p95)"
          rows={readable.map((r) => ({ key: rowKey(r), label: rowName(r), lo: r.latency.ttftP50Ms, hi: r.latency.ttftP95Ms,
            sub: r.latency.e2eP95Ms !== undefined ? `whole request p95 ${msText(r.latency.e2eP95Ms)}` : undefined }))} />
      </ChartCard>
    </ChartGrid>
  );
};

interface Props { source: string; vmNames: string[] }

export const ModelUsage: React.FC<Props> = ({ source, vmNames }) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [historySince, setHistorySince] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [at, setAt] = useState('');
  const [win, setWin] = useState<WindowKey>('day');
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [charts, setCharts] = useCharts();
  const seq = useRef(0);
  const vmKey = vmNames.join('\n');

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const targets = source === 'all' ? (vmKey ? vmKey.split('\n') : []) : [source];
      const res = await Promise.all(targets.map(async (t) => {
        const params = new URLSearchParams();
        if (t !== 'local') params.set('vm', t);
        const d = await fetch(`/api/models/usage?${params}`, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: e.message }));
        return { t, d };
      }));
      if (my !== seq.current) return;
      const R: Row[] = [], F: Finding[] = [], errs: string[] = [];
      let since: string | undefined;
      for (const { t, d } of res) {
        if (d.error) { errs.push(source === 'all' ? `${t}: ${d.error}` : d.error); continue; }
        const host = source === 'all' ? t : undefined;
        for (const r of d.models || []) R.push(host ? { ...r, host } : r);
        for (const f of d.findings || []) F.push(host ? { ...f, host } : f);
        if (d.history?.since && (!since || d.history.since < since)) since = d.history.since;
      }
      setRows(R);
      setFindings(F.sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] - { critical: 0, warning: 1, info: 2 }[b.severity])));
      setHistorySince(since);
      setError(errs.join(' · '));
      setAt(new Date().toLocaleTimeString());
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [source, vmKey]);

  useEffect(() => { void load(); }, [load]);
  // Each refresh is also a sample, so leaving the page open keeps the windows filling.
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(id);
  }, [auto, load]);

  const usage = (r: Row) => (win === 'lifetime' ? r.lifetime : r[win]);
  const readable = rows.filter((r) => r.readable);
  const sum = (f: (r: Row) => number | undefined) => readable.reduce((a, r) => a + (f(r) || 0), 0);
  const winRows = readable.filter((r) => usage(r));
  const tIn = sum((r) => usage(r)?.promptTokens), tOut = sum((r) => usage(r)?.generationTokens);
  const reqOk = sum((r) => usage(r)?.requestsOk), reqBad = sum((r) => usage(r)?.requestsFailed);
  const outNow = readable.some((r) => r.now.outTokPerSec !== undefined) ? sum((r) => r.now.outTokPerSec) : undefined;
  const waiting = sum((r) => r.now.waiting), running = sum((r) => r.now.running);
  const covered = win === 'lifetime' ? undefined : Math.max(0, ...readable.map((r) => r[win]?.coveredHours || 0));
  const winLabel = WINDOWS.find(([k]) => k === win)![1].toLowerCase();

  const exportCsv = () => {
    const out: Array<Array<string | number | undefined>> = [[
      'Model', 'Namespace', 'Server', 'Replicas', 'GPUs', `Tokens in (${winLabel})`, `Tokens out (${winLabel})`, `Requests ok (${winLabel})`, `Requests failed (${winLabel})`,
      'Tokens in (since start)', 'Tokens out (since start)', 'Out tokens/s now', 'Running', 'Waiting', 'KV cache %', 'TTFT p50 ms', 'TTFT p95 ms', 'Latency p95 ms', 'Host',
    ]];
    for (const r of rows) {
      const u = usage(r);
      out.push([r.model, r.namespace, r.server, r.replicas.length, r.gpus, u?.promptTokens, u?.generationTokens, u?.requestsOk, u?.requestsFailed,
        r.lifetime.promptTokens, r.lifetime.generationTokens, r.now.outTokPerSec, r.now.running, r.now.waiting, r.now.kvCachePct,
        r.latency.ttftP50Ms, r.latency.ttftP95Ms, r.latency.e2eP95Ms, r.host]);
    }
    downloadText(toCsv(out), `trinetra-model-usage-${stamp()}.csv`, 'text/csv');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Cpu size={18} /> Model usage — tokens, requests, latency</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="subnav-pill" style={{ display: 'flex', gap: 4 }}>
              {WINDOWS.map(([k, label]) => (
                <button key={k} className={`subnav-pill-btn ${win === k ? 'active' : ''}`} onClick={() => setWin(k)} style={{ fontSize: 12 }}>{label}</button>
              ))}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Every minute
            </label>
            <ChartsToggle on={charts} onChange={setCharts} />
            <button className="btn secondary" onClick={exportCsv} disabled={!rows.length} style={{ padding: '6px 12px', fontSize: 12 }}><Download size={13} /> CSV</button>
            <button className="btn primary" onClick={() => void load()} disabled={loading} style={{ padding: '6px 12px', fontSize: 12 }}>
              <RefreshCw size={13} className={loading ? 'loader' : ''} /> {loading ? 'Reading…' : 'Refresh'}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>{source === 'all' ? `All ${vmNames.length} hosts` : source === 'local' ? 'This machine\'s cluster' : `Cluster via ${source}`}</span>
          {at && <span>updated {at}</span>}
          <span>From each model server's /metrics through the API server's pod proxy — read-only, no exec.</span>
          {historySince
            ? <span>Windows count from Trinetra's samples since {new Date(historySince).toLocaleString()}.</span>
            : <span>Windows fill as Trinetra samples (each refresh is one; set TRINETRA_MODEL_POLL_SEC to sample in the background).</span>}
        </div>
        {error && <div style={{ color: 'var(--status-error)', fontSize: 12.5, marginTop: 8 }}><AlertTriangle size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
      </div>

      {rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 12 }}>
          <Tile icon={<Boxes size={13} />} label="Models serving" value={`${rows.length}`} sub={`${sum((r) => r.replicas.length)} replicas · ${rows.reduce((a, r) => a + r.gpus, 0)} GPUs · ${readable.length} readable`} />
          <Tile icon={<ArrowDownToLine size={13} />} label={`Tokens in · ${winLabel}`} value={winRows.length ? n(tIn) : '—'}
            sub={covered !== undefined ? (winRows.length ? `from ${covered} h of samples` : 'no samples in this window yet') : 'prompt tokens'} title="Prompt (input) tokens the models read" />
          <Tile icon={<ArrowUpFromLine size={13} />} label={`Tokens out · ${winLabel}`} value={winRows.length ? n(tOut) : '—'} sub="generated (output) tokens" />
          <Tile icon={<Gauge size={13} />} label="Output now" value={outNow === undefined ? '—' : `${n(outNow)} tok/s`} sub={outNow === undefined ? 'needs two reads a minute apart' : 'all models, since last read'} />
          <Tile icon={<Users size={13} />} label={`Requests · ${winLabel}`} value={winRows.length ? n(reqOk + reqBad) : '—'}
            sub={reqOk + reqBad ? `${((reqBad / (reqOk + reqBad)) * 100).toFixed(1)}% failed` : undefined}
            color={reqOk + reqBad && reqBad / (reqOk + reqBad) >= 0.05 ? 'var(--status-warning)' : undefined} />
          <Tile icon={<Timer size={13} />} label="In flight now" value={`${running} / ${waiting}`} sub="running / waiting" color={waiting ? 'var(--status-warning)' : undefined} />
        </div>
      )}

      {findings.length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title"><h2><AlertTriangle size={18} /> Worth a look</h2></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {findings.map((f) => {
              const s = SEV[f.severity];
              const Icon = s.icon;
              return (
                <div key={`${f.host || ''}${f.id}`} style={{ display: 'flex', gap: 8, padding: '6px 8px', borderRadius: 6, background: f.severity === 'info' ? undefined : 'var(--bg-tertiary)' }}>
                  <Icon size={14} color={s.color} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: f.severity === 'info' ? 500 : 650, color: 'var(--text-heading)' }}>{f.host ? `${f.host}: ` : ''}{f.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{f.detail}</div>
                    {f.hint && <div style={{ fontSize: 11.5, color: 'var(--accent-cyan)', marginTop: 2 }}>→ {f.hint}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {charts && readable.length > 0 && <UsageCharts rows={rows} win={win} winLabel={winLabel} usage={usage} />}

      {!loading && !error && rows.length === 0 && (
        <div className="panel-card"><p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          No model servers found. Trinetra looks for running vLLM, NVIDIA NIM, TGI, Triton and KServe pods, and any pod holding a GPU.
        </p></div>
      )}

      {rows.length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title">
            <h2><Boxes size={18} /> Per model</h2>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>replicas of one model are added up · click a row for each replica</span>
          </div>
          <div className="table-wrapper">
            <table className="resource-table">
              <thead>
                <tr>
                  <th></th><th>Model</th>
                  <th title="Prompt tokens read">Tokens in</th><th title="Tokens generated">Tokens out</th><th>Requests</th>
                  <th title="Output tokens per second since the previous read">Out tok/s</th><th>Last 6 h</th>
                  <th title="Running / waiting requests">Run / wait</th><th>KV cache</th>
                  <th title="Time to first token p50 / p95, and end-to-end request latency p95 — since the server started">Latency</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const u = usage(r);
                  const k = `${r.host || ''}${r.id}`;
                  const isOpen = !!open[k];
                  const total = u ? u.requestsOk + u.requestsFailed : 0;
                  const failPct = total ? (u!.requestsFailed / total) * 100 : 0;
                  return (
                    <React.Fragment key={k}>
                      <tr onClick={() => setOpen((o) => ({ ...o, [k]: !o[k] }))} style={{ cursor: 'pointer' }}>
                        <td>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td style={{ whiteSpace: 'normal', minWidth: 230, maxWidth: 320 }}>
                          <strong style={{ overflowWrap: 'anywhere' }}>{r.model}</strong>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {r.server} · {r.namespace} · {r.replicas.length} replica{r.replicas.length === 1 ? '' : 's'}{r.gpus ? ` · ${r.gpus} GPU${r.gpus === 1 ? '' : 's'}` : ''}{r.host ? ` · ${r.host}` : ''}
                          </div>
                        </td>
                        {!r.readable ? (
                          <td colSpan={8} style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'normal' }}>
                            <Info size={12} style={{ verticalAlign: -2 }} /> {r.replicas.map((x) => x.error).find(Boolean) || 'No metrics answered.'}
                          </td>
                        ) : (
                          <>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.tokensReported ? n(u?.promptTokens) : <span style={{ color: 'var(--text-muted)' }}>n/a</span>}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.tokensReported ? n(u?.generationTokens) : <span style={{ color: 'var(--text-muted)' }}>n/a</span>}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {u ? n(total) : '—'}
                              {failPct >= 1 && <div style={{ fontSize: 11, color: failPct >= 5 ? 'var(--status-warning)' : 'var(--text-muted)' }}>{failPct.toFixed(1)}% failed</div>}
                            </td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.now.outTokPerSec === undefined ? '—' : n(r.now.outTokPerSec)}</td>
                            <td>{r.tokensReported ? <Sparkline points={r.series} /> : '—'}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums', color: r.now.waiting ? 'var(--status-warning)' : undefined }}>{r.now.running} / {r.now.waiting}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.now.kvCachePct === undefined ? '—' : `${r.now.kvCachePct}%`}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                              {r.latency.ttftP50Ms === undefined && r.latency.ttftP95Ms === undefined ? '—' : `first token ${msText(r.latency.ttftP50Ms)} / ${msText(r.latency.ttftP95Ms)}`}
                              {r.latency.e2eP95Ms !== undefined && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>whole request p95 {msText(r.latency.e2eP95Ms)}</div>}
                            </td>
                          </>
                        )}
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={10} style={{ background: 'var(--bg-secondary)', whiteSpace: 'normal' }}>
                            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 8px' }}>
                              {(['hour', 'day', 'week'] as const).map((w) => (
                                <span key={w}><strong>{w === 'hour' ? '1 h' : w === 'day' ? '24 h' : '7 d'}:</strong>{' '}
                                  {r[w] ? `${n(r[w]!.promptTokens)} in · ${n(r[w]!.generationTokens)} out · ${n(r[w]!.requestsOk + r[w]!.requestsFailed)} requests${r[w]!.ttftMs !== undefined ? ` · TTFT avg ${msText(r[w]!.ttftMs)}` : ''} (${r[w]!.coveredHours} h sampled)` : 'not sampled yet'}
                                </span>
                              ))}
                              <span><strong>Since start:</strong> {n(r.lifetime.promptTokens)} in · {n(r.lifetime.generationTokens)} out · {n(r.lifetime.requestsOk + r.lifetime.requestsFailed)} requests{r.lifetime.inferences !== undefined ? ` · ${n(r.lifetime.inferences)} inferences` : ''}</span>
                              {r.latency.tpotMs !== undefined && <span><strong>Per output token:</strong> {msText(r.latency.tpotMs)}</span>}
                              {r.latency.queueP95Ms !== undefined && <span><strong>Queue p95:</strong> {msText(r.latency.queueP95Ms)}</span>}
                              {r.lifetime.requestsOk > 0 && r.tokensReported && <span><strong>Avg per request:</strong> {n(r.lifetime.promptTokens / Math.max(1, r.lifetime.requestsOk))} in / {n(r.lifetime.generationTokens / Math.max(1, r.lifetime.requestsOk))} out</span>}
                            </div>
                            <div className="table-wrapper">
                              <table className="resource-table">
                                <thead><tr><th>Replica (pod)</th><th>Node</th><th>GPUs</th><th>Up for</th><th>Tokens in / out (since start)</th><th>Requests</th><th>Run / wait</th><th>Metrics from</th></tr></thead>
                                <tbody>{r.replicas.map((x) => (
                                  <tr key={x.key}>
                                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{x.pod}<div style={{ color: 'var(--text-muted)' }}>{x.container}</div></td>
                                    <td>{x.node}</td>
                                    <td>{x.gpus || '—'}</td>
                                    <td>{ago(x.startedAt)}</td>
                                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{x.metrics ? `${n(x.metrics.promptTokens)} / ${n(x.metrics.generationTokens)}` : '—'}</td>
                                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{x.metrics ? `${n(x.metrics.requestsOk)}${x.metrics.requestsFailed ? ` (+${n(x.metrics.requestsFailed)} failed)` : ''}` : '—'}</td>
                                    <td>{x.metrics ? `${x.metrics.running ?? 0} / ${x.metrics.waiting ?? 0}` : '—'}</td>
                                    <td style={{ fontSize: 11.5, color: x.error ? 'var(--status-warning)' : 'var(--text-muted)' }}>{x.endpoint || x.error || '—'}</td>
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelUsage;
