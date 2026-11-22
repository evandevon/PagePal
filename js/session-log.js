// Session data collection, built on Word Helper's log.
//
// Records how each word was entered (typed, dictated, suggestion, spell
// correction), which words and blocks were listened to, and active working
// time, then turns that into summary stats, a text report and a CSV.
// No DOM code here, so it can be unit-tested and reused on every screen.

// A gap longer than this (no typing, talking or listening) pauses "time working".
export const IDLE_MS = 5000;

export const CONNECTIVES = new Set([
  'and', 'but', 'or', 'so', 'yet', 'for', 'nor', 'because', 'although', 'though',
  'even', 'while', 'whereas', 'unless', 'until', 'since', 'after', 'before', 'when', 'if', 'that', 'which',
  'however', 'therefore', 'furthermore', 'meanwhile', 'nevertheless', 'consequently', 'additionally',
  'moreover', 'otherwise', 'instead', 'finally', 'firstly', 'secondly', 'also', 'then', 'next', 'suddenly',
  'eventually', 'later', 'earlier', 'besides', 'despite', 'except',
]);

export const HOW_LABELS = {
  typed: 'Typed',
  dictated: 'Spoken (dictation)',
  suggestion: 'Word suggestion',
  corrected: 'Spell correction',
  listened: 'Listened to',
};

export class SessionLog {
  constructor({ student = '', worksheet = 'Practice', now = () => Date.now() } = {}) {
    this.now = now;
    this.student = student;
    this.worksheet = worksheet;
    this.start = null;        // ms timestamp of first activity
    this.lastActivity = null;
    this.activeStart = null;  // start of current active stretch
    this.activeMs = 0;        // completed active stretches
    this.words = [];          // {word, how, t, from}
    this.events = [];         // {type, t, ...}
    this.priorWorkingMs = 0;  // from earlier sittings (worksheet reopened)
    this.priorTotalMs = 0;
  }

  /** Plain object for saving with a worksheet. */
  toState() {
    return {
      student: this.student, worksheet: this.worksheet,
      firstStarted: this.firstStarted || this.start,
      priorWorkingMs: this.workingSecs() * 1000,
      priorTotalMs: this.totalSecs() * 1000,
      words: this.words, events: this.events,
    };
  }

  /** Carry on a session saved with a worksheet: times add up across sittings. */
  static fromState(state, opts = {}) {
    const log = new SessionLog(opts);
    if (!state) return log;
    log.firstStarted = state.firstStarted || null;
    log.priorWorkingMs = state.priorWorkingMs || 0;
    log.priorTotalMs = state.priorTotalMs || 0;
    log.words = state.words || [];
    log.events = state.events || [];
    return log;
  }

  _t() { return this.start ? (this.now() - this.start) / 1000 : 0; }

  /** Call on any student action. Keeps "time working" running. */
  activity() {
    const now = this.now();
    if (!this.start) this.start = now;
    if (this.activeStart !== null && now - this.lastActivity > IDLE_MS) {
      // The previous stretch ended when the student went idle.
      this.activeMs += (this.lastActivity + IDLE_MS) - this.activeStart;
      this.activeStart = null;
    }
    if (this.activeStart === null) this.activeStart = now;
    this.lastActivity = now;
  }

  logWord(word, how, from = null) {
    const clean = String(word).replace(/[^\p{L}\p{N}'’-]/gu, '');
    if (!clean) return;
    this.activity();
    this.words.push({ word: clean, how, t: +this._t().toFixed(1), from });
  }

  /** Log every word in a phrase (e.g. a dictated sentence). */
  logPhrase(text, how) {
    String(text).split(/\s+/).forEach(w => this.logWord(w, how));
  }

  /** scope: 'word' | 'block' | 'answer' */
  logListen(text, scope = 'word') {
    this.activity();
    this.events.push({ type: 'listen', scope, text: String(text).slice(0, 200), t: +this._t().toFixed(1) });
  }

  logEvent(type, extra = {}) {
    this.activity();
    this.events.push({ type, t: +this._t().toFixed(1), ...extra });
  }

  workingSecs() {
    let ms = this.priorWorkingMs + this.activeMs;
    if (this.activeStart !== null) {
      const end = Math.min(this.now(), this.lastActivity + IDLE_MS);
      ms += Math.max(0, end - this.activeStart);
    }
    return Math.round(ms / 1000);
  }

  totalSecs() {
    return Math.round((this.priorTotalMs + (this.start ? this.now() - this.start : 0)) / 1000);
  }

  /**
   * Summary stats. `finalText` is the student's finished writing, used for
   * vocabulary variety, words per minute and connectives (as in Word Helper).
   */
  stats(finalText = '') {
    const count = how => this.words.filter(w => w.how === how).length;
    const typed = count('typed'), dictated = count('dictated');
    const suggestion = count('suggestion'), corrected = count('corrected');
    const entered = typed + dictated + suggestion + corrected;
    const allWords = finalText.toLowerCase().split(/\s+/).filter(w => /\p{L}/u.test(w)).map(w => w.replace(/[^\p{L}'’-]/gu, ''));
    const unique = new Set(allWords);
    const working = this.workingSecs();
    const listens = this.events.filter(e => e.type === 'listen');
    return {
      totalSecs: this.totalSecs(),
      workingSecs: working,
      wordsWritten: allWords.length,
      typed, dictated, suggestion, corrected,
      assistanceRate: entered ? Math.round((dictated + suggestion + corrected) / entered * 100) : null,
      ttr: allWords.length >= 5 ? +(unique.size / allWords.length).toFixed(2) : null,
      wpm: working > 0 && allWords.length ? Math.round(allWords.length / (working / 60)) : null,
      connectives: allWords.filter(w => CONNECTIVES.has(w)).length,
      listens: listens.length,
      wordsListened: [...new Set(listens.filter(e => e.scope === 'word').map(e => e.text.toLowerCase()))],
      dictationRetries: this.events.filter(e => e.type === 'dictation_retry').length,
    };
  }

  toJSON(finalText = '') {
    return {
      app: 'PagePal',
      student: this.student,
      worksheet: this.worksheet,
      started: (this.firstStarted || this.start) ? new Date(this.firstStarted || this.start).toISOString() : null,
      stats: this.stats(finalText),
      answer: finalText,
      words: this.words,
      events: this.events,
    };
  }
}

export function fmtDuration(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * One CSV cell. Text starting with = + - @ (or a tab / return) gets a leading
 * apostrophe, so Excel or Sheets shows it as text instead of running it as a
 * formula (a student could otherwise type =HYPERLINK(…) as an "answer").
 */
export const csvCell = v => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** Spreadsheet-friendly report: summary rows, then one row per word. */
export function toCSV(log, finalText = '') {
  const st = log.stats(finalText);
  const date = (log.firstStarted || log.start) ? new Date(log.firstStarted || log.start) : new Date();
  const rows = [
    ['PagePal session report'],
    ['Student', log.student],
    ['Worksheet', log.worksheet],
    ['Date', date.toLocaleString('en-AU')],
    [],
    ['Total time (s)', st.totalSecs],
    ['Time working (s)', st.workingSecs],
    ['Words written', st.wordsWritten],
    ['Typed', st.typed],
    ['Spoken (dictation)', st.dictated],
    ['From suggestions', st.suggestion],
    ['Spell corrections', st.corrected],
    ['Assistance rate (%)', st.assistanceRate],
    ['Vocabulary variety (TTR)', st.ttr],
    ['Words per minute', st.wpm],
    ['Connectives used', st.connectives],
    ['Times listened', st.listens],
    ['Words listened to', st.wordsListened.join(' ')],
    [],
    ['Answer', finalText],
    [],
    ['#', 'Word', 'How entered', 'Started as', 'Time into session (s)'],
    ...log.words.map((w, i) => [i + 1, w.word, HOW_LABELS[w.how] || w.how, w.from || '', w.t]),
  ];
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Short plain-text summary, suitable for an email body. */
export function toText(log, finalText = '') {
  const st = log.stats(finalText);
  const date = (log.start ? new Date(log.start) : new Date()).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  const lines = [
    `PagePal report: ${log.student || 'Student'}, ${log.worksheet}, ${date}`,
    '',
    `Time working: ${fmtDuration(st.workingSecs)} of ${fmtDuration(st.totalSecs)}`,
    `Words written: ${st.wordsWritten} (typed ${st.typed}, spoken ${st.dictated}, suggestions ${st.suggestion}, corrections ${st.corrected})`,
    `Assistance rate: ${st.assistanceRate === null ? '-' : st.assistanceRate + '%'}`,
    `Vocabulary variety: ${st.ttr ?? '-'} · Words per minute: ${st.wpm ?? '-'} · Connectives: ${st.connectives}`,
    `Listened ${st.listens} times${st.wordsListened.length ? ': ' + st.wordsListened.join(', ') : ''}`,
  ];
  if (finalText.trim()) lines.push('', 'Answer:', finalText.trim());
  return lines.join('\n');
}
