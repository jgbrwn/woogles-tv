// Spoken announcements ("Alex plays ZOEA for 34").
// 1. Server voice (when the server has WT_TTS_URL set): the sentence is sent to /api/tts and the audio streams back
//    and plays through Web Audio as it arrives. Works on any TV browser that can play sound, e.g. LG webOS.
// 2. Fallback: the Android TV app's native text-to-speech (window.WooglesTV.speak — Android's WebView has no Web
//    Speech API), otherwise the browser's speechSynthesis, in the "backup voice" chosen in the settings.
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
// The server voice can't change its speed, so playback is sped up or slowed down instead; that also shifts the
// pitch, so keep the steps gentle.
const SERVER_RATE = { 0.85: 0.9, 1: 1, 1.2: 1.12 };
// Lead-in before the first server-voice sound after a quiet spell, in seconds (see srvStream).
const SERVER_LEAD = 0.3;

// Voices are identified by name + language: voiceURI isn't unique on every platform (Android Chrome repeats it),
// which made the announcer fall back to the first/previous voice.
const voiceId = (v) => `${v.name}|${v.lang}`;
const findVoice = (list, id) => list.find((x) => voiceId(x) === id) || list.find((x) => x.voiceURI === id) || null;
let stoppedAt = -1e9, estEnd = 0, pendingSay = 0, queuedUntil = 0;
const keep = new Set();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const nextOf = (list, v) => list[(list.indexOf(v) + 1) % list.length];

// ---- server voice ----
let ttsConf = null; // {voices: [{id, name}], sampleRate}; the first voice is the server's default
const confReady = fetch('/api/config').then((r) => r.json()).then((c) => { if (c?.tts?.voices?.length) ttsConf = c.tts; }).catch(() => {});
export const announcerReady = confReady;

const srv = {
  jobs: [],          // sentences waiting to be fetched, in order
  running: false,    // a fetch/stream is in progress
  ctrl: null,        // AbortController of the current fetch
  playHead: 0,       // AudioContext time when the audio scheduled so far ends
  sources: new Set(),
  fails: 0, offUntil: 0, // after repeated failures, use device speech for a while
  gen: 0,            // bumped by stop() so stale work is dropped
};
const srvOk = () => !!ttsConf && performance.now() >= srv.offUntil;

function srvFailed() {
  srv.fails++;
  if (srv.fails >= 2) { srv.offUntil = performance.now() + 60000; srv.fails = 0; }
}

// Plays queued jobs one after another. Each job's audio is scheduled right after the previous job's, and the next
// fetch starts as soon as the previous one has finished downloading (the server generates faster than real time).
async function srvPump() {
  if (srv.running) return;
  srv.running = true;
  try {
    while (srv.jobs.length) {
      const job = srv.jobs.shift(), gen = srv.gen;
      let ok = false;
      try { ok = await srvStream(job, gen); } catch { ok = false; }
      if (gen !== srv.gen) continue; // stopped meanwhile
      if (ok) srv.fails = 0;
      else {
        srvFailed();
        // Speak it on the device instead, once the server audio already scheduled has finished.
        const c = sfx.ctx(), wait = c ? Math.max(0, (srv.playHead - c.currentTime) * 1000) : 0;
        pendingSay++;
        setTimeout(() => { pendingSay--; if (gen === srv.gen) job.fallback(); }, wait);
      }
    }
  } finally { srv.running = false; }
}

// Fetches one sentence and schedules its audio chunk by chunk. Resolves true if any audio played.
async function srvStream(job, gen) {
  const c = sfx.ctx(), out = sfx.out();
  if (!c || !out || c.state !== 'running') return false;
  const ctrl = new AbortController(); srv.ctrl = ctrl;
  const firstByte = setTimeout(() => ctrl.abort(), 5000); // a slow start means late speech: use the device instead
  let res;
  try {
    res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ ...job.creds, text: job.text, voice: job.voice }) });
  } catch { clearTimeout(firstByte); return false; }
  if (!res.ok) { clearTimeout(firstByte); return false; }
  const rate = Number(res.headers.get('X-Sample-Rate')) || ttsConf?.sampleRate || 24000;
  const speed = SERVER_RATE[job.rate] || 1;
  let carry = null, pending = [], pendingLen = 0, played = false;
  const flush = (force) => {
    // Play in pieces of at least 0.1 s (fewer, longer buffers play more smoothly).
    if (!pendingLen || (!force && pendingLen < rate / 10) || gen !== srv.gen) return;
    // Pocket TTS starts speaking on its very first sample. After a quiet spell, the audio output (the browser's
    // sink, HDMI, a TV's optical out, a soundbar) needs a moment to wake up and would swallow the first sound
    // ("Jon" heard as "on"). So the first piece after silence starts with a short lead-in of inaudible noise
    // (about -80 dB: not digital zero, which some outputs treat as "nothing playing") and a 5 ms fade-in.
    const idle = srv.playHead < c.currentTime - 0.05;
    const lead = idle ? Math.round(rate * SERVER_LEAD) : 0;
    const buf = c.createBuffer(1, lead + pendingLen, rate), ch = buf.getChannelData(0);
    for (let i = 0; i < lead; i++) ch[i] = (Math.random() * 2 - 1) * 1e-4;
    let o = lead;
    for (const p of pending) { ch.set(p, o); o += p.length; }
    if (idle) for (let i = 0, n = Math.min(rate / 200, pendingLen); i < n; i++) ch[lead + i] *= i / n;
    pending = []; pendingLen = 0;
    const src = c.createBufferSource();
    src.buffer = buf; src.playbackRate.value = speed; src.connect(out);
    const at = Math.max(srv.playHead, c.currentTime + 0.06);
    src.start(at);
    srv.playHead = at + buf.duration / speed;
    srv.sources.add(src); src.onended = () => srv.sources.delete(src);
    played = true;
  };
  const take = (bytes) => {
    if (carry) { const b = new Uint8Array(carry.length + bytes.length); b.set(carry); b.set(bytes, carry.length); bytes = b; carry = null; }
    if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.subarray(0, bytes.length - 1); }
    if (!bytes.length) return;
    const n = bytes.length / 2, f = new Float32Array(n), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
    pending.push(f); pendingLen += n;
    flush(false);
  };
  try {
    if (res.body && res.body.getReader) {
      const rd = res.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        clearTimeout(firstByte);
        if (done || gen !== srv.gen) break;
        take(value);
      }
    } else { // older browsers: wait for the whole clip
      take(new Uint8Array(await res.arrayBuffer())); clearTimeout(firstByte);
    }
  } catch { clearTimeout(firstByte); /* aborted or the connection dropped: keep whatever already played */ }
  flush(true);
  if (srv.ctrl === ctrl) srv.ctrl = null;
  return played;
}

export function makeAnnouncer(prefix, defMode, creds = () => null) {
  const get = (k, d) => localStorage.getItem(prefix + k) ?? d;
  const A = {
    // voice: server voice id ('' = the server's default); backup: device voice for the fallback (stored under the
    // old 'voice' key, so a voice chosen before server voices existed becomes the backup).
    mode: get('mode', defMode), spell: get('spell', 'bingos'), rate: +get('rate', 1), voice: get('svoice', ''), backup: get('voice', ''),
    hasServer() { return !!ttsConf && !!creds(); },
    hasDevice() { return !!(bridge() || synth()); },
    available() { return this.hasServer() || this.hasDevice(); },
    on(level = 'moves') { return this.mode === 'all' || (this.mode === 'moves' && level === 'moves'); },
    set(k, v) { this[k] = v; localStorage.setItem(prefix + (k === 'voice' ? 'svoice' : k === 'backup' ? 'voice' : k), String(v)); },
    cycleMode() { this.set('mode', nextOf(ANN_MODES, this.mode)); return this.mode; },
    cycleSpell() { this.set('spell', nextOf(SPELL_MODES, this.spell)); return this.spell; },
    cycleRate() { this.set('rate', nextOf(RATES, this.rate)); return this.rate; },
    // Server voices in menu order (the first is the default). Each: {id, name}
    serverVoices() { return ttsConf ? ttsConf.voices : []; },
    serverVoice() { const vs = this.serverVoices(); return vs.find((v) => v.id === this.voice) || vs[0] || null; },
    voiceName() { return this.serverVoice()?.name || 'Default'; },
    cycleVoice() {
      const vs = this.serverVoices(); if (!vs.length) return '';
      this.set('voice', nextOf(vs, this.serverVoice()).id);
      return this.voiceName();
    },
    // Device voices for the fallback, English first. Each: {id, name, lang}
    deviceVoices() {
      let list = [];
      try {
        if (bridge()?.voices) list = JSON.parse(bridge().voices() || '[]').map((v) => ({ id: v.name, name: v.label || v.name, lang: v.lang }));
        else if (synth()) list = synth().getVoices().map((v) => ({ id: voiceId(v), name: v.name, lang: v.lang, local: v.localService }));
      } catch { list = []; }
      const en = list.filter((v) => /^en/i.test(v.lang || ''));
      return en.length ? en : list;
    },
    cycleBackup() {
      const vs = this.deviceVoices(); if (!vs.length) return '';
      const ids = ['', ...vs.map((v) => v.id)];
      this.set('backup', nextOf(ids, ids.includes(this.backup) ? this.backup : ''));
      return this.backupName();
    },
    backupName() { if (!this.backup) return 'Default'; const v = this.deviceVoices().find((x) => x.id === this.backup); return v ? v.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s*\(.*\)$/, '') : 'Default'; },
    stop() {
      srv.gen++; srv.jobs = []; srv.ctrl?.abort(); srv.ctrl = null;
      for (const s of srv.sources) { try { s.stop(); } catch {} }
      srv.sources.clear(); srv.playHead = 0;
      try { bridge()?.stopSpeaking?.(); synth()?.cancel(); } catch {}
      stoppedAt = performance.now(); estEnd = 0;
    },
    // Is anything being said (or about to be)?
    busy() {
      const c = sfx.ready() ? sfx.ctx() : null;
      if (srv.running || srv.jobs.length || (c && c.currentTime < srv.playHead)) return true;
      const b = bridge();
      if (b) { if (typeof b.isSpeaking === 'function') { try { return b.isSpeaking() || performance.now() < stoppedAt + 300; } catch {} } return performance.now() < estEnd; }
      const s = synth();
      return !!(s && (s.speaking || s.pending)) || performance.now() < queuedUntil;
    },
    // Say it once nothing has been said for `gap` ms (e.g. a definition shouldn't talk over a move). Gives up after 90 s.
    sayWhenQuiet(text, gap = 2000) {
      let quietSince = null; const t0 = performance.now();
      const tick = () => {
        if (performance.now() - t0 > 90000) return;
        if (this.busy() || pendingSay > 0) quietSince = null;
        else if (quietSince === null) quietSince = performance.now();
        else if (performance.now() - quietSince >= gap) { this.say(text, { force: true }); return; }
        setTimeout(tick, 200);
      };
      tick();
    },
    // Announcements scheduled with a delay count as "about to speak" for sayWhenQuiet.
    later(fn, ms) { pendingSay++; setTimeout(() => { pendingSay--; fn(); }, ms); },
    // Speak now (queued after anything already speaking). Respects the device's volume; silent when sound is off.
    say(text, { force = false } = {}) {
      if (!text || (!force && this.mode === 'off') || !sfx.enabled) return;
      const cr = creds();
      if (ttsConf && cr && srvOk() && sfx.ready()) {
        const v = this.serverVoice();
        srv.jobs.push({ text, voice: v ? v.id : '', rate: this.rate, creds: cr, fallback: () => this.sayOnDevice(text) });
        srvPump();
        return;
      }
      this.sayOnDevice(text);
    },
    sayOnDevice(text) {
      if (!sfx.enabled) return;
      const vol = sfx.gain;
      // rough length of the speech, for busy() when the platform can't tell us
      estEnd = Math.max(performance.now(), estEnd) + 400 + (text.length * 68) / (this.rate || 1);
      const b = bridge();
      if (b) { try { b.speak(text, this.rate, vol, this.backup || ''); } catch {} return; }
      const s = synth(); if (!s) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.rate; u.volume = vol; u.lang = 'en-US';
      const v = this.backup ? findVoice(s.getVoices(), this.backup) : null;
      if (v) { u.lang = v.lang; try { u.voice = v; } catch {} } // lang too: some engines pick by language
      keep.add(u); u.onend = u.onerror = () => keep.delete(u); // Chrome can drop utterances that get garbage-collected
      // Speaking right after cancel() is unreliable on mobile Chrome (it may be swallowed or keep the old voice),
      // so give the cancel a moment to settle first.
      const wait = 250 - (performance.now() - stoppedAt);
      const go = () => { try { s.resume(); } catch {} s.speak(u); };
      queuedUntil = Math.max(queuedUntil, performance.now() + Math.max(0, wait) + 150);
      if (wait > 0) setTimeout(go, wait); else go();
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
    // NASPA: 10 points for each minute or part of a minute over, so going past n minutes over starts minute n + 1.
    case 'overtime': return own ? "You're in overtime. Minus ten points for each minute, or part of a minute." : `${sayName(name)} is in overtime. Minus ten points for each minute, or part of a minute.`;
    case 'overmin': return `${own ? "You're" : sayName(name) + ' is'} now in minute ${n + 1} of overtime. Minus ${10 * (n + 1)}.`;
    case 'lastmin': return `${who}one minute until you lose on time!`;
  }
  return '';
}

// "Alex played soap at 8 D, for 12 points. Soap means: to treat with a cleansing agent."
export function definitionSpeech(ev, names, ann) {
  const who = sayName(names[ev.player]);
  const w = String(ev.word || '').toLowerCase();
  const spell = ann && ann.spell === 'always' ? `, ${[...String(ev.word).toUpperCase()].join(', ')},` : '';
  const pos = String(ev.pos || '').replace(/(\d)([A-Z])/g, '$1 $2').replace(/([A-Z])(\d)/g, '$1 $2');
  let t = `${who} played ${w}${spell}${pos ? ' at ' + pos : ''}, for ${pts(ev.score)}. `;
  const senses = ev.senses || [];
  if (!senses.length) return t + `Sorry, I couldn't find a definition for ${w}.`;
  t += `${w[0].toUpperCase() + w.slice(1)}${senses[0].pos ? ', ' + senses[0].pos + ',' : ''} means: ${senses[0].text}.`;
  if (senses[1] && senses[1].text !== senses[0].text) t += ` It can also mean: ${senses[1].text}.`;
  return t;
}
