# Woogles-TV — plan / status

## Done
- Macondo engine (rules, scoring, NWL23/CSW24, HastyBot), rooms over WebSockets, reconnect & seat takeover.
- TV board (coords, last-move highlight, drop-in tiles, score pops, scorecard, bag meter, clocks, D-pad menu).
- Phone rack (tap/drag placement, private live score, blank picker, swap, pass, unseen tiles, zoom, menu).
- Six Woogles-inspired themes, synthesized sounds, vibration on your turn.
- NASPA-style game clock (off / 30-120 min), pause/resume, resign, rematch (other player starts).
- Persistence of rooms + games across restarts (protojson game history replay).
- Security: unguessable join/TV keys, rate limits, CSP & headers, origin check, sandboxed systemd unit.
- Android TV launcher APK (android/), served at /app/woogles-tv.apk.
- Google Cast custom receiver (/cast) + Chrome sender (needs CAST_APP_ID, see CAST.md).

- Phone-first games: start a room on a phone, "Show on TV" by typing the TV's code (TV asks before
  leaving a game in progress), invite the 2nd player by QR/share link.
- Computer strength like Woogles: BeginnerBot, BasicBot, BetterBot (default), STEEBot, HastyBot.
- PWA: manifest, icons, service worker, install button, "New game" shortcut, rejoin last room.
- Clock in 15-minute steps (off, 15 min … 2 h).
- Bingo celebration (word in tiles, score, confetti, fanfare) on the TV and both phones.

- Multiple games per TV: "Games on this TV" list (remote), "Your games" on phones, spectator mode,
  unfinished games kept 7 days, /api/summaries (each item needs its own credential).

- Phone: ⌫ Back takes back the last tile (cursor steps back); Recall returns the cursor to where the move
  started, same direction. Hardware Backspace works too.
- Games lists: Active/Finished filter, remove (phone ✕, TV ◀ ▶), expired games auto-pruned.
- Home Appearance setting (Auto/Light/Dark); light themes declare `color-scheme: light dark` so Chrome's
  auto-dark never force-darkens them.

## Next ideas
- Test on the Onn 4K box + two real phones; tune TV sizes for 720p receivers.
- Spectator mode / 3–4 players, challenge modes (single/double), game history export (GCG).
- Optional end-of-game analysis from Macondo (best play per turn).
