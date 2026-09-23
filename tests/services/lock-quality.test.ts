import {
  lockScoreThreshold,
  shouldAbandonLock,
  LOCK_SCORE_STRICT,
  LOCK_SCORE_FLOOR,
  LOCK_THRESHOLD_HOLD_MS,
  LOCK_THRESHOLD_DECAY_MS,
  LOCK_CHALLENGE_MS,
} from '../../src/services/tracking-helpers';
import { shouldResendHeight, RESIZE_DEAD_BAND_PX } from '../../src/overlay/resize-helpers';

/**
 * Composite scores taken verbatim from a real session log (2026-09-23,
 * 13:23:06-13:24:09) in which the tracker locked onto the wrong champion eleven
 * times in 63 seconds, and from the one healthy lock at 13:26:17.
 */
const BAD_LOCK_SCORES = [0.28, 0.26, 0.29, 0.44, 0.26, 0.25, 0.23, 0.24, 0.25, 0.25, 0.25];
const HEALTHY_LOCK_SCORE = 0.74;

describe('lockScoreThreshold', () => {
  test('rejects every bad lock from the log at the start of a scan', () => {
    const threshold = lockScoreThreshold(0);
    for (const score of BAD_LOCK_SCORES) {
      expect(score).toBeLessThan(threshold);
    }
  });

  test('accepts the healthy lock immediately', () => {
    expect(HEALTHY_LOCK_SCORE).toBeGreaterThanOrEqual(lockScoreThreshold(0));
  });

  test('every bad lock stays rejected for the whole hold window', () => {
    // The observed cycle re-locked ~1s after each forced re-acquisition, so the
    // bar has to still be above those scores then or nothing changes. One of
    // them scored 0.44, which is why the strict bar is held flat rather than
    // decaying immediately.
    const worstBad = Math.max(...BAD_LOCK_SCORES);
    expect(worstBad).toBeCloseTo(0.44, 5);
    for (const t of [0, 500, 1000, LOCK_THRESHOLD_HOLD_MS]) {
      expect(worstBad).toBeLessThan(lockScoreThreshold(t));
    }
  });

  test('decays monotonically from strict to the floor', () => {
    let prev = Infinity;
    for (let t = 0; t <= LOCK_THRESHOLD_DECAY_MS + 2000; t += 250) {
      const v = lockScoreThreshold(t);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      expect(v).toBeGreaterThanOrEqual(LOCK_SCORE_FLOOR);
      expect(v).toBeLessThanOrEqual(LOCK_SCORE_STRICT);
      prev = v;
    }
  });

  test('never stays so strict that a weak champion can never lock', () => {
    // v0.3.0 shipped a hard gate here and v0.3.1 had to revert it because
    // champions the classifier scores poorly could never clear it and the app
    // broadcast no position at all. The floor is what makes that impossible.
    expect(lockScoreThreshold(LOCK_THRESHOLD_DECAY_MS)).toBe(LOCK_SCORE_FLOOR);
    expect(lockScoreThreshold(60_000)).toBe(LOCK_SCORE_FLOOR);
  });

  test('non-finite or negative elapsed time is treated as "just started"', () => {
    expect(lockScoreThreshold(NaN)).toBe(LOCK_SCORE_STRICT);
    expect(lockScoreThreshold(-500)).toBe(LOCK_SCORE_STRICT);
  });
});

describe('shouldAbandonLock', () => {
  test('no challenge in progress never abandons', () => {
    expect(shouldAbandonLock(0, 999_999)).toBe(false);
  });

  test('a brief challenge does not abandon', () => {
    expect(shouldAbandonLock(1000, 1000 + LOCK_CHALLENGE_MS - 1)).toBe(false);
  });

  test('a sustained challenge abandons', () => {
    expect(shouldAbandonLock(1000, 1000 + LOCK_CHALLENGE_MS)).toBe(true);
    expect(shouldAbandonLock(1000, 1000 + LOCK_CHALLENGE_MS * 3)).toBe(true);
  });
});

describe('shouldResendHeight', () => {
  test('always sends the first measurement', () => {
    expect(shouldResendHeight(400, null)).toBe(true);
  });

  test('an unchanged layout sends nothing — this is the 40 Hz loop fix', () => {
    // Logged: resizeOverlay fired 40-41 times per second for nine minutes,
    // 3629 of 4180 log lines, starving the thread the minimap scan runs on.
    expect(shouldResendHeight(400, 400)).toBe(false);
  });

  test('sub-pixel churn from fractional display scaling is absorbed', () => {
    for (let d = 1; d < RESIZE_DEAD_BAND_PX; d++) {
      expect(shouldResendHeight(400 + d, 400)).toBe(false);
      expect(shouldResendHeight(400 - d, 400)).toBe(false);
    }
  });

  test('a real layout change still resizes', () => {
    expect(shouldResendHeight(400 + RESIZE_DEAD_BAND_PX, 400)).toBe(true);
    expect(shouldResendHeight(400 - RESIZE_DEAD_BAND_PX, 400)).toBe(true);
    expect(shouldResendHeight(935, 180)).toBe(true);
  });

  test('a non-finite measurement is never sent', () => {
    expect(shouldResendHeight(NaN, 400)).toBe(false);
  });
});
