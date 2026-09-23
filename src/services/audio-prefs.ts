// Audio playback preferences, persisted to localStorage (the WebView2 profile
// under %LOCALAPPDATA%\com.proxchat.app\).
//
// Everything here used to be a single "ally proximity" boolean. It now carries
// the full mixer state, for two reasons:
//   • Output levels are adjustable at all — previously the only way a peer
//     could get louder was the per-row trim slider, and playback ran through
//     HTMLAudioElement.volume, which is hard-capped at 1.0. Nothing could
//     exceed "as recorded", which is why distant enemies were inaudible.
//   • AudioService is rebuilt per game (orchestrator.startSession) while the
//     overlay window is not reloaded. Without persistence the UI kept showing
//     the old slider positions while the fresh engine ran at its defaults.

import { ProximityMode, ProximityCurve } from './proximity-curve';

const PREFS_KEY = 'lolproxchat.audioPrefs';
const PLAYER_VOLUMES_KEY = 'lolproxchat.playerVolumes';
const LEGACY_ALLY_PROXIMITY_KEY = 'lolproxchat.allyProximity';

export interface AudioPrefs {
  /** Output gain applied to every peer, 0..2. */
  masterVolume: number;
  /** Extra gain for same-team peers, 0..2. */
  teamVolume: number;
  /** Extra gain for cross-team peers, 0..3. Defaults above 1 — enemies arrive
   *  attenuated by distance and were the #1 "can't hear them" complaint (#21). */
  enemyVolume: number;
  /** off = no distance falloff at all; enemy = enemies only (upstream default
   *  behaviour); all = teammates fade with distance too (sends allyProximity
   *  to the server, which applies the same falloff to same-team peers). */
  proximityMode: ProximityMode;
  /** Volume at and beyond the edge of hearing range, 0..1.
   *
   *  0 means a teammate who leaves the hearing radius goes silent, exactly
   *  like an enemy. It was 0.25 in v0.7.0 on the reasoning that the radius is
   *  small enough to lose your team otherwise — but in play that read as
   *  "teammates are audible everywhere", which is the opposite of the point of
   *  proximity chat. Silence is the honest reading of "too far away". */
  floor: number;
  /** How far into the server's fade band to stay at full volume, 0..0.9.
   *  A fraction, not game units: the server's actual distances are its own
   *  business and have already changed once under us. 0 = follow the server's
   *  own plateau exactly. */
  nearFraction: number;
  /** Falloff exponent. <1 fades gently, >1 fades steeply. */
  fadeCurve: number;
  /** WebAudio playback path (required for any gain above 1.0). Turning it off
   *  reverts to the upstream element-only path, capped at 1.0 — an escape
   *  hatch if the WebAudio path ever double-plays the way it did pre-v0.5.3. */
  audioBoost: boolean;
  /** Pre-transmission mic gain, 0..1. Mirrors AudioSettings.inputVolume. */
  inputVolume: number;
  /** Voice-gate threshold on the 0..100 meter scale. 0 disables the gate, so
   *  Always Open transmits continuously the way it always did. */
  micThreshold: number;
}

export const DEFAULT_AUDIO_PREFS: Readonly<AudioPrefs> = Object.freeze({
  masterVolume: 1.0,
  teamVolume: 1.0,
  enemyVolume: 1.6,
  proximityMode: 'all' as ProximityMode,
  floor: 0,
  nearFraction: 0,
  fadeCurve: 0.7,
  audioBoost: true,
  inputVolume: 1.0,
  // Low on purpose. Browser noise suppression already runs on the mic, so
  // room tone sits near zero and 10 is enough to stop a keyboard without
  // clipping the start of a quiet sentence. The meter next to the slider is
  // there so this can be corrected in seconds rather than guessed at.
  micThreshold: 10,
});

function num(raw: unknown, fallback: number, lo: number, hi: number): number {
  // Deliberately NOT Number(raw): Number(null) and Number('') are both 0,
  // which would turn a corrupt entry into a hard 0 — silence for a volume, a
  // muted player for a trim — instead of falling back to the default.
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}

/**
 * Read prefs, merging over the defaults and clamping every field. Corrupt or
 * partial stored JSON degrades to defaults rather than throwing — this runs on
 * the 10 Hz volume path, so it must never be the thing that breaks audio.
 */
export function getAudioPrefs(): AudioPrefs {
  let stored: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
    }
  } catch {
    // Unparseable — fall through to defaults.
  }

  const mode = stored.proximityMode;
  const proximityMode: ProximityMode =
    mode === 'off' || mode === 'enemy' || mode === 'all'
      ? mode
      : // Migrate the pre-mixer boolean: it only ever meant "allies too".
        localStorage.getItem(LEGACY_ALLY_PROXIMITY_KEY) === '1'
        ? 'all'
        : DEFAULT_AUDIO_PREFS.proximityMode;

  return {
    masterVolume: num(stored.masterVolume, DEFAULT_AUDIO_PREFS.masterVolume, 0, 2),
    teamVolume: num(stored.teamVolume, DEFAULT_AUDIO_PREFS.teamVolume, 0, 2),
    enemyVolume: num(stored.enemyVolume, DEFAULT_AUDIO_PREFS.enemyVolume, 0, 3),
    proximityMode,
    // Deliberately NOT read from storage: Min Vol / Fade Start / Fade Curve
    // were removed from the UI as too fiddly, and a value left over from when
    // they were adjustable would be invisible and unfixable. One real log had
    // fadeCurve pinned at its flattest setting, which is exactly the config
    // that makes distant players sound close.
    floor: DEFAULT_AUDIO_PREFS.floor,
    // Note: a stored `nearRange` from v0.6.0 is deliberately NOT migrated. It
    // was in game units against an inverse-curve constant that turned out not
    // to match the live server, so the number is meaningless now; the default
    // is the honest starting point.
    nearFraction: DEFAULT_AUDIO_PREFS.nearFraction,
    fadeCurve: DEFAULT_AUDIO_PREFS.fadeCurve,
    audioBoost: typeof stored.audioBoost === 'boolean'
      ? stored.audioBoost
      : DEFAULT_AUDIO_PREFS.audioBoost,
    inputVolume: num(stored.inputVolume, DEFAULT_AUDIO_PREFS.inputVolume, 0, 1),
    micThreshold: num(stored.micThreshold, DEFAULT_AUDIO_PREFS.micThreshold, 0, 100),
  };
}

/** Merge a partial update into the stored prefs and return the new full set. */
export function setAudioPrefs(patch: Partial<AudioPrefs>): AudioPrefs {
  const next = { ...getAudioPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('[AudioPrefs] persist failed:', e);
  }
  // The legacy key is what older builds read; keep it in sync so downgrading
  // the exe doesn't silently flip ally proximity back off.
  try {
    if (next.proximityMode === 'all') localStorage.setItem(LEGACY_ALLY_PROXIMITY_KEY, '1');
    else localStorage.removeItem(LEGACY_ALLY_PROXIMITY_KEY);
  } catch {
    // Non-fatal.
  }
  return getAudioPrefs();
}

/** Build the falloff curve for a peer, or null when falloff is disabled. */
export function curveFor(prefs: AudioPrefs, isAlly: boolean): ProximityCurve | null {
  if (prefs.proximityMode === 'off') return null;
  if (prefs.proximityMode === 'enemy' && isAlly) return null;
  return {
    nearFraction: prefs.nearFraction,
    floor: prefs.floor,
    gamma: prefs.fadeCurve,
  };
}

/** Group gain for a peer — the Team / Enemy sliders. */
export function groupGainFor(prefs: AudioPrefs, isAlly: boolean): number {
  return isAlly ? prefs.teamVolume : prefs.enemyVolume;
}

/**
 * Whether the server should apply its falloff to same-team peers. Only 'all'
 * needs it; 'enemy' and 'off' want teammates back at a flat 1.0 so the client
 * has something to scale with the Team slider.
 */
export function getAllyProximity(): boolean {
  return getAudioPrefs().proximityMode === 'all';
}

/**
 * Every localStorage key this app writes. Kept here so "reset everything"
 * cannot silently miss one — note `proxchat.autoUpdate`, which does NOT share
 * the `lolproxchat.` prefix and would be skipped by any prefix sweep.
 */
export const ALL_STORAGE_KEYS: readonly string[] = [
  PREFS_KEY,
  PLAYER_VOLUMES_KEY,
  LEGACY_ALLY_PROXIMITY_KEY,
  'lolproxchat.inputDeviceId',
  'lolproxchat.outputDeviceId',
  'lolproxchat.pttVk',
  'lolproxchat.toggleVk',
  'proxchat.autoUpdate',
];

/** Wipe every stored setting. The caller still has to re-sync the UI and tell
 *  the running engine — see resetAllSettings in the overlay. */
export function clearAllStoredSettings(): void {
  for (const key of ALL_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('[AudioPrefs] could not clear ' + key + ':', e);
    }
  }
}

// ---- per-player trim sliders -------------------------------------------------

/** Per-player trim, summonerName → 0..1. */
export function getPlayerVolumes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PLAYER_VOLUMES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Same reasoning as num(): coercing here would silently mute a player.
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[name] = Math.max(0, Math.min(1, v));
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function setStoredPlayerVolume(name: string, volume: number): void {
  if (!Number.isFinite(volume)) return;
  const all = getPlayerVolumes();
  all[name] = Math.max(0, Math.min(1, volume));
  try {
    localStorage.setItem(PLAYER_VOLUMES_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn('[AudioPrefs] player volume persist failed:', e);
  }
}
