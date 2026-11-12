import { buildBoard, paintBoard, lastPlaySquares, tileEl, el, esc, connect, toast, describeMove, applyTheme, paintTimer, sfx, THEME_NAMES } from './common.js';
import { confetti } from './confetti.js';
import { castAvailable, castRoom, castSession, NS } from './cast.js';

const $ = (s) => document.querySelector(s);
const code = location.pathname.split('/').pop().toUpperCase();
const tokKey = 'wt_tok_' + code, keyKey = 'wt_key_' + code;
// The join key arrives in the URL fragment (never sent to the server in HTTP requests or logs). Keep it, then hide it.
const frag = new URLSearchParams(location.hash.slice(1));
if (frag.get('k')) { localStorage.setItem(keyKey, frag.get('k')); history.replaceState(null, '', location.pathname); }
let recvAt = 0;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
let s = null;                 // latest server state
let cells = null, gameNo = -1, logLen = -1;
let rack = [];                // [{id, ch}] in display order; ch is 'A'..'Z' or '?'
let pending = new Map();      // "r,c" -> {id, l, blank}
let selected = null;          // rack tile id
let cursor = null;            // {r, c, vert}
let swapMode = false, swapSet = new Set();
let nextId = 1, lastPreview = null, wasMyTurn = false;

document.querySelectorAll('.code').forEach((n) => (n.textContent = code));
$('#name').value = localStorage.getItem('wt_name') || '';
$('#name').addEventListener('input', () => localStorage.setItem('wt_name', $('#name').value));

let ws = { send() {}, params: {} };
if (!localStorage.getItem(keyKey) && !localStorage.getItem(tokKey)) {
  show('noauth'); $('#noauthLink').href = '/?code=' + encodeURIComponent(code);
} else {
  ws = connect({ room: code, role: 'player', key: localStorage.getItem(keyKey) || '', token: localStorage.getItem(tokKey) || '' }, onMsg, (ok, fails) => {
    $('#conn').classList.toggle('hidden', ok || fails >= 4);
    if (!ok && fails >= 4 && !s) { show('noauth'); $('#noauthLink').href = '/?code=' + encodeURIComponent(code); }
  });
}

function onMsg(m) {
  if (m.t === 'state') render(m);
  else if (m.t === 'joined') { localStorage.setItem(tokKey, m.token); ws.params.token = m.token; }
  else if (m.t === 'error') { toast(m.msg, 'bad'); navigator.vibrate?.(80); }
  else if (m.t === 'preview') showPreview(m.preview);
  else if (m.t === 'notice') toast(m.msg, 'good');
  else if (m.t === 'event' && s) {
    const nm = s.seats?.[m.seat]?.name || '';
    if (m.kind === 'pause' && m.seat !== s.you) toast(`${nm} paused the clock`);
    if (m.kind === 'resume' && m.seat !== s.you) toast(`${nm} resumed the clock`, 'good');
    if (m.kind === 'resign' && m.seat !== s.you) toast(`${nm} resigned`);
  }
}

const myTurn = () => s && s.phase === 'playing' && s.you >= 0 && s.turn === s.you;
const names = () => s.seats.map((x, i) => x.name || `Player ${i + 1}`);

function show(id) { for (const x of ['lobby', 'game', 'noauth']) $('#' + x).classList.toggle('hidden', x !== id); }

let overDismissed = -1;
function render(st) {
  const prev = s; s = st; recvAt = performance.now();
  applyTheme(s.settings.theme);
  if (s.you < 0 || s.phase === 'lobby') { renderLobby(); show('lobby'); $('#over').classList.add('hidden'); if (s.phase === 'lobby') { gameNo = -1; } return; }
  if (s.phase === 'over') renderOver(prev); else $('#over').classList.add('hidden');
  // game board (also kept updated beneath the over screen)
  if (!cells || s.gameNo !== gameNo) {
    cells = buildBoard($('#board'), s.bonuses);
    gameNo = s.gameNo; logLen = -1; pending.clear(); rack = []; cursor = null;
    cells.flat().forEach((c) => c.addEventListener('click', () => onCellTap(+c.dataset.r, +c.dataset.c)));
  }
  const newLog = (s.log || []).length;
  if (newLog !== logLen) { pending.clear(); selected = null; cursor = null; swapMode = false; swapSet.clear(); lastPreview = null; logLen = newLog; }
  // drop pending tiles on squares that became occupied
  for (const [k] of pending) { const [r, c] = k.split(',').map(Number); if (s.board[r][c] !== '.') pending.delete(k); }
  reconcileRack(s.rack || '');
  paintBoard(cells, s.board, { last: new Set(lastPlaySquares(s.log)) });
  renderHeader();
  renderRack();
  renderPending();
  show('game');
  const mine = myTurn();
  if (prev && prev.gameNo === s.gameNo && prev.log && s.log.length > prev.log.length) {
    const b = s.log.slice(prev.log.length).find((m) => m.type === 'play' && m.bingo);
    if (b) celebrateBingo(b, names()[b.player], b.player === s.you);
  }
  if (mine && !wasMyTurn && prev) { navigator.vibrate?.([60, 60, 60]); sfx.turn(); }
  wasMyTurn = mine;
}

const TIME_LABEL = (m) => !m ? 'Off' : m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h${m % 60}` : `${m / 60}h`;
function renderLobby() {
  const seated = s.you >= 0;
  $('#seatedBox').classList.toggle('hidden', !seated);
  $('#tvBox').classList.toggle('hidden', !seated);
  $('#leaveBtn').classList.toggle('hidden', !seated);
  $('#joinBox').classList.toggle('hidden', seated);
  localStorage.setItem('wt_last', JSON.stringify({ code, at: Date.now() }));
  if (!seated) {
    const box = $('#seatBtns'); box.innerHTML = '';
    s.seats.forEach((seat, i) => {
      const b = el('button', 'seatBtn' + (seat.taken ? '' : ' open'));
      const av = `<span class="avatar p${i}">${seat.taken ? (seat.bot ? '🤖' : esc([...seat.name][0] || '?')) : i + 1}</span>`;
      if (!seat.taken) b.innerHTML = `${av}<span>Join as Player ${i + 1}<small>Seat open</small></span>`;
      else if (!seat.connected) b.innerHTML = `${av}<span>Take over ${esc(seat.name)}'s seat<small>Their phone disconnected</small></span>`;
      else { b.innerHTML = `${av}<span>${esc(seat.name)}<small>${seat.bot ? 'Computer' : 'Playing'}</small></span>`; b.disabled = true; }
      b.onclick = () => { sfx.ctx(); ws.send({ t: 'join', seat: i, name: $('#name').value.trim() || (seat.taken ? seat.name : '') }); };
      box.append(b);
    });
    return;
  }
  const me = s.seats[s.you], other = s.seats[1 - s.you];
  const av = (seat, i) => `<span class="avatar p${i}">${seat.bot ? '🤖' : esc([...(seat.name || '?')][0])}</span>`;
  $('#matchup').innerHTML = `<div class="m">${av(me, s.you)}<span>${esc(me.name)} (you)</span></div><span class="vs">VS</span>` +
    (other.taken ? `<div class="m">${av(other, 1 - s.you)}<span>${esc(other.name)}</span></div>` : `<div class="m"><span class="avatar" style="background:var(--line)">?</span><span class="muted">Waiting…</span></div>`);
  const st = s.settings;
  seg($('#lexSeg'), s.lexicons.map((l) => [l, l]), st.lexicon, (v) => ws.send({ t: 'settings', lexicon: v }));
  $('#lexHelp').textContent = st.lexicon === 'CSW24' ? 'Collins Scrabble Words — international' : 'NASPA Word List — North America';
  seg($('#timeSeg'), s.timeOptions.map((t) => [t, TIME_LABEL(t)]), st.timeMin, (v) => ws.send({ t: 'settings', timeMin: +v }));
  $('#timeHelp').textContent = st.timeMin ? `${st.timeMin} minutes each. Overtime costs 10 points per minute; more than 10 minutes over loses.` : 'No clock — take as long as you like.';
  renderThemes($('#themeRow'));
  const showBots = !other.taken || other.bot;
  $('#botField').classList.toggle('hidden', !showBots);
  if (showBots) {
    seg($('#botSeg'), s.bots.map((b) => [b.id, b.name.replace('Bot', '')]), st.bot, (v) => ws.send({ t: 'settings', bot: v }));
    const lv = s.bots.find((b) => b.id === st.bot);
    $('#botHelp').textContent = lv ? `${lv.name}: ${lv.desc}` : '';
  }
  renderTV();
  $('#startBtn').disabled = !other.taken;
  $('#startBtn').textContent = other.taken ? 'Start game' : 'Waiting for an opponent…';
  $('#botBtn').textContent = other.bot ? 'Remove computer' : '🤖 Play vs computer';
  $('#botBtn').classList.toggle('hidden', other.taken && !other.bot);
}
function seg(box, opts, cur, onPick) {
  const key = opts.map((o) => o[0]).join('|');
  if (box.dataset.k !== key) {
    box.dataset.k = key; box.innerHTML = '';
    for (const [v, label] of opts) { const b = el('button', '', label); b.dataset.v = v; b.onclick = () => onPick(v); box.append(b); }
  }
  [...box.children].forEach((b) => b.classList.toggle('on', b.dataset.v === String(cur)));
}
const SW = (t) => { const d = document.createElement('div'); d.dataset.theme = t; document.body.append(d); const cs = getComputedStyle(d);
  const v = ['--b-empty', '--b-tw', '--b-dl', '--t-bg'].map((k) => cs.getPropertyValue(k)); d.remove(); return v; };
function renderThemes(box) {
  if (box.children.length !== s.themes.length) {
    box.innerHTML = '';
    for (const t of s.themes) {
      const b = el('button'); b.dataset.t = t;
      b.innerHTML = `<span class="swatch">${SW(t).map((c) => `<i style="background:${c}"></i>`).join('')}</span>${THEME_NAMES[t] || t}`;
      b.onclick = () => { applyTheme(t); ws.send({ t: 'settings', theme: t }); };
      box.append(b);
    }
  }
  [...box.children].forEach((b) => b.classList.toggle('on', b.dataset.t === s.settings.theme));
}
// ---- casting (Chrome on Android -> Chromecast / Google TV) ----
const tvKey = localStorage.getItem('wt_tvkey_' + code);
let canCast = false;
if (tvKey) castAvailable().then((ok) => {
  canCast = ok; $('#castBtn').classList.toggle('hidden', !ok);
  if (ok && castSession()) castSession().sendMessage(NS, { t: 'room', code, tvKey }).catch(() => {});
});
async function doCast() {
  try { toast(`Casting to ${await castRoom(code, tvKey)}`, 'good'); } catch (e) { toast(e?.message || 'Casting was cancelled', 'bad'); }
}
$('#castBtn').onclick = doCast;

// ---- TV linking (phone-first games) & invites ----
function renderTV() {
  const on = s.tvs > 0;
  $('#tvState').innerHTML = on ? '<span class="dot on"></span> <b>On the TV</b> — the board is showing' : '<b>📺 Show this game on a TV</b>';
  $('#linkForm').classList.toggle('hidden', on);
  $('#linkHelp').classList.toggle('hidden', on);
}
$('#tvCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('#linkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('#tvCode').value.trim();
  if (c.length !== 6) { toast('Type the 6-letter code from the TV screen', 'bad'); return; }
  ws.send({ t: 'linktv', code: c });
});
$('#inviteBtn').onclick = () => {
  const url = s.joinUrl;
  openModal(`<h3>Invite the other player</h3><p class="muted" style="margin:0">Have them scan this with their phone camera</p>
    <img class="inviteQR" src="/qr?d=${encodeURIComponent(url)}" alt="QR code">
    <p class="muted" style="margin:0">or go to <b>${esc(location.host)}</b> and enter <b class="code">${esc(code)}</b></p>
    ${navigator.share ? '<button class="btn primary" id="shareBtn">Share link…</button>' : '<button class="btn primary" id="copyBtn">Copy link</button>'}`);
  $('#shareBtn')?.addEventListener('click', () => navigator.share({ title: 'Woogles-TV', text: 'Join my Woogles-TV game', url }).catch(() => {}));
  $('#copyBtn')?.addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast('Link copied', 'good')));
};
$('#botBtn').onclick = () => ws.send({ t: s.seats[1 - s.you].bot ? 'removebot' : 'addbot' });
$('#startBtn').onclick = () => { sfx.ctx(); ws.send({ t: 'start' }); };
$('#leaveBtn').onclick = () => { ws.send({ t: 'leave' }); localStorage.removeItem(tokKey); ws.params.token = ''; };

function renderHeader() {
  const n = names(), me = s.you, op = 1 - me;
  // you are always on the left
  [[me, '#pc0'], [op, '#pc1']].forEach(([seat, id]) => {
    const card = $(id), x = s.seats[seat];
    card.className = `pc p${seat}` + (s.phase === 'playing' && s.turn === seat ? ' turn' : '');
    card.querySelector('.avatar').textContent = x.bot ? '🤖' : ([...n[seat]][0] || '?');
    card.querySelector('.n').textContent = seat === me ? 'You' : n[seat];
    card.querySelector('.v').textContent = x.score;
  });
  tickClocks();
  const tm = $('#turnMsg');
  const paused = s.clock?.paused;
  tm.textContent = s.phase !== 'playing' ? 'Game over' : paused ? '⏸ Clock paused' : myTurn() ? 'Your turn' : `${n[op]}'s turn…`;
  tm.classList.toggle('mine', myTurn());
  const last = (s.log || []).filter((m) => ['play', 'pass', 'exchange'].includes(m.type)).at(-1);
  const d = last && describeMove(last, n);
  $('#bagMsg').textContent = (d ? `${last.player === me ? 'You' : n[op]}: ${d.text}${d.score ? ' ' + d.score : ''} · ` : '') + `${s.bag} in bag`;
  for (const id of ['#playBtn', '#passBtn', '#swapBtn']) $(id).disabled = !myTurn() || paused;
  $('#swapBtn').disabled = !myTurn() || paused || s.bag < 7;
}
function tickClocks() {
  if (!s || s.you < 0 || !s.seats) return;
  paintTimer($('#pc0 .timer'), s.clock, recvAt, s.you);
  paintTimer($('#pc1 .timer'), s.clock, recvAt, 1 - s.you);
}
setInterval(tickClocks, 250);

function reconcileRack(str) {
  const want = [...str];
  const keep = [];
  const pool = [...want];
  for (const t of rack) { const i = pool.indexOf(t.ch); if (i >= 0) { keep.push(t); pool.splice(i, 1); } }
  for (const ch of pool) keep.push({ id: nextId++, ch });
  rack = keep;
  const ids = new Set(rack.map((t) => t.id));
  for (const [k, p] of pending) if (!ids.has(p.id)) pending.delete(k);
}

function usedIds() { return new Set([...pending.values()].map((p) => p.id)); }

function renderRack() {
  const box = $('#rack'); box.innerHTML = '';
  const used = usedIds();
  for (let i = 0; i < 7; i++) {
    const slot = el('div', 'rslot'); slot.dataset.idx = i;
    const t = rack[i];
    if (t) {
      const tile = tileEl(t.ch); slot.append(tile); slot.dataset.id = t.id;
      if (used.has(t.id)) slot.classList.add('used');
      if (selected === t.id) slot.classList.add('sel');
      if (swapSet.has(t.id)) slot.classList.add('swap');
      attachDrag(tile, { from: 'rack', id: t.id });
    }
    box.append(slot);
  }
  $('#swapGo').textContent = `Swap ${swapSet.size}`;
}

function renderPending() {
  document.querySelectorAll('#board .tile.pending, #board .cursor').forEach((n) => n.remove());
  for (const [k, p] of pending) {
    const [r, c] = k.split(',').map(Number);
    const t = tileEl(p.l, { blank: p.blank, cls: 'pending' });
    attachDrag(t, { from: 'board', key: k });
    cells[r][c].append(t);
  }
  if (cursor && myTurn()) {
    const cur = el('div', 'cursor', cursor.vert ? '↓' : '→');
    cells[cursor.r][cursor.c].append(cur);
  }
}

function onTilesChanged() {
  renderRack(); renderPending();
  clearTimeout(onTilesChanged.t);
  onTilesChanged.t = setTimeout(sendPreview, 120);
}
function tilesPayload() { return [...pending].map(([k, p]) => { const [r, c] = k.split(',').map(Number); return { r, c, l: p.l, blank: p.blank }; }); }
function sendPreview() { if (myTurn()) ws.send({ t: 'preview', tiles: tilesPayload() }); else showPreview(null); }
function showPreview(p) {
  const n = $('#preview');
  if (!p || !p.tiles || !p.tiles.length || !pending.size) { n.textContent = myTurn() ? 'Tap a square, then tap tiles' : ''; n.className = 'err'; return; }
  if (p.score != null) { n.innerHTML = `<b>${p.score}</b> points`; n.className = 'score'; }
  else { n.textContent = p.err || ''; n.className = 'err'; }
}

async function place(r, c, id) {
  const t = rack.find((x) => x.id === id);
  if (!t || s.board[r][c] !== '.' || pending.has(r + ',' + c)) return false;
  let l = t.ch, blank = false;
  if (t.ch === '?') { l = await pickLetter(); if (!l) return false; blank = true; }
  pending.set(r + ',' + c, { id, l, blank });
  return true;
}

function advanceCursor() {
  if (!cursor) return;
  let { r, c } = cursor;
  do { if (cursor.vert) r++; else c++; } while (r < 15 && c < 15 && (s.board[r][c] !== '.' || pending.has(r + ',' + c)));
  cursor = r < 15 && c < 15 ? { r, c, vert: cursor.vert } : null;
}

async function onCellTap(r, c) {
  if (!myTurn() || swapMode || dragJustEnded) return;
  const k = r + ',' + c;
  if (pending.has(k)) { pending.delete(k); cursor = { r, c, vert: cursor?.vert ?? false }; onTilesChanged(); return; }
  if (s.board[r][c] !== '.') return;
  if (selected != null) {
    if (await place(r, c, selected)) { selected = null; cursor = { r, c, vert: cursor?.vert ?? false }; advanceCursor(); onTilesChanged(); }
    return;
  }
  if (cursor && cursor.r === r && cursor.c === c) cursor.vert = !cursor.vert;
  else cursor = { r, c, vert: cursor?.vert ?? false };
  renderPending();
}

async function onRackTap(id) {
  if (swapMode) { swapSet.has(id) ? swapSet.delete(id) : swapSet.add(id); renderRack(); return; }
  if (usedIds().has(id)) return;
  if (cursor && myTurn()) {
    if (await place(cursor.r, cursor.c, id)) { advanceCursor(); onTilesChanged(); }
    return;
  }
  if (selected === id) selected = null;
  else if (selected != null) { swapRack(selected, id); selected = null; }
  else selected = id;
  renderRack();
}
function swapRack(a, b) {
  const i = rack.findIndex((t) => t.id === a), j = rack.findIndex((t) => t.id === b);
  if (i >= 0 && j >= 0) [rack[i], rack[j]] = [rack[j], rack[i]];
}

// ---- drag & drop (pointer events) ----
let drag = null, dragJustEnded = false;
function attachDrag(tile, src) {
  tile.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = { src, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, tile };
    tile.setPointerCapture(e.pointerId);
  });
  tile.addEventListener('pointermove', (e) => {
    if (!drag || drag.tile !== tile) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.ghost = el('div', 'dragging'); drag.ghost.append(tile.cloneNode(true)); document.body.append(drag.ghost);
      tile.style.opacity = '.3';
    }
    drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px';
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    const cell = cellAt(e.clientX, e.clientY - 40);
    if (cell) cell.classList.add('drop-target');
  });
  const end = async (e) => {
    if (!drag || drag.tile !== tile) return;
    const d = drag; drag = null;
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    d.ghost?.remove(); tile.style.opacity = '';
    if (!d.moved) { // tap
      if (d.src.from === 'rack') onRackTap(d.src.id);
      else { const [r, c] = d.src.key.split(',').map(Number); onCellTap(r, c); }
      return;
    }
    dragJustEnded = true; setTimeout(() => (dragJustEnded = false), 50);
    if (e.type === 'pointercancel') return;
    const cell = cellAt(e.clientX, e.clientY - 40);
    const slot = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList?.contains('rslot'));
    const id = d.src.from === 'rack' ? d.src.id : pending.get(d.src.key)?.id;
    if (cell && myTurn() && !swapMode) {
      const r = +cell.dataset.r, c = +cell.dataset.c;
      if (s.board[r][c] === '.' && !pending.has(r + ',' + c)) {
        if (d.src.from === 'board') { const p = pending.get(d.src.key); pending.delete(d.src.key); pending.set(r + ',' + c, p); }
        else await place(r, c, id);
        selected = null; onTilesChanged(); return;
      }
    }
    if (d.src.from === 'board') pending.delete(d.src.key);
    if (slot && slot.dataset.id && +slot.dataset.id !== id) swapRack(id, +slot.dataset.id);
    onTilesChanged();
  };
  tile.addEventListener('pointerup', end);
  tile.addEventListener('pointercancel', end);
}
function cellAt(x, y) {
  return document.elementsFromPoint(x, y).find((n) => n.classList?.contains('cell') && n.closest('#board'));
}

// ---- actions ----
$('#shuffleBtn').onclick = () => {
  for (let i = rack.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rack[i], rack[j]] = [rack[j], rack[i]]; }
  renderRack();
};
$('#recallBtn').onclick = () => { pending.clear(); selected = null; onTilesChanged(); };
$('#playBtn').onclick = () => {
  if (!pending.size) { toast('Place some tiles first', 'bad'); return; }
  ws.send({ t: 'play', tiles: tilesPayload() });
};
$('#passBtn').onclick = () => { if (confirm('Pass your turn?')) ws.send({ t: 'pass' }); };
document.addEventListener('pointerdown', () => sfx.ctx(), { once: true });
$('#swapBtn').onclick = () => { pending.clear(); swapMode = true; swapSet.clear(); selected = null; $('#actions').classList.add('hidden'); $('#swapBar').classList.remove('hidden'); onTilesChanged(); };
const endSwap = () => { swapMode = false; swapSet.clear(); $('#actions').classList.remove('hidden'); $('#swapBar').classList.add('hidden'); renderRack(); };
$('#swapCancel').onclick = endSwap;
$('#swapGo').onclick = () => {
  if (!swapSet.size) return;
  const letters = rack.filter((t) => swapSet.has(t.id)).map((t) => t.ch).join('');
  ws.send({ t: 'exchange', letters }); endSwap();
};
$('#zoomBtn').onclick = () => $('#boardScroll').classList.toggle('zoom');
// ---- modal / blank picker ----
let modalResolve = null;
function openModal(html) { $('#mbody').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal(v) { $('#modal').classList.add('hidden'); modalResolve?.(v); modalResolve = null; }
$('#mclose').onclick = () => closeModal(null);
function pickLetter() {
  openModal(`<h3>Blank tile — pick a letter</h3><div class="letters">${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `<button data-l="${l}">${l}</button>`).join('')}</div>`);
  $('#mbody').querySelectorAll('button').forEach((b) => (b.onclick = () => closeModal(b.dataset.l)));
  return new Promise((res) => (modalResolve = res));
}

// ---- game over ----
function renderOver(prev) {
  if (overDismissed === s.gameNo) return;
  $('#over').classList.remove('hidden');
  if (prev && prev.phase === 'playing') { sfx.over(); navigator.vibrate?.([100, 50, 100]); }
  const n = names();
  const won = s.winner === s.you;
  $('#ovIcon').textContent = s.winner === -1 ? '🤝' : won ? '🏆' : '👏';
  $('#ovTitle').textContent = s.winner === -1 ? "It's a tie!" : won ? 'You win!' : `${n[s.winner]} wins`;
  const loser = s.winner >= 0 ? (s.winner === s.you ? n[1 - s.you] : 'You') : '';
  $('#ovReason').textContent = s.endReason === 'time' ? `${loser} went over 10 minutes of overtime` : s.endReason === 'resign' ? `${loser} resigned` : '';
  $('#ovScores').innerHTML = [s.you, 1 - s.you].map((i) => `<div class="${s.winner === i ? 'win' : ''}">${esc(i === s.you ? 'You' : n[i])}<b>${s.seats[i].score}</b></div>`).join('');
}
$('#rematchBtn').onclick = () => ws.send({ t: 'start' });
$('#lobbyBtn').onclick = () => ws.send({ t: 'end' });
$('#ovBoardBtn').onclick = () => { overDismissed = s.gameNo; $('#over').classList.add('hidden'); toast('Tap ☰ for rematch', '', 2000); };

function celebrateBingo(m, who, mine) {
  const box = $('#bingo');
  const word = (m.words?.[0] || '').toUpperCase();
  box.innerHTML = `<div class="bcard"><div class="btitle">BINGO!</div><div class="bword">${[...word].map((ch) => tileEl(ch).outerHTML).join('')}</div>
    <div class="bscore">+${m.score}</div><div class="bwho">${mine ? 'You played all 7 tiles!' : esc(who) + ' played all 7 tiles'}</div></div>` + confetti(40);
  box.classList.remove('hidden'); sfx.bingo(); navigator.vibrate?.([80, 40, 80, 40, 160]);
  clearTimeout(celebrateBingo.t); celebrateBingo.t = setTimeout(() => box.classList.add('hidden'), 3400);
}
$('#bingo').onclick = () => $('#bingo').classList.add('hidden');

// ---- menu ----
$('#menuBtn').onclick = () => {
  const playing = s.phase === 'playing', timed = !!s.clock;
  openModal(`<h3>Menu</h3><div class="menuList">
    <button class="btn" data-a="unseen">🔤 Unseen tiles</button>
    ${playing && timed ? `<button class="btn" data-a="pause">${s.clock.paused ? '▶ Resume clock' : '⏸ Pause clock'}</button>` : ''}
    ${s.tvs ? '' : '<button class="btn" data-a="tv">📺 Show on a TV</button>'}
    ${canCast ? '<button class="btn" data-a="cast">📡 Cast board to TV</button>' : ''}
    <button class="btn" data-a="invite">📨 Invite / room QR</button>
    <button class="btn" data-a="theme">🎨 Theme: ${THEME_NAMES[s.settings.theme]}</button>
    ${s.phase === 'over' ? '<button class="btn primary" data-a="results">🏆 Results / rematch</button>' : ''}
    ${playing ? '<button class="btn danger" data-a="resign">🏳 Resign</button>' : ''}
    <button class="btn danger" data-a="end">✖ End game for everyone</button></div>`);
  $('#mbody').querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
    const a = b.dataset.a; closeModal(null);
    if (a === 'unseen') showUnseen();
    else if (a === 'cast') doCast();
    else if (a === 'invite') $('#inviteBtn').click();
    else if (a === 'tv') linkPrompt();
    else if (a === 'pause') ws.send({ t: s.clock.paused ? 'resume' : 'pause' });
    else if (a === 'theme') { const th = s.themes; const nx = th[(th.indexOf(s.settings.theme) + 1) % th.length]; applyTheme(nx); ws.send({ t: 'settings', theme: nx }); }
    else if (a === 'results') { overDismissed = -1; renderOver(); }
    else if (a === 'resign' && confirm('Resign this game?')) ws.send({ t: 'resign' });
    else if (a === 'end' && confirm('End this game and go back to the lobby?')) ws.send({ t: 'end' });
  });
};
function linkPrompt() {
  openModal(`<h3>Show on a TV</h3><p class="muted" style="margin:0">Type the 6-letter code shown on the TV</p>
    <form id="mLink" class="linkRow"><input id="mTvCode" maxlength="6" placeholder="TV CODE" autocomplete="off" autocapitalize="characters"><button class="btn primary">Show</button></form>`);
  const inp = $('#mTvCode'); inp.focus();
  inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('#mLink').addEventListener('submit', (e) => { e.preventDefault(); ws.send({ t: 'linktv', code: inp.value.trim() }); closeModal(null); });
}
function showUnseen() {
  const u = s.unseen || {}; const keys = Object.keys(u).sort((a, b) => (a === '?') - (b === '?') || a.localeCompare(b));
  const total = Object.values(u).reduce((a, b) => a + b, 0);
  const vow = keys.filter((k) => 'AEIOU'.includes(k)).reduce((a, k) => a + u[k], 0);
  openModal(`<h3>Unseen tiles · ${total}</h3><p class="muted" style="margin:0">Bag + opponent's rack</p>
    <div class="unseenSum"><span>Vowels ${vow}</span><span>Consonants ${total - vow - (u['?'] || 0)}</span>${u['?'] ? `<span>Blanks ${u['?']}</span>` : ''}</div>
    <div class="unseen">${keys.map((k) => `<span>${tileEl(k).outerHTML}<b>${u[k]}</b></span>`).join('')}</div>`);
}

