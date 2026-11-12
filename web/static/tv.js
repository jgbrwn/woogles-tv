import { buildBoard, buildCoords, paintBoard, diffBoards, lastPlaySquares, el, esc, connect, toast, countUp, describeMove,
  applyTheme, paintTimer, sfx, THEME_NAMES } from './common.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const CAST = document.body.dataset.cast === '1';
const NS = 'urn:x-cast:io.woogles.tv';
let cells = null, prevBoard = null, gameNo = -1, state = {}, recvAt = 0, ws = null;
sfx.enabled = localStorage.getItem('wt_sound') !== 'off';

// ---- room bootstrap: reuse the room saved on this TV, else create one ----
async function getRoom() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('wt_tv') || 'null'); } catch {}
  if (saved && !params.has('new')) {
    try {
      const r = await fetch('/api/tv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: saved.code, tvKey: saved.tvKey }) });
      if (r.ok || r.status >= 500) return saved;
    } catch { return saved; }
  }
  for (;;) {
    const r = await fetch('/api/rooms', { method: 'POST' }).catch(() => ({ ok: false }));
    if (r.ok) {
      const j = await r.json();
      saved = { code: j.code, tvKey: j.tvKey };
      localStorage.setItem('wt_tv', JSON.stringify(saved));
      if (params.has('new')) history.replaceState(null, '', location.pathname + (params.has('app') ? '?app=1' : ''));
      return saved;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

function setQR(url) {
  if ($('#qr').dataset.u !== url) {
    const src = '/qr?d=' + encodeURIComponent(url);
    $('#qr').src = src; $('#qrMini').src = src; $('#qr').dataset.u = url;
  }
  document.querySelectorAll('.code').forEach((n) => (n.textContent = state.code));
  document.querySelectorAll('.host').forEach((n) => (n.textContent = location.host));
}

const initial = (n) => [...(n || '?').trim()][0] || '?';
const avatar = (name, i, bot) => `<span class="avatar p${i}">${bot ? '🤖' : esc(initial(name))}</span>`;

function render(s) {
  const prev = state; state = s; recvAt = performance.now();
  applyTheme(s.settings.theme);
  setQR(s.joinUrl);
  const names = s.seats.map((x, i) => x.name || `Player ${i + 1}`);
  const timeTxt = s.settings.timeMin ? `${s.settings.timeMin} min each` : 'untimed';

  // lobby
  $('#lobby').classList.toggle('hidden', s.phase !== 'lobby');
  $('#lobbySeats').innerHTML = s.seats.map((seat, i) => seat.taken
    ? `<div class="lseat">${avatar(seat.name, i, seat.bot)} <span>${esc(seat.name)}</span> <span class="dot ${seat.connected ? 'on' : ''}"></span></div>`
    : `<div class="lseat empty"><span class="avatar">${i + 1}</span> Seat open</div>`).join('');
  const ready = s.seats.every((x) => x.taken);
  $('#lobbyHint').textContent = ready ? `Ready! Press Start on a phone · ${s.settings.lexicon} · ${timeTxt}` : `Waiting for players… · ${s.settings.lexicon} · ${timeTxt}`;
  $('#lobbyHint').classList.toggle('ready', ready);
  if (s.phase === 'lobby') { prevBoard = null; return; }

  if (!cells || s.gameNo !== gameNo) {
    cells = buildBoard($('#board'), s.bonuses); buildCoords($('#coordTop'), $('#coordSide'));
    prevBoard = prev.gameNo === s.gameNo ? prevBoard : null; gameNo = s.gameNo;
  }
  const last = lastPlaySquares(s.log);
  const fresh = prevBoard ? diffBoards(prevBoard, s.board) : new Set();
  paintBoard(cells, s.board, { fresh, last: new Set(last), order: last });
  prevBoard = s.board;
  $('#meta').textContent = `${s.lexicon} · ${s.clock ? Math.round(s.clock.initialMs / 60000) + ' min' : 'untimed'}`;
  $('#pausedBanner').classList.toggle('hidden', !(s.phase === 'playing' && s.clock?.paused));

  // players
  const pl = $('#players');
  if (pl.children.length !== 2) {
    pl.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const c = el('div', `pcard p${i}`);
      c.innerHTML = `<span class="avatar"></span><div class="who"><div class="name"></div><div class="meta"></div></div><div class="right"><div class="score">0</div><div class="timer hidden"></div></div>`;
      pl.append(c);
    }
  }
  s.seats.forEach((seat, i) => {
    const card = pl.children[i];
    const onTurn = s.phase === 'playing' && s.turn === i;
    card.classList.toggle('turn', onTurn);
    card.querySelector('.avatar').textContent = seat.bot ? '🤖' : initial(names[i]);
    card.querySelector('.name').innerHTML = `${esc(names[i])} <span class="dot ${seat.connected ? 'on' : ''}"></span>`;
    card.querySelector('.meta').innerHTML = onTurn
      ? `<span class="turnTag thinking">${seat.bot ? 'Thinking' : 'On turn'}<i></i><i></i><i></i></span>`
      : `${seat.rackCount} tiles`;
    countUp(card.querySelector('.score'), seat.score);
  });
  tickClocks();
  $('#bagNum').textContent = s.bag;
  $('#bagBar div').style.width = Math.max(0, Math.min(100, (s.bag / 86) * 100)) + '%';

  renderLog(s, names, prev);

  // new move effects
  const grew = prev.log && s.log && prev.gameNo === s.gameNo && s.log.length > prev.log.length;
  if (grew) {
    for (const m of s.log.slice(prev.log.length)) {
      if (m.type === 'play') {
        sfx.play(fresh.size || 1);
        if (m.bingo) sfx.bingo();
        showScorePop(m, last);
      } else if (m.type === 'pass') { sfx.pass(); toast(`${names[m.player]} passed`); }
      else if (m.type === 'exchange') { sfx.pass(); toast(`${names[m.player]} exchanged ${m.count}`); }
    }
  }

  // game over
  const wasOver = prev.phase === 'over';
  $('#over').classList.toggle('hidden', s.phase !== 'over');
  if (s.phase === 'over') {
    if (!wasOver && prev.phase) setTimeout(() => sfx.over(), 900);
    $('#trophy').textContent = s.winner === -1 ? '🤝' : '🏆';
    $('#winner').textContent = s.winner === -1 ? "It's a tie!" : `${names[s.winner]} wins!`;
    const loser = s.winner >= 0 ? names[1 - s.winner] : '';
    $('#reason').textContent = s.endReason === 'time' ? `${loser} went more than 10 minutes over time`
      : s.endReason === 'resign' ? `${loser} resigned` : `Final score · ${s.lexicon}`;
    $('#finals').innerHTML = s.seats.map((seat, i) => `<div class="final${s.winner === i ? ' win' : ''}">${avatar(names[i], i, seat.bot)}
      <div class="n">${esc(names[i])}</div><div class="s">${seat.score}</div>
      <div class="r">${s.endReason ? '' : seat.rack ? 'Left: ' + esc(seat.rack) : 'Went out'}</div></div>`).join('');
  }
}

function renderLog(s, names, prev) {
  const log = $('#log');
  const entries = (s.log || []);
  const n = entries.length;
  const prevN = prev.gameNo === s.gameNo && prev.log ? prev.log.length : n;
  log.innerHTML = '';
  entries.slice(-14).reverse().forEach((m, k) => {
    const d = describeMove(m, names);
    const li = el('li', (m.bingo ? 'bingo ' : '') + (d.quiet ? 'quiet ' : '') + (k === 0 && n > prevN ? 'newest' : ''));
    li.innerHTML = `${avatar(names[m.player], m.player, s.seats[m.player]?.bot)}<div class="w">${esc(d.text)} ${d.detail ? `<span class="d">${esc(d.detail)}</span>` : ''}</div>
      <div class="s">${d.score > 0 ? '+' : ''}${d.score}</div><div class="t">${m.type === 'time' || m.type === 'adjust' ? '' : m.total}</div>`;
    log.append(li);
  });
}

function showScorePop(m, squares) {
  const pop = $('#scorePop');
  const k = squares[squares.length - 1];
  if (!k || !cells) return;
  const [r, c] = k.split(',').map(Number);
  const rect = cells[r][c].getBoundingClientRect();
  pop.className = m.bingo ? 'bingo' : '';
  pop.textContent = m.bingo ? `BINGO! +${m.score}` : `+${m.score}`;
  pop.style.left = Math.min(window.innerWidth * 0.55, Math.max(rect.left + rect.width / 2, 100)) + 'px';
  pop.style.top = Math.max(rect.top - rect.height, 60) + 'px';
  void pop.offsetWidth; pop.classList.remove('hidden');
  clearTimeout(showScorePop.t); showScorePop.t = setTimeout(() => pop.classList.add('hidden'), 2500);
}

function tickClocks() {
  const s = state;
  if (!s.seats || s.phase === 'lobby') return;
  const pl = $('#players');
  s.seats.forEach((_, i) => { const t = pl.children[i]?.querySelector('.timer'); if (t) paintTimer(t, s.clock, recvAt, i); });
}
setInterval(tickClocks, 250);

// ---- options menu (works with a TV remote: arrows + OK) ----
let menuIdx = 0;
const menuItems = () => [...document.querySelectorAll('#menu .mitem:not(.hidden)')];
function openMenu() {
  $('#mTheme').textContent = THEME_NAMES[state.settings?.theme] || '';
  $('#mSound').textContent = sfx.enabled ? 'On' : 'Off';
  $('#mApp').classList.toggle('hidden', !window.WooglesTV?.openMenu);
  $('#menu').classList.remove('hidden'); menuIdx = 0; focusMenu();
}
function focusMenu() { const it = menuItems(); it.forEach((b, i) => b.classList.toggle('focus', i === menuIdx)); it[menuIdx]?.focus(); }
function closeMenu() { $('#menu').classList.add('hidden'); }
function menuAct(act) {
  if (act === 'theme') {
    const th = state.themes || Object.keys(THEME_NAMES);
    const next = th[(th.indexOf(state.settings.theme) + 1) % th.length];
    ws.send({ t: 'settings', theme: next });
    $('#mTheme').textContent = THEME_NAMES[next];
  } else if (act === 'sound') {
    sfx.enabled = !sfx.enabled; localStorage.setItem('wt_sound', sfx.enabled ? 'on' : 'off');
    $('#mSound').textContent = sfx.enabled ? 'On' : 'Off'; sfx.turn();
  } else if (act === 'newroom') {
    if (confirm('Start a new room? Phones will need to scan the new QR code.')) { localStorage.removeItem('wt_tv'); location.href = '/tv?new=1' + (params.has('app') ? '&app=1' : ''); }
  } else if (act === 'app') { closeMenu(); window.WooglesTV?.openMenu(); }
  else closeMenu();
}
document.querySelectorAll('#menu .mitem').forEach((b) => b.addEventListener('click', () => menuAct(b.dataset.act)));
document.addEventListener('keydown', (e) => {
  sfx.ctx(); $('#soundHint').classList.add('hidden');
  const open = !$('#menu').classList.contains('hidden');
  if (!open) {
    if (['Enter', ' ', 'm', 'M', 'ContextMenu'].includes(e.key)) { e.preventDefault(); openMenu(); }
    return;
  }
  const it = menuItems();
  if (e.key === 'ArrowDown') { menuIdx = (menuIdx + 1) % it.length; focusMenu(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { menuIdx = (menuIdx - 1 + it.length) % it.length; focusMenu(); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); menuAct(it[menuIdx].dataset.act); }
  else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'GoBack') { e.preventDefault(); closeMenu(); }
});
document.addEventListener('pointerdown', () => { sfx.ctx(); $('#soundHint').classList.add('hidden'); });
let mouseT;
document.addEventListener('mousemove', () => { document.body.classList.add('mouse'); clearTimeout(mouseT); mouseT = setTimeout(() => document.body.classList.remove('mouse'), 3000); });

async function roomGone(room) {
  try {
    const r = await fetch('/api/tv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(room) });
    if (r.status === 404) { localStorage.removeItem('wt_tv'); location.reload(); }
  } catch {} // server unreachable: keep retrying the socket
}

function startRoom(room) {
  if (ws) ws.close();
  cells = null; prevBoard = null; gameNo = -1; state = { code: room.code }; $('#players').innerHTML = '';
  $('#castWait')?.classList.add('hidden');
  ws = connect({ room: room.code, role: 'tv', key: room.tvKey }, (m) => {
    if (m.t === 'state') render(m);
    else if (m.t === 'event') {
      const nm = state.seats?.[m.seat]?.name || '';
      if (m.kind === 'rejected') { toast(`${nm}: ${m.msg}`, 'bad'); sfx.bad(); }
      else if (m.kind === 'pause') toast(`${nm} paused the clock`);
      else if (m.kind === 'resume') toast(`${nm} resumed the clock`, 'good');
      else if (m.kind === 'start') { sfx.turn(); }
    }
  }, (ok, fails) => {
    $('#conn').classList.toggle('hidden', ok);
    if (!CAST && !ok && fails >= 3 && fails % 3 === 0) roomGone(room); // room may have expired: make a new one
  });
}

// Chromecast / Google TV receiver: the phone that cast us sends {t:'room', code, tvKey}.
function startCastReceiver() {
  const ctx = cast.framework.CastReceiverContext.getInstance();
  let current = '';
  ctx.addCustomMessageListener(NS, (ev) => {
    const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    if (d?.t === 'room' && d.code && d.tvKey && d.code !== current) { current = d.code; startRoom({ code: d.code, tvKey: d.tvKey }); }
  });
  const opts = new cast.framework.CastReceiverOptions();
  opts.disableIdleTimeout = true;
  opts.skipPlayersLoad = true;
  opts.maxInactivity = 3600;
  opts.customNamespaces = { [NS]: cast.framework.system.MessageType.JSON };
  ctx.start(opts);
}

(async () => {
  if (CAST) {
    $('#lobby').classList.add('hidden'); $('#castWait').classList.remove('hidden');
    document.querySelector('[data-act="newroom"]').classList.add('hidden');
    sfx.enabled = true;
    startCastReceiver();
    return;
  }
  startRoom(await getRoom());
  setTimeout(() => { if (sfx.enabled && !sfx.ready()) { sfx.ctx(); if (!sfx.ready()) $('#soundHint').classList.remove('hidden'); } }, 1500);
  try { await navigator.wakeLock?.request('screen'); } catch {}
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) try { await navigator.wakeLock?.request('screen'); } catch {} });
})();
