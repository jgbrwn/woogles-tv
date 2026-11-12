import { buildBoard, paintBoard, diffBoards, lastPlaySquares, tileEl, el, connect, toast, countUp, describeMove } from './common.js';

const $ = (s) => document.querySelector(s);
let cells = null, prev = null, gameNo = -1, ghosts = [];

async function getRoom() {
  const q = new URLSearchParams(location.search);
  let code = q.get('room') || (q.has('new') ? null : localStorage.getItem('wc_tv_room'));
  if (code) {
    const r = await fetch('/api/rooms/' + code);
    if (!r.ok) code = null;
  }
  if (!code) {
    const r = await fetch('/api/rooms', { method: 'POST' });
    code = (await r.json()).code;
  }
  localStorage.setItem('wc_tv_room', code);
  return code;
}

function setQR(url) {
  const src = '/qr?d=' + encodeURIComponent(url);
  if ($('#qr').dataset.u !== url) { $('#qr').src = src; $('#qrMini').src = src; $('#qr').dataset.u = url; }
  document.querySelectorAll('.code').forEach((n) => (n.textContent = state.code));
  $('.url').textContent = url.replace(/^https?:\/\//, '');
}

let state = {};
function render(s) {
  const prevState = state; state = s;
  setQR(s.joinUrl);
  const names = s.seats.map((x, i) => x.name || `Player ${i + 1}`);

  // lobby
  $('#lobby').classList.toggle('hidden', s.phase !== 'lobby');
  const ls = $('#lobbySeats'); ls.innerHTML = '';
  s.seats.forEach((seat, i) => {
    const d = el('div', 'lseat' + (seat.taken ? '' : ' empty'));
    d.innerHTML = seat.taken ? `<span class="dot ${seat.connected ? 'on' : ''}"></span> ${esc(seat.name)}` : `Player ${i + 1} — open`;
    ls.append(d);
  });
  $('#lobbyHint').textContent = s.seats.every((x) => x.taken) ? `Ready! Press Start on a phone (${s.lexicon})` : 'Waiting for players…';

  if (s.phase === 'lobby') { prev = null; return; }

  if (!cells || s.gameNo !== gameNo) { cells = buildBoard($('#board'), s.bonuses); prev = null; gameNo = s.gameNo; }
  const fresh = prev ? diffBoards(prev, s.board) : new Set();
  paintBoard(cells, s.board, { fresh, last: lastPlaySquares(s.log) });
  prev = s.board;
  drawGhosts(s.preview);

  // players
  const pl = $('#players');
  if (pl.children.length !== 2) { pl.innerHTML = ''; for (let i = 0; i < 2; i++) pl.append(el('div', 'pcard')); }
  s.seats.forEach((seat, i) => {
    const card = pl.children[i];
    card.classList.toggle('turn', s.phase === 'playing' && s.turn === i);
    if (!card.firstChild) card.innerHTML = `<div><div class="name"></div><div class="meta"></div></div><div class="score">0</div>`;
    card.querySelector('.name').innerHTML = `<span class="dot ${seat.connected ? 'on' : ''}"></span> ${esc(names[i])}`;
    card.querySelector('.meta').innerHTML = s.phase === 'playing' && s.turn === i ? '<span class="turnTag">▶ thinking…</span>' : `${seat.rackCount} tiles`;
    countUp(card.querySelector('.score'), seat.score);
  });
  $('#bag').textContent = s.bag;
  $('#lex').textContent = s.lexicon;

  // log
  const log = $('#log'); log.innerHTML = '';
  (s.log || []).slice(-12).forEach((m) => {
    const d = describeMove(m, names);
    const li = el('li', m.bingo ? 'bingo' : '');
    li.innerHTML = `<div><span class="w">${esc(d.text)}</span> <span class="d">${esc(d.who)}${d.detail ? ' · ' + d.detail : ''}</span></div><div class="s">${d.score > 0 ? '+' : ''}${d.score}</div>`;
    log.prepend(li);
  });

  // events derived from new log entries
  if (prevState.log && s.log && s.log.length > prevState.log.length && prevState.gameNo === s.gameNo) {
    const m = s.log[s.log.length - 1];
    if (m.type === 'play' && m.bingo) toast(`BINGO! ${m.words?.[0] || ''} +${m.score}`, 'good big-toast', 3500);
    else if (m.type === 'play') toast(`${names[m.player]}: ${(m.words?.[0] || '').toUpperCase()} for ${m.score}`, '', 2500);
  }

  // game over
  $('#over').classList.toggle('hidden', s.phase !== 'over');
  if (s.phase === 'over') {
    $('#winner').textContent = s.winner === -1 ? "It's a tie!" : `${names[s.winner]} wins!`;
    const f = $('#finals'); f.innerHTML = '';
    s.seats.forEach((seat, i) => {
      const d = el('div', 'final' + (s.winner === i ? ' win' : ''));
      d.innerHTML = `<div class="n">${esc(names[i])}</div><div class="s">${seat.score}</div><div class="r">${seat.rack ? 'left: ' + esc(seat.rack) : 'went out'}</div>`;
      f.append(d);
    });
  }
}

function drawGhosts(p) {
  ghosts.forEach((g) => g.remove()); ghosts = [];
  const badge = $('#previewBadge');
  if (!p || !p.tiles || !p.tiles.length || !cells) { badge.classList.add('hidden'); return; }
  for (const t of p.tiles) {
    const g = tileEl(t.l, { blank: t.blank, cls: 'ghost' });
    cells[t.r][t.c].append(g); ghosts.push(g);
  }
  badge.classList.remove('hidden');
  badge.textContent = p.score != null ? `${p.score} pts?` : '…';
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  const code = await getRoom();
  state = { code };
  connect({ room: code, role: 'tv' }, (m) => {
    if (m.t === 'state') render(m);
    else if (m.t === 'preview') { state.preview = m.preview; drawGhosts(m.preview); }
    else if (m.t === 'event' && m.kind === 'rejected') toast(m.msg, 'bad');
    else if (m.t === 'event' && m.kind === 'pass') toast(`${state.seats?.[m.seat]?.name} passed`);
    else if (m.t === 'event' && m.kind === 'exchange') toast(`${state.seats?.[m.seat]?.name} swapped tiles`);
  }, (ok) => $('#conn').classList.toggle('hidden', ok));
  try { await navigator.wakeLock?.request('screen'); } catch {}
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) try { await navigator.wakeLock?.request('screen'); } catch {} });
})();
