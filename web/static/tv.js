import { buildBoard, buildCoords, paintBoard, diffBoards, lastPlaySquares, el, esc, connect, toast, countUp, describeMove,
  applyTheme, paintTimer, sfx, keepAwake, THEME_NAMES, tileEl, clockAlerts, SOUND_NAMES, botFace, BOT_SPEED_NAMES, nextBotSpeed } from './common.js';
import { makeAnnouncer, announcerReady, definitionSpeech, speechMemory, describeForSpeech, gameOverSpeech, clockSpeech, sayName, holdBot, ANN_MODE_NAMES, SPELL_NAMES, RATE_NAMES } from './announcer.js';
import { confetti } from './confetti.js';
import { VERDICTS, tally, paintStep, bestDiffers, stepHTML, progressText, timelineHTML, stepSpeech, overviewSpeech } from './review.js';
import { makeMusic, musicReady, musicStations, musicSettings, isBreak, setIdleBreak, MUSIC_MODES, MUSIC_MODE_NAMES, MUSIC_VOLS, MUSIC_VOL_NAMES } from './music.js';

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
// Background music (when the server lists stations); the room's settings say when it plays.
const music = makeMusic(ann, { onNow: (info) => { npInfo = info; paintNow(); if (loungeOn) paintLounge(); }, onBlocked: () => $('#soundHint').classList.remove('hidden') });
let npInfo = null;
musicReady.then(() => { music.update(); if (!$('#menu').classList.contains('hidden')) paintMusicMenu(); });
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
const avatar = (name, i, seat) => `<span class="avatar p${i}">${seat?.bot ? botFace(seat.level) : esc(initial(name))}</span>`;

function render(s) {
  const prev = state; state = s; recvAt = performance.now();
  paintBotSpeedMenu();
  applyTheme(s.settings.theme);
  music.update(s); paintNow();
  setQR(s.joinUrl);
  idleAt = Date.now();
  loungeSeen(s, prev);
  paintStill(s);
  $('#mReview').classList.toggle('hidden', !(s.review?.tvCan && !s.review?.open));
  $('#mRematch').classList.toggle('hidden', !(s.tvRematch && !s.review?.open));
  $('#rematchHint').innerHTML = s.tvRematch ? 'Play again: press <b>OK</b> → <b>Rematch</b>, or <b>Rematch</b> on a phone' : 'Press <b>Rematch</b> on a phone to play again';
  if (s.review?.open) { renderReview(s); return; }
  if (rvOn) leaveReview();
  $('#rvHint').classList.toggle('hidden', !s.review?.analysis);
  const names = s.seats.map((x, i) => x.name || `Player ${i + 1}`);
  const timeTxt = s.settings.timeMin ? `${s.settings.timeMin} min each` : 'untimed';

  // lobby
  $('#lobby').classList.toggle('hidden', s.phase !== 'lobby');
  $('#lobbySeats').innerHTML = s.seats.map((seat, i) => seat.taken
    ? `<div class="lseat">${avatar(seat.name, i, seat)} <span>${esc(seat.name)}</span> <span class="dot ${seat.connected ? 'on' : ''}"></span></div>`
    : `<div class="lseat empty"><span class="avatar">${i + 1}</span> Seat open</div>`).join('');
  const ready = s.seats.every((x) => x.taken);
  $('#lobbyHint').textContent = ready ? `Ready! Press Start on a phone · ${s.settings.lexicon} · ${timeTxt}` : `Waiting for players… · ${s.settings.lexicon} · ${timeTxt}`;
  $('#lobbyHint').classList.toggle('ready', ready);
  if (s.phase === 'lobby') { prevBoard = null; $('#over').classList.add('hidden'); $('#pausedBanner').classList.add('hidden'); return; } // a finished game's result doesn't follow the TV to a fresh screen

  if (!cells || s.gameNo !== gameNo) {
    cells = buildBoard($('#board'), s.bonuses); buildCoords($('#coordTop'), $('#coordSide'));
    prevBoard = prev.gameNo === s.gameNo ? prevBoard : null; gameNo = s.gameNo;
  }
  const last = lastPlaySquares(s.log);
  const fresh = prevBoard ? diffBoards(prevBoard, s.board) : new Set();
  paintBoard(cells, s.board, { fresh, last: new Set(last), order: last });
  prevBoard = s.board;
  $('#meta').textContent = `${s.lexicon} · ${s.clock ? Math.round(s.clock.initialMs / 60000) + ' min' : 'untimed'}`;
  paintBreakHint(s);
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
    const av = seat.bot ? botFace(seat.level) : esc(initial(names[i]));
    if (card.dataset.av !== av) { card.dataset.av = av; card.querySelector('.avatar').innerHTML = av; }
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
      if (lines.length && s.phase === 'playing') holdBot((m) => ws.send(m), ann, s);
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
    $('#finals').innerHTML = s.seats.map((seat, i) => `<div class="final${s.winner === i ? ' win' : ''}">${avatar(names[i], i, seat)}
      <div class="n">${esc(names[i])}</div><div class="s">${seat.score}</div>
      <div class="r">${s.endReason ? '' : seat.rack ? 'Left: ' + esc(seat.rack) : 'Went out'}</div></div>`).join('');
  }
}

// ---- game review (post-game analysis) ----
// The board shows the position before each move with the move played, then the best one (alternating); the side
// panel shows the verdict and the numbers. A player's phone drives; the remote takes over if that phone goes.
let rvOn = false, rvKey = '', rvShow = 'played', rvTimer = 0, rvSaid = '';
const rvSpeakOn = () => { try { return localStorage.getItem('wt_rv_speak') !== 'off'; } catch { return true; } };
function leaveReview() {
  rvOn = false; rvKey = ''; clearInterval(rvTimer); document.body.classList.remove('reviewing');
  $('#rvPanel').classList.add('hidden'); cells = null; gameNo = -1; prevBoard = null; ann.stop();
}
function renderReview(s) {
  const rv = s.review, names = rv.seats.map((x) => x.name);
  if (!rvOn) {
    rvOn = true; rvSaid = '';
    document.body.classList.add('reviewing');
    cells = buildBoard($('#board'), rv.bonuses); buildCoords($('#coordTop'), $('#coordSide')); gameNo = -1;
    if (ann.on('moves') && rvSpeakOn()) { ann.stop(); ann.say('Game review.'); }
  }
  for (const id of ['#lobby', '#over', '#pausedBanner']) $(id).classList.add('hidden');
  $('#rvPanel').classList.remove('hidden');
  $('#meta').textContent = `${rv.lexicon} · review`;
  paintBreakHint(s);
  const total = rv.marks.length, key = `${rv.pos}:${rv.step?.ev ?? ''}:${rv.turn ? 1 : 0}`;
  const moved = key.split(':').slice(0, 2).join() !== rvKey.split(':').slice(0, 2).join();
  if (key !== rvKey) {
    rvKey = key;
    if (moved) rvShow = 'played';
    clearInterval(rvTimer);
    if (bestDiffers(rv)) rvTimer = setInterval(() => { rvShow = rvShow === 'played' ? 'best' : 'played'; paintReviewBoard(true); }, 4000);
  }
  paintReviewBoard(moved);
  $('#rvCount').textContent = rv.pos < 0 ? `${total} move${total === 1 ? '' : 's'} to go through` : `Move ${rv.pos + 1} of ${total}`;
  $('#rvBody').innerHTML = rv.pos < 0 ? overviewHTML(rv, names, s) : stepHTML(rv, names);
  $('#rvProg').textContent = progressText(rv);
  $('#rvLine').innerHTML = timelineHTML(rv);
  const driver = names[rv.driver] || '';
  $('#rvHelp').innerHTML = rv.driverHere ? `${esc(driver)}'s phone is going through the game` : '◀ ▶ on the remote to step through · Back to finish';
  // say each move once its analysis is in, and the overview once the whole game is done
  const line = rv.pos < 0 ? (rv.done >= total && total ? overviewSpeech(rv, names, sayName) : '') : stepSpeech(rv, names, sayName);
  const id = `${rv.pos}:${rv.step?.ev ?? ''}`;
  if (line && rvSaid !== id && ann.on('moves') && rvSpeakOn()) { rvSaid = id; ann.stop(); ann.later(() => ann.say(line), 500); }
  function paintReviewBoard(animate) {
    if (!state.review?.open) return;
    const r = state.review;
    if (r.pos < 0 || !r.step) { paintBoard(cells, r.board); return; }
    const show = rvShow === 'best' && bestDiffers(r) ? 'best' : 'played';
    paintStep(cells, r, show, { animate });
    document.querySelectorAll('#rvBody .rvMove').forEach((x) => x.classList.toggle('onBoard', x.classList.contains(show)));
  }
}
// "Still reviewing?": nobody has moved the review on for a while; it closes when the countdown runs out.
let stillAt = 0;
function paintStill(s) {
  const on = s.review?.open && s.review.closeIn != null;
  stillAt = on ? Date.now() + s.review.closeIn : 0;
  $('#stillAsk').classList.toggle('hidden', !on);
  if (on) { tickStill(); if (!$('#stillAsk').dataset.said && ann.on('moves')) { $('#stillAsk').dataset.said = 1; ann.say('Still reviewing? Press OK to keep going.'); } }
  else delete $('#stillAsk').dataset.said;
}
const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function tickStill() { if (stillAt) $('#stillLeft').textContent = mmss(stillAt - Date.now()); }
setInterval(tickStill, 1000);
$('#stillYes').addEventListener('click', () => ws.send({ t: 'review', op: 'still' }));

// A finished game left on screen with nothing happening: after a while the TV gets ready for the next game (a fresh
// QR code), as if "New game" had been picked. The game itself stays as it was, under OK → Games on this TV and the
// players' Your games. The last minute shows a countdown; any key keeps the result up.
const RESULT_IDLE = 20 * 60e3;
let idleAt = Date.now();
setInterval(() => {
  const busy = !$('#menu').classList.contains('hidden') || !$('#gamesMenu').classList.contains('hidden') || pendingSwitch;
  const left = RESULT_IDLE - (Date.now() - idleAt);
  const on = !CAST && state.phase === 'over' && !state.review?.open && !busy;
  if (!on) { $('#idleNote').classList.add('hidden'); return; }
  if (left <= 0) {
    $('#idleNote').classList.add('hidden'); idleAt = Date.now();
    newRoomHere().then(() => toast('Ready for a new game — the last one is under OK → Games on this TV', '', 6000));
    return;
  }
  $('#idleNote').classList.toggle('hidden', left > 60e3);
  $('#idleNote b').textContent = mmss(left);
}, 1000);

function overviewHTML(rv, names, s) {
  const t = tally(rv);
  return `<div class="rvOver">${rv.seats.map((x, i) => {
    const y = t[i];
    const body = x.bot ? '<div class="rvNote">The computer\'s moves aren\'t analysed</div>'
      : `<div class="rvChips">${['best', 'small', 'medium', 'large'].map((v) => `<span class="chip v-${v}"><b>${y[v]}</b> ${VERDICTS[v].short}</span>`).join('')}</div>
         ${y.missedBingo ? `<div class="rvNote">${y.missedBingo} missed bingo${y.missedBingo === 1 ? '' : 's'}</div>` : ''}`;
    return `<div class="rvPlayer">${avatar(names[i], i, x)}<div class="who"><div class="name">${esc(names[i])}</div>${body}</div><div class="score">${rv.finals[i]}</div></div>`;
  }).join('')}</div>`;
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
    li.innerHTML = `${avatar(names[m.player], m.player, s.seats[m.player])}<div class="w">${esc(d.text)} ${d.detail ? `<span class="d">${esc(d.detail)}</span>` : ''}</div>
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
  if (kind === 'overtime') toast(`${name} is in overtime: −10 points per minute or part of one`, 'bad');
  else if (kind === 'overmin') toast(`${name}: overtime minute ${n + 1}, −${10 * (n + 1)}`, 'bad');
  else if (kind === 'lastmin') toast(`${name}: one minute until a loss on time`, 'bad');
  if (ann.on('all')) ann.later(() => ann.say(clockSpeech(kind, n, name)), 500);
}

// ---- clock: the time of day next to the TV code, in this TV's own time zone ----
// A setting of this TV (not the room): Off, 12 hr or 24 hr. The default follows the device's own convention.
const CLOCK_MODES = ['off', '12', '24'], CLOCK_NAMES = { off: 'Off', 12: '12 hr', 24: '24 hr' };
let clockMode = (() => {
  try { const m = localStorage.getItem('wt_clock'); if (CLOCK_MODES.includes(m)) return m; } catch {}
  try { return /h1[12]/.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle) ? '12' : '24'; } catch { return '24'; }
})();
function paintClock() {
  const c = $('#clock');
  c.classList.toggle('hidden', clockMode === 'off');
  if (clockMode === 'off') return;
  const d = new Date(), m = String(d.getMinutes()).padStart(2, '0'), h = d.getHours();
  const html = clockMode === '24' ? `${String(h).padStart(2, '0')}:${m}` : `${h % 12 || 12}:${m}<small>${h < 12 ? 'AM' : 'PM'}</small>`;
  if (c.innerHTML !== html) c.innerHTML = html;
}
function cycleClock() {
  clockMode = CLOCK_MODES[(CLOCK_MODES.indexOf(clockMode) + 1) % CLOCK_MODES.length];
  try { localStorage.setItem('wt_clock', clockMode); } catch {}
  paintClock(); $('#mClock').textContent = CLOCK_NAMES[clockMode];
}
paintClock(); setInterval(paintClock, 1000);

// ---- idle screen ("lounge") ----
// After a while with nothing happening (no move, no one joining, no remote presses), the TV shows a big time of day,
// what's playing and the game at a glance. OK pauses or resumes the clock in a timed game; Back or any other key, or
// the next move, closes it. How long: a setting of this TV (OK → Idle screen), 10 minutes by default.
const LOUNGE_MINS = [0, 5, 10, 20, 30];
let loungeMins = (() => { try { const v = localStorage.getItem('wt_lounge'); if (v !== null && LOUNGE_MINS.includes(+v)) return +v; } catch {} return 10; })();
let loungeAt = Date.now(), loungeSig = '', loungeOn = false, loungeDrift = 0;
const loungeName = () => (loungeMins ? `After ${loungeMins} min` : 'Off');
function cycleLounge() {
  loungeMins = LOUNGE_MINS[(LOUNGE_MINS.indexOf(loungeMins) + 1) % LOUNGE_MINS.length];
  try { localStorage.setItem('wt_lounge', String(loungeMins)); } catch {}
  $('#mLounge').textContent = loungeName();
}
function loungeActive() { loungeAt = Date.now(); if (loungeOn) closeLounge(); }
// Called with every state: a move, a new game or a phase change, someone joining or a review counts as activity.
// (A clock paused or resumed doesn't: the idle screen is a fine place to wait out a pause.)
function loungeSeen(s, prev) {
  // The clock resumed (from a phone, or OK on the idle screen): the break is over, back to the board.
  if (loungeOn && prev?.clock?.paused && s.clock && !s.clock.paused && prev.gameNo === s.gameNo) { loungeAt = Date.now(); closeLounge(); }
  const sig = [s.code, s.gameNo, s.phase, s.log?.length, (s.seats || []).map((x) => x?.name || '').join(','), !!s.review?.open].join('|');
  if (sig !== loungeSig) { loungeSig = sig; loungeActive(); } else if (loungeOn) paintLounge();
}
function loungeBlocked() {
  return CAST || !state.phase || !!state.review?.open || pendingSwitch || ['#menu', '#gamesMenu', '#stillAsk', '#switchAsk', '#idleNote'].some((id) => !$(id).classList.contains('hidden')) ||
    !$('#bingo').classList.contains('hidden');
}
function openLounge() {
  loungeOn = true; loungeDrift = 0;
  $('#lounge').classList.remove('hidden');
  setIdleBreak(true); music.update(state); paintNow();
  paintLounge();
}
function closeLounge() {
  loungeOn = false;
  $('#lounge').classList.add('hidden');
  setIdleBreak(false); music.update(state); paintNow();
}
function fmtTimeOfDay(d) {
  const mode = clockMode === 'off' ? (/h1[12]/.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle || '') ? '12' : '24') : clockMode;
  const m = String(d.getMinutes()).padStart(2, '0'), h = d.getHours();
  return mode === '24' ? `${String(h).padStart(2, '0')}:${m}` : `${h % 12 || 12}:${m}<small>${h < 12 ? 'AM' : 'PM'}</small>`;
}
function paintLounge() {
  const s = state, box = $('#lounge');
  const names = (s.seats || []).map((x, i) => x?.name || `Player ${i + 1}`);
  const timed = s.phase === 'playing' && !!s.clock;
  let html = '';
  if (s.phase === 'lobby') {
    html = `<div class="lgQR"><img src="${esc($('#qr').getAttribute('src') || '')}" alt=""><div><div style="font-size:3.2vh;font-weight:800">Scan to play</div>
      <div class="muted" style="font-size:2.2vh;margin:.6vh 0 1.4vh">or enter the TV code at ${esc(location.host)}</div><div class="code">${esc(s.code || '')}</div></div></div>`;
  } else {
    const rows = (s.seats || []).map((seat, i) => {
      const turn = s.phase === 'playing' && s.turn === i;
      const tag = turn ? `<small>${seat.bot ? 'Thinking…' : 'On move'}</small>` : '';
      return `<div class="lgRow ${turn ? 'turn' : ''}">${avatar(names[i], i, seat)}<div class="nm">${esc(names[i])}${tag}</div>
        ${timed ? '<div class="timer"></div>' : ''}<div class="sc">${seat.score}</div></div>`;
    }).join('');
    const facts = [];
    if (s.phase === 'over') {
      html = `<div class="lgWin">${s.winner === -1 ? "It's a tie!" : `🏆 ${esc(names[s.winner] || '')} wins!`}</div>`;
    } else {
      const sc = (s.seats || []).map((x) => x.score), d = Math.abs(sc[0] - sc[1]);
      if (timed && s.clock.paused) facts.push('<span class="lgPaused">❚❚ Clock paused</span>');
      facts.push(d ? `<b>${esc(names[sc[0] > sc[1] ? 0 : 1])}</b> leads by <b>${d}</b> · <b>${s.bag}</b> in the bag` : `All square · <b>${s.bag}</b> in the bag`);
    }
    const log = s.log || [];
    const last = [...log].reverse().find((m) => ['play', 'exchange', 'pass'].includes(m.type));
    if (last && s.phase === 'playing') { const d = describeMove(last, names); facts.push(`Last: <b>${esc(d.text)}</b>${d.quiet ? '' : ` for <b>${d.score}</b>`} · ${esc(d.who)}`); }
    const top = log.filter((m) => m.type === 'play').reduce((a, m) => (!a || m.score > a.score ? m : a), null);
    if (top) { const d = describeMove(top, names); facts.push(`Top play: <b>${esc(d.text)}</b> for <b>${d.score}</b> · ${esc(d.who)}${top.bingo ? ' · bingo!' : ''}`); }
    html += rows + (facts.length ? `<div class="lgFacts"><div class="lgLines">${facts.map((f) => `<div>${f}</div>`).join('')}</div><img class="appIcon" src="/static/wtv2-icon.svg" alt=""></div>` : '');
  }
  const g = box.querySelector('.lgGame');
  if (g.dataset.h !== html) { g.dataset.h = html; g.innerHTML = html; }
  box.querySelector('.lgHint').innerHTML = timed
    ? `<b>OK</b> ${s.clock.paused ? 'resumes' : 'pauses'} the clock · <b>Back</b> returns to the game`
    : `Press any button to return${s.phase === 'lobby' ? '' : ' to the game'}`;
  // Now playing, big
  const np = box.querySelector('.lgNow'), glow = box.querySelector('.lgGlow');
  np.classList.toggle('hidden', !npInfo);
  if (npInfo) {
    const img = np.querySelector('img');
    if (npInfo.cover) { if (img.getAttribute('src') !== npInfo.cover) img.src = npInfo.cover; } else img.removeAttribute('src');
    img.classList.toggle('hidden', !npInfo.cover);
    np.querySelector('b').textContent = npInfo.song || npInfo.title || npInfo.station;
    np.querySelector('.ar').textContent = npInfo.song ? npInfo.artist || '' : '';
    np.querySelector('.st').textContent = npInfo.station || '';
  }
  const cover = npInfo?.cover || '';
  glow.classList.toggle('hidden', !cover);
  if (cover && glow.getAttribute('src') !== cover) glow.src = cover;
  tickLounge();
}
function tickLounge() {
  const box = $('#lounge'), d = new Date();
  const t = fmtTimeOfDay(d), te = box.querySelector('.lgTime');
  if (te.innerHTML !== t) te.innerHTML = t;
  box.querySelector('.lgDate').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  box.querySelectorAll('.lgRow .timer').forEach((n, i) => paintTimer(n, state.clock, recvAt, i));
}
setInterval(() => {
  if (loungeOn) {
    tickLounge();
    if (++loungeDrift % 240 === 0) { // every minute: move a little, so nothing sits still on the screen for hours
      const r = () => (Math.random() * 2 - 1).toFixed(2);
      $('#lounge .lgBody').style.transform = `translate(${r() * 2}vw, ${r() * 2.5}vh)`;
    }
    return;
  }
  if (loungeMins && !loungeBlocked() && Date.now() - loungeAt >= loungeMins * 60e3) openLounge();
}, 250);
// Remote keys while it's up: OK pauses/resumes a timed game's clock, anything else closes it.
function loungeKey(e) {
  e.preventDefault();
  const timed = state.phase === 'playing' && !!state.clock;
  if (timed && (e.key === 'Enter' || e.key === ' ' || MEDIA_KEYS.includes(e.key))) { takeBreak(); return; }
  closeLounge();
}
// "Pause & break" (OK → first item during a game, or the remote's play/pause key): in a timed game it pauses the
// clock of whoever is on move and brings up the idle screen; pressed again (or OK there) it resumes the clock and
// returns to the board. In an untimed game it just shows the idle screen.
const MEDIA_KEYS = ['MediaPlayPause', 'MediaPause', 'MediaPlay'];
const canBreak = () => !CAST && state.phase === 'playing' && !state.review?.open;
function takeBreak() {
  if (!canBreak()) return;
  const c = state.clock;
  if (c?.paused) { ws.send({ t: 'resume' }); return; } // closes the idle screen when the resumed state arrives
  if (c) ws.send({ t: 'pause' });
  if (!loungeOn) openLounge();
}
// The remote shortcut, shown in the header during a game: OK OK = Pause & break (see takeBreak).
function paintBreakHint(s = state) {
  const h = $('#breakHint'), on = !CAST && s.phase === 'playing' && !s.review?.open;
  h.classList.toggle('hidden', !on);
  if (!on) return;
  const html = `<kbd>OK</kbd><kbd>OK</kbd> ${!s.clock ? 'Take a break' : s.clock.paused ? 'Resume the clock' : 'Pause &amp; break'}`;
  if (h.innerHTML !== html) h.innerHTML = html;
}
function paintBreakItem() {
  const b = $('#mBreak'), c = state.clock;
  b.classList.toggle('hidden', !canBreak());
  b.textContent = !c ? '☕ Take a break (show the time and music)' : c.paused ? '▶ Resume the clock' : '⏸ Pause the clock & take a break';
}

// ---- options menu (works with a TV remote: arrows + OK) ----
let menuIdx = 0, menuPage = 'main';
const MENU_TITLES = { main: 'Options', ann: 'Announcer', music: 'Music' };
const menuItems = () => [...document.querySelectorAll(`#menu .mitem[data-page="${menuPage}"]:not(.hidden)`)];
// Shows one page of the menu; focusAct picks the item to focus (else the first).
function showMenuPage(page, focusAct) {
  menuPage = page;
  document.querySelectorAll('#menu .mitem').forEach((b) => b.classList.toggle('offpage', b.dataset.page !== page));
  $('#menuTitle').textContent = MENU_TITLES[page];
  const it = menuItems();
  menuIdx = Math.max(0, focusAct ? it.findIndex((b) => b.dataset.act === focusAct) : 0);
  focusMenu();
}
// Back / Escape: from a sub-page to the main menu (on the entry it came from), from the main menu out.
function menuBack() { if (menuPage === 'main') closeMenu(); else showMenuPage('main', 'page-' + menuPage); }
function openMenu() {
  $('#mTheme').textContent = THEME_NAMES[state.settings?.theme] || '';
  $('#mClock').textContent = CLOCK_NAMES[clockMode];
  $('#mLounge').textContent = loungeName();
  paintBotSpeedMenu();
  paintSoundMenu();
  paintMusicMenu();
  $('#mApp').classList.toggle('hidden', !window.WooglesTV?.openMenu);
  paintBreakItem();
  $('#mReview').classList.toggle('hidden', !(state.review?.tvCan && !state.review?.open));
  $('#mRematch').classList.toggle('hidden', !(state.tvRematch && !state.review?.open));
  $('#menu').classList.remove('hidden'); showMenuPage('main');
}
function paintSoundMenu() {
  sendPrefs();
  $('#mSound').textContent = SOUND_NAMES[sfx.level];
  const can = ann.available();
  $('#mAnnEntry').classList.toggle('hidden', !can);
  $('#mAnnSum').textContent = ANN_MODE_NAMES[ann.mode];
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
  $('#mRvSpeak').textContent = rvSpeakOn() ? 'Spoken' : 'Silent';
}
const MUSIC_NOTES = { always: 'Quieter during play, and softer still while the announcer talks', breaks: 'In the lobby, while the clock is paused, and after the game', off: '' };
function paintBotSpeedMenu(speed = state.settings?.botSpeed) {
  $('#mBotSpeedItem').classList.toggle('hidden', !(state.seats || []).some((x) => x && x.bot));
  $('#mBotSpeed').textContent = BOT_SPEED_NAMES[speed || 'normal'];
}
function paintMusicMenu() {
  const sts = musicStations(), ms = musicSettings(state.settings), on = sts.length > 0 && !!state.settings;
  $('#mMusicEntry').classList.toggle('hidden', !on);
  $('#mMusicSum').textContent = MUSIC_MODE_NAMES[ms.mode];
  $('#mStationItem').classList.toggle('hidden', !on || ms.mode === 'off' || sts.length < 2);
  $('#mMusicVolItem').classList.toggle('hidden', !on || ms.mode === 'off');
  if (!on) return;
  $('#mMusic').textContent = MUSIC_MODE_NAMES[ms.mode];
  $('#mMusicNote').textContent = !sfx.enabled && ms.mode !== 'off' ? 'Volume is off, so the music is too' : MUSIC_NOTES[ms.mode];
  $('#mMusicNote').classList.toggle('hidden', !$('#mMusicNote').textContent);
  $('#mStation').textContent = sts[ms.station]?.name || '';
  $('#mMusicVol').textContent = MUSIC_VOL_NAMES[ms.vol];
}
// Music settings belong to the room (phones can change them too); apply locally right away.
function setMusic(ch) {
  state.settings = { ...state.settings, ...ch };
  ws.send({ t: 'settings', ...ch });
  music.update(state); paintMusicMenu();
}
// "Now playing": a row in the side panel during a game, part of the lobby card, a corner card while the clock is
// paused and after the game. textContent only: titles come from the radio station.
function paintNow() {
  const slot = state.phase === 'lobby' || !state.phase ? '#npLobby' : isBreak(state) ? '#npBig' : '#npMini';
  const title = npInfo ? npInfo.song || npInfo.title || '' : '';
  for (const id of ['#npLobby', '#npBig', '#npMini']) {
    const box = $(id), vis = !!npInfo && id === slot;
    box.classList.toggle('hidden', !vis);
    if (!vis) continue;
    const img = box.querySelector('img');
    if (npInfo.cover) { if (img.getAttribute('src') !== npInfo.cover) img.src = npInfo.cover; } else img.removeAttribute('src');
    img.classList.toggle('hidden', !npInfo.cover);
    box.querySelector('b').textContent = title || npInfo.station;
    const by = npInfo.song ? npInfo.artist : '', st = box.querySelector('.st');
    box.querySelector('.ar').textContent = st ? by : [by, npInfo.station].filter(Boolean).join(' · ');
    if (st) st.textContent = npInfo.station;
  }
}
function focusMenu() { const it = menuItems(); it.forEach((b, i) => b.classList.toggle('focus', i === menuIdx)); it[menuIdx]?.focus(); }
function closeMenu() { $('#menu').classList.add('hidden'); }
function menuAct(act) {
  if (act === 'theme') {
    const th = state.themes || Object.keys(THEME_NAMES);
    const next = th[(th.indexOf(state.settings.theme) + 1) % th.length];
    ws.send({ t: 'settings', theme: next });
    $('#mTheme').textContent = THEME_NAMES[next];
  } else if (act === 'break') { closeMenu(); takeBreak();
  } else if (act === 'lounge') { cycleLounge();
  } else if (act === 'botspeed') {
    const next = nextBotSpeed(state.settings?.botSpeed);
    ws.send({ t: 'settings', botSpeed: next });
    paintBotSpeedMenu(next);
  } else if (act === 'clock') { cycleClock();
  } else if (act === 'sound') {
    sfx.cycle(); paintSoundMenu(); paintMusicMenu(); music.update(); sfx.turn();
  } else if (act === 'music' || act === 'station' || act === 'musicvol') {
    const ms = musicSettings(state.settings), next = (list, v) => list[(list.indexOf(v) + 1) % list.length];
    if (act === 'music') setMusic({ music: next(MUSIC_MODES, ms.mode) });
    else if (act === 'station') setMusic({ station: (ms.station + 1) % musicStations().length });
    else setMusic({ musicVol: next(MUSIC_VOLS, ms.vol) });
  } else if (act === 'ann') {
    ann.cycleMode(); ann.stop(); paintSoundMenu();
    if (ann.mode !== 'off') ann.say(ann.mode === 'all' ? 'Announcing moves, scores and the clock.' : 'Announcing moves.');
  } else if (act === 'voice') {
    if (ann.hasServer()) ann.cycleVoice(); else ann.cycleBackup();
    ann.stop(); paintSoundMenu(); ann.say("Hi! I'll be your announcer.");
  } else if (act === 'backup') { ann.cycleBackup(); ann.stop(); paintSoundMenu(); ann.sayOnDevice("This is the backup voice, used if the server voice can't be reached."); }
  else if (act === 'spell') { ann.cycleSpell(); paintSoundMenu(); ann.stop(); ann.say(ann.spell === 'never' ? 'Words will not be spelled out.' : `Zoea. Z, O, E, A.`); }
  else if (act === 'rate') { ann.cycleRate(); paintSoundMenu(); ann.stop(); ann.say(`${sayName('STEEBot')} plays, quixotic, for 98 points.`); } else if (act === 'newroom') { closeMenu(); newRoomHere(); toast('New game — earlier games are under OK → Games on this TV'); }
  else if (act === 'rvspeak') {
    try { localStorage.setItem('wt_rv_speak', rvSpeakOn() ? 'off' : 'on'); } catch {}
    paintSoundMenu(); ann.stop(); if (rvSpeakOn()) ann.say('Game reviews will be read out: the best move for each turn.');
  }
  else if (act === 'review') { closeMenu(); ws.send({ t: 'review', op: 'open' }); }
  else if (act === 'rematch') { closeMenu(); ws.send({ t: 'start' }); }
  else if (act === 'page-ann') showMenuPage('ann');
  else if (act === 'page-music') showMenuPage('music');
  else if (act === 'back') menuBack();
  else if (act === 'games') openGames(); else if (act === 'app') { closeMenu(); window.WooglesTV?.openMenu(); }
  else closeMenu();
}
document.querySelectorAll('#menu .mitem').forEach((b) => b.addEventListener('click', () => menuAct(b.dataset.act)));
document.addEventListener('keydown', (e) => {
  sfx.ctx(); music.kick(); $('#soundHint').classList.add('hidden'); setTimeout(sendPrefs, 300);
  const idleShown = !$('#idleNote').classList.contains('hidden');
  idleAt = Date.now(); loungeAt = Date.now();
  if (idleShown) { e.preventDefault(); $('#idleNote').classList.add('hidden'); return; } // "press OK to stay"
  if (loungeOn) { loungeKey(e); return; }
  if (MEDIA_KEYS.includes(e.key) && canBreak() && $('#menu').classList.contains('hidden') && $('#gamesMenu').classList.contains('hidden') && !pendingSwitch) { e.preventDefault(); takeBreak(); return; }
  if (!$('#stillAsk').classList.contains('hidden')) {
    e.preventDefault();
    if (['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) ws.send({ t: 'review', op: 'still' });
    else if (['Escape', 'Backspace', 'GoBack'].includes(e.key)) ws.send({ t: 'review', op: 'close' });
    return;
  }
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
  const rv = state.review;
  if (!open && rv?.open && ['ArrowLeft', 'ArrowRight', 'Escape', 'Backspace', 'GoBack'].includes(e.key)) {
    e.preventDefault();
    if (rv.driverHere) { toast(`${rv.seats[rv.driver].name}'s phone is going through the game`); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ws.send({ t: 'review', op: 'step', pos: rv.pos + (e.key === 'ArrowRight' ? 1 : -1) });
    else ws.send({ t: 'review', op: 'close' });
    return;
  }
  if (!open) {
    if (['Enter', ' ', 'm', 'M', 'ContextMenu'].includes(e.key)) { e.preventDefault(); openMenu(); }
    return;
  }
  const it = menuItems();
  if (e.key === 'ArrowDown') { menuIdx = (menuIdx + 1) % it.length; focusMenu(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { menuIdx = (menuIdx - 1 + it.length) % it.length; focusMenu(); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); menuAct(it[menuIdx].dataset.act); }
  else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'GoBack') { e.preventDefault(); menuBack(); }
});
// The remote's Back button. The Android TV app (and most TV browsers) don't hand Back to the page as a key: it goes
// "back" in the page's history, or the app offers to exit. So while something Back should close is showing (the
// menu, a prompt, the game review), the page keeps one extra history entry; Back pops it, and the page treats that
// like Escape (close the menu, finish the review, ...). If it's still showing afterwards, the entry is put back.
const backLayers = ['#menu', '#gamesMenu', '#switchAsk', '#stillAsk', '#idleNote', '#lounge'];
const backWanted = () => !CAST && (!!state.review?.open || backLayers.some((id) => !$(id).classList.contains('hidden')));
let backGuard = false, backSkip = 0;
function syncBack() {
  const want = backWanted();
  if (want && !backGuard) { history.pushState({ wtBack: 1 }, ''); backGuard = true; }
  else if (!want && backGuard) { backGuard = false; if (history.state?.wtBack) { backSkip++; history.back(); } }
}
window.addEventListener('popstate', () => {
  if (backSkip) { backSkip--; return; } // our own clean-up
  backGuard = false;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  setTimeout(syncBack, 50);
});
setInterval(syncBack, 300);

document.addEventListener('pointerdown', () => { idleAt = Date.now(); if (loungeOn) closeLounge(); loungeAt = Date.now(); sfx.ctx(); music.kick(); $('#soundHint').classList.add('hidden'); setTimeout(sendPrefs, 300); });
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
  holdBot((m) => ws.send(m), ann, state);
}

function startRoom(room) {
  currentRoom = room; rememberRoom(room);
  if (ws) ws.close();
  cells = null; prevBoard = null; gameNo = -1; state = { code: room.code }; $('#players').innerHTML = '';
  $('#over').classList.add('hidden'); $('#idleNote').classList.add('hidden');
  for (const id of ['#board', '#coordTop', '#coordSide', '#log']) { const n = $(id); if (n) n.innerHTML = ''; } // nothing of the last game behind the new one
  $('#castWait')?.classList.add('hidden');
  ws = connect({ room: room.code, role: 'tv', key: room.tvKey }, (m) => {
    if (m.t === 'state') render(m);
    else if (m.t === 'switch') onSwitch(m);
    else if (m.t === 'event') {
      const nm = state.seats?.[m.seat]?.name || 'The TV';
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

// A /tv#room=…&tv=… link opened in a tab already showing the TV only changes the hash, which doesn't reload the
// page: reload so getRoom() picks the new room up.
window.addEventListener('hashchange', () => { if (/room=.+&tv=/.test(location.hash)) location.reload(); });

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
  keepAwake(true); // the board stays on screen
})();
