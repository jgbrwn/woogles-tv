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

## Next ideas
- Test on the Onn 4K box + two real phones; tune TV sizes for 720p receivers.
- Spectator mode / 3–4 players, challenge modes (single/double), game history export (GCG).
- Optional end-of-game analysis from Macondo (best play per turn).
