/**
 * Which entries the Inspector's profile Source picker offers.
 *
 * "Adobe Color (local)" is hidden from the picker for new choices
 * (docs/decisions/0003-hide-acrlook-source.md). The engine, store probe and
 * sidecar value are untouched, so flipping this flag back to `true` restores
 * the option exactly as before. A doc that already uses 'acrlook' keeps the
 * option either way, so its current mode stays visible and selectable.
 */
export const ACR_LOOK_IN_SOURCE_PICKER = false;

export function showAcrLookOption(
  acrLookAvailable: boolean,
  currentSource: 'builtin' | 'dcp' | 'acrlook',
  inPicker: boolean = ACR_LOOK_IN_SOURCE_PICKER
): boolean {
  if (currentSource === 'acrlook') return true;
  return inPicker && acrLookAvailable;
}
