import React, { useMemo, useState, memo, useCallback, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  MarkerType
} from 'reactflow';
import type { NodeProps, Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Search,
  X,
  RefreshCw,
  Activity,
  Shield,
  Play,
  Square,
  RotateCw,
  Trash2,
  Sliders,
  Scale,
  AlertTriangle,
  Clock,
  Info
} from 'lucide-react';

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  created?: string;
}

interface K8sResources {
  pods: any[];
  services: any[];
  deployments: any[];
  nodes: any[];
}

interface TopologyGraphProps {
  containers: Container[];
  k8sResources: K8sResources;
}

// Helper: formats creation timestamp into relative age
function formatAge(creationTime: string | number | undefined): string {
  if (!creationTime) return 'Unknown age';
  const parsedTime = Date.parse(creationTime.toString());
  if (isNaN(parsedTime)) {
    return creationTime.toString();
  }
  const diffMs = Date.now() - parsedTime;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ${diffMin % 60}m ago`;
  return `${diffDay}d ${diffHour % 24}h ago`;
}

// ─── Custom DevOps Card Node ────────────────────────────────────────────────
const DevOpsNode = memo(({ id, data }: NodeProps) => {
  const { type, name, status, ip, ports, image, ready, replicas, role, state, isHovered, isFocused, onHover, heatmapMode, restarts, created } = data;

  let icon = '📦';
  let themeColor = '#8b5cf6'; // purple
  let borderColor = 'rgba(139, 92, 246, 0.25)';
  let cardTitle = name;

  if (type === 'docker') {
    icon = '🐳';
    themeColor = '#0ea5e9'; // sky blue
    borderColor = 'rgba(14, 165, 233, 0.25)';
  } else if (type === 'port') {
    icon = '🌐';
    themeColor = '#818cf8'; // indigo
    borderColor = 'rgba(129, 140, 248, 0.25)';
  } else if (type === 'service') {
    icon = '⚙️';
    themeColor = '#f59e0b'; // amber
    borderColor = 'rgba(245, 158, 11, 0.25)';
  } else if (type === 'deployment') {
    icon = '📦';
    themeColor = '#a78bfa'; // violet
    borderColor = 'rgba(167, 139, 250, 0.25)';
  } else if (type === 'pod') {
    icon = '🛸';
    themeColor = '#10b981'; // emerald
    borderColor = 'rgba(16, 185, 129, 0.25)';
  } else if (type === 'k8s-node') {
    icon = '💻';
    themeColor = '#9ca3af'; // grey
    borderColor = 'rgba(156, 163, 175, 0.25)';
  }

  // Handle errors
  let statusText = status || state || '';
  if (statusText) {
    const sLower = statusText.toLowerCase();
    if (sLower.includes('fail') || sLower.includes('err') || sLower.includes('crash') || (sLower.includes('exited') && !sLower.includes('(0)'))) {
      themeColor = '#f43f5e'; // rose red
      borderColor = '#f43f5e';
    } else if (sLower.includes('stop') || sLower.includes('exited')) {
      themeColor = '#f59e0b'; // amber
      borderColor = 'rgba(245, 158, 11, 0.5)';
    }
  }

  // Apply Heatmap Overlays
  let heatmapGlow = '';
  if (heatmapMode === 'restarts' && restarts !== undefined && restarts > 0) {
    const intensity = Math.min(restarts / 5, 1);
    themeColor = '#f43f5e';
    borderColor = `rgba(244, 63, 94, ${0.4 + intensity * 0.6})`;
    heatmapGlow = `0 0 16px rgba(244, 63, 94, ${0.5 + intensity * 0.5})`;
  } else if (heatmapMode === 'age' && created) {
    const parsedTime = Date.parse(created.toString());
    if (!isNaN(parsedTime)) {
      const ageMs = Date.now() - parsedTime;
      // If created within the last 15 minutes, glow neon cyan (recently deployed)
      if (ageMs < 15 * 60 * 1000) {
        themeColor = '#06b6d4'; // cyan
        borderColor = '#06b6d4';
        heatmapGlow = '0 0 16px rgba(6, 182, 212, 0.8)';
      } else if (ageMs < 2 * 60 * 60 * 1000) { // last 2 hours
        themeColor = '#22d3ee';
        borderColor = 'rgba(34, 211, 238, 0.6)';
      } else { // long-running, stable resources
        themeColor = '#475569'; // slate grey
        borderColor = 'rgba(71, 85, 105, 0.3)';
      }
    }
  }

  const isHighlighted = isHovered || isFocused;
  const borderStyle = isHighlighted
    ? `2px solid ${themeColor}`
    : `1px solid ${borderColor}`;

  const glowStyle = heatmapGlow
    ? heatmapGlow
    : isHighlighted
      ? `0 0 16px ${themeColor}60, 0 4px 20px rgba(0, 0, 0, 0.4)`
      : `0 4px 12px rgba(0, 0, 0, 0.25)`;

  return (
    <div
      onMouseEnter={() => onHover?.(id)}
      onMouseLeave={() => onHover?.(null)}
      style={{
        background: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(8px)',
        border: borderStyle,
        borderRadius: '10px',
        padding: '10px',
        color: '#f8fafc',
        fontFamily: 'Outfit, sans-serif',
        boxShadow: glowStyle,
        width: type === 'port' ? '80px' : '170px',
        boxSizing: 'border-box',
        fontSize: '11px',
        transition: 'all 0.2s ease',
        textAlign: 'left'
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '11.5px', marginBottom: '4px' }}>
        <span>{icon}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }} title={cardTitle}>
          {cardTitle}
        </span>
        {restarts > 0 && (
          <span style={{ color: '#ef4444', fontSize: '9px', fontWeight: 'bold', background: 'rgba(239, 68, 68, 0.15)', padding: '1px 4px', borderRadius: '4px' }} title={`${restarts} restarts`}>
            ↺{restarts}
          </span>
        )}
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.08)', margin: '4px 0 6px 0' }} />

      {type === 'docker' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>State:</span>
            <span style={{ color: themeColor, fontWeight: 500 }}>{state}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Image:</span>
            <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '95px' }} title={image}>
              {image}
            </span>
          </div>
        </div>
      )}

      {type === 'port' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, color: themeColor }}>:{data.hostPort}</span>
          <span style={{ color: '#94a3b8' }}>→ {data.containerPort}</span>
        </div>
      )}

      {type === 'service' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Type:</span>
            <span style={{ color: '#cbd5e1' }}>{data.svcType}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>IP:</span>
            <span style={{ color: '#cbd5e1' }}>{data.clusterIp}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Ports:</span>
            <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '95px' }} title={ports}>
              {ports}
            </span>
          </div>
        </div>
      )}

      {type === 'deployment' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Replicas:</span>
            <span style={{ color: '#cbd5e1' }}>{ready}/{replicas}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Available:</span>
            <span style={{ color: '#cbd5e1' }}>{data.available}</span>
          </div>
        </div>
      )}

      {type === 'pod' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Status:</span>
            <span style={{ color: themeColor, fontWeight: 500 }}>{status}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Ready:</span>
            <span style={{ color: '#cbd5e1' }}>{ready}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>IP:</span>
            <span style={{ color: '#cbd5e1' }}>{ip}</span>
          </div>
        </div>
      )}

      {type === 'k8s-node' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Status:</span>
            <span style={{ color: themeColor, fontWeight: 500 }}>{status}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Role:</span>
            <span style={{ color: '#cbd5e1' }}>{role}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>IP:</span>
            <span style={{ color: '#cbd5e1' }}>{ip}</span>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});
DevOpsNode.displayName = 'DevOpsNode';

// ─── Custom Group Container Node ────────────────────────────────────────────
const GroupNode = memo(({ data, style }: any) => {
  return (
    <div
      style={{
        ...style,
        position: 'relative',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        pointerEvents: 'none'
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '12px',
          left: '16px',
          fontSize: '11px',
          fontWeight: 700,
          color: data.textColor || '#94a3b8',
          fontFamily: 'Outfit, sans-serif',
          letterSpacing: '0.08em',
          textTransform: 'uppercase'
        }}
      >
        {data.label}
      </div>
    </div>
  );
});
GroupNode.displayName = 'GroupNode';

const nodeTypes = {
  devopsNode: DevOpsNode,
  groupNode: GroupNode
};

export const TopologyGraph: React.FC<TopologyGraphProps> = ({ containers, k8sResources }) => {
  // Navigation & Search State
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNamespace, setSelectedNamespace] = useState('All');
  const [selectedType, setSelectedType] = useState('All');
  const [heatmapMode, setHeatmapMode] = useState<'none' | 'restarts' | 'age'>('none');

  // Selected Detail Drawer state
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<'details' | 'logs' | 'actions' | 'security'>('details');

  // Logs state
  const [logs, setLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  // Actions state
  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scaleReplicas, setScaleReplicas] = useState<number>(1);

  // Security scan state
  const [scanLoading, setScanLoading] = useState(false);
  const [scanResult, setScanResult] = useState<any | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Dynamically extract namespaces
  const namespaces = useMemo(() => {
    const k8s = k8sResources;
    return Array.from(new Set([
      ...k8s.pods.map(p => p.namespace),
      ...k8s.services.map(s => s.namespace),
      ...k8s.deployments.map(d => d.namespace)
    ])).sort();
  }, [k8sResources]);

  // Construct raw nodes and edges based on filters (Namespace and Type only)
  const { nodes: rawNodes, edges: rawEdges } = useMemo(() => {
    const nsNodes: Node[] = [];
    const nsEdges: Edge[] = [];

    const spacingY = 120; // vertical spacing
    const k8s = k8sResources;

    // Filter Docker
    const showDocker = selectedType === 'All' || selectedType === 'Docker';
    const filteredContainers = showDocker ? containers : [];

    // Filter K8s
    const showK8s = selectedType === 'All' || selectedType !== 'Docker';
    const activeNamespaces = selectedNamespace === 'All' ? namespaces : [selectedNamespace];

    const filteredPods = showK8s ? k8s.pods.filter(p => activeNamespaces.includes(p.namespace) && (selectedType === 'All' || selectedType === 'Pod')) : [];
    const filteredSvcs = showK8s ? k8s.services.filter(s => activeNamespaces.includes(s.namespace) && (selectedType === 'All' || selectedType === 'Service')) : [];
    const filteredDeps = showK8s ? k8s.deployments.filter(d => activeNamespaces.includes(d.namespace) && (selectedType === 'All' || selectedType === 'Deployment')) : [];
    const filteredNodes = showK8s && (selectedType === 'All' || selectedType === 'Node') ? k8s.nodes : [];

    // Heights
    const dockerCount = filteredContainers.length;
    const totalDockerHeight = Math.max(1, dockerCount) * spacingY;

    let currentK8sY = 0;
    const nsHeightsMap: { [key: string]: number } = {};
    const nsYOffsetsMap: { [key: string]: number } = {};

    activeNamespaces.forEach(ns => {
      const nsSvcs = filteredSvcs.filter(s => s.namespace === ns);
      const nsDeps = filteredDeps.filter(d => d.namespace === ns);
      const nsPods = filteredPods.filter(p => p.namespace === ns);
      const maxItems = Math.max(nsSvcs.length, nsDeps.length, nsPods.length);
      
      if (maxItems > 0 || filteredNodes.length > 0) {
        const rowHeight = Math.max(1, maxItems) * spacingY;
        nsHeightsMap[ns] = rowHeight;
        nsYOffsetsMap[ns] = currentK8sY;
        currentK8sY += rowHeight + 140;
      }
    });

    const totalK8sHeight = Math.max(spacingY, currentK8sY - 140);
    const maxGlobalHeight = Math.max(totalDockerHeight, totalK8sHeight);

    const dockerYOffsetVal = (maxGlobalHeight - totalDockerHeight) / 2;
    const k8sYOffsetVal = (maxGlobalHeight - totalK8sHeight) / 2;

    // ─── 1. Background Groups ──────────────────────────────────────────
    if (filteredContainers.length > 0) {
      nsNodes.push({
        id: 'docker-group',
        type: 'groupNode',
        position: { x: 70, y: dockerYOffsetVal },
        style: {
          width: 380,
          height: totalDockerHeight + 40,
          background: 'rgba(14, 165, 233, 0.02)',
          border: '1.5px dashed rgba(14, 165, 233, 0.2)',
          borderRadius: '16px',
        },
        data: { label: '🐳 Docker Engine', textColor: '#38bdf8' }
      });
    }

    if (filteredPods.length > 0 || filteredSvcs.length > 0 || filteredDeps.length > 0 || filteredNodes.length > 0) {
      nsNodes.push({
        id: 'k8s-group',
        type: 'groupNode',
        position: { x: 500, y: k8sYOffsetVal },
        style: {
          width: 870,
          height: totalK8sHeight + 40,
          background: 'rgba(139, 92, 246, 0.02)',
          border: '1.5px dashed rgba(139, 92, 246, 0.2)',
          borderRadius: '16px',
        },
        data: { label: '☸️ Kubernetes Cluster', textColor: '#a78bfa' }
      });

      // Namespaces rows
      activeNamespaces.forEach(ns => {
        const rowHeight = nsHeightsMap[ns];
        if (rowHeight === undefined) return;
        const rowYStart = k8sYOffsetVal + nsYOffsetsMap[ns];
        nsNodes.push({
          id: `ns-group-${ns}`,
          type: 'groupNode',
          position: { x: 520, y: rowYStart + 25 },
          style: {
            width: 630,
            height: rowHeight + 10,
            background: 'rgba(255, 255, 255, 0.01)',
            border: '1.2px dashed rgba(147, 197, 253, 0.15)',
            borderRadius: '12px',
          },
          data: { label: `ns: ${ns}`, textColor: '#93c5fd' }
        });
      });
    }

    // ─── 2. Build Docker Nodes & Port Mapping ──────────────────────────────────
    if (filteredContainers.length > 0) {
      filteredContainers.forEach((c, cIdx) => {
        const nodeId = `docker-${c.id.slice(0, 12)}`;
        const containerY = dockerYOffsetVal + (cIdx * spacingY) + 30;
        const isRunning = c.state === 'running';
        const cleanName = c.name.replace(/^themachine-/, '').replace(/-1$/, '');

        nsNodes.push({
          id: nodeId,
          type: 'devopsNode',
          position: { x: 250, y: containerY },
          data: {
            type: 'docker',
            name: cleanName,
            state: c.state,
            status: c.status,
            image: c.image,
            ports: c.ports,
            created: c.created
          }
        });

        // Ports
        if (c.ports && c.ports !== 'None' && isRunning) {
          const portParts = c.ports.split(',');
          const validPorts: string[] = [];
          portParts.forEach(part => {
            if (part.trim().match(/([0-9.]+):([0-9]+)->([0-9]+)/)) {
              validPorts.push(part.trim());
            }
          });

          validPorts.forEach((part, idx) => {
            const match = part.match(/([0-9.]+):([0-9]+)->([0-9]+)/);
            if (match) {
              const hostPort = match[2];
              const containerPort = match[3];
              const portId = `port-${nodeId}-${idx}`;
              
              const pCount = validPorts.length;
              const portSpacing = 45;
              const portY = containerY + 12 - ((pCount - 1) * portSpacing) / 2 + idx * portSpacing;

              nsNodes.push({
                id: portId,
                type: 'devopsNode',
                position: { x: 95, y: portY },
                data: {
                  type: 'port',
                  name: `Port :${hostPort}`,
                  hostPort,
                  containerPort
                }
              });

              nsEdges.push({
                id: `edge-${portId}-${nodeId}`,
                source: portId,
                target: nodeId,
                type: 'smoothstep',
                animated: true,
                style: { stroke: '#818cf8', strokeWidth: 1.5, opacity: 0.8 },
                markerEnd: { type: MarkerType.ArrowClosed, color: '#818cf8', width: 12, height: 12 }
              });
            }
          });
        }
      });
    }

    // ─── 3. Build Kubernetes Nodes ───────────────────────────────────────────
    if (filteredNodes.length > 0) {
      const k8sNodeCount = filteredNodes.length;
      const k8sNodesStartY = k8sYOffsetVal + (totalK8sHeight - (k8sNodeCount - 1) * spacingY) / 2 + 30;

      filteredNodes.forEach((n, idx) => {
        const nodeId = `k8snode-${n.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

        nsNodes.push({
          id: nodeId,
          type: 'devopsNode',
          position: { x: 1180, y: k8sNodesStartY + idx * spacingY },
          data: {
            type: 'k8s-node',
            name: n.name,
            status: n.status,
            role: n.role,
            ip: n.ip,
            created: n.created
          }
        });
      });
    }

    activeNamespaces.forEach(ns => {
      const nsSvcs = filteredSvcs.filter(s => s.namespace === ns);
      const nsDeps = filteredDeps.filter(d => d.namespace === ns);
      const nsPods = filteredPods.filter(p => p.namespace === ns);

      const rowHeight = nsHeightsMap[ns];
      if (rowHeight === undefined) return;
      const rowYStart = k8sYOffsetVal + nsYOffsetsMap[ns] + 30;

      // Services (X = 540)
      const svcStartY = rowYStart + (rowHeight - (nsSvcs.length - 1) * spacingY) / 2;
      nsSvcs.forEach((s, sIdx) => {
        const svcId = `svc-${ns}-${s.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const cleanPorts = s.ports && s.ports !== 'None' ? s.ports : 'None';
        const portsTrunc = cleanPorts.length > 18 ? cleanPorts.slice(0, 16) + '…' : cleanPorts;

        nsNodes.push({
          id: svcId,
          type: 'devopsNode',
          position: { x: 540, y: svcStartY + sIdx * spacingY },
          data: {
            type: 'service',
            name: s.name,
            svcType: s.type,
            clusterIp: s.clusterIp,
            ports: portsTrunc,
            created: s.created
          }
        });
      });

      // Deployments (X = 750)
      const depStartY = rowYStart + (rowHeight - (nsDeps.length - 1) * spacingY) / 2;
      nsDeps.forEach((d, dIdx) => {
        const depId = `deploy-${ns}-${d.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

        nsNodes.push({
          id: depId,
          type: 'devopsNode',
          position: { x: 750, y: depStartY + dIdx * spacingY },
          data: {
            type: 'deployment',
            name: d.name,
            ready: d.ready,
            replicas: d.replicas,
            available: d.available,
            created: d.created
          }
        });
      });

      // Pods (X = 960)
      const podStartY = rowYStart + (rowHeight - (nsPods.length - 1) * spacingY) / 2;
      nsPods.forEach((p, pIdx) => {
        const podId = `pod-${ns}-${p.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const containerInfo = (p.containers || []).map((c: any) => `${c.name}: ${c.image}`).join('\n');

        nsNodes.push({
          id: podId,
          type: 'devopsNode',
          position: { x: 960, y: podStartY + pIdx * spacingY },
          data: {
            type: 'pod',
            name: p.name,
            status: p.status,
            ready: p.ready,
            ip: p.ip,
            restarts: p.restarts,
            containers: containerInfo,
            created: p.created
          }
        });

        // Connection: Deployment → Pod
        nsDeps.forEach(d => {
          if (p.name.startsWith(d.name)) {
            const depId = `deploy-${ns}-${d.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
            nsEdges.push({
              id: `edge-${depId}-${podId}`,
              source: depId,
              target: podId,
              type: 'smoothstep',
              style: { stroke: '#a78bfa', strokeWidth: 2, opacity: 0.8 },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#a78bfa', width: 12, height: 12 }
            });
          }
        });

        // Connection: Pod → Node
        if (p.node && p.node !== 'None') {
          const hostNodeId = `k8snode-${p.node.replace(/[^a-zA-Z0-9]/g, '_')}`;
          nsEdges.push({
            id: `edge-${hostNodeId}-${podId}`,
            source: hostNodeId,
            target: podId,
            type: 'smoothstep',
            style: { stroke: '#9ca3af', strokeWidth: 1.5, strokeDasharray: '4,4', opacity: 0.6 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#9ca3af', width: 12, height: 12 }
          });
        }
      });

      // Route Service → Pod
      nsSvcs.forEach(s => {
        const svcId = `svc-${ns}-${s.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        nsPods.forEach(p => {
          let matched = false;
          if (s.selector && s.selector !== 'None') {
            try {
              const sel = JSON.parse(s.selector);
              matched = Object.keys(sel).every((key: string) => p.name.includes(s.name) || p.name.includes(sel[key]));
            } catch {
              matched = p.name.includes(s.name);
            }
          } else {
            matched = p.name.includes(s.name);
          }
          if (matched) {
            const podId = `pod-${ns}-${p.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
            nsEdges.push({
              id: `edge-${svcId}-${podId}`,
              source: svcId,
              target: podId,
              type: 'smoothstep',
              animated: true,
              style: { stroke: '#fbbf24', strokeWidth: 2, strokeDasharray: '5,5', opacity: 0.8 },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#fbbf24', width: 12, height: 12 }
            });
          }
        });
      });
    });

    // Cross-Panel Backing Process & Node Mapping
    if (filteredContainers.length > 0 && filteredPods.length > 0) {
      filteredPods.forEach(p => {
        const podId = `pod-${p.namespace}-${p.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        filteredContainers.forEach(c => {
          if (c.name.startsWith('k8s_')) {
            const parts = c.name.split('_');
            if (parts.length >= 4) {
              const containerPodName = parts[2];
              const containerNamespace = parts[3];
              if (containerPodName === p.name && containerNamespace === p.namespace) {
                const dockerNodeId = `docker-${c.id.slice(0, 12)}`;
                nsEdges.push({
                  id: `edge-${podId}-${dockerNodeId}`,
                  source: podId,
                  target: dockerNodeId,
                  type: 'bezier',
                  style: { stroke: '#38bdf8', strokeWidth: 1.2, strokeDasharray: '3,3', opacity: 0.15 },
                  markerEnd: { type: MarkerType.ArrowClosed, color: '#38bdf8', width: 10, height: 10 }
                });
              }
            }
          }
        });
      });
    }

    if (filteredContainers.length > 0 && filteredNodes.length > 0) {
      filteredNodes.forEach(n => {
        const nodeId = `k8snode-${n.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        filteredContainers.forEach(c => {
          if (c.name === n.name || c.name.includes(n.name) || n.name.includes(c.name)) {
            const dockerNodeId = `docker-${c.id.slice(0, 12)}`;
            nsEdges.push({
              id: `edge-${nodeId}-${dockerNodeId}`,
              source: nodeId,
              target: dockerNodeId,
              type: 'bezier',
              style: { stroke: '#38bdf8', strokeWidth: 1.2, strokeDasharray: '3,3', opacity: 0.15 },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#38bdf8', width: 10, height: 10 }
            });
          }
        });
      });
    }

    return {
      nodes: nsNodes,
      edges: nsEdges
    };
  }, [containers, k8sResources, selectedNamespace, selectedType]);

  // Find neighbors of the hovered node
  const neighboringNodeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const neighbors = new Set<string>([hoveredNodeId]);
    
    rawEdges.forEach(e => {
      if (e.source === hoveredNodeId) {
        neighbors.add(e.target);
      } else if (e.target === hoveredNodeId) {
        neighbors.add(e.source);
      }
    });
    
    return neighbors;
  }, [hoveredNodeId, rawEdges]);

  // Determine if a node matches the active search term
  const matchesSearch = useCallback((node: Node) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    const name = (node.data?.name || '').toLowerCase();
    const type = (node.data?.type || '').toLowerCase();
    const stateVal = (node.data?.state || node.data?.status || '').toLowerCase();
    const ipVal = (node.data?.ip || '').toLowerCase();
    const imageVal = (node.data?.image || '').toLowerCase();
    const portsVal = (node.data?.ports || '').toLowerCase();

    return (
      name.includes(term) ||
      type.includes(term) ||
      stateVal.includes(term) ||
      ipVal.includes(term) ||
      imageVal.includes(term) ||
      portsVal.includes(term)
    );
  }, [searchTerm]);

  // Map raw nodes & inject states (search matching, dimming, hover states)
  const flowNodes = useMemo(() => {
    return rawNodes.map(node => {
      if (node.type === 'groupNode') return node;

      const isHovered = hoveredNodeId === node.id;
      const isFocused = neighboringNodeIds.has(node.id);
      
      const searchMatch = matchesSearch(node);
      const isDimmed = (!!hoveredNodeId && !isFocused) || (!!searchTerm && !searchMatch);
      const isSearchHighlighted = !!searchTerm && searchMatch;

      return {
        ...node,
        data: {
          ...node.data,
          isHovered,
          isFocused,
          isSearchHighlighted,
          heatmapMode,
          onHover: setHoveredNodeId
        },
        style: {
          opacity: isDimmed ? 0.22 : 1,
          transition: 'opacity 0.2s ease',
        }
      };
    });
  }, [rawNodes, hoveredNodeId, neighboringNodeIds, matchesSearch, searchTerm, heatmapMode]);

  // Map raw edges & inject states (hover paths)
  const flowEdges = useMemo(() => {
    return rawEdges.map(edge => {
      const isHovered = hoveredNodeId === edge.source || hoveredNodeId === edge.target;
      const isDimmed = !!hoveredNodeId && !isHovered;
      const isCrossPanel = edge.id.includes('pod-') && edge.id.includes('docker-') || edge.id.includes('k8snode-') && edge.id.includes('docker-');

      let edgeStyle = { ...edge.style };
      if (isDimmed) {
        edgeStyle.opacity = 0.08;
      } else if (isHovered) {
        edgeStyle.stroke = '#f43f5e'; // pink glow on hover
        edgeStyle.strokeWidth = 3;
        edgeStyle.opacity = 1;
      } else if (isCrossPanel) {
        edgeStyle.opacity = 0.15;
      }

      let markerEnd = edge.markerEnd;
      if (isHovered) {
        markerEnd = typeof markerEnd === 'object' ? { ...markerEnd, color: '#f43f5e' } : markerEnd;
      }

      return {
        ...edge,
        style: edgeStyle,
        markerEnd
      };
    });
  }, [rawEdges, hoveredNodeId]);

  // Bind node click to open details drawer
  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    if (node.type === 'devopsNode') {
      setSelectedNodeId(node.id);
      setDrawerTab('details');
      // Clear secondary panels
      setLogs('');
      setLogsError(null);
      setActionResult(null);
      setActionError(null);
      setScanResult(null);
      setScanError(null);
    }
  }, []);

  // Map the selectedNodeId to its corresponding rich raw resource
  const selectedResource = useMemo(() => {
    if (!selectedNodeId) return null;

    if (selectedNodeId.startsWith('docker-')) {
      const shortId = selectedNodeId.replace('docker-', '');
      const container = containers.find(c => c.id.startsWith(shortId));
      if (container) return { type: 'docker', data: container };
    }

    if (selectedNodeId.startsWith('port-')) {
      const parts = selectedNodeId.split('-');
      const shortId = parts[2];
      const container = containers.find(c => c.id.startsWith(shortId));
      return { type: 'port', data: { id: selectedNodeId, parentContainer: container } };
    }

    if (selectedNodeId.startsWith('svc-')) {
      const match = selectedNodeId.match(/^svc-([^-]+)-(.*)$/);
      if (match) {
        const ns = match[1];
        const rawName = match[2];
        const svc = k8sResources.services.find(s => s.namespace === ns && s.name.replace(/[^a-zA-Z0-9]/g, '_') === rawName);
        if (svc) return { type: 'service', data: svc };
      }
    }

    if (selectedNodeId.startsWith('deploy-')) {
      const match = selectedNodeId.match(/^deploy-([^-]+)-(.*)$/);
      if (match) {
        const ns = match[1];
        const rawName = match[2];
        const dep = k8sResources.deployments.find(d => d.namespace === ns && d.name.replace(/[^a-zA-Z0-9]/g, '_') === rawName);
        if (dep) return { type: 'deployment', data: dep };
      }
    }

    if (selectedNodeId.startsWith('pod-')) {
      const match = selectedNodeId.match(/^pod-([^-]+)-(.*)$/);
      if (match) {
        const ns = match[1];
        const rawName = match[2];
        const pod = k8sResources.pods.find(p => p.namespace === ns && p.name.replace(/[^a-zA-Z0-9]/g, '_') === rawName);
        if (pod) return { type: 'pod', data: pod };
      }
    }

    if (selectedNodeId.startsWith('k8snode-')) {
      const rawName = selectedNodeId.replace('k8snode-', '');
      const node = k8sResources.nodes.find(n => n.name.replace(/[^a-zA-Z0-9]/g, '_') === rawName);
      if (node) return { type: 'k8s-node', data: node };
    }

    return null;
  }, [selectedNodeId, containers, k8sResources]);

  // Drawer action helper functions
  const fetchLogs = async () => {
    if (!selectedResource) return;
    setLoadingLogs(true);
    setLogsError(null);
    setLogs('');
    try {
      let url = '';
      if (selectedResource.type === 'docker') {
        url = `/api/docker/logs/${selectedResource.data.id}`;
      } else if (selectedResource.type === 'pod') {
        url = `/api/k8s/logs/${selectedResource.data.namespace}/${selectedResource.data.name}`;
      }
      if (url) {
        const res = await fetch(url);
        const json = await res.json();
        if (res.ok) {
          setLogs(json.logs || 'No logs returned.');
        } else {
          setLogsError(json.error || 'Failed to fetch logs.');
        }
      }
    } catch (err: any) {
      setLogsError(err.message || 'Error occurred fetching logs.');
    } finally {
      setLoadingLogs(false);
    }
  };

  const triggerAction = async (actionName: string, extraParams: any = {}) => {
    if (!selectedResource) return;
    setActionLoading(true);
    setActionResult(null);
    setActionError(null);
    try {
      let url = '';
      let body: any = {};
      
      if (selectedResource.type === 'docker') {
        url = '/api/docker/action';
        body = { action: actionName, containerId: selectedResource.data.id };
      } else if (selectedResource.type === 'pod' || selectedResource.type === 'deployment') {
        url = '/api/k8s/action';
        body = {
          action: actionName,
          name: selectedResource.data.name,
          namespace: selectedResource.data.namespace,
          ...extraParams
        };
      }
      
      if (url) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (res.ok) {
          setActionResult(json.message || 'Action executed successfully.');
        } else {
          setActionError(json.error || json.details || 'Action failed.');
        }
      }
    } catch (err: any) {
      setActionError(err.message || 'Error occurred executing action.');
    } finally {
      setActionLoading(false);
    }
  };

  const runSecurityScan = async () => {
    if (!selectedResource || selectedResource.type !== 'docker') return;
    setScanLoading(true);
    setScanResult(null);
    setScanError(null);
    try {
      const res = await fetch('/api/docker/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageName: selectedResource.data.image })
      });
      const json = await res.json();
      if (res.ok) {
        setScanResult(json);
      } else {
        setScanError(json.error || json.details || 'Scan failed.');
      }
    } catch (err: any) {
      setScanError(err.message || 'Error occurred executing scan.');
    } finally {
      setScanLoading(false);
    }
  };

  // Fetch logs when tab changes to Logs
  useEffect(() => {
    if (drawerTab === 'logs' && selectedResource) {
      fetchLogs();
    }
  }, [drawerTab]);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {/* ─── Search & Interactive Filter Controls Header ─── */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          flexWrap: 'wrap',
          background: 'rgba(15, 23, 42, 0.4)',
          border: '1px solid rgba(255,255,255,0.06)',
          padding: '10px 16px',
          borderRadius: '10px',
          marginBottom: '12px',
          fontFamily: 'Outfit, sans-serif'
        }}
      >
        {/* Search */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: '200px' }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', color: '#64748b' }} />
          <input
            type="text"
            placeholder="Search name, type, state, IP or ports..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(2, 6, 23, 0.6)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '6px',
              padding: '6px 12px 6px 30px',
              color: '#f8fafc',
              fontSize: '12.5px',
              outline: 'none',
              transition: 'border-color 0.2s',
              fontFamily: 'inherit'
            }}
          />
          {searchTerm && (
            <X
              size={12}
              onClick={() => setSearchTerm('')}
              style={{ position: 'absolute', right: '10px', color: '#64748b', cursor: 'pointer' }}
            />
          )}
        </div>

        {/* Namespace filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Sliders size={12} style={{ color: '#94a3b8' }} />
          <select
            value={selectedNamespace}
            onChange={(e) => setSelectedNamespace(e.target.value)}
            style={{
              background: 'rgba(2, 6, 23, 0.6)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '6px',
              color: '#f8fafc',
              padding: '6px 10px',
              fontSize: '12px',
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            <option value="All">All Namespaces</option>
            {namespaces.map(ns => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
        </div>

        {/* Type filter */}
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          style={{
            background: 'rgba(2, 6, 23, 0.6)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '6px',
            color: '#f8fafc',
            padding: '6px 10px',
            fontSize: '12px',
            outline: 'none',
            cursor: 'pointer'
          }}
        >
          <option value="All">All Resource Types</option>
          <option value="Docker">Docker Containers</option>
          <option value="Pod">Kubernetes Pods</option>
          <option value="Service">Kubernetes Services</option>
          <option value="Deployment">Kubernetes Deployments</option>
          <option value="Node">Kubernetes Host Nodes</option>
        </select>

        {/* Heatmap settings */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            background: 'rgba(2, 6, 23, 0.4)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '6px',
            overflow: 'hidden'
          }}
        >
          <button
            onClick={() => setHeatmapMode('none')}
            style={{
              background: heatmapMode === 'none' ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: heatmapMode === 'none' ? '#fff' : '#94a3b8',
              border: 'none',
              padding: '6px 10px',
              fontSize: '11px',
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            Heatmap: Off
          </button>
          <button
            onClick={() => setHeatmapMode('restarts')}
            style={{
              background: heatmapMode === 'restarts' ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
              color: heatmapMode === 'restarts' ? '#f43f5e' : '#94a3b8',
              border: 'none',
              padding: '6px 10px',
              fontSize: '11px',
              cursor: 'pointer',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <Activity size={11} /> Restarts
          </button>
          <button
            onClick={() => setHeatmapMode('age')}
            style={{
              background: heatmapMode === 'age' ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
              color: heatmapMode === 'age' ? '#06b6d4' : '#94a3b8',
              border: 'none',
              padding: '6px 10px',
              fontSize: '11px',
              cursor: 'pointer',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <Clock size={11} /> Age / Freshness
          </button>
        </div>
      </div>

      {/* ─── Graph Canvas Container ─── */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '580px',
          background: 'rgba(2, 6, 23, 0.6)',
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.06)',
          overflow: 'hidden'
        }}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.2}
          maxZoom={1.5}
          zoomOnScroll={true}
          panOnScroll={false}
          preventScrolling={false}
          nodesConnectable={false}
          nodesDraggable={true}
        >
          <Background color="rgba(255,255,255,0.05)" gap={16} size={1} />
          <Controls
            showInteractive={false}
            style={{
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#fff',
              borderRadius: '8px',
              overflow: 'hidden'
            }}
          />
        </ReactFlow>

        {/* ─── Interactive Details Sliding Drawer Drawer ─── */}
        {selectedResource && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: '380px',
              height: '100%',
              background: 'rgba(9, 15, 30, 0.95)',
              backdropFilter: 'blur(16px)',
              borderLeft: '1px solid rgba(255,255,255,0.08)',
              zIndex: 1000,
              padding: '16px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              color: '#f8fafc',
              fontFamily: 'Outfit, sans-serif',
              boxShadow: '-10px 0 30px rgba(0,0,0,0.5)'
            }}
          >
            {/* Drawer Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '10px', textTransform: 'uppercase', color: '#64748b', fontWeight: 'bold', letterSpacing: '0.05em' }}>
                  {selectedResource.type === 'docker' ? 'Docker Container' : `Kubernetes ${selectedResource.type}`}
                </span>
                <span style={{ fontSize: '15px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '300px' }}>
                  {selectedResource.data.name}
                </span>
              </div>
              <X
                size={18}
                onClick={() => setSelectedNodeId(null)}
                style={{ color: '#94a3b8', cursor: 'pointer', hover: { color: '#fff' } } as any}
              />
            </div>

            {/* Tab navigation */}
            <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: '14px' }}>
              <button
                onClick={() => setDrawerTab('details')}
                style={{
                  background: 'transparent',
                  color: drawerTab === 'details' ? '#38bdf8' : '#94a3b8',
                  border: 'none',
                  borderBottom: drawerTab === 'details' ? '2px solid #38bdf8' : 'none',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontWeight: 500
                }}
              >
                Details
              </button>

              {(selectedResource.type === 'docker' || selectedResource.type === 'pod') && (
                <button
                  onClick={() => setDrawerTab('logs')}
                  style={{
                    background: 'transparent',
                    color: drawerTab === 'logs' ? '#38bdf8' : '#94a3b8',
                    border: 'none',
                    borderBottom: drawerTab === 'logs' ? '2px solid #38bdf8' : 'none',
                    padding: '6px 12px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    fontWeight: 500
                  }}
                >
                  Logs
                </button>
              )}

              {(selectedResource.type === 'docker' || selectedResource.type === 'pod' || selectedResource.type === 'deployment') && (
                <button
                  onClick={() => setDrawerTab('actions')}
                  style={{
                    background: 'transparent',
                    color: drawerTab === 'actions' ? '#38bdf8' : '#94a3b8',
                    border: 'none',
                    borderBottom: drawerTab === 'actions' ? '2px solid #38bdf8' : 'none',
                    padding: '6px 12px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    fontWeight: 500
                  }}
                >
                  Actions
                </button>
              )}

              {selectedResource.type === 'docker' && (
                <button
                  onClick={() => setDrawerTab('security')}
                  style={{
                    background: 'transparent',
                    color: drawerTab === 'security' ? '#38bdf8' : '#94a3b8',
                    border: 'none',
                    borderBottom: drawerTab === 'security' ? '2px solid #38bdf8' : 'none',
                    padding: '6px 12px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    fontWeight: 500
                  }}
                >
                  Security
                </button>
              )}
            </div>

            {/* Drawer Tab Contents */}
            <div style={{ flexGrow: 1, overflowY: 'auto', fontSize: '12px', boxSizing: 'border-box' }}>
              {/* Tab 1: Details */}
              {drawerTab === 'details' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '8px 0', color: '#64748b', width: '90px' }}>Namespace</td>
                        <td style={{ padding: '8px 0', fontWeight: 500 }}>{selectedResource.data.namespace || 'N/A (Docker)'}</td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '8px 0', color: '#64748b' }}>Status</td>
                        <td style={{ padding: '8px 0', fontWeight: 500, color: selectedResource.data.state === 'running' || selectedResource.data.status === 'Running' || selectedResource.data.status === 'Ready' ? '#10b981' : '#f59e0b' }}>
                          ● {selectedResource.data.state || selectedResource.data.status}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '8px 0', color: '#64748b' }}>Age</td>
                        <td style={{ padding: '8px 0', fontWeight: 500 }}>
                          <Clock size={11} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
                          {formatAge(selectedResource.data.created)}
                        </td>
                      </tr>
                      {selectedResource.data.ip && (
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 0', color: '#64748b' }}>IP Address</td>
                          <td style={{ padding: '8px 0', fontFamily: 'monospace' }}>{selectedResource.data.ip}</td>
                        </tr>
                      )}
                      {selectedResource.data.clusterIp && (
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 0', color: '#64748b' }}>Cluster IP</td>
                          <td style={{ padding: '8px 0', fontFamily: 'monospace' }}>{selectedResource.data.clusterIp}</td>
                        </tr>
                      )}
                      {selectedResource.data.ports && (
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 0', color: '#64748b' }}>Port Maps</td>
                          <td style={{ padding: '8px 0', fontSize: '11px', fontFamily: 'monospace' }}>{selectedResource.data.ports}</td>
                        </tr>
                      )}
                      {selectedResource.data.image && (
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 0', color: '#64748b' }}>Docker Image</td>
                          <td style={{ padding: '8px 0', fontSize: '11px', color: '#93c5fd', wordBreak: 'break-all' }}>{selectedResource.data.image}</td>
                        </tr>
                      )}
                      {selectedResource.data.role && (
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 0', color: '#64748b' }}>Node Role</td>
                          <td style={{ padding: '8px 0' }}>{selectedResource.data.role}</td>
                        </tr>
                      )}
                      {selectedResource.data.version && (
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 0', color: '#64748b' }}>kubelet</td>
                          <td style={{ padding: '8px 0' }}>{selectedResource.data.version} ({selectedResource.data.os})</td>
                        </tr>
                      )}
                    </tbody>
                  </table>

                  {/* K8s Pod internal containers */}
                  {selectedResource.type === 'pod' && selectedResource.data.containers && (
                    <div style={{ marginTop: '10px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Pod Containers ({selectedResource.data.ready})
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                        {selectedResource.data.containers.map((c: any, idx: number) => (
                          <div key={idx} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px', padding: '8px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                              <span>{c.name}</span>
                              <span style={{ color: c.ready ? '#10b981' : '#f59e0b', fontSize: '10px' }}>
                                {c.ready ? 'Ready' : 'Not Ready'} ({c.state})
                              </span>
                            </div>
                            <div style={{ fontSize: '10px', color: '#94a3b8', wordBreak: 'break-all', marginTop: '4px' }}>
                              Image: {c.image}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Logs */}
              {drawerTab === 'logs' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#94a3b8' }}>Live Container Logs (Tail 150 lines)</span>
                    <button
                      onClick={fetchLogs}
                      disabled={loadingLogs}
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '4px',
                        color: '#fff',
                        padding: '4px 8px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                    >
                      <RefreshCw size={10} className={loadingLogs ? 'animate-spin' : ''} /> Refresh
                    </button>
                  </div>

                  {loadingLogs ? (
                    <div style={{ padding: '30px 0', textAlign: 'center', color: '#94a3b8' }}>
                      <RefreshCw size={18} className="animate-spin" style={{ display: 'block', margin: '0 auto 10px auto' }} /> Loading container logs...
                    </div>
                  ) : logsError ? (
                    <div style={{ background: 'rgba(244,63,94,0.1)', border: '1px solid #f43f5e', color: '#f43f5e', padding: '10px', borderRadius: '6px' }}>
                      <AlertTriangle size={14} style={{ display: 'inline', marginRight: '4px' }} />
                      {logsError}
                    </div>
                  ) : (
                    <pre
                      style={{
                        background: '#020617',
                        color: '#38bdf8',
                        padding: '10px',
                        borderRadius: '6px',
                        fontFamily: 'monospace',
                        fontSize: '10px',
                        overflowX: 'auto',
                        overflowY: 'auto',
                        maxHeight: '360px',
                        margin: 0,
                        border: '1px solid rgba(255,255,255,0.04)',
                        textAlign: 'left',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all'
                      }}
                    >
                      {logs}
                    </pre>
                  )}
                </div>
              )}

              {/* Tab 3: Actions */}
              {drawerTab === 'actions' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <span style={{ color: '#94a3b8' }}>Trigger Runtime CLI Actions</span>

                  {actionLoading && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#38bdf8', background: 'rgba(56,189,248,0.08)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(56,189,248,0.2)' }}>
                      <RefreshCw size={12} className="animate-spin" /> Executing command on host...
                    </div>
                  )}

                  {actionResult && (
                    <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981', color: '#10b981', padding: '10px', borderRadius: '6px' }}>
                      {actionResult}
                    </div>
                  )}

                  {actionError && (
                    <div style={{ background: 'rgba(244,63,94,0.1)', border: '1px solid #f43f5e', color: '#f43f5e', padding: '10px', borderRadius: '6px' }}>
                      <AlertTriangle size={14} style={{ display: 'inline', marginRight: '4px' }} />
                      {actionError}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                    {/* Docker Actions */}
                    {selectedResource.type === 'docker' && (
                      <>
                        <button
                          disabled={actionLoading}
                          onClick={() => triggerAction('start')}
                          style={{
                            background: '#10b981',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontWeight: 600
                          }}
                        >
                          <Play size={12} /> Start Container
                        </button>
                        <button
                          disabled={actionLoading}
                          onClick={() => triggerAction('stop')}
                          style={{
                            background: '#f59e0b',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontWeight: 600
                          }}
                        >
                          <Square size={12} /> Stop Container
                        </button>
                        <button
                          disabled={actionLoading}
                          onClick={() => triggerAction('restart')}
                          style={{
                            background: '#8b5cf6',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontWeight: 600
                          }}
                        >
                          <RotateCw size={12} /> Restart Container
                        </button>
                        <button
                          disabled={actionLoading}
                          onClick={() => triggerAction('remove')}
                          style={{
                            background: 'rgba(239,68,68,0.1)',
                            border: '1px solid #ef4444',
                            color: '#ef4444',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontWeight: 600
                          }}
                        >
                          <Trash2 size={12} /> Delete Container (Force)
                        </button>
                      </>
                    )}

                    {/* K8s Pod Actions */}
                    {selectedResource.type === 'pod' && (
                      <button
                        disabled={actionLoading}
                        onClick={() => triggerAction('delete_pod')}
                        style={{
                          background: '#ef4444',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '8px 12px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          fontWeight: 600
                        }}
                      >
                        <Trash2 size={12} /> Terminate & Delete Pod
                      </button>
                    )}

                    {/* K8s Deployment Actions */}
                    {selectedResource.type === 'deployment' && (
                      <>
                        <button
                          disabled={actionLoading}
                          onClick={() => triggerAction('restart_deploy')}
                          style={{
                            background: '#8b5cf6',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontWeight: 600
                          }}
                        >
                          <RotateCw size={12} /> Rollout Restart
                        </button>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px' }}>
                          <label style={{ fontSize: '11px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Scale size={11} /> Scale Deployment (Replicas)
                          </label>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <input
                              type="number"
                              min="0"
                              max="10"
                              value={scaleReplicas}
                              onChange={(e) => setScaleReplicas(parseInt(e.target.value) || 0)}
                              style={{
                                width: '60px',
                                background: 'rgba(2, 6, 23, 0.6)',
                                border: '1px solid rgba(255,255,255,0.08)',
                                borderRadius: '6px',
                                padding: '6px',
                                color: '#fff',
                                outline: 'none',
                                textAlign: 'center'
                              }}
                            />
                            <button
                              disabled={actionLoading}
                              onClick={() => triggerAction('scale_deploy', { replicas: scaleReplicas })}
                              style={{
                                flexGrow: 1,
                                background: '#10b981',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '6px',
                                padding: '6px 12px',
                                cursor: 'pointer',
                                fontWeight: 600
                              }}
                            >
                              Apply Scaling
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Tab 4: Security Scan */}
              {drawerTab === 'security' && selectedResource.type === 'docker' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#94a3b8' }}>Image Vulnerability Scanning</span>
                    <button
                      disabled={scanLoading}
                      onClick={runSecurityScan}
                      style={{
                        background: '#38bdf8',
                        color: '#0f172a',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                    >
                      <Shield size={11} /> Run Scout Scan
                    </button>
                  </div>

                  {scanLoading && (
                    <div style={{ padding: '30px 0', textAlign: 'center', color: '#94a3b8' }}>
                      <RefreshCw size={18} className="animate-spin" style={{ display: 'block', margin: '0 auto 10px auto' }} /> Scanning Docker image layers...
                    </div>
                  )}

                  {scanError && (
                    <div style={{ background: 'rgba(244,63,94,0.1)', border: '1px solid #f43f5e', color: '#f43f5e', padding: '10px', borderRadius: '6px' }}>
                      <AlertTriangle size={14} style={{ display: 'inline', marginRight: '4px' }} />
                      {scanError}
                    </div>
                  )}

                  {scanResult && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {/* Vulcan summary badges */}
                      <div style={{ display: 'flex', justifyItems: 'stretch', gap: '6px' }}>
                        <div style={{ flexGrow: 1, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                          <div style={{ color: '#ef4444', fontSize: '16px', fontWeight: 'bold' }}>{scanResult.critical || 0}</div>
                          <div style={{ fontSize: '8px', color: '#ef4444', textTransform: 'uppercase', fontWeight: 600 }}>Critical</div>
                        </div>
                        <div style={{ flexGrow: 1, background: 'rgba(249, 115, 22, 0.1)', border: '1px solid #f97316', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                          <div style={{ color: '#f97316', fontSize: '16px', fontWeight: 'bold' }}>{scanResult.high || 0}</div>
                          <div style={{ fontSize: '8px', color: '#f97316', textTransform: 'uppercase', fontWeight: 600 }}>High</div>
                        </div>
                        <div style={{ flexGrow: 1, background: 'rgba(234, 179, 8, 0.1)', border: '1px solid #eab308', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                          <div style={{ color: '#eab308', fontSize: '16px', fontWeight: 'bold' }}>{scanResult.medium || 0}</div>
                          <div style={{ fontSize: '8px', color: '#eab308', textTransform: 'uppercase', fontWeight: 600 }}>Medium</div>
                        </div>
                        <div style={{ flexGrow: 1, background: 'rgba(100, 116, 139, 0.1)', border: '1px solid #64748b', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                          <div style={{ color: '#94a3b8', fontSize: '16px', fontWeight: 'bold' }}>{scanResult.low || 0}</div>
                          <div style={{ fontSize: '8px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Low</div>
                        </div>
                      </div>

                      {/* Scan Recommendation */}
                      {scanResult.recommendation && (
                        <div style={{ background: 'rgba(56, 189, 248, 0.08)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: '6px', padding: '10px' }}>
                          <div style={{ fontWeight: 600, color: '#38bdf8', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Info size={12} /> Recommendation
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#cbd5e1', lineHeight: 1.4 }}>{scanResult.recommendation}</p>
                        </div>
                      )}

                      {/* CVE Vulnerabilities list */}
                      {scanResult.vulnerabilities && scanResult.vulnerabilities.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                          <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' }}>Vulnerability List</span>
                          <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {scanResult.vulnerabilities.map((v: any, idx: number) => (
                              <div key={idx} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '6px', padding: '6px 8px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                                  <span style={{ color: '#38bdf8' }}>{v.cve}</span>
                                  <span style={{
                                    fontSize: '9px',
                                    fontWeight: 'bold',
                                    color: v.severity === 'Critical' ? '#ef4444' : v.severity === 'High' ? '#f97316' : '#eab308',
                                    background: v.severity === 'Critical' ? 'rgba(239,68,68,0.1)' : 'rgba(249,115,22,0.1)',
                                    padding: '1px 4px',
                                    borderRadius: '3px'
                                  }}>
                                    {v.severity}
                                  </span>
                                </div>
                                <div style={{ fontSize: '10px', color: '#cbd5e1', marginTop: '2px' }}>Package: {v.package}</div>
                                <p style={{ fontSize: '10px', color: '#94a3b8', margin: '4px 0 0 0', lineHeight: 1.3 }}>{v.desc}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Legend / Info Footer */}
      <div style={{
        display: 'flex', gap: '16px', marginTop: '10px', flexWrap: 'wrap',
        padding: '8px 4px', fontSize: '11px', color: 'var(--text-muted)'
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#0ea5e9', display: 'inline-block' }}></span> Docker
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#10b981', display: 'inline-block' }}></span> Pod
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#a78bfa', display: 'inline-block' }}></span> Deployment
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', border: '2px solid #f59e0b', background: 'transparent', display: 'inline-block' }}></span> Service
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#9ca3af', display: 'inline-block' }}></span> K8s Node
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', border: '1.5px dashed #818cf8', background: 'transparent', display: 'inline-block' }}></span> Port
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', opacity: 0.6 }}>
          Click card to inspect & act · Drag cards/canvas to pan · Scroll to zoom
        </span>
      </div>
    </div>
  );
};

export default TopologyGraph;
