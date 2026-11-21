// Hardware inventory: the parsers have to survive real lscpu / dmidecode /
// lsblk / lspci / multipath output, and the judging has to say the right thing
// about a bare-metal server and a VMware guest.

import { describe, it, expect } from 'vitest';
import {
  parseHardware, analyzeHardware, findHardwareDrift, fleetTotals, parseLscpu, parseDimms, parsePairs,
  parseMultipath, parsePci, isGpu, dmiSize, parseBonds, HARDWARE_CMD, assessReadiness, readinessSummary, type HardwareInfo,
} from '../hardware/inventory.js';
import { correlate } from '../insight/correlate.js';

const M = (tag: string) => `===TRINETRA:${tag}===`;

const FLAGS_SPR = 'fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe syscall nx pdpe1gb rdtscp lm constant_tsc vmx smx est tm2 ssse3 sdbg fma cx16 xtpr pdcm pcid dca sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand lahf_lm abm 3dnowprefetch invpcid avx2 bmi1 bmi2 erms rdseed adx smap clflushopt clwb avx512f avx512dq avx512cd avx512bw avx512vl sha_ni xsaveopt xsavec xgetbv1 xsaves amx_bf16 amx_tile amx_int8';

const metal = (opts: { host?: string; bios?: string; flags?: string; ue?: number; bondDown?: boolean; smartFail?: boolean; iommu?: number } = {}) => [
  M('SELF'), `HOST=${opts.host || 'dl380-01'}`, 'UID=0', 'NOW=1795000000', 'OS=Ubuntu 22.04.4 LTS', 'KERNEL=5.15.0-105-generic', 'ARCH=x86_64', 'VIRT=none',
  M('CPU'),
  'Architecture:                    x86_64',
  'CPU(s):                          128',
  'Vendor ID:                       GenuineIntel',
  'Model name:                      Intel(R) Xeon(R) Gold 6430',
  'Thread(s) per core:              2',
  'Core(s) per socket:              32',
  'Socket(s):                       2',
  'CPU max MHz:                     3400.0000',
  'Virtualization:                  VT-x',
  'L3 cache:                        120 MiB (2 instances)',
  'NUMA node(s):                    2',
  `Flags:                           ${opts.flags || FLAGS_SPR}`,
  'PROCMODEL= Intel(R) Xeon(R) Gold 6430', 'PROCFLAGS= fpu', 'PROCCOUNT=128', 'PROCSOCKETS=2',
  M('MEM'), 'MemTotal:       527990808 kB', 'SwapTotal:             0 kB', 'HugePages_Total:       0', 'Hugepagesize:       2048 kB',
  M('DIMM'),
  'Physical Memory Array', '\tMaximum Capacity: 8 TB', '\tError Correction Type: Multi-bit ECC', '\tNumber Of Devices: 32',
  'Memory Device', '\tSize: 32 GB', '\tLocator: PROC 1 DIMM 1', '\tType: DDR5', '\tSpeed: 4800 MT/s', '\tManufacturer: Hynix', '\tPart Number: HMCG88AEBRA115N', '\tConfigured Memory Speed: 4400 MT/s',
  'Memory Device', '\tSize: No Module Installed', '\tLocator: PROC 1 DIMM 2', '\tType: Unknown', '\tSpeed: Unknown', '\tManufacturer: NO DIMM', '\tPart Number: NO DIMM',
  'Memory Device', '\tSize: 64 GB', '\tLocator: PROC 2 DIMM 1', '\tType: DDR5', '\tSpeed: 4800 MT/s', '\tManufacturer: Samsung', '\tPart Number: M321R8GA0BB0-CQKZJ', '\tConfigured Memory Speed: 4800 MT/s',
  M('EDAC'), `MC=mc0 3 ${opts.ue ?? 0}`, 'MC=mc1 0 0',
  M('DMI'),
  'sys_vendor=HPE', 'product_name=ProLiant DL380 Gen11', 'product_serial=CZ2D1234AB', `bios_vendor=HPE`, `bios_version=${opts.bios || '2.10'}`,
  'bios_date=03/14/2021', 'chassis_type=23', 'board_name=ProLiant DL380 Gen11',
  M('NIC'),
  'NIC=ens1f0np0', 'KIND=physical', 'MAC=b4:7a:f1:00:00:01', 'STATE=up', 'SPEED=25000', 'MTU=9000', 'IP=', 'MASTER=bond0', 'PCI=0000:31:00.0', 'DRIVER=i40e', 'VFTOTAL=64', 'VFNUM=0', 'FIRMWARE=9.20 0x8000d95e 1.3429.0',
  'NIC=ens1f1np1', 'KIND=physical', 'MAC=b4:7a:f1:00:00:02', `STATE=${opts.bondDown ? 'down' : 'up'}`, `SPEED=${opts.bondDown ? '-1' : '25000'}`, 'MTU=1500', 'IP=', 'MASTER=bond0', 'PCI=0000:31:00.1', 'DRIVER=i40e', 'FIRMWARE=9.20 0x8000d95e 1.3429.0',
  'NIC=eno1', 'KIND=physical', 'MAC=94:40:c9:00:00:09', 'STATE=up', 'SPEED=1000', 'MTU=1500', 'IP=10.1.0.11/24 ', 'PCI=0000:02:00.0', 'DRIVER=tg3', 'FIRMWARE=5719-v1.46 NCSI v1.5.18.0',
  'NIC=bond0', 'KIND=bond', 'MAC=b4:7a:f1:00:00:01', 'STATE=up', 'SPEED=50000', 'MTU=9000', 'IP=10.2.0.11/24 ',
  M('BOND'),
  'BOND=bond0', 'Bonding Mode: IEEE 802.3ad Dynamic link aggregation', 'MII Status: up',
  'Slave Interface: ens1f0np0', 'MII Status: up', 'Speed: 25000 Mbps',
  'Slave Interface: ens1f1np1', `MII Status: ${opts.bondDown ? 'down' : 'up'}`, 'Speed: 25000 Mbps',
  M('DISK'),
  'NAME="sda" TYPE="disk" SIZE="480103981056" ROTA="0" MODEL="MR416i-o Gen11" SERIAL="PXTQ0ARH" TRAN="" VENDOR="HPE     " WWN="0x600508b1001c"',
  'NAME="nvme0n1" TYPE="disk" SIZE="3840755982336" ROTA="0" MODEL="VO003840KYDMT" SERIAL="S6LANA0T" TRAN="nvme" VENDOR="" WWN="eui.0025"',
  'NAME="loop0" TYPE="loop" SIZE="67108864" ROTA="0" MODEL="" SERIAL="" TRAN="" VENDOR="" WWN=""',
  'NAME="sr0" TYPE="rom" SIZE="1073741312" ROTA="1" MODEL="Virtual DVD-ROM" SERIAL="" TRAN="usb" VENDOR="HPE" WWN=""',
  M('SMART'),
  'DISK=sda', 'SMART Health Status: OK',
  'DISK=nvme0n1', `SMART overall-health self-assessment test result: ${opts.smartFail ? 'FAILED!' : 'PASSED'}`,
  M('MPATH'),
  'mpatha (3600c0ff00065e9b1a1b2c36101000000) dm-0 HPE,MSA 2060 FC',
  "size=2.0T features='1 queue_if_no_path' hwhandler='1 alua' wp=rw",
  "|-+- policy='service-time 0' prio=50 status=active",
  '| `- 1:0:0:1 sdb 8:16  active ready running',
  "`-+- policy='service-time 0' prio=10 status=enabled",
  '  `- 2:0:0:1 sdc 8:32  failed faulty running',
  M('SAN'), 'FC=host1 0x10005cba2c000001 Online 16_Gbit', 'FC=host2 0x10005cba2c000002 Linkdown unknown', 'InitiatorName=iqn.2004-10.com.ubuntu:01:abcdef', 'ISCSISESSIONS=0',
  M('PCI'),
  'DEV=0000:01:00.1|mgag200|"VGA compatible controller [0300]" "Matrox Electronics Systems Ltd. [102b]" "MGA G200eH3 [0538]" -r02 "Hewlett Packard Enterprise [1590]" "iLO6 [00e4]"',
  'DEV=0000:31:00.0|i40e|"Ethernet controller [0200]" "Intel Corporation [8086]" "Ethernet Controller XXV710 for 25GbE SFP28 [158b]" -r02 "Hewlett Packard Enterprise [1590]" "Ethernet 25Gb 2-port 661SFP28 Adapter [0000]"',
  'DEV=0000:ca:00.0|nvidia|"3D controller [0302]" "NVIDIA Corporation [10de]" "GH100 [H100 PCIe] [2331]" -ra1 "NVIDIA Corporation [10de]" "Device [1626]"',
  'DEV=0000:0b:00.0||"Fibre Channel [0c04]" "QLogic Corp. [1077]" "ISP2722-based 16/32Gb Fibre Channel to PCIe Adapter [2261]" -r01 "Hewlett Packard Enterprise [1590]" "SN1610Q 32Gb 2p FC HBA [00f8]"',
  M('VIRTHOST'), 'KVM=yes', 'NESTED=N', `IOMMUGROUPS=${opts.iommu ?? 0}`, 'CMDLINE=', 'LIBVIRT=8.0.0', 'VM=vm-101', 'VM=vm-102',
  'OVS=ovs-vsctl (Open vSwitch) 2.17.9', 'OVSBR=br-mgmt', 'OVSBR=br-data',
  'UNIT=libvirtd.service loaded active running Virtualization daemon', 'UNIT=morpheus-node.service loaded active running Morpheus Node',
  M('BMC'), 'Firmware Revision         : 1.55', 'Manufacturer Name         : Hewlett Packard Enterprise', 'IP Address              : 10.0.9.11', 'MAC Address             : 94:40:c9:00:00:aa',
  M('END'),
].join('\n');

const vmwareGuest = [
  M('SELF'), 'HOST=k8s-worker-3', 'UID=1000', 'NOW=1795000000', 'OS=SUSE Linux Enterprise Server 15 SP5', 'KERNEL=5.14.21-150500', 'ARCH=x86_64', 'VIRT=vmware',
  M('CPU'),
  'Architecture:            x86_64', 'CPU(s):                  16', 'Vendor ID:               GenuineIntel',
  'Model name:              Intel(R) Xeon(R) Gold 6430', 'Thread(s) per core:      1', 'Core(s) per socket:      1', 'Socket(s):               16',
  'Hypervisor vendor:       VMware', 'Virtualization type:     full', 'Flags:                   fpu vme sse4_2 avx avx2 aes',
  M('MEM'), 'MemTotal:       65842260 kB',
  M('DIMM'), M('EDAC'),
  M('DMI'), 'sys_vendor=VMware, Inc.', 'product_name=VMware7,1', 'bios_vendor=VMware, Inc.', 'bios_version=VMW71.00V.21100432.B64.2301110304',
  M('NIC'), 'NIC=ens192', 'KIND=physical', 'MAC=00:50:56:aa:bb:cc', 'STATE=up', 'SPEED=10000', 'MTU=1500', 'IP=10.3.0.23/24 ', 'PCI=0000:0b:00.0', 'DRIVER=vmxnet3',
  M('BOND'),
  M('DISK'), 'NAME="sda" TYPE="disk" SIZE="214748364800" ROTA="1" MODEL="Virtual disk" SERIAL="" TRAN="spi" VENDOR="VMware" WWN=""',
  M('SMART'), 'DISK=sda', 'SMART support is: Unavailable - device lacks SMART capability.',
  M('MPATH'), M('SAN'),
  M('PCI'), 'DEV=0000:03:00.0|vmw_pvscsi|"Serial Attached SCSI controller [0107]" "VMware [15ad]" "PVSCSI SCSI Controller [07c0]" -r02 "VMware [15ad]" "PVSCSI SCSI Controller [07c0]"',
  M('VIRTHOST'), 'IOMMUGROUPS=0', 'CMDLINE=',
  M('BMC'),
  M('END'),
].join('\n');

/** A VMware guest with the guest-side sections, in a good or a troubled state. */
const vmGuest = (o: { bad?: boolean; initrd?: string[]; os?: string } = {}) => [
  vmwareGuest.replace(M('END'), '').replace('HOST=k8s-worker-3', 'HOST=app-01').replace('UID=1000', 'UID=0')
    .replace('OS=SUSE Linux Enterprise Server 15 SP5', `OS=${o.os || 'Red Hat Enterprise Linux 8.9 (Ootpa)'}`),
  M('BOOT'), o.bad ? 'EFI=no' : 'EFI=yes', ...(o.bad ? [] : ['SECUREBOOT=1']),
  o.bad ? 'ARG=root=/dev/sda2' : 'ARG=root=/dev/mapper/rhel-root', 'ARG=resume=UUID=1111-2222',
  M('INITRD'), 'FILE=/boot/initramfs-4.18.0-513.el8.x86_64.img',
  ...(o.initrd || (o.bad
    ? ['TOOL=dracut', 'ONDISK=virtio_blk', 'ONDISK=virtio_net', 'ONDISK=virtio_pci', 'ONDISK=virtio_scsi', 'HAVE=dracut']
    : ['TOOL=dracut', 'MOD=virtio_blk', 'MOD=virtio_pci', 'MOD=virtio_scsi', 'MOD=virtio_net', 'ONDISK=virtio_net', 'HAVE=dracut'])),
  M('FSTAB'),
  ...(o.bad
    ? ['MNT=/dev/sda2 / xfs', 'MNT=/dev/disk/by-id/scsi-36000c29f1a2b3c4d-part1 /data xfs', 'MNT=UUID=abcd /boot xfs', 'MNT=/dev/sda3 swap swap']
    : ['MNT=/dev/mapper/rhel-root / xfs', 'MNT=UUID=abcd /boot xfs', 'MNT=LABEL=data /data xfs', 'MNT=tmpfs /tmp tmpfs']),
  M('NETCFG'),
  ...(o.bad
    ? ['FILE=/etc/sysconfig/network-scripts/ifcfg-ens192', 'REF=ens192', 'MACBOUND=1', 'STATIC=1', 'FILE=/etc/NetworkManager/system-connections/old.nmconnection', 'UNREADABLE=1', 'UDEVNET=1']
    : ['FILE=/etc/NetworkManager/system-connections/eth.nmconnection', 'DHCP=1']),
  M('AGENTS'),
  ...(o.bad
    ? ['SYSTEMD=yes', 'SVC=vmware-tools.service active', 'VMTOOLSVER=10.3.10.10540 (build-12406962)', 'VMTIMESYNC=Enabled']
    : ['SYSTEMD=yes', 'SVC=vmtoolsd.service active', 'SVC=qemu-guest-agent.service inactive', 'SVC=chronyd.service active', 'VMTOOLSVER=12.3.5.46049 (build-22544099)', 'VMTIMESYNC=Disabled']),
  M('USAGE'), 'USED=96636764160', 'SIZE=214748364800',
  M('END'),
].join('\n');

describe('hardware probe', () => {
  it('is one fixed script with every section and no shell ${} expansion', () => {
    for (const tag of ['SELF', 'CPU', 'MEM', 'DIMM', 'EDAC', 'DMI', 'NIC', 'BOND', 'DISK', 'SMART', 'MPATH', 'SAN', 'PCI', 'VIRTHOST', 'BMC', 'END']) {
      expect(HARDWARE_CMD).toContain(`===TRINETRA:${tag}===`);
    }
    expect(HARDWARE_CMD).not.toContain('${');
    // Read-only: nothing that writes, loads or changes state.
    expect(HARDWARE_CMD).not.toMatch(/\b(modprobe|rm|mv|dd|tee|ethtool -s|smartctl -t|virsh (start|destroy|shutdown)|ovs-vsctl (add|del|set))\b/);
  });
});

describe('parseHardware — bare-metal ProLiant', () => {
  const hw = parseHardware(metal());

  it('reads the identity and CPU', () => {
    expect(hw.physical).toBe(true);
    expect(hw.system).toMatchObject({ vendor: 'HPE', product: 'ProLiant DL380 Gen11', serial: 'CZ2D1234AB', biosVersion: '2.10', chassisType: 'Rack mount' });
    expect(hw.cpu).toMatchObject({ model: 'Intel(R) Xeon(R) Gold 6430', sockets: 2, coresPerSocket: 32, cores: 64, logical: 128, numaNodes: 2, maxMhz: 3400, virtualization: 'VT-x' });
    expect(hw.cpu.flags).toContain('avx512f');
  });

  it('reads memory slots, skipping empty ones', () => {
    expect(hw.memory.totalBytes).toBe(527990808 * 1024);
    expect(hw.memory.slots).toBe(3);
    expect(hw.memory.populated).toBe(2);
    expect(hw.memory.dimms[0]).toEqual({ locator: 'PROC 1 DIMM 1', sizeBytes: 32 * 1024 ** 3, type: 'DDR5', speed: '4400 MT/s', manufacturer: 'Hynix', part: 'HMCG88AEBRA115N' });
    expect(hw.memory.ecc).toBe('Multi-bit ECC');
    expect(hw.memory.edac).toEqual([{ mc: 'mc0', ce: 3, ue: 0 }, { mc: 'mc1', ce: 0, ue: 0 }]);
  });

  it('reads NICs, bonds, disks, SAN and PCI', () => {
    expect(hw.nics.map((n) => n.name)).toEqual(['ens1f0np0', 'ens1f1np1', 'eno1', 'bond0']);
    expect(hw.nics[0]).toMatchObject({ speedMbps: 25000, driver: 'i40e', firmware: '9.20 0x8000d95e 1.3429.0', master: 'bond0', sriovTotal: 64 });
    expect(hw.nics[2].ips).toEqual(['10.1.0.11/24']);
    expect(hw.bonds[0].slaves).toHaveLength(2);
    expect(hw.disks.map((d) => d.name)).toEqual(['sda', 'nvme0n1']); // no loop, no DVD
    expect(hw.disks[0]).toMatchObject({ vendor: 'HPE', smart: 'passed', rotational: false });
    expect(hw.disks[1].smart).toBe('passed');
    expect(hw.multipath).toMatchObject({ maps: 1, activePaths: 1, failedPaths: 1 });
    expect(hw.fc[0]).toEqual({ host: 'host1', wwpn: '0x10005cba2c000001', state: 'Online', speed: '16 Gbit' });
    expect(hw.iscsi).toEqual({ initiator: 'iqn.2004-10.com.ubuntu:01:abcdef', sessions: 0 });
    expect(hw.pci).toHaveLength(4);
    expect(hw.gpus.map((g) => g.device)).toEqual(['GH100 [H100 PCIe]']); // not the iLO's Matrox VGA
    expect(hw.pci[3].driver).toBeUndefined();
  });

  it('reads the virtualization stack and the BMC', () => {
    expect(hw.virtHost).toMatchObject({ kvm: true, libvirt: '8.0.0', guests: ['vm-101', 'vm-102'], ovsBridges: ['br-mgmt', 'br-data'] });
    expect(hw.virtHost.units).toContainEqual({ unit: 'morpheus-node.service', active: 'active', sub: 'running' });
    expect(hw.bmc).toEqual({ firmware: '1.55', manufacturer: 'Hewlett Packard Enterprise', ip: '10.0.9.11', mac: '94:40:c9:00:00:aa' });
  });
});

describe('analyzeHardware', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');

  it('flags the real problems on a server', () => {
    const checks = analyzeHardware(parseHardware(metal({ ue: 2, bondDown: true, smartFail: true })), now);
    const ids = checks.map((c) => c.id);
    expect(checks.find((c) => c.id === 'mem-ue')?.status).toBe('critical');
    expect(checks.find((c) => c.id === 'disk-smart-nvme0n1')?.status).toBe('critical');
    expect(checks.find((c) => c.id === 'bond-bond0')?.status).toBe('warning');
    expect(checks.find((c) => c.id === 'mpath-failed')?.status).toBe('warning');
    expect(checks.find((c) => c.id === 'fc-host2')?.status).toBe('warning');
    expect(checks.find((c) => c.id === 'iommu-off')?.status).toBe('warning'); // H100 present, no IOMMU groups
    expect(checks.find((c) => c.id === 'license-sockets')?.title).toMatch(/^2 CPU sockets/);
    expect(ids).toContain('nic-slow'); // eno1 at 1 Gb/s
    expect(ids).toContain('mtu-bond0'); // 9000 vs 1500
    expect(ids).toContain('mem-mixed');
    expect(ids).toContain('bios-old');
    expect(ids).not.toContain('access-root');
    expect(ids).not.toContain('virt-guest');
  });

  it('is quiet about IOMMU when it is on, and loud when VT-x is off', () => {
    expect(analyzeHardware(parseHardware(metal({ iommu: 180 })), now).map((c) => c.id)).not.toContain('iommu-off');
    const noVt = analyzeHardware(parseHardware(metal({ flags: 'fpu sse4_2 avx avx2' })), now);
    expect(noVt.find((c) => c.id === 'cpu-no-vt')?.status).toBe('critical');
  });

  it('treats a VMware guest as a migration candidate, not a server', () => {
    const hw = parseHardware(vmwareGuest);
    expect(hw.physical).toBe(false);
    expect(hw.cpu.hypervisor).toBe('VMware');
    expect(hw.disks[0].smart).toBe('unavailable');
    const checks = analyzeHardware(hw, now);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain('virt-guest');
    expect(ids).toContain('vmware-devices');
    expect(ids).toContain('access-root');
    expect(ids).not.toContain('license-sockets'); // vSockets are not licence sockets
    expect(ids).not.toContain('cpu-no-vt');
    expect(checks.every((c) => c.status === 'info')).toBe(true);
  });
});

describe('migration readiness', () => {
  const byId = (r: ReturnType<typeof assessReadiness>) => Object.fromEntries((r?.items || []).map((i) => [i.id, i]));

  it('parses the guest sections without reading file contents', () => {
    const g = parseHardware(vmGuest({ bad: true })).guest;
    expect(g.efi).toBe(false);
    expect(g.bootArgs).toEqual({ root: '/dev/sda2', resume: 'UUID=1111-2222' });
    expect(g.initramfs).toMatchObject({ file: '/boot/initramfs-4.18.0-513.el8.x86_64.img', tool: 'dracut', builder: 'dracut', modules: [] });
    expect(g.mounts).toHaveLength(4);
    expect(g.netConfigs[0]).toEqual({ file: '/etc/sysconfig/network-scripts/ifcfg-ens192', refs: ['ens192'], macBound: true, isStatic: true, dhcp: false });
    expect(g.netConfigs[1].unreadable).toBe(true);
    expect(g.udevNetRules).toBe(true);
    expect(g.vmtoolsTimeSync).toBe(true);
    expect(g.usedBytes).toBe(96636764160);
  });

  it('blocks a VM that would not boot or reach the network on KVM — and says how to fix it', () => {
    const r = assessReadiness(parseHardware(vmGuest({ bad: true })))!;
    const i = byId(r);
    expect(r.verdict).toBe('blocked');
    expect(i.virtio.status).toBe('fail');
    expect(i.virtio.detail).toMatch(/installed, just not in the boot image/);
    expect(i.virtio.fix).toMatch(/^dracut -f --add-drivers/);
    expect(i.disks.status).toBe('fail'); // by-id path names the VMware controller
    expect(i.disks.detail).toMatch(/\/data → \/dev\/disk\/by-id/);
    expect(i.network.status).toBe('fail'); // static IP on ens192
    expect(i.network.detail).toMatch(/pin.*MAC/);
    expect(i.firmware).toMatchObject({ status: 'info', detail: expect.stringMatching(/^BIOS/) });
    expect(i.vmtools.status).toBe('warn'); // legacy tarball tools
    expect(i.agent.fix).toBe('dnf install -y qemu-guest-agent');
    expect(i.time.status).toBe('fail'); // only VMware Tools keeps the clock
    expect(i.data.detail).toMatch(/^90 GiB used of 200 GiB/);
    expect(r.dataBytes).toBe(96636764160);
  });

  it('passes a prepared VM', () => {
    const r = assessReadiness(parseHardware(vmGuest()))!;
    const i = byId(r);
    expect(i.virtio.status).toBe('pass');
    expect(i.disks.status).toBe('pass');
    expect(i.network.status).toBe('pass');
    expect(i.firmware.detail).toMatch(/UEFI with Secure Boot/);
    expect(i.vmtools.status).toBe('info'); // open-vm-tools idles on KVM
    expect(i.agent.status).toBe('pass');
    expect(i.time.status).toBe('pass');
    expect(r.verdict).toBe('ready');
  });

  it('only warns about /dev/sdX (fine with virtio-scsi) and picks the right rebuild tool', () => {
    const out = vmGuest({ os: 'Ubuntu 22.04.4 LTS', initrd: ['TOOL=initramfs-tools', 'MOD=virtio_pci', 'HAVE=initramfs-tools'] })
      .replace('MNT=LABEL=data /data xfs', 'MNT=/dev/sdb1 /data xfs');
    const i = byId(assessReadiness(parseHardware(out)));
    expect(i.disks.status).toBe('warn');
    expect(i.disks.detail).toMatch(/virtio-scsi/);
    expect(i.virtio.status).toBe('fail');
    expect(i.virtio.fix).toMatch(/update-initramfs -u$/);
  });

  it('says "unknown" rather than guessing when the initramfs needs root', () => {
    const i = byId(assessReadiness(parseHardware(vmGuest({ initrd: ['UNREADABLE=1'] }))));
    expect(i.virtio.status).toBe('unknown');
    expect(i.virtio.fix).toMatch(/Root access/);
  });

  it('trusts built-in virtio and net.ifnames=0', () => {
    const out = vmGuest({ bad: true, initrd: ['TOOL=none', 'BUILTIN=virtio_blk', 'BUILTIN=virtio_pci', 'BUILTIN=virtio_net'] })
      .replace('ARG=resume=UUID=1111-2222', 'ARG=net.ifnames=0');
    const i = byId(assessReadiness(parseHardware(out)));
    expect(i.virtio.status).toBe('pass');
    expect(i.network.status).toBe('warn'); // the MAC pin still matters
  });

  it('says "unknown" instead of "missing" when there is no systemd to ask', () => {
    const out = vmGuest().replace(/===TRINETRA:AGENTS===[\s\S]*?===TRINETRA:USAGE===/, '===TRINETRA:AGENTS===\n===TRINETRA:USAGE===');
    const i = byId(assessReadiness(parseHardware(out)));
    expect(i.agent.status).toBe('unknown');
    expect(i.time.status).toBe('unknown');
    const withSystemd = byId(assessReadiness(parseHardware(out.replace('===TRINETRA:AGENTS===', '===TRINETRA:AGENTS===\nSYSTEMD=yes'))));
    expect(withSystemd.agent.status).toBe('warn');
    expect(withSystemd.time.status).toBe('warn');
  });

  it('is not assessed on bare metal, and rolls up across the fleet', () => {
    expect(assessReadiness(parseHardware(metal()))).toBeUndefined();
    const s = readinessSummary([
      { readiness: assessReadiness(parseHardware(vmGuest({ bad: true }))) },
      { readiness: assessReadiness(parseHardware(vmGuest())) },
      { readiness: undefined },
    ]);
    expect(s).toEqual({ vms: 2, ready: 1, prep: 0, blocked: 1, dataBytes: 2 * 96636764160 });
  });

  it('keeps the probe sections read-only and quiet about file contents', () => {
    for (const tag of ['BOOT', 'INITRD', 'FSTAB', 'NETCFG', 'AGENTS', 'USAGE']) expect(HARDWARE_CMD).toContain(`===TRINETRA:${tag}===`);
    expect(HARDWARE_CMD).not.toMatch(/dracut -f|update-initramfs -u|nmcli con mod/); // fixes are hints only
    expect(HARDWARE_CMD).toMatch(/print "MNT=" \$1 " " \$2 " " \$3/); // never the fstab options column
  });
});

describe('findHardwareDrift', () => {
  it('finds firmware and CPU-feature differences between identical servers', () => {
    const a = parseHardware(metal({ host: 'a' }));
    const b = parseHardware(metal({ host: 'b', bios: '1.48', flags: FLAGS_SPR.replace(/ amx_\w+/g, '') }));
    b.nics[0].firmware = '8.70 0x8000c40f 1.3354.0';
    const drift = findHardwareDrift({ a, b });
    const what = drift.map((d) => d.what);
    expect(what).toContain('System firmware (ProLiant DL380 Gen11)');
    expect(what).toContain('NIC firmware — i40e (ProLiant DL380 Gen11)');
    const flags = drift.find((d) => d.what === 'CPU features')!;
    expect(flags.values).toEqual({ a: 'all', b: 'missing amx_bf16 amx_int8 amx_tile' });
    expect(what).not.toContain('CPU model');
  });

  it('never compares a server with a VM', () => {
    expect(findHardwareDrift({ a: parseHardware(metal()), g: parseHardware(vmwareGuest) })).toEqual([]);
  });
});

describe('fleetTotals', () => {
  it('counts licence sockets on bare metal only', () => {
    const t = fleetTotals([parseHardware(metal()), parseHardware(vmwareGuest)]);
    expect(t).toMatchObject({ hosts: 2, physical: 1, virtual: 1, sockets: 2, gpus: 1, guests: 2 });
    expect(t.threads).toBe(144);
  });
});

describe('small parsers', () => {
  it('dmiSize', () => {
    expect(dmiSize('32 GB')).toBe(32 * 1024 ** 3);
    expect(dmiSize('16384 MB')).toBe(16 * 1024 ** 3);
    expect(dmiSize('No Module Installed')).toBeUndefined();
  });
  it('parsePairs handles spaces and escapes', () => {
    expect(parsePairs('NAME="sda" MODEL="Virtual\\x20disk" SIZE="1"')).toEqual({ NAME: 'sda', MODEL: 'Virtual disk', SIZE: '1' });
  });
  it('parseLscpu falls back to /proc/cpuinfo', () => {
    const c = parseLscpu(['PROCMODEL= AMD EPYC 9354', 'PROCFLAGS= fpu svm avx2', 'PROCCOUNT=64', 'PROCSOCKETS=1']);
    expect(c).toMatchObject({ model: 'AMD EPYC 9354', logical: 64, sockets: 1, virtualization: 'AMD-V' });
  });
  it('spots a guest by the CPU hypervisor flag when systemd-detect-virt is missing', () => {
    const guest = parseHardware([M('SELF'), 'HOST=x', 'VIRT=', M('CPU'), 'PROCFLAGS= fpu vmx hypervisor avx2', M('DMI'), 'sys_vendor=Dell Inc.', M('END')].join('\n'));
    expect(guest).toMatchObject({ physical: false, virt: 'guest' });
    const unknown = parseHardware([M('SELF'), 'HOST=y', M('CPU'), 'PROCFLAGS= fpu vmx', M('END')].join('\n'));
    expect(unknown.physical).toBe(false);
    expect(analyzeHardware(unknown).map((c) => c.id)).toContain('virt-unknown');
  });
  it('parseDimms without dmidecode', () => {
    expect(parseDimms(['NODMIDECODE=1'], ['MemTotal: 1024 kB'])).toMatchObject({ noDmi: true, totalBytes: 1024 * 1024, dimms: [] });
  });
  it('parseMultipath with no maps', () => {
    expect(parseMultipath([])).toEqual({ maps: 0, activePaths: 0, failedPaths: 0, text: [] });
  });
  it('parsePci / isGpu', () => {
    const { pci } = parsePci(['DEV=0000:41:00.0|vfio-pci|"VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Aldebaran/MI200 [740c]"']);
    expect(pci[0]).toMatchObject({ driver: 'vfio-pci', vendorId: '1002', classCode: '0300' });
    expect(isGpu(pci[0])).toBe(true);
  });
  it('parseBonds keeps the bond status apart from the slaves', () => {
    const [b] = parseBonds(['BOND=bond1', 'Bonding Mode: active-backup', 'MII Status: up', 'Slave Interface: eth0', 'MII Status: down']);
    expect(b).toEqual({ name: 'bond1', mode: 'active-backup', mii: 'up', slaves: [{ name: 'eth0', mii: 'down' }] });
  });
});

describe('insight engine', () => {
  it('turns hardware warnings into issues with hardware evidence', () => {
    const checks = analyzeHardware(parseHardware(metal({ ue: 1, bondDown: true })), Date.parse('2026-11-20T00:00:00Z'));
    const issues = correlate({ subject: 'dl380-01', hardware: checks });
    const hwIssue = issues.find((i) => i.concern === 'hardware');
    expect(hwIssue?.severity).toBe('critical');
    expect(hwIssue?.evidence.every((e) => e.kind === 'hardware')).toBe(true);
    expect(issues.find((i) => i.concern === 'network')).toBeTruthy();
  });
});
