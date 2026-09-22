import { TrackingState, TrackingService } from '../../src/services/tracking';

// Mock DOM APIs needed by TrackingService constructor
const mockCtx = {} as CanvasRenderingContext2D;
const mockCanvas = {
  width: 0,
  height: 0,
  getContext: jest.fn().mockReturnValue(mockCtx),
} as unknown as HTMLCanvasElement;

(globalThis as any).document = {
  createElement: jest.fn().mockReturnValue(mockCanvas),
};

describe('TrackingState enum', () => {
  test('SCANNING = "scanning"', () => {
    expect(TrackingState.SCANNING).toBe('scanning');
  });

  test('LOCKED = "locked"', () => {
    expect(TrackingState.LOCKED).toBe('locked');
  });

  test('DEAD = "dead"', () => {
    expect(TrackingState.DEAD).toBe('dead');
  });
});

describe('TrackingService state transitions', () => {
  let svc: TrackingService;

  beforeEach(() => {
    svc = new TrackingService(1920, 1080, 'summoners_rift');
  });

  test('starts in SCANNING state', () => {
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('onDeath transitions to DEAD', () => {
    svc.onDeath();
    expect(svc.getState()).toBe(TrackingState.DEAD);
  });

  test('onRespawn transitions from DEAD to SCANNING', () => {
    svc.onDeath();
    svc.onRespawn();
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('onDeath is idempotent when already DEAD', () => {
    svc.onDeath();
    svc.onDeath(); // should not throw
    expect(svc.getState()).toBe(TrackingState.DEAD);
  });

  test('onRespawn is no-op when not DEAD', () => {
    svc.onRespawn(); // should not transition (already SCANNING)
    expect(svc.getState()).toBe(TrackingState.SCANNING);
  });

  test('getLastPosition returns null initially', () => {
    expect(svc.getLastPosition()).toBeNull();
  });
});

describe('setLastPosition jump warning', () => {
  let svc: TrackingService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new TrackingService(1920, 1080, 'summoners_rift');
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // setLastPosition is private — call via reflection. Same trick the
  // tracking module uses internally; tests should mirror its boundary.
  const setLastPosition = (s: TrackingService, pos: { x: number; y: number }, source: string) =>
    (s as any).setLastPosition(pos, source);
  const peekLastPosition = (s: TrackingService) => s.getLastPosition();
  const setLastUpdateMs = (s: TrackingService, ms: number) => { (s as any).lastPositionUpdateMs = ms; };

  test('first call sets position without warning (no prior position to compare)', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test');
    expect(peekLastPosition(svc)).toEqual({ x: 1000, y: 1000 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('plausible movement does not warn', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test-1');
    // Pretend last update was 1 second ago; champion moves ~500 game units (slow)
    setLastUpdateMs(svc, performance.now() - 1000);
    setLastPosition(svc, { x: 1500, y: 1000 }, 'test-2');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('CV pixel jitter at high scan rate does NOT warn (small distance gate)', () => {
    // 150-unit jitter in 50ms = 3000 u/s. Speed exceeds the speed gate but
    // distance is below MIN_JUMP_UNITS (500). Was spamming the log pre-v0.1.30.
    setLastPosition(svc, { x: 7400, y: 7200 }, 'locked-track');
    setLastUpdateMs(svc, performance.now() - 50);
    setLastPosition(svc, { x: 7540, y: 7220 }, 'locked-track');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('large jump at impossible speed warns (both gates passed)', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test-1');
    // 0.05s later, position jumps 5000 game units → 100k u/s, dist > 500.
    setLastUpdateMs(svc, performance.now() - 50);
    setLastPosition(svc, { x: 6000, y: 1000 }, 'classifier-reacquire');
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0].join(' ');
    expect(msg).toContain('[Tracking] WARN');
    expect(msg).toContain('classifier-reacquire');
  });

  test('large distance but at normal walking speed does NOT warn (speed gate)', () => {
    // 600-unit move over 1.5s = 400 u/s — distance passes but speed doesn't.
    setLastPosition(svc, { x: 0, y: 0 }, 'test-1');
    setLastUpdateMs(svc, performance.now() - 1500);
    setLastPosition(svc, { x: 600, y: 0 }, 'test-2');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('position still updates after a warning (warn is not a guard)', () => {
    setLastPosition(svc, { x: 1000, y: 1000 }, 'test-1');
    setLastUpdateMs(svc, performance.now() - 50);
    setLastPosition(svc, { x: 14000, y: 14000 }, 'extrapolate');
    expect(peekLastPosition(svc)).toEqual({ x: 14000, y: 14000 });
  });
});

describe('pixelToGamePosition', () => {
  let svc: TrackingService;

  beforeEach(() => {
    svc = new TrackingService(1920, 1080, 'summoners_rift');
  });

  test('converts origin pixel to top-left game coords', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(0, 0, region);
    expect(pos.x).toBeCloseTo(0);
    expect(pos.y).toBeCloseTo(14980); // Y flipped
  });

  test('converts center pixel to center game coords', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(50, 50, region);
    expect(pos.x).toBeCloseTo(14870 / 2);
    expect(pos.y).toBeCloseTo(14980 / 2);
  });

  test('clamps out-of-bounds pixels', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    const pos = svc.pixelToGamePosition(-10, 200, region);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0); // Y flipped: relY=1 → y=0
  });
});
