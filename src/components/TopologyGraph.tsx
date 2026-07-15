import React, { useEffect, useRef, useCallback, useState } from 'react';
import cytoscape from 'cytoscape';

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
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

export const TopologyGraph: React.FC<TopologyGraphProps> = ({ containers, k8sResources }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string; type: string } | null>(null);

  const buildElements = useCallback(() => {
    const elements: cytoscape.ElementDefinition[] = [];

    // --- Docker Containers ---
    if (containers.length > 0) {
      elements.push({
        data: { id: 'docker-group', label: '🐳 Docker Engine' },
        classes: 'group-docker'
      });

      containers.forEach(c => {
        const nodeId = `docker-${c.id.slice(0, 12)}`;
        elements.push({
          data: {
            id: nodeId,
            label: c.name.replace(/^themachine-/, '').replace(/-1$/, ''),
            parent: 'docker-group',
            type: 'docker',
            fullName: c.name,
            image: c.image,
            state: c.state,
            status: c.status,
            ports: c.ports
          },
          classes: `docker ${c.state === 'running' ? 'running' : 'stopped'}`
        });

        // Port nodes
        if (c.ports && c.ports !== 'None' && c.state === 'running') {
          const portParts = c.ports.split(',');
          portParts.forEach((part, idx) => {
            const match = part.trim().match(/([0-9.]+):([0-9]+)->([0-9]+)/);
            if (match) {
              const hostPort = match[2];
              const containerPort = match[3];
              const portId = `port-${nodeId}-${idx}`;
              elements.push({
                data: {
                  id: portId,
                  label: `:${hostPort}`,
                  parent: 'docker-group',
                  type: 'port',
                  hostPort,
                  containerPort
                },
                classes: 'port'
              });
              elements.push({
                data: { source: portId, target: nodeId, label: `→${containerPort}` },
                classes: 'port-edge'
              });
            }
          });
        }
      });
    }

    // --- Kubernetes ---
    const k8s = k8sResources;
    if (k8s.pods.length > 0 || k8s.nodes.length > 0) {
      elements.push({
        data: { id: 'k8s-group', label: '☸️ Kubernetes Cluster' },
        classes: 'group-k8s'
      });

      // Nodes
      k8s.nodes.forEach(n => {
        const nodeId = `k8snode-${n.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        elements.push({
          data: {
            id: nodeId,
            label: n.name,
            parent: 'k8s-group',
            type: 'k8s-node',
            role: n.role,
            status: n.status,
            version: n.version,
            ip: n.ip
          },
          classes: `k8s-node ${n.status === 'Ready' ? 'running' : 'stopped'}`
        });
      });

      // Namespace subgroups
      const namespaces = new Set<string>();
      k8s.pods.forEach(p => namespaces.add(p.namespace));
      k8s.services.forEach(s => namespaces.add(s.namespace));
      k8s.deployments.forEach(d => namespaces.add(d.namespace));

      namespaces.forEach(ns => {
        const nsId = `ns-${ns.replace(/[^a-zA-Z0-9]/g, '_')}`;
        elements.push({
          data: { id: nsId, label: `ns: ${ns}`, parent: 'k8s-group' },
          classes: 'namespace'
        });

        // Deployments
        k8s.deployments.filter(d => d.namespace === ns).forEach(d => {
          const depId = `deploy-${ns}-${d.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
          elements.push({
            data: {
              id: depId,
              label: d.name,
              parent: nsId,
              type: 'deployment',
              ready: d.ready,
              available: d.available,
              replicas: d.replicas,
              namespace: d.namespace
            },
            classes: 'deployment'
          });
        });

        // Pods
        k8s.pods.filter(p => p.namespace === ns).forEach(p => {
          const podId = `pod-${ns}-${p.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
          const containerInfo = (p.containers || []).map((c: any) => `${c.name}: ${c.image}`).join('\n');
          elements.push({
            data: {
              id: podId,
              label: p.name.length > 22 ? `${p.name.slice(0, 20)}…` : p.name,
              parent: nsId,
              type: 'pod',
              fullName: p.name,
              status: p.status,
              ready: p.ready,
              ip: p.ip,
              node: p.node,
              restarts: p.restarts,
              containers: containerInfo
            },
            classes: `pod ${p.status === 'Running' ? 'running' : 'stopped'}`
          });

          // Connect Deployment → Pod
          k8s.deployments.filter(d => d.namespace === ns).forEach(d => {
            if (p.name.startsWith(d.name)) {
              const depId = `deploy-${ns}-${d.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
              elements.push({
                data: { source: depId, target: podId, label: 'manages' },
                classes: 'manages-edge'
              });
            }
          });

          // Connect Pod → Node
          if (p.node && p.node !== 'None') {
            const hostNodeId = `k8snode-${p.node.replace(/[^a-zA-Z0-9]/g, '_')}`;
            elements.push({
              data: { source: hostNodeId, target: podId, label: 'hosts' },
              classes: 'hosts-edge'
            });
          }
        });

        // Services
        k8s.services.filter(s => s.namespace === ns).forEach(s => {
          const svcId = `svc-${ns}-${s.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
          elements.push({
            data: {
              id: svcId,
              label: s.name,
              parent: nsId,
              type: 'service',
              svcType: s.type,
              clusterIp: s.clusterIp,
              ports: s.ports,
              namespace: s.namespace
            },
            classes: 'service'
          });

          // Route Service → Pod
          k8s.pods.filter(p => p.namespace === ns).forEach(p => {
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
              elements.push({
                data: { source: svcId, target: podId, label: 'routes' },
                classes: 'routes-edge'
              });
            }
          });
        });
      });
    }

    return elements;
  }, [containers, k8sResources]);

  const buildTooltip = useCallback((data: any): string => {
    const type = data.type;
    if (!type) return '';
    
    let lines: string[] = [];
    
    if (type === 'docker') {
      lines = [
        `<b>🐳 ${data.fullName}</b>`,
        `<hr/>`,
        `<span class="tt-key">Image:</span> <span class="tt-val">${data.image}</span>`,
        `<span class="tt-key">State:</span> <span class="tt-val ${data.state === 'running' ? 'tt-green' : 'tt-red'}">${data.state.toUpperCase()}</span>`,
        `<span class="tt-key">Status:</span> <span class="tt-val">${data.status}</span>`,
        `<span class="tt-key">Ports:</span> <span class="tt-val">${data.ports || 'None'}</span>`
      ];
    } else if (type === 'pod') {
      lines = [
        `<b>🛸 ${data.fullName || data.label}</b>`,
        `<hr/>`,
        `<span class="tt-key">Status:</span> <span class="tt-val ${data.status === 'Running' ? 'tt-green' : 'tt-yellow'}">${data.status}</span>`,
        `<span class="tt-key">Ready:</span> <span class="tt-val">${data.ready}</span>`,
        `<span class="tt-key">IP:</span> <span class="tt-val">${data.ip || 'None'}</span>`,
        `<span class="tt-key">Node:</span> <span class="tt-val">${data.node || 'None'}</span>`,
        `<span class="tt-key">Restarts:</span> <span class="tt-val ${data.restarts > 0 ? 'tt-red' : ''}">${data.restarts}</span>`,
      ];
      if (data.containers) {
        lines.push(`<hr/><span class="tt-key">Containers:</span>`);
        data.containers.split('\n').forEach((c: string) => {
          if (c.trim()) {
            const [name, img] = c.split(': ');
            lines.push(`<span class="tt-container">📦 ${name}: <em>${img}</em></span>`);
          }
        });
      }
    } else if (type === 'deployment') {
      lines = [
        `<b>📦 Deploy: ${data.label}</b>`,
        `<hr/>`,
        `<span class="tt-key">Namespace:</span> <span class="tt-val">${data.namespace}</span>`,
        `<span class="tt-key">Replicas:</span> <span class="tt-val">${data.ready}</span>`,
        `<span class="tt-key">Available:</span> <span class="tt-val">${data.available}</span>`
      ];
    } else if (type === 'service') {
      lines = [
        `<b>⚙️ Service: ${data.label}</b>`,
        `<hr/>`,
        `<span class="tt-key">Type:</span> <span class="tt-val">${data.svcType}</span>`,
        `<span class="tt-key">ClusterIP:</span> <span class="tt-val">${data.clusterIp}</span>`,
        `<span class="tt-key">Ports:</span> <span class="tt-val">${data.ports}</span>`
      ];
    } else if (type === 'k8s-node') {
      lines = [
        `<b>💻 Node: ${data.label}</b>`,
        `<hr/>`,
        `<span class="tt-key">Role:</span> <span class="tt-val">${data.role}</span>`,
        `<span class="tt-key">Version:</span> <span class="tt-val">${data.version}</span>`,
        `<span class="tt-key">Status:</span> <span class="tt-val ${data.status === 'Ready' ? 'tt-green' : 'tt-red'}">${data.status}</span>`,
        `<span class="tt-key">IP:</span> <span class="tt-val">${data.ip || 'N/A'}</span>`
      ];
    } else if (type === 'port') {
      lines = [
        `<b>🌐 Port Mapping</b>`,
        `<hr/>`,
        `<span class="tt-key">Host:</span> <span class="tt-val">${data.hostPort}</span>`,
        `<span class="tt-key">Container:</span> <span class="tt-val">${data.containerPort}</span>`
      ];
    }
    return lines.join('');
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const elements = buildElements();
    if (elements.length === 0) return;

    if (cyRef.current) {
      cyRef.current.destroy();
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.3,
      maxZoom: 2.5,
      wheelSensitivity: 0.15,
      style: [
        // Compound nodes (groups)
        {
          selector: '.group-docker',
          style: {
            'background-color': 'rgba(14, 165, 233, 0.06)',
            'border-color': 'rgba(14, 165, 233, 0.3)',
            'border-width': 2,
            'border-style': 'solid' as any,
            'label': 'data(label)',
            'text-valign': 'top',
            'text-halign': 'center',
            'font-size': '14px',
            'font-weight': 'bold' as any,
            'color': '#38bdf8',
            'padding': '24px' as any,
            'shape': 'roundrectangle',
            'corner-radius': '12px' as any,
          }
        },
        {
          selector: '.group-k8s',
          style: {
            'background-color': 'rgba(139, 92, 246, 0.06)',
            'border-color': 'rgba(139, 92, 246, 0.3)',
            'border-width': 2,
            'border-style': 'solid' as any,
            'label': 'data(label)',
            'text-valign': 'top',
            'text-halign': 'center',
            'font-size': '14px',
            'font-weight': 'bold' as any,
            'color': '#a78bfa',
            'padding': '24px' as any,
            'shape': 'roundrectangle',
            'corner-radius': '12px' as any,
          }
        },
        {
          selector: '.namespace',
          style: {
            'background-color': 'rgba(107, 114, 128, 0.05)',
            'border-color': 'rgba(107, 114, 128, 0.25)',
            'border-width': 1.5,
            'border-style': 'dashed' as any,
            'label': 'data(label)',
            'text-valign': 'top',
            'text-halign': 'center',
            'font-size': '11px',
            'font-weight': 'bold' as any,
            'color': '#9ca3af',
            'padding': '18px' as any,
            'shape': 'roundrectangle',
            'corner-radius': '8px' as any,
          }
        },
        // Docker container nodes
        {
          selector: 'node.docker',
          style: {
            'background-color': '#0c4a6e',
            'border-color': '#0ea5e9',
            'border-width': 2,
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '10px',
            'font-weight': 'bold' as any,
            'color': '#e0f2fe',
            'width': '100px',
            'height': '44px',
            'shape': 'roundrectangle',
            'corner-radius': '8px' as any,
            'text-wrap': 'wrap' as any,
            'text-max-width': '90px',
          }
        },
        {
          selector: 'node.docker.stopped',
          style: {
            'background-color': '#450a0a',
            'border-color': '#ef4444',
            'opacity': 0.7,
          }
        },
        // Port nodes
        {
          selector: 'node.port',
          style: {
            'background-color': '#1e1b4b',
            'border-color': '#6366f1',
            'border-width': 1.5,
            'border-style': 'dashed' as any,
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '10px',
            'font-weight': 'bold' as any,
            'color': '#c7d2fe',
            'width': '52px',
            'height': '28px',
            'shape': 'roundrectangle',
            'corner-radius': '14px' as any,
          }
        },
        // K8s node
        {
          selector: 'node.k8s-node',
          style: {
            'background-color': '#1f2937',
            'border-color': '#6b7280',
            'border-width': 2.5,
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '10px',
            'font-weight': 'bold' as any,
            'color': '#d1d5db',
            'width': '110px',
            'height': '44px',
            'shape': 'roundrectangle',
            'corner-radius': '8px' as any,
            'text-wrap': 'wrap' as any,
            'text-max-width': '100px',
          }
        },
        // Pod nodes
        {
          selector: 'node.pod',
          style: {
            'background-color': '#064e3b',
            'border-color': '#10b981',
            'border-width': 2,
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '9px',
            'font-weight': 'bold' as any,
            'color': '#d1fae5',
            'width': '105px',
            'height': '40px',
            'shape': 'roundrectangle',
            'corner-radius': '8px' as any,
            'text-wrap': 'wrap' as any,
            'text-max-width': '95px',
          }
        },
        {
          selector: 'node.pod.stopped',
          style: {
            'background-color': '#451a03',
            'border-color': '#f59e0b',
          }
        },
        // Deployment nodes
        {
          selector: 'node.deployment',
          style: {
            'background-color': '#2e1065',
            'border-color': '#8b5cf6',
            'border-width': 2,
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '9px',
            'font-weight': 'bold' as any,
            'color': '#ede9fe',
            'width': '100px',
            'height': '40px',
            'shape': 'roundrectangle',
            'corner-radius': '8px' as any,
            'text-wrap': 'wrap' as any,
            'text-max-width': '90px',
          }
        },
        // Service nodes
        {
          selector: 'node.service',
          style: {
            'background-color': '#451a03',
            'border-color': '#f59e0b',
            'border-width': 2,
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '9px',
            'font-weight': 'bold' as any,
            'color': '#fef3c7',
            'width': '100px',
            'height': '40px',
            'shape': 'diamond',
            'text-wrap': 'wrap' as any,
            'text-max-width': '85px',
          }
        },
        // Edges
        {
          selector: '.port-edge',
          style: {
            'line-color': '#6366f1',
            'target-arrow-color': '#6366f1',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'width': 1.5,
            'label': 'data(label)',
            'font-size': '8px',
            'color': '#818cf8',
            'text-background-color': '#0f172a',
            'text-background-opacity': 0.9,
            'text-background-padding': '2px' as any,
            'arrow-scale': 0.8,
            'opacity': 0.7,
          }
        },
        {
          selector: '.manages-edge',
          style: {
            'line-color': '#8b5cf6',
            'target-arrow-color': '#8b5cf6',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'width': 2,
            'label': 'data(label)',
            'font-size': '8px',
            'color': '#a78bfa',
            'text-background-color': '#0f172a',
            'text-background-opacity': 0.9,
            'text-background-padding': '2px' as any,
            'arrow-scale': 0.9,
          }
        },
        {
          selector: '.routes-edge',
          style: {
            'line-color': '#f59e0b',
            'target-arrow-color': '#f59e0b',
            'target-arrow-shape': 'triangle',
            'line-style': 'dashed',
            'curve-style': 'bezier',
            'width': 1.5,
            'label': 'data(label)',
            'font-size': '8px',
            'color': '#fbbf24',
            'text-background-color': '#0f172a',
            'text-background-opacity': 0.9,
            'text-background-padding': '2px' as any,
            'arrow-scale': 0.8,
          }
        },
        {
          selector: '.hosts-edge',
          style: {
            'line-color': '#6b7280',
            'target-arrow-color': '#6b7280',
            'target-arrow-shape': 'triangle',
            'line-style': 'dotted',
            'curve-style': 'bezier',
            'width': 1,
            'label': 'data(label)',
            'font-size': '7px',
            'color': '#9ca3af',
            'text-background-color': '#0f172a',
            'text-background-opacity': 0.9,
            'text-background-padding': '2px' as any,
            'arrow-scale': 0.7,
            'opacity': 0.6,
          }
        },
        // Highlighted state
        {
          selector: 'node:active, node:grabbed',
          style: {
            'overlay-color': '#a78bfa',
            'overlay-opacity': 0.15,
          }
        },
        {
          selector: 'node.highlight',
          style: {
            'border-width': 3.5,
            'border-color': '#a78bfa',
            'overlay-color': '#a78bfa',
            'overlay-opacity': 0.08,
          }
        },
        {
          selector: 'edge.highlight',
          style: {
            'width': 3,
            'opacity': 1,
          }
        },
        {
          selector: 'node.faded',
          style: { 'opacity': 0.2 }
        },
        {
          selector: 'edge.faded',
          style: { 'opacity': 0.08 }
        },
      ],
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 600,
        fit: true,
        padding: 40,
        nodeRepulsion: () => 12000,
        idealEdgeLength: () => 90,
        edgeElasticity: () => 80,
        nestingFactor: 1.2,
        gravity: 0.4,
        numIter: 800,
        randomize: false,
      } as any,
    });

    // Hover highlight: dim everything else, spotlight the hovered node and its neighbors
    cy.on('mouseover', 'node[type]', (e) => {
      const node = e.target;
      const neighborhood = node.closedNeighborhood();
      cy.elements().addClass('faded');
      neighborhood.removeClass('faded').addClass('highlight');

      const data = node.data();
      const renderedPos = node.renderedPosition();
      const containerBounds = containerRef.current!.getBoundingClientRect();
      setTooltip({
        x: containerBounds.left + renderedPos.x + 15,
        y: containerBounds.top + renderedPos.y - 10,
        content: buildTooltip(data),
        type: data.type
      });
    });

    cy.on('mouseout', 'node[type]', () => {
      cy.elements().removeClass('faded').removeClass('highlight');
      setTooltip(null);
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [buildElements, buildTooltip]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '520px',
          background: 'rgba(2, 6, 23, 0.6)',
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      />
      {tooltip && (
        <div
          className="cy-tooltip"
          style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y,
            zIndex: 9999,
            pointerEvents: 'none',
          }}
          dangerouslySetInnerHTML={{ __html: tooltip.content }}
        />
      )}
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
          <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#8b5cf6', display: 'inline-block' }}></span> Deployment
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', border: '2px solid #f59e0b', background: 'transparent', display: 'inline-block' }}></span> Service
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#6b7280', display: 'inline-block' }}></span> K8s Node
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', border: '1.5px dashed #6366f1', background: 'transparent', display: 'inline-block' }}></span> Port
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', opacity: 0.6 }}>
          Scroll to zoom · Drag to pan · Hover for details
        </span>
      </div>
    </>
  );
};

export default TopologyGraph;
