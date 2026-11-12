import { buildBoard, paintBoard, lastPlaySquares, tileEl, el, connect, toast, describeMove } from './common.js';

const $ = (s) => document.querySelector(s);
const code = location.pathname.split('/').pop().toUpperCase();
const tokKey = 'wc_tok_' + code;
let s = null;                 // latest server state
let cells = null, gameNo = -1, logLen = -1;
let rack = [];                // [{id, ch}] in display order; ch is 'A'..'Z' or '?'
let pending = new Map();      // "r,c" -> {id, l, blank}
let selected = null;          // rack tile id
let cursor = null;            // {r, c, vert}
let swapMode = false, swapSet = new Set();
let nextId = 1, lastPreview = null, wasMyTurn = false;

document.querySelectorAll('.code').forEach((n) => (n.textContent = code));
$('#name').value = localStorage.getItem('wc_name') || '';
$('#name').addEventListener('input', () => localStorage.setItem('wc_name', $('#name').value));

const ws = connect({ room: code, role: 'player', token: localStorage.getItem(tokKey) || '' }, onMsg, (ok) => $('#conn').classList.toggle('hidden', ok));

function onMsg(m) {
  if (m.t === 'state') render(m);
  else if (m.t === 'joined') { localStorage.setItem(tokKey, m.token); ws.params.token = m.token; }
  else if (m.t === 'error') { toast(m.msg, 'bad'); navigator.vibrate?.(80); }
  else if (m.t === 'preview') showPreview(m.preview);
}

const myTurn = () => s && s.phase === 'playing' && s.you >= 0 && s.turn === s.you;
const names = () => s.seats.map((x, i) => x.name || `Player ${i + 1}`);

function show(id) { for (const x of ['lobby', 'game', 'over']) $('#' + x).classList.toggle('hidden', x !== id); }

function render(st) {
  const prev = s; s = st;
  if (s.you < 0 || s.phase === 'lobby') { renderLobby(); show('lobby'); if (s.phase === 'lobby') { gameNo = -1; } return; }
  if (s.phase === 'over') renderOver();
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
  paintBoard(cells, s.board, { last: lastPlaySquares(s.log) });
  renderHeader();
  renderRack();
  renderPending();
  if (s.phase === 'playing') show('game');
  const mine = myTurn();
  if (mine && !wasMyTurn && prev) { navigator.vibrate?.([60, 60, 60]); toast('Your turn!', 'good', 1500); }
  wasMyTurn = mine;
}

function renderLobby() {
  const box = $('#seatBtns'); box.innerHTML = '';
  const seated = s.you >= 0;
  $('#seatedBox').classList.toggle('hidden', !seated);
  $('#name').parentElement.classList.toggle('hidden', seated);
  if (!seated) {
    s.seats.forEach((seat, i) => {
      const b = el('button');
      if (!seat.taken) b.textContent = `Join as Player ${i + 1}`;
      else if (!seat.connected) b.textContent = `Take over ${seat.name}'s seat`;
      else { b.textContent = `${seat.name} (Player ${i + 1})`; b.disabled = true; }
      b.onclick = () => ws.send({ t: 'join', seat: i, name: $('#name').value.trim() || (seat.taken ? seat.name : '') });
      box.append(b);
    });
  } else {
    const other = s.seats[1 - s.you];
    $('#seatedMsg').innerHTML = `You're <b>${esc(s.seats[s.you].name)}</b>. ` + (other.taken ? `Playing against <b>${esc(other.name)}</b>.` : 'Waiting for an opponent to scan the TV…');
    const sel = $('#lexSel');
    if (sel.options.length !== s.lexicons.length) sel.innerHTML = s.lexicons.map((l) => `<option>${l}</option>`).join('');
    sel.value = s.lexicon;
    $('#startBtn').disabled = !other.taken;
    $('#botBtn').textContent = other.bot ? 'Remove computer' : '🤖 Play vs computer';
    $('#botBtn').classList.toggle('hidden', other.taken && !other.bot);
  }
}
$('#lexSel').onchange = (e) => ws.send({ t: 'lexicon', lexicon: e.target.value });
$('#botBtn').onclick = () => ws.send({ t: s.seats[1 - s.you].bot ? 'removebot' : 'addbot' });
$('#startBtn').onclick = () => ws.send({ t: 'start' });
$('#leaveBtn').onclick = () => { ws.send({ t: 'leave' }); localStorage.removeItem(tokKey); ws.params.token = ''; };

function renderHeader() {
  const n = names(), me = s.you, op = 1 - me;
  $('#scMe .n').textContent = n[me] + ' (you)'; $('#scMe .v').textContent = s.seats[me].score;
  $('#scOpp .n').textContent = n[op]; $('#scOpp .v').textContent = s.seats[op].score;
  $('#scMe').classList.toggle('turn', s.turn === me); $('#scOpp').classList.toggle('turn', s.turn === op);
  const tm = $('#turnMsg');
  tm.textContent = myTurn() ? 'Your turn' : `${n[op]}'s turn`;
  tm.classList.toggle('mine', myTurn());
  const last = (s.log || []).at(-1);
  $('#bagMsg').textContent = `${s.bag} in bag`;
  const d = last && describeMove(last, n);
  $('#lastMove').textContent = d ? `Last: ${last.player === me ? 'You' : n[op]} — ${d.text}${d.detail ? ' (' + d.detail + ')' : ''} · ${d.score}` : '';
  for (const id of ['#playBtn', '#passBtn', '#swapBtn']) $(id).disabled = !myTurn();
  $('#swapBtn').disabled = !myTurn() || s.bag < 7;
}

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
  if (p.score != null) { n.textContent = `${p.score} points`; n.className = ''; }
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
$('#swapBtn').onclick = () => { pending.clear(); swapMode = true; swapSet.clear(); selected = null; $('#actions').classList.add('hidden'); $('#swapBar').classList.remove('hidden'); onTilesChanged(); };
const endSwap = () => { swapMode = false; swapSet.clear(); $('#actions').classList.remove('hidden'); $('#swapBar').classList.add('hidden'); renderRack(); };
$('#swapCancel').onclick = endSwap;
$('#swapGo').onclick = () => {
  if (!swapSet.size) return;
  const letters = rack.filter((t) => swapSet.has(t.id)).map((t) => t.ch).join('');
  ws.send({ t: 'exchange', letters }); endSwap();
};
$('#zoomBtn').onclick = () => $('#boardScroll').classList.toggle('zoom');
$('#unseenBtn').onclick = () => {
  const u = s.unseen || {}; const keys = Object.keys(u).sort((a, b) => (a === '?') - (b === '?') || a.localeCompare(b));
  const total = Object.values(u).reduce((a, b) => a + b, 0);
  openModal(`<h3>Unseen tiles (${total})</h3><p class="muted">Bag + opponent's rack</p><div class="unseen">${keys.map((k) => `<span>${k}<b>${u[k]}</b></span>`).join('')}</div>`);
};

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
function renderOver() {
  show('over');
  const n = names();
  $('#ovTitle').textContent = s.winner === -1 ? "It's a tie!" : s.winner === s.you ? 'You win! 🎉' : `${n[s.winner]} wins`;
  $('#ovScores').innerHTML = s.seats.map((x, i) => `<div>${esc(n[i])}<b>${x.score}</b></div>`).join('');
}
$('#rematchBtn').onclick = () => ws.send({ t: 'start' });
$('#lobbyBtn').onclick = () => ws.send({ t: 'end' });

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
