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
const castBtn = document.getElementById('castBtn');
castAvailable().then((ok) => castBtn.classList.toggle('hidden', !ok));
castBtn.addEventListener('click', async () => {
  castBtn.disabled = true;
  try {
    const r = await fetch('/api/rooms', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not create a game');
    localStorage.setItem('wt_tvkey_' + j.code, j.tvKey);
    const dev = await castRoom(j.code, j.tvKey);
    toast(`Casting to ${dev}`, 'good');
    location.href = `/p/${j.code}#k=${encodeURIComponent(j.joinKey)}`;
  } catch (e) {
    toast(e?.message || 'Casting was cancelled', 'bad');
  } finally { castBtn.disabled = false; }
});
