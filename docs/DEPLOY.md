# Deploying Woogles-TV

Woogles-TV is one self-contained Go binary: the web app is embedded, rooms are saved as JSON files, and there is no
database. Anything that can run a Linux/macOS/Windows binary or a Docker container can host it. A small VPS
(1 vCPU, 512 MB RAM) is plenty; the server idles at about 40 MB of RAM.

- [Requirements](#requirements)
- [Option A: binary + systemd](#option-a-binary--systemd)
- [Option B: Docker / Docker Compose](#option-b-docker--docker-compose)
- [HTTPS and reverse proxies](#https-and-reverse-proxies)
- [Configuration](#configuration)
- [Data, backups and upgrades](#data-backups-and-upgrades)
- [Pointing the TV app and Cast at your server](#pointing-the-tv-app-and-cast-at-your-server)
- [Security checklist](#security-checklist)
- [Platform notes](#platform-notes)

For a Raspberry Pi or other machine on your home network, also read [LOCAL-NETWORK.md](LOCAL-NETWORK.md).

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
sudo systemctl edit woogles-tv      # optional: add  [Service]  Environment=PUBLIC_URL=https://games.example.com
sudo systemctl enable --now woogles-tv
journalctl -u woogles-tv -f         # logs
```

The unit runs the server as an unprivileged user with systemd sandboxing (read-only system, private `/tmp`, no
capabilities, a memory cap). Only `/opt/woogles-tv/data` is writable.

To run it on port 80/443 directly instead of behind a proxy, add `AmbientCapabilities=CAP_NET_BIND_SERVICE` and
change `-addr`. A reverse proxy is usually the better choice (see below).

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
- Multi-arch images (e.g. for a Pi): `docker buildx build --platform linux/amd64,linux/arm64 -t you/woogles-tv --push .`
- Extra flags can go after the image name; for example, `docker run … woogles-tv -demo 10` seeds a demo game.

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
| `-apk` | `./android/out/woogles-tv.apk` | APK served at `/app/woogles-tv.apk` (the `/app` page links to it). If the file is missing, that link returns 404 |
| `-fetch-only` | | Download the word lists into `DATA/lexica` and exit |
| `-demo N` | | Also create a demo game with N moves played and print TV/phone links |
| `PUBLIC_URL` | derived from each request | Public base URL, e.g. `https://games.example.com` or `http://192.168.1.20:8420`. Used for QR codes and invite links |
| `WT_DEFINITIONS` | on | `off` disables word definitions (double-tap a word in the scorecard). When on, the server looks up only words already played, from Woogles.io's word service (fallback: dictionaryapi.dev), with caching and rate limits |
| `WT_DEFINE_URL` | Woogles.io | Alternative endpoint that speaks the same `DefineWords` JSON API |
| `CAST_APP_ID` | empty | Google Cast receiver app ID; enables the Cast buttons ([CAST.md](CAST.md)) |
| `WT_TTS_URL` | empty (off) | Speech engine for the announcer's server voice, e.g. `http://127.0.0.1:8431` ([TTS.md](TTS.md)) |
| `WT_TTS_VOICES` | 15 voices, Cosette first | Server voices offered, in menu order; the first is the default ([TTS.md](TTS.md)) |
| `WT_DEV=1` | off | Serve `web/` from disk instead of the embedded copy (for development) |

`GET /healthz` returns `ok` for load-balancer and container health checks.

Built-in limits (in `room.go` / `main.go`): 500 rooms, 16 connections per room, 20 new rooms per hour per IP,
10 code lookups per minute per IP, plus a global budget for code lookups and *Show on TV*. Idle rooms are removed after
3 days, or 7 days with an unfinished game.

## Data, backups and upgrades

- **Backups:** copy `data/rooms/` (small JSON files, one per room). Everything else can be re-downloaded or rebuilt.
- **Upgrades:** build the new binary, replace it, restart. Rooms and games in progress are saved on every change and
  restored on start; phones and TVs reconnect by themselves within a few seconds.
  ```sh
  git pull && CGO_ENABLED=0 go build -o woogles-tv . && sudo cp woogles-tv /opt/woogles-tv/ && sudo systemctl restart woogles-tv
  # Docker: git pull && docker compose up -d --build
  ```
- **Phone caches:** the PWA's service worker fetches from the network first, so new versions show up on the next
  reload. Nothing needs clearing.

## Pointing the TV app and Cast at your server

- **Android TV app:** the published APK opens the author's server by default. Either build your own with your URL
  baked in (`WT_SERVER_URL=https://games.example.com/tv?app=1 android/build.sh`, see
  [android/README.md](../android/README.md)), or install any build and change it on the TV: **hold OK** → *Change server
  URL*. To let people download your APK from your server's `/app` page, place it at `android/out/woogles-tv.apk` or
  pass `-apk`.
- **Google Cast:** register your own receiver URL (`https://games.example.com/cast`) and set `CAST_APP_ID`
  ([CAST.md](CAST.md)).

## Security checklist

The defaults are safe for a public server ([ARCHITECTURE.md](ARCHITECTURE.md#security-model) explains why):
unguessable room keys, rate limits, a strict Content-Security-Policy, origin-checked WebSockets, size limits and
expiry. When deploying:
- Serve it over **HTTPS** if it's reachable from the internet.
- Run it as an **unprivileged user** (the provided systemd unit and the Docker image already do).
- If you bind it to all interfaces behind a proxy, consider `-addr 127.0.0.1:8420` so nobody can bypass the proxy.
- If you modify it and offer it to others, the AGPL requires you to **publish your modified source**. Update the
  GitHub links in `web/index.html`, `web/tv.html`, `web/app.html` and `web/play.html` to point at your fork.

## Platform notes

- **exe.dev** (the author's setup): `go build`, install `deploy/woogles-tv.service` with the paths changed to your
  home directory, and the default port **8420** is served at `https://<vm>.exe.xyz/` with TLS and the forwarded
  headers already set. Set `PUBLIC_URL=https://<vm>.exe.xyz`.
- **Fly.io / Render / Railway / any container platform:** deploy the Dockerfile, expose port 8420, mount a small
  volume at `/app/data/rooms`, and set `PUBLIC_URL`. Run **a single instance**: rooms live in one process's memory,
  so don't scale horizontally without sticky routing by room.
- **Windows / macOS:** `go build`, then run `woogles-tv.exe -data data`. Allow it through the firewall for LAN play.
