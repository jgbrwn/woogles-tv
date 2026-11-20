// Splash: the Woogles-TV tile wave, once each time the app (or a tab) is opened, over the page while it loads. On the
// TV that is a fresh start of the TV app or tab: its own reloads (a new room, the starting-up screen, the app's retry
// after an error) keep the session, so they skip it. Not on Chromecast, which shows its own loading screen.
// It stays for one wave (1.8 s) or until the page has loaded, whichever is later (4 s at most), and a tap skips it.
// Loaded in <head>, before the page paints; the markup is #splash at the top of <body>, the styles are in app.css.
(function () {
  if (location.pathname === '/cast') return;
  var de = document.documentElement, t0 = Date.now(), show = false;
  try { show = !sessionStorage.getItem('wt_splash'); sessionStorage.setItem('wt_splash', '1'); } catch (e) {}
  if (!show) return;
  if (!de.dataset.home) { try { var t = localStorage.getItem('wt_theme'); if (t) de.dataset.theme = t; } catch (e) {} }
  de.classList.add('splashing');
  var min = matchMedia('(prefers-reduced-motion: reduce)').matches ? 600 : 1800, done = false;
  function hide() {
    if (done) return;
    done = true;
    var s = document.getElementById('splash');
    if (!s) { de.classList.remove('splashing'); return; }
    s.classList.add('out');
    setTimeout(function () { de.classList.remove('splashing'); }, 450);
  }
  function loaded() { setTimeout(hide, Math.max(0, min - (Date.now() - t0))); }
  if (document.readyState === 'complete') loaded(); else addEventListener('load', loaded);
  setTimeout(hide, 4000);
  // Any remote key skips it, and only does that (it doesn't also open the menu behind it).
  addEventListener('keydown', function (e) { if (!done) { e.preventDefault(); e.stopImmediatePropagation(); hide(); } }, true);
  addEventListener('pointerdown', function (e) { if (e.target.closest && e.target.closest('#splash')) hide(); }, true);
})();
