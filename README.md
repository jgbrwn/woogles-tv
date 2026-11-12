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

Phones scan the QR code on the TV (or open `/` and type the 6-letter code).

## Game options (chosen on a phone before the game)
- Dictionary: NWL23 (default) or CSW24. Invalid words are rejected with no penalty (void challenge).
- Clock: off (default) or 30/60/90/120 minutes per player for the whole game, NASPA overtime rules:
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
- Typing a code (`/api/join`) is rate limited per IP and globally; room creation is rate limited; rooms are capped.
- Strict CSP, no framing, no-referrer, nosniff, HSTS; WS origin check; message size/rate limits; idle rooms expire
  after 72 h; the service runs sandboxed by systemd.

## Phone controls
Tap a square (tap again to flip →/↓), then tap rack tiles to type them in, or drag tiles onto the board.
Tap a placed tile to take it back; tap two rack tiles to swap them. ☰ has unseen tiles, clock pause, theme,
cast, resign and end game.

License: GPL-3.0 (derived from Macondo). Fonts: SIL OFL. See PLAN.md for the roadmap.
