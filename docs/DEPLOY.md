# Deploying Woogles-TV

Woogles-TV is one self-contained Go binary: the web app is embedded, rooms are saved as JSON files, and there is no
database. Anything that can run a Linux/macOS/Windows binary or a Docker container can host it. A small VPS
(1 vCPU, 512 MB RAM) is plenty; the server idles at about 40 MB of RAM.

- [Requirements](#requirements)
- [Option A: binary + systemd](#option-a-binary--systemd)
- [Option B: Docker / Docker Compose](#option-b-docker--docker-compose)
- [HTTPS and reverse proxies](#https-and-reverse-proxies)
- [Configuration](#configuration)
- [Background music](#background-music)
- [Stats](#stats)
- [Data, backups and upgrades](#data-backups-and-upgrades)
- [Pointing the TV app and Cast at your server](#pointing-the-tv-app-and-cast-at-your-server)
  - [The Android TV app download](#the-android-tv-app-download)
- [Security checklist](#security-checklist)
- [Platform notes](#platform-notes)

For a Raspberry Pi or other machine on your home network, also read [LOCAL-NETWORK.md](LOCAL-NETWORK.md).

### Which files are for what

Pick **one** way to run the game server. The announcer's natural server voice ([TTS.md](TTS.md)) is optional in
both, and always runs in Docker, because its speech engine is a separate program.

| File | Used by | What it does |
|---|---|---|
| [`deploy/woogles-tv.service`](../deploy/woogles-tv.service) | Option A | systemd unit for the game server binary |
| [`deploy/woogles-tv.env.example`](../deploy/woogles-tv.env.example) | Option A (also `docker run --env-file`) | Every optional setting, commented out, with a short explanation. Copy it to `/opt/woogles-tv/woogles-tv.env` |
| [`Dockerfile`](../Dockerfile) | Option B | Builds the **game server** image only (binary + word lists). The speech engine is a ready-made image, so it has no Dockerfile here |
| [`docker-compose.yml`](../docker-compose.yml) | Option B | Runs the game server; with `--profile tts`, also the speech engine |
| [`tts/docker-compose.yml`](../tts/docker-compose.yml) | Option A + server voice | Runs **only** the speech engine, on `127.0.0.1:8431`, next to a game server that isn't in Docker. It is also where the engine's settings (image, limits) are defined; the main `docker-compose.yml` reuses them |
| [`tts/server.json`](../tts/server.json), [`tts/fetch-models.sh`](../tts/fetch-models.sh) | Both, with server voice | The engine's config, and the script that downloads its model and voices into `tts/models/` |

## Requirements

- **To build:** Go 1.27 or newer, or Docker. No C toolchain is needed (`CGO_ENABLED=0` works), and it cross-compiles to any
  OS/architecture Go supports.
- **At runtime:** the `data/` directory next to the binary (or wherever `-data` points), containing:
  - `letterdistributions/` and `strategy/`: shipped in this repository; copy them along with the binary.
  - `lexica/`: word lists and bot leave files (~15 MB). They are **downloaded automatically** from the
    [Woogles repository](https://github.com/woogles-io/liwords) on first start, so the first start needs internet
    access. To prepare an offline machine, run `woogles-tv -data DIR -fetch-only` anywhere and copy `DIR/lexica`.
  - `rooms/`: created automatically; saved games live here.
- **Network:** one TCP port (default `8420`) carrying HTTP and WebSockets.

## Option A: binary + systemd

```sh
git clone https://github.com/jgbrwn/woogles-tv && cd woogles-tv
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o woogles-tv .
# cross-compile examples: GOOS=linux GOARCH=arm64 …   GOOS=linux GOARCH=arm GOARM=7 …   GOOS=windows GOARCH=amd64 …
```

Install it as a service (paths match [`deploy/woogles-tv.service`](../deploy/woogles-tv.service); adjust as you like):

```sh
sudo useradd --system --home /opt/woogles-tv --shell /usr/sbin/nologin woogles
sudo install -d -o woogles -g woogles /opt/woogles-tv /opt/woogles-tv/data
sudo cp woogles-tv /opt/woogles-tv/
sudo cp -r data/letterdistributions data/strategy /opt/woogles-tv/data/
sudo chown -R woogles:woogles /opt/woogles-tv/data
sudo -u woogles /opt/woogles-tv/woogles-tv -data /opt/woogles-tv/data -fetch-only   # download the word lists now

sudo cp deploy/woogles-tv.service /etc/systemd/system/
sudo install -m 600 deploy/woogles-tv.env.example /opt/woogles-tv/woogles-tv.env
sudo nano /opt/woogles-tv/woogles-tv.env   # optional: uncomment PUBLIC_URL and anything else you need
sudo systemctl enable --now woogles-tv
journalctl -u woogles-tv -f         # logs
```

The unit runs the server as an unprivileged user with systemd sandboxing (read-only system, private `/tmp`, no
capabilities, a memory cap). Only `/opt/woogles-tv/data` is writable.

To run it on port 80/443 directly instead of behind a proxy, add `AmbientCapabilities=CAP_NET_BIND_SERVICE` and
change `-addr`. A reverse proxy is usually the better choice (see below).

**Optional server voice** (needs Docker just for the speech engine; details in [TTS.md](TTS.md)):

```sh
tts/fetch-models.sh                              # once: ~300 MB of model and voices into tts/models/
docker compose -f tts/docker-compose.yml up -d   # the speech engine alone, on 127.0.0.1:8431
sudo nano /opt/woogles-tv/woogles-tv.env         # uncomment  WT_TTS_URL=http://127.0.0.1:8431
sudo systemctl restart woogles-tv                # the log should say "server speech on"
```

Make sure Docker itself starts at boot (`sudo systemctl enable docker`), or the engine won't come back after a
reboot. Until it does, the announcer uses the TVs' and phones' own voices.

**Optional Android TV app download** for the `/app` page and the home page: see
[The Android TV app download](#the-android-tv-app-download). The unit already looks for `/opt/woogles-tv/woogles-tv.apk`.

## Option B: Docker / Docker Compose

The [`Dockerfile`](../Dockerfile) builds a static binary on `golang:1.27`, **downloads the word lists at build
time** (so the container works offline), and ships it on `distroless/static` as a non-root user (~70 MB image).

```sh
docker compose up -d                  # uses docker-compose.yml: port 8420, volume for saved games
# or
docker build -t woogles-tv .
docker run -d --name woogles-tv --restart unless-stopped -p 8420:8420 \
  -e PUBLIC_URL=https://games.example.com -v woogles-rooms:/app/data/rooms woogles-tv
```

- Only `/app/data/rooms` needs a volume (saved games). Everything else is in the image.
- The Android TV app download is optional: put `woogles-tv.apk` in `android/out/` and uncomment the `./android/out`
  volume in `docker-compose.yml` ([details](#the-android-tv-app-download)).
- Multi-arch images (e.g. for a Pi): `docker buildx build --platform linux/amd64,linux/arm64 -t you/woogles-tv --push .`
- Extra flags can go after the image name; for example, `docker run … woogles-tv -demo 10` seeds a demo game.

**Optional server voice** ([TTS.md](TTS.md)): the speech engine is a second service in the same
`docker-compose.yml`, switched on with the `tts` profile. It has no published port; the game server reaches it at
`http://tts:8431`.

```sh
tts/fetch-models.sh                    # once: ~300 MB of model and voices into tts/models/ (run this first)
# in docker-compose.yml, uncomment:  WT_TTS_URL: http://tts:8431
docker compose --profile tts up -d     # game server + speech engine
```

Needs Docker Compose 2.24 or newer. Keep `--profile tts` on later `docker compose` commands (or set
`COMPOSE_PROFILES=tts`), or they'll leave the engine out.

## HTTPS and reverse proxies

Woogles-TV speaks plain HTTP; put TLS in front of it. HTTPS isn't required to play, but you need it for:
- **installing the phone app (PWA)** and its service worker (browsers require a secure context),
- **Google Cast** (receiver pages must be HTTPS),
- `Strict-Transport-Security`, which the server adds when the proxy reports HTTPS (`X-Forwarded-Proto: https`).

The proxy must pass **WebSockets** (`/ws`) and should set `X-Forwarded-For`, `X-Forwarded-Proto` and
`X-Forwarded-Host`. The server uses them for client IPs (rate limits) and to build the QR-code URL when
`PUBLIC_URL` isn't set. Setting `PUBLIC_URL` explicitly is the most reliable.

**Caddy** (automatic Let's Encrypt certificates; proxies WebSockets by default):

```caddyfile
games.example.com {
    reverse_proxy 127.0.0.1:8420
}
```

**nginx:**

```nginx
server {
    listen 443 ssl http2;
    server_name games.example.com;
    ssl_certificate     /etc/letsencrypt/live/games.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/games.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8420;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;            # long-lived game connections
    }
}
```

**Traefik / Kubernetes ingress / Cloudflare Tunnel** work too. Just make sure WebSockets are allowed and idle
timeouts are generous (the clients reconnect automatically if a connection drops, so this isn't critical).

**WebSocket origin check:** a game connection is accepted only from a page on the same host as the request (or
the host in `PUBLIC_URL`), so other websites can't open connections on a visitor's behalf. Proxies that rewrite
`Host` should set `X-Forwarded-Host` or `PUBLIC_URL`.

**Client IPs:** the server takes the client address from the **last** `X-Forwarded-For` entry, which is the one your
own proxy appends. If you expose the server directly with no proxy, it uses the TCP peer address.

## Configuration

| Flag / variable | Default | Meaning |
|---|---|---|
| `-addr` | `:8420` | Listen address, e.g. `:9000` for another port, or `127.0.0.1:8420` to accept only a local proxy |
| `PORT` | | If set (Render, Railway, Fly, Cloud Run and Heroku set it for you), the default listen address becomes `:$PORT`. `-addr` still wins |
| `-data` | `./data` | Data directory (word lists, strategy files, `rooms/`) |
| `-apk` | `./android/out/woogles-tv.apk` | Android TV app served at `/app/woogles-tv.apk` and offered on the home and `/app` pages. If the file is missing, the home page leaves it out ([details](#the-android-tv-app-download)). The systemd unit uses `/opt/woogles-tv/woogles-tv.apk`, the Docker image `/app/apk/woogles-tv.apk` |
| `-fetch-only` | | Download the word lists into `DATA/lexica` and exit |
| `-demo N` | | Also create a demo game with N moves played and print TV/phone links |
| `PUBLIC_URL` | derived from each request | Public base URL, e.g. `https://games.example.com` or `http://192.168.1.20:8420`. Used for QR codes and invite links |
| `WT_DEFINITIONS` | on | `off` disables word definitions (double-tap a word in the scorecard). When on, the server looks up only words already played, from Woogles.io's word service (fallback: dictionaryapi.dev), with caching and rate limits |
| `WT_DEFINE_URL` | Woogles.io | Alternative endpoint that speaks the same `DefineWords` JSON API |
| `CAST_APP_ID` | empty | Google Cast receiver app ID; enables the Cast buttons ([CAST.md](CAST.md)) |
| `WT_TTS_URL` | empty (off) | Speech engine for the announcer's server voice, e.g. `http://127.0.0.1:8431` ([TTS.md](TTS.md)) |
| `WT_TTS_VOICES` | 15 voices, Cosette first | Server voices offered, in menu order; the first is the default ([TTS.md](TTS.md)) |
| `WT_MUSIC_STREAMS` | empty (off) | Internet radio stations the TV can play as background music: `Name=URL` entries separated by commas ([Background music](#background-music)) |
| `WT_MUSIC_NOWPLAYING` | on | `off` stops the server from reading song titles and covers from the streams |
| `-admin` / `WT_ADMIN_ADDR` | off | Address for the stats listener, e.g. `127.0.0.1:8421`: `GET /stats` there. Keep it on `127.0.0.1` ([Stats](#stats)) |
| `WT_STATS_TOKEN` | off | Turns on `GET /api/stats` on the public site, for requests with `Authorization: Bearer <token>`. At least 24 characters ([Stats](#stats)) |
| `WT_DEV=1` | off | Serve `web/` from disk instead of the embedded copy (for development) |

`GET /healthz` returns `ok` for load-balancer and container health checks.

Built-in limits (in `room.go` / `main.go`): 500 rooms, 16 connections per room, 20 new rooms per hour per IP,
10 code lookups per minute per IP, plus a global budget for code lookups and *Show on TV*. Idle rooms are removed after
3 days, or 7 days with an unfinished game.

## Background music

The TV can play an internet radio station quietly under the game. It's off until you list stations:

```sh
WT_MUSIC_STREAMS=Radio Paradise=https://stream.radioparadise.com/aac-128,RP Mellow=https://stream.radioparadise.com/mellow-128
```

Each entry is `Name=URL` (or just a URL, named after its host), separated by commas; the first is the default.
Use the stream's direct audio URL (the one a player like VLC opens, not the station's web page), over `https`:
browsers block `http` audio on an `https` site. Most stations list these on a "listen" or "streams" page.

Players choose in the game (☰ → *Music on TV*, or the lobby) and the TV in its menu: *Always* (the default; quieter
during play), *Breaks* (lobby, paused clock, game over) or *Off*, plus the station and a music volume. The settings
belong to the room. The music always fades down while the announcer talks.

How it works:
- **The TV plays the stream itself**, straight from the station, like any web radio player; the audio never passes
  through your server, and each TV counts as one listener of the station. The station's own terms of use apply.
  The stations' hosts are added to the pages' Content-Security-Policy (`media-src`) automatically.
- **Now playing** comes from the stream: Icecast and Shoutcast servers (nearly all internet radio) send the current
  title to players that ask for it (ICY metadata). The server reads it when a TV asks (at most once per 20 seconds
  per station, a few kilobytes each time) and shows it on the TV, so any station works without setup. Stations that
  don't send titles just show their name. Some stations, Radio Paradise among them, also send a cover image link;
  the server fetches it (public addresses only) and serves it to the TV. `WT_MUSIC_NOWPLAYING=off` turns this off.

## Stats

The server can report what's going on: rooms (in lobby, playing, paused, over; active in the last 15 minutes and
24 hours), games in progress against a bot or a person, connected TVs, players and spectators, and lifetime counters
(games started and how they ended, moves, bingos, connections, server-voice and definition requests, and how often
each rate limit turned someone away). It reports counts only: no room codes, keys or player names.

Lifetime counters are saved every 30 seconds and on shutdown in `data/rooms/stats/counters.json`, so they survive
restarts and upgrades (and, with Docker, live in the existing rooms volume). `sinceRestart` in the report shows the
same counters for the current process. Delete the file to start counting again.

It's off by default. Two ways to turn it on; use either or both:

**A local admin port** (simplest; nothing to keep secret):

```sh
WT_ADMIN_ADDR=127.0.0.1:8421     # in the env file, or -admin 127.0.0.1:8421
curl -s localhost:8421/stats | jq
ssh -L 8421:localhost:8421 your-server   # then open http://localhost:8421/stats on your computer
```

The listener is separate from the game's and has only `/stats`. Keep it on `127.0.0.1`: anyone who can reach the
port can read it. With Docker, the address inside the container must be `0.0.0.0:8421`; publish it to the host's
loopback only (`ports: ["127.0.0.1:8421:8421"]`), never to the network.

**A token on the public site** (to check from anywhere, e.g. a phone or an uptime monitor):

```sh
WT_STATS_TOKEN=$(openssl rand -hex 24)   # put the value in the env file
curl -s -H "Authorization: Bearer $WT_STATS_TOKEN" https://games.example.com/api/stats | jq
```

Without `WT_STATS_TOKEN` the route doesn't exist (404). A wrong token gets a 401, and repeated wrong tokens are
slowed down. Tokens shorter than 24 characters are refused (the route stays off and the log says why).

## Data, backups and upgrades

- **Backups:** copy `data/rooms/` (small JSON files, one per room, plus the lifetime stats in `stats/`). Everything
  else can be re-downloaded or rebuilt.
- **Upgrades:** build the new binary, replace it, restart. Rooms and games in progress are saved on every change and
  restored on start; phones and TVs reconnect by themselves within a few seconds.
  ```sh
  git pull && CGO_ENABLED=0 go build -o woogles-tv . && sudo cp woogles-tv /opt/woogles-tv/ && sudo systemctl restart woogles-tv
  # Docker: git pull && docker compose up -d --build
  ```
- **Phone caches:** the PWA's service worker fetches from the network first, so new versions show up on the next
  reload. Nothing needs clearing.

## Pointing the TV app and Cast at your server

- **Android TV app:** build your own so it opens your server (below), or install any build and change it on the TV:
  **hold OK** → *Change server URL*.
- **Google Cast:** register your own receiver URL (`https://games.example.com/cast`) and set `CAST_APP_ID`
  ([CAST.md](CAST.md)).

### The Android TV app download

The server can offer the Android TV app for download (`/app/woogles-tv.apk`, linked from the home page and `/app`),
so a TV can install it with the Downloader app ([android/README.md](../android/README.md#install-on-google-tv--onn-4k-stick-sideload)). It's
optional and not part of the build: the server serves whatever file `-apk` points at, checked on each request, so
adding or replacing it needs no restart. Without the file, the home page simply leaves the app out.

Two ways to get the file:

```sh
# 1. Build it, so it opens your server (needs a JDK; the script fetches the Android tools). It reads PUBLIC_URL
#    from the environment or the server's env file.
PUBLIC_URL=https://games.example.com android/build.sh          # -> android/out/woogles-tv.apk

# 2. Or download the ready-made release. It opens the author's server until it's changed on the TV
#    (hold OK → Change server URL), so building is better for your own server.
mkdir -p android/out
curl -fsSLo android/out/woogles-tv.apk https://github.com/jgbrwn/woogles-tv/releases/latest/download/woogles-tv.apk
```

Then put it where the server looks:
- **systemd** (the provided unit passes `-apk /opt/woogles-tv/woogles-tv.apk`):
  `sudo install -m 644 android/out/woogles-tv.apk /opt/woogles-tv/`
- **Docker:** uncomment `./android/out:/app/apk:ro` under `volumes:` in `docker-compose.yml`, then
  `docker compose up -d`. With `docker run`, add `-v "$PWD/android/out:/app/apk:ro"`.
- **Running from the repo** (`./woogles-tv` in the checkout): nothing to do; `android/out/woogles-tv.apk` is the
  default.

Rebuild or re-download it when the app changes (new GitHub releases say so); updates install over the old app if
they're signed with the same key (`android/woogles-tv.keystore`, made on your first build; keep it).

## Security checklist

The defaults are safe for a public server ([ARCHITECTURE.md](ARCHITECTURE.md#security-model) explains why):
unguessable room keys, rate limits, a strict Content-Security-Policy, origin-checked WebSockets, size limits and
expiry. When deploying:
- Serve it over **HTTPS** if it's reachable from the internet.
- Run it as an **unprivileged user** (the provided systemd unit and the Docker image already do).
- If you bind it to all interfaces behind a proxy, consider `-addr 127.0.0.1:8420` so nobody can bypass the proxy.
- Only list music stations you trust: their audio plays on every TV, and the server fetches their titles and covers.
- If you turn on [stats](#stats), keep the admin port on `127.0.0.1` and use a long random `WT_STATS_TOKEN`.
- If you modify it and offer it to others, the AGPL requires you to **publish your modified source**. Update the
  GitHub links in `web/index.html`, `web/tv.html`, `web/app.html` and `web/play.html` to point at your fork.

## Platform notes

- **exe.dev** (the author's setup): `go build`, install `deploy/woogles-tv.service` with the paths changed to your
  home directory, and the default port **8420** is served at `https://<vm>.exe.xyz/` with TLS and the forwarded
  headers already set. Set `PUBLIC_URL=https://<vm>.exe.xyz`. For [stats](#stats), `WT_ADMIN_ADDR=127.0.0.1:8421`
  is enough: exe.dev forwards ports 3000–9999 to people with access to the VM only, so
  `https://<vm>.exe.xyz:8421/stats` works for you and nobody else, with no token.
- **Fly.io / Render / Railway / any container platform:** deploy the Dockerfile, expose port 8420, mount a small
  volume at `/app/data/rooms`, and set `PUBLIC_URL`. Run **a single instance**: rooms live in one process's memory,
  so don't scale horizontally without sticky routing by room.
- **Windows / macOS:** `go build`, then run `woogles-tv.exe -data data`. Allow it through the firewall for LAN play.
