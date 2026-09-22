// Audio playback preferences. Currently just the "ally proximity" toggle, which
// makes teammates fade with distance (the same vision-range falloff as enemies)
// instead of always playing at full volume. Default off — most players want to
// hear their whole team; opting in trades that for positional ally audio (#22).

const ALLY_PROXIMITY_KEY = 'lolproxchat.allyProximity';

export function getAllyProximity(): boolean {
  return localStorage.getItem(ALLY_PROXIMITY_KEY) === '1';
}

export function setAllyProximity(enabled: boolean): void {
  if (enabled) localStorage.setItem(ALLY_PROXIMITY_KEY, '1');
  else localStorage.removeItem(ALLY_PROXIMITY_KEY);
}
