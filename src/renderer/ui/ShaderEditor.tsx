import { useEffect, useRef } from 'react';
import { monaco } from './monacoSetup';
import { useAppStore } from '../store/appStore';

/**
 * Monaco WGSL editor for a custom node. Edits validate + apply 400ms after
 * typing stops (⌘⏎ applies immediately); a broken source shows its error
 * while the last valid shader keeps rendering.
 */
export function ShaderEditor({ nodeId, src }: { nodeId: string; src: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const error = useAppStore((s) => s.shaderErrors[nodeId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value: src,
      language: 'wgsl',
      theme: 'vs-dark',
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: 'on',
    });
    editorRef.current = editor;

    const apply = () => {
      clearTimeout(debounceRef.current);
      void useAppStore.getState().applyShaderSource(nodeId, editor.getValue());
    };
    const sub = editor.onDidChangeModelContent(() => {
      clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(apply, 400);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, apply);

    return () => {
      clearTimeout(debounceRef.current);
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // recreate per node; external src changes (undo/load) are synced below
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync external source changes (undo/redo/sidecar load) into the editor
  // without clobbering an in-progress edit session.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && !editor.hasTextFocus() && editor.getValue() !== src) {
      editor.setValue(src);
    }
  }, [src]);

  return (
    <div className="shader-editor-block">
      <div className="shader-editor-note">
        fn shade(color, uv) → vec3f — color is linear RGB. Applies 400ms after typing stops (⌘⏎ to apply now).
      </div>
      <div ref={hostRef} className="shader-editor" data-testid="shader-editor" />
      {error ? (
        <pre className="shader-error" data-testid="shader-error">
          {error}
        </pre>
      ) : (
        <div className="shader-status-ok" data-testid="shader-status-ok">
          compiled ✓
        </div>
      )}
    </div>
  );
}
