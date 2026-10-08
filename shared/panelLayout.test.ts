import { describe, expect, it } from 'vitest';
import {
  clampInspectorWidth,
  clampNodeEditorHeight,
  DEFAULT_PANEL_LAYOUT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  NODE_EDITOR_MIN,
  sanitizePanelLayout,
} from './panelLayout';

describe('panel layout — clamps', () => {
  it('inspector width stays within its range and leaves the canvas room', () => {
    expect(clampInspectorWidth(10, 1600)).toBe(INSPECTOR_MIN);
    expect(clampInspectorWidth(5000, 1600)).toBe(INSPECTOR_MAX);
    expect(clampInspectorWidth(600, 900)).toBe(540); // 900 − 360 canvas minimum
    expect(clampInspectorWidth(400, 1600)).toBe(400);
  });
  it('a tiny window still allows the minimum inspector width', () => {
    expect(clampInspectorWidth(400, 300)).toBe(INSPECTOR_MIN);
  });
  it('node editor height stays within min and 70 % of the window', () => {
    expect(clampNodeEditorHeight(10, 1000)).toBe(NODE_EDITOR_MIN);
    expect(clampNodeEditorHeight(900, 1000)).toBe(700);
    expect(clampNodeEditorHeight(300, 1000)).toBe(300);
  });
});

describe('panel layout — sanitize', () => {
  it('missing or junk storage gives the defaults', () => {
    expect(sanitizePanelLayout(null)).toEqual(DEFAULT_PANEL_LAYOUT);
    expect(sanitizePanelLayout('x')).toEqual(DEFAULT_PANEL_LAYOUT);
    expect(sanitizePanelLayout({ inspectorWidth: 'wide', nodeEditorHeight: NaN, nodeEditorCollapsed: 1 })).toEqual(
      DEFAULT_PANEL_LAYOUT
    );
  });
  it('valid fields round-trip', () => {
    const l = { inspectorWidth: 420, nodeEditorHeight: 180, nodeEditorCollapsed: true };
    expect(sanitizePanelLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });
});
