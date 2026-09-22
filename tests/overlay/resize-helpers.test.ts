import { computeDesiredHeight } from '../../src/overlay/resize-helpers';

describe('computeDesiredHeight', () => {
  test('adds 4px breathing room for normal content sizes', () => {
    expect(computeDesiredHeight(400)).toBe(404);
    expect(computeDesiredHeight(623)).toBe(627);
  });

  test('floors at 120 (collapsed-state floor)', () => {
    expect(computeDesiredHeight(0)).toBe(120);
    expect(computeDesiredHeight(50)).toBe(120);
    expect(computeDesiredHeight(115)).toBe(120);
  });

  test('ceilings at 1200 (sanity cap)', () => {
    expect(computeDesiredHeight(2000)).toBe(1200);
    expect(computeDesiredHeight(1300)).toBe(1200);
  });

  test('returns exactly the floor at the transition boundary', () => {
    // 116 + 4 = 120 → still equals floor
    expect(computeDesiredHeight(116)).toBe(120);
    // 117 + 4 = 121 → above floor
    expect(computeDesiredHeight(117)).toBe(121);
  });

  test('returns exactly the ceiling at the transition boundary', () => {
    // 1196 + 4 = 1200 → at ceiling
    expect(computeDesiredHeight(1196)).toBe(1200);
    // 1197 + 4 = 1201 → still clamped to 1200
    expect(computeDesiredHeight(1197)).toBe(1200);
  });
});
