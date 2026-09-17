import React, { useMemo, useState } from 'react';
import {
  Activity, Cpu, MemoryStick, HardDrive, Server, RefreshCw, RotateCcw, Play, Info, Search,
  CheckCircle2, AlertTriangle, XCircle, Network, Clock,
} from 'lucide-react';
import { unitBadge } from '../lib/hostlogs';

// "What is this machine and is it healthy?" — the top of the Host Logs page.
// Everything comes from one /api/logs/overview call; service buttons call back
// into HostLogs, which owns the confirmation and the result panel.

export type HealthStatus = 'ok' | 'warning' | 'critical' | 'info';
export interface HealthCheck { id: string; status: HealthStatus; title: string; detail: string; unit?: string }
export interface ServiceUnit { unit: string; load: string; active: string; sub: string; description: string; critical: boolean; access: boolean }
interface Filesystem { source: string; type: string; mount: string; size: number; used: number; avail: number; usePct: number; inodesPct?: number }
interface ProcessRow { pid: number; user: string; cpu: number; mem: number; rssKb: number; command: string }
interface ListenPort { proto: string; address: string; port: string; process: string }

export interface Overview {
  reachable: boolean; error?: string; hint?: string;
  hostname: string; os: string; kernel: string; arch: string; virt: string;
  uptime: string; bootedAt: string; uptimeSec: number;
  cpus: number; load: [number, number, number];
  memory: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  filesystems: Filesystem[]; services: ServiceUnit[];
  topMemory: ProcessRow[]; topCpu: ProcessRow[]; ports: ListenPort[];
  timeSynced: boolean | null; timezone: string; journalDisk: string; reboots: string[];
  runsAsRoot: boolean; health: HealthCheck[];
}

export type ServiceAction = 'status' | 'restart' | 'start';

const STATUS_STYLE: Record<HealthStatus, { color: string; icon: React.ComponentType<any> }> = {
  critical: { color: '#E5484D', icon: XCircle },
  warning: { color: '#FF8300', icon: AlertTriangle },
  info: { color: '#00A3E0', icon: Info },
  ok: { color: '#01A982', icon: CheckCircle2 },
};

const GB = 1024 ** 3;
const gb = (b: number) => `${(b / GB).toFixed(b < 10 * GB ? 1 : 0)} GB`;
const barColor = (pct: number) => (pct >= 90 ? '#E5484D' : pct >= 80 ? '#FF8300' : '#01A982');

const Bar: React.FC<{ pct: number }> = ({ pct }) => (
  <div style={{ height: 6, borderRadius: 3, background: 'rgba(127,127,127,0.2)', overflow: 'hidden' }}>
    <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: barColor(pct) }} />
  </div>
);

interface Props {
  data: Overview | null;
  loading: boolean;
  busyUnit: string;
  onRefresh: () => void;
  onService: (unit: string, action: ServiceAction) => void;
}

export const HostOverview: React.FC<Props> = ({ data, loading, busyUnit, onRefresh, onService }) => {
  const [svcFilter, setSvcFilter] = useState<'problems' | 'running' | 'all'>('problems');
  const [svcQuery, setSvcQuery] = useState('');

  const services = useMemo(() => {
    const q = svcQuery.toLowerCase();
    const list = (data?.services || []).filter((s) => s.load !== 'not-found');
    return list
      .filter((s) =>
        svcFilter === 'all' ? true
          : svcFilter === 'running' ? s.active === 'active'
            : s.active === 'failed' || s.active === 'activating' || s.sub === 'auto-restart' || (s.critical && s.active !== 'active'))
      .filter((s) => !q || `${s.unit} ${s.description}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.active === 'failed') - Number(a.active === 'failed') || Number(b.critical) - Number(a.critical) || a.unit.localeCompare(b.unit));
  }, [data, svcFilter, svcQuery]);

  const small = { padding: '5px 12px', fontSize: 12 };
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 };
  const label: React.CSSProperties = { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' };
  const tile: React.CSSProperties = { flex: '1 1 180px', minWidth: 160, padding: 12, borderRadius: 8, background: 'var(--bg-subtle, rgba(127,127,127,0.06))', display: 'flex', flexDirection: 'column', gap: 6 };

  if (!data) {
    return (
      <div className="panel-card">
        <div className="panel-card-title"><h2><Server size={17} /> System overview</h2></div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
          {loading ? <><span className="loader" /> Collecting system facts over SSH…</> : 'Select a VM to load its overview.'}
        </p>
      </div>
    );
  }
  if (!data.reachable || data.error) {
    return (
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Server size={17} /> System overview</h2>
          <button className="btn secondary" onClick={onRefresh} disabled={loading} style={{ marginLeft: 'auto', ...small }}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Retry
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: '#E5484D' }}>{data.error || 'Host unreachable.'}</p>
      </div>
    );
  }

  const m = data.memory;
  const memPct = m.total ? Math.round(((m.total - m.available) / m.total) * 100) : 0;
  const loadPct = data.cpus ? Math.round((data.load[1] / data.cpus) * 100) : 0;
  const root = data.filesystems.find((f) => f.mount === '/') || data.filesystems[0];
  const counts = data.health.reduce((acc, h) => ({ ...acc, [h.status]: (acc[h.status] || 0) + 1 }), {} as Record<string, number>);
  const overall: HealthStatus = counts.critical ? 'critical' : counts.warning ? 'warning' : 'ok';
  const failedCount = data.services.filter((s) => s.active === 'failed').length;

  const serviceButtons = (unit: string, s?: ServiceUnit) => (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11.5 }} onClick={() => onService(unit, 'status')} disabled={!!busyUnit} title="systemctl status + recent journal (read-only)">
        <Info size={12} /> Status
      </button>
      {s && s.active !== 'active' && s.active !== 'activating' && (
        <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11.5 }} onClick={() => onService(unit, 'start')} disabled={!!busyUnit} title={`systemctl start ${unit}`}>
          <Play size={12} /> Start
        </button>
      )}
      <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11.5, color: s?.access ? '#FF8300' : undefined }} onClick={() => onService(unit, 'restart')} disabled={!!busyUnit} title={`systemctl restart ${unit}`}>
        {busyUnit === unit ? <RefreshCw size={12} className="animate-spin" /> : <RotateCcw size={12} />} Restart
      </button>
    </span>
  );

  return (
    <div className="panel-card" style={{ borderLeft: `3px solid ${STATUS_STYLE[overall].color}` }}>
      <div className="panel-card-title">
        <h2><Server size={17} /> {data.hostname}</h2>
        <span className={`badge ${overall === 'ok' ? 'success' : overall === 'warning' ? 'warning' : 'error'}`}>
          {overall === 'ok' ? 'healthy' : `${counts.critical || 0} critical · ${counts.warning || 0} warning`}
        </span>
        <button className="btn secondary" onClick={onRefresh} disabled={loading} style={{ marginLeft: 'auto', ...small }}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh overview
        </button>
      </div>

      {/* Identity */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 12 }}>
        <span>{data.os}</span>
        <span>kernel {data.kernel}{data.arch ? ` (${data.arch})` : ''}</span>
        {data.virt && <span>{data.virt}</span>}
        <span><Clock size={11} style={{ verticalAlign: -1 }} /> up {data.uptime || '—'}{data.bootedAt ? ` · since ${data.bootedAt}` : ''}</span>
        {data.timezone && <span>{data.timezone}</span>}
        {data.journalDisk && <span>journal {data.journalDisk}</span>}
        <span className={`badge ${data.runsAsRoot ? 'success' : 'warning'}`}>{data.runsAsRoot ? 'root' : 'not root'}</span>
      </div>

      {/* Resource tiles */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={tile}>
          <span style={label}><Cpu size={11} style={{ verticalAlign: -1 }} /> CPU load (5m)</span>
          <strong style={{ fontSize: 18 }}>{data.load[1].toFixed(2)} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>/ {data.cpus} CPUs</span></strong>
          <Bar pct={loadPct} />
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>1m {data.load[0].toFixed(2)} · 15m {data.load[2].toFixed(2)}</span>
        </div>
        <div style={tile}>
          <span style={label}><MemoryStick size={11} style={{ verticalAlign: -1 }} /> Memory</span>
          <strong style={{ fontSize: 18 }}>{memPct}% <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>of {gb(m.total)}</span></strong>
          <Bar pct={memPct} />
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{gb(m.available)} available{m.swapTotal ? ` · swap ${gb(m.swapUsed)}/${gb(m.swapTotal)}` : ' · no swap'}</span>
        </div>
        {root && (
          <div style={tile}>
            <span style={label}><HardDrive size={11} style={{ verticalAlign: -1 }} /> Disk {root.mount}</span>
            <strong style={{ fontSize: 18 }}>{root.usePct}% <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>of {gb(root.size)}</span></strong>
            <Bar pct={root.usePct} />
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{gb(root.avail)} free{root.inodesPct !== undefined ? ` · inodes ${root.inodesPct}%` : ''}</span>
          </div>
        )}
        <div style={tile}>
          <span style={label}><Activity size={11} style={{ verticalAlign: -1 }} /> Services</span>
          <strong style={{ fontSize: 18, color: failedCount ? '#E5484D' : undefined }}>{failedCount} failed</strong>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {data.services.filter((s) => s.active === 'active').length} active · {data.services.length} total · {data.ports.length} listening ports
          </span>
        </div>
      </div>

      {/* Health checklist */}
      <div style={{ ...label, marginBottom: 6 }}>Health checks</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8, marginBottom: 14 }}>
        {data.health.map((h) => {
          const st = STATUS_STYLE[h.status];
          const Icon = st.icon;
          const svc = h.unit ? data.services.find((s) => s.unit === h.unit) : undefined;
          return (
            <div key={h.id} style={{ display: 'flex', gap: 8, padding: '8px 10px', borderRadius: 6, borderLeft: `3px solid ${st.color}`, background: 'var(--bg-subtle, rgba(127,127,127,0.06))' }}>
              <Icon size={15} color={st.color} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12.5, lineHeight: 1.4, minWidth: 0 }}>
                <strong>{h.title}</strong>
                <div style={{ color: 'var(--text-secondary)' }}>{h.detail}</div>
                {h.unit && <div style={{ marginTop: 6 }}>{serviceButtons(h.unit, svc)}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Services */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={label}>systemd services</span>
        {(['problems', 'running', 'all'] as const).map((f) => (
          <button key={f} className={`btn ${svcFilter === f ? 'primary' : 'secondary'}`} style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => setSvcFilter(f)}>
            {f === 'problems' ? 'Needs attention' : f === 'running' ? 'Active' : 'All'}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Search size={13} />
          <input className="form-input" placeholder="Find a service…" value={svcQuery} onChange={(e) => setSvcQuery(e.target.value)} style={{ width: 180, ...small }} />
        </span>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto', marginBottom: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <tbody>
            {services.map((s) => (
              <tr key={s.unit} style={{ borderTop: '1px solid var(--border, rgba(127,127,127,0.2))' }}>
                <td style={{ padding: '5px 6px', ...mono, whiteSpace: 'nowrap' }}>
                  {s.unit} {s.critical && <span className="badge neutral" title="Core node service">core</span>}
                </td>
                <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}><span className={`badge ${unitBadge(s)}`}>{s.active}/{s.sub}</span></td>
                <td style={{ padding: '5px 6px', color: 'var(--text-secondary)' }}>{s.description}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>{serviceButtons(s.unit, s)}</td>
              </tr>
            ))}
            {!services.length && (
              <tr><td style={{ padding: 8, color: 'var(--text-muted)' }}>
                {svcFilter === 'problems' && !svcQuery ? 'No failed, restarting or stopped core services.' : 'No services match.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Filesystems, processes, ports */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <div>
          <div style={{ ...label, marginBottom: 6 }}><HardDrive size={11} style={{ verticalAlign: -1 }} /> Filesystems</div>
          {data.filesystems.map((f) => (
            <div key={f.mount} style={{ marginBottom: 8, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={mono} title={`${f.source} (${f.type})`}>{f.mount}</span>
                <span style={{ color: 'var(--text-muted)' }}>{f.usePct}% · {gb(f.avail)} free{f.inodesPct !== undefined ? ` · inodes ${f.inodesPct}%` : ''}</span>
              </div>
              <Bar pct={f.usePct} />
            </div>
          ))}
          {!data.filesystems.length && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No data.</span>}
        </div>

        <div>
          <div style={{ ...label, marginBottom: 6 }}><MemoryStick size={11} style={{ verticalAlign: -1 }} /> Top processes</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}><th>Command</th><th>User</th><th>PID</th><th>CPU%</th><th>MEM%</th></tr></thead>
            <tbody>
              {[...data.topMemory, ...data.topCpu.filter((c) => !data.topMemory.some((mm) => mm.pid === c.pid))].slice(0, 12).map((p) => (
                <tr key={p.pid} style={{ borderTop: '1px solid var(--border, rgba(127,127,127,0.15))' }}>
                  <td style={mono}>{p.command}</td><td>{p.user}</td><td>{p.pid}</td>
                  <td style={{ color: p.cpu >= 80 ? '#FF8300' : undefined }}>{p.cpu.toFixed(1)}</td>
                  <td style={{ color: p.mem >= 30 ? '#FF8300' : undefined }}>{p.mem.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <div style={{ ...label, marginBottom: 6 }}><Network size={11} style={{ verticalAlign: -1 }} /> Listening ports</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
            {data.ports.map((p) => (
              <span key={`${p.proto}${p.address}${p.port}${p.process}`} className="badge neutral" title={`${p.proto} ${p.address}:${p.port}`} style={mono}>
                {p.port}/{p.proto}{p.process ? ` ${p.process}` : ''}
              </span>
            ))}
            {!data.ports.length && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No data (needs <code className="code-tag">ss</code>).</span>}
          </div>
          {data.reboots.length > 0 && (
            <>
              <div style={{ ...label, margin: '12px 0 6px' }}>Recent reboots</div>
              <pre style={{ ...mono, margin: 0, fontSize: 11.5, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{data.reboots.join('\n')}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default HostOverview;
