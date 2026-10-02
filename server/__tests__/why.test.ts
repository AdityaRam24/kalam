// The why-engine reads like an operator: each case below is a real failure
// whose status says nothing about its cause.

import { describe, it, expect } from 'vitest';
import { explainCluster, contractsFor, classifyPull, type WhyInput } from '../k8s/why.js';

const all = new Set(['pods', 'services', 'endpoints', 'workloads', 'nodes', 'namespaces', 'events', 'certificates', 'issuers',
  'clusterIssuers', 'ingresses', 'ingressClasses', 'isvcs', 'servingRuntimes', 'clusterServingRuntimes', 'pvcs', 'storageClasses',
  'hpas', 'virtualServices', 'gateways', 'configMaps', 'secrets', 'serviceAccounts']);
const input = (o: Partial<WhyInput>): WhyInput => ({ read: all, serviceAccounts: [{ namespace: 'shop', name: 'default' }], ...o });
const md = (name: string, namespace = 'shop', extra: any = {}) => ({ metadata: { name, namespace, ...extra } });

const pod = (name: string, opts: any = {}) => ({
  ...md(name, 'shop', { labels: opts.labels || { app: 'web' } }),
  spec: { containers: [{ name: 'c', image: 'reg.io/web:1', ...(opts.container || {}) }], ...(opts.spec || {}) },
  status: { phase: opts.phase || 'Running', conditions: opts.conditions || [], containerStatuses: opts.cs || [] },
});

describe('certificates and issuers', () => {
  it('names the missing issuer as the root cause', () => {
    const r = explainCluster(input({
      certificates: [{ ...md('web-tls'), spec: { issuerRef: { name: 'letsencrypt', kind: 'ClusterIssuer' } }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Pending' }] } }],
      clusterIssuers: [], issuers: [],
    }));
    const f = r.findings.find((x) => x.object.name === 'web-tls')!;
    expect(f.title).toMatch(/Issuer not found: ClusterIssuer "letsencrypt"/);
    expect(f.rootCause).toMatchObject({ kind: 'ClusterIssuer', name: 'letsencrypt', reason: 'does not exist' });
  });

  it('spots the right name under the wrong kind', () => {
    const r = explainCluster(input({
      certificates: [{ ...md('web-tls'), spec: { issuerRef: { name: 'ca', kind: 'Issuer' } } }],
      clusterIssuers: [{ metadata: { name: 'ca' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }], issuers: [],
    }));
    expect(r.findings[0].fix[0]).toMatch(/kind: ClusterIssuer/);
  });

  it('blames a not-Ready issuer and lists what it breaks', () => {
    const r = explainCluster(input({
      certificates: [{ ...md('a'), spec: { issuerRef: { name: 'ca', kind: 'ClusterIssuer' } } }],
      clusterIssuers: [{ metadata: { name: 'ca' }, spec: { ca: { secretName: 'ca-key' } }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'ErrGetKeyPair', message: 'secret "ca-key" not found' }] } }],
    }));
    const cert = r.findings.find((x) => x.object.kind === 'Certificate')!;
    expect(cert.rootCause?.name).toBe('ca');
    const iss = r.findings.find((x) => x.object.kind === 'ClusterIssuer')!;
    expect(iss.affects).toEqual([{ kind: 'Certificate', name: 'a', namespace: 'shop' }]);
    expect(iss.rootCause).toMatchObject({ kind: 'Secret', name: 'ca-key' });
  });

  it('checks the cert-manager annotation on an Ingress as a contract', () => {
    const ing = { ...md('web', 'shop', { annotations: { 'cert-manager.io/cluster-issuer': 'gone' } }), spec: { rules: [{ http: { paths: [{ backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } };
    const r = explainCluster(input({ ingresses: [ing], clusterIssuers: [], services: [{ ...md('web'), spec: { ports: [{ port: 80 }] } }] }));
    const f = r.findings.find((x) => x.object.kind === 'Ingress')!;
    expect(f.category).toBe('certificate');
    expect(f.key?.name).toBe('cert-manager.io/cluster-issuer');
    expect(f.key?.readBy).toMatch(/cert-manager/);
  });
});

describe('image pulls', () => {
  it('classifies the registry message', () => {
    expect(classifyPull('pull access denied, repository does not exist or may require authorization').cause).toBe('auth');
    expect(classifyPull('manifest unknown').cause).toBe('missing');
    expect(classifyPull('x509: certificate signed by unknown authority').cause).toBe('tls');
    expect(classifyPull('dial tcp: lookup reg.io: no such host').cause).toBe('network');
    expect(classifyPull('toomanyrequests: rate limit').cause).toBe('ratelimit');
  });

  it('points at a pull secret that does not exist', () => {
    const p = pod('web-1', { spec: { imagePullSecrets: [{ name: 'regcred' }] }, phase: 'Pending',
      cs: [{ name: 'c', image: 'reg.io/web:1', state: { waiting: { reason: 'ImagePullBackOff', message: 'unauthorized: authentication required' } } }] });
    const r = explainCluster(input({ pods: [p], secrets: [] }));
    expect(r.findings[0].rootCause).toMatchObject({ kind: 'Secret', name: 'regcred' });
    expect(r.findings[0].why).toMatch(/regcred/);
  });

  it('does not claim a secret is missing when Secrets could not be read', () => {
    const p = pod('web-1', { spec: { imagePullSecrets: [{ name: 'regcred' }] },
      cs: [{ name: 'c', state: { waiting: { reason: 'ErrImagePull', message: '401 unauthorized' } } }] });
    const read = new Set([...all].filter((x) => x !== 'secrets'));
    const r = explainCluster({ ...input({ pods: [p] }), read });
    expect(r.findings[0].rootCause).toBeUndefined();
    expect(contractsFor({ ...input({ pods: [p] }), read }, 'Pod', 'shop', 'web-1').find((c) => c.rule.includes('regcred'))?.status).toBe('unknown');
  });
});

describe('pods', () => {
  it('names the missing ConfigMap', () => {
    const p = pod('api', { cs: [{ name: 'c', state: { waiting: { reason: 'CreateContainerConfigError', message: 'configmap "api-config" not found' } } }] });
    const f = explainCluster(input({ pods: [p] })).findings[0];
    expect(f.title).toBe('ConfigMap "api-config" is missing');
    expect(f.rootCause).toMatchObject({ kind: 'ConfigMap', name: 'api-config' });
  });

  it('reads OOMKilled with the limit', () => {
    const p = pod('api', { container: { resources: { limits: { memory: '256Mi' } } },
      cs: [{ name: 'c', restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] });
    const f = explainCluster(input({ pods: [p] })).findings[0];
    expect(f.title).toMatch(/out of memory \(limit 256Mi\)/);
  });

  it('explains an unschedulable pod with a nodeSelector nobody satisfies', () => {
    const p = pod('gpu', { phase: 'Pending', spec: { nodeSelector: { 'nvidia.com/gpu.present': 'true' } },
      conditions: [{ type: 'PodScheduled', status: 'False', message: "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector." }] });
    const inp = input({ pods: [p], nodes: [{ metadata: { name: 'n1', labels: {} } }] });
    const f = explainCluster(inp).findings[0];
    expect(f.category).toBe('scheduling');
    expect(f.fix[0]).toMatch(/nvidia.com\/gpu.present=true/);
    const c = contractsFor(inp, 'Pod', 'shop', 'gpu').find((x) => x.type === 'label')!;
    expect(c.status).toBe('violated');
    expect(c.key?.readBy).toMatch(/NVIDIA/);
  });
});

describe('labels as contracts', () => {
  it('a Service whose selector lost its pods, with the near-miss label', () => {
    const r = explainCluster(input({
      pods: [pod('web-1', { labels: { app: 'web-v2', tier: 'fe' } })],
      services: [{ ...md('web'), spec: { selector: { app: 'web', tier: 'fe' }, ports: [{ port: 80 }] } }],
    }));
    const f = r.findings.find((x) => x.object.kind === 'Service')!;
    expect(f.category).toBe('labels');
    expect(f.evidence[0]).toBe('web-1 has app=web-v2 — the Service wants app=web');
    expect(f.key?.name).toBe('app');
  });

  it('workload contracts show which Service selectors its pods satisfy', () => {
    const w = { kind: 'Deployment', ...md('web'), spec: { selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'c' }] } } } };
    const cs = contractsFor(input({ workloads: [w], services: [{ ...md('web'), spec: { selector: { app: 'web', tier: 'fe' } } }] }), 'Deployment', 'shop', 'web');
    expect(cs.find((c) => c.type === 'label')).toMatchObject({ status: 'violated' });
  });

  it('a workload inherits its pods’ cause', () => {
    const w = { kind: 'Deployment', ...md('api'), spec: { replicas: 2, selector: { matchLabels: { app: 'api' } } }, status: { readyReplicas: 0 } };
    const p = pod('api-1', { labels: { app: 'api' }, cs: [{ name: 'c', state: { waiting: { reason: 'CreateContainerConfigError', message: 'secret "db" not found' } } }] });
    const f = explainCluster(input({ pods: [p], workloads: [w] })).findings.find((x) => x.object.kind === 'Deployment')!;
    expect(f.title).toBe('0/2 ready — Secret "db" is missing');
    expect(f.rootCause).toMatchObject({ kind: 'Secret', name: 'db' });
  });
});

describe('KServe, storage, istio', () => {
  it('no runtime for the model format', () => {
    const isvc = { ...md('llm'), spec: { predictor: { model: { modelFormat: { name: 'vllm' } } } } };
    const f = explainCluster(input({ isvcs: [isvc], servingRuntimes: [], clusterServingRuntimes: [{ metadata: { name: 'triton' }, spec: { supportedModelFormats: [{ name: 'onnx', autoSelect: true }] } }] })).findings[0];
    expect(f.title).toMatch(/A runtime supports model format "vllm"/);
  });

  it('PVC asking for a StorageClass that does not exist', () => {
    const f = explainCluster(input({ pvcs: [{ ...md('data'), spec: { storageClassName: 'fast' }, status: { phase: 'Pending' } }], storageClasses: [] })).findings[0];
    expect(f.rootCause).toMatchObject({ kind: 'StorageClass', name: 'fast' });
  });

  it('VirtualService bound to a Gateway that is not there', () => {
    const vs = { ...md('app'), spec: { gateways: ['istio-system/ezaf-gateway'], http: [{ route: [{ destination: { host: 'app' } }] }] } };
    const r = explainCluster(input({ virtualServices: [vs], gateways: [], services: [{ ...md('app'), spec: {} }] }));
    expect(r.findings.map((f) => f.title)).toEqual(['Gateway istio-system/ezaf-gateway does not exist']);
  });
});

describe('robustness', () => {
  it('never throws on garbage', () => {
    const junk: any = [null, 7, 'x', {}, { metadata: null }, { status: { conditions: 'no' } }];
    expect(() => explainCluster(input({ pods: junk, services: junk, workloads: junk, certificates: junk, ingresses: junk, isvcs: junk, pvcs: junk, nodes: junk, hpas: junk, virtualServices: junk, events: junk }))).not.toThrow();
  });

  it('a healthy cluster has nothing to say', () => {
    const r = explainCluster(input({ pods: [pod('ok', { conditions: [{ type: 'Ready', status: 'True' }], cs: [{ name: 'c', state: { running: {} } }] })] }));
    expect(r.findings).toEqual([]);
  });
});
