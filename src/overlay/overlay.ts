import { setLoggingEnabled } from '../core/logging';
import { listen } from '@tauri-apps/api/event';
import {
  checkForUpdate,
  downloadAndApply,
  isAutoUpdateEnabled,
  setAutoUpdateEnabled,
} from '../services/updater';
import {
  getStoredInputDeviceId,
  setStoredInputDeviceId,
  getStoredOutputDeviceId,
  setStoredOutputDeviceId,
  listAudioDevices,
  probeMicPermission,
} from '../services/devices';
import {
  AudioPrefs, DEFAULT_AUDIO_PREFS, getAudioPrefs, setAudioPrefs, getPlayerVolumes,
  clearAllStoredSettings,
} from '../services/audio-prefs';
import { ProximityMode } from '../services/proximity-curve';
import { computeDesiredHeight, shouldResendHeight } from './resize-helpers';
import { browserKeyToWin32Vk, humanizeVk } from '../core/keymap';
import '../core/window-globals';

/**
 * Every control's "read storage and repaint me" function.
 *
 * Each one used to be a closure trapped inside its own `queueMicrotask` with
 * no way to call it again, which made "reset to defaults" impossible to reflect
 * in the UI without reloading the whole webview — and a reload would leave the
 * Rust-side key bindings untouched, so the old hotkey would keep firing while
 * the panel claimed otherwise.
 *
 * Declared at the very top of the module, before any caller. `registerResync`
 * is a hoisted function declaration, so calling it early *looks* fine — but
 * the array it writes to is a `const`, and touching a `const` before its
 * initialiser has run throws. That threw during module evaluation, which meant
 * every line after the first call never ran: the Debug button, auto-update,
 * Hide IP, the whole mixer, Reset and the key bindings were all dead, and the
 * panel showed raw HTML defaults instead of stored settings.
 */
const resyncers: Array<() => void> = [];
function registerResync(fn: () => void): void {
  resyncers.push(fn);
  queueMicrotask(fn);
}

// v0.3 (#11): dynamic overlay-window resize so the panel grows to fit
// debug-thumbnail / settings content and shrinks back when they collapse.
// requestAnimationFrame-batched so we don't ping Rust at full frame rate
// when ResizeObserver fires rapidly (image load, etc).
let resizeQueued = false;
// Last height actually sent to Rust, so an unchanged layout stops the
// resize -> relayout -> ResizeObserver -> resize loop dead. See
// RESIZE_DEAD_BAND_PX for the measurement that motivated this.
let lastSentHeight: number | null = null;
let lastSentHitRect: { width: number; height: number } | null = null;

/**
 * Push the panel's geometry to Rust: the window size, and the rectangle inside
 * which clicks are ours rather than passing through to the game.
 *
 * Both numbers come from the same measurement on purpose. They used to be
 * produced by two separate ResizeObservers — one reporting
 * `computeDesiredHeight(scrollHeight)`, the other `panel.offsetHeight` — and
 * whichever fired last won, because both write the same field on the Rust
 * side. If the hit-rect observer measured before the layout settled it wrote a
 * height that was too small, and everything below that line became
 * click-through: the Debug and Debug Logs rows stopped responding entirely.
 *
 * That race was invisible while the resize loop was firing 40 times a second,
 * because the next frame immediately corrected it. Damping the loop removed
 * the accidental self-healing and exposed the underlying bug.
 */
function syncOverlayHeight(): void {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const panel = document.querySelector('.panel') as HTMLElement | null;
    if (!panel) return;
    // scrollHeight is in logical CSS px; the Rust side sizes the window in
    // PHYSICAL px (and so does the click-through hit-rect, which is compared
    // against physical Win32 cursor coords). Multiply by devicePixelRatio so
    // the window fits its content on scaled displays — without this a 125/150%
    // laptop got a too-short window and clipped the debug thumbnail, while a
    // 100% ultrawide looked fine. Matches the panelResize convention below.
    const dpr = window.devicePixelRatio || 1;
    const desired = computeDesiredHeight(Math.ceil(panel.scrollHeight));
    const height = Math.round(desired * dpr);
    const width = Math.round(panel.offsetWidth * dpr);

    // The hit-rect is sent whenever it changes at all — it is a cheap message
    // and getting it wrong makes controls unusable, so it does not share the
    // resize dead band.
    if (!lastSentHitRect || lastSentHitRect.width !== width || lastSentHitRect.height !== height) {
      lastSentHitRect = { width, height };
      sendToBackground('panelResize', { width, height });
    }

    if (!shouldResendHeight(height, lastSentHeight)) return;
    lastSentHeight = height;
    sendToBackground('resizeOverlay', { height });
  });
}

/**
 * Low-frequency reconciliation.
 *
 * ResizeObserver only fires when the element's own box changes, so a layout
 * that settles late — a web font, the debug thumbnail loading, a scrollbar
 * appearing — can leave the last reported geometry stale with nothing to
 * correct it. Two checks a second is invisible next to the 40/second this
 * replaces, and it restores the self-healing without the cost. Each check is a
 * measurement and a comparison; nothing is sent unless something moved.
 */
setInterval(syncOverlayHeight, 500);

interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isMuted: boolean;
  isMutedByLocal: boolean;
  isDead: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
  trackingState?: string;
  trackingHoldSec?: number;
  lastPosition?: { x: number; y: number } | null;
  filteredImageUrl?: string | null;
  detectedMinimapBounds?: { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null;
  localTeam?: 'ORDER' | 'CHAOS' | null;
  lifecycleStatus?: string;
}

const playerList = document.getElementById('player-list')!;
const btnSelfMute = document.getElementById('btn-self-mute')!;
const btnMuteAll = document.getElementById('btn-mute-all')!;
const btnSettings = document.getElementById('btn-settings')!;
const btnDebug = document.getElementById('btn-debug')!;
const btnCollapse = document.getElementById('btn-collapse')!;
const panel = document.getElementById('panel')!;
const settingsPanel = document.getElementById('settings-panel')!;
const dragHandle = document.getElementById('drag-handle')!;

// Debug overlay state — always starts off; user toggles per session.
let debugEnabled = false;
setLoggingEnabled(false);

// Per-player volume cache (so sliders don't reset on re-render)
// Seeded from localStorage so the row sliders show the trims the user actually
// set. AudioService loads the same store, so UI and engine agree from the first
// frame — previously both reset to 100% on a new game while the UI kept
// displaying the old positions.
const playerVolumes: Map<string, number> = new Map(Object.entries(getPlayerVolumes()));

// Tauri handles window dragging and resizing via its window config.
// The drag handle uses Tauri's built-in data-tauri-drag-region attribute
// (set in the HTML). No manual drag/resize logic needed.

// --- Controls ---
// MIC / VOL buttons signal their muted state via the `.active` color only —
// the label stays "MIC" / "VOL" (no "OFF" suffix) so the button width doesn't
// jump and the icon-button row stays visually stable.
btnSelfMute.addEventListener('click', () => {
  const nowMuted = !btnSelfMute.classList.contains('active');
  btnSelfMute.classList.toggle('active', nowMuted);
  sendToBackground('toggleSelfMute', {});
});

btnMuteAll.addEventListener('click', () => {
  const nowMuted = !btnMuteAll.classList.contains('active');
  btnMuteAll.classList.toggle('active', nowMuted);
  sendToBackground('toggleMuteAll', {});
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    refreshDeviceLists();
  }
  syncOverlayHeight();
});

// --- Audio device pickers ---
const inputDeviceSelect = document.getElementById('input-device') as HTMLSelectElement;
const outputDeviceSelect = document.getElementById('output-device') as HTMLSelectElement;

async function refreshDeviceLists(): Promise<void> {
  try {
    let { inputs, outputs } = await listAudioDevices();
    // Empty labels mean the user hasn't granted mic permission yet. Trigger
    // a one-shot probe so labels populate; then re-enumerate.
    if (inputs.some((d) => !d.label) || outputs.some((d) => !d.label)) {
      try {
        await probeMicPermission();
        ({ inputs, outputs } = await listAudioDevices());
      } catch {
        // User denied or no mic present — fall through with whatever labels we have
      }
    }
    populateDeviceSelect(inputDeviceSelect, inputs, getStoredInputDeviceId());
    populateDeviceSelect(outputDeviceSelect, outputs, getStoredOutputDeviceId());
  } catch (e) {
    console.warn('[Overlay] device enumeration failed:', e);
  }
}

function populateDeviceSelect(
  select: HTMLSelectElement,
  devices: MediaDeviceInfo[],
  selectedId: string | null,
): void {
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Default';
  const opts: HTMLOptionElement[] = [defaultOpt];
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `(unnamed ${d.kind})`;
    opts.push(opt);
  }
  select.replaceChildren(...opts);
  select.value = selectedId && devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
}

inputDeviceSelect.addEventListener('change', () => {
  const id = inputDeviceSelect.value || null;
  setStoredInputDeviceId(id);
  sendToBackground('setInputDevice', { id });
});

outputDeviceSelect.addEventListener('change', () => {
  const id = outputDeviceSelect.value || null;
  setStoredOutputDeviceId(id);
  sendToBackground('setOutputDevice', { id });
});

// Refresh if user plugs / unplugs a device while the panel is open
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!settingsPanel.classList.contains('hidden')) {
    refreshDeviceLists();
  }
});

let collapsed = false;
btnCollapse.addEventListener('click', () => {
  collapsed = !collapsed;
  panel.classList.toggle('collapsed', collapsed);
  btnCollapse.textContent = collapsed ? '\u00AB' : '\u00BB';
  btnCollapse.title = collapsed ? 'Expand' : 'Collapse';
  // Close settings when collapsing
  if (collapsed) {
    settingsPanel.classList.add('hidden');
  }
});

const scanRateRow = document.getElementById('scan-rate-row')!;
const btnAutoUpdate = document.getElementById('btn-autoupdate') as HTMLButtonElement;
const btnCheckUpdate = document.getElementById('btn-check-update') as HTMLButtonElement;
const updateStatus = document.getElementById('update-status')!;

// --- Auto-update UI ---
function syncAutoUpdateButton(): void {
  const on = isAutoUpdateEnabled();
  btnAutoUpdate.textContent = on ? 'ON' : 'OFF';
  btnAutoUpdate.classList.toggle('active', on);
}
registerResync(syncAutoUpdateButton);

btnAutoUpdate.addEventListener('click', () => {
  setAutoUpdateEnabled(!isAutoUpdateEnabled());
  syncAutoUpdateButton();
});

async function runUpdateCheck(triggeredByUser: boolean): Promise<void> {
  updateStatus.textContent = 'Checking for updates…';
  try {
    const info = await checkForUpdate();
    if (info.update_available && info.download_url) {
      updateStatus.textContent = 'Update available: v' + info.latest_version + ' — applying…';
      await downloadAndApply(info.download_url);
      // If apply succeeds, the process exits before we reach here
    } else {
      updateStatus.textContent = triggeredByUser
        ? 'Up to date (v' + info.current_version + ')'
        : '';
    }
  } catch (e) {
    updateStatus.textContent = 'Update check failed: ' + (e as Error).message;
  }
}

btnCheckUpdate.addEventListener('click', () => {
  runUpdateCheck(true);
});

const btnOpenLogs = document.getElementById('btn-open-logs') as HTMLButtonElement;
btnOpenLogs.addEventListener('click', () => {
  sendToBackground('openLogFolder', {});
});

// Expose for background.ts to trigger an auto-check on launch
window.__proxchatRunUpdateCheck = runUpdateCheck;

// Force-TURN privacy toggle. New peer connections created after this is
// flipped honor the new setting; existing connections keep whatever policy

// Voice mixer. Everything here is persisted in localStorage by audio-prefs and
// pushed into the running AudioService, which also re-reads it when a new game
// starts a fresh service — so a slider position survives both a game change and
// an app restart.
//
// Proximity (#22) replaces the old binary ally toggle with three states,
// because "teammates fade too" and "nothing fades at all" are both things
// people want and the boolean could only express one of them. The orchestrator
// reads the mode fresh on every /compute-volumes tick, so changes apply on the
// next position update with no reconnect.
const PROXIMITY_ORDER: ProximityMode[] = ['off', 'enemy', 'all'];


function pushPrefs(patch: Partial<AudioPrefs>): AudioPrefs {
  const next = setAudioPrefs(patch);
  sendToBackground('updateAudioPrefs', next);
  return next;
}

const btnProximityMode = document.getElementById('btn-proximity-mode') as HTMLButtonElement;
function syncProximityButton(mode: ProximityMode): void {
  btnProximityMode.textContent = mode.toUpperCase();
  btnProximityMode.classList.toggle('active', mode !== 'off');
}
registerResync(() => syncProximityButton(getAudioPrefs().proximityMode));
btnProximityMode.addEventListener('click', () => {
  const current = getAudioPrefs().proximityMode;
  const next = PROXIMITY_ORDER[(PROXIMITY_ORDER.indexOf(current) + 1) % PROXIMITY_ORDER.length];
  syncProximityButton(pushPrefs({ proximityMode: next }).proximityMode);
});

const btnAudioBoost = document.getElementById('btn-audio-boost') as HTMLButtonElement;
function syncAudioBoostButton(on: boolean): void {
  btnAudioBoost.textContent = on ? 'ON' : 'OFF';
  btnAudioBoost.classList.toggle('active', on);
}
registerResync(() => syncAudioBoostButton(getAudioPrefs().audioBoost));
btnAudioBoost.addEventListener('click', () => {
  syncAudioBoostButton(pushPrefs({ audioBoost: !getAudioPrefs().audioBoost }).audioBoost);
});

/**
 * Wire one mixer slider. `scale` converts the integer slider position to the
 * stored value (percentages → gain factors, etc). The label always shows the
 * raw slider number so it matches what the user is dragging.
 */
function bindMixerSlider(
  inputId: string,
  labelId: string,
  key: keyof AudioPrefs,
  scale: (raw: number) => number,
  toRaw: (value: number) => number,
): void {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const label = document.getElementById(labelId)!;
  const sync = (prefs: AudioPrefs) => {
    const raw = Math.round(toRaw(prefs[key] as number));
    input.value = String(raw);
    label.textContent = String(raw);
  };
  registerResync(() => sync(getAudioPrefs()));
  input.addEventListener('input', () => {
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return;
    label.textContent = String(Math.round(raw));
    pushPrefs({ [key]: scale(raw) } as Partial<AudioPrefs>);
  });
}

bindMixerSlider('input-master-vol', 'master-vol-label', 'masterVolume', r => r / 100, v => v * 100);
bindMixerSlider('input-team-vol', 'team-vol-label', 'teamVolume', r => r / 100, v => v * 100);
bindMixerSlider('input-enemy-vol', 'enemy-vol-label', 'enemyVolume', r => r / 100, v => v * 100);


/**
 * Restore the factory state.
 *
 * Clearing storage is the easy part; three things have to happen alongside it
 * or the reset is a lie:
 *   • the PTT / toggle-mute keys live in Rust atomics, and the startup push
 *     that syncs them is conditional on the stored keys existing — after a
 *     clear it sends nothing, so the old hotkey would keep working silently.
 *   • the per-player slider map is held in memory here, so cleared storage
 *     alone leaves every row at its old position.
 *   • the running AudioService snapshots prefs at construction and only
 *     learns about changes when it is told.
 */
function resetAllSettings(): void {
  clearAllStoredSettings();

  sendToBackground('setPttKey', { vk: DEFAULT_PTT_VK });
  sendToBackground('setToggleKey', { vk: 0 });
  sendToBackground('updateAudioPrefs', getAudioPrefs());
  sendToBackground('updateSettings', {
    inputVolume: DEFAULT_AUDIO_PREFS.inputVolume,
    inputMode: 'always',
  });
  sendToBackground('setInputDevice', { id: null });
  sendToBackground('setOutputDevice', { id: null });

  // The audio engine holds its own copy of the trims and only learns about
  // changes when told, so clearing storage and the overlay's cache would still
  // leave a player muted at 20% for the rest of the game.
  for (const name of playerVolumes.keys()) {
    sendToBackground('setPlayerVolume', { name, volume: 1.0 });
  }
  playerVolumes.clear();
  for (const fn of resyncers) {
    try { fn(); } catch (e) { console.warn('[Overlay] resync failed:', e); }
  }
  void refreshDeviceLists();
  console.log('[Overlay] All settings reset to defaults');
}

const btnResetAll = document.getElementById('btn-reset-all') as HTMLButtonElement;
let resetArmed: ReturnType<typeof setTimeout> | null = null;
function disarmReset(): void {
  if (resetArmed !== null) { clearTimeout(resetArmed); resetArmed = null; }
  btnResetAll.textContent = 'RESET';
  btnResetAll.classList.remove('active');
}
btnResetAll.addEventListener('click', () => {
  if (resetArmed === null) {
    // Two-step confirm rather than a dialog: a JS confirm() would block the
    // whole WebView, and a blocked WebView stops the minimap scan dead.
    btnResetAll.textContent = 'SURE?';
    btnResetAll.classList.add('active');
    resetArmed = setTimeout(disarmReset, 3000);
    return;
  }
  disarmReset();
  resetAllSettings();
});

// v0.3 (#1): PTT + toggle-mute key rebind. The Rust WH_KEYBOARD_LL hook
// reads the bound VK code from atomics it exposes via set_ptt_key /
// set_toggle_key Tauri commands. UI pattern: click the button → "Press a
// key..." prompt → capture next keydown → translate to Win32 VK → persist
// + push to Rust.
const PTT_VK_KEY = 'lolproxchat.pttVk';
const TOGGLE_VK_KEY = 'lolproxchat.toggleVk';
const DEFAULT_PTT_VK: number | null = 0x14;  // Caps Lock — matches Rust default (v0.5.6 unbound it but that stranded PTT users; v0.5.7 restored it, see #27)
const FORBIDDEN_CODES = new Set([
  'Escape', 'Tab',
  // Common LoL bindings — would conflict with gameplay even though our
  // hook fires first.
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyD', 'KeyF', 'KeyB', 'KeyP',
  // Modifier-only is bad UX (always pressed during typing combos)
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

function setupBindButton(buttonId: string, storageKey: string, backgroundCmd: string, defaultVk: number | null): void {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  if (!btn) return;
  const stored = localStorage.getItem(storageKey);
  const initialVk = stored !== null ? parseInt(stored, 10) : defaultVk;
  if (initialVk !== null && !Number.isNaN(initialVk) && initialVk > 0) {
    btn.textContent = humanizeVk(initialVk);
  } else {
    btn.textContent = '(unbound)';
  }

  btn.addEventListener('click', () => {
    const originalText = btn.textContent || '(unbound)';
    btn.textContent = 'Press a key…';
    btn.classList.add('active');
    btn.disabled = true;
    const restore = (text: string) => {
      btn.textContent = text;
      btn.classList.remove('active');
      btn.disabled = false;
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onKey, true);
      if (e.code === 'Escape') {
        restore(originalText);
        return;
      }
      if (FORBIDDEN_CODES.has(e.code)) {
        restore('(LoL/system key — pick another)');
        setTimeout(() => restore(originalText), 1500);
        return;
      }
      const vk = browserKeyToWin32Vk(e.code);
      if (vk === null) {
        restore('(key not supported)');
        setTimeout(() => restore(originalText), 1500);
        return;
      }
      localStorage.setItem(storageKey, String(vk));
      sendToBackground(backgroundCmd, { vk });
      restore(humanizeVk(vk));
    };
    window.addEventListener('keydown', onKey, true);
  });
}

queueMicrotask(() => {
  setupBindButton('btn-bind-ptt', PTT_VK_KEY, 'setPttKey', DEFAULT_PTT_VK);
  setupBindButton('btn-bind-toggle', TOGGLE_VK_KEY, 'setToggleKey', null);
  // Push any stored bindings to Rust on startup so user prefs survive restart.
  const ptt = localStorage.getItem(PTT_VK_KEY);
  if (ptt !== null) sendToBackground('setPttKey', { vk: parseInt(ptt, 10) });
  const toggle = localStorage.getItem(TOGGLE_VK_KEY);
  if (toggle !== null) sendToBackground('setToggleKey', { vk: parseInt(toggle, 10) });
});

btnDebug.addEventListener('click', () => {
  debugEnabled = !debugEnabled;
  btnDebug.textContent = debugEnabled ? 'ON' : 'OFF';
  btnDebug.classList.toggle('active', debugEnabled);
  scanRateRow.classList.toggle('hidden', !debugEnabled);
  setLoggingEnabled(debugEnabled);
  // Read by orchestrator when emitting scanner:scene events so the scanner
  // window only renders the tracking dot while Debug is on.
  window.__lolproxchat_debug_enabled = debugEnabled;
  // Hide the HSV thumbnail immediately when Debug flips off.
  if (!debugEnabled) {
    debugFilterThumb.classList.add('hidden');
    debugFilterThumb.removeAttribute('src');
  }
  // v0.3 (#11): re-fit window for new debug-row visibility
  syncOverlayHeight();
});

// HSV-filtered minimap preview — shown only while Debug is on. Listens to the
// same scanner:scene event the scanner window does; the panel renders the
// filtered image (which used to live painted on the scanner itself, but that
// fed back into the next capture cycle and required excluding the scanner
// from capture, which broke ShadowPlay / OBS).
const debugFilterThumb = document.getElementById('debug-filter-thumb') as HTMLImageElement;
listen<{ filteredImageUrl: string | null; debugEnabled: boolean }>('scanner:scene', (event) => {
  const { filteredImageUrl, debugEnabled: dbg } = event.payload;
  if (dbg && filteredImageUrl) {
    debugFilterThumb.src = filteredImageUrl;
    debugFilterThumb.classList.remove('hidden');
  } else {
    debugFilterThumb.classList.add('hidden');
    if (!filteredImageUrl) debugFilterThumb.removeAttribute('src');
  }
}).catch((e) => console.warn('[Overlay] scanner:scene listen failed:', e));

// v0.3 (#11): also re-fit when the thumbnail finishes loading (async image
// load can change scrollHeight after the toggle click already fired) and on
// every overlayUpdate (peer list grows / shrinks).
debugFilterThumb.addEventListener('load', syncOverlayHeight);
const panelEl = document.querySelector('.panel');
if (panelEl) {
  new ResizeObserver(syncOverlayHeight).observe(panelEl);
}
window.addEventListener('DOMContentLoaded', syncOverlayHeight);

document.getElementById('input-mode')!.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  sendToBackground('updateSettings', { inputMode: mode });
});

const volumeInput = document.getElementById('input-volume') as HTMLInputElement;
const volumeLabel = document.getElementById('volume-label')!;
registerResync(() => {
  const stored = Math.round(getAudioPrefs().inputVolume * 100);
  volumeInput.value = String(stored);
  volumeLabel.textContent = String(stored);
});
volumeInput.addEventListener('input', () => {
  // Number(), not parseInt(): an empty field parses to NaN, which used to
  // travel all the way to an AudioParam assignment and throw, killing the mic.
  const raw = Number(volumeInput.value);
  if (!Number.isFinite(raw)) return;
  volumeLabel.textContent = String(Math.round(raw));
  pushPrefs({ inputVolume: raw / 100 });
  sendToBackground('updateSettings', { inputVolume: raw / 100 });
});

const scanRateInput = document.getElementById('input-scan-rate') as HTMLInputElement;
const scanRateLabel = document.getElementById('scan-rate-label')!;
scanRateInput.addEventListener('input', () => {
  const raw = parseInt(scanRateInput.value);
  scanRateLabel.textContent = String(raw);
  // Map 0-100 → 1-60 FPS for backend scan rate (default 50 → 30 FPS)
  const fps = Math.max(1, Math.round(1 + (raw / 100) * 59));
  sendToBackground('setScanRate', { fps });
});

function sendToBackground(action: string, payload: any): void {
  // In Tauri, both background and overlay run in the same WebView,
  // so we use window events for communication
  window.dispatchEvent(new CustomEvent('overlayAction', { detail: { action, payload } }));
}

// The click-through rect is reported by syncOverlayHeight, from the same
// measurement that sizes the window — see the note there for why having two
// independent reporters was a bug rather than redundancy.
requestAnimationFrame(syncOverlayHeight);

// --- Track active player row DOM elements for in-place updates ---
const playerRows: Map<string, {
  row: HTMLElement;
  nameSpan: HTMLElement;
  indicator: HTMLElement | null;
  volSlider: HTMLInputElement;
  muteBtn: HTMLButtonElement;
}> = new Map();

// Track whether a player slider is being actively dragged
let activeSliderPlayer: string | null = null;

function createPlayerRow(peer: NearbyPeer, localTeam: 'ORDER' | 'CHAOS' | null | undefined): HTMLElement {
  const row = document.createElement('div');
  const isAlly = localTeam ? peer.team === localTeam : peer.team === 'ORDER';
  row.className = 'player-row ' + (isAlly ? 'ally' : 'enemy');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName;
  nameSpan.title = peer.summonerName;
  row.appendChild(nameSpan);

  const indicator = document.createElement('span');
  indicator.className = 'player-muted-indicator';
  if (peer.isDead) {
    indicator.textContent = 'DEAD';
  } else if (peer.isMuted) {
    indicator.textContent = 'MUTED';
  } else {
    indicator.style.display = 'none';
  }
  row.appendChild(indicator);

  const volSlider = document.createElement('input') as HTMLInputElement;
  volSlider.type = 'range';
  volSlider.className = 'player-volume';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
  volSlider.addEventListener('mousedown', () => { activeSliderPlayer = peer.summonerName; });
  volSlider.addEventListener('mouseup', () => { activeSliderPlayer = null; });
  volSlider.addEventListener('input', () => {
    const raw = Number(volSlider.value);
    if (!Number.isFinite(raw)) return;
    const vol = raw / 100;
    playerVolumes.set(peer.summonerName, vol);
    sendToBackground('setPlayerVolume', { name: peer.summonerName, volume: vol });
  });
  row.appendChild(volSlider);

  const muteBtn = document.createElement('button') as HTMLButtonElement;
  muteBtn.className = 'player-mute-btn' + (peer.isMutedByLocal ? ' muted' : '');
  muteBtn.textContent = peer.isMutedByLocal ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    // Flip the UI immediately so the user gets feedback without waiting
    // for the next broadcastOverlayState tick. Backend state will confirm.
    const nowMuted = !muteBtn.classList.contains('muted');
    muteBtn.classList.toggle('muted', nowMuted);
    muteBtn.textContent = nowMuted ? 'MUTED' : 'MUTE';
    console.log('[Overlay] Mute toggled for', peer.summonerName, '→', nowMuted);
    sendToBackground('toggleMutePlayer', { name: peer.summonerName });
  });
  row.appendChild(muteBtn);

  playerRows.set(peer.summonerName, { row, nameSpan, indicator, volSlider, muteBtn });
  return row;
}

function updatePlayerRow(peer: NearbyPeer): void {
  const entry = playerRows.get(peer.summonerName);
  if (!entry) return;

  // Update indicator
  if (peer.isDead) {
    entry.indicator!.textContent = 'DEAD';
    entry.indicator!.style.display = '';
  } else if (peer.isMuted) {
    entry.indicator!.textContent = 'MUTED';
    entry.indicator!.style.display = '';
  } else {
    entry.indicator!.style.display = 'none';
  }

  // Don't touch slider if user is actively dragging it
  if (activeSliderPlayer !== peer.summonerName) {
    const expected = String(Math.round((playerVolumes.get(peer.summonerName) ?? 1.0) * 100));
    if (entry.volSlider.value !== expected) {
      entry.volSlider.value = expected;
    }
  }

  // Update mute button
  const isMuted = peer.isMutedByLocal;
  entry.muteBtn.className = 'player-mute-btn' + (isMuted ? ' muted' : '');
  entry.muteBtn.textContent = isMuted ? 'MUTED' : 'MUTE';
}

// --- Render state ---
function renderState(state: OverlayState): void {
  // Color-only mute indication (see the click handlers) — label stays static.
  btnSelfMute.classList.toggle('active', state.selfMuted);
  btnMuteAll.classList.toggle('active', state.muteAll);

  // Sort: allies first, then by champion name
  const localTeam = state.localTeam ?? null;
  const sortedPeers = [...state.nearbyPeers].sort((a, b) => {
    if (localTeam) {
      const aAlly = a.team === localTeam;
      const bAlly = b.team === localTeam;
      if (aAlly !== bAlly) return aAlly ? -1 : 1;
    }
    return a.championName.localeCompare(b.championName);
  });

  // Build set of current peer names for diffing
  const currentNames = new Set(sortedPeers.map(p => p.summonerName));

  // Remove rows for peers that left
  for (const [name, entry] of playerRows) {
    if (!currentNames.has(name)) {
      entry.row.remove();
      playerRows.delete(name);
    }
  }

  // Update existing rows or create new ones, in sorted order.
  // Only reorder DOM when the sort order *actually* changed — re-appending
  // a slider mid-drag detaches it from its pointer-event sequence, which
  // is why the per-player volume slider felt "clicky" / had to be re-grabbed
  // at every tick (issue #12). At 10 Hz position ticks the order rarely
  // changes, so the common case is now a no-op.
  const desiredOrder = sortedPeers.map(p => p.summonerName);
  const currentOrder: string[] = [];
  for (const child of Array.from(playerList.children)) {
    for (const [name, entry] of playerRows) {
      if (entry.row === child) { currentOrder.push(name); break; }
    }
  }
  const orderChanged = currentOrder.length !== desiredOrder.length
    || currentOrder.some((n, i) => n !== desiredOrder[i]);

  for (const peer of sortedPeers) {
    let entry = playerRows.get(peer.summonerName);
    if (entry) {
      updatePlayerRow(peer);
    } else {
      const row = createPlayerRow(peer, localTeam);
      playerList.appendChild(row);
      entry = playerRows.get(peer.summonerName);
    }
    if (orderChanged && entry && entry.row.parentElement === playerList) {
      playerList.appendChild(entry.row);
    }
  }

  // Show/hide empty state with lifecycle-aware text
  const emptyText = state.lifecycleStatus || 'Waiting for nearby players...';
  const emptyState = playerList.querySelector('.empty-state');
  if (sortedPeers.length === 0) {
    if (!emptyState) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = emptyText;
      playerList.appendChild(emptyDiv);
    } else if (emptyState.textContent !== emptyText) {
      emptyState.textContent = emptyText;
    }
  } else if (emptyState) {
    emptyState.remove();
  }

  // Debug info: tracking state + position (only when debug enabled)
  const dbgEl = document.getElementById('debug-info')!;
  // Tracking health badge — outside the Debug gate and outside the
  // peers-empty branch on purpose, because "enemies went silent" is almost
  // always this and the user had no way to see it.
  const trackBadge = document.getElementById('track-badge');
  if (trackBadge) {
    // Scanning is the obvious case, but a LOCKED tracker that has been holding
    // for more than a couple of seconds is the one that actually silences
    // enemies — the orchestrator stops sending coordinates at exactly that
    // threshold. Leaving it hidden then would hide the very situation people
    // report.
    const lost = state.trackingState === 'scanning' || (state.trackingHoldSec ?? 0) > 2;
    trackBadge.textContent = lost ? 'FINDING YOU' : '';
    trackBadge.classList.toggle('hidden', !lost);
  }

  if (debugEnabled && (state.trackingState || state.lastPosition)) {
    const parts: string[] = [];
    if (state.trackingState) parts.push('tracking: ' + state.trackingState);
    if (state.lastPosition) {
      parts.push('pos: (' + Math.round(state.lastPosition.x) + ',' + Math.round(state.lastPosition.y) + ')');
    }
    dbgEl.textContent = parts.join(' | ');
    dbgEl.classList.remove('hidden');
  } else {
    dbgEl.classList.add('hidden');
  }
}

// --- Listen for state updates from background ---
window.addEventListener('overlayUpdate', ((event: CustomEvent) => {
  renderState(event.detail);
}) as EventListener);

console.log('LoLProxChat overlay loaded');

export {};
