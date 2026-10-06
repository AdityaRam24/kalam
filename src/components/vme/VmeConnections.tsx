// VME Manager connections: add, edit, test, remove. Secrets are write-only —
// the server never sends a stored token or password back, only hasToken /
// hasPassword, and a blank field on edit keeps what is stored.

import React, { useState } from 'react';
import { Plug, Plus, Trash2, CheckCircle2, AlertTriangle, Pencil, ShieldAlert } from 'lucide-react';

export interface PublicConnection { name: string; url: string; username?: string; insecureTls?: boolean; k8sSource?: string; hasToken: boolean; hasPassword: boolean }

interface Props {
  connections: PublicConnection[];
  vmNames: string[];
  onChanged: (selectName?: string) => void;
}

const empty = { originalName: '', name: '', url: '', auth: 'token' as 'token' | 'password', token: '', username: '', password: '', insecureTls: false, k8sSource: 'local' };

export const VmeConnections: React.FC<Props> = ({ connections, vmNames, onChanged }) => {
  const [form, setForm] = useState<typeof empty | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});

  const edit = (c?: PublicConnection) => {
    setMsg(null);
    setForm(c ? { ...empty, originalName: c.name, name: c.name, url: c.url, auth: c.hasPassword && !c.hasToken ? 'password' : 'token', username: c.username || '', insecureTls: !!c.insecureTls, k8sSource: c.k8sSource || '' } : { ...empty });
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch('/api/vme/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, k8sSource: form.k8sSource || undefined }) }).then((r) => r.json());
      if (d.error) { setMsg({ ok: false, text: d.error }); return; }
      const t = await fetch('/api/vme/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name }) }).then((r) => r.json());
      setTests((x) => ({ ...x, [form.name]: t.ok ? { ok: true, text: `Connected as ${t.user || '?'}${t.version ? ` · VME ${t.version}` : ''}` } : { ok: false, text: t.error } }));
      setForm(null);
      onChanged(form.name);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const test = async (name: string) => {
    setTests((x) => ({ ...x, [name]: { ok: true, text: 'Testing…' } }));
    const t = await fetch('/api/vme/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    setTests((x) => ({ ...x, [name]: t.ok ? { ok: true, text: `Connected as ${t.user || '?'}${t.version ? ` · VME ${t.version}` : ''}` } : { ok: false, text: t.error } }));
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Remove the connection "${name}"? Its stored token/password is deleted.`)) return;
    await fetch(`/api/vme/connections/${encodeURIComponent(name)}`, { method: 'DELETE' });
    onChanged();
  };

  const set = (k: keyof typeof empty, v: any) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Plug size={18} /> VME Manager connections</h2>
          <button className="btn primary" onClick={() => edit()} style={{ padding: '6px 12px', fontSize: 12 }}><Plus size={13} /> Add Manager</button>
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Trinetra reads the Manager's REST API with <b>GET requests only</b> (servers, instances, clusters, datastores, networks, alarms, activity).
          Use an API token from <i>User Settings → API Access</i> of a user with a <b>read-only role</b>. Tokens and passwords stay on this server
          (<code className="code-tag">server/vme/vme.json</code>, mode 600) and are never sent back to the browser.
        </p>
        {connections.length === 0 && !form && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>No Manager yet — add one, or open the demo estate from the picker above.</p>}
        {connections.length > 0 && (
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>Name</th><th>Manager URL</th><th>Login</th><th>Join with Kubernetes</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.name}>
                    <td><strong>{c.name}</strong></td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.url}{c.insecureTls && <span className="badge warning" style={{ marginLeft: 6, textTransform: 'none' }} title="TLS certificate is not verified">TLS not verified</span>}</td>
                    <td style={{ fontSize: 12 }}>{c.hasToken ? 'API token' : c.hasPassword ? `password (${c.username})` : '—'}</td>
                    <td style={{ fontSize: 12 }}>{c.k8sSource ? (c.k8sSource === 'local' ? 'this machine’s kubeconfig' : c.k8sSource) : 'off'}</td>
                    <td style={{ fontSize: 12, color: tests[c.name] ? (tests[c.name].ok ? 'var(--status-success)' : 'var(--status-error)') : 'var(--text-muted)' }}>{tests[c.name]?.text || 'not tested'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn secondary" onClick={() => void test(c.name)} style={{ padding: '3px 8px', fontSize: 11 }}>Test</button>{' '}
                      <button className="icon-btn secondary" title="Edit" onClick={() => edit(c)}><Pencil size={13} /></button>{' '}
                      <button className="icon-btn secondary" title="Remove" onClick={() => void remove(c.name)}><Trash2 size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {form && (
        <div className="panel-card">
          <div className="panel-card-title"><h2>{form.originalName ? `Edit ${form.originalName}` : 'Add a VME Manager'}</h2></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, fontSize: 12.5 }}>
            <label>Name<input className="form-input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="vme-prod" /></label>
            <label>Manager URL<input className="form-input" value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://vme-manager.example.com" /></label>
            <label>Login with
              <select className="form-input" value={form.auth} onChange={(e) => set('auth', e.target.value)}>
                <option value="token">API token (recommended)</option>
                <option value="password">Username + password</option>
              </select>
            </label>
            {form.auth === 'token' ? (
              <label>API token<input className="form-input" type="password" autoComplete="off" value={form.token} onChange={(e) => set('token', e.target.value)}
                placeholder={form.originalName && connections.find((c) => c.name === form.originalName)?.hasToken ? '(stored — leave blank to keep)' : 'paste the access token'} /></label>
            ) : (
              <>
                <label>Username<input className="form-input" value={form.username} onChange={(e) => set('username', e.target.value)} /></label>
                <label>Password<input className="form-input" type="password" autoComplete="off" value={form.password} onChange={(e) => set('password', e.target.value)}
                  placeholder={form.originalName && connections.find((c) => c.name === form.originalName)?.hasPassword ? '(stored — leave blank to keep)' : ''} /></label>
              </>
            )}
            <label>Join VMs with Kubernetes nodes from
              <select className="form-input" value={form.k8sSource} onChange={(e) => set('k8sSource', e.target.value)}>
                <option value="">Don’t join</option>
                <option value="local">This machine’s kubeconfig</option>
                {vmNames.map((n) => <option key={n} value={n}>{n} (over SSH)</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'end', paddingBottom: 8 }}>
              <input type="checkbox" checked={form.insecureTls} onChange={(e) => set('insecureTls', e.target.checked)} />
              <ShieldAlert size={13} /> Skip TLS verification (self-signed Manager certificate)
            </label>
          </div>
          {msg && <div style={{ marginTop: 10, fontSize: 12.5, color: msg.ok ? 'var(--status-success)' : 'var(--status-error)' }}>{msg.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {msg.text}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={() => void save()} style={{ padding: '6px 14px', fontSize: 12 }}>{busy ? 'Saving…' : 'Save and test'}</button>
            <button className="btn secondary" onClick={() => setForm(null)} style={{ padding: '6px 14px', fontSize: 12 }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VmeConnections;
