# PagePal

A free worksheet helper for K-6 students that runs in the browser. Students load a worksheet, tap any word to hear it read aloud, answer by typing or talking, then send the finished work to their teacher.

**Live site:** https://evandevon.github.io/PagePal/ (turn on GitHub Pages: Settings › Pages › Deploy from branch › `main` / root)

PagePal builds on two earlier projects: [Say It, Spell It](https://evandevon.github.io/speak-a-word/) (dictation) and [Word Helper](https://evandevon.github.io/Word_Helper/) (read-aloud, display modes, session data).

## Progress

- [x] **Stage 0: Foundations.** App shell, display modes, voice and speed settings, hold-to-talk dictation, tap-to-hear text, session data, email / share / save to Files, works offline and installs to the Home Screen.
- [x] **Stage 1: Get a worksheet.** Scan QR code, open a file (PDF, Word .docx, picture), take photos with four-corner straightening and clean-up (multi-page), paste a picture or link, worksheet viewer with pinch zoom, recent worksheets. Save to Files / share now include page images named to match the CSV. Teacher page for worksheet and class QR codes; Send to teacher.
- [x] **Stage 2: Type on the page.** Tap to add a text box; move, resize, bigger/smaller, colour, delete; tick, cross and circle stamps; undo/redo; autosaves with the session data. Saved, shared and sent page pictures include the answers.
- [ ] **Stage 3: Dictation on the page.** Done: hold-to-talk into the selected box, Hear. Still to do: word suggestions and spell check from Word Helper.
- [ ] **Stage 4: QR to PDF.** Mostly done in Stage 1 (scanning, Drive links, teacher QR page); needs the Google API key below and testing on school iPads.
- [ ] **Stage 5: Read aloud.** Text from PDFs, on-device text recognition for photos, tap a word or play a block.
- [ ] **Stage 6: Data and reports.** Full report, timeline graph, and "Send to teacher" into the teacher's own Google Sheet, set up by scanning a teacher QR code.
- [ ] **Stage 7: Polish and rollout.** Accessibility checks, testing on school iPads and Chromebooks, teacher guide.

## Try Stage 0

On the home screen, the **Try the helpers** card has a sentence to tap and play, an answer box with **Hold to talk**, and **Hear my answer**. Then **Send my work to the teacher**:

- **Email or share:** opens the iPad share sheet with the report attached as a CSV file (Mail, AirDrop, Google Classroom, Seesaw, Drive).
- **Email summary:** opens an email draft with a short text summary, addressed to the teacher's email from Settings. Email links can't carry attachments, so this is the fallback.
- **Save to Files:** downloads the CSV report. On iPad it lands in Files › Downloads.

## Teacher page

`teacher.html` (linked from Settings › “For teachers: make QR codes”) makes two kinds of QR code:

1. **Worksheet QR:** paste a Google Drive link. The page checks the file is shared and is a type students can open, then shows a printable QR code.
2. **Class QR:** for receiving student work in a Google Sheet. See the [teacher set-up guide](https://claude.ai/artifact/D4guC9H9etjt9FgFegXvW7) and `teacher/PagePal-Inbox.gs`.

What opens from Google Drive:

| File | Result |
| --- | --- |
| PDF, Google Docs, Slides, Sheets, Drawings | Opens exactly (Google exports the Google files as PDF) |
| Word (.docx) | Laid out on the device; simple worksheets look right, complex layouts may shift |
| JPG, PNG, GIF, WebP | Opens as a page picture (HEIC only on iPads) |
| PowerPoint, Excel, .doc, .odt, .rtf | Not opened; the teacher page explains how to save as a Google file or PDF |

## Google Drive set-up (once, by whoever runs the site)

Students' iPads aren't signed in to Google, so PagePal downloads Drive worksheets through the Google Drive API with an API key. It's free.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project called **PagePal**.
2. **APIs & Services › Library**: find **Google Drive API** and click **Enable**.
3. **APIs & Services › Credentials › Create credentials › API key**.
4. Edit the key: under **Application restrictions** choose **Websites** and add `https://evandevon.github.io/*`; under **API restrictions** choose **Restrict key** and tick **Google Drive API**. Save.
5. Paste the key into `GOOGLE_API_KEY` in `js/config.js` and commit. Restricted like this, the key only works from the PagePal site, so it's safe in a public repo.

Worksheets must be shared as **Anyone with the link can view**. If your school's Google Workspace blocks that, ask IT, or upload PDFs to the repo and use `?pdf=` links instead.

## Project structure

No build step: plain HTML, CSS and JavaScript modules. Edit a file on GitHub and the site updates.

```
index.html             Home screen, worksheet viewer, crop and scanner screens, dialogs
app.css                All styles, including the display modes
teacher.html, .css     Teacher page: worksheet and class QR codes
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
  worksheets.js        Turning PDFs, Word files and photos into saved worksheets
  viewer.js            Worksheet screen: pages, zoom, pinch, page images for sending
  annotate.js          Text boxes and stamps on the page, undo, drawing answers into page images
  pdf-doc.js           PDF.js wrapper
  docx-doc.js          Word (.docx) layout via docx-preview + html2canvas
  image-tools.js       Four-corner straightening, rotate, "Clean up" scanner effect
  crop.js              Crop screen for photos and pasted pictures
  qr-scan.js           Camera QR scanner (BarcodeDetector or jsQR)
  links.js             Understanding QR / pasted / address links; teacher codes
  remote.js            Downloading from Google Drive (API key) or the web
  send.js              Share, save, email and Send to teacher, with paired file names
  teacher.js           Teacher page logic
  ui.js                Small shared helpers
lib/                   Third-party libraries, kept locally for offline use (see lib/README.md)
fonts/                 OpenDyslexic (SIL Open Font License)
icons/                 App icons
teacher/PagePal-Inbox.gs  Google Apps Script the teacher pastes into a Google Sheet to receive work (Stage 6)
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
