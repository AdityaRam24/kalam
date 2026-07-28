# ☸️ Ultimate Kubectl Cheat Sheet

This cheat sheet provides a comprehensive index of `kubectl` commands for Kubernetes cluster administrators and DevOps engineers. 

---

## 📂 Table of Contents
1. [Configuration & Contexts](#-configuration--contexts)
2. [Creating & Deploying Workloads](#-creating--deploying-workloads)
3. [Viewing & Querying Resources](#-viewing--querying-resources)
4. [Troubleshooting & Diagnostics](#-troubleshooting--diagnostics)
5. [Updates, Rollouts & Scaling](#-updates-rollouts--scaling)
6. [Advanced Operations & Administration](#-advanced-operations--administration)
7. [Useful Output Formatting Hacks](#-useful-output-formatting-hacks)
8. [Common Troubleshooting Runbooks](#-common-troubleshooting-runbooks)

---

## ⚙️ Configuration & Contexts

Manage Kubernetes cluster connections and active default namespace parameters.

| Command | Description |
| :--- | :--- |
| `kubectl config view` | Display merged `kubeconfig` settings (active keys, clusters, and contexts). |
| `kubectl config get-contexts` | List all available cluster contexts configured locally. |
| `kubectl config current-context` | Print the name of the currently active context. |
| `kubectl config use-context <context-name>` | Switch connection parameters to the designated cluster context. |
| `kubectl config set-context --current --namespace=<ns>` | Set the default namespace scope for the current active context. |
| `kubectl config delete-context <context-name>` | Delete the specified context configuration. |

---

## 🏗️ Creating & Deploying Workloads

Deploy pods, services, secrets, and configuration maps declarations.

| Command | Description |
| :--- | :--- |
| `kubectl apply -f <spec.yaml>` | Create or update resources defined in a YAML specification. |
| `kubectl apply -f <dir>/` | Recursively apply all YAML configurations found in the directory. |
| `kubectl create deployment <name> --image=<img-tag>` | Create a Deployment running the target container image. |
| `kubectl expose deployment <name> --port=<ext> --target-port=<int> --type=NodePort` | Create a NodePort Service routing external traffic into a Deployment. |
| `kubectl run <pod-name> --image=<img-tag> --restart=Never` | Run a single, standalone Pod. |
| `kubectl run <pod-name> --image=<img-tag> --restart=Never --dry-run=client -o yaml > pod.yaml` | Dry-run template generation. Creates a local Pod YAML template file. |
| `kubectl create configmap <cm-name> --from-literal=key=val` | Create a ConfigMap with key-value data parameters. |
| `kubectl create secret generic <s-name> --from-literal=key=secret` | Create a generic Secret containing encoded literal key-value values. |

---

## 🔍 Viewing & Querying Resources

Inspect cluster configurations, logs, and query status updates.

| Command | Description |
| :--- | :--- |
| `kubectl get pods` | List all pods in the active namespace. |
| `kubectl get pods -A` | List all pods globally across all cluster namespaces. |
| `kubectl get pods -n <namespace>` | List pods within a specific namespace scope. |
| `kubectl get pods -o wide` | List pods showing node allocation hostnames and Pod IPs. |
| `kubectl describe pod <pod-name>` | Inspect pod events, container lifecycles, and configuration mappings. |
| `kubectl get deployment <deploy-name> -o yaml` | Export live runtime deployment configuration specs in YAML. |
| `kubectl get events --sort-by='.metadata.creationTimestamp'` | View namespace ledger events sorted chronologically. |
| `kubectl get pods --field-selector status.phase=Failed` | List failed pods in the namespace. |
| `kubectl explain pods.spec.containers` | Show documentation specs of resource fields straight from the API schema. |

---

## 🛠️ Troubleshooting & Diagnostics

Interact directly with container filesystems, stream logs, and check compute loads.

| Command | Description |
| :--- | :--- |
| `kubectl logs <pod-name>` | Retrieve active standard output (stdout/stderr) logs of a pod. |
| `kubectl logs <pod-name> -c <container-name> -f` | Continuous live log streaming (`-f`) from a specific container. |
| `kubectl logs <pod-name> --previous` | Retrieve logs of the previous crashed container iteration (essential for `CrashLoopBackOff`). |
| `kubectl exec -it <pod-name> -- /bin/sh` | Connect to an interactive shell (`sh`/`bash`) inside a running pod container. |
| `kubectl port-forward <pod-name> <local>:<pod-port>` | Map a local port on your host directly to a pod port (tunnels local calls). |
| `kubectl cp <local-file> <pod-name>:/tmp/<dest>` | Transfer files from your host machine into a pod container environment. |
| `kubectl top node` | Display CPU/Memory workloads per physical host Node (requires metrics-server). |
| `kubectl top pod` | Display CPU/Memory workloads per active workload Pod. |

---

## 📈 Updates, Rollouts & Scaling

Handle workload version updates, rolling restarts, and replica scaling.

| Command | Description |
| :--- | :--- |
| `kubectl set image deployment/<name> <container>=<img:tag>` | Update deployment container image to initiate a rolling update. |
| `kubectl rollout status deployment/<name>` | Track rolling update progression in real-time. |
| `kubectl rollout history deployment/<name>` | View the history list of deployment revisions. |
| `kubectl rollout undo deployment/<name>` | Roll back a deployment instantly to its previous revision. |
| `kubectl rollout restart deployment/<name>` | Trigger a rolling restart of all pods under the deployment. |
| `kubectl scale deployment/<name> --replicas=<count>` | Instantly scale the deployment replica count up or down. |
| `kubectl autoscale deployment/<name> --min=2 --max=10 --cpu-percent=80` | Configure a Horizontal Pod Autoscaler (HPA) targeting CPU load. |

---

## 🛡️ Advanced Operations & Administration

Perform advanced administrative cluster node cordoning, draining, and RBAC privilege checks.

| Command | Description |
| :--- | :--- |
| `kubectl cordon <node-name>` | Mark node as unschedulable (prevents new pods scheduling on it). |
| `kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data` | Evict all pods from node safely before physical machine maintenance. |
| `kubectl uncordon <node-name>` | Mark node back as schedulable. |
| `kubectl api-resources` | Print all API endpoints, namespaces settings, and shortcode keys. |
| `kubectl auth can-i create pods` | Perform RBAC privilege checks to verify user authorizations. |

---

## 🎨 Useful Output Formatting Hacks

Quickly parse and format JSON/YAML query returns with command flags.

* **Format Output as JSON/YAML**:
  ```bash
  kubectl get pods -o json
  kubectl get pods -o yaml
  ```
* **Wide Output Format (Adds Node, IP, Readylines)**:
  ```bash
  kubectl get service -o wide
  ```
* **Custom Columns Formatting (Extract Specific Properties)**:
  ```bash
  kubectl get pods -o custom-columns=NAME:.metadata.name,IP:.status.podIP
  ```
* **Sort Resources (e.g. Sort Pods by Restart Count)**:
  ```bash
  kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'
  ```

---

## 🚨 Common Troubleshooting Runbooks

### 1. Pod is stuck in `CrashLoopBackOff` status
Follow these sequential debugging commands:
1. List namespace pods and check restart count:
   ```bash
   kubectl get pods -n <namespace>
   ```
2. Describe pod configuration parameters and inspect events:
   ```bash
   kubectl describe pod <pod-name> -n <namespace>
   ```
3. Extract previous crashed container stdout to inspect programming exceptions:
   ```bash
   kubectl logs <pod-name> -n <namespace> --previous
   ```
4. Run a temporary troubleshooting tool pod to inspect network paths:
   ```bash
   kubectl run debug-dns --image=busybox -it --rm --restart=Never -- nslookup kubernetes.default
   ```

### 2. Service endpoints return empty or traffic is not routed
Ensure correct label assignment mappings:
1. Check Service configuration details and selector parameters:
   ```bash
   kubectl describe svc <service-name> -n <namespace>
   ```
2. Check Endpoints list. If it displays `<none>`, labels do not match:
   ```bash
   kubectl get endpoints <service-name> -n <namespace>
   ```
3. Show labels of currently running workloads to verify the service matching query:
   ```bash
   kubectl get pods -n <namespace> --show-labels
   ```

### 3. Namespace remains stuck in `Terminating` status
Force-delete namespaces by bypassing finalizers:
1. Export namespace parameters as JSON:
   ```bash
   kubectl get namespace <ns-name> -o json > ns.json
   ```
2. Remove `"kubernetes"` from `spec.finalizers` in the `ns.json` file:
   ```json
   "spec": {
       "finalizers": []
   }
   ```
3. Replace raw namespace metadata via API PUT request:
   ```bash
   kubectl replace --raw "/api/v1/namespaces/<ns-name>/finalize" -f ns.json
   ```
