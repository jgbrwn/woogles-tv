import { toast } from './common.js';
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
void toast;
