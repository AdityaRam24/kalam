// Password-capable SSH transport (MobaXterm-style: host + user + password).
//
// The system `ssh` binary cannot be handed a password non-interactively — it
// always opens its own TTY prompt, which is why password logins never worked
// from the UI. This module talks the SSH protocol directly (ssh2, pure JS), so
// a password typed into the Add VM form authenticates the same way MobaXterm
// does. Key files still work; if neither a password nor a key is given we fall
// back to the caller's system `ssh` (agent / ~/.ssh/config).
//
// Everything here is stateless: one TCP connection per command, closed after.

import { Client, type ConnectConfig } from 'ssh2';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Every host is reached on the standard SSH port. Non-standard ports were the
// single most common reason a VM "would not connect", so there is no port knob.
export const SSH_PORT = 22;

// Test-only escape hatch: the SSH test suite runs a real daemon on a loopback
// ephemeral port. Never set in production, where 22 is always used.
function connectPort(): number {
  const override = process.env.SSH_PORT_OVERRIDE;
  return override ? Number(override) : SSH_PORT;
}

export interface SshTarget {
  name: string;
  host: string;
  user: string;
  password?: string;
  keyPath?: string;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  ok: boolean;
}

// "~/.ssh/id_rsa" -> "C:\Users\me\.ssh\id_rsa"
function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function authFor(vm: SshTarget, timeoutMs: number): Promise<ConnectConfig> {
  const cfg: ConnectConfig = {
    host: vm.host,
    port: connectPort(),
    username: vm.user,
    readyTimeout: Math.min(timeoutMs, 20000),
    // Older appliance/hypervisor SSH daemons (common on the hosts this monitors)
    // still offer only legacy KEX and host-key algorithms, which ssh2 supports
    // but leaves out of its defaults. `append` keeps every modern default first
    // and merely adds the fallbacks at the end — listing algorithms explicitly
    // would instead REPLACE the defaults and quietly drop some of them.
    algorithms: {
      kex: {
        append: [
          'diffie-hellman-group-exchange-sha1',
          'diffie-hellman-group14-sha1',
          'diffie-hellman-group1-sha1',
        ],
      },
      serverHostKey: { append: ['ssh-dss'] },
    } as ConnectConfig['algorithms'],
  };
  if (vm.password) {
    cfg.password = vm.password;
    // Some sshd configs answer password logins with keyboard-interactive
    // instead; MobaXterm handles both, so we do too.
    cfg.tryKeyboard = true;
  }
  if (vm.keyPath) {
    try {
      cfg.privateKey = await fs.readFile(expandHome(vm.keyPath));
    } catch {
      // Unreadable key: fall through to password/agent rather than hard-failing.
    }
  }
  if (!cfg.password && !cfg.privateKey && process.env.SSH_AUTH_SOCK) {
    cfg.agent = process.env.SSH_AUTH_SOCK;
  }
  return cfg;
}

// Open a connected ssh2 Client. `sock` carries a tunnelled stream when hopping
// through a jump host.
function connect(cfg: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', (err) => reject(err));
    // A server that asks keyboard-interactive gets the same password back.
    c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => String(cfg.password || '')));
    });
    c.connect(cfg);
  });
}

// Tunnel from `via` to `vm`: connect to the jump host, then ask it to open a
// TCP connection onwards. The returned stream becomes the target's socket.
async function jumpSocket(via: SshTarget, vm: SshTarget, timeoutMs: number): Promise<{ sock: any; hop: Client }> {
  const hop = await connect(await authFor(via, timeoutMs));
  return new Promise((resolve, reject) => {
    hop.forwardOut('127.0.0.1', 0, vm.host, connectPort(), (err, stream) => {
      if (err) {
        hop.end();
        reject(new Error(`Jump host ${via.name}: ${err.message}`));
        return;
      }
      resolve({ sock: stream, hop });
    });
  });
}

// Run one command. Never rejects — failures come back as { ok: false, stderr }.
export async function sshExec(
  vm: SshTarget,
  command: string,
  timeoutMs = 20000,
  via?: SshTarget,
  maxBuffer = 1024 * 1024 * 4
): Promise<SshResult> {
  let conn: Client | undefined;
  let hop: Client | undefined;
  try {
    const cfg = await authFor(vm, timeoutMs);
    if (via) {
      const t = await jumpSocket(via, vm, timeoutMs);
      hop = t.hop;
      cfg.sock = t.sock;
    }
    conn = await connect(cfg);

    return await new Promise<SshResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (r: SshResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => finish({ stdout, stderr: stderr || `Timed out after ${timeoutMs}ms`, ok: false }),
        timeoutMs
      );

      conn!.exec(command, (err, stream) => {
        if (err) return finish({ stdout: '', stderr: err.message, ok: false });
        // Truncated output parses as "these objects are gone", so stop reading
        // at the cap rather than letting the buffer grow without bound.
        stream.on('data', (d: Buffer) => { if (stdout.length < maxBuffer) stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { if (stderr.length < maxBuffer) stderr += d.toString('utf8'); });
        stream.on('close', (code: number) => finish({ stdout, stderr, ok: code === 0 }));
      });
    });
  } catch (e: any) {
    return { stdout: '', stderr: friendly(e), ok: false };
  } finally {
    try { conn?.end(); } catch { /* already closed */ }
    try { hop?.end(); } catch { /* already closed */ }
  }
}

// ssh2's raw errors ("All configured authentication methods failed") are not
// actionable in a UI toast — say what to change instead.
export function friendly(e: any): string {
  const msg = String(e?.message || e || 'SSH failed');
  if (/authentication methods failed/i.test(msg)) return 'Login failed — check the username and password.';
  if (/ECONNREFUSED/i.test(msg)) return 'Connection refused — SSH is not listening on this host.';
  if (/ETIMEDOUT|timed out/i.test(msg)) return 'Connection timed out — host unreachable or blocked by a firewall.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'Host not found — check the IP or hostname.';
  if (/ECONNRESET/i.test(msg)) return 'Connection reset by the host.';
  return msg;
}

// Verify credentials without running anything (used when adding a VM).
export async function sshCheck(vm: SshTarget, via?: SshTarget): Promise<{ ok: boolean; error?: string }> {
  const r = await sshExec(vm, 'echo ok', 15000, via);
  if (r.ok || r.stdout.includes('ok')) return { ok: true };
  return { ok: false, error: (r.stderr.split('\n')[0] || 'SSH failed').slice(0, 200) };
}
