// Shared helpers for TV + phone clients.
export const VALUES = {A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,'?':0};
export const BONUS = {'=':['tw','TRIPLE WORD','3W'], '-':['dw','DOUBLE WORD','2W'], '"':['tl','TRIPLE LETTER','3L'], "'":['dl','DOUBLE LETTER','2L']};
export const COLS = 'ABCDEFGHIJKLMNO';
export const THEME_NAMES = { 'woogles': 'Woogles', 'woogles-dark': 'Woogles Dark', 'balsa': 'Balsa', 'forest': 'Forest', 'pastel': 'Pastel', 'midnight': 'Midnight' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function applyTheme(t) {
  if (t && document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('wt_theme', t); } catch {}
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  }
}
// apply last-used theme immediately to avoid a flash
try { const t = localStorage.getItem('wt_theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function tileEl(letter, opts = {}) {
  const blank = opts.blank || (letter >= 'a' && letter <= 'z');
  const t = el('div', 'tile' + (blank ? ' blank' : '') + (opts.cls ? ' ' + opts.cls : ''));
  const L = letter === '?' ? '' : letter.toUpperCase();
  t.append(el('span', 'tl-letter', L));
  const v = blank || letter === '?' ? '' : VALUES[L];
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
      if (r === 7 && c === 7) { cell.className = 'cell star'; cell.innerHTML = '<span class="blabel">★</span>'; }
      root.append(cell);
      cells[r].push(cell);
    }
  }
  return cells;
}

// Coordinate labels around a board (A-O across the top, 1-15 down the side).
export function buildCoords(top, side) {
  top.innerHTML = COLS.split('').map((c) => `<span>${c}</span>`).join('');
  side.innerHTML = Array.from({ length: 15 }, (_, i) => `<span>${i + 1}</span>`).join('');
}

// Put tiles from board strings into cells. `fresh` = Set of "r,c" to animate.
export function paintBoard(cells, board, { fresh = new Set(), last = new Set(), order = null } = {}) {
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const cell = cells[r][c];
    const ch = board ? board[r][c] : '.';
    const existing = cell.querySelector('.tile:not(.pending)');
    const cur = existing ? existing.dataset.ch : '.';
    if (cur !== ch) {
      existing?.remove();
      if (ch !== '.') {
        const t = tileEl(ch);
        t.dataset.ch = ch;
        const k = r + ',' + c;
        if (fresh.has(k)) { t.classList.add('drop'); t.style.animationDelay = ((order ? order.indexOf(k) : 0) * 110) + 'ms'; }
        cell.append(t);
      }
    }
    const t = cell.querySelector('.tile:not(.pending)');
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

// Squares covered by the last tile-placement move in the log, in reading order.
export function lastPlaySquares(log) {
  const s = [];
  if (!log) return s;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i];
    if (m.type === 'play') {
      [...m.tiles].forEach((ch, k) => {
        if (ch === '.') return;
        const r = m.vert ? m.row + k : m.row, c = m.vert ? m.col : m.col + k;
        s.push(r + ',' + c);
      });
      return s;
    }
    if (m.type === 'pass' || m.type === 'exchange') return s;
  }
  return s;
}

export function describeMove(m, names) {
  const who = names[m.player] || '?';
  switch (m.type) {
    case 'play': return { who, text: (m.words && m.words.length ? m.words[0] : m.tiles.replace(/\./g, '·')).toUpperCase(), detail: m.pos, score: m.score, bingo: m.bingo };
    case 'exchange': return { who, text: `Exchanged ${m.count}`, score: 0, quiet: true };
    case 'pass': return { who, text: 'Passed', score: 0, quiet: true };
    case 'endrack': return { who, text: `2× rack ${m.rack}`, score: m.score, quiet: true };
    case 'penalty': return { who, text: `Rack ${m.rack}`, score: m.score, quiet: true };
    case 'time': return { who, text: 'Time penalty', score: m.score, quiet: true };
    case 'adjust': return { who, text: 'Win on time', score: m.score, quiet: true };
    default: return { who, text: m.type, score: m.score, quiet: true };
  }
}

export function fmtClock(ms) {
  const neg = ms < 0; let s = Math.abs(ms) / 1000;
  s = neg ? Math.ceil(s) : Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return (neg ? '−' : '') + body;
}

// Live clock helper: keeps server snapshot + local receive time.
export function clockNow(clock, recvAt, seat) {
  if (!clock) return null;
  let ms = clock.remaining[seat];
  if (clock.running === seat && !clock.paused) ms -= performance.now() - recvAt;
  return ms;
}
export function paintTimer(node, clock, recvAt, seat) {
  if (!clock) { node.classList.add('hidden'); return; }
  node.classList.remove('hidden');
  const ms = clockNow(clock, recvAt, seat);
  node.textContent = fmtClock(ms);
  node.classList.toggle('out', ms < 0);
  node.classList.toggle('low', ms >= 0 && ms < Math.min(120000, clock.initialMs / 10));
  node.classList.toggle('idle', clock.running !== seat);
  node.classList.toggle('paused', clock.paused && clock.running === seat);
}

// Reconnecting websocket.
export function connect(params, onMsg, onStatus) {
  let ws, timer, delay = 500, closed = false, fails = 0;
  const api = { send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }, close() { closed = true; ws?.close(); }, params };
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams(api.params).toString();
    ws = new WebSocket(`${proto}://${location.host}/ws?${qs}`);
    let opened = false;
    ws.onopen = () => { opened = true; fails = 0; delay = 500; onStatus?.(true); };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      if (!opened) fails++;
      onStatus?.(false, fails);
      if (!closed) { clearTimeout(timer); timer = setTimeout(open, delay); delay = Math.min(delay * 2, 5000); }
    };
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
  while (box.children.length > 3) box.firstChild.remove();
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

// ---- tiny synthesized sound effects (no audio files) ----
let actx = null;
export const sfx = {
  enabled: true,
  ctx() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  },
  ready() { return actx && actx.state === 'running'; },
  tone(freq, dur = 0.12, { type = 'sine', vol = 0.18, at = 0, slide = 0 } = {}) {
    if (!this.enabled) return;
    const c = this.ctx(); if (!c) return;
    const t = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  },
  clack(at = 0) { // wooden tile click: short filtered noise burst
    if (!this.enabled) return;
    const c = this.ctx(); if (!c) return;
    const t = c.currentTime + at, len = Math.floor(c.sampleRate * 0.05), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = 1800 + Math.random() * 600; f.Q.value = 1.2; g.gain.value = 0.7;
    src.connect(f).connect(g).connect(c.destination); src.start(t);
  },
  play(n) { for (let i = 0; i < n; i++) this.clack(i * 0.11); },
  bingo() { [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.25, { type: 'triangle', vol: 0.16, at: 0.5 + i * 0.09 })); },
  turn() { this.tone(880, 0.09, { vol: 0.12 }); this.tone(1175, 0.14, { vol: 0.12, at: 0.09 }); },
  bad() { this.tone(220, 0.22, { type: 'square', vol: 0.06, slide: 0.7 }); },
  pass() { this.tone(392, 0.15, { type: 'triangle', vol: 0.1, slide: 0.8 }); },
  over() { [784, 659, 523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.3, { type: 'triangle', vol: 0.14, at: i * 0.14 })); },
  tick() { this.tone(1400, 0.04, { type: 'square', vol: 0.04 }); },
};
