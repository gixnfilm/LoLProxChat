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

import { ProximityMode, ProximityCurve, SERVER_MAX_RANGE } from './proximity-curve';

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
  /** Volume at the edge of hearing range, 0..1. Above 0 keeps distant peers
   *  audible instead of letting them vanish into the server curve's cliff. */
  floor: number;
  /** Game units of full-volume plateau before the fade starts. */
  nearRange: number;
  /** Falloff exponent. <1 fades gently, >1 fades steeply. */
  fadeCurve: number;
  /** WebAudio playback path (required for any gain above 1.0). Turning it off
   *  reverts to the upstream element-only path, capped at 1.0 — an escape
   *  hatch if the WebAudio path ever double-plays the way it did pre-v0.5.3. */
  audioBoost: boolean;
  /** Pre-transmission mic gain, 0..1. Mirrors AudioSettings.inputVolume. */
  inputVolume: number;
}

export const DEFAULT_AUDIO_PREFS: Readonly<AudioPrefs> = Object.freeze({
  masterVolume: 1.0,
  teamVolume: 1.0,
  enemyVolume: 1.6,
  proximityMode: 'all' as ProximityMode,
  floor: 0.25,
  nearRange: 300,
  fadeCurve: 0.7,
  audioBoost: true,
  inputVolume: 1.0,
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
    floor: num(stored.floor, DEFAULT_AUDIO_PREFS.floor, 0, 1),
    nearRange: num(stored.nearRange, DEFAULT_AUDIO_PREFS.nearRange, 0, SERVER_MAX_RANGE - 1),
    fadeCurve: num(stored.fadeCurve, DEFAULT_AUDIO_PREFS.fadeCurve, 0.3, 2),
    audioBoost: typeof stored.audioBoost === 'boolean'
      ? stored.audioBoost
      : DEFAULT_AUDIO_PREFS.audioBoost,
    inputVolume: num(stored.inputVolume, DEFAULT_AUDIO_PREFS.inputVolume, 0, 1),
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
    nearRange: prefs.nearRange,
    farRange: SERVER_MAX_RANGE,
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
