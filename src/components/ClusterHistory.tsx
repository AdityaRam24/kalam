import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  History, RefreshCw, Camera, AlertTriangle, Filter, Search, X, Clock, User,
  Layers, ChevronRight, Server, Database, Shield, Network, Box, Activity,
  Download, ChevronsDownUp, ChevronsUpDown, FolderTree, BarChart3, Flame,
} from 'lucide-react';
import { downloadText, stamp, toCsv } from '../lib/health';

// The cluster changelog.
//
// Everything else in Kalam shows the cluster as it is now. This view is the
// only one that answers "what changed?" — and it can only answer it because
// the backend has been quietly fingerprinting the cluster and diffing the
// result. Two things follow from that, and the UI has to be honest about both:
//
//   - Nothing exists before the first capture. A fresh install shows an empty
//     timeline, and saying so plainly is better than looking broken.
//   - History only advances while something captures. If the poller is off,
//     the header says so and offers the button that fixes it.
//
// Slicing: namespace, object kind and writer come from /api/history/facets,
// which lists every namespace Kalam tracks (so a quiet namespace is still
// selectable) plus an activity histogram for the window.

interface FieldChange { path: string; from?: string; to?: string }

interface ChangeEvent {
  id: string;
  at: string;
  actualAt?: string;
  source: string;
  kind: string;
  severity: 'info' | 'notice' | 'warning';
  objectKind: string;
  name: string;
  namespace?: string;
  summary: string;
  fields: FieldChange[];
  actor?: string;
  actorOp?: string;
  cause?: string;
  revision?: string;
  owner?: string;
  causedBy?: string;
}

interface Poller {
  enabled: boolean;
  intervalSec: number;
  sources: string[];
  running: boolean;
  lastRunAt?: string;
  lastError?: string;
}

interface Facets {
  namespaces: Array<{ name: string; changes: number; objects: number }>;
  objectKinds: Array<{ kind: string; changes: number }>;
  actors: Array<{ actor: string; changes: number }>;
  topObjects: Array<{ objectKind: string; namespace?: string; name: string; changes: number }>;
  buckets: Array<{ start: string; total: number; warning: number }>;
  bucketMs: number;
  total: number;
  warnings: number;
}

// One accent per category, so a glance at the left edge of the timeline tells
// you whether the last hour was workloads, nodes or permissions.
const KIND_STYLE: Record<string, { color: string; label: string; icon: React.ComponentType<any> }> = {
  created:   { color: '#01A982', label: 'created',    icon: Box },
  deleted:   { color: '#E5484D', label: 'deleted',    icon: X },
  image:     { color: '#7630EA', label: 'image',      icon: Layers },
  scaled:    { color: '#00A3E0', label: 'scaled',     icon: Layers },
  spec:      { color: '#00B39A', label: 'spec',       icon: Box },
  config:    { color: '#FF8300', label: 'config',     icon: Database },
  network:   { color: '#FBBF24', label: 'network',    icon: Network },
  rbac:      { color: '#F472B6', label: 'rbac',       icon: Shield },
  storage:   { color: '#38BDF8', label: 'storage',    icon: Database },
  schedule:  { color: '#94A3B8', label: 'scheduling', icon: Server },
  restarted: { color: '#E5484D', label: 'restart',    icon: RefreshCw },
  lifecycle: { color: '#E07000', label: 'lifecycle',  icon: Activity },
  cordon:    { color: '#E5484D', label: 'cordon',     icon: Server },
  taint:     { color: '#FF8300', label: 'taint',      icon: Server },
  version:   { color: '#7630EA', label: 'version',    icon: Server },
};

const SINCE_OPTIONS = [
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '', label: 'Everything kept' },
];

const CLUSTER_SCOPED = '(cluster-scoped)';
const PAGE = 400;

function ago(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const dayOf = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? 'Unknown' : d.toDateString();
};

const selectStyle: React.CSSProperties = { width: 'auto', padding: '5px 10px', fontSize: 12, maxWidth: 260 };

/** Activity over the window; a bar narrows the timeline to its time slice. */
const Histogram: React.FC<{
  facets: Facets; selected: string | null; onSelect: (start: string | null) => void;
}> = ({ facets, selected, onSelect }) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...facets.buckets.map((b) => b.total));
  const hourly = facets.bucketMs < 86_400_000;
  const label = (iso: string) => {
    const d = new Date(iso);
    return hourly ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const H = 70;
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: H, padding: '0 2px' }} onMouseLeave={() => setHover(null)}>
        {facets.buckets.map((b, i) => {
          const h = b.total ? Math.max(3, (b.total / max) * (H - 4)) : 1;
          const wh = b.total ? (b.warning / b.total) * h : 0;
          const isSel = selected === b.start;
          return (
            <div key={b.start}
              onMouseEnter={() => setHover(i)}
              onClick={() => b.total && onSelect(isSel ? null : b.start)}
              title={`${label(b.start)} — ${b.total} change${b.total === 1 ? '' : 's'}${b.warning ? `, ${b.warning} need attention` : ''}`}
              style={{
                flex: 1, minWidth: 3, height: h, cursor: b.total ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                background: b.total ? (isSel ? 'var(--hpe-green)' : 'rgba(1, 169, 130, 0.45)') : 'var(--border-color)',
                outline: hover === i && b.total ? '1px solid var(--hpe-green)' : undefined, borderRadius: 2,
                opacity: selected && !isSel ? 0.45 : 1,
              }}>
              {wh > 0 && <div style={{ height: wh, background: 'var(--status-error)', borderRadius: '0 0 2px 2px' }} />}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
        <span>{facets.buckets[0] ? label(facets.buckets[0].start) : ''}</span>
        <span>{hover !== null && facets.buckets[hover] ? `${label(facets.buckets[hover].start)} · ${facets.buckets[hover].total} changes` : `${hourly ? 'hourly' : 'daily'} · red = needs attention · click a bar to zoom`}</span>
        <span>now</span>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string | number; sub?: string; color?: string; icon: React.ReactNode }> = ({ label, value, sub, color, icon }) => (
  <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '10px 12px', minWidth: 0 }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--text-secondary)' }}>{icon}{label}</div>
    <div style={{ fontSize: 20, fontWeight: 650, color: color || 'var(--text-heading)', marginTop: 2, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(value)}>{value}</div>
    {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sub}>{sub}</div>}
  </div>
);

interface Props {
  /** The app's selected source; used as the starting source here. */
  defaultSource?: string;
}

export const ClusterHistory: React.FC<Props> = ({ defaultSource }) => {
  const [source, setSource] = useState(defaultSource && defaultSource !== 'all' ? defaultSource : 'local');
  const [sources, setSources] = useState<string[]>(['local']);
  const [changes, setChanges] = useState<ChangeEvent[]>([]);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [poller, setPoller] = useState<Poller | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | undefined>();
  const [tracked, setTracked] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const [since, setSince] = useState('24h');
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [namespace, setNamespace] = useState('all');
  const [objectKind, setObjectKind] = useState('all');
  const [actor, setActor] = useState('all');
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<'day' | 'namespace' | 'object'>('day');
  const [hideConsequences, setHideConsequences] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [capturing, setCapturing] = useState(false);
  const [captureNote, setCaptureNote] = useState('');

  useEffect(() => {
    fetch('/api/history/status')
      .then((r) => r.json())
      .then((d) => {
        if (d.availableSources) setSources(d.availableSources);
        if (d.poller) setPoller(d.poller);
      })
      .catch(() => {});
  }, []);

  // A new source or window invalidates the slice the user had picked.
  useEffect(() => { setBucket(null); setLimit(PAGE); }, [source, since]);
  useEffect(() => { setNamespace('all'); setObjectKind('all'); setActor('all'); }, [source]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ source, limit: String(limit) });
      if (since) params.set('since', since);
      if (category !== 'all') params.set('kind', category);
      if (severity !== 'all') params.set('severity', severity);
      if (namespace !== 'all' && namespace !== CLUSTER_SCOPED) params.set('namespace', namespace);
      if (objectKind !== 'all') params.set('objectKind', objectKind);
      if (actor !== 'all') params.set('actor', actor);
      if (search.trim()) params.set('q', search.trim());
      const facetParams = new URLSearchParams({ source });
      if (since) facetParams.set('since', since);
      const [res, fres] = await Promise.all([
        fetch(`/api/history?${params}`),
        fetch(`/api/history/facets?${facetParams}`),
      ]);
      const d = await res.json();
      const f = await fres.json().catch(() => null);
      if (d.error) setError(d.error);
      else {
        setChanges(d.changes || []);
        setCapturedAt(d.capturedAt);
        setTracked(d.trackedObjects || 0);
        if (d.poller) setPoller(d.poller);
      }
      if (f && !f.error) setFacets(f);
    } catch (e: any) {
      setError(e.message || 'Could not load the history.');
    } finally {
      setLoading(false);
    }
  }, [source, since, category, severity, namespace, objectKind, actor, search, limit]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0); // debounce typing only
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const captureNow = async () => {
    setCapturing(true);
    setCaptureNote('');
    try {
      const res = await fetch('/api/history/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const d = await res.json();
      if (d.error) setCaptureNote(d.error);
      else {
        const notes = (d.notes || []).join(' ');
        setCaptureNote(
          d.changes > 0
            ? `${d.changes} change${d.changes === 1 ? '' : 's'} recorded from ${d.objects} objects in ${d.durationMs}ms.`
            : notes || `No changes since the last capture (${d.objects} objects, ${d.durationMs}ms).`
        );
        await load();
      }
    } catch (e: any) {
      setCaptureNote(e.message);
    } finally {
      setCapturing(false);
    }
  };

  // Client-side refinements the API does not do: cluster-scoped only, one
  // histogram slice, and hiding consequences of another change.
  const visible = useMemo(() => {
    const start = bucket ? Date.parse(bucket) : 0;
    const end = bucket && facets ? start + facets.bucketMs : 0;
    return changes.filter((c) => {
      if (namespace === CLUSTER_SCOPED && c.namespace) return false;
      if (hideConsequences && c.causedBy) return false;
      if (bucket) {
        const t = Date.parse(c.at);
        if (t < start || t >= end) return false;
      }
      return true;
    });
  }, [changes, namespace, bucket, facets, hideConsequences]);

  const grouped = useMemo(() => {
    const keyOf = (c: ChangeEvent) =>
      groupBy === 'day' ? dayOf(c.actualAt || c.at)
        : groupBy === 'namespace' ? (c.namespace || CLUSTER_SCOPED)
          : `${c.objectKind} ${c.namespace ? `${c.namespace}/` : ''}${c.name}`;
    const out: Array<{ key: string; items: ChangeEvent[] }> = [];
    const index = new Map<string, number>();
    for (const c of visible) {
      const k = keyOf(c);
      const i = index.get(k);
      if (i === undefined) { index.set(k, out.length); out.push({ key: k, items: [c] }); }
      else out[i].items.push(c);
    }
    // Day groups stay chronological; the others put the busiest first.
    if (groupBy !== 'day') out.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
    return out;
  }, [visible, groupBy]);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of changes) seen.set(c.kind, (seen.get(c.kind) || 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [changes]);

  const stats = useMemo(() => {
    const objects = new Set(visible.map((c) => `${c.objectKind}/${c.namespace || ''}/${c.name}`));
    const nss = new Set(visible.map((c) => c.namespace || CLUSTER_SCOPED));
    const actors = new Map<string, number>();
    for (const c of visible) if (c.actor) actors.set(c.actor, (actors.get(c.actor) || 0) + 1);
    const topActor = [...actors.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      total: visible.length,
      warnings: visible.filter((c) => c.severity === 'warning').length,
      objects: objects.size,
      namespaces: nss.size,
      topActor,
      latest: visible[0]?.at,
    };
  }, [visible]);

  const activeFilters = [
    namespace !== 'all' && { label: `namespace: ${namespace}`, clear: () => setNamespace('all') },
    objectKind !== 'all' && { label: `kind: ${objectKind}`, clear: () => setObjectKind('all') },
    actor !== 'all' && { label: `by: ${actor}`, clear: () => setActor('all') },
    category !== 'all' && { label: `change: ${KIND_STYLE[category]?.label || category}`, clear: () => setCategory('all') },
    severity !== 'all' && { label: `severity: ${severity}`, clear: () => setSeverity('all') },
    bucket && { label: `time: ${new Date(bucket).toLocaleString()}`, clear: () => setBucket(null) },
    search.trim() && { label: `"${search.trim()}"`, clear: () => setSearch('') },
  ].filter(Boolean) as Array<{ label: string; clear: () => void }>;

  const clearAll = () => {
    setNamespace('all'); setObjectKind('all'); setActor('all'); setCategory('all');
    setSeverity('all'); setBucket(null); setSearch(''); setHideConsequences(false);
  };

  const exportCsv = () => {
    const header = ['Observed', 'Happened', 'Source', 'Severity', 'Change', 'Kind', 'Namespace', 'Name', 'Summary', 'Changed by', 'Operation', 'Revision', 'Change cause', 'Fields'];
    const body = visible.map((c) => [c.at, c.actualAt, c.source, c.severity, c.kind, c.objectKind, c.namespace, c.name, c.summary, c.actor, c.actorOp, c.revision, c.cause,
      c.fields.map((f) => `${f.path}: ${f.from ?? '—'} -> ${f.to ?? '—'}`).join('; ')]);
    downloadText(toCsv([header, ...body]), `kalam-history-${source}-${stamp()}.csv`, 'text/csv');
  };
  const exportJson = () => downloadText(JSON.stringify({ source, since: since || 'all', exportedAt: new Date().toISOString(), changes: visible }, null, 2),
    `kalam-history-${source}-${stamp()}.json`, 'application/json');

  const toggle = (id: string) => setExpanded((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const nsOptions = facets?.namespaces || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ─── Capture state ─── */}
      <div className="panel-card" style={{ borderLeft: `3px solid ${poller?.enabled ? 'var(--hpe-green)' : 'var(--border-strong)'}` }}>
        <div className="panel-card-title">
          <h2><History size={17} /> Cluster Change History</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
            <select className="form-input" value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle} title="Which cluster's history">
              {sources.map((s) => <option key={s} value={s}>{s === 'local' ? 'This machine' : `VM: ${s}`}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }} title="Reload the timeline every 30 seconds">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> Auto-refresh
            </label>
            <button className="btn secondary" onClick={captureNow} disabled={capturing} style={{ padding: '5px 12px', fontSize: 12 }}>
              {capturing ? <RefreshCw size={13} className="animate-spin" /> : <Camera size={13} />} Capture now
            </button>
            <button className="btn secondary" onClick={load} disabled={loading} style={{ padding: '5px 12px', fontSize: 12 }}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: poller?.enabled ? 'var(--hpe-green)' : 'var(--text-muted)',
              boxShadow: poller?.enabled ? '0 0 6px var(--hpe-green)' : 'none',
            }} />
            {poller?.enabled
              ? `Capturing ${poller.sources.join(', ') || source} every ${poller.intervalSec}s`
              : 'Background capture is off'}
          </span>
          {capturedAt && <span><Clock size={11} style={{ verticalAlign: -1 }} /> last capture {ago(capturedAt)}</span>}
          {tracked > 0 && <span>{tracked} objects tracked</span>}
          {poller?.lastError && <span className="badge error" title={poller.lastError}>capture error</span>}
        </div>

        {!poller?.enabled && (
          <p style={{ margin: '10px 0 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            History only advances while something captures the cluster. Use <strong>Capture now</strong> for a
            point-in-time comparison, or set <code className="code-tag">KALAM_HISTORY=1</code> (optionally
            <code className="code-tag">KALAM_HISTORY_INTERVAL_SEC=300</code> and
            <code className="code-tag">KALAM_HISTORY_SOURCES=all</code>) before starting the server to record
            continuously. Captures are read-only: they run <code className="code-tag">kubectl get</code> and nothing else.
          </p>
        )}

        {captureNote && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)'
          }}>
            {captureNote}
          </div>
        )}
      </div>

      {/* ─── Overview: numbers, activity, hot spots ─── */}
      {facets && facets.total > 0 && (
        <div className="panel-card">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
            <Stat icon={<History size={12} />} label="Changes shown" value={stats.total} sub={`${facets.total} in the window`} />
            <Stat icon={<AlertTriangle size={12} />} label="Need attention" value={stats.warnings} color={stats.warnings ? 'var(--status-error)' : undefined} />
            <Stat icon={<Box size={12} />} label="Objects changed" value={stats.objects} />
            <Stat icon={<FolderTree size={12} />} label="Namespaces" value={stats.namespaces} />
            <Stat icon={<User size={12} />} label="Most active writer" value={stats.topActor ? stats.topActor[0] : '—'} sub={stats.topActor ? `${stats.topActor[1]} changes` : 'no writer recorded'} />
            <Stat icon={<Clock size={12} />} label="Latest change" value={stats.latest ? ago(stats.latest) : '—'} sub={stats.latest ? new Date(stats.latest).toLocaleString() : undefined} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(240px, 1fr)', gap: 16 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 8 }}>
                <BarChart3 size={13} /> Activity
              </div>
              <Histogram facets={facets} selected={bucket} onSelect={setBucket} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 8 }}>
                <Flame size={13} /> Most-changed objects
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 120, overflowY: 'auto' }}>
                {facets.topObjects.map((o) => (
                  <button key={`${o.objectKind}/${o.namespace || ''}/${o.name}`} type="button"
                    onClick={() => { setSearch(o.name); if (o.namespace) setNamespace(o.namespace); setObjectKind(o.objectKind); }}
                    title="Show only this object's changes"
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, background: 'transparent', border: 'none', padding: '2px 4px', cursor: 'pointer', fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'left', borderRadius: 4 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{o.objectKind}</span>{' '}
                      {o.namespace ? `${o.namespace}/` : ''}<strong>{o.name}</strong>
                    </span>
                    <span className="badge neutral" style={{ fontSize: 9.5, flexShrink: 0 }}>{o.changes}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Filters ─── */}
      <div className="panel-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Filter size={14} style={{ color: 'var(--text-muted)' }} />
          <select className="form-input" value={since} onChange={(e) => setSince(e.target.value)} style={selectStyle} title="Time window">
            {SINCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="form-input" value={namespace} onChange={(e) => setNamespace(e.target.value)} style={selectStyle} title="Namespace">
            <option value="all">All namespaces{nsOptions.length ? ` (${nsOptions.length})` : ''}</option>
            <option value={CLUSTER_SCOPED}>Cluster-scoped objects (nodes, PVs…)</option>
            {nsOptions.filter((n) => n.name !== CLUSTER_SCOPED).map((n) => (
              <option key={n.name} value={n.name}>
                {n.name} — {n.changes} change{n.changes === 1 ? '' : 's'}{n.objects ? ` · ${n.objects} tracked` : ''}
              </option>
            ))}
          </select>
          <select className="form-input" value={objectKind} onChange={(e) => setObjectKind(e.target.value)} style={selectStyle} title="Object kind">
            <option value="all">All kinds</option>
            {(facets?.objectKinds || []).map((k) => <option key={k.kind} value={k.kind}>{k.kind} ({k.changes})</option>)}
          </select>
          <select className="form-input" value={actor} onChange={(e) => setActor(e.target.value)} style={selectStyle} title="Who made the change (from managedFields)">
            <option value="all">Anyone</option>
            {(facets?.actors || []).map((a) => <option key={a.actor} value={a.actor}>{a.actor} ({a.changes})</option>)}
          </select>
          <select className="form-input" value={severity} onChange={(e) => setSeverity(e.target.value)} style={selectStyle} title="Severity">
            <option value="all">Any severity</option>
            <option value="warning">Needs attention</option>
            <option value="notice">Notable</option>
            <option value="info">Routine</option>
          </select>
          <div style={{ position: 'relative', marginLeft: 'auto', minWidth: 240 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
            <input
              className="form-input"
              placeholder="object, namespace or who changed it"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ padding: '5px 10px 5px 28px', fontSize: 12 }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className={`subnav-pill-btn ${category === 'all' ? 'active' : ''}`}
            onClick={() => setCategory('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            All changes {changes.length > 0 && `(${changes.length})`}
          </button>
          {categories.map(([k, n]) => (
            <button
              key={k}
              className={`subnav-pill-btn ${category === k ? 'active' : ''}`}
              onClick={() => setCategory(category === k ? 'all' : k)}
              style={{ fontSize: 11, padding: '4px 10px', color: category === k ? undefined : KIND_STYLE[k]?.color }}
            >
              {KIND_STYLE[k]?.label || k} ({n})
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Group by</span>
          <div className="subnav-pills">
            <button className={`subnav-pill-btn ${groupBy === 'day' ? 'active' : ''}`} onClick={() => setGroupBy('day')}>Day</button>
            <button className={`subnav-pill-btn ${groupBy === 'namespace' ? 'active' : ''}`} onClick={() => setGroupBy('namespace')}>Namespace</button>
            <button className={`subnav-pill-btn ${groupBy === 'object' ? 'active' : ''}`} onClick={() => setGroupBy('object')}>Object</button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)', cursor: 'pointer' }} title="Hide changes that only happened because of another change in the same capture (e.g. pods replaced by a rollout)">
            <input type="checkbox" checked={hideConsequences} onChange={(e) => setHideConsequences(e.target.checked)} /> Root changes only
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setExpanded(new Set(visible.map((c) => c.id)))} disabled={!visible.length}>
              <ChevronsUpDown size={12} /> Expand all
            </button>
            <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setExpanded(new Set())} disabled={!expanded.size}>
              <ChevronsDownUp size={12} /> Collapse all
            </button>
            <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={exportCsv} disabled={!visible.length}>
              <Download size={12} /> CSV
            </button>
            <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={exportJson} disabled={!visible.length}>
              <Download size={12} /> JSON
            </button>
          </div>
        </div>

        {activeFilters.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {activeFilters.map((f) => (
              <span key={f.label} className="badge neutral" style={{ textTransform: 'none', cursor: 'pointer' }} onClick={f.clear} title="Remove this filter">
                {f.label} <X size={10} />
              </span>
            ))}
            <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={clearAll}>Clear all</button>
          </div>
        )}
      </div>

      {/* ─── Timeline ─── */}
      {error && (
        <div className="panel-card" style={{ borderLeft: '3px solid var(--status-error)', color: 'var(--status-error)', fontSize: 13 }}>
          <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> {error}
        </div>
      )}

      {!error && !loading && visible.length === 0 && (
        <div className="panel-card" style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--text-muted)' }}>
          <History size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)' }}>
            {activeFilters.length ? 'No changes match these filters.' : capturedAt ? 'No changes in this window.' : 'No history for this source yet.'}
          </p>
          <p style={{ margin: '6px 0 0 0', fontSize: 12 }}>
            {activeFilters.length
              ? 'Remove a filter above, or widen the time window.'
              : capturedAt
                ? `${tracked} objects are being watched — the next change to any of them lands here.`
                : 'Take a capture to record a baseline. The capture after that is the one that can show changes.'}
          </p>
        </div>
      )}

      {grouped.map((group) => (
        <div key={group.key} className="panel-card">
          <div className="panel-card-title">
            <h3 style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              {groupBy === 'namespace' && <FolderTree size={13} />}
              {groupBy === 'object' && <Box size={13} />}
              {group.key}
            </h3>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {group.items.some((c) => c.severity === 'warning') && (
                <span className="badge error" style={{ fontSize: 9.5 }}>{group.items.filter((c) => c.severity === 'warning').length} attention</span>
              )}
              <span className="badge neutral">{group.items.length}</span>
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {group.items.map((c) => {
              const style = KIND_STYLE[c.kind] || { color: 'var(--text-muted)', label: c.kind, icon: Box };
              const Icon = style.icon;
              const open = expanded.has(c.id);
              const when = c.actualAt || c.at;
              return (
                <div
                  key={c.id}
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: `1px solid ${c.severity === 'warning' ? 'var(--status-error)' : 'var(--border-color)'}`,
                    borderLeft: `3px solid ${style.color}`,
                    borderRadius: 6,
                    opacity: c.causedBy ? 0.72 : 1, // consequences sit behind their cause
                  }}
                >
                  <div
                    onClick={() => toggle(c.id)}
                    style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 11px', cursor: 'pointer', fontSize: 12.5 }}
                  >
                    <ChevronRight
                      size={12}
                      style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flexShrink: 0, alignSelf: 'center' }}
                    />
                    <span className="badge neutral" style={{ fontSize: 9, color: style.color, borderColor: `${style.color}55`, flexShrink: 0 }}>
                      <Icon size={9} style={{ verticalAlign: -1, marginRight: 3 }} />{style.label}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                      {c.objectKind}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>
                        {c.namespace && (
                          <span
                            onClick={(e) => { e.stopPropagation(); setNamespace(c.namespace!); }}
                            title={`Show only namespace ${c.namespace}`}
                            style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
                          >{c.namespace}</span>
                        )}
                        {c.namespace ? '/' : ''}{c.name}
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}> — {c.summary.replace(new RegExp(`^${c.objectKind} \\S+: `), '')}</span>
                    </span>
                    {c.actor && (
                      <span
                        onClick={(e) => { e.stopPropagation(); setActor(c.actor!); }}
                        style={{ fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer' }}
                        title={`${c.actor} (${c.actorOp || 'wrote'}) — click to show only this writer's changes`}
                      >
                        <User size={9} style={{ verticalAlign: -1 }} /> {c.actor}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }} title={new Date(when).toLocaleString()}>
                      {ago(when)}
                    </span>
                  </div>

                  {open && (
                    <div style={{ padding: '2px 12px 11px 34px', borderTop: '1px solid var(--border-color)' }}>
                      {/* How we know — the attribution line */}
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', margin: '9px 0' }}>
                        {c.actor ? (
                          <>Written by <strong>{c.actor}</strong>{c.actorOp ? ` (${c.actorOp})` : ''}
                            {c.actualAt ? ` at ${new Date(c.actualAt).toLocaleString()}` : ''} — from the object's managedFields.</>
                        ) : (
                          <>No writer recorded for this change. Kubernetes only attributes writes when the API server tracks managed fields; controllers and kubelet-driven changes often have none.</>
                        )}
                        {c.revision && <> · deployment revision <code className="code-tag">{c.revision}</code></>}
                      </div>

                      {c.cause && (
                        <div style={{ fontSize: 11.5, marginBottom: 9, padding: '6px 9px', background: 'var(--bg-secondary)', borderRadius: 5, border: '1px solid var(--border-color)' }}>
                          <strong>Change cause:</strong> {c.cause}
                        </div>
                      )}

                      {c.causedBy && (
                        <div style={{ fontSize: 11.5, marginBottom: 9, color: 'var(--text-muted)' }}>
                          This is a consequence of another change in the same capture, not an independent event.
                        </div>
                      )}

                      {c.fields.length > 0 && (
                        <div className="table-wrapper" style={{ maxHeight: 260, overflow: 'auto' }}>
                          <table className="resource-table" style={{ fontSize: 11 }}>
                            <thead>
                              <tr><th>Field</th><th>Before</th><th>After</th></tr>
                            </thead>
                            <tbody>
                              {c.fields.map((f) => (
                                <tr key={f.path}>
                                  <td style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{f.path}</td>
                                  <td style={{ fontFamily: 'var(--font-mono)', color: f.from === undefined ? 'var(--text-muted)' : 'var(--status-error)', wordBreak: 'break-all' }}>
                                    {f.from === undefined ? '—' : f.from}
                                  </td>
                                  <td style={{ fontFamily: 'var(--font-mono)', color: f.to === undefined ? 'var(--text-muted)' : 'var(--hpe-green)', wordBreak: 'break-all' }}>
                                    {f.to === undefined ? '—' : f.to}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <div style={{ marginTop: 9, fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span>
                          observed {new Date(c.at).toLocaleString()} · source {c.source}
                          {c.owner && <> · owned by {c.owner}</>}
                        </span>
                        <button className="btn secondary" style={{ padding: '1px 7px', fontSize: 10.5 }}
                          onClick={() => { setSearch(c.name); if (c.namespace) setNamespace(c.namespace); setObjectKind(c.objectKind); }}>
                          All changes to this object
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {changes.length >= limit && limit < 2000 && (
        <div style={{ textAlign: 'center' }}>
          <button className="btn secondary" onClick={() => setLimit((l) => Math.min(2000, l + PAGE))} disabled={loading}>
            {loading ? 'Loading…' : `Load older changes (showing ${changes.length})`}
          </button>
        </div>
      )}
    </div>
  );
};

export default ClusterHistory;
