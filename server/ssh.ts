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

// How a non-root login gets root rights for the commands Kalam runs.
//   none — run as the login user (default)
//   sudo — wrap each command in `sudo -S`, password fed on stdin
//   su   — run each command through `su - root -c`, password fed on a PTY
export type Elevation = 'none' | 'sudo' | 'su';

export interface SshTarget {
  name: string;
  host: string;
  user: string;
  password?: string;
  keyPath?: string;
  elevate?: Elevation;
  // Password for the elevation step: the sudo password (usually the login
  // password) or root's password for `su`. Falls back to `password`.
  elevatePassword?: string;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  /**
   * Output hit the buffer cap and was cut short.
   *
   * This must be reported, never inferred. Truncated JSON does not fail loudly
   * — it fails as a parse error that a caller swallows into an empty array, so
   * a cluster full of pods reads as a cluster with none.
   */
  truncated?: boolean;
}

export interface ExecOptions {
  maxBuffer?: number;
  // Run through a login shell (`bash -lc`), so the command sees the same PATH,
  // aliases and profile the user gets in a real terminal. Off for internal
  // probes, whose output is parsed and would be corrupted by profile banners.
  login?: boolean;
  // Allocate a pseudo-terminal. Required by anything that insists on a TTY
  // (su, some sudo configs, tools that refuse to run "not from a terminal").
  pty?: boolean;
  // Bypass shell wrapping and elevation entirely — the command is sent as-is.
  raw?: boolean;
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

// Single-quote a string for /bin/sh.
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Directories that hold kubectl / crictl / nvidia-smi on the hosts this talks
// to but are missing from a non-interactive SSH session's default PATH. Their
// absence is why "command not found" was the usual answer to a working command.
const EXTRA_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/bin:/var/lib/rancher/rke2/bin:/snap/bin';

// Turn the caller's command into what actually goes over the wire: the shell it
// runs in, plus any elevation. Pure and exported so the behaviour is testable
// without a live host.
export function buildRemoteCommand(
  vm: SshTarget,
  command: string,
  opts: { login?: boolean } = {}
): { command: string; stdin?: string; pty: boolean } {
  // A login shell for user-typed commands (their PATH, their profile); an
  // explicit PATH for parsed probes, which profile banners would corrupt.
  const inner = opts.login
    ? `if command -v bash >/dev/null 2>&1; then exec bash -lc ${shQuote(command)}; else exec sh -lc ${shQuote(command)}; fi`
    : `export PATH="$PATH:${EXTRA_PATH}"; ${command}`;

  const mode: Elevation = vm.user === 'root' ? 'none' : (vm.elevate || 'none');
  const pw = vm.elevatePassword ?? vm.password;

  if (mode === 'sudo') {
    // -S reads the password from stdin, -p '' keeps the prompt out of stderr.
    return { command: `sudo -S -p '' -- /bin/sh -c ${shQuote(inner)}`, stdin: pw ? `${pw}\n` : undefined, pty: false };
  }
  if (mode === 'su') {
    // su insists on a real terminal, so this one gets a PTY and the password
    // typed into it the way a person would.
    return { command: `su - root -c ${shQuote(`/bin/sh -c ${shQuote(inner)}`)}`, stdin: pw ? `${pw}\n` : undefined, pty: true };
  }
  return { command: inner, pty: false };
}

// A PTY echoes the password prompt (and turns newlines into CRLF). Neither
// belongs in output that gets parsed or shown.
function cleanPty(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^[^\n]*[Pp]assword:?[^\n]*\n/, '');
}

// Run one command. Never rejects — failures come back as { ok: false, stderr }.
export async function sshExec(
  vm: SshTarget,
  command: string,
  timeoutMs = 20000,
  via?: SshTarget,
  options: number | ExecOptions = {}
): Promise<SshResult> {
  const opts: ExecOptions = typeof options === 'number' ? { maxBuffer: options } : options;
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024 * 4;
  const wrapped = opts.raw
    ? { command, stdin: undefined as string | undefined, pty: !!opts.pty }
    : buildRemoteCommand(vm, command, { login: opts.login });
  const usePty = wrapped.pty || !!opts.pty;
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
      // Chunks are collected and joined once. Repeatedly concatenating a
      // string that reaches tens of megabytes is quadratic, and bulk cluster
      // JSON reaches exactly that.
      const outChunks: string[] = [];
      const errChunks: string[] = [];
      let outLen = 0;
      let errLen = 0;
      let truncated = false;
      const stdoutText = () => outChunks.join('');
      const stderrText = () => errChunks.join('');
      let done = false;
      const finish = (r: SshResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => finish({ stdout: stdoutText(), stderr: stderrText() || `Timed out after ${timeoutMs}ms`, ok: false, truncated }),
        timeoutMs
      );

      const execOpts = usePty ? { pty: { term: 'xterm-256color', cols: 200, rows: 50 } } : {};
      conn!.exec(wrapped.command, execOpts as any, (err, stream) => {
        if (err) return finish({ stdout: '', stderr: err.message, ok: false });
        // Stop reading at the cap rather than letting the buffer grow without
        // bound — but record that it happened, so the caller can say "this was
        // cut short" instead of reporting an empty cluster.
        stream.on('data', (d: Buffer) => {
          if (outLen >= maxBuffer) { truncated = true; return; }
          const text = d.toString('utf8');
          outLen += text.length;
          outChunks.push(text);
          if (outLen >= maxBuffer) truncated = true;
        });
        stream.stderr.on('data', (d: Buffer) => {
          if (errLen >= maxBuffer) return;
          const text = d.toString('utf8');
          errLen += text.length;
          errChunks.push(text);
        });
        stream.on('close', (code: number) => {
          const out = stdoutText();
          const errText = stderrText();
          finish(usePty
            ? { stdout: cleanPty(out), stderr: cleanPty(errText), ok: code === 0, truncated }
            : { stdout: out, stderr: errText, ok: code === 0, truncated });
        });
        // Elevation passwords are typed, not passed as arguments — an argument
        // would be visible to every user in `ps` on the remote host.
        if (wrapped.stdin) stream.write(wrapped.stdin);
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
// Deliberately `raw`: this answers "does the login work", so a misconfigured
// sudo must not be reported as a bad password.
export async function sshCheck(vm: SshTarget, via?: SshTarget): Promise<{ ok: boolean; error?: string }> {
  const r = await sshExec(vm, 'echo ok', 15000, via, { raw: true });
  if (r.ok || r.stdout.includes('ok')) return { ok: true };
  return { ok: false, error: (r.stderr.split('\n')[0] || 'SSH failed').slice(0, 200) };
}

// Who do commands actually run as with this target's elevation settings?
// Returns the effective user name, so the UI can say "you are root now" only
// when that is true.
export async function sshWhoami(vm: SshTarget, via?: SshTarget): Promise<{ ok: boolean; user?: string; error?: string }> {
  const r = await sshExec(vm, 'id -un', 20000, via);
  const user = r.stdout.replace(/\r/g, '').trim().split('\n').filter(Boolean).pop();
  if (user && /^[a-zA-Z0-9._-]+$/.test(user)) return { ok: true, user };
  const err = (r.stderr || r.stdout).split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'Could not determine the effective user.';
  return { ok: false, error: friendlyElevation(err) };
}

// sudo/su failures have their own vocabulary — translate the common ones.
export function friendlyElevation(msg: string): string {
  if (/incorrect password|Sorry, try again|Authentication failure/i.test(msg)) return 'Wrong password for elevation.';
  if (/is not in the sudoers file|not allowed to execute/i.test(msg)) return 'This user is not allowed to run sudo on that host — use “Log in as root” or add them to sudoers.';
  if (/no tty present|sudo: a (terminal|password) is required/i.test(msg)) return 'sudo needs a terminal here — try the “su to root” mode instead.';
  if (/command not found|not found/i.test(msg) && /sudo/i.test(msg)) return 'sudo is not installed on that host — use “su to root” or log in as root.';
  return msg.slice(0, 200);
}

// An interactive login shell on a PTY, kept open by the caller. This is what
// makes the remote terminal behave like a terminal: one persistent session, so
// `cd`, exported variables, `sudo` prompts and full-screen tools all work.
export async function sshShell(
  vm: SshTarget,
  opts: { cols?: number; rows?: number } = {},
  via?: SshTarget
): Promise<{ conn: Client; hop?: Client; stream: any }> {
  const cfg = await authFor(vm, 20000);
  let hop: Client | undefined;
  if (via) {
    const t = await jumpSocket(via, vm, 20000);
    hop = t.hop;
    cfg.sock = t.sock;
  }
  const conn = await connect(cfg);
  return new Promise((resolve, reject) => {
    conn.shell(
      { term: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 30 },
      (err, stream) => {
        if (err) {
          try { conn.end(); } catch { /* already closed */ }
          try { hop?.end(); } catch { /* already closed */ }
          return reject(err);
        }
        resolve({ conn, hop, stream });
      }
    );
  });
}
