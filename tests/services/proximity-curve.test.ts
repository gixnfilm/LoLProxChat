import {
  SERVER_MAX_RANGE,
  MAX_TOTAL_GAIN,
  volumeToDistance,
  shapeProximity,
  computeFinalPeerVolume,
  ProximityCurve,
} from '../../src/services/proximity-curve';

/**
 * The server's curve, copied verbatim from server/src/volumes.ts::calculateVolume.
 * Duplicated here on purpose: these tests exist to prove the client's inverse
 * matches the real server maths, so silently importing a shared helper would
 * defeat the point — if upstream changes the curve, this fixture must be
 * updated and the round-trip test is what catches it.
 */
function serverCalculateVolume(distance: number): number {
  if (distance >= SERVER_MAX_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  const normalized = distance / SERVER_MAX_RANGE;
  return Math.max(0, 1 - normalized * normalized);
}

const CURVE: ProximityCurve = {
  nearRange: 300,
  farRange: SERVER_MAX_RANGE,
  floor: 0.25,
  gamma: 0.7,
};

describe('volumeToDistance', () => {
  test('inverts the server curve at its own documented fixtures', () => {
    // These two values are asserted directly in server/tests/volumes.test.ts.
    expect(volumeToDistance(0.75)).toBeCloseTo(675, 6);
    expect(volumeToDistance(0.4375)).toBeCloseTo(1012.5, 6);
  });

  test('round-trips every distance across the audible range', () => {
    for (let d = 0; d < SERVER_MAX_RANGE; d += 25) {
      expect(volumeToDistance(serverCalculateVolume(d))).toBeCloseTo(d, 6);
    }
  });

  test('endpoints map to the full range', () => {
    expect(volumeToDistance(1)).toBe(0);
    expect(volumeToDistance(0)).toBe(SERVER_MAX_RANGE);
  });

  test('clamps out-of-range and non-finite input instead of returning NaN', () => {
    expect(volumeToDistance(1.5)).toBe(0);
    expect(volumeToDistance(-1)).toBe(SERVER_MAX_RANGE);
    expect(volumeToDistance(NaN)).toBe(SERVER_MAX_RANGE);
  });
});

describe('shapeProximity', () => {
  test('a silenced peer stays silent — the floor must not resurrect them', () => {
    // resolveProximityTargets synthesises 0 for connected-but-absent peers.
    // Treating that as "maximum distance" would lift it to `floor` and make
    // people audible after the server deliberately dropped them.
    expect(shapeProximity(0, CURVE)).toBe(0);
    expect(shapeProximity(-0.2, CURVE)).toBe(0);
  });

  test('non-finite input is silence, not NaN', () => {
    expect(shapeProximity(NaN, CURVE)).toBe(0);
    expect(shapeProximity(undefined as unknown as number, CURVE)).toBe(0);
  });

  test('full-volume peers (allies, or standing on you) pass through', () => {
    expect(shapeProximity(1, CURVE)).toBe(1);
    expect(shapeProximity(1.2, CURVE)).toBe(1);
  });

  test('null curve disables falloff but preserves silence', () => {
    expect(shapeProximity(0.3, null)).toBe(1);
    expect(shapeProximity(0, null)).toBe(0);
  });

  test('full volume inside the near-range plateau', () => {
    const atNear = serverCalculateVolume(CURVE.nearRange);
    expect(shapeProximity(atNear, CURVE)).toBe(1);
    expect(shapeProximity(serverCalculateVolume(100), CURVE)).toBe(1);
  });

  test('monotonically decreasing with distance', () => {
    let prev = Infinity;
    for (let d = CURVE.nearRange; d < SERVER_MAX_RANGE; d += 25) {
      const v = shapeProximity(serverCalculateVolume(d), CURVE);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  test('reaches the floor at the edge of hearing range, never below', () => {
    // 1349u is the loudest still-audible sample; the curve hits the floor
    // exactly at farRange (1350u), which the server already treats as out of
    // range. So the last observable value sits a hair above the floor.
    const edge = shapeProximity(serverCalculateVolume(SERVER_MAX_RANGE - 1), CURVE);
    expect(edge).toBeGreaterThanOrEqual(CURVE.floor);
    expect(edge - CURVE.floor).toBeLessThan(0.01);
  });

  test('lifts distant peers well above the stock server curve', () => {
    // The actual complaint (#21): at 1300u the server hands back 0.073, which
    // is inaudible in practice. The re-shaped curve must be dramatically louder.
    const serverVol = serverCalculateVolume(1300);
    expect(serverVol).toBeCloseTo(0.0726, 3);
    expect(shapeProximity(serverVol, CURVE)).toBeGreaterThan(0.3);
  });

  test('floor 0 still fades all the way to silence at max range', () => {
    const curve = { ...CURVE, floor: 0 };
    const edge = shapeProximity(serverCalculateVolume(SERVER_MAX_RANGE - 1), curve);
    expect(edge).toBeLessThan(0.01);
  });

  test('gamma controls steepness: <1 is louder further out than >1', () => {
    const mid = serverCalculateVolume(800);
    const gentle = shapeProximity(mid, { ...CURVE, floor: 0, gamma: 0.5 });
    const steep = shapeProximity(mid, { ...CURVE, floor: 0, gamma: 2 });
    expect(gentle).toBeGreaterThan(steep);
  });

  test('a corrupt curve degrades instead of producing NaN', () => {
    const bad = { nearRange: NaN, farRange: NaN, floor: NaN, gamma: NaN };
    const v = shapeProximity(0.5, bad);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('computeFinalPeerVolume', () => {
  test('with unity gains it is the original proximity × slider', () => {
    expect(computeFinalPeerVolume(0.5, 0.5)).toBe(0.25);
    expect(computeFinalPeerVolume(0.8, 0.4)).toBeCloseTo(0.32);
  });

  test('group and master gains amplify past 1.0 — the point of the change', () => {
    expect(computeFinalPeerVolume(0.63, 1, 1.6, 1)).toBeCloseTo(1.008, 3);
    expect(computeFinalPeerVolume(1, 1, 1.5, 1.5)).toBeCloseTo(2.25);
  });

  test('total gain is capped so a pathological combination cannot deafen', () => {
    expect(computeFinalPeerVolume(1, 1, 3, 2)).toBe(MAX_TOTAL_GAIN);
  });

  test('silence wins over any gain', () => {
    expect(computeFinalPeerVolume(0, 1, 3, 2)).toBe(0);
    expect(computeFinalPeerVolume(1, 0, 3, 2)).toBe(0);
  });

  test('non-finite inputs collapse to 0 rather than propagating NaN', () => {
    expect(computeFinalPeerVolume(NaN, 1, 1, 1)).toBe(0);
    expect(computeFinalPeerVolume(0.5, NaN, 1, 1)).toBe(0);
    expect(computeFinalPeerVolume(0.5, 1, NaN, 1)).toBe(0);
    expect(computeFinalPeerVolume(0.5, 1, 1, NaN)).toBe(0);
  });
});
