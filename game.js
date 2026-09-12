// Word Ninja — game module.
// A factory: index.html calls createWordNinja(ctx).start().
// ctx = { data, storage, canvas }, where data is the generated words.js payload.
//
// The round is driven by a wave SCHEDULE built up front from a seed, not by
// per-frame randomness. Two things fall out of that: the daily run deals the
// same letters to everyone regardless of frame rate or screen size, and the
// scoring can be tested without running the physics at all.
window.createWordNinja = function (ctx) {
  "use strict";

  var DATA = ctx.data;
  var store = ctx.storage;
  var cv = ctx.canvas;
  var g2d = cv.getContext("2d");

  var DICT = new Set(DATA.WORDS);
  var POINTS = DATA.POINTS;
  var MIN_LEN = DATA.MIN;

  // ---- tunables --------------------------------------------------------------
  var CONFIG = {
    roundSec: 60,
    // Gravity sets how long a tile hangs, and hang time is the whole game.
    // This is a WORD game: you have to read a dozen letters, find a word in
    // them, and plan a path through it in the right order. At 1.15 a tile was
    // airborne about two seconds, which is fine for cutting fruit on reflex and
    // hopeless for thinking. At 0.26 it is four to five, which leaves room to
    // look before you swipe.
    gravity: 0.26,          // x arena height, per second squared
    // Tuned against a simulation of how many words are formable from the tiles
    // on screen: sparser or shorter-lived waves left nothing to cut about a
    // fifth of the time, and rarely anything past three letters.
    rise: [0.52, 0.88],     // apex height as a fraction of the arena
    tileR: [22, 32],        // tile radius clamp, px
    tileRFrac: 0.072,       // ... as a fraction of arena width
    // Slower tiles linger, so waves have to thin out or the screen floods.
    waveGap: [2.4, 1.6],    // seconds between waves, start -> end of round
    waveSize: [4, 6],       // tiles per wave, start -> end of round
    // A safety valve, not a limiter: peaks run near 21 tiles, and a cap that
    // actually bites would drop tiles depending on frame timing, which would
    // make the daily run differ between devices.
    maxLive: 30,
    bombFrom: 8,            // no bombs in the first n seconds
    bombChance: 0.045,      // per tile, at most one per wave
    bombSec: 10,            // what cutting one costs
    maxClock: 90,           // time bonuses can't stretch a run past this
    trailMs: 260,
    penaltySec: 3,
    bonus: [[7, 4], [5, 2]], // [minLength, secondsAdded], first match wins
    multEvery: 3,           // valid words per multiplier step
    multMax: 5
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    arena: $("arena"), score: $("score"), mult: $("mult"), clock: $("clock"),
    timeFill: $("timeFill"), word: $("word"), pops: $("pops"), toast: $("toast"),
    modeDaily: $("modeDaily"), modePractice: $("modePractice"), helpBtn: $("helpBtn"),
    startBack: $("startBack"), startTitle: $("startTitle"), startSub: $("startSub"),
    startBest: $("startBest"), startBtn: $("startBtn"), startHelp: $("startHelp"),
    overBack: $("overBack"), overTitle: $("overTitle"), overSub: $("overSub"),
    stScore: $("stScore"), stWords: $("stWords"), stBest: $("stBest"),
    cutList: $("cutList"), againBtn: $("againBtn"), shareBtn: $("shareBtn"),
    helpBack: $("helpBack"), helpClose: $("helpClose")
  };

  // ---- state -----------------------------------------------------------------
  var mode = "daily";        // "daily" | "practice"
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
      var gap = CONFIG.waveGap[0] + (CONFIG.waveGap[1] - CONFIG.waveGap[0]) * p;
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
          // Spread launch points across the width, keeping clear of the edges.
          x: 0.12 + 0.76 * ((i + 0.5) / size) + (rand() - 0.5) * 0.1,
          rise: CONFIG.rise[0] + rand() * (CONFIG.rise[1] - CONFIG.rise[0]),
          drift: (rand() - 0.5) * 0.24,                     // sideways travel, fraction of width
          spin: (rand() - 0.5) * 0.9,          // slow enough to read mid-flight
          delay: rand() * 0.22                              // stagger within the wave
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
      var grav = CONFIG.gravity * H;
      var rise = spec.rise * H;
      var vy = -Math.sqrt(2 * grav * rise);          // exactly enough to reach the apex
      var air = (-2 * vy) / grav;                    // seconds from launch to landing
      tiles.push({
        id: nextId++,
        ch: spec.ch,
        bomb: spec.bomb,
        x: spec.x * W,
        y: H + R,
        vx: (spec.drift * W) / air,
        vy: vy,
        rot: 0,
        vrot: spec.spin,
        wait: spec.delay,
        sliced: false
      });
    });
  }

  function stepTiles(dt) {
    var grav = CONFIG.gravity * H;
    for (var i = tiles.length - 1; i >= 0; i--) {
      var t = tiles[i];
      if (t.wait > 0) { t.wait -= dt; continue; }
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.vy += grav * dt;
      t.rot += t.vrot * dt;
      if (t.y > H + R * 2.5) tiles.splice(i, 1);   // fell away, no penalty
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

  function wordValue(word) {
    var sum = 0;
    for (var i = 0; i < word.length; i++) sum += POINTS[word[i]] || 1;
    return sum * word.length;
  }

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

    // A stray tap or a one-letter clip isn't a wrong answer, so it costs nothing.
    if (word.length < MIN_LEN) {
      flashWord("bad");
      toast(MIN_LEN + " letters or more");
      return { word: word, ok: false, scored: 0, reason: "short" };
    }
    if (used[word]) {
      flashWord("bad");
      toast("Already cut " + word.toUpperCase());
      streak = 0;
      renderHud();
      return { word: word, ok: false, scored: 0, reason: "repeat" };
    }
    if (!DICT.has(word)) {
      extra -= CONFIG.penaltySec;
      streak = 0;
      flashWord("bad");
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
    cut.push({ word: word, points: gained });
    flashWord("good");
    pop(W / 2, H * 0.62,
      "+" + gained + (mult > 1 ? " ×" + mult : "") + (bonus ? "  +" + bonus + "s" : ""), "good");
    renderHud();
    return { word: word, ok: true, scored: gained, bonus: bonus };
  }

  // ---- round lifecycle -------------------------------------------------------
  function localDateKey(d) {
    var p = function (x) { return String(x).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function todayKey() { return localDateKey(new Date()); }

  function read(key, fallback) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { store.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  function seedFor(kind) {
    return kind === "daily"
      ? hash32("wn:daily:" + todayKey())
      : hash32("wn:practice:" + Date.now() + ":" + Math.random());
  }

  function beginRound() {
    sizeCanvas();
    schedule = buildSchedule(seedFor(mode));
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
    saveResult();
    showResults();
  }

  function saveResult() {
    var best = read("wn-best", {});
    if (!best[mode] || score > best[mode]) {
      best[mode] = score;
      write("wn-best", best);
    }
    if (mode === "daily") {
      write("wn-daily:" + todayKey(), {
        score: score, words: cut.length, reason: endReason,
        best: cut.slice().sort(function (a, b) { return b.points - a.points; })[0] || null
      });
    }
  }

  function dailyPlayed() { return read("wn-daily:" + todayKey(), null); }

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
        // Letter value, small, in the corner.
        g2d.fillStyle = "rgba(20,23,31,0.5)";
        g2d.font = "700 " + Math.round(R * 0.36) + "px system-ui, sans-serif";
        g2d.fillText(String(POINTS[t.ch] || 1), R * 0.55, R * 0.6);
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
    var left = remaining();
    els.clock.textContent = mmss(Math.ceil(left));
    els.clock.classList.toggle("low", left <= 10);
    var frac = Math.max(0, Math.min(1, left / CONFIG.roundSec));
    els.timeFill.style.width = (frac * 100).toFixed(1) + "%";
    els.timeFill.classList.toggle("low", left <= 10);
    var m = multiplier();
    els.mult.textContent = "×" + m;
    els.mult.classList.toggle("hidden-soft", m < 2);
    els.modeDaily.classList.toggle("active", mode === "daily");
    els.modePractice.classList.toggle("active", mode === "practice");
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
    setTimeout(function () { if (!buffer.length) renderWord(); }, 260);
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

  // ---- cards -----------------------------------------------------------------
  function showStart() {
    phase = "ready";
    cancelAnimationFrame(rafId);
    rafId = null;
    tiles = [];
    buffer = [];
    elapsed = 0;
    extra = 0;
    score = 0;
    streak = 0;
    renderHud();
    renderWord();
    g2d.clearRect(0, 0, W, H);

    var best = read("wn-best", {});
    var played = mode === "daily" ? dailyPlayed() : null;
    els.startTitle.textContent = mode === "daily" ? "Daily run" : "Practice run";
    els.startSub.textContent = mode === "daily"
      ? "One attempt. Everyone gets the same letters today."
      : "Fresh letters every time. Play as often as you like.";
    els.startBest.innerHTML = "";
    if (played) {
      els.startSub.textContent = "You've already played today's run.";
      addLine("Today: " + played.score + " points from " + played.words + " words");
      addLine("Come back tomorrow, or switch to Practice.");
    } else if (best[mode]) {
      addLine("Best so far: " + best[mode]);
    }
    els.startBtn.textContent = played ? "Play it again for fun" : "Start";
    els.startBack.classList.remove("hidden");
    els.overBack.classList.add("hidden");

    function addLine(text) {
      var p = document.createElement("p");
      p.textContent = text;
      els.startBest.appendChild(p);
    }
  }

  function showResults() {
    var ranked = cut.slice().sort(function (a, b) { return b.points - a.points; });
    els.overTitle.textContent = endReason === "bomb" ? "Bomb" : "Time";
    els.overSub.textContent = endReason === "bomb"
      ? "You cut a bomb. The run ends there."
      : (mode === "daily" ? "Daily run · " + todayKey() : "Practice run");
    els.stScore.textContent = String(score);
    els.stWords.textContent = String(cut.length);
    els.stBest.textContent = ranked.length ? ranked[0].word.toUpperCase() : "—";

    els.cutList.innerHTML = "";
    ranked.slice(0, 12).forEach(function (c) {
      var s = document.createElement("span");
      s.textContent = c.word;
      var b = document.createElement("b");
      b.textContent = c.points;
      s.appendChild(b);
      els.cutList.appendChild(s);
    });

    els.againBtn.textContent = mode === "daily" ? "Practice run" : "Play again";
    els.overBack.classList.remove("hidden");
  }

  function shareText() {
    var ranked = cut.slice().sort(function (a, b) { return b.points - a.points; });
    var head = "Word Ninja · " + (mode === "daily" ? todayKey() : "practice");
    var body = score + " points · " + cut.length + " words";
    var top = ranked.length ? "best cut: " + ranked[0].word.toUpperCase() + " (" + ranked[0].points + ")" : "";
    var tail = endReason === "bomb" ? "💣 ended on a bomb" : "⏱ ran out of time";
    return [head, body, top, tail].filter(Boolean).join("\n");
  }

  function share() {
    var text = shareText();
    var ok = function () { toast("Result copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { toast("Copy failed"); });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) { toast("Copy failed"); }
      document.body.removeChild(ta);
    }
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

  function setMode(m) {
    if (m === mode && phase === "ready") return;
    mode = m;
    write("wn-mode", m);
    showStart();
  }

  function bind() {
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("pointerleave", onUp);

    els.modeDaily.addEventListener("click", function () { setMode("daily"); });
    els.modePractice.addEventListener("click", function () { setMode("practice"); });
    els.startBtn.addEventListener("click", beginRound);
    els.againBtn.addEventListener("click", function () {
      if (mode === "daily") { setMode("practice"); return; }
      beginRound();
    });
    els.shareBtn.addEventListener("click", share);

    var openHelp = function () { els.helpBack.classList.remove("hidden"); };
    els.helpBtn.addEventListener("click", openHelp);
    els.startHelp.addEventListener("click", openHelp);
    els.helpClose.addEventListener("click", function () {
      els.helpBack.classList.add("hidden");
      write("wn-help-seen", 1);
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
    mode = read("wn-mode", "daily") === "practice" ? "practice" : "daily";
    bind();
    sizeCanvas();
    showStart();
    if (!read("wn-help-seen", 0)) els.helpBack.classList.remove("hidden");
  }

  return {
    start: start,
    // Exposed for the smoke test. The round model is deliberately separable
    // from the physics, so a test can drive it without chasing flying tiles.
    _debug: {
      state: function () {
        return {
          phase: phase, mode: mode, score: score, streak: streak,
          mult: multiplier(), remaining: remaining(), buffer: buffer.join(""),
          tiles: tiles.length, words: cut.map(function (c) { return c.word; }),
          waves: schedule.length
        };
      },
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
      dailySeedKey: todayKey
    }
  };
};
