import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '../store/appStore';
import { OPS, isOpKind } from '../engine/graph/ops';

/** Node editor rendering the GraphDoc; selection feeds the inspector. */
export function NodeEditorPanel() {
  const fileName = useAppStore((s) => s.fileName);
  const graph = useAppStore((s) => s.graph);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const selectNode = useAppStore((s) => s.selectNode);
  const moveNode = useAppStore((s) => s.moveNode);

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
            : isOpKind(n.kind)
              ? OPS[n.kind].label.toLowerCase()
              : n.kind,
    },
    position: n.position,
    selected: n.id === selectedNodeId,
    sourcePosition: 'right',
    targetPosition: 'left',
    deletable: false,
  })) as Node[];

  const edges: Edge[] = graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));

  const onNodeClick: NodeMouseHandler = useCallback((_ev, node) => selectNode(node.id), [selectNode]);
  const onNodeDragStop: OnNodeDrag = useCallback((_ev, node) => moveNode(node.id, node.position), [moveNode]);

  return (
    <div className="node-editor">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => selectNode(null)}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}
