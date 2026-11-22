# PagePal

A free worksheet helper for K-6 students that runs in the browser. Students load a worksheet, tap any word to hear it read aloud, answer by typing or talking, then send the finished work to their teacher.

**Live site:** https://evandevon.github.io/PagePal/ (turn on GitHub Pages: Settings › Pages › Deploy from branch › `main` / root)

PagePal builds on two earlier projects: [Say It, Spell It](https://evandevon.github.io/speak-a-word/) (dictation) and [Word Helper](https://evandevon.github.io/Word_Helper/) (read-aloud, display modes, session data).

## Progress

- [x] **Stage 0: Foundations.** App shell, display modes, voice and speed settings, hold-to-talk dictation, tap-to-hear text, session data, email / share / save to Files, works offline and installs to the Home Screen.
- [x] **Stage 1: Get a worksheet.** Scan QR code, open a file (PDF, Word .docx, picture), take photos with four-corner straightening and clean-up (multi-page), paste a picture or link, worksheet viewer with pinch zoom, recent worksheets. Save to Files / share now include page images named to match the CSV. Teacher page for worksheet and class QR codes; Send to teacher.
- [x] **Stage 2: Type on the page.** Press and hold (or right-click) anywhere on the page, or tap **+ Add**, for a menu (Type, Talk, Tick, Cross, Circle, Draw); a short tap never adds anything, so stray taps and taps on words are safe. Text boxes: move, resize, bigger/smaller, colour, delete; tick, cross and circle stamps; freehand Draw with a Done drawing bar; undo/redo; autosaves with the session data. Saved, shared and sent page pictures include the answers.
- [x] **New page:** lined (wide / narrow), handwriting (dotted middle line), story page, 1 cm and 5 mm squares, dot grid, blank; Add page for longer work.
- [x] **Stage 3: Talk on the page.** Talk (press-and-hold menu) types spoken words into an answer box. iPad auto-correct is off in answer boxes, so answers show the student's own spelling. (Word suggestions and spell check were tried and taken out to keep PagePal simple; they live in Word Helper.)
- [ ] **Stage 4: QR to PDF.** Mostly done in Stage 1 (scanning, Drive links, teacher QR page); needs the Google API key below and testing on school iPads.
- [x] **Stage 5: Read aloud.** Tap **Hear** on the toolbar and swipe a finger over words like a highlighter: just that area is read and spoken, each word lighting up purple as it's said, with a **Stop reading** button. PDFs use their own text (exact, instant); photos, pictures, Word files and scanned PDFs have the swiped area read by on-device text recognition (Tesseract). With an answer box selected, Hear reads the answer. The app version shows in small print beside the PagePal name on the home screen.
- [ ] **Stage 6: Data and reports.** Full report, timeline graph, and "Send to teacher" into the teacher's own Google Sheet, set up by scanning a teacher QR code.
- [ ] **Stage 7: Polish and rollout.** Accessibility checks, testing on school iPads and Chromebooks, teacher guide.

## Sending work

PagePal is a worksheet tool: the home screen is just the student's name, **Get a worksheet** and **My worksheets**. When a worksheet is done, **Send** offers:

- **Send to teacher:** (after scanning the class QR code) a row in the teacher's Google Sheet with the answers and stats, and a PDF of the worksheet in their Drive.
- **Email or share:** opens the iPad share sheet with the CSV report and page pictures (Mail, AirDrop, Google Classroom, Seesaw, Drive).
- **Email summary:** an email draft with a short text summary, addressed to the teacher's email from Settings.
- **Save to Files:** downloads the CSV report and page pictures. On iPad they land in Files › Downloads.

(The home screen's "Try the helpers" practice card was removed to keep PagePal a worksheet tool; typing helpers live in Word Helper.)

## Teacher page

`teacher.html` (linked from Settings › “For teachers: make QR codes”) makes two kinds of QR code:

1. **Worksheet QR:** paste a Google Drive link. The page checks the file is shared and is a type students can open, then shows a printable QR code.
2. **Class QR:** for receiving student work in a Google Sheet. It expires after the time the teacher picks. See the [teacher set-up guide](https://claude.ai/artifact/D4guC9H9etjt9FgFegXvW7), `teacher/PagePal-Inbox.gs` and `teacher/appsscript.json`.

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
sw.js                  Offline support: fresh files when online, saved copy offline (bump CACHE_VERSION when adding files)
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
  annotate.js          Text boxes, stamps and pen strokes on the page, long press, undo, drawing answers into page images
  templates.js         New-page types (lined, handwriting, grids…), drawn on the device
  pdf-doc.js           PDF.js wrapper
  docx-doc.js          Word (.docx) layout via docx-preview + html2canvas
  image-tools.js       Four-corner straightening, rotate, "Clean up" scanner effect
  crop.js              Crop screen for photos and pasted pictures
  qr-scan.js           Camera QR scanner (BarcodeDetector or jsQR)
  links.js             Understanding QR / pasted / address links; teacher codes
  remote.js            Downloading from Google Drive (API key) or the web
  send.js              Share, save, email and Send to teacher, with paired file names
  pdf-writer.js        Tiny PDF maker (one JPEG per page) for Send to teacher
  page-text.js         Reading the words under a Hear swipe (PDF text, or text recognition)
  teacher.js           Teacher page logic
  ui.js                Small shared helpers
lib/                   Third-party libraries, kept locally for offline use (see lib/README.md)
fonts/                 OpenDyslexic (SIL Open Font License)
icons/                 App icons
teacher/PagePal-Inbox.gs  Google Apps Script the teacher pastes into a Google Sheet to receive work
teacher/appsscript.json   Its permission settings (this sheet + files it creates only)
tests/                 Unit tests for the pure logic (run: node --test)
```

## Running it locally

Speech and the service worker need `https` or `localhost`:

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Run the unit tests with `node --test` (Node 20 or later). `package.json` exists only for the tests; the site needs no install.

## Names, files and folders

Every send carries the **student's name** and the **worksheet name**. Both are editable at the top of the Send dialog (and the worksheet name by tapping the title bar). Each worksheet remembers the student who started it, so on a shared iPad Mia's sheet still says Mia, and when Jack scans the same worksheet QR code he gets his own fresh copy.

| Where | Organised as |
|---|---|
| Teacher's Drive (Send to teacher) | `PagePal submissions › 3/4K › Fractions page 12 › Mia S – Fractions page 12 – 2026-11-21 1430.pdf` (class, then worksheet; files sort by student; sending again adds a new, later file) |
| Word Helper work (same class QR code, inbox script v4) | Its own spreadsheet, **Word Helper submissions**, made by the script inside `Word Helper submissions` in the teacher's Drive; PDFs (if sent) in `Word Helper submissions › 3/4K › Mia S – Word Helper – 2026-11-21 1430.pdf` |
| Teacher's sheet | One row per send: student, worksheet, class, stats, answers, PDF link. Filter or sort by the Worksheet column. |
| Save to Files / share | `Mia-S_Fractions-page-12_2026-11-21_1430.csv` plus `…_p1.jpg`, `…_p2.jpg` (one name per sitting, so the CSV and its pictures stay paired) |

Tips for tidy folders: students type **first name and surname initial** (`Mia S`) the same way every time; worksheets from a teacher's worksheet QR code arrive already named, so students don't need to rename them; photos and blank pages get a made-up name, and the Send dialog asks for a better one.

**Unfinished work** is saved on the iPad as the student goes. **My worksheets** on the home screen shows each one with the student's name and *Not sent yet*, *Sent 21 Nov* or *Sent · changed since*. Tapping it reopens on the page where the student stopped. Safari may clear a website's saved data after 7 days without a visit, so add PagePal to the Home Screen on shared iPads (the Home Screen app keeps its data).

## Security

How sending work to a teacher is protected (details in the teacher set-up guide):

- **No server of ours.** Work goes from the iPad straight to the teacher's own Google Sheet (an Apps Script web app the teacher deploys).
- **Narrow permissions.** `teacher/appsscript.json` limits the script to its own spreadsheet and the Drive files it creates (`spreadsheets.currentonly`, `drive.file`). It uses the Drive API directly because Apps Script's DriveApp always requires access to the whole Drive.
- **Join codes, not keys, on the wall.** A class QR code holds a join code that the script issues and that expires (1 day to 1 term). Scanning it swaps the join code for the sending key. `resetCode()` replaces the key and cancels every join code.
- **Write-only.** The web app accepts submissions; nothing can be read back through it.
- **File checks.** Pictures and PDFs must really be JPEG, PNG or PDF (checked by their first bytes), 5 MB at most. Anything else is refused and noted in the sheet.
- **Rate limits.** At most 60 sends a minute and 1,500 a day.
- **No formulas at all.** The sheet holds no formulas: students' text is stored as text (an answer like `-5` or `=HYPERLINK(…)` shows exactly as typed but never runs) and page links are plain links. The CSV students save marks such cells as text too.
- **Not covered:** student identity (no logins, so anyone with a current code or a connected iPad can send in any name), and the content of what students send.

**For whoever looks after this repo:** anyone who can change the code here can change where every iPad sends work. Turn on two-factor sign-in for the GitHub account, and only give write access to people you trust.

## Privacy

There are no accounts, no server and no analytics. Names, answers and session data stay on the device until a student chooses to share them. Dictation audio is processed by the browser maker's speech service (Google in Chrome, Apple in Safari); read-aloud and text recognition run on the device, so worksheet photos are never uploaded for reading.

## Credits

- Font: [OpenDyslexic](https://opendyslexic.org) by Abbie Gonzalez, SIL Open Font License 1.1.
