// What each host physically IS — the inventory a VMware → HPE VME (Morpheus)
// migration is planned on.
//
// The metrics probe knows how busy a machine is; this knows what it is made of,
// and that is what the questions before a migration are about:
//
//   * how many CPU sockets (VME is licensed per socket)
//   * can these hosts live-migrate VMs between each other (same CPU model and
//     feature flags, or the cluster has to fall back to a common baseline)
//   * is hardware virtualization on, is IOMMU on (GPU passthrough), is KVM there
//   * which NICs, at what speed, on which firmware; bonds with a dead leg
//   * which disks, healthy or not; multipath paths up; FC/iSCSI identities
//   * memory slots, ECC errors, BIOS and BMC (iLO) firmware — and where they
//     differ between hosts that should be identical
//
// Read-only and allow-listed like every other probe: a fixed script, sections
// marked with ===TRINETRA:TAG===, `|| true` semantics per block, and anything
// missing on the host (no dmidecode, no root, no lspci) just leaves a field empty.
// Pure parsing and judging live here and are covered by
// server/__tests__/hardware.test.ts; the router at the bottom does the SSH.

import { Router } from 'express';
import { loadVms, sshRun, type VmEntry } from '../vms.js';
import { splitMarked, mark } from '../hostlogs/router.js';
import { SAFE_NAME } from '../k8s/kubectl.js';

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------
// Written as template literals: `$(...)` and `$x` pass through untouched; the
// shell's `${...}` form is deliberately never used.

const PCI_CLASSES = 'VGA|3D controller|Display controller|Ethernet|Network controller|Fibre Channel|RAID|Serial Attached SCSI|SATA|Non-Volatile|InfiniBand|Processing accelerators';
const UNITS = `'morpheus*' 'libvirtd*' 'virtqemud*' 'openvswitch*' 'ovs-vswitchd*' 'pacemaker*' 'corosync*' 'multipathd*' 'iscsid*'`;

export const HARDWARE_CMD = [
  mark('SELF'),
  `echo "HOST=$(hostname)"; echo "UID=$(id -u)"; echo "NOW=$(date +%s)"; ` +
    `echo "OS=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"; echo "KERNEL=$(uname -r)"; echo "ARCH=$(uname -m)"; ` +
    `echo "VIRT=$(systemd-detect-virt 2>/dev/null)"`,

  mark('CPU'),
  `LC_ALL=C lscpu 2>/dev/null | head -n 80; ` +
    `echo "PROCMODEL=$(grep -m1 -E '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)"; ` +
    `echo "PROCFLAGS=$(grep -m1 -E '^(flags|Features)' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)"; ` +
    `echo "PROCCOUNT=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"; ` +
    `echo "PROCSOCKETS=$(grep '^physical id' /proc/cpuinfo 2>/dev/null | sort -u | wc -l)"`,

  mark('MEM'),
  `grep -E '^(MemTotal|SwapTotal|HugePages_Total|Hugepagesize):' /proc/meminfo 2>/dev/null`,

  mark('DIMM'),
  `if command -v dmidecode >/dev/null 2>&1; then dmidecode -t memory 2>/dev/null | ` +
    `grep -E '^(Physical Memory Array|Memory Device)|^[[:space:]]+(Size|Locator|Type|Speed|Configured Memory Speed|Configured Clock Speed|Manufacturer|Part Number|Maximum Capacity|Number Of Devices|Error Correction Type):' | head -n 2000; ` +
    `else echo "NODMIDECODE=1"; fi`,

  mark('EDAC'),
  `for d in /sys/devices/system/edac/mc/mc[0-9]*; do [ -d "$d" ] && echo "MC=$(basename "$d") $(cat "$d/ce_count" 2>/dev/null) $(cat "$d/ue_count" 2>/dev/null)"; done`,

  mark('DMI'),
  `for f in sys_vendor product_name product_version product_serial product_uuid bios_vendor bios_version bios_date board_vendor board_name chassis_type; do ` +
    `[ -r "/sys/class/dmi/id/$f" ] && echo "$f=$(cat "/sys/class/dmi/id/$f" 2>/dev/null)"; done`,

  mark('NIC'),
  `for i in /sys/class/net/*; do n=$(basename "$i"); [ "$n" = lo ] && continue; k=""; ` +
    `[ -e "$i/device" ] && k=physical; [ -d "$i/bonding" ] && k=bond; [ -d "$i/bridge" ] && k=bridge; [ -e "/proc/net/vlan/$n" ] && k=vlan; ` +
    `[ -z "$k" ] && continue; echo "NIC=$n"; echo "KIND=$k"; echo "MAC=$(cat "$i/address" 2>/dev/null)"; ` +
    `echo "STATE=$(cat "$i/operstate" 2>/dev/null)"; echo "SPEED=$(cat "$i/speed" 2>/dev/null)"; echo "MTU=$(cat "$i/mtu" 2>/dev/null)"; ` +
    `echo "IP=$(ip -o -4 addr show dev "$n" 2>/dev/null | awk '{print $4}' | tr '\\n' ' ')"; ` +
    `[ -L "$i/master" ] && echo "MASTER=$(basename "$(readlink -f "$i/master")")"; ` +
    `if [ "$k" = physical ]; then echo "PCI=$(basename "$(readlink -f "$i/device")")"; ` +
    `[ -e "$i/device/driver" ] && echo "DRIVER=$(basename "$(readlink -f "$i/device/driver")")"; ` +
    `echo "VFTOTAL=$(cat "$i/device/sriov_totalvfs" 2>/dev/null)"; echo "VFNUM=$(cat "$i/device/sriov_numvfs" 2>/dev/null)"; ` +
    `command -v ethtool >/dev/null 2>&1 && ethtool -i "$n" 2>/dev/null | sed -n 's/^firmware-version: */FIRMWARE=/p'; fi; done | head -n 1500`,

  mark('BOND'),
  `for f in /proc/net/bonding/*; do [ -f "$f" ] || continue; echo "BOND=$(basename "$f")"; grep -E '^(Bonding Mode|Slave Interface|MII Status|Speed):' "$f"; done`,

  mark('DISK'),
  `lsblk -d -b -P -o NAME,TYPE,SIZE,ROTA,MODEL,SERIAL,TRAN,VENDOR,WWN 2>/dev/null || lsblk -d -b -P -o NAME,TYPE,SIZE,ROTA,MODEL 2>/dev/null`,

  mark('SMART'),
  `if command -v smartctl >/dev/null 2>&1; then for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}' | head -n 24); do ` +
    `echo "DISK=$d"; timeout 6 smartctl -H "/dev/$d" 2>/dev/null | grep -iE 'overall-health|health status|SMART support is|Unavailable'; done; ` +
    `else echo "NOSMARTCTL=1"; fi`,

  mark('MPATH'),
  `command -v multipath >/dev/null 2>&1 && timeout 10 multipath -ll 2>/dev/null | head -n 300`,

  mark('SAN'),
  `for h in /sys/class/fc_host/host*; do [ -d "$h" ] || continue; ` +
    `echo "FC=$(basename "$h") $(cat "$h/port_name" 2>/dev/null) $(cat "$h/port_state" 2>/dev/null) $(cat "$h/speed" 2>/dev/null | tr ' ' '_')"; done; ` +
    `[ -r /etc/iscsi/initiatorname.iscsi ] && grep -m1 '^InitiatorName=' /etc/iscsi/initiatorname.iscsi; ` +
    `command -v iscsiadm >/dev/null 2>&1 && echo "ISCSISESSIONS=$(iscsiadm -m session 2>/dev/null | grep -c .)"`,

  mark('PCI'),
  `if command -v lspci >/dev/null 2>&1; then lspci -Dmm -nn 2>/dev/null | grep -iE '${PCI_CLASSES}' | head -n 128 | while read -r a rest; do ` +
    `d=""; [ -e "/sys/bus/pci/devices/$a/driver" ] && d=$(basename "$(readlink -f "/sys/bus/pci/devices/$a/driver")"); echo "DEV=$a|$d|$rest"; done; ` +
    `else echo "NOLSPCI=1"; fi`,

  mark('VIRTHOST'),
  `[ -e /dev/kvm ] && echo "KVM=yes"; ` +
    `for m in kvm_intel kvm_amd; do [ -r "/sys/module/$m/parameters/nested" ] && echo "NESTED=$(cat "/sys/module/$m/parameters/nested")"; done; ` +
    `echo "IOMMUGROUPS=$(ls /sys/kernel/iommu_groups 2>/dev/null | wc -l)"; ` +
    `echo "CMDLINE=$(tr ' ' '\\n' < /proc/cmdline 2>/dev/null | grep -E '^(intel_iommu|amd_iommu|iommu|hugepages|hugepagesz|default_hugepagesz|isolcpus|vfio-pci\\.ids)=' | tr '\\n' ' ')"; ` +
    `[ -d /sys/module/vfio_pci ] && echo "VFIO=yes"; ` +
    `command -v virsh >/dev/null 2>&1 && { echo "LIBVIRT=$(virsh --version 2>/dev/null)"; timeout 10 virsh -r list --all --name 2>/dev/null | grep -v '^$' | head -n 300 | sed 's/^/VM=/'; }; ` +
    `command -v ovs-vsctl >/dev/null 2>&1 && { echo "OVS=$(ovs-vsctl --version 2>/dev/null | head -n 1)"; timeout 5 ovs-vsctl list-br 2>/dev/null | head -n 50 | sed 's/^/OVSBR=/'; }; ` +
    `systemctl list-units --all --no-legend --plain ${UNITS} 2>/dev/null | head -n 40 | sed 's/^/UNIT=/'`,

  mark('BMC'),
  `if [ -e /dev/ipmi0 ] || [ -e /dev/ipmi/0 ] || [ -e /dev/ipmidev/0 ]; then command -v ipmitool >/dev/null 2>&1 && { ` +
    `timeout 8 ipmitool mc info 2>/dev/null | grep -E '^(Firmware Revision|Manufacturer Name)'; ` +
    `timeout 8 ipmitool lan print 2>/dev/null | grep -E '^(IP Address|MAC Address)[[:space:]]*:'; }; fi`,

  // ── Guest side: will this VM still boot and reach the network on KVM? ──────
  mark('BOOT'),
  `[ -d /sys/firmware/efi ] && echo "EFI=yes" || echo "EFI=no"; ` +
    `sb=$(ls /sys/firmware/efi/efivars/SecureBoot-* 2>/dev/null | head -n 1); [ -n "$sb" ] && echo "SECUREBOOT=$(od -An -t u1 "$sb" 2>/dev/null | awk '{print $NF}')"; ` +
    `tr ' ' '\\n' < /proc/cmdline 2>/dev/null | grep -E '^(root|resume|net\\.ifnames|biosdevname)=' | sed 's/^/ARG=/'`,

  mark('INITRD'),
  // Skipped on bare metal: listing an initramfs takes seconds and only matters for a VM that will move.
  `if [ "$(systemd-detect-virt 2>/dev/null)" != none ]; then k=$(uname -r); img=""; ` +
    `for f in "/boot/initramfs-$k.img" "/boot/initrd.img-$k" "/boot/initrd-$k" /boot/initrd.img /boot/initrd; do [ -f "$f" ] && { img=$f; break; }; done; ` +
    `if [ -n "$img" ]; then echo "FILE=$img"; ` +
    `if [ ! -r "$img" ]; then echo "UNREADABLE=1"; ` +
    `elif command -v lsinitrd >/dev/null 2>&1; then echo "TOOL=dracut"; timeout 60 lsinitrd "$img" 2>/dev/null | grep -oE 'virtio[a-z_]*\\.ko' | sed 's/\\.ko$//' | sort -u | sed 's/^/MOD=/'; ` +
    `elif command -v lsinitramfs >/dev/null 2>&1; then echo "TOOL=initramfs-tools"; timeout 60 lsinitramfs "$img" 2>/dev/null | grep -oE 'virtio[a-z_]*\\.ko' | sed 's/\\.ko$//' | sort -u | sed 's/^/MOD=/'; ` +
    `else echo "TOOL=none"; fi; fi; ` +
    `grep -oE 'virtio[a-z_]*\\.ko' "/lib/modules/$k/modules.builtin" 2>/dev/null | sed 's/\\.ko$//' | sort -u | sed 's/^/BUILTIN=/'; ` +
    `find "/lib/modules/$k" -name 'virtio*.ko*' 2>/dev/null | sed 's#.*/##; s/\\.ko.*$//' | sort -u | head -n 40 | sed 's/^/ONDISK=/'; ` +
    `command -v dracut >/dev/null 2>&1 && echo "HAVE=dracut"; command -v update-initramfs >/dev/null 2>&1 && echo "HAVE=initramfs-tools"; fi`,

  mark('FSTAB'),
  // Device, mount point and type only — options can hold credentials (cifs) and are never read out.
  `awk '$1 !~ /^#/ && NF >= 3 {print "MNT=" $1 " " $2 " " $3}' /etc/fstab 2>/dev/null | head -n 100`,

  mark('NETCFG'),
  // Which config files name a current interface, and whether they pin a MAC or a static
  // address. Nothing is printed from the files themselves (NetworkManager keyfiles hold Wi-Fi keys).
  `names=$(ls /sys/class/net 2>/dev/null | grep -v '^lo$'); ` +
    `for f in /etc/sysconfig/network-scripts/ifcfg-* /etc/sysconfig/network/ifcfg-* /etc/netplan/*.yaml /etc/netplan/*.yml /etc/network/interfaces /etc/network/interfaces.d/* ` +
    `/etc/NetworkManager/system-connections/* /etc/systemd/network/*.network /etc/systemd/network/*.link; do [ -f "$f" ] || continue; ` +
    `case "$f" in *ifcfg-lo) continue ;; esac; echo "FILE=$f"; [ -r "$f" ] || { echo "UNREADABLE=1"; continue; }; ` +
    `for n in $names; do grep -qw -- "$n" "$f" && echo "REF=$n"; done; ` +
    `grep -qiE '^[[:space:]]*(HWADDR|MACADDR)=|macaddress:|mac-address=|MACAddress=' "$f" && echo "MACBOUND=1"; ` +
    `grep -qiE 'BOOTPROTO=.?(none|static)|dhcp4:[[:space:]]*(false|no)|method=manual|^iface .* static|^Address=|^[[:space:]]*addresses:' "$f" && echo "STATIC=1"; ` +
    `grep -qiE 'BOOTPROTO=.?dhcp|dhcp4:[[:space:]]*(true|yes)|method=auto|^iface .* dhcp|^DHCP=' "$f" && echo "DHCP=1"; done; ` +
    `[ -f /etc/udev/rules.d/70-persistent-net.rules ] && echo "UDEVNET=1"`,

  mark('AGENTS'),
  `command -v systemctl >/dev/null 2>&1 && echo "SYSTEMD=yes"; systemctl list-unit-files --no-legend --plain 'vmtoolsd*' 'open-vm-tools*' 'vmware-tools*' 'qemu-guest-agent*' 'cloud-init.service' 'chronyd*' 'chrony.service' 'ntpd*' 'ntp.service' 'ntpsec*' 'systemd-timesyncd*' 'morpheus-node*' 2>/dev/null | ` +
    `awk '{print $1}' | head -n 30 | while read -r u; do echo "SVC=$u $(systemctl is-active "$u" 2>/dev/null)"; done; ` +
    `[ -x /etc/init.d/vmware-tools ] && echo "SVC=vmware-tools.legacy present"; ` +
    `command -v vmware-toolbox-cmd >/dev/null 2>&1 && { echo "VMTOOLSVER=$(vmware-toolbox-cmd -v 2>/dev/null)"; echo "VMTIMESYNC=$(vmware-toolbox-cmd timesync status 2>/dev/null)"; }`,

  mark('USAGE'),
  `df -P -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x nfs -x nfs4 -x cifs -x fuse.sshfs 2>/dev/null | awk 'NR > 1 {s += $2; u += $3} END {print "USED=" u; print "SIZE=" s}'`,

  mark('END'),
].join('; ');

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CpuInfo {
  model?: string;
  vendor?: string;
  arch?: string;
  sockets?: number;
  coresPerSocket?: number;
  threadsPerCore?: number;
  logical?: number;
  /** sockets × cores per socket. */
  cores?: number;
  numaNodes?: number;
  maxMhz?: number;
  l3?: string;
  /** VT-x / AMD-V as lscpu reports it. */
  virtualization?: string;
  /** Set when this machine is itself a guest. */
  hypervisor?: string;
  flags: string[];
}

export interface DimmInfo {
  locator: string;
  sizeBytes?: number;
  type?: string;
  speed?: string;
  manufacturer?: string;
  part?: string;
}

export interface MemoryInfo {
  totalBytes?: number;
  swapBytes?: number;
  hugepages?: number;
  hugepageKb?: number;
  maxCapacity?: string;
  ecc?: string;
  /** Slots the firmware reports; populated = slots holding a DIMM. */
  slots?: number;
  populated?: number;
  dimms: DimmInfo[];
  /** Memory-controller error counters: corrected (CE) and uncorrected (UE). */
  edac: Array<{ mc: string; ce: number; ue: number }>;
  /** dmidecode was not installed (or not readable): no slot detail. */
  noDmi?: boolean;
}

export interface SystemInfo {
  vendor?: string;
  product?: string;
  version?: string;
  serial?: string;
  uuid?: string;
  biosVendor?: string;
  biosVersion?: string;
  biosDate?: string;
  boardVendor?: string;
  boardName?: string;
  chassisType?: string;
}

export interface NicInfo {
  name: string;
  kind: 'physical' | 'bond' | 'vlan' | 'bridge';
  mac?: string;
  state?: string;
  speedMbps?: number;
  mtu?: number;
  ips: string[];
  master?: string;
  pci?: string;
  driver?: string;
  firmware?: string;
  sriovTotal?: number;
  sriovNum?: number;
}

export interface BondInfo {
  name: string;
  mode?: string;
  mii?: string;
  slaves: Array<{ name: string; mii?: string; speed?: string }>;
}

export interface DiskInfo {
  name: string;
  type: string;
  sizeBytes: number;
  rotational: boolean;
  model?: string;
  serial?: string;
  transport?: string;
  vendor?: string;
  wwn?: string;
  smart?: 'passed' | 'failed' | 'unavailable';
}

export interface PciDevice {
  address: string;
  driver?: string;
  cls: string;
  classCode?: string;
  vendor: string;
  vendorId?: string;
  device: string;
  deviceId?: string;
}

export interface VirtHostInfo {
  kvm: boolean;
  nested?: string;
  iommuGroups: number;
  cmdline: string[];
  vfio: boolean;
  libvirt?: string;
  guests: string[];
  ovs?: string;
  ovsBridges: string[];
  units: Array<{ unit: string; active: string; sub: string }>;
}

/** What the guest OS itself says about how it boots and finds its disks and network. */
export interface GuestInfo {
  efi?: boolean;
  secureBoot?: boolean;
  /** root=, resume=, net.ifnames=, biosdevname= from the kernel command line. */
  bootArgs: Record<string, string>;
  initramfs?: {
    file?: string;
    unreadable?: boolean;
    /** Which tool listed it (dracut = lsinitrd, initramfs-tools = lsinitramfs), or none. */
    tool?: 'dracut' | 'initramfs-tools' | 'none';
    /** The tool that would rebuild it. */
    builder?: 'dracut' | 'initramfs-tools';
    modules: string[];
    builtin: string[];
    onDisk: string[];
  };
  mounts: Array<{ device: string; mount: string; fstype: string }>;
  netConfigs: Array<{ file: string; refs: string[]; macBound: boolean; isStatic: boolean; dhcp: boolean; unreadable?: boolean }>;
  udevNetRules: boolean;
  services: Array<{ unit: string; state: string }>;
  /** systemctl exists, so an empty service list means "none installed", not "could not tell". */
  systemd: boolean;
  vmtoolsVersion?: string;
  vmtoolsTimeSync?: boolean;
  usedBytes?: number;
  sizeBytes?: number;
}

export interface HardwareInfo {
  host?: string;
  uid?: number;
  hostNow?: number;
  os?: string;
  kernel?: string;
  arch?: string;
  /** systemd-detect-virt: `none` on bare metal, else kvm / vmware / microsoft / … */
  virt?: string;
  physical: boolean;
  system: SystemInfo;
  cpu: CpuInfo;
  memory: MemoryInfo;
  nics: NicInfo[];
  bonds: BondInfo[];
  disks: DiskInfo[];
  smartMissing?: boolean;
  multipath: { maps: number; activePaths: number; failedPaths: number; text: string[] };
  fc: Array<{ host: string; wwpn?: string; state?: string; speed?: string }>;
  iscsi: { initiator?: string; sessions?: number };
  pci: PciDevice[];
  lspciMissing?: boolean;
  gpus: PciDevice[];
  virtHost: VirtHostInfo;
  bmc: { firmware?: string; manufacturer?: string; ip?: string; mac?: string };
  guest: GuestInfo;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const kv = (line: string, sep = '='): [string, string] => {
  const i = line.indexOf(sep);
  return i < 0 ? [line.trim(), ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
};

const num = (v?: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? n : undefined;
};

const clean = (v?: string): string | undefined => {
  const s = (v || '').trim();
  // dmidecode / sysfs placeholders mean "nothing here".
  return !s || /^(not specified|to be filled by o\.e\.m\.|default string|none|unknown|n\/a|0+)$/i.test(s) ? undefined : s;
};

/** Split lines into items, each starting at a `KEY=` line. */
function itemsBy(key: string, body: string[]): Array<{ head: string; lines: string[] }> {
  const out: Array<{ head: string; lines: string[] }> = [];
  const p = `${key}=`;
  for (const raw of body) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(p)) out.push({ head: line.slice(p.length).trim(), lines: [] });
    else if (out.length && line.trim()) out[out.length - 1].lines.push(line);
  }
  return out;
}

/** `16 GB`, `32768 MB`, `1 TB` → bytes. `No Module Installed` → undefined. */
export function dmiSize(v?: string): number | undefined {
  const m = (v || '').match(/^\s*([\d.]+)\s*(kB|KB|MB|GB|TB)\b/i);
  if (!m) return undefined;
  const mult: Record<string, number> = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.round(Number(m[1]) * mult[m[2].toLowerCase()]);
}

export function parseLscpu(lines: string[]): CpuInfo {
  const cpu: CpuInfo = { flags: [] };
  let procFlags: string[] = [];
  let procModel: string | undefined;
  let procCount: number | undefined;
  let procSockets: number | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('PROCMODEL=')) { procModel = clean(line.slice(10)); continue; }
    if (line.startsWith('PROCFLAGS=')) { procFlags = line.slice(10).trim().split(/\s+/).filter(Boolean); continue; }
    if (line.startsWith('PROCCOUNT=')) { procCount = num(line.slice(10)) || undefined; continue; }
    if (line.startsWith('PROCSOCKETS=')) { procSockets = num(line.slice(12)) || undefined; continue; }
    const [k, v] = kv(line, ':');
    if (!v) continue;
    switch (k) {
      case 'Architecture': cpu.arch = v; break;
      case 'CPU(s)': cpu.logical = num(v); break;
      case 'Vendor ID': cpu.vendor = v; break;
      case 'Model name': cpu.model = cpu.model || v; break;
      case 'Socket(s)': cpu.sockets = num(v); break;
      case 'Core(s) per socket': cpu.coresPerSocket = num(v); break;
      case 'Thread(s) per core': cpu.threadsPerCore = num(v); break;
      case 'NUMA node(s)': cpu.numaNodes = num(v); break;
      case 'CPU max MHz': cpu.maxMhz = Math.round(num(v) || 0) || undefined; break;
      case 'L3 cache': cpu.l3 = v; break;
      case 'Virtualization': cpu.virtualization = v; break;
      case 'Hypervisor vendor': cpu.hypervisor = v; break;
      case 'Flags': cpu.flags = v.split(/\s+/).filter(Boolean); break;
    }
  }
  if (!cpu.model) cpu.model = procModel;
  if (!cpu.flags.length) cpu.flags = procFlags;
  if (cpu.logical === undefined) cpu.logical = procCount;
  if (cpu.sockets === undefined && procSockets) cpu.sockets = procSockets;
  if (cpu.sockets && cpu.coresPerSocket) cpu.cores = cpu.sockets * cpu.coresPerSocket;
  if (!cpu.virtualization) {
    if (cpu.flags.includes('vmx')) cpu.virtualization = 'VT-x';
    else if (cpu.flags.includes('svm')) cpu.virtualization = 'AMD-V';
  }
  return cpu;
}

export function parseDimms(lines: string[], meminfo: string[]): MemoryInfo {
  const mem: MemoryInfo = { dimms: [], edac: [] };
  for (const l of meminfo) {
    const [k, v] = kv(l, ':');
    const n = num(v.replace(/\s*kB$/i, ''));
    if (n === undefined) continue;
    if (k === 'MemTotal') mem.totalBytes = n * 1024;
    else if (k === 'SwapTotal') mem.swapBytes = n * 1024;
    else if (k === 'HugePages_Total') mem.hugepages = n;
    else if (k === 'Hugepagesize') mem.hugepageKb = n;
  }

  let section: 'array' | 'device' | '' = '';
  let cur: (DimmInfo & { present: boolean }) | null = null;
  let slots = 0;
  const flush = () => {
    if (cur) {
      slots++;
      const { present, ...dimm } = cur;
      if (present) mem.dimms.push(dimm);
    }
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('NODMIDECODE=')) { mem.noDmi = true; continue; }
    if (/^Physical Memory Array/.test(line)) { flush(); section = 'array'; continue; }
    if (/^Memory Device/.test(line)) { flush(); section = 'device'; cur = { locator: '', present: false }; continue; }
    const [k, v] = kv(line, ':');
    if (section === 'array') {
      if (k === 'Maximum Capacity') mem.maxCapacity = v;
      else if (k === 'Error Correction Type') mem.ecc = v;
    } else if (section === 'device' && cur) {
      if (k === 'Size') { const b = dmiSize(v); cur.present = !!b; cur.sizeBytes = b; }
      else if (k === 'Locator') cur.locator = v;
      else if (k === 'Type') cur.type = clean(v) && v !== 'Unknown' ? v : undefined;
      else if (k === 'Configured Memory Speed' || k === 'Configured Clock Speed') cur.speed = clean(v) && !/unknown/i.test(v) ? v : cur.speed;
      else if (k === 'Speed' && !cur.speed) cur.speed = clean(v) && !/unknown/i.test(v) ? v : undefined;
      else if (k === 'Manufacturer') cur.manufacturer = clean(v);
      else if (k === 'Part Number') cur.part = clean(v);
    }
  }
  flush();
  if (slots) { mem.slots = slots; mem.populated = mem.dimms.length; }
  return mem;
}

export function parseEdac(lines: string[]): MemoryInfo['edac'] {
  const out: MemoryInfo['edac'] = [];
  for (const l of lines) {
    const m = l.match(/^MC=(\S+)\s+(\d+)?\s*(\d+)?/);
    if (m) out.push({ mc: m[1], ce: Number(m[2] || 0), ue: Number(m[3] || 0) });
  }
  return out;
}

const DMI_KEYS: Record<string, keyof SystemInfo> = {
  sys_vendor: 'vendor', product_name: 'product', product_version: 'version', product_serial: 'serial', product_uuid: 'uuid',
  bios_vendor: 'biosVendor', bios_version: 'biosVersion', bios_date: 'biosDate', board_vendor: 'boardVendor', board_name: 'boardName',
  chassis_type: 'chassisType',
};
// SMBIOS chassis type codes worth naming.
const CHASSIS: Record<string, string> = { '1': 'Other', '3': 'Desktop', '7': 'Tower', '9': 'Laptop', '17': 'Main server chassis', '23': 'Rack mount', '24': 'Sealed-case PC', '25': 'Multi-system', '28': 'Blade', '29': 'Blade enclosure', '35': 'Mini PC' };

export function parseDmi(lines: string[]): SystemInfo {
  const s: SystemInfo = {};
  for (const l of lines) {
    const [k, v] = kv(l);
    const key = DMI_KEYS[k];
    if (!key) continue;
    const val = clean(v);
    if (val) s[key] = key === 'chassisType' ? (CHASSIS[val] || val) : val;
  }
  return s;
}

export function parseNics(body: string[]): NicInfo[] {
  return itemsBy('NIC', body).map(({ head, lines }) => {
    const n: NicInfo = { name: head, kind: 'physical', ips: [] };
    for (const l of lines) {
      const [k, v] = kv(l);
      switch (k) {
        case 'KIND': n.kind = (['physical', 'bond', 'vlan', 'bridge'].includes(v) ? v : 'physical') as NicInfo['kind']; break;
        case 'MAC': n.mac = v || undefined; break;
        case 'STATE': n.state = v || undefined; break;
        // -1 / empty when the link is down or the driver does not say.
        case 'SPEED': { const s = num(v); n.speedMbps = s && s > 0 ? s : undefined; break; }
        case 'MTU': n.mtu = num(v); break;
        case 'IP': n.ips = v.split(/\s+/).filter(Boolean); break;
        case 'MASTER': n.master = v || undefined; break;
        case 'PCI': n.pci = v || undefined; break;
        case 'DRIVER': n.driver = v || undefined; break;
        case 'FIRMWARE': n.firmware = v || undefined; break;
        case 'VFTOTAL': n.sriovTotal = num(v); break;
        case 'VFNUM': n.sriovNum = num(v); break;
      }
    }
    return n;
  });
}

export function parseBonds(body: string[]): BondInfo[] {
  return itemsBy('BOND', body).map(({ head, lines }) => {
    const b: BondInfo = { name: head, slaves: [] };
    let slave: BondInfo['slaves'][number] | undefined;
    for (const l of lines) {
      const [k, v] = kv(l, ':');
      if (k === 'Bonding Mode') b.mode = v;
      else if (k === 'Slave Interface') { slave = { name: v }; b.slaves.push(slave); }
      else if (k === 'MII Status') { if (slave) slave.mii = v; else b.mii = v; }
      else if (k === 'Speed' && slave) slave.speed = v;
    }
    return b;
  });
}

/** `NAME="sda" TYPE="disk" SIZE="480103981056" …` → record. */
export function parsePairs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9_:-]+)="((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2].replace(/\\x20/g, ' ').trim();
  return out;
}

export function parseDisks(lsblk: string[], smart: string[]): { disks: DiskInfo[]; smartMissing: boolean } {
  const disks: DiskInfo[] = [];
  for (const l of lsblk) {
    if (!l.includes('NAME=')) continue;
    const r = parsePairs(l);
    if (!r.NAME || !/^(disk|mpath|raid\d*)$/.test(r.TYPE || '')) continue;
    disks.push({
      name: r.NAME, type: r.TYPE, sizeBytes: Number(r.SIZE) || 0, rotational: r.ROTA === '1',
      model: clean(r.MODEL), serial: clean(r.SERIAL), transport: clean(r.TRAN), vendor: clean(r.VENDOR), wwn: clean(r.WWN),
    });
  }
  const smartMissing = smart.some((l) => l.startsWith('NOSMARTCTL='));
  for (const { head, lines } of itemsBy('DISK', smart)) {
    const d = disks.find((x) => x.name === head);
    if (!d) continue;
    const text = lines.join(' ');
    if (/PASSED|:\s*OK\b/i.test(text)) d.smart = 'passed';
    else if (/FAILED|FAILING/i.test(text)) d.smart = 'failed';
    else if (text) d.smart = 'unavailable';
  }
  return { disks, smartMissing };
}

export function parseMultipath(lines: string[]): HardwareInfo['multipath'] {
  const text = lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  let maps = 0, active = 0, failed = 0;
  for (const l of text) {
    // A map header: `mpatha (3600…) dm-0 HPE,MSA 2060 FC`
    if (/^\S+\s+\([0-9a-f]{8,}\)\s+dm-\d+/i.test(l) || /^\S+\s+dm-\d+\s/.test(l)) maps++;
    // A path line: `  |- 1:0:0:1 sdb 8:16 active ready running`
    else if (/\d+:\d+:\d+:\d+\s+\S+\s+\d+:\d+/.test(l)) {
      if (/\b(failed|faulty|offline)\b/i.test(l)) failed++;
      else if (/\bactive\b/.test(l)) active++;
    }
  }
  return { maps, activePaths: active, failedPaths: failed, text: text.slice(0, 300) };
}

export function parseSan(lines: string[]): Pick<HardwareInfo, 'fc' | 'iscsi'> {
  const fc: HardwareInfo['fc'] = [];
  const iscsi: HardwareInfo['iscsi'] = {};
  for (const l of lines) {
    const m = l.match(/^FC=(\S+)\s*(\S+)?\s*(\S+)?\s*(\S+)?/);
    if (m) { fc.push({ host: m[1], wwpn: m[2], state: m[3], speed: m[4]?.replace(/_/g, ' ') }); continue; }
    if (l.startsWith('InitiatorName=')) iscsi.initiator = l.slice(14).trim();
    else if (l.startsWith('ISCSISESSIONS=')) iscsi.sessions = num(l.slice(14));
  }
  return { fc, iscsi };
}

/** `Ethernet controller [0200]` → { name, code } */
const bracket = (s: string) => {
  const m = s.match(/^(.*?)\s*\[([0-9a-f]{4})\]\s*$/i);
  return m ? { name: m[1], code: m[2].toLowerCase() } : { name: s, code: undefined };
};

export function parsePci(lines: string[]): { pci: PciDevice[]; missing: boolean } {
  const pci: PciDevice[] = [];
  for (const l of lines) {
    if (!l.startsWith('DEV=')) continue;
    const [address, driver, ...rest] = l.slice(4).split('|');
    const q = [...rest.join('|').matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (q.length < 3) continue;
    const c = bracket(q[0]), v = bracket(q[1]), d = bracket(q[2]);
    pci.push({ address, driver: driver || undefined, cls: c.name, classCode: c.code, vendor: v.name, vendorId: v.code, device: d.name, deviceId: d.code });
  }
  return { pci, missing: lines.some((l) => l.startsWith('NOLSPCI=')) };
}

/** NVIDIA / AMD accelerators — not the BMC's little ASPEED or Matrox display. */
export function isGpu(d: PciDevice): boolean {
  return (d.vendorId === '10de' || d.vendorId === '1002') && /^(03|12)/.test(d.classCode || '');
}

export function parseVirtHost(lines: string[]): VirtHostInfo {
  const v: VirtHostInfo = { kvm: false, iommuGroups: 0, cmdline: [], vfio: false, guests: [], ovsBridges: [], units: [] };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const [k, val] = kv(line);
    switch (k) {
      case 'KVM': v.kvm = val === 'yes'; break;
      case 'NESTED': v.nested = val; break;
      case 'IOMMUGROUPS': v.iommuGroups = num(val) || 0; break;
      case 'CMDLINE': v.cmdline = val.split(/\s+/).filter(Boolean); break;
      case 'VFIO': v.vfio = val === 'yes'; break;
      case 'LIBVIRT': v.libvirt = val || undefined; break;
      case 'VM': if (val) v.guests.push(val); break;
      case 'OVS': v.ovs = val || undefined; break;
      case 'OVSBR': if (val) v.ovsBridges.push(val); break;
      case 'UNIT': {
        const [unit, , active, sub] = val.replace(/^●\s*/, '').split(/\s+/);
        if (unit) v.units.push({ unit, active: active || '', sub: sub || '' });
        break;
      }
    }
  }
  return v;
}

export function parseBmc(lines: string[]): HardwareInfo['bmc'] {
  const b: HardwareInfo['bmc'] = {};
  for (const l of lines) {
    const [k, v] = kv(l, ':');
    if (k === 'Firmware Revision') b.firmware = v;
    else if (k === 'Manufacturer Name') b.manufacturer = v;
    else if (k === 'IP Address' && v && v !== '0.0.0.0') b.ip = v;
    else if (k === 'MAC Address') b.mac = v;
  }
  return b;
}

export function parseGuest(get: (tag: string) => string[]): GuestInfo {
  const g: GuestInfo = { bootArgs: {}, mounts: [], netConfigs: [], udevNetRules: false, services: [], systemd: false };

  for (const l of get('BOOT')) {
    const [k, v] = kv(l);
    if (k === 'EFI') g.efi = v === 'yes';
    else if (k === 'SECUREBOOT') g.secureBoot = v === '1';
    else if (k === 'ARG') { const [ak, av] = kv(v); if (ak) g.bootArgs[ak] = av; }
  }

  const ird = get('INITRD').filter((l) => l.trim());
  if (ird.length) {
    const i: NonNullable<GuestInfo['initramfs']> = { modules: [], builtin: [], onDisk: [] };
    for (const l of ird) {
      const [k, v] = kv(l);
      if (k === 'FILE') i.file = v;
      else if (k === 'UNREADABLE') i.unreadable = true;
      else if (k === 'TOOL') i.tool = v as any;
      else if (k === 'HAVE' && !i.builder) i.builder = v as any;
      else if (k === 'MOD' && v) i.modules.push(v);
      else if (k === 'BUILTIN' && v) i.builtin.push(v);
      else if (k === 'ONDISK' && v) i.onDisk.push(v);
    }
    g.initramfs = i;
  }

  for (const l of get('FSTAB')) {
    const m = l.match(/^MNT=(\S+)\s+(\S+)\s+(\S+)/);
    if (m) g.mounts.push({ device: m[1], mount: m[2], fstype: m[3] });
  }

  for (const { head, lines } of itemsBy('FILE', get('NETCFG'))) {
    const c = { file: head, refs: [] as string[], macBound: false, isStatic: false, dhcp: false, unreadable: undefined as boolean | undefined };
    for (const l of lines) {
      const [k, v] = kv(l);
      if (k === 'REF') c.refs.push(v);
      else if (k === 'MACBOUND') c.macBound = true;
      else if (k === 'STATIC') c.isStatic = true;
      else if (k === 'DHCP') c.dhcp = true;
      else if (k === 'UNREADABLE') c.unreadable = true;
    }
    if (!c.unreadable) delete c.unreadable;
    g.netConfigs.push(c);
  }
  g.udevNetRules = get('NETCFG').some((l) => l.startsWith('UDEVNET='));

  for (const l of get('AGENTS')) {
    const [k, v] = kv(l);
    if (k === 'SYSTEMD') g.systemd = v === 'yes';
    else if (k === 'SVC') { const [unit, state] = v.split(/\s+/); if (unit) g.services.push({ unit, state: state || '' }); }
    else if (k === 'VMTOOLSVER') g.vmtoolsVersion = v || undefined;
    else if (k === 'VMTIMESYNC') g.vmtoolsTimeSync = /enabled/i.test(v) ? true : /disabled/i.test(v) ? false : undefined;
  }

  for (const l of get('USAGE')) {
    const [k, v] = kv(l);
    if (k === 'USED') g.usedBytes = num(v);
    else if (k === 'SIZE') g.sizeBytes = num(v);
  }
  return g;
}

export function parseHardware(stdout: string): HardwareInfo {
  const blocks = splitMarked(stdout);
  const get = (tag: string) => (blocks.find((b) => b.tag === tag)?.body || []).map((l) => l.replace(/\r$/, ''));

  const hw: HardwareInfo = {
    physical: false, system: {}, cpu: { flags: [] }, memory: { dimms: [], edac: [] }, nics: [], bonds: [], disks: [],
    multipath: { maps: 0, activePaths: 0, failedPaths: 0, text: [] }, fc: [], iscsi: {}, pci: [], gpus: [],
    virtHost: { kvm: false, iommuGroups: 0, cmdline: [], vfio: false, guests: [], ovsBridges: [], units: [] }, bmc: {},
    guest: { bootArgs: {}, mounts: [], netConfigs: [], udevNetRules: false, services: [], systemd: false },
  };

  for (const l of get('SELF')) {
    const [k, v] = kv(l);
    if (k === 'HOST') hw.host = v;
    else if (k === 'UID') hw.uid = num(v);
    else if (k === 'NOW') hw.hostNow = num(v);
    else if (k === 'OS') hw.os = v || undefined;
    else if (k === 'KERNEL') hw.kernel = v || undefined;
    else if (k === 'ARCH') hw.arch = v || undefined;
    else if (k === 'VIRT') hw.virt = v || undefined;
  }

  hw.cpu = parseLscpu(get('CPU'));
  hw.memory = { ...parseDimms(get('DIMM'), get('MEM')), edac: parseEdac(get('EDAC')) };
  hw.system = parseDmi(get('DMI'));
  hw.nics = parseNics(get('NIC'));
  hw.bonds = parseBonds(get('BOND'));
  const d = parseDisks(get('DISK'), get('SMART'));
  hw.disks = d.disks;
  hw.smartMissing = d.smartMissing;
  hw.multipath = parseMultipath(get('MPATH'));
  Object.assign(hw, parseSan(get('SAN')));
  const p = parsePci(get('PCI'));
  hw.pci = p.pci;
  hw.lspciMissing = p.missing;
  hw.gpus = hw.pci.filter(isGpu);
  hw.virtHost = parseVirtHost(get('VIRTHOST'));
  hw.bmc = parseBmc(get('BMC'));
  hw.guest = parseGuest(get);

  // Bare metal when systemd says so; when it is silent, a lscpu hypervisor line
  // means guest, and a real BIOS vendor plus no hypervisor means metal.
  // The CPU's own `hypervisor` flag is set in every guest.
  const guest = !!hw.cpu.hypervisor || hw.cpu.flags.includes('hypervisor') ||
    /qemu|vmware|microsoft|xen|innotek|red hat|nutanix/i.test(`${hw.system.vendor || ''} ${hw.system.product || ''}`);
  hw.physical = hw.virt === 'none' || (!hw.virt && !guest && !!hw.system.vendor);
  if (!hw.virt && guest) hw.virt = 'guest';
  return hw;
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

export type CheckStatus = 'critical' | 'warning' | 'info' | 'ok';
export type HwArea = 'cpu' | 'memory' | 'storage' | 'network' | 'firmware' | 'virtualization' | 'licensing' | 'access' | 'migration';

export interface HwCheck {
  id: string;
  status: CheckStatus;
  area: HwArea;
  title: string;
  detail?: string;
  evidence?: string;
  /** A read-only command or the next step. Reported, never run. */
  hint?: string;
}

const GiB = 1024 ** 3;
export const fmtBytes = (b?: number) => {
  if (!b) return '—';
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(1)} TiB`;
  if (b >= GiB) return `${Math.round(b / GiB)} GiB`;
  return `${Math.round(b / 1024 ** 2)} MiB`;
};

const GUEST_PLATFORM: Record<string, string> = {
  vmware: 'VMware', kvm: 'KVM', qemu: 'QEMU', microsoft: 'Hyper-V', xen: 'Xen', oracle: 'VirtualBox', 'amazon': 'AWS Nitro',
};

export function analyzeHardware(hw: HardwareInfo, now = Date.now()): HwCheck[] {
  const out: HwCheck[] = [];
  const add = (c: HwCheck) => out.push(c);

  // ── Access: without root, half the picture is missing ───────────────────
  if (hw.uid !== undefined && hw.uid !== 0) {
    add({
      id: 'access-root', status: 'info', area: 'access', title: 'Read without root — memory slots, serial numbers, disk health and multipath are hidden',
      detail: 'dmidecode, smartctl and multipath need root. Everything else was read.',
      hint: 'K8s Nodes → this host → Root access (sudo)',
    });
  }

  // ── What kind of machine is this ─────────────────────────────────────────
  if (!hw.physical && !hw.virt) {
    add({
      id: 'virt-unknown', status: 'info', area: 'migration', title: 'Could not tell whether this is bare metal or a VM',
      detail: 'No systemd-detect-virt and no firmware identity. Treated as a VM, so it is left out of socket counts and server drift.',
      hint: 'systemd-detect-virt; cat /sys/class/dmi/id/sys_vendor',
    });
  } else if (!hw.physical) {
    const platform = GUEST_PLATFORM[hw.virt || ''] || hw.cpu.hypervisor || 'a hypervisor';
    add({
      id: 'virt-guest', status: 'info', area: 'migration',
      title: `This is a virtual machine on ${platform}`,
      detail: hw.virt === 'vmware'
        ? 'A VMware guest: in scope for the move to VME. CPU, NICs and disks here are what VMware presents, not the physical server.'
        : 'CPU, NICs and disks here are what the hypervisor presents, not the physical server underneath.',
      evidence: `systemd-detect-virt=${hw.virt || '?'}${hw.cpu.hypervisor ? `, lscpu hypervisor=${hw.cpu.hypervisor}` : ''}`,
    });
    if (hw.virt === 'vmware') {
      const vmwareNics = hw.nics.filter((n) => n.kind === 'physical' && /vmxnet/.test(n.driver || ''));
      const pvscsi = hw.pci.some((d) => /vmw_pvscsi/.test(d.driver || ''));
      if (vmwareNics.length || pvscsi) {
        add({
          id: 'vmware-devices', status: 'info', area: 'migration',
          title: 'Uses VMware-only virtual devices — they become virtio on VME',
          detail: `${[vmwareNics.length ? `NIC driver vmxnet3 (${vmwareNics.map((n) => n.name).join(', ')})` : '', pvscsi ? 'disk controller pvscsi' : ''].filter(Boolean).join('; ')}. ` +
            'Interface names and disk device names can change after conversion; check that the guest has virtio drivers and mounts by UUID.',
          hint: 'lsinitrd | grep virtio  (or: lsinitramfs /boot/initrd.img-$(uname -r) | grep virtio)',
        });
      }
    }
  }

  // ── CPU / virtualization capability (bare metal only) ────────────────────
  if (hw.physical) {
    const hasVirt = hw.cpu.flags.includes('vmx') || hw.cpu.flags.includes('svm');
    if (hw.cpu.flags.length && !hasVirt) {
      add({
        id: 'cpu-no-vt', status: 'critical', area: 'virtualization', title: 'Hardware virtualization (VT-x / AMD-V) is off — this server cannot run VMs',
        detail: 'The CPU flags have neither vmx nor svm. VME (KVM) needs it. It is usually a BIOS setting.',
        evidence: '/proc/cpuinfo flags', hint: 'BIOS/UEFI → Processor options → Intel(R) Virtualization Technology: Enabled',
      });
    } else if (hasVirt && !hw.virtHost.kvm) {
      add({
        id: 'kvm-missing', status: 'warning', area: 'virtualization', title: 'CPU supports virtualization but /dev/kvm is missing',
        detail: 'The kvm module is not loaded. Fine for a plain Kubernetes node; a VME host needs it.',
        hint: 'lsmod | grep kvm',
      });
    }
    if (hw.gpus.length && hw.virtHost.iommuGroups === 0) {
      add({
        id: 'iommu-off', status: 'warning', area: 'virtualization', title: `${hw.gpus.length} GPU${hw.gpus.length === 1 ? '' : 's'} but IOMMU is off — no GPU passthrough to VMs`,
        detail: 'Passing a GPU to a VM needs VT-d / AMD-Vi in the BIOS and intel_iommu=on (or amd_iommu=on) on the kernel command line.',
        evidence: `/sys/kernel/iommu_groups is empty; cmdline: ${hw.virtHost.cmdline.join(' ') || '(no iommu flags)'}`,
        hint: 'cat /proc/cmdline; dmesg | grep -i -e DMAR -e IOMMU',
      });
    }
    if (hw.cpu.sockets) {
      add({
        id: 'license-sockets', status: 'info', area: 'licensing',
        title: `${hw.cpu.sockets} CPU socket${hw.cpu.sockets === 1 ? '' : 's'} — VME is licensed per socket`,
        detail: `${hw.cpu.model || 'CPU'}: ${hw.cpu.cores ?? '?'} cores, ${hw.cpu.logical ?? '?'} threads.`,
        evidence: 'lscpu Socket(s)',
      });
    }
  }

  // ── Memory ───────────────────────────────────────────────────────────────
  const ue = hw.memory.edac.reduce((s, m) => s + m.ue, 0);
  const ce = hw.memory.edac.reduce((s, m) => s + m.ce, 0);
  if (ue > 0) {
    add({
      id: 'mem-ue', status: 'critical', area: 'memory', title: `${ue} uncorrectable memory error${ue === 1 ? '' : 's'} since boot`,
      detail: 'Uncorrected ECC errors crash processes or the host. Replace the DIMM before moving workloads here.',
      evidence: hw.memory.edac.filter((m) => m.ue).map((m) => `${m.mc} ue_count=${m.ue}`).join(', '),
      hint: 'grep . /sys/devices/system/edac/mc/mc*/*/dimm_label; journalctl -k | grep -i edac',
    });
  } else if (ce > 0) {
    add({
      id: 'mem-ce', status: ce >= 100 ? 'warning' : 'info', area: 'memory', title: `${ce} corrected memory error${ce === 1 ? '' : 's'} since boot`,
      detail: 'ECC fixed them, but a DIMM that keeps producing them is on its way out.',
      evidence: hw.memory.edac.filter((m) => m.ce).map((m) => `${m.mc} ce_count=${m.ce}`).join(', '),
      hint: 'journalctl -k | grep -i edac',
    });
  }
  if (hw.physical && hw.memory.dimms.length > 1) {
    const sizes = new Set(hw.memory.dimms.map((d) => d.sizeBytes));
    const speeds = new Set(hw.memory.dimms.map((d) => d.speed).filter(Boolean));
    if (sizes.size > 1 || speeds.size > 1) {
      add({
        id: 'mem-mixed', status: 'info', area: 'memory', title: 'Mixed DIMM sizes or speeds',
        detail: `Sizes: ${[...sizes].map((s) => fmtBytes(s)).join(', ')}; speeds: ${[...speeds].join(', ') || '—'}. Memory runs at the slowest DIMM and unbalanced channels cost bandwidth.`,
        evidence: 'dmidecode -t memory',
      });
    }
  }

  // ── Storage ──────────────────────────────────────────────────────────────
  for (const d of hw.disks.filter((x) => x.smart === 'failed')) {
    add({
      id: `disk-smart-${d.name}`, status: 'critical', area: 'storage', title: `Disk ${d.name} fails its SMART health check`,
      detail: `${d.model || 'disk'} ${fmtBytes(d.sizeBytes)}${d.serial ? `, serial ${d.serial}` : ''}. Replace before it carries a datastore.`,
      hint: `smartctl -a /dev/${d.name}`,
    });
  }
  if (hw.multipath.failedPaths > 0) {
    add({
      id: 'mpath-failed', status: 'warning', area: 'storage',
      title: `${hw.multipath.failedPaths} failed storage path${hw.multipath.failedPaths === 1 ? '' : 's'} (multipath)`,
      detail: `${hw.multipath.activePaths} active across ${hw.multipath.maps} LUN${hw.multipath.maps === 1 ? '' : 's'}. One more failure on the same LUN takes it offline.`,
      hint: 'multipath -ll',
    });
  }
  for (const f of hw.fc.filter((x) => x.state && !/online/i.test(x.state))) {
    add({ id: `fc-${f.host}`, status: 'warning', area: 'storage', title: `Fibre Channel port ${f.host} is ${f.state}`, evidence: `WWPN ${f.wwpn || '?'}`, hint: `cat /sys/class/fc_host/${f.host}/port_state` });
  }

  // ── Network ──────────────────────────────────────────────────────────────
  for (const b of hw.bonds) {
    const down = b.slaves.filter((s) => s.mii && !/up/i.test(s.mii));
    if (down.length) {
      add({
        id: `bond-${b.name}`, status: 'warning', area: 'network',
        title: `Bond ${b.name} has ${down.length} of ${b.slaves.length} link${b.slaves.length === 1 ? '' : 's'} down — no redundancy left`,
        detail: `${b.mode || ''}. Down: ${down.map((s) => s.name).join(', ')}`.trim(),
        hint: `cat /proc/net/bonding/${b.name}`,
      });
    }
  }
  if (hw.physical) {
    const slow = hw.nics.filter((n) => n.kind === 'physical' && n.state === 'up' && n.speedMbps && n.speedMbps < 10_000);
    if (slow.length) {
      add({
        id: 'nic-slow', status: 'info', area: 'network',
        title: `${slow.length} active link${slow.length === 1 ? '' : 's'} below 10 Gb/s`,
        detail: `${slow.map((n) => `${n.name} ${n.speedMbps! >= 1000 ? `${n.speedMbps! / 1000} Gb/s` : `${n.speedMbps} Mb/s`}`).join(', ')}. ` +
          'Fine for management; slow for VM live migration or storage traffic.',
      });
    }
    const mtus = hw.nics.filter((n) => n.kind === 'physical' && n.master && n.mtu);
    const byMaster = new Map<string, Set<number>>();
    for (const n of mtus) byMaster.set(n.master!, (byMaster.get(n.master!) || new Set()).add(n.mtu!));
    for (const [master, set] of byMaster) {
      if (set.size > 1) add({ id: `mtu-${master}`, status: 'warning', area: 'network', title: `Members of ${master} have different MTUs`, detail: [...set].join(' vs '), hint: `ip -d link show master ${master}` });
    }
  }

  // ── Firmware age ─────────────────────────────────────────────────────────
  if (hw.physical && hw.system.biosDate) {
    const t = Date.parse(hw.system.biosDate.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2'));
    if (Number.isFinite(t)) {
      const years = (now - t) / (365.25 * 86_400_000);
      if (years >= 3) {
        add({
          id: 'bios-old', status: 'info', area: 'firmware', title: `System firmware is ${Math.floor(years)} years old`,
          detail: `${hw.system.biosVendor || ''} ${hw.system.biosVersion || ''} (${hw.system.biosDate}). Check the VME hardware compatibility list and the HPE Service Pack for ProLiant before migrating.`.trim(),
          evidence: '/sys/class/dmi/id/bios_date',
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Migration readiness (VMware → VME / KVM), per VM
// ---------------------------------------------------------------------------
// What decides whether a Linux VM boots and reaches the network after it is
// converted: virtio drivers in the initramfs, disks found by UUID rather than
// by device name, network config that survives the NIC rename (ens192 → enp1s0)
// and the MAC change, the same firmware type, and an agent / time source that
// does not depend on VMware Tools. Fix commands are reported, never run.

export type ReadyStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'info';
export type ReadyId = 'virtio' | 'disks' | 'network' | 'firmware' | 'vmtools' | 'agent' | 'time' | 'passthrough' | 'data';

export interface ReadinessItem {
  id: ReadyId;
  label: string;
  status: ReadyStatus;
  detail: string;
  /** Read-only check or the change to make. Reported, never run. */
  fix?: string;
}

export interface Readiness {
  verdict: 'ready' | 'prep' | 'blocked';
  items: ReadinessItem[];
  /** Bytes in use on local filesystems — roughly what a migration copies. */
  dataBytes?: number;
}

export const READY_LABEL: Record<ReadyId, string> = {
  virtio: 'virtio drivers', disks: 'Disks by UUID', network: 'Network config', firmware: 'Firmware',
  vmtools: 'VMware Tools', agent: 'Guest agent', time: 'Time sync', passthrough: 'Passthrough', data: 'Data to copy',
};

/** apt / dnf / zypper, from the OS name. */
function pkgInstall(os: string | undefined, pkg: string): string {
  const o = (os || '').toLowerCase();
  if (/ubuntu|debian/.test(o)) return `apt-get install -y ${pkg}`;
  if (/suse|sles/.test(o)) return `zypper install -y ${pkg}`;
  if (/red hat|rhel|rocky|alma|centos|oracle|fedora|amazon/.test(o)) return `dnf install -y ${pkg}`;
  return `<package manager> install ${pkg}`;
}

const PREDICTABLE_NIC = /^(ens|enp|eno|enx)\w*/;
/** A disk named by order or by a VMware-controller path changes on another hypervisor. */
const DEVICE_PATH = /^\/dev\/(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+)\d*$|^\/dev\/disk\/by-(path|id)\//;

/** Readiness of a VM for conversion to KVM. Bare-metal hosts are not migrated and get none. */
export function assessReadiness(hw: HardwareInfo): Readiness | undefined {
  if (hw.physical) return undefined;
  const g = hw.guest;
  const items: ReadinessItem[] = [];
  const add = (id: ReadyId, status: ReadyStatus, detail: string, fix?: string) => items.push({ id, label: READY_LABEL[id], status, detail, fix });
  const onKvm = hw.virt === 'kvm' || hw.virt === 'qemu';

  // ── virtio: without the disk driver in the initramfs, the VM cannot find its root disk ──
  const ird = g.initramfs;
  const early = new Set([...(ird?.modules || []), ...(ird?.builtin || [])]);
  const hasDisk = early.has('virtio_blk') || early.has('virtio_scsi');
  const hasPci = early.has('virtio_pci') || [...early].some((m) => m.startsWith('virtio_pci'));
  const netAvail = early.has('virtio_net') || (ird?.onDisk || []).includes('virtio_net');
  const builder = ird?.builder || (ird?.tool !== 'none' ? ird?.tool : undefined);
  const virtioFix = builder === 'initramfs-tools'
    ? `printf 'virtio_blk\\nvirtio_scsi\\nvirtio_net\\nvirtio_pci\\n' >> /etc/initramfs-tools/modules && update-initramfs -u`
    : `dracut -f --add-drivers "virtio_blk virtio_scsi virtio_net virtio_pci" /boot/initramfs-$(uname -r).img $(uname -r)`;
  if (onKvm) {
    add('virtio', 'pass', 'Already running on KVM: virtio drivers are in use.');
  } else if (!ird) {
    add('virtio', 'unknown', 'No initramfs found under /boot for the running kernel — check where the boot image of this VM lives.', 'ls -l /boot; lsinitrd | grep virtio');
  } else if (hasDisk && hasPci) {
    add('virtio', netAvail ? 'pass' : 'warn',
      `Boot image has ${[...early].filter((m) => /virtio_(blk|scsi|pci)$/.test(m)).sort().join(', ')}${netAvail ? ', and virtio_net is available' : ' — but virtio_net was not found, so the network will not come up'}.`,
      netAvail ? undefined : pkgInstall(hw.os, 'linux-modules-extra-$(uname -r)  # or the distro kernel-modules package'));
  } else if (ird.unreadable || (ird.tool === 'none' && !hasDisk)) {
    add('virtio', 'unknown',
      `${ird.file || 'The initramfs'} ${ird.unreadable ? 'could not be read (needs root)' : 'could not be listed (no lsinitrd/lsinitramfs)'}; ` +
      `${(ird.builtin || []).length ? `built into the kernel: ${ird.builtin.join(', ')}` : 'no virtio driver is built into the kernel'}.`,
      ird.unreadable ? 'Give Trinetra root on this host (K8s Nodes → Root access) and re-scan' : 'lsinitrd /boot/initramfs-$(uname -r).img | grep virtio');
  } else {
    const missing = ['virtio_blk or virtio_scsi', 'virtio_pci'].filter((m, i) => !(i === 0 ? hasDisk : hasPci));
    add('virtio', 'fail',
      `The boot image ${ird.file ? `(${ird.file}) ` : ''}lacks ${missing.join(' and ')}. On KVM the VM will stop at "cannot find root device". ` +
      `${(ird.onDisk || []).length ? 'The modules are installed, just not in the boot image.' : 'The modules are not installed either.'}`,
      virtioFix);
  }

  // ── Disks: names by order (sdX) or by VMware path move on another controller ──
  const fragile = g.mounts.filter((m) => DEVICE_PATH.test(m.device));
  const rootArg = g.bootArgs.root;
  const fragileBoot = (['root', 'resume'] as const)
    .map((k) => [k, g.bootArgs[k]] as const)
    .filter((kv): kv is readonly ['root' | 'resume', string] => !!kv[1] && DEVICE_PATH.test(kv[1]));
  if (!g.mounts.length && !rootArg) {
    add('disks', 'unknown', '/etc/fstab was not read.');
  } else if (fragile.length || fragileBoot.length) {
    const vmwareIds = [...fragile.map((m) => m.device), ...fragileBoot.map(([, v]) => v)].filter((d) => /by-(path|id)\//.test(d));
    add('disks', vmwareIds.length ? 'fail' : 'warn',
      `${[...fragile.map((m) => `${m.mount} → ${m.device}`), ...fragileBoot.map(([k, v]) => `boot loader ${k}=${v}`)].join('; ')}. ` +
      (vmwareIds.length
        ? 'Paths under /dev/disk/by-id or by-path name the VMware controller and will not exist on KVM.'
        : 'Works only if the new VM uses a virtio-scsi controller (disks stay /dev/sdX); with virtio-blk they become /dev/vdX and the mount fails.'),
      'blkid   # then use UUID=… in /etc/fstab (and root=UUID=… in the boot loader)');
  } else {
    add('disks', 'pass', `${g.mounts.length} fstab entr${g.mounts.length === 1 ? 'y' : 'ies'}; none depends on disk order or the VMware controller (UUID, label or LVM names).`);
  }

  // ── Network: VMware's PCI-slot names (ens192, ens160…) change; MACs change unless kept ──
  const nicNames = hw.nics.filter((n) => n.kind === 'physical').map((n) => n.name);
  const named = g.netConfigs.filter((c) => c.refs.some((r) => PREDICTABLE_NIC.test(r)));
  const staticNamed = named.filter((c) => c.isStatic && !c.dhcp);
  const macBound = g.netConfigs.filter((c) => c.macBound);
  const unreadableNet = g.netConfigs.filter((c) => c.unreadable);
  const keepsEth = g.bootArgs['net.ifnames'] === '0';
  const netNotes: string[] = [];
  let netStatus: ReadyStatus = 'pass';
  if (!onKvm && !keepsEth && staticNamed.length) {
    netStatus = 'fail';
    netNotes.push(`Static address tied to ${[...new Set(staticNamed.flatMap((c) => c.refs.filter((r) => PREDICTABLE_NIC.test(r))))].join(', ')} in ${staticNamed.map((c) => c.file).join(', ')}. The NIC will have a different name on KVM (e.g. enp1s0), so the VM comes up without its address.`);
  } else if (!onKvm && !keepsEth && named.length) {
    netStatus = 'warn';
    netNotes.push(`${named.map((c) => c.file).join(', ')} name${named.length === 1 ? 's' : ''} ${[...new Set(named.flatMap((c) => c.refs))].join(', ')}; DHCP, but the profile will not match the renamed NIC.`);
  }
  if (!onKvm && (macBound.length || g.udevNetRules)) {
    if (netStatus === 'pass') netStatus = 'warn';
    netNotes.push(`${[...macBound.map((c) => c.file), g.udevNetRules ? '/etc/udev/rules.d/70-persistent-net.rules' : ''].filter(Boolean).join(', ')} pin${macBound.length + (g.udevNetRules ? 1 : 0) === 1 ? 's' : ''} a MAC address: keep the MAC on the new VM, or remove the pin.`);
  }
  if (unreadableNet.length && netStatus === 'pass') {
    netStatus = 'unknown';
    netNotes.push(`${unreadableNet.length} config file${unreadableNet.length === 1 ? '' : 's'} could not be read without root.`);
  }
  if (!netNotes.length) {
    netNotes.push(keepsEth ? 'net.ifnames=0: interfaces keep eth* names on any hypervisor.'
      : g.netConfigs.length ? 'No config file pins a VMware interface name or a MAC.' : `No interface config files found (${nicNames.join(', ') || 'no NICs'}); likely DHCP via defaults.`);
  }
  add('network', netStatus, netNotes.join(' '),
    netStatus === 'fail' || netStatus === 'warn'
      ? 'After cutover: ip -br link   # then rename the profile to the new NIC (nmcli con mod <name> connection.interface-name <new>) or match it by MAC'
      : undefined);

  // ── Firmware: create the VME VM with the same firmware type ──
  if (g.efi === undefined) add('firmware', 'unknown', 'Boot firmware was not detected.');
  else add('firmware', 'info', g.efi
    ? `UEFI${g.secureBoot ? ' with Secure Boot on' : ''}: create the VME VM with UEFI firmware${g.secureBoot ? ' and Secure Boot' : ''}, or it will not boot.`
    : 'BIOS (legacy): create the VME VM with BIOS firmware.');

  // ── VMware Tools ──
  const svc = (re: RegExp) => g.services.filter((s) => re.test(s.unit));
  const legacyTools = svc(/^vmware-tools/);
  const openVmTools = svc(/^(vmtoolsd|open-vm-tools)/);
  if (legacyTools.length) {
    add('vmtools', 'warn', 'Legacy VMware Tools (tarball install) is present. It replaces kernel modules and is known to break boot on other hypervisors.',
      'vmware-uninstall-tools.pl   # before cutover; then use open-vm-tools if staying on VMware');
  } else if (openVmTools.length) {
    add('vmtools', 'info', `open-vm-tools${g.vmtoolsVersion ? ` ${g.vmtoolsVersion}` : ''} installed. It stays idle on KVM; remove it at cleanup.`);
  } else {
    add('vmtools', 'pass', 'No VMware Tools to clean up.');
  }

  // ── Guest agent: lets VME see IPs, quiesce disks and shut down cleanly ──
  const qga = svc(/^qemu-guest-agent/);
  if (!g.systemd && !g.services.length) add('agent', 'unknown', 'No systemd: could not tell whether qemu-guest-agent is installed.', 'command -v qemu-ga');
  else if (qga.length) add('agent', 'pass', `qemu-guest-agent installed${qga[0].state ? ` (${qga[0].state} — it starts once the virtio channel exists)` : ''}.`);
  else add('agent', 'warn', 'qemu-guest-agent is not installed: VME cannot report the VM\'s IPs, freeze the filesystem for snapshots, or shut it down cleanly.', pkgInstall(hw.os, 'qemu-guest-agent'));

  // ── Time: VMware Tools time sync stops with VMware ──
  const timeActive = svc(/^(chronyd?|ntpd?|ntpsec|systemd-timesyncd)/).filter((s) => s.state === 'active');
  if (timeActive.length) add('time', 'pass', `${timeActive.map((s) => s.unit.replace(/\.service$/, '')).join(', ')} keeps the clock.`);
  else if (g.vmtoolsTimeSync) add('time', 'fail', 'Only VMware Tools keeps the clock. After migration nothing will, and the clock drifts (TLS and Kerberos fail).', 'systemctl enable --now chronyd   # (chrony on Debian/Ubuntu)');
  else if (g.systemd || g.services.length) add('time', 'warn', 'No time service is running.', 'systemctl enable --now chronyd   # (chrony on Debian/Ubuntu)');
  else add('time', 'unknown', 'No systemd: could not tell which time service runs.', 'ps -e | grep -E "chrony|ntp"');

  // ── Passthrough devices need IOMMU on the target host ──
  if (hw.gpus.length) {
    add('passthrough', 'warn', `${hw.gpus.length} GPU${hw.gpus.length === 1 ? '' : 's'} passed through (${hw.gpus.map((x) => x.device).join(', ')}). The VME host needs the same GPU with IOMMU on — see Inventory.`);
  }

  // ── Data volume ──
  if (g.usedBytes !== undefined) {
    add('data', 'info', `${fmtBytes(g.usedBytes)} used of ${fmtBytes(g.sizeBytes)} on local filesystems${hw.disks.length ? ` (${fmtBytes(hw.disks.reduce((s, d) => s + d.sizeBytes, 0))} provisioned)` : ''}.`);
  }

  const verdict: Readiness['verdict'] = items.some((i) => i.status === 'fail') ? 'blocked'
    : items.some((i) => i.status === 'warn' || i.status === 'unknown') ? 'prep' : 'ready';
  return { verdict, items, dataBytes: g.usedBytes };
}

// ---------------------------------------------------------------------------
// Across hosts
// ---------------------------------------------------------------------------

export interface HwDrift {
  /** Which group the hosts were compared in: bare-metal servers, or VMs. */
  group: 'physical' | 'virtual';
  what: string;
  /** Why the difference matters. */
  why: string;
  values: Record<string, string>;
}

/** CPU flags that decide whether a VM can live-migrate between hosts. */
const MIGRATION_FLAGS = /^(avx|avx2|avx512.*|amx.*|sse4_1|sse4_2|ssse3|aes|pclmulqdq|sha_ni|fma|bmi1|bmi2|adx|rdseed|rdrand|f16c|movbe|xsave.*|vaes|vpclmulqdqd?|gfni|pku|la57|tsx.*|rtm|hle|clwb|clflushopt|invpcid|pcid|erms|fsrm|serialize|waitpkg|vmx|svm)$/;

/** Where hosts that should be interchangeable are not. */
export function findHardwareDrift(hosts: Record<string, HardwareInfo>): HwDrift[] {
  const out: HwDrift[] = [];
  for (const group of ['physical', 'virtual'] as const) {
    const members = Object.entries(hosts).filter(([, h]) => h.physical === (group === 'physical'));
    if (members.length < 2) continue;

    const diff = (what: string, why: string, pick: (h: HardwareInfo) => string | undefined, among = members) => {
      const values = Object.fromEntries(among.map(([n, h]) => [n, pick(h) ?? '—']));
      const known = Object.values(values).filter((v) => v !== '—');
      if (new Set(known).size > 1) out.push({ group, what, why, values });
    };

    diff('CPU model', 'VMs only live-migrate between hosts with the same CPU, or the cluster must use a common (older) CPU baseline.', (h) => h.cpu.model);

    // Feature flags: compare only the ones that matter for migration.
    const flagSets = members.map(([n, h]) => [n, new Set(h.cpu.flags.filter((f) => MIGRATION_FLAGS.test(f)))] as const).filter(([, s]) => s.size);
    if (flagSets.length >= 2) {
      const union = new Set(flagSets.flatMap(([, s]) => [...s]));
      const missing = Object.fromEntries(flagSets.map(([n, s]) => [n, [...union].filter((f) => !s.has(f)).sort()]));
      if (Object.values(missing).some((m) => m.length)) {
        out.push({
          group, what: 'CPU features',
          why: 'A VM started on a host with these features cannot move to one without them.',
          values: Object.fromEntries(Object.entries(missing).map(([n, m]) => [n, m.length ? `missing ${m.join(' ')}` : 'all'])),
        });
      }
    }

    diff('Kernel', 'Different kernels behave differently under the same load; a mid-way patch round shows up here.', (h) => h.kernel);
    diff('OS', 'Mixed OS releases complicate a uniform VME host build.', (h) => h.os);

    if (group === 'physical') {
      // Firmware only compares like with like: the same server model.
      const byModel = new Map<string, Array<[string, HardwareInfo]>>();
      for (const m of members) {
        const key = m[1].system.product || '?';
        byModel.set(key, [...(byModel.get(key) || []), m]);
      }
      for (const [model, same] of byModel) {
        if (same.length < 2) continue;
        diff(`System firmware (${model})`, 'Same server model on different BIOS levels: a known source of "only fails on that one host".', (h) => h.system.biosVersion, same);
        diff(`BMC / iLO firmware (${model})`, 'Out-of-band management on different firmware levels.', (h) => h.bmc.firmware, same);
        diff(`Memory (${model})`, 'Same model, different RAM — capacity planning assumes they match.', (h) => (h.memory.totalBytes ? fmtBytes(h.memory.totalBytes) : undefined), same);
        // NIC firmware per driver (e.g. all i40e ports should be on one level).
        const drivers = new Set(same.flatMap(([, h]) => h.nics.filter((n) => n.kind === 'physical' && n.driver && n.firmware).map((n) => n.driver!)));
        for (const drv of drivers) {
          diff(`NIC firmware — ${drv} (${model})`, 'NIC firmware mismatches cause flapping links and offload bugs on one host only.',
            (h) => [...new Set(h.nics.filter((n) => n.driver === drv && n.firmware).map((n) => n.firmware!))].sort().join(', ') || undefined, same);
        }
      }
    }
  }
  return out;
}

/** Fleet-wide totals for the capacity tiles. */
export function fleetTotals(hosts: HardwareInfo[]) {
  const phys = hosts.filter((h) => h.physical);
  const sum = (xs: Array<number | undefined>) => xs.reduce<number>((s, x) => s + (x || 0), 0);
  return {
    hosts: hosts.length,
    physical: phys.length,
    virtual: hosts.length - phys.length,
    sockets: sum(phys.map((h) => h.cpu.sockets)),
    cores: sum(hosts.map((h) => h.cpu.cores ?? h.cpu.logical)),
    threads: sum(hosts.map((h) => h.cpu.logical)),
    memoryBytes: sum(hosts.map((h) => h.memory.totalBytes)),
    diskBytes: sum(hosts.flatMap((h) => h.disks.map((d) => d.sizeBytes))),
    gpus: sum(hosts.map((h) => h.gpus.length)),
    guests: sum(hosts.map((h) => h.virtHost.guests.length)),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface HardwareResult {
  host: string;
  reachable: boolean;
  error?: string;
  at: string;
  hardware?: HardwareInfo;
  checks: HwCheck[];
  /** VMs only: how ready this guest is to move to VME. */
  readiness?: Readiness;
}

/** Fleet roll-up of the per-VM readiness verdicts. */
export function readinessSummary(results: Array<Pick<HardwareResult, 'readiness'>>) {
  const r = results.map((x) => x.readiness).filter((x): x is Readiness => !!x);
  return {
    vms: r.length,
    ready: r.filter((x) => x.verdict === 'ready').length,
    prep: r.filter((x) => x.verdict === 'prep').length,
    blocked: r.filter((x) => x.verdict === 'blocked').length,
    dataBytes: r.reduce((s, x) => s + (x.dataBytes || 0), 0),
  };
}

// Hardware barely changes; a long cache keeps the page cheap to reopen.
const CACHE_MS = 30 * 60_000;
const cache = new Map<string, HardwareResult>();

/** The last scan of a host, if recent — read by the insight engine without new SSH. */
export function cachedHardware(name: string, maxAgeMs = CACHE_MS): HardwareResult | undefined {
  const r = cache.get(name);
  return r && Date.now() - Date.parse(r.at) < maxAgeMs ? r : undefined;
}

export async function collectHardware(vm: VmEntry): Promise<HardwareResult> {
  const at = new Date().toISOString();
  const { stdout, stderr, ok } = await sshRun(vm, HARDWARE_CMD, 120_000, 1024 * 1024 * 4);
  if (!ok && !stdout.includes('===TRINETRA:')) {
    return { host: vm.name, reachable: false, error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 300), at, checks: [] };
  }
  const hardware = parseHardware(stdout);
  const result: HardwareResult = { host: vm.name, reachable: true, at, hardware, checks: analyzeHardware(hardware), readiness: assessReadiness(hardware) };
  cache.set(vm.name, result);
  return result;
}

export const hardwareRouter = Router();

/**
 * GET /api/hardware?vm=a,b   (default: every inventory VM)
 *   &fresh=1                 ignore the 30-minute cache
 */
hardwareRouter.get('/api/hardware', async (req, res) => {
  const wanted = String(req.query.vm || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.some((n) => !SAFE_NAME.test(n))) return res.status(400).json({ error: 'Invalid VM name.' });
  const fresh = req.query.fresh === '1';
  const all = await loadVms();
  const vms = all.filter((v) => !wanted.length || wanted.includes(v.name));
  if (!vms.length) {
    return res.json({
      hosts: [], drift: [], totals: fleetTotals([]), readiness: readinessSummary([]), at: new Date().toISOString(),
      note: all.length ? `${wanted.join(', ')} is not in the inventory.` : 'No hosts in the inventory — add servers and cluster nodes on the K8s Nodes tab.',
    });
  }

  // Three at a time, like Node Config: a big fleet must not open N SSH sessions at once.
  const results: HardwareResult[] = new Array(vms.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, vms.length) }, async () => {
    while (next < vms.length) {
      const i = next++;
      const vm = vms[i];
      results[i] = (!fresh && cachedHardware(vm.name)) || await collectHardware(vm).catch((e) => ({
        host: vm.name, reachable: false, error: String(e?.message || e), at: new Date().toISOString(), checks: [],
      }));
    }
  }));

  const read: Record<string, HardwareInfo> = {};
  for (const r of results) if (r.hardware) read[r.host] = r.hardware;
  res.json({
    hosts: results, drift: findHardwareDrift(read), totals: fleetTotals(Object.values(read)),
    readiness: readinessSummary(results), at: new Date().toISOString(),
  });
});
