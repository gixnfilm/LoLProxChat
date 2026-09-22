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
