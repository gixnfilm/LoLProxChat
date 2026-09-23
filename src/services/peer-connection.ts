import { getIceServers } from '../core/config';
import { MAX_TOTAL_GAIN } from './proximity-curve';
import { getForceTurnRelay } from './privacy';

// Time-based EMA on per-peer volume targets. Damps CV-jitter spikes without
// introducing audible ramp delay on normal updates. Two important properties:
//   • First call (prev == null) snaps to the new value so new peers don't
//     start playing at 1.0 before the proximity pipeline catches up.
//   • Alpha is capped at 0.3 so even a long gap between updates (e.g. a peer
//     re-entering hearing range after going far away) ramps over multiple
//     ticks instead of snapping to a loud value. At the 10 Hz positionTick
//     cadence the smoother reaches ~95% of target in about a second.
// Targets are clamped to [0, MAX_TOTAL_GAIN] rather than [0, 1]: playback runs
// through a GainNode that can amplify past unity (see applyGain).
// Exported so tests can verify the math without a real RTCPeerConnection.
export function nextSmoothedVolume(
  prev: number | null,
  target: number,
  nowMs: number,
  lastUpdateMs: number,
): number {
  const clamped = Number.isFinite(target)
    ? Math.max(0, Math.min(MAX_TOTAL_GAIN, target))
    : 0;
  if (prev === null) return clamped;
  const dtSec = (nowMs - lastUpdateMs) / 1000;
  const alpha = Math.min(0.3, 1 - Math.exp(-dtSec / 0.3));
  return prev * (1 - alpha) + clamped * alpha;
}


/**
 * Render an ICE candidate as `type addr:port proto` for diagnostic logs.
 * Parses the SDP "candidate:..." line because not every browser exposes the
 * convenience getters (.address, .type, etc.) on RTCIceCandidate.
 */
function describeCandidate(c: RTCIceCandidateInit | null): string {
  if (!c) return 'end-of-candidates';
  const cand = c.candidate || '';
  if (!cand) return 'end-of-candidates';
  const parts = cand.split(' ');
  // Format: "candidate:foundation component proto priority addr port typ TYPE ..."
  const proto = parts[2] || '?';
  const addr = parts[4] || '?';
  const port = parts[5] || '?';
  const typeIdx = parts.indexOf('typ');
  const type = typeIdx > 0 ? parts[typeIdx + 1] : '?';
  return `${type} ${addr}:${port} ${proto.toLowerCase()}`;
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteStream: MediaStream = new MediaStream();
  private audioElement: HTMLAudioElement;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  readonly remoteName: string;

  // Playback has two paths and exactly one of them is ever audible.
  //
  // • Graph path (default): remoteStream → sourceNode → gainNode → the shared
  //   master bus owned by AudioService. Only this path can exceed unity gain,
  //   which is the whole point — HTMLMediaElement.volume is hard-capped at 1.0,
  //   so on the element path a peer can never be louder than as-recorded. That
  //   cap is why distant enemies were inaudible (#21).
  // • Element path (fallback, Settings → Audio Boost OFF): the upstream
  //   behaviour, `audioElement.volume` carries the gain, capped at 1.0.
  //
  // The element stays attached either way — it keeps the remote track pulled
  // and is where autoplay unblocking happens — but on the graph path it is
  // muted AND volume-zeroed AND never written to again. A previous attempt at
  // a parallel WebAudio path played through both at once (echo + muddied
  // level, #19/#21) and was deleted wholesale in v0.5.3, taking the ability to
  // amplify with it. `usingGraph` is the single source of truth for which
  // path owns the level.
  // Default to silent. Volume is supposed to come from the proximity pipeline
  // (applyPeerVolumes → setVolume). If a peer connects before that pipeline
  // has produced a value for them (e.g. during tracking SCANNING state where
  // only allies get a volume), defaulting to 1.0 would play them at full
  // volume regardless of in-game distance — exactly the "hear across the
  // map at startup" bug reported on #6 / #7.
  private targetVolume = 0;
  private muted = false;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private pannerNode: StereoPannerNode | null = null;
  private reverbSend: GainNode | null = null;
  private graphCtx: AudioContext | null = null;
  private graphDestination: AudioNode | null = null;
  private graphReverb: AudioNode | null = null;
  private usingGraph = false;
  private targetPan = 0;
  private targetReverb = 0;
  // Outer-loop EMA on volume targets so brief CV tracking glitches don't
  // produce audible dropouts. null = first call (snap to value, no smoothing).
  private smoothedVolume: number | null = null;
  private lastSetVolumeMs = 0;

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  // Fired when ICE has fully failed. The audio layer is responsible for
  // re-issuing an offer (initiator side only) so we don't restart from both
  // ends and race. Capped retry counter lives here to avoid loops.
  onIceFailed: (() => void) | null = null;
  iceRestartAttempts = 0;
  static readonly MAX_ICE_RESTARTS = 2;

  private constructor(
    remoteName: string,
    iceServers: RTCIceServer[],
    iceTransportPolicy: RTCIceTransportPolicy = 'all',
  ) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    if (iceTransportPolicy === 'relay') {
      console.log('[WebRTC] Forcing TURN relay for', remoteName, '— no direct P2P candidates will be used');
    }
    this.audioElement = new Audio();
    this.audioElement.autoplay = true;
    this.audioElement.srcObject = this.remoteStream;
    // Start silent; the proximity pipeline (applyPeerVolumes → setVolume) sets
    // the real gain on whichever path is active (see field comment).
    this.audioElement.volume = 0;

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        console.log('[WebRTC] Local ICE → ' + remoteName + ':', describeCandidate(event.candidate.toJSON()));
        this.onIceCandidate(event.candidate);
      } else if (!event.candidate) {
        console.log('[WebRTC] Local ICE gathering complete for ' + remoteName);
      }
    };

    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track from', remoteName, 'kind:', event.track.kind);
      this.remoteStream.addTrack(event.track);
      // MediaStreamAudioSourceNode binds the stream's first audio track at
      // construction and does NOT follow tracks added later — so the graph can
      // only be built now, not when the peer object was created.
      this.connectGraph();
      // Ensure audio plays (autoplay may be blocked by Chromium policy)
      this.tryPlay();
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state with', remoteName, ':', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        // Successful (re)connect — reset the restart budget for any future failure.
        this.iceRestartAttempts = 0;
      }
      if (this.pc.connectionState === 'failed' &&
          this.iceRestartAttempts < PeerConnection.MAX_ICE_RESTARTS) {
        this.iceRestartAttempts++;
        console.warn('[WebRTC] Connection failed with', remoteName,
          '— triggering ICE restart attempt', this.iceRestartAttempts);
        this.onIceFailed?.();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state with', remoteName, ':', this.pc.iceConnectionState);
    };

    this.startStatsLogging();
  }

  static async create(remoteName: string): Promise<PeerConnection> {
    const iceServers = await getIceServers();
    const policy: RTCIceTransportPolicy = getForceTurnRelay() ? 'relay' : 'all';
    return new PeerConnection(remoteName, iceServers, policy);
  }

  /** Route this peer's audio to the chosen output device via the element sink. */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    const el = this.audioElement as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (!deviceId || typeof el.setSinkId !== 'function') return;
    try {
      await el.setSinkId(deviceId);
    } catch (e) {
      console.warn('[WebRTC] setSinkId failed for ' + this.remoteName + ':', e);
    }
  }

  /**
   * Hand this peer the shared playback bus. Safe to call before the remote
   * track arrives — the nodes are built in `ontrack` (see connectGraph).
   * Passing `null` tears the graph down and reverts to element playback.
   */
  setPlaybackGraph(
    ctx: AudioContext | null,
    destination: AudioNode | null,
    reverb: AudioNode | null = null,
  ): void {
    if (!ctx || !destination) {
      this.detachGraph();
      return;
    }
    if (this.graphCtx === ctx && this.graphDestination === destination &&
        this.graphReverb === reverb) return;
    this.detachGraph();
    this.graphCtx = ctx;
    this.graphDestination = destination;
    this.graphReverb = reverb;
    this.connectGraph();
  }

  private connectGraph(): void {
    if (this.usingGraph || !this.graphCtx || !this.graphDestination) return;
    if (this.remoteStream.getAudioTracks().length === 0) return;
    try {
      this.sourceNode = this.graphCtx.createMediaStreamSource(this.remoteStream);
      this.gainNode = this.graphCtx.createGain();
      this.gainNode.gain.value = 0;
      // Panner sits AFTER the gain so applyGain and MAX_TOTAL_GAIN keep working
      // untouched, and the master-bus compressor sees the already-panned
      // signal rather than a centred one it would then squash asymmetrically.
      this.pannerNode = this.graphCtx.createStereoPanner();
      this.pannerNode.pan.value = this.targetPan;
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.pannerNode);
      this.pannerNode.connect(this.graphDestination);
      if (this.graphReverb) {
        // Fed post-pan so the reverb tail is positioned too, and post-gain so
        // it follows distance and mute without extra bookkeeping.
        this.reverbSend = this.graphCtx.createGain();
        this.reverbSend.gain.value = 0;
        this.pannerNode.connect(this.reverbSend);
        this.reverbSend.connect(this.graphReverb);
      }
      this.usingGraph = true;
      // Hand the level over to the gain node and keep the element permanently
      // silent — belt and braces, because a single audible element here is the
      // v0.5.3 double-playback regression.
      this.audioElement.muted = true;
      this.audioElement.volume = 0;
      console.log('[WebRTC] WebAudio playback graph attached for', this.remoteName);
      this.applyGain(this.muted ? 0 : this.targetVolume);
    } catch (e) {
      console.warn('[WebRTC] WebAudio graph attach failed for', this.remoteName,
        '— falling back to element playback:', e);
      this.teardownNodes();
      this.usingGraph = false;
      if (!this.muted) this.audioElement.muted = false;
      this.applyGain(this.muted ? 0 : this.targetVolume);
    }
  }

  private teardownNodes(): void {
    try { this.sourceNode?.disconnect(); } catch { /* already gone */ }
    try { this.gainNode?.disconnect(); } catch { /* already gone */ }
    try { this.pannerNode?.disconnect(); } catch { /* already gone */ }
    try { this.reverbSend?.disconnect(); } catch { /* already gone */ }
    this.sourceNode = null;
    this.gainNode = null;
    this.pannerNode = null;
    this.reverbSend = null;
  }

  /**
   * Where this voice sits in the stereo field, -1 (left) to +1 (right).
   * Ramped rather than set, so a peer crossing in front of you glides instead
   * of snapping — and so a brief mis-attribution never produces a click.
   */
  setPan(pan: number): void {
    const v = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
    this.targetPan = v;
    if (!this.pannerNode || !this.graphCtx) return;
    try {
      this.pannerNode.pan.setTargetAtTime(v, this.graphCtx.currentTime, 0.12);
    } catch {
      this.pannerNode.pan.value = v;
    }
  }

  /** How much of this voice is sent to the shared environment reverb, 0..1. */
  setReverbSend(amount: number): void {
    const v = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.targetReverb = v;
    if (!this.reverbSend || !this.graphCtx) return;
    try {
      // Slower than the pan: walking in and out of the river should feel like
      // a change of room, not a switch being flipped.
      this.reverbSend.gain.setTargetAtTime(v, this.graphCtx.currentTime, 0.4);
    } catch {
      this.reverbSend.gain.value = v;
    }
  }

  private detachGraph(): void {
    if (!this.graphCtx && !this.usingGraph) return;
    this.teardownNodes();
    this.graphCtx = null;
    this.graphDestination = null;
    this.graphReverb = null;
    this.usingGraph = false;
    this.audioElement.muted = this.muted;
    this.applyGain(this.muted ? 0 : this.targetVolume);
  }

  /** True while the WebAudio path owns the level (i.e. gain can exceed 1.0). */
  isUsingGraph(): boolean {
    return this.usingGraph;
  }

  private applyGain(value: number, tauSec = 0.08): void {
    const v = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (this.usingGraph && this.gainNode && this.graphCtx) {
      const g = Math.min(MAX_TOTAL_GAIN, v);
      try {
        // Ramp in the audio thread. The 10 Hz EMA only moves the *target*;
        // setTargetAtTime turns each step into a continuous glide, so the
        // staircase of discrete element.volume writes is gone.
        this.gainNode.gain.setTargetAtTime(g, this.graphCtx.currentTime, tauSec);
      } catch {
        this.gainNode.gain.value = g;
      }
      return;
    }
    // Element path — hard-capped at unity by the media element itself.
    this.audioElement.volume = Math.min(1, v);
  }

  private tryPlay(): void {
    this.audioElement.play().catch((err) => {
      // Autoplay blocked by browser policy — retry on next user gesture.
      // Log explicitly so a user reporting "voice doesn't work" with Debug on
      // can be told to click anywhere in the overlay to unblock playback.
      console.warn('[WebRTC] Autoplay blocked for', this.remoteName,
        '— will retry on next user gesture:', err?.name || err);
      const resume = () => {
        this.audioElement.play().catch((retryErr) => {
          console.warn('[WebRTC] Autoplay retry still blocked for', this.remoteName, ':',
            retryErr?.name || retryErr);
        });
        document.removeEventListener('click', resume);
        document.removeEventListener('keydown', resume);
      };
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    });
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer(options?: { iceRestart?: boolean }): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer(options);
    offer.sdp = this.enhanceOpusSdp(offer.sdp || '');
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.enhanceOpusSdp(answer.sdp || '');
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Modify SDP to set Opus bitrate to 128kbps and disable DTX.
   * DTX (Discontinuous Transmission) stops sending packets during silence
   * to save bandwidth, but the ramp out of silence-mode at speech onset
   * clips the first packet or two — audible as missing word starts. The
   * bandwidth cost of always-on transmission is trivial for voice.
   */
  private enhanceOpusSdp(sdp: string): string {
    return sdp.replace(
      /a=fmtp:111 (.*)/g,
      (match, params) => {
        let enhanced = params;
        if (!enhanced.includes('maxaveragebitrate')) {
          enhanced += ';maxaveragebitrate=128000';
        }
        // Explicitly disable DTX so word starts/ends aren't clipped.
        if (!enhanced.includes('usedtx')) {
          enhanced += ';usedtx=0';
        }
        return 'a=fmtp:111 ' + enhanced;
      }
    );
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    console.log('[WebRTC] Remote ICE ← ' + this.remoteName + ':', describeCandidate(candidate));
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
  }

  /**
   * `immediate` bypasses the EMA for user-driven changes (the per-row slider).
   * Routing those through the smoother made the slider feel broken: dragging
   * fires ~60 events/sec, each with dt ≈ 16 ms → alpha ≈ 0.05, so the gain
   * crawled and never reached the slider's own value. Worse, every one of those
   * events overwrote `lastSetVolumeMs`, so the next proximity tick also saw a
   * tiny dt and a tiny alpha — responsiveness degraded *while* the user was
   * interacting with it. The immediate path deliberately leaves
   * `lastSetVolumeMs` alone so it can't poison the proximity cadence.
   */
  setVolume(volume: number, immediate = false): void {
    if (!Number.isFinite(volume)) return;
    if (immediate) {
      const v = Math.max(0, Math.min(MAX_TOTAL_GAIN, volume));
      this.smoothedVolume = v;
      this.targetVolume = v;
      if (!this.muted) this.applyGain(v, 0.02);
      return;
    }
    const now = performance.now();
    this.smoothedVolume = nextSmoothedVolume(this.smoothedVolume, volume, now, this.lastSetVolumeMs);
    this.lastSetVolumeMs = now;
    this.targetVolume = this.smoothedVolume;
    if (!this.muted) this.applyGain(this.smoothedVolume);
  }

  mute(): void {
    if (this.muted) return;
    this.muted = true;
    this.audioElement.muted = true;
    if (this.usingGraph) this.applyGain(0);
  }

  unmute(): void {
    if (!this.muted) return;
    this.muted = false;
    // On the graph path the element must stay muted forever — it is a silent
    // keep-alive sink, and un-muting it is exactly the double-playback bug.
    if (!this.usingGraph) this.audioElement.muted = false;
    this.applyGain(this.targetVolume);
  }

  close(): void {
    if (this.statsIntervalId !== null) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
    }
    this.teardownNodes();
    this.graphCtx = null;
    this.graphDestination = null;
    this.graphReverb = null;
    this.usingGraph = false;
    this.remoteStream.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
  }

  // Periodic getStats snapshot — selected candidate pair, RTT, bytes flowing.
  // Logged via the standard console.log path which is gated by Debug toggle.
  // Without these, ICE failures are opaque (we only see "failed" with no
  // context about which pair was tried or what the RTT looked like).
  private statsIntervalId: number | null = null;
  private startStatsLogging(): void {
    this.statsIntervalId = window.setInterval(() => {
      this.logStatsSnapshot().catch(() => { /* non-fatal */ });
    }, 10_000) as unknown as number;
  }

  private async logStatsSnapshot(): Promise<void> {
    const stats = await this.pc.getStats();
    let pair: any = null;
    let outAudio: any = null;
    let inAudio: any = null;
    const byId = new Map<string, any>();
    stats.forEach((r: any) => {
      byId.set(r.id, r);
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') outAudio = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inAudio = r;
    });
    const parts: string[] = [
      'conn=' + this.pc.connectionState,
      'ice=' + this.pc.iceConnectionState,
    ];
    if (pair) {
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      const fmt = (c: any) => c ? `${c.candidateType}:${c.address || c.ip || '?'}:${c.port || '?'}/${c.protocol || '?'}` : '?';
      parts.push('pair=' + fmt(local) + '<->' + fmt(remote));
      if (typeof pair.currentRoundTripTime === 'number') {
        parts.push('rtt=' + Math.round(pair.currentRoundTripTime * 1000) + 'ms');
      }
    } else {
      parts.push('pair=none');
    }
    if (outAudio) parts.push('outBytes=' + outAudio.bytesSent);
    if (inAudio) parts.push('inBytes=' + inAudio.bytesReceived);
    if (inAudio && typeof inAudio.packetsLost === 'number') parts.push('lost=' + inAudio.packetsLost);
    console.log('[WebRTC stats]', this.remoteName, parts.join(' '));
  }
}
