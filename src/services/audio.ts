import { PeerConnection } from './peer-connection';
import { SignalingService, SignalMessage } from './signaling';
import { AudioSettings } from '../core/types';
import { getStoredInputDeviceId, getStoredOutputDeviceId } from './devices';
import {
  AudioPrefs, getAudioPrefs, getPlayerVolumes, setStoredPlayerVolume,
  curveFor, groupGainFor,
} from './audio-prefs';
import { resolvePeerLevel, computeFinalPeerVolume, TickSample } from './proximity-curve';
import { panFor } from './peer-locator';
import { Position } from '../core/types';

export { computeFinalPeerVolume };

/** Which side of the scoreboard a peer is on, for the Team / Enemy gains. */
export type PeerSide = 'ally' | 'enemy';

function peakRms(buf: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    sumSq += buf[i] * buf[i];
  }
  return Math.sqrt(sumSq / buf.length);
}

// How long to keep a peer at its last level after it drops out of the server
// response before letting it fall away. Covers a dropped coords packet or two
// on a lossy / DPI-bypass connection so the audio doesn't blip and back (#27).
const PROXIMITY_GRACE_MS = 1500;

// How long a teammate keeps their last level on ticks that never reached the
// server at all (our own tracking lost us). Longer than the grace window on
// purpose: here the missing information is OUR position, not theirs, so their
// last known level stays the best estimate for a while. Every death puts the
// local client into this state, and ducking the whole team on every death is
// worse than holding a slightly stale level.
const ALLY_NO_DATA_HOLD_MS = 5000;

/**
 * How much of a voice is sent to the environment reverb when the speaker is
 * standing somewhere reverberant. Deliberately subtle — the ask was "a little
 * reverb in the river", and a positional cue that swamps intelligibility
 * defeats the point of a voice chat.
 */
const REVERB_SEND = 0.22;

/**
 * A synthetic impulse response: exponentially decaying stereo noise.
 *
 * Generated rather than shipped as a file — a real room recording would be a
 * licensing question and a download, and for a cue this subtle the difference
 * is inaudible. Slight left/right decorrelation keeps the tail from collapsing
 * to the centre and squashing the panning it is supposed to support.
 */
function buildReverbImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 1.2;
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const decay = Math.pow(1 - i / length, 2.5);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return buffer;
}

/** Per-peer volume bookkeeping. One entry, so the inputs can't drift apart. */
interface PeerVolumeState {
  /** Last value the SERVER actually returned (never a synthesised one). */
  lastServerVol?: number;
  /** Last shaped level applied, 0..1. Used to hold through a gap. */
  lastLevel?: number;
  /** performance.now() when the peer was last present in a server response. */
  seenAtMs?: number;
}

export class AudioService {
  private localStream: MediaStream | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private signaling: SignalingService;
  private localName: string;
  private selfMuted = false;
  private muteAll = false;
  private mutedPlayers: Set<string> = new Set();
  // Track last reported volume state per peer so we only log transitions
  private lastAppliedVolume: Map<string, string> = new Map();
  // Everything the level decision needs, per peer. Kept as one record rather
  // than parallel maps so a code path can't update half of it — the previous
  // split let a synthesised value be recorded as if the server had sent it.
  private peerVolumeState: Map<string, PeerVolumeState> = new Map();
  // Consecutive fresh responses in which every teammate came back at exactly
  // 1.00 — the fingerprint of a server that ignores allyProximity.
  private allyFlatOneTicks = 0;
  private allyProximityWarned = false;
  // Throttling state for the verbose applyPeerVolumes snapshot log
  private lastVolumeLogLine = '';
  private lastVolumeLogMs = 0;
  private settings: AudioSettings = {
    // Always-open by default. Push-to-talk is unbound by default (#27) and
    // bound in Settings; the real PTT keybind lives in the overlay (localStorage
    // `lolproxchat.pttVk`) + the Rust hook, not this (vestigial) field.
    inputMode: 'always',
    inputVolume: 1.0,
    pttKey: '',
    playerVolumes: {},
  };

  // Mixer preferences (master / team / enemy gains, falloff curve, boost
  // toggle). Read from localStorage at construction so a freshly built
  // AudioService — one is created per game — starts where the user left off
  // instead of silently reverting to defaults while the overlay still shows
  // the old slider positions.
  private prefs: AudioPrefs = getAudioPrefs();
  // summonerName → side, pushed by the orchestrator each tick. Needed because
  // /compute-volumes returns names only, but Team and Enemy have separate
  // gains. Unknown names are treated as allies: the SCANNING passthrough only
  // ever names teammates, and guessing "enemy" there would apply the (louder)
  // enemy gain to someone we know nothing about.
  private peerTeams: Map<string, PeerSide> = new Map();

  // Audio processing state
  private audioContext: AudioContext | null = null;
  // Playback graph, deliberately on its own AudioContext: the mic chain lives
  // on `audioContext` and is torn down / rebuilt on device switches, and a mic
  // failure must not take everyone's voice down with it.
  private playbackCtx: AudioContext | null = null;
  private playbackBus: GainNode | null = null;
  private playbackCompressor: DynamicsCompressorNode | null = null;
  private playbackReverb: ConvolverNode | null = null;
  private playbackReverbGain: GainNode | null = null;
  // Where each peer is, when we can see their icon. Absent = play them centred.
  private peerPositions: Map<string, Position> = new Map();
  private selfPosition: Position | null = null;
  // Which peers are standing somewhere reverberant (the river).
  private peerWet: Set<string> = new Set();
  private gainNode: GainNode | null = null;
  private outputStream: MediaStream | null = null;
  // Held so we can swap it when the user picks a different input device at
  // runtime without renegotiating WebRTC (the destination MediaStream that
  // PeerConnections received stays the same).
  private micSource: MediaStreamAudioSourceNode | null = null;

  // Guard against concurrent connectToPeer calls for the same peer
  private connectingPeers: Set<string> = new Set();
  // Buffer signals that arrive before the peer connection is created
  private pendingSignals: Map<string, SignalMessage[]> = new Map();

  // PTT state
  private pttHeld = false;

  constructor(signaling: SignalingService, localName: string) {
    this.signaling = signaling;
    this.localName = localName;
    this.settings.playerVolumes = getPlayerVolumes();
    this.settings.inputVolume = this.prefs.inputVolume;
  }

  /**
   * Lazily build the shared playback bus:
   *
   *     peer gain ─┐
   *     peer gain ─┼→ playbackBus → compressor → destination
   *     peer gain ─┘
   *
   * The compressor is not cosmetic. Per-peer gain can now exceed 1.0, and
   * several peers talking at once sum on this bus — without it, boosting
   * clips. It also lifts quiet passages, which is half the reason distant
   * enemies were hard to make out in the first place.
   *
   * Returns null when the boost path is disabled or unavailable, in which case
   * peers fall back to element playback (capped at unity).
   */
  private ensurePlaybackGraph(): GainNode | null {
    if (!this.prefs.audioBoost) return null;
    if (this.playbackBus) return this.playbackBus;
    try {
      const ctx = new AudioContext();
      const bus = ctx.createGain();
      bus.gain.value = 1.0;
      const comp = ctx.createDynamicsCompressor();
      const reverb = ctx.createConvolver();
      reverb.buffer = buildReverbImpulse(ctx);
      const reverbGain = ctx.createGain();
      reverbGain.gain.value = 1.0;
      reverb.connect(reverbGain);
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      bus.connect(comp);
      comp.connect(ctx.destination);
      // Wet path rejoins before the compressor so the tail is levelled with
      // everything else rather than riding on top of it.
      reverbGain.connect(bus);
      this.playbackCtx = ctx;
      this.playbackBus = bus;
      this.playbackCompressor = comp;
      this.playbackReverb = reverb;
      this.playbackReverbGain = reverbGain;
      void this.resumePlaybackContext();
      void this.applyPlaybackSink();
      console.log('[Audio] Playback graph created (boost path active)');
      return bus;
    } catch (e) {
      console.warn('[Audio] Playback graph unavailable — element playback only:', e);
      this.playbackCtx = null;
      this.playbackBus = null;
      this.playbackCompressor = null;
      this.playbackReverb = null;
      this.playbackReverbGain = null;
      return null;
    }
  }

  private async resumePlaybackContext(): Promise<void> {
    const ctx = this.playbackCtx;
    if (!ctx || ctx.state !== 'suspended') return;
    try {
      await ctx.resume();
    } catch (e) {
      console.warn('[Audio] Playback context resume failed:', e);
    }
  }

  /** Point the playback context at the user's chosen output device. */
  private async applyPlaybackSink(): Promise<void> {
    const ctx = this.playbackCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    const outputId = getStoredOutputDeviceId();
    if (!ctx || !outputId || typeof ctx.setSinkId !== 'function') return;
    try {
      await ctx.setSinkId(outputId);
      console.log('[Audio] Playback sink →', outputId);
    } catch (e) {
      console.warn('[Audio] Playback setSinkId failed:', e);
    }
  }

  private teardownPlaybackGraph(): void {
    for (const peer of this.peers.values()) peer.setPlaybackGraph(null, null);
    try { this.playbackCompressor?.disconnect(); } catch { /* already gone */ }
    try { this.playbackReverbGain?.disconnect(); } catch { /* already gone */ }
    try { this.playbackReverb?.disconnect(); } catch { /* already gone */ }
    try { this.playbackBus?.disconnect(); } catch { /* already gone */ }
    void this.playbackCtx?.close().catch(() => { /* already closed */ });
    this.playbackCtx = null;
    this.playbackBus = null;
    this.playbackCompressor = null;
    this.playbackReverb = null;
    this.playbackReverbGain = null;
  }

  /** Attach a peer to the boost path if it is enabled. */
  private attachPlayback(peer: PeerConnection): void {
    const bus = this.ensurePlaybackGraph();
    if (bus && this.playbackCtx) {
      peer.setPlaybackGraph(this.playbackCtx, bus, this.playbackReverb);
    }
  }

  /**
   * Tell the mixer where everyone is, from the icons visible on our own
   * minimap. Peers not in the map have no known position and are played
   * centred and dry — that is the honest answer when we cannot see them.
   */
  setPeerPositions(self: Position | null, positions: Map<string, Position>, wet: Set<string>): void {
    this.selfPosition = self;
    this.peerPositions = positions;
    this.peerWet = wet;
  }

  async initMicrophone(): Promise<void> {
    this.localStream = await this.acquireMicStream();

    this.audioContext = new AudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    // Honor stored output-device pick if AudioContext.setSinkId is available
    // (Chromium 110+, which WebView2 evergreen ships).
    await this.applyStoredOutputDevice();

    this.micSource = this.audioContext.createMediaStreamSource(this.localStream);
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.settings.inputVolume;
    const destination = this.audioContext.createMediaStreamDestination();

    // Simple straight-through chain: mic → gain → destination. Noise
    // suppression is handled by the browser's native DSP (set via the
    // getUserMedia constraints above) which runs off the JS main thread.
    this.micSource.connect(this.gainNode);
    this.gainNode.connect(destination);
    console.log('[Audio] Using native browser noise suppression');

    this.outputStream = destination.stream;
    // Apply initial transmit state through the normal path so the first
    // [Audio] Local mic transmit log line is emitted.
    this.updateLocalTrackState();

    // Attach analysers to monitor whether the mic is actually producing audio
    // and whether the WebRTC-output stream contains audio. Reported every 2s.
    this.startAudioLevelMonitor(this.micSource, destination);
  }

  private micLevelAnalyser: AnalyserNode | null = null;
  private outputLevelAnalyser: AnalyserNode | null = null;
  private levelMonitorId: number | null = null;

  private startAudioLevelMonitor(
    micSource: MediaStreamAudioSourceNode,
    outputDest: MediaStreamAudioDestinationNode,
  ): void {
    if (!this.audioContext) return;
    this.micLevelAnalyser = this.audioContext.createAnalyser();
    this.micLevelAnalyser.fftSize = 1024;
    micSource.connect(this.micLevelAnalyser);

    // The destination node is a sink — to monitor its output we need to
    // re-source from its stream via a second source node.
    const outSource = this.audioContext.createMediaStreamSource(outputDest.stream);
    this.outputLevelAnalyser = this.audioContext.createAnalyser();
    this.outputLevelAnalyser.fftSize = 1024;
    outSource.connect(this.outputLevelAnalyser);

    const micBuf = new Float32Array(this.micLevelAnalyser.fftSize);
    const outBuf = new Float32Array(this.outputLevelAnalyser.fftSize);

    this.levelMonitorId = window.setInterval(() => {
      if (!this.micLevelAnalyser || !this.outputLevelAnalyser) return;
      this.micLevelAnalyser.getFloatTimeDomainData(micBuf);
      this.outputLevelAnalyser.getFloatTimeDomainData(outBuf);
      const micPeak = peakRms(micBuf);
      const outPeak = peakRms(outBuf);
      const transmitting = !this.selfMuted && this.isTransmitting();
      console.log(
        '[Audio] mic=' + micPeak.toFixed(3) +
        ' out=' + outPeak.toFixed(3) +
        ' transmit=' + transmitting +
        ' inputMode=' + this.settings.inputMode +
        ' selfMuted=' + this.selfMuted,
      );
    }, 2000) as unknown as number;
  }

  private isTransmitting(): boolean {
    if (this.selfMuted) return false;
    if (this.settings.inputMode === 'ptt') return this.pttHeld;
    // 'always' (default) — transmit unless muted
    return true;
  }

  setPTTState(held: boolean): void {
    console.log('[Audio] setPTTState(' + held + '), inputMode=' + this.settings.inputMode);
    this.pttHeld = held;
    this.updateLocalTrackState();
  }

  private lastTrackEnabled: boolean | null = null;
  private updateLocalTrackState(): void {
    if (!this.outputStream) return;
    const enabled = !this.selfMuted && this.isTransmitting();
    for (const track of this.outputStream.getAudioTracks()) {
      track.enabled = enabled;
    }
    if (enabled !== this.lastTrackEnabled) {
      this.lastTrackEnabled = enabled;
      const reason = this.selfMuted
        ? 'selfMuted'
        : this.settings.inputMode === 'ptt'
          ? 'ptt=' + this.pttHeld
          : 'always-open';
      console.log('[Audio] Local mic transmit → ' + enabled + ' (' + reason + ')');
    }
  }

  // Connect to a new peer
  async connectToPeer(remoteName: string, isInitiator?: boolean): Promise<void> {
    if (this.peers.has(remoteName) || this.connectingPeers.has(remoteName)) return;
    this.connectingPeers.add(remoteName);

    console.log('[Audio] Connecting to peer:', remoteName);
    let peer: PeerConnection;
    try {
      peer = await PeerConnection.create(remoteName);
      void peer.setOutputDevice(getStoredOutputDeviceId());
      this.attachPlayback(peer);
    } catch (e) {
      this.connectingPeers.delete(remoteName);
      throw e;
    }
    this.peers.set(remoteName, peer);
    this.connectingPeers.delete(remoteName);

    if (this.outputStream) {
      peer.addLocalStream(this.outputStream);
    }

    peer.onIceCandidate = (candidate) => {
      this.signaling.sendSignal({
        type: 'ice-candidate',
        from: this.localName,
        to: remoteName,
        payload: candidate.toJSON(),
      });
    };

    // Initiator creates data channel + offer
    const shouldInitiate = isInitiator ?? (this.localName < remoteName);

    // Auto-recover from ICE failure. Only the original initiator re-issues
    // the offer (with iceRestart=true) so we don't both restart and race.
    // The other side just handles the incoming offer via the normal flow.
    if (shouldInitiate) {
      peer.onIceFailed = () => {
        peer.createOffer({ iceRestart: true })
          .then((offer) => {
            console.log('[Audio] Sending ICE-restart offer to:', remoteName);
            this.signaling.sendSignal({
              type: 'offer',
              from: this.localName,
              to: remoteName,
              payload: offer,
            });
          })
          .catch((e) => console.warn('[Audio] ICE-restart offer failed for', remoteName, e));
      };
    }

    if (shouldInitiate) {
      console.log('[Audio] Creating offer (initiator) to:', remoteName);
      try {
        const offer = await peer.createOffer();
        this.signaling.sendSignal({
          type: 'offer',
          from: this.localName,
          to: remoteName,
          payload: offer,
        });
      } catch (e) {
        console.error('[Audio] Failed to create offer for:', remoteName, e);
        this.peers.delete(remoteName);
        peer.close();
      }
    }

    // Flush any signals that arrived before this peer was created
    const pending = this.pendingSignals.get(remoteName);
    if (pending) {
      this.pendingSignals.delete(remoteName);
      for (const sig of pending) {
        this.handleSignal(sig).catch(e =>
          console.error('[Audio] Failed to replay buffered signal:', sig.type, e));
      }
    }
  }

  // Handle incoming WebRTC signals
  async handleSignal(signal: SignalMessage): Promise<void> {
    console.log('[Audio] Received signal:', signal.type, 'from:', signal.from);
    try {
      let peer = this.peers.get(signal.from);

      if (signal.type === 'offer') {
        if (!peer) {
          // Peer is reaching us first via the signaling channel — orchestrator's
          // "Peer joined" log only fires once their first position broadcast
          // arrives, which can be seconds later (or never if they're idle in
          // base). Log here so the join is always traceable in diagnostics.
          console.log('[Audio] Peer created via incoming offer: ' + signal.from);
          peer = await PeerConnection.create(signal.from);
          void peer.setOutputDevice(getStoredOutputDeviceId());
          this.attachPlayback(peer);
          this.peers.set(signal.from, peer);
          if (this.outputStream) peer.addLocalStream(this.outputStream);

          peer.onIceCandidate = (candidate) => {
            this.signaling.sendSignal({
              type: 'ice-candidate',
              from: this.localName,
              to: signal.from,
              payload: candidate.toJSON(),
            });
          };
        }
        const answer = await peer.handleOffer(signal.payload);
        this.signaling.sendSignal({
          type: 'answer',
          from: this.localName,
          to: signal.from,
          payload: answer,
        });
      } else if (signal.type === 'answer' && peer) {
        await peer.handleAnswer(signal.payload);
      } else if (signal.type === 'ice-candidate' && peer) {
        await peer.addIceCandidate(signal.payload);
      } else if (!peer && (signal.type === 'answer' || signal.type === 'ice-candidate')) {
        // Buffer signals that arrive before the peer connection is created
        let pending = this.pendingSignals.get(signal.from);
        if (!pending) {
          pending = [];
          this.pendingSignals.set(signal.from, pending);
        }
        pending.push(signal);
      }
    } catch (e) {
      console.error('[Audio] Signal handling failed:', signal.type, 'from:', signal.from, e);
    }
  }

  disconnectPeer(remoteName: string): void {
    const peer = this.peers.get(remoteName);
    if (peer) {
      peer.close();
      this.peers.delete(remoteName);
    }
    // Drop the per-peer proximity bookkeeping too. Leaving it behind let a
    // reconnecting peer inherit a stale gain via setPlayerVolume before the
    // first fresh /compute-volumes tick landed.
    this.peerVolumeState.delete(remoteName);
    this.lastAppliedVolume.delete(remoteName);
  }

  /** Tell the mixer which side each peer is on (drives Team vs Enemy gain). */
  setPeerTeams(teams: Map<string, PeerSide>): void {
    this.peerTeams = teams;
  }

  /** Current mixer prefs (the overlay reads these back for its sliders). */
  getAudioPrefs(): AudioPrefs {
    return this.prefs;
  }

  /**
   * Apply a new set of mixer prefs. Caller owns persistence; this only moves
   * the running engine. Re-applies every peer's gain immediately so a slider
   * drag is audible now rather than at the next 100 ms tick.
   */
  applyAudioPrefs(prefs: AudioPrefs): void {
    const boostChanged = prefs.audioBoost !== this.prefs.audioBoost;
    this.prefs = prefs;
    this.settings.inputVolume = prefs.inputVolume;
    this.applyInputVolume();

    if (boostChanged) {
      if (prefs.audioBoost) {
        for (const peer of this.peers.values()) this.attachPlayback(peer);
      } else {
        this.teardownPlaybackGraph();
      }
      console.log('[Audio] Audio boost →', prefs.audioBoost ? 'ON (WebAudio)' : 'OFF (element)');
    }
    this.refreshPeerVolumes();
  }

  /**
   * Re-apply every connected peer's gain after a prefs change, by re-running
   * the same decision on the cached inputs.
   *
   * Deliberately replays the stored inputs rather than a stored output: a
   * gain/curve change has to re-shape from the raw server value, and a peer
   * that has no server value yet must not be silently treated as "proximity 0"
   * — that would duck every teammate to silence on a slider drag while
   * tracking is still scanning.
   */
  private refreshPeerVolumes(): void {
    const now = performance.now();
    for (const name of this.peers.keys()) {
      this.applyLevelFor(name, { kind: 'no-data' }, now, true);
    }
  }

  private isAlly(name: string): boolean {
    return this.peerTeams.get(name) !== 'enemy';
  }

  /** Shaped level (0..1) → actual playback gain, for one peer. */
  private finalFromShaped(name: string, shaped: number, isAlly: boolean): number {
    const trim = this.settings.playerVolumes[name] ?? 1.0;
    return computeFinalPeerVolume(
      shaped, trim, groupGainFor(this.prefs, isAlly), this.prefs.masterVolume,
    );
  }

  /**
   * Decide and apply one peer's level for this tick, and record what was
   * applied. Returns the final gain (for logging).
   */
  private applyLevelFor(
    name: string, tick: TickSample, now: number, immediate = false,
  ): number {
    const st = this.peerVolumeState.get(name);
    const isAlly = this.isAlly(name);
    const shaped = resolvePeerLevel({
      tick,
      isAlly,
      curve: curveFor(this.prefs, isAlly),
      lastLevel: st?.lastLevel,
      msSinceSeen: st?.seenAtMs === undefined ? undefined : now - st.seenAtMs,
      graceMs: PROXIMITY_GRACE_MS,
      allyHoldMs: ALLY_NO_DATA_HOLD_MS,
    });
    const next: PeerVolumeState = { ...(st ?? {}), lastLevel: shaped };
    this.peerVolumeState.set(name, next);

    const finalVol = this.finalFromShaped(name, shaped, isAlly);
    const peer = this.peers.get(name);
    peer?.setVolume(finalVol, immediate);
    if (peer) {
      const pos = this.peerPositions.get(name);
      peer.setPan(this.selfPosition ? panFor(this.selfPosition, pos, this.prefs.stereoWidth) : 0);
      peer.setReverbSend(this.prefs.reverb && pos && this.peerWet.has(name) ? REVERB_SEND : 0);
    }
    return finalVol;
  }

  /**
   * Apply one tick's worth of peer levels.
   *
   * `volumes === null` means this tick never reached the server — our own
   * position is unknown (tracking scanning / holding / lost) or the request
   * failed. That is a genuinely different situation from "the server answered
   * and this peer wasn't in it", and conflating the two is what pinned
   * teammates at full volume: the fallback path used to synthesise 1.0 for
   * every ally and feed it in here, where it was indistinguishable from a real
   * response — so it refreshed the grace window and was cached as if the
   * server had said it, then held forever by the next fallback tick.
   *
   * On a null tick nothing is stamped and nothing is cached as server data.
   */
  applyPeerVolumes(volumes: Record<string, number> | null): void {
    const now = performance.now();
    const fresh = volumes !== null;

    // Drop anything non-numeric before it reaches the maths. The response is
    // parsed from JSON, and a single null / string entry used to throw here
    // (.toFixed) and take the whole tick — every peer's gain with it.
    const entries = fresh
      ? Object.entries(volumes).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      : [];
    const clean: Record<string, number> = Object.fromEntries(entries);

    if (fresh) {
      // Only a real response updates "when did we last hear about this peer"
      // and the raw server value. Both feed the grace window and the prefs
      // replay, and both must reflect the server, not us.
      for (const [name, vol] of entries) {
        const st = this.peerVolumeState.get(name) ?? {};
        st.lastServerVol = vol;
        st.seenAtMs = now;
        this.peerVolumeState.set(name, st);
      }
      this.noteAllyProximityHealth(entries);
    }

    this.logVolumeSnapshot(fresh, entries, now);

    // Every connected peer gets a decision every tick — including the ones
    // absent from the response, which is how a peer that walked out of range
    // is silenced instead of sticking at its last gain.
    for (const name of this.peers.keys()) {
      const tick: TickSample = !fresh
        ? { kind: 'no-data' }
        : Object.prototype.hasOwnProperty.call(clean, name)
          ? { kind: 'server', vol: clean[name] }
          : { kind: 'absent' };

      const wasState = this.lastAppliedVolume.get(name);
      // Don't hard-mute on 0 — the smoothed gain ramp handles it without a
      // click and lets brief proximity zeros fade gracefully.
      const finalVol = this.applyLevelFor(name, tick, now);

      const peer = this.peers.get(name)!;
      const muteNow = this.muteAll || this.mutedPlayers.has(name);
      if (muteNow) peer.mute();
      else peer.unmute();

      const stateNow = muteNow ? 'silent' : finalVol.toFixed(2);
      if (wasState !== stateNow) {
        console.log('[Audio] peer ' + name + ' → ' + stateNow +
          (wasState !== undefined ? ' (was ' + wasState + ')' : ''));
        this.lastAppliedVolume.set(name, stateNow);
      }
    }
  }

  /**
   * Verbose snapshot of the tick. Silent unless Debug is on (console.log is
   * no-op'd by core/logging.ts) and throttled to ≥1 s or a change, so an
   * active session doesn't drown the log at 10 lines/sec.
   *
   * Carries the proximity mode and whether the tick reached the server at all,
   * because "teammates are always loud" has three different causes and this
   * line is what tells them apart.
   */
  private logVolumeSnapshot(fresh: boolean, entries: [string, number][], now: number): void {
    const summary = entries.length
      ? entries.map(([n, v]) => `${n}=${v.toFixed(2)}`).join(' ')
      : '(none)';
    const skipped = entries.filter(([n]) => !this.peers.has(n)).map(([n]) => n);
    const skippedTag = skipped.length ? ` (skipped no-peer: ${skipped.join(',')})` : '';
    const source = fresh ? 'server' : 'NO-SERVER-DATA';
    const fullLine = `[${source} mode=${this.prefs.proximityMode}] ${summary}${skippedTag}`;
    if (fullLine !== this.lastVolumeLogLine || now - this.lastVolumeLogMs >= 1000) {
      console.log('[Audio] applyPeerVolumes:', fullLine);
      this.lastVolumeLogLine = fullLine;
      this.lastVolumeLogMs = now;
    }
  }

  /**
   * Warn once if the server looks like it is ignoring `allyProximity`.
   *
   * Fingerprint: in ALL mode an honouring server subjects teammates to the
   * same range and staleness rules as everyone else, so they must *sometimes*
   * be absent or below 1.0. A teammate that is present in every single
   * response at exactly 1.0 for a long stretch means the flag isn't being
   * honoured — which is unfixable client-side (a 1.0 carries no distance), so
   * it deserves to be said out loud rather than looking like a client bug.
   */
  private noteAllyProximityHealth(entries: [string, number][]): void {
    if (this.allyProximityWarned || this.prefs.proximityMode !== 'all') return;
    const allies = entries.filter(([name]) => this.isAlly(name));
    if (!allies.length) return;
    if (allies.every(([, v]) => v === 1)) {
      this.allyFlatOneTicks++;
      // ~30 s at the 10 Hz position tick.
      if (this.allyFlatOneTicks >= 300) {
        this.allyProximityWarned = true;
        console.warn('[Audio] Ally proximity looks unsupported by the server: ' +
          'every teammate has been present at exactly 1.00 for ~30s while ' +
          'Proximity=ALL. The client cannot derive distance from 1.0.');
      }
    } else {
      this.allyFlatOneTicks = 0;
    }
  }

  // Mute controls
  toggleSelfMute(): boolean {
    this.setSelfMuted(!this.selfMuted);
    return this.selfMuted;
  }

  setSelfMuted(value: boolean): void {
    if (this.selfMuted === value) return;
    this.selfMuted = value;
    this.updateLocalTrackState();
  }

  toggleMuteAll(): boolean {
    this.setMuteAll(!this.muteAll);
    return this.muteAll;
  }

  setMuteAll(value: boolean): void {
    if (this.muteAll === value) return;
    this.muteAll = value;
    for (const [name, peer] of this.peers) {
      if (this.muteAll || this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
  }

  toggleMutePlayer(name: string): boolean {
    if (this.mutedPlayers.has(name)) {
      this.mutedPlayers.delete(name);
    } else {
      this.mutedPlayers.add(name);
    }
    const peer = this.peers.get(name);
    if (peer) {
      if (this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
    return this.mutedPlayers.has(name);
  }

  setPlayerVolume(name: string, volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.settings.playerVolumes[name] = Math.max(0, Math.min(1, volume));
    setStoredPlayerVolume(name, this.settings.playerVolumes[name]);
    if (this.peers.has(name)) {
      // Re-run the normal decision on the cached inputs rather than assuming
      // anything about proximity. A hardcoded 1.0 here briefly played the peer
      // at slider-value × full volume before the next tick corrected it
      // (issue #7); a hardcoded 0 would duck a teammate to silence whenever no
      // server value has arrived yet. `immediate` keeps the drag out of the
      // proximity EMA (see PeerConnection.setVolume).
      this.applyLevelFor(name, { kind: 'no-data' }, performance.now(), true);
    }
  }

  isSelfMuted(): boolean { return this.selfMuted; }
  isMuteAll(): boolean { return this.muteAll; }
  isPlayerMuted(name: string): boolean { return this.mutedPlayers.has(name); }

  getPeer(name: string): PeerConnection | undefined {
    return this.peers.get(name);
  }

  hasPeer(name: string): boolean {
    return this.peers.has(name);
  }

  updateSettings(settings: Partial<AudioSettings>): void {
    Object.assign(this.settings, settings);
    this.applyInputVolume();
    this.updateLocalTrackState();
  }

  private applyInputVolume(): void {
    if (!this.gainNode) return;
    // updateSettings takes `any` all the way from the overlay bus, and an
    // empty slider field parses to NaN. Assigning NaN to an AudioParam throws
    // and kills the whole mic chain, so clamp before it gets there. The short
    // ramp replaces a raw `.value =` write, which zipper-noised on drag.
    const raw = this.settings.inputVolume;
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
    this.settings.inputVolume = v;
    const ctx = this.audioContext;
    if (ctx) {
      try {
        this.gainNode.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
        return;
      } catch { /* fall through to a direct write */ }
    }
    this.gainNode.gain.value = v;
  }

  private async acquireMicStream(): Promise<MediaStream> {
    const inputId = getStoredInputDeviceId();
    const constraints: MediaTrackConstraints = {
      // Native Chromium DSP runs in the audio thread — can't be starved by
      // our main-thread CV work the way RNNoise's ScriptProcessorNode was.
      // Quality is the WebRTC NS3 algorithm Discord used pre-Krisp.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (inputId) constraints.deviceId = { exact: inputId };
    return navigator.mediaDevices.getUserMedia({ audio: constraints });
  }

  private async applyStoredOutputDevice(): Promise<void> {
    const outputId = getStoredOutputDeviceId();
    if (!outputId) return;
    // Two sinks to move: the playback context (boost path) and each peer's
    // element (fallback path). Setting both keeps the device correct
    // regardless of which path is live, and costs nothing when one is idle.
    await this.applyPlaybackSink();
    for (const peer of this.peers.values()) {
      await peer.setOutputDevice(outputId);
    }
    console.log('[Audio] Output device applied to', this.peers.size, 'peer(s):', outputId);
  }

  // Re-acquire mic from the new device, swap the source node in place.
  // outputStream / destination stay the same so peer connections keep
  // working without renegotiation.
  async applyInputDevice(_id: string | null): Promise<void> {
    if (!this.audioContext || !this.gainNode) {
      console.log('[Audio] applyInputDevice: not initialized yet, will pick up on next session');
      return;
    }
    try {
      const newStream = await this.acquireMicStream();
      this.micSource?.disconnect();
      this.localStream?.getTracks().forEach((t) => t.stop());
      this.localStream = newStream;
      this.micSource = this.audioContext.createMediaStreamSource(newStream);
      this.micSource.connect(this.gainNode);
      this.updateLocalTrackState();
      console.log('[Audio] Input device switched');
    } catch (e) {
      console.warn('[Audio] applyInputDevice failed:', e);
    }
  }

  async applyOutputDevice(_id: string | null): Promise<void> {
    await this.applyStoredOutputDevice();
  }

  cleanup(): void {
    for (const [, peer] of this.peers) {
      peer.close();
    }
    this.peers.clear();
    this.outputStream?.getTracks().forEach((t) => t.stop());
    this.outputStream = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.teardownPlaybackGraph();
  }
}
