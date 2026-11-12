# WoogleCast — Living-Room Scrabble (TV board + phone racks)

## Goal
TV shows the shared board/scoreboard; each player's phone is a private rack + controller.
Rules, scoring and word validation come from **Macondo** (the Woogles.io engine, GPL/AGPL).

## Architecture (v1)
- **Single Go binary** (`wooglecast`) — authoritative game server.
  - Embeds Macondo `game`/`turnplayer` for move validation, scoring, bag, end-game.
  - Lexicons: NWL23 (default) / CSW24 KWG files auto-downloaded from woogles-io/liwords.
  - Rooms in memory (4-letter code), WebSocket per client, per-seat secret tokens (reconnect-safe).
- **TV page** `/tv` — 1080p full-screen board, scores, move log, bag, QR code to join.
  Works in any TV browser on the Onn 4K stick (or a tiny WebView launcher APK, phase 2).
- **Phone page** `/p/CODE` — private rack, mini board, tap/drag placement, live score preview
  (ghost tiles shown on TV), submit / pass / exchange / shuffle / recall, blank picker.
- Runs on this exe.dev VM now; the same binary can run on any LAN box (Pi, PC) later.

## Phases
1. **MVP (now)**: engine wrapper, rooms + WS, TV board, phone controller, QR join, reconnect, game over screen.
2. **Polish**: tile fly-in animations, score count-up, endgame reveal, sounds, VS-computer (Macondo HastyBot),
   game persistence (survive server restart), Android TV WebView launcher APK (D-pad friendly).
3. **Optional**: Google Cast receiver app, timers/clock, challenge modes, more word games.
