/**
 * Work out *where* a voice is coming from, using only the champion icons that
 * are already visible on our own minimap.
 *
 * The idea, and why it is allowed: if an icon is on your minimap, the game has
 * already told you where that player is. Reading it back off the minimap leaks
 * nothing. That is what makes directional audio possible for **enemies** at
 * all — exchanging coordinates over the network would have been a wallhack,
 * and was the reason this feature looked impossible at first. It also means
 * fog of war is handled for free: someone you cannot see produces no icon, so
 * their voice simply stays centred.
 *
 * The hard part is not detection — `TrackingService` already finds and
 * validates every icon, ally and enemy alike, and throws the enemies away one
 * line later. The hard part is *attribution*: the server tells us "you can
 * hear Zed at volume 0.62", the minimap shows us two red dots, and nothing
 * connects the two.
 *
 * Three signals do connect them, in order of strength:
 *
 * 1. **Scarcity.** The server only sends peers within ~1350 units, on a map
 *    14870 units across. In practice that means zero or one audible enemy at a
 *    time. One audible enemy plus one plausible red icon is not a guess.
 * 2. **Distance.** Between 900 and 1350 units the server's volume encodes the
 *    real distance, so an icon at the wrong radius can be ruled out outright.
 *    Inside 900 units the server reports a flat 1.0 and this signal vanishes —
 *    which is exactly the crowded near-field, so it is used to *reject*
 *    candidates, never to pick one.
 * 3. **Continuity.** Once a peer is bound to an icon, that icon is followed
 *    across frames. A binding made during a clean one-on-one survives into the
 *    teamfight that follows, where instantaneous matching would fail.
 *
 * When none of that resolves to a single candidate we return nothing and the
 * caller centres the voice. A wrong direction is worse than no direction:
 * people act on it.
 *
 * Deliberately NOT used: the champion classifier. It scores 0.695 top-1, this
 * project has abandoned appearance matching twice, and the measurement on real
 * harvested crops was "32px crops are background-dominated". On enemy icons it
 * has never been evaluated at all. It would produce confident wrong answers.
 */

import { Position } from '../core/types';
import { MEASURED_CUTOFF_UNITS, MEASURED_FADE_START_UNITS, fadePosition } from './proximity-curve';

export type PeerSide = 'ally' | 'enemy';

/** A champion icon seen on the minimap, converted to game coordinates. */
export interface IconObservation {
  pos: Position;
  side: PeerSide;
}

/** What the mixer knows about one audible peer this tick. */
export interface AudiblePeer {
  name: string;
  side: PeerSide;
  /** The raw value from /compute-volumes; >= 1 means "inside the plateau". */
  serverVol: number;
}

export interface LocateInput {
  /** Our own tracked position, in game units. */
  self: Position;
  /** Icons on the minimap, excluding our own. */
  icons: IconObservation[];
  peers: AudiblePeer[];
  /** Last frame's result, for continuity. */
  previous: ReadonlyMap<string, Position>;
}

/**
 * How far off the server-derived radius an icon may sit and still be accepted.
 *
 * One minimap pixel is 27-74 game units depending on HUD scale, centroids are
 * integer-rounded, and the ring shape jitters by a pixel or two frame to
 * frame — so a few hundred units of slack is the measurement noise, not
 * generosity.
 */
export const RADIUS_TOLERANCE_UNITS = 300;

/**
 * How far a bound icon may move between frames and still be considered the
 * same player. At ~10 Hz even a dashing champion covers far less than this.
 */
export const CONTINUITY_JUMP_UNITS = 900;

function distance(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Distance the server implies for a volume, or null when it implies only
 * "somewhere inside the plateau".
 */
export function impliedDistance(serverVol: number): number | null {
  if (!Number.isFinite(serverVol) || serverVol <= 0) return null;
  if (serverVol >= 1) return null;
  const u = fadePosition(serverVol);
  return MEASURED_FADE_START_UNITS + u * (MEASURED_CUTOFF_UNITS - MEASURED_FADE_START_UNITS);
}

/** Could this icon be this peer, on distance grounds alone? */
function radiusAllows(iconDist: number, serverVol: number): boolean {
  const implied = impliedDistance(serverVol);
  if (implied === null) {
    // Plateau: all we know is "closer than the fade start".
    return iconDist <= MEASURED_FADE_START_UNITS + RADIUS_TOLERANCE_UNITS;
  }
  return Math.abs(iconDist - implied) <= RADIUS_TOLERANCE_UNITS;
}

/**
 * Attribute visible icons to audible peers.
 *
 * Returns only the peers we are confident about. A peer left out of the result
 * has no usable direction and must be played centred.
 */
export function locatePeers(input: LocateInput): Map<string, Position> {
  const out = new Map<string, Position>();
  if (!input.peers.length || !input.icons.length) return out;

  const taken = new Set<IconObservation>();

  // Pass 1 — continuity. A peer already bound to an icon keeps it as long as
  // something plausible is near where it was. Done first so a settled binding
  // is never stolen by a fresh ambiguous match.
  for (const peer of input.peers) {
    const prev = input.previous.get(peer.name);
    if (!prev) continue;
    let best: IconObservation | null = null;
    let bestDist = Infinity;
    for (const icon of input.icons) {
      if (taken.has(icon) || icon.side !== peer.side) continue;
      const moved = distance(icon.pos, prev);
      if (moved > CONTINUITY_JUMP_UNITS || moved >= bestDist) continue;
      if (!radiusAllows(distance(icon.pos, input.self), peer.serverVol)) continue;
      best = icon;
      bestDist = moved;
    }
    if (best) {
      taken.add(best);
      out.set(peer.name, best.pos);
    }
  }

  // Pass 2 — scarcity. An icon is accepted only when the match is unambiguous
  // in BOTH directions: this peer has exactly one candidate icon, and that
  // icon has exactly one candidate peer. Checking only the first direction
  // would hand the single visible icon to whichever of two equidistant peers
  // happened to be listed first — a coin flip dressed up as a measurement.
  const unbound = input.peers.filter((p) => !out.has(p.name));
  const candidates = new Map<AudiblePeer, IconObservation[]>();
  for (const peer of unbound) {
    const forPeer: IconObservation[] = [];
    for (const icon of input.icons) {
      if (taken.has(icon) || icon.side !== peer.side) continue;
      if (!radiusAllows(distance(icon.pos, input.self), peer.serverVol)) continue;
      forPeer.push(icon);
    }
    candidates.set(peer, forPeer);
  }

  for (const peer of unbound) {
    const forPeer = candidates.get(peer);
    if (!forPeer || forPeer.length !== 1) continue;
    const icon = forPeer[0];
    let contendingPeers = 0;
    for (const other of unbound) {
      if (candidates.get(other)?.includes(icon)) contendingPeers++;
    }
    if (contendingPeers !== 1) continue;
    taken.add(icon);
    out.set(peer.name, icon.pos);
  }

  return out;
}

/**
 * Left/right position for a voice, -1 (hard left) to +1 (hard right).
 *
 * The minimap is fixed north-up regardless of which side you are on, so a
 * larger x really is "to the right" with no camera transform. Normalised by
 * hearing range rather than map size, because everything audible is inside
 * that radius — normalising by the map would compress every pan to nearly
 * nothing.
 */
export function panFor(self: Position, peer: Position | undefined, width: number): number {
  if (!peer) return 0;
  const w = Number.isFinite(width) ? Math.max(0, Math.min(1.5, width)) : 1;
  const raw = (peer.x - self.x) / MEASURED_CUTOFF_UNITS;
  const clamped = Math.max(-1, Math.min(1, raw));
  return Math.max(-1, Math.min(1, clamped * w));
}
