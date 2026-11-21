# Third-party libraries

Copied here (not loaded from a CDN) so PagePal works offline and keeps working if a CDN changes.

| Library | Version | Used for | Licence |
| --- | --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, legacy build) | 4.10.38 | Showing PDF worksheets and reading their text | Apache 2.0 (`pdfjs/LICENSE`) |
| [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Reading QR codes from the camera where the browser has no built-in reader (iPad Safari) | Apache 2.0 (`jsQR.LICENSE`) |
| [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | 0.4.1 | Laying out Word (.docx) worksheets in the browser | Apache 2.0 (`docx/docx-preview.LICENSE`) |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.2 | Opening .docx files (needed by docx-preview) | MIT (`docx/jszip.LICENSE.md`) |
| [html2canvas](https://github.com/niklasvh/html2canvas) | 1.4.1 | Turning laid-out Word pages into page images | MIT (`docx/html2canvas.LICENSE`) |
| [Tesseract.js](https://github.com/naptha/tesseract.js) + tesseract.js-core | 7.0.0 | On-device text recognition, so words on photos can be read aloud (`tesseract/`; English `4.0.0_best_int` data from `@tesseract.js-data/eng`) | Apache 2.0 (`tesseract/*.LICENSE*`) |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 2.0.4 | Drawing QR codes on the teacher page | MIT, © Kazuhiko Arase |

The legacy PDF.js build is used because it supports older iPads (iPadOS 15/16) that school fleets often still run.

The Word libraries are only downloaded the first time someone opens a .docx file.

The text-recognition files (about 7 MB for one device: the worker, one core build and the English data) are downloaded in the background once PagePal is installed, so photos can be read offline.
