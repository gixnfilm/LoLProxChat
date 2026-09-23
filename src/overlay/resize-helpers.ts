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

/**
 * Minimum change, in physical pixels, before the overlay asks Rust to resize
 * the window again.
 *
 * Without a dead band this is a feedback loop: resize the window -> the panel
 * relayouts -> ResizeObserver fires -> resize the window. The rAF batching caps
 * it at one round per frame but does not damp it, so it simply runs forever at
 * the refresh rate. A real session log showed `resizeOverlay` firing a
 * sustained **40-41 times per second for nine minutes** — 3629 of 4180 log
 * lines — saturating the same main thread that runs the 30 FPS minimap scan and
 * the 10 Hz volume tick, which is a direct cause of tracking losing the player.
 *
 * 2 px is below the smallest meaningful layout change and comfortably above the
 * sub-pixel churn that devicePixelRatio rounding produces on fractional display
 * scaling (the affected machine runs at 1.5x).
 */
export const RESIZE_DEAD_BAND_PX = 2;

/**
 * Whether a newly measured window height is worth sending to Rust.
 * `lastSent === null` means nothing has been sent yet, so always send.
 */
export function shouldResendHeight(next: number, lastSent: number | null): boolean {
  if (!Number.isFinite(next)) return false;
  if (lastSent === null) return true;
  return Math.abs(next - lastSent) >= RESIZE_DEAD_BAND_PX;
}
