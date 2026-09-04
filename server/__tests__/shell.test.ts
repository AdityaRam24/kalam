// Guards on root elevation in the remote terminal.
//
// The rule these protect: a stored password is written to the shell ONLY in
// response to a prompt that is genuinely waiting for one. The previous
// implementation wrote it on a fixed timer, so on a host with passwordless
// sudo — where no prompt is ever printed — the password was typed into the
// freshly-opened root shell as a command, echoed on screen and recorded in
// root's shell history.

import { describe, it, expect } from 'vitest';
import { elevationStep } from '../shell.js';

const fresh = { hasPassword: true, sentPassword: false };

describe('elevationStep — when the password may be sent', () => {
  it('answers the sudo prompt', () => {
    expect(elevationStep('[sudo] password for steve: ', fresh)).toBe('send-password');
  });

  it('answers a bare su prompt', () => {
    expect(elevationStep('Password:', fresh)).toBe('send-password');
    expect(elevationStep("steve's Password: ", fresh)).toBe('send-password');
  });

  it('answers a prompt that arrives after a login banner', () => {
    const motd = 'Welcome to Ubuntu 22.04.3 LTS\nLast login: Tue Sep 2\nsteve@node1:~$ sudo -i\n[sudo] password for steve: ';
    expect(elevationStep(motd, fresh)).toBe('send-password');
  });
});

describe('elevationStep — when it must NOT be sent', () => {
  it('sends nothing when passwordless sudo produced a root prompt', () => {
    // The exact case that leaked the password into root's history.
    expect(elevationStep('steve@node1:~$ sudo -i\nroot@node1:~# ', fresh)).toBe('wait');
  });

  it('sends nothing while the shell is still printing', () => {
    expect(elevationStep('Welcome to Ubuntu\nLast login: Tue Sep 2 10:00:00\n', fresh)).toBe('wait');
  });

  it('sends nothing when no password is stored — the user types it', () => {
    expect(elevationStep('[sudo] password for steve: ', { hasPassword: false, sentPassword: false })).toBe('wait');
  });

  it('never sends the password twice', () => {
    expect(elevationStep('[sudo] password for steve: ', { hasPassword: true, sentPassword: true })).toBe('wait');
  });

  it('ignores the word "password" that is not a waiting prompt', () => {
    expect(elevationStep('changing password for steve\n', fresh)).toBe('wait');
    expect(elevationStep('cat /etc/passwd | grep password\n', fresh)).toBe('wait');
    // A prompt only counts at the very end of the output, where the shell has
    // stopped and is waiting.
    expect(elevationStep('[sudo] password for steve: \nroot@node1:~# ls\n', fresh)).toBe('wait');
  });
});

describe('elevationStep — giving up', () => {
  it('stops after a wrong password', () => {
    expect(elevationStep('[sudo] password for steve: \nSorry, try again.\n', fresh)).toBe('stop');
  });

  it('stops when the account may not use sudo', () => {
    expect(elevationStep('steve is not in the sudoers file.  This incident will be reported.\n', fresh)).toBe('stop');
  });

  it('stops on an su authentication failure', () => {
    expect(elevationStep('su: Authentication failure\n', fresh)).toBe('stop');
  });

  it('refusal wins over a prompt in the same buffer, so we stop retrying', () => {
    expect(elevationStep('Sorry, try again.\n[sudo] password for steve: ', fresh)).toBe('stop');
  });
});
