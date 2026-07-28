// kubectl reference data and the pure logic behind the interactive guide.
//
// Kept out of the component on purpose: risk classification, placeholder
// parsing and command building decide whether Kalam will *execute* something
// against a live cluster, so they are unit-tested rather than buried in JSX.

// ---------------------------------------------------------------------------
// Risk model
// ---------------------------------------------------------------------------

/**
 * How dangerous a command is:
 *   read        — inspects only; safe to run unattended
 *   mutate      — changes cluster state, recoverable
 *   destructive — deletes or evicts; needs deliberate confirmation
 */
export type Risk = 'read' | 'mutate' | 'destructive';

export const RISK_LABEL: Record<Risk, string> = {
  read: 'Read-only',
  mutate: 'Changes state',
  destructive: 'Destructive',
};

const DESTRUCTIVE_VERBS = ['delete', 'drain', 'evict', 'replace', 'taint'];
const MUTATING_VERBS = [
  'apply', 'create', 'run', 'expose', 'scale', 'edit', 'patch', 'label',
  'annotate', 'rollout', 'set', 'cordon', 'uncordon', 'autoscale', 'exec',
  'attach', 'debug', 'cp', 'certificate', 'kustomize',
];

/**
 * Classify a command by what it can do to the cluster. Errs toward danger:
 * anything unrecognized, and anything carrying a destructive flag, is treated
 * as more dangerous than it may actually be.
 */
export function classifyRisk(command: string): Risk {
  const c = command.trim().toLowerCase();

  // Dangerous flags outrank the verb: `apply --force` is not a gentle apply.
  if (/--force\b|--grace-period=0|--all\b(?!-namespaces)|\/finalize/.test(c)) {
    if (/\bdelete\b|\breplace\b|\bdrain\b/.test(c)) return 'destructive';
  }

  const words = c.replace(/^kubectl\s+/, '').split(/\s+/);
  const verb = words[0] || '';

  if (DESTRUCTIVE_VERBS.includes(verb)) return 'destructive';

  // `config` is read-only for view/get/current, mutating for set/use/delete.
  if (verb === 'config') {
    return /^(view|get-contexts|current-context|get-clusters|get-users)$/.test(words[1] || '')
      ? 'read'
      : 'mutate';
  }
  // `auth can-i` only asks a question; `auth reconcile` writes RBAC.
  if (verb === 'auth') return words[1] === 'can-i' ? 'read' : 'mutate';

  if (MUTATING_VERBS.includes(verb)) return 'mutate';
  return 'read';
}

/**
 * Shell metacharacters mean the command does more than talk to the API server —
 * it redirects to a file, pipes, or chains. Kalam never auto-runs those.
 */
export function hasShellSideEffects(command: string): boolean {
  return /[>|;&`$]|\$\(/.test(command);
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/** Every `<placeholder>` in a command, de-duplicated, in order of appearance. */
export function extractPlaceholders(command: string): string[] {
  const found = command.match(/<[^<>\s][^<>]*>/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const name = raw.slice(1, -1);
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Substitute filled-in values; blanks stay as `<placeholder>`. */
export function fillPlaceholders(command: string, values: Record<string, string>): string {
  return command.replace(/<([^<>\s][^<>]*)>/g, (whole, name: string) => {
    const v = (values[name] || '').trim();
    return v || whole;
  });
}

/** True when nothing is left to fill in. */
export function isFullyResolved(command: string): boolean {
  return extractPlaceholders(command).length === 0;
}

export interface Runnability {
  runnable: boolean;
  /** Why not, phrased for a tooltip. */
  reason?: string;
}

/**
 * Kalam only executes a command when all three hold: it is read-only, every
 * placeholder is filled, and it contains no shell redirection or chaining.
 * Anything else is copy-only — the operator runs it themselves, deliberately.
 */
export function canRun(command: string): Runnability {
  if (classifyRisk(command) !== 'read') {
    return { runnable: false, reason: 'Only read-only commands can be run from here — copy it and run it yourself.' };
  }
  if (!isFullyResolved(command)) {
    return { runnable: false, reason: `Fill in ${extractPlaceholders(command).map((p) => `<${p}>`).join(', ')} first.` };
  }
  if (hasShellSideEffects(command)) {
    return { runnable: false, reason: 'Contains shell redirection or chaining — copy it and run it yourself.' };
  }
  return { runnable: true };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const CATEGORIES = {
  all: 'All Commands',
  context: 'Config & Context',
  create: 'Creating & Deploying',
  inspect: 'Inspect & Query',
  troubleshoot: 'Troubleshooting & Logs',
  rollout: 'Updates & Rollouts',
  resources: 'Capacity & Scheduling',
  security: 'Security & RBAC',
  advanced: 'Advanced Operations',
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

export interface CommandItem {
  command: string;
  description: string;
  category: Exclude<CategoryKey, 'all'>;
  tags: string[];
  explanation?: string;
  /** Overrides classifyRisk when a command is subtler than its verb suggests. */
  risk?: Risk;
}

export const COMMANDS: CommandItem[] = [
  // ---- Config & Context ---------------------------------------------------
  {
    command: 'kubectl config view',
    description: 'Display merged kubeconfig settings or a specified kubeconfig file.',
    category: 'context',
    tags: ['Config'],
    explanation: 'Shows the active cluster configurations, contexts, and credentials currently loaded in the user environment.',
  },
  {
    command: 'kubectl config view --minify --output "jsonpath={..namespace}"',
    description: 'Print only the namespace of the current context.',
    category: 'context',
    tags: ['Config', 'Scripting'],
    explanation: '--minify strips the config down to the active context only. Handy in scripts and shell prompts that need to show which namespace you are about to affect.',
  },
  {
    command: 'kubectl config get-contexts',
    description: 'List all available cluster contexts configured in your kubeconfig.',
    category: 'context',
    tags: ['Config'],
    explanation: 'Lists all defined environments (contexts) that you can connect to, showing the active one marked with an asterisk (*).',
  },
  {
    command: 'kubectl config current-context',
    description: 'Display the name of the currently active context.',
    category: 'context',
    tags: ['Config'],
    explanation: 'Shows the context currently used for executing kubectl commands. Check this before running anything destructive.',
  },
  {
    command: 'kubectl config use-context <context-name>',
    description: 'Switch context to the specified cluster and credentials profile.',
    category: 'context',
    tags: ['Config'],
    explanation: 'Instructs kubectl to route all subsequent commands to the specified context cluster.',
  },
  {
    command: 'kubectl config set-context --current --namespace=<namespace>',
    description: 'Change the default namespace for the current active context.',
    category: 'context',
    tags: ['Config'],
    explanation: 'Saves you from appending -n <namespace> to every command by setting the default scope to this namespace.',
  },
  {
    command: 'kubectl config delete-context <context-name>',
    description: 'Delete the specified context from your kubeconfig.',
    category: 'context',
    tags: ['Config'],
    explanation: 'Removes a cluster connection profile. It does not delete the cluster itself, only your local access configuration.',
  },
  {
    command: 'kubectl cluster-info',
    description: 'Show the addresses of the control plane and cluster services.',
    category: 'context',
    tags: ['Config', 'Diagnostics'],
    explanation: 'Quickest confirmation that your kubeconfig actually reaches a live API server. If this hangs, the problem is connectivity or credentials, not the workload.',
  },
  {
    command: 'kubectl version',
    description: 'Print the client and server Kubernetes versions.',
    category: 'context',
    tags: ['Config'],
    explanation: 'A client more than one minor version away from the server is unsupported and produces confusing field errors.',
  },

  // ---- Creating & Deploying ----------------------------------------------
  {
    command: 'kubectl apply -f <filename.yaml>',
    description: 'Create or update resource configurations defined in a YAML or JSON file.',
    category: 'create',
    tags: ['Deploy'],
    explanation: 'The standard declarative way to manage Kubernetes resources. It computes the diff between your local file and the live cluster state, then applies the changes.',
  },
  {
    command: 'kubectl apply -f <directory-path>/ --recursive',
    description: 'Apply every configuration file in a directory tree.',
    category: 'create',
    tags: ['Deploy'],
    explanation: 'Executes apply on every YAML/JSON configuration file found beneath the target directory.',
  },
  {
    command: 'kubectl diff -f <filename.yaml>',
    description: 'Show what applying a manifest would change, without changing it.',
    category: 'create',
    tags: ['Deploy', 'Safe'],
    explanation: 'The rehearsal for apply. Prints a diff between the live object and your file, so you see exactly which fields the apply would touch.',
    risk: 'read',
  },
  {
    command: 'kubectl apply -f <filename.yaml> --dry-run=server',
    description: 'Validate a manifest against the live API server without persisting it.',
    category: 'create',
    tags: ['Deploy', 'Safe'],
    explanation: 'Server-side dry run runs full admission — including webhooks like Kyverno or Gatekeeper — so it catches policy rejections that a client-side dry run cannot.',
  },
  {
    command: 'kubectl create deployment <deploy-name> --image=<image-name>',
    description: 'Create a deployment that manages a set of replicated pods.',
    category: 'create',
    tags: ['Deploy'],
    explanation: 'Generates a Deployment resource running the specified image. Creates replica sets automatically to manage container lifecycle.',
  },
  {
    command: 'kubectl expose deployment <deploy-name> --port=<external-port> --target-port=<container-port> --type=NodePort',
    description: 'Expose a deployment as a new Kubernetes Service of type NodePort.',
    category: 'create',
    tags: ['Deploy', 'Network'],
    explanation: 'Creates a Service that routes traffic from the external cluster port to the containers managed by the deployment.',
  },
  {
    command: 'kubectl run <pod-name> --image=<image-name> --restart=Never',
    description: 'Create and run a single standalone Pod with no replica manager.',
    category: 'create',
    tags: ['Deploy'],
    explanation: 'Runs a single pod. Often used for running temporary utilities or test containers in the cluster.',
  },
  {
    command: 'kubectl run tmp-shell --rm -it --image=busybox --restart=Never -- sh',
    description: 'Open a throwaway shell pod inside the cluster network, deleted on exit.',
    category: 'create',
    tags: ['Deploy', 'Debug'],
    explanation: 'The standard way to test DNS, Service reachability, or registry access from inside the cluster. --rm removes the pod when you exit, so it leaves nothing behind.',
  },
  {
    command: 'kubectl create deployment <deploy-name> --image=<image-name> --dry-run=client -o yaml > deploy.yaml',
    description: 'Generate a Deployment manifest without creating anything.',
    category: 'create',
    tags: ['Deploy', 'Template'],
    explanation: 'The fastest way to get a valid starting manifest. --dry-run=client builds the object locally and -o yaml prints it instead of sending it.',
  },
  {
    command: 'kubectl create secret generic <secret-name> --from-literal=<key>=<value>',
    description: 'Create a Secret from a literal key/value pair.',
    category: 'create',
    tags: ['Config', 'Security'],
    explanation: 'Secrets are only base64-encoded, not encrypted, unless encryption at rest is configured on the API server. Anyone who can read the Secret can read the value.',
  },
  {
    command: 'kubectl create secret docker-registry regcred --docker-server=<registry> --docker-username=<user> --docker-password=<password>',
    description: 'Create an image pull secret for a private registry.',
    category: 'create',
    tags: ['Config', 'Security'],
    explanation: 'The fix for ImagePullBackOff against a private registry. Reference it from the pod spec with imagePullSecrets, or attach it to the ServiceAccount so every pod inherits it.',
  },
  {
    command: 'kubectl create configmap <config-name> --from-file=<path>',
    description: 'Create a ConfigMap from a file or directory.',
    category: 'create',
    tags: ['Config'],
    explanation: 'Each file becomes a key. Pods consume it as environment variables or as a mounted volume; mounted ConfigMaps update in place, env vars do not.',
  },

  // ---- Inspect & Query ----------------------------------------------------
  {
    command: 'kubectl get pods',
    description: 'List pods in the current namespace.',
    category: 'inspect',
    tags: ['Pods'],
    explanation: 'The default view: name, ready containers, status, restarts, age.',
  },
  {
    command: 'kubectl get pods -A',
    description: 'List pods across every namespace.',
    category: 'inspect',
    tags: ['Pods'],
    explanation: '-A (--all-namespaces) is the fastest whole-cluster health glance. Add -o wide to also see which node each pod landed on.',
  },
  {
    command: 'kubectl get pods -o wide',
    description: 'List pods with node placement and pod IPs.',
    category: 'inspect',
    tags: ['Pods'],
    explanation: 'Adds NODE, IP, NOMINATED NODE and READINESS GATES columns — the quickest way to spot that every failing pod is on the same node.',
  },
  {
    command: 'kubectl get pods --sort-by=.status.containerStatuses[0].restartCount',
    description: 'Sort pods by restart count to surface the flappiest workload.',
    category: 'inspect',
    tags: ['Pods', 'Triage'],
    explanation: 'Restart count is the single best signal of an unhealthy-but-running workload. Sorting puts the worst offender at the bottom of the list.',
  },
  {
    command: 'kubectl get pods --field-selector status.phase=Failed -A',
    description: 'List only failed pods, cluster-wide.',
    category: 'inspect',
    tags: ['Pods', 'Triage'],
    explanation: 'Field selectors filter server-side, so this stays fast on large clusters where grep over thousands of rows would not.',
  },
  {
    command: 'kubectl get pods -l <key>=<value>',
    description: 'List pods matching a label selector.',
    category: 'inspect',
    tags: ['Pods', 'Selectors'],
    explanation: 'Labels are how Services, Deployments and NetworkPolicies find pods. If a Service has no endpoints, run this with the Service selector to see whether it matches anything.',
  },
  {
    command: 'kubectl get pods --show-labels',
    description: 'List pods with all their labels.',
    category: 'inspect',
    tags: ['Pods', 'Selectors'],
    explanation: 'The other half of debugging an empty Service: compare these labels against the Service selector character by character.',
  },
  {
    command: 'kubectl describe pod <pod-name>',
    description: 'Show full pod detail including the event log.',
    category: 'inspect',
    tags: ['Pods', 'Diagnostics'],
    explanation: 'The Events section at the bottom is where the real reason lives: FailedScheduling, ImagePullBackOff, CreateContainerConfigError, failing probes, and OOMKilled (exit code 137). Start here for almost any unhealthy pod.',
  },
  {
    command: 'kubectl get deployment <deploy-name> -o yaml',
    description: 'Dump the live YAML of a deployment.',
    category: 'inspect',
    tags: ['Deploy'],
    explanation: 'Shows the object as the API server stores it, including defaulted fields and the last-applied-configuration annotation.',
  },
  {
    command: 'kubectl get events --sort-by=.lastTimestamp -A',
    description: 'List cluster events, oldest to newest.',
    category: 'inspect',
    tags: ['Diagnostics'],
    explanation: 'Events are the cluster narrating itself. Note they expire (one hour by default), so an empty list does not mean nothing happened.',
  },
  {
    command: 'kubectl events --for pod/<pod-name>',
    description: 'Show events for one specific object.',
    category: 'inspect',
    tags: ['Diagnostics'],
    explanation: 'The modern replacement for grepping describe output. Scoped, sorted, and it can follow with --watch.',
  },
  {
    command: 'kubectl get all -n <namespace>',
    description: 'List the common workload resources in a namespace.',
    category: 'inspect',
    tags: ['Overview'],
    explanation: 'Despite the name it is NOT everything — it misses ConfigMaps, Secrets, PVCs, Ingresses and CRDs. Useful as a first glance, never as an audit.',
  },
  {
    command: 'kubectl get pods -o jsonpath="{range .items[*]}{.metadata.name}{\'\\t\'}{.status.phase}{\'\\n\'}{end}"',
    description: 'Extract specific fields from a list as plain text.',
    category: 'inspect',
    tags: ['Scripting'],
    explanation: 'jsonpath is how you get scriptable output without depending on jq. The range/end construct iterates the items array.',
  },
  {
    command: 'kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase',
    description: 'Print a table with exactly the columns you want.',
    category: 'inspect',
    tags: ['Scripting'],
    explanation: 'More readable than jsonpath for tabular output, and it keeps kubectl doing the column alignment.',
  },
  {
    command: 'kubectl explain pod.spec.containers',
    description: 'Show the API schema documentation for a field.',
    category: 'inspect',
    tags: ['Docs'],
    explanation: 'Documentation straight from the API server your cluster is actually running, so it reflects the real available fields. Add --recursive for the whole subtree.',
  },
  {
    command: 'kubectl api-resources',
    description: 'List every resource type the cluster serves, with short names.',
    category: 'inspect',
    tags: ['Docs'],
    explanation: 'Exposes all available endpoints and standard resource shortnames (po, deploy, svc, ing) — including CRDs installed by platform operators.',
  },

  // ---- Troubleshooting & Logs --------------------------------------------
  {
    command: 'kubectl logs <pod-name>',
    description: 'Print the logs of a pod.',
    category: 'troubleshoot',
    tags: ['Logs'],
    explanation: 'Reads stdout/stderr of the pod\'s single container. If the pod has several, kubectl asks you to pick one with -c.',
  },
  {
    command: 'kubectl logs <pod-name> --previous',
    description: 'Read the logs of the container instance that died.',
    category: 'troubleshoot',
    tags: ['Logs', 'Diagnostics'],
    explanation: 'The single most important flag for CrashLoopBackOff. The current container was just born and knows nothing; the fatal error is in the previous one.',
  },
  {
    command: 'kubectl logs <pod-name> -c <container-name> -f --tail=100',
    description: 'Follow the last 100 lines of one container in a multi-container pod.',
    category: 'troubleshoot',
    tags: ['Logs'],
    explanation: '-c selects the container (needed for sidecars and init containers), --tail bounds the history, -f streams new lines as they arrive.',
  },
  {
    command: 'kubectl logs -l <key>=<value> --all-containers=true --tail=50',
    description: 'Tail logs from every pod matching a label.',
    category: 'troubleshoot',
    tags: ['Logs'],
    explanation: 'Aggregates across replicas, so you see the error whichever pod handled the request instead of guessing which one to open.',
  },
  {
    command: 'kubectl logs <pod-name> --since=15m',
    description: 'Show only logs from the last 15 minutes.',
    category: 'troubleshoot',
    tags: ['Logs'],
    explanation: 'Time-bounding beats --tail when the container is chatty: you get everything around the incident rather than an arbitrary line count.',
  },
  {
    command: 'kubectl exec -it <pod-name> -- /bin/sh',
    description: 'Open an interactive shell inside a running container.',
    category: 'troubleshoot',
    tags: ['Debug'],
    explanation: 'Everything after -- runs inside the container. Distroless and scratch images have no shell — use kubectl debug instead.',
  },
  {
    command: 'kubectl debug <pod-name> -it --image=busybox --target=<container-name>',
    description: 'Attach an ephemeral debug container to a running pod.',
    category: 'troubleshoot',
    tags: ['Debug'],
    explanation: 'Adds a container with real tools into the existing pod, sharing its namespaces. The way to debug distroless images without rebuilding or restarting the workload.',
  },
  {
    command: 'kubectl debug node/<node-name> -it --image=busybox',
    description: 'Get a privileged shell onto a node through a debug pod.',
    category: 'troubleshoot',
    tags: ['Debug', 'Nodes'],
    explanation: 'Mounts the host filesystem at /host. The route onto a NotReady node when SSH is unavailable — assuming the node can still schedule pods.',
  },
  {
    command: 'kubectl port-forward svc/<service-name> <local-port>:<service-port>',
    description: 'Tunnel a cluster Service to a local port.',
    category: 'troubleshoot',
    tags: ['Network', 'Debug'],
    explanation: 'Bypasses Ingress, LoadBalancers and firewalls entirely, so it isolates whether a problem is in the app or in the path to it. Blocks until you Ctrl+C.',
    risk: 'read',
  },
  {
    command: 'kubectl get endpoints <service-name>',
    description: 'Show the pod IPs a Service is actually routing to.',
    category: 'troubleshoot',
    tags: ['Network', 'Diagnostics'],
    explanation: 'If this is empty, the Service selector matches no ready pods — the request never reaches your app. That single check resolves most "service is down" reports.',
  },
  {
    command: 'kubectl cp <pod-name>:<remote-path> <local-path>',
    description: 'Copy a file out of a container.',
    category: 'troubleshoot',
    tags: ['Debug'],
    explanation: 'Requires tar inside the container. Useful for retrieving heap dumps or config the app wrote at runtime.',
  },
  {
    command: 'kubectl get pods -A -o wide | grep -v Running',
    description: 'List every pod that is not Running, cluster-wide.',
    category: 'troubleshoot',
    tags: ['Triage'],
    explanation: 'The fastest triage sweep. Completed Jobs show up too — they are fine, ignore them.',
  },

  // ---- Updates & Rollouts -------------------------------------------------
  {
    command: 'kubectl set image deployment/<deploy-name> <container-name>=<image-name>:<tag>',
    description: 'Update the image of a container in a deployment.',
    category: 'rollout',
    tags: ['Deploy'],
    explanation: 'Triggers a rolling update. Prefer changing the manifest and applying it, so the cluster state stays reproducible from git.',
  },
  {
    command: 'kubectl rollout status deployment/<deploy-name>',
    description: 'Watch a rollout until it completes or fails.',
    category: 'rollout',
    tags: ['Deploy'],
    explanation: 'Blocks until all replicas are updated and available, then exits non-zero on failure — which is why CI pipelines use it as the deploy gate.',
    risk: 'read',
  },
  {
    command: 'kubectl rollout history deployment/<deploy-name>',
    description: 'List the revision history of a deployment.',
    category: 'rollout',
    tags: ['Deploy'],
    explanation: 'Add --revision=<n> to see the full pod template of one revision before rolling back to it.',
    risk: 'read',
  },
  {
    command: 'kubectl rollout undo deployment/<deploy-name>',
    description: 'Roll a deployment back to its previous revision.',
    category: 'rollout',
    tags: ['Deploy'],
    explanation: 'The emergency brake after a bad deploy. Add --to-revision=<n> to target a specific one from the history.',
  },
  {
    command: 'kubectl rollout restart deployment/<deploy-name>',
    description: 'Restart all pods of a deployment gracefully.',
    category: 'rollout',
    tags: ['Deploy'],
    explanation: 'Performs a rolling restart by stamping the pod template with a new annotation. The correct way to pick up a changed ConfigMap or Secret.',
  },
  {
    command: 'kubectl rollout pause deployment/<deploy-name>',
    description: 'Pause a rollout so several changes can be batched.',
    category: 'rollout',
    tags: ['Deploy'],
    explanation: 'Lets you make multiple edits without triggering a rollout per change. Nothing happens until you rollout resume.',
  },
  {
    command: 'kubectl scale deployment/<deploy-name> --replicas=<count>',
    description: 'Change the replica count of a deployment.',
    category: 'rollout',
    tags: ['Deploy', 'Scaling'],
    explanation: 'Scaling to 0 is the standard way to stop a workload without deleting it or losing its configuration.',
  },
  {
    command: 'kubectl autoscale deployment/<deploy-name> --min=2 --max=10 --cpu-percent=80',
    description: 'Create a HorizontalPodAutoscaler for a deployment.',
    category: 'rollout',
    tags: ['Scaling'],
    explanation: 'Requires metrics-server to be running — without it the HPA reports unknown CPU and never scales.',
  },
  {
    command: 'kubectl patch deployment <deploy-name> -p \'{"spec":{"replicas":3}}\'',
    description: 'Apply a partial JSON change to a live object.',
    category: 'rollout',
    tags: ['Deploy'],
    explanation: 'Surgical edit of one field without touching the rest. Useful when the full manifest is managed elsewhere.',
  },

  // ---- Capacity & Scheduling ---------------------------------------------
  {
    command: 'kubectl top node',
    description: 'Show CPU and memory usage per node.',
    category: 'resources',
    tags: ['Metrics'],
    explanation: 'Requires metrics-server. Shows actual usage, not requests — a node can be 100% requested and 5% used.',
  },
  {
    command: 'kubectl top pod -A --sort-by=memory',
    description: 'Rank pods across the cluster by memory usage.',
    category: 'resources',
    tags: ['Metrics'],
    explanation: 'Finds the workload responsible for node memory pressure. Compare against the pod\'s limit to predict the next OOMKill.',
  },
  {
    command: 'kubectl describe node <node-name>',
    description: 'Show node capacity, conditions and everything scheduled on it.',
    category: 'resources',
    tags: ['Nodes', 'Diagnostics'],
    explanation: 'The Conditions block reveals DiskPressure/MemoryPressure, and the Allocated resources table at the bottom explains most Pending pods.',
  },
  {
    command: 'kubectl get nodes -o wide',
    description: 'List nodes with IPs, OS, kernel and runtime versions.',
    category: 'resources',
    tags: ['Nodes'],
    explanation: 'A version skew across nodes here often explains why a workload runs on some nodes and not others.',
  },
  {
    command: 'kubectl cordon <node-name>',
    description: 'Mark a node unschedulable without evicting anything.',
    category: 'resources',
    tags: ['Nodes', 'Maintenance'],
    explanation: 'Stops new pods landing on the node. Running pods stay exactly where they are.',
  },
  {
    command: 'kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data',
    description: 'Evict all pods from a node for maintenance.',
    category: 'resources',
    tags: ['Nodes', 'Maintenance'],
    explanation: 'Cordons, then evicts respecting PodDisruptionBudgets. --ignore-daemonsets is required because DaemonSet pods cannot be evicted; --delete-emptydir-data acknowledges that scratch data will be lost.',
  },
  {
    command: 'kubectl uncordon <node-name>',
    description: 'Make a node schedulable again after maintenance.',
    category: 'resources',
    tags: ['Nodes', 'Maintenance'],
    explanation: 'Easy to forget after a drain — a cordoned node silently reduces cluster capacity forever.',
  },
  {
    command: 'kubectl taint nodes <node-name> <key>=<value>:NoSchedule',
    description: 'Repel pods from a node unless they tolerate the taint.',
    category: 'resources',
    tags: ['Nodes', 'Scheduling'],
    explanation: 'How GPU nodes are reserved for GPU workloads. Remove a taint by repeating the command with a trailing minus, e.g. key=value:NoSchedule-',
  },
  {
    command: 'kubectl get pvc -A',
    description: 'List persistent volume claims across all namespaces.',
    category: 'resources',
    tags: ['Storage'],
    explanation: 'A claim stuck Pending is the usual reason a pod never leaves ContainerCreating.',
  },
  {
    command: 'kubectl get storageclass',
    description: 'List available storage classes and their provisioners.',
    category: 'resources',
    tags: ['Storage'],
    explanation: 'A PVC referencing a StorageClass that does not exist stays Pending forever with a FailedBinding event.',
  },

  // ---- Security & RBAC ----------------------------------------------------
  {
    command: 'kubectl auth can-i create pods',
    description: 'Check whether your context may create pods.',
    category: 'security',
    tags: ['RBAC'],
    explanation: 'Queries the SubjectAccessReview API directly, so you learn about a permission problem before a deploy half-fails.',
  },
  {
    command: 'kubectl auth can-i --list -n <namespace>',
    description: 'List every action you are allowed in a namespace.',
    category: 'security',
    tags: ['RBAC'],
    explanation: 'The complete picture of your effective permissions — far faster than reading Roles and RoleBindings by hand.',
  },
  {
    command: 'kubectl auth can-i create deployments --as=system:serviceaccount:<namespace>:<serviceaccount>',
    description: 'Check permissions as another user or service account.',
    category: 'security',
    tags: ['RBAC'],
    explanation: 'Impersonation lets an admin answer "why is the CI service account failing?" without borrowing its credentials.',
  },
  {
    command: 'kubectl get rolebindings,clusterrolebindings -A -o wide',
    description: 'List every role binding in the cluster.',
    category: 'security',
    tags: ['RBAC', 'Audit'],
    explanation: 'The starting point of an access audit: who is bound to what, and at which scope.',
  },
  {
    command: 'kubectl get secret <secret-name> -o jsonpath="{.data.<key>}"',
    description: 'Read one key out of a Secret (still base64-encoded).',
    category: 'security',
    tags: ['Secrets'],
    explanation: 'Prints the base64 value; decode it separately. Be aware that reading a Secret is an audited, privileged action.',
  },
  {
    command: 'kubectl get serviceaccount <serviceaccount> -o yaml',
    description: 'Inspect a service account and its attached secrets.',
    category: 'security',
    tags: ['RBAC'],
    explanation: 'Shows attached imagePullSecrets — a common cause of ImagePullBackOff that only affects pods in one namespace.',
  },

  // ---- Advanced -----------------------------------------------------------
  {
    command: 'kubectl get --raw /healthz?verbose',
    description: 'Query the API server health endpoint directly.',
    category: 'advanced',
    tags: ['Diagnostics', 'Control plane'],
    explanation: 'Bypasses the resource layer entirely and lists every individual control-plane health check, including etcd.',
  },
  {
    command: 'kubectl get crd',
    description: 'List custom resource definitions installed in the cluster.',
    category: 'advanced',
    tags: ['CRD', 'Platform'],
    explanation: 'On a platform like HPE PCAI this is how you discover what the operators actually installed — the CRDs are the platform\'s real API.',
  },
  {
    command: 'kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations',
    description: 'List admission webhooks that intercept every write.',
    category: 'advanced',
    tags: ['Admission', 'Platform'],
    explanation: 'When every deploy suddenly fails or hangs, a webhook whose backing service is down is a prime suspect. Check its failurePolicy: Fail blocks writes, Ignore silently skips the policy.',
  },
  {
    command: 'kubectl get apiservices | grep -v True',
    description: 'Find aggregated API services that are unavailable.',
    category: 'advanced',
    tags: ['Diagnostics', 'Control plane'],
    explanation: 'A broken APIService (often metrics.k8s.io) makes unrelated commands like kubectl top or even get all fail with confusing errors.',
  },
  {
    command: 'kubectl wait --for=condition=Ready pod/<pod-name> --timeout=120s',
    description: 'Block until a resource reaches a condition.',
    category: 'advanced',
    tags: ['Scripting'],
    explanation: 'Turns a polling loop in a script into one line, and fails loudly on timeout instead of racing ahead.',
    risk: 'read',
  },
  {
    command: 'kubectl label pod <pod-name> <key>=<value> --overwrite',
    description: 'Add or change a label on a live object.',
    category: 'advanced',
    tags: ['Selectors'],
    explanation: 'Removing a pod\'s label pulls it out of its Service (and its ReplicaSet, which then makes a replacement) — a neat way to quarantine one bad pod for inspection while traffic keeps flowing.',
  },
  {
    command: 'kubectl annotate <resource>/<name> <key>=<value> --overwrite',
    description: 'Set an annotation on a resource.',
    category: 'advanced',
    tags: ['Metadata'],
    explanation: 'Annotations carry non-identifying metadata: rollout causes, ingress tuning, sidecar injection toggles.',
  },
  {
    command: 'kubectl replace --raw "/api/v1/namespaces/<namespace>/finalize" -f ns.json',
    description: 'Force-remove finalizers from a stuck namespace.',
    category: 'advanced',
    tags: ['Recovery'],
    explanation: 'A last resort. Finalizers exist to guarantee cleanup; stripping them can orphan real cloud resources such as load balancers and disks. Find out what the finalizer is waiting for first.',
    risk: 'destructive',
  },
  {
    command: 'kubectl api-resources --verbs=list --namespaced -o name',
    description: 'List every namespaced resource type, for exhaustive sweeps.',
    category: 'advanced',
    tags: ['Scripting', 'Audit'],
    explanation: 'Feed this into a loop to find what "kubectl get all" misses — the answer to "why does this namespace refuse to delete?".',
  },
];

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Multi-term AND search across command, description, tags and explanation.
 * Every whitespace-separated term must appear somewhere, so "logs previous"
 * narrows instead of widening.
 */
export function searchCommands(
  commands: CommandItem[],
  query: string,
  category: CategoryKey = 'all'
): CommandItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((cmd) => {
    if (category !== 'all' && cmd.category !== category) return false;
    if (!terms.length) return true;
    const haystack = `${cmd.command} ${cmd.description} ${cmd.tags.join(' ')} ${cmd.explanation || ''}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** How many commands each category holds, for the filter pills. */
export function categoryCounts(commands: CommandItem[]): Record<string, number> {
  const counts: Record<string, number> = { all: commands.length };
  for (const c of commands) counts[c.category] = (counts[c.category] || 0) + 1;
  return counts;
}

/** The effective risk of an item: explicit override, else derived from the verb. */
export function riskOf(item: CommandItem): Risk {
  return item.risk ?? classifyRisk(item.command);
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export type BuilderVerb =
  | 'get' | 'describe' | 'logs' | 'exec' | 'top'
  | 'delete' | 'scale' | 'rollout' | 'port-forward';

export interface BuilderState {
  verb: BuilderVerb;
  resource: string;
  name: string;
  namespaceOpt: 'default' | 'specific' | 'all';
  namespace: string;
  selector: string;
  /** get */
  format: 'standard' | 'wide' | 'yaml' | 'json' | 'name' | 'jsonpath';
  jsonpath: string;
  sortBy: string;
  watch: boolean;
  /** logs */
  container: string;
  tail: string;
  since: string;
  follow: boolean;
  previous: boolean;
  /** exec */
  execCommand: string;
  /** delete */
  force: boolean;
  /** scale */
  replicas: string;
  /** rollout */
  rolloutAction: 'status' | 'restart' | 'undo' | 'history';
  /** port-forward */
  localPort: string;
  remotePort: string;
  /** mutating verbs */
  dryRun: boolean;
}

export const DEFAULT_BUILDER: BuilderState = {
  verb: 'get',
  resource: 'pods',
  name: '',
  namespaceOpt: 'default',
  namespace: '',
  selector: '',
  format: 'standard',
  jsonpath: '{.items[*].metadata.name}',
  sortBy: '',
  watch: false,
  container: '',
  tail: '100',
  since: '',
  follow: false,
  previous: false,
  execCommand: '/bin/sh',
  force: false,
  replicas: '3',
  rolloutAction: 'status',
  localPort: '8080',
  remotePort: '80',
  dryRun: false,
};

/** Verbs that take a resource kind before the name. */
export const VERBS_WITH_RESOURCE: BuilderVerb[] = ['get', 'describe', 'delete', 'top'];
/** Verbs that require a specific object name. */
export const VERBS_REQUIRING_NAME: BuilderVerb[] = ['logs', 'exec', 'scale', 'port-forward'];

export function buildCommand(s: BuilderState): string {
  const name = s.name.trim() || '<name>';
  const parts: string[] = ['kubectl'];

  // Scope flags are identical for every verb, so build them once.
  const scope: string[] = [];
  if (s.namespaceOpt === 'specific' && s.namespace.trim()) scope.push('-n', s.namespace.trim());
  else if (s.namespaceOpt === 'all') scope.push('-A');

  // A label selector only means something when you have NOT named one object.
  const selector = s.selector.trim() && !s.name.trim() ? ['-l', s.selector.trim()] : [];

  switch (s.verb) {
    case 'get': {
      parts.push('get', s.resource, ...(s.name.trim() ? [name] : []), ...scope, ...selector);
      if (s.format === 'jsonpath') parts.push('-o', `jsonpath="${s.jsonpath}"`);
      else if (s.format !== 'standard') parts.push('-o', s.format);
      if (s.sortBy.trim()) parts.push(`--sort-by=${s.sortBy.trim()}`);
      if (s.watch) parts.push('--watch');
      break;
    }

    case 'describe':
      parts.push('describe', s.resource, ...(s.name.trim() ? [name] : []), ...scope, ...selector);
      break;

    case 'top':
      parts.push('top', s.resource, ...(s.name.trim() ? [name] : []), ...scope, ...selector);
      if (s.sortBy.trim()) parts.push(`--sort-by=${s.sortBy.trim()}`);
      break;

    case 'logs':
      parts.push('logs', name, ...scope);
      if (s.container.trim()) parts.push('-c', s.container.trim());
      if (s.previous) parts.push('--previous');
      if (s.since.trim()) parts.push(`--since=${s.since.trim()}`);
      if (s.tail && s.tail !== 'all') parts.push(`--tail=${s.tail}`);
      if (s.follow) parts.push('-f');
      break;

    case 'exec': {
      parts.push('exec', '-it', name, ...scope);
      if (s.container.trim()) parts.push('-c', s.container.trim());
      parts.push('--', ...s.execCommand.trim().split(/\s+/).filter(Boolean));
      break;
    }

    case 'delete':
      parts.push('delete', s.resource, ...(s.name.trim() ? [name] : []), ...scope, ...selector);
      if (s.force) parts.push('--force', '--grace-period=0');
      if (s.dryRun) parts.push('--dry-run=client');
      break;

    case 'scale':
      parts.push('scale', `${s.resource}/${name}`, ...scope, `--replicas=${s.replicas.trim() || '0'}`);
      if (s.dryRun) parts.push('--dry-run=client');
      break;

    case 'rollout':
      parts.push('rollout', s.rolloutAction, `${s.resource}/${name}`, ...scope);
      if (s.dryRun && s.rolloutAction === 'restart') parts.push('--dry-run=client');
      break;

    case 'port-forward':
      parts.push(
        'port-forward',
        `${s.resource === 'services' ? 'svc' : 'pod'}/${name}`,
        ...scope,
        `${s.localPort.trim() || '8080'}:${s.remotePort.trim() || '80'}`
      );
      break;
  }

  return parts.join(' ');
}

export interface BuilderIssue {
  level: 'error' | 'warning';
  message: string;
}

/**
 * Catch the combinations that produce an invalid command or a very bad day,
 * before the operator copies it into a terminal.
 */
export function validateBuilder(s: BuilderState): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const name = s.name.trim();

  if (VERBS_REQUIRING_NAME.includes(s.verb) && !name) {
    issues.push({ level: 'error', message: `${s.verb} needs a specific resource name.` });
  }
  if (s.verb === 'rollout' && !name) {
    issues.push({ level: 'error', message: 'rollout needs the name of a deployment, daemonset or statefulset.' });
  }
  if (s.namespaceOpt === 'all' && name) {
    issues.push({ level: 'error', message: '-A cannot be combined with a specific resource name — use -n <namespace> instead.' });
  }
  if (s.namespaceOpt === 'specific' && !s.namespace.trim()) {
    issues.push({ level: 'warning', message: 'No namespace typed yet, so the command falls back to your current default.' });
  }
  if (s.verb === 'delete' && !name && !s.selector.trim()) {
    issues.push({ level: 'warning', message: `This deletes EVERY ${s.resource} in scope. Add a name or a label selector.` });
  }
  if (s.verb === 'delete' && s.force) {
    issues.push({ level: 'warning', message: 'Force delete removes the object from the API immediately, even if the container is still running — it can leave orphaned processes and duplicate StatefulSet members.' });
  }
  if (s.verb === 'scale' && s.replicas.trim() === '0') {
    issues.push({ level: 'warning', message: 'Scaling to 0 stops the workload entirely (config is kept).' });
  }
  if (s.verb === 'scale' && !/^\d+$/.test(s.replicas.trim())) {
    issues.push({ level: 'error', message: 'Replicas must be a non-negative whole number.' });
  }
  if (s.verb === 'get' && s.format === 'jsonpath' && !s.jsonpath.trim()) {
    issues.push({ level: 'error', message: 'jsonpath output needs an expression.' });
  }
  if (s.verb === 'top' && !['pods', 'nodes'].includes(s.resource)) {
    issues.push({ level: 'error', message: 'kubectl top only supports pods and nodes.' });
  }
  if (s.verb === 'logs' && s.follow && s.previous) {
    issues.push({ level: 'warning', message: '--previous reads a terminated container, so there is nothing left to follow.' });
  }
  if (s.selector.trim() && name) {
    issues.push({ level: 'warning', message: 'A label selector is ignored once you name a specific object.' });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Runbooks
// ---------------------------------------------------------------------------

export interface RunbookStep {
  step: number;
  title: string;
  cmd: string;
  notes: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  /** The symptom as it appears in the cluster, so the runbook is findable. */
  symptom: string;
  steps: RunbookStep[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'crashloop',
    title: 'Pod Crashing / CrashLoopBackOff',
    description: 'Diagnose containers that start, fail, and restart repeatedly.',
    symptom: 'STATUS shows CrashLoopBackOff and the restart count keeps climbing.',
    steps: [
      { step: 1, title: 'Find the pod and its restart count', cmd: 'kubectl get pods -o wide', notes: 'Note the exact name, status, restart tally and which node it landed on. Several pods failing on one node points at the node, not the app.' },
      { step: 2, title: 'Read the events', cmd: 'kubectl describe pod <pod-name>', notes: 'Go to the Events ledger at the bottom. Look for probe failures, image pull errors, and the container Exit Code — 137 means OOMKilled, 1 means the process itself failed.' },
      { step: 3, title: 'Read the logs of the instance that DIED', cmd: 'kubectl logs <pod-name> --previous', notes: 'The critical step. The running container was just created and knows nothing; the fatal error lives in the previous one.' },
      { step: 4, title: 'Rule out config and dependencies', cmd: 'kubectl get configmap,secret -n <namespace>', notes: 'CreateContainerConfigError means a referenced ConfigMap or Secret does not exist. Verify the names in the pod spec resolve.' },
      { step: 5, title: 'Test the network from inside the cluster', cmd: 'kubectl run tmp-shell --rm -it --image=busybox --restart=Never -- sh', notes: 'If the app crashes trying to reach a dependency, prove whether that dependency is reachable from a pod in the same namespace.' },
    ],
  },
  {
    id: 'svc-routing',
    title: 'Service Not Routing Traffic',
    description: 'Resolve connectivity breaks between Services and workload Pods.',
    symptom: 'Connection refused or timeouts to a Service that looks healthy.',
    steps: [
      { step: 1, title: 'Check the endpoints first', cmd: 'kubectl get endpoints <service-name>', notes: 'This one command resolves most cases. Empty endpoints means the Service selector matches no ready pod, so traffic never reaches your app.' },
      { step: 2, title: 'Compare selector against pod labels', cmd: 'kubectl get pods --show-labels', notes: 'Read the Service selector from describe svc and compare it character by character. A single typo produces exactly this symptom.' },
      { step: 3, title: 'Confirm the pods are actually Ready', cmd: 'kubectl get pods -l <key>=<value>', notes: 'A pod only becomes an endpoint once its readiness probe passes. Running is not the same as Ready.' },
      { step: 4, title: 'Check ports line up', cmd: 'kubectl describe svc <service-name>', notes: 'The Service targetPort must match the container port the app actually listens on — not the Service port.' },
      { step: 5, title: 'Bypass the network path entirely', cmd: 'kubectl port-forward svc/<service-name> 8080:<service-port>', notes: 'If port-forward works but Ingress does not, the app is fine and the problem is in the ingress path.' },
    ],
  },
  {
    id: 'pending',
    title: 'Pod Stuck in Pending',
    description: 'Work out why the scheduler will not place a pod on any node.',
    symptom: 'Pod sits in Pending with no node assigned.',
    steps: [
      { step: 1, title: 'Read the scheduling failure', cmd: 'kubectl describe pod <pod-name>', notes: 'The FailedScheduling event states the reason verbatim: insufficient cpu/memory, taints not tolerated, or no available PVC.' },
      { step: 2, title: 'Check remaining node capacity', cmd: 'kubectl describe node <node-name>', notes: 'The "Allocated resources" table shows requests vs capacity. A cluster can be 100% requested while barely used — the scheduler goes by requests.' },
      { step: 3, title: 'Check taints', cmd: 'kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints', notes: 'GPU and control-plane nodes are usually tainted. A pod without the matching toleration can never land there.' },
      { step: 4, title: 'Check the volume claim', cmd: 'kubectl get pvc -n <namespace>', notes: 'A Pending PVC keeps its pod Pending too. Follow the PVC runbook if this is the case.' },
    ],
  },
  {
    id: 'imagepull',
    title: 'ImagePullBackOff / ErrImagePull',
    description: 'The node cannot fetch the container image.',
    symptom: 'Pods stay in ImagePullBackOff and never start.',
    steps: [
      { step: 1, title: 'Read the exact pull error', cmd: 'kubectl describe pod <pod-name>', notes: 'The event distinguishes the three causes: "not found" (wrong name/tag), "unauthorized" (missing credentials), or a timeout (no network route to the registry).' },
      { step: 2, title: 'Verify the image reference', cmd: 'kubectl get pod <pod-name> -o jsonpath="{.spec.containers[*].image}"', notes: 'Check the registry host, path and tag. A missing tag defaults to :latest, which may not exist.' },
      { step: 3, title: 'Check the pull secret exists and is attached', cmd: 'kubectl get secret -n <namespace>', notes: 'The secret must be in the SAME namespace as the pod, and referenced by imagePullSecrets in the pod spec or on its ServiceAccount.' },
      { step: 4, title: 'Create the registry credential if missing', cmd: 'kubectl create secret docker-registry regcred --docker-server=<registry> --docker-username=<user> --docker-password=<password>', notes: 'Then reference it under imagePullSecrets, or patch the default ServiceAccount so every pod in the namespace inherits it.' },
    ],
  },
  {
    id: 'oomkilled',
    title: 'OOMKilled / Exit Code 137',
    description: 'The kernel killed the container for exceeding its memory limit.',
    symptom: 'Container restarts with Last State: Terminated, Reason: OOMKilled.',
    steps: [
      { step: 1, title: 'Confirm the kill and its limit', cmd: 'kubectl describe pod <pod-name>', notes: 'Look for Last State: Terminated, Reason: OOMKilled and compare it against the container Limits block.' },
      { step: 2, title: 'Measure real usage over time', cmd: 'kubectl top pod -A --sort-by=memory', notes: 'Decide between "the limit is too low" and "the app leaks". A steady climb until the limit is a leak; a spike at load is an undersized limit.' },
      { step: 3, title: 'Check whether the node was also under pressure', cmd: 'kubectl describe node <node-name>', notes: 'MemoryPressure on the node means eviction, which looks similar but has a different fix — reduce load or add capacity.' },
      { step: 4, title: 'Raise the limit deliberately', cmd: 'kubectl set resources deployment/<deploy-name> --limits=memory=<size>', notes: 'Prefer changing the manifest in git. Raising a limit to hide a leak just moves the outage later.' },
    ],
  },
  {
    id: 'node-notready',
    title: 'Node NotReady',
    description: 'A node stopped reporting healthy and its pods are being disrupted.',
    symptom: 'kubectl get nodes shows NotReady; pods on that node go Unknown or get evicted.',
    steps: [
      { step: 1, title: 'Read the node conditions', cmd: 'kubectl describe node <node-name>', notes: 'The Conditions block names it: DiskPressure, MemoryPressure, PIDPressure, or a kubelet that simply stopped posting status.' },
      { step: 2, title: 'See what is stranded on it', cmd: 'kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name>', notes: 'Establish the blast radius before touching anything — this tells you whether it is safe to drain.' },
      { step: 3, title: 'Get onto the node', cmd: 'kubectl debug node/<node-name> -it --image=busybox', notes: 'If SSH is unavailable. From there check the kubelet and container runtime: systemctl status kubelet, journalctl -u kubelet -n 100.' },
      { step: 4, title: 'Drain it for maintenance', cmd: 'kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data', notes: 'Only once you know why it failed. Remember to uncordon afterwards, or the node stays out of service silently.' },
    ],
  },
  {
    id: 'pvc-pending',
    title: 'PVC Stuck in Pending',
    description: 'A persistent volume claim never binds to storage.',
    symptom: 'PVC shows Pending; the pod that mounts it stays in ContainerCreating.',
    steps: [
      { step: 1, title: 'Find the unbound claims', cmd: 'kubectl get pvc -A', notes: 'Anything not Bound blocks its pod from starting.' },
      { step: 2, title: 'Read the binding failure', cmd: 'kubectl describe pvc <pvc-name>', notes: 'FailedBinding usually names a missing StorageClass, an unavailable provisioner, or an unsatisfiable size/access-mode request.' },
      { step: 3, title: 'Verify the storage class exists', cmd: 'kubectl get storageclass', notes: 'A PVC naming a StorageClass that is not installed waits forever. Note which class is marked (default).' },
      { step: 4, title: 'Check the CSI driver is actually running', cmd: 'kubectl get pods -n kube-system -l app=csi-driver', notes: 'Dynamic provisioning needs a healthy CSI controller and a node plugin on the target node. On PCAI this is typically the HPE CSI driver.' },
    ],
  },
  {
    id: 'ns-terminating',
    title: 'Namespace Stuck in Terminating',
    description: 'A namespace refuses to delete because a finalizer is still waiting.',
    symptom: 'Namespace has been Terminating for many minutes with nothing visible left in it.',
    steps: [
      { step: 1, title: 'Find what is actually left', cmd: 'kubectl api-resources --verbs=list --namespaced -o name', notes: 'Loop this over kubectl get -n <namespace> — "kubectl get all" misses most resource types, which is exactly why the namespace looks empty.' },
      { step: 2, title: 'Find the blocking finalizer', cmd: 'kubectl get namespace <namespace-name> -o json', notes: 'Read spec.finalizers and status.conditions. The condition usually names the API group whose resources cannot be cleaned up — frequently a CRD whose operator is gone.' },
      { step: 3, title: 'Fix the real cause if you can', cmd: 'kubectl get apiservices | grep -v True', notes: 'An unavailable aggregated API blocks namespace cleanup. Restoring it lets the deletion finish on its own, with no forcing.' },
      { step: 4, title: 'Last resort: strip the finalizer', cmd: 'kubectl replace --raw "/api/v1/namespaces/<namespace-name>/finalize" -f ns.json', notes: 'Dump the namespace to ns.json, empty the finalizers array, then send this. It can orphan real cloud resources such as load balancers and disks — only do this once you know what was waiting.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

export interface QuizQuestion {
  question: string;
  options: string[];
  correct: number;
  explanation: string;
}

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    question: 'How do you view logs of a container that crashed in its previous run?',
    options: ['kubectl logs <pod-name> --previous', 'kubectl logs <pod-name> -f', 'kubectl describe pod <pod-name> --logs', 'kubectl get pods --logs-crashed'],
    correct: 0,
    explanation: 'The --previous (or -p) flag retrieves the logs of the container from its previous instance, which is essential for troubleshooting CrashLoopBackOff — the running container was just created and holds no record of the crash.',
  },
  {
    question: 'Which option generates a local YAML spec for a Deployment without creating it in the cluster?',
    options: ['kubectl create deployment my-dep --image=nginx --yaml', 'kubectl create deployment my-dep --image=nginx --dry-run=client -o yaml > dep.yaml', 'kubectl run my-dep --image=nginx --export > dep.yaml', 'kubectl apply deployment my-dep --dry-run=yaml'],
    correct: 1,
    explanation: '--dry-run=client builds the API object locally, and -o yaml prints it instead of sending it. --export was removed in Kubernetes 1.18.',
  },
  {
    question: 'Which command safely evicts all pods from a Node and marks it unschedulable?',
    options: ['kubectl cordon <node-name>', 'kubectl delete node <node-name>', 'kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data', 'kubectl stop node <node-name>'],
    correct: 2,
    explanation: 'drain cordons the node and then evicts its pods while respecting PodDisruptionBudgets. cordon alone only stops NEW pods from scheduling; it never moves the running ones.',
  },
  {
    question: 'What is the correct syntax to forward local port 8080 to pod web-pod on container port 80?',
    options: ['kubectl port-forward web-pod 8080:80', 'kubectl forward web-pod 80:8080', 'kubectl port-forward web-pod 80:8080', 'kubectl tunnel web-pod --port=8080'],
    correct: 0,
    explanation: 'The syntax is "kubectl port-forward <resource> <local-port>:<remote-port>" — local first. Reversing them silently forwards the wrong way round.',
  },
  {
    question: 'How do you check whether your current context may create Secrets?',
    options: ['kubectl check-privilege secret', 'kubectl auth can-i create secrets', 'kubectl get rbac --can-create=secrets', 'kubectl show privileges'],
    correct: 1,
    explanation: '"kubectl auth can-i" queries the SubjectAccessReview API directly. Add --list to see every permission you hold in the namespace.',
  },
  {
    question: 'A Service returns connection refused. Which single command most quickly tells you whether it routes anywhere at all?',
    options: ['kubectl describe svc <name>', 'kubectl get endpoints <name>', 'kubectl logs svc/<name>', 'kubectl get svc <name> -o wide'],
    correct: 1,
    explanation: 'Empty endpoints proves the Service selector matches no READY pod, so traffic never reaches your application. It separates "the app is broken" from "nothing is wired up" in one step.',
  },
  {
    question: 'A container is terminated with exit code 137. What happened?',
    options: ['The image could not be pulled', 'The liveness probe failed', 'The kernel killed it for exceeding its memory limit', 'The node was drained'],
    correct: 2,
    explanation: '137 is 128 + 9, i.e. SIGKILL — the OOM killer. Either the memory limit is too low for the workload or the application is leaking.',
  },
  {
    question: 'Why does --dry-run=server catch problems that --dry-run=client misses?',
    options: ['It is faster', 'It runs full admission control including validating webhooks', 'It writes the object then rolls it back', 'It validates YAML indentation'],
    correct: 1,
    explanation: 'Server-side dry run goes through the real admission chain, so policy engines like Kyverno or Gatekeeper get to reject it. Client-side never contacts admission at all.',
  },
  {
    question: 'Every deploy in the cluster suddenly hangs or is rejected. Which is the prime suspect?',
    options: ['A full node disk', 'An admission webhook whose backing service is down', 'An expired kubeconfig', 'A missing StorageClass'],
    correct: 1,
    explanation: 'A ValidatingWebhookConfiguration with failurePolicy: Fail blocks every matching write when its service is unreachable. Check with kubectl get validatingwebhookconfigurations.',
  },
  {
    question: 'A pod is stuck in Pending. Where is the reason stated explicitly?',
    options: ['In the container logs', 'In the FailedScheduling event from kubectl describe pod', 'In kubectl top pod', 'In the kubelet version'],
    correct: 1,
    explanation: 'A Pending pod has no container yet, so there are no logs to read. The scheduler records exactly why it could not place it — insufficient resources, an untolerated taint, or an unbound PVC.',
  },
  {
    question: 'Which command shows the pods actually consuming the most memory right now?',
    options: ['kubectl get pods -o wide', 'kubectl describe pods', 'kubectl top pod -A --sort-by=memory', 'kubectl get pods --sort-by=.spec.containers[0].resources.limits.memory'],
    correct: 2,
    explanation: 'kubectl top reports live usage from metrics-server. The get variants only show what was REQUESTED or LIMITED, which is often nothing like actual consumption.',
  },
  {
    question: 'What does removing a pod\'s app label typically achieve?',
    options: ['It deletes the pod', 'It pulls the pod out of its Service and ReplicaSet, so it can be inspected while a replacement is created', 'It restarts the container', 'It changes the namespace'],
    correct: 1,
    explanation: 'Labels are how Services and ReplicaSets claim pods. Removing the label quarantines the pod for debugging, and the ReplicaSet immediately creates a replacement so traffic is unaffected.',
  },
];

/**
 * Fisher-Yates shuffle against an injectable RNG, so quiz order is random in
 * the app and deterministic in tests.
 */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick n questions at random for one quiz run. */
export function pickQuiz(n = 8, rng: () => number = Math.random): QuizQuestion[] {
  return shuffle(QUIZ_QUESTIONS, rng).slice(0, Math.min(n, QUIZ_QUESTIONS.length));
}
