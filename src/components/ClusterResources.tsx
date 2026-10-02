// Every other kind of cluster object, in one browsable place.
//
// Pods, workloads, services and nodes have their own tables on the Kubernetes
// page. Everything else an operator reaches for — certificates and issuers,
// KServe InferenceServices and runtimes, PVCs/PVs/StorageClasses, Ingresses and
// Istio routing, Jobs/CronJobs/HPAs, ConfigMaps/Secrets (names only), quotas,
// warning events, CRDs — is read by /api/k8s/extra and listed here with the
// same status vocabulary as the rest of Kalam.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, RefreshCw, Search, Download, AlertTriangle, Filter, ChevronDown, ChevronRight } from 'lucide-react';
import { HEALTH_BADGE, ageOf, downloadText, stamp, toCsv, type Health } from '../lib/health';

interface Row {
  kind: string;
  name: string;
  namespace?: string;
  created?: string;
  status: string;
  health: Health;
  info: Array<[string, string]>;
  host?: string;
}
interface KindState { kind: string; group: string; state: 'ok' | 'absent'; count: number }

const GROUP_ORDER = ['Workloads', 'AI / ML', 'Network', 'Storage', 'Certificates', 'Config', 'Cluster'];

interface Props {
  /** 'local', 'all', or an inventory VM name — same meaning as the app's source picker. */
  source: string;
  vmNames: string[];
  /** Global search box text from the top bar. */
  globalSearch?: string;
}

export const ClusterResources: React.FC<Props> = ({ source, vmNames, globalSearch = '' }) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [kinds, setKinds] = useState<Record<string, KindState>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [at, setAt] = useState<string>('');

  const [group, setGroup] = useState<string>('all');
  const [kind, setKind] = useState<string>('all');
  const [namespace, setNamespace] = useState<string>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);

  // Keyed by content, not identity: the parent rebuilds the array on every
  // render, and an identity dependency would re-read the cluster each time.
  const vmKey = vmNames.join('\n');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const targets = source === 'all' ? (vmKey ? vmKey.split('\n') : []) : [source];
      const results = await Promise.all(targets.map(async (t) => {
        const q = t === 'local' ? '' : `?vm=${encodeURIComponent(t)}`;
        const d = await fetch(`/api/k8s/extra${q}`).then((r) => r.json()).catch((e) => ({ error: e.message }));
        return { t, d };
      }));
      const merged: Row[] = [];
      const mergedKinds: Record<string, KindState> = {};
      const errors: string[] = [];
      for (const { t, d } of results) {
        if (d.error) { errors.push(source === 'all' ? `${t}: ${d.error}` : d.error); continue; }
        for (const r of d.rows || []) merged.push(source === 'all' ? { ...r, host: t } : r);
        for (const [k, v] of Object.entries(d.kinds || {}) as Array<[string, KindState]>) {
          const cur = mergedKinds[k];
          mergedKinds[k] = cur
            ? { ...cur, state: cur.state === 'ok' || v.state === 'ok' ? 'ok' : 'absent', count: cur.count + v.count }
            : { ...v };
        }
      }
      setRows(merged);
      setKinds(mergedKinds);
      setAt(new Date().toLocaleTimeString());
      if (errors.length) setError(errors.join(' · '));
    } finally {
      setLoading(false);
    }
  }, [source, vmKey]);

  useEffect(() => { void load(); }, [load]);
  // A slow-moving view: once a minute is plenty, and it never stacks requests.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const kindList = useMemo(() => Object.values(kinds), [kinds]);
  const groups = useMemo(() => GROUP_ORDER.map((g) => {
    const ks = kindList.filter((k) => k.group === g);
    const inGroup = rows.filter((r) => ks.some((k) => k.kind === r.kind));
    return { group: g, kinds: ks, count: inGroup.length, problems: inGroup.filter((r) => r.health === 'failing' || r.health === 'progressing').length };
  }).filter((g) => g.kinds.length), [kindList, rows]);

  const namespaces = useMemo(
    () => Array.from(new Set(rows.map((r) => r.namespace).filter(Boolean) as string[])).sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const q = `${query} ${globalSearch}`.trim().toLowerCase();
    const groupKinds = group === 'all' ? null : new Set(kindList.filter((k) => k.group === group).map((k) => k.kind));
    return rows.filter((r) =>
      (!groupKinds || groupKinds.has(r.kind)) &&
      (kind === 'all' || r.kind === kind) &&
      (namespace === 'all' || r.namespace === namespace) &&
      (!problemsOnly || r.health === 'failing' || r.health === 'progressing') &&
      (!q || q.split(/\s+/).every((w) => `${r.kind} ${r.name} ${r.namespace || ''} ${r.status} ${r.info.map((i) => i[1]).join(' ')} ${r.host || ''}`.toLowerCase().includes(w))),
    ).sort((a, b) => {
      const rank = (h: Health) => (h === 'failing' ? 0 : h === 'progressing' ? 1 : 2);
      return rank(a.health) - rank(b.health) || a.kind.localeCompare(b.kind) || (a.namespace || '').localeCompare(b.namespace || '') || a.name.localeCompare(b.name);
    });
  }, [rows, group, kind, namespace, problemsOnly, query, globalSearch, kindList]);

  // With one kind selected, its info labels become real columns.
  const singleKind = kind !== 'all' ? kind : (new Set(visible.map((r) => r.kind)).size === 1 ? visible[0]?.kind : undefined);
  const infoCols = singleKind ? (visible.find((r) => r.kind === singleKind)?.info.map((i) => i[0]) || []) : [];

  const exportCsv = () => {
    const header = ['Host', 'Kind', 'Namespace', 'Name', 'Status', 'Health', 'Age', 'Details'];
    const body = visible.map((r) => [r.host || source, r.kind, r.namespace || '', r.name, r.status, r.health, ageOf(r.created),
      r.info.map(([k, v]) => `${k}: ${v}`).join('; ')]);
    downloadText(toCsv([header, ...body]), `trinetra-resources-${source}-${stamp()}.csv`, 'text/csv');
  };

  const problemTotal = rows.filter((r) => r.health === 'failing').length;
  const absent = kindList.filter((k) => k.state === 'absent');

  return (
    <div className="k8s-section">
      <div className="k8s-section-header" onClick={() => setOpen((o) => !o)}>
        <div className="k8s-section-title">
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <Boxes size={16} />
          <span>All Other Resources</span>
          <span className="k8s-section-count">{rows.length}</span>
          {problemTotal > 0 && <span className="badge error" style={{ fontSize: 10 }}>{problemTotal} failing</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }} onClick={(e) => e.stopPropagation()}>
          {at && <span>read {at}</span>}
          <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'loader' : ''} /> Refresh
          </button>
          <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={exportCsv} disabled={!visible.length}>
            <Download size={12} /> CSV
          </button>
        </div>
      </div>

      {open && (
        <div className="k8s-section-content">
          {error && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--status-error)', fontSize: 12.5, marginBottom: 10 }}>
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {/* Groups */}
          <div className="subnav-pills" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            <button className={`subnav-pill-btn ${group === 'all' ? 'active' : ''}`} onClick={() => { setGroup('all'); setKind('all'); }}>
              Everything ({rows.length})
            </button>
            {groups.map((g) => (
              <button key={g.group} className={`subnav-pill-btn ${group === g.group ? 'active' : ''}`}
                onClick={() => { setGroup(g.group); setKind('all'); }}
                title={g.problems ? `${g.problems} not healthy` : undefined}>
                {g.group} ({g.count}){g.problems > 0 && <span style={{ color: 'var(--status-error)', marginLeft: 4 }}>•{g.problems}</span>}
              </button>
            ))}
          </div>

          {/* Kinds in the chosen group */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {kindList
              .filter((k) => group === 'all' || k.group === group)
              .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.kind.localeCompare(b.kind))
              .map((k) => (
                <button key={k.kind}
                  disabled={k.state === 'absent'}
                  onClick={() => setKind(kind === k.kind ? 'all' : k.kind)}
                  title={k.state === 'absent' ? `${k.kind} is not installed on this cluster (no such API)` : `${k.count} ${k.kind}`}
                  className={`badge ${kind === k.kind ? 'running' : 'neutral'}`}
                  style={{ cursor: k.state === 'absent' ? 'not-allowed' : 'pointer', opacity: k.state === 'absent' ? 0.45 : 1, textTransform: 'none' }}>
                  {k.kind} {k.state === 'absent' ? '— n/a' : `(${k.count})`}
                </button>
              ))}
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <Filter size={13} style={{ color: 'var(--text-muted)' }} />
            <select className="form-input" value={namespace} onChange={(e) => setNamespace(e.target.value)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}>
              <option value="all">All namespaces</option>
              {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> Not healthy only
            </label>
            <div style={{ position: 'relative', marginLeft: 'auto', minWidth: 240 }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
              <input className="form-input" placeholder="name, status, host, value…" value={query} onChange={(e) => setQuery(e.target.value)}
                style={{ padding: '5px 10px 5px 28px', fontSize: 12 }} />
            </div>
          </div>

          <div className="table-wrapper" style={{ maxHeight: 560, overflow: 'auto' }}>
            <table className="resource-table">
              <thead>
                <tr>
                  {source === 'all' && <th>Host</th>}
                  {!singleKind && <th>Kind</th>}
                  <th>Name</th>
                  <th>Namespace</th>
                  <th>Status</th>
                  {singleKind ? infoCols.map((c) => <th key={c}>{c}</th>) : <th>Details</th>}
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {loading && !rows.length ? (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>
                    <span className="loader" /> Reading every resource kind…
                  </td></tr>
                ) : visible.length === 0 ? (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    {rows.length ? 'Nothing matches these filters.' : 'No resources were read from this source.'}
                  </td></tr>
                ) : visible.slice(0, 1500).map((r) => (
                  <tr key={`${r.host || ''}/${r.kind}/${r.namespace || ''}/${r.name}`}>
                    {source === 'all' && <td><span className="code-tag">{r.host}</span></td>}
                    {!singleKind && <td style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.kind}</td>}
                    <td title={r.name} style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong>{r.name}</strong></td>
                    <td>{r.namespace ? <span className="code-tag">{r.namespace}</span> : <span style={{ color: 'var(--text-muted)' }}>cluster</span>}</td>
                    <td><span className={`badge ${HEALTH_BADGE[r.health] || 'neutral'}`} style={{ textTransform: 'none' }}>{r.status}</span></td>
                    {singleKind
                      ? infoCols.map((c) => {
                          const v = r.info.find((i) => i[0] === c)?.[1] || '—';
                          return <td key={c} title={v} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</td>;
                        })
                      : (
                        <td style={{ fontSize: 11.5, color: 'var(--text-secondary)', maxWidth: 520, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                          {r.info.filter(([, v]) => v && v !== '—').slice(0, 4).map(([k, v]) => (
                            <span key={k} style={{ marginRight: 10, whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }} title={`${k}: ${v}`}>
                              <span style={{ color: 'var(--text-muted)' }}>{k}:</span> {v}
                            </span>
                          ))}
                        </td>
                      )}
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }} title={r.created}>{ageOf(r.created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length > 1500 && (
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '8px 0 0' }}>Showing the first 1500 of {visible.length} — narrow with the filters, or export CSV for all of them.</p>
          )}
          {absent.length > 0 && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0' }}>
              Not installed on this cluster: {absent.map((k) => k.kind).join(', ')}.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ClusterResources;
