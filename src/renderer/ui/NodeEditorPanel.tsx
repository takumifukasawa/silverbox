import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  applyNodeChanges,
  type Connection,
  type Node,
  type NodeChange,
  type NodeProps,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '../store/appStore';
import { BLEND_KIND, CUSTOM_KIND, OPS, isOpKind } from '../engine/graph/ops';
import { DEVELOP_KIND, outputName, type GraphDoc } from '../engine/graph/graphDoc';
import { MASK_KIND } from '../engine/graph/maskNode';

/** Blend node: three labeled inputs (a = base, b = overlay, mask = optional), one output. */
function BlendNode({ data, selected }: NodeProps) {
  return (
    <div className={`blend-node${selected ? ' selected' : ''}`}>
      <Handle type="target" id="a" position={Position.Left} style={{ top: '30%' }} />
      <Handle type="target" id="b" position={Position.Left} style={{ top: '70%' }} />
      <Handle type="target" id="mask" position={Position.Bottom} style={{ left: '50%' }} />
      <span className="blend-node-ports">
        a<br />b
      </span>
      <span>{String((data as { label?: string }).label ?? 'blend')}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { blend: BlendNode };

/** Pure GraphDoc → React Flow Node[] projection, shared by the initial state and the resync effect below. */
function buildNodes(graph: GraphDoc, fileName: string | null, selectedNodeId: string | null): Node[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type:
      n.kind === 'input' ? 'input' : n.kind === 'output' ? 'output' : n.kind === BLEND_KIND ? 'blend' : 'default',
    data: {
      label:
        n.kind === 'input'
          ? fileName
            ? `input — ${fileName}`
            : 'input'
          : n.kind === 'output'
            ? `output (sRGB) — ${outputName(n)}`
            : n.kind === DEVELOP_KIND
              ? 'Develop'
              : n.kind === CUSTOM_KIND
                ? 'custom (wgsl)'
                : n.kind === BLEND_KIND
                  ? 'blend'
                  : n.kind === MASK_KIND
                    ? 'mask'
                    : isOpKind(n.kind)
                      ? OPS[n.kind].label.toLowerCase()
                      : n.kind,
    },
    position: n.position,
    selected: n.id === selectedNodeId,
    sourcePosition: 'right',
    targetPosition: 'left',
    deletable:
      isOpKind(n.kind) || n.kind === CUSTOM_KIND || n.kind === BLEND_KIND || n.kind === DEVELOP_KIND || n.kind === MASK_KIND,
  })) as Node[];
}

/**
 * Node editor rendering the GraphDoc. Selection feeds the inspector; ops can
 * be inserted before the output (toolbar), removed (Delete/Backspace), and
 * rewired by dragging a connection onto an input — the store validates and
 * rejects wirings that break the DAG.
 */
export function NodeEditorPanel() {
  const fileName = useAppStore((s) => s.fileName);
  const graph = useAppStore((s) => s.graph);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const selectNode = useAppStore((s) => s.selectNode);
  const moveNode = useAppStore((s) => s.moveNode);
  const addOpNode = useAppStore((s) => s.addOpNode);
  const removeOpNode = useAppStore((s) => s.removeOpNode);
  const connectEdge = useAppStore((s) => s.connectEdge);
  const removeEdge = useAppStore((s) => s.removeEdge);
  const connectNotice = useAppStore((s) => s.connectNotice);
  const graphBroken = useAppStore((s) => s.graphBroken);
  // edge selection is transient UI state — the GraphDoc doesn't carry it
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // React Flow's OWN, LOCAL node list — NOT derived fresh from `graph` on
  // every render. This is the fix for the node-drag lag (#pointer-drag-lag):
  // node.position is layout-only (graphDoc.ts's buildPlan never reads it), so
  // dragging must never write to the store per mouse-move — that would push
  // one history entry per pixel AND make CanvasView's render effect re-post
  // to the worker on every move. Instead, onNodesChange applies EVERY change
  // (including in-flight 'position' drag changes) to this local state only;
  // the GraphDoc is written exactly once, at drag end (onNodeDragStop below).
  const [rfNodes, setRfNodes] = useState<Node[]>(() => buildNodes(graph, fileName, selectedNodeId));
  // Suppressed while a drag is in flight: the store's node position is still
  // the PRE-drag value until drop, so resyncing from it mid-drag would fight
  // the local per-move state right back into the lag this exists to avoid.
  const draggingRef = useRef(false);
  useEffect(() => {
    if (draggingRef.current) return;
    setRfNodes(buildNodes(graph, fileName, selectedNodeId));
  }, [graph, fileName, selectedNodeId]);

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    targetHandle: e.targetHandle,
    selected: e.id === selectedEdgeId,
  }));

  const onNodeClick: NodeMouseHandler = useCallback((_ev, node) => selectNode(node.id), [selectNode]);
  // Every intermediate position lands in local state only (see rfNodes above)
  // — applyNodeChanges is the same helper React Flow's own useNodesState uses.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds));
  }, []);
  const onNodeDragStart: OnNodeDrag = useCallback(() => {
    draggingRef.current = true;
  }, []);
  // The ONE point the GraphDoc actually changes: one moveNode call, one
  // history entry, regardless of how many mouse-moves the drag contained.
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_ev, node) => {
      draggingRef.current = false;
      moveNode(node.id, node.position);
    },
    [moveNode]
  );
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const handle =
        conn.targetHandle === 'a' || conn.targetHandle === 'b' || conn.targetHandle === 'mask'
          ? conn.targetHandle
          : undefined;
      connectEdge(conn.source, conn.target, handle);
    },
    [connectEdge]
  );
  // one unified delete handler: node deletion rewires its neighbors itself,
  // so the adjacent edges React Flow reports alongside must NOT be removed
  // separately (their freed ids may already be reused by the bypass edge)
  const onDelete = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      if (deletedNodes.length > 0) {
        for (const node of deletedNodes) removeOpNode(node.id);
      } else {
        for (const edge of deletedEdges) removeEdge(edge.id);
      }
      setSelectedEdgeId(null);
    },
    [removeOpNode, removeEdge]
  );
  const onEdgeClick = useCallback((_ev: React.MouseEvent, edge: Edge) => setSelectedEdgeId(edge.id), []);

  return (
    <div className="node-editor">
      {graphBroken && (
        <div className="node-editor-banner" data-testid="broken-banner">
          input → output path is broken — preview shows the unedited image (pass-through)
        </div>
      )}
      {connectNotice && (
        <div className="node-editor-banner node-editor-banner--reject" data-testid="reject-banner">
          {connectNotice}
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        onNodeClick={onNodeClick}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onDelete={onDelete}
        onEdgeClick={onEdgeClick}
        onConnect={onConnect}
        onPaneClick={() => {
          selectNode(null);
          setSelectedEdgeId(null);
        }}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}
