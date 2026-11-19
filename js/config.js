// PagePal — app-wide settings that teachers or developers may need to change.
// Everything else (display mode, voice, speed…) is chosen in the app and
// remembered per device by settings.js.

export const APP_NAME = 'PagePal';
export const APP_VERSION = '0.4.1'; // Stage 2+ — page menu, drawing, new pages

// Language for dictation and the preferred read-aloud accent.
export const SPEECH_LANG = 'en-AU';

// Google Drive (used from Stage 4, QR codes → PDF).
// Worksheets shared as "Anyone with the link can view" are downloaded with
// the Drive API and a browser API key. Create the key in Google Cloud
// Console, enable the Google Drive API, and restrict the key to the
// HTTP referrer https://evandevon.github.io/* so nobody else can use it.
// An API key restricted this way is safe to commit to a public repo.
export const GOOGLE_API_KEY = '';
