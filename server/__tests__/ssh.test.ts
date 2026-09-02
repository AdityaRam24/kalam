// Proves the MobaXterm-style login path: host + user + password, no key, port 22
// implied. Runs a real ssh2 SSH daemon on an ephemeral port and connects to it,
// so this exercises the actual protocol handshake and auth exchange rather than
// a mock. The daemon's port is injected via SSH_PORT_OVERRIDE (test-only).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server, utils } from 'ssh2';
import type { AddressInfo } from 'net';
import { sshExec, sshCheck, friendly, buildRemoteCommand, friendlyElevation } from '../ssh.js';

const USER = 'kalam';
const PASS = 'correct-horse';

let server: Server;
let port: number;

beforeAll(async () => {
  const keys = utils.generateKeyPairSync('ed25519');
  server = new Server({ hostKeys: [keys.private] }, (client) => {
    client.on('authentication', (ctx) => {
      // Accept only the right username+password, exactly like a real sshd.
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) return ctx.accept();
      if (ctx.method === 'none') return ctx.reject(['password'], true);
      return ctx.reject(['password'], false);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`ran:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      process.env.SSH_PORT_OVERRIDE = String(port);
      resolve();
    });
  });
});

afterAll(async () => {
  delete process.env.SSH_PORT_OVERRIDE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('password SSH login', () => {
  it('authenticates with just host, user and password', async () => {
    const r = await sshExec({ name: 'vm', host: '127.0.0.1', user: USER, password: PASS }, 'uptime');
    expect(r.ok).toBe(true);
    // The command reaches the host with a PATH prefix (see buildRemoteCommand)
    // so tools in /usr/local/bin resolve the way they do in a real terminal.
    expect(r.stdout).toContain('uptime');
    expect(r.stdout).toContain('/usr/local/bin');
  });

  it('sends the command untouched when raw is requested', async () => {
    const r = await sshExec({ name: 'vm', host: '127.0.0.1', user: USER, password: PASS }, 'uptime', 15000, undefined, { raw: true });
    expect(r.stdout).toContain('ran:uptime');
  });

  it('reports a wrong password as a login failure, not a generic error', async () => {
    const r = await sshCheck({ name: 'vm', host: '127.0.0.1', user: USER, password: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/check the username and password/i);
  });

  it('does not hang or prompt when no credentials are supplied', async () => {
    const r = await sshCheck({ name: 'vm', host: '127.0.0.1', user: USER });
    expect(r.ok).toBe(false);
  });
});

describe('buildRemoteCommand', () => {
  const base = { name: 'vm', host: 'h', user: 'ubuntu', password: 'pw' };

  it('runs user commands in a login shell so their PATH and profile apply', () => {
    const b = buildRemoteCommand(base, 'kubectl get pods', { login: true });
    expect(b.command).toContain('bash -lc');
    expect(b.command).toContain('kubectl get pods');
    expect(b.pty).toBe(false);
  });

  it('gives parsed probes an explicit PATH instead of a login shell', () => {
    // A login shell would print profile banners into output that gets parsed.
    const b = buildRemoteCommand(base, 'echo @@X@@');
    expect(b.command).not.toContain('bash -lc');
    expect(b.command).toContain('/usr/local/bin');
  });

  it('feeds the sudo password on stdin, never as an argument', () => {
    const b = buildRemoteCommand({ ...base, elevate: 'sudo' }, 'crictl ps');
    expect(b.command).toContain('sudo -S');
    expect(b.command).not.toContain('pw'); // would otherwise show up in `ps`
    expect(b.stdin).toBe('pw\n');
  });

  it('uses a separate elevation password when one is stored', () => {
    const b = buildRemoteCommand({ ...base, elevate: 'su', elevatePassword: 'rootpw' }, 'id');
    expect(b.command).toContain('su - root -c');
    expect(b.stdin).toBe('rootpw\n');
    expect(b.pty).toBe(true); // su refuses to run without a terminal
  });

  it('never wraps a root login in sudo', () => {
    const b = buildRemoteCommand({ ...base, user: 'root', elevate: 'sudo' }, 'id');
    expect(b.command).not.toContain('sudo');
    expect(b.stdin).toBeUndefined();
  });

  it('quotes commands containing single quotes', () => {
    const b = buildRemoteCommand(base, `awk '{print $1}'`, { login: true });
    // Round-trips through the shell without ending the quoted string early.
    expect(b.command).toContain(`'\\''`);
  });
});

describe('friendlyElevation', () => {
  it('explains why elevation failed in terms of what to change', () => {
    expect(friendlyElevation('user is not in the sudoers file')).toMatch(/Log in as root|sudoers/);
    expect(friendlyElevation('sudo: no tty present and no askpass program specified')).toMatch(/su to root/);
    expect(friendlyElevation('sudo: 1 incorrect password attempt')).toMatch(/Wrong password/);
  });
});

describe('friendly', () => {
  it('maps raw ssh2 errors to actionable text', () => {
    expect(friendly(new Error('connect ECONNREFUSED 10.0.0.1:22'))).toMatch(/not listening/);
    expect(friendly(new Error('getaddrinfo ENOTFOUND nope'))).toMatch(/Host not found/);
    expect(friendly(new Error('All configured authentication methods failed'))).toMatch(/username and password/);
  });
});
