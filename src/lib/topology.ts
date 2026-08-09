// Helpers that decide when the topology canvas has *really* changed.
//
// The cluster is polled every few seconds, and each poll hands the UI brand-new
// objects. Some of the fields in them re-word themselves on every single poll
// (`docker ps` reports "Up 7 minutes"), so comparing raw payloads reports a
// change constantly and the canvas rebuilds itself forever. These helpers reduce
// a payload to just what the canvas draws, with the clock-driven text removed.

export interface TopologyContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  created?: string;
}

export interface TopologyK8s {
  pods: any[];
  services: any[];
  deployments: any[];
  nodes: any[];
}

/** "Up 7 minutes" and "Up 8 minutes" are the same state to the canvas. */
export const stripDuration = (s: unknown): unknown =>
  typeof s === 'string'
    ? s.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?/gi, '~').trim()
    : s;

/**
 * Fingerprint of everything the canvas actually draws. Two payloads sharing a
 * fingerprint produce a pixel-identical graph, so the previous data can be
 * reused and the layout left completely untouched.
 */
export const canvasSignature = (
  containers: TopologyContainer[] | undefined,
  k8s: TopologyK8s | undefined
): string =>
  JSON.stringify({
    c: (containers || []).map(c => [c.id, c.name, c.image, c.state, c.ports, stripDuration(c.status)]),
    p: (k8s?.pods || []).map((p: any) => [p.name, p.namespace, p.status, p.ready, p.ip, p.restarts, p.node, p.labels]),
    s: (k8s?.services || []).map((s: any) => [s.name, s.namespace, s.type, s.clusterIp, s.ports, s.selector]),
    d: (k8s?.deployments || []).map((d: any) => [d.name, d.namespace, d.ready, d.replicas, d.available]),
    n: (k8s?.nodes || []).map((n: any) => [n.name, n.status, n.role, n.ip]),
  });
