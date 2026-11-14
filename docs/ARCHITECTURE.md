# Architecture

```
 ┌──────────── TV ────────────┐        ┌──────────── server (Go) ─────────────┐        ┌──── phone ────┐
 │ /tv  (browser, Android TV  │  WS    │ HTTP mux · rate limits · CSP          │   WS   │ /p/{code}     │
 │  WebView app, or /cast on  │◀──────▶│ rooms (in memory) ── Macondo engine   │◀──────▶│ rack, moves,  │
 │  a Chromecast)             │ state  │   │                    rules/scoring  │ state  │ lobby, menus  │
 │  shows board, never racks  │        │   └─ data/rooms/*.json  bots (NWL23,  │ +rack  │               │
 └────────────────────────────┘        │      (saved on change)  CSW24 KWGs)   │        └───────────────┘
                                       └───────────────────────────────────────┘
```

## Components

| File | Role |
|---|---|
| `main.go` | Flags, HTTP routes, static files (embedded `web/`), JSON APIs, WebSocket endpoint, QR codes |
| `room.go` | Rooms, seats, clients, game lifecycle, NASPA clock, persistence, expiry, state broadcasting |
| `engine.go` | Thin wrapper around Macondo: build/validate/preview moves, play/pass/exchange, move log, unseen tiles, bots, history save/restore |
| `tts.go` | Optional server voice: `/api/tts` checks credentials and limits, streams audio from the local speech engine, caches clips |
| `stats.go` | Optional stats: rooms, games and connections right now, plus lifetime counters saved in `data/rooms/stats/`; served on a local admin port and/or a token-protected `/api/stats` |
| `security.go` | Token-bucket rate limits, client IP, security headers / CSP |
| `demo.go` | `-demo N`: seeds a game in progress for screenshots and trying the UI |
| `web/` | Pages (`index.html` home, `tv.html`, `play.html` phone, `app.html` APK page), `static/*.js|css`, PWA manifest + service worker |
| `android/` | Android TV launcher (single `MainActivity.java`, built without Gradle) |
| `tools/sim/` | A scripted dummy player for testing |

## Rooms and credentials

A **room** holds two seats, the settings (dictionary, clock, bot strength, theme), the current game (if any) and the
connected clients. Each room has three credentials:

| Credential | Looks like | Who has it | Grants |
|---|---|---|---|
| **Code** | `RJCDXH` (6 letters) | Shown on the TV for typing | Nothing by itself. `/api/join` swaps it for the join key, rate limited |
| **Join key** | 128-bit random, base64url | QR code / invite link, in the URL **fragment** `#k=…` | Connect as a player: pick a seat or watch |
| **TV key** | 128-bit random | Only the TV (and a phone that created the room) | Connect as a TV: see the board, never a rack |
| **Seat token** | 128-bit random | The phone in that seat (localStorage) | Reconnect to that seat. Reissued when a seat is taken over |

Phones store their join keys and seat tokens in `localStorage`; *Your games* asks `/api/summaries` about each of
them (every item needs its own credential). TVs store the rooms they've shown in the same way.

A seat whose phone is **disconnected** can be taken by anyone holding the join key. That's how you switch phones,
and also why you should only share a game's link with people you're happy to have in the game.

## WebSocket protocol

`GET /ws?room=CODE&role=player&key=JOINKEY[&token=SEATTOKEN]` or `…&role=tv&key=TVKEY`. JSON text messages,
≤ 16 KB each, rate limited per connection.

Client → server (`t` field): `join` (seat, name), `leave`, `addbot`, `removebot`, `settings`, `start`, `end`, `resign`,
`pause`, `preview` (tentative tiles → private score), `play` (tiles), `pass`, `exchange` (letters), `linktv` (TV code),
`define` (move number: look up that play's word), `tvprefs` (TV only: whether its announcer will speak; players' `state` carries `tvVoice` so phones can stay quiet
while a TV announces).

The announcer's optional server voice is plain HTTP, not WebSocket: `POST /api/tts` with the room code, the TV key or
a seat token, the sentence and a voice streams back 16-bit 24 kHz PCM from a local speech engine. See [TTS.md](TTS.md).

Server → client: `state` (the full view for that client: board, scores, log, clock, settings, seats, and **your rack only**),
`define` (a played word's definition, also sent to TVs as an `event`), `event` (moves, bingos, start, time-outs for sounds and animations), `preview` (score or error for your tentative
move, sent only to you), `joined` (your seat token), `notice` / `error` (toasts), `switch` (TV only: show another room;
`ask` if it's mid-game).

The server is authoritative. Phones send tile positions; the engine validates words, placement and scoring.
Tentative tiles never leave the phone except as `preview` requests, which are answered only to that phone. The TV
receives only committed moves.

## Game engine

- `engine.go` uses Macondo's `turnplayer` with the **void** challenge rule: invalid words are rejected before they're
  played. Previews use the same validation and scoring path as real moves.
- Word graphs (`.kwg`) and leave values (`.klv2`) come from the Woogles repository (`data/lexica/gaddag`).
- Bots are Macondo bot types: `LEVEL1..4_PROBABILISTIC` (Beginner/Basic/Better/STEE) and `HASTY_BOT`.
- **Clock:** a per-seat time bank (`Clock` in `room.go`), charged on every turn change, can go negative. Overtime
  penalties (10/min, rounded up) are applied at the end of the game. `clockWatch` ends a game when a player is more
  than 10 minutes over (−100, and the winner is bumped to win by 1 if needed), following NASPA rules.

## Persistence and lifecycle

- Each room is saved to `data/rooms/CODE.json` (write to a temp file, then rename) whenever something changes. A game
  is stored as Macondo's protobuf game history (protojson) and replayed on load, so games survive restarts and upgrades.
- Rooms expire after **72 h** without activity, or **7 days** if a game is unfinished, and only when nobody is connected.
- Limits: 500 rooms, 16 connections per room.

## Security model

The server is meant to sit on the open internet without accounts.
- **Unguessable access:** the 6-letter code alone gives nothing; joining needs a 128-bit key. Code lookups are rate
  limited per IP (10/min) and globally (300/min), so enumerating codes is slow and pointless.
- **Keys in fragments:** QR and invite links carry the join key in `#k=…`, which browsers never send in requests,
  `Referer` headers or link previews. (The TV fetches its QR image from your server's `/qr?d=…` endpoint, so the
  key does reach your own server and proxy in that request. `/qr` only encodes URLs on its own host.)
- **TV linking** (*Show on TV*) needs a seated player, sends the target TV only *this* room's TV key, never reveals
  anything about the TV's room, is rate limited per room and globally, and asks for confirmation on a TV that is
  mid-game.
- **Room creation** is limited to 20 rooms per hour per IP, with a cap of 500 rooms.
- **Headers:** strict CSP (`default-src 'self'`; Google's domain only on `/cast`), `X-Frame-Options: DENY`,
  `nosniff`, `no-referrer`, COOP, Permissions-Policy, HSTS behind HTTPS.
- **WebSockets:** origin-checked, size and rate limited, and per-role authorization on every message (TVs can't
  act; players can only act for their own seat).
- **Definitions:** a phone can only ask about a word already played in its game (by move number), so the server
  can't be used as an open dictionary proxy. Lookups are cached and rate limited per room and globally. The only
  data sent out is the word and the dictionary name (to Woogles.io, or dictionaryapi.dev as a fallback).
- **Server voice:** `/api/tts` needs the TV key or a seat token, caps text at 700 characters, allows only the
  configured voices and is rate limited per room and globally. The speech engine listens on localhost only.
- **Process:** the systemd unit and Docker image run unprivileged with a read-only filesystem, apart from `data/`.

Found a problem? See [SECURITY.md](../SECURITY.md).
