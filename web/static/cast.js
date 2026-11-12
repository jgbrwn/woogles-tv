// Google Cast sender: lets a phone (Chrome on Android) put the TV board on a Chromecast /
// Google TV device. The receiver is our own /cast page, registered as a Custom Web Receiver.
export const NS = 'urn:x-cast:io.woogles.tv';
let ready = null;

// Resolves true when casting is possible on this browser and the server has a Cast App ID.
export function castAvailable() {
  if (ready) return ready;
  ready = (async () => {
    if (!/Chrome|CriOS/.test(navigator.userAgent) || /iPhone|iPad/.test(navigator.userAgent)) return false;
    let appId = '';
    try { appId = (await (await fetch('/api/config')).json()).castAppId; } catch {}
    if (!appId) return false;
    return new Promise((resolve) => {
      window.__onGCastApiAvailable = (ok) => {
        if (!ok) return resolve(false);
        cast.framework.CastContext.getInstance().setOptions({
          receiverApplicationId: appId,
          autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });
        resolve(true);
      };
      const s = document.createElement('script');
      s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      s.onerror = () => resolve(false);
      document.head.append(s);
      setTimeout(() => resolve(false), 8000);
    });
  })();
  return ready;
}

export function castSession() {
  try { return cast.framework.CastContext.getInstance().getCurrentSession(); } catch { return null; }
}

// Opens the Cast device picker (needs a user tap) and tells the TV which room to show.
export async function castRoom(code, tvKey) {
  if (!(await castAvailable())) throw new Error('Casting is not available in this browser');
  const ctx = cast.framework.CastContext.getInstance();
  let s = ctx.getCurrentSession();
  if (!s) {
    await ctx.requestSession();
    s = ctx.getCurrentSession();
  }
  await s.sendMessage(NS, { t: 'room', code, tvKey });
  return s.getCastDevice()?.friendlyName || 'TV';
}

export function stopCasting() { try { cast.framework.CastContext.getInstance().endCurrentSession(true); } catch {} }
