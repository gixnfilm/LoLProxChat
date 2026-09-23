import {
  locatePeers,
  panFor,
  impliedDistance,
  RADIUS_TOLERANCE_UNITS,
  IconObservation,
  AudiblePeer,
} from '../../src/services/peer-locator';
import { isInRiver } from '../../src/services/river-mask';
import {
  MEASURED_CUTOFF_UNITS,
  MEASURED_FADE_START_UNITS,
} from '../../src/services/proximity-curve';
import { Position, MAP_DIMENSIONS } from '../../src/core/types';

const SELF: Position = { x: 7000, y: 7000 };

/** The live server's curve, so test fixtures speak in real distances. */
function volumeAt(distance: number): number {
  if (distance >= MEASURED_CUTOFF_UNITS) return 0;
  if (distance < MEASURED_FADE_START_UNITS) return 1;
  const band = MEASURED_CUTOFF_UNITS - MEASURED_FADE_START_UNITS;
  return 1 - ((distance - MEASURED_FADE_START_UNITS) / band) ** 2;
}

const eastOf = (d: number): Position => ({ x: SELF.x + d, y: SELF.y });
const westOf = (d: number): Position => ({ x: SELF.x - d, y: SELF.y });

const icon = (pos: Position, side: 'ally' | 'enemy'): IconObservation => ({ pos, side });
const peer = (name: string, side: 'ally' | 'enemy', d: number): AudiblePeer =>
  ({ name, side, serverVol: volumeAt(d) });

const NO_PREV = new Map<string, Position>();

describe('impliedDistance', () => {
  test('recovers the real distance inside the fade band', () => {
    for (const d of [950, 1000, 1100, 1200, 1300]) {
      expect(impliedDistance(volumeAt(d))).toBeCloseTo(d, 3);
    }
  });

  test('the plateau carries no distance, and says so', () => {
    // Below the fade start the server reports a flat 1.0 for everyone. Anything
    // that pretended to read a distance out of that would be inventing it.
    expect(impliedDistance(volumeAt(500))).toBeNull();
    expect(impliedDistance(1)).toBeNull();
    expect(impliedDistance(0)).toBeNull();
    expect(impliedDistance(NaN)).toBeNull();
  });
});

describe('locatePeers — the unambiguous case', () => {
  test('one audible enemy and one visible red icon is a match', () => {
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1100), 'enemy')],
      peers: [peer('Zed', 'enemy', 1100)],
      previous: NO_PREV,
    });
    expect(located.get('Zed')).toEqual(eastOf(1100));
  });

  test('an icon at the wrong radius is rejected, not stretched to fit', () => {
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1300), 'enemy')],
      peers: [peer('Zed', 'enemy', 950)],
      previous: NO_PREV,
    });
    expect(located.has('Zed')).toBe(false);
  });

  test('measurement noise within tolerance still matches', () => {
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1100 + RADIUS_TOLERANCE_UNITS - 50), 'enemy')],
      peers: [peer('Zed', 'enemy', 1100)],
      previous: NO_PREV,
    });
    expect(located.has('Zed')).toBe(true);
  });

  test('a teammate is never matched to an enemy icon', () => {
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1100), 'enemy')],
      peers: [peer('Ally', 'ally', 1100)],
      previous: NO_PREV,
    });
    expect(located.size).toBe(0);
  });

  test('nothing visible means nothing located', () => {
    const located = locatePeers({
      self: SELF, icons: [], peers: [peer('Zed', 'enemy', 1100)], previous: NO_PREV,
    });
    expect(located.size).toBe(0);
  });
});

describe('locatePeers — ambiguity resolves to silence, not a guess', () => {
  test('two equally plausible icons produce no answer', () => {
    // A wrong direction is worse than none: people act on what they hear.
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1100), 'enemy'), icon(westOf(1100), 'enemy')],
      peers: [peer('Zed', 'enemy', 1100)],
      previous: NO_PREV,
    });
    expect(located.size).toBe(0);
  });

  test('two peers inside the plateau cannot be told apart', () => {
    // No distance information exists below the fade start, so scarcity is the
    // only signal left — and with two of each it says nothing.
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(400), 'enemy'), icon(westOf(400), 'enemy')],
      peers: [peer('Zed', 'enemy', 400), peer('Yasuo', 'enemy', 400)],
      previous: NO_PREV,
    });
    expect(located.size).toBe(0);
  });

  test('a second icon at a clearly different radius does not create ambiguity', () => {
    const located = locatePeers({
      self: SELF,
      // 1330 would still be inside RADIUS_TOLERANCE_UNITS of 1100, so the
      // decoy has to be genuinely elsewhere to count as "clearly different".
      icons: [icon(eastOf(1100), 'enemy'), icon(westOf(400), 'enemy')],
      peers: [peer('Zed', 'enemy', 1100)],
      previous: NO_PREV,
    });
    expect(located.get('Zed')).toEqual(eastOf(1100));
  });

  test('one icon cannot serve two peers', () => {
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1100), 'enemy')],
      peers: [peer('Zed', 'enemy', 1100), peer('Yasuo', 'enemy', 1100)],
      previous: NO_PREV,
    });
    expect(located.size).toBe(0);
  });
});

describe('locatePeers — continuity carries a binding through a crowd', () => {
  test('a previously bound peer keeps their icon when a rival appears', () => {
    // The binding was formed in a clean moment; the crowd arriving afterwards
    // must not dissolve it, which is the whole point of tracking over time.
    const previous = new Map([['Zed', eastOf(1100)]]);
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1150), 'enemy'), icon(westOf(1100), 'enemy')],
      peers: [peer('Zed', 'enemy', 1150)],
      previous,
    });
    expect(located.get('Zed')).toEqual(eastOf(1150));
  });

  test('continuity still respects the radius — it cannot resurrect a bad match', () => {
    const previous = new Map([['Zed', eastOf(960)]]);
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(960), 'enemy')],
      peers: [peer('Zed', 'enemy', 1340)],
      previous,
    });
    expect(located.has('Zed')).toBe(false);
  });

  test('an icon too far from last frame is a different player', () => {
    const previous = new Map([['Zed', westOf(1200)]]);
    const located = locatePeers({
      self: SELF,
      icons: [icon(eastOf(1100), 'enemy'), icon(eastOf(1200), 'enemy')],
      peers: [peer('Zed', 'enemy', 1100)],
      previous,
    });
    // Neither icon is near where Zed was, and two remain plausible → no answer.
    expect(located.has('Zed')).toBe(false);
  });
});

describe('panFor', () => {
  test('east is right, west is left', () => {
    expect(panFor(SELF, eastOf(1350), 1)).toBeGreaterThan(0);
    expect(panFor(SELF, westOf(1350), 1)).toBeLessThan(0);
  });

  test('no known position plays centred', () => {
    expect(panFor(SELF, undefined, 1)).toBe(0);
  });

  test('someone on top of you is centred', () => {
    expect(panFor(SELF, { ...SELF }, 1)).toBe(0);
  });

  test('stays within the stereo field however far away they are', () => {
    expect(panFor(SELF, eastOf(99999), 1.5)).toBe(1);
    expect(panFor(SELF, westOf(99999), 1.5)).toBe(-1);
  });

  test('width scales the effect and 0 disables it', () => {
    const full = panFor(SELF, eastOf(675), 1);
    expect(panFor(SELF, eastOf(675), 0.5)).toBeCloseTo(full * 0.5, 6);
    expect(panFor(SELF, eastOf(675), 0)).toBe(0);
  });

  test('a nonsense width falls back to unity rather than producing NaN', () => {
    expect(Number.isFinite(panFor(SELF, eastOf(675), NaN))).toBe(true);
  });
});

describe('isInRiver', () => {
  const W = MAP_DIMENSIONS.summoners_rift.width;
  const H = MAP_DIMENSIONS.summoners_rift.height;
  /** The river runs along the anti-diagonal: x/W + y/H ≈ 1. */
  const onRiverAxis = (t: number): Position => ({ x: t * W, y: (1 - t) * H });

  test('the river band is wet', () => {
    expect(isInRiver(onRiverAxis(0.35), 'summoners_rift')).toBe(true);
  });

  test('the bases are dry', () => {
    expect(isInRiver({ x: 1000, y: 1000 }, 'summoners_rift')).toBe(false);
    expect(isInRiver({ x: W - 1000, y: H - 1000 }, 'summoners_rift')).toBe(false);
  });

  test('jungle away from the river is dry', () => {
    expect(isInRiver({ x: 4000, y: 4000 }, 'summoners_rift')).toBe(false);
    expect(isInRiver({ x: 11000, y: 11000 }, 'summoners_rift')).toBe(false);
  });

  test('Howling Abyss has no river', () => {
    expect(isInRiver(onRiverAxis(0.35), 'howling_abyss')).toBe(false);
  });

  test('missing or out-of-bounds positions are dry, not a crash', () => {
    expect(isInRiver(null, 'summoners_rift')).toBe(false);
    expect(isInRiver(undefined, 'summoners_rift')).toBe(false);
    expect(isInRiver({ x: -5, y: 0 }, 'summoners_rift')).toBe(false);
    expect(isInRiver({ x: W * 2, y: H * 2 }, 'summoners_rift')).toBe(false);
  });
});
