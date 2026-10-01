import React, { useEffect, useState, useCallback } from 'react';
import { Server, RefreshCw, Plus, Trash2, Terminal, TerminalSquare, Copy, Play, X, Cpu, Check, Boxes, Database, Layers, Activity, AlertTriangle, ShieldCheck, ShieldAlert, Network, Brain, History, Info, Share2, KeyRound } from 'lucide-react';
import VmTopology from './VmTopology';
import RemoteTerminal from './RemoteTerminal';

interface VmEntry {
  name: string; host: string; user: string; hasPassword?: boolean; keyPath?: string; via?: string;
  elevate?: 'none' | 'sudo' | 'su'; hasElevatePassword?: boolean; runsAsRoot?: boolean;
}
interface VmMetrics {
  name: string; host: string; reachable: boolean; error?: string;
  host_?: string; load?: string; ncpu?: string; mem?: string; disk?: string; gpu?: string; up?: string;
}

export const VmMonitor: React.FC = () => {
  const [vms, setVms] = useState<VmEntry[]>([]);
  const [metrics, setMetrics] = useState<Record<string, VmMetrics>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const blankForm = { name: '', host: '', user: '', password: '', keyPath: '', via: '' };
  const [form, setForm] = useState(blankForm);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Re-prompt for a password on a VM already in the inventory (MobaXterm asks
  // again when a saved session stops authenticating; so do we).
  const [credsFor, setCredsFor] = useState<string | null>(null);
  const [creds, setCreds] = useState({ user: '', password: '' });
  const [credsBusy, setCredsBusy] = useState(false);
  const [credsMsg, setCredsMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Root access. Offered right after a VM is added or its credentials change,
  // because most of what Kalam can discover on a host (containerd via crictl,
  // service logs, /etc/kubernetes) is unreadable to an ordinary login — an
  // unprivileged session reports a nearly empty machine and looks broken.
  interface RootOptions {
    reachable: boolean; error?: string; currentUser?: string; alreadyRoot?: boolean;
    sudoAvailable?: boolean; sudoPasswordless?: boolean; suAvailable?: boolean; elevate?: string;
  }
  const [rootFor, setRootFor] = useState<string | null>(null);
  const [rootOpts, setRootOpts] = useState<RootOptions | null>(null);
  const [rootMode, setRootMode] = useState<'login' | 'sudo' | 'su'>('sudo');
  const [rootPassword, setRootPassword] = useState('');
  const [rootBusy, setRootBusy] = useState(false);
  const [rootMsg, setRootMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const openRoot = useCallback(async (name: string) => {
    setRootFor(name);
    setRootOpts(null);
    setRootMsg(null);
    setRootPassword('');
    setRootBusy(true);
    try {
      const res = await fetch(`/api/vms/${encodeURIComponent(name)}/root-options`, { method: 'POST' });
      const data: RootOptions = await res.json();
      setRootOpts(data);
      // Recommend what this host actually supports rather than making the user
      // guess: sudo where it exists, su where it does not, nothing if already root.
      setRootMode(data.alreadyRoot ? 'login' : data.sudoAvailable ? 'sudo' : data.suAvailable ? 'su' : 'login');
    } catch (e: any) {
      setRootOpts({ reachable: false, error: e.message });
    } finally {
      setRootBusy(false);
    }
  }, []);

  const applyRoot = async (mode: 'login' | 'sudo' | 'su' | 'none') => {
    if (!rootFor) return;
    setRootBusy(true);
    setRootMsg(null);
    try {
      const res = await fetch(`/api/vms/${encodeURIComponent(rootFor)}/root`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, password: rootPassword || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setRootMsg({ ok: false, text: data.error || 'Failed to change the user.' }); return; }
      if (!data.ok) { setRootMsg({ ok: false, text: data.error || 'Elevation failed.' }); return; }
      setRootMsg({
        ok: true,
        text: mode === 'none'
          ? 'Reverted — commands run as the login user again.'
          : `Commands on ${rootFor} now run as root${mode === 'login' ? ' (logged in as root)' : ` (via ${mode})`}. Re-scanning what this host can see…`,
      });
      setRootPassword('');
      await loadVms();
      probe(rootFor);
      // The point of getting root is seeing what was hidden before, so refresh
      // discovery straight away rather than making the user ask again.
      if (mode !== 'none') { discover(rootFor); exploreVm(rootFor); }
    } catch (e: any) {
      setRootMsg({ ok: false, text: `Network error: ${e.message}` });
    } finally {
      setRootBusy(false);
    }
  };

  // Peer-VM discovery (hosts visible FROM a connected VM: K8s nodes, /etc/hosts, ARP)
  interface Neighbor { ip: string; hostname?: string; source: string; }
  const [neighbors, setNeighbors] = useState<Neighbor[]>([]);
  const [neighborsFor, setNeighborsFor] = useState<string | null>(null);
  const [neighborsBusy, setNeighborsBusy] = useState(false);
  const [neighborsErr, setNeighborsErr] = useState('');

  const findNeighbors = async (name: string) => {
    setNeighborsFor(name);
    setNeighborsBusy(true);
    setNeighbors([]);
    setNeighborsErr('');
    try {
      const res = await fetch('/api/vms/neighbors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.error) setNeighborsErr(data.error);
      else setNeighbors(data.neighbors || []);
    } catch (e: any) {
      setNeighborsErr(e.message);
    } finally {
      setNeighborsBusy(false);
    }
  };
  const [formErr, setFormErr] = useState('');
  const [copied, setCopied] = useState('');

  // Which VM has an interactive terminal open (see RemoteTerminal).
  const [execFor, setExecFor] = useState<string | null>(null);
  // Whether the next terminal opens elevated. Explicit, so "Root terminal"
  // means root even on a host that has no elevation configured yet.
  const [execRoot, setExecRoot] = useState(false);

  // Remote workload discovery (containers + pods running ON the VM)
  interface Discovery {
    reachable: boolean; error?: string; engines?: string[];
    containers?: Array<{ id: string; name: string; image: string; status: string; state: string; ports: string }>;
    pods?: Array<{ name: string; namespace: string; status: string; ready: string; node: string; restarts: number }>;
    services?: Array<{ name: string; namespace: string; type: string; clusterIp: string; ports: string }>;
    crictl?: Array<{ id: string; name: string; state: string; image: string; pod: string }>;
    systemServices?: Array<{ unit: string; sub: string; description: string }>;
    listeningPorts?: Array<{ proto: string; local: string; process: string }>;
  }
  const [discovery, setDiscovery] = useState<Record<string, Discovery>>({});
  const [discoverBusy, setDiscoverBusy] = useState<Record<string, boolean>>({});
  const [discoverFor, setDiscoverFor] = useState<string | null>(null);

  // Read-only cluster diagnosis (kubectl inspection over SSH — reports, never fixes)
  interface DiagFinding {
    severity: 'critical' | 'warning' | 'info'; kind: string; namespace?: string; name: string;
    reason: string; detail: string; logExcerpt?: string; events?: string; suggestedFixes: string[];
    // From the dependency graph: is this the cause, or somebody else's casualty?
    graphId?: string; rootCause?: boolean; explains?: number; causedBy?: string;
  }
  interface DiagRootCause {
    id: string; name: string; kind: string; namespace?: string; reason?: string;
    explains: string[]; atRisk: number; confidence: 'high' | 'medium' | 'low';
    explanation: string; component?: { id: string; title: string; impact: string };
  }
  interface Diagnosis {
    reachable: boolean; kubectlAvailable?: boolean; error?: string; summary?: string;
    findings?: DiagFinding[]; warningEvents?: string;
    causes?: { rootCauses: DiagRootCause[]; brokenCount: number; summary: string };
  }
  const [diagnosis, setDiagnosis] = useState<Record<string, Diagnosis>>({});
  const [diagBusy, setDiagBusy] = useState<Record<string, boolean>>({});
  const [diagFor, setDiagFor] = useState<string | null>(null);

  // "Node brain": what this node is, why each component runs on it, what changed
  interface BrainComponent {
    id: string; title: string; category: string; what: string; why: string; impact: string;
    unhealthy: number;
    workloads: Array<{ name: string; namespace?: string; status?: string; restarts?: number; image?: string; age?: string }>;
  }
  interface NodeBrain {
    reachable: boolean; error?: string; kubectlAvailable?: boolean; summary?: string;
    identity?: {
      hostname: string; ips: string[]; nodeName: string | null; role: string; os: string; kernel: string;
      uptime: string; bootedAt: string; joinedAge: string; kubelet: string; runtime: string;
      cpu: string; memory: string; gpus: number; ready: boolean | null; schedulable: boolean | null;
      taints: string[]; notableLabels: string[];
    };
    components?: BrainComponent[];
    otherWorkloads?: BrainComponent['workloads'];
    changes?: Array<{ at?: string; age: string; kind: string; text: string }>;
    warningEvents?: string;
  }
  const [brains, setBrains] = useState<Record<string, NodeBrain>>({});
  const [brainBusy, setBrainBusy] = useState<Record<string, boolean>>({});
  const [brainFor, setBrainFor] = useState<string | null>(null);

  // Topology view of the inventory (SSH paths + analyzed components)
  const [showTopology, setShowTopology] = useState(true);
  const [topoExpanded, setTopoExpanded] = useState<Record<string, boolean>>({});
  const toggleTopoExpand = useCallback((name: string) => setTopoExpanded((e) => ({ ...e, [name]: !e[name] })), []);

  // Memoised because VmTopology re-runs its dagre layout whenever this prop
  // changes identity — an un-memoised handler re-laid-out the whole VM graph on
  // every render of this component, so the nodes never held still.
  const explain = useCallback(async (name: string) => {
    setBrainBusy((b) => ({ ...b, [name]: true }));
    setBrainFor(name);
    try {
      const res = await fetch('/api/vms/explain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setBrains((b) => ({ ...b, [name]: data }));
      if (data.components?.length) setTopoExpanded((e) => ({ ...e, [name]: true }));
    } catch (e: any) {
      setBrains((b) => ({ ...b, [name]: { reachable: false, error: e.message } }));
    } finally {
      setBrainBusy((b) => ({ ...b, [name]: false }));
    }
  }, []);

  const diagnose = async (name: string) => {
    setDiagBusy((b) => ({ ...b, [name]: true }));
    setDiagFor(name);
    try {
      const res = await fetch('/api/vms/diagnose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setDiagnosis((d) => ({ ...d, [name]: data }));
    } catch (e: any) {
      setDiagnosis((d) => ({ ...d, [name]: { reachable: false, error: e.message } }));
    } finally {
      setDiagBusy((b) => ({ ...b, [name]: false }));
    }
  };

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

  const [exploring, setExploring] = useState<Record<string, boolean>>({});
  const [explored, setExplored] = useState<Record<string, { ok: boolean; text: string }>>({});

  const probe = useCallback(async (name: string) => {
    setProbing((p) => ({ ...p, [name]: true }));
    try {
      const res = await fetch('/api/vms/metrics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setMetrics((m) => ({ ...m, [name]: data }));
    } catch (e: any) {
      setMetrics((m) => ({ ...m, [name]: { name, host: '', reachable: false, error: e.message } }));
    } finally {
      setProbing((p) => ({ ...p, [name]: false }));
    }
  }, []);

  // Auto-probe whenever the inventory changes
  useEffect(() => { vms.forEach((v) => probe(v.name)); }, [vms, probe]);

  // A host that has just been added is immediately explored: its containers,
  // pods, services, nodes and deployments are read once so the dashboard and
  // topology map have something to draw the moment the user switches to it,
  // and so an unreachable or root-only host says so here rather than looking
  // like an empty cluster later.
  const exploreVm = useCallback(async (name: string) => {
    setExploring((e) => ({ ...e, [name]: true }));
    try {
      const res = await fetch('/api/vms/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const d = await res.json();
      if (d.error || d.reachable === false) {
        setExplored((m) => ({ ...m, [name]: { ok: false, text: d.error || 'unreachable over SSH' } }));
        return;
      }
      const counts = [
        [(d.containers || []).length, 'container'],
        [(d.pods || []).length, 'pod'],
        [(d.services || []).length, 'service'],
        [(d.deployments || []).length, 'workload'],
        [(d.nodes || []).length, 'node'],
      ] as Array<[number, string]>;
      const found = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`);
      const engines = (d.engines || []).join(', ');
      setExplored((m) => ({
        ...m,
        [name]: d.warning
          // The backend names the actual obstacle (read cut short, kubectl
          // missing, API unreachable, no permission) — repeat it rather than
          // reporting a bare count that hides it.
          ? { ok: false, text: found.length ? `Mapped: ${found.join(', ')} — but ${d.warning}` : d.warning }
          : found.length
            ? { ok: true, text: `Mapped: ${found.join(', ')}${engines ? ` · ${engines}` : ''}` }
            : { ok: false, text: 'Reachable, but nothing was visible — this login may need root (shield icon) to see containerd and the kubeconfig.' },
      }));
    } catch (e: any) {
      setExplored((m) => ({ ...m, [name]: { ok: false, text: `Scan failed: ${e.message}` } }));
    } finally {
      setExploring((e) => ({ ...e, [name]: false }));
    }
  }, []);

  const addVm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErr('');
    setTestMsg(null);
    try {
      const res = await fetch('/api/vms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, password: form.password || undefined, keyPath: form.keyPath || undefined, via: form.via || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setFormErr(data.error || 'Failed to add VM'); return; }
      // Saved either way — but if the login did not go through, keep the form
      // open with the reason so the password can be corrected immediately.
      if (data.warning) {
        setFormErr(`Saved, but the login failed: ${data.warning}`);
        loadVms();
        return;
      }
      const addedName = data.vm?.name || form.name;
      setForm(blankForm);
      setShowAdd(false);
      loadVms();
      // Explore it straight away, and take a first metrics reading, so the row
      // is populated without the user having to press anything.
      exploreVm(addedName);
      probe(addedName);
      // A freshly connected host is exactly when root matters: offer it now,
      // instead of leaving the user to discover later that half the machine
      // was invisible to their login.
      if (form.user !== 'root') openRoot(addedName);
    } catch (e: any) { setFormErr(`Network error: ${e.message}`); }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch('/api/vms/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: form.host, user: form.user, password: form.password || undefined, keyPath: form.keyPath || undefined, via: form.via || undefined }),
      });
      const data = await res.json();
      setTestMsg(data.ok ? { ok: true, text: `Connected to ${form.user}@${form.host}` } : { ok: false, text: data.error || 'Connection failed' });
    } catch (e: any) { setTestMsg({ ok: false, text: `Network error: ${e.message}` }); } finally { setTesting(false); }
  };

  const saveCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!credsFor) return;
    setCredsBusy(true);
    setCredsMsg(null);
    try {
      const res = await fetch(`/api/vms/${encodeURIComponent(credsFor)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: creds.user, password: creds.password }),
      });
      const data = await res.json();
      if (!res.ok) { setCredsMsg({ ok: false, text: data.error || 'Update failed' }); return; }
      if (data.warning) { setCredsMsg({ ok: false, text: data.warning }); loadVms(); return; }
      const updated = credsFor;
      setCredsFor(null);
      loadVms();
      probe(updated);
      // Same offer after an update — the login may have changed to one that
      // needs (or no longer needs) elevation.
      if (creds.user !== 'root') openRoot(updated);
    } catch (e: any) { setCredsMsg({ ok: false, text: `Network error: ${e.message}` }); } finally { setCredsBusy(false); }
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
          <form onSubmit={addVm} style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr 1fr auto auto', gap: 10, alignItems: 'end', marginBottom: 16, padding: 14, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)' }}>
            <div className="form-group"><label style={{ fontSize: 12 }}>Name</label><input className="form-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="gpu-node-1" /></div>
            <div className="form-group"><label style={{ fontSize: 12 }}>Host / IP</label><input className="form-input" required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.0.0.11" /></div>
            <div className="form-group"><label style={{ fontSize: 12 }}>Login as</label><input className="form-input" required autoComplete="off" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="root" /></div>
            <div className="form-group">
              <label style={{ fontSize: 12 }}>Password</label>
              <input className="form-input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
            </div>
            <button type="button" className="btn secondary" style={{ height: 40 }} onClick={testConnection} disabled={testing || !form.host || !form.user}>
              {testing ? <RefreshCw size={14} className="loader" /> : <Network size={14} />} Test
            </button>
            <button type="submit" className="btn primary" style={{ height: 40 }}>Save</button>
            {testMsg && (
              <div style={{ gridColumn: '1 / -1', fontSize: 12, color: testMsg.ok ? 'var(--hpe-green)' : 'var(--status-error)' }}>
                {testMsg.ok ? <Check size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> : <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />}
                {testMsg.text}
              </div>
            )}
            <details style={{ gridColumn: '1 / -1' }}>
              <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>Use a private key instead of a password</summary>
              <div className="form-group" style={{ marginTop: 8 }}>
                <input className="form-input" value={form.keyPath} onChange={(e) => setForm({ ...form, keyPath: e.target.value })} placeholder="~/.ssh/id_rsa — leave blank to use the password above" />
              </div>
            </details>
            {vms.length > 0 && (
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 12 }}>Connect via jump host (optional)</label>
                <select className="form-input" value={form.via} onChange={(e) => setForm({ ...form, via: e.target.value })}>
                  <option value="">Direct connection</option>
                  {vms.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.user}@{v.host})</option>)}
                </select>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Use when this VM is only reachable from another VM (e.g. a VME host behind the DSC VM). SSH will hop through it automatically.</span>
              </div>
            )}
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
                    <td>
                      <strong>{v.name}</strong>
                      {/* What the automatic first scan found on this host. */}
                      {exploring[v.name] && (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>exploring…</div>
                      )}
                      {!exploring[v.name] && explored[v.name] && (
                        <div
                          style={{
                            fontSize: 10, marginTop: 2, maxWidth: 260, lineHeight: 1.4,
                            color: explored[v.name].ok ? 'var(--hpe-green)' : 'var(--text-muted)',
                          }}
                          title={explored[v.name].text}
                        >
                          {explored[v.name].text}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="code-id">{v.user}@{v.host}</span>
                      {v.runsAsRoot && (
                        <span className="badge badge-lc error" style={{ fontSize: 9, marginLeft: 6 }}
                          title={v.user === 'root' ? 'Logged in as root' : `Commands are elevated with ${v.elevate}`}>
                          root{v.user === 'root' ? '' : ` · ${v.elevate}`}
                        </span>
                      )}
                      {v.via && <span className="badge neutral" style={{ fontSize: 9, marginLeft: 6 }} title={`SSH hops through ${v.via}`}>via {v.via}</span>}
                      {!v.hasPassword && !v.keyPath && <span className="badge warning" style={{ fontSize: 9, marginLeft: 6 }} title="No password or key saved for this host">no credentials</span>}
                    </td>
                    <td>{m?.error ? '—' : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.load ?? '—'}{m?.ncpu ? ` / ${m.ncpu}` : ''}</span>}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.mem ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.disk ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m?.gpu && m.gpu !== 'none' ? `${m.gpu}%` : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m?.error ? <span style={{ color: 'var(--status-error)' }}>{m.error}</span> : (m?.up ?? '—')}</td>
                    <td>
                      <div className="action-btns">
                        <button className="icon-btn primary" title="Refresh metrics" onClick={() => probe(v.name)}><RefreshCw size={14} className={busy ? 'loader' : ''} /></button>
                        <button className="icon-btn success" title="Discover containers & pods" onClick={() => discover(v.name)}><Boxes size={14} className={discoverBusy[v.name] ? 'loader' : ''} /></button>
                        <button className="icon-btn primary" title="Explain this node — what it is, why each component runs here, what changed" onClick={() => explain(v.name)}><Brain size={14} className={brainBusy[v.name] ? 'loader' : ''} /></button>
                        <button className="icon-btn secondary" title="Find peer VMs visible from this host" onClick={() => findNeighbors(v.name)}><Network size={14} className={neighborsBusy && neighborsFor === v.name ? 'loader' : ''} /></button>
                        <button className="icon-btn warning" title="Diagnose cluster (read-only kubectl checks)" onClick={() => diagnose(v.name)}><Activity size={14} className={diagBusy[v.name] ? 'loader' : ''} /></button>
                        <button className="icon-btn secondary" title="Open an interactive terminal as this login" onClick={() => { setExecRoot(false); setExecFor(v.name); }}><Play size={14} /></button>
                        <button
                          className="icon-btn warning"
                          title={v.user === 'root' ? 'Already root — opens a login shell' : 'Open a root terminal (sudo -i / su -) for administrative work'}
                          onClick={() => { setExecRoot(true); setExecFor(v.name); }}
                        >
                          <TerminalSquare size={14} />
                        </button>
                        <button className={`icon-btn ${v.runsAsRoot ? 'success' : 'warning'}`} title={v.runsAsRoot ? 'Root access — change or revert' : 'Switch this host to root (sudo / su / root login)'} onClick={() => openRoot(v.name)}><ShieldAlert size={14} className={rootBusy && rootFor === v.name ? 'loader' : ''} /></button>
                        <button className="icon-btn secondary" title="Change login / password" onClick={() => { setCredsFor(v.name); setCreds({ user: v.user, password: '' }); setCredsMsg(null); }}><KeyRound size={14} /></button>
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
        {/* Password re-prompt for a host already in the inventory */}
        {credsFor && (
          <form onSubmit={saveCreds} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 10, alignItems: 'end', marginTop: 12, padding: 14, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)' }}>
            <div style={{ gridColumn: '1 / -1', fontSize: 13, fontWeight: 600 }}>
              <KeyRound size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--hpe-green)' }} />
              Credentials for {credsFor}
            </div>
            <div className="form-group"><label style={{ fontSize: 12 }}>Login as</label><input className="form-input" required autoComplete="off" value={creds.user} onChange={(e) => setCreds({ ...creds, user: e.target.value })} /></div>
            <div className="form-group"><label style={{ fontSize: 12 }}>Password</label><input className="form-input" type="password" autoComplete="new-password" autoFocus value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} placeholder="••••••••" /></div>
            <button type="submit" className="btn primary" style={{ height: 40 }} disabled={credsBusy}>{credsBusy ? 'Connecting…' : 'Connect'}</button>
            <button type="button" className="btn secondary" style={{ height: 40 }} onClick={() => setCredsFor(null)}>Cancel</button>
            {credsMsg && (
              <div style={{ gridColumn: '1 / -1', fontSize: 12, color: credsMsg.ok ? 'var(--hpe-green)' : 'var(--status-error)' }}>{credsMsg.text}</div>
            )}
            <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-muted)' }}>
              Leave the password blank to clear it and fall back to a key / the SSH agent.
            </div>
          </form>
        )}

        {/* Root access for a host that was just added or updated */}
        {rootFor && (() => {
          const vm = vms.find((v) => v.name === rootFor);
          const o = rootOpts;
          const already = o?.alreadyRoot || vm?.user === 'root';
          const modeCard = (
            mode: 'login' | 'sudo' | 'su',
            title: string,
            body: string,
            disabled?: string,
          ) => (
            <label key={mode}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8,
                border: `1px solid ${rootMode === mode ? 'var(--hpe-green)' : 'var(--border-color)'}`,
                background: rootMode === mode ? 'rgba(1, 169, 130, 0.08)' : 'var(--bg-tertiary)',
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
              }}>
              <input type="radio" name="rootmode" checked={rootMode === mode} disabled={!!disabled}
                onChange={() => setRootMode(mode)} style={{ marginTop: 3 }} />
              <span>
                <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{title}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{disabled || body}</span>
              </span>
            </label>
          );

          return (
            <div style={{ marginTop: 12, padding: 14, background: 'var(--bg-tertiary)', borderRadius: 10, border: '1px solid var(--border-color)', borderLeft: '3px solid var(--hpe-green)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  <ShieldAlert size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--hpe-green)' }} />
                  Root access on {rootFor}
                  {vm?.runsAsRoot && <span className="badge badge-lc error" style={{ fontSize: 10, marginLeft: 8 }}>currently root</span>}
                </div>
                <button className="icon-btn" onClick={() => setRootFor(null)}><X size={16} /></button>
              </div>

              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                Discovery reads containerd (<code>crictl</code>), kubelet config, service logs and package history — all of
                which an ordinary login cannot see, so an unelevated host looks almost empty. Pick how Kalam should become
                root; the choice is verified against the host before it is saved.
              </p>

              {rootBusy && !o ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', fontSize: 12 }}>
                  <span className="loader" /> Checking what this host allows…
                </div>
              ) : o && !o.reachable ? (
                <p style={{ color: 'var(--status-error)', fontSize: 12 }}>{o.error || 'Host unreachable.'}</p>
              ) : (
                <>
                  {o && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span className="badge badge-lc neutral" style={{ fontSize: 10 }}>logs in as {o.currentUser || vm?.user}</span>
                      {o.alreadyRoot && <span className="badge badge-lc running" style={{ fontSize: 10 }}>already root</span>}
                      {o.sudoPasswordless && <span className="badge badge-lc running" style={{ fontSize: 10 }}>passwordless sudo</span>}
                      {!o.sudoAvailable && <span className="badge badge-lc warning" style={{ fontSize: 10 }}>no sudo</span>}
                      {!o.suAvailable && <span className="badge badge-lc warning" style={{ fontSize: 10 }}>no su</span>}
                    </div>
                  )}

                  {already ? (
                    <p style={{ fontSize: 12.5, color: 'var(--hpe-green)', margin: '0 0 10px' }}>
                      <Check size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                      This login is already root — nothing to change. Everything Kalam runs here is fully privileged.
                    </p>
                  ) : (
                    <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
                      {modeCard('sudo', 'Keep this login, run commands with sudo',
                        o?.sudoPasswordless
                          ? 'This host allows passwordless sudo — leave the password blank.'
                          : 'Uses the password below (usually the same login password). Recommended.',
                        o && !o.sudoAvailable ? 'sudo is not installed on this host.' : undefined)}
                      {modeCard('su', 'Keep this login, switch with su - root',
                        'Uses root’s own password. Use this when the login is not a sudoer.',
                        o && !o.suAvailable ? 'su is not available on this host.' : undefined)}
                      {modeCard('login', 'Log in as root directly',
                        'Replaces the stored login with root and root’s password. Fails if the host denies root SSH login.')}
                    </div>
                  )}

                  {!already && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div className="form-group" style={{ flex: '1 1 220px' }}>
                        <label style={{ fontSize: 12 }}>
                          {rootMode === 'sudo' ? 'sudo password' : rootMode === 'su' ? 'root password' : 'root’s SSH password'}
                          {rootMode === 'sudo' && ' (blank = reuse the login password)'}
                        </label>
                        <input className="form-input" type="password" autoComplete="new-password" value={rootPassword}
                          onChange={(e) => setRootPassword(e.target.value)} placeholder="••••••••" />
                      </div>
                      <button className="btn primary" style={{ height: 40 }} disabled={rootBusy} onClick={() => applyRoot(rootMode)}>
                        {rootBusy ? <RefreshCw size={14} className="loader" /> : <ShieldAlert size={14} />} Become root
                      </button>
                      {vm?.runsAsRoot && vm.user !== 'root' && (
                        <button className="btn secondary" style={{ height: 40 }} disabled={rootBusy} onClick={() => applyRoot('none')}>
                          Revert to {vm.user}
                        </button>
                      )}
                      <button className="btn secondary" style={{ height: 40 }} onClick={() => setRootFor(null)}>Not now</button>
                    </div>
                  )}

                  {rootMsg && (
                    <div style={{ marginTop: 10, fontSize: 12, color: rootMsg.ok ? 'var(--hpe-green)' : 'var(--status-error)' }}>
                      {rootMsg.ok ? <Check size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> : <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />}
                      {rootMsg.text}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}

        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
          <Terminal size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          Hosts are reached over SSH on port 22 with the login and password you provide (like MobaXterm); a private key can be used instead.
          Passwords are kept server-side in <code>server/vms.json</code> and never sent back to the browser.
          “Copy SSH command” puts a ready-to-paste connection string on your clipboard for a native terminal.
        </p>
      </div>

      {/* Topology: inventory + SSH paths, expandable into analyzed components */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Share2 size={18} style={{ color: 'var(--hpe-green)', marginRight: 6 }} /> VM Topology</h2>
          <button className="btn secondary" onClick={() => setShowTopology((s) => !s)} style={{ padding: '6px 12px' }}>
            {showTopology ? 'Hide' : 'Show'}
          </button>
        </div>
        {showTopology && (
          <>
            <VmTopology
              vms={vms}
              metrics={metrics}
              brains={brains}
              expanded={topoExpanded}
              onToggleExpand={toggleTopoExpand}
              onExplain={explain}
              busy={brainBusy}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, marginBottom: 0 }}>
              Solid animated links are reachable SSH paths; a VM drawn under another is reached through it as a jump host.
              “Analyze node” runs the read-only Node Brain scan and expands that host into its platform components by category.
            </p>
          </>
        )}
      </div>

      {/* Node brain: what this node is, why its components run, what changed */}
      {brainFor && (() => {
        const b = brains[brainFor];
        const busy = brainBusy[brainFor];
        const id = b?.identity;
        const kindLabel: Record<string, string> = {
          reboot: 'Reboot', service: 'Service restart', 'pod-new': 'New pod', 'pod-restart': 'Pod restart', package: 'Package', event: 'Event',
        };
        const fact = (label: string, value: React.ReactNode) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{value}</span>
          </div>
        );
        // Keep the catalog's category order stable in the UI.
        const categories = Array.from(new Set((b?.components || []).map((c) => c.category)));
        return (
          <div className="panel-card" style={{ borderLeft: '3px solid var(--hpe-green)' }}>
            <div className="panel-card-title">
              <h2><Brain size={18} /> Node Brain · {brainFor}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn secondary" onClick={() => explain(brainFor)} disabled={busy} style={{ padding: '6px 12px' }}>
                  <RefreshCw size={14} className={busy ? 'loader' : ''} /> Re-analyze
                </button>
                <button className="icon-btn" onClick={() => setBrainFor(null)}><X size={16} /></button>
              </div>
            </div>

            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0 }}>
              <ShieldCheck size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
              Read-only: identity, workload and change data gathered over SSH with <code>kubectl get</code> and host inspection. Nothing is modified.
            </p>

            {busy && !b ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', padding: 12 }}>
                <span className="loader" /> Working out what this node is and why each component runs on it…
              </div>
            ) : !b ? null : b.error ? (
              <p style={{ color: 'var(--status-error)', fontSize: 13 }}>{b.error}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div style={{ fontSize: 13, lineHeight: 1.6, padding: 12, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                  {b.summary}
                </div>

                {/* Identity */}
                {id && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                      <Server size={15} style={{ color: 'var(--hpe-green)' }} /> Identity
                      <span className="badge neutral" style={{ fontSize: 10 }}>{id.role}</span>
                      {id.ready === false && <span className="badge error" style={{ fontSize: 10 }}>NotReady</span>}
                      {id.schedulable === false && <span className="badge warning" style={{ fontSize: 10 }}>cordoned</span>}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
                      {fact('Node name', id.nodeName || id.hostname)}
                      {fact('IP', id.ips[0] || '—')}
                      {fact('CPU / Memory', `${id.cpu || '?'} / ${id.memory}`)}
                      {fact('GPUs', id.gpus ? String(id.gpus) : 'none')}
                      {fact('OS / Kernel', `${id.os} · ${id.kernel}`)}
                      {fact('kubelet / runtime', `${id.kubelet || '—'} · ${id.runtime || '—'}`)}
                      {fact('Uptime', id.uptime || '—')}
                      {fact('In cluster since', id.joinedAge || '—')}
                    </div>
                    {(id.taints.length > 0 || id.notableLabels.length > 0) && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                        {id.taints.map((t) => <span key={t} className="badge warning" style={{ fontSize: 10 }} title="Taint — only pods with a matching toleration schedule here">taint {t}</span>)}
                        {id.notableLabels.map((l) => <span key={l} className="badge neutral" style={{ fontSize: 10 }}>{l}</span>)}
                      </div>
                    )}
                  </div>
                )}

                {/* What runs here and why */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                    <Layers size={15} style={{ color: 'var(--hpe-green)' }} /> What runs here — and why
                    <span className="badge neutral" style={{ fontSize: 10 }}>{b.components?.length || 0} components</span>
                  </div>
                  {!b.components?.length ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No recognized platform components found on this node.</p>
                  ) : categories.map((cat) => (
                    <div key={cat} style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 6 }}>{cat}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {b.components!.filter((c) => c.category === cat).map((c) => (
                          <details key={c.id} style={{ border: '1px solid var(--border-color)', borderLeft: `3px solid ${c.unhealthy ? 'var(--status-error)' : 'var(--hpe-green)'}`, borderRadius: 8, background: 'var(--bg-tertiary)', padding: '10px 12px' }}>
                            <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, fontWeight: 600 }}>
                              {c.title}
                              <span className={`badge ${c.unhealthy ? 'error' : 'running'}`} style={{ fontSize: 10 }}>
                                {c.unhealthy ? `${c.unhealthy} unhealthy` : `${c.workloads.length} healthy`}
                              </span>
                              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{c.workloads.map((w) => w.name).slice(0, 2).join(', ')}{c.workloads.length > 2 ? ` +${c.workloads.length - 2}` : ''}</span>
                            </summary>
                            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                              <div><strong style={{ color: 'var(--hpe-green)' }}>What it is:</strong> {c.what}</div>
                              <div><strong style={{ color: 'var(--hpe-green)' }}>Why it runs on this node:</strong> {c.why}</div>
                              <div><strong style={{ color: 'var(--status-warn, #E5A50A)' }}>If it stops:</strong> {c.impact}</div>
                              <div className="table-wrapper"><table className="resource-table">
                                <thead><tr><th>Workload</th><th>Namespace</th><th>Status</th><th>Restarts</th><th>Age</th><th>Image</th></tr></thead>
                                <tbody>{c.workloads.map((w, i) => (
                                  <tr key={`${w.namespace}/${w.name}/${i}`}>
                                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{w.name}</td>
                                    <td style={{ fontSize: 12 }}>{w.namespace || '—'}</td>
                                    <td><span className={`badge ${w.status === 'Running' || w.status === 'running (systemd)' ? 'running' : w.status === 'Pending' ? 'warning' : 'error'}`} style={{ fontSize: 10 }}>{w.status}</span></td>
                                    <td>{w.restarts ?? '—'}</td>
                                    <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{w.age || '—'}</td>
                                    <td><span className="code-tag" style={{ fontSize: 10 }}>{w.image || '—'}</span></td>
                                  </tr>
                                ))}</tbody>
                              </table></div>
                            </div>
                          </details>
                        ))}
                      </div>
                    </div>
                  ))}
                  {b.otherWorkloads && b.otherWorkloads.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>
                        <Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                        {b.otherWorkloads.length} other workload(s) not in the component catalog (application pods)
                      </summary>
                      <div className="table-wrapper" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}><table className="resource-table">
                        <thead><tr><th>Pod</th><th>Namespace</th><th>Status</th><th>Restarts</th><th>Age</th><th>Image</th></tr></thead>
                        <tbody>{b.otherWorkloads.map((w, i) => (
                          <tr key={i}><td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{w.name}</td><td style={{ fontSize: 12 }}>{w.namespace}</td>
                            <td><span className={`badge ${w.status === 'Running' ? 'running' : 'error'}`} style={{ fontSize: 10 }}>{w.status}</span></td>
                            <td>{w.restarts ?? '—'}</td><td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{w.age || '—'}</td>
                            <td><span className="code-tag" style={{ fontSize: 10 }}>{w.image || '—'}</span></td></tr>
                        ))}</tbody>
                      </table></div>
                    </details>
                  )}
                </div>

                {/* Recent changes */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                    <History size={15} style={{ color: 'var(--hpe-green)' }} /> Recent changes
                    <span className="badge neutral" style={{ fontSize: 10 }}>{b.changes?.length || 0}</span>
                  </div>
                  {!b.changes?.length ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Nothing changed recently: no reboots, service restarts, new pods or package installs detected.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {b.changes.map((c, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12.5, padding: '6px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 6 }}>
                          <span className="badge neutral" style={{ fontSize: 9, flexShrink: 0 }}>{kindLabel[c.kind] || c.kind}</span>
                          <span style={{ flex: 1 }}>{c.text}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }} title={c.at || ''}>{c.age}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {b.warningEvents && (
                  <details>
                    <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>Recent cluster events</summary>
                    <pre style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: 10, fontSize: 11, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', margin: '6px 0 0' }}>{b.warningEvents}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })()}

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

                {/* Kubernetes services */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                    <Layers size={15} style={{ color: 'var(--hpe-green)' }} /> Kubernetes Services
                    <span className="badge neutral" style={{ fontSize: 10 }}>{d.services?.length || 0}</span>
                  </div>
                  {d.services && d.services.length ? (
                    <div className="table-wrapper"><table className="resource-table">
                      <thead><tr><th>Service</th><th>Namespace</th><th>Type</th><th>Cluster IP</th><th>Ports</th></tr></thead>
                      <tbody>{d.services.map((s) => (
                        <tr key={`${s.namespace}/${s.name}`}><td><strong>{s.name}</strong></td><td>{s.namespace}</td>
                          <td><span className="badge neutral" style={{ fontSize: 10 }}>{s.type}</span></td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.clusterIp}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.ports || '—'}</td></tr>
                      ))}</tbody>
                    </table></div>
                  ) : <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No Kubernetes services found (or kubectl not configured on this host).</p>}
                </div>

                {/* Running system services (systemd) */}
                {d.systemServices && d.systemServices.length > 0 && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                      <Cpu size={15} style={{ color: 'var(--hpe-green)' }} /> Running System Services
                      <span className="badge neutral" style={{ fontSize: 10 }}>{d.systemServices.length}</span>
                    </div>
                    <div className="table-wrapper" style={{ maxHeight: 260, overflow: 'auto' }}><table className="resource-table">
                      <thead><tr><th>Service</th><th>State</th><th>Description</th></tr></thead>
                      <tbody>{d.systemServices.map((s) => (
                        <tr key={s.unit}><td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}><strong>{s.unit}</strong></td>
                          <td><span className="badge running" style={{ fontSize: 10 }}>{s.sub}</span></td>
                          <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{s.description}</td></tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                )}

                {/* Listening ports */}
                {d.listeningPorts && d.listeningPorts.length > 0 && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                      <Terminal size={15} style={{ color: 'var(--hpe-green)' }} /> Listening Ports
                      <span className="badge neutral" style={{ fontSize: 10 }}>{d.listeningPorts.length}</span>
                    </div>
                    <div className="table-wrapper" style={{ maxHeight: 220, overflow: 'auto' }}><table className="resource-table">
                      <thead><tr><th>Proto</th><th>Local Address</th><th>Process</th></tr></thead>
                      <tbody>{d.listeningPorts.map((p, i) => (
                        <tr key={i}><td>{p.proto}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.local}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.process || '—'}</td></tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                )}

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

      {/* Peer VMs visible from a connected host */}
      {neighborsFor && (
        <div className="panel-card" style={{ borderLeft: '3px solid var(--hpe-green)' }}>
          <div className="panel-card-title">
            <h2><Network size={18} /> Peer VMs visible from {neighborsFor}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn secondary" onClick={() => findNeighbors(neighborsFor)} disabled={neighborsBusy} style={{ padding: '6px 12px' }}>
                <RefreshCw size={14} className={neighborsBusy ? 'loader' : ''} /> Re-scan
              </button>
              <button className="icon-btn" onClick={() => setNeighborsFor(null)}><X size={16} /></button>
            </div>
          </div>
          {neighborsBusy ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', padding: 12 }}>
              <span className="loader" /> Scanning cluster nodes, hosts file and network neighbors over SSH…
            </div>
          ) : neighborsErr ? (
            <p style={{ color: 'var(--status-error)', fontSize: 13 }}>{neighborsErr}</p>
          ) : neighbors.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No new peer hosts found (everything visible is already in the inventory).</p>
          ) : (
            <>
              <div className="table-wrapper"><table className="resource-table">
                <thead><tr><th>IP</th><th>Hostname</th><th>Seen in</th><th>Action</th></tr></thead>
                <tbody>{neighbors.map((n) => (
                  <tr key={n.ip}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{n.ip}</td>
                    <td>{n.hostname || '—'}</td>
                    <td><span className="badge neutral" style={{ fontSize: 10 }}>{n.source === 'k8s-node' ? 'K8s cluster' : n.source === 'hosts-file' ? '/etc/hosts' : 'ARP table'}</span></td>
                    <td>
                      <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={() => {
                          const src = vms.find((v) => v.name === neighborsFor);
                          setForm({
                            name: (n.hostname || `vm-${n.ip.replace(/\./g, '-')}`).split('.')[0],
                            host: n.ip,
                            user: src?.user || '',
                            password: '',
                            keyPath: src?.keyPath || '',
                            via: neighborsFor,
                          });
                          setShowAdd(true);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}>
                        <Plus size={12} /> Add via {neighborsFor}
                      </button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
                "Add via" pre-fills the form with {neighborsFor} as the SSH jump host — enter the peer's login and password, then Save.
              </p>
            </>
          )}
        </div>
      )}

      {/* Read-only cluster diagnosis report */}
      {diagFor && (() => {
        const d = diagnosis[diagFor];
        const busy = diagBusy[diagFor];
        return (
          <div className="panel-card" style={{ borderLeft: '3px solid var(--status-warn, #E5A50A)' }}>
            <div className="panel-card-title">
              <h2><Activity size={18} /> Diagnosis · {diagFor}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn secondary" onClick={() => diagnose(diagFor)} disabled={busy} style={{ padding: '6px 12px' }}>
                  <RefreshCw size={14} className={busy ? 'loader' : ''} /> Re-run
                </button>
                <button className="icon-btn" onClick={() => setDiagFor(null)}><X size={16} /></button>
              </div>
            </div>

            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0 }}>
              <ShieldCheck size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
              Read-only: runs only <code>kubectl get / describe / logs / events</code> over SSH. Suggested fixes are reported for you to review — nothing is executed.
            </p>

            {busy && !d ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', padding: 12 }}>
                <span className="loader" /> Inspecting nodes, pods, logs and events over SSH…
              </div>
            ) : !d ? null : d.error ? (
              <p style={{ color: 'var(--status-error)', fontSize: 13 }}>{d.error}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: (d.findings?.length || 0) === 0 ? 'var(--hpe-green)' : 'var(--text-primary)' }}>
                  {d.summary}
                </div>

                {/* Start here: what the dependency graph thinks is the actual cause. */}
                {(d.causes?.rootCauses.length || 0) > 0 && (d.findings?.length || 0) > 1 && (
                  <div style={{ border: '1px solid var(--border-color)', borderLeft: '3px solid var(--hpe-green)', borderRadius: 8, padding: 12, background: 'var(--bg-tertiary)' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Start here — root cause analysis</div>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 8px' }}>{d.causes!.summary}</p>
                    {d.causes!.rootCauses.slice(0, 3).map((c) => (
                      <div key={c.id} style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span className={`badge ${c.confidence === 'high' ? 'error' : 'warning'}`}>{c.confidence} confidence</span>
                          <strong style={{ fontSize: 13 }}>{c.component?.title || `${c.namespace ? `${c.namespace} / ` : ''}${c.name}`}</strong>
                          {c.explains.length > 0 && (
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>explains {c.explains.length} downstream failure(s)</span>
                          )}
                          {c.atRisk > 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {c.atRisk} healthy at risk</span>}
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>{c.explanation}</p>
                        {c.component?.impact && (
                          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>Impact if it stays down: {c.component.impact}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {(d.findings || []).map((f, i) => (
                  <div key={i} style={{ border: '1px solid var(--border-color)', borderLeft: `3px solid ${f.severity === 'critical' ? 'var(--status-error)' : 'var(--status-warn, #E5A50A)'}`, borderRadius: 8, padding: 12, background: 'var(--bg-tertiary)', opacity: f.causedBy ? 0.75 : 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                      <AlertTriangle size={14} style={{ color: f.severity === 'critical' ? 'var(--status-error)' : 'var(--status-warn, #E5A50A)' }} />
                      <span className={`badge ${f.severity === 'critical' ? 'error' : 'warning'}`}>{f.reason}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{f.kind}</span>
                      <strong style={{ fontSize: 13 }}>{f.namespace ? `${f.namespace} / ` : ''}{f.name}</strong>
                      {f.rootCause && (
                        <span className="badge" style={{ background: 'var(--hpe-green)', color: '#fff' }}>
                          root cause{f.explains ? ` · explains ${f.explains}` : ''}
                        </span>
                      )}
                    </div>
                    {f.causedBy && (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                        Downstream of {f.causedBy} — likely clears when that is fixed.
                      </p>
                    )}
                    <p style={{ fontSize: 13, margin: '4px 0 8px' }}>{f.detail}</p>
                    {f.events && (
                      <details style={{ marginBottom: 6 }}>
                        <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>Events (kubectl describe)</summary>
                        <pre style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: 10, fontSize: 11, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto', margin: '6px 0 0' }}>{f.events}</pre>
                      </details>
                    )}
                    {f.logExcerpt && (
                      <details style={{ marginBottom: 6 }}>
                        <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>Log excerpt (last lines)</summary>
                        <pre style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: 10, fontSize: 11, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', margin: '6px 0 0' }}>{f.logExcerpt}</pre>
                      </details>
                    )}
                    <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>Suggested fix (not executed):</div>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {f.suggestedFixes.map((s, j) => <li key={j} style={{ fontSize: 12, fontFamily: s.includes('kubectl') || s.includes('systemctl') ? 'var(--font-mono)' : undefined, color: 'var(--text-secondary)' }}>{s}</li>)}
                    </ul>
                  </div>
                ))}

                {d.warningEvents && (
                  <details>
                    <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>Recent cluster warning events</summary>
                    <pre style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: 10, fontSize: 11, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', margin: '6px 0 0' }}>{d.warningEvents}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Interactive terminal (persistent login shell over SSH) */}
      {execFor && (
        <RemoteTerminal
          key={`${execFor}:${execRoot ? 'root' : 'user'}`}
          vm={execFor}
          asRoot={execRoot && vms.find((v) => v.name === execFor)?.user !== 'root'}
          onClose={() => setExecFor(null)}
        />
      )}
    </div>
  );
};

export default VmMonitor;
