// Node configuration — what /etc/kubernetes (or RKE2 / k3s) says about each node.
//
// The cluster API says what Kubernetes is doing; these files say how it was
// built: certificate expiry, API server posture, etcd headroom, kubelet limits,
// recent manifest edits, and where control-plane nodes disagree. The backend
// (server/k8s/nodeconfig.ts) reads them over SSH, read-only, and never returns
// a key or token. This page lays it out per node, worst first.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2, Info, KeyRound, Server, GitCompare, Clock, ChevronDown, ChevronRight, Download,
} from 'lucide-react';
import { downloadText, stamp, toCsv } from '../lib/health';

type Status = 'critical' | 'warning' | 'info' | 'ok';
interface Check { id: string; status: Status; area: string; title: string; detail?: string; evidence?: string; hint?: string }
interface Cert { path: string; notAfter?: string; subject?: string; issuer?: string; sans: string[]; daysLeft?: number; unreadable?: boolean }
interface Kubeconfig { path: string; server?: string; certFile?: string; notAfter?: string; subject?: string }
interface Manifest { path: string; component: string; image?: string; version?: string; mtime?: number; flags: Record<string, string> }
interface Config {
  host?: string; uid?: number; distro: string; role: string; certs: Cert[]; kubeconfigs: Kubeconfig[]; manifests: Manifest[];
  kubelet?: { mtime?: number; config: Record<string, string> }; kubeletFlags: Record<string, string>; rancherConfig: string[];
  etcdDb?: { path: string; bytes: number };
}
interface HostResult { host: string; reachable: boolean; error?: string; at: string; config?: Config; checks: Check[] }
interface Drift { component: string; what: string; values: Record<string, string> }

const STATUS_COLOR: Record<Status, string> = {
  critical: 'var(--status-error)', warning: 'var(--status-warning)', info: 'var(--text-secondary)', ok: 'var(--status-success)',
};
const STATUS_BADGE: Record<Status, string> = { critical: 'error', warning: 'warning', info: 'neutral', ok: 'running' };
const StatusIcon: React.FC<{ s: Status }> = ({ s }) =>
  s === 'ok' ? <CheckCircle2 size={14} color={STATUS_COLOR[s]} /> : s === 'info' ? <Info size={14} color={STATUS_COLOR[s]} /> : <AlertTriangle size={14} color={STATUS_COLOR[s]} />;

const daysColor = (d?: number) => d === undefined ? 'var(--text-muted)' : d < 7 ? 'var(--status-error)' : d < 30 ? 'var(--status-warning)' : 'var(--text-primary)';
const shortPath = (p: string) => p.replace(/^\/(etc\/kubernetes|var\/lib\/rancher\/(rke2|k3s)|var\/lib\/kubelet)\//, '');
const ago = (sec?: number) => {
  if (!sec) return '—';
  const s = Date.now() / 1000 - sec;
  return s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

const Tile: React.FC<{ label: string; value: string; sub?: string; color?: string; icon: React.ReactNode }> = ({ label, value, sub, color, icon }) => (
  <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>{icon}{label}</div>
    <div style={{ fontSize: 22, fontWeight: 650, color: color || 'var(--text-heading)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-all' }}>{sub}</div>}
  </div>
);

const Section: React.FC<{ title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }> = ({ title, count, children, defaultOpen }) => {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ marginTop: 10 }}>
      <button className="btn secondary" onClick={() => setOpen(!open)} style={{ padding: '3px 10px', fontSize: 12 }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {title}{count !== undefined ? ` (${count})` : ''}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
};

interface Props { source: string; vmNames: string[] }

export const NodeConfig: React.FC<Props> = ({ source, vmNames }) => {
  const [hosts, setHosts] = useState<HostResult[]>([]);
  const [drift, setDrift] = useState<Drift[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [at, setAt] = useState('');
  const [showOk, setShowOk] = useState(false);

  // A single VM source scans that VM; "this machine" and "all hosts" scan the
  // whole inventory, because /etc/kubernetes lives on the nodes, not here.
  const scope = source !== 'local' && source !== 'all' && vmNames.includes(source) ? source : '';

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (scope) params.set('vm', scope);
      if (fresh) params.set('fresh', '1');
      const d = await fetch(`/api/nodeconfig?${params}`, { cache: 'no-store' }).then((r) => r.json());
      if (d.error) { setError(d.error); return; }
      setHosts(d.hosts || []);
      setDrift(d.drift || []);
      setNote(d.note || '');
      setAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  const nodes = hosts.filter((h) => h.config && h.config.distro !== 'none');
  const summary = useMemo(() => {
    const all = nodes.flatMap((h) => h.checks.map((c) => ({ ...c, host: h.host })));
    let soonest: { host: string; path: string; days: number } | undefined;
    for (const h of nodes) {
      for (const c of h.config!.certs) {
        if (c.daysLeft !== undefined && (!soonest || c.daysLeft < soonest.days)) soonest = { host: h.host, path: c.path, days: c.daysLeft };
      }
    }
    return {
      critical: all.filter((c) => c.status === 'critical').length,
      warning: all.filter((c) => c.status === 'warning').length,
      cp: nodes.filter((h) => h.config!.role === 'control-plane').length,
      soonest,
    };
  }, [nodes]);

  const driftHosts = useMemo(() => Array.from(new Set(drift.flatMap((d) => Object.keys(d.values)))).sort(), [drift]);

  const exportCsv = () => {
    const rows: Array<Array<string | number | undefined>> = [['Host', 'Status', 'Area', 'Finding', 'Detail', 'Evidence', 'Next step']];
    for (const h of hosts) for (const c of h.checks) rows.push([h.host, c.status, c.area, c.title, c.detail, c.evidence, c.hint]);
    for (const d of drift) rows.push(['(cluster)', 'warning', 'drift', `${d.component} ${d.what} differs`, Object.entries(d.values).map(([k, v]) => `${k}=${v}`).join('; ')]);
    downloadText(toCsv(rows), `trinetra-nodeconfig-${scope || 'all'}-${stamp()}.csv`, 'text/csv');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><ShieldCheck size={18} /> Node configuration — /etc/kubernetes</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} /> Show passed checks
            </label>
            <button className="btn secondary" onClick={exportCsv} disabled={!hosts.length} style={{ padding: '6px 12px', fontSize: 12 }}><Download size={13} /> CSV</button>
            <button className="btn primary" onClick={() => void load(true)} disabled={loading} style={{ padding: '6px 12px', fontSize: 12 }}>
              <RefreshCw size={13} className={loading ? 'loader' : ''} /> {loading ? 'Reading nodes…' : 'Re-scan'}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>{scope ? `Node: ${scope}` : `All ${vmNames.length} inventory host${vmNames.length === 1 ? '' : 's'}`}</span>
          {at && <span>updated {at}</span>}
          <span>Read-only over SSH: certificates are parsed on the node (dates, subjects and SANs only); keys and tokens never leave it.</span>
        </div>
        {error && <div style={{ color: 'var(--status-error)', fontSize: 12.5, marginTop: 8 }}><AlertTriangle size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
        {note && <div style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginTop: 8 }}>{note}</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <Tile icon={<Server size={13} />} label="Kubernetes nodes read" value={`${nodes.length}`} sub={`${summary.cp} control-plane · ${hosts.length - nodes.length} other host${hosts.length - nodes.length === 1 ? '' : 's'}`} />
        <Tile icon={<AlertTriangle size={13} />} label="Critical" value={`${summary.critical}`} color={summary.critical ? 'var(--status-error)' : undefined} />
        <Tile icon={<AlertTriangle size={13} />} label="Warnings" value={`${summary.warning + drift.length}`} sub={drift.length ? `${drift.length} from drift between nodes` : undefined} color={summary.warning + drift.length ? 'var(--status-warning)' : undefined} />
        <Tile icon={<KeyRound size={13} />} label="Soonest certificate expiry"
          value={summary.soonest ? `${summary.soonest.days} d` : '—'} color={daysColor(summary.soonest?.days)}
          sub={summary.soonest ? `${summary.soonest.host}: ${shortPath(summary.soonest.path)}` : 'no certificates read'} />
      </div>

      {drift.length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title"><h2><GitCompare size={18} /> Where control-plane nodes disagree</h2></div>
          <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Static-pod flags, image versions and API endpoints that differ between nodes. A mid-way upgrade or a hand edit on one node shows up here,
            and explains "works through one API server, not the other".
          </p>
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>Component</th><th>Setting</th>{driftHosts.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {drift.map((d, i) => {
                  const hostsInDrift = driftHosts;
                  return (
                    <tr key={i}>
                      <td><strong>{d.component}</strong></td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{d.what}</td>
                      {hostsInDrift.map((h) => <td key={h} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, wordBreak: 'break-all' }}>{d.values[h] ?? '—'}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hosts.length === 0 && !loading && !error && !note && (
        <div className="panel-card"><p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>No hosts scanned yet.</p></div>
      )}

      {hosts.map((h) => {
        const cfg = h.config;
        const checks = h.checks.filter((c) => showOk || c.status !== 'ok');
        const worst: Status = h.checks.find((c) => c.status === 'critical') ? 'critical' : h.checks.find((c) => c.status === 'warning') ? 'warning' : 'ok';
        return (
          <div key={h.host} className="panel-card" style={{ borderLeft: `3px solid ${h.reachable ? STATUS_COLOR[worst] : 'var(--status-error)'}` }}>
            <div className="panel-card-title">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Server size={17} /> {h.host}
                {cfg && cfg.distro !== 'none' && <span className="badge neutral" style={{ textTransform: 'none' }}>{cfg.distro}</span>}
                {cfg && cfg.role !== 'unknown' && <span className={`badge ${cfg.role === 'control-plane' ? 'running' : 'neutral'}`} style={{ textTransform: 'none' }}>{cfg.role}</span>}
                {!h.reachable && <span className="badge error" style={{ textTransform: 'none' }}>unreachable</span>}
              </h2>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>read {new Date(h.at).toLocaleTimeString()}</span>
            </div>

            {!h.reachable ? (
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-error)' }}>{h.error}</p>
            ) : (
              <>
                {checks.length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-success)' }}><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> No problems found.</p>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {checks.map((c) => (
                    <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 6, background: c.status === 'critical' || c.status === 'warning' ? 'var(--bg-tertiary)' : undefined }}>
                      <div style={{ marginTop: 2 }}><StatusIcon s={c.status} /></div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, color: 'var(--text-heading)', fontWeight: c.status === 'ok' || c.status === 'info' ? 500 : 650 }}>
                          {c.title} <span className={`badge ${STATUS_BADGE[c.status]}`} style={{ textTransform: 'none', fontSize: 10, marginLeft: 4 }}>{c.area}</span>
                        </div>
                        {c.detail && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{c.detail}</div>}
                        {c.evidence && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2, wordBreak: 'break-all' }}>{c.evidence}</div>}
                        {c.hint && <div style={{ fontSize: 11, color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>$ {c.hint}</div>}
                      </div>
                    </div>
                  ))}
                </div>

                {cfg && cfg.certs.length > 0 && (
                  <Section title="Certificates" count={cfg.certs.length + cfg.kubeconfigs.filter((k) => k.notAfter).length}>
                    <div className="table-wrapper">
                      <table className="resource-table">
                        <thead><tr><th>File</th><th>Subject</th><th>Expires</th><th>Days left</th><th>SANs</th></tr></thead>
                        <tbody>
                          {[...cfg.certs].sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9)).map((c) => (
                            <tr key={c.path}>
                              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }} title={c.path}>{shortPath(c.path)}</td>
                              <td style={{ fontSize: 11.5 }}>{c.subject || (c.unreadable ? 'unreadable' : '—')}</td>
                              <td style={{ fontSize: 11.5 }}>{c.notAfter ? c.notAfter.slice(0, 10) : '—'}</td>
                              <td style={{ color: daysColor(c.daysLeft), fontWeight: 650 }}>{c.daysLeft ?? '—'}</td>
                              <td style={{ fontSize: 11, maxWidth: 360, wordBreak: 'break-all' }}>{c.sans.join(', ') || '—'}</td>
                            </tr>
                          ))}
                          {cfg.kubeconfigs.filter((k) => k.notAfter).map((k) => {
                            const d = Math.floor((Date.parse(k.notAfter!) - Date.now()) / 86_400_000);
                            return (
                              <tr key={k.path}>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{shortPath(k.path)} (client cert)</td>
                                <td style={{ fontSize: 11.5 }}>{k.subject || '—'}</td>
                                <td style={{ fontSize: 11.5 }}>{k.notAfter!.slice(0, 10)}</td>
                                <td style={{ color: daysColor(d), fontWeight: 650 }}>{d}</td>
                                <td style={{ fontSize: 11 }}>server {k.server || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Section>
                )}

                {cfg && cfg.manifests.length > 0 && (
                  <Section title="Static pod manifests" count={cfg.manifests.length}>
                    {cfg.manifests.map((m) => (
                      <details key={m.path} style={{ marginBottom: 6 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>
                          <strong>{m.component}</strong> <span className="code-tag">{m.version || m.image || '—'}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}> · <Clock size={11} style={{ verticalAlign: -1 }} /> edited {ago(m.mtime)} · {Object.keys(m.flags).length} flags</span>
                        </summary>
                        <pre style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 8, fontSize: 11.5, maxHeight: 280, overflow: 'auto', margin: '6px 0 0' }}>
                          {Object.entries(m.flags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `--${k}=${v}`).join('\n')}
                        </pre>
                      </details>
                    ))}
                  </Section>
                )}

                {cfg?.kubelet && (
                  <Section title="Kubelet settings" count={Object.keys(cfg.kubelet.config).length}>
                    <pre style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 8, fontSize: 11.5, maxHeight: 280, overflow: 'auto', margin: 0 }}>
                      {Object.entries(cfg.kubelet.config).map(([k, v]) => `${k}: ${v}`).join('\n')}
                      {Object.keys(cfg.kubeletFlags).length ? `\n\n# kubelet flags\n${Object.entries(cfg.kubeletFlags).map(([k, v]) => `--${k}=${v}`).join('\n')}` : ''}
                    </pre>
                  </Section>
                )}

                {cfg && cfg.rancherConfig.length > 0 && (
                  <Section title={`${cfg.distro.toUpperCase()} config (secrets redacted)`}>
                    <pre style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 8, fontSize: 11.5, maxHeight: 280, overflow: 'auto', margin: 0 }}>{cfg.rancherConfig.join('\n')}</pre>
                  </Section>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default NodeConfig;
