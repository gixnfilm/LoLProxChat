import { invoke } from '@tauri-apps/api/core';
import { Player, MapType } from '../core/types';
import { isStreamerMode } from '../core/streamer-detect';
import { generateRoomId } from '../core/room';

/** Shape returned by the Rust get_game_state command */
export interface TauriGameState {
  isLeagueRunning: boolean;
  isInGame: boolean;
  summonerName: string | null;
  isDead: boolean;
  gameFlowPhase: string;
}

/** Shape returned by the Rust get_live_client_data command */
export interface LiveClientData {
  activePlayer: any;
  allPlayers: any[];
  gameData: any;
}

export interface GameSession {
  roomId: string;
  localPlayer: Player;
  allPlayers: Player[];
  eligiblePlayers: Player[]; // excludes streamers
  mapType: MapType;
  gameMode: string;
}

export class GameStateService {
  private session: GameSession | null = null;

  parsePlayerList(liveClientData: any): Player[] {
    if (!liveClientData?.players) return [];
    return liveClientData.players.map((p: any) => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team === 'ORDER' ? 'ORDER' : 'CHAOS',
      isDead: p.isDead ?? false,
      respawnTimer: p.respawnTimer ?? 0,
    }));
  }

  createSession(
    allPlayers: Player[],
    localSummonerName: string,
    gameMode: string,
  ): GameSession | null {
    const localPlayer = allPlayers.find(
      (p) => p.summonerName === localSummonerName,
    );
    if (!localPlayer) return null;

    if (isStreamerMode(localPlayer)) {
      console.log('Local player has streamer mode on - not joining proximity chat');
      return null;
    }

    const eligiblePlayers = allPlayers.filter((p) => !isStreamerMode(p));
    const playerNames = allPlayers.map((p) => p.summonerName);
    const roomId = generateRoomId(playerNames);

    const mapType = this.detectMapType(gameMode);

    this.session = {
      roomId,
      localPlayer,
      allPlayers,
      eligiblePlayers,
      mapType,
      gameMode,
    };

    return this.session;
  }

  getSession(): GameSession | null {
    return this.session;
  }

  clearSession(): void {
    this.session = null;
  }

  /** Poll Tauri backend for basic game state (league running, in-game, summoner name) */
  async pollGameState(): Promise<TauriGameState> {
    return invoke<TauriGameState>('get_game_state');
  }

  /** Poll League Live Client Data API via Tauri backend */
  async pollLiveClientData(): Promise<LiveClientData | null> {
    try {
      return await invoke<LiveClientData>('get_live_client_data');
    } catch {
      return null;
    }
  }

  private detectMapType(gameMode: string): MapType {
    const mode = gameMode.toLowerCase();
    if (mode.includes('aram') || mode.includes('howling')) return 'howling_abyss';
    // Practice tool, custom games, and standard modes all use Summoner's Rift
    if (
      mode.includes('classic') || mode.includes('ranked') || mode.includes('normal') ||
      mode.includes('practice') || mode.includes('custom') || mode.includes('tutorial')
    )
      return 'summoners_rift';
    return 'summoners_rift'; // Default to SR rather than unknown
  }
}
