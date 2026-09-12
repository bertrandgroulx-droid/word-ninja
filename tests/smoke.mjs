// Headless smoke test — serves the folder and drives a real browser.
// Run: npm test   (needs `npx playwright install chromium` once).
//
// An arcade game can't be tested by chasing flying tiles, so this works at two
// levels: the round model (scoring, penalties, bombs, the daily schedule) is
// driven directly, and one real pointer drag over a tile placed at a known spot
// proves the slice geometry actually connects.
import { chromium } from "playwright";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../", import.meta.url).pathname);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon"
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const state = (page) => page.evaluate(() => window.game._debug.state());
const play = (page, word) => page.evaluate((w) => window.game._debug.play(w), word);

async function run() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const exe = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(base);
  await page.waitForFunction(() => window.game && window.WORD_NINJA_DATA);

  // 1) The dictionary and the letter bag.
  const data = await page.evaluate(() => {
    const d = window.WORD_NINJA_DATA;
    const words = d.WORDS;
    const set = new Set(words);
    const vowelWeight = "aeiou".split("").reduce((a, c) => a + d.BAG[c], 0);
    const total = Object.values(d.BAG).reduce((a, b) => a + b, 0);
    return {
      count: words.length,
      lengths: [...new Set(words.map((w) => w.length))].sort((a, b) => a - b),
      shaped: words.every((w) => /^[a-z]+$/.test(w)),
      sorted: words.every((w, i) => i === 0 || words[i - 1] <= w),
      unique: set.size === words.length,
      hasCommon: ["cat", "stone", "ninja", "letter"].filter((w) => set.has(w)),
      vowelShare: vowelWeight / total,
      letters: Object.keys(d.BAG).length
    };
  });
  assert(data.count > 8000, `dictionary should be substantial, got ${data.count}`);
  assert(data.shaped && data.unique && data.sorted, "dictionary is clean, unique and sorted");
  assert(data.lengths[0] === 3 && data.lengths[data.lengths.length - 1] === 8,
    `words run 3 to 8 letters, got ${data.lengths.join(",")}`);
  assert(data.hasCommon.includes("cat") && data.hasCommon.includes("stone"),
    `everyday words are present, found ${data.hasCommon.join(",")}`);
  assert(data.letters === 26, "every letter is in the bag");
  assert(data.vowelShare > 0.25 && data.vowelShare < 0.5,
    `vowels are a workable share of the bag, got ${data.vowelShare.toFixed(2)}`);

  // 2) Every icon the page declares resolves. On a shared github.io address a
  //    missing one means the browser borrows a neighbouring app's icon.
  const icons = await page.$$eval("link[rel~='icon'], link[rel='apple-touch-icon']",
    (els) => els.map((e) => e.getAttribute("href")));
  assert(icons.length >= 7, `expected the full icon set, got ${icons.length}`);
  for (const href of icons) {
    const res = await page.request.get(new URL(href, base).href);
    assert(res.status() === 200, `icon ${href} -> HTTP ${res.status()}`);
  }

  // 3) Help opens on a first visit; the start card waits behind it.
  assert(await page.$eval("#helpBack", (e) => !e.classList.contains("hidden")), "help opens first time");
  await page.click("#helpClose");
  assert(await page.$eval("#startBack", (e) => !e.classList.contains("hidden")), "start card is showing");
  assert((await state(page)).phase === "ready", "waiting to start");

  // 4) The daily schedule is deterministic, and shaped like a round.
  const sched = await page.evaluate(() => {
    const a = window.game._debug.schedule("same-seed");
    const b = window.game._debug.schedule("same-seed");
    const c = window.game._debug.schedule("other-seed");
    const flat = (s) => JSON.stringify(s);
    const tiles = a.flatMap((w) => w.tiles);
    const bombs = tiles.filter((t) => t.bomb);
    return {
      stable: flat(a) === flat(b),
      differs: flat(a) !== flat(c),
      waves: a.length,
      tiles: tiles.length,
      bombs: bombs.length,
      earliestBomb: Math.min(...a.filter((w) => w.tiles.some((t) => t.bomb)).map((w) => w.t)),
      // Launch across the width, and high enough to be reachable without
      // sailing off the top. The exact band is a tuning knob; these are the
      // limits beyond which the tile is unplayable.
      inBounds: tiles.every((t) => t.x > 0.05 && t.x < 0.95 && t.rise > 0.3 && t.rise < 0.95),
      lettersOnly: tiles.every((t) => t.bomb || /^[a-z]$/.test(t.ch)),
      vowelWaves: a.filter((w) => {
        const letters = w.tiles.filter((t) => !t.bomb);
        return letters.length >= 2 && !letters.some((t) => "aeiou".includes(t.ch));
      }).length
    };
  });
  assert(sched.stable, "the same seed deals the same run");
  assert(sched.differs, "a different seed deals a different run");
  assert(sched.waves >= 20 && sched.tiles > 90,
    `a round's worth of play, got ${sched.waves} waves and ${sched.tiles} tiles`);
  assert(sched.inBounds, "tiles launch on screen");
  assert(sched.lettersOnly, "every non-bomb tile carries a letter");
  assert(sched.vowelWaves === 0, `every wave of 2+ has a vowel, ${sched.vowelWaves} without`);
  assert(sched.bombs > 0 && sched.earliestBomb >= 8, `bombs arrive, but not early: ${sched.earliestBomb}`);

  // 5) Tiles hang long enough to read and plan around. This is a word game:
  //    at two seconds it was unplayable, whatever the other numbers said.
  const hang = async () => page.evaluate(() => {
    const st = window.game._debug.state();
    const s = window.game._debug.schedule("airtime");
    const tiles = s.flatMap((w) => w.tiles);
    // Matches the launch maths in release(): a tile is airborne
    // 2 * sqrt(2 * rise / gravity) seconds, both in arena-height units.
    const secs = tiles.map((t) => 2 * Math.sqrt(2 * t.rise / st.gravity));
    const gaps = s.slice(1).map((w, i) => w.t - s[i].t);
    // Roughly how many tiles are up at once: each wave's tiles times how many
    // wave-gaps they stay airborne.
    const avgAir = secs.reduce((a, b) => a + b, 0) / secs.length;
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return {
      speed: st.speed, min: Math.min(...secs), avg: avgAir,
      onScreen: (tiles.length / s.length) * (avgAir / avgGap)
    };
  });
  const fast = await hang();
  assert(fast.speed === "fast", "opens on the fast speed");
  assert(fast.min > 3.5, `tiles hang long enough to read, min ${fast.min.toFixed(1)}s`);
  assert(fast.avg > 4 && fast.avg < 6, `fast hang time, avg ${fast.avg.toFixed(1)}s`);

  // Slow is a real difference, and thins its waves so the screen doesn't flood.
  await page.evaluate(() => window.game._debug.setSpeed("slow"));
  const slow = await hang();
  assert(slow.avg > fast.avg * 1.3, `slow is markedly slower: ${slow.avg.toFixed(1)}s vs ${fast.avg.toFixed(1)}s`);
  assert(Math.abs(slow.onScreen - fast.onScreen) < 3,
    `both speeds hold a similar crowd, ${slow.onScreen.toFixed(1)} vs ${fast.onScreen.toFixed(1)}`);
  assert(await page.$eval("#speedSlow", (e) => e.classList.contains("active")), "the card shows the choice");
  await page.evaluate(() => window.game._debug.setSpeed("fast"));

  // 6) Scoring: a valid word pays, longer words pay much more.
  await page.click("#startBtn");
  assert((await state(page)).phase === "playing", "round started");
  const cat = await play(page, "cat");
  assert(cat.ok && cat.scored > 0, `"cat" scores, got ${JSON.stringify(cat)}`);
  const longer = await play(page, "stone");
  assert(longer.ok && longer.scored > cat.scored, "a longer word pays more");
  assert(longer.bonus > 0, "five letters buys time back");

  // 7) Three in a row lifts the multiplier.
  let s = await state(page);
  assert(s.streak === 2 && s.mult === 1, `streak building, got ${JSON.stringify(s)}`);
  await play(page, "table");
  s = await state(page);
  assert(s.mult === 2, `three in a row gives x2, got ${s.mult}`);

  // 8) A word that isn't a word costs time and the multiplier.
  const before = (await state(page)).remaining;
  const dud = await play(page, "zzzzq");
  assert(!dud.ok && dud.reason === "unknown", "gibberish is rejected");
  const after = await state(page);
  assert(after.remaining < before - 2.5, "a wrong word costs three seconds");
  assert(after.mult === 1, "and drops the multiplier");

  // 9) Too short costs nothing; a repeat scores nothing.
  const shortWord = await play(page, "an");
  assert(!shortWord.ok && shortWord.reason === "short", "two letters is not a submission");
  const repeat = await play(page, "cat");
  assert(!repeat.ok && repeat.reason === "repeat", "the same word twice pays once");
  assert((await state(page)).score === after.score, "no score from short or repeated words");

  // 10) A real drag across a real tile actually cuts it.
  const box = await page.$eval("#cv", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const spot = await page.evaluate(() => {
    const arena = document.getElementById("arena").getBoundingClientRect();
    return window.game._debug.placeTile(arena.width / 2, arena.height / 2, "k");
  });
  await page.mouse.move(box.x + spot.x - 90, box.y + spot.y);
  await page.mouse.down();
  await page.mouse.move(box.x + spot.x, box.y + spot.y, { steps: 6 });
  await page.mouse.move(box.x + spot.x + 90, box.y + spot.y, { steps: 6 });
  assert((await state(page)).buffer === "k", `the drag cut the tile, buffer=${(await state(page)).buffer}`);
  await page.mouse.up();
  assert((await state(page)).buffer === "", "lifting submits and clears");

  // 11) A bomb costs ten seconds and the word in hand, but the run goes on.
  const cutBomb = async () => {
    const spot = await page.evaluate(() => {
      const arena = document.getElementById("arena").getBoundingClientRect();
      return window.game._debug.placeTile(arena.width / 2, arena.height / 2, "*");
    });
    await page.mouse.move(box.x + spot.x - 90, box.y + spot.y);
    await page.mouse.down();
    await page.mouse.move(box.x + spot.x + 90, box.y + spot.y, { steps: 8 });
    await page.mouse.up();
  };
  const preBomb = await state(page);
  await cutBomb();
  const postBomb = await state(page);
  assert(postBomb.remaining < preBomb.remaining - 9, "a bomb costs ten seconds");
  assert(postBomb.phase === "playing", "but the run continues while there is time");
  assert(postBomb.buffer === "", "and the word in hand is lost");

  // ... unless the clock can't absorb it, which is the danger late on.
  await page.evaluate(() => window.game._debug.setRemaining(4));
  await cutBomb();
  assert((await state(page)).phase === "over", "a bomb late in a run ends it");
  await page.waitForSelector("#overBack:not(.hidden)", { timeout: 3000 });
  assert((await page.$eval("#overTitle", (e) => e.textContent)) === "Bomb", "and says so");
  assert((await page.$eval("#stWords", (e) => e.textContent)) === "3", "three words survived the run");
  assert((await page.$$eval("#cutList span", (e) => e.length)) === 3, "the words are listed");

  // 12) Time bonuses can't stretch the clock past the cap.
  await page.evaluate(() => {
    const d = window.game._debug;
    d.begin();
    d.setRemaining(88);
  });
  await page.evaluate(() => window.game._debug.play("strength"));
  const capped = await state(page);
  assert(capped.remaining <= 90.01, `clock capped at 90s, got ${capped.remaining.toFixed(1)}`);
  await page.evaluate(() => window.game._debug.end("time"));

  // 13) The daily run is one attempt, and the result is remembered.
  await page.reload();
  await page.waitForFunction(() => window.game && document.getElementById("startSub"));
  const sub = await page.$eval("#startSub", (e) => e.textContent);
  assert(/already played/i.test(sub), `daily is spent after a run, got "${sub}"`);
  await page.evaluate(() => window.game._debug.setSpeed("slow"));
  const slowSub = await page.$eval("#startSub", (e) => e.textContent);
  assert(!/already played/i.test(slowSub), "the other speed still has its daily run");
  await page.evaluate(() => window.game._debug.setSpeed("fast"));

  // 14) Practice is always available, and running the clock out ends the round.
  await page.click("#modePractice");
  assert((await state(page)).mode === "practice", "switched to practice");
  await page.click("#startBtn");
  await page.evaluate(() => window.game._debug.setRemaining(0.2));
  await page.waitForFunction(() => window.game._debug.state().phase === "over", { timeout: 5000 });
  assert((await page.$eval("#overTitle", (e) => e.textContent)) === "Time", "the clock runs out");

  assert(errors.length === 0, "page errors: " + errors.join(" | "));
  await browser.close();
  server.close();
  console.log(`PASS — ${data.count} words, ${sched.waves} waves, hang ${fast.avg.toFixed(1)}s fast / ${slow.avg.toFixed(1)}s slow, scoring/slice/bomb/daily OK`);
}

run().catch((err) => { console.error("FAIL —", err.message); process.exit(1); });
