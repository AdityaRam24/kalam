import { describe, it, expect } from 'vitest';
import { canvasSignature, stripDuration } from '../topology';

const container = (over: Partial<Record<string, string>> = {}) => ({
  id: 'abc123def456',
  name: 'kalam-web',
  image: 'nginx:1.25',
  state: 'running',
  status: 'Up 7 minutes',
  ports: '0.0.0.0:8080->80/tcp',
  created: '7 minutes ago',
  ...over,
} as any);

const k8s = (over: Partial<any> = {}) => ({
  pods: [{ name: 'web-1', namespace: 'default', status: 'Running', ready: '1/1', ip: '10.0.0.4', restarts: 0, node: 'node-a', labels: { app: 'web' } }],
  services: [{ name: 'web', namespace: 'default', type: 'ClusterIP', clusterIp: '10.96.0.1', ports: '80/TCP', selector: '{"app":"web"}' }],
  deployments: [{ name: 'web', namespace: 'default', ready: '1/1', replicas: 1, available: 1 }],
  nodes: [{ name: 'node-a', status: 'Ready', role: 'control-plane', ip: '192.168.1.10' }],
  ...over,
});

describe('stripDuration', () => {
  it('collapses clock-driven wording', () => {
    expect(stripDuration('Up 7 minutes')).toBe(stripDuration('Up 8 minutes'));
    expect(stripDuration('3 hours ago')).toBe(stripDuration('4 hours ago'));
    expect(stripDuration('Up 2 days')).toBe(stripDuration('Up 15 days'));
  });

  it('leaves non-duration text alone', () => {
    expect(stripDuration('Exited (137) ')).toBe('Exited (137)');
    expect(stripDuration(undefined)).toBeUndefined();
  });
});

describe('canvasSignature', () => {
  it('is stable while only the uptime clock ticks', () => {
    const a = canvasSignature([container()], k8s());
    const b = canvasSignature([container({ status: 'Up 9 minutes', created: '9 minutes ago' })], k8s());
    expect(b).toBe(a);
  });

  it('is stable across fresh object identities carrying the same data', () => {
    expect(canvasSignature([container()], k8s())).toBe(canvasSignature([container()], k8s()));
  });

  it('changes when a container stops', () => {
    const running = canvasSignature([container()], k8s());
    const stopped = canvasSignature([container({ state: 'exited', status: 'Exited (0) 1 minute ago' })], k8s());
    expect(stopped).not.toBe(running);
  });

  it('changes when a pod restarts, changes phase, or moves node', () => {
    const base = canvasSignature([container()], k8s());
    const restarted = k8s();
    restarted.pods[0].restarts = 3;
    expect(canvasSignature([container()], restarted)).not.toBe(base);

    const crashed = k8s();
    crashed.pods[0].status = 'CrashLoopBackOff';
    expect(canvasSignature([container()], crashed)).not.toBe(base);

    const moved = k8s();
    moved.pods[0].node = 'node-b';
    expect(canvasSignature([container()], moved)).not.toBe(base);
  });

  it('changes when resources appear or disappear', () => {
    const base = canvasSignature([container()], k8s());
    expect(canvasSignature([], k8s())).not.toBe(base);
    const extra = k8s();
    extra.pods.push({ name: 'web-2', namespace: 'default', status: 'Running', ready: '1/1', ip: '10.0.0.5', restarts: 0, node: 'node-a', labels: { app: 'web' } });
    expect(canvasSignature([container()], extra)).not.toBe(base);
  });

  it('changes when a deployment loses a replica', () => {
    const base = canvasSignature([container()], k8s());
    const degraded = k8s();
    degraded.deployments[0].ready = '0/1';
    degraded.deployments[0].available = 0;
    expect(canvasSignature([container()], degraded)).not.toBe(base);
  });

  it('tolerates empty and missing payloads', () => {
    expect(canvasSignature(undefined, undefined)).toBe(
      canvasSignature([], { pods: [], services: [], deployments: [], nodes: [] })
    );
  });
});
