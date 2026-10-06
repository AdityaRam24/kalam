// HPE VM Essentials — the virtualization layer under the cluster.
//
// One page, nine subpages (listed in the sidebar too): everything is drawn
// from a single snapshot of /api/vme/snapshot, so switching subpage never
// re-reads the Manager. The connection picker includes a built-in demo estate
// so the page can be seen before a Manager is connected; demo data is always
// labelled as such.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Layers3, RefreshCw, AlertTriangle, FlaskConical, ShieldAlert } from 'lucide-react';
import { VME_SUBPAGES, type VmeSub, type VmeView } from './types';
import { VmeOverview, VmeHosts, VmeVms, VmeStorage, VmeNetworks, VmeEvents, VmeCapacity } from './VmeViews';
import { VmeTopology } from './VmeTopology';
import { VmeConnections, type PublicConnection } from './VmeConnections';

const DEMO = '__demo__';
const PICK_KEY = 'trinetra_vme_connection';

interface Props { sub: VmeSub; onSub: (s: VmeSub) => void; vmNames: string[] }

export const VmePage: React.FC<Props> = ({ sub, onSub, vmNames }) => {
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [conn, setConn] = useState<string>(() => { try { return localStorage.getItem(PICK_KEY) || ''; } catch { return ''; } });
  const [k8s, setK8s] = useState<string>('');
  const [view, setView] = useState<VmeView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<string | undefined>();
  const seq = useRef(0);

  const loadConnections = useCallback(async (select?: string) => {
    const d = await fetch('/api/vme/connections', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ connections: [] }));
    const list: PublicConnection[] = d.connections || [];
    setConnections(list);
    setConn((cur) => select || (cur && (cur === DEMO || list.some((c) => c.name === cur)) ? cur : list[0]?.name || DEMO));
  }, []);
  useEffect(() => { void loadConnections(); }, [loadConnections]);
  useEffect(() => { try { if (conn) localStorage.setItem(PICK_KEY, conn); } catch { /* storage unavailable */ } }, [conn]);

  const load = useCallback(async (fresh = false) => {
    if (!conn) return;
    const my = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const p = new URLSearchParams();
      if (conn === DEMO) p.set('demo', '1'); else p.set('name', conn);
      if (k8s) p.set('k8s', k8s);
      if (fresh) p.set('fresh', '1');
      const d = await fetch(`/api/vme/snapshot?${p}`, { cache: 'no-store' }).then((r) => r.json());
      if (my !== seq.current) return;
      if (d.error && !d.snapshot) { setError(d.error); setView(null); return; }
      setView(d);
      if (d.error) setError(d.error);
    } catch (e: any) {
      if (my === seq.current) setError(e.message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [conn, k8s]);
  useEffect(() => { void load(); }, [load]);

  const focusOn = (id: string) => { setFocus(id); onSub('topology'); };
  const s = view?.snapshot;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel-card" style={{ paddingBottom: 12 }}>
        <div className="panel-card-title" style={{ borderBottom: 'none', marginBottom: 0, paddingBottom: 0, flexWrap: 'wrap', gap: 10 }}>
          <h2><Layers3 size={18} style={{ color: 'var(--hpe-green)' }} /> HPE VM Essentials</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="form-input" value={conn} onChange={(e) => setConn(e.target.value)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }} title="Which VME Manager to read">
              {connections.map((c) => <option key={c.name} value={c.name}>{c.name} — {c.url.replace(/^https?:\/\//, '')}</option>)}
              <option value={DEMO}>Demo estate (sample data)</option>
            </select>
            {conn !== DEMO && (
              <select className="form-input" value={k8s} onChange={(e) => setK8s(e.target.value)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }} title="Kubernetes cluster to join VMs with">
                <option value="">Kubernetes: as configured</option>
                <option value="none">Kubernetes: don’t join</option>
                <option value="local">Kubernetes: this machine</option>
                {vmNames.map((n) => <option key={n} value={n}>Kubernetes: {n}</option>)}
              </select>
            )}
            <button className="btn primary" onClick={() => void load(true)} disabled={loading || sub === 'connections'} style={{ padding: '6px 12px', fontSize: 12 }}>
              <RefreshCw size={13} className={loading ? 'loader' : ''} /> {loading ? 'Reading Manager…' : 'Refresh'}
            </button>
          </div>
        </div>
        <div className="subnav-pills" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {VME_SUBPAGES.map((p) => (
            <button key={p.id} className={`subnav-pill-btn ${sub === p.id ? 'active' : ''}`} title={p.hint} onClick={() => onSub(p.id)}>
              {p.label}{p.id === 'overview' && view?.findings.some((f) => f.severity === 'critical') ? ' •' : ''}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          {s && <span>read {new Date(s.at).toLocaleTimeString()}{view?.cached ? ' (cached)' : ''}</span>}
          {s?.manager?.version && <span>VME {s.manager.version}</span>}
          {s?.manager?.user && <span>as {s.manager.user}</span>}
          <span>GET-only, read-only</span>
        </div>
        {s?.demo && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px dashed var(--status-warning)', fontSize: 12.5 }}>
            <FlaskConical size={15} color="var(--status-warning)" />
            <span><b>Demo estate — sample data, not a real Manager.</b> It runs through the same code as a real connection. Add your Manager under <a href="#" onClick={(e) => { e.preventDefault(); onSub('connections'); }}>Connections</a>.</span>
          </div>
        )}
        {view?.insecureTls && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--status-warning)' }}>
            <ShieldAlert size={13} /> TLS verification is off for this connection.
          </div>
        )}
        {error && sub !== 'connections' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--status-error)', fontSize: 12.5, marginTop: 10 }}>
            <AlertTriangle size={14} /> {error}
          </div>
        )}
      </div>

      {sub === 'connections' ? (
        <VmeConnections connections={connections} vmNames={vmNames} onChanged={(n) => { void loadConnections(n).then(() => onSub(n ? 'overview' : 'connections')); }} />
      ) : !view ? (
        <div className="panel-card"><p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{loading ? 'Reading the VME Manager…' : 'Nothing to show yet.'}</p></div>
      ) : sub === 'overview' ? <VmeOverview view={view} onFocus={focusOn} go={onSub} />
        : sub === 'topology' ? <VmeTopology view={view} focus={focus} onClearFocus={() => setFocus(undefined)} />
          : sub === 'hosts' ? <VmeHosts view={view} onFocus={focusOn} />
            : sub === 'vms' ? <VmeVms view={view} onFocus={focusOn} />
              : sub === 'storage' ? <VmeStorage view={view} onFocus={focusOn} />
                : sub === 'networks' ? <VmeNetworks view={view} />
                  : sub === 'events' ? <VmeEvents view={view} />
                    : <VmeCapacity view={view} onFocus={focusOn} />}
    </div>
  );
};

export default VmePage;
