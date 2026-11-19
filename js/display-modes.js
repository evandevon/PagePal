// Display modes, carried over from Word Helper.
// Each mode is a CSS class on <body> (see app.css, "Display modes"), so the
// colours and fonts live in the stylesheet and this file only lists them.

export const DISPLAY_MODES = {
  dyslexia: {
    label: 'Yellow · OpenDyslexic',
    desc: 'Soft yellow background, OpenDyslexic font, wide line spacing',
  },
  regular: {
    label: 'White · Arial',
    desc: 'Standard view',
  },
  highcontrast: {
    label: 'Black and white · Arial',
    desc: 'White text on black, for low vision or bright rooms',
  },
  darkblue: {
    label: 'Dark blue · OpenDyslexic',
    desc: 'Yellow text on dark blue, OpenDyslexic font',
  },
  large: {
    label: 'Extra large · OpenDyslexic',
    desc: 'Extra large text and very wide spacing, for younger students',
  },
};

export function applyDisplayMode(key) {
  const mode = DISPLAY_MODES[key] ? key : 'dyslexia';
  const body = document.body;
  Object.keys(DISPLAY_MODES).forEach(k => body.classList.remove('mode-' + k));
  body.classList.add('mode-' + mode);
  // Keep the browser chrome (iPad status bar, Android toolbar) in step.
  const dark = mode === 'highcontrast' || mode === 'darkblue';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#07101E' : '#1D9E75';
  return mode;
}
