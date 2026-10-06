// /etc/kubernetes insights: the parsing has to survive real openssl and
// manifest output, and the judging has to say the right thing about it.

import { describe, it, expect } from 'vitest';
import {
  parseNodeConfig, analyzeNodeConfig, findDrift, flattenYaml, parseKubeletEnv,
  imageVersion, cleanDn, parseBytes, redactFlag, type NodeConfig,
} from '../k8s/nodeconfig.js';
import { correlate } from '../insight/correlate.js';

const M = (tag: string) => `===TRINETRA:${tag}===`;
const NOW = Date.parse('2026-10-07T12:00:00Z');

const stdout = [
  M('SELF'), 'HOST=cp-1', 'UID=0', `NOW=${NOW / 1000 + 5}`, 'OPENSSL=yes', 'DIR=/etc/kubernetes', 'DIR=/var/lib/kubelet',
  M('CERTS'),
  'FILE=/etc/kubernetes/pki/apiserver.crt',
  'notAfter=Oct 12 08:00:00 2026 GMT', 'notBefore=Oct 12 08:00:00 2025 GMT',
  'subject=CN = kube-apiserver', 'issuer=CN = kubernetes',
  'SAN=DNS:kubernetes, DNS:kubernetes.default, IP Address:10.96.0.1, IP Address:10.0.0.10',
  'FILE=/etc/kubernetes/pki/ca.crt',
  'notAfter=Oct 10 08:00:00 2035 GMT', 'subject= /CN=kubernetes', 'issuer= /CN=kubernetes',
  'FILE=/etc/kubernetes/pki/front-proxy-client.crt',
  'notAfter=Oct 30 08:00:00 2026 GMT',
  M('KUBECONF'),
  'FILE=/etc/kubernetes/admin.conf', 'SERVER=https://10.0.0.100:6443', 'notAfter=Oct  1 08:00:00 2026 GMT', 'subject=O = system:masters, CN = kubernetes-admin',
  'FILE=/etc/kubernetes/kubelet.conf', 'SERVER=https://10.0.0.100:6443', 'CERTFILE=/var/lib/kubelet/pki/kubelet-client-current.pem',
  M('MANIFESTS'),
  'FILE=/etc/kubernetes/manifests/kube-apiserver.yaml', `MTIME=${NOW / 1000 - 600}`, 'SHA=abcdef0123456789',
  'IMAGE=registry.k8s.io/kube-apiserver:v1.30.4',
  'FLAG=--advertise-address=10.0.0.10', 'FLAG=--authorization-mode=Node,RBAC', 'FLAG=--enable-admission-plugins=NodeRestriction',
  'FLAG=--anonymous-auth=false', 'FLAG=--service-cluster-ip-range=10.96.0.0/12', 'FLAG=--token-auth-file=/etc/kubernetes/tokens.csv',
  'FLAG=--oidc-client-secret=hunter2', 'FLAG=--allow-privileged',
  'FILE=/etc/kubernetes/manifests/etcd.yaml', `MTIME=${NOW / 1000 - 90 * 86400}`, 'IMAGE=registry.k8s.io/etcd:3.5.12-0',
  'FLAG=--quota-backend-bytes=2147483648', 'FLAG=--name=cp-1',
  M('KUBELET'), `MTIME=${NOW / 1000 - 30 * 86400}`,
  'apiVersion: kubelet.config.k8s.io/v1beta1', 'kind: KubeletConfiguration',
  'authentication:', '  anonymous:', '    enabled: false', '  webhook:', '    enabled: true',
  'authorization:', '  mode: Webhook', 'cgroupDriver: systemd', 'maxPods: 250', 'readOnlyPort: 10255',
  'evictionHard:', '  memory.available: "200Mi"', '  nodefs.available: "10%"',
  'tlsCipherSuites:', '- TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  M('KFLAGS'), 'KUBELET_KUBEADM_ARGS="--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.9"',
  M('RANCHER'),
  M('ETCD'), 'DB=/var/lib/etcd/member/snap/db 1825361100',
  M('END'),
].join('\n');

describe('parseNodeConfig', () => {
  const cfg = parseNodeConfig(stdout);

  it('reads identity, layout and role', () => {
    expect(cfg.host).toBe('cp-1');
    expect(cfg.distro).toBe('kubeadm');
    expect(cfg.role).toBe('control-plane');
  });

  it('parses certificate dates, subjects (both openssl styles) and SANs', () => {
    const api = cfg.certs.find((c) => c.path.endsWith('apiserver.crt'))!;
    expect(api.notAfter).toBe('2026-10-12T08:00:00.000Z');
    expect(api.subject).toBe('CN=kube-apiserver');
    expect(api.sans).toContain('IP Address:10.96.0.1');
    expect(cfg.certs.find((c) => c.path.endsWith('ca.crt'))!.subject).toBe('CN=kubernetes');
  });

  it('reads kubeconfig endpoints and embedded client cert expiry, nothing else', () => {
    const admin = cfg.kubeconfigs.find((k) => k.path.endsWith('admin.conf'))!;
    expect(admin.server).toBe('https://10.0.0.100:6443');
    expect(admin.notAfter).toBe('2026-10-01T08:00:00.000Z');
    expect(Object.keys(admin).sort()).toEqual(['notAfter', 'path', 'server', 'subject']);
  });

  it('parses manifest flags and image version, redacting secrets but not file paths', () => {
    const api = cfg.manifests.find((m) => m.component === 'kube-apiserver')!;
    expect(api.version).toBe('v1.30.4');
    expect(api.flags['authorization-mode']).toBe('Node,RBAC');
    expect(api.flags['allow-privileged']).toBe('true');
    expect(api.flags['oidc-client-secret']).toBe('<redacted>');
    expect(api.flags['token-auth-file']).toBe('/etc/kubernetes/tokens.csv');
  });

  it('flattens the kubelet config and reads kubeadm flags', () => {
    expect(cfg.kubelet!.config['authentication.anonymous.enabled']).toBe('false');
    expect(cfg.kubelet!.config['evictionHard.memory.available']).toBe('200Mi');
    expect(cfg.kubelet!.config['maxPods']).toBe('250');
    expect(cfg.kubeletFlags['container-runtime-endpoint']).toBe('unix:///var/run/containerd/containerd.sock');
  });

  it('reads the etcd db size', () => {
    expect(cfg.etcdDb).toEqual({ path: '/var/lib/etcd/member/snap/db', bytes: 1825361100 });
  });
});

describe('analyzeNodeConfig', () => {
  const checks = analyzeNodeConfig(parseNodeConfig(stdout), NOW);
  const byId = (id: string) => checks.find((c) => c.id === id);

  it('flags certificates by how soon they expire', () => {
    expect(byId('cert:/etc/kubernetes/pki/apiserver.crt')).toMatchObject({ status: 'critical', title: expect.stringMatching(/expires in 4 day/) });
    expect(byId('cert:/etc/kubernetes/pki/front-proxy-client.crt')?.status).toBe('warning');
    expect(byId('cert:/etc/kubernetes/pki/ca.crt')).toBeUndefined();
    expect(byId('kubeconfig:/etc/kubernetes/admin.conf')).toMatchObject({ status: 'critical', title: expect.stringMatching(/EXPIRED 6 day/) });
  });

  it('judges apiserver posture with the flag as evidence', () => {
    expect(byId('api:audit')).toMatchObject({ status: 'warning', evidence: expect.stringContaining('--audit-log-path (not set)') });
    expect(byId('api:encrypt')?.status).toBe('warning');
    expect(byId('api:anon')?.status).toBe('ok');
    expect(byId('api:noderestrict')?.status).toBe('ok');
    expect(byId('api:authz')?.status).toBe('ok');
  });

  it('warns as etcd approaches its quota', () => {
    expect(byId('etcd:quota')).toMatchObject({ status: 'warning', title: expect.stringMatching(/85%/) });
  });

  it('reads kubelet risk and limits', () => {
    expect(byId('kubelet:ro')?.status).toBe('warning');
    expect(byId('kubelet:limits')?.title).toMatch(/max 250 pods, cgroup driver systemd/);
    expect(byId('kubelet:limits')?.detail).toMatch(/memory\.available<200Mi/);
  });

  it('reports a manifest edited minutes ago, not one from months ago', () => {
    expect(byId('changed:/etc/kubernetes/manifests/kube-apiserver.yaml')).toMatchObject({ status: 'warning', title: expect.stringMatching(/10 min ago/) });
    expect(byId('changed:/etc/kubernetes/manifests/etcd.yaml')).toBeUndefined();
  });

  it('orders worst first and leaves a small clock offset alone', () => {
    expect(checks[0].status).toBe('critical');
    expect(byId('time:skew')).toBeUndefined();
  });

  it('says plainly when a host is not a node, or when access is missing', () => {
    const none = analyzeNodeConfig(parseNodeConfig([M('SELF'), 'UID=1000', M('END')].join('\n')), NOW);
    expect(none).toEqual([expect.objectContaining({ id: 'none' })]);
    const noRoot = analyzeNodeConfig(parseNodeConfig([M('SELF'), 'UID=1000', 'DIR=/etc/kubernetes', M('END')].join('\n')), NOW);
    expect(noRoot[0]).toMatchObject({ id: 'access', status: 'warning' });
  });
});

describe('findDrift', () => {
  const base = parseNodeConfig(stdout);
  const other: NodeConfig = JSON.parse(JSON.stringify(base));
  other.manifests[0].version = 'v1.29.8';
  other.manifests[0].flags['advertise-address'] = '10.0.0.11';
  other.manifests[0].flags['enable-admission-plugins'] = 'NodeRestriction,PodSecurity';
  other.kubeconfigs[1].server = 'https://10.0.0.10:6443';

  it('reports version and flag disagreements, ignoring per-node flags', () => {
    const d = findDrift({ 'cp-1': base, 'cp-2': other });
    expect(d).toContainEqual({ component: 'kube-apiserver', what: 'image', values: { 'cp-1': 'v1.30.4', 'cp-2': 'v1.29.8' } });
    expect(d.find((x) => x.what === '--enable-admission-plugins')).toBeTruthy();
    expect(d.find((x) => x.what === '--advertise-address')).toBeUndefined();
    expect(d.find((x) => x.what === 'kubeconfig server')?.values).toEqual({ 'cp-1': 'https://10.0.0.100:6443', 'cp-2': 'https://10.0.0.10:6443' });
  });

  it('finds nothing when nodes agree', () => {
    expect(findDrift({ 'cp-1': base, 'cp-2': JSON.parse(JSON.stringify(base)) })).toEqual([]);
  });
});

describe('helpers', () => {
  it('parse small things', () => {
    expect(imageVersion('registry.k8s.io/etcd:3.5.12-0')).toBe('3.5.12-0');
    expect(imageVersion('host:5000/kube-apiserver:v1.30.4@sha256:abc')).toBe('v1.30.4');
    expect(cleanDn('/O=system:masters/CN=kubernetes-admin')).toBe('O=system:masters, CN=kubernetes-admin');
    expect(cleanDn('O = system:masters, CN = kubernetes-admin')).toBe('O=system:masters, CN=kubernetes-admin');
    expect(parseBytes('8Gi')).toBe(8 * 1024 ** 3);
    expect(parseBytes('2147483648')).toBe(2147483648);
    expect(redactFlag('kubelet-client-key', '/x')).toBe('/x');
    expect(redactFlag('bootstrap-token', 'abc')).toBe('<redacted>');
    expect(flattenYaml('a:\n  b: 1\nc: "x" # note\n')).toEqual({ 'a.b': '1', c: 'x' });
    expect(parseKubeletEnv(['X="--node-ip=10.0.0.5 --register-with-taints=a=b:NoSchedule"'])).toEqual({ 'node-ip': '10.0.0.5', 'register-with-taints': 'a=b:NoSchedule' });
  });
});

describe('correlate with node config', () => {
  it('turns config warnings into security / kubernetes issues with hints', () => {
    const issues = correlate({
      subject: 'cp-1',
      config: [
        { status: 'critical', area: 'certificates', title: 'Certificate apiserver.crt expires in 4 day(s)', evidence: '/etc/kubernetes/pki/apiserver.crt', hint: 'kubeadm certs check-expiration' },
        { status: 'ok', area: 'apiserver', title: 'Anonymous auth disabled' },
        { status: 'warning', area: 'kubelet', title: 'Kubelet read-only port 10255 is open' },
      ],
    });
    expect(issues.map((i) => i.concern)).toEqual(['security', 'kubernetes']);
    expect(issues[0].evidence[0]).toMatchObject({ kind: 'config', severity: 'critical' });
    expect(issues[0].checks).toContain('kubeadm certs check-expiration');
  });
});
