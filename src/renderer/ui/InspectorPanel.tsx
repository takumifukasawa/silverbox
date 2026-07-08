import { useAppStore } from '../store/appStore';
import { OPS, isOpKind } from '../engine/graph/ops';

/** Parameter editor for the node selected in the graph. */
export function InspectorPanel() {
  const graph = useAppStore((s) => s.graph);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const updateNodeParam = useAppStore((s) => s.updateNodeParam);

  const node = graph.nodes.find((n) => n.id === selectedNodeId);
  if (!node) {
    return (
      <div className="inspector">
        <div className="inspector-placeholder">Select a node in the graph below.</div>
      </div>
    );
  }
  if (!isOpKind(node.kind)) {
    return (
      <div className="inspector">
        <div className="inspector-placeholder">
          {node.kind === 'input' ? 'Input: the decoded linear image.' : 'Output: sRGB-encoded display.'}
        </div>
      </div>
    );
  }

  const def = OPS[node.kind];
  return (
    <div className="inspector">
      <div className="inspector-title">{def.label}</div>
      {def.params.map((p) => {
        const value = node.params?.[p.key] ?? p.default;
        return (
          <label key={p.key} className="inspector-param">
            <span className="inspector-param-label">
              {p.label}
              <span className="inspector-param-value">{value.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step}
              value={value}
              onChange={(ev) => updateNodeParam(node.id, p.key, Number(ev.target.value))}
            />
          </label>
        );
      })}
    </div>
  );
}
