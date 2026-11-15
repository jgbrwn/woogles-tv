// Background music on the TV: an internet radio station from the server's list (WT_MUSIC_STREAMS), played by the
// TV itself through a plain <audio> element (the audio never passes through our server). The room's settings say
// when it plays: Always, Breaks (lobby, paused clock, game over) or Off. It fades down while the announcer talks
// and comes back up afterwards, and plays a little quieter while a game is on so players can think.
// Its loudness follows the TV's Volume setting (Volume: Off silences it too).
import { sfx } from './common.js';
import { appConfig } from './announcer.js';

export const MUSIC_MODES = ['always', 'breaks', 'off'];
export const MUSIC_MODE_NAMES = { always: 'Always', breaks: 'Breaks', off: 'Off' };
export const MUSIC_VOLS = ['low', 'med', 'high'];
export const MUSIC_VOL_NAMES = { low: 'Low', med: 'Medium', high: 'High' };
const LEVEL = { low: 0.2, med: 0.4, high: 0.65 }; // share of the TV's volume
const IN_PLAY = 0.7;  // during a game (mode Always)
const DUCK = 0.15;    // while the announcer talks
const NOW_EVERY = 20000;

let conf = null; // {stations: [{name, url}], nowPlaying}
export const musicReady = appConfig.then((c) => { if (c?.music?.stations?.length) conf = c.music; });
export const musicStations = () => (conf ? conf.stations : []);

// The room's music settings, with defaults for rooms saved before music existed.
export function musicSettings(settings = {}) {
  const n = musicStations().length;
  const station = Number.isInteger(settings.station) && settings.station >= 0 && settings.station < n ? settings.station : 0;
  return { mode: MUSIC_MODES.includes(settings.music) ? settings.music : 'always', station,
    vol: MUSIC_VOLS.includes(settings.musicVol) ? settings.musicVol : 'med' };
}
export const isBreak = (st) => st.phase !== 'playing' || !!st.clock?.paused;

// ann: the TV's announcer (for ducking). onNow(info|null): what's playing, for the "now playing" card;
// info = {station, title, artist, song, cover}. onBlocked(): the browser wants a key press before playing sound.
export function makeMusic(ann, { onNow = () => {}, onBlocked = () => {} } = {}) {
  const a = new Audio();
  a.preload = 'none';
  let wantUrl = '', level = 0, stIdx = 0, loaded = '', cur = 0, duckUntil = 0, retryAt = 0, fails = 0, blocked = false;
  let nowTimer = null, nowFor = '', last = null;

  const stopEl = () => { a.pause(); a.removeAttribute('src'); a.load(); loaded = ''; blocked = false; showNow(false); };
  const startEl = (url) => {
    loaded = url; cur = 0; a.volume = 0; a.src = url;
    a.play().then(() => { blocked = false; showNow(true); }).catch((e) => {
      if (loaded !== url) return;
      if (e && e.name === 'NotAllowedError') { blocked = true; onBlocked(); } else failed();
    });
  };
  // Stream errors (station down, network): try again later, waiting longer each time (up to a minute).
  const failed = () => {
    if (!loaded) return;
    stopEl(); fails++;
    retryAt = performance.now() + Math.min(60000, 5000 * 2 ** Math.min(fails - 1, 4));
  };
  a.addEventListener('error', () => { if (a.getAttribute('src')) failed(); });
  a.addEventListener('ended', failed); // a live stream "ends" when the connection drops
  a.addEventListener('playing', () => { fails = 0; });

  // Now playing: asked every 20 s while the music is on.
  function showNow(on) {
    clearTimeout(nowTimer); nowTimer = null;
    const st = musicStations()[stIdx];
    if (!on || !st) { nowFor = ''; onNow(null); return; }
    const key = loaded;
    if (nowFor !== key) { nowFor = key; onNow({ station: st.name }); }
    if (!conf.nowPlaying) return;
    const idx = stIdx;
    const poll = async () => {
      try {
        const r = await fetch(`/api/music/now?s=${idx}`);
        if (r.ok && nowFor === key) onNow({ station: st.name, ...(await r.json()) });
      } catch {}
      if (nowFor === key) nowTimer = setTimeout(poll, NOW_EVERY);
    };
    poll();
  }

  setInterval(() => {
    if (!conf) return;
    const now = performance.now();
    if (loaded && loaded !== wantUrl) { // switching off or to another station: fade out first
      cur *= 0.7; a.volume = cur;
      if (cur < 0.005) stopEl();
      return;
    }
    if (!loaded) {
      if (wantUrl && now >= retryAt) startEl(wantUrl);
      return;
    }
    if (blocked) return;
    if (ann.soon()) duckUntil = now + 600;
    const target = sfx.gain * level * (now < duckUntil ? DUCK : 1);
    // Down quickly (the announcer is about to talk), back up slowly.
    cur += (target - cur) * (target < cur ? 0.35 : 0.06);
    if (Math.abs(target - cur) < 0.002) cur = target;
    a.volume = Math.max(0, Math.min(1, cur));
  }, 50);

  document.addEventListener('visibilitychange', () => M.update());
  const M = {
    // Call with every room state; without one, re-checks the last (after the TV's volume changes).
    update(st = last) {
      last = st;
      if (!conf || !st?.settings) return;
      const s = musicSettings(st.settings), station = musicStations()[s.station], brk = isBreak(st);
      const on = !!station && s.mode !== 'off' && (s.mode === 'always' || brk) && sfx.enabled && !document.hidden && !st.review?.open; // quiet during a game review
      level = LEVEL[s.vol] * (brk ? 1 : IN_PLAY);
      if (s.station !== stIdx || !on) retryAt = 0;
      stIdx = s.station;
      wantUrl = on ? station.url : '';
    },
    // After a key press or click: the browser now allows sound.
    kick() { if (blocked && loaded) a.play().then(() => { blocked = false; showNow(true); }).catch(() => {}); },
    get blocked() { return blocked; },
    get playing() { return !!loaded && !blocked; },
  };
  return M;
}
