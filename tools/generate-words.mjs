// Rebuild words.js: the dictionary the game checks a sliced word against, plus
// the letter bag it draws tiles from and the per-letter points it scores.
// Run: npm run generate            (needs network; caches downloads in .cache/)
//
// Unlike a grid puzzle, an arcade round has to accept anything the player can
// reach, so this keeps every common word from MIN to MAX letters rather than a
// single length.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../", import.meta.url).pathname);
const CACHE = path.join(ROOT, ".cache");

const MIN = 3;
const MAX = 8;
const MAX_RANK = 30000;   // how far down the frequency list a word may sit

const SOURCES = {
  // A Scrabble dictionary (TWL) decides what counts as a real word. A plain
  // word list won't do: those carry proper nouns, so "MOORE" reads as valid.
  "twl.txt": "https://raw.githubusercontent.com/redbo/scrabble/master/dictionary.txt",
  // 50k words by frequency: decides which of them a player is likely to know.
  "en_50k.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
  // Profanity and first names, both filtered out.
  "bad.txt": "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en",
  "names1.txt": "https://raw.githubusercontent.com/dominictarr/random-name/master/first-names.txt",
  "names2.txt": "https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/first%20names/us.txt"
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
  "slave", "slaves", "urine", "scum", "casa", "senor", "pasha"]) bad.add(w);

const names = new Set([...lines(readCache("names1.txt")), ...lines(readCache("names2.txt"))]);

const fragments = new Set(["aren", "cant", "dont", "isnt", "wont", "weve", "wasnt", "didnt",
  "hadnt", "arent", "youve", "youll", "youre", "theyd", "theyll", "theyre", "thats", "whats",
  "hasnt", "havent", "aint", "shes", "hes", "ive", "itll", "gonna", "wanna", "gotta",
  "dunno", "cmon", "yall", "didn", "doesn", "wouldn", "couldn", "shouldn", "hadn", "weren",
  "isn", "wasn", "mustn", "needn", "daren", "shan", "ain", "ll", "ve", "re", "nt"]);

const words = [];
for (const [w, r] of rank) {           // Map keeps insertion order: common first
  if (w.length < MIN || w.length > MAX || r > MAX_RANK) continue;
  if (!/^[a-z]+$/.test(w)) continue;
  if (!valid.has(w)) continue;
  if (bad.has(w) || names.has(w) || fragments.has(w)) continue;
  words.push(w);
}
words.sort();

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
// WORDS  every accepted word, ${MIN} to ${MAX} letters, common enough to be fair.
// BAG    per-mille weight of each letter, measured across WORDS itself.
// POINTS what each letter is worth, running inversely to how common it is.
window.WORD_NINJA_DATA = {
  MIN: ${MIN},
  MAX: ${MAX},
  WORDS: "${words.join(" ")}".split(" "),
  BAG: ${JSON.stringify(weights)},
  POINTS: ${JSON.stringify(points)}
};
`);

const kb = (fs.statSync(out).size / 1024).toFixed(0);
const byLen = {};
for (const w of words) byLen[w.length] = (byLen[w.length] || 0) + 1;
console.log(`${words.length} words, ${kb} KB (gzips to roughly a third)`);
console.log("  by length:", JSON.stringify(byLen));
console.log(`  vowels are ${(vowelShare * 100).toFixed(0)}% of the bag`);
console.log("  dearest letters:", alphabet.filter((c) => points[c] >= 6).join(" "));
