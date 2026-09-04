// Persistent interactive SSH shells.
//
// `/api/vms/exec` runs one command per TCP connection, in a non-interactive
// shell. That is why so many commands "did not work": every invocation started
// from scratch, so `cd` was forgotten, exported variables vanished, anything
// that prompted (sudo, passwd, apt) hung with no way to answer, and tools that
// insist on a TTY refused to run at all.
//
// This module keeps ONE real login shell open per session, on a PTY, exactly
// like a terminal emulator does:
//
//   POST /api/vms/shell/open        { name, cols, rows, asRoot } -> { id }
//   GET  /api/vms/shell/:id/stream  server-sent events of raw output
//   POST /api/vms/shell/:id/input   { data } — keystrokes, including control chars
//   POST /api/vms/shell/:id/resize  { cols, rows }
//   POST /api/vms/shell/:id/close
//
// Sessions live in memory only and are closed when idle.

import { Router, type Response } from 'express';
import { randomUUID } from 'crypto';
import { sshShell, friendly } from './ssh.js';
import { loadVms, type VmEntry } from './vms.js';

export const shellRouter = Router();

interface Session {
  id: string;
  vm: string;
  conn: any;
  hop?: any;
  stream: any;
  // Replayed to a client that connects (or reconnects) after output arrived —
  // without it, a page refresh loses the scrollback and looks like a dead shell.
  scrollback: string;
  subscribers: Set<Response>;
  lastUsed: number;
  closed: boolean;
  exitNote?: string;
}

const sessions = new Map<string, Session>();
const MAX_SCROLLBACK = 256 * 1024;
const IDLE_MS = 30 * 60 * 1000;
// One terminal per host is plenty and keeps a runaway client from opening
// hundreds of SSH connections.
const MAX_SESSIONS = 12;

function broadcast(s: Session, event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of s.subscribers) {
    try { res.write(payload); } catch { s.subscribers.delete(res); }
  }
}

function destroy(s: Session, note?: string) {
  if (s.closed) return;
  s.closed = true;
  s.exitNote = note;
  broadcast(s, 'exit', { note: note || 'Session closed.' });
  for (const res of s.subscribers) { try { res.end(); } catch { /* gone */ } }
  s.subscribers.clear();
  try { s.stream?.end(); } catch { /* already closed */ }
  try { s.conn?.end(); } catch { /* already closed */ }
  try { s.hop?.end(); } catch { /* already closed */ }
  sessions.delete(s.id);
}

// Idle reaper: an abandoned browser tab must not hold an SSH connection open
// forever.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastUsed > IDLE_MS) destroy(s, 'Session closed after 30 minutes idle.');
  }
}, 60_000).unref?.();

async function jumpFor(vm: VmEntry): Promise<VmEntry | undefined> {
  if (!vm.via) return undefined;
  return (await loadVms()).find((v) => v.name === vm.via && v.name !== vm.name);
}

// A shell asking for a password: "[sudo] password for steve:", "Password:",
// "steve's Password:". Anchored to the end of the buffer because a prompt is
// only a prompt when the shell has stopped and is waiting for input.
const PASSWORD_PROMPT = /password[^\n]{0,60}:\s*$/i;

// The shell telling us elevation did not work. The text is already on the
// user's screen — this only stops us from feeding it more input.
const ELEVATION_REFUSED = /(Sorry, try again|Authentication failure|is not in the sudoers file|incorrect password attempt)/i;

// How long to keep watching for a prompt before giving up and leaving the
// session to the user. Long enough for a slow link, short enough that a stored
// password is never sent into an unrelated command later in the session.
const ELEVATION_WINDOW_MS = 20_000;

/**
 * Elevate an open shell to root, driven by what the shell actually says.
 *
 * This must never write the password speculatively. A host with passwordless
 * sudo prints no prompt at all, so a timer-based version types the password
 * straight into the freshly-opened root shell — where it is echoed on screen
 * and written to root's shell history. The password is only ever sent in
 * response to a prompt that is genuinely waiting for one, once, and only
 * inside the window below.
 */
export type ElevationStep = 'wait' | 'send-password' | 'stop';

/**
 * What to do with the elevation output seen so far. Pure, so the rule that
 * guards the password is covered by tests rather than by hope.
 */
export function elevationStep(
  buffer: string,
  opts: { hasPassword: boolean; sentPassword: boolean },
): ElevationStep {
  if (ELEVATION_REFUSED.test(buffer)) return 'stop';
  if (!opts.sentPassword && opts.hasPassword && PASSWORD_PROMPT.test(buffer)) return 'send-password';
  return 'wait';
}

function beginElevation(s: Session, vm: VmEntry) {
  const mode = vm.elevate === 'su' ? 'su' : 'sudo';
  const password = vm.elevatePassword ?? vm.password;
  let buffer = '';
  let sentPassword = false;
  let done = false;

  const stop = () => {
    if (done) return;
    done = true;
    s.stream.removeListener('data', onData);
    clearTimeout(timer);
  };

  const onData = (chunk: Buffer) => {
    if (done) return;
    // A bounded tail is all a prompt check needs, and it keeps a chatty MOTD
    // from growing this buffer without limit.
    buffer = (buffer + chunk.toString('utf8')).slice(-2048);

    const step = elevationStep(buffer, { hasPassword: !!password, sentPassword });
    if (step === 'stop') { stop(); return; }
    if (step === 'send-password') {
      sentPassword = true;
      buffer = '';
      try { s.stream.write(`${password}\n`); } catch { /* session closed */ }
      // Stop watching shortly after: from here on the session belongs to the
      // user, and anything that looks like a prompt is their own command.
      setTimeout(stop, 3000).unref?.();
    }
  };

  const timer = setTimeout(stop, ELEVATION_WINDOW_MS);
  timer.unref?.();
  s.stream.on('data', onData);

  // Give the login shell a moment to finish printing its banner, then ask.
  setTimeout(() => {
    if (done) return;
    try { s.stream.write(mode === 'su' ? 'su - root\n' : 'sudo -i\n'); } catch { stop(); }
  }, 400).unref?.();
}

shellRouter.post('/api/vms/shell/open', async (req, res) => {
  const { name, cols, rows, asRoot } = req.body || {};
  const vm = (await loadVms()).find((v) => v.name === name);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: 'Too many open terminals — close one first.' });

  try {
    const { conn, hop, stream } = await sshShell(
      vm,
      { cols: Math.min(Math.max(parseInt(cols, 10) || 120, 20), 400), rows: Math.min(Math.max(parseInt(rows, 10) || 30, 5), 200) },
      await jumpFor(vm)
    );

    const s: Session = {
      id: randomUUID(), vm: vm.name, conn, hop, stream,
      scrollback: '', subscribers: new Set(), lastUsed: Date.now(), closed: false,
    };
    sessions.set(s.id, s);

    stream.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      s.scrollback = (s.scrollback + text).slice(-MAX_SCROLLBACK);
      s.lastUsed = Date.now();
      broadcast(s, 'data', text);
    });
    stream.on('close', () => destroy(s, 'Remote shell exited.'));
    conn.on('error', (e: any) => destroy(s, friendly(e)));

    // "Open as root" types the elevation the same way a person would, so the
    // rest of the session simply IS root — no per-command wrapping.
    const wantRoot = !!asRoot && vm.user !== 'root';
    if (wantRoot) beginElevation(s, vm);

    res.json({
      id: s.id,
      vm: vm.name,
      user: vm.user,
      root: vm.user === 'root' || wantRoot,
      elevate: vm.elevate || 'none',
    });
  } catch (e: any) {
    res.status(200).json({ error: friendly(e) });
  }
});

shellRouter.get('/api/vms/shell/:id/stream', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such terminal session.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  s.subscribers.add(res);
  s.lastUsed = Date.now();
  if (s.scrollback) res.write(`event: data\ndata: ${JSON.stringify(s.scrollback)}\n\n`);

  // Proxies drop a silent stream; a comment every 25s keeps it alive.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 25_000);
  req.on('close', () => {
    clearInterval(ping);
    s.subscribers.delete(res);
  });
});

shellRouter.post('/api/vms/shell/:id/input', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such terminal session.' });
  const { data } = req.body || {};
  if (typeof data !== 'string') return res.status(400).json({ error: 'data must be a string.' });
  s.lastUsed = Date.now();
  try {
    s.stream.write(data);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: friendly(e) });
  }
});

shellRouter.post('/api/vms/shell/:id/resize', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such terminal session.' });
  const cols = Math.min(Math.max(parseInt(req.body?.cols, 10) || 120, 20), 400);
  const rows = Math.min(Math.max(parseInt(req.body?.rows, 10) || 30, 5), 200);
  try { s.stream.setWindow(rows, cols, 0, 0); } catch { /* server may refuse */ }
  res.json({ ok: true });
});

shellRouter.post('/api/vms/shell/:id/close', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) destroy(s, 'Closed by the user.');
  res.json({ ok: true });
});

// Convenience for the UI: which terminals are already open.
shellRouter.get('/api/vms/shell', (_req, res) => {
  res.json({ sessions: Array.from(sessions.values()).map((s) => ({ id: s.id, vm: s.vm, idleSec: Math.round((Date.now() - s.lastUsed) / 1000) })) });
});

// Exported for tests / shutdown.
export function closeAllShells(): void {
  for (const s of Array.from(sessions.values())) destroy(s, 'Server shutting down.');
}
