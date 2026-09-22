import { nextSmoothedVolume } from '../../src/services/peer-connection';
import { MAX_TOTAL_GAIN } from '../../src/services/proximity-curve';

describe('nextSmoothedVolume', () => {
  test('first call (prev=null) snaps directly to the target', () => {
    expect(nextSmoothedVolume(null, 0.8, 1000, 0)).toBe(0.8);
  });

  test('clamps target to [0, MAX_TOTAL_GAIN]', () => {
    // The ceiling is no longer 1.0: the boost path amplifies past unity, so
    // the smoother has to be able to carry those targets. It still must not
    // pass an unbounded value through to an AudioParam.
    expect(nextSmoothedVolume(null, 1.5, 0, 0)).toBe(1.5);
    expect(nextSmoothedVolume(null, 99, 0, 0)).toBe(MAX_TOTAL_GAIN);
    expect(nextSmoothedVolume(null, -0.3, 0, 0)).toBe(0);
    expect(nextSmoothedVolume(0.5, 99, 100, 0)).toBeLessThanOrEqual(MAX_TOTAL_GAIN);
  });

  test('a non-finite target is treated as silence, not propagated', () => {
    // updateSettings / the server response are both `any`-typed upstream;
    // NaN reaching an AudioParam assignment throws and kills playback.
    expect(nextSmoothedVolume(null, NaN, 0, 0)).toBe(0);
    expect(Number.isFinite(nextSmoothedVolume(0.5, NaN, 100, 0))).toBe(true);
  });

  test('short dt produces a small step toward the target', () => {
    // 100ms gap, prev=0, target=1 → ~24% of the way there
    const out = nextSmoothedVolume(0, 1, 100, 0);
    expect(out).toBeGreaterThan(0.2);
    expect(out).toBeLessThan(0.3);
  });

  test('long dt is capped at alpha=0.3 — no instant snap to loud target', () => {
    // 60s gap would naively give alpha ≈ 1. Cap forces 0.3.
    // prev=0, target=1 → result ≤ 0.3
    const out = nextSmoothedVolume(0, 1, 60_000, 0);
    expect(out).toBeCloseTo(0.3, 5);
  });

  test('repeated calls converge toward the target over multiple ticks', () => {
    let smoothed: number | null = 0;
    let t = 0;
    const target = 1;
    // 1-second cadence × 5 ticks
    for (let i = 0; i < 5; i++) {
      t += 1000;
      smoothed = nextSmoothedVolume(smoothed, target, t, t - 1000);
    }
    // After 5 seconds of constant target, should be well above 0.8
    expect(smoothed).toBeGreaterThan(0.8);
    // And below or at the cap-bounded ceiling
    expect(smoothed).toBeLessThanOrEqual(1);
  });

  test('symmetric: ramping down works the same way as ramping up', () => {
    const downStep = nextSmoothedVolume(1, 0, 1000, 0);
    const upStep = nextSmoothedVolume(0, 1, 1000, 0);
    // Both should move ~the same fraction of the gap, just in opposite directions
    expect(downStep).toBeCloseTo(1 - upStep, 5);
  });
});
