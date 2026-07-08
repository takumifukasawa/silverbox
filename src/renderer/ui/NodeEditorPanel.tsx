import { useCallback, useState } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnNodesDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '../store/appStore';
import { CUSTOM_KIND, OPS, isOpKind, type OpKind } from '../engine/graph/ops';

/**
 * Node editor rendering the GraphDoc. Selection feeds the inspector; ops can
 * be inserted before the output (toolbar) and removed (Delete/Backspace) —
 * the chain rewires itself. Manual edge wiring comes with branching nodes.
 */
export function NodeEditorPanel() {
  const fileName = useAppStore((s) => s.fileName);
  const graph = useAppStore((s) => s.graph);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const selectNode = useAppStore((s) => s.selectNode);
  const moveNode = useAppStore((s) => s.moveNode);
  const addOpNode = useAppStore((s) => s.addOpNode);
  const removeOpNode = useAppStore((s) => s.removeOpNode);
  const [addKind, setAddKind] = useState<OpKind | typeof CUSTOM_KIND>('exposure');

  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.kind === 'input' ? 'input' : n.kind === 'output' ? 'output' : 'default',
    data: {
      label:
        n.kind === 'input'
          ? fileName
            ? `input — ${fileName}`
            : 'input'
          : n.kind === 'output'
            ? 'output (sRGB)'
            : n.kind === CUSTOM_KIND
              ? 'custom (wgsl)'
              : isOpKind(n.kind)
                ? OPS[n.kind].label.toLowerCase()
                : n.kind,
    },
    position: n.position,
    selected: n.id === selectedNodeId,
    sourcePosition: 'right',
    targetPosition: 'left',
    deletable: isOpKind(n.kind) || n.kind === CUSTOM_KIND,
  })) as Node[];

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
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

  return (
    <div className="node-editor">
      <div className="node-editor-toolbar">
        <select value={addKind} onChange={(ev) => setAddKind(ev.target.value as OpKind | typeof CUSTOM_KIND)}>
          {Object.values(OPS).map((op) => (
            <option key={op.kind} value={op.kind}>
              {op.label}
            </option>
          ))}
          <option value={CUSTOM_KIND}>Custom (WGSL)</option>
        </select>
        <button onClick={() => addOpNode(addKind)}>Add node</button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onPaneClick={() => selectNode(null)}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}
