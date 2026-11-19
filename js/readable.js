// Tap-to-hear text.
//
// Turns a list of words into tappable elements: tap a word to hear it, or
// play the whole block with each word lit up as it is spoken. In Stage 0 it
// powers the practice card; from Stage 5 the same functions drive the words
// found on a worksheet (positioned over the page instead of flowing as text).

import * as tts from './tts.js';

/**
 * Build tappable word spans inside `container`.
 * @returns {{play: () => Promise<void>, words: HTMLElement[]}}
 */
export function makeReadable(container, text, { onListen } = {}) {
  container.textContent = '';
  container.classList.add('readable');
  const words = [];
  text.split(/(\s+)/).forEach(part => {
    if (!part) return;
    if (/^\s+$/.test(part)) { container.append(part); return; }
    const span = document.createElement('span');
    span.className = 'rw';
    span.textContent = part;
    span.tabIndex = 0;
    span.setAttribute('role', 'button');
    span.setAttribute('aria-label', 'Hear ' + part.replace(/[^\p{L}\p{N}'’-]/gu, ''));
    words.push(span);
    container.append(span);
  });

  const sayWord = span => {
    const word = span.textContent.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!word) return;
    flash(span);
    tts.speak(word);
    onListen && onListen(word, 'word');
  };

  container.addEventListener('click', e => {
    const span = e.target.closest('.rw');
    if (span && container.contains(span)) sayWord(span);
  });
  container.addEventListener('keydown', e => {
    const span = e.target.closest('.rw');
    if (span && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sayWord(span); }
  });

  const play = async () => {
    onListen && onListen(text, 'block');
    container.classList.add('playing');
    let current = null;
    await tts.readWords(words.map(w => w.textContent), {
      onWord: i => {
        if (current) current.classList.remove('speaking');
        current = words[i];
        if (current) current.classList.add('speaking');
      },
    });
    if (current) current.classList.remove('speaking');
    container.classList.remove('playing');
  };

  return { play, words };
}

function flash(el) {
  el.classList.remove('speaking');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
}
