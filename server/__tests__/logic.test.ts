// Unit tests for Kalam's pure logic: the diagnosis rule engine, SSH output
// section parsing, KB chunking/tokenizing/search, and learned-doc classification.
// Run with: npm test

import { describe, it, expect } from 'vitest';
import { diagnoseReason, section, humanAge, matchNode, parseContainers, parseCrictl } from '../vms.js';
import { identifyComponent } from '../pcai/components.js';
import { chunkText, tokenize, searchKB, KnowledgeBase } from '../pcai/store.js';
import { guessKind } from '../pcai/router.js';

describe('diagnoseReason (read-only diagnosis rule engine)', () => {
  it('flags CrashLoopBackOff as critical with rollout suggestions', () => {
    const d = diagnoseReason('CrashLoopBackOff', { restarts: 7 });
    expect(d.severity).toBe('critical');
    expect(d.detail).toContain('7 restarts');
    expect(d.fixes.some((f) => f.includes('rollout restart'))).toBe(true);
  });

  it('flags OOMKilled with exit code 137 and memory-limit fix', () => {
    const d = diagnoseReason('OOMKilled', { exitCode: 137 });
    expect(d.severity).toBe('critical');
    expect(d.detail).toContain('137');
    expect(d.fixes.some((f) => f.includes('--limits=memory'))).toBe(true);
  });

  it('treats image pull failures as critical registry problems', () => {
    for (const reason of ['ImagePullBackOff', 'ErrImagePull']) {
      const d = diagnoseReason(reason);
      expect(d.severity).toBe('critical');
      expect(d.detail.toLowerCase()).toContain('image');
    }
  });

  it('treats Pending and Evicted as warnings', () => {
    expect(diagnoseReason('Pending').severity).toBe('warning');
    expect(diagnoseReason('Evicted').severity).toBe('warning');
  });

  it('falls back gracefully for unknown reasons', () => {
    const d = diagnoseReason('SomethingNew');
    expect(d.severity).toBe('warning');
    expect(d.detail).toContain('SomethingNew');
    expect(d.fixes.length).toBeGreaterThan(0);
  });
});

describe('section (delimited SSH output parsing)', () => {
  const out = '@@ENGINES@@\ndocker\nkubectl\n@@DOCKER@@\n{"ID":"abc"}\n@@END@@';

  it('extracts a middle section', () => {
    expect(section(out, 'ENGINES')).toBe('docker\nkubectl');
  });

  it('extracts the last content section', () => {
    expect(section(out, 'DOCKER')).toBe('{"ID":"abc"}');
  });

  it('returns empty for a missing tag', () => {
    expect(section(out, 'NOPE')).toBe('');
  });
});

describe('chunkText (KB chunking)', () => {
  it('keeps short text as a single chunk', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
  });

  it('returns no chunks for empty text', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text into overlapping chunks under the max length', () => {
    const para = 'A sentence about Kubernetes troubleshooting. '.repeat(20);
    const text = Array.from({ length: 8 }, () => para).join('\n\n');
    const chunks = chunkText(text, 1200, 150);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1200 + 200);
  });
});

describe('tokenize + searchKB (lexical retrieval)', () => {
  it('lowercases and drops stopwords', () => {
    const t = tokenize('The Pod IS in a CrashLoopBackOff state');
    expect(t).toContain('pod');
    expect(t).toContain('crashloopbackoff');
    expect(t).not.toContain('the');
    expect(t).not.toContain('is');
  });

  it('ranks the chunk matching the query highest', () => {
    const mk = (id: string, text: string) => ({ id, title: id, url: `u://${id}`, text, tokens: tokenize(text) });
    const kb: KnowledgeBase = {
      version: 1, createdAt: '', updatedAt: '', embedProvider: 'none', embedModel: 'lexical',
      chunks: [
        mk('gpu', 'GPU operator daemonset installs NVIDIA drivers on cluster nodes'),
        mk('oom', 'OOMKilled means the container exceeded its memory limit, raise the limit'),
        mk('net', 'Service networking uses ClusterIP and kube-proxy routing'),
      ],
    };
    const hits = searchKB(kb, 'container OOMKilled memory limit', null, 2);
    expect(hits[0].id).toBe('oom');
  });
});

describe('guessKind (learned-document classification)', () => {
  it('detects runbooks', () => {
    expect(guessKind('GPU reset', 'Runbook: Step 1: cordon the node...')).toBe('runbook');
  });
  it('detects logs', () => {
    expect(guessKind('dump', 'FATAL error: Traceback (most recent call last)')).toBe('log');
  });
  it('detects diagrams', () => {
    expect(guessKind('arch', '```mermaid\nflowchart LR\nA-->B\n```')).toBe('diagram');
  });
  it('defaults to note', () => {
    expect(guessKind('misc', 'General observations about the platform rollout plans.')).toBe('note');
  });
});

describe('identifyComponent (node brain component catalog)', () => {
  it('explains why a SPIRE agent runs on every node', () => {
    const c = identifyComponent('spire-agent-x9k2 ghcr.io/spiffe/spire-agent:1.9 spire-system');
    expect(c?.id).toBe('spire-agent');
    expect(c?.category).toBe('Identity & Security');
    expect(c?.why.toLowerCase()).toContain('daemonset');
    expect(c?.impact.toLowerCase()).toContain('svid');
  });

  it('explains Kyverno as an admission policy engine and its failurePolicy blast radius', () => {
    const c = identifyComponent('kyverno-admission-controller-77b ghcr.io/kyverno/kyverno:v1.12 kyverno');
    expect(c?.id).toBe('kyverno');
    expect(c?.what.toLowerCase()).toContain('admission');
    expect(c?.impact).toContain('failurePolicy');
  });

  it('matches GPU components more specifically than generic observability', () => {
    expect(identifyComponent('nvidia-dcgm-exporter-abc nvcr.io/nvidia/k8s/dcgm-exporter:3.3 gpu-operator')?.id).toBe('nvidia-dcgm');
    expect(identifyComponent('nvidia-device-plugin-daemonset-zz kube-system')?.id).toBe('nvidia-device-plugin');
  });

  it('recognizes host systemd units as well as pods', () => {
    expect(identifyComponent('kubelet.service')?.id).toBe('kubelet');
    expect(identifyComponent('containerd.service')?.id).toBe('containerd');
  });

  it('returns null for unrecognized application workloads', () => {
    expect(identifyComponent('my-billing-api-7d4 registry.corp/billing:2.1 finance')).toBeNull();
  });
});

describe('humanAge', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  it('formats seconds, minutes, hours and days', () => {
    expect(humanAge('2026-07-28T11:59:30Z', now)).toBe('30s ago');
    expect(humanAge('2026-07-28T11:00:00Z', now)).toBe('60m ago');
    expect(humanAge('2026-07-27T12:00:00Z', now)).toBe('24h ago');
    expect(humanAge('2026-07-20T12:00:00Z', now)).toBe('8d ago');
  });
  it('returns empty for missing or unparseable input', () => {
    expect(humanAge(undefined, now)).toBe('');
    expect(humanAge('not-a-date', now)).toBe('');
  });
});

describe('matchNode (SSH host -> cluster node)', () => {
  const nodes = [
    { metadata: { name: 'worker-01.lab.local' }, status: { addresses: [{ type: 'InternalIP', address: '10.0.0.11' }] } },
    { metadata: { name: 'gpu-node-2' }, status: { addresses: [{ type: 'InternalIP', address: '10.0.0.12' }, { type: 'Hostname', address: 'gpu2.lab.local' }] } },
  ];
  it('matches on the short hostname when domains differ', () => {
    expect(matchNode(nodes, 'worker-01', [])?.metadata.name).toBe('worker-01.lab.local');
  });
  it('matches on internal IP when names differ', () => {
    expect(matchNode(nodes, 'unrelated-name', ['10.0.0.12'])?.metadata.name).toBe('gpu-node-2');
  });
  it('matches on the node Hostname address', () => {
    expect(matchNode(nodes, 'gpu2', [])?.metadata.name).toBe('gpu-node-2');
  });
  it('returns undefined for a host outside the cluster', () => {
    expect(matchNode(nodes, 'laptop', ['192.168.1.5'])).toBeUndefined();
  });
});


// Kalam must visualize a host that has no Docker at all. A stock Kubernetes
// node runs containerd only, so if container discovery is docker-shaped the
// dashboard and topology come up empty on exactly the machines that matter.
describe('parseContainers (runtime-agnostic container discovery)', () => {
  const dockerLine = JSON.stringify({ ID: 'abc123456789', Names: 'web', Image: 'nginx:1.25', Status: 'Up 3 hours', Ports: '0.0.0.0:80->80/tcp' });
  const nerdctlLine = JSON.stringify({ ID: 'def123456789', Names: 'side', Image: 'redis:7', Status: 'Up 2 minutes', Ports: '' });
  const crictlJson = JSON.stringify({
    containers: [{
      id: 'aaaabbbbccccdddd', state: 'CONTAINER_RUNNING',
      metadata: { name: 'coredns' }, image: { image: 'registry.k8s.io/coredns:1.11' },
      labels: { 'io.kubernetes.pod.name': 'coredns-1' },
    }, {
      id: 'eeeeffff00001111', state: 'CONTAINER_EXITED',
      metadata: { name: 'install-cni' }, imageRef: 'calico/cni:v3',
      labels: { 'io.kubernetes.pod.name': 'calico-node-x' },
    }],
  });
  const podmanJson = JSON.stringify([
    { Id: '99998888777766665555', Names: ['pod-web'], Image: 'httpd:2.4', State: 'running', Ports: [{ host_port: 8080, container_port: 80 }] },
  ]);

  const build = (parts: Record<string, string>) =>
    Object.entries(parts).map(([tag, body]) => `@@${tag}@@\n${body}`).join('\n') + '\n@@END@@';

  it('reads containerd workloads on a host with no docker', () => {
    const out = parseContainers(build({ ENGINES: 'kubectl\ncrictl', DOCKER: '', CRICTL: crictlJson }));
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.runtime === 'containerd')).toBe(true);
    expect(out.find((c) => c.name === 'coredns')?.image).toBe('registry.k8s.io/coredns:1.11');
  });

  it('normalizes crictl states to the lowercase form the views filter on', () => {
    const out = parseContainers(build({ CRICTL: crictlJson }));
    expect(out.find((c) => c.name === 'coredns')?.state).toBe('running');
    // -a in the probe means exited containers are visible; they must not be
    // mistaken for running ones.
    expect(out.find((c) => c.name === 'install-cni')?.state).toBe('exited');
  });

  it('merges every runtime into one list, each tagged with its origin', () => {
    const out = parseContainers(build({
      DOCKER: dockerLine, NERDCTL: nerdctlLine, PODMAN: podmanJson, CRICTL: crictlJson,
    }));
    expect(out).toHaveLength(5);
    expect(out.map((c) => c.runtime).sort()).toEqual(
      ['containerd', 'containerd', 'docker', 'nerdctl', 'podman'],
    );
  });

  it('derives docker state from the status line when State is absent', () => {
    const [c] = parseContainers(build({ DOCKER: dockerLine }));
    expect(c.state).toBe('running');
    expect(c.runtime).toBe('docker');
    expect(c.ports).toBe('0.0.0.0:80->80/tcp');
  });

  it('maps podman ports and truncates its long ids', () => {
    const [c] = parseContainers(build({ PODMAN: podmanJson }));
    expect(c.id).toBe('999988887777');
    expect(c.name).toBe('pod-web');
    expect(c.ports).toBe('8080:80');
    expect(c.state).toBe('running');
  });

  it('returns an empty list when no runtime answered, without throwing', () => {
    expect(parseContainers(build({ ENGINES: '', DOCKER: '', CRICTL: '', PODMAN: '' }))).toEqual([]);
    expect(parseContainers('')).toEqual([]);
  });

  it('skips malformed output instead of losing the whole host', () => {
    const out = parseContainers(build({ DOCKER: 'not json\n' + dockerLine, PODMAN: '[oops' }));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('web');
  });

  it('still exposes the raw crictl shape, with its pod association intact', () => {
    const raw = parseCrictl(build({ CRICTL: crictlJson }));
    expect(raw).toHaveLength(2);
    expect(raw[0].state).toBe('RUNNING');
    expect(raw[0].pod).toBe('coredns-1');
  });
});
