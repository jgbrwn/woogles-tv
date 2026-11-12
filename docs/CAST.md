# Casting the board from a phone (Google Cast)

A phone running Chrome can put the board on any Chromecast or Google TV device (most Google TVs, including the Onn 4K,
have Chromecast built in) without installing anything on the TV.

**How it works:** `/cast` is the TV page running as a Google Cast **Custom Web Receiver**. In Chrome on Android, the
home page shows **📡 Start a game & cast it to a TV**, and games have **☰ → Cast board to TV**. The phone creates or
uses the room, launches the receiver on the TV, and tells it which room to show (the room code plus its TV key, over the
private Cast channel `urn:x-cast:io.woogles.tv`). The second player scans the QR code on the TV as usual.

**Limits:** only **Chrome on Android and desktop Chrome** can cast a web page. iPhones can't, but iPhone players can
still join by scanning the QR code once the board is on the TV. The receiver page and the server must be reachable
over **HTTPS with a publicly trusted certificate**, from the Chromecast, which uses Google's DNS rather than your
router's. For a home server, see [LOCAL-NETWORK.md](LOCAL-NETWORK.md#http-or-https).

The Cast buttons appear only when the server has a `CAST_APP_ID`; without one, Woogles-TV hides them.

## One-time setup (server owner)

1. Go to the [Google Cast SDK Developer Console](https://cast.google.com/publish), sign in, and pay the one-time
   **US $5** registration fee.
2. **Add New Application → Custom Receiver.** Name it, e.g., `Woogles-TV`.
   Receiver Application URL: `https://your-server/cast`
3. Copy the **Application ID** (8 characters) and give it to the server as `CAST_APP_ID`:
   - systemd: `sudo systemctl edit woogles-tv` → `[Service]` `Environment=CAST_APP_ID=ABCD1234`, or put
     `CAST_APP_ID=ABCD1234` in the unit's `EnvironmentFile`, then restart.
   - Docker: `-e CAST_APP_ID=ABCD1234` (or in `docker-compose.yml`).
4. While the app is **unpublished**, it only runs on devices you register: **Add New Device** with the Cast device's
   serial number (on Google TV: Settings → System → About → Status, or on the device's label), then reboot the device
   (allow about 15 minutes after registering). Alternatively, click **Publish** so that any Cast device can run it. The
   receiver only loads your own page, so publishing is harmless.
5. On an Android phone, open `https://your-server/` in Chrome. The Cast buttons appear.

## Technical notes

- The receiver is `web/tv.html` served at `/cast` with the Cast Application Framework (CAF) receiver SDK injected
  and a Content-Security-Policy that allows `https://www.gstatic.com` and framing by the Cast runtime.
- The sender code is [`web/static/cast.js`](../web/static/cast.js). It loads the Cast sender SDK only when a
  `CAST_APP_ID` is configured.
- The phone sends the receiver the room's **TV key**; the receiver can only display that room, never play in it.
