import {
  MAX_TOTAL_GAIN,
  MEASURED_CUTOFF_UNITS,
  MEASURED_FADE_START_UNITS,
  fadePosition,
  shapeProximity,
  resolvePeerLevel,
  computeFinalPeerVolume,
  ProximityCurve,
  TickSample,
} from '../../src/services/proximity-curve';

/**
 * The live server's actual curve, measured on 2026-09-23 against
 * proxchat.dant123.com (see scripts/probe-server-curve.mjs). Every sample
 * matched to within 5e-5:
 *
 *   d <  900        -> 1.0
 *   900 <= d < 1350 -> 1 - ((d - 900) / 450)²
 *   d >= 1350       -> omitted from the response
 *
 * Kept here as a fixture rather than imported, because these tests exist to
 * prove the client behaves correctly against the REAL server — which does not
 * match the bundled server source (that one says `1 - (d/1350)²`, no plateau).
 * If the deployed curve is retuned again, re-run the probe and update this.
 */
function serverVolume(distance: number): number | undefined {
  if (distance >= MEASURED_CUTOFF_UNITS) return undefined;
  if (distance < MEASURED_FADE_START_UNITS) return 1;
  const band = MEASURED_CUTOFF_UNITS - MEASURED_FADE_START_UNITS;
  return 1 - ((distance - MEASURED_FADE_START_UNITS) / band) ** 2;
}

const CURVE: ProximityCurve = { nearFraction: 0, floor: 0.25, gamma: 0.7 };

const base = {
  curve: CURVE as ProximityCurve | null,
  lastLevel: undefined as number | undefined,
  msSinceSeen: undefined as number | undefined,
  graceMs: 1500,
  allyHoldMs: 5000,
  everTracked: true,
};
const SERVER = (vol: number): TickSample => ({ kind: 'server', vol });
const ABSENT: TickSample = { kind: 'absent' };
const NO_DATA: TickSample = { kind: 'no-data' };

describe('fadePosition', () => {
  test('0 at the near edge of the band, 1 at the cut-off', () => {
    expect(fadePosition(1)).toBe(0);
    expect(fadePosition(0)).toBe(1);
  });

  test('recovers the position within the measured server band', () => {
    // 1200u sits 300 of 450 units into the band -> 2/3 of the way across.
    expect(fadePosition(serverVolume(1200)!)).toBeCloseTo(2 / 3, 6);
    expect(fadePosition(serverVolume(1100)!)).toBeCloseTo(200 / 450, 6);
    expect(fadePosition(serverVolume(1340)!)).toBeCloseTo(440 / 450, 6);
  });

  test('is range-free: the same fraction whatever endpoints the server uses', () => {
    // The whole reason this is a fraction and not game units — the bundled
    // server source and the deployed server disagree about both endpoints.
    const other = (d: number, lo: number, hi: number) => 1 - ((d - lo) / (hi - lo)) ** 2;
    expect(fadePosition(other(675, 0, 1350))).toBeCloseTo(0.5, 6);
    expect(fadePosition(other(2250, 0, 4500))).toBeCloseTo(0.5, 6);
    expect(fadePosition(other(1125, 900, 1350))).toBeCloseTo(0.5, 6);
  });

  test('clamps out-of-range and non-finite input instead of returning NaN', () => {
    expect(fadePosition(1.5)).toBe(0);
    expect(fadePosition(-1)).toBe(1);
    expect(fadePosition(NaN)).toBe(1);
  });
});

describe('shapeProximity', () => {
  test('silence stays silence — the floor must not resurrect a silenced peer', () => {
    expect(shapeProximity(0, CURVE)).toBe(0);
    expect(shapeProximity(-0.2, CURVE)).toBe(0);
  });

  test('non-finite input is silence, not NaN', () => {
    expect(shapeProximity(NaN, CURVE)).toBe(0);
    expect(shapeProximity(undefined as unknown as number, CURVE)).toBe(0);
  });

  test('1.0 passes through — it carries no distance to shape', () => {
    expect(shapeProximity(1, CURVE)).toBe(1);
    expect(shapeProximity(1.2, CURVE)).toBe(1);
  });

  test('null curve disables falloff but preserves silence', () => {
    expect(shapeProximity(0.3, null)).toBe(1);
    expect(shapeProximity(0, null)).toBe(0);
  });

  test('full volume everywhere inside the server plateau', () => {
    for (const d of [0, 300, 600, 899]) {
      expect(shapeProximity(serverVolume(d)!, CURVE)).toBe(1);
    }
  });

  test('monotonically decreasing across the fade band', () => {
    let prev = Infinity;
    for (let d = MEASURED_FADE_START_UNITS; d < MEASURED_CUTOFF_UNITS; d += 10) {
      const v = shapeProximity(serverVolume(d)!, CURVE);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  test('approaches the floor at the cut-off, never below', () => {
    // gamma 0.7 flattens the approach, so the last audible sample sits a
    // little above the floor rather than exactly on it. 1 % of full scale is
    // far below audibility; what matters is that it never undershoots.
    const edge = shapeProximity(serverVolume(MEASURED_CUTOFF_UNITS - 1)!, CURVE);
    expect(edge).toBeGreaterThanOrEqual(CURVE.floor);
    expect(edge - CURVE.floor).toBeLessThan(0.02);
    // Closer still to the boundary, it converges.
    expect(shapeProximity(serverVolume(1349.9)!, CURVE) - CURVE.floor).toBeLessThan(0.005);
  });

  test('nearFraction extends the plateau into the band', () => {
    const curve = { ...CURVE, nearFraction: 0.5 };
    // Half-way across the band is still inside the extended plateau.
    expect(shapeProximity(serverVolume(1125)!, curve)).toBe(1);
    expect(shapeProximity(serverVolume(1300)!, curve)).toBeLessThan(1);
  });

  test('gamma controls steepness: <1 is louder further out than >1', () => {
    const mid = serverVolume(1125)!;
    const gentle = shapeProximity(mid, { ...CURVE, floor: 0, gamma: 0.5 });
    const steep = shapeProximity(mid, { ...CURVE, floor: 0, gamma: 2 });
    expect(gentle).toBeGreaterThan(steep);
  });

  test('a corrupt curve degrades instead of producing NaN', () => {
    const bad = { nearFraction: NaN, floor: NaN, gamma: NaN };
    const v = shapeProximity(0.5, bad);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('resolvePeerLevel — enemies are never synthesised', () => {
  // These pin the anti-cheat boundary. The server omits out-of-range enemies
  // precisely so that no client can hear them; inventing a level for an absent
  // enemy would hand every user a hearing-range bypass.

  test('absent past the grace window → 0 (the stuck-gain fix)', () => {
    expect(resolvePeerLevel({
      ...base, tick: ABSENT, isAlly: false, lastLevel: 0.8, msSinceSeen: 3000,
    })).toBe(0);
  });

  test('absent with no history at all → 0', () => {
    expect(resolvePeerLevel({ ...base, tick: ABSENT, isAlly: false })).toBe(0);
  });

  test('absent within the grace window → holds the last level (#27)', () => {
    expect(resolvePeerLevel({
      ...base, tick: ABSENT, isAlly: false, lastLevel: 0.8, msSinceSeen: 500,
    })).toBe(0.8);
  });

  test('present beats grace — the response value always wins', () => {
    expect(resolvePeerLevel({
      ...base, tick: SERVER(serverVolume(1200)!), isAlly: false,
      lastLevel: 0.9, msSinceSeen: 100,
    })).toBeCloseTo(shapeProximity(serverVolume(1200)!, CURVE), 10);
  });

  test('a no-data tick NEVER invents an enemy level, in any mode', () => {
    // The design flaw this test exists to catch: a "no own position" tick used
    // to be a licence to synthesise, which would make every enemy on the map
    // audible whenever local tracking hiccuped — bypassing the server cut-off.
    for (const curve of [CURVE, null]) {
      expect(resolvePeerLevel({
        ...base, curve, tick: NO_DATA, isAlly: false, msSinceSeen: 9000, lastLevel: 0.9,
      })).toBe(0);
      expect(resolvePeerLevel({
        ...base, curve, tick: NO_DATA, isAlly: false,
      })).toBe(0);
    }
  });

  test('a no-data tick still honours the short grace window', () => {
    expect(resolvePeerLevel({
      ...base, tick: NO_DATA, isAlly: false, lastLevel: 0.7, msSinceSeen: 800,
    })).toBe(0.7);
  });
});

describe('resolvePeerLevel — teammates stay reachable', () => {
  test('out of range past grace → the floor, not silence', () => {
    // The hearing radius is ~1350 units on a 14870-unit map, so a teammate is
    // out of range for most of the game. Silencing on absence would mean
    // losing the team almost entirely.
    expect(resolvePeerLevel({
      ...base, tick: ABSENT, isAlly: true, msSinceSeen: 9000, lastLevel: 0.4,
    })).toBe(CURVE.floor);
  });

  test('the floor is continuous with the curve at the cut-off', () => {
    // No audible step as a teammate crosses out of range.
    const lastAudible = shapeProximity(serverVolume(MEASURED_CUTOFF_UNITS - 1)!, CURVE);
    const beyond = resolvePeerLevel({
      ...base, tick: ABSENT, isAlly: true, msSinceSeen: 9000,
    });
    expect(Math.abs(lastAudible - beyond)).toBeLessThan(0.02);
  });

  test('with falloff off (Proximity OFF / ENEMY) a teammate is always 1.0', () => {
    for (const tick of [ABSENT, NO_DATA]) {
      expect(resolvePeerLevel({
        ...base, curve: null, tick, isAlly: true, msSinceSeen: 60_000,
      })).toBe(1);
    }
  });

  test('a no-data tick holds their last level rather than ducking the team', () => {
    // Every death puts the local client into this state.
    expect(resolvePeerLevel({
      ...base, tick: NO_DATA, isAlly: true, lastLevel: 0.62, msSinceSeen: 2000,
    })).toBe(0.62);
  });

  test('before the first fix of the game, a teammate is audible', () => {
    // Every game starts with tracking still scanning while everyone stands in
    // the fountain. Treating that as "too far away" silenced entire teams.
    expect(resolvePeerLevel({
      ...base, everTracked: false, tick: NO_DATA, isAlly: true,
    })).toBe(1);
    expect(resolvePeerLevel({
      ...base, everTracked: false, tick: NO_DATA, isAlly: true,
      lastLevel: 0.3, msSinceSeen: 9000,
    })).toBe(1);
  });

  test('after a position has existed, losing it does NOT jump back to full volume', () => {
    // The other half of the same mistake: with tracking failing over half the
    // time, "no position means full volume" is heard as "teammates are audible
    // wherever I am", which is what proximity chat exists to avoid.
    expect(resolvePeerLevel({
      ...base, everTracked: true, tick: NO_DATA, isAlly: true,
      lastLevel: 0.62, msSinceSeen: 9000,
    })).toBe(CURVE.floor);
    expect(resolvePeerLevel({
      ...base, everTracked: true, tick: NO_DATA, isAlly: true,
    })).toBe(CURVE.floor);
  });

  test('a brief gap is still held, whether or not we have tracked before', () => {
    for (const everTracked of [true, false]) {
      expect(resolvePeerLevel({
        ...base, everTracked, tick: NO_DATA, isAlly: true,
        lastLevel: 0.62, msSinceSeen: 2000,
      })).toBe(0.62);
    }
  });

  test('a silent floor still silences a teammate the server says is out of range', () => {
    // The distinction that matters: absence from a response is evidence of
    // distance, a tick that never reached the server is absence of evidence.
    // The second half only holds before the first fix of the game — once a
    // position has existed, losing it is treated as a loss, not as a blank
    // slate. See allyUnknownLevel.
    const silent = { ...CURVE, floor: 0 };
    expect(resolvePeerLevel({
      ...base, curve: silent, tick: ABSENT, isAlly: true, msSinceSeen: 9000,
    })).toBe(0);
    expect(resolvePeerLevel({
      ...base, everTracked: false, curve: silent, tick: NO_DATA, isAlly: true,
      msSinceSeen: 9000,
    })).toBe(1);
  });

  test('Min Vol (far) 0 gives hard silence beyond the radius', () => {
    expect(resolvePeerLevel({
      ...base, curve: { ...CURVE, floor: 0 }, tick: ABSENT, isAlly: true, msSinceSeen: 9000,
    })).toBe(0);
  });

  test('walking out of range is monotonically non-increasing', () => {
    // The regression guard for the reported bug: a teammate must never get
    // LOUDER by crossing the range boundary.
    const levels = [500, 899, 1000, 1100, 1200, 1300, 1340].map((d) =>
      resolvePeerLevel({ ...base, tick: SERVER(serverVolume(d)!), isAlly: true }));
    levels.push(resolvePeerLevel({
      ...base, tick: ABSENT, isAlly: true, msSinceSeen: 9000, lastLevel: levels[levels.length - 1],
    }));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] + 1e-9);
    }
    // Inside the server's plateau: full volume. Out of range: the floor.
    expect(levels[0]).toBe(1);
    expect(levels[1]).toBe(1);
    expect(levels[levels.length - 1]).toBeCloseTo(CURVE.floor, 6);
  });

  test('a teammate inside the plateau is full volume, out of range is the floor', () => {
    expect(resolvePeerLevel({ ...base, tick: SERVER(serverVolume(500)!), isAlly: true })).toBe(1);
    expect(resolvePeerLevel({ ...base, tick: ABSENT, isAlly: true, msSinceSeen: 9000 }))
      .toBe(CURVE.floor);
  });
});

describe('computeFinalPeerVolume', () => {
  test('with unity gains it is the original proximity × slider', () => {
    expect(computeFinalPeerVolume(0.5, 0.5)).toBe(0.25);
    expect(computeFinalPeerVolume(0.8, 0.4)).toBeCloseTo(0.32);
  });

  test('group and master gains amplify past 1.0', () => {
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
