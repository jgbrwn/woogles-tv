import { buildBoard, buildCoords, paintBoard, diffBoards, lastPlaySquares, el, esc, connect, toast, countUp, describeMove,
  applyTheme, paintTimer, sfx, THEME_NAMES, tileEl, clockAlerts, SOUND_NAMES } from './common.js';
import { makeAnnouncer, announcerReady, definitionSpeech, speechMemory, describeForSpeech, gameOverSpeech, clockSpeech, sayName, ANN_MODE_NAMES, SPELL_NAMES, RATE_NAMES } from './announcer.js';
import { confetti } from './confetti.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const CAST = document.body.dataset.cast === '1';
const NS = 'urn:x-cast:io.woogles.tv';
let cells = null, prevBoard = null, gameNo = -1, state = {}, recvAt = 0, ws = null;
sfx.load('high', 'wt_sound');
let currentRoom = null;
// The TV's own room credentials let it use the server voice (POST /api/tts).
const ann = makeAnnouncer('wt_tv_', 'all', () => (currentRoom ? { code: currentRoom.code, tvKey: currentRoom.tvKey } : null));
announcerReady.then(() => { if (!$('#menu').classList.contains('hidden')) paintSoundMenu(); sendPrefs(); });
let speechCtx = {};
const alertsTick = clockAlerts(onClockAlert);

// ---- room bootstrap: reuse the room saved on this TV, else create one ----
async function getRoom() {
  let saved = null;
  // /tv#room=CODE&tv=TVKEY pins this screen to a room (links printed by -demo)
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('room') && h.get('tv')) {
    localStorage.setItem('wt_tv', JSON.stringify({ code: h.get('room').toUpperCase(), tvKey: h.get('tv') }));
    history.replaceState(null, '', location.pathname + location.search);
  }
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
        if (m.bingo) setTimeout(() => celebrateBingo(m, names[m.player]), 700);
        else showScorePop(m, last);
      } else if (m.type === 'pass') { sfx.pass(); toast(`${names[m.player]} passed`); }
      else if (m.type === 'exchange') { sfx.pass(); toast(`${names[m.player]} exchanged ${m.count}`); }
    }
    if (ann.on('moves')) {
      const lines = describeForSpeech(s.log.slice(prev.log.length), s, names, ann, speechCtx);
      ann.later(() => lines.forEach((l) => ann.say(l)), s.log.slice(prev.log.length).some((m) => m.bingo) ? 1300 : 650);
    }
  }
  if (prev.gameNo !== s.gameNo || !prev.log) speechCtx = speechMemory(s);

  // game over
  const wasOver = prev.phase === 'over';
  $('#over').classList.toggle('hidden', s.phase !== 'over');
  if (s.phase === 'over') {
    if (!wasOver && prev.phase) {
      setTimeout(() => sfx.over(), 900);
      if (ann.on('moves')) ann.later(() => ann.say(gameOverSpeech(s, names)), 1900);
    }
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
  // Chronological like the phone and Woogles.io: oldest at the top, newest at the bottom, scrolled to the end.
  const shown = entries.slice(-40);
  shown.forEach((m, k) => {
    const d = describeMove(m, names);
    const li = el('li', (m.bingo ? 'bingo ' : '') + (d.quiet ? 'quiet ' : '') + (k === shown.length - 1 && n > prevN ? 'newest ' : '') + ((n - shown.length + k) % 2 ? '' : 'alt'));
    li.innerHTML = `${avatar(names[m.player], m.player, s.seats[m.player]?.bot)}<div class="w">${esc(d.text)} ${d.detail ? `<span class="d">${esc(d.detail)}</span>` : ''}</div>
      <div class="s">${d.score > 0 ? '+' : ''}${d.score}</div><div class="t">${m.type === 'time' || m.type === 'adjust' ? '' : m.total}</div>`;
    log.append(li);
  });
  log.scrollTop = log.scrollHeight;
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

function celebrateBingo(m, who) {
  const box = $('#bingo');
  const word = (m.words?.[0] || '').toUpperCase();
  box.innerHTML = `<div class="bcard"><div class="btitle">BINGO!</div><div class="bword">${[...word].map((ch) => tileEl(ch).outerHTML).join('')}</div>
    <div class="bscore">+${m.score}</div><div class="bwho">${esc(who)} played all 7 tiles</div></div>` + confetti(90);
  box.classList.remove('hidden'); sfx.bingo();
  clearTimeout(celebrateBingo.t); celebrateBingo.t = setTimeout(() => box.classList.add('hidden'), 3400);
}

function tickClocks() {
  const s = state;
  if (!s.seats || s.phase === 'lobby') return;
  const pl = $('#players');
  s.seats.forEach((_, i) => { const t = pl.children[i]?.querySelector('.timer'); if (t) paintTimer(t, s.clock, recvAt, i); });
}
setInterval(() => { tickClocks(); if (state.phase === 'playing') alertsTick(state.clock, recvAt, state.gameNo); }, 250);
function onClockAlert(seat, kind, n) {
  const name = state.seats?.[seat]?.name || '';
  if (kind === 'count') { sfx.count(n); return; }
  if (kind === '5min' || kind === '1min') sfx.warn();
  else if (kind === 'overtime' || kind === 'lastmin') sfx.overtime();
  else if (kind === 'overmin') sfx.penalty();
  if (kind === 'overtime') toast(`${name} is in overtime: −10 points per minute`, 'bad');
  else if (kind === 'lastmin') toast(`${name}: one minute until a loss on time`, 'bad');
  if (ann.on('all')) ann.later(() => ann.say(clockSpeech(kind, n, name)), 500);
}

// ---- options menu (works with a TV remote: arrows + OK) ----
let menuIdx = 0;
const menuItems = () => [...document.querySelectorAll('#menu .mitem:not(.hidden)')];
function openMenu() {
  $('#mTheme').textContent = THEME_NAMES[state.settings?.theme] || '';
  paintSoundMenu();
  $('#mApp').classList.toggle('hidden', !window.WooglesTV?.openMenu);
  $('#menu').classList.remove('hidden'); menuIdx = 0; focusMenu();
}
function paintSoundMenu() {
  sendPrefs();
  $('#mSound').textContent = SOUND_NAMES[sfx.level];
  const can = ann.available();
  $('#mAnnItem').classList.toggle('hidden', !can);
  $('#mAnn').textContent = ANN_MODE_NAMES[ann.mode];
  $('#mAnnNote').classList.toggle('hidden', ann.mode === 'off' || !sfx.enabled);
  document.querySelectorAll('#menu .annOpt').forEach((b) => b.classList.toggle('hidden', !can || ann.mode === 'off' || !sfx.enabled));
  $('#mVoice').textContent = ann.hasServer() ? ann.voiceName() : ann.backupName();
  // With server voices, the device voice is only the backup; without them it is the voice.
  const backups = ann.hasServer() && ann.hasDevice() && ann.deviceVoices().length > 0;
  $('#mBackupItem').classList.toggle('hidden', !backups || !can || ann.mode === 'off' || !sfx.enabled);
  $('#mBackup').textContent = ann.backupName();
  $('#mSpell').textContent = SPELL_NAMES[ann.spell];
  $('#mRate').textContent = RATE_NAMES[ann.rate] || 'Normal';
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
    sfx.cycle(); paintSoundMenu(); sfx.turn();
  } else if (act === 'ann') {
    ann.cycleMode(); ann.stop(); paintSoundMenu();
    if (ann.mode !== 'off') ann.say(ann.mode === 'all' ? 'Announcing moves, scores and the clock.' : 'Announcing moves.');
  } else if (act === 'voice') {
    if (ann.hasServer()) ann.cycleVoice(); else ann.cycleBackup();
    ann.stop(); paintSoundMenu(); ann.say("Hi! I'll be your announcer.");
  } else if (act === 'backup') { ann.cycleBackup(); ann.stop(); paintSoundMenu(); ann.sayOnDevice("This is the backup voice, used if the server voice can't be reached."); }
  else if (act === 'spell') { ann.cycleSpell(); paintSoundMenu(); ann.stop(); ann.say(ann.spell === 'never' ? 'Words will not be spelled out.' : `Zoea. Z, O, E, A.`); }
  else if (act === 'rate') { ann.cycleRate(); paintSoundMenu(); ann.stop(); ann.say(`${sayName('STEEBot')} plays quixotic, for 98 points.`); } else if (act === 'newroom') { closeMenu(); newRoomHere(); toast('New game — earlier games are under OK → Games on this TV'); }
  else if (act === 'games') openGames(); else if (act === 'app') { closeMenu(); window.WooglesTV?.openMenu(); }
  else closeMenu();
}
document.querySelectorAll('#menu .mitem').forEach((b) => b.addEventListener('click', () => menuAct(b.dataset.act)));
document.addEventListener('keydown', (e) => {
  sfx.ctx(); $('#soundHint').classList.add('hidden'); setTimeout(sendPrefs, 300);
  if (pendingSwitch) {
    const yes = $('#switchYes'), no = $('#switchNo');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const t = document.activeElement === yes ? no : yes; t.focus(); yes.classList.toggle('focus', t === yes); no.classList.toggle('focus', t === no); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (document.activeElement === no ? no : yes).click(); }
    else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); no.click(); }
    return;
  }
  if (!$('#gamesMenu').classList.contains('hidden')) {
    const n = gamesRows.length, r = gamesRows[gamesIdx];
    if (e.key === 'ArrowDown') { gamesIdx = (gamesIdx + 1) % n; gamesCol = 0; focusGames(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { gamesIdx = (gamesIdx - 1 + n) % n; gamesCol = 0; focusGames(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { if (r?.x) { gamesCol = 1; focusGames(); } e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { gamesCol = 0; focusGames(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (gamesCol === 1 && r?.x ? r.x : r?.main)?.click(); }
    else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); $('#gamesMenu').classList.add('hidden'); }
    return;
  }
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
document.addEventListener('pointerdown', () => { sfx.ctx(); $('#soundHint').classList.add('hidden'); setTimeout(sendPrefs, 300); });
let mouseT;
document.addEventListener('mousemove', () => { document.body.classList.add('mouse'); clearTimeout(mouseT); mouseT = setTimeout(() => document.body.classList.remove('mouse'), 3000); });

async function roomGone(room) {
  try {
    const r = await fetch('/api/tv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(room) });
    if (r.status === 404) { localStorage.removeItem('wt_tv'); location.reload(); }
  } catch {} // server unreachable: keep retrying the socket
}

// ---- rooms this TV has shown (for "Games on this TV") ----
const RECENT = 'wt_tv_recent';
function recentRooms() { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } }
function rememberRoom(room) {
  const list = recentRooms().filter((x) => x.code !== room.code);
  list.unshift({ code: room.code, tvKey: room.tvKey, at: Date.now() });
  localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 10)));
}
async function newRoomHere() {
  const r = await fetch('/api/rooms', { method: 'POST' }).catch(() => null);
  if (!r || !r.ok) { toast('Could not start a new game — try again', 'bad'); return; }
  const j = await r.json();
  const room = { code: j.code, tvKey: j.tvKey };
  if (!CAST) localStorage.setItem('wt_tv', JSON.stringify(room));
  startRoom(room);
}

const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
let gamesRows = [], gamesIdx = 0, gamesCol = 0;
function forgetRoom(code) { localStorage.setItem(RECENT, JSON.stringify(recentRooms().filter((x) => x.code !== code))); }
async function openGames() {
  closeMenu();
  const list = recentRooms();
  const box = $('#gamesList');
  box.innerHTML = '<div class="hint">Loading…</div>';
  $('#gamesMenu').classList.remove('hidden');
  let res = null;
  try {
    const r = await fetch('/api/summaries', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list.slice(0, 12).map((x) => ({ code: x.code, tvKey: x.tvKey })) }) });
    if (r.ok) res = await r.json();
  } catch {}
  if (res) {
    // games the server no longer has (expired or removed) drop off automatically
    const gone = new Set(res.filter((r) => r.gone).map((r) => r.code));
    localStorage.setItem(RECENT, JSON.stringify(list.filter((x) => !gone.has(x.code))));
  }
  const rows = recentRooms().map((x) => ({ x, sm: res?.find((r) => r.code === x.code)?.summary })).filter((r) => r.sm);
  const on = (r) => r.x.code === currentRoom?.code;
  rows.sort((a, b) => on(b) - on(a) || b.sm.updated - a.sm.updated);
  box.innerHTML = '';
  gamesRows = [];
  for (const { x, sm } of rows) {
    const empty = sm.phase === 'lobby' && !sm.names.some(Boolean);
    if (empty && !on({ x })) continue; // unused lobbies just clutter the list
    const row = el('div', 'grow');
    const b = el('button', 'mitem gitem');
    const who = empty ? 'Waiting for players' : sm.names.map((n) => n || 'open seat').join(' vs ');
    const tag = on({ x }) ? '<span class="tag now">On screen</span>'
      : sm.phase === 'playing' ? '<span class="tag live">In progress</span>' : sm.phase === 'over' ? '<span class="tag">Finished</span>' : '<span class="tag">Lobby</span>';
    const sc = sm.phase === 'lobby' ? '' : `${sm.scores[0]}–${sm.scores[1]}`;
    b.innerHTML = `<div><div class="gn">${tag}${esc(who)}</div><div class="gs">${sm.lexicon} · ${sm.moves} moves · code ${sm.code} · ${ago(sm.updated)}</div></div><div class="gsc">${sc}</div>`;
    b.onclick = () => { $('#gamesMenu').classList.add('hidden'); if (!on({ x })) { if (!CAST) localStorage.setItem('wt_tv', JSON.stringify(x)); startRoom(x); toast('Switched games', 'good'); } };
    row.append(b);
    let xb = null;
    if (!on({ x })) {
      xb = el('button', 'mitem gx', '✕');
      xb.title = 'Remove from this TV';
      xb.onclick = () => {
        if (!xb.classList.contains('armed')) { xb.classList.add('armed'); xb.textContent = 'Remove?'; return; }
        forgetRoom(x.code); row.remove(); gamesRows = gamesRows.filter((r) => r.main !== b); gamesIdx = Math.min(gamesIdx, gamesRows.length - 1); gamesCol = 0; focusGames();
        toast('Removed from this TV');
      };
      row.append(xb);
    }
    box.append(row);
    gamesRows.push({ main: b, x: xb });
  }
  for (const [label, fn] of [['＋ New game (new QR code)', () => newRoomHere()], ['Close', () => {}]]) {
    const nb = el('button', 'mitem', label);
    nb.onclick = () => { $('#gamesMenu').classList.add('hidden'); fn(); };
    box.append(nb); gamesRows.push({ main: nb, x: null });
  }
  gamesIdx = 0; gamesCol = 0; focusGames();
}
function focusGames() {
  document.querySelectorAll('#gamesList .mitem').forEach((n) => n.classList.remove('focus'));
  document.querySelectorAll('#gamesList .gx.armed').forEach((n) => { if (n !== gamesRows[gamesIdx]?.x || gamesCol === 0) { n.classList.remove('armed'); n.textContent = '✕'; } });
  const r = gamesRows[gamesIdx]; if (!r) return;
  const t = gamesCol === 1 && r.x ? r.x : r.main;
  t.classList.add('focus'); t.focus(); t.scrollIntoView({ block: 'nearest' });
}

// Tell the room whether this TV will speak, so a phone asking for a definition knows whether to speak it itself.
// Tell the server whether this TV will actually speak; phones in the game stay quiet while it does.
// The server voice needs unlocked audio (a key press on some TVs); device speech doesn't.
let sentVoice = null;
function sendPrefs(force) {
  const voice = ann.mode !== 'off' && sfx.enabled && (ann.hasDevice() || (ann.hasServer() && sfx.ready()));
  if (!ws || (!force && voice === sentVoice)) return;
  sentVoice = voice; ws.send({ t: 'tvprefs', voice });
}

// A phone double-tapped a word in its scorecard: show the definition, and say it once the TV is quiet.
let defTimer = null;
function showDefinition(ev) {
  const names = (state.seats || []).map((x, i) => x.name || `Player ${i + 1}`);
  const card = $('#defCard'), senses = ev.senses || [];
  card.className = `p${ev.player}`;
  card.innerHTML = `<div class="dw"><b>${esc(ev.word)}</b><span>${esc(names[ev.player] || '')} · ${esc(ev.pos || '')} · ${ev.score} pts</span></div>` +
    (senses.length ? `<ol>${senses.slice(0, 3).map((x) => `<li>${x.pos ? `<i>${esc(x.pos)}</i>` : ''}${esc(x.text)}</li>`).join('')}</ol>`
      : `<div class="none">No definition found for this word.</div>`) +
    `<small>${ev.by ? esc(ev.by) + ' asked · ' : ''}${esc(ev.lexicon || '')}</small>`;
  const speak = ann.mode !== 'off' && ann.available() && sfx.enabled;
  const text = definitionSpeech(ev, names, ann);
  clearTimeout(defTimer);
  const hide = () => { defTimer = setTimeout(() => card.classList.add('hidden'), 12000); };
  if (speak) { ann.sayWhenQuiet(text, 2000); waitSpoken(hide); } else hide();
  card.classList.remove('hidden');
}
// keep the card up while the definition is (about to be) spoken
function waitSpoken(done) { let t = 0; const iv = setInterval(() => { t += 500; if ((!ann.busy() && t > 3000) || t > 60000) { clearInterval(iv); done(); } }, 500); }

// "New game! Alex versus Steebot. NWL23, 30 minutes each. Alex goes first. Good luck!"
function announceStart() {
  if (!ann.on('all') || !state.seats) return;
  const n = state.seats.map((x) => sayName(x.name));
  const lex = { NWL23: 'N W L 23', CSW24: 'C S W 24' }[state.lexicon] || state.lexicon || '';
  const time = state.clock ? `, ${Math.round(state.clock.initialMs / 60000)} minutes each` : '';
  const first = state.seats[state.turn] ? ` ${n[state.turn]} goes first.` : '';
  ann.say(`New game! ${n[0]} versus ${n[1]}. ${lex}${time}.${first} Good luck!`);
}

function startRoom(room) {
  currentRoom = room; rememberRoom(room);
  if (ws) ws.close();
  cells = null; prevBoard = null; gameNo = -1; state = { code: room.code }; $('#players').innerHTML = '';
  $('#castWait')?.classList.add('hidden');
  ws = connect({ room: room.code, role: 'tv', key: room.tvKey }, (m) => {
    if (m.t === 'state') render(m);
    else if (m.t === 'switch') onSwitch(m);
    else if (m.t === 'event') {
      const nm = state.seats?.[m.seat]?.name || '';
      if (m.kind === 'rejected') { toast(`${nm}: ${m.msg}`, 'bad'); sfx.bad(); }
      else if (m.kind === 'pause') { toast(`${nm} paused the clock`); if (ann.on('all')) ann.say('Clock paused.'); }
      else if (m.kind === 'resume') { toast(`${nm} resumed the clock`, 'good'); if (ann.on('all')) ann.say('Clock resumed.'); }
      else if (m.kind === 'start') { sfx.turn(); setTimeout(announceStart, 400); }
      else if (m.kind === 'define') showDefinition(m);
    }
  }, (ok, fails) => {
    if (ok) sendPrefs(true);
    $('#conn').classList.toggle('hidden', ok);
    if (!CAST && !ok && fails >= 3 && fails % 3 === 0) roomGone(room); // room may have expired: make a new one
  });
}

// A phone that started its own game asked to be shown on this TV (it typed our TV code).
let pendingSwitch = null;
function onSwitch(m) {
  const go = () => {
    const room = { code: m.code, tvKey: m.tvKey };
    if (!CAST) localStorage.setItem('wt_tv', JSON.stringify(room));
    $('#switchAsk').classList.add('hidden'); pendingSwitch = null;
    toast(`Showing ${m.from}'s game`, 'good');
    startRoom(room);
  };
  if (!m.ask) return go();
  pendingSwitch = go;
  $('#switchFrom').textContent = m.from;
  $('#switchAsk').classList.remove('hidden'); $('#switchYes').focus();
  clearTimeout(onSwitch.t); onSwitch.t = setTimeout(() => { $('#switchAsk').classList.add('hidden'); pendingSwitch = null; }, 60000);
}
$('#switchYes').addEventListener('click', () => pendingSwitch?.());
$('#switchNo').addEventListener('click', () => { $('#switchAsk').classList.add('hidden'); pendingSwitch = null; });

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
    if (sfx.level === 'off') sfx.set('high');
    startCastReceiver();
    return;
  }
  startRoom(await getRoom());
  setTimeout(() => { if (sfx.enabled && !sfx.ready()) { sfx.ctx(); if (!sfx.ready()) $('#soundHint').classList.remove('hidden'); } sendPrefs(); }, 1500);
  try { await navigator.wakeLock?.request('screen'); } catch {}
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) try { await navigator.wakeLock?.request('screen'); } catch {} });
})();
