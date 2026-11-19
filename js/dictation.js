// Hold-to-talk dictation (speech-to-text) using the Web Speech API.
//
// Carried over from Say It, Spell It, which was tested on iPads:
// - Safari's `continuous = true` mode is broken (the mic never stops and no
//   result comes back), so we use continuous = false and start a fresh
//   recogniser each time one ends while the button is still held.
// - Re-using one recogniser across many start/stop cycles is flaky on iOS,
//   so a new instance is created for every start.
// - Pointer capture on the button (not document-wide listeners) means a
//   finger sliding off the button still ends the recording, without
//   swallowing taps elsewhere on the page.
// Audio is processed by the browser maker's speech service (Google in
// Chrome, Apple in Safari), so dictation needs a network connection.

import { SPEECH_LANG } from './config.js';

const Ctor = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : undefined;

/** 'ok' | 'unsupported' (no API, e.g. Firefox) | 'insecure' (not https) */
export function dictationStatus() {
  if (!Ctor) return 'unsupported';
  if (window.isSecureContext === false) return 'insecure';
  return 'ok';
}

export class Dictation {
  /**
   * @param {object} cb
   * @param {(text:string)=>void} [cb.onPreview]  live transcript while talking
   * @param {(text:string)=>void} [cb.onResult]   final text when the button is released
   * @param {(listening:boolean)=>void} [cb.onState]
   * @param {(message:string)=>void} [cb.onError]
   * @param {()=>void} [cb.onEmpty]  released but nothing was heard
   */
  constructor(cb = {}) {
    this.cb = cb;
    this.listening = false;
    this.finalText = '';
    this.interimText = '';
    this.rec = null;
  }

  _create() {
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = SPEECH_LANG;
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += (this.finalText ? ' ' : '') + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      this.interimText = interim.trim();
      this.cb.onPreview && this.cb.onPreview(this._full());
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this._setListening(false);
        this.cb.onError && this.cb.onError('The microphone is blocked. Allow it for this site in Settings, then try again.');
      } else if (e.error === 'network') {
        this._setListening(false);
        this.cb.onError && this.cb.onError('Talking needs the internet. Check the wifi and try again.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.cb.onError && this.cb.onError('Listening problem: ' + e.error);
      }
    };
    rec.onend = () => {
      if (this.listening) {
        // A natural pause ended this segment; the button is still held.
        this.rec = this._create();
        try { this.rec.start(); } catch { /* already starting */ }
      } else {
        this._finish();
      }
    };
    return rec;
  }

  _full() { return (this.finalText + ' ' + this.interimText).trim(); }

  _setListening(on) {
    this.listening = on;
    this.cb.onState && this.cb.onState(on);
  }

  _finish() {
    const text = this._full();
    this.finalText = '';
    this.interimText = '';
    this.cb.onPreview && this.cb.onPreview('');
    if (text) this.cb.onResult && this.cb.onResult(text);
    else this.cb.onEmpty && this.cb.onEmpty();
  }

  start() {
    if (dictationStatus() !== 'ok' || this.listening) return;
    this.finalText = '';
    this.interimText = '';
    this._setListening(true);
    this.rec = this._create();
    try { this.rec.start(); } catch { /* already started */ }
  }

  stop() {
    if (!this.listening) return;
    this._setListening(false);
    if (this.rec) { try { this.rec.stop(); } catch { this._finish(); } }
    else this._finish();
  }

  /** Throw away anything heard (e.g. when leaving a screen). */
  abort() {
    this.listening = false;
    this.finalText = '';
    this.interimText = '';
    if (this.rec) { try { this.rec.abort(); } catch { /* ignore */ } }
    this.cb.onState && this.cb.onState(false);
  }

  /** Wire a button so recording happens only while it is held down. */
  attachHoldButton(btn) {
    const start = e => { e.preventDefault(); this.start(); };
    const stop = e => { if (e) e.preventDefault(); this.stop(); };
    if (window.PointerEvent) {
      btn.addEventListener('pointerdown', e => {
        try { btn.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
        start(e);
      });
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
    } else {
      btn.addEventListener('mousedown', start);
      btn.addEventListener('touchstart', start, { passive: false });
      document.addEventListener('mouseup', () => this.stop());
      document.addEventListener('touchend', () => this.stop());
      document.addEventListener('touchcancel', () => this.stop());
    }
    // Long-press on iPad would otherwise open the text-selection magnifier.
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('keydown', e => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); this.start(); }
    });
    btn.addEventListener('keyup', e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.stop(); }
    });
    btn.addEventListener('blur', () => { if (this.listening) this.stop(); });
  }
}
