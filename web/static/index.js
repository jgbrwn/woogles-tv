import { toast } from './common.js';
import { castAvailable, castRoom } from './cast.js';
const q = new URLSearchParams(location.search);
const input = document.getElementById('code');
if (q.get('code')) input.value = q.get('code').toUpperCase();
input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z]/g, ''); });
document.getElementById('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = input.value.trim().toUpperCase();
  const err = document.getElementById('err');
  if (code.length < 4) { err.textContent = 'Enter the code shown on the TV'; return; }
  err.textContent = '';
  try {
    const r = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!r.ok) { err.textContent = j.error || 'Could not join'; return; }
    location.href = `/p/${j.code}#k=${encodeURIComponent(j.key)}`;
  } catch { err.textContent = 'Network error — try again'; }
});
const $ = (q) => document.getElementById(q);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

async function newRoom() {
  const r = await fetch('/api/rooms', { method: 'POST' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Could not create a game');
  localStorage.setItem('wt_tvkey_' + j.code, j.tvKey); // lets this phone cast the room later
  return j;
}
async function startNew() {
  $('newBtn').disabled = true;
  try { const j = await newRoom(); location.href = `/p/${j.code}#k=${encodeURIComponent(j.joinKey)}`; }
  catch (e) { toast(e.message, 'bad'); $('newBtn').disabled = false; }
}
$('newBtn').addEventListener('click', startNew);
if (q.has('new')) startNew();

// "Your games": every room this phone has a seat token (or join key) for, with live status.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const IDLE = 3 * 24 * 3600e3; // in-progress games untouched this long count as abandoned
let gameRows = [], filter = localStorage.getItem('wt_games_filter') || 'active';
const forget = (code) => { for (const p of ['tok', 'key', 'tvkey']) localStorage.removeItem(`wt_${p}_${code}`); };
const isDone = ({ summary: sm, seat }) => sm.phase === 'over' || seat < 0 || Date.now() - sm.updated > IDLE;

async function loadGames() {
  const codes = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const m = /^wt_(tok|key)_([A-Z]+)$/.exec(localStorage.key(i));
    if (m) codes.add(m[2]);
  }
  if (!codes.size) { gameRows = []; drawGames(); return; }
  const items = [...codes].slice(0, 30).map((code) => ({ code, token: localStorage.getItem('wt_tok_' + code) || '', key: localStorage.getItem('wt_key_' + code) || '' }));
  let res;
  try { res = await (await fetch('/api/summaries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })).json(); } catch { return; }
  // games the server no longer has (expired or removed) drop off automatically
  for (const r of res) if (r.gone) forget(r.code);
  gameRows = res.filter((r) => !r.gone && !(r.summary.phase === 'lobby' && r.seat < 0));
  drawGames();
}
function drawGames() {
  const act = gameRows.filter((r) => !isDone(r)), done = gameRows.filter(isDone);
  const fb = document.querySelectorAll('#gamesFilter button');
  fb[0].querySelector('span').textContent = act.length ? `(${act.length})` : '';
  fb[1].querySelector('span').textContent = done.length ? `(${done.length})` : '';
  fb.forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  const rows = (filter === 'active' ? act : done).sort((a, b) =>
    (b.summary.turn === b.seat && b.seat >= 0) - (a.summary.turn === a.seat && a.seat >= 0) || b.summary.updated - a.summary.updated);
  const box = $('gamesList'); box.innerHTML = '';
  for (const { summary: sm, seat } of rows) {
    const a = document.createElement('a'); a.className = 'g'; a.href = '/p/' + sm.code;
    const nm = sm.names.map((n, i) => (i === seat ? 'You' : n || 'open seat'));
    const mine = seat >= 0 && sm.turn === seat && sm.phase === 'playing';
    const stale = sm.phase === 'playing' && Date.now() - sm.updated > IDLE;
    const tag = sm.phase === 'over' ? `<span class="tag">${seat < 0 ? 'Finished' : sm.winner === seat ? 'You won' : sm.winner === -1 ? 'Tie' : 'You lost'}</span>`
      : stale || (seat < 0 && sm.phase === 'playing') ? '<span class="tag old">Abandoned</span>'
      : mine ? '<span class="tag turn">Your turn</span>' : sm.phase === 'playing' ? '<span class="tag live">In progress</span>' : '<span class="tag">Lobby</span>';
    a.innerHTML = `<div><div class="n">${tag}${esc(nm[0])} vs ${esc(nm[1])}</div><div class="m">${sm.lexicon} · code ${sm.code} · ${ago(sm.updated)}${seat < 0 ? ' · watching' : ''}</div></div>
      <div class="rt"><span class="sc">${sm.phase === 'lobby' ? '' : `${sm.scores[0]}–${sm.scores[1]}`}</span><button class="x" type="button" title="Remove from this list" aria-label="Remove">✕</button></div>`;
    a.querySelector('.x').onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const live = sm.phase === 'playing' && seat >= 0 && !stale;
      if (live && !confirm(`Remove ${nm[0]} vs ${nm[1]} from your list?\nYou won't be able to get back into this game from this phone.`)) return;
      forget(sm.code); gameRows = gameRows.filter((r) => r.summary.code !== sm.code); drawGames();
    };
    box.append(a);
  }
  $('gamesHint').textContent = filter === 'done' && rows.length ? '✕ removes a game from this phone only.' : '';
  $('myGames').classList.toggle('hidden', !gameRows.length);
}
document.querySelectorAll('#gamesFilter button').forEach((b) => b.onclick = () => { filter = b.dataset.f; localStorage.setItem('wt_games_filter', filter); drawGames(); });
loadGames();
// refresh when coming back to the app
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadGames(); });

// appearance (home screen only; games keep their own theme)
const look = () => localStorage.getItem('wt_home_look') || 'auto';
const drawLook = () => document.querySelectorAll('#lookSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === look()));
document.querySelectorAll('#lookSeg button').forEach((b) => b.onclick = () => { localStorage.setItem('wt_home_look', b.dataset.v); window.wtHomeLook?.(); drawLook(); });
drawLook();

// PWA install prompt (Android Chrome)
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('installBtn').classList.add('hidden'); });

const castBtn = document.getElementById('castBtn');
castAvailable().then((ok) => castBtn.classList.toggle('hidden', !ok));
castBtn.addEventListener('click', async () => {
  castBtn.disabled = true;
  try {
    const j = await newRoom();
    const dev = await castRoom(j.code, j.tvKey);
    toast(`Casting to ${dev}`, 'good');
    location.href = `/p/${j.code}#k=${encodeURIComponent(j.joinKey)}`;
  } catch (e) {
    toast(e?.message || 'Casting was cancelled', 'bad');
  } finally { castBtn.disabled = false; }
});
