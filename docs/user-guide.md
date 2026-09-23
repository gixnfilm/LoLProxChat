# User Guide

Everything you need to use LoLProxChat day-to-day. For installation, see the [README](../README.md). For privacy and the threat model, see [`threat-model.md`](threat-model.md). For self-hosting the signaling server, see [`self-hosting.md`](self-hosting.md).

## First-time setup

1. **Set League of Legends to Borderless mode** (Settings → Video → Window Mode → Borderless). This is non-negotiable — DX9 true fullscreen takes exclusive GPU output and no overlay (including this one) can render over it. Borderless is functionally identical performance-wise.
2. Launch `lolproxchat.exe`. The panel appears in the middle of the screen showing the current lifecycle status: "Waiting for League of Legends", "In champion select", "Joining game…", etc.
3. Once you load into a match the panel jumps to the left edge of the minimap. You can drag it anywhere by grabbing the title bar.
4. Other players running LoLProxChat in the same match appear in the player list within a few seconds.

## Panel controls

| Button | What it does |
|---|---|
| **MIC** | Toggle self-mute (no one hears you) |
| **VOL** | Mute everyone for you (you hear no one) |
| **SET** | Open / close the Settings panel |
| **»** | Collapse the panel to a thin column |

Each player row has:

- **Champion name** (or summoner name on hover)
- **Per-player volume slider** — adjust how loud this specific player is for you
- **MUTE button** — silence this specific player without affecting others

## Settings

| Setting | What it does |
|---|---|
| **Input Device** | Which microphone to use. "Default" follows Windows' default communications device. Selection persists across launches. Switching mid-game swaps the source in place — no peer reconnection needed. |
| **Output Device** | Which speaker / headset to send voice to. Same persistence behavior. |
| **Input Mode** | "Always Open" (default) — mic is always live unless self-muted. "Push to Talk" — hold the bound PTT key (default Caps Lock) to transmit; it works while League has focus. |
| **PTT Key** | The push-to-talk key. Default Caps Lock (the keyboard LED is auto-flipped back so it doesn't toggle on every press). Click the button to capture a new key; the app rejects common LoL bindings (Q/W/E/R/D/F/B/P) and modifier-only keys. |
| **Toggle-mute Key** | Optional global hotkey to flip self-mute on/off. Unbound by default — click the button to bind. |
| **Mic Volume** | Pre-transmission gain on your mic, 0-100%. Useful if your hardware mic is too quiet or too hot. Persists across launches. |

### Voice Mixer

How loud everyone else is for you. All of it persists across games and restarts.

| Setting | What it does |
|---|---|
| **Master Vol** | Output level for every voice, 0-200%. Above 100% amplifies past the original recording. |
| **Team Vol** | Extra gain for teammates, 0-200%. |
| **Enemy Vol** | Extra gain for enemies, 0-300%. Defaults to **160%** — enemies always arrive attenuated by distance, so they need more headroom than allies to be comfortably audible. |
| **Proximity** | **OFF** — nobody fades, everyone you can hear plays flat. **ENEMY** — only enemies fade with distance. **ALL** — teammates fade too. Takes effect on the next position update; no reconnect. |
| **Stereo** | How strongly voices are pushed left or right depending on where that player stands relative to you, 0-150%. 0 turns it off. |
| **Reverb** | Adds a little reverb to voices coming from the river. |

> **Hearing range is set by the server and can't be raised here.** Players
> further than ~1350 units (a champion's vision range) are not sent to you at
> all, so no slider can bring them back. Everything inside that radius is
> yours to shape.
>
### Stereo and reverb

Voices come from the direction the speaker is standing — but only when you can
**see their icon on your own minimap**. That restriction is the whole design:
an icon you can see is a position the game already showed you, so nothing is
exchanged between clients and nothing is revealed that you did not already
know. Someone hidden in fog of war has no icon, so their voice stays centred.

Two things follow from that, and both are intentional:

- If two players stand close enough that their icons merge, their voices stay
  centred instead of picking one at random. A confident wrong direction is
  worse than an honest centre.
- Reverb follows the **speaker's** surroundings, so it only applies to someone
  you can see. An unseen speaker stays dry rather than borrowing yours.

Both need **Audio Boost** on (Settings → Other), which is the default.

> **Teammates get an exception; enemies don't.** Once a teammate leaves that
> radius they hold at **Min Vol (far)** rather than going silent — you can
> always still reach your team, just quietly. Enemies out of range are silent,
> full stop: the server withholds them so that no client can hear them, and
> the app will not invent a level for someone it wasn't told about.
>
> The exact numbers above were measured against the live server
> (`node scripts/probe-server-curve.mjs`), not read out of the source — the
> two disagreed, which is what broke teammate proximity in v0.6.0.
| **Hide IP (Force TURN)** | Routes all voice through the TURN relay so peers in your match never see your public IP. Defends against DDoS / port-scan attempts from random players. Adds ~20-100 ms latency. Default off; takes effect on the next peer connection. See [`threat-model.md`](threat-model.md) for the full discussion. |
| **Debug** | Toggles diagnostic mode — shows a filtered minimap thumbnail with the tracked position marked, exposes the Scan Rate slider, and starts writing a debug log to disk. Off by default; turn on only when investigating a problem or asked by a maintainer. |
| **Debug Logs → OPEN** | Launches Explorer at `%LOCALAPPDATA%\com.proxchat.app\` so you can grab `lolproxchat.log` to attach to a GitHub issue. |
| **Audio Boost** | The WebAudio playback path. Required for volumes above 100%, and for Stereo and Reverb. Only switch it off if you hear echo or doubled voices. |
| **Reset All** | Puts every setting back to factory defaults — mixer, mic volume, per-player sliders, key bindings, devices, Hide IP, auto-update. Click twice to confirm. |
| **Auto-update** | When on, the app checks GitHub Releases ~5 seconds after launch and applies any newer version automatically (process exits cleanly, new binary takes over, old one is deleted). Off by default. The setting persists. |
| **Updates → CHECK** | Force an immediate update check, regardless of the Auto-update toggle. |
| **Scan Rate** *(Debug only)* | How often the minimap is scanned — 0 ≈ 1 FPS, 50 ≈ 30 FPS, 100 = 60 FPS. The rate doesn't change how tracking feels (smoothing adjusts to it). Lower it if you hear audio crackling under heavy load (rare on modern hardware). |

## Global keyboard shortcuts

These work even while League has focus:

- **Caps Lock** *(hold, default)* — push-to-talk. Rebindable in **Settings → PTT Key**. Caps Lock won't toggle the LED — the app cancels the toggle via synthetic input (Discord trick).
- **Toggle-mute** — unbound by default. Bind in **Settings → Toggle-mute Key**.

PTT is only effective when **Input Mode** is set to "Push to Talk".

## Reporting bugs

If something's broken — voice not working, weird volume, players not appearing, crashes — please open an issue at <https://github.com/danthi123/LoLProxChat/issues> with the debug log attached. The log captures everything the app sees (connection state, network negotiation, champion tracking, and more) and is by far the fastest way to figure out what went wrong.

### Three-step log grab

1. **Settings → Debug** — flip from **OFF** to **ON**. Diagnostic writes start immediately; overhead is negligible.
2. **Reproduce the bug.** Start a game, repeat whatever triggered the issue.
3. **Settings → Debug Logs → OPEN.** Explorer pops up at `%LOCALAPPDATA%\com.proxchat.app\`. Drag `lolproxchat.log` into your GitHub issue.

> If you restarted the app between the bug and grabbing the log, the previous session is at `lolproxchat.1.log`. The app keeps three rolling sessions: `.log` (current) → `.1.log` (previous) → `.2.log` (oldest).

The log is plain text. It contains your summoner name and nearby players' summoner names (gameplay-public), plus technical IP info from the connection setup. If any of that is sensitive in your situation, skim through and redact before posting.

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| Overlay invisible during gameplay | League is in true fullscreen — switch to **Borderless** in Video Settings. |
| Panel sits in the middle of the screen | No game detected yet, or tracking hasn't locked on. The panel's status text tells you which. |
| Panel sits above the minimap instead of beside it | The detected minimap bounds are off. Turn on **Debug** and check the tracking log lines. (The draggable panel never auto-positions — only the minimap overlay does.) |
| Audio cuts out or crackles | Usually the minimap scan competing for the main thread at a high scan rate. Lower the **Scan Rate** slider to ~50 (Debug). |
| Connected to a peer but hear nothing | First check your **Output Device** (Settings) — the wrong default device is the most common cause. Then turn on Debug and confirm the connection reaches `connected`; if it shows `failed`, you're behind a restrictive network and need **Hide IP (Force TURN)**. |
| Can't hear one specific player | Check their per-player volume slider isn't at zero and their **MUTE** isn't on. |
| Faint or no audio from a nearby enemy | Raise **Settings → Enemy Vol** (up to 300%). Enemy voices fade with distance by design. |
| Everyone suddenly sounds doubled / echoey | Turn **Settings → Audio Boost** OFF. That reverts to the original playback path (capped at 100%) and is worth reporting. |
| Teammates don't get quieter when they walk away | **Settings → Proximity** must be **ALL**. On **ENEMY** (or **OFF**) teammates stay at full volume. If it is already ALL, turn on Debug and check the log: `[Audio] applyPeerVolumes` prints what the server actually returned per teammate. |
| Teammates are quiet but never silent | Working as intended — beyond ~1350 units they hold at a low level so you never lose your team entirely. |
| Voices all sound centred | You can only hear direction for players whose icon is visible on your minimap, and only when it's clear which icon is which. Check **Stereo** isn't at 0 and **Audio Boost** is on. |
| The panel says FINDING YOU | Tracking has lost your champion on the minimap. Proximity and stereo both need your own position, so enemies stay silent until it clears. It recovers on its own; if it persists, make sure League is in **Borderless** and the minimap isn't covered. |
| Something else seems off | Make sure you're on the latest version: turn on **Auto-update**, or grab the newest build from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest). |

## Updating

If **Auto-update** is on (Settings), the app downloads and applies new releases automatically on launch.

You can also force a check at any time via **Settings → Updates → CHECK**. If an update is available it downloads and applies immediately; if not you get an "Up to date" message.

For manual updates: download the new `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest) and replace your existing copy.

### Verifying downloads

Every release body includes a SHA-256 hash of the exe. Compare against your download:

```bash
# Windows PowerShell
Get-FileHash lolproxchat.exe

# WSL / git-bash
sha256sum lolproxchat.exe

# Linux/macOS
shasum -a 256 lolproxchat.exe
```

The hash defends against in-transit tampering, mirror reposts, and typosquatted re-uploads. It does *not* defend against you having downloaded from the wrong URL — always start from <https://github.com/danthi123/LoLProxChat/releases>.

## Uninstalling

LoLProxChat is a portable executable with no installer. Removing it is two steps:

1. **Delete the exe** wherever you put it (probably Downloads or a folder you chose).
2. **Delete app data:** open `Run` (Win+R), paste `%LOCALAPPDATA%\com.proxchat.app\`, then delete the folder. It contains:
   - WebView2 cache (cookies, localStorage, IndexedDB)
   - Your Settings (auto-update toggle, device picks, etc.)
   - `lolproxchat.log` + `lolproxchat.1.log` + `lolproxchat.2.log` if you ever turned Debug on

That's the full footprint. No registry entries, nothing under "Programs and Features", no startup tasks, no services.
