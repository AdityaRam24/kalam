import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ALLOWED_HOSTS,
  parseAllowedHosts,
  hostMatches,
  isOriginAllowed,
  corsOriginCheck,
} from '../cors.js';

describe('parseAllowedHosts', () => {
  it('falls back to the defaults when unset or blank', () => {
    expect(parseAllowedHosts(undefined)).toEqual(DEFAULT_ALLOWED_HOSTS);
    expect(parseAllowedHosts('')).toEqual(DEFAULT_ALLOWED_HOSTS);
    expect(parseAllowedHosts('   ')).toEqual(DEFAULT_ALLOWED_HOSTS);
  });

  it('treats "true" as the opt-out, not as a hostname', () => {
    expect(parseAllowedHosts('true')).toBe('any');
  });

  it('splits and trims a comma-separated list', () => {
    expect(parseAllowedHosts('a.com, .b.com ,c.com')).toEqual(['a.com', '.b.com', 'c.com']);
  });

  it('does not degrade to an empty allowlist on a list of separators', () => {
    // An empty array would reject every origin including the app's own — the
    // defaults are the safer reading of "the user set nothing meaningful".
    expect(parseAllowedHosts(',,')).toEqual(DEFAULT_ALLOWED_HOSTS);
  });
});

describe('hostMatches', () => {
  it('matches a bare pattern exactly', () => {
    expect(hostMatches('a.com', 'a.com')).toBe(true);
    expect(hostMatches('sub.a.com', 'a.com')).toBe(false);
  });

  it('matches the domain and its subdomains for a leading dot', () => {
    expect(hostMatches('pcaicoe.com', '.pcaicoe.com')).toBe(true);
    expect(hostMatches('kubeflow.labpcaidev.pcaicoe.com', '.pcaicoe.com')).toBe(true);
  });

  it('does not let a suffix match span a domain boundary', () => {
    // The bug this guards: endsWith('.pcaicoe.com') must not accept an
    // attacker-registered "evilpcaicoe.com".
    expect(hostMatches('evilpcaicoe.com', '.pcaicoe.com')).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  const allowed = DEFAULT_ALLOWED_HOSTS;

  it('accepts the real ingress hostname', () => {
    expect(isOriginAllowed('https://kubeflow.labpcaidev.pcaicoe.com', allowed)).toBe(true);
  });

  it('accepts loopback on any port regardless of the allowlist', () => {
    expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3001', allowed)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', [])).toBe(true);
  });

  it('rejects an unrelated origin', () => {
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
  });

  it('rejects an unparseable Origin header instead of guessing', () => {
    expect(isOriginAllowed('not a url', allowed)).toBe(false);
    expect(isOriginAllowed('', allowed)).toBe(false);
  });

  it('accepts anything under the "any" opt-out', () => {
    expect(isOriginAllowed('https://evil.example.com', 'any')).toBe(true);
  });
});

describe('corsOriginCheck', () => {
  it('allows requests with no Origin header', () => {
    // The CLI and curl send none; rejecting them would break `kalam ask`.
    expect(corsOriginCheck(undefined, DEFAULT_ALLOWED_HOSTS)).toBe(true);
  });

  it('still filters browser origins', () => {
    expect(corsOriginCheck('https://evil.example.com', DEFAULT_ALLOWED_HOSTS)).toBe(false);
    expect(corsOriginCheck('https://mlis.pcaicoe.com', DEFAULT_ALLOWED_HOSTS)).toBe(true);
  });
});
