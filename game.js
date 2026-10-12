// Word Ninja — game module.
// A factory: index.html calls createWordNinja(ctx).start().
// ctx = { data, storage, canvas, daily }, where data is the generated words.js
// payload and daily is the shozbot daily kit (shozbot-daily.js, window.ShozDaily).
//
// The round is driven by a wave SCHEDULE built up front from a seed, not by
// per-frame randomness. Two things fall out of that: the daily run deals the
// same letters to everyone regardless of frame rate or screen size, and the
// scoring can be tested without running the physics at all.
//
// The daily run is presented the way every shozbot daily is: the page opens on
// today's run (or today's results, if played), one card stands before the
// clock starts, the first finished score is the one kept, and there is a Past
// puzzles list, a streak, and a share line. The kit decides what those say;
// this file draws them in the game's own look.
window.createWordNinja = function (ctx) {
  "use strict";

  var DATA = ctx.data;
  var store = ctx.storage;
  var cv = ctx.canvas;
  var g2d = cv.getContext("2d");
  var daily = ctx.daily.create({
    game: "word-ninja", title: "Word Ninja", storage: store, now: ctx.now
  });

  // The dictionary arrives front-coded: a digit for how many leading letters
  // this word shares with the one before it, then the rest of it. Whole, the
  // Scrabble list is 649 KB of text; this way it is 243 KB and unpacks in about
  // a tenth of a second on a slow phone.
  // The digit is what marks a boundary: it sorts below "a", every letter above.
  function unpack(packed) {
    var set = new Set(), prev = "", i = 0, j, word;
    while (i < packed.length) {
      var shared = packed.charCodeAt(i) - 48;
      j = ++i;
      while (j < packed.length && packed.charCodeAt(j) > 96) j++;
      word = prev.slice(0, shared) + packed.slice(i, j);
      set.add(word);
      prev = word;
      i = j;
    }
    return set;
  }
  // That tenth of a second used to land inside the first paint, because this
  // script runs before the browser draws anything. Nothing needs the dictionary
  // until a word is submitted, and the start card stands between load and the
  // first cut, so warm it just after the first frame instead. dict() still
  // builds on demand, so a submit that somehow beats the warm-up is correct
  // rather than fast.
  var DICT = null;
  function dict() {
    if (!DICT) DICT = unpack(DATA.WORDS);
    return DICT;
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () { setTimeout(dict, 0); });
  } else {
    dict();
  }

  var POINTS = DATA.POINTS;

  // ---- tunables --------------------------------------------------------------
  var CONFIG = {
    roundSec: 60,
    // Tiles fall from the top and leave at the bottom, at a CONSTANT speed
    // rather than under gravity. An arc spends its slowest, most readable
    // moment at the apex and its fastest at the edges; a steady fall gives the
    // same reading time everywhere on screen and lets you plan a path ahead of
    // where the tiles are now. This is a word game, and predictability is worth
    // more than drama.
    //
    // Each speed is a crossing time paired with a wave gap. Slower tiles linger,
    // so the gap has to stretch with them or the screen floods; as paired, both
    // hold about a dozen tiles at once and only the pace changes.
    speeds: {
      slow: { fallSec: 9.7, waveGap: [4.6, 3.4] },
      fast: { fallSec: 6.8, waveGap: [3.4, 2.4] }
    },
    // Per-tile variation on the crossing time, so a wave doesn't descend in
    // lockstep like a wall.
    fallSpread: [0.85, 1.2],
    tileR: [22, 32],        // tile radius clamp, px
    tileRFrac: 0.072,       // ... as a fraction of arena width
    waveSize: [4, 6],       // tiles per wave, start -> end of round
    // A safety valve, not a limiter. Peaks run near 24 on screen, plus tiles
    // still waiting to enter. A cap that actually bit would drop tiles
    // depending on frame timing, making the daily run differ between devices.
    maxLive: 44,
    bombFrom: 8,            // no bombs in the first n seconds
    bombChance: 0.045,      // per tile, at most one per wave
    bombSec: 10,            // what cutting one costs
    maxClock: 90,           // time bonuses can't stretch a run past this
    trailMs: 260,
    penaltySec: 3,
    // Anything shorter than this that isn't a word costs nothing. Two letters
    // is the shortest real word, so a lone clipped tile is always a slip and
    // always free; two letters is a genuine attempt and pays the penalty.
    freeBelow: 2,
    bonus: [[7, 4], [5, 2]], // [minLength, secondsAdded], first match wins
    multEvery: 3,           // valid words per multiplier step
    multMax: 5
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    arena: $("arena"), score: $("score"), mult: $("mult"), clock: $("clock"),
    timeFill: $("timeFill"), word: $("word"), pops: $("pops"), toast: $("toast"),
    wordCount: $("wordCount"), helpBtn: $("helpBtn"),
    dailyText: $("dailyText"), dailyLinks: $("dailyLinks"),
    startBack: $("startBack"), startTitle: $("startTitle"), startSub: $("startSub"),
    startBest: $("startBest"), startBtn: $("startBtn"), startHelp: $("startHelp"),
    speedRow: $("speedRow"),
    overBack: $("overBack"), overScore: $("overScore"), overSub: $("overSub"),
    overStreak: $("overStreak"), overSaved: $("overSaved"),
    stWords: $("stWords"), stBest: $("stBest"),
    cutList: $("cutList"), cutMore: $("cutMore"), cutHead: $("cutHead"),
    randomBtn: $("randomBtn"), shareBtn: $("shareBtn"), pastBtn: $("pastBtn"), againBtn: $("againBtn"),
    speedSlow: $("speedSlow"), speedFast: $("speedFast"),
    pastBack: $("pastBack"), pastList: $("pastList"), pastRandom: $("pastRandom"),
    helpBack: $("helpBack"), helpClose: $("helpClose")
  };

  // ---- state -----------------------------------------------------------------
  // The daily run is always Slow: it is the game's default speed, and one
  // puzzle a day means one speed. Fast is a choice for random runs only.
  var DAILY_SPEED = "slow";
  var mode = "daily";        // "daily" | "practice" — what meta.mode says
  var meta = null;           // the kit's description of the run showing: day, number, seed
  var speed = DAILY_SPEED;   // the speed of the run showing — see CONFIG.speeds
  var practiceSpeed = DAILY_SPEED; // the stored choice for random runs
  var lastResult = null;     // what the results card is showing, for Share
  var phase = "ready";       // "ready" | "playing" | "over"
  var W = 0, H = 0, R = 28;  // arena size and tile radius, px

  var schedule = [];         // precomputed waves for the whole round
  var waveAt = 0;            // index of the next wave to release
  var tiles = [];            // live tiles
  var nextId = 1;

  var elapsed = 0;           // seconds of round time used
  var extra = 0;             // seconds won back by long words
  var score = 0;
  var streak = 0;
  var cut = [];              // [{ word, points }] in the order they were cut
  var used = Object.create(null);
  var buffer = [];           // letters sliced since the finger went down
  var endReason = "";

  var trail = [];
  var dragging = false;
  var lastFrame = 0;
  var rafId = null;
  var toastId = null;

  // ---- seeded randomness -----------------------------------------------------
  function tuning() { return CONFIG.speeds[speed]; }

  function hash32(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The bag is a per-mille weight table, so sampling is one pass over 26 keys.
  var BAG = (function () {
    var letters = [], cum = [], total = 0;
    Object.keys(DATA.BAG).forEach(function (ch) {
      total += DATA.BAG[ch];
      letters.push(ch);
      cum.push(total);
    });
    return { letters: letters, cum: cum, total: total };
  })();

  function drawLetter(rand) {
    var x = rand() * BAG.total;
    for (var i = 0; i < BAG.cum.length; i++) if (x < BAG.cum[i]) return BAG.letters[i];
    return BAG.letters[BAG.letters.length - 1];
  }

  var VOWELS = "aeiou";
  function drawVowel(rand) {
    // Sample within the vowels only, keeping their relative weights.
    var total = 0, i;
    for (i = 0; i < VOWELS.length; i++) total += DATA.BAG[VOWELS[i]];
    var x = rand() * total;
    for (i = 0; i < VOWELS.length; i++) {
      x -= DATA.BAG[VOWELS[i]];
      if (x < 0) return VOWELS[i];
    }
    return "e";
  }

  // ---- the wave schedule -----------------------------------------------------
  // Positions are fractions of the arena, never pixels, so a phone and a tablet
  // running the same daily seed get the same run at their own scale.
  function buildSchedule(seed) {
    var rand = rng(seed);
    var out = [];
    var t = 0.6;
    while (t < CONFIG.roundSec) {
      var p = t / CONFIG.roundSec;                          // 0 at the start, 1 at the end
      var waveGap = tuning().waveGap;
      var gap = waveGap[0] + (waveGap[1] - waveGap[0]) * p;
      var size = Math.round(CONFIG.waveSize[0] + (CONFIG.waveSize[1] - CONFIG.waveSize[0]) * p);
      size = Math.max(1, size + (rand() < 0.3 ? 1 : 0));

      var wave = [];
      var bombUsed = false;
      for (var i = 0; i < size; i++) {
        var isBomb = !bombUsed && t > CONFIG.bombFrom && rand() < CONFIG.bombChance;
        if (isBomb) bombUsed = true;
        wave.push({
          ch: isBomb ? "*" : "",                            // letters are filled in below
          bomb: isBomb,
          // Spread entry points across the width, keeping clear of the edges.
          x: 0.12 + 0.76 * ((i + 0.5) / size) + (rand() - 0.5) * 0.1,
          // Multiplier on the speed's crossing time: below 1 falls faster.
          fall: CONFIG.fallSpread[0] + rand() * (CONFIG.fallSpread[1] - CONFIG.fallSpread[0]),
          drift: (rand() - 0.5) * 0.24,                     // sideways travel, fraction of width
          spin: (rand() - 0.5) * 0.9,                       // slow enough to read mid-fall
          // Spread the wave's entries across most of the gap to the next one.
          // Released together they descend as a horizontal band with dead space
          // between bands; spread out they read as a steady drizzle.
          delay: rand() * gap * 0.85
        });
      }

      // Every wave of two or more carries at least one vowel, otherwise the
      // bag happily deals BRRTS and there is nothing to cut.
      var letters = wave.filter(function (x) { return !x.bomb; });
      letters.forEach(function (tile) { tile.ch = drawLetter(rand); });
      if (letters.length >= 2 && !letters.some(function (x) { return VOWELS.indexOf(x.ch) >= 0; })) {
        letters[Math.floor(rand() * letters.length)].ch = drawVowel(rand);
      }

      out.push({ t: t, tiles: wave });
      t += gap;
    }
    return out;
  }

  // ---- tiles -----------------------------------------------------------------
  function release(wave) {
    wave.tiles.forEach(function (spec) {
      if (tiles.length >= CONFIG.maxLive) return;
      var travel = H + R * 3;                        // just above the top to just below the floor
      var cross = tuning().fallSec * spec.fall;      // seconds to make that trip
      tiles.push({
        id: nextId++,
        ch: spec.ch,
        bomb: spec.bomb,
        x: spec.x * W,
        y: -R,
        vx: (spec.drift * W) / cross,
        vy: travel / cross,                          // constant: no acceleration
        rot: 0,
        vrot: spec.spin,
        wait: spec.delay,
        sliced: false
      });
    });
  }

  function stepTiles(dt) {
    for (var i = tiles.length - 1; i >= 0; i--) {
      var t = tiles[i];
      if (t.wait > 0) { t.wait -= dt; continue; }
      t.x += t.vx * dt;
      t.y += t.vy * dt;                            // constant speed, no gravity term
      t.rot += t.vrot * dt;
      if (t.y > H + R * 2) tiles.splice(i, 1);     // fell past the floor, no penalty
    }
  }

  // ---- slicing ---------------------------------------------------------------
  // Distance from a circle centre to a line segment, squared.
  function segDistSq(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len = dx * dx + dy * dy;
    var t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var cx = ax + t * dx, cy = ay + t * dy;
    return (px - cx) * (px - cx) + (py - cy) * (py - cy);
  }

  function sliceSegment(ax, ay, bx, by) {
    for (var i = tiles.length - 1; i >= 0; i--) {
      var t = tiles[i];
      if (t.sliced || t.wait > 0) continue;
      if (segDistSq(t.x, t.y, ax, ay, bx, by) > R * R) continue;
      hit(t, i);
    }
  }

  function hit(t, index) {
    t.sliced = true;
    tiles.splice(index, 1);
    if (t.bomb) {
      // Ten seconds and the word you were building. That still ends the run if
      // the clock can't absorb it, which is the real danger late on.
      extra -= CONFIG.bombSec;
      streak = 0;
      buffer = [];
      pop(t.x, t.y, "−" + CONFIG.bombSec + "s", "bad");
      flashWord("bad");
      renderWord();
      renderHud();
      if (remaining() <= 0) endRound("bomb");
      return;
    }
    buffer.push(t.ch);
    renderWord();
  }

  // ---- scoring ---------------------------------------------------------------
  function multiplier() {
    return Math.min(CONFIG.multMax, 1 + Math.floor(streak / CONFIG.multEvery));
  }

  function letterSum(word) {
    var sum = 0;
    for (var i = 0; i < word.length; i++) sum += POINTS[word[i]] || 1;
    return sum;
  }
  function wordValue(word) { return letterSum(word) * word.length; }

  function timeBonus(len) {
    for (var i = 0; i < CONFIG.bonus.length; i++) {
      if (len >= CONFIG.bonus[i][0]) return CONFIG.bonus[i][1];
    }
    return 0;
  }

  function submit() {
    var word = buffer.join("");
    buffer = [];
    if (!word.length) { renderWord(); return null; }

    if (used[word]) {
      flashWord("bad");
      toast("Already cut " + word.toUpperCase());
      streak = 0;
      renderHud();
      return { word: word, ok: false, scored: 0, reason: "repeat" };
    }
    if (!dict().has(word)) {
      // A stray tap or a clipped letter or two isn't a wrong answer, it's an
      // accident, so it costs nothing. Past that length it was a real attempt.
      // Name what was actually cut. The blade takes tiles in the order it
      // meets them, so an intended BUT can arrive as BTU, or pick up a fourth
      // tile on the way past. Saying only "wrong" leaves the player certain a
      // real word was refused.
      if (word.length < CONFIG.freeBelow) {
        flashWord("bad");
        toast(word.toUpperCase() + " is not a word");
        return { word: word, ok: false, scored: 0, reason: "short" };
      }
      extra -= CONFIG.penaltySec;
      streak = 0;
      flashWord("bad");
      toast(word.toUpperCase() + " is not a word");
      pop(W / 2, H * 0.62, "−" + CONFIG.penaltySec + "s", "bad");
      renderHud();
      return { word: word, ok: false, scored: 0, reason: "unknown" };
    }

    var mult = multiplier();
    var gained = wordValue(word) * mult;
    var bonus = timeBonus(word.length);
    score += gained;
    extra += bonus;
    // Long words buy time, but a hot streak shouldn't run forever.
    if (remaining() > CONFIG.maxClock) extra = CONFIG.maxClock + elapsed - CONFIG.roundSec;
    streak++;
    used[word] = true;
    cut.push({ word: word, sum: letterSum(word), mult: mult, points: gained });
    flashWord("good");
    pop(W / 2, H * 0.62,
      "+" + gained + (mult > 1 ? " ×" + mult : "") + (bonus ? "  +" + bonus + "s" : ""), "good");
    renderHud();
    return { word: word, ok: true, scored: gained, bonus: bonus };
  }

  // ---- storage ---------------------------------------------------------------
  // Everything lives under the kit's prefix, "wordninja:", because every
  // shozbot app shares one origin now. The daily records are the kit's
  // (wordninja:daily:<iso>); the rest are this game's own settings and the
  // bests for random runs, one per speed.
  function read(key, fallback) { return daily.read(key, fallback); }
  function write(key, val) { daily.write(key, val); }
  function remove(key) { try { store.removeItem(key); } catch (e) { /* ignore */ } }
  function readRaw(key, fallback) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  // What was stored before the shared daily kit, and where it went:
  //   wn-daily:slow:<date>  one record per day at the default speed. These are
  //                         the daily runs, so each becomes a kit record for
  //                         that day, with the first score kept — which keeps
  //                         a streak and this week's runs. The old record held
  //                         only the best cut and a word count, so a migrated
  //                         day's results list one word and say so.
  //   wn-daily:fast:<date>  a fast daily no longer exists; Fast is a random
  //                         run now. These are deleted, after folding the best
  //                         of them into the Fast random best (below).
  //   wn-best               bests keyed mode:speed. The practice bests stay as
  //                         the random bests per speed; a daily:fast best counts
  //                         as a fast run and goes in with them; daily:slow is
  //                         implied by the migrated records, so is dropped.
  //   wn-speed, wn-help-seen  renamed under the prefix. wn-mode is gone: the
  //                         page always opens on today's run now.
  // Runs once per load, finds nothing the second time, and never touches a
  // day that already has a kit record.
  function migrate() {
    var keys = [];
    try { for (var i = 0; i < store.length; i++) keys.push(store.key(i)); } catch (e) { return; }
    if (!keys.some(function (k) { return /^wn-/.test(k); })) return;

    var oldBest = readRaw("wn-best", null);
    if (oldBest) {
      var best = read("best", {});
      var slow = oldBest["practice:slow"] || 0;
      var fast = Math.max(oldBest["practice:fast"] || 0, oldBest["daily:fast"] || 0);
      if (slow > (best.slow || 0)) best.slow = slow;
      if (fast > (best.fast || 0)) best.fast = fast;
      write("best", best);
      remove("wn-best");
    }
    keys.forEach(function (k) {
      var m = /^wn-daily:(slow|fast):(\d{4}-\d{2}-\d{2})$/.exec(k);
      if (!m) return;
      var old = readRaw(k, null), d = daily.parseIso(m[2]);
      if (m[1] === DAILY_SPEED && old && d && typeof old.score === "number") {
        daily.save(daily.metaFor(d), {
          score: old.score, max: null, results: [],
          recap: {
            reason: old.reason || "time", words: old.words || 0, partial: true,
            cuts: old.best ? [[old.best.word, old.best.sum, old.best.mult, old.best.points]] : []
          }
        });
      }
      remove(k);
    });
    var sp = readRaw("wn-speed", null);
    if (sp === "slow" || sp === "fast") { write("speed", sp); }
    if (readRaw("wn-help-seen", 0)) write("help-seen", 1);
    remove("wn-speed");
    remove("wn-help-seen");
    remove("wn-mode");
  }

  // ---- round lifecycle -------------------------------------------------------
  function beginRound() {
    sizeCanvas();
    schedule = buildSchedule(meta.seed);
    waveAt = 0;
    tiles = [];
    buffer = [];
    trail = [];
    cut = [];
    used = Object.create(null);
    elapsed = 0;
    extra = 0;
    score = 0;
    streak = 0;
    endReason = "";
    phase = "playing";
    els.startBack.classList.add("hidden");
    els.overBack.classList.add("hidden");
    els.pastBack.classList.add("hidden");
    renderWord();
    renderHud();
    lastFrame = 0;
    loop(performance.now());
  }

  function remaining() {
    return Math.max(0, CONFIG.roundSec + extra - elapsed);
  }

  function endRound(reason) {
    if (phase !== "playing") return;
    phase = "over";
    endReason = reason;
    dragging = false;
    buffer = [];
    cancelAnimationFrame(rafId);
    rafId = null;
    renderWord();
    showResults(saveResult());
  }

  // The record a run leaves. The kit keeps score/max/results/recap/at; this
  // game's recap is how the run ended and every word cut, with the factors
  // the results card lays out in columns.
  function saveResult() {
    var recap = {
      reason: endReason, words: cut.length,
      cuts: cut.map(function (c) { return [c.word, c.sum, c.mult, c.points]; })
    };
    var res = { meta: meta, score: score, recap: recap, first: false, newBest: false };
    if (mode === "daily") {
      // First score kept: the kit refuses to overwrite a day already saved.
      res.first = daily.save(meta, { score: score, max: null, results: [], recap: recap }).first;
    } else {
      var best = read("best", {});
      if (score > (best[speed] || 0)) {
        best[speed] = score;
        write("best", best);
        res.newBest = true;
      }
    }
    return res;
  }

  // ---- the loop --------------------------------------------------------------
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (phase !== "playing") return;

    // Cap the step so a backgrounded tab doesn't teleport every tile off-screen.
    var dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    lastFrame = now;

    if (!document.hidden) {
      elapsed += dt;
      while (waveAt < schedule.length && schedule[waveAt].t <= elapsed) {
        release(schedule[waveAt]);
        waveAt++;
      }
      stepTiles(dt);
      if (remaining() <= 0) { endRound("time"); return; }
    }

    renderHud();
    paint(now);
  }

  // ---- painting --------------------------------------------------------------
  function sizeCanvas() {
    var rect = els.arena.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.max(CONFIG.tileR[0], Math.min(CONFIG.tileR[1], Math.round(W * CONFIG.tileRFrac)));
  }

  function roundRect(x, y, w, h, r) {
    g2d.beginPath();
    g2d.moveTo(x + r, y);
    g2d.arcTo(x + w, y, x + w, y + h, r);
    g2d.arcTo(x + w, y + h, x, y + h, r);
    g2d.arcTo(x, y + h, x, y, r);
    g2d.arcTo(x, y, x + w, y, r);
    g2d.closePath();
  }

  function paint(now) {
    g2d.clearRect(0, 0, W, H);

    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.wait > 0) continue;
      g2d.save();
      g2d.translate(t.x, t.y);
      g2d.rotate(t.rot);
      if (t.bomb) {
        g2d.fillStyle = "#1a1016";
        g2d.strokeStyle = "#ff4d5e";
        g2d.lineWidth = 2;
        g2d.beginPath();
        g2d.arc(0, 0, R * 0.92, 0, Math.PI * 2);
        g2d.fill();
        g2d.stroke();
        g2d.font = "700 " + Math.round(R * 1.0) + "px system-ui, sans-serif";
        g2d.textAlign = "center";
        g2d.textBaseline = "middle";
        g2d.fillText("💣", 0, R * 0.06);
      } else {
        roundRect(-R, -R, R * 2, R * 2, R * 0.32);
        g2d.fillStyle = "#e9eef7";
        g2d.fill();
        g2d.strokeStyle = "rgba(13,15,20,0.35)";
        g2d.lineWidth = 1.5;
        g2d.stroke();
        g2d.fillStyle = "#14171f";
        g2d.font = "800 " + Math.round(R * 1.05) + "px system-ui, sans-serif";
        g2d.textAlign = "center";
        g2d.textBaseline = "middle";
        g2d.fillText(t.ch.toUpperCase(), 0, R * 0.06);
        // Letter value in the corner. This is the whole reason two words of the
        // same length score differently, so it has to be readable rather than
        // decorative.
        g2d.fillStyle = "rgba(20,23,31,0.72)";
        g2d.font = "800 " + Math.round(R * 0.42) + "px system-ui, sans-serif";
        g2d.fillText(String(POINTS[t.ch] || 1), R * 0.54, R * 0.58);
      }
      g2d.restore();
    }

    // The blade: recent pointer positions, tapering and fading.
    var live = [];
    for (var k = 0; k < trail.length; k++) {
      if (now - trail[k].t <= CONFIG.trailMs) live.push(trail[k]);
    }
    trail = live;
    if (live.length > 1) {
      for (var j = 1; j < live.length; j++) {
        var age = (now - live[j].t) / CONFIG.trailMs;
        g2d.strokeStyle = "rgba(86,224,255," + (0.85 * (1 - age)).toFixed(3) + ")";
        g2d.lineWidth = Math.max(1, 9 * (1 - age));
        g2d.lineCap = "round";
        g2d.beginPath();
        g2d.moveTo(live[j - 1].x, live[j - 1].y);
        g2d.lineTo(live[j].x, live[j].y);
        g2d.stroke();
      }
    }
  }

  // ---- DOM chrome ------------------------------------------------------------
  function mmss(s) {
    var m = Math.floor(s / 60);
    return m + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  }

  function renderHud() {
    els.score.textContent = String(score);
    els.wordCount.textContent = "(" + cut.length + ")";
    var left = remaining();
    els.clock.textContent = mmss(Math.ceil(left));
    els.clock.classList.toggle("low", left <= 10);
    var frac = Math.max(0, Math.min(1, left / CONFIG.roundSec));
    els.timeFill.style.width = (frac * 100).toFixed(1) + "%";
    els.timeFill.classList.toggle("low", left <= 10);
    var m = multiplier();
    els.mult.textContent = "×" + m;
    els.mult.classList.toggle("hidden-soft", m < 2);
  }

  function renderWord() {
    els.word.className = "word";
    els.word.innerHTML = "";
    if (!buffer.length) {
      if (phase === "playing") {
        var h = document.createElement("span");
        h.className = "hint";
        h.textContent = "drag through the letters";
        els.word.appendChild(h);
      }
      return;
    }
    buffer.forEach(function (ch) {
      var d = document.createElement("span");
      d.className = "ch";
      d.textContent = ch;
      els.word.appendChild(d);
    });
  }

  // Keep the just-submitted word on screen for a beat, coloured by the verdict.
  function flashWord(kind) {
    var letters = els.word.querySelectorAll(".ch");
    if (!letters.length) { renderWord(); return; }
    els.word.className = "word " + kind;
    // A rejected word lingers: reading back what the blade actually took is
    // the only way to learn that the order or an extra tile was the problem.
    setTimeout(function () { if (!buffer.length) renderWord(); },
      kind === "bad" ? 900 : 260);
  }

  function pop(x, y, text, kind) {
    var d = document.createElement("div");
    d.className = "pop " + kind;
    d.style.left = x + "px";
    d.style.top = y + "px";
    d.textContent = text;
    els.pops.appendChild(d);
    setTimeout(function () { d.remove(); }, 1000);
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastId);
    toastId = setTimeout(function () { els.toast.classList.remove("show"); }, 1400);
  }

  // ---- the daily line and the places to go -----------------------------------
  // Under the name: which run is showing, and links to the other two places.
  // The hrefs are the real URL states, so a link can be opened in a new tab;
  // a tap stays on the page and routes in place.
  var PLACES = {
    today: ["Today’s puzzle", "?daily", function () { openToday(); }],
    past: ["Past puzzles", "?past", function () { showPast(); }],
    random: ["Random puzzles", "?practice", function () { showStart(daily.practiceMeta()); }]
  };
  function setDailyLine(html, places) {
    els.dailyText.innerHTML = html;
    els.dailyLinks.innerHTML = "";
    places.forEach(function (k) {
      var a = document.createElement("a");
      a.href = PLACES[k][1];
      a.textContent = PLACES[k][0];
      a.addEventListener("click", function (e) { e.preventDefault(); PLACES[k][2](); });
      els.dailyLinks.appendChild(a);
    });
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function lineFor(m) {
    return m && m.mode === "daily"
      ? "<b>Daily No. " + m.number + "</b> · " + esc(daily.fmtShort(m.date))
      : "<b>Random puzzles</b>";
  }
  function isToday(m) { return m && m.mode === "daily" && m.iso === daily.iso(daily.today()); }
  function showingMeta(m) {
    meta = m;
    mode = m.mode === "daily" ? "daily" : "practice";
    speed = mode === "daily" ? DAILY_SPEED : practiceSpeed;
    setUrl(mode === "daily" ? (isToday(m) ? "" : "?daily=" + m.iso) : "?practice");
    setDailyLine(lineFor(m), mode === "daily" ? ["past", "random"] : ["today", "past"]);
  }
  // The address names the day, so a run can be linked; today's is the bare
  // page. Replaced rather than pushed, so Back leaves the game rather than
  // walking through every card shown.
  function setUrl(query) {
    try { history.replaceState(null, "", location.pathname + query); } catch (e) { /* file:// */ }
  }

  // ---- cards -----------------------------------------------------------------
  // Stop the round: no loop, no tiles, no half-built word. The hud keeps the
  // score it had, so a finished run still reads under its results card.
  function stopRound(nextPhase) {
    phase = nextPhase;
    cancelAnimationFrame(rafId);
    rafId = null;
    tiles = [];
    buffer = [];
    dragging = false;
    renderWord();
    g2d.clearRect(0, 0, W, H);
  }
  // ...and clear the hud too, for a card that stands before a run.
  function resetRound() {
    stopRound("ready");
    elapsed = 0;
    extra = 0;
    score = 0;
    streak = 0;
    renderHud();
  }
  function showOnly(back) {
    [els.startBack, els.overBack, els.pastBack].forEach(function (b) {
      b.classList.toggle("hidden", b !== back);
    });
    back.querySelector(".card").scrollTop = 0;
  }

  // The one card before the clock starts: the rules in brief and Start. For
  // today's daily by default; for a past day or a random run when asked.
  function showStart(m) {
    resetRound();
    showingMeta(m);
    var isDaily = mode === "daily";
    var today = isToday(m);
    var played = isDaily ? daily.record(m.iso) : null;
    var best = read("best", {});
    els.startTitle.textContent = isDaily ? "Daily No. " + m.number : "Random run";
    els.startSub.textContent = isDaily
      ? (today ? "Everyone gets the same letters today." : "The letters everyone got on " + daily.fmtShort(m.date) + ".")
      : "Fresh letters every time. Play as often as you like.";
    els.startBest.innerHTML = "";
    if (played) {
      addLine((today ? "Today: " : "Your score: ") + played.score + " points. " +
        "Play it again for fun; your first score is the one that is kept.");
    } else if (!isDaily && best[practiceSpeed]) {
      addLine("Best " + (practiceSpeed === "fast" ? "Fast" : "Slow") + " run so far: " + best[practiceSpeed]);
    }
    els.speedRow.classList.toggle("hidden", isDaily);
    els.speedSlow.classList.toggle("active", practiceSpeed === "slow");
    els.speedFast.classList.toggle("active", practiceSpeed === "fast");
    els.startBtn.textContent = played ? "Play it again" : "Start";
    showOnly(els.startBack);

    function addLine(text) {
      var p = document.createElement("p");
      p.textContent = text;
      els.startBest.appendChild(p);
    }
  }

  // res = { meta, score, recap, first, newBest }. The same card shows a run
  // just finished and a day's kept record opened from Past puzzles.
  function showResults(res) {
    stopRound("over");
    showingMeta(res.meta);
    lastResult = res;
    var isDaily = mode === "daily";
    var recap = res.recap || {};
    var cuts = (recap.cuts || []).slice().sort(function (a, b) { return b[3] - a[3]; });
    var words = recap.words || cuts.length;

    // The shared order: score, verdict, streak, saved line, then the game's own.
    els.overScore.textContent = String(res.score);
    els.overSub.textContent = recap.reason === "bomb"
      ? "You cut a bomb. The run ended there."
      : "The clock ran out.";
    var run = isToday(res.meta) ? daily.streakLine() : "";
    els.overStreak.textContent = run;
    els.overStreak.classList.toggle("hidden", !run);
    var saved, good = false;
    if (isDaily) {
      saved = daily.savedLine(res.meta, res.first);
      good = !!res.first;
    } else {
      var best = read("best", {})[speed] || res.score;
      var label = speed === "fast" ? "Fast" : "Slow";
      saved = res.newBest ? "A new best for " + label + " runs." : "Random runs are not kept. Your best " + label + " run is " + best + ".";
      good = !!res.newBest;
    }
    els.overSaved.textContent = saved;
    els.overSaved.classList.toggle("good", good);

    els.stWords.textContent = String(words);
    els.stBest.textContent = cuts.length ? cuts[0][0].toUpperCase() : "—";

    // One row per word, one column per factor, headed once at the top. An
    // earlier version wrote the arithmetic inline after the tiles, so the
    // numbers landed in a different place on every line and a three-letter
    // word beating a four-letter one looked like a fault rather than a streak.
    els.cutList.innerHTML = "";
    els.cutHead.classList.toggle("hidden", cuts.length === 0);
    cuts.slice(0, 12).forEach(function (c) {
      var word = c[0], sum = c[1], mult = c[2], points = c[3];
      var row = document.createElement("div");
      row.className = mult > 1 ? "cut boost" : "cut";

      var wt = document.createElement("div");
      wt.className = "wt";
      var w = document.createElement("span");
      w.className = "w";
      w.textContent = word;
      wt.appendChild(w);

      var tiles = document.createElement("span");
      tiles.className = "tiles";
      word.split("").forEach(function (ch) {
        var t = document.createElement("span");
        t.className = "mt";
        t.appendChild(document.createTextNode(ch));
        var v = document.createElement("i");
        v.textContent = POINTS[ch] || 1;
        t.appendChild(v);
        tiles.appendChild(t);
      });
      wt.appendChild(tiles);
      row.appendChild(wt);

      row.appendChild(col("sum", String(sum)));
      row.appendChild(col("len", "×" + word.length));
      // The streak factor wears the amber pill from the score bar; a word cut
      // without a streak gets a dash rather than a silent gap, so the column
      // never looks like missing information.
      var runCol = col("run", "");
      if (mult > 1) {
        var pill = document.createElement("b");
        pill.textContent = "×" + mult;
        runCol.appendChild(pill);
      } else {
        runCol.textContent = "–";
      }
      row.appendChild(runCol);
      row.appendChild(col("tot", String(points)));

      els.cutList.appendChild(row);
    });
    // A record migrated from before the kit kept only the best cut.
    els.cutMore.textContent = recap.partial && words > cuts.length
      ? "Only the best cut was kept from this run; " + words + " words were cut in all."
      : (cuts.length > 12 ? "and " + (cuts.length - 12) + " more" : "");

    function col(kind, text) {
      var el = document.createElement("span");
      el.className = "n " + kind;
      el.textContent = text;
      return el;
    }

    els.randomBtn.textContent = isDaily ? "Play random puzzles" : "More random puzzles";
    els.againBtn.textContent = isDaily ? "Play it again" : "Today’s puzzle";
    els.shareBtn.textContent = "Share";
    showOnly(els.overBack);
  }

  // The previous 100 days, newest first, with the kept score beside any played.
  function showPast() {
    resetRound();
    meta = null;
    setUrl("?past");
    setDailyLine("<b>Past puzzles</b> · the previous " + daily.PAST_DAYS + " days", ["today", "random"]);
    var t = daily.today();
    els.pastList.innerHTML = "";
    daily.pastDays().forEach(function (m) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "?daily=" + m.iso;
      if (m.isToday) a.className = "today";
      var n = document.createElement("span");
      n.className = "n";
      n.textContent = "No. " + m.number;
      var d = document.createElement("span");
      d.className = "d";
      d.textContent = (m.isToday ? "Today, " : "") + daily.fmtTiny(m.date) +
        (m.date.getFullYear() !== t.getFullYear() ? ", " + m.date.getFullYear() : "");
      var s = document.createElement("span");
      s.className = m.record ? "s done" : "s";
      s.textContent = m.record ? String(m.record.score) : "Not played";
      a.appendChild(n); a.appendChild(d); a.appendChild(s);
      a.addEventListener("click", function (e) { e.preventDefault(); openDate(m.iso); });
      li.appendChild(a);
      els.pastList.appendChild(li);
    });
    showOnly(els.pastBack);
  }

  // A day that has been played opens on its results; Play it again starts it over.
  function openDate(isoDate) {
    var d = daily.parseIso(isoDate);
    if (!d) return openToday();
    if (d > daily.today()) return showPast();
    var m = daily.metaFor(d), r = daily.record(m.iso);
    if (r) return showResults({ meta: m, score: r.score, recap: r.recap, first: false, newBest: false });
    showStart(m);
  }
  function openToday() { openDate(daily.iso(daily.today())); }

  // Where the address says to open: a day, the past list, a random run, or
  // — with nothing said — today's run.
  function route() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
    if (q && q.has("past")) return showPast();
    if (q && q.has("practice")) return showStart(daily.practiceMeta());
    if (q && q.get("daily")) return openDate(q.get("daily"));
    openToday();
  }

  // ---- sharing ---------------------------------------------------------------
  // The kit's lines: "Word Ninja No. 285 · Oct 12", then "Score 1240" (there is
  // no maximum, so no squares), then the game's address.
  function shareText() {
    if (!lastResult) return "";
    return daily.shareText({ meta: lastResult.meta, score: lastResult.score, max: null, squares: "" });
  }
  function share() {
    var text = shareText();
    if (!text) return;
    daily.share(text, els.shareBtn).then(function (how) {
      if (how === "failed") toast("Copy failed");
    });
  }

  // ---- input -----------------------------------------------------------------
  function pointAt(e) {
    var rect = cv.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onDown(e) {
    if (phase !== "playing") return;
    dragging = true;
    buffer = [];
    trail = [];
    var p = pointAt(e);
    trail.push({ x: p.x, y: p.y, t: performance.now() });
    if (cv.setPointerCapture && e.pointerId != null) {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    }
    renderWord();
  }

  function onMove(e) {
    if (!dragging || phase !== "playing") return;
    var p = pointAt(e);
    var last = trail[trail.length - 1];
    if (last) sliceSegment(last.x, last.y, p.x, p.y);
    trail.push({ x: p.x, y: p.y, t: performance.now() });
    if (trail.length > 40) trail.shift();
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    if (phase === "playing") submit();
  }

  // The speed choice belongs to random runs; the daily is always Slow.
  function setSpeed(s) {
    if (s !== "slow" && s !== "fast") return;
    practiceSpeed = s;
    write("speed", s);
    if (mode === "practice" && phase === "ready") showStart(meta);  // the card reports this speed's best
  }

  function bind() {
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("pointerleave", onUp);

    els.speedSlow.addEventListener("click", function () { setSpeed("slow"); });
    els.speedFast.addEventListener("click", function () { setSpeed("fast"); });
    els.startBtn.addEventListener("click", beginRound);
    els.randomBtn.addEventListener("click", function () { showStart(daily.practiceMeta()); });
    els.pastBtn.addEventListener("click", showPast);
    els.pastRandom.addEventListener("click", function () { showStart(daily.practiceMeta()); });
    els.againBtn.addEventListener("click", function () {
      // On a daily: the same day's letters again, for fun. On a random run the
      // slot is the way back to today's puzzle.
      if (mode === "daily") showStart(meta); else openToday();
    });
    els.shareBtn.addEventListener("click", share);

    var openHelp = function () { els.helpBack.classList.remove("hidden"); };
    els.helpBtn.addEventListener("click", openHelp);
    els.startHelp.addEventListener("click", openHelp);
    els.helpClose.addEventListener("click", function () {
      els.helpBack.classList.add("hidden");
      write("help-seen", 1);
    });

    window.addEventListener("resize", function () {
      var wasPlaying = phase === "playing";
      sizeCanvas();
      if (!wasPlaying) g2d.clearRect(0, 0, W, H);
    });
    document.addEventListener("visibilitychange", function () {
      // Dropping the stale timestamp stops the first frame back from eating time.
      if (!document.hidden) lastFrame = 0;
    });
  }

  // ---- start -----------------------------------------------------------------
  function start() {
    migrate();
    // Slow is the default for random runs too: play testing picked it, and it
    // is the kinder first run. A stored choice still wins.
    practiceSpeed = read("speed", "slow") === "fast" ? "fast" : "slow";
    bind();
    sizeCanvas();
    route();
    if (!read("help-seen", 0)) els.helpBack.classList.remove("hidden");
  }

  return {
    start: start,
    // Exposed for the smoke test. The round model is deliberately separable
    // from the physics, so a test can drive it without chasing flying tiles.
    _debug: {
      state: function () {
        return {
          phase: phase, mode: mode, speed: speed, score: score, streak: streak,
          fallSec: tuning().fallSec,
          mult: multiplier(), remaining: remaining(), buffer: buffer.join(""),
          tiles: tiles.length, words: cut.map(function (c) { return c.word; }),
          waves: schedule.length,
          meta: meta ? { mode: meta.mode, iso: meta.iso, number: meta.number, seed: meta.seed } : null
        };
      },
      daily: daily,
      open: openDate,
      today: openToday,
      past: showPast,
      practice: function () { showStart(daily.practiceMeta()); },
      shareText: shareText,
      migrate: migrate,
      begin: beginRound,
      end: endRound,
      // Type a word straight into the buffer and submit it.
      play: function (word) {
        buffer = word.split("");
        renderWord();
        return submit();
      },
      // Drop the clock to n seconds left, to reach the end of a round quickly.
      setRemaining: function (s) { extra = s + elapsed - CONFIG.roundSec; },
      // Put one tile at a known spot so a real pointer drag can be tested.
      placeTile: function (x, y, ch) {
        var t = {
          id: nextId++, ch: ch || "a", bomb: ch === "*",
          x: x, y: y, vx: 0, vy: 0, rot: 0, vrot: 0, wait: 0, sliced: false
        };
        tiles.push(t);
        return { id: t.id, x: x, y: y, r: R };
      },
      schedule: function (seed) { return buildSchedule(hash32(seed)); },
      setSpeed: setSpeed
    }
  };
};
