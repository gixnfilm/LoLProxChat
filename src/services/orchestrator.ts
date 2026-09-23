import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { GameStateService, GameSession, TauriGameState } from './game-state';
import { SignalingService, SignalMessage, PositionBroadcast } from './signaling';
import { AudioService, PeerSide } from './audio';
import { TrackingService, TrackingState } from './tracking';
import { ChampionClassifier } from './champion-classifier';
import { VolumeClient } from './volume-client';
import { getAllyProximity, getAudioPrefs, AudioPrefs } from './audio-prefs';
import { PeerState, Position } from '../core/types';
import { locatePeers, AudiblePeer } from './peer-locator';
import { isInRiver } from './river-mask';
import '../core/window-globals';
import { isStreamerMode } from '../core/streamer-detect';


/**
 * How long the orchestrator tolerates having no usable own position before it
 * tears the tracker down and rescans. Long enough not to fight a normal
 * death-and-respawn (which legitimately produces no position), short enough
 * that a wedged or mis-locked tracker doesn't ruin a whole game.
 */
const TRACKING_WATCHDOG_MS = 12000;

export class Orchestrator {
  private gameState: GameStateService;
  private signaling: SignalingService;
  private audio: AudioService | null = null;
  private tracking: TrackingService | null = null;
  private volumeClient: VolumeClient | null = null;
  private session: GameSession | null = null;

  private localSummonerName = '';
  private peerStates: Map<string, PeerState> = new Map();
  private volumeTickId: number | null = null;
  private configPollId: number | null = null;
  private gameStatePollId: number | null = null;
  private positionTickRunning = false;
  // Consecutive /compute-volumes failures, for throttling the error log.
  private volumeFailures = 0;
  // performance.now() of the last tick that had a usable own position, and of
  // the last forced rescan, so the watchdog neither fires early nor loops.
  private lastGoodPositionMs = 0;
  private lastForcedRescanMs = 0;
  // Where each peer was last confidently seen, so a binding made in a clear
  // moment survives the crowded frames that follow.
  private peerPositions: Map<string, Position> = new Map();
  private sessionActive = false;
  private lastOverlayRepositionTime = 0;
  private lastOverlayBounds: { x: number; y: number; w: number; h: number } | null = null;
  private lastLoggedPosition: { x: number; y: number } | null = null;
  private lastMinimapScale: number | null = null;
  private dpiScale = 1;
  private lastGameState: TauriGameState | null = null;

  // User mute prefs survive across session start/end so the panel's MIC / VOL
  // buttons stay sticky when toggled outside a game (audio is null between
  // games). On session start these get pushed into the new AudioService.
  private selfMutedPref = false;
  private muteAllPref = false;

  constructor() {
    this.gameState = new GameStateService();
    this.signaling = new SignalingService();
  }

  start(): void {
    console.log('[LoLProxChat] Orchestrator.start() called');

    // Poll Tauri backend for game state every 3 seconds
    this.gameStatePollId = window.setInterval(() => this.pollGameState(), 3000) as unknown as number;

    // Also poll immediately on start
    this.pollGameState();
  }

  private async pollGameState(): Promise<void> {
    try {
      const state: TauriGameState = await this.gameState.pollGameState();
      this.lastGameState = state;

      if (!state.isLeagueRunning) {
        if (this.session) {
          console.log('[LoLProxChat] LoL closed, ending session');
          this.endSession();
        }
        // Fire an overlay refresh so the empty-state text reflects "Waiting for LoL"
        this.broadcastOverlayState();
        return;
      }

      if (state.isInGame && !this.session) {
        // Game is in progress but we don't have a session yet — try to get live client data
        await this.pollForLiveClientData();
      }

      // Update death state from Tauri backend
      if (this.session && state.isDead !== this.session.localPlayer.isDead) {
        if (state.isDead) {
          this.session.localPlayer.isDead = true;
          this.tracking?.onDeath();
        } else {
          this.session.localPlayer.isDead = false;
          this.tracking?.onRespawn();
        }
      }

      if (!state.isInGame && this.session) {
        console.log('[LoLProxChat] Game ended (phase: ' + state.gameFlowPhase + ')');
        this.endSession();
      }

      // Refresh overlay even between sessions so lifecycle text stays current
      if (!this.session) {
        this.broadcastOverlayState();
      }
    } catch (e) {
      console.error('[LoLProxChat] pollGameState failed:', e);
    }
  }

  private async pollForLiveClientData(): Promise<void> {
    if (this.session) return;

    try {
      // Fetch live client data directly from League's local API via Tauri
      const lcd = await this.gameState.pollLiveClientData();
      if (lcd) {
        this.processLiveClientData(lcd);
      }
    } catch (e) {
      console.error('[LoLProxChat] pollForLiveClientData failed:', e);
    }
  }

  private processLiveClientData(lcd: any): void {
    if (this.session) return;

    try {
      if (lcd.activePlayer && !this.localSummonerName) {
        const active = typeof lcd.activePlayer === 'string'
          ? JSON.parse(lcd.activePlayer)
          : lcd.activePlayer;
        this.localSummonerName = active.riotId || active.summonerName || '';
        console.log('[LoLProxChat] Local summoner:', this.localSummonerName);
      }

      if (lcd.allPlayers && this.localSummonerName) {
        const playersData = typeof lcd.allPlayers === 'string'
          ? JSON.parse(lcd.allPlayers)
          : lcd.allPlayers;
        const players = this.gameState.parsePlayerList({ players: playersData });
        console.log('[LoLProxChat] Parsed players:', players.length);

        const gameMode = lcd.gameData
          ? (typeof lcd.gameData === 'string' ? JSON.parse(lcd.gameData) : lcd.gameData).gameMode || 'CLASSIC'
          : 'CLASSIC';

        const session = this.gameState.createSession(
          players,
          this.localSummonerName,
          gameMode,
        );

        if (session) {
          this.session = session;
          console.log('[LoLProxChat] Session created! Room:', session.roomId);
          this.startSession(session);
        }
      }
    } catch (e) {
      console.error('[LoLProxChat] Failed to process live client data:', e);
    }
  }

  private async startSession(session: GameSession): Promise<void> {
    console.log('[LoLProxChat] Starting session: room=' + session.roomId);

    // Initialize audio (mic + WebRTC)
    this.audio = new AudioService(this.signaling, this.localSummonerName);
    try {
      await this.audio.initMicrophone();
      console.log('[LoLProxChat] Microphone initialized');
    } catch (e) {
      console.error('[LoLProxChat] Mic init failed — aborting session:', e);
      this.audio = null;
      return;
    }
    // performance.now() runs for the life of the process, so leftovers from a
    // previous game would read as "no position for several minutes" and fire a
    // forced rescan on a tracker that started milliseconds ago.
    this.lastGoodPositionMs = 0;
    this.lastForcedRescanMs = 0;
    this.peerPositions = new Map();

    // Carry over any mute toggles the user set before/between sessions.
    this.audio.setSelfMuted(this.selfMutedPref);
    this.audio.setMuteAll(this.muteAllPref);
    // ...and the mixer. A new AudioService is built per game while the overlay
    // window is never reloaded, so without this the engine silently resets to
    // its defaults while the UI still shows the user's slider positions.
    this.audio.applyAudioPrefs(getAudioPrefs());

    // Join signaling room. v0.3: team is sent so the server can do team-aware
    // proximity (allies always full volume; enemies fade out at vision range).
    // Older servers ignore the team field and fall back to team-blind behavior.
    this.signaling.joinRoom(
      session.roomId,
      this.localSummonerName,
      session.localPlayer.team,
      (peer) => this.handlePeerPosition(peer),
      (signal) => this.handleSignal(signal),
      (name) => this.handlePeerLeave(name),
      undefined,
      () => this.handleSignalingReconnect(),
    );

    this.sessionActive = true;

    // Start tracking service
    try {
      // Get actual screen resolution from Tauri backend (Win32 GetSystemMetrics)
      let gameW = window.screen.width;
      let gameH = window.screen.height;
      try {
        const [w, h] = await invoke<[number, number]>('get_screen_size');
        gameW = w;
        gameH = h;
      } catch (e) {
        console.warn('[LoLProxChat] get_screen_size failed, using window.screen:', e);
      }
      this.dpiScale = window.devicePixelRatio || 1;
      console.log('[LoLProxChat] Resolution: game=' + gameW + 'x' + gameH +
        ' dpiScale=' + this.dpiScale);

      // Note: League install dir is resolved Rust-side via the
      // read_league_config_file command (computes the path from the running
      // LeagueClient process or common defaults). The frontend no longer
      // handles the path directly — closing an arbitrary-file-read attack
      // surface that v0.1.30 and earlier had via read_text_file.

      this.tracking = new TrackingService(gameW, gameH, session.mapType);
      this.tracking.loadChampionTemplate(session.localPlayer.championName);

      // Set capture bounds in Tauri backend
      await this.tracking.initCaptureBounds();

      // Load champion classifier (async, non-blocking — tracking works without it)
      const classifier = new ChampionClassifier();
      classifier.load(
        '../models/champion_classifier.onnx',
        '../models/champion_labels.json',
        session.localPlayer.championName,
      ).then(() => {
        if (this.tracking) {
          this.tracking.setClassifier(classifier);
          console.log('[LoLProxChat] Champion classifier loaded');
        }
      }).catch(err => {
        console.warn('[LoLProxChat] Champion classifier failed to load (tracking continues without it):', err);
      });

      // Read minimap scale from League config and apply before starting tracking
      this.readMinimapScale((scale) => {
        if (scale !== null && this.tracking) {
          this.lastMinimapScale = scale;
          this.tracking.setMinimapScaleFromConfig(scale);
        }
      });

      this.tracking.start((_pos) => {
        // Fast overlay refresh at scan rate so position/debug visuals don't
        // wait for the 4 Hz positionTick. Volume + peer state still flow
        // through positionTick — broadcastOverlayState is read-only.
        this.broadcastOverlayState();
      }, 30);

      // Volume client speaks the v0.2 /compute-volumes shape — peer positions
      // come from server-side room state populated by `coords` WSS messages,
      // not from peer-to-peer data channels.
      this.volumeClient = new VolumeClient();

      // Start volume computation tick (10 Hz). Per-peer GainNode
      // setTargetAtTime smoothing turns these discrete steps into a continuous
      // ramp; the tick rate just sets how often we refresh the *target*, not
      // how often the audio gain actually moves.
      this.volumeTickId = window.setInterval(() => this.positionTick(), 100) as unknown as number;

      // Poll game.cfg every 5 seconds for minimap scale changes
      this.configPollId = window.setInterval(() => this.pollMinimapScale(), 5000) as unknown as number;

    } catch (e) {
      console.error('[LoLProxChat] Tracking initialization failed:', e);
    }

    // Overlay is managed by Tauri window configuration — no manual window open needed
  }

  private async positionTick(): Promise<void> {
    if (this.positionTickRunning) return;
    if (!this.audio || !this.session || !this.tracking || !this.volumeClient) return;
    this.positionTickRunning = true;
    try {
      await this.positionTickInner();
    } finally {
      this.positionTickRunning = false;
    }
  }

  private async positionTickInner(): Promise<void> {
    if (!this.audio || !this.session || !this.tracking || !this.volumeClient) return;

    // Broadcast presence over signaling so peers can discover us.
    // Coordinates go separately via sendCoords() — kept off this message so
    // every peer doesn't see them, and so server-side staleness can be
    // computed against the actual position update time.
    this.signaling.broadcastPosition({
      summonerName: this.localSummonerName,
      championName: this.session.localPlayer.championName,
      team: this.session.localPlayer.team,
      isMuted: this.audio.isSelfMuted(),
      isDead: this.session.localPlayer.isDead ?? false,
    });

    // Feed known ally peer positions to tracking for self-identification disambiguation
    const allyPeerPositions = Array.from(this.peerStates.values())
      .filter(p => p.team === this.session!.localPlayer.team && p.position.x > 0 && p.position.y > 0)
      .map(p => p.position);
    this.tracking.setPeerGamePositions(allyPeerPositions);

    // The mixer needs sides to pick the Team vs Enemy gain; /compute-volumes
    // only returns names.
    this.audio.setPeerTeams(this.peerSides());

    this.trackingWatchdog();

    // Before CV locks on (SCANNING), pass through all ally audio at full volume (fountain)
    if (this.tracking.getState() === TrackingState.SCANNING) {
      this.applyFallbackVolumes();
      this.broadcastOverlayState();
      return;
    }

    const position = this.tracking.getLastPosition();
    if (!position || (position.x === 0 && position.y === 0)) {
      this.applyFallbackVolumes();
      this.broadcastOverlayState();
      return;
    }

    // Stop reporting if our position is stale (CV has been extrapolating
    // for >2s). The server prunes positions older than STALE_POSITION_MS
    // (5s) on its own, but we want to stop polluting earlier than that
    // when CV has clearly lost the player.
    if (this.tracking.getHoldDurationSec() > 2) {
      this.applyFallbackVolumes();
      this.broadcastOverlayState();
      return;
    }

    this.lastGoodPositionMs = performance.now();

    // Push our latest XY to server-side room state. /compute-volumes reads
    // every peer's stored position from there — no more P2P blob exchange.
    this.signaling.sendCoords(position.x, position.y);

    // Log our position whenever it moves >500 game units so we can see the
    // coordinates we're broadcasting (useful for verifying CV accuracy).
    const moved = !this.lastLoggedPosition
      || Math.abs(position.x - this.lastLoggedPosition.x) > 500
      || Math.abs(position.y - this.lastLoggedPosition.y) > 500;
    if (moved) {
      this.lastLoggedPosition = { x: position.x, y: position.y };
      console.log('[LoLProxChat] My position: (' + Math.round(position.x) + ', ' + Math.round(position.y) + ')');
    }

    try {
      const result = await this.volumeClient.computeVolumes(
        position,
        this.session.roomId,
        this.localSummonerName,
        getAllyProximity(),
      );
      this.updatePeerPositions(position, result.peerVolumes);
      this.audio.applyPeerVolumes(result.peerVolumes);
      this.volumeFailures = 0;
    } catch (e) {
      // Don't just log and leave: skipping applyPeerVolumes means setVolume is
      // never called, the EMA never steps, and every peer stays pinned at
      // whatever gain it last had — indefinitely. One failed request (timeout,
      // 429) used to freeze the whole mix.
      this.volumeFailures++;
      if (this.volumeFailures === 1 || this.volumeFailures % 50 === 0) {
        console.error('[LoLProxChat] Volume computation failed (' +
          this.volumeFailures + ' in a row):', e);
      }
      this.applyFallbackVolumes();
    }

    this.broadcastOverlayState();
  }

  /**
   * Work out which visible minimap icon belongs to which voice, and hand the
   * result to the mixer for panning and reverb.
   *
   * Everything here comes from our own minimap — nothing is exchanged with
   * other clients. That is what makes directional audio legitimate for
   * enemies: an icon we can see is a position the game already gave us, while
   * sending coordinates over the network would have been a wallhack.
   */
  private updatePeerPositions(self: Position, peerVolumes: Record<string, number>): void {
    if (!this.audio || !this.tracking || !this.session) return;

    const icons = this.tracking.getLastIcons();
    const sides = this.peerSides();
    const peers: AudiblePeer[] = [];
    for (const [name, vol] of Object.entries(peerVolumes)) {
      if (typeof vol !== 'number' || !Number.isFinite(vol) || vol <= 0) continue;
      peers.push({ name, side: sides.get(name) === 'enemy' ? 'enemy' : 'ally', serverVol: vol });
    }

    const located = locatePeers({
      self,
      icons: icons.slice(),
      peers,
      previous: this.peerPositions,
    });
    this.peerPositions = located;

    // Reverb follows the SPEAKER's surroundings, which is only knowable for
    // someone we can actually see — an unseen speaker stays dry rather than
    // borrowing our own surroundings and implying a location we don't have.
    const wet = new Set<string>();
    const mapType = this.session.mapType;
    for (const [name, pos] of located) {
      if (isInRiver(pos, mapType)) wet.add(name);
    }
    this.audio.setPeerPositions(self, located, wet);
  }

  /**
   * Force a fresh scan when tracking has produced nothing usable for a while.
   *
   * Cross-team audio depends strictly on our own position, so a tracker that
   * quietly stops producing one silences every enemy with no indication why.
   * Before this there was no recovery path at all: the only exit from a bad
   * LOCKED state was a 5 s hold, and a tick wedged mid-capture never even got
   * that far.
   */
  private trackingWatchdog(): void {
    if (!this.tracking) return;
    const now = performance.now();
    if (this.lastGoodPositionMs === 0) this.lastGoodPositionMs = now;
    const sinceGood = now - this.lastGoodPositionMs;
    const sinceRescan = now - this.lastForcedRescanMs;
    if (sinceGood < TRACKING_WATCHDOG_MS || sinceRescan < TRACKING_WATCHDOG_MS) return;
    this.lastForcedRescanMs = now;
    this.lastGoodPositionMs = now;
    this.tracking.forceRescan('no usable position for ' +
      Math.round(sinceGood / 1000) + 's');
  }

  /** summonerName → side, from the roster the orchestrator already tracks. */
  private peerSides(): Map<string, PeerSide> {
    const sides = new Map<string, PeerSide>();
    const myTeam = this.session?.localPlayer.team;
    for (const [name, state] of this.peerStates) {
      sides.set(name, state.team === myTeam ? 'ally' : 'enemy');
    }
    return sides;
  }

  /**
   * Signal a tick that has no usable position of our own — CV hasn't locked
   * yet, lost the player, or the volume request failed.
   *
   * `null` is the whole point: it tells the mixer "no server data" rather than
   * handing it a fabricated response. The previous version synthesised 1.0 for
   * every teammate, which the mixer could not tell apart from a real answer —
   * so it refreshed the grace window and cached the value as the server's,
   * and the next fallback tick did it again. Teammates latched at full volume
   * and never came down, which is exactly the bug this replaces.
   *
   * The per-peer degradation now lives in resolvePeerLevel: teammates hold
   * their last level (then fall back to Min Vol far), enemies fade out. An
   * enemy is never synthesised — the server's range cut-off is a boundary the
   * client must not paper over.
   */
  private applyFallbackVolumes(): void {
    // No position of our own means no frame of reference, so drop every
    // binding and centre everyone rather than panning against a stale one.
    this.peerPositions = new Map();
    this.audio?.setPeerPositions(null, new Map(), new Set());
    this.audio?.applyPeerVolumes(null);
  }

  /**
   * Our socket dropped and came back. Every other client saw us leave and threw
   * away their RTCPeerConnection to us, but we kept ours — so `hasPeer` stayed
   * true, we never re-offered, and whichever side was the designated initiator
   * sat waiting for an offer that would never come. Roughly half the room was
   * lost for the rest of the game, deterministically by name ordering.
   *
   * Dropping our own side of every connection puts both ends in the same state
   * and lets the normal discovery path rebuild them.
   */
  private handleSignalingReconnect(): void {
    if (!this.audio) return;
    const names = Array.from(this.peerStates.keys());
    if (names.length === 0) return;
    console.warn('[LoLProxChat] Signaling reconnected — rebuilding ' +
      names.length + ' peer connection(s)');
    for (const name of names) this.audio.disconnectPeer(name);
    this.peerStates.clear();
    this.broadcastOverlayState();
  }

  private async handlePeerPosition(peer: PositionBroadcast): Promise<void> {
    if (!this.session || !this.audio) return;

    // Skip streamer mode players
    const player = this.session.allPlayers.find(
      (p) => p.summonerName === peer.summonerName,
    );
    if (player && isStreamerMode(player)) return;

    const existing = this.peerStates.get(peer.summonerName);
    if (!existing) {
      const sameTeam = peer.team === this.session.localPlayer.team;
      console.log('[LoLProxChat] Peer joined: ' + peer.summonerName +
        ' (' + (sameTeam ? 'ALLY' : 'ENEMY') + ', ' + peer.championName + ')');
    }
    const peerState: PeerState = {
      summonerName: peer.summonerName,
      championName: peer.championName,
      team: peer.team as 'ORDER' | 'CHAOS',
      position: existing?.position ?? { x: 0, y: 0 },
      isMuted: peer.isMuted,
      isDead: peer.isDead,
    };

    this.peerStates.set(peer.summonerName, peerState);

    // Connect to peer (audio only — positions go via the server in v0.2)
    try {
      if (!this.audio.hasPeer(peer.summonerName)) {
        const isInitiator = this.localSummonerName < peer.summonerName;
        await this.audio.connectToPeer(peer.summonerName, isInitiator);
      }
    } catch (e) {
      console.error('[LoLProxChat] Failed to connect to peer:', peer.summonerName, e);
      this.peerStates.delete(peer.summonerName);
    }
  }

  private async handleSignal(signal: SignalMessage): Promise<void> {
    await this.audio?.handleSignal(signal);
  }

  private handlePeerLeave(name: string): void {
    this.audio?.disconnectPeer(name);
    this.peerStates.delete(name);
    this.broadcastOverlayState();
  }

  private computeLifecycleStatus(): string {
    const gs = this.lastGameState;
    if (!gs || !gs.isLeagueRunning) return 'Waiting for League of Legends';
    if (this.session) {
      const ts = this.tracking?.getState();
      if (ts === 'scanning') return 'Searching for your champion on the minimap';
      // LOCKED with no peers in the room — empty waiting state handled elsewhere
      return '';
    }
    const phase = gs.gameFlowPhase || 'None';
    switch (phase) {
      case 'None':         return 'In client';
      case 'Lobby':        return 'In lobby';
      case 'Matchmaking':  return 'Searching for match';
      case 'ReadyCheck':   return 'Ready check';
      case 'ChampSelect':  return 'In champion select';
      case 'GameStart':
      case 'InProgress':   return 'Joining game...';
      case 'WaitingForStats': return 'Game complete';
      case 'PreEndOfGame':
      case 'EndOfGame':    return 'End of game';
      default:             return phase;
    }
  }

  private broadcastOverlayState(): void {
    const audio = this.audio;
    const nearbyPeers = audio ? Array.from(this.peerStates.values())
      .map((p) => ({
        summonerName: p.summonerName,
        championName: p.championName,
        team: p.team,
        isMuted: p.isMuted,
        isMutedByLocal: audio.isPlayerMuted(p.summonerName),
        isDead: p.isDead,
      })) : [];

    const data = {
      selfMuted: this.selfMutedPref,
      muteAll: this.muteAllPref,
      nearbyPeers,
      trackingState: this.tracking?.getState() ?? 'none',
      trackingHoldSec: this.tracking?.getHoldDurationSec() ?? 0,
      lastPosition: this.tracking?.getLastPosition() ?? null,
      filteredImageUrl: this.tracking?.getFilteredImageUrl() ?? null,
      detectedMinimapBounds: this.tracking?.getDetectedMinimapScreenBounds() ?? null,
      localTeam: this.session?.localPlayer.team ?? null,
      lifecycleStatus: this.computeLifecycleStatus(),
    };

    // Auto-position the SCANNER window over the minimap whenever bounds
    // change (HUD scale, resolution swap, etc). The panel window is never
    // auto-moved — the user owns its position via drag.
    if (data.detectedMinimapBounds) {
      const mb = data.detectedMinimapBounds;
      const next = { x: mb.screenX, y: mb.screenY, w: mb.screenWidth, h: mb.screenHeight };
      const last = this.lastOverlayBounds;
      const changed = !last
        || Math.abs(next.x - last.x) > 4
        || Math.abs(next.y - last.y) > 4
        || Math.abs(next.w - last.w) > 4
        || Math.abs(next.h - last.h) > 4;
      const now = performance.now();
      if (changed && now - this.lastOverlayRepositionTime > 1000) {
        this.lastOverlayRepositionTime = now;
        this.lastOverlayBounds = next;
        invoke('position_scanner', {
          x: mb.screenX,
          y: mb.screenY,
          width: mb.screenWidth,
          height: mb.screenHeight,
        }).catch((e) => console.warn('[LoLProxChat] position_scanner failed:', e));
      }
    }

    // Push the scanner-specific scene (tracking dot + debug image + debug-on)
    // to the scanner window via Tauri events. We rely on the panel window
    // having access to a tauri-emit; reuse the existing invoke pattern so
    // background.ts doesn't need to know about scanner internals.
    emit('scanner:scene', {
      filteredImageUrl: data.filteredImageUrl,
      lastPosition: data.lastPosition,
      debugEnabled: window.__lolproxchat_debug_enabled === true,
    }).catch(() => { /* scanner may not be ready yet — non-fatal */ });

    // Broadcast panel-relevant state to the overlay UI
    window.dispatchEvent(new CustomEvent('overlayUpdate', { detail: data }));
  }

  // Public controls (called from overlay via messaging)
  toggleSelfMute(): boolean {
    this.selfMutedPref = !this.selfMutedPref;
    this.audio?.setSelfMuted(this.selfMutedPref);
    this.broadcastOverlayState();
    return this.selfMutedPref;
  }
  toggleMuteAll(): boolean {
    this.muteAllPref = !this.muteAllPref;
    this.audio?.setMuteAll(this.muteAllPref);
    this.broadcastOverlayState();
    return this.muteAllPref;
  }
  toggleMutePlayer(name: string): boolean { return this.audio?.toggleMutePlayer(name) ?? false; }
  setPlayerVolume(name: string, volume: number): void { this.audio?.setPlayerVolume(name, volume); }
  setScanRate(fps: number): void {
    if (!this.tracking) return;
    const clamped = Math.max(1, Math.min(60, Math.round(fps)));
    console.log('[LoLProxChat] Scan rate changed to ' + clamped + ' FPS');
    this.tracking.stop();
    // Pass the SAME callback start() was originally given. Installing an empty
    // one here permanently killed the fast overlay refresh for the rest of the
    // session — touching the Scan Rate slider once was enough.
    this.tracking.start(() => this.broadcastOverlayState(), clamped);
  }
  setPTTState(held: boolean): void { this.audio?.setPTTState(held); }
  /** Mixer settings changed in the overlay — persistence is the caller's job. */
  updateAudioPrefs(prefs: AudioPrefs): void { this.audio?.applyAudioPrefs(prefs); }
  updateSettings(settings: any): void { this.audio?.updateSettings(settings); }
  applyInputDevice(id: string | null): Promise<void> | void { return this.audio?.applyInputDevice(id); }
  applyOutputDevice(id: string | null): Promise<void> | void { return this.audio?.applyOutputDevice(id); }

  getSessionPlayers(): { summonerName: string; championName: string; team: string }[] {
    if (!this.session) return [];
    return this.session.allPlayers.map((p) => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team,
    }));
  }

  /**
   * Receive minimap screen bounds from calibration overlay and convert to
   * capture-relative coordinates for the tracking service.
   */
  setMinimapCalibration(bounds: { screenX: number; screenY: number; screenWidth: number; screenHeight: number }): void {
    if (!this.tracking) {
      console.warn('[LoLProxChat] setMinimapCalibration called but no tracking service');
      return;
    }
    const capture = this.tracking.captureBounds;
    // Convert screen coordinates to capture-relative coordinates
    const region = {
      x: bounds.screenX - capture.x,
      y: bounds.screenY - capture.y,
      width: bounds.screenWidth,
      height: bounds.screenHeight,
    };
    console.log('[LoLProxChat] Calibration bounds (screen):', JSON.stringify(bounds));
    console.log('[LoLProxChat] Calibration region (capture-relative):', JSON.stringify(region));
    this.tracking.setMinimapRegion(region);
  }

  /**
   * Read MinimapScale from League's game.cfg. The file is an INI-style config
   * with [Section] headers. MinimapScale is under [HUD] and ranges from 0.0 to 1.0.
   * The Rust side computes the install dir and reads only `Config/game.cfg`;
   * the frontend never handles arbitrary paths.
   */
  private readMinimapScale(callback: (scale: number | null) => void): void {
    invoke<string>('read_league_config_file')
      .then(text => this.parseMinimapScale(text, callback))
      .catch(err => {
        console.warn('[LoLProxChat] Failed to read game.cfg:', err);
        callback(null);
      });
  }

  private parseMinimapScale(text: string, callback: (scale: number | null) => void): void {
    const lines = text.split('\n');
    let inHudSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inHudSection = trimmed.toLowerCase() === '[hud]';
        continue;
      }
      if (inHudSection && trimmed.toLowerCase().startsWith('minimapscale=')) {
        const rawVal = trimmed.split('=')[1].trim();
        const val = parseFloat(rawVal);
        if (!isNaN(val)) {
          console.log('[LoLProxChat] MinimapScale raw="' + rawVal + '" parsed=' + val);
          callback(val);
          return;
        }
      }
    }
    console.warn('[LoLProxChat] MinimapScale not found in game.cfg, text length=' + text.length);
    callback(null);
  }

  /**
   * Poll game.cfg for MinimapScale changes and update tracking bounds.
   */
  private pollMinimapScale(): void {
    this.readMinimapScale((scale) => {
      if (scale === null || !this.tracking) return;
      if (scale !== this.lastMinimapScale) {
        console.log('[LoLProxChat] MinimapScale changed:', this.lastMinimapScale, '->', scale);
        this.lastMinimapScale = scale;
        this.tracking.setMinimapScaleFromConfig(scale);
      }
    });
  }

  private endSession(): void {
    this.positionTickRunning = false;
    this.sessionActive = false;

    if (this.volumeTickId !== null) {
      clearInterval(this.volumeTickId);
      this.volumeTickId = null;
    }
    if (this.configPollId !== null) {
      clearInterval(this.configPollId);
      this.configPollId = null;
    }

    this.tracking?.stop();
    this.tracking = null;
    this.volumeClient = null;
    this.audio?.cleanup();
    this.signaling.leaveRoom();
    this.gameState.clearSession();
    this.session = null;
    this.peerStates.clear();
    this.localSummonerName = '';
    // Allow re-positioning on the next session
    this.lastOverlayBounds = null;
    this.lastOverlayRepositionTime = 0;

    // Hide the scanner window so it doesn't float wherever the minimap last was
    invoke('hide_scanner').catch(() => { /* non-fatal */ });

    // Notify overlay that session ended
    window.dispatchEvent(new CustomEvent('sessionEnded'));
  }
}
