/**
 * Client-side re-shaping of the server's proximity volume.
 *
 * The signaling server stays authoritative for *who* you may hear (the team
 * filter and the hard cut-off at vision range). It hands back one number per
 * audible peer, produced by `server/src/volumes.ts::calculateVolume`:
 *
 *     v = 1 - (d / 1350)²          for 0 <= d < 1350
 *
 * That curve is strictly monotonic on the audible interval, so it inverts:
 *
 *     d = 1350 · √(1 - v)
 *
 * Recovering `d` lets the client apply its own falloff — a full-volume plateau
 * near the player, adjustable steepness, and an audible floor at the edge —
 * without touching the server. The shipped curve is very flat up close and
 * cliff-like at the edge (0.75 at 675u, 0.073 at 1300u), which is why distant
 * enemies were effectively inaudible.
 *
 * What this CANNOT do: hear anyone past 1350 units. The server omits those
 * peers from the response entirely rather than sending them at volume 0, so
 * there is nothing to re-shape. Range can be narrowed here, never widened.
 */

/** Must track `MAX_HEARING_RANGE` in server/src/volumes.ts. */
export const SERVER_MAX_RANGE = 1350;

/**
 * Ceiling on the total gain any single peer can reach. Playback runs through a
 * WebAudio GainNode, which happily amplifies past 1.0 — this bounds how far,
 * so a pathological prefs combination (master 2 × enemy 3 = 6) can't blow out
 * someone's ears. The master-bus compressor handles the rest.
 */
export const MAX_TOTAL_GAIN = 4;

export type ProximityMode = 'off' | 'enemy' | 'all';

export interface ProximityCurve {
  /** Game units of full-volume plateau around the listener. */
  nearRange: number;
  /** Game units at which `floor` is reached. Clamped to SERVER_MAX_RANGE. */
  farRange: number;
  /** Volume at and beyond `farRange`, 0..1. The "still audible at the edge" knob. */
  floor: number;
  /** Falloff exponent. <1 fades gently (loud further out), >1 fades steeply. */
  gamma: number;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Invert the server's quadratic falloff to recover the distance it used.
 * Returns game units in [0, SERVER_MAX_RANGE].
 */
export function volumeToDistance(serverVol: number): number {
  const v = clamp(serverVol, 0, 1);
  return SERVER_MAX_RANGE * Math.sqrt(1 - v);
}

/**
 * Re-shape one server proximity value with the user's curve.
 *
 * `curve === null` disables distance falloff: anything audible plays flat at
 * full volume (the server's range filter still applies — we can't undo that).
 *
 * Two values are passed through untouched, and both are load-bearing:
 *   • `serverVol <= 0` means "absent / silenced". The server never returns a
 *     genuine 0 for an audible peer (0 only happens at d >= 1350, and those
 *     peers are dropped from the response), and `resolveProximityTargets`
 *     synthesises 0 for connected-but-absent peers. Feeding that through the
 *     curve would inflate it to `floor` and make silenced peers audible.
 *   • `serverVol >= 1` is either "on top of you" or a full-volume ally, which
 *     is already the maximum the curve can produce.
 */
export function shapeProximity(serverVol: number, curve: ProximityCurve | null): number {
  if (!Number.isFinite(serverVol) || serverVol <= 0) return 0;
  if (serverVol >= 1) return 1;
  if (!curve) return 1;

  const d = volumeToDistance(serverVol);
  const near = clamp(curve.nearRange, 0, SERVER_MAX_RANGE);
  if (d <= near) return 1;

  const far = clamp(curve.farRange, near + 1, SERVER_MAX_RANGE);
  const floor = clamp(curve.floor, 0, 1);
  const gamma = clamp(curve.gamma, 0.05, 8);

  const t = Math.min(1, (d - near) / (far - near));
  return floor + (1 - floor) * Math.pow(1 - t, gamma);
}

/**
 * Combine the shaped proximity volume with the per-player trim slider and the
 * group/master gains into the final playback gain.
 *
 * Proximity and the slider are clamped to [0, 1] defensively — they are
 * attenuations. The gains are amplifications and may push the result past 1.0,
 * up to MAX_TOTAL_GAIN. With both gains left at 1 this is the original
 * `proximity × slider`, which is what the pre-existing tests pin down.
 */
export function computeFinalPeerVolume(
  proximityVol: number,
  sliderVol: number,
  groupGain = 1,
  masterGain = 1,
): number {
  const p = clamp(proximityVol, 0, 1);
  const s = clamp(sliderVol, 0, 1);
  const g = clamp(groupGain, 0, MAX_TOTAL_GAIN);
  const m = clamp(masterGain, 0, MAX_TOTAL_GAIN);
  return clamp(p * s * g * m, 0, MAX_TOTAL_GAIN);
}
