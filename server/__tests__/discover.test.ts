// Regression guards for the failure that made a real multi-node cluster show
// its containers and nothing else.
//
// `/api/vms/discover` pulled every kind — pods, services, nodes, deployments,
// statefulsets, daemonsets, replicasets — through ONE SSH command reading into
// sshRun's 4 MB default buffer. Real pod objects are around 12 KB each, so a
// few hundred pods overran it. Output is read in section order, so the
// container sections (early) survived and every Kubernetes section after them
// was cut off or never arrived at all. Nothing reported a problem: the
// truncated JSON simply failed to parse and was swallowed into an empty array.

import { describe, it, expect } from 'vitest';
import { section, readKindItems } from '../vms.js';

/** A pod roughly the size kubectl actually emits (~12 KB measured). */
const bigPod = (i: number) => ({
  kind: 'Pod',
  metadata: {
    name: `workload-${Math.floor(i / 5)}-7d9f8b${String(i).padStart(4, '0')}`,
    namespace: `ns-${i % 12}`,
    labels: { app: `app${i % 60}`, 'pod-template-hash': '7d9f8b', tier: 'backend' },
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': 'x'.repeat(9000) },
    ownerReferences: [{ kind: 'ReplicaSet', name: `workload-${Math.floor(i / 5)}-7d9f8b`, controller: true }],
  },
  spec: { nodeName: `node-${i % 24}`, containers: [{ name: 'main', image: 'registry/team/app:1.2.3' }] },
  status: { phase: 'Running', podIP: `10.1.${i % 256}.5`, containerStatuses: [{ name: 'main', ready: true, restartCount: 0, state: { running: {} } }] },
});

const podList = (n: number) => JSON.stringify({ apiVersion: 'v1', items: Array.from({ length: n }, (_, i) => bigPod(i)) });

describe('readKindItems — an empty result must say why', () => {
  it('reads a complete section', () => {
    const r = readKindItems(podList(3));
    expect(r.status).toBe('3');
    expect(r.items).toHaveLength(3);
  });

  it('reports a section cut mid-stream as cut-short, NOT as an empty cluster', () => {
    // Exactly what a buffer overrun leaves behind: valid JSON, sliced in half.
    const full = podList(700);
    const cut = full.slice(0, 4 * 1024 * 1024);
    expect(cut.length).toBeLessThan(full.length); // the fixture must actually be truncated
    const r = readKindItems(cut);
    expect(r.items).toEqual([]);
    expect(r.status).toBe('cut-short');
  });

  it('distinguishes a genuinely empty cluster from a failed read', () => {
    expect(readKindItems(JSON.stringify({ items: [] })).status).toBe('0');
    expect(readKindItems('').status).toBe('empty');
    expect(readKindItems('   ').status).toBe('empty');
  });

  it('reports non-JSON output (a kubectl error) as unreadable', () => {
    expect(readKindItems('error: You must be logged in to the server').status).toBe('unreadable');
    expect(readKindItems('sh: kubectl: command not found').status).toBe('unreadable');
  });
});

describe('a realistic cluster exceeds the old 4 MB default', () => {
  it('confirms the overrun that hid every Kubernetes section', () => {
    const OLD_DEFAULT = 4 * 1024 * 1024;
    const pods = podList(600);
    expect(pods.length).toBeGreaterThan(OLD_DEFAULT);
    // Sections are read in order, so a cut inside the pod JSON removes that
    // section AND everything the command would have emitted after it.
    expect(readKindItems(pods.slice(0, OLD_DEFAULT)).status).toBe('cut-short');
  });
});

describe('section extraction across the split commands', () => {
  const host = ['@@ENGINES@@', 'docker', 'kubectl', '@@DOCKER@@', '{"ID":"abc"}', '@@KUBECHECK@@', 'ok', '@@END@@'].join('\n');
  const k8s = ['@@KNODES@@', JSON.stringify({ items: [1] }), '@@KSVCS@@', JSON.stringify({ items: [1, 2] }), '@@KPODS@@', JSON.stringify({ items: [1, 2, 3] }), '@@END@@'].join('\n');

  it('reads each section from its own command output', () => {
    expect(section(host, 'ENGINES').split('\n')).toEqual(['docker', 'kubectl']);
    expect(section(host, 'KUBECHECK')).toBe('ok');
    expect(readKindItems(section(k8s, 'KPODS')).items).toHaveLength(3);
    expect(readKindItems(section(k8s, 'KNODES')).items).toHaveLength(1);
  });

  it('reports a missing section rather than silently borrowing the next one', () => {
    expect(section(k8s, 'KDEPLOYS')).toBe('');
    expect(readKindItems(section(k8s, 'KDEPLOYS')).status).toBe('empty');
  });

  it('keeps the host command independent of the cluster command', () => {
    // The point of the split: a cluster read that fails entirely still leaves
    // the host's containers and engines intact.
    expect(section(host, 'DOCKER')).toContain('"ID":"abc"');
    expect(readKindItems(section('', 'KPODS')).status).toBe('empty');
  });
});
