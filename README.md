# WoogleCast

Living-room crossword board game: the **TV** shows the board, each **phone** is a private rack/controller.
Game rules, scoring, dictionary checks and the computer opponent come from
[Macondo](https://github.com/domino14/macondo), the engine behind [Woogles.io](https://woogles.io).

## Run
    go build -o wooglecast . && ./wooglecast -addr :8420
Lexicon (`NWL23`, `CSW24`) and leave files download automatically from woogles-io/liwords on first start.

- TV: open `/tv` (shows QR + room code)
- Phones: scan the QR (or open `/` and type the code)
- `PUBLIC_URL=https://host` overrides the URL encoded in the QR.

Systemd unit: `/etc/systemd/system/wooglecast.service`.

## Phone controls
Tap a square (tap again to flip →/↓), then tap rack tiles to type them in. Or drag tiles onto the board.
Tap a placed tile to take it back. Tap two rack tiles to swap their positions.

License: GPL-3.0 (derived from Macondo). See PLAN.md for roadmap.
