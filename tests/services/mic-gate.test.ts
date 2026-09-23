import {
  levelPercent, updateGate, CLOSED_GATE, GateState, MIC_THRESHOLD_REFERENCE,
} from '../../src/services/mic-gate';
import { DEFAULT_AUDIO_PREFS } from '../../src/services/audio-prefs';

describe('levelPercent', () => {
  test('silence reads as 0 and garbage does not produce NaN', () => {
    expect(levelPercent(0)).toBe(0);
    expect(levelPercent(-1)).toBe(0);
    expect(levelPercent(NaN)).toBe(0);
  });

  test('clamps at 100 rather than running off the meter', () => {
    expect(levelPercent(5)).toBe(100);
  });

  test('gives usable resolution where people actually set the slider', () => {
    // The point of the square root: quiet speech must not all collapse into
    // the first few slider positions. A linear scale would put this at 4.
    expect(levelPercent(MIC_THRESHOLD_REFERENCE.quietSpeech)).toBeCloseTo(20, 0);
    expect(levelPercent(MIC_THRESHOLD_REFERENCE.ordinarySpeech)).toBeCloseTo(50, 0);
  });

  test('the shipped default sits at room tone, well below any speech', () => {
    // This is the guard the earlier version lacked. The scale lived in
    // mic-gate.ts, the default in audio-prefs.ts and a third estimate in a
    // test comment, with nothing tying them together — so all three could
    // disagree (and did) without a single test failing.
    const d = DEFAULT_AUDIO_PREFS.micThreshold;
    expect(levelPercent(MIC_THRESHOLD_REFERENCE.roomTone)).toBeCloseTo(d, 0);
    // A very quiet sentence must clear the default with room to spare, or the
    // gate silences people who believe they are talking.
    expect(levelPercent(MIC_THRESHOLD_REFERENCE.quietSpeech)).toBeGreaterThan(d * 1.8);
  });
});

describe('updateGate', () => {
  const HOLD = 300;

  test('threshold 0 is the old behaviour: always transmitting', () => {
    expect(updateGate(CLOSED_GATE, 0, 0, 1000, HOLD).open).toBe(true);
  });

  test('stays shut below the threshold and opens above it', () => {
    let s: GateState = CLOSED_GATE;
    s = updateGate(s, 5, 20, 100, HOLD);
    expect(s.open).toBe(false);
    s = updateGate(s, 25, 20, 200, HOLD);
    expect(s.open).toBe(true);
  });

  test('holds through the gaps inside speech', () => {
    // A gate that shuts the instant the level dips cuts the tail off every
    // word. The hold is what makes it sound like a person talking.
    let s = updateGate(CLOSED_GATE, 40, 20, 0, HOLD);
    s = updateGate(s, 0, 20, 200, HOLD);
    expect(s.open).toBe(true);
    s = updateGate(s, 0, 20, 400, HOLD);
    expect(s.open).toBe(false);
  });

  test('a voice sitting on the threshold does not chatter', () => {
    // Hysteresis: once open, the bar drops, so readings that wobble a little
    // either side of the setting keep it open instead of flipping every tick.
    let s = updateGate(CLOSED_GATE, 20, 20, 0, HOLD);
    expect(s.open).toBe(true);
    for (let t = 50; t <= 1000; t += 50) {
      s = updateGate(s, 19, 20, t, HOLD);
      expect(s.open).toBe(true);
    }
  });

  test('a level below the release bar still closes after the hold', () => {
    let s = updateGate(CLOSED_GATE, 40, 20, 0, HOLD);
    s = updateGate(s, 10, 20, 500, HOLD);
    expect(s.open).toBe(false);
  });

  test('re-opening after a close works from the closed state', () => {
    let s = updateGate(CLOSED_GATE, 40, 20, 0, HOLD);
    s = updateGate(s, 0, 20, 500, HOLD);
    expect(s.open).toBe(false);
    s = updateGate(s, 40, 20, 600, HOLD);
    expect(s.open).toBe(true);
    expect(s.lastAboveMs).toBe(600);
  });
});
