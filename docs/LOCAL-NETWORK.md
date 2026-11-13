# Running Woogles-TV on your home network (Raspberry Pi / Linux box)

Woogles-TV runs well on a Raspberry Pi, an old laptop or a NAS. Phones and the TV connect to it over your Wi-Fi, and
after the first start it needs no internet at all. This page covers the setup and the network caveats: addresses,
local DNS and HTTPS.

- [Hardware](#hardware)
- [Install on a Pi](#install-on-a-pi)
- [Give the server a stable address](#give-the-server-a-stable-address)
- [Names instead of IP addresses (local DNS)](#names-instead-of-ip-addresses-local-dns)
- [HTTP or HTTPS?](#http-or-https)
- [Connect the TV](#connect-the-tv)
- [Network caveats checklist](#network-caveats-checklist)
- [Playing away from home](#playing-away-from-home)

## Hardware

- **Raspberry Pi 3B+, 4, 5 or Zero 2 W**, or any Linux machine. The server idles at about 40 MB of RAM. The bots
  pick moves in well under a second on a modern Pi; Macondo's word graphs are compact.
- 64-bit Raspberry Pi OS (Lite is fine) is recommended (`arm64`); 32-bit (`armv7`) works too.
- Wired Ethernet for the Pi is nice, but Wi-Fi is fine.

## Install on a Pi

Build on any computer (no Go needed on the Pi), and fetch the word lists while you have internet:

```sh
git clone https://github.com/jgbrwn/woogles-tv && cd woogles-tv
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o woogles-tv-arm64 .   # 32-bit OS: GOARCH=arm GOARM=7
go run . -data ./data -fetch-only      # downloads data/lexica (~15 MB)
scp -r woogles-tv-arm64 data/letterdistributions data/strategy data/lexica deploy/woogles-tv.service pi@raspberrypi.local:~
```

On the Pi:

```sh
sudo useradd --system --home /opt/woogles-tv --shell /usr/sbin/nologin woogles
sudo install -d -o woogles -g woogles /opt/woogles-tv /opt/woogles-tv/data
sudo mv ~/woogles-tv-arm64 /opt/woogles-tv/woogles-tv
sudo mv ~/letterdistributions ~/strategy ~/lexica /opt/woogles-tv/data/
sudo chown -R woogles:woogles /opt/woogles-tv/data
sudo cp ~/woogles-tv.service /etc/systemd/system/
sudo systemctl edit woogles-tv
#   [Service]
#   Environment=PUBLIC_URL=http://192.168.1.20:8420      <- your Pi's address (see below)
sudo systemctl enable --now woogles-tv
```

Or with Docker on the Pi: `git clone … && docker compose up -d` builds an arm64 image with the word lists included.

Check it works: open `http://192.168.1.20:8420/` from your phone.

**Firewall:** if the Pi runs `ufw`, run `sudo ufw allow from 192.168.0.0/16 to any port 8420 proto tcp` (adjust it
to your subnet).

## Give the server a stable address

Phones and the TV app reach the server by its address, and the QR code on the TV encodes `PUBLIC_URL`. That address
must not change:
- **Best:** add a **DHCP reservation** for the Pi in your router (often under LAN / DHCP / Address reservation).
- Or set a static IP on the Pi (e.g. with `nmtui` on Raspberry Pi OS Bookworm), outside the router's DHCP pool.

Set `PUBLIC_URL` to the address phones should use, e.g. `http://192.168.1.20:8420`. If you leave it unset, the QR
code uses whatever address the TV used to open the page, which is also fine as long as the TV used an address that
phones can reach (not `localhost`).

## Names instead of IP addresses (local DNS)

`http://192.168.1.20:8420` works everywhere. If you'd prefer something like `http://scrabble.home:8420`:

- **mDNS (`raspberrypi.local`)**: works on iPhones, Macs, Windows and Linux, but **not reliably on Android** or in the
  Android TV WebView. Don't depend on it for the TV or Android phones.
- **Your router's local DNS**: many routers let you name devices (`pi.lan`, `pi.home`, `pi.fritz.box`, …). Use
  that name in `PUBLIC_URL`.
- **Pi-hole / AdGuard Home / dnsmasq** on your network: add a local DNS record such as
  `scrabble.home → 192.168.1.20`.
- **Android "Private DNS"** (DNS-over-TLS, e.g. `dns.google`) bypasses your router's DNS, so local names won't
  resolve on those phones. Use the IP address, or turn Private DNS off / set it to Automatic.
- **Chromecast devices ignore local DNS** (they use Google's DNS), which matters only for Cast (see below).

## HTTP or HTTPS?

**Plain HTTP on your LAN is fine for playing.** Everything works except for a few browser features that require a
secure (HTTPS) context:

| Feature | Over `http://192.168.x.x` |
|---|---|
| Playing, TV board, QR codes, Android TV app | ✅ works (the app allows cleartext) |
| Installing the phone app (PWA), offline shell | ❌ needs HTTPS |
| *Share link…* button in the invite dialog | falls back to the QR code / copying the link |
| Keeping a browser TV awake (Wake Lock) | ❌ needs HTTPS. Turn off the TV's screensaver, or use the Android TV app, which keeps the screen on |
| Google Cast | ❌ needs HTTPS with a publicly trusted certificate |

If you want HTTPS at home, here are the options, best first:

1. **A real domain + Let's Encrypt DNS-01, pointing at a private IP.** Create `scrabble.example.com → 192.168.1.20`
   in your domain's public DNS (an A record to a private address is allowed). Get a certificate with a DNS challenge,
   which doesn't need any open ports: e.g. Caddy built with your DNS provider's plugin
   ([caddy-dns](https://github.com/caddy-dns)), or `certbot --dns-cloudflare`. Then proxy to `127.0.0.1:8420`
   ([DEPLOY.md](DEPLOY.md#https-and-reverse-proxies)) and set `PUBLIC_URL=https://scrabble.example.com`.
   - Caveat: **DNS rebinding protection.** Some routers and DNS filters (FRITZ!Box, OpenWrt/dnsmasq
     `rebind_protection`, pfSense/OPNsense, NextDNS, some ISP resolvers) refuse public names that resolve to private
     IPs. Whitelist your domain there (e.g. dnsmasq `rebind-domain-ok=/example.com/`), or add a local DNS record for
     it.
   - This is also the only home setup where **Cast** works: the Chromecast resolves the name through public DNS and
     trusts the certificate.
2. **Tailscale.** Install Tailscale on the Pi and run `tailscale serve --bg 8420`. That gives you
   `https://pi.<tailnet>.ts.net` with a valid certificate. Every phone and the TV must also be on your tailnet
   (Tailscale has Android, iOS and Android TV apps). This is handy for playing with family elsewhere, too.
3. **A local CA (mkcert, Caddy `tls internal`, step-ca).** Not recommended: you have to install the root certificate
   on every phone, and the Android TV app and Chromecasts won't trust it.

## Connect the TV

- **Android TV app:** install the APK, then **hold OK** (or press Menu) → *Change server URL* →
  `http://192.168.1.20:8420` (a bare `192.168.1.20:8420` is assumed to be https, so type the `http://`).
  Or build the APK with your address baked in:
  `WT_SERVER_URL='http://192.168.1.20:8420/tv?app=1' android/build.sh` ([android/README.md](../android/README.md)).
  The server also offers the APK for download on its `/app` page if you place it at `android/out/woogles-tv.apk`
  (or pass `-apk`).
- **TV browser / laptop:** open `http://192.168.1.20:8420/tv`.
- **Cast:** only with option 1 above ([CAST.md](CAST.md)).

## Network caveats checklist

- **Same network:** phones and the TV must be able to reach the server. **Guest Wi-Fi** and **"AP/client
  isolation"** block devices from talking to each other. Put everyone on the main network or turn isolation off.
- **VLANs / IoT networks:** if your TV is on a separate VLAN, allow it to reach the server's port.
- **VPN on a phone:** a phone VPN may route `192.168.x.x` away from your LAN. Allow LAN access in the VPN app.
- **Mobile data:** a phone that drops off Wi-Fi onto mobile data can't reach a LAN-only server. It reconnects by
  itself when it's back on Wi-Fi.
- **Internet is only needed** to download the word lists on first start (or use `-fetch-only` on another machine, as
  above), for Cast, and for **word definitions** (looked up online when someone asks; without internet the
  phone just says the dictionary can't be reached). Fonts, QR codes and sounds are all served or generated locally.
- **Clock:** game clocks are timed on the server. A Pi without a real-time clock syncs the time over the network at
  boot (`systemd-timesyncd`); without internet, restarting the Pi in the middle of a timed game may confuse room
  expiry times, but not move timing.

## Playing away from home

Don't forward the port on your router to expose plain HTTP. To reach your home server from elsewhere, use
**Tailscale** (above) or a **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:8420`, with a hostname
on your Cloudflare domain; WebSockets work). Then set `PUBLIC_URL` to that HTTPS URL. Both give you HTTPS and keep
your router closed.
