'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node as FlowNode,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { useMemo, useState } from 'react';

import {
  buildKgGraph,
  type KgEdgeKind,
  type KgGraphData,
  type KgNode,
} from '@/lib/graph/builder';
import {
  filterKgGraph,
  kgNeighbors,
  MEMORIES_ONLY_FILTERS,
  type KgFilters,
} from '@/lib/graph/kg-view';
import type { MemoryType } from '@/lib/memory/types';

interface KgGraphProps {
  data: KgGraphData;
  projectId: string;
}

interface SimulationNode extends SimulationNodeDatum {
  id: string;
  w: number;
  h: number;
  x: number;
  y: number;
}

interface SimulationLink extends SimulationLinkDatum<SimulationNode> {
  kind: KgEdgeKind;
}

const MEM_W = 220;
const MEM_H = 84;
const ENT_W = 132;
const ENT_H = 44;

const TYPE_ACCENT: Record<MemoryType, { accent: string; tint: string; ring: string; label: string }> = {
  user: { accent: '#2563eb', tint: '#eff6ff', ring: '#bfdbfe', label: 'USER' },
  feedback: { accent: '#d97706', tint: '#fffbeb', ring: '#fde68a', label: 'FEEDBACK' },
  project: { accent: '#059669', tint: '#ecfdf5', ring: '#a7f3d0', label: 'PROJECT' },
  reference: { accent: '#7c3aed', tint: '#f5f3ff', ring: '#ddd6fe', label: 'REFERENCE' },
  session: { accent: '#4b5563', tint: '#f9fafb', ring: '#d1d5db', label: 'SESSION' },
};

const EDGE_STYLE: Record<KgEdgeKind, { stroke: string; width: number; opacity: number }> = {
  membership: { stroke: '#cbd5e1', width: 1.25, opacity: 0.45 },
  triple: { stroke: '#6366f1', width: 1.75, opacity: 0.75 },
  link: { stroke: '#f97316', width: 2.5, opacity: 0.85 },
};

const EDGE_LABEL: Record<KgEdgeKind, string> = {
  membership: '所属',
  triple: 'トリプル',
  link: 'リンク',
};

interface GraphNodeData extends Record<string, unknown> {
  label: string;
  memoryType?: MemoryType;
  description?: string;
  tags?: string[];
  href?: string;
}

function asGraphData(data: Record<string, unknown>): GraphNodeData {
  return data as GraphNodeData;
}

function MemoryFlowNode({ data }: NodeProps<FlowNode>) {
  const node = asGraphData(data);
  const type = node.memoryType ?? 'reference';
  const accent = TYPE_ACCENT[type];
  return (
    <div style={{ color: '#0f172a', fontSize: 12 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ color: accent.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</strong>
        {node.href ? <Link href={node.href} onClick={(event) => event.stopPropagation()} aria-label={'Open ' + node.label}>↗</Link> : null}
      </div>
      <small style={{ color: '#475569' }}>{accent.label}</small>
      {node.description ? <div style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.description}</div> : null}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

function EntityFlowNode({ data }: NodeProps<FlowNode>) {
  const node = asGraphData(data);
  return (
    <div style={{ color: '#334155', fontSize: 12, textAlign: 'center' }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <strong>{node.label}</strong>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { memory: MemoryFlowNode, entity: EntityFlowNode };

function computePositions(graph: ReturnType<typeof buildKgGraph>): Map<string, { x: number; y: number }> {
  const simNodes: SimulationNode[] = graph.nodes.map((node, index) => ({
    id: node.id,
    w: node.kind === 'memory' ? MEM_W : ENT_W,
    h: node.kind === 'memory' ? MEM_H : ENT_H,
    x: (index % 5) * 260 - 520,
    y: Math.floor(index / 5) * 130 - 260,
  }));
  const simLinks: SimulationLink[] = graph.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
  }));
  const simulation = forceSimulation(simNodes)
    .force('charge', forceManyBody<SimulationNode>().strength(-520))
    .force(
      'link',
      forceLink<SimulationNode, SimulationLink>(simLinks)
        .id((node) => node.id)
        .distance((link) => link.kind === 'membership' ? 70 : link.kind === 'triple' ? 120 : 165)
        .strength(0.75),
    )
    .force('collide', forceCollide<SimulationNode>().radius((node) => Math.hypot(node.w, node.h) / 2 + 10).iterations(2))
    .force('x', forceX<SimulationNode>(0).strength(0.045))
    .force('y', forceY<SimulationNode>(0).strength(0.07))
    .stop();
  for (let index = 0; index < 340; index += 1) simulation.tick();
  return new Map(simNodes.map((node) => [node.id, { x: node.x, y: node.y }]));
}

function withoutOrphans(graph: ReturnType<typeof buildKgGraph>) {
  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  return {
    nodes: graph.nodes.filter((node) => node.kind === 'memory' || connected.has(node.id)),
    edges: graph.edges,
  };
}

function allTags(graph: ReturnType<typeof buildKgGraph>): string[] {
  return [...new Set(graph.nodes.flatMap((node) => (
    node.kind === 'memory' ? (node.data as { tags: string[] }).tags : []
  )))].sort();
}

function nodeStyle(node: KgNode, neighbors: Set<string> | null) {
  const focused = !neighbors || neighbors.has(node.id);
  if (node.kind === 'entity') {
    return {
      width: ENT_W,
      minHeight: ENT_H,
      borderRadius: 22,
      border: '2px solid #94a3b8',
      background: '#f8fafc',
      opacity: focused ? 1 : 0.28,
    };
  }
  const type = (node.data as { memoryType?: MemoryType }).memoryType ?? 'reference';
  const accent = TYPE_ACCENT[type];
  return {
    width: MEM_W,
    minHeight: MEM_H,
    borderRadius: 10,
    border: '2px solid ' + accent.accent,
    boxShadow: '0 0 0 2px ' + accent.ring,
    background: accent.tint,
    opacity: focused ? 1 : 0.28,
  };
}

function nodeData(node: KgNode, projectId: string): GraphNodeData {
  return node.kind === 'memory'
    ? {
      ...(node.data as GraphNodeData),
      href: '/p/' + encodeURIComponent(projectId) + '/memories/' + encodeURIComponent(node.data.label),
    }
    : { ...node.data };
}

export function KgGraph({ data, projectId }: KgGraphProps) {
  const router = useRouter();
  const [mode, setMode] = useState<'kg' | 'memories'>('kg');
  const [tags, setTags] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [showMembership, setShowMembership] = useState(false);
  const graph = useMemo(() => buildKgGraph(data), [data]);
  const availableTags = useMemo(() => allTags(graph), [graph]);
  const filters = useMemo<KgFilters>(() => mode === 'memories'
    ? { ...MEMORIES_ONLY_FILTERS, tags }
    : { showMemory: true, showEntity: true, showMembership, showTriple: true, showLink: true, tags },
  [mode, showMembership, tags]);
  const displayed = useMemo(() => withoutOrphans(filterKgGraph(graph, filters)), [graph, filters]);
  const neighbors = useMemo(
    () => focused ? kgNeighbors(displayed, focused) : null,
    [displayed, focused],
  );
  const positions = useMemo(() => computePositions(displayed), [displayed]);
  const flowNodes: FlowNode[] = displayed.nodes.map((node) => ({
    id: node.id,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: nodeData(node, projectId),
    type: node.kind,
    style: nodeStyle(node, neighbors),
  }));
  const flowEdges: Edge[] = displayed.edges.map((edge) => {
    const style = EDGE_STYLE[edge.kind];
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.kind === 'triple' ? edge.label : EDGE_LABEL[edge.kind],
      style: { stroke: style.stroke, strokeWidth: style.width, opacity: style.opacity },
      labelStyle: { fontSize: 11, fill: '#475569' },
    };
  });

  function toggleTag(tag: string) {
    setTags((current) => current.includes(tag)
      ? current.filter((item) => item !== tag)
      : [...current, tag]);
  }

  function handleNodeClick(nodeId: string) {
    setFocused((current) => current === nodeId ? null : nodeId);
  }

  function handleDoubleClick(nodeId: string) {
    const node = displayed.nodes.find((item) => item.id === nodeId);
    if (node?.kind === 'memory') {
      router.push('/p/' + encodeURIComponent(projectId) + '/memories/' + encodeURIComponent(node.data.label));
    }
  }

  return (
    <section>
      <div className="graph-toolbar">
        <div className="actions">
          <button type="button" onClick={() => setMode('kg')} aria-pressed={mode === 'kg'}>Knowledge graph</button>
          <button type="button" onClick={() => setMode('memories')} aria-pressed={mode === 'memories'}>Memories only</button>
          {mode === 'kg' ? <button type="button" onClick={() => setShowMembership((current) => !current)} aria-pressed={showMembership}>Memberships</button> : null}
        </div>
        {availableTags.length > 0 ? (
          <div className="tag-filters">
            <span>Tags:</span>
            {availableTags.map((tag) => (
              <button
                type="button"
                className={tags.includes(tag) ? 'tag selected' : 'tag'}
                aria-pressed={tags.includes(tag)}
                key={tag}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
            {tags.length > 0 ? <button type="button" onClick={() => setTags([])}>Clear tags</button> : null}
          </div>
        ) : null}
        {focused ? <button type="button" onClick={() => setFocused(null)}>Clear focus</button> : null}
      </div>
      {displayed.nodes.some((node) => node.kind === 'memory') ? (
        <div className="kg-graph">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.22 }}
            minZoom={0.12}
            maxZoom={2.2}
            nodesDraggable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node) => handleNodeClick(node.id)}
            onNodeDoubleClick={(_event, node) => handleDoubleClick(node.id)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d3dbe6" />
            <Controls showInteractive={false} />
          </ReactFlow>
          <div className="graph-legend">
            <span><i className="legend-memory" />Memory</span>
            <span><i className="legend-entity" />Entity</span>
            <span><i className="legend-link" />Link</span>
          </div>
        </div>
      ) : <p>No memories yet. Save some via the MCP tools, then they will appear here.</p>}
    </section>
  );
}
