// Unit tests for the Host Logs system overview: command-output parsers, the
// health checklist, service-name validation and finding → unit linking.
// Run with: npm test

import { describe, it, expect } from 'vitest';
import {
  parseFree, parseDf, parseUnits, parsePs, parseSs, parseKv, buildHealth, unitsForLines, safeServiceUnit,
  type SystemOverview,
} from '../hostlogs/system.js';

const GB = 1024 ** 3;

const UNITS = parseUnits([
  'kubelet.service            loaded active   running Kubernetes Kubelet',
  '● containerd.service       loaded failed   failed  containerd container runtime',
  'ssh.service                loaded active   running OpenBSD Secure Shell server',
  'nginx.service              loaded inactive dead    A high performance web server',
  'foo.socket                 loaded active   listening not a service',
]);

function overview(over: Partial<Omit<SystemOverview, 'health'>> = {}): Omit<SystemOverview, 'health'> {
  return {
    hostname: 'n1', os: 'Ubuntu', kernel: '6.8', arch: 'x86_64', virt: 'kvm', uptime: '3 days', bootedAt: '', uptimeSec: 300000,
    cpus: 8, load: [1, 1, 1],
    memory: { total: 32 * GB, used: 8 * GB, available: 20 * GB, swapTotal: 0, swapUsed: 0 },
    filesystems: [{ source: '/dev/sda1', type: 'ext4', mount: '/', size: 100 * GB, used: 50 * GB, avail: 50 * GB, usePct: 50, inodesPct: 10 }],
    services: [], topMemory: [], topCpu: [], ports: [], timeSynced: true, timezone: 'UTC', journalDisk: '', reboots: [], runsAsRoot: true,
    ...over,
  };
}

describe('parsers', () => {
  it('parseFree reads memory and swap', () => {
    const m = parseFree([
      '               total        used        free      shared  buff/cache   available',
      'Mem:     34359738368  8589934592  4294967296   1000  21474836480 25769803776',
      'Swap:     2147483648  1073741824  1073741824',
    ]);
    expect(m.total).toBe(34359738368);
    expect(m.available).toBe(25769803776);
    expect(m.swapUsed).toBe(1073741824);
  });

  it('parseDf joins inode usage by mount', () => {
    const fs = parseDf(
      ['/dev/sda1 ext4 107374182400 96636764160 10737418240 91% /', '/dev/sdb1 xfs 1000 100 900 10% /var/lib/data dir'],
      ['/dev/sda1 6000000 5700000 300000 95% /'],
    );
    expect(fs).toHaveLength(2);
    expect(fs[0]).toMatchObject({ mount: '/', usePct: 91, inodesPct: 95, type: 'ext4' });
    expect(fs[1].mount).toBe('/var/lib/data dir');
  });

  it('parseUnits keeps services only, strips the failed bullet and flags critical units', () => {
    expect(UNITS.map((u) => u.unit)).toEqual(['kubelet.service', 'containerd.service', 'ssh.service', 'nginx.service']);
    expect(UNITS[1]).toMatchObject({ active: 'failed', critical: true, description: 'containerd container runtime' });
    expect(UNITS[3].critical).toBe(false);
  });

  it('parsePs and parseSs', () => {
    expect(parsePs(['  812 root 12.5  3.1 1048576 containerd'])[0]).toMatchObject({ pid: 812, cpu: 12.5, command: 'containerd' });
    const ports = parseSs([
      'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=900,fd=3))',
      'tcp LISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=900,fd=4))',
      'tcp LISTEN 0 4096 127.0.0.1:10248 0.0.0.0:* users:(("kubelet",pid=1,fd=9))',
    ]);
    expect(ports.map((p) => [p.port, p.process])).toEqual([['22', 'sshd'], ['10248', 'kubelet']]);
  });

  it('parseKv', () => {
    expect(parseKv(['NTPSynchronized=yes', 'OS=Ubuntu 24.04 LTS', 'junk'])).toEqual({ NTPSynchronized: 'yes', OS: 'Ubuntu 24.04 LTS' });
  });
});

describe('buildHealth', () => {
  it('is all ok on a healthy host', () => {
    const h = buildHealth(overview({ services: UNITS.filter((u) => u.active === 'active') }));
    expect(h.every((c) => c.status === 'ok')).toBe(true);
  });

  it('flags full disk, low memory, overload, failed critical unit and clock, most severe first', () => {
    const h = buildHealth(overview({
      filesystems: [{ source: 'x', type: 'ext4', mount: '/', size: 100 * GB, used: 95 * GB, avail: 5 * GB, usePct: 95, inodesPct: 85 }],
      memory: { total: 32 * GB, used: 30 * GB, available: 2 * GB, swapTotal: 4 * GB, swapUsed: 3 * GB },
      load: [30, 20, 10],
      services: UNITS,
      timeSynced: false,
      runsAsRoot: false,
    }));
    const byId = Object.fromEntries(h.map((c) => [c.id, c]));
    expect(byId['disk:/'].status).toBe('critical');
    expect(byId['inode:/'].status).toBe('warning');
    expect(byId.memory.status).toBe('critical');
    expect(byId.swap.status).toBe('warning');
    expect(byId.load.status).toBe('critical');
    expect(byId['failed:containerd.service']).toMatchObject({ status: 'critical', unit: 'containerd.service' });
    expect(byId.time.status).toBe('warning');
    expect(byId.root.status).toBe('info');
    expect(h[0].status).toBe('critical');
    expect(h[h.length - 1].status).not.toBe('critical');
  });

  it('ignores snap / squashfs mounts that are always 100%', () => {
    const h = buildHealth(overview({
      filesystems: [
        { source: 'a', type: 'ext4', mount: '/', size: 10 * GB, used: 1 * GB, avail: 9 * GB, usePct: 10 },
        { source: 'b', type: 'squashfs', mount: '/snap/core/1', size: GB, used: GB, avail: 0, usePct: 100 },
      ],
    }));
    expect(h.find((c) => c.id.startsWith('disk'))?.status).toBe('ok');
  });
});

describe('safeServiceUnit', () => {
  it('normalizes and accepts real unit names', () => {
    expect(safeServiceUnit('kubelet')).toBe('kubelet.service');
    expect(safeServiceUnit('getty@tty1.service')).toBe('getty@tty1.service');
    expect(safeServiceUnit('systemd-fsck@dev-disk-by\\x2duuid.service')).toBe('systemd-fsck@dev-disk-by\\x2duuid.service');
  });
  it('rejects injection and options', () => {
    for (const u of ['kubelet; reboot', '$(id)', 'a b', '--force', '', 'x`y`', 42]) expect(safeServiceUnit(u), String(u)).toBeNull();
  });
});

describe('unitsForLines', () => {
  it('links syslog identifiers, explicit unit names and systemd descriptions', () => {
    expect(unitsForLines(['Sep 17 10:02:03 node1 kubelet[900]: E0917 PLEG is not healthy'], UNITS)).toEqual(['kubelet.service']);
    expect(unitsForLines(['2026-09-17T10:02:03+0000 node1 systemd[1]: containerd.service: Main process exited, code=exited'], UNITS)).toEqual(['containerd.service']);
    expect(unitsForLines(['Sep 17 10:02:03 node1 systemd[1]: Failed to start A high performance web server.'], UNITS)).toEqual(['nginx.service']);
    expect(unitsForLines(['Sep 17 10:02:03 node1 sshd[2001]: Invalid user admin from 1.2.3.4'], UNITS)).toEqual(['ssh.service']);
  });
  it('does not invent units for kernel lines or unknown programs', () => {
    expect(unitsForLines(['Sep 17 10:02:03 node1 kernel: Out of memory: Killed process 1'], UNITS)).toEqual([]);
    expect(unitsForLines(['Sep 17 10:02:03 node1 myapp[1]: error'], UNITS)).toEqual([]);
  });
});
