/**
 * Panel layout (drag-resizable Inspector width, node-editor height, and a
 * collapsible node editor). A per-machine UI preference persisted in
 * settings.json (Settings.panelLayout), never in a sidecar.
 *
 * Why not localStorage: the built app loads from file://, whose storage did
 * not survive a relaunch, and the dev server's origin differs from the built
 * one anyway.
 *
 * Test runs (SILVERBOX_TEST) use Settings.panelLayoutTest instead, so a
 * layout the user left in the app (say, a collapsed node editor) never leaks
 * into the verify scripts when they run against the real userData dir.
 */

export interface PanelLayout {
  inspectorWidth: number;
  nodeEditorHeight: number;
  nodeEditorCollapsed: boolean;
}

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  inspectorWidth: 340,
  nodeEditorHeight: 260,
  nodeEditorCollapsed: false,
};

export const INSPECTOR_MIN = 260;
export const INSPECTOR_MAX = 720;
/** The canvas column keeps at least this much width. */
export const CANVAS_MIN_WIDTH = 360;
export const NODE_EDITOR_MIN = 120;
/** The node editor never takes more than this share of the window height. */
export const NODE_EDITOR_MAX_FRACTION = 0.7;

export function clampInspectorWidth(w: number, windowWidth: number): number {
  const max = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, windowWidth - CANVAS_MIN_WIDTH));
  return Math.round(Math.min(Math.max(w, INSPECTOR_MIN), max));
}

export function clampNodeEditorHeight(h: number, windowHeight: number): number {
  const max = Math.max(NODE_EDITOR_MIN, Math.floor(windowHeight * NODE_EDITOR_MAX_FRACTION));
  return Math.round(Math.min(Math.max(h, NODE_EDITOR_MIN), max));
}

/** Lenient parse of a stored value: anything missing or malformed falls back to the default for that field. */
export function sanitizePanelLayout(raw: unknown): PanelLayout {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    inspectorWidth: num(o.inspectorWidth, DEFAULT_PANEL_LAYOUT.inspectorWidth),
    nodeEditorHeight: num(o.nodeEditorHeight, DEFAULT_PANEL_LAYOUT.nodeEditorHeight),
    nodeEditorCollapsed: typeof o.nodeEditorCollapsed === 'boolean' ? o.nodeEditorCollapsed : false,
  };
}
