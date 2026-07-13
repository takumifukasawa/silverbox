/** <input> types that actually accept free text/numeric entry — everything
 *  else (range, checkbox, radio, color, button…) is a plain control and must
 *  NOT block window-level shortcuts just because it happens to hold focus. */
const TEXT_ENTRY_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'password', 'tel', 'url']);

/**
 * Single source of truth for "is the keydown target a text-entry surface" —
 * used to guard every window-level shortcut in App.tsx (and, since round-10,
 * CanvasView.tsx's spot-mode `[`/`]` brush-radius keys — pulled out of App.tsx
 * into its own module rather than imported from there, since App.tsx itself
 * imports CanvasView and a reverse import would be circular). Previously each
 * handler inlined its own `tagName === 'INPUT'` check, which blocked
 * shortcuts for ANY input (including the crop angle range slider and
 * checkboxes) rather than just genuine text entry — that's why ⌘Z/O
 * "sometimes" didn't fire: it depended on which control last held focus, not
 * on whether the user was actually typing (#46/undo-focus).
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type || 'text';
    return TEXT_ENTRY_INPUT_TYPES.has(type);
  }
  // Monaco renders into plain <div>/<textarea> nodes inside .shader-editor —
  // its own undo stack and keybindings must own the keystroke, not ours.
  return !!el.closest?.('.shader-editor');
}
