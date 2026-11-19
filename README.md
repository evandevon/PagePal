# PagePal

A free worksheet helper for K-6 students that runs in the browser. Students load a worksheet, tap any word to hear it read aloud, answer by typing or talking, then send the finished work to their teacher.

**Live site:** https://evandevon.github.io/PagePal/ (turn on GitHub Pages: Settings › Pages › Deploy from branch › `main` / root)

PagePal builds on two earlier projects: [Say It, Spell It](https://evandevon.github.io/speak-a-word/) (dictation) and [Word Helper](https://evandevon.github.io/Word_Helper/) (read-aloud, display modes, session data).

## Progress

- [x] **Stage 0: Foundations.** App shell, display modes, voice and speed settings, hold-to-talk dictation, tap-to-hear text, session data, email / share / save to Files, works offline and installs to the Home Screen.
- [ ] **Stage 1: Load and view.** Open a PDF, take a photo and crop it, zoom and pan, recent worksheets.
- [ ] **Stage 2: Type on the page.** Text boxes, stamps, undo, export the finished page as a PDF or image.
- [ ] **Stage 3: Dictation on the page.** Mic into the selected text box, hear my answer, suggestions and spell check.
- [ ] **Stage 4: QR to PDF.** Scan a QR code that links to a worksheet in Google Drive; teacher QR maker page.
- [ ] **Stage 5: Read aloud.** Text from PDFs, on-device text recognition for photos, tap a word or play a block.
- [ ] **Stage 6: Data and reports.** Full report, timeline graph, and "Send to teacher" into the teacher's own Google Sheet, set up by scanning a teacher QR code.
- [ ] **Stage 7: Polish and rollout.** Accessibility checks, testing on school iPads and Chromebooks, teacher guide.

## Try Stage 0

On the home screen, the **Try the helpers** card has a sentence to tap and play, an answer box with **Hold to talk**, and **Hear my answer**. Then **Send my work to the teacher**:

- **Email or share:** opens the iPad share sheet with the report attached as a CSV file (Mail, AirDrop, Google Classroom, Seesaw, Drive).
- **Email summary:** opens an email draft with a short text summary, addressed to the teacher's email from Settings. Email links can't carry attachments, so this is the fallback.
- **Save to Files:** downloads the CSV report. On iPad it lands in Files › Downloads.

## Project structure

No build step: plain HTML, CSS and JavaScript modules. Edit a file on GitHub and the site updates.

```
index.html             Home screen and settings dialog
app.css                All styles, including the display modes
manifest.webmanifest   Home Screen install details
sw.js                  Offline support (bump CACHE_VERSION when adding files)
js/
  app.js               Connects the modules to the page
  config.js            App version, speech language, Google API key
  settings.js          Per-device settings (localStorage)
  display-modes.js     Colour and font modes from Word Helper
  tts.js               Read aloud: voice ranking, sentence chunking, word timing
  dictation.js         Hold-to-talk speech-to-text (iPad-safe, from Say It, Spell It)
  readable.js          Tap a word to hear it; play a block with word highlighting
  session-log.js       Session data, stats, CSV and text reports (from Word Helper)
  export.js            Share sheet, email draft, save to Files
  store.js             On-device storage for worksheets (IndexedDB)
  ui.js                Small shared helpers
fonts/                 OpenDyslexic (SIL Open Font License)
icons/                 App icons
tests/                 Unit tests for the pure logic (run: node --test)
```

## Running it locally

Speech and the service worker need `https` or `localhost`:

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Run the unit tests with `node --test` (Node 20 or later). `package.json` exists only for the tests; the site needs no install.

## Privacy

There are no accounts, no server and no analytics. Names, answers and session data stay on the device until a student chooses to share them. Dictation audio is processed by the browser maker's speech service (Google in Chrome, Apple in Safari); read-aloud runs on the device.

## Credits

- Font: [OpenDyslexic](https://opendyslexic.org) by Abbie Gonzalez, SIL Open Font License 1.1.
