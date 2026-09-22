import { GameStateService } from '../../src/services/game-state';
import { generateRoomId } from '../../src/core/room';
import { Player } from '../../src/core/types';

describe('Session flow integration', () => {
  const mockPlayers: Player[] = [
    { summonerName: 'Player1', championName: 'Ahri', team: 'ORDER', isDead: false, respawnTimer: 0 },
    { summonerName: 'Player2', championName: 'Zed', team: 'CHAOS', isDead: false, respawnTimer: 0 },
    { summonerName: 'Jinx', championName: 'Jinx', team: 'CHAOS', isDead: false, respawnTimer: 0 },
    { summonerName: 'Player4', championName: 'Lux', team: 'ORDER', isDead: false, respawnTimer: 0 },
  ];

  it('creates a session excluding streamer mode players', () => {
    const gs = new GameStateService();
    const session = gs.createSession(mockPlayers, 'Player1', 'CLASSIC');

    expect(session).not.toBeNull();
    expect(session!.eligiblePlayers).toHaveLength(3);
    expect(session!.eligiblePlayers.find(p => p.summonerName === 'Jinx')).toBeUndefined();
  });

  it('returns null session if local player is in streamer mode', () => {
    const gs = new GameStateService();
    const session = gs.createSession(mockPlayers, 'Jinx', 'CLASSIC');
    expect(session).toBeNull();
  });

  it('generates same room ID for all players in the same game', () => {
    const names = mockPlayers.map(p => p.summonerName);
    const id1 = generateRoomId(names);
    const id2 = generateRoomId([...names].reverse());
    expect(id1).toBe(id2);
  });

  // Proximity math (distance/volume/range) is server-authoritative — the
  // client just submits encrypted positions to /compute-volumes and applies
  // whatever volumes come back. Tests for that math live in
  // server/tests/volumes.test.ts.
});
