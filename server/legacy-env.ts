// MIGRATION SHIM — settings from before the product was renamed Trinetra.
//
// Every environment variable is now TRINETRA_*. Machines, systemd units, .env
// files and Helm values written before the rename still say KALAM_*; rather
// than silently ignoring them, each one is adopted under its new name (an
// explicit TRINETRA_* always wins) and a one-line notice says what to rename.
//
// This file is the only place in the server that knows the old name. It must
// be the FIRST import of every entry point, because several modules read
// their settings when they load.

const OLD_PREFIX = 'KALAM_';
const NEW_PREFIX = 'TRINETRA_';
const adopted = new Set<string>();

export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const fresh: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(OLD_PREFIX) || v === undefined) continue;
    const next = NEW_PREFIX + k.slice(OLD_PREFIX.length);
    if (env[next] === undefined) env[next] = v;
    if (!adopted.has(k)) { adopted.add(k); fresh.push(k); }
  }
  if (fresh.length && env === process.env && !process.env.VITEST) {
    console.warn(`[trinetra] using pre-rename settings ${fresh.join(', ')} — rename them to ${fresh.map((k) => NEW_PREFIX + k.slice(OLD_PREFIX.length)).join(', ')}.`);
  }
  return fresh;
}

adoptLegacyEnv();
