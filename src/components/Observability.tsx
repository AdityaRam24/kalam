// Observability — the high-level "how is the estate doing" page.
//
// Design notes worth keeping, because they are easy to undo by accident:
//
//  * Host identity is carried by the CARD, not by colour. The primary layout is
//    small multiples (one card per host), so a 30-host inventory needs no
//    30-colour palette — which could not be made colourblind-safe anyway. Colour
//    is only used for identity in the overlay chart, capped at five series.
//  * The five identity hues were validated, not chosen by eye: worst adjacent
//    CVD ΔE 8.4 dark / 9.1 light, normal-vision 19.7 / 22.9, all ≥3:1 on the
//    chart surface. Three light-mode hues sit under 3:1, which obligates the
//    relief rule — hence the always-present legend AND direct labels.
//  * Status colours (Trinetra's --status-*) are RESERVED for state and never used
//    as a series colour, and every status chip pairs the colour with a word so
//    it never reads by colour alone.
//  * A null is a hole. An unreachable host breaks the line rather than joining
//    across the gap: a smooth line through an outage is a claim the host was
//    fine while it was down.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, Cpu, Database, Gauge, HardDrive, RefreshCw,
  Server, Thermometer, Zap, CheckCircle2, CircleSlash, Search, Download, Copy, Check, ChevronDown, ChevronRight,
} from 'lucide-react';
import ClusterMetrics from './ClusterMetrics';
import { downloadText, stamp, toCsv } from '../lib/health';

// ── Palette ─────────────────────────────────────────────────────────────────
// Validated with the dataviz palette checker against Trinetra's own surfaces
// (#0A0D12 dark / #FFFFFF light). Order is the CVD-safety mechanism — do not
// re-order or extend without re-running the validator.
const SERIES_DARK = ['#3987e5', '#d55181', '#9085e9', '#199e70', '#c98500'];
const SERIES_LIGHT = ['#2a78d6', '#e87ba4', '#4a3aa7', '#1baf7a', '#eda100'];
const MAX_OVERLAY_SERIES = 5;

type Level = 'ok' | 'warn' | 'critical' | 'unknown';

const LEVEL_TOKEN: Record<Level, { color: string; label: string; Icon: typeof CheckCircle2 }> = {
  ok: { color: 'var(--status-success)', label: 'OK', Icon: CheckCircle2 },
  warn: { color: 'var(--status-warning)', label: 'Warning', Icon: AlertTriangle },
  critical: { color: 'var(--status-error)', label: 'Critical', Icon: AlertTriangle },
  unknown: { color: 'var(--text-muted)', label: 'No data', Icon: CircleSlash },
};

interface Point { t: number; v: number | null }
interface Evidence { kind: 'log' | 'health' | 'metric' | 'graph' | 'config'; severity: Severity; summary: string; detail?: string; count?: number }
type Severity = 'critical' | 'warning' | 'info';
interface Issue {
  id: string; concern: string; severity: Severity; title: string; subject: string;
  confidence: 'confirmed' | 'likely'; why: string; evidence: Evidence[]; checks: string[]; units: string[];
}
interface MetricMeta { id: string; label: string; unit: string; warn?: number; critical?: number; ratio: boolean }
interface HostLatest {
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
}

const RANGES = [
  { label: '15m', min: 15 },
  { label: '1h', min: 60 },
  { label: '6h', min: 360 },
  { label: '24h', min: 1440 },
];

// Metrics shown as a sparkline on every host card, in reading order.
const CARD_METRICS = ['cpuPct', 'memUsedPct', 'diskUsedPct', 'gpuUtilPct'] as const;

const METRIC_ICON: Record<string, typeof Cpu> = {
  cpuPct: Cpu, memUsedPct: Database, diskUsedPct: HardDrive, gpuUtilPct: Zap,
  gpuMemPct: Zap, gpuTempC: Thermometer, gpuPowerW: Zap,
  load1: Gauge, loadPerCpu: Gauge, swapUsedPct: Database, failedUnits: AlertTriangle,
};

const fmt = (v: number | null | undefined, unit: string): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 0 : 1;
  return `${v.toFixed(digits)}${unit === '' ? '' : unit === '%' ? '%' : ` ${unit}`}`;
};

const fmtUptime = (sec?: number): string => {
  if (!sec || !Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
};

const clockOf = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ── Chart primitives ────────────────────────────────────────────────────────

/**
 * Build one or more SVG subpaths, starting a new one at every gap.
 *
 * This is the whole reason not to use a naive join: a null must LEAVE A HOLE.
 */
function pathSegments(
  points: Point[],
  x: (t: number) => number,
  y: (v: number) => number,
): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) {
      if (cur.length > 1) out.push(cur.join(' '));
      cur = [];
      continue;
    }
    cur.push(`${cur.length ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
  }
  if (cur.length > 1) out.push(cur.join(' '));
  // A lone readable point between two gaps still deserves to be seen.
  if (cur.length === 1) out.push(`${cur[0]} L${cur[0].slice(1)}`);
  return out;
}

const Sparkline: React.FC<{
  points: Point[]; color: string; ratio: boolean; height?: number;
}> = ({ points, color, ratio, height = 34 }) => {
  const W = 120;
  const usable = points.filter((p) => p.v !== null && Number.isFinite(p.v)) as Array<{ t: number; v: number }>;
  if (usable.length === 0) {
    return (
      <div style={{ width: W, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, color: 'var(--text-muted)' }}>
        no data
      </div>
    );
  }
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const lo = ratio ? 0 : Math.min(...usable.map((p) => p.v));
  const hi = ratio ? 100 : Math.max(...usable.map((p) => p.v), lo + 1);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 2) + 1;
  const y = (v: number) => height - 3 - ((v - lo) / Math.max(1e-9, hi - lo)) * (height - 6);
  const segs = pathSegments(points, x, y);
  const last = usable[usable.length - 1];

  return (
    <svg width={W} height={height} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      {segs.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
      ))}
      <circle cx={x(last.t)} cy={y(last.v)} r={2.5} fill={color} />
    </svg>
  );
};

interface OverlaySeries { name: string; color: string; points: Point[] }

// Hoisted: recreating this per render makes it a changing hook dependency.
const PAD = { l: 44, r: 74, t: 12, b: 22 }; // right pad holds the direct labels

/** Multi-host line chart with a crosshair + tooltip, one metric (never two axes). */
const LineChart: React.FC<{ series: OverlaySeries[]; meta: MetricMeta; height?: number }> = ({
  series, meta, height = 210,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(720);
  const [hoverT, setHoverT] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const all = series.flatMap((s) => s.points);
  const readable = all.filter((p) => p.v !== null && Number.isFinite(p.v)) as Array<{ t: number; v: number }>;
  const t0 = all.length ? Math.min(...all.map((p) => p.t)) : 0;
  const t1 = all.length ? Math.max(...all.map((p) => p.t)) : 1;
  const lo = meta.ratio ? 0 : Math.min(0, ...readable.map((p) => p.v));
  const hi = meta.ratio ? 100 : Math.max(1, ...readable.map((p) => p.v)) * 1.1;

  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (height - PAD.t - PAD.b);

  const ticks = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
  }, [lo, hi]);

  const onMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.l || px > w - PAD.r) { setHoverT(null); return; }
    const frac = (px - PAD.l) / Math.max(1, w - PAD.l - PAD.r);
    setHoverT(t0 + frac * (t1 - t0));
  }, [w, t0, t1]);

  // Nearest actual sample to the cursor, per series.
  const hover = useMemo(() => {
    if (hoverT === null) return null;
    const rows = series.map((s) => {
      let best: Point | null = null;
      for (const p of s.points) {
        if (!best || Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p;
      }
      return { name: s.name, color: s.color, point: best };
    });
    const t = rows.find((r) => r.point)?.point?.t ?? hoverT;
    return { t, rows };
  }, [hoverT, series]);

  if (!readable.length) {
    return (
      <div ref={wrapRef} style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  color: 'var(--text-muted)', fontSize: 12 }}>
        No samples in this window.
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <svg width="100%" height={height} onMouseMove={onMove} onMouseLeave={() => setHoverT(null)}
           role="img" aria-label={`${meta.label} over time`}>
        {/* Recessive grid */}
        {ticks.map((tv, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(tv)} y2={y(tv)}
                  stroke="var(--border-color)" strokeWidth={1} opacity={0.6} />
            <text x={PAD.l - 8} y={y(tv) + 3} textAnchor="end"
                  fill="var(--text-muted)" fontSize={10}>{fmt(tv, meta.unit)}</text>
          </g>
        ))}
        {/* Threshold markers — state, so status colour is correct here */}
        {meta.critical !== undefined && meta.critical <= hi && (
          <line x1={PAD.l} x2={w - PAD.r} y1={y(meta.critical)} y2={y(meta.critical)}
                stroke="var(--status-error)" strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
        )}
        <line x1={PAD.l} x2={w - PAD.r} y1={height - PAD.b} y2={height - PAD.b}
              stroke="var(--border-strong)" strokeWidth={1} />
        <text x={PAD.l} y={height - 6} fill="var(--text-muted)" fontSize={10}>{clockOf(t0)}</text>
        <text x={w - PAD.r} y={height - 6} textAnchor="end" fill="var(--text-muted)" fontSize={10}>{clockOf(t1)}</text>

        {series.map((s) => (
          <g key={s.name}>
            {pathSegments(s.points, x, y).map((d, i) => (
              <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={2}
                    strokeLinecap="round" strokeLinejoin="round" />
            ))}
          </g>
        ))}

        {/* Direct labels: identity without relying on colour (relief rule) */}
        {series.map((s) => {
          const lastReadable = [...s.points].reverse().find((p) => p.v !== null && Number.isFinite(p.v));
          if (!lastReadable) return null;
          return (
            <text key={s.name} x={w - PAD.r + 6} y={y(lastReadable.v as number) + 3}
                  fill="var(--text-secondary)" fontSize={10}>
              {s.name.length > 10 ? `${s.name.slice(0, 9)}…` : s.name}
            </text>
          );
        })}

        {hover && (
          <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD.t} y2={height - PAD.b}
                stroke="var(--text-muted)" strokeWidth={1} opacity={0.5} />
        )}
        {hover?.rows.map((r) =>
          r.point && r.point.v !== null && Number.isFinite(r.point.v) ? (
            <circle key={r.name} cx={x(r.point.t)} cy={y(r.point.v)} r={4}
                    fill={r.color} stroke="var(--bg-card)" strokeWidth={2} />
          ) : null,
        )}
      </svg>

      {hover && (
        <div style={{
          position: 'absolute', left: Math.min(x(hover.t) + 10, w - 170), top: 8, pointerEvents: 'none',
          background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 6,
          padding: '6px 8px', fontSize: 11, minWidth: 140, backdropFilter: 'blur(6px)',
          boxShadow: 'var(--shadow-md)', zIndex: 3,
        }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{clockOf(hover.t)}</div>
          {hover.rows.map((r) => (
            <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flexShrink: 0 }} />
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
              </span>
              <span style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(r.point?.v ?? null, meta.unit)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const StatTile: React.FC<{
  label: string; value: string; sub?: string; level?: Level; Icon: typeof Server;
}> = ({ label, value, sub, level, Icon }) => {
  const tok = level ? LEVEL_TOKEN[level] : null;
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-secondary)', fontSize: 11 }}>
        <Icon size={13} /> {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--text-heading)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
        {value}
      </div>
      {(sub || tok) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: tok ? tok.color : 'var(--text-muted)' }}>
          {tok && <tok.Icon size={12} />}
          {sub || tok?.label}
        </div>
      )}
    </div>
  );
};

const EVIDENCE_LABEL: Record<Evidence['kind'], string> = {
  health: 'health check', log: '/var/log', metric: 'metric', graph: 'dependency graph', config: '/etc/kubernetes',
};

const SEV_LEVEL: Record<Severity, Level> = { critical: 'critical', warning: 'warn', info: 'unknown' };

/**
 * One fused issue. The evidence row is the point of the whole feature: it names
 * which independent signals agree, so "confirmed" is auditable rather than a
 * claim you have to trust.
 */
const IssueCard: React.FC<{ issue: Issue }> = ({ issue }) => {
  const tok = LEVEL_TOKEN[SEV_LEVEL[issue.severity]];
  const kinds = Array.from(new Set(issue.evidence.map((e) => e.kind)));
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState('');
  const copy = (c: string) => {
    navigator.clipboard?.writeText(c).then(() => { setCopied(c); setTimeout(() => setCopied(''), 1400); }).catch(() => {});
  };
  return (
    <div style={{
      border: '1px solid var(--border-color)', borderLeft: `3px solid ${tok.color}`,
      borderRadius: 8, padding: '10px 12px', background: 'var(--bg-tertiary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <tok.Icon size={13} style={{ color: tok.color, flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-heading)' }}>{issue.title}</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>on {issue.subject}</span>
        <span style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
          color: issue.confidence === 'confirmed' ? 'var(--status-success)' : 'var(--text-muted)',
          border: `1px solid ${issue.confidence === 'confirmed' ? 'var(--status-success)' : 'var(--border-strong)'}`,
          borderRadius: 999, padding: '1px 6px',
        }}>
          {issue.confidence === 'confirmed' ? `corroborated by ${kinds.length} sources` : 'single source'}
        </span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '6px 0 8px', lineHeight: 1.5 }}>
        {issue.why}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {issue.evidence.slice(0, more ? undefined : 4).map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 11 }}>
            <span style={{
              fontSize: 9.5, color: 'var(--text-muted)', minWidth: 96,
              textTransform: 'uppercase', letterSpacing: '0.03em',
            }}>
              {EVIDENCE_LABEL[e.kind]}
            </span>
            <span style={{ color: 'var(--text-primary)' }}>
              {e.summary}
              {e.count && e.count > 1 && (
                <span style={{ color: 'var(--text-muted)' }}> &times;{e.count}</span>
              )}
            </span>
          </div>
        ))}
      </div>

      {(issue.evidence.length > 4 || issue.checks.length > 0) && (
        <button type="button" onClick={() => setMore((m) => !m)}
          style={{ marginTop: 6, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, color: 'var(--hpe-green)', display: 'flex', alignItems: 'center', gap: 3 }}>
          {more ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {more ? 'Less' : `${issue.evidence.length > 4 ? `${issue.evidence.length - 4} more signals · ` : ''}${issue.checks.length} check${issue.checks.length === 1 ? '' : 's'} to run`}
        </button>
      )}

      {more && issue.checks.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>read-only commands to run next</div>
          {issue.checks.map((c) => (
            <div key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
              <code style={{ flex: 1, fontSize: 11, color: 'var(--text-secondary)', background: 'var(--code-bg, var(--bg-secondary))', padding: '3px 7px', borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{c}</code>
              <button type="button" className="icon-btn secondary" style={{ padding: 4 }} onClick={() => copy(c)} title="Copy">
                {copied === c ? <Check size={11} /> : <Copy size={11} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {issue.units.length > 0 && (
        <div style={{ marginTop: 7, fontSize: 10, color: 'var(--text-muted)' }}>
          units: {issue.units.join(', ')}
        </div>
      )}
    </div>
  );
};

const LevelChip: React.FC<{ level: Level }> = ({ level }) => {
  const tok = LEVEL_TOKEN[level];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600,
      color: tok.color, border: `1px solid ${tok.color}`, borderRadius: 999, padding: '1px 7px',
      opacity: 0.95,
    }}>
      <tok.Icon size={10} /> {tok.label}
    </span>
  );
};

// ── Page ────────────────────────────────────────────────────────────────────

interface ObservabilityProps {
  /** The app's current cluster data, for the Kubernetes resource panel. */
  k8sResources?: { pods: any[]; nodes: any[] };
  source?: string;
  vmNames?: string[];
}

type SortKey = 'attention' | 'name' | 'cpuPct' | 'memUsedPct' | 'diskUsedPct' | 'gpuUtilPct';

const Observability: React.FC<ObservabilityProps> = ({ k8sResources, source = 'local', vmNames = [] }) => {
  const [rangeMin, setRangeMin] = useState(60);
  const [hostQuery, setHostQuery] = useState('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'attention' | 'down'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('attention');
  const [openHosts, setOpenHosts] = useState<Set<string>>(new Set());
  const [allIssues, setAllIssues] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [overlayMetric, setOverlayMetric] = useState('cpuPct');
  const [status, setStatus] = useState<any>(null);
  const [latest, setLatest] = useState<Record<string, HostLatest>>({});
  const [seriesByHost, setSeriesByHost] = useState<Record<string, { series: Record<string, Point[]> }>>({});
  const [metrics, setMetrics] = useState<MetricMeta[]>([]);
  const [insight, setInsight] = useState<Record<string, { issues: Issue[] }>>({});
  const [loading, setLoading] = useState(true);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState('');

  const isDark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  const seriesColors = isDark ? SERIES_DARK : SERIES_LIGHT;

  const load = useCallback(async () => {
    try {
      const [st, lt, se, ins] = await Promise.all([
        fetch('/api/metrics/status').then((r) => r.json()),
        fetch('/api/metrics/latest').then((r) => r.json()),
        fetch(`/api/metrics/series?sinceMin=${rangeMin}&points=240`).then((r) => r.json()),
        fetch('/api/insight/fleet').then((r) => r.json()).catch(() => ({ hosts: {} })),
      ]);
      setStatus(st);
      setMetrics(st.metrics || []);
      setLatest(lt.hosts || {});
      setSeriesByHost(se.hosts || {});
      setInsight(ins.hosts || {});
      setUpdatedAt(new Date());
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not reach the Trinetra backend.');
    } finally {
      setLoading(false);
    }
  }, [rangeMin]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { if (!document.hidden) void load(); }, 30000);
    return () => clearInterval(id);
  }, [load, autoRefresh]);

  const sampleNow = async () => {
    setSampling(true);
    try {
      await fetch('/api/metrics/sample', { method: 'POST' });
      await load();
    } finally {
      setSampling(false);
    }
  };

  const hosts = useMemo(() => Object.keys(latest).sort(), [latest]);
  const metaOf = useCallback(
    (id: string): MetricMeta => metrics.find((m) => m.id === id) || { id, label: id, unit: '', ratio: true },
    [metrics],
  );

  const fleet = useMemo(() => {
    const vals = Object.values(latest);
    const up = vals.filter((h) => h.reachable && !h.stale).length;
    const attention = vals.filter((h) => h.level === 'warn' || h.level === 'critical').length;
    const down = vals.filter((h) => !h.reachable).length;
    const gpus = vals.reduce((a, h) => a + (h.gpus || 0), 0);
    const disks = vals.map((h) => h.fullest?.usePct ?? 0);
    const worstDisk = disks.length ? Math.max(...disks) : null;
    const worstHost = vals.find((h) => (h.fullest?.usePct ?? -1) === worstDisk);
    return { total: vals.length, up, attention, down, gpus, worstDisk, worstHost };
  }, [latest]);

  // Everything wrong across the estate, worst first. Metrics-and-graph only —
  // a /var/log scan is 120s per host, so it is offered per host, not here.
  const fleetIssues = useMemo(() => {
    const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    return Object.values(insight)
      .flatMap((h) => h.issues || [])
      .sort((a, b) =>
        rank[a.severity] - rank[b.severity] ||
        (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1));
  }, [insight]);

  // Overlay is capped at five: past that, colour stops being able to carry
  // identity safely, and the per-host cards below already tell the whole story.
  const overlaySeries: OverlaySeries[] = useMemo(() => {
    const ranked = [...hosts].sort((a, b) => {
      const rank = (h: string) => (latest[h]?.level === 'critical' ? 0 : latest[h]?.level === 'warn' ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    return ranked.slice(0, MAX_OVERLAY_SERIES).map((h, i) => ({
      name: h,
      color: seriesColors[i % seriesColors.length],
      points: seriesByHost[h]?.series?.[overlayMetric] || [],
    }));
  }, [hosts, latest, seriesByHost, overlayMetric, seriesColors]);

  const visibleHosts = useMemo(() => {
    const q = hostQuery.trim().toLowerCase();
    const rank = (h: string) => (latest[h]?.level === 'critical' ? 0 : latest[h]?.level === 'warn' ? 1 : !latest[h]?.reachable ? 2 : 3);
    const val = (h: string, k: string) => latest[h]?.values?.[k]?.v ?? -1;
    return hosts
      .filter((h) => !q || h.toLowerCase().includes(q))
      .filter((h) => levelFilter === 'all'
        || (levelFilter === 'attention' && (latest[h]?.level === 'warn' || latest[h]?.level === 'critical'))
        || (levelFilter === 'down' && !latest[h]?.reachable))
      .sort((a, b) => sortKey === 'name' ? a.localeCompare(b)
        : sortKey === 'attention' ? rank(a) - rank(b) || a.localeCompare(b)
          : val(b, sortKey) - val(a, sortKey) || a.localeCompare(b));
  }, [hosts, latest, hostQuery, levelFilter, sortKey]);

  const exportCsv = () => {
    const ids = metrics.map((m) => m.id);
    const header = ['Host', 'Level', 'Reachable', 'Sampled at', 'CPUs', 'GPUs', 'Uptime', 'Fullest mount', ...metrics.map((m) => `${m.label}${m.unit ? ` (${m.unit})` : ''}`)];
    const body = hosts.map((h) => {
      const x = latest[h];
      return [h, x.level, x.reachable ? 'yes' : 'no', x.at || '', x.cpus ?? '', x.gpus, fmtUptime(x.uptimeSec),
        x.fullest ? `${x.fullest.mount} ${x.fullest.usePct.toFixed(0)}%` : '', ...ids.map((id) => x.values?.[id]?.v ?? '')];
    });
    downloadText(toCsv([header, ...body]), `trinetra-observability-${stamp()}.csv`, 'text/csv');
  };

  const pollerOn = !!status?.enabled;
  const accent = isDark ? SERIES_DARK[0] : SERIES_LIGHT[0];

  return (
    <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ── Controls: one row above the charts ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                      borderRadius: 7, overflow: 'hidden' }}>
          {RANGES.map((r) => (
            <button key={r.label} onClick={() => setRangeMin(r.min)}
              style={{
                background: rangeMin === r.min ? 'var(--bg-hover)' : 'transparent',
                color: rangeMin === r.min ? 'var(--text-primary)' : 'var(--text-muted)',
                border: 'none', padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontWeight: 600,
              }}>
              {r.label}
            </button>
          ))}
        </div>

        <button onClick={() => void sampleNow()} disabled={sampling}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)', borderRadius: 7, padding: '6px 12px',
            fontSize: 11, color: 'var(--text-secondary)', cursor: sampling ? 'default' : 'pointer',
          }}>
          <RefreshCw size={12} style={{ animation: sampling ? 'spin 1s linear infinite' : undefined }} />
          {sampling ? 'Sampling…' : 'Sample now'}
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> Auto-refresh (30s)
        </label>
        {updatedAt && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>updated {updatedAt.toLocaleTimeString()}</span>}
        <button onClick={exportCsv} disabled={!hosts.length}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)', borderRadius: 7, padding: '6px 12px',
            fontSize: 11, color: 'var(--text-secondary)', cursor: hosts.length ? 'pointer' : 'default',
          }}>
          <Download size={12} /> Export CSV
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11,
                      color: pollerOn ? 'var(--status-success)' : 'var(--text-muted)' }}>
          <Activity size={12} />
          {pollerOn
            ? `Sampling every ${status?.intervalSec}s · keeping ${status?.retentionHours}h`
            : 'Background sampling off — set TRINETRA_METRICS=1 to record continuously'}
        </div>
      </div>

      {error && (
        <div style={{ background: 'var(--status-error-glow)', border: '1px solid var(--status-error)',
                      color: 'var(--status-error)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* ── Fleet headline numbers ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <StatTile Icon={Server} label="Hosts reporting" value={`${fleet.up}/${fleet.total}`}
                  level={fleet.down > 0 ? 'critical' : fleet.total ? 'ok' : 'unknown'}
                  sub={fleet.down > 0 ? `${fleet.down} unreachable` : undefined} />
        <StatTile Icon={AlertTriangle} label="Need attention" value={String(fleet.attention)}
                  level={fleet.attention > 0 ? 'warn' : 'ok'}
                  sub={fleet.attention > 0 ? 'over threshold' : 'all within limits'} />
        <StatTile Icon={Zap} label="GPUs seen" value={String(fleet.gpus)}
                  sub={fleet.gpus === 0 ? 'no nvidia-smi on these hosts' : undefined} />
        <StatTile Icon={HardDrive} label="Fullest filesystem"
                  value={fleet.worstDisk === null ? '—' : `${fleet.worstDisk.toFixed(0)}%`}
                  level={fleet.worstDisk === null ? 'unknown' : fleet.worstDisk >= 95 ? 'critical' : fleet.worstDisk >= 85 ? 'warn' : 'ok'}
                  sub={fleet.worstHost?.fullest ? `${fleet.worstHost.fullest.mount}` : undefined} />
      </div>

      {/* ── Kubernetes: CPU / memory / GPU used and requested, per node ── */}
      {k8sResources && (k8sResources.nodes || []).length > 0 && (
        <ClusterMetrics k8sResources={k8sResources} source={source} vmNames={vmNames} />
      )}

      {/* ── What needs attention: the fused view ── */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 13, color: 'var(--text-heading)', fontWeight: 600 }}>
            What needs attention
          </h3>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            health checks, metrics and the dependency graph, merged per problem
          </span>
        </div>
        {fleetIssues.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            <CheckCircle2 size={14} style={{ color: 'var(--status-success)' }} />
            {hosts.length === 0
              ? 'No hosts sampled yet.'
              : 'Nothing is wrong that Trinetra can see from stored data. Run a deep scan on Host Logs to include /var/log.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {fleetIssues.slice(0, allIssues ? undefined : 8).map((i) => <IssueCard key={i.id} issue={i} />)}
            {fleetIssues.length > 8 && (
              <button type="button" onClick={() => setAllIssues((a) => !a)}
                style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--hpe-green)' }}>
                {allIssues ? 'Show the top 8 only' : `Show all ${fleetIssues.length} issues`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── One metric across hosts ── */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 13, color: 'var(--text-heading)', fontWeight: 600 }}>
            {metaOf(overlayMetric).label} across hosts
          </h3>
          <select value={overlayMetric} onChange={(e) => setOverlayMetric(e.target.value)}
            style={{
              background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontSize: 11,
              border: '1px solid var(--border-color)', borderRadius: 6, padding: '4px 8px',
            }}>
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {hosts.length > MAX_OVERLAY_SERIES && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              showing {MAX_OVERLAY_SERIES} of {hosts.length} — most affected first; all hosts below
            </span>
          )}
          {/* Legend is always present for ≥2 series */}
          {overlaySeries.length > 1 && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {overlaySeries.map((s) => (
                <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-secondary)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
                  {s.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <LineChart series={overlaySeries} meta={metaOf(overlayMetric)} />
      </div>

      {/* ── Small multiples: one card per host ── */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading samples…</div>
      ) : hosts.length === 0 ? (
        <div style={{
          background: 'var(--bg-card)', border: '1px dashed var(--border-strong)', borderRadius: 10,
          padding: '28px 20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.7,
        }}>
          <Gauge size={22} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div style={{ color: 'var(--text-heading)', fontWeight: 600, marginBottom: 4 }}>No samples yet</div>
          Add hosts on the <strong>K8s Nodes</strong> tab, then press <strong>Sample now</strong> above.<br />
          To record continuously, start Trinetra with <code>TRINETRA_METRICS=1</code>.
        </div>
      ) : (
        <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 13, color: 'var(--text-heading)', fontWeight: 600 }}>Hosts</h3>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{visibleHosts.length} of {hosts.length}</span>
          <div style={{ display: 'flex', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 7, overflow: 'hidden' }}>
            {([['all', 'All'], ['attention', 'Need attention'], ['down', 'Unreachable']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setLevelFilter(k)}
                style={{
                  background: levelFilter === k ? 'var(--bg-hover)' : 'transparent',
                  color: levelFilter === k ? 'var(--text-primary)' : 'var(--text-muted)',
                  border: 'none', padding: '5px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600,
                }}>{label}</button>
            ))}
          </div>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontSize: 11, border: '1px solid var(--border-color)', borderRadius: 6, padding: '4px 8px' }}>
            <option value="attention">Sort: most affected first</option>
            <option value="name">Sort: name</option>
            <option value="cpuPct">Sort: CPU</option>
            <option value="memUsedPct">Sort: memory</option>
            <option value="diskUsedPct">Sort: disk</option>
            <option value="gpuUtilPct">Sort: GPU</option>
          </select>
          <div style={{ position: 'relative', marginLeft: 'auto' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: 7, color: 'var(--text-muted)' }} />
            <input value={hostQuery} onChange={(e) => setHostQuery(e.target.value)} placeholder="Find a host…"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 11.5, border: '1px solid var(--border-color)', borderRadius: 6, padding: '5px 8px 5px 26px', width: 190 }} />
          </div>
        </div>
        {visibleHosts.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No host matches these filters.</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {visibleHosts.map((h) => {
            const host = latest[h];
            const hostSeries = seriesByHost[h]?.series || {};
            const isOpen = openHosts.has(h);
            // Everything sampled for this host beyond the four card metrics.
            const extra = metrics.filter((m) => !(CARD_METRICS as readonly string[]).includes(m.id)
              && ((host.values?.[m.id]?.v ?? null) !== null || (hostSeries[m.id] || []).some((p) => p.v !== null)));
            return (
              <div key={h} style={{
                background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                borderLeft: `3px solid ${LEVEL_TOKEN[host.level].color}`,
                borderRadius: 10, padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Server size={13} style={{ color: 'var(--text-muted)' }} />
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-heading)' }}>{h}</span>
                  <span style={{ marginLeft: 'auto' }}><LevelChip level={host.level} /></span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
                  {host.reachable
                    ? `${host.cpus ?? '—'} CPU · up ${fmtUptime(host.uptimeSec)}${host.gpus ? ` · ${host.gpus} GPU` : ''}${host.stale ? ' · sample is stale' : ''}`
                    : host.error || 'unreachable'}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {CARD_METRICS.map((mid) => {
                    const meta = metaOf(mid);
                    const cur = host.values?.[mid];
                    const Icon = METRIC_ICON[mid] || Activity;
                    // A host with no GPU should not show an empty GPU row.
                    if (mid === 'gpuUtilPct' && !host.gpus) return null;
                    return (
                      <div key={mid} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, width: 74,
                                       fontSize: 10.5, color: 'var(--text-secondary)' }}>
                          <Icon size={11} /> {meta.label}
                        </span>
                        <span style={{
                          width: 52, textAlign: 'right', fontSize: 12, fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                          color: cur && cur.level !== 'ok' && cur.level !== 'unknown'
                            ? LEVEL_TOKEN[cur.level].color : 'var(--text-primary)',
                        }}>
                          {fmt(cur?.v ?? null, meta.unit)}
                        </span>
                        <Sparkline points={hostSeries[mid] || []} color={accent} ratio={meta.ratio} />
                      </div>
                    );
                  })}
                  {isOpen && extra.map((meta) => {
                    const cur = host.values?.[meta.id];
                    const Icon = METRIC_ICON[meta.id] || Activity;
                    return (
                      <div key={meta.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, width: 74, fontSize: 10.5, color: 'var(--text-secondary)' }} title={meta.label}>
                          <Icon size={11} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.label}</span>
                        </span>
                        <span style={{
                          width: 52, textAlign: 'right', fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                          color: cur && cur.level !== 'ok' && cur.level !== 'unknown' ? LEVEL_TOKEN[cur.level].color : 'var(--text-primary)',
                        }}>
                          {fmt(cur?.v ?? null, meta.unit)}
                        </span>
                        <Sparkline points={hostSeries[meta.id] || []} color={accent} ratio={meta.ratio} />
                      </div>
                    );
                  })}
                  {host.fullest && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      fullest mount {host.fullest.mount} at {host.fullest.usePct.toFixed(0)}%
                    </div>
                  )}
                  {extra.length > 0 && (
                    <button type="button"
                      onClick={() => setOpenHosts((cur) => { const n = new Set(cur); if (n.has(h)) n.delete(h); else n.add(h); return n; })}
                      style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, color: 'var(--hpe-green)', display: 'flex', alignItems: 'center', gap: 3 }}>
                      {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      {isOpen ? 'Fewer metrics' : `${extra.length} more metric${extra.length === 1 ? '' : 's'} (load, swap, GPU memory/temp/power…)`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
};

export default Observability;
