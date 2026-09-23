// Pure helpers extracted from TrackingService.handleLocked. Each is a
// stateless function with deterministic output for a given input — easy to
// unit-test in isolation. State mutation and side effects (callback firing,
// logging, position updates) stay in TrackingService itself.

import type { Blob } from './blob-types';

/**
 * Maximum allowed per-frame jump distance, in minimap pixels. Allows normal
 * frame-to-frame movement plus a growing search radius while holding position
 * so we can re-acquire a blob that moved during the hold.
 */
export function computeMaxJumpPx(
  expectedIconDiam: number,
  holdStartMs: number,
  nowMs: number,
): number {
  const base = Math.max(20, Math.round(expectedIconDiam * 2.0));
  const holdSec = holdStartMs > 0 ? (nowMs - holdStartMs) / 1000 : 0;
  const holdExpansion = holdSec > 0 ? Math.round(expectedIconDiam * holdSec) : 0;
  return base + holdExpansion;
}

/**
 * Classifier confidence threshold for Phase-2 long-distance re-acquisition.
 * After standing still for a while, raise the bar dramatically — a lost icon
 * is more likely a render glitch than a teleport, and we don't want to lock
 * onto a minion wave. After a brief hold (>1s), lower the threshold for
 * faster recovery from genuine teleports.
 */
export function computeReacquireThreshold(
  stationarySec: number,
  holdSec: number,
): number {
  if (stationarySec > 3) return 0.85;
  if (holdSec > 1.0) return 0.35;
  return 0.5;
}

export interface BlobScoreInputs {
  /** 1 = on the predicted point, decays toward 0 at max-jump edge. */
  posScore: number;
  /** 0..1 classifier confidence for this blob being the local champion. */
  clsScore: number;
  /** 0..1 heuristic on how many "white" (champion-mark) pixels surround the blob. */
  whiteScore: number;
  /** 0..1, lower if the blob is suspiciously close to a known ally peer. */
  peerScore: number;
}

/**
 * Composite score for a candidate blob. When the classifier is loaded we
 * weight its confidence heavily; without it, position dominates.
 */
export function computeBlobScore(s: BlobScoreInputs, hasClassifier: boolean): number {
  return hasClassifier
    ? s.posScore * 0.35 + s.clsScore * 0.30 + s.whiteScore * 0.20 + s.peerScore * 0.15
    : s.posScore * 0.45 + s.peerScore * 0.30 + s.whiteScore * 0.25;
}

/** Minimum classifier confidence to follow a blob during Phase 1 tracking. */
export const CLS_FOLLOW_THRESHOLD = 0.2;

export interface ScoreFns {
  cls: (b: Blob) => number;
  white: (b: Blob) => number;
  peer: (b: Blob) => number;
}

export interface ScoredBlob {
  blob: Blob;
  score: number;
}

/**
 * Phase 1: pick the best teal blob within jump range of the predicted
 * position. Returns null if no candidate scored above the (classifier-gated)
 * follow threshold.
 */
export function pickBestBlobInRange(
  tealBlobs: Blob[],
  lastReg: { x: number; y: number },
  predicted: { x: number; y: number },
  maxJumpPx: number,
  hasClassifier: boolean,
  scoreFns: ScoreFns,
): ScoredBlob | null {
  const maxJumpSq = maxJumpPx * maxJumpPx;
  let best: ScoredBlob | null = null;

  for (const b of tealBlobs) {
    const dxLast = b.cx - lastReg.x;
    const dyLast = b.cy - lastReg.y;
    if (dxLast * dxLast + dyLast * dyLast > maxJumpSq) continue;

    const dxPred = b.cx - predicted.x;
    const dyPred = b.cy - predicted.y;
    const posScore = 1 - (dxPred * dxPred + dyPred * dyPred) / maxJumpSq;

    const clsScore = scoreFns.cls(b);
    // Skipping a candidate outright on classifier confidence is only safe
    // while the classifier is informative. When it returns zero for everything
    // — the normal case on real minimap crops — this rejected every blob on
    // every tick, so a lock could never be followed, the hold grew, and the
    // tracker forced a full re-acquisition every five seconds. The caller now
    // passes hasClassifier=false in that situation, which disables this gate
    // and switches computeBlobScore to the weights that do not depend on it.
    if (hasClassifier && clsScore < CLS_FOLLOW_THRESHOLD) continue;

    const score = computeBlobScore(
      { posScore, clsScore, whiteScore: scoreFns.white(b), peerScore: scoreFns.peer(b) },
      hasClassifier,
    );
    if (!best || score > best.score) best = { blob: b, score };
  }
  return best;
}

/**
 * Phase 2: pick the teal blob with the highest classifier confidence above
 * the (adaptive) reacquire threshold, regardless of distance. Handles
 * teleport, respawn, camera pan, blob-overlap recovery.
 */
export function pickClassifierReacquisition(
  tealBlobs: Blob[],
  threshold: number,
  clsScoreFn: (b: Blob) => number,
): ScoredBlob | null {
  let best: ScoredBlob | null = null;
  for (const b of tealBlobs) {
    const clsScore = clsScoreFn(b);
    if (clsScore < threshold) continue;
    if (!best || clsScore > best.score) best = { blob: b, score: clsScore };
  }
  return best;
}

// ---------- v0.3 tracking tweaks (driven by IXAM's v0.1.33 issue #7 logs) ----------

/**
 * After this many ms of continuous hold, extrapolated position is essentially
 * noise — the player could be anywhere. Force a drop back to SCANNING-style
 * classifier-driven full-minimap search rather than continuing to extend the
 * search box. IXAM's v0.1.33 logs showed 44-second holds during which the
 * orchestrator was sending phantom coords; 5s is the budget for "tracking
 * should have recovered by now or it's time to start over."
 */
export const FORCED_REACQUIRE_HOLD_MS = 5000;

export function shouldForceReacquisition(holdStartMs: number, nowMs: number): boolean {
  if (holdStartMs === 0) return false;
  return (nowMs - holdStartMs) >= FORCED_REACQUIRE_HOLD_MS;
}

/**
 * Standard exponential moving average for classifier confidence. `decay` is
 * the weight kept on the current value; `1 - decay` is the weight of the new
 * raw sample.
 *
 * v0.3.0 added a "snap up to raw on any increase" branch to recover from a
 * stuck-at-0 EMA (IXAM v0.1.33). That root cause was actually the Nunu/Dr.
 * Mundo label-mismatch bug (fixed in v0.2.1 — the classifier was returning 0
 * for every blob), NOT the EMA. The snap-up's real-world effect was harmful:
 * a single false-high raw on a wrong blob (a minion, a structure) latched the
 * EMA to 1.0, making the tracker confidently follow it — the "clinging to
 * minions and structures" failure. Reverted to symmetric EMA in v0.3.1; the
 * whole classifier-confidence path is replaced by template matching in v0.4
 * (see docs/plans/2026-06-03-cv-tracking-research.md).
 */
export function nextClassifierEma(currentEma: number, raw: number, decay: number): number {
  return currentEma * decay + raw * (1 - decay);
}

/**
 * Minimum composite score required to accept a SCANNING -> LOCKED transition,
 * and how that bar relaxes the longer we fail to find anything better.
 *
 * Why this exists, from a real session log (2026-09-23, 13:23:06-13:24:09):
 *
 *     Hold exceeded 5000ms — forcing re-acquisition (back to SCANNING)
 *     SCANNING -> LOCKED via composite(score=0.28)
 *     Hold exceeded 5000ms …
 *     SCANNING -> LOCKED via composite(score=0.26)
 *     … eleven cycles in 63 seconds, every score between 0.23 and 0.29,
 *       with "Classifier scores: raw=0.000" — the classifier explicitly
 *       saying "none of these is your champion" …
 *     13:26:17  SCANNING -> LOCKED via composite(score=0.74)   ← a healthy lock
 *
 * The transition had no absolute bar at all: it took the best available blob no
 * matter how bad. Locking onto a teammate's icon is then permanent, because the
 * only exit from LOCKED is a 5 s hold and a wrong-but-followable blob never
 * holds — so wrong coordinates go out at 10 Hz for the rest of the game.
 *
 * The bar decays rather than being fixed, because v0.3.0 shipped a hard
 * classifier gate here and had to revert it in v0.3.1: champions the classifier
 * is weak on could never clear it, so the tracker refused to lock at all and
 * broadcast no position whatsoever. Decaying to roughly the old behaviour means
 * the worst case is "we waited a few seconds first", never "we never lock".
 */
export const LOCK_SCORE_STRICT = 0.45;
export const LOCK_SCORE_FLOOR = 0.20;
/** How long the strict bar is held before it starts giving way. */
export const LOCK_THRESHOLD_HOLD_MS = 2000;
export const LOCK_THRESHOLD_DECAY_MS = 8000;

export function lockScoreThreshold(scanElapsedMs: number): number {
  if (!Number.isFinite(scanElapsedMs) || scanElapsedMs <= LOCK_THRESHOLD_HOLD_MS) {
    return LOCK_SCORE_STRICT;
  }
  if (scanElapsedMs >= LOCK_THRESHOLD_DECAY_MS) return LOCK_SCORE_FLOOR;
  // The bar is held flat first rather than decaying from the instant scanning
  // starts, because one of the eleven bad locks in the log scored 0.44 — close
  // enough to a healthy lock that an immediate decay would have let it through
  // within a second. A fresh scan that is going to find the right icon finds it
  // quickly; giving way only after a couple of seconds costs nothing real.
  const t = (scanElapsedMs - LOCK_THRESHOLD_HOLD_MS) /
    (LOCK_THRESHOLD_DECAY_MS - LOCK_THRESHOLD_HOLD_MS);
  return LOCK_SCORE_STRICT - (LOCK_SCORE_STRICT - LOCK_SCORE_FLOOR) * t;
}

/**
 * How much better another blob's classifier score must be than the one we are
 * following, and for how long, before we abandon the lock.
 *
 * This is the escape hatch from a confidently-wrong lock. It is deliberately
 * *relative*: an absolute "is the tracked blob still plausible" test would fire
 * constantly for champions the classifier scores poorly across the board (the
 * exact failure that got the v0.3.0 gate reverted). Asking "is there a clearly
 * better candidate than the one I am following" is immune to that, because a
 * uniformly weak classifier produces no clear winner either.
 */
export const LOCK_CHALLENGE_MARGIN = 0.35;
export const LOCK_CHALLENGE_MS = 3000;

export function shouldAbandonLock(challengeStartMs: number, nowMs: number): boolean {
  if (challengeStartMs <= 0) return false;
  return nowMs - challengeStartMs >= LOCK_CHALLENGE_MS;
}

/**
 * Centre of League's camera box on the minimap, in region-relative pixels.
 *
 * The box is the bright rectangle showing which part of the map you are
 * looking at. With the camera locked to your champion — League's default —
 * its centre **is** your champion, which makes the entire "which teal ring am
 * I?" problem disappear. The project's own research ranked this P0 and it was
 * never built; the runs were already being detected here purely so they could
 * be *excluded* from the white-pixel score, and the geometry thrown away.
 *
 * Returns null unless the shape is plausibly a camera box: it must be a
 * decent fraction of the minimap, not almost all of it (that would be the
 * minimap frame itself), and roughly landscape.
 */
export function computeViewportCenter(
  viewportMask: Uint8Array, w: number, h: number,
): { x: number; y: number } | null {
  // Connected components, not a global bounding box.
  //
  // buildWhiteMasks marks EVERY white pixel in any run of >=12px as
  // viewport: the camera rectangle, but also the minimap frame, ping
  // animations, path lines and bright terrain. A min/max over all of them at
  // once returns the midpoint between the box and whatever else was bright —
  // a point with no meaning, which this then hands out as the player's
  // position. Each component has to be measured on its own and judged on its
  // own shape.
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let best: { x: number; y: number; score: number } | null = null;

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx;
      if (viewportMask[start] !== 1 || seen[start] === 1) continue;

      seen[start] = 1;
      queue[0] = start;
      let head = 0, tail = 1;
      let minX = sx, maxX = sx, minY = sy, maxY = sy, count = 0;

      while (head < tail) {
        const idx = queue[head++];
        const x = idx % w;
        const y = (idx - x) / w;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        // 8-connected: the box outline is thin, and a 1px diagonal step is
        // enough to break a 4-connected walk into separate pieces.
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const n = ny * w + nx;
            if (viewportMask[n] !== 1 || seen[n] === 1) continue;
            seen[n] = 1;
            queue[tail++] = n;
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (count < 20) continue;
      // Too small to be the camera box...
      if (bw < w * 0.15 || bh < h * 0.10) continue;
      // ...or large enough in EITHER axis to be the minimap frame. This was
      // an && and therefore let a full-width, short mask through.
      if (bw > w * 0.92 || bh > h * 0.92) continue;
      // The camera box is wider than it is tall.
      const aspect = bw / bh;
      if (aspect < 0.9 || aspect > 3.5) continue;
      // An outline, not a filled patch: the box is a rectangle border, so
      // its pixel count is a fraction of its bounding-box area. A solid
      // bright region that happens to be box-shaped is not the camera.
      const fill = count / (bw * bh);
      if (fill > 0.55) continue;
      // A box clipped by the minimap edge reports a centre pulled inward by
      // up to half its width — thousands of game units, in exactly the
      // fountain case the fallback exists for.
      if (minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) continue;

      const score = bw * bh;
      if (!best || score > best.score) {
        best = { x: minX + bw / 2, y: minY + bh / 2, score };
      }
    }
  }

  return best ? { x: best.x, y: best.y } : null;
}
