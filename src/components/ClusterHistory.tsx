import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  History, RefreshCw, Camera, AlertTriangle, Filter, Search, X, Clock, User,
  Layers, ChevronRight, Server, Database, Shield, Network, Box, Activity
} from 'lucide-react';

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
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '', label: 'Everything kept' },
];

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

export const ClusterHistory: React.FC = () => {
  const [source, setSource] = useState('local');
  const [sources, setSources] = useState<string[]>(['local']);
  const [changes, setChanges] = useState<ChangeEvent[]>([]);
  const [poller, setPoller] = useState<Poller | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | undefined>();
  const [tracked, setTracked] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [since, setSince] = useState('24h');
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ source, limit: '400' });
      if (since) params.set('since', since);
      if (category !== 'all') params.set('kind', category);
      if (severity !== 'all') params.set('severity', severity);
      if (search.trim()) params.set('q', search.trim());
      const res = await fetch(`/api/history?${params}`);
      const d = await res.json();
      if (d.error) setError(d.error);
      else {
        setChanges(d.changes || []);
        setCapturedAt(d.capturedAt);
        setTracked(d.trackedObjects || 0);
        if (d.poller) setPoller(d.poller);
      }
    } catch (e: any) {
      setError(e.message || 'Could not load the history.');
    } finally {
      setLoading(false);
    }
  }, [source, since, category, severity, search]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0); // debounce typing only
    return () => clearTimeout(t);
  }, [load, search]);

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

  // Group by calendar day — a changelog reads by day, not by flat list.
  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: ChangeEvent[] }> = [];
    for (const c of changes) {
      const day = dayOf(c.actualAt || c.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(c);
      else out.push({ day, items: [c] });
    }
    return out;
  }, [changes]);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of changes) seen.set(c.kind, (seen.get(c.kind) || 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [changes]);

  const warnings = changes.filter((c) => c.severity === 'warning').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ─── Capture state ─── */}
      <div className="panel-card" style={{ borderLeft: `3px solid ${poller?.enabled ? 'var(--hpe-green)' : 'var(--border-strong)'}` }}>
        <div className="panel-card-title">
          <h2><History size={17} /> Cluster Change History</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
            <select className="form-input" value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}>
              {sources.map((s) => <option key={s} value={s}>{s === 'local' ? 'This machine' : `VM: ${s}`}</option>)}
            </select>
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
          {warnings > 0 && <span className="badge warning">{warnings} need attention</span>}
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

      {/* ─── Filters ─── */}
      <div className="panel-card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Filter size={14} style={{ color: 'var(--text-muted)' }} />
        <select className="form-input" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}>
          {SINCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="form-input" value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}>
          <option value="all">Any severity</option>
          <option value="warning">Needs attention</option>
          <option value="notice">Notable</option>
          <option value="info">Routine</option>
        </select>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            className={`subnav-pill-btn ${category === 'all' ? 'active' : ''}`}
            onClick={() => setCategory('all')}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            All {changes.length > 0 && `(${changes.length})`}
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
        <div style={{ position: 'relative', marginLeft: 'auto', minWidth: 220 }}>
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

      {/* ─── Timeline ─── */}
      {error && (
        <div className="panel-card" style={{ borderLeft: '3px solid var(--status-error)', color: 'var(--status-error)', fontSize: 13 }}>
          <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> {error}
        </div>
      )}

      {!error && !loading && changes.length === 0 && (
        <div className="panel-card" style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--text-muted)' }}>
          <History size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)' }}>
            {capturedAt ? 'No changes in this window.' : 'No history for this source yet.'}
          </p>
          <p style={{ margin: '6px 0 0 0', fontSize: 12 }}>
            {capturedAt
              ? `${tracked} objects are being watched — the next change to any of them lands here.`
              : 'Take a capture to record a baseline. The capture after that is the one that can show changes.'}
          </p>
        </div>
      )}

      {grouped.map((group) => (
        <div key={group.day} className="panel-card">
          <div className="panel-card-title">
            <h3 style={{ fontSize: 13 }}>{group.day}</h3>
            <span className="badge neutral" style={{ marginLeft: 'auto' }}>{group.items.length}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {group.items.map((c) => {
              const style = KIND_STYLE[c.kind] || { color: 'var(--text-muted)', label: c.kind, icon: Box };
              const Icon = style.icon;
              const open = expanded === c.id;
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
                    onClick={() => setExpanded(open ? null : c.id)}
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
                      <span style={{ fontWeight: 600 }}>{c.namespace ? `${c.namespace}/` : ''}{c.name}</span>
                      <span style={{ color: 'var(--text-secondary)' }}> — {c.summary.replace(new RegExp(`^${c.objectKind} \\S+: `), '')}</span>
                    </span>
                    {c.actor && (
                      <span style={{ fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }} title={`${c.actor} (${c.actorOp || 'wrote'})`}>
                        <User size={9} style={{ verticalAlign: -1 }} /> {c.actor}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }} title={when}>
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

                      <div style={{ marginTop: 9, fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        observed {new Date(c.at).toLocaleString()} · source {c.source}
                        {c.owner && <> · owned by {c.owner}</>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ClusterHistory;
