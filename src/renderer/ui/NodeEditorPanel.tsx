import { useCallback, useState } from 'react';
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  type Connection,
  type Node,
  type NodeProps,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnNodesDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '../store/appStore';
import { BLEND_KIND, CUSTOM_KIND, OPS, isOpKind } from '../engine/graph/ops';
import { DEVELOP_KIND, type AddableKind } from '../engine/graph/graphDoc';

/** Blend node: two labeled inputs (a = base, b = overlay), one output. */
function BlendNode({ data, selected }: NodeProps) {
  return (
    <div className={`blend-node${selected ? ' selected' : ''}`}>
      <Handle type="target" id="a" position={Position.Left} style={{ top: '30%' }} />
      <Handle type="target" id="b" position={Position.Left} style={{ top: '70%' }} />
      <span className="blend-node-ports">
        a<br />b
      </span>
      <span>{String((data as { label?: string }).label ?? 'blend')}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { blend: BlendNode };

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
  const [addKind, setAddKind] = useState<AddableKind>('exposure');

  const nodes: Node[] = graph.nodes.map((n) => ({
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
            ? 'output (sRGB)'
            : n.kind === DEVELOP_KIND
              ? 'Develop'
              : n.kind === CUSTOM_KIND
                ? 'custom (wgsl)'
                : n.kind === BLEND_KIND
                  ? 'blend'
                  : isOpKind(n.kind)
                    ? OPS[n.kind].label.toLowerCase()
                    : n.kind,
    },
    position: n.position,
    selected: n.id === selectedNodeId,
    sourcePosition: 'right',
    targetPosition: 'left',
    deletable: isOpKind(n.kind) || n.kind === CUSTOM_KIND || n.kind === BLEND_KIND || n.kind === DEVELOP_KIND,
  })) as Node[];

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    targetHandle: e.targetHandle,
    deletable: false,
  }));

  const onNodeClick: NodeMouseHandler = useCallback((_ev, node) => selectNode(node.id), [selectNode]);
  const onNodeDragStop: OnNodeDrag = useCallback((_ev, node) => moveNode(node.id, node.position), [moveNode]);
  const onNodesDelete: OnNodesDelete = useCallback(
    (deleted) => {
      for (const node of deleted) removeOpNode(node.id);
    },
    [removeOpNode]
  );
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const handle = conn.targetHandle === 'a' || conn.targetHandle === 'b' ? conn.targetHandle : undefined;
      connectEdge(conn.source, conn.target, handle);
    },
    [connectEdge]
  );

  return (
    <div className="node-editor">
      <div className="node-editor-toolbar">
        <select value={addKind} onChange={(ev) => setAddKind(ev.target.value as AddableKind)}>
          {Object.values(OPS).map((op) => (
            <option key={op.kind} value={op.kind}>
              {op.label}
            </option>
          ))}
          <option value={BLEND_KIND}>Blend</option>
          <option value={CUSTOM_KIND}>Custom (WGSL)</option>
        </select>
        <button onClick={() => addOpNode(addKind)}>Add node</button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onConnect={onConnect}
        onPaneClick={() => selectNode(null)}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}
