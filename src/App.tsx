import React, { useState, useEffect, useRef } from 'react';
import { 
  Terminal, 
  Layers, 
  Database, 
  Server, 
  RefreshCw, 
  Play, 
  Square, 
  Trash2, 
  Send, 
  Check, 
  AlertCircle, 
  FileText, 
  ChevronRight, 
  ChevronDown, 
  Sliders, 
  MessageSquare,
  Eye,
  EyeOff,
  SlidersHorizontal,
  Info,
  ShieldAlert,
  Cpu
} from 'lucide-react';
import TopologyGraph from './components/TopologyGraph';
import MermaidChart from './components/MermaidChart';
import AgentTeamwork from './components/AgentTeamwork';

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
  const [activeTab, setActiveTab] = useState<'dashboard' | 'docker' | 'k8s' | 'chat' | 'security' | 'agents'>('dashboard');
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('kalam_gemini_api_key') || '');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [provider, setProvider] = useState<'gemini' | 'local'>(() => (localStorage.getItem('kalam_llm_provider') as 'gemini' | 'local') || 'gemini');
  const [localUrl, setLocalUrl] = useState<string>(() => localStorage.getItem('kalam_local_url') || 'http://localhost:11434/v1');
  const [localModel, setLocalModel] = useState<string>(() => localStorage.getItem('kalam_local_model') || 'qwen2.5-coder:7b');
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
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
        setFixOutput(`✅ ${data.message}\nCommand executed: ${data.cmdRun}\nNew Container ID: ${data.newContainerId}`);
        fetchClusterState();
      } else {
        setFixOutput(`❌ Upgrade failed: ${data.error}\nDetails: ${data.details || ''}`);
      }
    } catch (err: any) {
      setFixOutput(`❌ Network error: ${err.message}`);
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
      // Get Status
      const statusRes = await fetch('/api/status');
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
      setErrorMsg('Failed to query cluster resource states. Make sure Docker Desktop and/or Kubernetes are active.');
    } finally {
      setLoading(false);
      hasDataRef.current = true;
    }
  };

  useEffect(() => {
    fetchClusterState();
    // Poll every 10 seconds for live updates
    const interval = setInterval(fetchClusterState, 10000);
    return () => clearInterval(interval);
  }, []);

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
          provider: provider,
          localUrl: localUrl,
          localModel: localModel
        })
      });

      const data = await response.json();
      if (!response.ok) {
        const errorMsg: ChatMessage = {
          role: 'agent',
          content: `⚠️ **Error talking to backend:** ${data.error || 'Unknown error occurred'}\n\n*Details: ${data.details || 'Check console logs.'}*`,
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
        content: `❌ **Failed to send message:** Network error. Make sure your server is running.\n\n*Details: ${e.message}*`,
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



  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-logo">K</div>
          <div className="brand-title">
            <h1>Kalam</h1>
            <span>Agentic cluster viewer</span>
          </div>
        </div>

        {/* Global Resource Status Badges */}
        <div className="status-badges">
          <div className={`status-badge ${status.docker.running ? 'active' : 'inactive'}`}>
            <span className="status-dot"></span>
            <span>Docker</span>
          </div>
          <div className={`status-badge ${status.kubernetes.running ? 'active' : 'inactive'}`}>
            <span className="status-dot"></span>
            <span>Kubernetes</span>
          </div>
        </div>

        {/* API Key */}
        <div className="header-actions">
          <span className="badge neutral" style={{ fontSize: '12px' }}>
            Agent: {provider === 'gemini' ? 'Gemini 3.5' : localModel}
          </span>
          <button 
            type="button"
            className="icon-btn primary"
            onClick={() => setSettingsModalOpen(true)}
            title="Configure Agent Settings"
            style={{ padding: '8px' }}
          >
            <Sliders size={16} />
          </button>

          <button 
            className="icon-btn success"
            onClick={fetchClusterState} 
            title="Refresh State"
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? 'loader' : ''} />
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="tabs-container">
        <button 
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <Layers size={18} />
          Dashboard
        </button>
        <button 
          className={`tab-btn ${activeTab === 'docker' ? 'active' : ''}`}
          onClick={() => setActiveTab('docker')}
          disabled={!status.docker.installed}
        >
          <Database size={18} />
          Docker ({dockerContainers.length})
        </button>
        <button 
          className={`tab-btn ${activeTab === 'k8s' ? 'active' : ''}`}
          onClick={() => setActiveTab('k8s')}
          disabled={!status.kubernetes.installed}
        >
          <Server size={18} />
          Kubernetes
        </button>
        <button 
          className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          <MessageSquare size={18} />
          Agent Chat
        </button>
        <button 
          className={`tab-btn ${activeTab === 'security' ? 'active' : ''}`}
          onClick={() => setActiveTab('security')}
        >
          <ShieldAlert size={18} />
          Image Hardener
        </button>
        <button 
          className={`tab-btn ${activeTab === 'agents' ? 'active' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          <Cpu size={18} />
          Agent Teamwork
        </button>
      </nav>

      {/* Tab Contents */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
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
          <div className="tab-panel">
            {/* Stats Overview */}
            <div className="stats-container">
              <div className="stat-item">
                <span className="stat-label">Docker Containers</span>
                <span className={`stat-value ${status.docker.running ? 'ok' : 'err'}`}>
                  {status.docker.running ? dockerContainers.length : 'Offline'}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-label">K8s Cluster Nodes</span>
                <span className={`stat-value ${status.kubernetes.running ? 'ok' : 'err'}`}>
                  {status.kubernetes.running ? k8sResources.nodes.length : 'Offline'}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Kubernetes Pods</span>
                <span className={`stat-value ${status.kubernetes.running ? 'ok' : 'err'}`}>
                  {status.kubernetes.running ? k8sResources.pods.length : 'Offline'}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Active Context</span>
                <span className="stat-value" style={{ fontSize: '16px', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {status.kubernetes.running ? status.kubernetes.context : 'None'}
                </span>
              </div>
            </div>

            {/* Main Diagram Panel */}
            <div className="dashboard-grid">
              <div className="panel-card" style={{ height: 'fit-content' }}>
                <div className="panel-card-title">
                  <h2>💻 Cluster Topology Map</h2>
                  <span className="badge neutral">Auto Generated</span>
                </div>
                <div style={{ padding: '8px' }}>
                  {loading ? (
                    <div className="loader"></div>
                  ) : dockerContainers.length > 0 || k8sResources.pods.length > 0 ? (
                    <TopologyGraph containers={dockerContainers} k8sResources={k8sResources} />
                  ) : (
                    <div className="text-secondary" style={{ fontStyle: 'italic', padding: '16px' }}>
                      No active containers or nodes detected to generate visual map.
                    </div>
                  )}
                </div>
              </div>

              <div className="context-panel">
                <div className="panel-card">
                  <div className="panel-card-title">
                    <h2>🔍 Host Context</h2>
                  </div>
                  <div className="context-card">
                    <div className="context-row">
                      <span className="context-key">Docker Daemon:</span>
                      <span className="context-val">{status.docker.running ? '🟢 Active' : '🔴 Down'}</span>
                    </div>
                    <div className="context-row">
                      <span className="context-key">Docker Version:</span>
                      <span className="context-val" style={{ fontSize: '11px' }}>{status.docker.version || 'N/A'}</span>
                    </div>
                    <div className="context-row" style={{ marginTop: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}>
                      <span className="context-key">Kubernetes:</span>
                      <span className="context-val">{status.kubernetes.running ? '🟢 Active' : '🔴 Down'}</span>
                    </div>
                    <div className="context-row">
                      <span className="context-key">Kube Client:</span>
                      <span className="context-val" style={{ fontSize: '11px' }}>{status.kubernetes.version.split(' ')[0] || 'N/A'}</span>
                    </div>
                  </div>
                </div>

                <div className="panel-card">
                  <div className="panel-card-title">
                    <h2>🤖 Kalam Chatbot</h2>
                  </div>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    Need to modify resources, scale up pods, or see customized graphs? Talk to the agent!
                  </p>
                  <button 
                    className="btn primary" 
                    onClick={() => setActiveTab('chat')}
                    style={{ width: '100%' }}
                  >
                    Open Chat Console
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* AGENTS TEAMWORK TAB */}
        {activeTab === 'agents' && (
          <div className="tab-panel">
            <AgentTeamwork
              containers={dockerContainers}
              k8sResources={k8sResources}
              localUrl={localUrl}
              localModel={localModel}
              apiKey={apiKey}
              provider={provider}
            />
          </div>
        )}

        {/* DOCKER TAB */}
        {activeTab === 'docker' && (
          <div className="tab-panel">
            <div className="panel-card">
              <div className="panel-card-title">
                <h2>🐳 Docker Containers ({dockerContainers.length})</h2>
              </div>
              <div className="table-wrapper">
                <table className="resource-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Container ID</th>
                      <th>Image</th>
                      <th>Status</th>
                      <th>State</th>
                      <th>Ports</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dockerContainers.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '24px' }}>
                          No Docker containers found.
                        </td>
                      </tr>
                    ) : (
                      dockerContainers.map((c) => (
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
                                  title="Start"
                                  onClick={() => triggerDockerAction('start', c.id)}
                                >
                                  <Play size={14} />
                                </button>
                              ) : (
                                <button 
                                  className="icon-btn danger" 
                                  title="Stop"
                                  onClick={() => triggerDockerAction('stop', c.id)}
                                >
                                  <Square size={14} />
                                </button>
                              )}
                              <button 
                                className="icon-btn primary" 
                                title="Restart"
                                onClick={() => triggerDockerAction('restart', c.id)}
                              >
                                <RefreshCw size={14} />
                              </button>
                              <button 
                                className="icon-btn secondary" 
                                title="View Logs"
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
          <div className="tab-panel">
            {/* NODES SECTION */}
            <div className="k8s-section">
              <div 
                className="k8s-section-header"
                onClick={() => setExpandedK8s(prev => ({ ...prev, nodes: !prev.nodes }))}
              >
                <div className="k8s-section-title">
                  {expandedK8s.nodes ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <span>💻 Nodes</span>
                  <span className="k8s-section-count">{k8sResources.nodes.length}</span>
                </div>
              </div>
              {expandedK8s.nodes && (
                <div className="k8s-section-content">
                  <div className="table-wrapper">
                    <table className="resource-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Status</th>
                          <th>Role</th>
                          <th>Version</th>
                          <th>Internal IP</th>
                          <th>OS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {k8sResources.nodes.length === 0 ? (
                          <tr>
                            <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No Nodes detected.</td>
                          </tr>
                        ) : (
                          k8sResources.nodes.map(node => (
                            <tr key={node.name}>
                              <td><strong>{node.name}</strong></td>
                              <td><span className={`badge ${node.status.toLowerCase()}`}>{node.status}</span></td>
                              <td><span className="code-id">{node.role}</span></td>
                              <td>{node.version}</td>
                              <td>{node.ip}</td>
                              <td>{node.os}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* DEPLOYMENTS SECTION */}
            <div className="k8s-section">
              <div 
                className="k8s-section-header"
                onClick={() => setExpandedK8s(prev => ({ ...prev, deployments: !prev.deployments }))}
              >
                <div className="k8s-section-title">
                  {expandedK8s.deployments ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <span>📦 Deployments</span>
                  <span className="k8s-section-count">{k8sResources.deployments.length}</span>
                </div>
              </div>
              {expandedK8s.deployments && (
                <div className="k8s-section-content">
                  <div className="table-wrapper">
                    <table className="resource-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Namespace</th>
                          <th>Ready Replicas</th>
                          <th>Available</th>
                          <th>Updated</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {k8sResources.deployments.length === 0 ? (
                          <tr>
                            <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No Deployments detected.</td>
                          </tr>
                        ) : (
                          k8sResources.deployments.map(d => (
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

            {/* SERVICES SECTION */}
            <div className="k8s-section">
              <div 
                className="k8s-section-header"
                onClick={() => setExpandedK8s(prev => ({ ...prev, services: !prev.services }))}
              >
                <div className="k8s-section-title">
                  {expandedK8s.services ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <span>⚙️ Services</span>
                  <span className="k8s-section-count">{k8sResources.services.length}</span>
                </div>
              </div>
              {expandedK8s.services && (
                <div className="k8s-section-content">
                  <div className="table-wrapper">
                    <table className="resource-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Namespace</th>
                          <th>Type</th>
                          <th>Cluster IP</th>
                          <th>External IP</th>
                          <th>Ports</th>
                        </tr>
                      </thead>
                      <tbody>
                        {k8sResources.services.length === 0 ? (
                          <tr>
                            <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No Services detected.</td>
                          </tr>
                        ) : (
                          k8sResources.services.map(s => (
                            <tr key={`${s.namespace}/${s.name}`}>
                              <td><strong>{s.name}</strong></td>
                              <td><span className="code-tag">{s.namespace}</span></td>
                              <td><span className="badge neutral">{s.type}</span></td>
                              <td>{s.clusterIp}</td>
                              <td>{s.externalIp}</td>
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

            {/* PODS SECTION */}
            <div className="k8s-section">
              <div 
                className="k8s-section-header"
                onClick={() => setExpandedK8s(prev => ({ ...prev, pods: !prev.pods }))}
              >
                <div className="k8s-section-title">
                  {expandedK8s.pods ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <span>🛸 Pods</span>
                  <span className="k8s-section-count">{k8sResources.pods.length}</span>
                </div>
              </div>
              {expandedK8s.pods && (
                <div className="k8s-section-content">
                  <div className="table-wrapper">
                    <table className="resource-table">
                      <thead>
                        <tr>
                          <th>Name</th>
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
                        {k8sResources.pods.length === 0 ? (
                          <tr>
                            <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No Pods detected.</td>
                          </tr>
                        ) : (
                          k8sResources.pods.map(p => (
                            <tr key={`${p.namespace}/${p.name}`}>
                              <td title={p.name}><strong>{p.name.length > 30 ? `${p.name.slice(0, 28)}...` : p.name}</strong></td>
                              <td><span className="code-tag">{p.namespace}</span></td>
                              <td>
                                <span className={`badge ${p.status.toLowerCase()}`}>
                                  {p.status}
                                </span>
                              </td>
                              <td>{p.ready}</td>
                              <td>{p.ip}</td>
                              <td style={{ fontSize: '13px' }}>{p.node}</td>
                              <td>{p.restarts}</td>
                              <td>
                                <div className="action-btns">
                                  <button 
                                    className="icon-btn primary" 
                                    title="View logs"
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
          </div>
        )}

        {/* CHAT TAB */}
        {activeTab === 'chat' && (
          <div className="tab-panel chat-container">
            {/* Left Panel: Diagram / Workspace view */}
            <div className="chat-sidebar">
              <div className="chat-sidebar-section">
                <h3>🗺️ Agent Visualizer</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
                  Mermaid diagrams drawn by the agent are displayed below.
                </p>
                <div className="mermaid-wrapper" style={{ minHeight: '300px', maxHeight: '500px', padding: '8px' }}>
                  {agentMermaidChart ? (
                    <MermaidChart chart={agentMermaidChart} onNodeHover={handleNodeHover} />
                  ) : (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic', padding: '16px' }}>
                      No customized agent diagrams yet. Ask the agent: "Show me a graph of my cluster."
                    </div>
                  )}
                </div>
              </div>
              
              <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <Info size={14} />
                  <span>Talk directly or click interactive buttons inside bubbles to run tasks!</span>
                </div>
              </div>
            </div>

            {/* Right Panel: Chat Console */}
            <div className="chat-main">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 8px 12px 8px', borderBottom: '1px solid var(--border-color)', marginBottom: '12px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Chat Conversation</span>
                <button 
                  onClick={() => {
                    if (window.confirm("Are you sure you want to clear your chat history?")) {
                      localStorage.removeItem('kalam_chat_history');
                      setChatHistory([
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
                      ]);
                      setAgentMermaidChart('');
                    }
                  }}
                  style={{ background: 'transparent', border: 'none', color: 'var(--status-error)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '4px' }}
                >
                  <Trash2 size={13} />
                  Clear Chat
                </button>
              </div>
              <div className="chat-messages-wrapper">
                {chatHistory.map((msg, msgIdx) => (
                  <div key={msgIdx} className={`chat-message ${msg.role}`}>
                    <div className="chat-avatar">
                      {msg.role === 'user' ? 'U' : '🤖'}
                    </div>
                    <div className="chat-bubble">
                      {/* Simple custom renderer for bold/italic/code block formats */}
                      <div className="chat-text-content" style={{ whiteSpace: 'pre-wrap' }}>
                        {msg.content.split('\n').map((line, lineIdx) => {
                          // Very basic markdown translation for highlights
                          
                          return (
                            <p key={lineIdx} style={{ margin: '0 0 6px 0' }}>
                              {line.split(' ').map((word, wIdx) => {
                                if (word.startsWith('**') && word.endsWith('**')) {
                                  return <strong key={wIdx}>{word.slice(2, -2)} </strong>;
                                }
                                if (word.startsWith('*') && word.endsWith('*')) {
                                  return <em key={wIdx}>{word.slice(1, -1)} </em>;
                                }
                                if (word.startsWith('`') && word.endsWith('`')) {
                                  return <code key={wIdx} style={{ padding: '2px 4px', background: 'var(--bg-primary)', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: '13px' }}>{word.slice(1, -1)}</code>;
                                }
                                return word + ' ';
                              })}
                            </p>
                          );
                        })}
                      </div>

                      {/* Display Actions recommended by the agent */}
                      {msg.actions && msg.actions.length > 0 && (
                        <div className="chat-actions-container">
                          <span className="chat-actions-title">
                            <SlidersHorizontal size={14} />
                            Recommended Agent Actions
                          </span>
                          <div className="chat-actions-list">
                            {msg.actions.map((action, actionIdx) => {
                              const actKey = `act-${actionIdx}`;
                              const statusObj = msg.actionStatuses?.[actKey] || { status: 'idle' };

                              return (
                                <div key={actionIdx} style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <button
                                      className="agent-action-btn"
                                      disabled={statusObj.status === 'running' || statusObj.status === 'success'}
                                      onClick={() => handleExecuteAgentAction(msgIdx, actionIdx, action)}
                                    >
                                      {statusObj.status === 'running' && <span className="loader" style={{ width: '12px', height: '12px', borderWidth: '2px' }}></span>}
                                      {statusObj.status === 'success' && <Check size={14} style={{ color: 'var(--status-success)' }} />}
                                      <span>{action.label}</span>
                                    </button>
                                  </div>

                                  {/* Action execution output */}
                                  {statusObj.output && (
                                    <div className={`action-status-card ${statusObj.status}`}>
                                      {statusObj.output}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                
                {chatLoading && (
                  <div className="chat-message agent">
                    <div className="chat-avatar">🤖</div>
                    <div className="chat-bubble" style={{ padding: '16px 24px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div className="loader"></div>
                        <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>Kalam is analyzing cluster state...</span>
                      </div>
                    </div>
                  </div>
                )}
                
                <div ref={chatEndRef} />
              </div>

              {/* Chat Input Bar */}
              <div className="chat-input-wrapper">
                <form className="chat-input-form" onSubmit={handleSendMessage}>
                  <textarea 
                    className="chat-input"
                    placeholder={(provider === 'local' || apiKey) ? "Ask Kalam: 'Which container has ports mapped?' or 'Restart my PG container'" : "Configure your settings in the header to start chat..."}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={(provider === 'gemini' && !apiKey) || chatLoading}
                    rows={1}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage(e);
                      }
                    }}
                  />
                  <button 
                    type="submit" 
                    className="chat-send-btn"
                    disabled={!chatInput.trim() || (provider === 'gemini' && !apiKey) || chatLoading}
                  >
                    <Send size={16} />
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* SECURITY TAB */}
        {activeTab === 'security' && (
          <div className="tab-panel">
            <div className="panel-card" style={{ marginBottom: '20px' }}>
              <div className="panel-card-title">
                <h2>🛡️ Container Image Security Hardener</h2>
                <span className="badge warning">Scout & Patch</span>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '13.5px', marginTop: '6px' }}>
                Scan your local running container images for CVE vulnerabilities and apply a **one-click secure upgrade** by automatically converting base images to optimized Alpine, slim, or distroless architectures.
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
                      🚨 {scanResult.summary.critical} Critical
                    </div>
                    <div style={{ padding: '6px 12px', background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)', borderRadius: '6px', color: '#f97316', fontSize: '12px', fontWeight: 'bold' }}>
                      🔥 {scanResult.summary.high} High
                    </div>
                    <div style={{ padding: '6px 12px', background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: '6px', color: '#eab308', fontSize: '12px', fontWeight: 'bold' }}>
                      ⚠️ {scanResult.summary.medium} Medium
                    </div>
                    <div style={{ padding: '6px 12px', background: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.3)', borderRadius: '6px', color: '#9ca3af', fontSize: '12px', fontWeight: 'bold' }}>
                      ℹ️ {scanResult.summary.low} Low
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
                    <h3>⚡ One-Place Secure Patch</h3>
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
                        <code style={{ fontSize: '11px', whiteSpace: 'pre-wrap', color: fixOutput.includes('❌') ? 'var(--status-error)' : '#34d399' }}>
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
      </main>

      {/* LOGS MODAL */}
      {logsModal?.open && (
        <div className="modal-overlay" onClick={() => setLogsModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                <Terminal size={18} />
                Logs: {logsModal.name} {logsModal.namespace ? `[ns: ${logsModal.namespace}]` : ''}
              </h3>
              <button className="icon-btn" onClick={() => setLogsModal(null)}>✕</button>
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
              <button className="icon-btn" onClick={() => setScaleModal(null)}>✕</button>
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
          <div className="modal-content" style={{ maxHeight: '480px', maxWidth: '500px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                <Sliders size={18} />
                DevOps Agent Configuration
              </h3>
              <button className="icon-btn" onClick={() => setSettingsModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                
                {/* Provider Selector */}
                <div className="form-group">
                  <label style={{ fontSize: '13px', fontWeight: '600' }}>LLM Provider</label>
                  <select 
                    className="form-input" 
                    value={provider} 
                    onChange={(e) => {
                      const val = e.target.value as 'gemini' | 'local';
                      setProvider(val);
                      localStorage.setItem('kalam_llm_provider', val);
                    }}
                    style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px', borderRadius: '8px' }}
                  >
                    <option value="gemini">Google Gemini (Cloud)</option>
                    <option value="local">Local LLM (Ollama / LM Studio)</option>
                  </select>
                </div>

                {provider === 'gemini' ? (
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

                    <div className="form-group">
                      <label style={{ fontSize: '13px', fontWeight: '600' }}>Model Name</label>
                      <input 
                        type="text" 
                        className="form-input" 
                        placeholder="qwen2.5-coder"
                        value={localModel}
                        onChange={(e) => {
                          setLocalModel(e.target.value);
                          localStorage.setItem('kalam_local_model', e.target.value);
                        }}
                      />
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Specify the model downloaded locally (e.g., <code>qwen2.5-coder</code>, <code>llama3</code>, <code>mistral</code>).
                      </span>
                    </div>
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
