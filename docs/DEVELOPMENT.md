# Development

## Run it locally

```sh
go build -o woogles-tv . && WT_DEV=1 ./woogles-tv -demo 14
```

- `WT_DEV=1` serves `web/` straight from disk, so edits to HTML/CSS/JS show up on reload with no rebuild. Go changes
  still need a rebuild.
- `-demo 14` seeds a game in progress (human *Alex* vs STEEBot, 14 moves played, 1-hour clocks) and prints two links:
  `/tv#room=…&tv=…` (opens it as the TV) and `/p/…#k=…&t=…` (opens it as Alex's phone). Use a second browser profile
  or a private window for the phone, because seats are remembered per browser.
- Phone layouts: Chrome DevTools device mode (e.g. 400×860), or your phone on the same Wi-Fi via
  `http://<your-ip>:8420`.
- TV layouts: a 1920×1080 or 1280×720 window in full screen. The TV page is sized in `vh` units, so it scales with
  the screen.

## Tests

```sh
go vet ./... && go test ./...
```

`engine_test.go` covers playing moves, rejecting invalid words, a full bot-vs-bot game and restoring a saved game. `room_test.go` covers
authorization, *Show on TV*, game summaries and the NASPA clock (overtime penalties, time loss). There is no JS test
suite; the web code is small, framework-free ES modules. Check them with `node --check` and in a browser.

`tools/sim` is a scripted player for watching full games on the TV:

```sh
go run ./tools/sim -url http://localhost:8420 -code ABCDEF -key JOINKEY [-time 30] [-delay 1s]
```

It sits down, adds the computer opponent, starts a game and only exchanges or passes, so the bot fills the board.
(Get `JOINKEY` from the QR link, or `POST /api/join {"code":"ABCDEF"}`.)

## Code tour

- **Server:** start at `main.go` (routes) → `room.go` (`handle` is the message switch, `stateFor` builds each
  client's view, `broadcastLocked` sends it) → `engine.go` (all Macondo calls). Everything a room does happens under
  its mutex, and saving happens in `saveLocked` after each change.
- **Web:** `web/static/common.js` has the shared pieces (board and tile rendering, the WebSocket connection with
  reconnect, clocks, sounds, themes). `tv.js` / `play.js` / `index.js` drive the three pages. `app.css` holds the
  design tokens and all six themes; `tv.css` / `play.css` hold the layouts.
- **Android:** `android/src/io/woogles/tv/MainActivity.java`, one file. See [android/README.md](../android/README.md).

## Adding a theme

1. In `web/static/app.css`, copy one of the `[data-theme="…"]` blocks, give it a new id and adjust the variables
   (page, cards, board squares, tiles, players). Set `color-scheme` to `light dark` for light themes or `dark` for
   dark ones.
2. Add the id to `Themes` in `room.go` and its display name to `THEME_NAMES` in `web/static/common.js`.
   The lobby swatches are computed from the CSS automatically.

## Conventions

- No frameworks and no build step for the web app. Keep it that way, so the binary stays self-contained and easy to audit.
- Anything a phone sends is untrusted: validate it in `room.go` / `engine.go`.
- Never put a player's rack or tentative tiles in a message to anyone else.
- Run `gofmt` and `go vet`, and keep the docs (README and `docs/`) in step with features.
