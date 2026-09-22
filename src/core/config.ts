// Injected at build time via webpack.DefinePlugin — see .env.example
declare const __PROXCHAT_SERVER__: string;

export const SERVER_URL: string = typeof __PROXCHAT_SERVER__ !== 'undefined'
  ? __PROXCHAT_SERVER__
  : 'https://proxchat.dant123.com';

// Derive WebSocket URL from SERVER_URL (http→ws, https→wss)
export const WS_URL: string = SERVER_URL.replace(/^http/, 'ws') + '/ws';

// Default STUN-only ICE servers (fallback if TURN credentials unavailable)
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * Fetch ICE servers with TURN credentials from the signaling server.
 * TURN secret never touches the client — HMAC generation happens server-side.
 */
export async function getIceServers(): Promise<RTCIceServer[]> {
  try {
    const resp = await fetch(`${SERVER_URL}/turn-credentials`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.iceServers && data.iceServers.length > 0) {
      return data.iceServers;
    }
  } catch (e) {
    console.warn('[Config] Failed to fetch TURN credentials, using STUN only:', e);
  }
  return ICE_SERVERS;
}
