import React, { useMemo, useState, memo, useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  ReactFlowProvider,
  useReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath
} from 'reactflow';
import type { NodeProps, Node, Edge, EdgeProps } from 'reactflow';
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
  Info,
  Maximize2,
  Minimize2,
  Container,
  Plug,
  Zap,
  Rocket,
  Box,
  Server,
  Network
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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

// ─── Custom Premium DevOps Card Node ────────────────────────────────────────
const DevOpsNode = memo(({ id, data }: NodeProps) => {
  const { type, name, status, ip, ports, image, ready, replicas, role, state, isHovered, isFocused, onHover, heatmapMode, restarts, created } = data;

  // Theme configuration per resource type — one flat accent color each, no gradients
  const themes: Record<string, { icon: LucideIcon; color: string; label: string }> = {
    'docker':     { icon: Container, color: '#38bdf8', label: 'CONTAINER' },
    'port':       { icon: Plug, color: '#818cf8', label: 'PORT' },
    'service':    { icon: Zap, color: '#fbbf24', label: 'SERVICE' },
    'deployment': { icon: Rocket, color: '#a78bfa', label: 'DEPLOYMENT' },
    'pod':        { icon: Box, color: '#34d399', label: 'POD' },
    'k8s-node':   { icon: Server, color: '#94a3b8', label: 'NODE' },
  };

  const theme = themes[type] || themes['docker'];
  let accentColor = theme.color;

  // Status-based color overrides. LED behaves like a real server indicator light:
  // solid glow = healthy, fast blink = down/error, slow blink = pending/starting, dim static = stopped.
  let statusText = status || state || '';
  let statusDotColor = '#10b981'; // default green
  let ledMode: 'glow' | 'blink-fast' | 'blink-slow' | 'off' = 'glow';

  if (statusText) {
    const sLower = statusText.toLowerCase();
    if (sLower.includes('running') || sLower === 'ready') {
      statusDotColor = '#10b981';
      ledMode = 'glow';
    } else if (sLower.includes('fail') || sLower.includes('err') || sLower.includes('crash') || (sLower.includes('exited') && !sLower.includes('(0)'))) {
      accentColor = '#f43f5e';
      statusDotColor = '#f43f5e';
      ledMode = 'blink-fast';
    } else if (sLower.includes('pending') || sLower.includes('creating')) {
      accentColor = '#fbbf24';
      statusDotColor = '#fbbf24';
      ledMode = 'blink-slow';
    } else if (sLower.includes('stop') || sLower.includes('exited')) {
      accentColor = '#64748b';
      statusDotColor = '#64748b';
      ledMode = 'off';
    }
  }

  // A crash-looping workload should never read as healthy, even while "Running"
  if (ledMode === 'glow' && typeof restarts === 'number' && restarts >= 3) {
    accentColor = '#f43f5e';
    statusDotColor = '#f43f5e';
    ledMode = 'blink-fast';
  }

  // Heatmap overlays
  let heatmapGlow = '';
  if (heatmapMode === 'restarts' && restarts !== undefined && restarts > 0) {
    const intensity = Math.min(restarts / 5, 1);
    accentColor = '#f43f5e';
    heatmapGlow = `0 0 ${12 + intensity * 16}px rgba(244, 63, 94, ${0.4 + intensity * 0.5})`;
  } else if (heatmapMode === 'age' && created) {
    const parsedTime = Date.parse(created.toString());
    if (!isNaN(parsedTime)) {
      const ageMs = Date.now() - parsedTime;
      if (ageMs < 15 * 60 * 1000) {
        accentColor = '#06b6d4';
        heatmapGlow = '0 0 20px rgba(6, 182, 212, 0.7)';
      } else if (ageMs < 2 * 60 * 60 * 1000) {
        accentColor = '#22d3ee';
      } else {
        accentColor = '#475569';
      }
    }
  }

  const isHighlighted = isHovered || isFocused;
  const isPortType = type === 'port';
  // Detail rows only appear when the node is hovered/focused — keeps the resting canvas uncluttered
  const showMeta = isHighlighted && !isPortType;

  const cardWidth = isPortType ? 80 : 180;

  const boxShadow = heatmapGlow
    ? heatmapGlow
    : isHighlighted
      ? `0 0 0 1px ${accentColor}40, 0 0 18px ${accentColor}25, 0 10px 28px rgba(0,0,0,0.45)`
      : '0 1px 2px rgba(0,0,0,0.25)';

  // Helper to render a row
  const MetaRow = ({ label, value, mono }: { label: string; value: string | number; mono?: boolean }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
      <span style={{ color: '#64748b', fontSize: '10px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#e2e8f0', fontSize: '10.5px', fontWeight: 500, fontFamily: mono ? 'JetBrains Mono, monospace' : 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: isPortType ? '50px' : '105px', textAlign: 'right' }} title={String(value)}>{value}</span>
    </div>
  );

  return (
    <div
      onMouseEnter={() => onHover?.(id)}
      onMouseLeave={() => onHover?.(null)}
      title={created ? `${name} · ${formatAge(created)}` : name}
      style={{
        width: cardWidth,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'stretch',
        background: 'rgba(13, 17, 23, 0.92)',
        borderRadius: '10px',
        border: `1px solid ${isHighlighted ? accentColor + '60' : 'rgba(255,255,255,0.07)'}`,
        boxShadow,
        color: '#f8fafc',
        fontFamily: 'Outfit, sans-serif',
        transition: 'border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease',
        transform: isHighlighted ? 'translateY(-1px)' : 'none',
        overflow: 'hidden',
        textAlign: 'left',
        cursor: 'pointer'
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 6, height: 6, background: accentColor, border: 'none', opacity: 0.4, minWidth: 6, minHeight: 6 }} />
      <Handle type="target" position={Position.Top} id="top-target" style={{ width: 6, height: 6, background: accentColor, border: 'none', opacity: 0, minWidth: 6, minHeight: 6 }} />

      {/* Left accent stripe — replaces the old top gradient bar */}
      <div style={{ width: '3px', flexShrink: 0, background: accentColor, opacity: isHighlighted ? 1 : 0.6, transition: 'opacity 0.2s' }} />

      <div style={{ padding: isPortType ? '7px 10px' : '9px 11px', flex: 1, minWidth: 0 }}>
        {/* Header row — always visible */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: isPortType ? 0 : '7px' }}>
          <theme.icon size={isPortType ? 13 : 15} strokeWidth={2.25} style={{ color: accentColor, flexShrink: 0 }} />
          <div style={{ flexGrow: 1, overflow: 'hidden', minWidth: 0 }}>
            <div style={{ fontSize: isPortType ? '10px' : '11.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.25, color: '#f1f5f9' }} title={name}>
              {isPortType ? `:${data.hostPort}` : name}
            </div>
            {!isPortType && (
              <div style={{ fontSize: '8px', fontWeight: 600, color: accentColor, textTransform: 'uppercase', letterSpacing: '0.09em', marginTop: '1px', opacity: 0.65 }}>
                {theme.label}
              </div>
            )}
          </div>
          {/* Restart badge (persistent — it signals a problem) */}
          {restarts > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '2px',
              color: '#fecaca', fontSize: '9px', fontWeight: 700,
              background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.3)',
              padding: '1px 5px', borderRadius: '6px', flexShrink: 0
            }} title={`${restarts} restarts`}>
              <RotateCw size={8} strokeWidth={2.5} />{restarts}
            </span>
          )}
          {/* Server-style status LED */}
          {statusText && !isPortType && (
            <div style={{ position: 'relative', width: '9px', height: '9px', flexShrink: 0 }} title={statusText}>
              {ledMode !== 'off' && (
                <div
                  className={`led-halo led-halo-${ledMode}`}
                  style={{
                    position: 'absolute', inset: '-4px', borderRadius: '50%',
                    background: statusDotColor,
                    opacity: 0.35,
                    filter: 'blur(3px)'
                  }}
                />
              )}
              <div
                className={ledMode !== 'off' ? `led-core led-core-${ledMode}` : undefined}
                style={{
                  position: 'relative',
                  width: '9px', height: '9px', borderRadius: '50%',
                  background: `radial-gradient(circle at 35% 30%, ${statusDotColor}, ${statusDotColor}dd 60%, ${statusDotColor}88)`,
                  border: `1px solid ${statusDotColor}${ledMode === 'off' ? '55' : 'aa'}`,
                  boxShadow: ledMode === 'off' ? 'none' : `0 0 5px ${statusDotColor}, 0 0 1px ${statusDotColor}`,
                  opacity: ledMode === 'off' ? 0.4 : 1
                }}
              />
            </div>
          )}
        </div>

        {/* Metadata: one key line always visible; full detail expands on hover/focus */}
        {!isPortType && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {type === 'docker' && (
              <>
                <MetaRow label="Image" value={(image || '').split('@')[0].split(':').slice(0, 2).join(':')} mono />
                {showMeta && <MetaRow label="State" value={state} />}
              </>
            )}
            {type === 'service' && (
              <>
                <MetaRow label="Ports" value={ports} mono />
                {showMeta && <MetaRow label="Type" value={data.svcType} />}
                {showMeta && <MetaRow label="ClusterIP" value={data.clusterIp} mono />}
              </>
            )}
            {type === 'deployment' && (
              <>
                <MetaRow label="Ready" value={`${ready} / ${replicas}`} />
                {showMeta && <MetaRow label="Available" value={data.available} />}
              </>
            )}
            {type === 'pod' && (
              <>
                <MetaRow label="Ready" value={ready} />
                {showMeta && <MetaRow label="Status" value={status} />}
                {showMeta && <MetaRow label="IP" value={ip || 'N/A'} mono />}
              </>
            )}
            {type === 'k8s-node' && (
              <>
                <MetaRow label="Role" value={role} />
                {showMeta && <MetaRow label="IP" value={ip || 'N/A'} mono />}
              </>
            )}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} style={{ width: 6, height: 6, background: accentColor, border: 'none', opacity: 0.4, minWidth: 6, minHeight: 6 }} />
      <Handle type="source" position={Position.Bottom} id="bottom-source" style={{ width: 6, height: 6, background: accentColor, border: 'none', opacity: 0, minWidth: 6, minHeight: 6 }} />

      {/* Server-LED animation keyframes (injected inline once) */}
      <style>{`
        @keyframes led-glow-core {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.35); }
        }
        @keyframes led-glow-halo {
          0%, 100% { opacity: 0.25; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.25); }
        }
        @keyframes led-blink-fast {
          0%, 45% { opacity: 1; }
          50%, 100% { opacity: 0.12; }
        }
        @keyframes led-blink-slow {
          0%, 65% { opacity: 1; }
          75%, 100% { opacity: 0.2; }
        }
        .led-halo-glow { animation: led-glow-halo 2.2s ease-in-out infinite; }
        .led-halo-blink-fast { animation: led-blink-fast 0.6s steps(1) infinite; }
        .led-halo-blink-slow { animation: led-blink-slow 1.6s steps(1) infinite; }
        .led-core-glow { animation: led-glow-core 2.2s ease-in-out infinite; }
        .led-core-blink-fast { animation: led-blink-fast 0.6s steps(1) infinite; }
        .led-core-blink-slow { animation: led-blink-slow 1.6s steps(1) infinite; }
        @media (prefers-reduced-motion: reduce) {
          .led-halo, .led-core { animation: none !important; opacity: 1 !important; }
        }
      `}</style>
    </div>
  );
});
DevOpsNode.displayName = 'DevOpsNode';

// ─── Custom Premium Group Container Node ────────────────────────────────────
const GroupNode = memo(({ data, style }: any) => {
  const isK8s = data.label?.includes('Kubernetes');
  const isDocker = data.label?.includes('Docker');
  const isNs = data.label?.startsWith('ns:');

  let borderColor = 'rgba(255,255,255,0.07)';
  let iconSize = '11px';

  if (isK8s) {
    borderColor = 'rgba(139, 92, 246, 0.18)';
  } else if (isDocker) {
    borderColor = 'rgba(14, 165, 233, 0.18)';
  } else if (isNs) {
    borderColor = 'rgba(147, 197, 253, 0.12)';
    iconSize = '10px';
  }

  return (
    <div
      style={{
        ...style,
        position: 'relative',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        borderRadius: isNs ? '10px' : '14px',
        border: `1px solid ${borderColor}`,
        background: isNs ? 'transparent' : 'rgba(255,255,255,0.012)',
        overflow: 'hidden'
      }}
    >
      {/* Header label bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: isNs ? '6px 14px' : '8px 16px',
          borderBottom: `1px solid ${borderColor}`,
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}
      >
        {data.icon && (
          <data.icon size={parseInt(iconSize, 10) + 2} strokeWidth={2.25} style={{ color: data.textColor || '#94a3b8', flexShrink: 0 }} />
        )}
        <span style={{
          fontSize: iconSize,
          fontWeight: 800,
          color: data.textColor || '#94a3b8',
          fontFamily: 'Outfit, sans-serif',
          letterSpacing: '0.06em',
          textTransform: 'uppercase'
        }}>
          {data.label}
        </span>
      </div>
    </div>
  );
});
GroupNode.displayName = 'GroupNode';

// ─── Custom edge that renders a traveling dot along the path to show live data flow ───
const FlowEdge = memo(({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, data, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, animated
}: EdgeProps) => {
  const isBezier = data?.pathType === 'bezier';
  const [edgePath, labelX, labelY] = isBezier
    ? getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
    : getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10 });

  const strokeColor = (style as any)?.stroke || '#e2e8f0';
  const edgeOpacity = (style as any)?.opacity ?? 1;
  const showFlow = !!animated && edgeOpacity > 0.15;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd as string} />
      {showFlow && (
        <circle r={2.6} fill={strokeColor} style={{ filter: `drop-shadow(0 0 3px ${strokeColor})` }}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              transition: 'opacity 0.2s ease',
              ...(labelStyle as React.CSSProperties),
              background: (labelBgStyle as any)?.fill,
              padding: labelBgPadding ? `${labelBgPadding[0]}px ${labelBgPadding[1]}px` : undefined,
              borderRadius: labelBgBorderRadius
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
FlowEdge.displayName = 'FlowEdge';

const edgeTypes = {
  flow: FlowEdge
};

const nodeTypes = {
  devopsNode: DevOpsNode,
  groupNode: GroupNode
};


const TopologyGraphInner: React.FC<TopologyGraphProps> = ({ containers, k8sResources }) => {
  const { fitView } = useReactFlow();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Navigation & Search State
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNamespace, setSelectedNamespace] = useState('All');
  const [selectedType, setSelectedType] = useState('All');
  const [heatmapMode, setHeatmapMode] = useState<'none' | 'restarts' | 'age'>('none');
  const [isFullscreen, setIsFullscreen] = useState(false);

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

    const spacingY = 120; // vertical spacing between sibling cards within a stage column
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
          height: totalDockerHeight + 50,
        },
        data: { label: 'Docker Engine', icon: Container, textColor: '#38bdf8' }
      });
    }

    if (filteredPods.length > 0 || filteredSvcs.length > 0 || filteredDeps.length > 0 || filteredNodes.length > 0) {
      nsNodes.push({
        id: 'k8s-group',
        type: 'groupNode',
        position: { x: 500, y: k8sYOffsetVal },
        style: {
          width: 870,
          height: totalK8sHeight + 50,
        },
        data: { label: 'Kubernetes Cluster', icon: Network, textColor: '#a78bfa' }
      });

      // Namespaces rows
      activeNamespaces.forEach(ns => {
        const rowHeight = nsHeightsMap[ns];
        if (rowHeight === undefined) return;
        const rowYStart = k8sYOffsetVal + nsYOffsetsMap[ns];
        nsNodes.push({
          id: `ns-group-${ns}`,
          type: 'groupNode',
          position: { x: 520, y: rowYStart + 30 },
          style: {
            width: 630,
            height: rowHeight + 15,
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
                type: 'flow',
                animated: true,
                label: 'expose',
                labelStyle: { fill: '#818cf8', fontSize: 8, fontWeight: 600, fontFamily: 'Outfit, sans-serif', letterSpacing: '0.05em', opacity: 0 },
                labelBgStyle: { fill: 'rgba(15, 23, 42, 0.85)', strokeWidth: 0 },
                labelBgPadding: [4, 2] as [number, number],
                labelBgBorderRadius: 4,
                style: { stroke: '#818cf8', strokeWidth: 1.5, opacity: 0.7, strokeLinecap: 'round' },
                markerEnd: { type: MarkerType.ArrowClosed, color: '#a5b4fc', width: 14, height: 14 }
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
              type: 'flow',
              animated: true,
              label: 'manages',
              labelStyle: { fill: '#a78bfa', fontSize: 8, fontWeight: 600, fontFamily: 'Outfit, sans-serif', letterSpacing: '0.05em', opacity: 0 },
              labelBgStyle: { fill: 'rgba(15, 23, 42, 0.85)', strokeWidth: 0 },
              labelBgPadding: [4, 2] as [number, number],
              labelBgBorderRadius: 4,
              style: { stroke: '#a78bfa', strokeWidth: 2, opacity: 0.65, strokeLinecap: 'round' },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#c4b5fd', width: 14, height: 14 }
            });
          }
        });

        // Connection: Pod → Node
        if (p.node && p.node !== 'None') {
          const hostNodeId = `k8snode-${p.node.replace(/[^a-zA-Z0-9]/g, '_')}`;
          nsEdges.push({
            id: `edge-${podId}-${hostNodeId}`,
            source: podId,
            target: hostNodeId,
            type: 'flow',
            label: 'runs on',
            labelStyle: { fill: '#94a3b8', fontSize: 8, fontWeight: 600, fontFamily: 'Outfit, sans-serif', letterSpacing: '0.05em', opacity: 0 },
            labelBgStyle: { fill: 'rgba(15, 23, 42, 0.85)', strokeWidth: 0 },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 4,
            style: { stroke: '#64748b', strokeWidth: 1.5, strokeDasharray: '6,4', opacity: 0.5, strokeLinecap: 'round' },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 12, height: 12 }
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
              type: 'flow',
              animated: true,
              label: 'routes to',
              labelStyle: { fill: '#fbbf24', fontSize: 8, fontWeight: 600, fontFamily: 'Outfit, sans-serif', letterSpacing: '0.05em', opacity: 0 },
              labelBgStyle: { fill: 'rgba(15, 23, 42, 0.85)', strokeWidth: 0 },
              labelBgPadding: [4, 2] as [number, number],
              labelBgBorderRadius: 4,
              style: { stroke: '#fbbf24', strokeWidth: 1.8, strokeDasharray: '6,4', opacity: 0.6, strokeLinecap: 'round' },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#fde68a', width: 14, height: 14 }
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
                  type: 'flow',
                  data: { pathType: 'bezier' },
                  label: 'backs',
                  labelStyle: { fill: '#38bdf8', fontSize: 7, fontWeight: 600, fontFamily: 'Outfit, sans-serif', opacity: 0 },
                  labelBgStyle: { fill: 'rgba(15, 23, 42, 0.85)', strokeWidth: 0 },
                  labelBgPadding: [3, 2] as [number, number],
                  labelBgBorderRadius: 3,
                  style: { stroke: '#38bdf8', strokeWidth: 1.2, strokeDasharray: '4,4', opacity: 0.3 },
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
              type: 'flow',
              data: { pathType: 'bezier' },
              label: 'hosts',
              labelStyle: { fill: '#38bdf8', fontSize: 7, fontWeight: 600, fontFamily: 'Outfit, sans-serif', opacity: 0 },
              labelBgStyle: { fill: 'rgba(15, 23, 42, 0.85)', strokeWidth: 0 },
              labelBgPadding: [3, 2] as [number, number],
              labelBgBorderRadius: 3,
              style: { stroke: '#38bdf8', strokeWidth: 1.2, strokeDasharray: '4,4', opacity: 0.3 },
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

  // IDs of resource nodes currently matching the search term
  const searchMatchIds = useMemo(() => {
    if (!searchTerm) return [];
    return rawNodes.filter(n => n.type === 'devopsNode' && matchesSearch(n)).map(n => n.id);
  }, [rawNodes, searchTerm, matchesSearch]);

  // Auto-pan/zoom to the result when the search narrows to a single match
  useEffect(() => {
    if (searchMatchIds.length === 1) {
      fitView({ nodes: [{ id: searchMatchIds[0] }], duration: 500, padding: 1.2, maxZoom: 1 });
    }
  }, [searchMatchIds, fitView]);

  // Keyboard shortcuts: "/" focuses search, "Escape" clears search / closes drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.key === '/' && !isTyping) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (searchTerm) {
          setSearchTerm('');
        } else if (selectedNodeId) {
          setSelectedNodeId(null);
        } else if (isFullscreen) {
          setIsFullscreen(false);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchTerm, selectedNodeId, isFullscreen]);

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
        edgeStyle.opacity = 0.06;
      } else if (isHovered) {
        edgeStyle.stroke = '#e2e8f0'; // bright white glow on hover
        edgeStyle.strokeWidth = 2.5;
        edgeStyle.opacity = 0.9;
        edgeStyle.filter = 'drop-shadow(0 0 4px rgba(226, 232, 240, 0.5))';
      } else if (isCrossPanel) {
        edgeStyle.opacity = 0.12;
      }

      let markerEnd = edge.markerEnd;
      if (isHovered) {
        markerEnd = typeof markerEnd === 'object' ? { ...markerEnd, color: '#e2e8f0' } : markerEnd;
      }

      // Update label visibility on hover/dim
      let labelStyle = edge.labelStyle ? { ...edge.labelStyle as any } : undefined;
      if (isDimmed && labelStyle) {
        labelStyle.opacity = 0.1;
      } else if (isHovered && labelStyle) {
        labelStyle.opacity = 1;
        labelStyle.fill = '#f1f5f9';
      }

      return {
        ...edge,
        style: edgeStyle,
        markerEnd,
        ...(labelStyle ? { labelStyle } : {})
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
            ref={searchInputRef}
            type="text"
            placeholder="Search name, type, state, IP or ports... (press /)"
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
            <>
              <span style={{
                position: 'absolute', right: '28px', fontSize: '10px', fontWeight: 600,
                color: searchMatchIds.length > 0 ? '#38bdf8' : '#f43f5e', pointerEvents: 'none'
              }}>
                {searchMatchIds.length} match{searchMatchIds.length === 1 ? '' : 'es'}
              </span>
              <X
                size={12}
                role="button"
                tabIndex={0}
                aria-label="Clear search"
                onClick={() => setSearchTerm('')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSearchTerm(''); }}
                style={{ position: 'absolute', right: '10px', color: '#64748b', cursor: 'pointer' }}
              />
            </>
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

        {/* Fit View */}
        <button
          onClick={() => fitView({ duration: 500, padding: 0.2 })}
          title="Reset zoom & pan to fit the whole graph"
          style={{
            background: 'rgba(2, 6, 23, 0.4)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '6px',
            color: '#94a3b8',
            padding: '6px 12px',
            fontSize: '12px',
            cursor: 'pointer',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginLeft: 'auto'
          }}
        >
          <RefreshCw size={13} /> Fit View
        </button>

        {/* Fullscreen Toggle */}
        <button
          onClick={() => setIsFullscreen(prev => !prev)}
          style={{
            background: isFullscreen ? 'rgba(56, 189, 248, 0.15)' : 'rgba(2, 6, 23, 0.4)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '6px',
            color: isFullscreen ? '#38bdf8' : '#94a3b8',
            padding: '6px 12px',
            fontSize: '12px',
            cursor: 'pointer',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          {isFullscreen ? (
            <>
              <Minimize2 size={13} /> Exit Fullscreen
            </>
          ) : (
            <>
              <Maximize2 size={13} /> Fullscreen Map
            </>
          )}
        </button>
      </div>

      {/* ─── Graph Canvas Container ─── */}
      <div
        style={isFullscreen ? {
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'radial-gradient(ellipse at 30% 20%, rgba(15, 23, 42, 0.99), rgba(2, 6, 23, 0.99))',
          zIndex: 9999,
          overflow: 'hidden',
          padding: '20px',
          boxSizing: 'border-box'
        } : {
          position: 'relative',
          width: '100%',
          height: '680px',
          background: 'radial-gradient(ellipse at 20% 30%, rgba(15, 23, 42, 0.7), rgba(2, 6, 23, 0.7))',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,0.05)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03), 0 4px 24px rgba(0,0,0,0.3)',
          overflow: 'hidden'
        }}
      >
        {isFullscreen && (
          <button
            onClick={() => setIsFullscreen(false)}
            style={{
              position: 'absolute',
              top: '20px',
              right: '20px',
              zIndex: 10001,
              background: 'rgba(239, 68, 68, 0.2)',
              border: '1px solid #ef4444',
              borderRadius: '6px',
              color: '#f43f5e',
              padding: '8px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
            }}
          >
            <Minimize2 size={14} /> Exit Fullscreen
          </button>
        )}

        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={1.5}
          zoomOnScroll={true}
          panOnScroll={false}
          preventScrolling={false}
          nodesConnectable={false}
          nodesDraggable={true}
          style={{ width: '100%', height: isFullscreen ? 'calc(100vh - 40px)' : '100%' }}
        >
          <Background color="rgba(255,255,255,0.03)" gap={24} size={0.8} />
          <Controls
            showInteractive={false}
            style={{
              background: 'rgba(15, 23, 42, 0.9)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,0.06)',
              color: '#e2e8f0',
              borderRadius: '10px',
              overflow: 'hidden',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)'
            }}
          />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={0}
            nodeColor={(n: Node) => {
              if (n.type === 'groupNode') return 'transparent';
              const nodeColors: Record<string, string> = {
                docker: '#38bdf8', port: '#818cf8', service: '#fbbf24',
                deployment: '#a78bfa', pod: '#34d399', 'k8s-node': '#94a3b8'
              };
              return nodeColors[(n.data as any)?.type] || 'rgba(148,163,184,0.5)';
            }}
            maskColor="rgba(2, 6, 23, 0.75)"
            style={{
              background: 'rgba(15, 23, 42, 0.9)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '10px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)'
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
                role="button"
                tabIndex={0}
                aria-label="Close details panel"
                onClick={() => setSelectedNodeId(null)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedNodeId(null); }}
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
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px', marginRight: '8px', paddingRight: '12px', borderRight: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: '10px', fontWeight: 600, color: '#94a3b8', letterSpacing: '0.04em' }}>FLOW →</span>
          <span style={{ fontSize: '9px', color: '#64748b' }}>Port → Container → Service → Deploy → Pod → Node</span>
        </span>
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

export const TopologyGraph: React.FC<TopologyGraphProps> = (props) => (
  <ReactFlowProvider>
    <TopologyGraphInner {...props} />
  </ReactFlowProvider>
);

export default TopologyGraph;
