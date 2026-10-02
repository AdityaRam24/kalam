// Run Trinetra's REAL discovery pipeline against a real host and report exactly
// what happens at every stage.
//
// This is not a test and uses no fixtures. It calls the same functions the
// running application calls — the same SSH command, the same buffer, the same
// parsers, the same relation and layout model — so whatever it prints is what
// the dashboard and topology map will show for that host.
//
//   npm run diagnose -- --local                 # THIS machine (no SSH)
//   npm run diagnose -- <name-from-inventory>
//   npm run diagnose -- --host 10.1.2.3 --user ubuntu --key ~/.ssh/id_rsa
//   npm run diagnose -- --host 10.1.2.3 --user ubuntu          # password via env
//   TRINETRA_SSH_PASSWORD=... npm run diagnose -- --host ... --user ...
//
// Optional: --via <inventory-name> to hop through a jump host,
//           --root to run commands elevated (sudo), --json for raw output.
//
// Nothing secret is printed.

import '../server/legacy-env.js';
import fs from 'fs';
import path from 'path';
import {
  sshRun, loadVms, parseContainers, parseCrictl, section, readKindItems,
  DISCOVER_HOST_CMD, DISCOVER_K8S_CMD,
  K8S_MAX_BUFFER, K8S_TIMEOUT_MS, type VmEntry,
} from '../server/vms.js';
import { normalizeClusterItems, parseReplicaSetOwners } from '../server/k8s/workloads.js';
import { buildRelations } from '../src/lib/relations.js';
import { layoutCluster } from '../src/lib/layout.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const MB = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const ok = (m: string) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const bad = (m: string) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const warn = (m: string) => console.log(`  \x1b[33mWARN\x1b[0m  ${m}`);
const info = (m: string) => console.log(`        ${m}`);
const head = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function resolveTarget(): Promise<{ vm: VmEntry; via?: VmEntry }> {
  const host = flag('host');
  if (host) {
    const keyPath = flag('key');
    const vm: VmEntry = {
      name: flag('name') || host,
      host,
      user: flag('user') || 'root',
    } as VmEntry;
    if (keyPath) (vm as any).keyPath = keyPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '~');
    const pw = process.env.TRINETRA_SSH_PASSWORD || flag('password');
    if (pw) (vm as any).password = pw;
    if (has('root') && vm.user !== 'root') (vm as any).elevate = 'sudo';
    const viaName = flag('via');
    const via = viaName ? (await loadVms()).find((v) => v.name === viaName) : undefined;
    if (viaName && !via) throw new Error(`Jump host "${viaName}" is not in the inventory.`);
    if (via) (vm as any).via = viaName;
    return { vm, via };
  }

  const name = argv.find((a) => !a.startsWith('--'));
  const vms = await loadVms();
  if (!name) {
    console.log('Usage: npm run diagnose -- <name> | --host H --user U [--key K] [--via J] [--root]');
    console.log(`Hosts in the inventory: ${vms.map((v) => v.name).join(', ') || '(none)'}`);
    process.exit(2);
  }
  const vm = vms.find((v) => v.name === name);
  if (!vm) throw new Error(`"${name}" is not in the inventory. Known: ${vms.map((v) => v.name).join(', ') || '(none)'}`);
  const via = vm.via ? vms.find((v) => v.name === vm.via) : undefined;
  return { vm, via };
}

/**
 * Diagnose the machine Trinetra itself is running on — the path used when Trinetra
 * is deployed onto a cluster node, where kubectl is local and no SSH is
 * involved. Runs the same commands `/api/k8s/resources` runs.
 */
async function diagnoseLocal() {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const run = promisify(execFile);
  const problems: string[] = [];
  const BUF = 256 * 1024 * 1024;

  console.log(`\n\x1b[1mTrinetra local diagnosis\x1b[0m — this machine, no SSH`);
  console.log('Runs the same commands /api/k8s/resources runs.');

  head('1. Tooling');
  // kubectl has no --version; asking the wrong way reports a present binary as
  // missing, which then contradicts the API check below.
  const versionArgs: Record<string, string[]> = {
    kubectl: ['version', '--client'],
    docker: ['--version'],
    crictl: ['--version'],
    nerdctl: ['--version'],
    podman: ['--version'],
  };
  for (const [bin, args] of Object.entries(versionArgs)) {
    try {
      const { stdout } = await run(bin, args, { timeout: 10000 });
      ok(`${bin.padEnd(8)} ${stdout.trim().split('\n')[0].slice(0, 70)}`);
    } catch { info(`${bin.padEnd(8)} not present`); }
  }

  head('2. Kubernetes API');
  try {
    const { stdout } = await run('kubectl', ['get', '--raw=/readyz', '--request-timeout=10s'], { timeout: 15000 });
    ok(`API reachable (/readyz = ${stdout.trim().slice(0, 40)})`);
  } catch (e: any) {
    bad(`kubectl cannot reach the cluster: ${String(e?.stderr || e?.message).split('\n')[0].slice(0, 200)}`);
    problems.push('kubectl cannot reach the cluster from this machine');
  }

  head('3. Each kind, fetched the way the server fetches it');
  const kindArgs: Record<string, string[]> = {
    nodes: ['get', 'nodes', '-o', 'json'],
    daemonsets: ['get', 'ds', '-A', '-o', 'json'],
    statefulsets: ['get', 'sts', '-A', '-o', 'json'],
    services: ['get', 'svc', '-A', '-o', 'json'],
    deployments: ['get', 'deploy', '-A', '-o', 'json'],
    pods: ['get', 'pods', '-A', '-o', 'json'],
  };
  const items: any[] = [];
  for (const [kind, args] of Object.entries(kindArgs)) {
    const t = Date.now();
    try {
      const { stdout } = await run('kubectl', args, { timeout: 60000, maxBuffer: BUF });
      const parsed = JSON.parse(stdout).items || [];
      items.push(...parsed);
      const size = MB(stdout.length);
      ok(`${kind.padEnd(13)} ${String(parsed.length).padStart(5)} objects   ${size.padStart(9)}   ${Date.now() - t} ms`);
      if (stdout.length > 10 * 1024 * 1024) {
        info(`\x1b[33m^ larger than the old 10 MB limit — this kind was being lost\x1b[0m`);
      }
    } catch (e: any) {
      const msg = String(e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? `output exceeded ${MB(BUF)}` : (e?.stderr || e?.message || e)).split('\n')[0];
      bad(`${kind.padEnd(13)} FAILED: ${msg.slice(0, 160)}`);
      problems.push(`${kind}: ${msg.slice(0, 120)}`);
    }
  }

  let owners;
  try {
    const { stdout } = await run('kubectl', ['get', 'rs', '--all-namespaces', '--no-headers', '-o',
      'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,OKIND:.metadata.ownerReferences[0].kind,ONAME:.metadata.ownerReferences[0].name'],
      { timeout: 30000, maxBuffer: BUF });
    owners = parseReplicaSetOwners(stdout);
    info(`replicasets   ${String(owners.size).padStart(5)} owner mappings  ${MB(stdout.length).padStart(9)} (projected)`);
  } catch { warn('replicasets could not be read — pod→Deployment edges will be missing'); }

  head('4. What the dashboard will show');
  const cluster = normalizeClusterItems(items, owners);
  console.log(`  pods ${cluster.pods.length}   services ${cluster.services.length}   workloads ${cluster.deployments.length}   nodes ${cluster.nodes.length}`);
  if (cluster.pods.length) info(`pods with a resolved owner: ${cluster.pods.filter((p: any) => p.owner).length}/${cluster.pods.length}`);
  if (cluster.services.length) info(`services with a selector: ${cluster.services.filter((s: any) => s.selector !== 'None').length}/${cluster.services.length}`);

  head('5. Topology map');
  const rels = buildRelations({ containers: [], ...cluster });
  const byKind: Record<string, number> = {};
  for (const r of rels) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  const layout = layoutCluster({ containers: [], ...cluster });
  console.log(`  edges ${rels.length}  ${JSON.stringify(byKind)}   guessed ${rels.filter((r) => r.inferred).length}`);
  console.log(`  canvas ${Math.round(layout.width)} x ${Math.round(layout.height)}   cards ${layout.cards.size}   bands ${layout.groups.filter((g) => g.kind === 'namespace').length}`);

  head('Verdict');
  if (!problems.length) {
    console.log(`  \x1b[32mThis machine reads its cluster correctly end to end.\x1b[0m`);
    process.exit(0);
  }
  console.log(`  \x1b[31mProblems found:\x1b[0m`);
  for (const p of [...new Set(problems)]) console.log(`    - ${p}`);
  process.exit(1);
}

async function main() {
  if (has('local')) return diagnoseLocal();
  const { vm, via } = await resolveTarget();
  const problems: string[] = [];

  console.log(`\n\x1b[1mTrinetra host diagnosis\x1b[0m — ${vm.user}@${vm.host}${via ? ` via ${via.name}` : ''}`);
  console.log('Runs the same code the application runs. No fixtures, no mocks.');

  // ── 1. Can we log in at all? ──────────────────────────────────────────────
  head('1. SSH');
  const who = await sshRun(vm, 'id -un; echo "---"; uname -srm; echo "---"; echo "$PATH"', 25000);
  if (!who.ok && !who.stdout.trim()) {
    bad(`could not run a command: ${(who.stderr.split('\n')[0] || 'unknown').slice(0, 160)}`);
    console.log('\nNothing else can be checked until SSH works. Verify host, user and credentials.');
    process.exit(1);
  }
  const [whoami, kernel, remotePath] = who.stdout.split('---').map((x) => x.trim());
  ok(`logged in, commands run as \x1b[1m${whoami}\x1b[0m`);
  info(kernel);
  if (whoami !== 'root') info('not root — crictl, the kubeconfig and most logs are root-only on a cluster node');

  // ── 2. Host facts: engines and containers ────────────────────────────────
  head('2. Host discovery (the small, fast round trip)');
  const t0 = Date.now();
  const host = await sshRun(vm, DISCOVER_HOST_CMD, 45000);
  info(`${MB(host.stdout.length)} in ${Date.now() - t0} ms${host.truncated ? '  \x1b[31m(TRUNCATED)\x1b[0m' : ''}`);
  if (host.truncated) problems.push('the host round trip was truncated — raise its buffer');

  const engines = section(host.stdout, 'ENGINES').split('\n').map((x) => x.trim()).filter(Boolean);
  if (engines.length) ok(`runtimes/tools found: ${engines.join(', ')}`);
  else bad('no docker / kubectl / crictl / nerdctl / podman found in PATH');
  if (!engines.length) {
    info(`remote PATH was: ${remotePath || '(empty)'}`);
    info('a non-interactive SSH shell skips ~/.bashrc, so /usr/local/bin may be missing');
    problems.push('no container runtime or kubectl visible in the non-interactive PATH');
  }

  const containers = parseContainers(host.stdout);
  const crictl = parseCrictl(host.stdout);
  ok(`containers parsed: ${containers.length}` +
    (containers.length ? `  (${[...new Set(containers.map((c) => c.runtime))].join(', ')})` : ''));
  for (const tag of ['DOCKER', 'CRICTL', 'NERDCTL', 'PODMAN'] as const) {
    const len = section(host.stdout, tag).length;
    if (len) info(`${tag.toLowerCase().padEnd(8)} ${len} bytes`);
  }
  if (crictl.length) info(`crictl reported ${crictl.length} containerd containers`);

  // ── 3. Can kubectl actually reach the cluster? ───────────────────────────
  head('3. Kubernetes API reachability');
  const kubeCheck = section(host.stdout, 'KUBECHECK').trim();
  const hasKubectl = engines.includes('kubectl');
  if (!hasKubectl) {
    bad('kubectl is not on this host (or not in the non-interactive PATH)');
    problems.push('kubectl not found — no pods, services, deployments or nodes can be read');
  } else if (/^ok$/i.test(kubeCheck)) {
    ok('kubectl reached the API (/readyz = ok)');
  } else {
    bad(`kubectl could not reach the cluster: ${kubeCheck.slice(0, 200) || '(no output)'}`);
    problems.push(`kubectl cannot reach the API: ${kubeCheck.slice(0, 120)}`);
  }

  // ── 4. The cluster read — where the old failure lived ────────────────────
  head('4. Cluster discovery (the bulk round trip)');
  let k8sOut = '';
  let truncated = false;
  if (hasKubectl) {
    const t1 = Date.now();
    const k8s = await sshRun(vm, DISCOVER_K8S_CMD, K8S_TIMEOUT_MS, { maxBuffer: K8S_MAX_BUFFER });
    k8sOut = k8s.stdout;
    truncated = !!k8s.truncated;
    info(`${MB(k8sOut.length)} in ${Date.now() - t1} ms   (cap ${MB(K8S_MAX_BUFFER)})`);
    if (truncated) {
      bad('the cluster read hit the buffer cap and was cut short');
      problems.push(`cluster read exceeded ${MB(K8S_MAX_BUFFER)} — raise K8S_MAX_BUFFER`);
    } else {
      ok('read completely, nothing truncated');
    }
    if (k8sOut.length > 4 * 1024 * 1024) {
      info(`\x1b[33mnote:\x1b[0m this is larger than the old 4 MB default — on the previous build`);
      info('      every Kubernetes section here would have been lost');
    }
  } else {
    warn('skipped — kubectl is not available');
  }

  head('5. What each kind returned');
  const kinds: Record<string, string> = {};
  const items: any[] = [];
  for (const tag of ['KNODES', 'KDS', 'KSTS', 'KSVCS', 'KDEPLOYS', 'KPODS'] as const) {
    const text = section(k8sOut, tag);
    const r = readKindItems(text);
    kinds[tag] = r.status;
    items.push(...r.items);
    const label = tag.replace('K', '').toLowerCase().padEnd(9);
    const bytes = `${String(text.length).padStart(9)} bytes`;
    if (r.status === 'cut-short') { bad(`${label}${bytes}  CUT SHORT — arrived incomplete`); problems.push(`${label.trim()} arrived incomplete`); }
    else if (r.status === 'unreadable') { bad(`${label}${bytes}  UNREADABLE: ${text.slice(0, 120)}`); problems.push(`${label.trim()}: ${text.slice(0, 90)}`); }
    else if (r.status === 'empty') warn(`${label}${bytes}  nothing returned`);
    else ok(`${label}${bytes}  ${r.status} objects`);
  }
  const rsText = section(k8sOut, 'KRS');
  const owners = parseReplicaSetOwners(rsText);
  info(`replicasets ${String(rsText.length).padStart(7)} bytes  ${owners.size} owner mappings (projected, not JSON)`);

  // ── 6. Through the real normalizer, relation model and layout ────────────
  head('6. What the dashboard will show');
  const cluster = normalizeClusterItems(items, owners);
  const withOwner = cluster.pods.filter((p: any) => p.owner).length;
  const withSelector = cluster.services.filter((s: any) => s.selector !== 'None').length;
  console.log(`  pods ${cluster.pods.length}   services ${cluster.services.length}   ` +
    `workloads ${cluster.deployments.length}   nodes ${cluster.nodes.length}   containers ${containers.length}`);
  const kindCounts: Record<string, number> = {};
  for (const w of cluster.deployments) kindCounts[w.kind] = (kindCounts[w.kind] || 0) + 1;
  if (cluster.deployments.length) info(`workload kinds: ${JSON.stringify(kindCounts)}`);
  if (cluster.pods.length) info(`pods with a resolved owner: ${withOwner}/${cluster.pods.length}`);
  if (cluster.services.length) info(`services with a selector: ${withSelector}/${cluster.services.length}`);
  if (cluster.nodes.length) info(`nodes: ${cluster.nodes.map((n: any) => `${n.name}(${n.status})`).join(', ').slice(0, 200)}`);

  head('7. Topology map');
  const rels = buildRelations({ containers, ...cluster });
  const byKind: Record<string, number> = {};
  for (const r of rels) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  const layout = layoutCluster({ containers, ...cluster });
  console.log(`  edges ${rels.length}  ${JSON.stringify(byKind)}`);
  console.log(`  guessed (not from cluster data): ${rels.filter((r) => r.inferred).length}`);
  console.log(`  canvas ${Math.round(layout.width)} x ${Math.round(layout.height)}  ` +
    `cards ${layout.cards.size}  namespace bands ${layout.groups.filter((g) => g.kind === 'namespace').length}`);
  if (cluster.pods.length === 0 && containers.length > 0) {
    problems.push('containers were found but no pods — this is the symptom to chase above');
  }

  if (has('json')) {
    const out = path.resolve('diagnose-output.json');
    fs.writeFileSync(out, JSON.stringify({ engines, kinds, truncated, kubeCheck, cluster, containers }, null, 2));
    info(`raw output written to ${out}`);
  }

  head('Verdict');
  if (!problems.length) {
    console.log('  \x1b[32mThis host reads correctly end to end.\x1b[0m');
    console.log('  What is printed above is what the dashboard and topology map will show.');
    process.exit(0);
  }
  console.log('  \x1b[31mProblems found:\x1b[0m');
  for (const p of [...new Set(problems)]) console.log(`    - ${p}`);
  process.exit(1);
}

main().catch((e) => { console.error(`\n${e?.message || e}`); process.exit(1); });
