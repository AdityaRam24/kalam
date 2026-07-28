import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Terminal, 
  Layers, 
  Database, 
  Server, 
  RefreshCw, 
  Play, 
  Square, 
  Trash2, 
  AlertCircle, 
  FileText, 
  ChevronRight, 
  ChevronLeft,
  ChevronDown, 
  Sliders, 
  MessageSquare,
  Eye,
  EyeOff,
  ShieldAlert,
  Info,
  Cpu,
  Search,
  X,
  Activity,
  Sparkles,
  HardDrive,
  Sun,
  Moon,
  Network
} from 'lucide-react';
import TopologyGraph from './components/TopologyGraph';
import AgentTeamwork from './components/AgentTeamwork';
import HPEAgentChat from './components/HPEAgentChat';
import PcaiAssistant from './components/PcaiAssistant';
import ModelPicker from './components/ModelPicker';
import PcaiStackView from './components/PcaiStackView';
import VmMonitor from './components/VmMonitor';
import KubectlCheatSheet from './components/KubectlCheatSheet';

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
}

interface Pod {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  ip: string;
  node: string;
  restarts: number;
  containers: Array<{ name: string; ready: boolean; state: string }>;
  created: string;
}

interface Service {
  name: string;
  namespace: string;
  type: string;
  clusterIp: string;
  externalIp: string;
  ports: string;
  selector: string;
  created: string;
}

interface Deployment {
  name: string;
  namespace: string;
  ready: string;
  available: number;
  updated: number;
  replicas: number;
  created: string;
}

interface NodeResource {
  name: string;
  status: string;
  role: string;
  version: string;
  ip: string;
  os: string;
  gpus?: string;
  created: string;
}

interface K8sResources {
  pods: Pod[];
  services: Service[];
  deployments: Deployment[];
  nodes: NodeResource[];
}

interface SystemStatus {
  docker: { installed: boolean; version: string; running: boolean };
  kubernetes: { installed: boolean; version: string; running: boolean; context: string };
}

interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  actions?: Array<{
    type: string;
    id?: string;
    name?: string;
    namespace?: string;
    replicas?: number;
    label: string;
  }>;
  actionStatuses?: Record<string, { status: 'idle' | 'running' | 'success' | 'error'; output?: string }>;
}

export function App() {
  // Tabs & Config
  const [activeTab, setActiveTab] = useState<'dashboard' | 'pcaistack' | 'docker' | 'k8s' | 'vms' | 'chat' | 'security' | 'agents' | 'pcai' | 'cheatsheet'>('dashboard');
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('kalam_gemini_api_key') || '');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [provider, setProvider] = useState<'gemini' | 'local' | 'custom'>(() => (localStorage.getItem('kalam_llm_provider') as 'gemini' | 'local' | 'custom') || 'gemini');
  const [localUrl, setLocalUrl] = useState<string>(() => localStorage.getItem('kalam_local_url') || 'http://localhost:11434/v1');
  const [localModel, setLocalModel] = useState<string>(() => localStorage.getItem('kalam_local_model') || 'qwen2.5-coder:7b');
  const [embedModel, setEmbedModel] = useState<string>(() => localStorage.getItem('kalam_local_embed_model') || 'nomic-embed-text');
  // Custom OpenAI-compatible model endpoint (e.g. HPE MLIS, vLLM, OpenAI)
  const [customUrl, setCustomUrl] = useState<string>(() => localStorage.getItem('kalam_custom_url') || '');
  const [customModel, setCustomModel] = useState<string>(() => localStorage.getItem('kalam_custom_model') || '');
  const [customKey, setCustomKey] = useState<string>(() => localStorage.getItem('kalam_custom_key') || '');
  const [showCustomKey, setShowCustomKey] = useState<boolean>(false);
  // Model discovery for the custom endpoint (works with any OpenAI-compatible API)
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customDetectMsg, setCustomDetectMsg] = useState<string>('');
  const detectCustomModels = async () => {
    if (!customUrl.trim()) { setCustomDetectMsg('Enter the endpoint base URL first.'); return; }
    setCustomDetectMsg('Detecting…');
    setCustomModels([]);
    try {
      const q = new URLSearchParams({ localUrl: customUrl.trim() });
      if (customKey.trim()) q.set('authKey', customKey.trim());
      const res = await fetch(`/api/llm/models?${q.toString()}`);
      const data = await res.json();
      if (!data.endpointUp) { setCustomDetectMsg('Endpoint not reachable (check the URL and API key).'); return; }
      const names = (data.chatModels || data.models || []).map((m: any) => m.name).filter(Boolean);
      setCustomModels(names);
      setCustomDetectMsg(names.length ? `${names.length} model(s) found — click one to select it.` : 'Endpoint is up, but it lists no models. Type the model name manually.');
    } catch (e: any) {
      setCustomDetectMsg(`Detection failed: ${e.message}`);
    }
  };
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('kalam_theme') as 'light' | 'dark') || 'light');
  const [globalSearch, setGlobalSearch] = useState<string>('');
  const [dockerFilter, setDockerFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [k8sSubTab, setK8sSubTab] = useState<'all' | 'nodes' | 'pods' | 'deployments' | 'services'>('all');
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [status, setStatus] = useState<SystemStatus>({
    docker: { installed: false, version: '', running: false },
    kubernetes: { installed: false, version: '', running: false, context: '' }
  });

  // Security states
  const [securityTarget, setSecurityTarget] = useState<string>('');
  const [scanLoading, setScanLoading] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<{
    imageName: string;
    isMock: boolean;
    summary: { critical: number; high: number; medium: number; low: number };
    vulnerabilities: Array<{ cve: string; package: string; severity: string; desc: string }>;
    recommendation: string;
    fixAction: { type: string; targetImage: string; desc: string } | null;
  } | null>(null);
  const [fixExecuting, setFixExecuting] = useState<boolean>(false);
  const [fixOutput, setFixOutput] = useState<string | null>(null);

  // Resources Data
  const [dockerContainers, setDockerContainers] = useState<Container[]>([]);
  const [k8sResources, setK8sResources] = useState<K8sResources>({
    pods: [],
    services: [],
    deployments: [],
    nodes: []
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Expanded Sections for K8s List
  const [expandedK8s, setExpandedK8s] = useState<Record<string, boolean>>({
    nodes: true,
    deployments: true,
    services: true,
    pods: true
  });

  // Modals (Logs & Scale)
  const [logsModal, setLogsModal] = useState<{
    open: boolean;
    type: 'docker' | 'k8s';
    id: string;
    name: string;
    namespace?: string;
  } | null>(null);
  const [logs, setLogs] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [scaleModal, setScaleModal] = useState<{
    open: boolean;
    name: string;
    namespace: string;
    currentReplicas: number;
    value: number;
  } | null>(null);

  // Chat/Agent
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem('kalam_chat_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((m: any) => ({
            ...m,
            timestamp: m.timestamp ? new Date(m.timestamp) : new Date()
          }));
        }
      } catch (e) {
        console.error('Failed to parse saved chat history:', e);
      }
    }
    return [
      {
        role: 'agent',
        content: `Hello! I am **Kalam**, your local DevOps agent. 
I have scanned your local workspace. I can see your running Docker containers and Kubernetes clusters.

I can help you:
1. Explain the state of your clusters and individual resources.
2. Render visual graphs of relationships between containers, nodes, and pods.
3. Automatically execute actions like restarting containers, scaling deployments, or viewing logs upon your approval.

Please configure your agent (Gemini Cloud or Local LLM like Ollama) in the settings panel by clicking the Sliders icon in the top header. Otherwise, you can still view your resources in the tabs above and use standard controls!`,
        timestamp: new Date()
      }
    ];
  });
  const [chatInput, setChatInput] = useState<string>('');
  const [chatLoading, setChatLoading] = useState<boolean>(false);
  
  // Interactive Diagram State
  const [agentMermaidChart, setAgentMermaidChart] = useState<string>(() => localStorage.getItem('kalam_agent_mermaid_chart') || '');

  // Persist chat and diagram state
  useEffect(() => {
    localStorage.setItem('kalam_chat_history', JSON.stringify(chatHistory));
  }, [chatHistory]);

  useEffect(() => {
    localStorage.setItem('kalam_agent_mermaid_chart', agentMermaidChart);
  }, [agentMermaidChart]);

  // Apply & persist theme (light default / refined dark)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('kalam_theme', theme);
  }, [theme]);

  // Floating Hover State for Node Tooltips
  const [hoveredNode, setHoveredNode] = useState<{
    key: string;
    x: number;
    y: number;
    resource: {
      title: string;
      type: string;
      status: 'success' | 'warning' | 'error' | 'neutral';
      statusLabel: string;
      details: Record<string, string | number>;
    } | null;
  } | null>(null);

  const handleNodeHover = (nodeKey: string | null, clientX: number, clientY: number) => {
    if (!nodeKey) {
      setHoveredNode(null);
      return;
    }

    let type: 'docker' | 'pod' | 'svc' | 'deploy' | 'node' | null = null;
    let matchKey = '';

    if (nodeKey.startsWith('text_')) {
      const label = nodeKey.replace('text_', '').toLowerCase();
      
      const dockerMatch = dockerContainers.find(c => 
        label.includes(c.name.toLowerCase()) || 
        c.name.toLowerCase().includes(label) || 
        label.includes(c.id.slice(0, 8).toLowerCase())
      );
      if (dockerMatch) {
        type = 'docker';
        matchKey = dockerMatch.id;
      } else {
        const podMatch = k8sResources.pods.find(p => 
          label.includes(p.name.toLowerCase()) || 
          p.name.toLowerCase().includes(label)
        );
        if (podMatch) {
          type = 'pod';
          matchKey = podMatch.name;
        } else {
          const svcMatch = k8sResources.services.find(s => 
            label.includes(s.name.toLowerCase()) || 
            s.name.toLowerCase().includes(label)
          );
          if (svcMatch) {
            type = 'svc';
            matchKey = svcMatch.name;
          } else {
            const deployMatch = k8sResources.deployments.find(d => 
              label.includes(d.name.toLowerCase()) || 
              d.name.toLowerCase().includes(label)
            );
            if (deployMatch) {
              type = 'deploy';
              matchKey = deployMatch.name;
            } else {
              const nodeMatch = k8sResources.nodes.find(n => 
                label.includes(n.name.toLowerCase()) || 
                n.name.toLowerCase().includes(label)
              );
              if (nodeMatch) {
                type = 'node';
                matchKey = nodeMatch.name;
              }
            }
          }
        }
      }
    } else {
      const match = nodeKey.match(/(docker|pod|svc|deploy|node)_([a-zA-Z0-9_.-]+)/);
      if (match) {
        type = match[1] as any;
        const rawKey = match[2];
        
        if (type === 'docker') {
          const c = dockerContainers.find(item => item.id.startsWith(rawKey) || item.name.replace(/[^a-zA-Z0-9]/g, '_') === rawKey);
          if (c) matchKey = c.id;
        } else {
          if (type === 'pod') {
            const p = k8sResources.pods.find(item => item.name.replace(/[^a-zA-Z0-9]/g, '_').includes(rawKey) || rawKey.includes(item.name.replace(/[^a-zA-Z0-9]/g, '_')));
            if (p) matchKey = p.name;
          } else if (type === 'svc') {
            const s = k8sResources.services.find(item => item.name.replace(/[^a-zA-Z0-9]/g, '_').includes(rawKey) || rawKey.includes(item.name.replace(/[^a-zA-Z0-9]/g, '_')));
            if (s) matchKey = s.name;
          } else if (type === 'deploy') {
            const d = k8sResources.deployments.find(item => item.name.replace(/[^a-zA-Z0-9]/g, '_').includes(rawKey) || rawKey.includes(item.name.replace(/[^a-zA-Z0-9]/g, '_')));
            if (d) matchKey = d.name;
          } else if (type === 'node') {
            const n = k8sResources.nodes.find(item => item.name.replace(/[^a-zA-Z0-9]/g, '_').includes(rawKey) || rawKey.includes(item.name.replace(/[^a-zA-Z0-9]/g, '_')));
            if (n) matchKey = n.name;
          }
        }
      }
    }

    if (!type || !matchKey) {
      setHoveredNode({
        key: nodeKey,
        x: clientX,
        y: clientY,
        resource: null
      });
      return;
    }

    let title = '';
    let status: 'success' | 'warning' | 'error' | 'neutral' = 'neutral';
    let statusLabel = '';
    const details: Record<string, string | number> = {};

    if (type === 'docker') {
      const c = dockerContainers.find(item => item.id === matchKey);
      if (c) {
        title = c.name;
        status = c.state === 'running' ? 'success' : 'error';
        statusLabel = c.state.toUpperCase();
        details['Image'] = c.image.split('@')[0];
        details['Container ID'] = c.id.slice(0, 12);
        details['Mapped Ports'] = c.ports || 'None';
        details['Status'] = c.status;
        details['Created'] = c.created;
      }
    } else if (type === 'pod') {
      const p = k8sResources.pods.find(item => item.name === matchKey);
      if (p) {
        title = p.name;
        status = p.status === 'Running' ? 'success' : p.status === 'Pending' ? 'warning' : 'error';
        statusLabel = p.status;
        details['Namespace'] = p.namespace;
        details['Ready Containers'] = p.ready;
        details['Pod IP'] = p.ip;
        details['Scheduled Node'] = p.node;
        details['Restarts'] = p.restarts;
      }
    } else if (type === 'svc') {
      const s = k8sResources.services.find(item => item.name === matchKey);
      if (s) {
        title = s.name;
        status = 'neutral';
        statusLabel = 'SERVICE';
        details['Namespace'] = s.namespace;
        details['Type'] = s.type;
        details['Cluster IP'] = s.clusterIp;
        details['Ports'] = s.ports;
      }
    } else if (type === 'deploy') {
      const d = k8sResources.deployments.find(item => item.name === matchKey);
      if (d) {
        title = d.name;
        const parts = d.ready.split('/');
        const isHealthy = parts[0] === parts[1] && parts[0] !== '0';
        status = isHealthy ? 'success' : 'error';
        statusLabel = `DEPLOY: ${d.ready}`;
        details['Namespace'] = d.namespace;
        details['Available Replicas'] = d.available;
      }
    } else if (type === 'node') {
      const n = k8sResources.nodes.find(item => item.name === matchKey);
      if (n) {
        title = n.name;
        status = n.status === 'Ready' ? 'success' : 'error';
        statusLabel = `NODE: ${n.status}`;
        details['Role'] = n.role;
        details['IP Address'] = n.ip;
        details['Kube Version'] = n.version;
      }
    }

    setHoveredNode({
      key: nodeKey,
      x: clientX,
      y: clientY,
      resource: {
        title,
        type: type.toUpperCase(),
        status,
        statusLabel,
        details
      }
    });
  };

  const chatEndRef = useRef<HTMLDivElement>(null);
  const hasDataRef = useRef<boolean>(false);

  const handleScanImage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!securityTarget) return;
    
    const container = dockerContainers.find(c => c.id === securityTarget);
    if (!container) return;

    setScanLoading(true);
    setScanResult(null);
    setFixOutput(null);
    try {
      const res = await fetch('/api/docker/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageName: container.image })
      });
      const data = await res.json();
      if (res.ok) {
        setScanResult(data);
      } else {
        alert(`Scan failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      alert(`Network error: ${err.message}`);
    } finally {
      setScanLoading(false);
    }
  };

  const handleApplySecurityFix = async () => {
    if (!scanResult || !scanResult.fixAction || !securityTarget) return;
    if (!confirm(`Are you sure you want to apply the security fix? This will stop and recreate the container using ${scanResult.fixAction.targetImage}.`)) return;

    setFixExecuting(true);
    setFixOutput(null);
    try {
      const res = await fetch('/api/docker/apply-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          containerId: securityTarget,
          targetImage: scanResult.fixAction.targetImage
        })
      });
      const data = await res.json();
      if (res.ok) {
        setFixOutput(`[OK] ${data.message}\nCommand executed: ${data.cmdRun}\nNew Container ID: ${data.newContainerId}`);
        fetchClusterState();
      } else {
        setFixOutput(`[FAIL] Upgrade failed: ${data.error}\nDetails: ${data.details || ''}`);
      }
    } catch (err: any) {
      setFixOutput(`[FAIL] Network error: ${err.message}`);
    } finally {
      setFixExecuting(false);
    }
  };

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, chatLoading]);

  // Fetch initial cluster state
  const fetchClusterState = async () => {
    if (!hasDataRef.current) {
      setLoading(true);
    }
    setErrorMsg(null);
    try {
      // Get Status. A network/proxy failure here means the BACKEND is down
      // (not Docker/K8s) — surface that distinctly so it's actionable.
      let statusRes: Response;
      try {
        statusRes = await fetch('/api/status');
      } catch {
        throw new Error('BACKEND_DOWN');
      }
      if (!statusRes.ok) throw new Error('BACKEND_DOWN');
      const statusData = await statusRes.json();
      setStatus(statusData);

      // Get Docker list
      if (statusData.docker.running) {
        const dockerRes = await fetch('/api/docker/containers');
        const dockerData = await dockerRes.json();
        setDockerContainers(dockerData);
      } else {
        setDockerContainers([]);
      }

      // Get K8s list
      if (statusData.kubernetes.running) {
        const k8sRes = await fetch('/api/k8s/resources');
        const k8sData = await k8sRes.json();
        setK8sResources(k8sData);
      } else {
        setK8sResources({ pods: [], services: [], deployments: [], nodes: [] });
      }
    } catch (err: any) {
      console.error(err);
      if (err?.message === 'BACKEND_DOWN') {
        setErrorMsg('Backend server not reachable on port 3001. Start it with "npm run dev" (or "npm run server"). If it keeps dying, a leftover process may be holding the port — stop it and restart.');
      } else {
        setErrorMsg('Failed to query cluster resource states. Make sure Docker Desktop and/or Kubernetes are active.');
      }
    } finally {
      setLoading(false);
      hasDataRef.current = true;
    }
  };

  useEffect(() => {
    fetchClusterState();
    if (!autoRefresh) return;
    const interval = setInterval(fetchClusterState, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Save API Key
  const handleSaveApiKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem('kalam_gemini_api_key', key);
  };

  // Fetch Logs
  const fetchLogs = async (type: 'docker' | 'k8s', id: string, namespace?: string) => {
    setLogsLoading(true);
    setLogs('');
    try {
      const url = type === 'docker' 
        ? `/api/docker/logs/${id}`
        : `/api/k8s/logs/${namespace}/${id}`;
      
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) {
        setLogs(data.logs || 'No logs generated.');
      } else {
        setLogs(`Error: ${data.error || 'Failed to fetch logs'}\nDetails: ${data.details || ''}`);
      }
    } catch (e: any) {
      setLogs(`Error: Failed to connect to server backend.\n${e.message}`);
    } finally {
      setLogsLoading(false);
    }
  };

  // Open log viewer modal
  const openLogsModal = (type: 'docker' | 'k8s', id: string, name: string, namespace?: string) => {
    setLogsModal({ open: true, type, id, name, namespace });
    fetchLogs(type, id, namespace);
  };

  // Trigger container actions
  const triggerDockerAction = async (action: 'start' | 'stop' | 'restart' | 'remove', id: string) => {
    if (!confirm(`Are you sure you want to ${action} container ${id}?`)) return;
    setLoading(true);
    try {
      const res = await fetch('/api/docker/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, containerId: id })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Failed: ${data.error || 'Action failed'}`);
      }
    } catch (e: any) {
      alert(`Network error: ${e.message}`);
    } finally {
      fetchClusterState();
    }
  };

  // Trigger Kubernetes actions
  const triggerK8sAction = async (action: 'restart_deploy' | 'scale_deploy' | 'delete_pod', name: string, namespace: string, replicas?: number) => {
    setLoading(true);
    try {
      const res = await fetch('/api/k8s/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name, namespace, replicas })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Failed: ${data.error || 'Action failed'}`);
      }
    } catch (e: any) {
      alert(`Network error: ${e.message}`);
    } finally {
      fetchClusterState();
    }
  };

  // Chat message submission
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const userPrompt = chatInput;
    setChatInput('');
    setChatLoading(true);

    // Append user message
    const userMsg: ChatMessage = {
      role: 'user',
      content: userPrompt,
      timestamp: new Date()
    };
    setChatHistory(prev => [...prev, userMsg]);

    try {
      // Call backend agent api
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userPrompt,
          chatHistory: chatHistory.map(h => ({ role: h.role, content: h.content })),
          apiKey: apiKey,
          provider: effProvider,
          localUrl: effLocalUrl,
          localModel: effLocalModel,
          authKey: effAuthKey
        })
      });

      const data = await response.json();
      if (!response.ok) {
        const errorMsg: ChatMessage = {
          role: 'agent',
          content: `**Error talking to backend:** ${data.error || 'Unknown error occurred'}\n\n*Details: ${data.details || 'Check console logs.'}*`,
          timestamp: new Date()
        };
        setChatHistory(prev => [...prev, errorMsg]);
        return;
      }

      // Parse the response to extract Actions and Mermaid diagrams
      let text = data.content;
      
      // Extract [ACTION: {...}] definitions
      const actions: any[] = [];
      const actionRegex = /\[ACTION:\s*({.*?})\]/g;
      let match;
      while ((match = actionRegex.exec(text)) !== null) {
        try {
          actions.push(JSON.parse(match[1]));
        } catch (err) {
          console.error('Failed to parse action json:', match[1], err);
        }
      }
      
      // Strip actions from text display
      text = text.replace(actionRegex, '').trim();

      // Extract Mermaid block
      const mermaidRegex = /```mermaid([\s\S]*?)```/g;
      const mermaidMatch = mermaidRegex.exec(text);
      if (mermaidMatch) {
        const diagramCode = mermaidMatch[1].trim();
        setAgentMermaidChart(diagramCode);
      }

      // Set initial state for actions statuses
      const actionStatuses: Record<string, { status: 'idle' | 'running' | 'success' | 'error'; output?: string }> = {};
      actions.forEach((_, idx) => {
        actionStatuses[`act-${idx}`] = { status: 'idle' };
      });

      const agentMsg: ChatMessage = {
        role: 'agent',
        content: text,
        timestamp: new Date(),
        actions: actions.length > 0 ? actions : undefined,
        actionStatuses: actions.length > 0 ? actionStatuses : undefined
      };

      setChatHistory(prev => [...prev, agentMsg]);
    } catch (e: any) {
      const errorMsg: ChatMessage = {
        role: 'agent',
        content: `**Failed to send message:** Network error. Make sure your server is running.\n\n*Details: ${e.message}*`,
        timestamp: new Date()
      };
      setChatHistory(prev => [...prev, errorMsg]);
    } finally {
      setChatLoading(false);
    }
  };

  // Run action recommended in chat
  const handleExecuteAgentAction = async (msgIndex: number, actionIndex: number, action: any) => {
    const actKey = `act-${actionIndex}`;
    
    // Update state to running
    setChatHistory(prev => {
      const copy = [...prev];
      const msg = copy[msgIndex];
      if (msg.actionStatuses) {
        msg.actionStatuses[actKey] = { status: 'running' };
      }
      return copy;
    });

    try {
      let url = '';
      let body: any = {};

      if (action.type.startsWith('docker_')) {
        url = '/api/docker/action';
        // Map type (e.g. docker_restart) to action string (e.g. restart)
        const actStr = action.type.replace('docker_', '');
        body = { action: actStr, containerId: action.id };
      } else if (action.type.startsWith('k8s_')) {
        url = '/api/k8s/action';
        // Map type (e.g. k8s_restart_deploy) to action string (e.g. restart_deploy)
        const actStr = action.type.replace('k8s_', '');
        body = { 
          action: actStr, 
          name: action.name, 
          namespace: action.namespace,
          replicas: action.replicas 
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      
      setChatHistory(prev => {
        const copy = [...prev];
        const msg = copy[msgIndex];
        if (msg.actionStatuses) {
          if (res.ok) {
            msg.actionStatuses[actKey] = { 
              status: 'success', 
              output: data.message || 'Action executed successfully.' 
            };
          } else {
            msg.actionStatuses[actKey] = { 
              status: 'error', 
              output: data.error || 'Action execution failed.' 
            };
          }
        }
        return copy;
      });

      // Refresh resource list
      fetchClusterState();
    } catch (e: any) {
      setChatHistory(prev => {
        const copy = [...prev];
        const msg = copy[msgIndex];
        if (msg.actionStatuses) {
          msg.actionStatuses[actKey] = { 
            status: 'error', 
            output: `Network error: ${e.message}` 
          };
        }
        return copy;
      });
    }
  };



  // Memoized Search & Filter Functions
  const filteredDockerContainers = useMemo(() => {
    return dockerContainers.filter(c => {
      const matchesSearch = !globalSearch || 
        c.name.toLowerCase().includes(globalSearch.toLowerCase()) || 
        c.image.toLowerCase().includes(globalSearch.toLowerCase()) ||
        c.id.toLowerCase().includes(globalSearch.toLowerCase());
      
      const matchesFilter = dockerFilter === 'all' || 
        (dockerFilter === 'running' && c.state === 'running') ||
        (dockerFilter === 'stopped' && c.state !== 'running');

      return matchesSearch && matchesFilter;
    });
  }, [dockerContainers, globalSearch, dockerFilter]);

  const filteredK8sPods = useMemo(() => {
    return k8sResources.pods.filter(p => {
      return !globalSearch || 
        p.name.toLowerCase().includes(globalSearch.toLowerCase()) ||
        p.namespace.toLowerCase().includes(globalSearch.toLowerCase()) ||
        (p.node && p.node.toLowerCase().includes(globalSearch.toLowerCase()));
    });
  }, [k8sResources.pods, globalSearch]);

  const filteredK8sNodes = useMemo(() => {
    return k8sResources.nodes.filter(n => {
      return !globalSearch || 
        n.name.toLowerCase().includes(globalSearch.toLowerCase()) ||
        (n.role && n.role.toLowerCase().includes(globalSearch.toLowerCase()));
    });
  }, [k8sResources.nodes, globalSearch]);

  const filteredK8sDeployments = useMemo(() => {
    return k8sResources.deployments.filter(d => {
      return !globalSearch || 
        d.name.toLowerCase().includes(globalSearch.toLowerCase()) ||
        d.namespace.toLowerCase().includes(globalSearch.toLowerCase());
    });
  }, [k8sResources.deployments, globalSearch]);

  const filteredK8sServices = useMemo(() => {
    return k8sResources.services.filter(s => {
      return !globalSearch || 
        s.name.toLowerCase().includes(globalSearch.toLowerCase()) ||
        s.namespace.toLowerCase().includes(globalSearch.toLowerCase()) ||
        (s.type && s.type.toLowerCase().includes(globalSearch.toLowerCase()));
    });
  }, [k8sResources.services, globalSearch]);

  // Effective LLM params sent to the backend. A "custom" endpoint is an
  // OpenAI-compatible model server (HPE MLIS / vLLM / OpenAI), so it rides the
  // same "local" path but with its own URL/model and a Bearer auth key.
  const effProvider: 'gemini' | 'local' = provider === 'gemini' ? 'gemini' : 'local';
  const effLocalUrl = provider === 'custom' ? customUrl : localUrl;
  const effLocalModel = provider === 'custom' ? customModel : localModel;
  const effAuthKey = provider === 'custom' ? customKey : undefined;
  const llmParams = { provider: effProvider, apiKey, localUrl: effLocalUrl, localModel: effLocalModel, authKey: effAuthKey };
  const providerLabel = provider === 'gemini' ? 'Gemini' : provider === 'custom' ? (customModel || 'Endpoint') : localModel;

  return (
    <div className="app-shell">
      {/* Enterprise Left Sidebar */}
      <aside className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <a href="#" className="sidebar-brand" onClick={(e) => { e.preventDefault(); setActiveTab('dashboard'); }}>
            <div className="brand-logo-icon" title="Hewlett Packard Enterprise">HPE</div>
            <div className="brand-info">
              <h1><span className="hpe-text">HPE</span> Kalam</h1>
              <span className="sub-text">GreenLake Console</span>
            </div>
          </a>
          <button 
            className="sidebar-toggle-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group">
            <span className="nav-group-label">Core Workspace</span>
            <button 
              className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <span className="nav-item-icon"><Layers size={18} /></span>
              <span className="nav-item-text">Dashboard</span>
              <span className="nav-item-badge">Overview</span>
            </button>
          </div>

          <div className="nav-group">
            <span className="nav-group-label">Infrastructure</span>
            <button 
              className={`nav-item ${activeTab === 'docker' ? 'active' : ''}`}
              onClick={() => setActiveTab('docker')}
              disabled={!status.docker.installed}
            >
              <span className="nav-item-icon"><Database size={18} /></span>
              <span className="nav-item-text">Docker Engine</span>
              <span className="nav-item-badge">{dockerContainers.length}</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'k8s' ? 'active' : ''}`}
              onClick={() => setActiveTab('k8s')}
              disabled={!status.kubernetes.installed}
            >
              <span className="nav-item-icon"><Server size={18} /></span>
              <span className="nav-item-text">Kubernetes</span>
              <span className="nav-item-badge">{k8sResources.pods.length}</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'vms' ? 'active' : ''}`}
              onClick={() => setActiveTab('vms')}
            >
              <span className="nav-item-icon"><HardDrive size={18} /></span>
              <span className="nav-item-text">Virtual Machines</span>
              <span className="nav-item-badge">SSH</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'cheatsheet' ? 'active' : ''}`}
              onClick={() => setActiveTab('cheatsheet')}
            >
              <span className="nav-item-icon"><Terminal size={18} /></span>
              <span className="nav-item-text">Kubectl Cheat Sheet</span>
              <span className="nav-item-badge">CLI</span>
            </button>
          </div>

          <div className="nav-group">
            <span className="nav-group-label">HPE Private Cloud AI</span>
            <button
              className={`nav-item ${activeTab === 'pcaistack' ? 'active' : ''}`}
              onClick={() => setActiveTab('pcaistack')}
            >
              <span className="nav-item-icon"><Network size={18} /></span>
              <span className="nav-item-text">PCAI Stack</span>
              <span className="nav-item-badge">Map</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'chat' ? 'active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              <span className="nav-item-icon"><MessageSquare size={18} /></span>
              <span className="nav-item-text">Agent Chat</span>
              <span className="nav-item-badge">{provider === 'gemini' ? 'Gemini' : provider === 'custom' ? 'Endpoint' : 'Local'}</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'agents' ? 'active' : ''}`}
              onClick={() => setActiveTab('agents')}
            >
              <span className="nav-item-icon"><Cpu size={18} /></span>
              <span className="nav-item-text">Agent Teamwork</span>
              <span className="nav-item-badge">Swarm</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'pcai' ? 'active' : ''}`}
              onClick={() => setActiveTab('pcai')}
            >
              <span className="nav-item-icon"><Info size={18} /></span>
              <span className="nav-item-text">PCAI Assistant</span>
              <span className="nav-item-badge">HPE AI</span>
            </button>
          </div>

          <div className="nav-group">
            <span className="nav-group-label">Security & Audit</span>
            <button 
              className={`nav-item ${activeTab === 'security' ? 'active' : ''}`}
              onClick={() => setActiveTab('security')}
            >
              <span className="nav-item-icon"><ShieldAlert size={18} /></span>
              <span className="nav-item-text">Image Hardener</span>
              <span className="nav-item-badge">CVE</span>
            </button>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="status-summary-box">
            <div className="status-indicator-row">
              <div className={`status-dot-pill ${status.docker.running ? 'online' : 'offline'}`}>
                <span className="dot"></span>
                <span>Docker</span>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {status.docker.running ? 'Active' : 'Down'}
              </span>
            </div>
            <div className="status-indicator-row">
              <div className={`status-dot-pill ${status.kubernetes.running ? 'online' : 'offline'}`}>
                <span className="dot"></span>
                <span>Kubernetes</span>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {status.kubernetes.running ? 'Active' : 'Down'}
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Area */}
      <div className="app-main">
        {/* Top Command Bar */}
        <header className="app-topbar">
          <div className="topbar-left">
            <div className="page-title-badge">
              <h2>
                {activeTab === 'dashboard' && 'Dashboard & Topology Overview'}
                {activeTab === 'pcaistack' && 'HPE Private Cloud AI — Stack Visualizer'}
                {activeTab === 'docker' && 'Docker Container Operations'}
                {activeTab === 'k8s' && 'Kubernetes Cluster Management'}
                {activeTab === 'vms' && 'Virtual Machine Monitoring & SSH'}
                {activeTab === 'chat' && 'Kalam Agentic DevOps Assistant'}
                {activeTab === 'security' && 'Container Security & CVE Patching'}
                {activeTab === 'agents' && 'Multi-Agent Swarm Visualizer'}
                {activeTab === 'pcai' && 'HPE Private Cloud AI Assistant'}
                {activeTab === 'cheatsheet' && 'Kubectl Reference Guide & Tools'}
              </h2>
            </div>

            {/* Global Search Bar */}
            <div className="global-search-container">
              <Search size={15} style={{ color: 'var(--text-muted)' }} />
              <input 
                type="text"
                className="global-search-input"
                placeholder="Search containers, pods, nodes..."
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
              />
              {globalSearch ? (
                <X size={14} style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setGlobalSearch('')} />
              ) : (
                <span className="search-shortcut-pill">Ctrl K</span>
              )}
            </div>
          </div>

          <div className="topbar-right">
            {/* HPE GreenLake Tenant & SLA Badges */}
            <div className="cluster-kpi-pill" title="HPE Tenant" style={{ borderColor: 'var(--hpe-green-border)', background: 'rgba(1, 167, 129, 0.06)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--hpe-green)' }}></span>
              <span style={{ fontSize: '11px', color: 'var(--hpe-green)' }}>Tenant: <strong>HPE-PROD-EAST-01</strong></span>
            </div>

            <div className="cluster-kpi-pill" title="Containers">
              <Database size={13} style={{ color: 'var(--hpe-green)' }} />
              <span>Containers: <strong>{dockerContainers.length}</strong></span>
            </div>
            <div className="cluster-kpi-pill" title="Pods">
              <Server size={13} style={{ color: 'var(--hpe-blue)' }} />
              <span>Pods: <strong>{k8sResources.pods.length}</strong></span>
            </div>

            {/* Auto Refresh Toggle */}
            <button 
              className={`icon-btn ${autoRefresh ? 'success' : ''}`}
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={autoRefresh ? "Auto-Refresh Enabled (Every 10s)" : "Auto-Refresh Paused"}
              style={{ padding: '6px 10px', gap: '6px', fontSize: '12px' }}
            >
              <Activity size={13} className={autoRefresh ? 'loader' : ''} />
              <span style={{ fontSize: '12px' }}>{autoRefresh ? 'Live Sync' : 'Paused'}</span>
            </button>

            {/* Manual Refresh */}
            <button 
              className="icon-btn success"
              onClick={fetchClusterState} 
              title="Refresh State"
              disabled={loading}
            >
              <RefreshCw size={15} className={loading ? 'loader' : ''} />
            </button>

            {/* Provider Pill */}
            <span className="badge running" style={{ fontSize: '11px', padding: '6px 10px' }}>
              HPE AI: {providerLabel}
            </span>

            {/* Theme Toggle */}
            <button
              type="button"
              className="theme-toggle-btn"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              aria-label="Toggle color theme"
            >
              {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
            </button>

            {/* Settings Trigger */}
            <button
              type="button"
              className="icon-btn primary"
              onClick={() => setSettingsModalOpen(true)}
              title="Configure Agent Settings"
              style={{ padding: '8px' }}
            >
              <Sliders size={16} />
            </button>
          </div>
        </header>

        {/* Viewport Content */}
        <div className={`app-viewport ${activeTab === 'chat' || activeTab === 'pcai' ? 'full-bleed' : ''}`}>
          {errorMsg && (
            <div className="panel-card" style={{ borderLeft: '4px solid var(--status-error)' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', color: 'var(--status-error)' }}>
                <AlertCircle size={20} />
                <strong style={{ fontSize: '15px' }}>Cluster Detection Alert:</strong>
              </div>
              <p style={{ marginTop: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>{errorMsg}</p>
            </div>
          )}

          {/* DASHBOARD TAB */}
          {activeTab === 'dashboard' && (
            <div className="tab-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* 4 Sleek Production KPI Cards */}
              <div className="stats-grid-row">
                <div className="kpi-card purple">
                  <div className="kpi-content">
                    <span className="kpi-label">Docker Containers</span>
                    <div className="kpi-value-row">
                      <span className="kpi-number">{status.docker.running ? dockerContainers.length : 0}</span>
                      <span className="kpi-subtext">Total active</span>
                    </div>
                  </div>
                  <div className="kpi-icon-box">
                    <Database size={22} />
                  </div>
                </div>

                <div className="kpi-card cyan">
                  <div className="kpi-content">
                    <span className="kpi-label">K8s Cluster Nodes</span>
                    <div className="kpi-value-row">
                      <span className="kpi-number">{status.kubernetes.running ? k8sResources.nodes.length : 0}</span>
                      <span className="kpi-subtext">Nodes detected</span>
                    </div>
                  </div>
                  <div className="kpi-icon-box">
                    <Server size={22} />
                  </div>
                </div>

                <div className="kpi-card emerald">
                  <div className="kpi-content">
                    <span className="kpi-label">Kubernetes Pods</span>
                    <div className="kpi-value-row">
                      <span className="kpi-number">{status.kubernetes.running ? k8sResources.pods.length : 0}</span>
                      <span className="kpi-subtext">Active workloads</span>
                    </div>
                  </div>
                  <div className="kpi-icon-box">
                    <Layers size={22} />
                  </div>
                </div>

                <div className="kpi-card blue">
                  <div className="kpi-content">
                    <span className="kpi-label">Active Kube Context</span>
                    <div className="kpi-value-row">
                      <span className="kpi-number" style={{ fontSize: '16px', fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>
                        {status.kubernetes.running ? status.kubernetes.context : 'None'}
                      </span>
                    </div>
                  </div>
                  <div className="kpi-icon-box">
                    <HardDrive size={22} />
                  </div>
                </div>
              </div>

              {/* Full-Width Topology Map */}
              <div className="panel-card" style={{ height: 'fit-content', width: '100%' }}>
                <div className="panel-card-title">
                  <h2><Network size={18} /> Cluster Topology Map</h2>
                  <span className="badge neutral">Interactive Visualizer</span>
                </div>
                <div className="topology-visualizer-container" style={{ width: '100%' }}>
                  {loading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '400px', gap: '12px', color: 'var(--text-secondary)' }}>
                      <div className="loader"></div>
                      <span>Scanning cluster topology graph...</span>
                    </div>
                  ) : dockerContainers.length > 0 || k8sResources.pods.length > 0 ? (
                    <TopologyGraph containers={dockerContainers} k8sResources={k8sResources} onRefresh={fetchClusterState} />
                  ) : (
                    <div className="text-secondary" style={{ fontStyle: 'italic', padding: '32px', textAlign: 'center' }}>
                      No active containers or nodes detected to generate visual map.
                    </div>
                  )}
                </div>
              </div>

              {/* Secondary Info Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '16px' }}>
                <div className="panel-card">
                  <div className="panel-card-title">
                    <h2><Activity size={18} /> Host and Daemon Health</h2>
                  </div>
                  <div className="context-card">
                    <div className="context-row">
                      <span className="context-key">Docker Daemon:</span>
                      <span className="context-val">{status.docker.running ? <><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', marginRight: '6px' }} />Active</> : <><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', marginRight: '6px' }} />Down</>}</span>
                    </div>
                    <div className="context-row">
                      <span className="context-key">Docker Version:</span>
                      <span className="context-val" style={{ fontSize: '11px' }}>{status.docker.version || 'N/A'}</span>
                    </div>
                    <div className="context-row" style={{ marginTop: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}>
                      <span className="context-key">Kubernetes:</span>
                      <span className="context-val">{status.kubernetes.running ? <><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', marginRight: '6px' }} />Active</> : <><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', marginRight: '6px' }} />Down</>}</span>
                    </div>
                    <div className="context-row">
                      <span className="context-key">Kube Client:</span>
                      <span className="context-val" style={{ fontSize: '11px' }}>{status.kubernetes.version.split(' ')[0] || 'N/A'}</span>
                    </div>
                  </div>
                </div>

                <div className="panel-card">
                  <div className="panel-card-title">
                    <h2><Cpu size={18} /> Kalam AI Assistant</h2>
                  </div>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
                    Ask Kalam to inspect logs, troubleshoot CrashLoopBackOff pods, scale deployments, or harden Docker images.
                  </p>
                  <button 
                    className="btn primary" 
                    onClick={() => setActiveTab('chat')}
                    style={{ width: '100%', marginTop: '6px' }}
                  >
                    <Sparkles size={16} />
                    <span>Launch AI Console</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* PCAI STACK VISUALIZER TAB */}
          {activeTab === 'pcaistack' && (
            <div className="tab-panel">
              <PcaiStackView k8sResources={k8sResources} status={status} llm={llmParams} />
            </div>
          )}

          {/* VIRTUAL MACHINES TAB */}
          {activeTab === 'vms' && (
            <div className="tab-panel">
              <VmMonitor />
            </div>
          )}

          {/* AGENTS TEAMWORK TAB */}
          {activeTab === 'agents' && (
            <div className="tab-panel">
              <AgentTeamwork
                containers={dockerContainers}
                k8sResources={k8sResources}
                localUrl={effLocalUrl}
                localModel={effLocalModel}
                apiKey={apiKey}
                provider={effProvider}
              />
            </div>
          )}

          {/* DOCKER TAB */}
          {activeTab === 'docker' && (
            <div className="tab-panel">
              <div className="panel-card">
                <div className="panel-card-title">
                  <h2><Database size={18} style={{ color: 'var(--hpe-green)', marginRight: 6 }} /> Docker Container Operations</h2>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="subnav-pills">
                      <button 
                        className={`subnav-pill-btn ${dockerFilter === 'all' ? 'active' : ''}`}
                        onClick={() => setDockerFilter('all')}
                      >
                        All ({dockerContainers.length})
                      </button>
                      <button 
                        className={`subnav-pill-btn ${dockerFilter === 'running' ? 'active' : ''}`}
                        onClick={() => setDockerFilter('running')}
                      >
                        Running ({dockerContainers.filter(c => c.state === 'running').length})
                      </button>
                      <button 
                        className={`subnav-pill-btn ${dockerFilter === 'stopped' ? 'active' : ''}`}
                        onClick={() => setDockerFilter('stopped')}
                      >
                        Stopped ({dockerContainers.filter(c => c.state !== 'running').length})
                      </button>
                    </div>
                  </div>
                </div>

                <div className="table-wrapper">
                  <table className="resource-table">
                    <thead>
                      <tr>
                        <th>Container Name</th>
                        <th>Container ID</th>
                        <th>Image</th>
                        <th>Status</th>
                        <th>State</th>
                        <th>Port Mappings</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDockerContainers.length === 0 ? (
                        <tr>
                          <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '32px' }}>
                            {globalSearch ? `No containers matching "${globalSearch}"` : 'No Docker containers found on local daemon.'}
                          </td>
                        </tr>
                      ) : (
                        filteredDockerContainers.map((c) => (
                          <tr key={c.id}>
                            <td><strong>{c.name}</strong></td>
                            <td><span className="code-id">{c.id.slice(0, 12)}</span></td>
                            <td><span className="code-tag">{c.image}</span></td>
                            <td style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{c.status}</td>
                            <td>
                              <span className={`badge ${c.state}`}>
                                {c.state}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{c.ports || 'None'}</td>
                            <td>
                              <div className="action-btns">
                                {c.state !== 'running' ? (
                                  <button 
                                    className="icon-btn success" 
                                    title="Start Container"
                                    onClick={() => triggerDockerAction('start', c.id)}
                                  >
                                    <Play size={14} />
                                  </button>
                                ) : (
                                  <button 
                                    className="icon-btn danger" 
                                    title="Stop Container"
                                    onClick={() => triggerDockerAction('stop', c.id)}
                                  >
                                    <Square size={14} />
                                  </button>
                                )}
                                <button 
                                  className="icon-btn primary" 
                                  title="Restart Container"
                                  onClick={() => triggerDockerAction('restart', c.id)}
                                >
                                  <RefreshCw size={14} />
                                </button>
                                <button 
                                  className="icon-btn secondary" 
                                  title="View Container Logs"
                                  onClick={() => openLogsModal('docker', c.id, c.name)}
                                >
                                  <FileText size={14} />
                                </button>
                                <button 
                                  className="icon-btn danger" 
                                  title="Force Remove"
                                  onClick={() => triggerDockerAction('remove', c.id)}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* KUBERNETES TAB */}
          {activeTab === 'k8s' && (
            <div className="tab-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="panel-card" style={{ paddingBottom: '12px' }}>
                <div className="panel-card-title" style={{ borderBottom: 'none', marginBottom: 0, paddingBottom: 0 }}>
                  <h2><Server size={18} style={{ color: 'var(--hpe-green)', marginRight: 6 }} /> Kubernetes Resource Manager</h2>
                  <div className="subnav-pills">
                    <button 
                      className={`subnav-pill-btn ${k8sSubTab === 'all' ? 'active' : ''}`}
                      onClick={() => setK8sSubTab('all')}
                    >
                      All Resources
                    </button>
                    <button 
                      className={`subnav-pill-btn ${k8sSubTab === 'nodes' ? 'active' : ''}`}
                      onClick={() => setK8sSubTab('nodes')}
                    >
                      Nodes ({k8sResources.nodes.length})
                    </button>
                    <button 
                      className={`subnav-pill-btn ${k8sSubTab === 'pods' ? 'active' : ''}`}
                      onClick={() => setK8sSubTab('pods')}
                    >
                      Pods ({k8sResources.pods.length})
                    </button>
                    <button 
                      className={`subnav-pill-btn ${k8sSubTab === 'deployments' ? 'active' : ''}`}
                      onClick={() => setK8sSubTab('deployments')}
                    >
                      Deployments ({k8sResources.deployments.length})
                    </button>
                    <button 
                      className={`subnav-pill-btn ${k8sSubTab === 'services' ? 'active' : ''}`}
                      onClick={() => setK8sSubTab('services')}
                    >
                      Services ({k8sResources.services.length})
                    </button>
                  </div>
                </div>
              </div>

              {/* NODES SECTION */}
              {(k8sSubTab === 'all' || k8sSubTab === 'nodes') && (
                <div className="k8s-section">
                  <div 
                    className="k8s-section-header"
                    onClick={() => setExpandedK8s(prev => ({ ...prev, nodes: !prev.nodes }))}
                  >
                    <div className="k8s-section-title">
                      {expandedK8s.nodes ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      <span>Nodes</span>
                      <span className="k8s-section-count">{filteredK8sNodes.length}</span>
                    </div>
                  </div>
                  {expandedK8s.nodes && (
                    <div className="k8s-section-content">
                      <div className="table-wrapper">
                        <table className="resource-table">
                          <thead>
                            <tr>
                              <th>Node Name</th>
                              <th>Status</th>
                              <th>Roles</th>
                              <th>Kubelet Version</th>
                              <th>OS Image</th>
                              <th>Internal IP</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredK8sNodes.length === 0 ? (
                              <tr>
                                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '24px' }}>
                                  No nodes detected or matching search.
                                </td>
                              </tr>
                            ) : (
                              filteredK8sNodes.map((n, idx) => (
                                <tr key={idx}>
                                  <td><strong>{n.name}</strong></td>
                                  <td><span className={`badge ${n.status.toLowerCase()}`}>{n.status}</span></td>
                                  <td><span className="code-tag">{n.role || 'worker'}</span></td>
                                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{n.version}</td>
                                  <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{n.os}</td>
                                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{n.ip}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            {/* DEPLOYMENTS SECTION */}
            {(k8sSubTab === 'all' || k8sSubTab === 'deployments') && (
              <div className="k8s-section">
                <div 
                  className="k8s-section-header"
                  onClick={() => setExpandedK8s(prev => ({ ...prev, deployments: !prev.deployments }))}
                >
                  <div className="k8s-section-title">
                    {expandedK8s.deployments ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    <span>Deployments</span>
                    <span className="k8s-section-count">{filteredK8sDeployments.length}</span>
                  </div>
                </div>
                {expandedK8s.deployments && (
                  <div className="k8s-section-content">
                    <div className="table-wrapper">
                      <table className="resource-table">
                        <thead>
                          <tr>
                            <th>Deployment Name</th>
                            <th>Namespace</th>
                            <th>Ready Replicas</th>
                            <th>Available</th>
                            <th>Updated</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredK8sDeployments.length === 0 ? (
                            <tr>
                              <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '24px' }}>
                                No deployments detected or matching search.
                              </td>
                            </tr>
                          ) : (
                            filteredK8sDeployments.map(d => (
                              <tr key={`${d.namespace}/${d.name}`}>
                                <td><strong>{d.name}</strong></td>
                                <td><span className="code-tag">{d.namespace}</span></td>
                                <td><span className={`badge ${d.available > 0 ? 'running' : 'warning'}`}>{d.ready}</span></td>
                                <td>{d.available}</td>
                                <td>{d.updated}</td>
                                <td>
                                  <div className="action-btns">
                                    <button 
                                      className="icon-btn primary" 
                                      title="Scale Deployment"
                                      onClick={() => setScaleModal({ open: true, name: d.name, namespace: d.namespace, currentReplicas: d.replicas, value: d.replicas })}
                                    >
                                      <Sliders size={14} />
                                    </button>
                                    <button 
                                      className="icon-btn warning" 
                                      title="Restart Rollout"
                                      onClick={() => triggerK8sAction('restart_deploy', d.name, d.namespace)}
                                    >
                                      <RefreshCw size={14} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* SERVICES SECTION */}
            {(k8sSubTab === 'all' || k8sSubTab === 'services') && (
              <div className="k8s-section">
                <div 
                  className="k8s-section-header"
                  onClick={() => setExpandedK8s(prev => ({ ...prev, services: !prev.services }))}
                >
                  <div className="k8s-section-title">
                    {expandedK8s.services ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    <span>Services</span>
                    <span className="k8s-section-count">{filteredK8sServices.length}</span>
                  </div>
                </div>
                {expandedK8s.services && (
                  <div className="k8s-section-content">
                    <div className="table-wrapper">
                      <table className="resource-table">
                        <thead>
                          <tr>
                            <th>Service Name</th>
                            <th>Namespace</th>
                            <th>Type</th>
                            <th>Cluster IP</th>
                            <th>External IP</th>
                            <th>Ports</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredK8sServices.length === 0 ? (
                            <tr>
                              <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '24px' }}>
                                No services detected or matching search.
                              </td>
                            </tr>
                          ) : (
                            filteredK8sServices.map(s => (
                              <tr key={`${s.namespace}/${s.name}`}>
                                <td><strong>{s.name}</strong></td>
                                <td><span className="code-tag">{s.namespace}</span></td>
                                <td><span className="badge neutral">{s.type}</span></td>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{s.clusterIp}</td>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{s.externalIp}</td>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{s.ports || 'None'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* PODS SECTION */}
            {(k8sSubTab === 'all' || k8sSubTab === 'pods') && (
              <div className="k8s-section">
                <div 
                  className="k8s-section-header"
                  onClick={() => setExpandedK8s(prev => ({ ...prev, pods: !prev.pods }))}
                >
                  <div className="k8s-section-title">
                    {expandedK8s.pods ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    <span>Pods</span>
                    <span className="k8s-section-count">{filteredK8sPods.length}</span>
                  </div>
                </div>
                {expandedK8s.pods && (
                  <div className="k8s-section-content">
                    <div className="table-wrapper">
                      <table className="resource-table">
                        <thead>
                          <tr>
                            <th>Pod Name</th>
                            <th>Namespace</th>
                            <th>Status</th>
                            <th>Ready</th>
                            <th>IP</th>
                            <th>Node</th>
                            <th>Restarts</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredK8sPods.length === 0 ? (
                            <tr>
                              <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '24px' }}>
                                No pods detected or matching search.
                              </td>
                            </tr>
                          ) : (
                            filteredK8sPods.map(p => (
                              <tr key={`${p.namespace}/${p.name}`}>
                                <td title={p.name}><strong>{p.name.length > 30 ? `${p.name.slice(0, 28)}...` : p.name}</strong></td>
                                <td><span className="code-tag">{p.namespace}</span></td>
                                <td>
                                  <span className={`badge ${p.status.toLowerCase()}`}>
                                    {p.status}
                                  </span>
                                </td>
                                <td>{p.ready}</td>
                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{p.ip}</td>
                                <td style={{ fontSize: '13px' }}>{p.node}</td>
                                <td>{p.restarts}</td>
                                <td>
                                  <div className="action-btns">
                                    <button 
                                      className="icon-btn primary" 
                                      title="View Pod Logs"
                                      onClick={() => openLogsModal('k8s', p.name, p.name, p.namespace)}
                                    >
                                      <FileText size={14} />
                                    </button>
                                    <button 
                                      className="icon-btn danger" 
                                      title="Delete Pod"
                                      onClick={() => triggerK8sAction('delete_pod', p.name, p.namespace)}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* CHAT TAB */}
        {activeTab === 'chat' && (
          <HPEAgentChat
            chatHistory={chatHistory}
            setChatHistory={setChatHistory}
            chatLoading={chatLoading}
            chatInput={chatInput}
            setChatInput={setChatInput}
            handleSendMessage={handleSendMessage}
            handleExecuteAgentAction={handleExecuteAgentAction}
            agentMermaidChart={agentMermaidChart}
            setAgentMermaidChart={setAgentMermaidChart}
            provider={effProvider}
            apiKey={apiKey}
            localModel={effLocalModel}
            handleNodeHover={handleNodeHover}
          />
        )}

        {/* PCAI ASSISTANT TAB */}
        {activeTab === 'pcai' && (
          <PcaiAssistant
            provider={effProvider}
            apiKey={apiKey}
            localUrl={effLocalUrl}
            localModel={effLocalModel}
            embedModel={embedModel}
            authKey={effAuthKey}
          />
        )}

        {/* SECURITY TAB */}
        {activeTab === 'security' && (
          <div className="tab-panel">
            <div className="panel-card" style={{ marginBottom: '20px' }}>
              <div className="panel-card-title">
                <h2><ShieldAlert size={18} style={{ color: 'var(--hpe-green)', marginRight: 6 }} /> Container Image Security Hardener</h2>
                <span className="badge warning">Scout & Patch</span>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', marginTop: '6px' }}>
                Scan your local running container images for CVE vulnerabilities and apply a one-click secure upgrade by automatically converting base images to optimized Alpine, slim, or distroless architectures.
              </p>
              
              <form onSubmit={handleScanImage} style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '16px', flexWrap: 'wrap' }}>
                <div className="form-group" style={{ flex: '1', minWidth: '250px' }}>
                  <select 
                    className="form-input" 
                    value={securityTarget} 
                    onChange={(e) => setSecurityTarget(e.target.value)}
                    style={{ width: '100%', padding: '10px', height: 'auto', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '8px' }}
                  >
                    <option value="">-- Select a Running Container --</option>
                    {dockerContainers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.image})
                      </option>
                    ))}
                  </select>
                </div>
                <button 
                  type="submit" 
                  className="btn primary" 
                  disabled={!securityTarget || scanLoading}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  {scanLoading ? <span className="loader" style={{ width: '14px', height: '14px', borderWidth: '2px' }}></span> : <ShieldAlert size={16} />}
                  <span>Scan Base Image</span>
                </button>
              </form>
            </div>

            {scanResult && (
              <div className="dashboard-grid" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.8fr)' }}>
                {/* Vulnerability Details List */}
                <div className="panel-card">
                  <div className="panel-card-title">
                    <h3>Vulnerabilities Detected in <code>{scanResult.imageName}</code></h3>
                  </div>

                  {/* Summary badges */}
                  <div style={{ display: 'flex', gap: '10px', margin: '14px 0', flexWrap: 'wrap' }}>
                    <div style={{ padding: '6px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px', color: '#ef4444', fontSize: '12px', fontWeight: 'bold' }}>
                      {scanResult.summary.critical} Critical
                    </div>
                    <div style={{ padding: '6px 12px', background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)', borderRadius: '6px', color: '#f97316', fontSize: '12px', fontWeight: 'bold' }}>
                      {scanResult.summary.high} High
                    </div>
                    <div style={{ padding: '6px 12px', background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: '6px', color: '#eab308', fontSize: '12px', fontWeight: 'bold' }}>
                      {scanResult.summary.medium} Medium
                    </div>
                    <div style={{ padding: '6px 12px', background: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.3)', borderRadius: '6px', color: '#9ca3af', fontSize: '12px', fontWeight: 'bold' }}>
                      {scanResult.summary.low} Low
                    </div>
                  </div>

                  <div className="table-wrapper" style={{ marginTop: '16px' }}>
                    <table className="resource-table">
                      <thead>
                        <tr>
                          <th>CVE ID</th>
                          <th>Package</th>
                          <th>Severity</th>
                          <th>Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scanResult.vulnerabilities.map((v, idx) => (
                          <tr key={idx}>
                            <td><strong style={{ fontFamily: 'var(--font-mono)' }}>{v.cve}</strong></td>
                            <td><span className="code-tag">{v.package}</span></td>
                            <td>
                              <span className={`badge ${v.severity === 'Critical' || v.severity === 'High' ? 'error' : v.severity === 'Medium' ? 'warning' : 'neutral'}`}>
                                {v.severity}
                              </span>
                            </td>
                            <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{v.desc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* One-Place Fix Console */}
                <div className="panel-card" style={{ border: '2px solid rgba(168, 85, 247, 0.4)', background: 'rgba(168, 85, 247, 0.02)' }}>
                  <div className="panel-card-title">
                    <h3><Sparkles size={16} style={{ color: 'var(--hpe-green)', marginRight: 6 }} /> One-Place Secure Patch</h3>
                    <span className="badge success">Ready</span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '14px' }}>
                    <div className="context-card" style={{ background: 'rgba(255, 255, 255, 0.02)' }}>
                      <h4 style={{ color: 'var(--accent-cyan)', fontSize: '13px', margin: '0 0 6px 0' }}>Security Hardening Plan</h4>
                      <p style={{ fontSize: '13px', lineHeight: '1.4', margin: 0, color: 'var(--text-secondary)' }}>
                        {scanResult.recommendation}
                      </p>
                    </div>

                    {scanResult.fixAction && (
                      <>
                        <div className="context-card" style={{ background: 'rgba(16, 185, 129, 0.03)', border: '1px solid rgba(16, 185, 129, 0.15)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', marginBottom: '4px' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Current Vulnerable Base:</span>
                            <strong style={{ color: 'var(--status-error)' }}>{scanResult.imageName}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Secure Target Base:</span>
                            <strong style={{ color: 'var(--status-success)' }}>{scanResult.fixAction.targetImage}</strong>
                          </div>
                        </div>

                        <button 
                          className="btn primary" 
                          onClick={handleApplySecurityFix}
                          disabled={fixExecuting}
                          style={{ width: '100%', height: '42px', fontSize: '14px', background: 'var(--accent-purple)', borderColor: 'var(--accent-purple)' }}
                        >
                          {fixExecuting ? (
                            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                              <span className="loader" style={{ width: '14px', height: '14px', borderWidth: '2px' }}></span>
                              <span>Upgrading and Re-deploying...</span>
                            </span>
                          ) : (
                            <span>Apply Secure Fix & Re-deploy</span>
                          )}
                        </button>
                      </>
                    )}

                    {fixOutput && (
                      <div className="logs-pre" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px', maxHeight: '180px', overflowY: 'auto' }}>
                        <code style={{ fontSize: '11px', whiteSpace: 'pre-wrap', color: fixOutput.includes('[FAIL]') || fixOutput.includes('error') ? 'var(--status-error)' : '#34d399' }}>
                          {fixOutput}
                        </code>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* KUBECTL CHEATSHEET TAB */}
        {activeTab === 'cheatsheet' && (
          <KubectlCheatSheet />
        )}
      </div>
    </div>

      {/* LOGS MODAL */}
      {logsModal?.open && (
        <div className="modal-overlay" onClick={() => setLogsModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                <Terminal size={18} />
                Logs: {logsModal.name} {logsModal.namespace ? `[ns: ${logsModal.namespace}]` : ''}
              </h3>
              <button className="icon-btn" onClick={() => setLogsModal(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {logsLoading ? (
                <div className="logs-loading">
                  <div className="loader"></div>
                  <span>Streaming logs from daemon...</span>
                </div>
              ) : (
                <pre className="logs-pre">
                  <code>{logs}</code>
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SCALE K8S MODAL */}
      {scaleModal?.open && (
        <div className="modal-overlay" onClick={() => setScaleModal(null)}>
          <div className="modal-content" style={{ maxHeight: '350px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                <Sliders size={18} />
                Scale Deployment: {scaleModal.name}
              </h3>
              <button className="icon-btn" onClick={() => setScaleModal(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <form 
                className="scale-form" 
                onSubmit={(e) => {
                  e.preventDefault();
                  triggerK8sAction('scale_deploy', scaleModal.name, scaleModal.namespace, scaleModal.value);
                  setScaleModal(null);
                }}
              >
                <div className="form-group">
                  <label>Target Replicas Count</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    min="0"
                    max="10"
                    value={scaleModal.value}
                    onChange={(e) => setScaleModal(prev => prev ? { ...prev, value: parseInt(e.target.value) || 0 } : null)}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Current replicas: {scaleModal.currentReplicas}
                  </span>
                </div>
                <div className="form-actions">
                  <button type="button" className="btn secondary" onClick={() => setScaleModal(null)}>Cancel</button>
                  <button type="submit" className="btn primary">Apply Scale</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* AGENT SETTINGS MODAL */}
      {settingsModalOpen && (
        <div className="modal-overlay" onClick={() => setSettingsModalOpen(false)}>
          <div className="modal-content" style={{ maxHeight: '88vh', maxWidth: '520px', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                <Sliders size={18} />
                DevOps Agent Configuration
              </h3>
              <button className="icon-btn" onClick={() => setSettingsModalOpen(false)}><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

                {/* Provider Selector */}
                <div className="form-group">
                  <label style={{ fontSize: '13px', fontWeight: '600' }}>LLM Provider</label>
                  <select
                    className="form-input"
                    value={provider}
                    onChange={(e) => {
                      const val = e.target.value as 'gemini' | 'local' | 'custom';
                      setProvider(val);
                      localStorage.setItem('kalam_llm_provider', val);
                    }}
                    style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px', borderRadius: '8px' }}
                  >
                    <option value="gemini">Google Gemini (Cloud)</option>
                    <option value="local">Local LLM (Ollama / LM Studio)</option>
                    <option value="custom">Custom Model Endpoint (HPE MLIS / vLLM / OpenAI)</option>
                  </select>
                </div>

                {provider === 'custom' ? (
                  /* Custom OpenAI-compatible endpoint */
                  <>
                    <div className="form-group">
                      <label style={{ fontSize: '13px', fontWeight: '600' }}>Endpoint Base URL</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="https://mlis.my-pcai.example.com/v1"
                        value={customUrl}
                        onChange={(e) => { setCustomUrl(e.target.value); localStorage.setItem('kalam_custom_url', e.target.value); }}
                      />
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        OpenAI-compatible base URL. For an HPE <strong>MLIS</strong> deployment use its serving URL ending in <code>/v1</code>.
                      </span>
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '13px', fontWeight: '600' }}>Model Name</label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          type="text"
                          className="form-input"
                          style={{ flex: 1 }}
                          placeholder="e.g. meta-llama/Llama-3.1-8B-Instruct"
                          value={customModel}
                          onChange={(e) => { setCustomModel(e.target.value); localStorage.setItem('kalam_custom_model', e.target.value); }}
                        />
                        <button type="button" className="btn secondary" onClick={detectCustomModels} style={{ whiteSpace: 'nowrap' }}>Detect models</button>
                      </div>
                      {customDetectMsg && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{customDetectMsg}</span>}
                      {customModels.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px', maxHeight: 120, overflow: 'auto' }}>
                          {customModels.map((m) => (
                            <button key={m} type="button" className={`badge ${customModel === m ? 'running' : 'neutral'}`} style={{ cursor: 'pointer', border: 'none' }}
                              onClick={() => { setCustomModel(m); localStorage.setItem('kalam_custom_model', m); }}>{m}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '13px', fontWeight: '600' }}>API Key / Bearer Token (optional)</label>
                      <div style={{ display: 'flex', gap: '8px', position: 'relative' }}>
                        <input
                          type={showCustomKey ? 'text' : 'password'}
                          className="form-input"
                          placeholder="Deployment token — leave blank if the endpoint is unauthenticated"
                          value={customKey}
                          onChange={(e) => { setCustomKey(e.target.value); localStorage.setItem('kalam_custom_key', e.target.value); }}
                          style={{ flex: 1 }}
                        />
                        <button type="button" className="icon-btn" onClick={() => setShowCustomKey(!showCustomKey)} style={{ position: 'absolute', right: '10px', top: '10px', background: 'transparent', border: 'none' }}>
                          {showCustomKey ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Sent as <code>Authorization: Bearer …</code>. Stored locally in your browser.
                      </span>
                    </div>
                  </>
                ) : provider === 'gemini' ? (
                  /* Gemini Key Input */
                  <div className="form-group">
                    <label style={{ fontSize: '13px', fontWeight: '600' }}>Gemini API Key</label>
                    <div style={{ display: 'flex', gap: '8px', position: 'relative' }}>
                      <input 
                        type={showApiKey ? "text" : "password"} 
                        className="form-input" 
                        placeholder="AIzaSy..."
                        value={apiKey}
                        onChange={(e) => handleSaveApiKey(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button 
                        type="button" 
                        className="icon-btn" 
                        onClick={() => setShowApiKey(!showApiKey)}
                        style={{ position: 'absolute', right: '10px', top: '10px', background: 'transparent', border: 'none' }}
                      >
                        {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      API keys are saved locally in your browser storage.
                    </span>
                  </div>
                ) : (
                  /* Local LLM Inputs */
                  <>
                    <div className="form-group">
                      <label style={{ fontSize: '13px', fontWeight: '600' }}>Local Endpoint URL</label>
                      <input 
                        type="text" 
                        className="form-input" 
                        placeholder="http://localhost:11434/v1"
                        value={localUrl}
                        onChange={(e) => {
                          setLocalUrl(e.target.value);
                          localStorage.setItem('kalam_local_url', e.target.value);
                        }}
                      />
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        OpenAI-compatible local endpoint. For Ollama, use default: <code>http://localhost:11434/v1</code>.
                      </span>
                    </div>

                    <ModelPicker
                      localUrl={localUrl}
                      localModel={localModel}
                      onSelectModel={(m) => { setLocalModel(m); localStorage.setItem('kalam_local_model', m); }}
                      embedModel={embedModel}
                      onSelectEmbed={(m) => { setEmbedModel(m); localStorage.setItem('kalam_local_embed_model', m); }}
                    />
                  </>
                )}

                <div className="form-actions" style={{ marginTop: '12px' }}>
                  <button className="btn primary" style={{ width: '100%' }} onClick={() => setSettingsModalOpen(false)}>
                    Save Configuration
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Tooltip for Graph Hover */}
      {hoveredNode && (
        <div 
          className="graph-tooltip"
          style={{ 
            left: `${hoveredNode.x + 15}px`, 
            top: `${hoveredNode.y + 15}px` 
          }}
        >
          {hoveredNode.resource ? (
            <>
              <div className="graph-tooltip-header">
                <span className="graph-tooltip-title">{hoveredNode.resource.title}</span>
                <span className={`badge ${hoveredNode.resource.status}`} style={{ fontSize: '9px', padding: '2px 6px' }}>
                  {hoveredNode.resource.statusLabel}
                </span>
              </div>
              <div className="graph-tooltip-type" style={{ marginBottom: '8px' }}>
                {hoveredNode.resource.type}
              </div>
              <div className="graph-tooltip-content">
                {Object.entries(hoveredNode.resource.details).map(([key, val]) => (
                  <div className="graph-tooltip-row" key={key}>
                    <span className="graph-tooltip-key">{key}:</span>
                    <span className="graph-tooltip-val">{val}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div>
              <div className="graph-tooltip-header" style={{ borderBottom: 'none', marginBottom: 0, paddingBottom: 0 }}>
                <span className="graph-tooltip-title" style={{ maxWidth: '100%' }}>
                  {hoveredNode.key.replace('text_', '')}
                </span>
              </div>
              <span className="graph-tooltip-type">RESOURCE RELATIONSHIP</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
export default App;
