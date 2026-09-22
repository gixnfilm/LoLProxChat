import { WS_URL } from '../core/config';

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

export interface SignalMessage {
  type: SignalType;
  from: string;
  to: string;
  payload: any;
}

export interface PositionBroadcast {
  summonerName: string;
  championName: string;
  team: string;
  isMuted: boolean;
  isDead: boolean;
}

type OnPeerPosition = (peer: PositionBroadcast) => void;
type OnSignal = (signal: SignalMessage) => void;
type OnPeerLeave = (summonerName: string) => void;
type OnPeerJoined = (name: string) => void;

export class SignalingService {
  private ws: WebSocket | null = null;
  private localName: string = '';
  // Saved so reconnect can rejoin the same room with the same identity
  private currentRoomId: string | null = null;
  // v0.3: team is fixed for the session (sent on join) and used by the server
  // for team-aware proximity.
  private currentTeam: 'ORDER' | 'CHAOS' | null = null;
  private currentHandlers: {
    onPeerPosition: OnPeerPosition;
    onSignal: OnSignal;
    onPeerLeave: OnPeerLeave;
    onPeerJoined?: OnPeerJoined;
  } | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  joinRoom(
    roomId: string,
    localName: string,
    team: 'ORDER' | 'CHAOS',
    onPeerPosition: OnPeerPosition,
    onSignal: OnSignal,
    onPeerLeave: OnPeerLeave,
    onPeerJoined?: OnPeerJoined,
  ): void {
    this.localName = localName;
    this.currentRoomId = roomId;
    this.currentTeam = team;
    this.currentHandlers = { onPeerPosition, onSignal, onPeerLeave, onPeerJoined };
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.currentRoomId || !this.currentHandlers) return;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }

    const { onPeerPosition, onSignal, onPeerLeave, onPeerJoined } = this.currentHandlers;
    const roomId = this.currentRoomId;
    const localName = this.localName;

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    const team = this.currentTeam;

    ws.addEventListener('open', () => {
      console.log('[Signaling] WebSocket connected');
      this.reconnectAttempt = 0;
      // v0.3: include team in join. Older servers ignore the extra field.
      ws.send(JSON.stringify({ type: 'join', room: roomId, name: localName, team }));
    });

    ws.addEventListener('message', (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        console.warn('[Signaling] Failed to parse message:', event.data);
        return;
      }

      switch (msg.type) {
        case 'room_state': {
          // Existing peers already in the room
          const peers: string[] = msg.peers || [];
          for (const name of peers) {
            onPeerJoined?.(name);
          }
          break;
        }

        case 'peer_joined': {
          if (msg.name !== this.localName) {
            onPeerJoined?.(msg.name);
          }
          break;
        }

        case 'peer_left': {
          onPeerLeave(msg.name);
          break;
        }

        case 'signal': {
          // Envelope: { type: 'offer' | 'answer' | 'ice-candidate', payload: <whatever> }
          // Older builds sent the raw SDP/candidate without an envelope; SDPs have a
          // `.type` field of their own so offers/answers happened to work, but ICE
          // candidates had no type and were silently dropped.
          onSignal({
            type: msg.payload?.type,
            from: msg.from,
            to: this.localName,
            payload: msg.payload?.payload,
          });
          break;
        }

        case 'position': {
          if (msg.from !== this.localName) {
            try {
              const broadcast: PositionBroadcast = JSON.parse(msg.blob);
              onPeerPosition(broadcast);
            } catch {
              console.warn('[Signaling] Failed to parse position blob from:', msg.from);
            }
          }
          break;
        }

        case 'error': {
          console.error('[Signaling] Server error:', msg.message);
          break;
        }
      }
    });

    ws.addEventListener('close', () => {
      console.log('[Signaling] WebSocket disconnected');
      if (this.intentionallyClosed) return;
      // Exponential backoff capped at 30s
      this.reconnectAttempt++;
      const delayMs = Math.min(30000, 500 * Math.pow(2, this.reconnectAttempt - 1));
      console.log('[Signaling] Reconnecting in ' + delayMs + 'ms (attempt ' + this.reconnectAttempt + ')');
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket();
      }, delayMs);
    });

    ws.addEventListener('error', (err) => {
      console.error('[Signaling] WebSocket error:', err);
    });
  }

  broadcastPosition(data: PositionBroadcast): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'position',
        blob: JSON.stringify(data),
      }));
    }
  }

  /**
   * v0.2: send the local player's XY coordinates to the server, where they
   * land in the room state and feed the next /compute-volumes request.
   */
  sendCoords(x: number, y: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'coords', x, y }));
    }
  }

  /** Current room ID + local player name, for HTTP requests that need them
   *  (volume-client's /compute-volumes uses both in the v0.2 request body). */
  getCurrentRoom(): string | null { return this.currentRoomId; }
  getLocalName(): string { return this.localName; }

  sendSignal(signal: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'signal',
        to: signal.to,
        // Envelope so the receiver can identify ice-candidates (which carry
        // no `.type` field of their own, unlike RTCSessionDescriptionInit).
        payload: { type: signal.type, payload: signal.payload },
      }));
    }
  }

  leaveRoom(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.currentRoomId = null;
    this.currentTeam = null;
    this.currentHandlers = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}
