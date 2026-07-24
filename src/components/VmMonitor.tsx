import React, { useEffect, useState, useCallback } from 'react';
import { Server, RefreshCw, Plus, Trash2, Terminal, Copy, Play, X, Cpu, Check, Boxes, Database, Layers } from 'lucide-react';

interface VmEntry { name: string; host: string; user: string; port: number; keyPath?: string; }
interface VmMetrics {
  name: string; host: string; port: number; reachable: boolean; error?: string;
  host_?: string; load?: string; ncpu?: string; mem?: string; disk?: string; gpu?: string; up?: string;
}

export const VmMonitor: React.FC = () => {
  const [vms, setVms] = useState<VmEntry[]>([]);
  const [metrics, setMetrics] = useState<Record<string, VmMetrics>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', user: '', port: '22', keyPath: '' });
  const [formErr, setFormErr] = useState('');
  const [copied, setCopied] = useState('');

  // Ad-hoc command runner
  const [execFor, setExecFor] = useState<string | null>(null);
  const [command, setCommand] = useState('uptime');
  const [execOut, setExecOut] = useState('');
  const [execBusy, setExecBusy] = useState(false);

  // Remote workload discovery (containers + pods running ON the VM)
  interface Discovery {
    reachable: boolean; error?: string; engines?: string[];
    containers?: Array<{ id: string; name: string; image: string; status: string; state: string; ports: string }>;
    pods?: Array<{ name: string; namespace: string; status: string; ready: string; node: string; restarts: number }>;
    crictl?: Array<{ id: string; name: string; state: string; image: string; pod: string }>;
  }
  const [discovery, setDiscovery] = useState<Record<string, Discovery>>({});
  const [discoverBusy, setDiscoverBusy] = useState<Record<string, boolean>>({});
  const [discoverFor, setDiscoverFor] = useState<string | null>(null);

  const loadVms = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/vms');
      const data = await res.json();
      setVms(data.vms || []);
    } catch { /* backend down — handled by empty state */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadVms(); }, [loadVms]);

  const probe = useCallback(async (name: string) => {
    setProbing((p) => ({ ...p, [name]: true }));
    try {
      const res = await fetch('/api/vms/metrics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setMetrics((m) => ({ ...m, [name]: data }));
    } catch (e: any) {
      setMetrics((m) => ({ ...m, [name]: { name, host: '', port: 0, reachable: false, error: e.message } }));
    } finally {
      setProbing((p) => ({ ...p, [name]: false }));
    }
  }, []);

  // Auto-probe whenever the inventory changes
  useEffect(() => { vms.forEach((v) => probe(v.name)); }, [vms, probe]);

  const addVm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErr('');
    try {
      const res = await fetch('/api/vms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, port: parseInt(form.port, 10) || 22, keyPath: form.keyPath || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setFormErr(data.error || 'Failed to add VM'); return; }
      setForm({ name: '', host: '', user: '', port: '22', keyPath: '' });
      setShowAdd(false);
      loadVms();
    } catch (e: any) { setFormErr(`Network error: ${e.message}`); }
  };

  const removeVm = async (name: string) => {
    if (!confirm(`Remove VM "${name}" from the inventory?`)) return;
    await fetch(`/api/vms/${encodeURIComponent(name)}`, { method: 'DELETE' });
    loadVms();
  };

  const copySsh = async (name: string) => {
    try {
      const res = await fetch(`/api/vms/ssh-command/${encodeURIComponent(name)}`);
      const data = await res.json();
      await navigator.clipboard.writeText(data.command);
      setCopied(name);
      setTimeout(() => setCopied(''), 1800);
    } catch { /* clipboard unavailable */ }
  };

  const runCommand = async (name: string) => {
    setExecBusy(true);
    setExecOut('');
    try {
      const res = await fetch('/api/vms/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command }),
      });
      const data = await res.json();
      setExecOut((data.output || '') + (data.error ? `\n[stderr] ${data.error}` : '') || '(no output)');
    } catch (e: any) { setExecOut(`Network error: ${e.message}`); } finally { setExecBusy(false); }
  };

  const discover = async (name: string) => {
    setDiscoverBusy((b) => ({ ...b, [name]: true }));
    setDiscoverFor(name);
    try {
      const res = await fetch('/api/vms/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setDiscovery((d) => ({ ...d, [name]: data }));
    } catch (e: any) {
      setDiscovery((d) => ({ ...d, [name]: { reachable: false, error: e.message } }));
    } finally {
      setDiscoverBusy((b) => ({ ...b, [name]: false }));
    }
  };

  const dot = (m?: VmMetrics) => {
    if (!m) return { cls: 'offline', label: 'Probing' };
    if (m.reachable && !m.error) return { cls: 'online', label: 'Online' };
    if (m.reachable) return { cls: 'warn', label: 'SSH error' };
    return { cls: 'offline', label: 'Unreachable' };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Server size={18} style={{ color: 'var(--hpe-green)', marginRight: 6 }} /> Virtual Machines</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn secondary" onClick={loadVms} style={{ padding: '6px 12px' }}>
              <RefreshCw size={14} className={loading ? 'loader' : ''} /> Refresh
            </button>
            <button className="btn primary" onClick={() => setShowAdd((s) => !s)} style={{ padding: '6px 12px' }}>
              <Plus size={14} /> Add VM
            </button>
          </div>
        </div>

        {showAdd && (
          <form onSubmit={addVm} style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr 0.6fr auto', gap: 10, alignItems: 'end', marginBottom: 16, padding: 14, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)' }}>
            <div className="form-group"><label style={{ fontSize: 12 }}>Name</label><input className="form-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="gpu-node-1" /></div>
            <div className="form-group"><label style={{ fontSize: 12 }}>Host / IP</label><input className="form-input" required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.0.0.11" /></div>
            <div className="form-group"><label style={{ fontSize: 12 }}>SSH User</label><input className="form-input" required value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="ubuntu" /></div>
            <div className="form-group"><label style={{ fontSize: 12 }}>Port</label><input className="form-input" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="22" /></div>
            <button type="submit" className="btn primary" style={{ height: 40 }}>Save</button>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12 }}>Private Key Path (optional)</label>
              <input className="form-input" value={form.keyPath} onChange={(e) => setForm({ ...form, keyPath: e.target.value })} placeholder="~/.ssh/id_rsa — leave blank to use the SSH agent" />
            </div>
            {formErr && <div style={{ gridColumn: '1 / -1', color: 'var(--status-error)', fontSize: 12 }}>{formErr}</div>}
          </form>
        )}

        <div className="table-wrapper">
          <table className="resource-table">
            <thead>
              <tr><th>Status</th><th>Name</th><th>Endpoint</th><th>Load / CPU</th><th>Memory</th><th>Disk</th><th>GPU</th><th>Uptime</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {vms.length === 0 ? (
                <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', padding: 32 }}>
                  {loading ? 'Loading inventory…' : 'No VMs yet. Click “Add VM” to register a host for SSH monitoring.'}
                </td></tr>
              ) : vms.map((v) => {
                const m = metrics[v.name];
                const d = dot(m);
                const busy = probing[v.name];
                return (
                  <tr key={v.name}>
                    <td><span className={`status-dot-pill ${d.cls === 'online' ? 'online' : 'offline'}`} style={{ fontSize: 11 }}><span className="dot" style={d.cls === 'warn' ? { background: 'var(--status-warn, #E5A50A)' } : undefined}></span>{busy ? 'Probing' : d.label}</span></td>
                    <td><strong>{v.name}</strong></td>
                    <td><span className="code-id">{v.user}@{v.host}:{v.port}</span></td>
                    <td>{m?.error ? '—' : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.load ?? '—'}{m?.ncpu ? ` / ${m.ncpu}` : ''}</span>}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.mem ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.disk ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.gpu && m.gpu !== 'none' ? `${m.gpu}%` : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m?.error ? <span style={{ color: 'var(--status-error)' }}>{m.error}</span> : (m?.up ?? '—')}</td>
                    <td>
                      <div className="action-btns">
                        <button className="icon-btn primary" title="Refresh metrics" onClick={() => probe(v.name)}><RefreshCw size={14} className={busy ? 'loader' : ''} /></button>
                        <button className="icon-btn success" title="Discover containers & pods" onClick={() => discover(v.name)}><Boxes size={14} className={discoverBusy[v.name] ? 'loader' : ''} /></button>
                        <button className="icon-btn secondary" title="Run remote command" onClick={() => { setExecFor(v.name); setExecOut(''); }}><Play size={14} /></button>
                        <button className="icon-btn secondary" title="Copy SSH command" onClick={() => copySsh(v.name)}>{copied === v.name ? <Check size={14} /> : <Copy size={14} />}</button>
                        <button className="icon-btn danger" title="Remove from inventory" onClick={() => removeVm(v.name)}><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
          <Terminal size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          Metrics are gathered over SSH (system <code>ssh</code>). “Copy SSH command” puts a ready-to-paste connection string on your clipboard for a native terminal.
        </p>
      </div>

      {/* Discovered workloads on the VM */}
      {discoverFor && (() => {
        const d = discovery[discoverFor];
        const busy = discoverBusy[discoverFor];
        return (
          <div className="panel-card" style={{ borderLeft: '3px solid var(--hpe-green)' }}>
            <div className="panel-card-title">
              <h2><Boxes size={18} /> Workloads on {discoverFor}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn secondary" onClick={() => discover(discoverFor)} disabled={busy} style={{ padding: '6px 12px' }}>
                  <RefreshCw size={14} className={busy ? 'loader' : ''} /> Re-scan
                </button>
                <button className="icon-btn" onClick={() => setDiscoverFor(null)}><X size={16} /></button>
              </div>
            </div>

            {busy && !d ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', padding: 12 }}>
                <span className="loader" /> Connecting over SSH and enumerating containers &amp; pods…
              </div>
            ) : !d ? null : d.error ? (
              <p style={{ color: 'var(--status-error)', fontSize: 13 }}>{d.error}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {/* Detected engines */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Detected runtimes:</span>
                  {(d.engines && d.engines.length) ? d.engines.map((e) => (
                    <span key={e} className="badge running" style={{ fontSize: 10 }}>{e}</span>
                  )) : <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>none found (no docker/kubectl/crictl on PATH)</span>}
                </div>

                {/* Docker containers */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                    <Database size={15} style={{ color: 'var(--hpe-green)' }} /> Docker Containers
                    <span className="badge neutral" style={{ fontSize: 10 }}>{d.containers?.length || 0}</span>
                  </div>
                  {d.containers && d.containers.length ? (
                    <div className="table-wrapper"><table className="resource-table">
                      <thead><tr><th>Name</th><th>Image</th><th>State</th><th>Status</th><th>Ports</th></tr></thead>
                      <tbody>{d.containers.map((c) => (
                        <tr key={c.id}><td><strong>{c.name}</strong></td><td><span className="code-tag">{c.image}</span></td>
                          <td><span className={`badge ${c.state === 'running' ? 'running' : 'error'}`}>{c.state}</span></td>
                          <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.status}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.ports || '—'}</td></tr>
                      ))}</tbody>
                    </table></div>
                  ) : <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No Docker containers (or Docker not present on this host).</p>}
                </div>

                {/* Kubernetes pods */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                    <Layers size={15} style={{ color: 'var(--hpe-green)' }} /> Kubernetes Pods
                    <span className="badge neutral" style={{ fontSize: 10 }}>{d.pods?.length || 0}</span>
                  </div>
                  {d.pods && d.pods.length ? (
                    <div className="table-wrapper"><table className="resource-table">
                      <thead><tr><th>Pod</th><th>Namespace</th><th>Status</th><th>Ready</th><th>Node</th><th>Restarts</th></tr></thead>
                      <tbody>{d.pods.map((p) => (
                        <tr key={`${p.namespace}/${p.name}`}><td><strong>{p.name}</strong></td><td>{p.namespace}</td>
                          <td><span className={`badge ${p.status === 'Running' ? 'running' : p.status === 'Pending' ? 'warning' : 'error'}`}>{p.status}</span></td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.ready}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{p.node || '—'}</td><td>{p.restarts}</td></tr>
                      ))}</tbody>
                    </table></div>
                  ) : <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No pods via <code>kubectl</code> (not configured on this host, or none scheduled).</p>}
                </div>

                {/* containerd (crictl) fallback */}
                {d.crictl && d.crictl.length > 0 && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                      <Boxes size={15} style={{ color: 'var(--hpe-green)' }} /> containerd (crictl)
                      <span className="badge neutral" style={{ fontSize: 10 }}>{d.crictl.length}</span>
                    </div>
                    <div className="table-wrapper"><table className="resource-table">
                      <thead><tr><th>Container</th><th>Pod</th><th>State</th><th>Image</th></tr></thead>
                      <tbody>{d.crictl.map((c) => (
                        <tr key={c.id}><td><strong>{c.name}</strong></td><td style={{ fontSize: 12 }}>{c.pod || '—'}</td>
                          <td><span className={`badge ${c.state === 'RUNNING' || c.state === 'running' ? 'running' : 'error'}`}>{c.state}</span></td>
                          <td><span className="code-tag">{c.image}</span></td></tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Remote command runner */}
      {execFor && (
        <div className="panel-card" style={{ borderLeft: '3px solid var(--hpe-green)' }}>
          <div className="panel-card-title">
            <h2><Cpu size={18} /> Remote Command · {execFor}</h2>
            <button className="icon-btn" onClick={() => setExecFor(null)}><X size={16} /></button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="form-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. nvidia-smi" onKeyDown={(e) => { if (e.key === 'Enter') runCommand(execFor); }} />
            <button className="btn primary" onClick={() => runCommand(execFor)} disabled={execBusy}><Play size={14} /> {execBusy ? 'Running…' : 'Run'}</button>
          </div>
          {execOut && (
            <pre style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>{execOut}</pre>
          )}
        </div>
      )}
    </div>
  );
};

export default VmMonitor;
