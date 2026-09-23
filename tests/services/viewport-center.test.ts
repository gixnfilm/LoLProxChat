import { computeViewportCenter } from '../../src/services/tracking-helpers';

const W = 100;
const H = 100;

/** Draw a hollow rectangle outline into a fresh mask, the way League's camera box appears. */
function boxMask(x0: number, y0: number, x1: number, y1: number, into?: Uint8Array): Uint8Array {
  const m = into ?? new Uint8Array(W * H);
  for (let x = x0; x <= x1; x++) { m[y0 * W + x] = 1; m[y1 * W + x] = 1; }
  for (let y = y0; y <= y1; y++) { m[y * W + x0] = 1; m[y * W + x1] = 1; }
  return m;
}

describe('computeViewportCenter', () => {
  test('finds the centre of a plain camera box', () => {
    const c = computeViewportCenter(boxMask(20, 30, 60, 55), W, H);
    expect(c).not.toBeNull();
    expect(c!.x).toBeCloseTo(40.5, 1);
    expect(c!.y).toBeCloseTo(43, 1);
  });

  test('a second bright run does not drag the centre', () => {
    // The defect this function was rewritten for: a global min/max over the
    // whole mask returns the midpoint between the box and any other long white
    // run — a point belonging to neither, handed out as the player's position.
    const m = boxMask(20, 30, 60, 55);
    for (let x = 75; x < 95; x++) m[90 * W + x] = 1;   // a path line, far away
    const c = computeViewportCenter(m, W, H);
    expect(c).not.toBeNull();
    expect(c!.x).toBeCloseTo(40.5, 1);
    expect(c!.y).toBeCloseTo(43, 1);
  });

  test('picks the larger of two boxes rather than merging them', () => {
    const m = boxMask(5, 5, 25, 18);
    boxMask(40, 40, 90, 75, m);
    const c = computeViewportCenter(m, W, H);
    expect(c!.x).toBeCloseTo(65.5, 1);
    expect(c!.y).toBeCloseTo(58, 1);
  });

  test('rejects a box clipped by the minimap edge', () => {
    // A clipped box reports a centre pulled inward by up to half its width —
    // thousands of game units, in exactly the fountain case the camera-box
    // fallback exists for.
    expect(computeViewportCenter(boxMask(0, 30, 40, 55), W, H)).toBeNull();
    expect(computeViewportCenter(boxMask(30, 0, 70, 40), W, H)).toBeNull();
    expect(computeViewportCenter(boxMask(60, 30, W - 1, 55), W, H)).toBeNull();
  });

  test('rejects the minimap frame itself', () => {
    // Full width but short used to pass, because the oversize guard was an &&.
    const m = new Uint8Array(W * H);
    for (let y = 2; y < 8; y++) for (let x = 1; x < W - 1; x++) m[y * W + x] = 1;
    expect(computeViewportCenter(m, W, H)).toBeNull();
  });

  test('rejects a solid bright patch that happens to be box-shaped', () => {
    // The camera box is an outline. A filled region of the same proportions is
    // terrain or a ping, and its centre means nothing.
    const m = new Uint8Array(W * H);
    for (let y = 30; y <= 55; y++) for (let x = 20; x <= 60; x++) m[y * W + x] = 1;
    expect(computeViewportCenter(m, W, H)).toBeNull();
  });

  test('rejects shapes that are too small, too tall, or absent', () => {
    expect(computeViewportCenter(new Uint8Array(W * H), W, H)).toBeNull();
    expect(computeViewportCenter(boxMask(40, 40, 48, 48), W, H)).toBeNull();  // too small
    expect(computeViewportCenter(boxMask(30, 20, 50, 80), W, H)).toBeNull();  // portrait
  });

  test('joins an outline across its diagonal corners', () => {
    // 4-connected flood fill breaks a 1px outline at the corners into four
    // separate runs, each of which fails the size test on its own.
    const c = computeViewportCenter(boxMask(20, 30, 60, 55), W, H);
    expect(c).not.toBeNull();
  });
});
