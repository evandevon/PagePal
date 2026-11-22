// Read aloud (text-to-speech) using the browser's built-in voices.
//
// Voice ranking is carried over from Word Helper, with Australian English
// preferred. Long text is spoken one sentence at a time, because Chrome
// stops long utterances after about 15 seconds. Word boundary events are
// mapped back to the caller's words so the current word can be highlighted.

import { SPEECH_LANG } from './config.js';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;

export const ttsSupported = () => !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

// Novelty / robotic voices on Apple devices (from Word Helper).
const BAD_VOICES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged',
  'good news', 'hysterical', 'junior', 'kathy', 'organ', 'pipe organ', 'princess',
  'ralph', 'trinoids', 'whisper', 'wobble', 'zarvox', 'fred', 'jester', 'siri',
  'superstar', 'bruce', 'vicki', 'victoria', 'audrey',
]);

function isBadVoice(name) {
  const n = name.toLowerCase().trim();
  return BAD_VOICES.has(n) || BAD_VOICES.has(n.split(' ')[0]);
}

/** Higher is better; negative means "don't offer this voice". */
export function rankVoice(v) {
  if (!v.lang || !v.lang.toLowerCase().startsWith('en')) return -1;
  if (isBadVoice(v.name)) return -1;
  const n = v.name.toLowerCase();
  let score = 10;
  const known = [
    ['karen', 96], ['google uk english female', 95], ['samantha', 94], ['lee', 90],
    ['google uk english male', 90], ['catherine', 89], ['natasha', 89], ['william', 88],
    ['moira', 86], ['fiona', 85], ['kate', 84], ['daniel', 84], ['aria', 82], ['guy', 82],
    ['jenny', 80], ['ryan', 80], ['sonia', 78], ['alex', 76], ['google us english', 70],
    ['zira', 60], ['mark', 40], ['david', 35],
  ];
  for (const [key, val] of known) if (n.includes(key)) { score = val; break; }
  // Prefer the app's accent (en-AU), then voices installed on the device
  // (they work offline and support word boundary events more reliably).
  if (v.lang.replace('_', '-').toLowerCase() === SPEECH_LANG.toLowerCase()) score += 15;
  if (v.localService) score += 5;
  return score;
}

let voices = [];
const voiceListeners = new Set();

function refreshVoices() {
  if (!synth) return;
  voices = synth.getVoices()
    .filter(v => rankVoice(v) > 0)
    .sort((a, b) => rankVoice(b) - rankVoice(a));
  voiceListeners.forEach(fn => fn(voices));
}

if (synth) {
  refreshVoices();
  // Chrome loads voices asynchronously; Safari sometimes never fires the event.
  if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', refreshVoices);
  setTimeout(refreshVoices, 500);
}

/** The usable English voices, best first. */
export const getVoices = () => voices.slice();

/** fn(voices) is called whenever the voice list changes. */
export function onVoicesChanged(fn) {
  voiceListeners.add(fn);
  if (voices.length) fn(voices.slice());
  return () => voiceListeners.delete(fn);
}

let preferredVoiceName = '';
let rate = 0.88;

export function setVoice(name) { preferredVoiceName = name || ''; }
export function setRate(r) { rate = Math.min(1.5, Math.max(0.5, Number(r) || 0.88)); }

function currentVoice() {
  if (preferredVoiceName) {
    const v = voices.find(x => x.name === preferredVoiceName);
    if (v) return v;
  }
  return voices[0] || null;
}

/**
 * Split text into sentence-sized chunks, keeping each chunk's offset in the
 * original string so boundary events can be mapped back.
 * Chunks longer than maxLen are split again at the last space before maxLen.
 */
export function splitIntoChunks(text, maxLen = 220) {
  const chunks = [];
  const re = /[^.!?\n]+[.!?]*["')\]]*\s*|\n+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let piece = m[0];
    let offset = m.index;
    while (piece.length > maxLen) {
      let cut = piece.lastIndexOf(' ', maxLen);
      if (cut <= 0) cut = maxLen;
      chunks.push({ text: piece.slice(0, cut), offset });
      piece = piece.slice(cut);
      offset += cut;
    }
    if (piece.trim()) chunks.push({ text: piece, offset });
  }
  return chunks;
}

/** Given sorted word start offsets, return the index of the word containing charIndex. */
export function wordIndexAt(starts, charIndex) {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= charIndex) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

let runId = 0;
// Voices seen to report word positions (so no guessing is needed).
const boundaryVoices = new Set();
const voiceKey = v => (v ? v.name : 'default');
let speakingNow = false;
const speakingListeners = new Set();

function setSpeaking(on) {
  if (on === speakingNow) return;
  speakingNow = on;
  speakingListeners.forEach(fn => fn(on));
}

/** fn(true | false) when reading aloud starts and stops (for a Stop button). */
export function onSpeakingChange(fn) {
  speakingListeners.add(fn);
  return () => speakingListeners.delete(fn);
}

export const isSpeaking = () => speakingNow;

// iPad and iPhone Safari only start speech as a direct response to a tap.
// Hear speaks a moment after the swipe (once the words are read), which
// Safari can silently block. Speaking a silent, empty utterance during the
// tap itself unlocks speech for the rest of the visit.
let unlocked = false;

/** Call from inside a tap or swipe handler, before any waiting. */
export function unlock() {
  if (unlocked || !synth || typeof SpeechSynthesisUtterance === 'undefined') return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
    unlocked = true;
  } catch { /* try again on the next tap */ }
}

/** Stop anything currently being read. */
export function stop() {
  runId++;
  if (synth) synth.cancel();
  setSpeaking(false);
}

/**
 * Speak text. Resolves when finished (or stopped).
 * opts.onBoundary(charIndex) fires as each word starts, with an index into `text`.
 */
export function speak(text, opts = {}) {
  return new Promise(resolve => {
    if (!ttsSupported() || !text || !text.trim()) { resolve(); return; }
    stop();
    const myRun = runId;
    const chunks = splitIntoChunks(text);
    const voice = currentVoice();
    let i = 0;
    setSpeaking(true);

    const next = () => {
      if (myRun !== runId || i >= chunks.length) {
        if (myRun === runId) setSpeaking(false);
        resolve();
        return;
      }
      const chunk = chunks[i++];
      const u = new SpeechSynthesisUtterance(chunk.text);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = SPEECH_LANG;
      u.rate = rate;
      u.pitch = 1;
      // Some voices (Chrome's online Google voices, a few others) never say
      // which word they're on. For those, guess from the speaking rate so the
      // highlight still moves along; a real word event cancels the guessing.
      let guessTimers = [];
      const stopGuessing = () => { guessTimers.forEach(clearTimeout); guessTimers = []; };
      u.onstart = () => {
        if (!opts.onBoundary || boundaryVoices.has(voiceKey(voice))) return;
        const cps = 13.5 * rate; // characters a second at this rate
        const re = /\S+/g;
        let m;
        while ((m = re.exec(chunk.text)) !== null) {
          const at = m.index;
          guessTimers.push(setTimeout(() => {
            if (myRun === runId) opts.onBoundary(chunk.offset + at);
          }, (at / cps) * 1000 + 120));
        }
      };
      u.onboundary = e => {
        if (myRun !== runId) return;
        if (e.name && e.name !== 'word') return;
        if (guessTimers.length) stopGuessing();
        boundaryVoices.add(voiceKey(voice));
        opts.onBoundary && opts.onBoundary(chunk.offset + e.charIndex);
      };
      u.onend = () => { stopGuessing(); next(); };
      u.onerror = () => { stopGuessing(); next(); }; // 'interrupted' / 'canceled' end the run via runId
      synth.speak(u);
    };
    next();
  });
}

/**
 * Read a list of words, calling onWord(index) as each one is spoken.
 * Used for "play the whole block" with karaoke-style highlighting.
 */
export async function readWords(words, { onWord, onEnd } = {}) {
  const starts = [];
  let text = '';
  words.forEach((w, idx) => {
    if (idx) text += ' ';
    starts.push(text.length);
    text += w;
  });
  let last = -1;
  await speak(text, {
    onBoundary: ci => {
      const idx = wordIndexAt(starts, ci);
      if (idx !== last) { last = idx; onWord && onWord(idx); }
    },
  });
  onEnd && onEnd();
}
