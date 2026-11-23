// The web version of "Use as a screen" in the Tricky Words app.
// It tunes in to the phone's broadcast by code and only ever displays.
import { RealtimeClient } from '/screen/realtime.js';

const SUPABASE_URL = 'https://iqslfmttpqougzmvtotn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_eMk34Jl0GUfpTH88B_dPYA_5yBHK1rE';
const PROTOCOL_VERSION = 1;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const RESULT_HOLD_MS = 2200;
const HOST_SILENCE_MS = 15000;

const $ = (id) => document.getElementById(id);
const join = $('join'), stage = $('stage'), view = $('view'), input = $('code'), problem = $('code-problem');

/** Same forgiving reading as the app: lower case, spaces, dashes, 0 for O and 1 for I. */
function parseCode(text) {
  let raw = text.trim();
  const fromLink = /[?&]code=([^&#\s]+)/i.exec(raw);
  if (fromLink) raw = fromLink[1];
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

function isScreenMessage(m) {
  if (!m || typeof m !== 'object' || m.v !== PROTOCOL_VERSION || typeof m.seq !== 'number') return false;
  const s = m.state;
  if (!s || typeof s !== 'object') return false;
  if (s.phase === 'waiting' || s.phase === 'done' || s.phase === 'writing') return true;
  if (s.phase === 'result' || s.phase === 'copy' || s.phase === 'reveal') {
    return typeof s.word === 'string' && s.word.length > 0 && s.word.length <= 40;
  }
  return false;
}

// ---- Sound ----
let soundOn = true;
const sounds = {};
for (const name of ['correct', 'incorrect', 'mastered']) {
  const audio = new Audio(`/sounds/${name}.wav`);
  audio.preload = 'auto';
  sounds[name] = audio;
}
function play(name) {
  if (!soundOn) return;
  const audio = sounds[name].cloneNode();
  audio.play().catch(() => {});
}
/** Browsers only allow sound after a tap or key press, so this runs from the join button. */
function unlockSound() {
  for (const audio of Object.values(sounds)) {
    audio.muted = true;
    audio.play().then(() => { audio.pause(); audio.currentTime = 0; audio.muted = false; }).catch(() => { audio.muted = false; });
  }
}

// ---- Drawing ----
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Makes the word as large as the sheet allows. */
function fitWord() {
  const word = view.querySelector('.word');
  const sheet = view.querySelector('.sheet');
  if (!word || !sheet) return;
  const style = getComputedStyle(sheet);
  const room = sheet.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const tallest = window.innerHeight * 0.34;
  let size = 400;
  word.style.fontSize = size + 'px';
  const wide = word.scrollWidth;
  if (wide > room) size = Math.floor(size * room / wide);
  size = Math.max(28, Math.min(size, tallest));
  word.style.fontSize = size + 'px';
  sheet.style.setProperty('--line', Math.round(size * 1.25) + 'px');
}

function sheetWith(word, ruled) {
  const sheet = el('div', ruled ? 'sheet ruled' : 'sheet');
  sheet.append(el('div', 'word', word));
  return sheet;
}

function draw(state, link) {
  view.replaceChildren();
  const showingWord = state.phase === 'result' || state.phase === 'copy' || state.phase === 'reveal';
  if ((!link.connected || !link.hostPresent) && !showingWord) {
    view.append(el('p', 'headline', link.connected ? 'Waiting for the phone' : 'Connecting…'));
    view.append(el('p', 'hint', link.connected ? 'In the app, tap "Second screen" to start sharing.' : 'Check the internet connection.'));
    return;
  }
  if (state.phase === 'waiting') {
    view.append(el('p', 'headline', 'Connected'), el('p', 'hint', 'Practice will start in a moment.'));
  } else if (state.phase === 'writing') {
    view.append(el('div', 'pencil', '✏️'), el('p', 'headline', 'Listen and write'));
  } else if (state.phase === 'reveal') {
    view.append(el('p', 'hint', 'Check your spelling'), sheetWith(state.word, false));
  } else if (state.phase === 'result') {
    view.append(el('div', state.outcome === 'mastered' ? 'tick gold' : 'tick', state.outcome === 'mastered' ? '★' : '✓'), sheetWith(state.word, false));
    if (state.outcome === 'mastered') view.append(el('div', 'badge', 'Mastered!'));
  } else if (state.phase === 'copy') {
    view.append(el('p', 'hint', 'Copy this word'), sheetWith(state.word, true));
  } else if (state.phase === 'done') {
    view.append(el('div', 'tick', '✓'), el('p', 'headline', 'Done for today'));
  }
  fitWord();
}

// ---- Live link ----
let client = null;
let leave = null;

function tuneIn(code) {
  client ??= new RealtimeClient(SUPABASE_URL.replace(/^http/, 'ws') + '/realtime/v1', { params: { apikey: SUPABASE_KEY } });
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  const channel = client.channel('tricky-words-screen-' + code, {
    config: { broadcast: { self: false }, presence: { key: 'screen-' + id } },
  });

  let shown = { phase: 'waiting' };
  let shownAt = 0;
  let pending = null;
  let timer = null;
  let lastSeq = -1;
  let lastHeard = Date.now();
  const link = { connected: false, hostPresent: false };

  const show = (state) => {
    shown = state;
    shownAt = Date.now();
    if (state.phase === 'result') play(state.outcome === 'mastered' ? 'mastered' : 'correct');
    else if (state.phase === 'copy' && state.missed) play('incorrect');
    draw(shown, link);
  };
  // A correct word stays up for a moment even if the phone has already moved on.
  const receive = (state) => {
    const wait = shown.phase === 'result' ? Math.max(0, RESULT_HOLD_MS - (Date.now() - shownAt)) : 0;
    clearTimeout(timer);
    if (wait === 0) show(state);
    else { pending = state; timer = setTimeout(() => { const next = pending; pending = null; show(next); }, wait); }
  };
  const hosts = () => {
    let count = 0;
    for (const list of Object.values(channel.presenceState())) for (const p of list) if (p.role === 'host') count += 1;
    return count;
  };
  const refresh = () => {
    link.hostPresent = hosts() > 0 && Date.now() - lastHeard < HOST_SILENCE_MS;
    if (!pending) draw(shown, link);
  };

  channel
    .on('broadcast', { event: 'state' }, ({ payload }) => {
      lastHeard = Date.now();
      if (!isScreenMessage(payload)) return;
      if (payload.seq === lastSeq) { if (!link.hostPresent) refresh(); return; }
      lastSeq = payload.seq;
      link.hostPresent = true;
      receive(payload.state);
    })
    .on('presence', { event: 'sync' }, () => { if (hosts() > 0) lastHeard = Date.now(); refresh(); })
    .subscribe((status) => {
      link.connected = status === 'SUBSCRIBED';
      if (link.connected) {
        channel.track({ role: 'screen' }).catch(() => {});
        channel.send({ type: 'broadcast', event: 'hello', payload: {} }).catch(() => {});
      }
      refresh();
    });

  const watchdog = setInterval(refresh, 3000);
  draw(shown, link);
  return () => {
    clearInterval(watchdog);
    clearTimeout(timer);
    client.removeChannel(channel).catch(() => {});
  };
}

// ---- Page wiring ----
function start(code) {
  join.hidden = true;
  stage.hidden = false;
  $('stage-code').textContent = 'Code ' + code.slice(0, 3) + ' ' + code.slice(3);
  history.replaceState(null, '', location.pathname + '?code=' + code);
  leave = tuneIn(code);
}

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = parseCode(input.value);
  if (!code) { problem.hidden = false; input.focus(); return; }
  problem.hidden = true;
  unlockSound();
  start(code);
});
input.addEventListener('input', () => {
  problem.hidden = true;
  const clean = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  input.value = clean.length > 3 ? clean.slice(0, 3) + ' ' + clean.slice(3) : clean;
});
$('leave').addEventListener('click', () => {
  if (leave) leave();
  leave = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  stage.hidden = true;
  join.hidden = false;
  history.replaceState(null, '', location.pathname);
  input.value = '';
  input.focus();
});
$('sound').addEventListener('click', (event) => {
  soundOn = !soundOn;
  if (soundOn) unlockSound();
  event.currentTarget.textContent = soundOn ? 'Sound on' : 'Sound off';
  event.currentTarget.setAttribute('aria-pressed', String(soundOn));
});
$('full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
});
if (!document.documentElement.requestFullscreen) $('full').hidden = true;
window.addEventListener('resize', fitWord);

// For checking the look without a phone: /screen/?demo=copy:beautiful
const demo = new URLSearchParams(location.search).get('demo');
const fromLink = parseCode(location.search);
if (demo) {
  const [phase, word = 'because'] = demo.split(':');
  join.hidden = true;
  stage.hidden = false;
  $('stage-code').textContent = 'Demo';
  draw({ phase, word, outcome: phase === 'mastered' ? 'mastered' : 'correct', missed: true, ...(phase === 'mastered' ? { phase: 'result' } : {}) }, { connected: phase !== 'connecting', hostPresent: phase !== 'nophone' && phase !== 'connecting' });
} else if (fromLink) {
  // Opened from a link with the code in it: join straight away. Sound needs one tap, so the button says so.
  soundOn = false;
  $('sound').textContent = 'Turn sound on';
  $('sound').setAttribute('aria-pressed', 'false');
  start(fromLink);
} else {
  input.focus();
}
