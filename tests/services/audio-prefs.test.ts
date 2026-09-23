// jest runs in the `node` environment (jest.config.js), so there is no DOM and
// no localStorage. A tiny in-memory stand-in is enough — audio-prefs only uses
// getItem / setItem / removeItem — and keeps the suite free of a jsdom dep.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

const storage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage;

import {
  DEFAULT_AUDIO_PREFS,
  getAudioPrefs,
  setAudioPrefs,
  curveFor,
  groupGainFor,
  getAllyProximity,
  getPlayerVolumes,
  setStoredPlayerVolume,
} from '../../src/services/audio-prefs';

const PREFS_KEY = 'lolproxchat.audioPrefs';

beforeEach(() => storage.clear());

describe('getAudioPrefs', () => {
  test('returns the defaults on a fresh install', () => {
    expect(getAudioPrefs()).toEqual({ ...DEFAULT_AUDIO_PREFS });
  });

  test('enemies default louder than teammates — the #21 complaint', () => {
    const p = getAudioPrefs();
    expect(p.enemyVolume).toBeGreaterThan(p.teamVolume);
  });

  test('unparseable JSON degrades to defaults instead of throwing', () => {
    storage.setItem(PREFS_KEY, '{not json');
    expect(getAudioPrefs()).toEqual({ ...DEFAULT_AUDIO_PREFS });
  });

  test('a non-object payload degrades to defaults', () => {
    storage.setItem(PREFS_KEY, '"a string"');
    expect(getAudioPrefs()).toEqual({ ...DEFAULT_AUDIO_PREFS });
  });

  test('partial stored prefs are merged over the defaults', () => {
    storage.setItem(PREFS_KEY, JSON.stringify({ enemyVolume: 2.4 }));
    const p = getAudioPrefs();
    expect(p.enemyVolume).toBe(2.4);
    expect(p.masterVolume).toBe(DEFAULT_AUDIO_PREFS.masterVolume);
  });

  test('out-of-range and non-numeric values are clamped, never NaN', () => {
    storage.setItem(PREFS_KEY, JSON.stringify({
      masterVolume: 99,
      teamVolume: -5,
      enemyVolume: 'loud',
      floor: 4,
      nearFraction: 99,
      fadeCurve: 0,
      inputVolume: 7,
    }));
    const p = getAudioPrefs();
    expect(p.masterVolume).toBe(2);
    expect(p.teamVolume).toBe(0);
    expect(p.enemyVolume).toBe(DEFAULT_AUDIO_PREFS.enemyVolume);
    expect(p.floor).toBe(1);
    expect(p.nearFraction).toBe(0.9);
    expect(p.fadeCurve).toBe(0.3);
    expect(p.inputVolume).toBe(1);
    for (const v of Object.values(p)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });

  test('an invalid proximityMode falls back rather than sticking', () => {
    storage.setItem(PREFS_KEY, JSON.stringify({ proximityMode: 'sideways' }));
    expect(getAudioPrefs().proximityMode).toBe(DEFAULT_AUDIO_PREFS.proximityMode);
  });

  test('migrates the pre-mixer allyProximity boolean', () => {
    storage.setItem('lolproxchat.allyProximity', '1');
    expect(getAudioPrefs().proximityMode).toBe('all');
  });
});

describe('setAudioPrefs', () => {
  test('round-trips a patch and leaves the rest alone', () => {
    setAudioPrefs({ enemyVolume: 2.2 });
    const p = getAudioPrefs();
    expect(p.enemyVolume).toBe(2.2);
    expect(p.floor).toBe(DEFAULT_AUDIO_PREFS.floor);
  });

  test('clamps on the way back out even if a caller passes nonsense', () => {
    setAudioPrefs({ masterVolume: 50 });
    expect(getAudioPrefs().masterVolume).toBe(2);
  });

  test('keeps the legacy allyProximity key in sync both ways', () => {
    setAudioPrefs({ proximityMode: 'all' });
    expect(storage.getItem('lolproxchat.allyProximity')).toBe('1');
    setAudioPrefs({ proximityMode: 'enemy' });
    expect(storage.getItem('lolproxchat.allyProximity')).toBeNull();
  });
});

describe('curveFor / groupGainFor', () => {
  test('mode "off" disables falloff for both sides', () => {
    const p = { ...DEFAULT_AUDIO_PREFS, proximityMode: 'off' as const };
    expect(curveFor(p, true)).toBeNull();
    expect(curveFor(p, false)).toBeNull();
  });

  test('mode "enemy" fades enemies only', () => {
    const p = { ...DEFAULT_AUDIO_PREFS, proximityMode: 'enemy' as const };
    expect(curveFor(p, true)).toBeNull();
    expect(curveFor(p, false)).not.toBeNull();
  });

  test('mode "all" fades both sides', () => {
    const p = { ...DEFAULT_AUDIO_PREFS, proximityMode: 'all' as const };
    expect(curveFor(p, true)).not.toBeNull();
    expect(curveFor(p, false)).not.toBeNull();
  });

  test('the curve carries the user prefs through', () => {
    const p = { ...DEFAULT_AUDIO_PREFS, floor: 0.4, nearFraction: 0.3, fadeCurve: 1.3 };
    const c = curveFor(p, false)!;
    expect(c).toEqual({ nearFraction: 0.3, floor: 0.4, gamma: 1.3 });
  });

  test('a v0.6.0 nearRange in storage is ignored, not misread as a fraction', () => {
    // It was game units against an inverse-curve constant that turned out not
    // to match the live server, so the stored number is meaningless now.
    storage.setItem(PREFS_KEY, JSON.stringify({ nearRange: 300 }));
    expect(getAudioPrefs().nearFraction).toBe(DEFAULT_AUDIO_PREFS.nearFraction);
  });

  test('group gain picks the right slider per side', () => {
    const p = { ...DEFAULT_AUDIO_PREFS, teamVolume: 0.8, enemyVolume: 2.0 };
    expect(groupGainFor(p, true)).toBe(0.8);
    expect(groupGainFor(p, false)).toBe(2.0);
  });

  test('only mode "all" asks the server for ally proximity', () => {
    setAudioPrefs({ proximityMode: 'all' });
    expect(getAllyProximity()).toBe(true);
    setAudioPrefs({ proximityMode: 'enemy' });
    expect(getAllyProximity()).toBe(false);
    setAudioPrefs({ proximityMode: 'off' });
    expect(getAllyProximity()).toBe(false);
  });
});

describe('per-player trims', () => {
  test('round-trip and clamp', () => {
    setStoredPlayerVolume('Ahri', 0.4);
    setStoredPlayerVolume('Zed', 5);
    setStoredPlayerVolume('Yasuo', -1);
    expect(getPlayerVolumes()).toEqual({ Ahri: 0.4, Zed: 1, Yasuo: 0 });
  });

  test('NaN is ignored rather than stored', () => {
    setStoredPlayerVolume('Ahri', NaN);
    expect(getPlayerVolumes()).toEqual({});
  });

  test('corrupt storage yields an empty map, not a throw', () => {
    storage.setItem('lolproxchat.playerVolumes', 'nope');
    expect(getPlayerVolumes()).toEqual({});
  });

  test('non-numeric entries are dropped, valid siblings survive', () => {
    storage.setItem('lolproxchat.playerVolumes', JSON.stringify({ Ahri: 0.5, Zed: null }));
    expect(getPlayerVolumes()).toEqual({ Ahri: 0.5 });
  });
});
