// Hardware inventory — what every host physically is, for planning the move
// from VMware to HPE VM Essentials (Morpheus).
//
// One read-only SSH probe per inventory host (server/hardware/inventory.ts):
// CPU model / sockets / feature flags, memory slots and ECC errors, NICs and
// bonds, disks and SMART health, multipath / FC / iSCSI, PCI devices and GPUs,
// BIOS and iLO firmware, KVM / IOMMU / libvirt / OVS. The page leads with the
// fleet totals (sockets = VME licences), then where hosts that should match do
// not, then one row per host that opens into its full detail.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Cpu, RefreshCw, AlertTriangle, CheckCircle2, Info, Server, GitCompare, ChevronDown, ChevronRight, Download,
  MemoryStick, HardDrive, Network, Microchip, Layers, Scale, Boxes, XCircle, HelpCircle, ListChecks, ArrowRightLeft,
} from 'lucide-react';
import { downloadText, stamp, toCsv } from '../lib/health';
import CapacityPlan from './CapacityPlan';
import { useCharts, SERIES } from '../lib/charts';
import { BarList, ChartCard, ChartGrid, ChartsToggle, PartBar } from './Charts';

type Status = 'critical' | 'warning' | 'info' | 'ok';
interface Check { id: string; status: Status; area: string; title: string; detail?: string; evidence?: string; hint?: string }
interface Cpu { model?: string; vendor?: string; sockets?: number; coresPerSocket?: number; threadsPerCore?: number; logical?: number; cores?: number; numaNodes?: number; maxMhz?: number; l3?: string; virtualization?: string; hypervisor?: string; flags: string[] }
interface Dimm { locator: string; sizeBytes?: number; type?: string; speed?: string; manufacturer?: string; part?: string }
interface Memory { totalBytes?: number; swapBytes?: number; hugepages?: number; hugepageKb?: number; maxCapacity?: string; ecc?: string; slots?: number; populated?: number; dimms: Dimm[]; edac: Array<{ mc: string; ce: number; ue: number }>; noDmi?: boolean }
interface Nic { name: string; kind: string; mac?: string; state?: string; speedMbps?: number; mtu?: number; ips: string[]; master?: string; pci?: string; driver?: string; firmware?: string; sriovTotal?: number; sriovNum?: number }
interface Bond { name: string; mode?: string; mii?: string; slaves: Array<{ name: string; mii?: string; speed?: string }> }
interface Disk { name: string; type: string; sizeBytes: number; rotational: boolean; model?: string; serial?: string; transport?: string; vendor?: string; wwn?: string; smart?: string }
interface Pci { address: string; driver?: string; cls: string; vendor: string; device: string }
interface Hardware {
  host?: string; uid?: number; os?: string; kernel?: string; arch?: string; virt?: string; physical: boolean;
  system: { vendor?: string; product?: string; version?: string; serial?: string; biosVendor?: string; biosVersion?: string; biosDate?: string; chassisType?: string };
  cpu: Cpu; memory: Memory; nics: Nic[]; bonds: Bond[]; disks: Disk[]; smartMissing?: boolean;
  multipath: { maps: number; activePaths: number; failedPaths: number; text: string[] };
  fc: Array<{ host: string; wwpn?: string; state?: string; speed?: string }>; iscsi: { initiator?: string; sessions?: number };
  pci: Pci[]; lspciMissing?: boolean; gpus: Pci[];
  virtHost: { kvm: boolean; nested?: string; iommuGroups: number; cmdline: string[]; vfio: boolean; libvirt?: string; guests: string[]; ovs?: string; ovsBridges: string[]; units: Array<{ unit: string; active: string; sub: string }> };
  bmc: { firmware?: string; manufacturer?: string; ip?: string; mac?: string };
}
type ReadyStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'info';
interface ReadyItem { id: string; label: string; status: ReadyStatus; detail: string; fix?: string }
interface Readiness { verdict: 'ready' | 'prep' | 'blocked'; items: ReadyItem[]; dataBytes?: number }
interface ReadySummary { vms: number; ready: number; prep: number; blocked: number; dataBytes: number }
interface HostResult { host: string; reachable: boolean; error?: string; at: string; hardware?: Hardware; checks: Check[]; readiness?: Readiness }
interface Drift { group: 'physical' | 'virtual'; what: string; why: string; values: Record<string, string> }
interface Totals { hosts: number; physical: number; virtual: number; sockets: number; cores: number; threads: number; memoryBytes: number; diskBytes: number; gpus: number; guests: number }

const STATUS_COLOR: Record<Status, string> = {
  critical: 'var(--status-error)', warning: 'var(--status-warning)', info: 'var(--text-secondary)', ok: 'var(--status-success)',
};
const STATUS_BADGE: Record<Status, string> = { critical: 'error', warning: 'warning', info: 'neutral', ok: 'running' };
const StatusIcon: React.FC<{ s: Status }> = ({ s }) =>
  s === 'ok' ? <CheckCircle2 size={14} color={STATUS_COLOR[s]} /> : s === 'info' ? <Info size={14} color={STATUS_COLOR[s]} /> : <AlertTriangle size={14} color={STATUS_COLOR[s]} />;

const GUEST_NAME: Record<string, string> = { vmware: 'VMware VM', kvm: 'KVM VM', qemu: 'QEMU VM', microsoft: 'Hyper-V VM', xen: 'Xen VM', oracle: 'VirtualBox VM', guest: 'VM' };

const bytes = (b?: number) => {
  if (!b) return '—';
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(1)} TiB`;
  if (b >= 1024 ** 3) return `${Math.round(b / 1024 ** 3)} GiB`;
  return `${Math.round(b / 1024 ** 2)} MiB`;
};
const speed = (mbps?: number) => (!mbps ? '—' : mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`);
const worstOf = (checks: Check[]): Status =>
  checks.some((c) => c.status === 'critical') ? 'critical' : checks.some((c) => c.status === 'warning') ? 'warning' : 'ok';
const kindOf = (hw: Hardware) => hw.physical
  ? (hw.system.product || 'Bare metal')
  : GUEST_NAME[hw.virt || ''] || (hw.cpu.hypervisor ? `${hw.cpu.hypervisor} VM` : 'VM (platform unknown)');

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };
const pre: React.CSSProperties = { background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 8, fontSize: 11.5, maxHeight: 280, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' };

const Tile: React.FC<{ label: string; value: string; sub?: string; color?: string; icon: React.ReactNode; title?: string }> = ({ label, value, sub, color, icon, title }) => (
  <div title={title} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>{icon}{label}</div>
    <div style={{ fontSize: 22, fontWeight: 650, color: color || 'var(--text-heading)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
  </div>
);

const Section: React.FC<{ title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean; icon?: React.ReactNode }> = ({ title, count, children, defaultOpen, icon }) => {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ marginTop: 10 }}>
      <button className="btn secondary" onClick={() => setOpen(!open)} style={{ padding: '3px 10px', fontSize: 12 }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {icon} {title}{count !== undefined ? ` (${count})` : ''}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
};

const KV: React.FC<{ rows: Array<[string, React.ReactNode]> }> = ({ rows }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 14, rowGap: 3, fontSize: 12 }}>
    {rows.filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => (
      <React.Fragment key={k}>
        <span style={{ color: 'var(--text-muted)' }}>{k}</span>
        <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{v}</span>
      </React.Fragment>
    ))}
  </div>
);

/** CPU flags people ask about before a migration, shown first. */
const KEY_FLAGS = ['vmx', 'svm', 'avx', 'avx2', 'avx512f', 'amx_tile', 'aes', 'sha_ni', 'pdpe1gb', 'hypervisor'];

const HostDetail: React.FC<{ r: HostResult; showInfo: boolean }> = ({ r, showInfo }) => {
  const hw = r.hardware!;
  const checks = r.checks.filter((c) => showInfo || c.status === 'critical' || c.status === 'warning');
  const phys = hw.nics.filter((n) => n.kind === 'physical');
  const logical = hw.nics.filter((n) => n.kind !== 'physical');
  return (
    <div style={{ padding: '4px 4px 10px' }}>
      {checks.length === 0 && <p style={{ margin: '0 0 6px', fontSize: 12.5, color: 'var(--status-success)' }}><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> No hardware problems found.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {checks.map((c) => (
          <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 6, background: c.status === 'critical' || c.status === 'warning' ? 'var(--bg-tertiary)' : undefined }}>
            <div style={{ marginTop: 2 }}><StatusIcon s={c.status} /></div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--text-heading)', fontWeight: c.status === 'info' ? 500 : 650 }}>
                {c.title} <span className={`badge ${STATUS_BADGE[c.status]}`} style={{ textTransform: 'none', fontSize: 10, marginLeft: 4 }}>{c.area}</span>
              </div>
              {c.detail && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{c.detail}</div>}
              {c.evidence && <div style={{ ...mono, fontSize: 11, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-all' }}>{c.evidence}</div>}
              {c.hint && <div style={{ ...mono, fontSize: 11, color: 'var(--accent-cyan)', marginTop: 2 }}>$ {c.hint}</div>}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 6, color: 'var(--text-heading)' }}><Server size={13} style={{ verticalAlign: -2 }} /> System</div>
          <KV rows={[
            ['Vendor / model', [hw.system.vendor, hw.system.product].filter(Boolean).join(' ') || undefined],
            ['Serial', hw.system.serial && <span style={mono}>{hw.system.serial}</span>],
            ['Chassis', hw.system.chassisType],
            ['BIOS', [hw.system.biosVendor, hw.system.biosVersion, hw.system.biosDate && `(${hw.system.biosDate})`].filter(Boolean).join(' ') || undefined],
            ['BMC / iLO', [hw.bmc.manufacturer, hw.bmc.firmware && `fw ${hw.bmc.firmware}`, hw.bmc.ip].filter(Boolean).join(' · ') || undefined],
            ['OS', hw.os],
            ['Kernel', hw.kernel && <span style={mono}>{hw.kernel}</span>],
          ]} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 6, color: 'var(--text-heading)' }}><Cpu size={13} style={{ verticalAlign: -2 }} /> CPU</div>
          <KV rows={[
            ['Model', hw.cpu.model],
            ['Topology', hw.cpu.sockets ? `${hw.cpu.sockets} socket${hw.cpu.sockets === 1 ? '' : 's'} ×${hw.cpu.coresPerSocket ?? '?'} cores × ${hw.cpu.threadsPerCore ?? '?'} threads = ${hw.cpu.logical ?? '?'} CPUs` : hw.cpu.logical ? `${hw.cpu.logical} CPUs` : undefined],
            ['NUMA nodes', hw.cpu.numaNodes],
            ['Max clock', hw.cpu.maxMhz ? `${(hw.cpu.maxMhz / 1000).toFixed(2)} GHz` : undefined],
            ['L3 cache', hw.cpu.l3],
            ['Virtualization', hw.cpu.virtualization || (hw.physical ? 'none' : undefined)],
            ['Hypervisor', hw.cpu.hypervisor],
            ['Key flags', <span style={mono}>{KEY_FLAGS.filter((f) => hw.cpu.flags.includes(f)).join(' ') || '—'}</span>],
          ]} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 6, color: 'var(--text-heading)' }}><Layers size={13} style={{ verticalAlign: -2 }} /> Virtualization host</div>
          <KV rows={[
            ['/dev/kvm', hw.virtHost.kvm ? 'present' : 'absent'],
            ['Nested', hw.virtHost.nested],
            ['IOMMU groups', hw.virtHost.iommuGroups || 'none (passthrough off)'],
            ['vfio-pci', hw.virtHost.vfio ? 'loaded' : undefined],
            ['Kernel args', hw.virtHost.cmdline.length ? <span style={mono}>{hw.virtHost.cmdline.join(' ')}</span> : undefined],
            ['libvirt', hw.virtHost.libvirt && `${hw.virtHost.libvirt} · ${hw.virtHost.guests.length} guest${hw.virtHost.guests.length === 1 ? '' : 's'}`],
            ['Open vSwitch', hw.virtHost.ovs && `${hw.virtHost.ovs.match(/\d+(\.\d+)+/)?.[0] || hw.virtHost.ovs}${hw.virtHost.ovsBridges.length ? ` · ${hw.virtHost.ovsBridges.join(', ')}` : ''}`],
            ['Services', hw.virtHost.units.length ? hw.virtHost.units.map((u) => `${u.unit.replace(/\.service$/, '')} (${u.sub || u.active})`).join(', ') : undefined],
          ]} />
        </div>
      </div>

      <Section title="Memory" icon={<MemoryStick size={13} />} count={hw.memory.dimms.length || undefined}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
          {bytes(hw.memory.totalBytes)} usable
          {hw.memory.slots ? ` · ${hw.memory.populated}/${hw.memory.slots} slots populated` : ''}
          {hw.memory.maxCapacity ? ` · max ${hw.memory.maxCapacity}` : ''}
          {hw.memory.ecc ? ` · ${hw.memory.ecc}` : ''}
          {hw.memory.hugepages ? ` · ${hw.memory.hugepages} hugepages × ${hw.memory.hugepageKb} kB` : ''}
          {hw.memory.edac.length ? ` · ECC errors: ${hw.memory.edac.reduce((s, m) => s + m.ce, 0)} corrected, ${hw.memory.edac.reduce((s, m) => s + m.ue, 0)} uncorrected` : ''}
          {hw.memory.noDmi || (!hw.memory.slots && hw.uid !== 0) ? ' · slot detail needs dmidecode and root' : ''}
        </div>
        {hw.memory.dimms.length > 0 && (
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>Slot</th><th>Size</th><th>Type</th><th>Speed</th><th>Manufacturer</th><th>Part number</th></tr></thead>
              <tbody>{hw.memory.dimms.map((d) => (
                <tr key={d.locator}><td style={mono}>{d.locator}</td><td>{bytes(d.sizeBytes)}</td><td>{d.type || '—'}</td><td>{d.speed || '—'}</td><td>{d.manufacturer || '—'}</td><td style={mono}>{d.part || '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Network" icon={<Network size={13} />} count={hw.nics.length}>
        <div className="table-wrapper">
          <table className="resource-table">
            <thead><tr><th>Interface</th><th>Kind</th><th>State</th><th>Speed</th><th>MTU</th><th>IPv4</th><th>Member of</th><th>Driver</th><th>Firmware</th><th>SR-IOV</th><th>MAC</th></tr></thead>
            <tbody>{[...phys, ...logical].map((n) => (
              <tr key={n.name}>
                <td style={mono}><strong>{n.name}</strong></td>
                <td>{n.kind}</td>
                <td style={{ color: n.state === 'up' ? 'var(--status-success)' : n.state === 'down' ? 'var(--status-warning)' : undefined }}>{n.state || '—'}</td>
                <td>{speed(n.speedMbps)}</td>
                <td>{n.mtu ?? '—'}</td>
                <td style={mono}>{n.ips.join(', ') || '—'}</td>
                <td>{n.master || '—'}</td>
                <td>{n.driver || '—'}</td>
                <td style={{ ...mono, fontSize: 11 }}>{n.firmware || '—'}</td>
                <td>{n.sriovTotal ? `${n.sriovNum ?? 0}/${n.sriovTotal} VFs` : '—'}</td>
                <td style={{ ...mono, fontSize: 11 }}>{n.mac || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {hw.bonds.length > 0 && (
          <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-secondary)' }}>
            {hw.bonds.map((b) => (
              <div key={b.name}><strong>{b.name}</strong> — {b.mode || 'bond'}: {b.slaves.map((s) => `${s.name} ${s.mii || '?'}`).join(', ')}</div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Storage" icon={<HardDrive size={13} />} count={hw.disks.length}>
        <div className="table-wrapper">
          <table className="resource-table">
            <thead><tr><th>Disk</th><th>Size</th><th>Media</th><th>Bus</th><th>Vendor / model</th><th>Serial</th><th>SMART</th><th>WWN</th></tr></thead>
            <tbody>{hw.disks.map((d) => (
              <tr key={d.name}>
                <td style={mono}><strong>{d.name}</strong></td>
                <td>{bytes(d.sizeBytes)}</td>
                <td>{d.rotational ? 'HDD' : 'SSD / NVMe'}</td>
                <td>{d.transport || '—'}</td>
                <td>{[d.vendor, d.model].filter(Boolean).join(' ') || '—'}</td>
                <td style={mono}>{d.serial || '—'}</td>
                <td style={{ color: d.smart === 'failed' ? 'var(--status-error)' : d.smart === 'passed' ? 'var(--status-success)' : 'var(--text-muted)', fontWeight: d.smart === 'failed' ? 650 : undefined }}>
                  {d.smart || (hw.smartMissing ? 'smartctl not installed' : '—')}
                </td>
                <td style={{ ...mono, fontSize: 11 }}>{d.wwn || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {hw.multipath.maps > 0 && <span>Multipath: {hw.multipath.maps} LUN{hw.multipath.maps === 1 ? '' : 's'}, {hw.multipath.activePaths} active path{hw.multipath.activePaths === 1 ? '' : 's'}{hw.multipath.failedPaths ? <strong style={{ color: 'var(--status-warning)' }}>, {hw.multipath.failedPaths} failed</strong> : ''}</span>}
          {hw.fc.map((f) => <span key={f.host}>Fibre Channel {f.host}: <span style={mono}>{f.wwpn || '?'}</span> · {f.state || '?'} · {f.speed || '?'}</span>)}
          {hw.iscsi.initiator && <span>iSCSI initiator: <span style={mono}>{hw.iscsi.initiator}</span>{hw.iscsi.sessions !== undefined ? ` · ${hw.iscsi.sessions} session${hw.iscsi.sessions === 1 ? '' : 's'}` : ''}</span>}
        </div>
        {hw.multipath.text.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12 }}>multipath -ll</summary>
            <pre style={pre}>{hw.multipath.text.join('\n')}</pre>
          </details>
        )}
      </Section>

      <Section title="PCI devices" icon={<Microchip size={13} />} count={hw.pci.length}>
        {hw.lspciMissing ? <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>lspci is not installed on this host (package pciutils).</p> : (
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>Address</th><th>Class</th><th>Vendor</th><th>Device</th><th>Driver</th></tr></thead>
              <tbody>{hw.pci.map((d) => (
                <tr key={d.address}>
                  <td style={mono}>{d.address}</td><td>{d.cls}</td><td>{d.vendor}</td>
                  <td>{hw.gpus.some((g) => g.address === d.address) ? <strong>{d.device}</strong> : d.device}</td>
                  <td style={{ ...mono, color: d.driver === 'vfio-pci' ? 'var(--accent-cyan)' : undefined }}>{d.driver || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      {hw.virtHost.guests.length > 0 && (
        <Section title="VMs on this host (libvirt)" icon={<Boxes size={13} />} count={hw.virtHost.guests.length}>
          <pre style={pre}>{hw.virtHost.guests.join('\n')}</pre>
        </Section>
      )}

      <Section title="All CPU flags" icon={<Cpu size={13} />} count={hw.cpu.flags.length}>
        <pre style={pre}>{hw.cpu.flags.join(' ')}</pre>
      </Section>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Inventory graphics — the same scan, drawn.
const AREA_LABEL: Record<string, string> = {
  cpu: 'CPU', memory: 'Memory', storage: 'Storage', network: 'Network', firmware: 'Firmware / BIOS',
  virtualization: 'Virtualization', licensing: 'Licensing', access: 'Access (root/sudo)', migration: 'Migration',
};
const TYPE_LEGEND = [{ label: 'Server', color: SERIES[0] }, { label: 'VM', color: SERIES[2] }];
const TOP = 15;
const verdictIcon = (v: 'ready' | 'prep' | 'blocked') => (v === 'blocked' ? <XCircle size={12} color="var(--status-error)" />
  : v === 'prep' ? <AlertTriangle size={12} color="var(--status-warning)" /> : <CheckCircle2 size={12} color="var(--status-success)" />);

const InventoryCharts: React.FC<{ hosts: HostResult[] }> = ({ hosts }) => {
  const read = hosts.filter((h) => h.hardware);
  const typeColor = (h: HostResult) => (h.hardware!.physical ? SERIES[0] : SERIES[2]);
  const typeName = (h: HostResult) => (h.hardware!.physical ? 'Server' : 'VM');
  const memRows = [...read].sort((a, b) => (b.hardware!.memory.totalBytes || 0) - (a.hardware!.memory.totalBytes || 0)).slice(0, TOP).map((h) => ({
    key: h.host, label: h.host, valueText: bytes(h.hardware!.memory.totalBytes),
    segs: [{ label: `${typeName(h)} memory`, value: (h.hardware!.memory.totalBytes || 0) / 1024 ** 3, color: typeColor(h), text: bytes(h.hardware!.memory.totalBytes) }],
  }));
  const cpuRows = [...read].sort((a, b) => (b.hardware!.cpu.logical || 0) - (a.hardware!.cpu.logical || 0)).slice(0, TOP).map((h) => ({
    key: h.host, label: h.host, valueText: `${h.hardware!.cpu.logical ?? '?'}`,
    sub: h.hardware!.cpu.sockets ? `${h.hardware!.cpu.sockets} socket${h.hardware!.cpu.sockets === 1 ? '' : 's'} × ${h.hardware!.cpu.coresPerSocket ?? '?'} cores` : undefined,
    segs: [{ label: `${typeName(h)} CPU threads`, value: h.hardware!.cpu.logical || 0, color: typeColor(h), text: String(h.hardware!.cpu.logical ?? '?') }],
  }));

  const areas = new Map<string, { critical: number; warning: number }>();
  for (const h of hosts) for (const c of h.checks) {
    if (c.status !== 'critical' && c.status !== 'warning') continue;
    const a = areas.get(c.area) || { critical: 0, warning: 0 };
    a[c.status]++;
    areas.set(c.area, a);
  }
  const areaRows = [...areas.entries()].sort((a, b) => (b[1].critical - a[1].critical) || (b[1].warning - a[1].warning)).map(([area, v]) => ({
    key: area, label: AREA_LABEL[area] || area,
    icon: v.critical ? <XCircle size={12} color="var(--status-error)" /> : <AlertTriangle size={12} color="var(--status-warning)" />,
    valueText: `${v.critical + v.warning}`,
    segs: [
      { label: 'Critical', value: v.critical, color: 'var(--status-error)' },
      { label: 'Warning', value: v.warning, color: 'var(--status-warning)' },
    ],
  }));

  const models = new Map<string, { server: number; vm: number }>();
  for (const h of read) {
    const m = (h.hardware!.cpu.model || 'unknown').replace(/\(R\)|\(TM\)|CPU |Processor/g, '').replace(/\s+/g, ' ').trim();
    const v = models.get(m) || { server: 0, vm: 0 };
    if (h.hardware!.physical) v.server++; else v.vm++;
    models.set(m, v);
  }
  const modelRows = [...models.entries()].sort((a, b) => (b[1].server + b[1].vm) - (a[1].server + a[1].vm)).slice(0, 10).map(([m, v]) => ({
    key: m, label: m, valueText: `${v.server + v.vm}`,
    segs: [{ label: 'Servers', value: v.server, color: SERIES[0] }, { label: 'VMs', value: v.vm, color: SERIES[2] }],
  }));

  const more = read.length > TOP ? `top ${TOP} of ${read.length}` : undefined;
  return (
    <ChartGrid>
      <ChartCard icon={<MemoryStick size={14} />} title="Memory per host" note={more} legend={TYPE_LEGEND}><BarList rows={memRows} /></ChartCard>
      <ChartCard icon={<Cpu size={14} />} title="CPU threads per host" note={more} legend={TYPE_LEGEND}><BarList rows={cpuRows} /></ChartCard>
      <ChartCard icon={<AlertTriangle size={14} />} title="Problems by area" note="critical + warning findings, all hosts"
        legend={areaRows.length ? [{ label: 'Critical', color: 'var(--status-error)', icon: <XCircle size={12} color="var(--status-error)" /> },
          { label: 'Warning', color: 'var(--status-warning)', icon: <AlertTriangle size={12} color="var(--status-warning)" /> }] : undefined}>
        {areaRows.length ? <BarList rows={areaRows} />
          : <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-success)', display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle2 size={14} /> No critical or warning findings.</p>}
      </ChartCard>
      <ChartCard icon={<Microchip size={14} />} title="CPU models in the fleet" note="mixed models need a common CPU baseline to live-migrate" legend={TYPE_LEGEND}>
        <BarList rows={modelRows} labelWidth="minmax(120px, 45%)" />
      </ChartCard>
    </ChartGrid>
  );
};

const READY_LEGEND = [
  { label: 'Blocked', color: 'var(--status-error)', icon: <XCircle size={12} color="var(--status-error)" /> },
  { label: 'Needs a fix', color: 'var(--status-warning)', icon: <AlertTriangle size={12} color="var(--status-warning)" /> },
  { label: 'Could not check', color: 'var(--text-muted)', icon: <HelpCircle size={12} color="var(--text-muted)" /> },
];

const ReadinessCharts: React.FC<{ vms: HostResult[] }> = ({ vms }) => {
  const count = (v: Readiness['verdict']) => vms.filter((h) => h.readiness!.verdict === v).length;
  const checkRows = READY_COLUMNS.map(([id, label]) => {
    const st = vms.map((h) => h.readiness!.items.find((i) => i.id === id)?.status);
    const fail = st.filter((x) => x === 'fail').length, warn = st.filter((x) => x === 'warn').length, unk = st.filter((x) => x === 'unknown').length;
    const full = vms.map((h) => h.readiness!.items.find((i) => i.id === id)?.label).find(Boolean) || label;
    return {
      key: id, label: full, valueText: `${fail + warn + unk} VM${fail + warn + unk === 1 ? '' : 's'}`,
      icon: fail ? verdictIcon('blocked') : warn ? verdictIcon('prep') : unk ? <HelpCircle size={12} color="var(--text-muted)" /> : verdictIcon('ready'),
      segs: [
        { label: 'Blocked', value: fail, color: 'var(--status-error)' },
        { label: 'Needs a fix', value: warn, color: 'var(--status-warning)' },
        { label: 'Could not check', value: unk, color: 'var(--text-muted)' },
      ],
    };
  }).sort((a, b) => b.segs[0].value - a.segs[0].value || b.segs[1].value - a.segs[1].value || b.segs[2].value - a.segs[2].value);
  const data = vms.filter((h) => h.readiness!.dataBytes).sort((a, b) => (b.readiness!.dataBytes || 0) - (a.readiness!.dataBytes || 0));
  const dataRows = data.slice(0, TOP).map((h) => ({
    key: h.host, label: h.host, valueText: bytes(h.readiness!.dataBytes), icon: verdictIcon(h.readiness!.verdict),
    segs: [{ label: `Data to copy · ${VERDICT[h.readiness!.verdict].label.toLowerCase()}`, value: h.readiness!.dataBytes! / 1024 ** 3, color: SERIES[0], text: bytes(h.readiness!.dataBytes) }],
  }));
  return (
    <ChartGrid>
      <ChartCard icon={<ListChecks size={14} />} title="Where the VMs stand" note={`${vms.length} VM${vms.length === 1 ? '' : 's'}`}>
        <PartBar items={[
          { key: 'ready', label: 'Ready', value: count('ready'), color: 'var(--status-success)', icon: <CheckCircle2 size={13} color="var(--status-success)" />, detail: 'VMs' },
          { key: 'prep', label: 'Needs prep', value: count('prep'), color: 'var(--status-warning)', icon: <AlertTriangle size={13} color="var(--status-warning)" />, detail: 'VMs' },
          { key: 'blocked', label: 'Blocked', value: count('blocked'), color: 'var(--status-error)', icon: <XCircle size={13} color="var(--status-error)" />, detail: 'VMs' },
        ]} />
        <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
          Blocked = would not boot or reach the network after conversion. Needs prep = warnings, or something Trinetra could not read.
        </p>
      </ChartCard>
      <ChartCard icon={<AlertTriangle size={14} />} title="What to fix first" note="VMs failing each check" legend={READY_LEGEND}>
        <BarList rows={checkRows} max={vms.length} labelWidth="minmax(120px, 42%)" />
      </ChartCard>
      <ChartCard icon={<ArrowRightLeft size={14} />} title="Data to copy per VM" note={data.length > TOP ? `top ${TOP} of ${data.length} · plan waves by size` : 'used space · plan waves by size'}>
        <BarList rows={dataRows} empty="No data sizes read yet." />
      </ChartCard>
    </ChartGrid>
  );
};

// ---------------------------------------------------------------------------
// VME readiness — per VM, will it boot and reach the network after conversion?
// ---------------------------------------------------------------------------

const READY_COLOR: Record<ReadyStatus, string> = {
  pass: 'var(--status-success)', warn: 'var(--status-warning)', fail: 'var(--status-error)', unknown: 'var(--text-muted)', info: 'var(--accent-cyan)',
};
const ReadyIcon: React.FC<{ s: ReadyStatus; size?: number }> = ({ s, size = 15 }) => {
  const Icon = s === 'pass' ? CheckCircle2 : s === 'warn' ? AlertTriangle : s === 'fail' ? XCircle : s === 'info' ? Info : HelpCircle;
  return <Icon size={size} color={READY_COLOR[s]} />;
};
const VERDICT: Record<Readiness['verdict'], { label: string; badge: string; order: number }> = {
  blocked: { label: 'Blocked', badge: 'error', order: 0 },
  prep: { label: 'Needs prep', badge: 'warning', order: 1 },
  ready: { label: 'Ready', badge: 'running', order: 2 },
};
/** Matrix columns, in the order a migration would trip over them. */
const READY_COLUMNS: Array<[string, string]> = [
  ['virtio', 'virtio'], ['disks', 'Disks'], ['network', 'Network'], ['firmware', 'Firmware'],
  ['time', 'Time'], ['agent', 'Agent'], ['vmtools', 'Tools'], ['passthrough', 'GPU'],
];

const ReadinessView: React.FC<{ hosts: HostResult[]; summary: ReadySummary | null; showInfo: boolean; charts: boolean }> = ({ hosts, summary, showInfo, charts }) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const vms = hosts
    .filter((h) => h.readiness)
    .sort((a, b) => VERDICT[a.readiness!.verdict].order - VERDICT[b.readiness!.verdict].order || a.host.localeCompare(b.host));
  const servers = hosts.filter((h) => h.hardware?.physical).length;
  const unreachable = hosts.filter((h) => !h.reachable).length;

  return (
    <>
      {summary && summary.vms > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Tile icon={<ListChecks size={13} />} label="VMs assessed" value={`${summary.vms}`} sub={`${servers} server${servers === 1 ? '' : 's'} not assessed (not migrated)`} />
          <Tile icon={<CheckCircle2 size={13} />} label="Ready" value={`${summary.ready}`} color={summary.ready ? 'var(--status-success)' : undefined} />
          <Tile icon={<AlertTriangle size={13} />} label="Needs prep" value={`${summary.prep}`} color={summary.prep ? 'var(--status-warning)' : undefined} sub="warnings or not yet checkable" />
          <Tile icon={<XCircle size={13} />} label="Blocked" value={`${summary.blocked}`} color={summary.blocked ? 'var(--status-error)' : undefined} sub="would not boot or reach the network" />
          <Tile icon={<ArrowRightLeft size={13} />} label="Data to copy" value={bytes(summary.dataBytes)} sub="used space on local filesystems" />
        </div>
      )}

      {charts && vms.length > 0 && <ReadinessCharts vms={vms} />}

      <div className="panel-card">
        <div className="panel-card-title">
          <h2><ListChecks size={18} /> VMware → VME readiness, per VM</h2>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>click a VM for the checklist and fix commands</span>
        </div>
        <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Read from inside each Linux VM: virtio drivers in the boot image, disks found by UUID rather than device name, network config that survives
          the NIC rename (ens192 → enp1s0) and the MAC change, firmware type, guest agent and time source. Fix commands are shown, never run.
          Windows VMs, snapshots, RDMs and independent disks are only visible from vCenter / the VME Manager.
        </p>
        {!vms.length ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            {hosts.length ? `No VMs among the hosts read${unreachable ? ` (${unreachable} unreachable)` : ''}. Add the VMware VMs you plan to move on the K8s Nodes tab.` : 'No hosts read yet.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table className="resource-table">
              <thead>
                <tr>
                  <th></th><th>VM</th><th>Verdict</th>
                  {READY_COLUMNS.map(([, label]) => <th key={label} style={{ textAlign: 'center', padding: '8px 6px' }}>{label}</th>)}
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {vms.map((h) => {
                  const r = h.readiness!;
                  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
                  const isOpen = !!open[h.host];
                  const items = r.items.filter((i) => showInfo || (i.status !== 'pass' && i.status !== 'info'));
                  return (
                    <React.Fragment key={h.host}>
                      <tr onClick={() => setOpen((o) => ({ ...o, [h.host]: !o[h.host] }))} style={{ cursor: 'pointer', borderLeft: `3px solid ${r.verdict === 'blocked' ? 'var(--status-error)' : r.verdict === 'prep' ? 'var(--status-warning)' : 'var(--status-success)'}` }}>
                        <td>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td style={{ whiteSpace: 'normal', minWidth: 180 }}>
                          <strong>{h.host}</strong>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.hardware?.os || kindOf(h.hardware!)}</div>
                        </td>
                        <td><span className={`badge ${VERDICT[r.verdict].badge}`} style={{ whiteSpace: 'nowrap' }}>{VERDICT[r.verdict].label}</span></td>
                        {READY_COLUMNS.map(([id]) => {
                          const it = byId[id];
                          return (
                            <td key={id} style={{ textAlign: 'center', padding: '8px 6px' }} title={it ? `${it.label}: ${it.detail}` : 'not applicable'}>
                              {it ? <ReadyIcon s={it.status} /> : <span style={{ color: 'var(--text-muted)' }}>·</span>}
                            </td>
                          );
                        })}
                        <td style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.dataBytes !== undefined ? bytes(r.dataBytes) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={READY_COLUMNS.length + 4} style={{ background: 'var(--bg-secondary)', whiteSpace: 'normal' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 4px 8px' }}>
                              {items.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--status-success)' }}>Nothing to do before migrating.</span>}
                              {items.map((i) => (
                                <div key={i.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 6, background: i.status === 'fail' || i.status === 'warn' ? 'var(--bg-tertiary)' : undefined }}>
                                  <div style={{ marginTop: 2 }}><ReadyIcon s={i.status} size={14} /></div>
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontSize: 13, color: 'var(--text-heading)', fontWeight: i.status === 'fail' || i.status === 'warn' ? 650 : 500 }}>{i.label}</div>
                                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{i.detail}</div>
                                    {i.fix && <div style={{ ...mono, fontSize: 11, color: 'var(--accent-cyan)', marginTop: 3, wordBreak: 'break-all' }}>$ {i.fix}</div>}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};

export type HardwareView = 'inventory' | 'readiness' | 'capacity';
interface Props { source: string; vmNames: string[]; view?: HardwareView; onViewChange?: (v: HardwareView) => void }

export const HardwareInventory: React.FC<Props> = ({ source, vmNames, view: viewProp, onViewChange }) => {
  // Controlled by the sidebar (Hardware / VME Readiness) when App passes it; local otherwise.
  const [localView, setLocalView] = useState<HardwareView>('inventory');
  const view = viewProp ?? localView;
  const setView = (v: HardwareView) => { setLocalView(v); onViewChange?.(v); };
  const [readiness, setReadiness] = useState<ReadySummary | null>(null);
  const [hosts, setHosts] = useState<HostResult[]>([]);
  const [drift, setDrift] = useState<Drift[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [at, setAt] = useState('');
  const [showInfo, setShowInfo] = useState(true);
  const [filter, setFilter] = useState<'all' | 'physical' | 'virtual'>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [charts, setCharts] = useCharts();

  // A single VM source reads that host; "this machine" and "all hosts" read the
  // whole inventory, because the hardware worth knowing about is on the nodes.
  const scope = source !== 'local' && source !== 'all' && vmNames.includes(source) ? source : '';

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (scope) params.set('vm', scope);
      if (fresh) params.set('fresh', '1');
      const d = await fetch(`/api/hardware?${params}`, { cache: 'no-store' }).then((r) => r.json());
      if (d.error) { setError(d.error); return; }
      setHosts(d.hosts || []);
      setDrift(d.drift || []);
      setTotals(d.totals || null);
      setReadiness(d.readiness || null);
      setNote(d.note || '');
      setAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  const shown = hosts.filter((h) => filter === 'all' || !h.hardware || h.hardware.physical === (filter === 'physical'));
  const counts = useMemo(() => {
    const all = hosts.flatMap((h) => h.checks);
    return { critical: all.filter((c) => c.status === 'critical').length, warning: all.filter((c) => c.status === 'warning').length };
  }, [hosts]);
  const driftHosts = useMemo(() => Array.from(new Set(drift.flatMap((d) => Object.keys(d.values)))).sort(), [drift]);

  const exportCsv = () => {
    if (view === 'readiness') {
      const rr: Array<Array<string | number | undefined>> = [['VM', 'OS', 'Verdict', 'Check', 'Status', 'Detail', 'Fix']];
      for (const h of hosts) for (const i of h.readiness?.items || []) rr.push([h.host, h.hardware?.os, h.readiness!.verdict, i.label, i.status, i.detail, i.fix]);
      downloadText(toCsv(rr), `trinetra-vme-readiness-${scope || 'all'}-${stamp()}.csv`, 'text/csv');
      return;
    }
    const rows: Array<Array<string | number | undefined>> = [[
      'Host', 'Type', 'Vendor', 'Model', 'Serial', 'BIOS', 'BMC firmware', 'BMC IP', 'OS', 'Kernel',
      'CPU model', 'Sockets', 'Cores', 'Threads', 'NUMA', 'Memory GiB', 'DIMMs', 'Slots', 'NICs', 'Fastest NIC Gb/s', 'Disks', 'Raw disk GiB',
      'GPUs', 'KVM', 'IOMMU groups', 'libvirt guests', 'Critical', 'Warnings',
    ]];
    for (const h of hosts) {
      const hw = h.hardware;
      if (!hw) { rows.push([h.host, h.reachable ? '' : `unreachable: ${h.error || ''}`]); continue; }
      const fastest = Math.max(0, ...hw.nics.filter((n) => n.kind === 'physical').map((n) => n.speedMbps || 0));
      rows.push([
        h.host, hw.physical ? 'bare metal' : (hw.virt || 'vm'), hw.system.vendor, hw.system.product, hw.system.serial, hw.system.biosVersion, hw.bmc.firmware, hw.bmc.ip, hw.os, hw.kernel,
        hw.cpu.model, hw.cpu.sockets, hw.cpu.cores, hw.cpu.logical, hw.cpu.numaNodes,
        hw.memory.totalBytes ? Math.round(hw.memory.totalBytes / 1024 ** 3) : undefined, hw.memory.populated, hw.memory.slots,
        hw.nics.filter((n) => n.kind === 'physical').length, fastest ? fastest / 1000 : undefined,
        hw.disks.length, Math.round(hw.disks.reduce((s, d) => s + d.sizeBytes, 0) / 1024 ** 3),
        hw.gpus.length, hw.virtHost.kvm ? 'yes' : 'no', hw.virtHost.iommuGroups, hw.virtHost.guests.length,
        h.checks.filter((c) => c.status === 'critical').length, h.checks.filter((c) => c.status === 'warning').length,
      ]);
    }
    downloadText(toCsv(rows), `trinetra-hardware-${scope || 'all'}-${stamp()}.csv`, 'text/csv');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Cpu size={18} /> Hardware inventory &amp; VME readiness</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="subnav-pill" style={{ display: 'flex', gap: 4 }}>
              {(['inventory', 'readiness', 'capacity'] as const).map((v) => (
                <button key={v} className={`subnav-pill-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)} style={{ fontSize: 12 }}>
                  {v === 'inventory' ? 'Inventory' : v === 'readiness' ? `VME readiness${readiness?.blocked ? ` (${readiness.blocked} blocked)` : ''}` : 'VME capacity'}
                </button>
              ))}
            </div>
            {view === 'inventory' && <div className="subnav-pill" style={{ display: 'flex', gap: 4 }}>
              {(['all', 'physical', 'virtual'] as const).map((f) => (
                <button key={f} className={`subnav-pill-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)} style={{ fontSize: 12 }}>
                  {f === 'all' ? 'All' : f === 'physical' ? 'Servers' : 'VMs'}
                </button>
              ))}
            </div>}
            {view !== 'capacity' && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} /> {view === 'readiness' ? 'Show passed' : 'Show notes'}
            </label>}
            {view !== 'capacity' && <ChartsToggle on={charts} onChange={setCharts} />}
            {view !== 'capacity' && <button className="btn secondary" onClick={exportCsv} disabled={!hosts.length} style={{ padding: '6px 12px', fontSize: 12 }}><Download size={13} /> CSV</button>}
            <button className="btn primary" onClick={() => void load(true)} disabled={loading} style={{ padding: '6px 12px', fontSize: 12 }}>
              <RefreshCw size={13} className={loading ? 'loader' : ''} /> {loading ? 'Reading hosts…' : 'Re-scan'}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>{scope ? `Host: ${scope}` : `All ${vmNames.length} inventory host${vmNames.length === 1 ? '' : 's'}`}</span>
          {at && <span>updated {at}</span>}
          <span>Read-only over SSH (lscpu, dmidecode, lsblk, lspci, ethtool -i, smartctl -H, multipath -ll, virsh -r; in VMs also lsinitrd, /etc/fstab devices, network config names). Cached 30 min — Re-scan reads again.</span>
        </div>
        {error && <div style={{ color: 'var(--status-error)', fontSize: 12.5, marginTop: 8 }}><AlertTriangle size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
        {note && <div style={{ color: 'var(--text-secondary)', fontSize: 12.5, marginTop: 8 }}>{note}</div>}
      </div>

      {view === 'readiness' && <ReadinessView hosts={hosts} summary={readiness} showInfo={showInfo} charts={charts} />}
      {/* Reads the same scan (server-side cache); re-plans whenever a scan lands. */}
      {view === 'capacity' && <CapacityPlan scanAt={at} />}

      {view === 'inventory' && totals && totals.hosts > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Tile icon={<Server size={13} />} label="Hosts read" value={`${totals.hosts}`} sub={`${totals.physical} server${totals.physical === 1 ? '' : 's'} · ${totals.virtual} VM${totals.virtual === 1 ? '' : 's'}`} />
          <Tile icon={<Scale size={13} />} label="CPU sockets (servers)" value={totals.physical ? `${totals.sockets}` : '—'} sub="VME is licensed per socket" title="Physical sockets on bare-metal hosts only; a VM's vSockets are not licence sockets." />
          <Tile icon={<Cpu size={13} />} label="Cores / threads" value={`${totals.cores} / ${totals.threads}`} sub="all hosts read" />
          <Tile icon={<MemoryStick size={13} />} label="Memory" value={bytes(totals.memoryBytes)} sub="all hosts read" />
          <Tile icon={<HardDrive size={13} />} label="Raw disk" value={bytes(totals.diskBytes)} sub="local + SAN LUNs seen" />
          <Tile icon={<Microchip size={13} />} label="GPUs" value={`${totals.gpus}`} sub={totals.guests ? `${totals.guests} libvirt guests on these hosts` : undefined} />
          <Tile icon={<AlertTriangle size={13} />} label="Problems" value={`${counts.critical} / ${counts.warning + drift.length}`}
            sub={`critical / warning${drift.length ? ` (${drift.length} drift)` : ''}`}
            color={counts.critical ? 'var(--status-error)' : counts.warning + drift.length ? 'var(--status-warning)' : undefined} />
        </div>
      )}

      {view === 'inventory' && charts && hosts.some((h) => h.hardware) && <InventoryCharts hosts={shown} />}

      {view === 'inventory' && drift.length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title"><h2><GitCompare size={18} /> Where hosts that should match don't</h2></div>
          <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Servers are compared with servers and VMs with VMs; firmware only within the same server model. CPU differences decide whether VMs
            can live-migrate between hosts in one VME cluster; firmware differences explain "it only fails on that one host".
          </p>
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>What</th>{driftHosts.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {drift.map((d, i) => (
                  <tr key={i}>
                    <td title={d.why}>
                      <strong>{d.what}</strong> <span className="badge neutral" style={{ textTransform: 'none', fontSize: 10 }}>{d.group === 'physical' ? 'servers' : 'VMs'}</span>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, maxWidth: 320 }}>{d.why}</div>
                    </td>
                    {driftHosts.map((h) => <td key={h} style={{ ...mono, wordBreak: 'break-word' }}>{d.values[h] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'inventory' && hosts.length === 0 && !loading && !error && !note && (
        <div className="panel-card"><p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>No hosts read yet.</p></div>
      )}
      {loading && hosts.length === 0 && (
        <div className="panel-card"><p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>Reading hardware over SSH — the first scan takes up to a minute per host (disk health checks are the slow part).</p></div>
      )}

      {view === 'inventory' && shown.length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title"><h2><Server size={18} /> Fleet</h2><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>click a row for the full inventory</span></div>
          <div className="table-wrapper">
            <table className="resource-table">
              <thead>
                <tr><th></th><th>Host</th><th>Type</th><th>CPU</th><th>Sockets × cores</th><th>Memory</th><th>NICs</th><th>Disks</th><th>GPUs</th><th>BIOS / iLO</th><th>Findings</th></tr>
              </thead>
              <tbody>
                {shown.map((h) => {
                  const hw = h.hardware;
                  const worst = worstOf(h.checks);
                  const isOpen = !!open[h.host];
                  const physNics = hw?.nics.filter((n) => n.kind === 'physical') || [];
                  const fastest = Math.max(0, ...physNics.map((n) => n.speedMbps || 0));
                  const crit = h.checks.filter((c) => c.status === 'critical').length;
                  const warn = h.checks.filter((c) => c.status === 'warning').length;
                  return (
                    <React.Fragment key={h.host}>
                      <tr onClick={() => hw && setOpen((o) => ({ ...o, [h.host]: !o[h.host] }))} style={{ cursor: hw ? 'pointer' : undefined, borderLeft: `3px solid ${h.reachable ? STATUS_COLOR[worst] : 'var(--status-error)'}` }}>
                        <td>{hw ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</td>
                        <td><strong>{h.host}</strong>{hw?.host && hw.host !== h.host ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hw.host}</div> : null}</td>
                        {!h.reachable || !hw ? (
                          <td colSpan={9} style={{ color: 'var(--status-error)', fontSize: 12 }}>{h.error || 'unreachable'}</td>
                        ) : (
                          <>
                            <td>
                              <span className={`badge ${hw.physical ? 'running' : 'neutral'}`} style={{ textTransform: 'none' }}>{hw.physical ? 'server' : 'VM'}</span>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{kindOf(hw)}</div>
                            </td>
                            <td style={{ fontSize: 12 }}>{hw.cpu.model || '—'}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{hw.cpu.sockets ? `${hw.cpu.sockets} × ${hw.cpu.coresPerSocket ?? '?'}` : '—'}<div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hw.cpu.logical ?? '?'} threads</div></td>
                            <td>{bytes(hw.memory.totalBytes)}{hw.memory.slots ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hw.memory.populated}/{hw.memory.slots} slots</div> : null}</td>
                            <td>{physNics.length}{fastest ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>up to {speed(fastest)}</div> : null}</td>
                            <td>{hw.disks.length}<div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{bytes(hw.disks.reduce((s, d) => s + d.sizeBytes, 0))}</div></td>
                            <td>{hw.gpus.length || '—'}</td>
                            {/* A VM's "BIOS" is the hypervisor's virtual firmware string — noise here. */}
                            <td style={{ fontSize: 11.5, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={hw.system.biosVersion}>
                              {hw.physical ? (hw.system.biosVersion || '—') : '—'}{hw.bmc.firmware ? <div style={{ color: 'var(--text-muted)' }}>iLO {hw.bmc.firmware}</div> : null}
                            </td>
                            <td>
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
                                {crit > 0 && <span className="badge error" style={{ whiteSpace: 'nowrap' }}>{crit} critical</span>}
                                {warn > 0 && <span className="badge warning" style={{ whiteSpace: 'nowrap' }}>{warn} warning</span>}
                                {!crit && !warn && <CheckCircle2 size={14} color="var(--status-success)" />}
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                      {isOpen && hw && (
                        <tr><td colSpan={11} style={{ background: 'var(--bg-secondary)', whiteSpace: 'normal' }}><HostDetail r={h} showInfo={showInfo} /></td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default HardwareInventory;
