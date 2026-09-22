/**
 * Compute the desired Tauri window height for the overlay panel from its
 * measured `panel.scrollHeight`. Pure for testability — the DOM measurement
 * happens at the call site in overlay.ts.
 *
 * - Adds 4px breathing room so content doesn't sit flush against the bottom edge.
 * - Floors at 120px (collapsed-state header height) so a transient zero-height
 *   measurement during DOM transitions doesn't collapse the window to nothing.
 * - Ceilings at 1200px (sanity cap) so we don't try to size larger than the
 *   smallest plausible game resolution height.
 */
const BREATHING_ROOM_PX = 4;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1200;

export function computeDesiredHeight(scrollHeight: number): number {
  const raw = scrollHeight + BREATHING_ROOM_PX;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, raw));
}
