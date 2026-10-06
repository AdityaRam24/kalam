// VME Manager connections.
//
// Same rules as the SSH inventory (server/vms.ts): one JSON file, git-ignored,
// mode 0600 because it holds an API token or a password, overridable path for
// containers, and secrets never sent to the browser.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.TRINETRA_VME_PATH || path.join(__dirname, 'vme.json');

export const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

export interface VmeConnection {
  name: string;
  /** Base URL of the Manager, e.g. https://vme-manager.example.com */
  url: string;
  /** API access token (User Settings → API Access). Preferred over a password. */
  token?: string;
  username?: string;
  password?: string;
  /** Accept a self-signed Manager certificate. */
  insecureTls?: boolean;
  /** Kubernetes source to join with: 'local' (this kubeconfig) or an inventory VM name. */
  k8sSource?: string;
}

export async function loadConnections(): Promise<VmeConnection[]> {
  try {
    const raw = JSON.parse(await fs.readFile(STORE_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function saveConnections(list: VmeConnection[]): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true }).catch(() => {});
  await fs.writeFile(STORE_PATH, JSON.stringify(list, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(STORE_PATH, 0o600).catch(() => {});
}

/** What the browser may see. */
export function publicConnection(c: VmeConnection) {
  const { token, password, ...rest } = c;
  return { ...rest, hasToken: !!token, hasPassword: !!password };
}

/** Validate an incoming connection body; returns an error sentence or the clean entry. */
export function validateConnection(body: any, existing?: VmeConnection): string | VmeConnection {
  const name = String(body?.name || '').trim();
  if (!NAME_RE.test(name)) return 'Name: letters, numbers, . _ - only.';
  let url: URL;
  try { url = new URL(String(body?.url || '').trim()); } catch { return 'URL must be like https://vme-manager.example.com'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'URL must start with https:// (or http://).';
  const k8sSource = body?.k8sSource ? String(body.k8sSource) : undefined;
  if (k8sSource && k8sSource !== 'local' && !NAME_RE.test(k8sSource)) return 'Invalid Kubernetes source.';
  // `auth` picks the login method and drops the other one's secret. Blank
  // secret fields on an edit mean "keep what is stored".
  const auth = body?.auth === 'password' ? 'password' : 'token';
  const token = auth === 'token' ? (body?.token ? String(body.token).trim() : existing?.token) : undefined;
  const username = auth === 'password' ? (body?.username !== undefined ? String(body.username).trim() || undefined : existing?.username) : undefined;
  const password = auth === 'password' ? (body?.password ? String(body.password) : existing?.password) : undefined;
  if (!token && !(username && password)) return 'Give an API token, or a username and password.';
  return { name, url: url.origin + url.pathname.replace(/\/+$/, ''), token, username, password, insecureTls: !!body?.insecureTls, k8sSource };
}
