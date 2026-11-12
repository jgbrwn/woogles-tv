# Casting the board from a phone (Google Cast)

Like spelunkr.tv, a phone can put the board on any Chromecast / Google TV (the Onn 4K box has
Chromecast built in) without installing an app on the TV.

How it works: `/cast` is the TV page running as a Google Cast **Custom Web Receiver**. On a phone, Chrome
(Android) shows **"Cast a new game to your TV"** on the home page, or **"Cast board to TV"** in the
lobby/menu. The phone creates the room, launches the receiver on the TV, and tells it which room to show
(code + TV key over the private Cast channel `urn:x-cast:io.woogles.tv`). The second player scans the
QR code on the TV as usual.

Limits: casting from a web page works in **Chrome on Android** (and desktop Chrome). iPhones can't
cast a web page; iPhone players just scan the QR once the TV shows it.

## One-time setup (owner)
1. Go to https://cast.google.com/publish, sign in, pay the one-time **US $5** developer registration.
2. **Add New Application → Custom Receiver.** Name: `Woogles-TV`.
   Receiver Application URL: `https://woogles-tv.exe.xyz/cast`
3. Copy the **Application ID** (8 characters) and put it on the server:
   ```
   echo 'CAST_APP_ID=ABCD1234' > ~/woogles-tv/deploy/woogles-tv.env
   sudo systemctl restart woogles-tv
   ```
4. While the app is unpublished it only runs on registered devices: **Add New Device** with the Onn
   box's serial number (Settings → System → About → Status, or on the box's label), then
   restart the box (wait ~15 minutes after registering). Or click **Publish** so any Cast device can
   run it; it only loads our own page, so publishing is harmless.
5. On an Android phone, open https://woogles-tv.exe.xyz/ in Chrome. The Cast button appears.
