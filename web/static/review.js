// Game review (post-game analysis), shared by the TV and the phones. The server sends the walkthrough in
// state.review: the moves (marks), the move on screen (step: the board before it, the rack, the move before it)
// and, once Macondo has looked at it, its analysis (turn: played vs best, other good plays, a verdict).
import { esc, paintBoard, tileEl } from './common.js';

export const VERDICTS = {
  best: { label: 'Best move', short: 'Best', icon: '✓' },
  small: { label: 'Small mistake', short: 'Small', icon: '•' },
  medium: { label: 'Medium mistake', short: 'Medium', icon: '••' },
  large: { label: 'Large mistake', short: 'Large', icon: '!' },
};

// "GENTLER C7", "Exchange ABC", "Pass"
export function moveText(m) {
  if (!m) return '';
  if (m.kind === 'exchange') return m.tiles ? `Exchange ${m.tiles.toUpperCase()}` : 'Exchange';
  if (m.kind === 'pass') return 'Pass';
  return m.word || '';
}
export const pct = (w) => (w == null ? '' : `${Math.round(w * 1000) / 10}%`.replace('.0%', '%'));
export const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
// The number that decides: winning chances, or in the endgame the final margin with best play after it.
export const outlook = (m) => (m?.win != null ? `${pct(m.win)} to win` : m?.spread != null ? `ends ${signed(m.spread)}` : '');

// Per-player tallies for the overview.
export function tally(rv) {
  const t = [0, 1].map(() => ({ moves: 0, done: 0, best: 0, small: 0, medium: 0, large: 0, missedBingo: 0 }));
  for (const m of rv.marks || []) {
    const x = t[m.seat]; x.moves++;
    if (m.verdict) { x.done++; x[m.verdict]++; if (m.missedBingo) x.missedBingo++; }
  }
  return t;
}

// The board for a step: the position before the move, plus the move being shown ('played' or 'best').
// Returns the squares of that move, so the caller can highlight them.
export function paintStep(cells, rv, which, { animate = false } = {}) {
  const st = rv.step; if (!st || !cells) return [];
  const mv = which === 'best' ? rv.turn?.best : st.played;
  const board = st.board.map((row) => [...row]);
  const sq = [];
  for (const c of mv?.cells || []) { board[c.r][c.c] = c.l; sq.push(c.r + ',' + c.c); }
  const strs = board.map((r) => r.join(''));
  paintBoard(cells, strs, { fresh: animate ? new Set(sq) : new Set(), last: new Set((st.prevCells || []).map((c) => c.r + ',' + c.c)), order: sq });
  for (const row of cells) for (const cell of row) {
    const t = cell.querySelector('.tile:not(.pending)');
    if (!t) continue;
    const on = sq.includes(cell.dataset.r + ',' + cell.dataset.c);
    t.classList.toggle('rvPlayed', on && which !== 'best');
    t.classList.toggle('rvBest', on && which === 'best');
    if (on) t.classList.remove('last');
  }
  return sq;
}

// Whether showing the best move adds anything (it differs from what was played).
export const bestDiffers = (rv) => !!rv.turn && !rv.turn.err && rv.turn.verdict !== 'best';

const tilesHTML = (s) => [...(s || '')].map((ch) => tileEl(ch === '?' ? '?' : ch).outerHTML).join('');

// The card for one move: what was played, the verdict, the best move and other good plays. Same markup on the TV
// and the phone; each styles it for its own size.
export function stepHTML(rv, names) {
  const st = rv.step, t = rv.turn;
  if (!st) return '';
  const who = names[st.seat];
  const prev = st.prev ? `<div class="rvPrev">${esc(names[st.prev.seat])} ${st.prev.pos ? `played <b>${esc(st.prev.text)}</b> ${esc(st.prev.pos)} for ${st.prev.score}` : esc(st.prev.text)}</div>` : '';
  const v = t && !t.err ? VERDICTS[t.verdict] : null;
  const verdict = !t ? `<div class="rvVerdict wait"><span class="spin"></span>Analysing this move…</div>`
    : t.err ? `<div class="rvVerdict wait">${esc(t.err)}</div>`
    : `<div class="rvVerdict v-${t.verdict}"><span class="ico">${v.icon}</span>${v.label}${t.missedBingo ? '<span class="tag">Missed bingo</span>' : ''}${t.blownEndgame ? '<span class="tag">Cost the game</span>' : ''}</div>`;
  const line = (label, m, cls, extra = '') => `<div class="rvMove ${cls}"><span class="lbl">${label}</span><span class="mv"><b>${esc(moveText(m))}</b>${m.pos ? ` <span class="pos">${esc(m.pos)}</span>` : ''}</span>
    <span class="pts">${m.kind === 'play' ? signed(m.score) : ''}</span><span class="out">${esc(outlook(m))}</span>${extra}</div>`;
  const played = { ...st.played, ...(t?.played || {}) };
  let moves = line('Played', played, 'played');
  if (t && !t.err && t.verdict !== 'best') moves += line('Best', t.best, 'best', t.best.leave && t.best.kind !== 'pass' ? `<span class="keep">keep ${esc(t.best.leave)}</span>` : '');
  const alts = t?.alts?.length ? `<div class="rvAlts"><div class="cap">Other options</div>${t.alts.slice(0, 3).map((a) => line('', a, 'alt')).join('')}</div>` : '';
  return `<div class="rvWho"><span class="nm">${esc(who)}</span><span class="rvRack">${tilesHTML(st.rack)}</span><span class="rvSc">${st.scores[st.seat]}–${st.scores[1 - st.seat]} · ${st.bag} in bag</span></div>
    ${prev}${verdict}<div class="rvMoves">${moves}</div>${alts}`;
}

// Progress line: "Waiting for the analyser (1 game ahead)", "Analysing… 5 of 12 moves", or nothing once done.
export function progressText(rv) {
  const total = (rv.marks || []).length;
  if (rv.done >= total) return '';
  if (rv.queue > 0) return `Waiting for the analyser · ${rv.queue} game${rv.queue === 1 ? '' : 's'} ahead`;
  return `Analysing… ${rv.done} of ${total} moves`;
}

// The timeline: one dot per move, coloured by its verdict.
export function timelineHTML(rv) {
  return (rv.marks || []).map((m, k) => `<button class="rvDot p${m.seat} ${m.verdict ? 'v-' + m.verdict : 'todo'}${k === rv.pos ? ' on' : ''}" data-k="${k}" aria-label="Move ${k + 1}"></button>`).join('');
}

// What the TV says for a step (once its analysis is in).
const posSpeech = (p) => (p || '').replace(/^(\d+)([A-O])$/, '$1 $2').replace(/^([A-O])(\d+)$/, '$1 $2');
const say = (m) => (m.kind === 'exchange' ? `exchanged ${m.tiles ? [...m.tiles].join(', ') : ''}` : m.kind === 'pass' ? 'passed' : `${m.word.toLowerCase()}, at ${posSpeech(m.pos)}, for ${m.score}`);
const sayBest = (m) => (m.kind === 'exchange' ? `to exchange ${[...(m.tiles || '')].join(', ')}` : m.kind === 'pass' ? 'to pass' : `${m.word.toLowerCase()}, at ${posSpeech(m.pos)}, for ${m.score}`);
export function stepSpeech(rv, names, sayName = (n) => n) {
  const st = rv.step, t = rv.turn;
  if (!st || !t || t.err) return '';
  const played = { ...st.played, ...t.played };
  let s = `Move ${rv.pos + 1}. ${sayName(names[st.seat])} ${played.kind === 'play' ? 'played ' : ''}${say(played)}.`;
  if (t.verdict === 'best') return s + ' That was the best move.';
  s += ` Best was ${sayBest(t.best)}. ${VERDICTS[t.verdict].label}.`;
  if (t.missedBingo) s += ' A missed bingo!';
  if (t.blownEndgame) s += ' That one cost the game.';
  return s;
}
export function overviewSpeech(rv, names, sayName = (n) => n) {
  const t = tally(rv), parts = [];
  rv.seats.forEach((x, i) => {
    if (x.bot || !t[i].moves) return;
    const y = t[i], miss = y.small + y.medium + y.large;
    parts.push(`${sayName(names[i])}: ${y.best} best move${y.best === 1 ? '' : 's'}, ${miss} mistake${miss === 1 ? '' : 's'}${y.large ? `, ${y.large} of them large` : ''}.`);
  });
  return parts.join(' ');
}
