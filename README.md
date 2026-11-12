# Woogles-TV

Living-room crossword board game: the **TV** shows the board, each **phone** is a private rack and controller.
Rules, scoring, dictionaries (NWL23, CSW24) and the computer opponent come from
[Macondo](https://github.com/domino14/macondo), the engine behind [Woogles.io](https://woogles.io).
The look follows Woogles.io (Mulish / Fjalla One / Roboto Mono, its board and tile palettes) with six themes.

Live: **https://woogles-tv.exe.xyz/**

## Getting the board on the TV (pick one)
1. **Android TV / Google TV app** (Onn 4K etc.): sideload `android/out/woogles-tv.apk`, see `/app` or `android/README.md`.
2. **Cast from a phone** (Chrome on Android → Chromecast built-in): needs a one-time Cast receiver registration, see `CAST.md`.
3. **Any browser** on the TV or a laptop plugged into it: open `/tv` full-screen.

**TV-first:** the TV shows a QR code and a 6-letter code; phones scan it (or open `/` and type the code).
**Phone-first:** tap *Start a new game* on a phone, then *Show on TV* and type the code the TV app/browser is
showing (the TV switches to your game; if it is mid-game it asks first). Invite the other player with the room QR.
**Several games:** the code in the TV's corner is always the code of the game on screen. To start another game
press OK → *New game*; earlier games stay listed under OK → *Games on this TV* (switch back with the remote), and
each phone lists its games on the home page (*Your games*), where *Show on TV* can bring one back. Unfinished games
are kept 7 days. Anyone with the room link who isn't seated can watch (board and scores only, never racks).
*Your games* has Active / Finished tabs (finished, left, or idle 3+ days counts as finished); ✕ removes a game from
that phone, ◀ ▶ + OK removes one from the TV list, and games the server has expired disappear from both on their own.
The home screen has its own Appearance (Auto follows the phone's light/dark mode); games keep their chosen theme.
Installable as a PWA (Chrome menu → Install app, or the *Install* button on the home page).

## Game options (chosen on a phone before the game)
- Dictionary: NWL23 (default) or CSW24. Invalid words are rejected with no penalty (void challenge).
- Computer: BeginnerBot, BasicBot, BetterBot (default), STEEBot or HastyBot (Woogles' bot ladder).
- Clock: off (default) or 15 min to 2 h in 15-minute steps per player for the whole game, NASPA overtime rules:
  10 points per minute (or part) over; going more than 10 minutes over ends the game as a loss with −100,
  and the opponent is raised to win by 1 if needed. Any player can pause/resume from the ☰ menu.
- Theme: Woogles, Woogles Dark, Balsa, Forest, Pastel, Midnight (TV remote: OK → Theme).
- Tentative tiles stay on the placing phone (with the live score); the TV only shows submitted moves.

## Run / deploy
    go build -o woogles-tv . && sudo systemctl restart woogles-tv
- Systemd unit: `deploy/woogles-tv.service` (copy to `/etc/systemd/system/`). Optional env file
  `deploy/woogles-tv.env` (gitignored) for `CAST_APP_ID=...`.
- `PUBLIC_URL` sets the URL encoded in QR codes. `WT_DEV=1` serves `web/` from disk for live editing.
- Lexicon files download automatically into `data/lexica` on first start. Rooms and games are saved
  in `data/rooms/` and survive restarts.
- `go test ./...`; `go run ./tools/sim -code CODE -key JOINKEY` plays a dummy player vs the bot for visual testing.

## Security model
- Each room has a short **code** (6 letters, for typing), a 128-bit **join key** (in the QR link's `#fragment`,
  so it never appears in server logs or referrers) and a separate 128-bit **TV key** held only by the TV.
- WebSockets require the join key (players), a seat token (reconnect), or the TV key (TV role).
- *Show on TV* sends the TV this room's TV key; the phone learns nothing about the TV's own room. It is
  rate limited per room and globally, needs a seated player, and a TV in a game asks before switching.
- Typing a code (`/api/join`) is rate limited per IP and globally; room creation is rate limited; rooms are capped.
- Strict CSP, no framing, no-referrer, nosniff, HSTS; WS origin check; message size/rate limits; idle rooms expire
  after 72 h; the service runs sandboxed by systemd.

## Phone controls
Tap a square (tap again to flip →/↓), then tap rack tiles to type them in, or drag tiles onto the board.
Tap a placed tile to take it back; tap two rack tiles to swap them. ☰ has unseen tiles, clock pause, theme,
cast, resign and end game.

License: GPL-3.0 (derived from Macondo). Fonts: SIL OFL. See PLAN.md for the roadmap.
