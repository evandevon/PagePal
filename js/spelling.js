// Word suggestions, spell check and definitions, from Word Helper
// (evandevon/Word_Helper), adapted for PagePal's answer boxes. The logic is
// Word Helper's own (comments kept); PagePal changes:
//   - outside lookups go through lookup(), so the "Look up unusual words
//     online" setting can turn them off (then the offline fallbacks run);
//   - when an online check finishes, listeners are told (instead of
//     re-running Word Helper's editor spell pass).
//
// What leaves the iPad, and only when online lookups are on: a single word,
// to Datamuse (api.datamuse.com: is this a real word / what are close
// spellings) or the Free Dictionary API (api.dictionaryapi.dev: a
// definition). Never a name, sentence or worksheet.

import { WORD_LIST, HIGH_FREQ_WORDS, BLOCK, BLOCK_ROOTS, TEXTSPEAK_MISSPELLINGS, LETTER_HOMOPHONES, LOCAL_DEFS } from './words-data.js';

const WORD_SET = new Set(WORD_LIST.map(w => w.toLowerCase()));
const MIN_VALID_SCORE = 3000;
const MIN_VALID_FREQ = 3;
const verifiedWords = new Set();
const rejectedWords = new Set();
const pendingWords = new Set();
const debugLog = () => {};

let online = true;
/** Allow (true) or stop (false) single-word lookups with Datamuse and the Free Dictionary API. */
export function setOnline(on) { online = !!on; }

function lookup(url) {
  if (!online) return Promise.reject(new Error('online lookups are off'));
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.reject(new Error('offline'));
  return fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
}

const checkedListeners = new Set();
/** fn(word) when an online check decides whether a word is spelt right. */
export function onChecked(fn) { checkedListeners.add(fn); return () => checkedListeners.delete(fn); }
function notifyChecked(word) { checkedListeners.forEach(fn => { try { fn(word); } catch { /* ignore */ } }); }

/** Is this one of the built-in school words? */
export const isKnownWord = w => WORD_SET.has(String(w).toLowerCase());

function endsInCVC(w) {
  if (w.length < 3) return false;
  const vowels = 'aeiou';
  const a = w[w.length - 3], b = w[w.length - 2], c = w[w.length - 1];
  return !vowels.includes(a) && vowels.includes(b) && !vowels.includes(c) && !'wxy'.includes(c);
}

function stripInflection(w) {
  const safe = [];  // not affected by consonant doubling
  const bare = [];  // is affected — needs the endsInCVC guard

  if (/ies$/.test(w)) safe.push(w.replace(/ies$/, 'y'));   // studies -> study
  if (/ied$/.test(w)) safe.push(w.replace(/ied$/, 'y'));   // studied -> study
  if (/ing$/.test(w)) {
    bare.push(w.replace(/ing$/, ''));                       // testing -> test
    safe.push(w.replace(/ing$/, 'e'));                      // hoping -> hope
  }
  if (/ed$/.test(w)) {
    bare.push(w.replace(/ed$/, ''));                        // tested -> test
    safe.push(w.replace(/ed$/, 'e'));                       // hoped -> hope
  }
  if (/es$/.test(w)) safe.push(w.replace(/es$/, ''));      // boxes -> box
  if (/s$/.test(w)) safe.push(w.replace(/s$/, ''));        // tests -> test
  if (/er$/.test(w)) bare.push(w.replace(/er$/, ''));      // tester -> test
  if (/est$/.test(w)) bare.push(w.replace(/est$/, ''));    // fastest -> fast

  const safeHit = safe.find(c => c.length >= 2 && WORD_SET.has(c));
  if (safeHit) return safeHit;
  return bare.find(c => c.length >= 2 && WORD_SET.has(c) && !endsInCVC(c)) || null;
}

function verifyWordWithDatamuse(word) {
  if (pendingWords.has(word)) return;
  pendingWords.add(word);

  // Ask Datamuse for words spelled/sounding like this one — no wildcard.
  // A wildcard prefix search (sp=word*) pulls in unrelated LONGER words and
  // multi-word phrases that just happen to start with the same letters,
  // and those routinely outrank the real word itself: "jelly*" topped with
  // the phrase "jelly roll", and "lived*" topped with the obscure medical
  // term "livedoid" — both beat the actual word on Datamuse's internal
  // rank score, which used to make this code wrongly reject them as
  // misspelled (it required the word to be the literal #1 result). Dropping
  // the wildcard restricts results to genuine close-spelling neighbors.
  //
  // Validity is judged by real-world usage frequency (md=f), not rank
  // score: the word must appear in the results, and its own frequency
  // must not be massively dwarfed by a much more common near-spelling.
  // That gap is the actual signature of a typo — "begining" appears at
  // 0.1 uses/million while "beginning" sits at 92/million (~900x more
  // common). Two unrelated real words of different everyday-ness never
  // differ anywhere near that much (e.g. "lived" 64/million vs "live"
  // 101/million; "jelly" 2.2/million vs "belly" 6.3/million).
  lookup('https://api.datamuse.com/words?sp=' + encodeURIComponent(word) + '&max=10&md=f')
    .then(r => r.json())
    .then(data => {
      pendingWords.delete(word);
      const wl = word.toLowerCase();

      function freqOf(entry) {
        if (!entry || !entry.tags) return 0;
        const tag = entry.tags.find(t => t.startsWith('f:'));
        return tag ? (parseFloat(tag.slice(2)) || 0) : 0;
      }

      const self = data.find(d => d.word.toLowerCase() === wl);
      const exists = !!self;
      const selfFreq = freqOf(self);
      const others = data.filter(d => d.word.toLowerCase() !== wl);
      const topRival = others.reduce((best, d) => (freqOf(d) > freqOf(best) ? d : best), null);
      const maxOtherFreq = freqOf(topRival);

      // Not dominated: a rival can be more common (real words vary in
      // everyday-ness) as long as it's not >20x more common — that gap
      // consistently separates "different real word" from "typo of a
      // much more common one" in practice.
      const notDominated = maxOtherFreq === 0 || selfFreq * 20 >= maxOtherFreq;
      // Absolute floor — mainly guards the case where the word has no
      // rivals to compare against at all.
      const minFreq = others.length === 0 ? 1 : 0.05;
      const passesA = exists && notDominated && selfFreq >= minFreq;

      debugLog('verify "' + word + '" | freq: ' + selfFreq.toFixed(3) + '/million | top rival: ' +
        (topRival ? topRival.word + '(' + maxOtherFreq.toFixed(3) + ')' : 'none') + ' | ' +
        (passesA ? 'VALID' : 'FLAGGED'));
      if (passesA) {
        verifiedWords.add(word);
      } else {
        rejectedWords.add(word);
      }
      notifyChecked(word);
    })
    .catch(() => {
      pendingWords.delete(word);
      // Datamuse unavailable (offline, blocked by a network/firewall, API
      // down, etc.) — use local heuristics as fallback.
      const wl = word.toLowerCase();

      // First: is this just a common inflection (-ing/-ed/-s/-er/-est/...)
      // of a word we already know is real? Our curated list is only ~4,000
      // words and doesn't carry every conjugated form of every entry (e.g.
      // it has "test" but not "testing"/"tested"/"tests") — without this
      // check, a word like "testing" falls through to the edit-distance
      // check below, where it happens to be exactly one letter away from
      // the unrelated real word "tasting" and gets wrongly flagged.
      const root = stripInflection(wl);
      if (root && WORD_SET.has(root)) {
        debugLog('verify "' + word + '" | OFFLINE fallback | inflection of known word "' + root + '" | VALID');
        verifiedWords.add(word);
        notifyChecked(word);
        return;
      }

      // Otherwise: if the word is within edit distance 1 of a known word,
      // it's likely a misspelling. If no close match exists, give benefit
      // of the doubt.
      // A word is likely a misspelling if a known word exists within
      // edit distance 1 AND is the same length or longer (not just a
      // shorter root — "tells" is not a misspelling of "tell").
      const hasCloseMatch = WORD_LIST.some(cand => {
        const cl = cand.toLowerCase();
        if (cl.length < wl.length) return false; // ignore shorter roots
        if (Math.abs(cl.length - wl.length) > 1) return false;
        return levenshtein(wl, cl) === 1;
      });
      debugLog('verify "' + word + '" | OFFLINE fallback | close match: ' + hasCloseMatch + ' | ' + (hasCloseMatch ? 'FLAGGED' : 'VALID'));
      if (hasCloseMatch) {
        rejectedWords.add(word);
      } else {
        verifiedWords.add(word);
      }
      notifyChecked(word);
    });
}

function isLikelyMisspelled(word) {
  const clean = word.toLowerCase().replace(/^[\'-]+|[\'-]+$/g, '');
  if (!clean) return false;
  if (clean.length === 1) {
    // "a" and "I" are the only real single-letter English words. Every
    // other lone letter ("r", "u", "b", "c", "y"...) is almost always
    // texting shorthand (are, you, be, see, why) rather than a genuine
    // word — and Datamuse is the wrong tool to tell the difference, since
    // single letters reliably show up in its corpus with real frequency
    // for their own reasons (e.g. "y" the chromosome/variable, "k" for
    // "okay") that have nothing to do with what a child meant.
    return clean !== 'a' && clean !== 'i';
  }
  if (TEXTSPEAK_MISSPELLINGS.has(clean)) return true; // known phonetic/text-speak — always underline
  if (WORD_SET.has(clean)) return false;          // in our curated list — fine
  if (verifiedWords.has(clean)) return false;     // confirmed real by Datamuse — fine
  if (rejectedWords.has(clean)) return true;      // confirmed bad by Datamuse — underline
  // Not yet verified — trigger async check, don't underline yet
  verifyWordWithDatamuse(clean);
  return false; // innocent until proven guilty
}

function isBlocked(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  // 1. Exact whole-word match
  if (BLOCK.has(w)) return true;
  // 2. Substring check for longer roots (5+ chars) — low false-positive risk at this length
  //    Catches compound/hyphenated forms like "bullshitting", "assholes", "fucker" etc.
  for (const b of BLOCK) {
    if (b.length >= 5 && w.includes(b)) return true;
  }
  // 3. Substring check for safe short roots — catches "shithead", "fuck-boy", "wanker" etc.
  //    These roots were verified not to appear inside common innocent English words.
  for (const b of BLOCK_ROOTS) {
    if (w.includes(b) && w.length > b.length) return true;
  }
  return false;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function localSugg(prefix) {
  const pl = prefix.toLowerCase();
  return WORD_LIST
    .filter(w => w.toLowerCase().startsWith(pl) && w.toLowerCase() !== pl && !isBlocked(w))
    .map(w => ({ word: w, score: (HIGH_FREQ_WORDS.has(w.toLowerCase()) ? 200000 : 5000) - (w.length - prefix.length) * 3000 }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 5)
    .map(d => d.word);
}

function phonemeVariants(w) {
  const variants = new Set([w]);

  // Ordered longest-first so multi-char patterns match before their sub-patterns
  const subs = [
    // ════════════════════════════════════════════════════════
    // Phonetic substitution table
    // CRITICAL consonant rules run FIRST to avoid hitting MAX_VARIANTS
    // ════════════════════════════════════════════════════════

    // ── Critical consonant mappings (run first, before vowel explosion) ──
    ['ph', ['f']],                         // phone→fone (reverse lookup)
    ['f',  ['ph']],                        // fone→phone ✓
    ['wr', ['r']],                         // write→rite (reverse)
    ['r',  ['wr']],                        // rite→write ✓
    ['kn', ['n']],                         // knife→nife (reverse)
    ['n',  ['kn']],                        // nife→knife ✓
    ['wh', ['w']],                         // when→wen (reverse)
    ['w',  ['wh']],                        // wen→when ✓
    ['mb', ['m']],                         // lamb→lam (reverse)
    ['m',  ['mb']],                        // thum→thumb ✓
    ['gn', ['n']],                         // gnaw→naw
    ['gh', ['f','g','']],                  // rough→ruf
    ['ck', ['k','c']],                     // back→bak
    ['k',  ['c','ck']],                    // bak→back
    ['qu', ['kw','k']],                    // queen→kween
    ['th', ['t','d','f']],                 // that→dat, with→wif
    ['sh', ['ch','s']],
    ['ch', ['k','sh','tch']],

    // ── 5+ char patterns ──
    ['ight',  ['it','ite','yt']],          // nite→night, lite→light
    ['ought', ['ot','awt','ort']],         // bawt→bought, thot→thought
    ['aught', ['ort','awt','ot']],         // taut/taught
    ['ough',  ['oo','ow','uf','off','o']], // enuf→enough, coff→cough
    ['shun',  ['tion','sion','cion']],     // nayshun→nation
    ['zhun',  ['sion','tion']],            // tenshun→tension
    ['eigh',  ['ay','ai','a']],            // weigh, eight

    // ── 4-char patterns ──
    ['tion',  ['shun','sion']],
    ['sion',  ['shun','tion','zhun']],
    ['ould',  ['ud','od','ood']],          // could→cud reverse
    ['ious',  ['us','eus']],
    ['ness',  ['nis','nas']],              // hapines→happiness
    ['able',  ['abel','abul','ibal']],     // possibal→possible
    ['ible',  ['ibel','ibul','abel']],     // terribel→terrible
    ['tion',  ['shon','shun']],
    ['ally',  ['alee','ali']],             // really→reely
    ['ully',  ['ulee','uli']],
    ['elly',  ['elee','eli']],
    ['illy',  ['ilee','ili']],

    // ── 3-char patterns ──
    ['air', ['are','ear','ere']],          // their, there, wear
    ['are', ['air','ear']],
    ['igh', ['i','ie','y']],               // high, sigh
    ['ore', ['or','aw','au']],             // more, store
    ['or',  ['aw','au','ore']],            // crorl→crawl ✓
    ['aw',  ['or','ore','au']],            // tawk→talk
    ['ure', ['oor','yer','ur']],           // sure, cure
    ['ear', ['eer','ere','air','er']],     // bear, fear, wear
    ['eer', ['ear','ere']],
    ['oor', ['or','aw','ur']],             // floor, poor
    ['ite', ['ight','it']],                // nite→night ✓
    ['ate', ['ait','ight']],               // weight, wait
    ['ane', ['ain','eign']],               // plain, reign
    ['ile', ['ial','yal']],                // trial
    ['ive', ['iv','yv']],
    ['alk', ['ork','awk','ak']],           // talk→tawk, walk→wak
    ['alk', ['alk']],
    ['all', ['awl','ol','al']],            // fall, ball
    ['ell', ['el','ul']],                  // bell→bel
    ['ill', ['il','yl']],                  // hill→hil
    ['ull', ['ul','ool']],                 // full→ful
    ['oll', ['ol','owl']],                 // roll→rol
    ['err', ['ur','ir','er']],             // blur, stir
    ['irr', ['er','ur']],                  // mirror
    ['urr', ['er','ir']],                  // blur
    ['arr', ['ar','er']],
    ['nit', ['knit']],
    ['rit', ['writ']],
    ['ild', ['ld','id']],                  // child→chid (dropping l)
    ['old', ['od','ld']],                  // cold→cod
    ['ild', ['ild']],
    ['ble', ['bul','bel','bal']],          // possible→possibal
    ['ple', ['pul','pel','pal']],          // people→peopul
    ['kle', ['kul','kel']],               // tickle→tikul
    ['tle', ['tul','tel','tal']],          // little→litul
    ['dle', ['dul','del']],               // middle→midul
    ['gle', ['gul','gel']],               // single→singul
    ['nle', ['nul','nel']],
    ['str', ['st','str']],                 // street→stret (cluster drop)
    ['spl', ['sp','spl']],                 // splash→spash
    ['spr', ['sp','spr']],                 // spring→spring
    ['scr', ['sc','sk','scr']],            // scratch→scach
    ['thr', ['th','thr']],                 // three→free (via f/th)
    ['nd',  ['n','nd']],                   // friend→frien (dropping d)
    ['ld',  ['l','ld']],                   // cold→col, old→ol
    ['st',  ['s','st']],                   // first→firs
    ['ft',  ['f','ft']],                   // left→lef
    ['er',  ['ur','ir','a']],              // girl→gerl, bird→berd ✓
    ['ir',  ['er','ur','ea']],             // bird→berd ✓
    ['ur',  ['er','ir']],                  // hurt→hert ✓
    ['ar',  ['er','a']],                   // sugar→suger

    // ── 2-char patterns ──
    ['ee', ['ea','ie','ey','ei','e']],
    ['ea', ['ee','e','ie']],
    ['oa', ['oe','ow','o']],
    ['oe', ['oa','ow']],
    ['ow', ['ou','oa','o']],
    ['ou', ['ow','oo','oul','ould']],      // shoud→should ✓
    ['oo', ['ew','ue','ou','ui','u']],     // buk→book ✓ (u→oo)
    ['ew', ['oo','ue','ou']],
    ['ue', ['oo','ew','ou']],
    ['oi', ['oy']],
    ['oy', ['oi']],
    ['au', ['aw','or','o']],
    ['aw', ['au','or','o']],
    ['ay', ['ai','ey','a']],
    ['ai', ['ay','a','ei']],
    ['ei', ['ai','ay','ee']],
    ['ey', ['ay','ee','y']],
    ['ie', ['igh','y','i','ee']],
    ['ng', ['n','nk']],                    // ring→rin
    ['dg', ['j','g']],                     // judge→juje
    ['j',  ['dge','ge']],                   // frij→fridge, brij→bridge
    ['g',  ['dge']],                         // frige→fridge, brige→bridge
    ['ss', ['s']],                         // miss→mis
    ['s',  ['ss']],                         // mis→miss, clas→class, les→less
    ['ll', ['l']],                         // full→ful, bell→bel
    ['l',  ['ll']],                         // bel→bell, ful→full, smal→small
    ['tt', ['t']],                         // butter→buter
    ['t',  ['tt']],                         // buter→butter, spageti→spaghetti
    ['nn', ['n']],                         // funny→funy
    ['mm', ['m']],                         // hammer→hamer
    ['rr', ['r']],                         // arrow→arow
    ['pp', ['p']],                         // happy→hapy
    ['bb', ['b']],                         // rabbit→rabit
    ['dd', ['d']],                         // middle→midle
    ['ff', ['f']],                         // off→of, stuff→stuf
    ['gg', ['g']],                         // bigger→biger
    ['cc', ['k','c']],                     // account→acount
    ['zz', ['z']],                         // jazz→jaz
    ['uld', ['ould']],                     // shuld→should ✓
    ['ood', ['ould']],                     // shood→should ✓
    ['oud', ['ould']],                     // shoud→should ✓
    ['ud',  ['ould']],                     // shud→should ✓
    ['od',  ['ould','ood']],               // shod→should ✓
    ['ak', ['ake','eak']],                 // brak→brake/break ✓
    ['uf', ['ough','off']],                // enuf→enough ✓

    // ── Single char ──
    ['e', ['ai','ay','ea','a','ee']],      // sed→said ✓, brek→break
    ['i', ['igh','ie','y','ee']],          // lite→light
    ['o', ['oa','ow','oe','oul','ould']],  // shod→should ✓
    ['u', ['oo','ew','ue','oul','ould']],  // buk→book, shud→should ✓
    ['a', ['ai','ay','a']],
    ['y', ['ie','igh','i']],               // my→mi reverse
    ['f', ['ph','gh']],                    // fone→phone ✓
    ['k', ['c','ck','ch']],
    ['s', ['c','ce','se','ss']],
    ['z', ['s','se','ze']],
    ['j', ['g','ge','dge']],
    ['r', ['wr','rh']],                    // rite→write ✓
    ['w', ['wh']],                         // wen→when ✓
    ['n', ['kn','gn']],                    // nife→knife ✓
    ['m', ['mb','mn']],                    // thum→thumb ✓
    ['c', ['k','ck','s','ch']],
    ['b', ['bb']],                         // raber→rubber (double)
    ['t', ['tt','ed']],                    // buter→butter
    ['p', ['pp']],                         // hapy→happy
    ['g', ['gg','j']],                     // biger→bigger
  ];

  const MAX_VARIANTS = 400;
  for (const [from, tos] of subs) {
    const current = [...variants];
    if (variants.size >= MAX_VARIANTS) break;
    for (const variant of current) {
      let idx = variant.indexOf(from);
      while (idx !== -1 && variants.size < MAX_VARIANTS) {
        for (const to of tos) {
          variants.add(variant.slice(0, idx) + to + variant.slice(idx + from.length));
        }
        idx = variant.indexOf(from, idx + from.length);
      }
    }
  }
  return [...variants];
}

function getSpellSuggestionsAsync(word, callback) {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  if (!w) { callback(null); return; }

  if (w.length === 1) {
    const homophones = LETTER_HOMOPHONES[w];
    callback(homophones ? homophones.map(hw => ({ word: hw, def: null })) : null);
    return;
  }

  // For correctly spelled words we still want alternatives —
  // only exclude the word itself from suggestions, don't bail out early.
  const isCorrect = WORD_SET.has(w);

  // Local Levenshtein candidates up to distance 3
  // Also explicitly check silent-e completions (hav→have, liv→live, etc.)
  // and common vowel-drop patterns since Levenshtein can miss these in ranking
  const localCands = [];
  const maxLen = w.length + 3, minLen = Math.max(1, w.length - 3);
  const silentEBonus = new Set();
  const phoneticBonus = new Set(); // words found via phonetic variant matching

  // Generate phonetic variants of the typed word, then search WORD_LIST for
  // close matches to each variant. This handles multi-substitution cases:
  // 'crorl' → variant 'crawl' (or→aw) → exact match in WORD_LIST → suggest 'crawl'
  // 'crorlee' → variant 'crawly' (or→aw, ee→y) → found → suggest 'crawly'
  const allVariants = phonemeVariants(w);

  // Prune variants: keep only those close in length to the typed word,
  // and pre-filter WORD_LIST by first letter of each variant.
  // This reduces O(400 × 3700) to O(30 × ~150) — ~30× faster.
  const prunedVariants = [...allVariants].filter(v =>
    v !== w && Math.abs(v.length - w.length) <= 2 && v.length >= 2
  ).slice(0, 40); // cap at 40 variants

  // Build a first-letter index and case-lookup map (built once, cached)
  if (!getSpellSuggestionsAsync._wordIndex) {
    const idx = {};
    const caseMap = {}; // lowercase→original case
    for (const cand of WORD_LIST) {
      const cl = cand.toLowerCase();
      const fl = cl[0];
      if (!idx[fl]) idx[fl] = [];
      idx[fl].push(cl);
      caseMap[cl] = cand;
    }
    getSpellSuggestionsAsync._wordIndex = idx;
    getSpellSuggestionsAsync._caseMap = caseMap;
  }
  const wordIndex = getSpellSuggestionsAsync._wordIndex;
  const caseMap = getSpellSuggestionsAsync._caseMap;

  for (const variant of prunedVariants) {
    const vlen = variant.length;
    const fl = variant[0];
    // Only check words starting with the same letter as this variant
    const bucket = wordIndex[fl] || [];
    for (const cl of bucket) {
      if (phoneticBonus.has(cl)) continue;
      if (isBlocked(cl)) continue;
      if (cl.length < vlen - 1 || cl.length > vlen + 1) continue;
      if (levenshtein(variant, cl) <= 1) phoneticBonus.add(cl);
    }
  }

  // Use first-letter index for local scan too — only check same-letter words
  // plus phonetic matches (which may start with a different letter)
  const firstLetterBucket = wordIndex[w[0]] || [];
  const phonetics = [...phoneticBonus]; // already found, add directly

  // Add phonetic matches directly to localCands (they bypass first-letter filter)
  for (const cl of phonetics) {
    if (isBlocked(cl)) continue;
    const dist = levenshtein(w, cl);
    const isSilentEnd = (cl === w + 'e' || cl === w + 'y' || cl === w + 'ed'
                         || cl === w + 'er' || cl === w + 'ing');
    if (isSilentEnd) silentEBonus.add(cl);
    localCands.push({ word: caseMap[cl] || cl, dist: 1 }); // phonetic = effective dist 1
  }

  // Scan only same-first-letter words for Levenshtein
  for (const cl of firstLetterBucket) {
    if (phoneticBonus.has(cl)) continue; // already added above
    if (cl.length < minLen || cl.length > maxLen) continue;
    if (isBlocked(cl)) continue;
    const dist = levenshtein(w, cl);
    if (dist <= 3) {
      const isSilentEnd = (cl === w + 'e' || cl === w + 'y' || cl === w + 'ed'
                           || cl === w + 'er' || cl === w + 'ing');
      if (isSilentEnd) silentEBonus.add(cl);
      localCands.push({ word: caseMap[cl] || cl, dist });
    }
  }

  // Datamuse phonetic query
  lookup('https://api.datamuse.com/words?sp=' + encodeURIComponent(w) + '&max=15&md=f')
    .then(r => r.json())
    .then(data => {
      const seen = new Set();
      const results = [];
      // First-letter bonus: rewards same first letter OR phonetic first-letter
      // equivalents (f/ph, k/c, n/kn, r/wr, w/wh etc)
      const firstLetter = w[0];
      const phoneticFirstMap = {f:['p'],p:['f'],k:['c','q'],c:['k'],n:['k'],r:['w'],w:['w']};
      const firstLetterBonus = (cand) => {
        if (cand[0] === firstLetter) return 800;
        if (phoneticBonus.has(cand)) return 600; // phonetic match, slightly less
        return 0;
      };
      // Real-world usage frequency (uses per million), from the md=f tag —
      // see MIN_VALID_FREQ comment for why we need this alongside `score`.
      function freqOf(entry) {
        if (!entry || !entry.tags) return 0;
        const tag = entry.tags.find(t => t.startsWith('f:'));
        return tag ? (parseFloat(tag.slice(2)) || 0) : 0;
      }
      // A one-character length difference is completely normal for a real
      // correction (silent letters, doubled consonants, vowel-team spellings
      // like "sed"→"said" or "hoping"→"hopping") — it shouldn't cost a
      // candidate anything. Only penalize once the gap grows past that, so a
      // handful of coincidentally same-length-but-less-likely words (e.g.
      // "sad"/"say"/"saw" for "sed") can't crowd out the actual best answer
      // ("said") purely on a length tie-break.
      function lenPenalty(a, b) {
        return Math.max(0, Math.abs(a.length - b.length) - 1) * 30;
      }

      localCands.forEach(c => {
        const cl = c.word.toLowerCase();
        seen.add(cl);
        // Phonetic matches get same first-letter bonus as true first-letter matches
        const localFirstBonus = (cl[0] === w[0]) ? 800 : (phoneticBonus.has(cl) ? 600 : 0);
        // Distance-1 local matches get an extra boost to ensure they always
        // beat high-frequency Datamuse words that are further away (fex→fix over fex→free)
        const dist1Boost = (c.dist === 1 && cl[0] === w[0]) ? 1500 : 0;
        results.push({ word: c.word, def: null,
          score: 2000                               // local list base bonus
            + localFirstBonus
            + dist1Boost
            + (HIGH_FREQ_WORDS.has(cl) ? 1500 : 0) // strong boost for common words
            + (WORD_SET.has(cl) ? 500 : 0)         // any local list word
            + (silentEBonus.has(cl) ? 600 : 0)
            + (phoneticBonus.has(cl) ? 1800 : 0)   // strong boost for phonetic match
            - c.dist * 200
            - lenPenalty(cl, w) });
      });
      data.forEach(d => {
        const dl = d.word.toLowerCase();
        if (isBlocked(dl)) return;
        const freq = freqOf(d);
        // Reject only if BOTH the phonetic-closeness score is weak AND the
        // word isn't a genuinely common one — a low `score` alone isn't
        // enough to discard a word real kids actually use (see MIN_VALID_FREQ).
        if ((d.score || 0) < MIN_VALID_SCORE && freq < MIN_VALID_FREQ) return;
        if (seen.has(dl)) {
          const ex = results.find(r => r.word.toLowerCase() === dl);
          if (ex) ex.score += 300;
          return;
        }
        seen.add(dl);
        const dist = levenshtein(w, dl);
        const defs = d.defs && d.defs.length ? d.defs : null;
        results.push({ word: d.word, def: defs,
          score: (WORD_SET.has(dl) ? 800 : 0)
            + firstLetterBonus(dl)
            + (HIGH_FREQ_WORDS.has(dl) ? 1500 : 0)
            + (phoneticBonus.has(dl) ? 1800 : 0)
            + Math.min(freq, 50) * 20   // reward genuinely common real words
            - dist * 200
            - lenPenalty(dl, w) });
      });
      results.sort((a, b) => b.score - a.score);
      const final = results.filter(r => r.word.toLowerCase() !== w).slice(0, 7).map(r => ({ word: r.word, def: r.def }));
      callback(final.length ? final : null);
    })
    .catch(() => {
      // Datamuse unavailable — local only. Same reasoning as lenPenalty()
      // above: a 1-character length difference is normal for a genuine
      // correction and shouldn't out-rank it against same-length words that
      // just happen to also be nearby edits (see "sed"→"said" vs "sad"/"say"/etc).
      const lenGap = (word) => Math.max(0, Math.abs(word.length - w.length) - 1);
      localCands.sort((a, b) => a.dist - b.dist || lenGap(a.word) - lenGap(b.word));
      const final = localCands.filter(c => c.word.toLowerCase() !== w).slice(0, 7).map(c => ({ word: c.word, def: null }));
      callback(final.length ? final : null);
    });
}

function fetchFreeDictDef(word, callback) {
  // Check local definitions first for common words
  // (PagePal: some built-in definitions were cut short at an abbreviation,
  // e.g. "Past and past part", "Book listing (usu". Those are tidied, and
  // looked up online instead when allowed.)
  const local = goodLocalDef(word);
  if (local) { callback(local); return; }


  lookup('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word))
    .then(r => {
      if (!r.ok) { callback(null); return; }
      return r.json();
    })
    .then(data => {
      if (!data || !data.length) { callback(null); return; }

      // Filter out specialised/technical definitions but preserve API order.
      // The Free Dictionary API lists definitions most-common-first within
      // each part of speech, so we trust that ordering and just skip the
      // ones that are clearly domain-specific or jargon-heavy.
      const techTerms = /\b(computing|programming|software|algorithm|data structure|topology|linguistics|heraldry|archaic|obsolete|nautical|military|legal|pathology|saddlery|carpentry|falconry|anatomy|surgery)\b/i;
      const preferredPos = ['noun', 'verb', 'adjective', 'adverb'];

      // Two passes: first try preferred parts of speech, then fall back to any
      for (const posGroup of [preferredPos, null]) {
        for (const entry of data) {
          for (const meaning of (entry.meanings || [])) {
            const pos = (meaning.partOfSpeech || '').toLowerCase();
            if (posGroup && !posGroup.includes(pos)) continue;
            // Use only the FIRST definition of each meaning — most common usage
            const def = (meaning.definitions || [])[0];
            if (!def) continue;
            const text = (def.definition || '').trim();
            if (!text || text.length > 150 || text.startsWith('(')) continue;
            if (techTerms.test(text)) continue;
            callback(text);
            return;
          }
        }
      }
      callback(null);
    })
    .catch(() => callback(null));
}

/** Likely corrections (or alternatives) for a word: [{word}], or null. */
export function spellingSuggestions(word) {
  return new Promise(resolve => getSpellSuggestionsAsync(word, list => resolve(list)));
}

/** A built-in definition, tidied: an unfinished "(usu…" tail removed. */
function cleanDef(raw) {
  let s = String(raw || '').trim();
  if ((s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length) s = s.slice(0, s.lastIndexOf('(')).trim();
  s = s.replace(/[,;:\s]+$/, '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Was this built-in definition cut off part-way (at an abbreviation)? */
function looksCut(raw) {
  const s = String(raw || '').trim();
  return (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length ||
    /\b(part|usu|foll|esp|etc|colloq|abbr|orig|freq|incl|attrib|var|pl|sing)$/i.test(s) ||
    cleanDef(s).length < 12;
}

/** A built-in definition good enough to use as is, or null. */
function goodLocalDef(word) {
  const raw = LOCAL_DEFS[String(word).toLowerCase()];
  return raw && !looksCut(raw) ? cleanDef(raw) : null;
}

/** A short definition for a word, or null. */
export function definition(word) {
  return new Promise(resolve => fetchFreeDictDef(word, text => {
    if (text) return resolve(text);
    // Nothing online (or lookups off): a tidied built-in one, unless it
    // trails off at an abbreviation ("Past and past part"), which doesn't help.
    const raw = String(LOCAL_DEFS[String(word).toLowerCase()] || '').trim();
    const fallback = cleanDef(raw);
    const trailsOff = /\b(part|usu|foll|esp|etc|colloq|abbr|orig|freq|incl|attrib|var|pl|sing)$/i.test(fallback) || /\band$|\bor$|\bof$/i.test(fallback);
    resolve(fallback.length >= 6 && !trailsOff ? fallback : null);
  }));
}

/** True once a word is known to be misspelt (an online check may still be running). */
export const misspelt = isLikelyMisspelled;
export { localSugg as completions, isBlocked };
