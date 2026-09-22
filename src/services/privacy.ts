// Privacy-related user preferences. Currently just the "force TURN relay"
// toggle, which hides the user's public IP from peers by routing all WebRTC
// media through the TURN server instead of direct P2P. Default off — most
// users don't need it and direct P2P is lower-latency.

const FORCE_TURN_KEY = 'lolproxchat.forceTurnRelay';

export function getForceTurnRelay(): boolean {
  return localStorage.getItem(FORCE_TURN_KEY) === '1';
}

export function setForceTurnRelay(enabled: boolean): void {
  if (enabled) localStorage.setItem(FORCE_TURN_KEY, '1');
  else localStorage.removeItem(FORCE_TURN_KEY);
}
