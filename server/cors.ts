// Which browser origins may talk to the API.
//
// This matters more than it looks: the API runs docker, kubectl and ssh, so an
// open policy means any page the user visits can drive their cluster. That is
// harmless while the server is on loopback, but the moment HOST=0.0.0.0 puts it
// behind an ingress it becomes remotely reachable — the allowlist starts
// mattering exactly when the deployment stops being local.
//
// Semantics match the Vite host check so one setting reads the same in both
// places: a leading dot matches the domain and all its subdomains.

export const DEFAULT_ALLOWED_HOSTS = ['.pcaicoe.com', '.ext.hpe.com'];

export function parseAllowedHosts(raw: string | undefined): string[] | 'any' {
  const value = (raw || '').trim();
  if (value === 'true') return 'any';
  if (!value) return DEFAULT_ALLOWED_HOSTS;
  const hosts = value.split(',').map((h) => h.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : DEFAULT_ALLOWED_HOSTS;
}

export function hostMatches(hostname: string, pattern: string): boolean {
  // A bare pattern is an exact hostname; ".example.com" also covers
  // "example.com" itself, so one entry handles a domain and its subdomains.
  if (!pattern.startsWith('.')) return hostname === pattern;
  return hostname === pattern.slice(1) || hostname.endsWith(pattern);
}

export function isOriginAllowed(origin: string, allowed: string[] | 'any'): boolean {
  if (allowed === 'any') return true;

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false; // unparseable Origin header — refuse rather than guess
  }
  if (!hostname) return false;

  // Any port on the loopback names: plain local dev and the Vite proxy.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

  return allowed.some((pattern) => hostMatches(hostname, pattern));
}

// A missing Origin header is not a browser cross-origin request: the CLI, curl
// and same-origin navigations all arrive without one and must keep working.
export function corsOriginCheck(
  origin: string | undefined,
  allowed: string[] | 'any',
): boolean {
  if (!origin) return true;
  return isOriginAllowed(origin, allowed);
}
