/**
 * Client-side re-shaping of the server's proximity volume.
 *
 * The signaling server stays authoritative for *who* you may hear (the team
 * filter and the hard cut-off at vision range) and hands back one number per
 * audible peer. What that number means was measured against the live server on
 * 2026-09-23 (`scripts/probe-server-curve.mjs`, re-runnable):
 *
 *     d <  900        -> 1.0                        (full-volume plateau)
 *     900 <= d < 1350 -> 1 - ((d - 900) / 450)²     (quadratic fade)
 *     d >= 1350       -> omitted from the response entirely
 *
 * Two things about that are worth stating plainly, because the previous
 * version of this file assumed otherwise and got both wrong:
 *
 * 1. **The constants are not ours and they drift.** The bundled server source
 *    says `1 - (d/1350)²` with no plateau — the deployed server disagrees. So
 *    nothing here inverts to absolute game units any more. Everything works in
 *    `u = √(1 - v)`, the normalised position inside whatever fade band the
 *    server happens to use: `u = 0` at the near edge, `u = 1` at the cut-off.
 *    That quantity is correct for any curve of the form `1 - (progress)²`,
 *    whatever its endpoints, so a server-side retune cannot silently skew the
 *    client's idea of distance the way the hardcoded 1350 did.
 *
 * 2. **The audible radius is tiny.** 1350 units on a 14870-unit map is roughly
 *    a lane segment. Peers are *usually* out of range and therefore simply
 *    absent from the response — which is why "absent" must not be conflated
 *    with "silent" for teammates. See `resolvePeerLevel`.
 *
 * What the client genuinely controls: the shape inside the fade band, the
 * level teammates keep once they leave it, and the group/master gains. What it
 * cannot do is manufacture resolution the server didn't send — a returned
 * 1.0 carries no distance information at all.
 */

/**
 * Ceiling on the total gain any single peer can reach. Playback runs through a
 * WebAudio GainNode, which happily amplifies past 1.0 — this bounds how far,
 * so a pathological prefs combination (master 2 × enemy 3 = 6) can't blow out
 * someone's ears. The master-bus compressor handles the rest.
 */
export const MAX_TOTAL_GAIN = 4;

/**
 * The measured cut-off, in game units. Used only to describe the settings to
 * the user — no maths depends on it, by design (see the header).
 */
export const MEASURED_CUTOFF_UNITS = 1350;
/** The measured near edge of the fade band, in game units. Display only. */
export const MEASURED_FADE_START_UNITS = 900;

export type ProximityMode = 'off' | 'enemy' | 'all';

export interface ProximityCurve {
  /**
   * How far into the server's fade band to stay at full volume, 0..0.9.
   * 0 means "start fading as soon as the server does". The server already
   * provides its own near-field plateau, so this only narrows the band
   * further; it cannot widen it.
   */
  nearFraction: number;
  /** Level at (and beyond) the far edge of the band, 0..1. */
  floor: number;
  /** Falloff exponent. <1 fades gently (loud further out), >1 fades steeply. */
  gamma: number;
}

/** One tick's worth of information about one peer. */
export type TickSample =
  /** The server returned a volume for this peer. */
  | { kind: 'server'; vol: number }
  /** The server answered, but this peer was not in the response. */
  | { kind: 'absent' }
  /** This tick never reached the server (no own position, or request failed). */
  | { kind: 'no-data' };

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Normalised position inside the server's fade band: 0 at the near edge (full
 * volume), 1 at the cut-off. Derived from `v = 1 - progress²`, so it holds for
 * any endpoints the server chooses.
 */
export function fadePosition(serverVol: number): number {
  return Math.sqrt(1 - clamp(serverVol, 0, 1));
}

/**
 * Re-shape one server proximity value with the user's curve.
 *
 * `curve === null` disables distance falloff: anything audible plays flat at
 * full volume (the server's range filter still applies — we can't undo that).
 *
 * Two values pass through untouched, and both are load-bearing:
 *   • `serverVol <= 0` means silence. Feeding it through the curve would lift
 *     it to `floor`.
 *   • `serverVol >= 1` means the peer is inside the server's own plateau. It
 *     carries no distance information, so there is nothing to shape.
 */
export function shapeProximity(serverVol: number, curve: ProximityCurve | null): number {
  if (!Number.isFinite(serverVol) || serverVol <= 0) return 0;
  if (serverVol >= 1) return 1;
  if (!curve) return 1;

  const u = fadePosition(serverVol);
  const near = clamp(curve.nearFraction, 0, 0.9);
  if (u <= near) return 1;

  const floor = clamp(curve.floor, 0, 1);
  const gamma = clamp(curve.gamma, 0.05, 8);
  const t = Math.min(1, (u - near) / (1 - near));
  return floor + (1 - floor) * Math.pow(1 - t, gamma);
}

/**
 * The level a teammate keeps once they leave the server's hearing radius.
 *
 * `floor` is continuous with the curve, which asymptotes to exactly this value
 * at the cut-off, so crossing the boundary makes no audible step.
 *
 * It defaults to 0 — out of range means silent, the same as an enemy. A
 * non-zero floor was tried first, on the reasoning that the radius is small
 * enough to cost you your team otherwise, but in play it simply sounded like
 * teammates were audible everywhere, which is the thing proximity chat exists
 * to avoid. The case that argument was really worried about — not knowing
 * where anyone is — is handled separately by allyUnknownLevel.
 *
 * With falloff disabled for this peer (`curve === null`, i.e. Proximity OFF or
 * ENEMY) teammates are meant to be unconditionally audible, so it is 1.0.
 */
function allyOutOfRangeLevel(curve: ProximityCurve | null): number {
  return curve ? clamp(curve.floor, 0, 1) : 1;
}

/**
 * What a teammate should sound like when we have no idea where *we* are.
 *
 * Always full volume, never the out-of-range level — and the distinction is
 * the whole point. A teammate missing from the server's response is *evidence*
 * of distance: the server looked, and they were too far. A tick that never
 * reached the server is the *absence* of evidence, and the missing piece is
 * our own position, not theirs.
 *
 * Conflating the two silenced entire teams. With the out-of-range level set to
 * silence, every game began with nobody able to hear anyone: tracking is still
 * scanning in the fountain, so every tick is a no-data tick, so everyone was
 * treated as too far away. The same applied after every death and every
 * tracking hiccup.
 */
function allyUnknownLevel(): number {
  return 1;
}

export interface PeerLevelInput {
  tick: TickSample;
  isAlly: boolean;
  /** Falloff curve for this peer, or null when falloff is off for them. */
  curve: ProximityCurve | null;
  /** Last level actually applied, for hold-through-a-gap. */
  lastLevel: number | undefined;
  /** ms since this peer was last present in a server response. */
  msSinceSeen: number | undefined;
  /** How long to hold the last level when a peer drops out of a response. */
  graceMs: number;
  /** How long to hold when the tick itself had no server data (allies only). */
  allyHoldMs: number;
}

/**
 * Decide one peer's shaped level (0..1, before trim and group gain).
 *
 * The asymmetry between allies and enemies here is deliberate and is the whole
 * point of the function:
 *
 * **Enemies are never synthesised.** Present → shaped; absent → hold briefly,
 * then 0. The server omits out-of-range enemies precisely so that no client
 * can hear them (it is the anti-cheat boundary), so inventing a level for an
 * absent enemy — on a lost-tracking tick, say — would hand every user a
 * hearing-range bypass. There is no mode in which that is acceptable.
 *
 * **Allies may be synthesised**, because for them absence is ordinary (out of
 * a 1350-unit radius on a 14870-unit map) rather than a privacy boundary:
 * allies see each other on the minimap regardless.
 */
export function resolvePeerLevel(input: PeerLevelInput): number {
  const { tick, isAlly, curve, lastLevel, msSinceSeen, graceMs, allyHoldMs } = input;

  if (tick.kind === 'server') {
    return shapeProximity(tick.vol, curve);
  }

  const withinGrace = msSinceSeen !== undefined && msSinceSeen <= graceMs;

  if (tick.kind === 'absent') {
    // A single dropped coords packet on a lossy link briefly removes a peer
    // from the response; holding across that keeps the audio from blipping to
    // silence and straight back (#27).
    if (withinGrace && lastLevel !== undefined) return lastLevel;
    return isAlly ? allyOutOfRangeLevel(curve) : 0;
  }

  // kind === 'no-data': we have no position of our own this tick, so there is
  // no distance for anyone. For an enemy that means exactly what absence means.
  if (!isAlly) {
    if (withinGrace && lastLevel !== undefined) return lastLevel;
    return 0;
  }
  // For an ally the missing information is *ours*, not theirs — their last
  // known level is the best estimate available, so hold it rather than ducking
  // the whole team every time tracking hiccups (which happens on every death).
  const holdable = msSinceSeen === undefined || msSinceSeen <= allyHoldMs;
  if (holdable && lastLevel !== undefined) return lastLevel;
  return allyUnknownLevel();
}

/**
 * Combine the shaped proximity level with the per-player trim slider and the
 * group/master gains into the final playback gain.
 *
 * Level and trim are clamped to [0, 1] defensively — they are attenuations.
 * The gains are amplifications and may push the result past 1.0, up to
 * MAX_TOTAL_GAIN. With both gains left at 1 this is the original
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
