// Rebuild words.js: the dictionary the game checks a sliced word against, plus
// the letter bag it draws tiles from and the per-letter points it scores.
// Run: npm run generate            (needs network; caches downloads in .cache/)
//
// Two separate word lists come out of this, and keeping them apart is the whole
// design:
//
//   ACCEPTED  every Scrabble word from MIN to MAX letters. If it is good enough
//             for a Scrabble board it is good enough here, so DEET and QOPH
//             score rather than costing you three seconds.
//   COMMON    the frequency-gated subset. It never reaches the player as a
//             rule; it is what the letter bag and the letter values are
//             measured from, so the tiles that fall are the ones that finish
//             words people actually know.
//
// Widening what is ACCEPTED is pure upside: more of what you try works. Widening
// what is DEALT is not — a bag measured over the whole Scrabble dictionary
// weights letters toward words nobody is going to find mid-drag.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../", import.meta.url).pathname);
const CACHE = path.join(ROOT, ".cache");

const MIN = 2;
const MAX = 8;
const MAX_RANK = 30000;   // how far down the frequency list a word may sit

const SOURCES = {
  // A Scrabble dictionary (TWL) decides what counts as a real word. A plain
  // word list won't do: those carry proper nouns, so "MOORE" reads as valid.
  "twl.txt": "https://raw.githubusercontent.com/redbo/scrabble/master/dictionary.txt",
  // 50k words by frequency: decides which of them a player is likely to know.
  "en_50k.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
  // Profanity, filtered out.
  "bad.txt": "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en"
};

async function fetchSources() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const [name, url] of Object.entries(SOURCES)) {
    const file = path.join(CACHE, name);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    process.stdout.write(`fetching ${name}… `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
}

const readCache = (f) => fs.readFileSync(path.join(CACHE, f), "utf8");
const lines = (s) => s.split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean);

await fetchSources();

// There is deliberately NO first-names filter. An early version had one, and it
// threw away 813 ordinary words, WILL BILL ROSE GRACE HOPE ART DAWN MAY JACK
// CHASE among them, because thousands of English words are also somebody's
// name. It was redundant as well as harmful: a Scrabble dictionary contains no
// proper nouns, so HELEN, SANTA and MOORE are already absent from this list
// while WILL and ROSE are correctly present. The dictionary is the authority.
const valid = new Set(lines(readCache("twl.txt")));

const rank = new Map();
readCache("en_50k.txt").split("\n").forEach((line, i) => {
  const w = line.split(" ")[0];
  if (w && !rank.has(w)) rank.set(w, i + 1);
});

const bad = new Set(lines(readCache("bad.txt")));
// Slurs and unpleasantness the generic list misses. A word flying across the
// screen is as visible as one in a grid, so the bar is the same.
for (const w of ["fags", "coon", "coons", "wank", "wanks", "spic", "spics", "kike", "kikes",
  "gook", "gooks", "dyke", "dykes", "negro", "negros", "chink", "chinks", "twat", "twats",
  "cunt", "cunts", "jizz", "cums", "turd", "turds", "crap", "craps", "damn", "hell",
  "arse", "arses", "rape", "rapes", "raped", "nazi", "nazis", "slut", "sluts", "whore",
  "whores", "piss", "pissed", "homo", "homos", "shag", "shags", "prick", "pricks",
  "slave", "slaves", "urine", "scum", "casa", "senor", "pasha",
  // These were only ever excluded as a side effect of the first-names filter.
  // Dropping that filter let them back, so name them properly.
  "fanny", "fannies", "randy", "dong", "dongs", "johnson", "johnsons",
  "sissy", "sissies", "cissy", "pooh"]) bad.add(w);

const fragments = new Set(["aren", "cant", "dont", "isnt", "wont", "weve", "wasnt", "didnt",
  "hadnt", "arent", "youve", "youll", "youre", "theyd", "theyll", "theyre", "thats", "whats",
  "hasnt", "havent", "aint", "shes", "hes", "ive", "itll", "gonna", "wanna", "gotta",
  "dunno", "cmon", "yall", "didn", "doesn", "wouldn", "couldn", "shouldn", "hadn", "weren",
  "isn", "wasn", "mustn", "needn", "daren", "shan", "ain", "ll", "ve", "re", "nt"]);

const ok = (w) => w.length >= MIN && w.length <= MAX && /^[a-z]+$/.test(w)
  && !bad.has(w) && !fragments.has(w);

// What the game accepts: the Scrabble dictionary, whole.
const accepted = [...valid].filter(ok).sort();

// What the bag and the points are measured from: the common subset.
const words = [];
for (const [w, r] of rank) {           // Map keeps insertion order: common first
  if (r > MAX_RANK || !ok(w) || !valid.has(w)) continue;
  words.push(w);
}
words.sort();

// Front-coded: each word is a digit for how many leading letters it shares with
// the one before, then the rest of it. Sorted words share a lot of prefix, so
// this is 243 KB where the plain list is 649 KB, and it costs the game one pass
// at load. The digit is always below "a" in code order, which is what tells the
// decoder where a word ends.
function frontCode(list) {
  let out = "", prev = "";
  for (const w of list) {
    let i = 0;
    while (i < prev.length && i < w.length && prev[i] === w[i]) i++;
    out += String.fromCharCode(48 + i) + w.slice(i);
    prev = w;
  }
  return out;
}

// ---- the letter bag --------------------------------------------------------
// Weight letters by how often they appear in THESE words rather than in English
// prose. Prose frequency over-weights the letters of common short function
// words, and a bag built from it starves the player of the letters that
// actually finish a word.
const counts = {};
let total = 0;
for (const w of words) {
  for (const ch of w) { counts[ch] = (counts[ch] || 0) + 1; total++; }
}

// Per-mille weights, so the bag is a plain integer table the game can sample.
const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
const weights = {};
for (const ch of alphabet) weights[ch] = Math.max(1, Math.round(((counts[ch] || 0) / total) * 1000));

// Points run inversely to how common a letter is, the Scrabble intuition, but
// derived from this dictionary rather than copied.
const points = {};
for (const ch of alphabet) {
  const share = (counts[ch] || 0) / total;
  points[ch] = share >= 0.07 ? 1 : share >= 0.04 ? 2 : share >= 0.02 ? 3 : share >= 0.01 ? 4 : share >= 0.004 ? 6 : 10;
}

const vowels = "aeiou";
const vowelShare = vowels.split("").reduce((a, c) => a + weights[c], 0) / 1000;

const out = path.join(ROOT, "words.js");
fs.writeFileSync(out, `// GENERATED FILE — do not edit by hand.
// Rebuild with: npm run generate   (see tools/generate-words.mjs)
//
// WORDS  every accepted word: the Scrabble dictionary from ${MIN} to ${MAX}
//        letters, front-coded (see the decoder in game.js). Two letters is the
//        floor, so no single letter ever counts.
// BAG    per-mille weight of each letter, measured over the COMMON subset of
//        those words rather than all of them, so the tiles that fall are the
//        ones that finish words people know.
// POINTS what each letter is worth, running inversely to how common it is.
window.WORD_NINJA_DATA = {
  MIN: ${Math.min(...accepted.map((w) => w.length))},
  MAX: ${MAX},
  WORDS: "${frontCode(accepted)}",
  BAG: ${JSON.stringify(weights)},
  POINTS: ${JSON.stringify(points)}
};
`);

const kb = (fs.statSync(out).size / 1024).toFixed(0);
const byLen = {};
for (const w of accepted) byLen[w.length] = (byLen[w.length] || 0) + 1;
console.log(`${accepted.length} words accepted, ${kb} KB front-coded (gzips to under half)`);
console.log("  by length:", JSON.stringify(byLen));
console.log(`  bag and points measured over the ${words.length} common ones`);
console.log(`  vowels are ${(vowelShare * 100).toFixed(0)}% of the bag`);
console.log("  dearest letters:", alphabet.filter((c) => points[c] >= 6).join(" "));
