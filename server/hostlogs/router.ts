// Host Logs: browse, scan and download /var/log on inventory VMs over SSH.
//
// Read-only by construction: every command below lists, reads or archives
// files under /var/log (plus journalctl/dmesg). Paths from the browser are
// validated by safeLogPath and shell-quoted; the VM is always looked up by name
// in the inventory, never taken as a raw host.

import { Router } from 'express';
import path from 'path';
import { loadVms, sshRun, vmReachable, type VmEntry } from '../vms.js';
import { shQuote } from '../ssh.js';
import {
  scanSources, safeLogPath, isCompressed, isBinaryLog, LOG_RULES,
} from './rules.js';
import {
  parseKv, parseFree, parseDf, parseUnits, parsePs, parseSs, buildHealth, unitsForLines,
  safeServiceUnit, baseName, ACCESS_UNITS, type SystemOverview,
} from './system.js';
import {
  buildJournalCommand, buildCheckCommand, splitCursor, parseBoots, PRIORITIES, OUTPUT_MODES, type JournalQuery,
} from './journal.js';

export const logsRouter = Router();

const MB = 1024 * 1024;
const BUNDLE_MAX_BYTES = Math.max(1, Number(process.env.KALAM_LOG_BUNDLE_MAX_MB || 50)) * MB;
const SCAN_MAX_FILES = 40;
const SCAN_TAIL_LINES = 5000;
const SCAN_KEEP_LINES = 2000;
const WINDOWS_HOURS = new Set([1, 6, 24, 72, 168, 720]);

// Virtual sources that are not files under /var/log.
const JOURNAL = 'journal';
const DMESG = 'dmesg';

// Cheap remote pre-filter so only candidate lines cross the wire. Every rule in
// rules.ts must be reachable through at least one of these keywords — the unit
// tests assert that for each rule's sample lines. Plain literals only, so the
// same string is valid as grep -E and as a JS RegExp.
export const PREFILTER = [
  'err', 'fail', 'warn', 'crit', 'fatal', 'panic', 'emerg', 'alert', 'denied', 'refused',
  'timeout', 'timed out', 'exception', 'unable', 'oom', 'out of memory', 'killed process',
  'no space', 'enospc', 'quota', 'diskpressure', 'evict', 'corrupt', 'read-only', 'remount',
  'lockup', 'hung_task', 'blocked for more', 'bug:', 'call trace', 'protection fault',
  'machine check', 'mce', 'edac', 'aer:', 'xid', 'fallen off', 'segfault', 'core dump', 'dumped core', 'trap',
  'invalid user', 'break-in', 'identification string', 'authenticating user', 'not in sudoers',
  'expired', 'x509', 'tls:', 'ssl', 'clock', 'time jump', 'time has been changed', 'synchronise', 'unreachable', 'no servers',
  'link is down', 'link is not ready', 'carrier', 'table full', 'overflow', 'dropping', 'name resolution',
  'backoff', 'pleg', 'not ready', 'not found', 'repeated too quickly', 'exited, code', 'deprecated',
].join('|');

// ---- helpers ---------------------------------------------------------------

async function findVm(name: unknown): Promise<VmEntry | undefined> {
  if (typeof name !== 'string') return undefined;
  return (await loadVms()).find((v) => v.name === name);
}

// Output blocks are delimited by marker lines rather than server/vms.ts's
// `@@TAG@@` sections, because log text itself can contain "@@".
const MARK = '===KALAM:';
export function splitMarked(stdout: string): Array<{ tag: string; arg: string; body: string[] }> {
  const out: Array<{ tag: string; arg: string; body: string[] }> = [];
  let cur: { tag: string; arg: string; body: string[] } | null = null;
  for (const line of stdout.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.startsWith(MARK) ? line.match(/^===KALAM:([A-Z]+)(?::(.*))?===$/) : null;
    if (m) {
      cur = { tag: m[1], arg: m[2] || '', body: [] };
      out.push(cur);
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return out;
}

export const mark = (tag: string, arg?: string) => `echo ${shQuote(`${MARK}${tag}${arg !== undefined ? ':' + arg : ''}===`)}`;

// Remote shell snippet that streams a log file, decompressing by extension.
function catCmd(file: string): string {
  const q = shQuote(file);
  if (file.endsWith('.gz')) return `zcat -f ${q}`;
  if (file.endsWith('.xz')) return `xzcat ${q}`;
  if (file.endsWith('.bz2')) return `bzcat ${q}`;
  if (file.endsWith('.zst')) return `zstdcat ${q}`;
  if (file.endsWith('.lz4')) return `lz4cat ${q}`;
  return `cat ${q}`;
}

// Why a listing looks thin: shown whenever commands are not running as root.
function permissionHint(vm: VmEntry, uid: string): string | undefined {
  if (uid === '0') return undefined;
  return vm.elevate && vm.elevate !== 'none'
    ? `Root elevation (${vm.elevate}) is configured but commands are not running as root — check the elevation password on the Virtual Machines page.`
    : `Logged in as "${vm.user}" without root: most of /var/log is root-only. Enable root access for this VM on the Virtual Machines page to see everything.`;
}

async function unreachable(vm: VmEntry): Promise<string | null> {
  if (await vmReachable(vm)) return null;
  return vm.via ? `Jump host "${vm.via}" unreachable` : 'Host unreachable on SSH (port 22)';
}

function firstLine(s: string, fallback: string): string {
  return (s.split('\n').find((l) => l.trim()) || fallback).slice(0, 300);
}

const UNITS_CMD = 'systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null';

// ---- overview --------------------------------------------------------------
// One round-trip for "what is this machine and is it healthy?".

/**
 * The whole-host system picture, in one SSH round trip.
 *
 * Exported as a function rather than living only inside the route so the
 * insight engine can fuse it with log findings and metrics without
 * re-implementing the command or opening a second connection.
 */
export async function collectOverview(vm: VmEntry) {
  const down = await unreachable(vm);
  if (down) return { reachable: false as const, error: down };

  const cmd = [
    mark('SELF'),
    `echo "UID=$(id -u)"; echo "HOST=$(hostname)"; echo "OS=$(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME)"; ` +
      `echo "KERNEL=$(uname -r)"; echo "ARCH=$(uname -m)"; echo "UPTIME=$(uptime -p 2>/dev/null)"; echo "BOOT=$(uptime -s 2>/dev/null)"; ` +
      `echo "UPSEC=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"; echo "NCPU=$(nproc 2>/dev/null)"; echo "LOAD=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"; ` +
      `echo "VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown)"; echo "JOURNAL=$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -n 1)"`,
    mark('FREE'), 'free -b 2>/dev/null',
    mark('DF'), 'df -PT -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2',
    mark('INODES'), 'df -Pi -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2',
    mark('UNITS'), UNITS_CMD,
    mark('TOPMEM'), 'ps -eo pid,user,pcpu,pmem,rss,comm --no-headers --sort=-pmem 2>/dev/null | head -n 10',
    mark('TOPCPU'), 'ps -eo pid,user,pcpu,pmem,rss,comm --no-headers --sort=-pcpu 2>/dev/null | head -n 10',
    mark('PORTS'), 'ss -tulnpH 2>/dev/null | head -n 200',
    mark('TIME'), 'timedatectl show 2>/dev/null',
    mark('REBOOTS'), 'last -x reboot 2>/dev/null | head -n 5',
    mark('END'),
  ].join('; ');

  const { stdout, stderr, ok } = await sshRun(vm, cmd, 60000, { maxBuffer: 8 * MB });
  if (!ok && !stdout.includes(MARK)) return { reachable: true as const, error: firstLine(stderr, 'SSH failed') };

  const blocks = splitMarked(stdout);
  const get = (tag: string) => blocks.find((b) => b.tag === tag)?.body.filter((l) => l.trim()) || [];
  const self = parseKv(get('SELF'));
  const time = parseKv(get('TIME'));
  const load = (self.LOAD || '').split(/\s+/).map(Number);

  const base: Omit<SystemOverview, 'health'> = {
    hostname: self.HOST || vm.host,
    os: self.OS || '—',
    kernel: self.KERNEL || '—',
    arch: self.ARCH || '',
    virt: self.VIRT === 'none' ? 'bare metal' : self.VIRT || '',
    uptime: (self.UPTIME || '').replace(/^up /, ''),
    bootedAt: self.BOOT || '',
    uptimeSec: Number(self.UPSEC) || 0,
    cpus: Number(self.NCPU) || 0,
    load: [load[0] || 0, load[1] || 0, load[2] || 0],
    memory: parseFree(get('FREE')),
    filesystems: parseDf(get('DF'), get('INODES')),
    services: parseUnits(get('UNITS')),
    topMemory: parsePs(get('TOPMEM')),
    topCpu: parsePs(get('TOPCPU')),
    ports: parseSs(get('PORTS')),
    timeSynced: time.NTPSynchronized ? time.NTPSynchronized === 'yes' : null,
    timezone: time.Timezone || '',
    journalDisk: self.JOURNAL || '',
    reboots: get('REBOOTS').filter((l) => l.startsWith('reboot')),
    runsAsRoot: self.UID === '0',
  };
  return { reachable: true as const, ...base, health: buildHealth(base), hint: permissionHint(vm, self.UID || '') };
}

logsRouter.post('/api/logs/overview', async (req, res) => {
  const vm = await findVm(req.body?.name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  res.json(await collectOverview(vm));
});

// ---- service status / restart / start --------------------------------------
// status is read-only. restart and start change the host, so they require
// confirm:true (the UI asks first), refuse units that do not exist on the host,
// and are logged on the Kalam server.

const SERVICE_ACTIONS = new Set(['status', 'restart', 'start']);

logsRouter.post('/api/logs/service', async (req, res) => {
  const { name, unit: rawUnit, action, confirm } = req.body || {};
  const vm = await findVm(name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const unit = safeServiceUnit(rawUnit);
  if (!unit) return res.status(400).json({ error: 'Invalid service name.' });
  if (!SERVICE_ACTIONS.has(action)) return res.status(400).json({ error: 'action must be status, restart or start.' });
  if (action !== 'status' && confirm !== true) return res.status(400).json({ error: 'Confirmation required.' });

  const q = shQuote(unit);
  const report = [
    mark('STATE'), `systemctl show ${q} -p LoadState,ActiveState,SubState,NRestarts,ActiveEnterTimestamp,MainPID,Description --no-pager 2>&1`,
    mark('STATUS'), `systemctl status ${q} --no-pager -l -n 0 2>&1 | head -n 40`,
    mark('JOURNAL'), `journalctl -u ${q} --no-pager -o short-iso -n 80 2>&1`,
    mark('END'),
  ].join('; ');

  let cmd = report;
  if (action !== 'status') {
    // Check existence first: `systemctl restart typo.service` would otherwise
    // fail with a confusing message after the fact.
    cmd = [
      `if [ "$(systemctl show ${q} -p LoadState --value 2>/dev/null)" != "loaded" ]; then ${mark('MISSING')}; exit 0; fi`,
      mark('ACTION'), `systemctl ${action} ${q} 2>&1; echo "EXIT=$?"`,
      'sleep 2',
      report,
    ].join('; ');
    console.log(`[hostlogs] ${new Date().toISOString()} systemctl ${action} ${unit} on ${vm.name} (${vm.user}@${vm.host})`);
  }

  const { stdout, stderr, ok } = await sshRun(vm, cmd, 150000, { maxBuffer: 4 * MB });
  const blocks = splitMarked(stdout);
  const get = (tag: string) => blocks.find((b) => b.tag === tag)?.body || [];

  if (blocks.some((b) => b.tag === 'MISSING')) {
    return res.json({ ok: false, unit, action, error: `${unit} does not exist on this host.` });
  }
  if (!ok && !blocks.some((b) => b.tag === 'STATE')) {
    // Restarting sshd or networking can cut the very session running the command.
    const dropped = action !== 'status' && ACCESS_UNITS.has(baseName(unit));
    return res.json({
      ok: false, unit, action,
      error: dropped
        ? `Connection dropped while running ${action} on ${unit} — expected for SSH/network services. Check its status again in a few seconds.`
        : firstLine(stderr || stdout, 'SSH failed'),
    });
  }

  const actionOut = get('ACTION').filter((l) => l.trim());
  const exitLine = actionOut.find((l) => /^EXIT=\d+$/.test(l));
  const exitCode = exitLine ? Number(exitLine.slice(5)) : undefined;
  const actionText = actionOut.filter((l) => l !== exitLine).join('\n');
  const state = parseKv(get('STATE'));
  const needsRoot = /Interactive authentication required|Access denied|not permitted/i.test(actionText);

  res.json({
    ok: action === 'status' ? true : exitCode === 0,
    unit,
    action,
    exitCode,
    actionOutput: actionText,
    error: action !== 'status' && exitCode !== 0
      ? (needsRoot
        ? `Not permitted to ${action} ${unit} as "${vm.user}" — service control needs root. Enable root access (sudo/su) for this VM on the Virtual Machines page.\n${actionText}`
        : actionText || `systemctl ${action} failed.`)
      : undefined,
    state: {
      load: state.LoadState || '', active: state.ActiveState || '', sub: state.SubState || '',
      restarts: state.NRestarts || '', since: state.ActiveEnterTimestamp || '', pid: state.MainPID || '',
      description: state.Description || '',
    },
    status: get('STATUS').join('\n').trim(),
    journal: get('JOURNAL').filter((l) => l.trim()),
  });
});

// ---- journal explorer ------------------------------------------------------
// Structured journalctl queries (see ./journal.ts for every supported option).

const FIELD_NAME_RE = /^_{0,2}[A-Z0-9][A-Z0-9_]{0,63}$/;

// Boots, units/identifiers that have entries, available fields, disk usage and
// journald configuration — everything the explorer's pickers need.
logsRouter.post('/api/logs/journal/meta', async (req, res) => {
  const vm = await findVm(req.body?.name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const down = await unreachable(vm);
  if (down) return res.json({ reachable: false, error: down });

  const cmd = [
    mark('PRESENT'), 'command -v journalctl >/dev/null 2>&1 && echo yes',
    mark('VERSION'), 'journalctl --version 2>/dev/null | head -n 1',
    mark('BOOTS'), 'journalctl --list-boots --no-pager 2>/dev/null | tail -n 100',
    mark('UNITS'), 'journalctl -F _SYSTEMD_UNIT 2>/dev/null | sort | head -n 1500',
    mark('IDENTS'), 'journalctl -F SYSLOG_IDENTIFIER 2>/dev/null | sort | head -n 1500',
    mark('FIELDS'), 'journalctl -N 2>/dev/null | sort | head -n 400',
    mark('DISK'), 'journalctl --disk-usage 2>&1',
    mark('STORAGE'), 'if [ -d /var/log/journal ]; then echo persistent; else echo volatile; fi',
    mark('CONF'), "(systemd-analyze cat-config systemd/journald.conf 2>/dev/null || cat /etc/systemd/journald.conf 2>/dev/null) | grep -E '^[A-Za-z]' | head -n 40",
    mark('END'),
  ].join('; ');

  const { stdout, stderr, ok } = await sshRun(vm, cmd, 90000, { maxBuffer: 8 * MB });
  if (!ok && !stdout.includes(MARK)) return res.json({ reachable: true, error: firstLine(stderr, 'SSH failed') });
  const blocks = splitMarked(stdout);
  const get = (tag: string) => (blocks.find((b) => b.tag === tag)?.body || []).map((l) => l.trim()).filter(Boolean);

  res.json({
    reachable: true,
    available: get('PRESENT')[0] === 'yes',
    version: get('VERSION')[0] || '',
    boots: parseBoots(get('BOOTS')),
    units: get('UNITS'),
    identifiers: get('IDENTS'),
    fields: get('FIELDS'),
    diskUsage: get('DISK').join(' '),
    storage: get('STORAGE')[0] || '',
    config: get('CONF'),
    priorities: PRIORITIES,
    outputModes: OUTPUT_MODES,
  });
});

// Distinct values of one field (journalctl -F FIELD), for value pickers.
logsRouter.post('/api/logs/journal/field-values', async (req, res) => {
  const { name, field } = req.body || {};
  const vm = await findVm(name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  if (typeof field !== 'string' || !FIELD_NAME_RE.test(field)) return res.status(400).json({ error: 'Invalid field name.' });
  const { stdout, ok, stderr } = await sshRun(vm, `journalctl -F ${shQuote(field)} 2>&1 | sort | head -n 1000`, 60000, { maxBuffer: 4 * MB });
  if (!ok && !stdout) return res.json({ error: firstLine(stderr, 'SSH failed') });
  res.json({ field, values: stdout.split('\n').map((l) => l.trim()).filter(Boolean) });
});

logsRouter.post('/api/logs/journal', async (req, res) => {
  const { name, query } = req.body || {};
  const vm = await findVm(name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const built = buildJournalCommand((query || {}) as JournalQuery);
  if (built.errors.length) return res.status(400).json({ error: built.errors.join(' '), command: built.display });

  const started = Date.now();
  const { stdout, stderr, ok, truncated } = await sshRun(vm, built.command, 90000, { maxBuffer: 32 * MB });
  const raw = (stdout || (ok ? '' : stderr)).replace(/\r\n/g, '\n').replace(/\n$/, '');
  const { lines, cursor } = splitCursor(raw ? raw.split('\n') : []);

  // journalctl's own errors (bad unit pattern, an option this version lacks).
  const first = lines[0] || '';
  const jerr = lines.length <= 3 && /^(journalctl: |Failed to |Unrecognized option|invalid option|Option .* requires)/i.test(first)
    ? lines.join(' ') : undefined;
  const noEntries = lines.length === 1 && first === '-- No entries --';

  res.json({
    ok: !jerr,
    command: built.display,
    lines: noEntries || jerr ? [] : lines,
    cursor,
    error: jerr
      ? `${jerr}${/unrecognized|invalid option/i.test(jerr) ? " — this host's journalctl is too old for one of the selected options." : ''}`
      : undefined,
    empty: noEntries || (!jerr && !lines.length),
    truncated: !!truncated,
    durationMs: Date.now() - started,
  });
});

// Same query saved as a file (.json for json output modes, .log otherwise).
logsRouter.post('/api/logs/journal/download', async (req, res) => {
  const { name, query } = req.body || {};
  const vm = await findVm(name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const q = { ...((query || {}) as JournalQuery), afterCursor: undefined };
  const built = buildJournalCommand(q, { forDownload: true });
  if (built.errors.length) return res.status(400).json({ error: built.errors.join(' ') });

  const cap = BUNDLE_MAX_BYTES;
  const { stdout, truncated } = await sshRun(vm, `{ ${built.command}; } | head -c ${cap}`, 300000, { maxBuffer: cap + MB });
  const json = /^json/.test(q.output || '');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', json ? 'application/json' : 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${`${vm.name}-journal-${stamp}.${json ? 'json' : 'log'}`.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Access-Control-Expose-Headers', 'X-Kalam-Truncated, X-Kalam-Cap-Mb, Content-Disposition');
  res.setHeader('X-Kalam-Truncated', truncated || Buffer.byteLength(stdout) >= cap ? '1' : '0');
  res.setHeader('X-Kalam-Cap-Mb', String(Math.round(cap / MB)));
  res.end(stdout);
});

// Read-only integrity checks: --verify and --header.
logsRouter.post('/api/logs/journal/check', async (req, res) => {
  const { name, op } = req.body || {};
  const vm = await findVm(name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const cmd = buildCheckCommand(op);
  if (!cmd) return res.status(400).json({ error: 'op must be verify or header.' });
  const { stdout, stderr, ok } = await sshRun(vm, cmd, 300000, { maxBuffer: 4 * MB });
  const output = (stdout || stderr).replace(/\r\n/g, '\n').trim();
  res.json({
    ok,
    op,
    output,
    // --verify prints PASS/FAIL per file; surface the failures.
    failures: output.split('\n').filter((l) => /^FAIL|File corruption|failed/i.test(l)).length,
  });
});

// ---- GET the rule catalogue (for the UI legend) ---------------------------

logsRouter.get('/api/logs/rules', (_req, res) => {
  res.json({ rules: LOG_RULES.map(({ pattern: _p, ...r }) => r) });
});

// ---- list ------------------------------------------------------------------

logsRouter.post('/api/logs/list', async (req, res) => {
  const vm = await findVm(req.body?.name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const down = await unreachable(vm);
  if (down) return res.json({ reachable: false, error: down });

  const cmd = [
    mark('UID'), 'id -u',
    mark('HOST'), 'hostname',
    mark('FILES'),
    // GNU find first; BusyBox has no -printf, so fall back to stat.
    `{ find /var/log -maxdepth 3 -type f -printf '%s\\t%T@\\t%u\\t%p\\n' 2>/dev/null || find /var/log -maxdepth 3 -type f -exec stat -c '%s\t%Y\t%U\t%n' {} + 2>/dev/null; } | head -n 3000`,
    mark('UNREADABLE'), `find /var/log -maxdepth 3 -type f ! -readable 2>/dev/null | head -n 3000`,
    mark('JOURNAL'), 'command -v journalctl >/dev/null 2>&1 && echo yes',
    mark('END'),
  ].join('; ');

  const { stdout, stderr, ok } = await sshRun(vm, cmd, 45000, { maxBuffer: 8 * MB });
  if (!ok && !stdout.includes(MARK)) return res.json({ reachable: true, error: firstLine(stderr, 'SSH failed') });

  const blocks = splitMarked(stdout);
  const get = (tag: string) => blocks.find((b) => b.tag === tag)?.body || [];
  const uid = (get('UID')[0] || '').trim();
  const unreadable = new Set(get('UNREADABLE').map((l) => l.trim()).filter(Boolean));

  const files = get('FILES')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 4 && p[3].startsWith('/var/log/'))
    .map(([size, mtime, owner, ...rest]) => {
      const p = rest.join('\t');
      return {
        path: p,
        size: Number(size) || 0,
        mtime: new Date((Number(mtime) || 0) * 1000).toISOString(),
        owner,
        compressed: isCompressed(p),
        binary: isBinaryLog(p),
        readable: !unreadable.has(p),
        safe: safeLogPath(p) !== null,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  res.json({
    reachable: true,
    host: (get('HOST')[0] || vm.host).trim(),
    runsAsRoot: uid === '0',
    journal: (get('JOURNAL')[0] || '').trim() === 'yes',
    files,
    unreadableCount: unreadable.size,
    hint: permissionHint(vm, uid),
  });
});

// ---- read ------------------------------------------------------------------

logsRouter.post('/api/logs/read', async (req, res) => {
  const { name, path: reqPath, lines: reqLines = 500, grep } = req.body || {};
  const vm = await findVm(name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const lines = Math.min(Math.max(parseInt(String(reqLines), 10) || 500, 1), 5000);
  const q = typeof grep === 'string' && grep.trim() ? grep.trim().slice(0, 200) : '';
  const filter = q ? ` | grep -aiF -- ${shQuote(q)}` : '';

  let cmd: string;
  if (reqPath === JOURNAL) {
    cmd = `journalctl --no-pager -o short-iso -n ${q ? 100000 : lines} 2>&1${filter} | tail -n ${lines}`;
  } else if (reqPath === DMESG) {
    cmd = `dmesg -T 2>&1${filter} | tail -n ${lines}`;
  } else {
    const file = safeLogPath(reqPath);
    if (!file || file === '/var/log') return res.status(400).json({ error: 'Path must be a file under /var/log.' });
    if (/\/(wtmp|btmp)(\.\d+)?$/.test(file)) {
      cmd = `last -F -f ${shQuote(file)} 2>&1${filter} | head -n ${lines}`;
    } else if (isBinaryLog(file)) {
      return res.status(400).json({ error: 'Binary log — download it instead of viewing it as text.' });
    } else if (!q && !isCompressed(file)) {
      cmd = `tail -n ${lines} ${shQuote(file)} 2>&1`;
    } else {
      cmd = `${catCmd(file)} 2>&1${filter} | tail -n ${lines}`;
    }
  }

  const { stdout, stderr, ok, truncated } = await sshRun(vm, cmd, 60000, { maxBuffer: 16 * MB });
  const text = stdout || stderr;
  const denied = /permission denied/i.test(text) && text.split('\n').length <= 3;
  res.json({
    ok: ok && !denied,
    lines: text ? text.replace(/\n$/, '').split('\n') : [],
    truncated: !!truncated,
    error: denied ? permissionHint(vm, '') : undefined,
  });
});

// ---- scan ------------------------------------------------------------------

/**
 * The deterministic /var/log + journal + dmesg scan.
 *
 * Exported for the same reason as collectOverview: this is a 120s, 48MB
 * operation, so the insight engine must be able to reuse one run of it rather
 * than trigger a second.
 */
export async function collectScan(vm: VmEntry, reqHours: number = 168) {
  const hours = WINDOWS_HOURS.has(Number(reqHours)) ? Number(reqHours) : 168;
  const down = await unreachable(vm);
  if (down) return { reachable: false as const, error: down };

  const pre = shQuote(PREFILTER);
  const exclude = [
    "! -name '*.gz'", "! -name '*.xz'", "! -name '*.bz2'", "! -name '*.zst'", "! -name '*.lz4'",
    "! -name 'wtmp*'", "! -name 'btmp*'", "! -name 'lastlog'", "! -name 'faillog'",
    "! -name '*.journal*'", "! -path '*/journal/*'",
  ].join(' ');

  const cmd = [
    mark('UID'), 'id -u',
    `find /var/log -maxdepth 3 -type f -mmin -${hours * 60} ${exclude} -printf '%T@\\t%p\\n' 2>/dev/null | sort -rn | head -n ${SCAN_MAX_FILES} | cut -f2- | while IFS= read -r f; do ` +
      `echo "${MARK}FILE:$f==="; tail -n ${SCAN_TAIL_LINES} "$f" 2>&1 | grep -aiE ${pre} | tail -n ${SCAN_KEEP_LINES}; done`,
    `if command -v journalctl >/dev/null 2>&1; then ${mark('SRC', JOURNAL)}; ` +
      `journalctl --no-pager -o short-iso -p warning --since "$(date -d '-${hours} hours' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '-${hours}h')" 2>/dev/null | tail -n ${SCAN_KEEP_LINES}; fi`,
    mark('SRC', DMESG),
    `dmesg -T --level=emerg,alert,crit,err,warn 2>/dev/null | tail -n ${SCAN_KEEP_LINES}`,
    mark('UNITS'), UNITS_CMD,
    mark('END'),
  ].join('; ');

  const started = Date.now();
  const { stdout, stderr, ok, truncated } = await sshRun(vm, cmd, 120000, { maxBuffer: 48 * MB });
  if (!ok && !stdout.includes(MARK)) return { reachable: true as const, error: firstLine(stderr, 'SSH failed') };

  const blocks = splitMarked(stdout);
  const uid = (blocks.find((b) => b.tag === 'UID')?.body[0] || '').trim();
  const sources = blocks
    .filter((b) => b.tag === 'FILE' || b.tag === 'SRC')
    .map((b) => ({
      file: b.arg,
      // A root-only file read without root yields just the error line.
      lines: b.body.filter((l) => !/^tail: cannot open .*Permission denied/.test(l)),
      denied: b.body.some((l) => /^tail: cannot open .*Permission denied/.test(l)),
    }));

  // Link each finding to the systemd unit(s) that logged it, so the page can
  // offer status / restart right next to the problem.
  const units = parseUnits(blocks.find((b) => b.tag === 'UNITS')?.body || []);
  const findings = scanSources(sources).map((f) => ({ ...f, units: unitsForLines(f.samples, units) }));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += f.count;

  const deniedFiles = sources.filter((s) => s.denied).map((s) => s.file);
  return {
    reachable: true as const,
    hours,
    runsAsRoot: uid === '0',
    scannedFiles: sources.map((s) => s.file),
    deniedFiles,
    matchedLines: sources.reduce((n, s) => n + s.lines.length, 0),
    counts,
    findings: findings.slice(0, 500),
    totalGroups: findings.length,
    truncated: !!truncated,
    durationMs: Date.now() - started,
    hint: permissionHint(vm, uid),
  };
}

logsRouter.post('/api/logs/scan', async (req, res) => {
  const vm = await findVm(req.body?.name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  res.json(await collectScan(vm, Number(req.body?.hours ?? 168)));
});

// ---- download --------------------------------------------------------------
// { name, paths?: string[] }  → .tar.gz of those paths (default: all /var/log)
// { name, path, raw: true }   → the single file as-is

logsRouter.post('/api/logs/download', async (req, res) => {
  const { name, paths, path: single, raw } = req.body || {};
  const vm = await findVm(name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const down = await unreachable(vm);
  if (down) return res.status(502).json({ error: down });

  const cap = BUNDLE_MAX_BYTES;
  let cmd: string;
  let filename: string;
  let contentType: string;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  if (raw) {
    const file = safeLogPath(single);
    if (!file || file === '/var/log') return res.status(400).json({ error: 'Path must be a file under /var/log.' });
    cmd = `head -c ${cap + 1} ${shQuote(file)} | base64`;
    filename = `${vm.name}-${path.posix.basename(file)}`;
    contentType = 'application/octet-stream';
  } else {
    let list: string[] = ['/var/log'];
    if (Array.isArray(paths) && paths.length) {
      const valid = paths.slice(0, 500).map(safeLogPath);
      if (valid.some((p) => !p)) return res.status(400).json({ error: 'Every path must be under /var/log.' });
      list = valid as string[];
    }
    const rel = list.map((p) => shQuote(p.slice(1))).join(' ');
    // --ignore-failed-read: a single unreadable or rotating file must not
    // abort the whole bundle. Exit status is ignored; the byte count decides.
    cmd = `tar czf - --ignore-failed-read -C / ${rel} 2>/dev/null | head -c ${cap + 1} | base64`;
    filename = `${vm.name}-varlog-${stamp}.tar.gz`;
    contentType = 'application/gzip';
  }

  const { stdout, stderr, truncated: bufCut } = await sshRun(vm, cmd, 300000, {
    maxBuffer: Math.ceil((cap + 1) * 1.4) + MB,
  });
  let data = Buffer.from(stdout.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (!data.length) {
    return res.status(502).json({ error: firstLine(stderr, 'Nothing was archived — the files may be unreadable without root.') });
  }
  const truncated = data.length > cap || !!bufCut;
  if (data.length > cap) data = data.subarray(0, cap);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Access-Control-Expose-Headers', 'X-Kalam-Truncated, X-Kalam-Cap-Mb, Content-Disposition');
  res.setHeader('X-Kalam-Truncated', truncated ? '1' : '0');
  res.setHeader('X-Kalam-Cap-Mb', String(Math.round(cap / MB)));
  res.end(data);
});
