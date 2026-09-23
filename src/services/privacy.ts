// Privacy: all WebRTC media is relayed through the TURN server rather than
// going peer-to-peer.
//
// This used to be a user-facing toggle, defaulting to off. It is now simply
// always on, for two reasons:
//
//   • Without the relay, every other player in the match — including the enemy
//     team, who are strangers — learns your real IP address from the ICE
//     candidate exchange. League has a long history of players being knocked
//     offline that way, which is the reason the option existed at all.
//   • Relaying is *more* reliable. It sidesteps the NAT configurations where a
//     direct connection cannot be established and the peer simply never
//     connects at all.
//
// The cost is 20-100 ms of added latency, which is not meaningful for speech.

export function getForceTurnRelay(): boolean {
  return true;
}
