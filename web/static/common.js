// Shared helpers for TV + phone clients.
export const VALUES = {A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,'?':0};
export const BONUS = {'=':['tw','TRIPLE WORD','3W'], '-':['dw','DOUBLE WORD','2W'], '"':['tl','TRIPLE LETTER','3L'], "'":['dl','DOUBLE LETTER','2L']};
export const COLS = 'ABCDEFGHIJKLMNO';

export function tileValue(ch) {
  if (!ch || ch === '.') return 0;
  if (ch >= 'a' && ch <= 'z') return 0; // blank
  return VALUES[ch] ?? 0;
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function tileEl(letter, opts = {}) {
  const t = el('div', 'tile' + (opts.blank ? ' blank' : '') + (opts.cls ? ' ' + opts.cls : ''));
  const L = letter === '?' ? '' : letter.toUpperCase();
  t.append(el('span', 'tl-letter', L));
  const v = opts.blank || letter === '?' ? '' : VALUES[L];
  if (v !== '' && v != null) t.append(el('span', 'tl-val', String(v)));
  return t;
}

// Build a 15x15 board into `root`. Returns cell elements [r][c].
export function buildBoard(root, bonuses, { labels = true } = {}) {
  root.innerHTML = '';
  root.classList.add('board');
  const cells = [];
  for (let r = 0; r < 15; r++) {
    cells.push([]);
    for (let c = 0; c < 15; c++) {
      const b = bonuses ? bonuses[r][c] : ' ';
      const cell = el('div', 'cell');
      cell.dataset.r = r; cell.dataset.c = c;
      if (BONUS[b]) {
        cell.classList.add(BONUS[b][0]);
        if (labels) cell.append(el('span', 'blabel', BONUS[b][2]));
      }
      if (r === 7 && c === 7) { cell.classList.add('star'); cell.innerHTML = '<span class="blabel">★</span>'; }
      root.append(cell);
      cells[r].push(cell);
    }
  }
  return cells;
}

// Put tiles from board strings into cells. `fresh` = Set of "r,c" to animate.
export function paintBoard(cells, board, { fresh = new Set(), last = new Set() } = {}) {
  let i = 0;
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const cell = cells[r][c];
    const ch = board ? board[r][c] : '.';
    const existing = cell.querySelector('.tile:not(.pending):not(.ghost)');
    const cur = existing ? existing.dataset.ch : '.';
    if (cur !== ch) {
      existing?.remove();
      if (ch !== '.') {
        const isBlank = ch >= 'a' && ch <= 'z';
        const t = tileEl(ch, { blank: isBlank });
        t.dataset.ch = ch;
        if (fresh.has(r + ',' + c)) { t.classList.add('drop'); t.style.animationDelay = (i++ * 90) + 'ms'; }
        cell.append(t);
      }
    }
    const t = cell.querySelector('.tile:not(.pending):not(.ghost)');
    if (t) t.classList.toggle('last', last.has(r + ',' + c));
    cell.classList.toggle('filled', ch !== '.');
  }
}

export function diffBoards(a, b) {
  const s = new Set();
  if (!b) return s;
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    if ((a ? a[r][c] : '.') !== b[r][c]) s.add(r + ',' + c);
  }
  return s;
}

// Squares covered by the last tile-placement move in the log.
export function lastPlaySquares(log) {
  const s = new Set();
  if (!log) return s;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i];
    if (m.type === 'play') {
      [...m.tiles].forEach((ch, k) => {
        if (ch === '.') return;
        const r = m.vert ? m.row + k : m.row, c = m.vert ? m.col : m.col + k;
        s.add(r + ',' + c);
      });
      return s;
    }
  }
  return s;
}

export function describeMove(m, names) {
  const who = names[m.player] || '?';
  switch (m.type) {
    case 'play': return { who, text: (m.words && m.words.length ? m.words[0] : m.tiles.replace(/\./g, '·')).toUpperCase(), detail: m.pos, score: m.score, bingo: m.bingo };
    case 'exchange': return { who, text: `swapped ${m.count}`, score: 0 };
    case 'pass': return { who, text: 'passed', score: 0 };
    case 'endrack': return { who, text: `+ opponent's rack (${m.rack})`, score: m.score };
    case 'penalty': return { who, text: `− rack (${m.rack})`, score: m.score };
    default: return { who, text: m.type, score: m.score };
  }
}

// Reconnecting websocket.
export function connect(params, onMsg, onStatus) {
  let ws, timer, delay = 500, closed = false;
  const api = { send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }, close() { closed = true; ws?.close(); }, params };
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams(api.params).toString();
    ws = new WebSocket(`${proto}://${location.host}/ws?${qs}`);
    ws.onopen = () => { delay = 500; onStatus?.(true); };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => { onStatus?.(false); if (!closed) { clearTimeout(timer); timer = setTimeout(open, delay); delay = Math.min(delay * 2, 5000); } };
  }
  open();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws.readyState > 1) { clearTimeout(timer); open(); } });
  return api;
}

export function toast(text, cls = '', ms = 2600) {
  let box = document.getElementById('toasts');
  if (!box) { box = el('div'); box.id = 'toasts'; document.body.append(box); }
  const t = el('div', 'toast ' + cls, text);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function countUp(node, to, ms = 900) {
  const from = parseInt(node.textContent) || 0;
  if (from === to) { node.textContent = to; return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    node.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
