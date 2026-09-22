// src/services/volume-client.ts
import { Position } from '../core/types';
import { SERVER_URL } from '../core/config';

interface VolumeResponse {
  // Always empty in v0.2 — kept on the wire only so older server builds that
  // still echo the field don't break JSON.parse. Client never reads it.
  myBlob?: string;
  peerVolumes: Record<string, number>;
}

/**
 * Keep only numeric, finite peer volumes.
 *
 * The response used to be handed back straight from `resp.json()` with no
 * checking, and the audio layer immediately called `.toFixed()` on every
 * value — so one `null` or string entry threw before a single gain was
 * applied, taking the whole tick (and every peer's volume) with it. Bad
 * entries are dropped rather than coerced: a peer missing from the map is
 * already meaningful ("not audible"), which is the safe reading of garbage.
 *
 * Exported for unit testing.
 */
export function sanitizePeerVolumes(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
  }
  return out;
}

export class VolumeClient {
  private endpoint: string;

  constructor() {
    this.endpoint = `${SERVER_URL}/compute-volumes`;
  }

  /**
   * v0.2 request: the server reads peer positions from its own room state
   * (populated by `coords` WSS messages from each client), so the request
   * just identifies who we are and where we are. No more peer-to-peer
   * encrypted-blob exchange — see docs/plans/2026-06-02-server-side-positions.md.
   *
   * `allyProximity` opts the caller into hearing teammates by distance (the same
   * falloff as enemies) instead of always-full volume (#22).
   */
  async computeVolumes(
    myPosition: Position,
    roomId: string,
    name: string,
    allyProximity: boolean,
  ): Promise<VolumeResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          myPosition: { x: myPosition.x, y: myPosition.y },
          roomId,
          name,
          allyProximity,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Volume API error: ${resp.status}`);
      }

      const body = await resp.json();
      return { peerVolumes: sanitizePeerVolumes(body?.peerVolumes) };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
