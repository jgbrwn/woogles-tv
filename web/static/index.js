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

// rejoin the last room this phone played in (within 3 days)
try {
  const last = JSON.parse(localStorage.getItem('wt_last') || 'null');
  if (last && Date.now() - last.at < 72 * 3600e3 && localStorage.getItem('wt_tok_' + last.code)) {
    $('rejoinCode').textContent = last.code; $('rejoinBtn').href = '/p/' + last.code; $('rejoinBtn').classList.remove('hidden');
  }
} catch {}

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
