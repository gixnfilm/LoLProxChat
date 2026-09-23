// Voice gate for "Always Open" mode.
//
// Always Open transmits continuously: typing, breathing, a fan, a housemate.
// There was no speech detection anywhere in the app — only "on" and
// "push to talk" — so the only way to stop broadcasting your keyboard was to
// hold a key down while talking.
//
// The mic level is already measured (the analyser behind the 2-second
// [Audio] mic=... log line); this turns that number into a decision.

/**
 * Convert a raw RMS reading into the 0-100 scale the slider and the meter
 * both use.
 *
 * Square-rooted rather than linear because loudness is not: on a linear scale
 * ordinary speech sits in the bottom fifth of the range and every useful
 * threshold would be crammed into the first few slider positions. Here quiet
 * speech lands around 20-40 and a raised voice near 100, so the slider has
 * usable resolution exactly where people set it.
 */
export function levelPercent(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(100, Math.sqrt(rms / 0.3) * 100);
}

export interface GateState {
  /** Whether audio is currently passing. */
  open: boolean;
  /** Timestamp of the last reading at or above the bar, ms. */
  lastAboveMs: number;
}

export const CLOSED_GATE: Readonly<GateState> = Object.freeze({
  open: false,
  lastAboveMs: 0,
});

/**
 * How far the level may fall below the threshold before the gate starts its
 * hold. Without this margin a voice sitting exactly on the threshold flips the
 * gate on every tick and stutters.
 */
const RELEASE_RATIO = 0.7;

/**
 * Advance the gate by one reading.
 *
 * `holdMs` keeps the gate open through the gaps *inside* speech — the pause
 * between sentences, the silence in the middle of a stop consonant. A gate
 * without a hold cuts the tail off every word and sounds broken; 300 ms or so
 * is enough to sound continuous while still closing between turns.
 *
 * A threshold of 0 means the feature is off and the gate is simply always
 * open, which is exactly the old behaviour.
 */
export function updateGate(
  prev: GateState,
  level: number,
  threshold: number,
  nowMs: number,
  holdMs: number,
): GateState {
  if (threshold <= 0) return { open: true, lastAboveMs: nowMs };

  const bar = prev.open ? threshold * RELEASE_RATIO : threshold;
  if (level >= bar) return { open: true, lastAboveMs: nowMs };
  if (prev.open && nowMs - prev.lastAboveMs < holdMs) return prev;
  return { open: false, lastAboveMs: prev.lastAboveMs };
}
