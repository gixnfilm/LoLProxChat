use serde::Serialize;
use std::path::PathBuf;
use sysinfo::System;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub is_league_running: bool,
    pub is_in_game: bool,
    pub summoner_name: Option<String>,
    pub is_dead: bool,
    pub game_flow_phase: String,
}

/// Locate the LeagueClient.exe install directory by querying the running
/// process. Falls back to a few common default install paths if the process
/// query fails (permissions / sysinfo platform quirks).
fn find_league_install_dir() -> Option<PathBuf> {
    let sys = System::new_all();
    for proc in sys.processes().values() {
        let name = proc.name().to_string_lossy();
        if name.contains("LeagueClient") {
            if let Some(exe_path) = proc.exe() {
                if let Some(parent) = exe_path.parent() {
                    return Some(parent.to_path_buf());
                }
            }
            if let Some(cwd) = proc.cwd() {
                return Some(cwd.to_path_buf());
            }
        }
    }
    // No running process — try common defaults. Used during transient process
    // states or when sysinfo can't read the exe path due to permissions.
    let defaults = [
        r"C:\Riot Games\League of Legends",
        r"D:\Riot Games\League of Legends",
        r"C:\Program Files\Riot Games\League of Legends",
        r"C:\Program Files (x86)\Riot Games\League of Legends",
    ];
    for d in &defaults {
        let p = PathBuf::from(d);
        if p.join("lockfile").exists() || p.join("LeagueClient.exe").exists() {
            return Some(p);
        }
    }
    None
}

/// Find and parse the LeagueClient lockfile. Returns (port, password).
fn find_lockfile() -> Option<(u16, String)> {
    let dir = find_league_install_dir()?;
    let content = std::fs::read_to_string(dir.join("lockfile")).ok()?;
    let parts: Vec<&str> = content.split(':').collect();
    if parts.len() < 4 {
        return None;
    }
    let port = parts[2].parse::<u16>().ok()?;
    Some((port, parts[3].to_string()))
}

/// Returns the absolute path to the League of Legends install directory if
/// detected, so the frontend can read other files in the install (e.g.
/// `Config/game.cfg` for minimap-scale calibration) regardless of install path.
#[tauri::command]
pub fn get_league_install_dir() -> Option<String> {
    find_league_install_dir().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn check_league_running() -> bool {
    find_lockfile().is_some()
}

#[tauri::command]
pub async fn get_game_state() -> GameState {
    let mut state = GameState {
        is_league_running: false,
        is_in_game: false,
        summoner_name: None,
        is_dead: false,
        game_flow_phase: "None".into(),
    };

    let lockfile = find_lockfile();
    state.is_league_running = lockfile.is_some();

    if let Some((port, password)) = &lockfile {
        // Check gameflow phase via LCU API
        if let Ok(client) = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
        {
            let url = format!(
                "https://127.0.0.1:{}/lol-gameflow/v1/gameflow-phase",
                port
            );
            if let Ok(resp) = client
                .get(&url)
                .basic_auth("riot", Some(password))
                .send()
                .await
            {
                if let Ok(phase) = resp.text().await {
                    let phase = phase.trim_matches('"').to_string();
                    state.is_in_game = phase == "InProgress";
                    state.game_flow_phase = phase;
                }
            }
        }
    }

    // If in game, get live data (no auth needed)
    if state.is_in_game {
        if let Ok(client) = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
        {
            if let Ok(resp) = client
                .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
                .send()
                .await
            {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(player) = data.get("activePlayer") {
                        state.summoner_name = player
                            .get("riotId")
                            .or_else(|| player.get("summonerName"))
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        state.is_dead = player
                            .get("isDead")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                    }
                }
            }
        }
    }

    state
}

/// Get full live client data (all players, active player, events).
/// Only available during an active game on localhost:2999 with no auth.
#[tauri::command]
pub async fn get_live_client_data() -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;

    client
        .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

/// Read the League client's `Config/game.cfg`. Path is computed Rust-side
/// from `find_league_install_dir()` so the frontend can't supply an arbitrary
/// path — this used to be a `read_text_file(path: String)` command which gave
/// JS arbitrary file-read capability if WebView2 ever got compromised.
#[tauri::command]
pub fn read_league_config_file() -> Result<String, String> {
    let dir = find_league_install_dir().ok_or("League install directory not detected".to_string())?;
    let path = dir.join("Config").join("game.cfg");
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}
