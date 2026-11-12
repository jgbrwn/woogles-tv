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
async function loadGames() {
  const codes = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i), m = /^wt_(tok|key)_([A-Z]+)$/.exec(k);
    if (m) codes.add(m[2]);
  }
  if (!codes.size) return;
  const items = [...codes].slice(0, 12).map((code) => ({ code, token: localStorage.getItem('wt_tok_' + code) || '', key: localStorage.getItem('wt_key_' + code) || '' }));
  let res;
  try { res = await (await fetch('/api/summaries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })).json(); } catch { return; }
  const rows = [];
  for (const r of res) {
    if (r.gone) { for (const p of ['tok', 'key', 'tvkey']) localStorage.removeItem(`wt_${p}_${r.code}`); continue; }
    rows.push(r);
  }
  rows.sort((a, b) => (b.summary.turn === b.seat && b.seat >= 0) - (a.summary.turn === a.seat && a.seat >= 0) || b.summary.updated - a.summary.updated);
  const box = $('gamesList'); box.innerHTML = '';
  for (const { summary: sm, seat } of rows) {
    if (sm.phase === 'lobby' && seat < 0) continue;
    const a = document.createElement('a'); a.className = 'g'; a.href = '/p/' + sm.code;
    const nm = sm.names.map((n, i) => (i === seat ? 'You' : n || 'open seat'));
    const mine = seat >= 0 && sm.turn === seat;
    const tag = mine ? '<span class="tag turn">Your turn</span>' : sm.phase === 'playing' ? '<span class="tag live">In progress</span>'
      : sm.phase === 'over' ? `<span class="tag">${sm.winner === seat ? 'You won' : sm.winner === -1 ? 'Tie' : 'Finished'}</span>` : '<span class="tag">Lobby</span>';
    a.innerHTML = `<div><div class="n">${tag}${esc(nm[0])} vs ${esc(nm[1])}</div><div class="m">${sm.lexicon} · code ${sm.code} · ${ago(sm.updated)}${seat < 0 ? ' · watching' : ''}</div></div>
      <div class="sc">${sm.phase === 'lobby' ? '' : `${sm.scores[0]}–${sm.scores[1]}`}</div>`;
    box.append(a);
  }
  $('myGames').classList.toggle('hidden', !box.children.length);
}
loadGames();

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
