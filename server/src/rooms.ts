import type { WebSocket } from 'ws';
import type { ClientInfo } from './types.js';
import type { TieredRoomClient } from './volumes.js';

export class RoomManager {
  /** roomId → set of ClientInfo */
  private rooms = new Map<string, ClientInfo[]>();
  /** ws → ClientInfo (for fast lookup on disconnect) */
  private clients = new Map<WebSocket, ClientInfo>();

  /**
   * Add a client to a room. Returns list of existing peer names (before this join).
   * `team` is v0.3+ — when omitted the client is treated as legacy v0.2 and
   * `computeTieredVolumes` falls back to team-blind 1200u behavior.
   */
  join(roomId: string, name: string, ws: WebSocket, team?: 'ORDER' | 'CHAOS'): string[] {
    const existing = this.rooms.get(roomId) ?? [];
    const existingNames = existing.map(c => c.name);

    const info: ClientInfo = { roomId, name, ws, team };
    existing.push(info);
    this.rooms.set(roomId, existing);
    this.clients.set(ws, info);

    return existingNames;
  }

  /** Remove a client. Returns their info, or undefined if not found. */
  leave(ws: WebSocket): { roomId: string; name: string } | undefined {
    const info = this.clients.get(ws);
    if (!info) return undefined;

    this.clients.delete(ws);

    const room = this.rooms.get(info.roomId);
    if (room) {
      const idx = room.indexOf(info);
      if (idx !== -1) room.splice(idx, 1);
      if (room.length === 0) {
        this.rooms.delete(info.roomId);
      }
    }

    return { roomId: info.roomId, name: info.name };
  }

  /** Get all peer names in a room. */
  getPeers(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? room.map(c => c.name) : [];
  }

  /** Get all other clients in the same room (excludes the given ws). */
  getOthersInRoom(ws: WebSocket): ClientInfo[] {
    const info = this.clients.get(ws);
    if (!info) return [];
    const room = this.rooms.get(info.roomId);
    if (!room) return [];
    return room.filter(c => c.ws !== ws);
  }

  /** Find a specific client in a room by name. */
  findInRoom(roomId: string, name: string): ClientInfo | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    return room.find(c => c.name === name);
  }

  /** Get client info for a WebSocket. */
  getClientInfo(ws: WebSocket): ClientInfo | undefined {
    return this.clients.get(ws);
  }

  /**
   * Record a client's latest XY position. No-op if the ws isn't in a room.
   */
  setPosition(ws: WebSocket, x: number, y: number): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.position = { x, y, updatedMs: Date.now() };
  }

  /**
   * Snapshot of all peer positions in a room, keyed by name. Skips the
   * requester (`exceptName`) and skips entries with no position set yet,
   * or whose position is older than `staleMs`.
   *
   * v0.2 server-side proximity flow: `computeVolumesFromRoom` calls this to
   * get every other peer's most recent reported XY, then computes pairwise
   * distance from the requester's position.
   */
  getRoomPositions(
    roomId: string,
    exceptName: string,
    staleMs: number,
  ): Record<string, { x: number; y: number }> {
    const room = this.rooms.get(roomId);
    if (!room) return {};
    const cutoff = Date.now() - staleMs;
    const out: Record<string, { x: number; y: number }> = {};
    for (const c of room) {
      if (c.name === exceptName) continue;
      if (!c.position) continue;
      if (c.position.updatedMs < cutoff) continue;
      out[c.name] = { x: c.position.x, y: c.position.y };
    }
    return out;
  }

  /**
   * v0.3 — snapshot of all clients in a room with just the fields
   * `computeTieredVolumes` needs (name, team, position). Includes the
   * requester; the function filters itself out by name. No staleness filter
   * here — the caller decides per-peer.
   */
  getRoomClients(roomId: string): TieredRoomClient[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.map(c => ({
      name: c.name,
      team: c.team,
      position: c.position,
    }));
  }

  /** Number of active rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}
