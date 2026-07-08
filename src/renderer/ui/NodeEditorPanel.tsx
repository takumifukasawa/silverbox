import { ReactFlow, Background, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Placeholder graph until GraphDoc lands (milestone 3+): a bare input→output
// chain laid out the same way the real fallback layout will position nodes.
const nodes: Node[] = [
  {
    id: 'in',
    type: 'input',
    data: { label: 'input' },
    position: { x: 40, y: 60 },
    sourcePosition: 'right',
    deletable: false,
  } as Node,
  {
    id: 'out',
    type: 'output',
    data: { label: 'output (sRGB)' },
    position: { x: 260, y: 60 },
    targetPosition: 'left',
    deletable: false,
  } as Node,
];

const edges: Edge[] = [{ id: 'in-out', source: 'in', target: 'out' }];

export function NodeEditorPanel() {
  return (
    <div className="node-editor">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}
