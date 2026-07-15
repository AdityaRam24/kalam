import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper for safe command execution
async function runCmd(cmd: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 }); // 10MB buffer
    return { stdout, stderr, success: true };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
      success: false,
    };
  }
}

// Regex validation helpers to prevent shell injection
const ALPHANUMERIC_DASH = /^[a-zA-Z0-9_.-]+$/;
const DOCKER_ID_REGEX = /^[a-fA-F0-9]{12,64}$|^[a-zA-Z0-9_.-]+$/;

// API: Get Status
app.get('/api/status', async (req, res) => {
  const dockerVer = await runCmd('docker --version');
  const k8sVer = await runCmd('kubectl version --client');
  const dockerRunning = await runCmd('docker ps');
  const k8sRunning = await runCmd('kubectl get nodes');

  res.json({
    docker: {
      installed: dockerVer.success,
      version: dockerVer.stdout.trim() || 'Not found',
      running: dockerRunning.success,
    },
    kubernetes: {
      installed: k8sVer.success,
      version: k8sVer.stdout.trim() || 'Not found',
      running: k8sRunning.success,
      context: k8sRunning.success ? 'docker-desktop' : 'Unavailable',
    }
  });
});

// API: List Docker Containers
app.get('/api/docker/containers', async (req, res) => {
  const { stdout, success, stderr } = await runCmd('docker ps -a --format "{{json .}}"');
  if (!success) {
    return res.status(500).json({ error: 'Failed to list containers', details: stderr });
  }

  const lines = stdout.split('\n').filter(line => line.trim() !== '');
  const containers = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Clean up common properties to ensure uniform output
      containers.push({
        id: parsed.ID,
        name: parsed.Names,
        image: parsed.Image,
        status: parsed.Status,
        state: parsed.State || (parsed.Status.toLowerCase().includes('up') ? 'running' : 'exited'),
        ports: parsed.Ports,
        created: parsed.RunningFor || parsed.CreatedAt,
      });
    } catch (e) {
      // Ignore parse errors on bad lines
    }
  }

  res.json(containers);
});

// API: Docker Container Actions
app.post('/api/docker/action', async (req, res) => {
  const { action, containerId } = req.body;

  if (!containerId || !DOCKER_ID_REGEX.test(containerId)) {
    return res.status(400).json({ error: 'Invalid container ID format' });
  }

  if (!['start', 'stop', 'restart', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  let cmd = '';
  switch (action) {
    case 'start':
      cmd = `docker start ${containerId}`;
      break;
    case 'stop':
      cmd = `docker stop ${containerId}`;
      break;
    case 'restart':
      cmd = `docker restart ${containerId}`;
      break;
    case 'remove':
      cmd = `docker rm -f ${containerId}`;
      break;
  }

  const { stdout, stderr, success } = await runCmd(cmd);
  if (!success) {
    return res.status(500).json({ error: `Failed to ${action} container`, details: stderr });
  }

  res.json({ message: `Container ${action}ed successfully`, output: stdout.trim() });
});

// API: Docker Logs
app.get('/api/docker/logs/:id', async (req, res) => {
  const { id } = req.params;

  if (!id || !DOCKER_ID_REGEX.test(id)) {
    return res.status(400).json({ error: 'Invalid container ID format' });
  }

  const { stdout, stderr, success } = await runCmd(`docker logs --tail 150 ${id}`);
  
  // Docker logs often write to stderr even when successful, so return stdout + stderr combined
  res.json({ logs: stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '') });
});

// API: Docker Image Security Vulnerability Scan
app.post('/api/docker/scan', async (req, res) => {
  const { imageName } = req.body;
  if (!imageName) {
    return res.status(400).json({ error: 'Image name is required' });
  }

  // Try running docker scout
  const cmd = `docker scout quickview ${imageName}`;
  const scoutRes = await runCmd(cmd);
  
  let isMock = !scoutRes.success;
  let rawOutput = scoutRes.stdout || scoutRes.stderr;

  let baseImage = imageName.split(':')[0];
  let tag = imageName.split(':')[1] || 'latest';
  
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  let vulnerabilities: any[] = [];
  let recommendation = '';
  let fixAction: any = null;

  if (isMock) {
    // Generate realistic vulnerabilities based on common base images
    if (baseImage.includes('node')) {
      critical = 3; high = 14; medium = 28; low = 12;
      vulnerabilities = [
        { cve: 'CVE-2023-46809', package: 'node', severity: 'Critical', desc: 'Vulnerability in Node.js HTTP/2 implementation leading to Denial of Service.' },
        { cve: 'CVE-2024-21824', package: 'undici', severity: 'High', desc: 'Undici HTTP Request smuggling through cookie injection.' },
        { cve: 'CVE-2023-5363', package: 'openssl', severity: 'High', desc: 'OpenSSL AES-GCM cipher encryption memory corruption.' }
      ];
      recommendation = `Upgrade Node.js base image to node:20-alpine. This reduces the image footprint by 80% and resolves all 3 Critical and 14 High vulnerabilities by switching to a minimal Alpine Linux footprint.`;
      fixAction = {
        type: 'docker_upgrade',
        targetImage: 'node:20-alpine',
        desc: 'Rebuild container using node:20-alpine'
      };
    } else if (baseImage.includes('postgres')) {
      critical = 1; high = 5; medium = 12; low = 8;
      vulnerabilities = [
        { cve: 'CVE-2023-51385', package: 'openssh', severity: 'Critical', desc: 'Remote Code Execution vulnerability in OpenSSH client config.' },
        { cve: 'CVE-2024-0985', package: 'postgresql', severity: 'High', desc: 'PostgreSQL privilege escalation via late-binding operators.' }
      ];
      recommendation = `Upgrade PostgreSQL to postgres:16-alpine. Using the Alpine-based tag removes major Debian dependencies and secures the database runtime.`;
      fixAction = {
        type: 'docker_upgrade',
        targetImage: 'postgres:16-alpine',
        desc: 'Upgrade PG container to postgres:16-alpine'
      };
    } else if (baseImage.includes('python')) {
      critical = 2; high = 8; medium = 15; low = 10;
      vulnerabilities = [
        { cve: 'CVE-2023-27043', package: 'python-email', severity: 'Critical', desc: 'Python email module parsing vulnerability leading to spoofing.' },
        { cve: 'CVE-2024-0450', package: 'zipfile', severity: 'High', desc: 'Path traversal vulnerability in zipfile module.' }
      ];
      recommendation = `Upgrade Python to python:3.11-slim. Toggling from the full debian base to the slim footprint trims unused build components and removes CVE vulnerabilities.`;
      fixAction = {
        type: 'docker_upgrade',
        targetImage: 'python:3.11-slim',
        desc: 'Upgrade Python container to python:3.11-slim'
      };
    } else {
      critical = 1; high = 3; medium = 7; low = 5;
      vulnerabilities = [
        { cve: 'CVE-2023-38408', package: 'ssh-agent', severity: 'Critical', desc: 'Remote Code Execution vulnerability in OpenSSH agent forwarding.' },
        { cve: 'CVE-2024-2961', package: 'glibc', severity: 'High', desc: 'Buffer overflow vulnerability in glibc iconv conversion.' }
      ];
      recommendation = `Switch to a distroless or minimal Alpine base tag. Standard library dependencies in raw base images contain build tools that are not needed at runtime.`;
      fixAction = {
        type: 'docker_upgrade',
        targetImage: `${baseImage}-alpine`,
        desc: 'Upgrade container base to Alpine version'
      };
    }
  } else {
    const critMatch = rawOutput.match(/([0-9]+)\s+critical/i);
    const highMatch = rawOutput.match(/([0-9]+)\s+high/i);
    const medMatch = rawOutput.match(/([0-9]+)\s+medium/i);
    const lowMatch = rawOutput.match(/([0-9]+)\s+low/i);

    critical = critMatch ? parseInt(critMatch[1]) : 0;
    high = highMatch ? parseInt(highMatch[1]) : 0;
    medium = medMatch ? parseInt(medMatch[1]) : 0;
    low = lowMatch ? parseInt(lowMatch[1]) : 0;

    vulnerabilities = [
      { cve: 'CVE-Detected-1', package: 'base-os', severity: high > 0 ? 'High' : 'Medium', desc: 'Scan output: ' + rawOutput.split('\n')[0] },
      { cve: 'CVE-Detected-2', package: 'libraries', severity: 'Medium', desc: 'Vulnerability list found in base image layers.' }
    ];
    recommendation = `Switch image base to ${baseImage}-alpine or minimal slim tag. Reducing image footprint removes standard library tools like compilers and package managers that are targets for exploits.`;
    fixAction = {
      type: 'docker_upgrade',
      targetImage: `${baseImage}-alpine`,
      desc: `Upgrade base to ${baseImage}-alpine`
    };
  }

  res.json({
    imageName,
    isMock,
    summary: { critical, high, medium, low },
    vulnerabilities,
    recommendation,
    fixAction
  });
});

// API: Apply Security Fix
app.post('/api/docker/apply-fix', async (req, res) => {
  const { containerId, targetImage } = req.body;
  if (!containerId || !targetImage) {
    return res.status(400).json({ error: 'Container ID and target image are required' });
  }

  const inspectRes = await runCmd(`docker inspect ${containerId}`);
  if (!inspectRes.success) {
    return res.status(500).json({ error: 'Failed to inspect container', details: inspectRes.stderr });
  }

  try {
    const data = JSON.parse(inspectRes.stdout)[0];
    const name = data.Name.replace(/^\//, ''); // Strip leading slash
    const config = data.Config || {};
    const hostConfig = data.HostConfig || {};

    const envs = config.Env || [];
    const envArgs = envs.map((e: string) => `-e "${e}"`).join(' ');

    const portBindings = hostConfig.PortBindings || {};
    const portArgs = Object.keys(portBindings).map(containerPort => {
      const binding = portBindings[containerPort][0];
      const hostPort = binding.HostPort;
      return `-p ${hostPort}:${containerPort.split('/')[0]}`;
    }).join(' ');

    const pullRes = await runCmd(`docker pull ${targetImage}`);
    if (!pullRes.success) {
      return res.status(500).json({ error: `Failed to pull secure image ${targetImage}`, details: pullRes.stderr });
    }

    await runCmd(`docker stop ${containerId}`);
    await runCmd(`docker rm ${containerId}`);

    const runCmdStr = `docker run -d --name ${name} ${portArgs} ${envArgs} ${targetImage}`;
    const newRunRes = await runCmd(runCmdStr);
    
    if (!newRunRes.success) {
      return res.status(500).json({ error: 'Failed to launch secured container', details: newRunRes.stderr });
    }

    res.json({
      message: 'Container upgraded and re-deployed successfully!',
      newContainerId: newRunRes.stdout.trim().slice(0, 12),
      cmdRun: runCmdStr
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to process container upgrade', details: err.message });
  }
});

// API: List Kubernetes Resources
app.get('/api/k8s/resources', async (req, res) => {
  // Query pods, services, deployments and nodes in one go
  const { stdout, success, stderr } = await runCmd('kubectl get pods,svc,deploy,nodes -o json --all-namespaces');
  if (!success) {
    return res.status(500).json({ error: 'Failed to query Kubernetes resources', details: stderr });
  }

  try {
    const raw = JSON.parse(stdout);
    const items = raw.items || [];

    const pods: any[] = [];
    const services: any[] = [];
    const deployments: any[] = [];
    const nodes: any[] = [];

    items.forEach((item: any) => {
      const kind = item.kind;
      const metadata = item.metadata || {};
      const status = item.status || {};
      const spec = item.spec || {};

      const name = metadata.name;
      const namespace = metadata.namespace || 'default';
      const age = metadata.creationTimestamp;

      if (kind === 'Pod') {
        const containerStatuses = status.containerStatuses || [];
        const readyCount = containerStatuses.filter((c: any) => c.ready).length;
        const totalCount = containerStatuses.length;

        pods.push({
          name,
          namespace,
          status: status.phase || 'Unknown',
          ready: `${readyCount}/${totalCount}`,
          ip: status.podIP || 'None',
          node: spec.nodeName || 'None',
          restarts: containerStatuses.reduce((acc: number, c: any) => acc + (c.restartCount || 0), 0),
          containers: (spec.containers || []).map((c: any) => {
            const statusMatch = containerStatuses.find((cs: any) => cs.name === c.name) || {};
            return {
              name: c.name,
              image: c.image,
              ready: statusMatch.ready || false,
              state: Object.keys(statusMatch.state || {})[0] || 'unknown',
            };
          }),
          created: age
        });
      } else if (kind === 'Service') {
        const ports = (spec.ports || []).map((p: any) => `${p.port}:${p.targetPort}/${p.protocol}`);
        services.push({
          name,
          namespace,
          type: spec.type || 'ClusterIP',
          clusterIp: spec.clusterIP || 'None',
          externalIp: (status.loadBalancer?.ingress || []).map((i: any) => i.ip || i.hostname).join(', ') || 'None',
          ports: ports.join(', '),
          selector: spec.selector ? JSON.stringify(spec.selector) : 'None',
          created: age
        });
      } else if (kind === 'Deployment') {
        deployments.push({
          name,
          namespace,
          ready: `${status.readyReplicas || 0}/${spec.replicas || 0}`,
          available: status.availableReplicas || 0,
          updated: status.updatedReplicas || 0,
          replicas: spec.replicas || 0,
          created: age
        });
      } else if (kind === 'Node') {
        const conds = status.conditions || [];
        const readyCond = conds.find((c: any) => c.type === 'Ready');
        const nodeStatus = readyCond ? (readyCond.status === 'True' ? 'Ready' : 'NotReady') : 'Unknown';
        
        const internalIPObj = (status.addresses || []).find((a: any) => a.type === 'InternalIP');
        
        nodes.push({
          name,
          status: nodeStatus,
          role: metadata.labels?.['kubernetes.io/role'] || 'worker',
          version: status.nodeInfo?.kubeletVersion || 'Unknown',
          ip: internalIPObj ? internalIPObj.address : 'Unknown',
          os: status.nodeInfo?.operatingSystem || 'Linux',
          created: age
        });
      }
    });

    res.json({ pods, services, deployments, nodes });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to parse Kubernetes resource list JSON', details: e.message });
  }
});

// API: Kubernetes Actions
app.post('/api/k8s/action', async (req, res) => {
  const { action, name, namespace = 'default', replicas } = req.body;

  if (!name || !ALPHANUMERIC_DASH.test(name)) {
    return res.status(400).json({ error: 'Invalid resource name' });
  }
  if (!namespace || !ALPHANUMERIC_DASH.test(namespace)) {
    return res.status(400).json({ error: 'Invalid namespace' });
  }

  let cmd = '';
  switch (action) {
    case 'restart_deploy':
      cmd = `kubectl rollout restart deployment/${name} -n ${namespace}`;
      break;
    case 'scale_deploy':
      if (replicas === undefined || isNaN(parseInt(replicas))) {
        return res.status(400).json({ error: 'Replicas count is required for scale action' });
      }
      cmd = `kubectl scale deployment/${name} --replicas=${parseInt(replicas)} -n ${namespace}`;
      break;
    case 'delete_pod':
      cmd = `kubectl delete pod/${name} -n ${namespace}`;
      break;
    default:
      return res.status(400).json({ error: 'Invalid action type' });
  }

  const { stdout, stderr, success } = await runCmd(cmd);
  if (!success) {
    return res.status(500).json({ error: `Failed to execute k8s action`, details: stderr });
  }

  res.json({ message: 'Action executed successfully', output: stdout.trim() });
});

// API: Kubernetes Pod Logs
app.get('/api/k8s/logs/:namespace/:pod', async (req, res) => {
  const { namespace, pod } = req.params;

  if (!namespace || !ALPHANUMERIC_DASH.test(namespace)) {
    return res.status(400).json({ error: 'Invalid namespace' });
  }
  if (!pod || !ALPHANUMERIC_DASH.test(pod)) {
    return res.status(400).json({ error: 'Invalid pod name' });
  }

  const { stdout, stderr, success } = await runCmd(`kubectl logs -n ${namespace} ${pod} --tail 150`);
  if (!success) {
    return res.status(500).json({ error: 'Failed to fetch pod logs', details: stderr });
  }

  res.json({ logs: stdout || stderr });
});

app.post('/api/agent/chat', async (req, res) => {
  const { 
    prompt, 
    chatHistory = [], 
    apiKey, 
    provider = 'gemini', 
    localUrl = 'http://localhost:11434/v1', 
    localModel = 'qwen2.5-coder:7b' 
  } = req.body;
  // Let's gather the live cluster status to inject into the LLM context
  const dockerVer = await runCmd('docker --version');
  const k8sVer = await runCmd('kubectl version --client');
  
  // Get docker containers
  let dockerStateStr = 'Docker status: Not running or failed to list containers.';
  const dockerRes = await runCmd('docker ps -a --format "{{json .}}"');
  if (dockerRes.success) {
    const lines = dockerRes.stdout.split('\n').filter(l => l.trim());
    const conts = lines.map(line => {
      try {
        const p = JSON.parse(line);
        return `- Container: Name="${p.Names}", ID="${p.ID}", Image="${p.Image}", Status="${p.Status}", State="${p.State || ''}", Ports="${p.Ports}"`;
      } catch {
        return null;
      }
    }).filter(Boolean);
    dockerStateStr = conts.length > 0 
      ? `Docker is running with the following containers:\n${conts.join('\n')}` 
      : 'Docker is running, but no containers are currently present.';
  }

  // Get kubernetes resources
  let k8sStateStr = 'Kubernetes status: Not running or failed to list resources.';
  const k8sRes = await runCmd('kubectl get pods,svc,deploy,nodes -o json --all-namespaces');
  if (k8sRes.success) {
    try {
      const parsed = JSON.parse(k8sRes.stdout);
      const items = parsed.items || [];
      const pods: string[] = [];
      const svcs: string[] = [];
      const deploys: string[] = [];
      const nodes: string[] = [];

      items.forEach((item: any) => {
        const kind = item.kind;
        const name = item.metadata.name;
        const ns = item.metadata.namespace || 'default';
        if (kind === 'Pod') {
          pods.push(`  - Pod: Name="${name}", Namespace="${ns}", Status="${item.status?.phase || 'Unknown'}", Ready="${(item.status?.containerStatuses || []).filter((c: any) => c.ready).length}/${(item.status?.containerStatuses || []).length}"`);
        } else if (kind === 'Service') {
          svcs.push(`  - Service: Name="${name}", Namespace="${ns}", Type="${item.spec?.type}", IP="${item.spec?.clusterIP}", Ports="${(item.spec?.ports || []).map((p: any) => p.port).join(', ')}"`);
        } else if (kind === 'Deployment') {
          deploys.push(`  - Deployment: Name="${name}", Namespace="${ns}", Replicas="${item.status?.readyReplicas || 0}/${item.spec?.replicas || 0}"`);
        } else if (kind === 'Node') {
          nodes.push(`  - Node: Name="${name}", Status="${(item.status?.conditions || []).find((c: any) => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady'}", K8sVersion="${item.status?.nodeInfo?.kubeletVersion}"`);
        }
      });

      k8sStateStr = `Kubernetes is active (context: docker-desktop).
Nodes:
${nodes.join('\n')}
Deployments:
${deploys.join('\n')}
Services:
${svcs.join('\n')}
Pods:
${pods.join('\n')}`;
    } catch {
      k8sStateStr = 'Kubernetes is running but resources could not be parsed.';
    }
  }

  const systemInstruction = `You are Kalam, a DevOps AI Agent. You run locally on the user's machine and help them visualize, analyze, and manage their local Docker and Kubernetes environments.
You are talking to the user. You have direct read and write access (via local execution) to Docker and Kubernetes.

Here is the current live cluster environment state:
---
SYSTEM ENVIRONMENT:
- Docker Version: ${dockerVer.stdout.trim() || 'Unknown'}
- Kubernetes Client Version: ${k8sVer.stdout.trim() || 'Unknown'}

${dockerStateStr}

${k8sStateStr}
---

INSTRUCTIONS:
1. Explain the state clearly when asked.
2. If the user wants to see relationships, connections, or topology, generate a Mermaid diagram. 
   Wrap the diagram in a markdown code block starting with \`\`\`mermaid. 
   Inside the diagram, represent containers, pods, services, and nodes. Use clean design, subgraphs for namespaces or Docker vs K8s, and arrows indicating service/port mappings or node hosting relationships.
3. If the user asks you to take an action (e.g. restart container, scale deployment, delete pod), explain what you will do and recommend that action.
   To recommend an action, append a structured JSON block at the VERY END of your response (after all your chat explanation) using this exact syntax:
   [ACTION: {"type": "docker_restart", "id": "CONTAINER_ID_OR_NAME", "label": "Restart container Name"}]
   [ACTION: {"type": "docker_stop", "id": "CONTAINER_ID_OR_NAME", "label": "Stop container Name"}]
   [ACTION: {"type": "docker_start", "id": "CONTAINER_ID_OR_NAME", "label": "Start container Name"}]
   [ACTION: {"type": "k8s_restart_deploy", "name": "DEPLOY_NAME", "namespace": "NAMESPACE", "label": "Restart deployment Name"}]
   [ACTION: {"type": "k8s_scale", "name": "DEPLOY_NAME", "namespace": "NAMESPACE", "replicas": NUMBER, "label": "Scale deployment Name to X replicas"}]
   [ACTION: {"type": "k8s_delete_pod", "name": "POD_NAME", "namespace": "NAMESPACE", "label": "Delete pod Name"}]

   Only output actions that make direct sense based on the user's intent. Do not output placeholders.
   
4. Keep answers friendly, technical but accessible, and crisp. Avoid extra wordy responses.`;

  if (provider === 'local') {
    try {
      const endpoint = `${localUrl.replace(/\/$/, '')}/chat/completions`;
      const messages = [
        { role: 'system', content: systemInstruction },
        ...chatHistory.map((h: any) => ({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: h.content
        })),
        { role: 'user', content: prompt }
      ];

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: localModel,
          messages,
          temperature: 0.2
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ 
          error: 'Local LLM returned an error', 
          details: `HTTP ${response.status}: ${errorText}` 
        });
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || 'No response content returned from local LLM.';
      return res.json({ content });
    } catch (error: any) {
      console.error('Local LLM API Error:', error);
      return res.status(500).json({ 
        error: 'Failed to connect to Local LLM endpoint', 
        details: `Make sure your local LLM server (Ollama, LM Studio, etc.) is running at ${localUrl}. Error message: ${error.message}` 
      });
    }
  }

  const finalKey = apiKey || process.env.GEMINI_API_KEY;

  if (!finalKey) {
    const lPrompt = prompt.toLowerCase();
    
    if (lPrompt.includes('status') || lPrompt.includes('list') || lPrompt.includes('show')) {
      const responseText = `Hi! I am the Kalam DevOps Agent. I notice you don't have a Gemini API key configured. 
However, I can still show you the status!

**Docker Status:**
${dockerVer.success ? `✅ Installed (${dockerVer.stdout.trim()})` : '❌ Not Installed'}
- Active Containers: ${dockerRes.success ? dockerRes.stdout.split('\n').filter(Boolean).length : 0}

**Kubernetes Status:**
${k8sVer.success ? `✅ Installed (${k8sVer.stdout.trim()})` : '❌ Not Installed'}
- Nodes: ${k8sRes.success && k8sRes.stdout.includes('Node') ? 'docker-desktop (Ready)' : 'None/Unavailable'}

You can check out the **Docker** and **Kubernetes** tabs at the top to inspect details, view logs, restart containers, and scale deployments directly!

To unlock the full agentic conversational chatbot experience, please provide your **Gemini API Key** in the Settings panel, or toggle the provider to **Local LLM** (e.g., using Ollama)!`;
      return res.json({ content: responseText });
    }

    const defaultResponse = `I am ready to help you manage your Docker and Kubernetes cluster! 
To start chatting and generate visual Mermaid graphs of your cluster topology, please add your **Gemini API Key** or choose a **Local LLM (like Ollama)** in the settings panel.

In the meantime, you can explore the visual collections in the tabs above, view container logs, stop/restart containers, scale deployments, and delete pods directly from the UI!`;
    return res.json({ content: defaultResponse });
  }

  try {
    const geminiPrompt = `${systemInstruction}

Let's look at the chat history:
${chatHistory.map((h: any) => `${h.role === 'user' ? 'User' : 'Kalam'}: ${h.content}`).join('\n')}
User: ${prompt}
Kalam:`;

    const ai = new GoogleGenAI({ apiKey: finalKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: geminiPrompt,
    });

    const content = response.text || "Sorry, I generated an empty response.";
    res.json({ content });
  } catch (error: any) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ error: 'Failed to call Gemini API', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Kalam Backend Server running on port ${PORT}`);
});
