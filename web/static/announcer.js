// Spoken announcements ("Alex plays ZOEA for 34"). Uses the Android TV app's native text-to-speech when present
// (window.WooglesTV.speak — Android's WebView has no Web Speech API), otherwise the browser's speechSynthesis.
// Settings are per device, stored in localStorage under a prefix ('wt_tv_' on the TV, 'wt_ph_' on phones).
import { sfx } from './common.js';

const bridge = () => (window.WooglesTV && typeof window.WooglesTV.speak === 'function' ? window.WooglesTV : null);
const synth = () => ('speechSynthesis' in window ? window.speechSynthesis : null);

export const ANN_MODES = ['off', 'moves', 'all'];
export const ANN_MODE_NAMES = { off: 'Off', moves: 'Moves', all: 'Everything' };
export const SPELL_MODES = ['never', 'bingos', 'always'];
export const SPELL_NAMES = { never: 'Never', bingos: 'Bingos', always: 'Always' };
export const RATES = [0.85, 1, 1.2];
export const RATE_NAMES = { 0.85: 'Slow', 1: 'Normal', 1.2: 'Fast' };

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const nextOf = (list, v) => list[(list.indexOf(v) + 1) % list.length];

export function makeAnnouncer(prefix, defMode) {
  const get = (k, d) => localStorage.getItem(prefix + k) ?? d;
  const A = {
    mode: get('mode', defMode), spell: get('spell', 'bingos'), rate: +get('rate', 1), voice: get('voice', ''),
    available() { return !!(bridge() || synth()); },
    on(level = 'moves') { return this.mode === 'all' || (this.mode === 'moves' && level === 'moves'); },
    set(k, v) { this[k] = v; localStorage.setItem(prefix + k, String(v)); },
    cycleMode() { this.set('mode', nextOf(ANN_MODES, this.mode)); return this.mode; },
    cycleSpell() { this.set('spell', nextOf(SPELL_MODES, this.spell)); return this.spell; },
    cycleRate() { this.set('rate', nextOf(RATES, this.rate)); return this.rate; },
    // English voices, best first. Each: {id, name}
    voices() {
      let list = [];
      try {
        if (bridge()?.voices) list = JSON.parse(bridge().voices() || '[]').map((v) => ({ id: v.name, name: v.label || v.name, lang: v.lang }));
        else if (synth()) list = synth().getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService }));
      } catch { list = []; }
      const en = list.filter((v) => /^en/i.test(v.lang || ''));
      return en.length ? en : list;
    },
    cycleVoice() {
      const vs = this.voices(); if (!vs.length) return '';
      const ids = ['', ...vs.map((v) => v.id)];
      this.set('voice', nextOf(ids, ids.includes(this.voice) ? this.voice : ''));
      return this.voiceName();
    },
    voiceName() { if (!this.voice) return 'Default'; const v = this.voices().find((x) => x.id === this.voice); return v ? v.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s*\(.*\)$/, '') : 'Default'; },
    stop() { try { bridge()?.stopSpeaking?.(); synth()?.cancel(); } catch {} },
    // Speak now (queued after anything already speaking). Respects the device's volume; silent when sound is off.
    say(text, { force = false } = {}) {
      if (!text || (!force && this.mode === 'off') || !sfx.enabled) return;
      const vol = sfx.gain;
      const b = bridge();
      if (b) { try { b.speak(text, this.rate, vol, this.voice || ''); } catch {} return; }
      const s = synth(); if (!s) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.rate; u.volume = vol; u.lang = 'en-US';
      if (this.voice) { const v = s.getVoices().find((x) => x.voiceURI === this.voice); if (v) { u.voice = v; u.lang = v.lang; } }
      s.speak(u);
    },
  };
  synth()?.getVoices(); // Chrome loads voices lazily
  return A;
}

// ---- turning game events into sentences ----
// Bot names like "STEEBot" would be read letter by letter; make them pronounceable.
export function sayName(n) {
  return String(n || 'Someone').replace(/^([A-Z]{2,})(Bot)$/, (_, a) => a[0] + a.slice(1).toLowerCase() + ' Bot').replace(/^([A-Z][a-z]+)(Bot)$/, '$1 Bot');
}
const andList = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`);
// Lowercase so TTS reads a word, not an acronym.
const sayWord = (w) => String(w).toLowerCase();
const spellOut = (w) => [...String(w).toUpperCase()].join(', ');
const pts = (n) => `${n} ${Math.abs(n) === 1 ? 'point' : 'points'}`;

// Per-game memory for the announcer, primed from the game so far (so a page reload doesn't forget the best play).
export function speechMemory(st) {
  const log = (st && st.log) || [], sc = st && st.seats ? st.seats.map((x) => x.score) : [0, 0];
  return { moves: log.length, best: Math.max(0, ...log.filter((m) => m.type === 'play').map((m) => m.score)),
    lead: sc[0] === sc[1] ? -1 : sc[0] > sc[1] ? 0 : 1, bagEmpty: st?.bag === 0, bagLow: st?.bag <= 7 };
}

// Builds the sentences for new log entries. `ctx` keeps per-game memory (best play, leader, bag warnings).
export function describeForSpeech(entries, st, names, ann, ctx) {
  const out = [];
  const N = names.map(sayName);
  const scores = st.seats.map((x) => x.score);
  for (const m of entries) {
    const who = N[m.player] || 'Someone';
    if (m.type === 'play') {
      const word = (m.words && m.words[0]) || (m.tiles || '').replace(/\./g, '');
      const spell = ann.spell === 'always' || (ann.spell === 'bingos' && m.bingo);
      let s = '';
      if (m.bingo) s += pick(['Bingo! ', 'Bingo! ', "It's a bingo! ", 'Bingo! All seven tiles! ']);
      else if (m.score >= 80) s += pick(['Huge play! ', 'Massive play! ']);
      else if (m.score >= 50) s += pick(['Big play! ', 'Nice one! ']);
      s += `${who} plays ${sayWord(word)}`;
      if (spell) s += `. ${spellOut(word)},`;
      s += ` for ${pts(m.score)}.`;
      if (ann.on('all')) {
        const extra = (m.words || []).slice(1).filter((w) => w.length >= 3).map(sayWord); // 2-letter words sound like noise
        if (extra.length && extra.length <= 3) s += ` Also making ${andList(extra)}.`;
        if (/Q/i.test(word) && !/U/i.test(word)) s += ' A Q without a U!';
        if (word.length >= 9 && !m.bingo) s += ` A ${word.length}-letter word!`;
        if (m.score >= 40 && m.score > (ctx.best || 0) && ctx.moves >= 4) s += ' Best play of the game so far.';
      }
      ctx.best = Math.max(ctx.best || 0, m.score);
      out.push(s);
    } else if (m.type === 'pass') out.push(`${who} passes.`);
    else if (m.type === 'exchange') out.push(`${who} exchanges ${m.count === 7 ? 'all seven tiles' : m.count === 1 ? 'one tile' : m.count + ' tiles'}.`);
    else if (m.type === 'endrack' && ann.on('all')) out.push(`${who} goes out, and picks up ${pts(m.score)} from the tiles left on the other rack.`);
    ctx.moves = (ctx.moves || 0) + 1;
  }
  if (ann.on('all') && st.phase === 'playing') {
    const lead = scores[0] === scores[1] ? -1 : scores[0] > scores[1] ? 0 : 1;
    if (ctx.lead !== undefined && lead !== ctx.lead) {
      if (lead === -1) out.push(`All tied at ${scores[0]}.`);
      else out.push(`${N[lead]} takes the lead, ${scores[lead]} to ${scores[1 - lead]}.`);
    }
    ctx.lead = lead;
    if (st.bag === 0 && !ctx.bagEmpty) { ctx.bagEmpty = true; out.push('The bag is empty.'); }
    else if (st.bag > 0 && st.bag <= 7 && !ctx.bagLow) { ctx.bagLow = true; out.push(`${st.bag === 1 ? 'One tile' : st.bag + ' tiles'} left in the bag.`); }
  } else ctx.lead = scores[0] === scores[1] ? -1 : scores[0] > scores[1] ? 0 : 1;
  return out;
}

export function gameOverSpeech(st, names) {
  const N = names.map(sayName), sc = st.seats.map((x) => x.score);
  if (st.winner === -1) return `Game over. It's a tie, at ${sc[0]} each!`;
  const w = st.winner, l = 1 - w;
  const lead = st.endReason === 'time' ? `${N[l]} ran out of time. ` : st.endReason === 'resign' ? `${N[l]} resigns. ` : 'Game over. ';
  const margin = sc[w] - sc[l];
  const flavor = margin <= 10 && st.endReason !== 'time' && st.endReason !== 'resign' ? ' What a close game!' : margin >= 150 ? ' A dominant win.' : '';
  return `${lead}${N[w]} wins, ${sc[w]} to ${sc[l]}!${flavor}`;
}

export function clockSpeech(kind, n, name, own = false) {
  const who = own ? '' : `${sayName(name)}, `;
  switch (kind) {
    case '5min': return `${who}five minutes left.`;
    case '1min': return `${who}one minute left.`;
    case 'overtime': return own ? "You're in overtime. Ten points per minute." : `${sayName(name)} is in overtime. Ten points per minute.`;
    case 'overmin': return `${who}${n === 1 ? 'one minute' : n + ' minutes'} over. Minus ${10 * (n + 1)}.`;
    case 'lastmin': return `${who}one minute until you lose on time!`;
  }
  return '';
}
