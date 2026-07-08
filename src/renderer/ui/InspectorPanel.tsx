import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { CUSTOM_KIND, CUSTOM_PARAM_DEFS, DEFAULT_CUSTOM_CODE, OPS, isOpKind, type OpParamDef } from '../engine/graph/ops';
import type { GraphNode } from '../engine/graph/graphDoc';
import { HistogramPanel } from './HistogramPanel';

function ParamSlider({ nodeId, def, value }: { nodeId: string; def: OpParamDef; value: number }) {
  const updateNodeParam = useAppStore((s) => s.updateNodeParam);
  return (
    <label className="inspector-param">
      <span className="inspector-param-label">
        {def.label}
        <span className="inspector-param-value">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(ev) => updateNodeParam(nodeId, def.key, Number(ev.target.value))}
      />
    </label>
  );
}

/** WGSL editor for a custom node: edit freely, compile on Apply. */
function CustomEditor({ node }: { node: GraphNode }) {
  const updateNodeCode = useAppStore((s) => s.updateNodeCode);
  const error = useAppStore((s) => s.shaderErrors[node.id]);
  const savedCode = node.code ?? DEFAULT_CUSTOM_CODE;
  const [draft, setDraft] = useState(savedCode);
  useEffect(() => setDraft(savedCode), [node.id, savedCode]);

  return (
    <>
      <textarea
        className="inspector-code"
        spellCheck={false}
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
      />
      <div className="inspector-code-actions">
        <button onClick={() => updateNodeCode(node.id, draft)} disabled={draft === savedCode}>
          Apply
        </button>
        {error && (
          <pre className="inspector-code-error" data-testid="shader-error">
            {error}
          </pre>
        )}
      </div>
    </>
  );
}

function NodeContent({ node }: { node: GraphNode | undefined }) {
  if (!node) {
    return <div className="inspector-placeholder">Select a node in the graph below.</div>;
  }
  if (node.kind === CUSTOM_KIND) {
    return (
      <>
        <div className="inspector-title">Custom (WGSL)</div>
        <CustomEditor node={node} />
        {CUSTOM_PARAM_DEFS.map((p) => (
          <ParamSlider key={p.key} nodeId={node.id} def={p} value={node.params?.[p.key] ?? p.default} />
        ))}
      </>
    );
  }
  if (!isOpKind(node.kind)) {
    return (
      <div className="inspector-placeholder">
        {node.kind === 'input' ? 'Input: the decoded linear image.' : 'Output: sRGB-encoded display.'}
      </div>
    );
  }
  const def = OPS[node.kind];
  return (
    <>
      <div className="inspector-title">{def.label}</div>
      {def.params.map((p) => (
        <ParamSlider key={p.key} nodeId={node.id} def={p} value={node.params?.[p.key] ?? p.default} />
      ))}
    </>
  );
}

/** Histogram + parameter editor for the node selected in the graph. */
export function InspectorPanel() {
  const graph = useAppStore((s) => s.graph);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const node = graph.nodes.find((n) => n.id === selectedNodeId);
  return (
    <div className="inspector">
      <HistogramPanel />
      <NodeContent node={node} />
    </div>
  );
}
