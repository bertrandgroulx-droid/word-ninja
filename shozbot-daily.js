/* Shozbot daily-puzzle kit — the logic every daily game shares, with no DOM
   and no styling. Each game draws its own screens; this decides what they say.

   What it gives a game, so that all of them behave the same way:
     - which day it is, how days are numbered (by day of the year, "No. 285"),
       and a seed for that day so everyone gets the same puzzle;
     - a saved record per day under one storage shape, with the first score
       kept and later plays never overwriting it;
     - the streak (days in a row ending today or yesterday);
     - the standard wording: the daily line, the verdict, the "saved" note;
     - the share text, with the emoji line and the game's address.

   The canonical copy lives in the studio repo at kit/daily.js. Each game
   carries its own copy (shozbot-daily.js) so it works with no other site up,
   the same way the Puzzling games carry their shell. Change the canonical
   copy, then copy it into each game.

   Usage:
     var daily = ShozDaily.create({ game: "letter-drop", title: "Letter Drop" });
     var meta = daily.todayMeta();            // { mode:"daily", date, iso, number, seed }
     var rng = daily.rng(meta.seed);          // 0..1, deterministic for the day
     ... play ...
     var saved = daily.save(meta, { score: 7, max: 10, results: [1,0,1,...], recap: [...] });
     saved.first        // true when this is the kept score
     daily.streak()     // 3
     daily.shareText({ meta, score: 7, max: 10, results: [...] , perMax: 1 })
*/
(function (root) {
  "use strict";

  var PAST_DAYS = 100;

  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseIso(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  // Numbered by the day of the year, as the Puzzling games are: Jan 1 is No. 1.
  function dayOfYear(d) { return Math.round((startOfDay(d) - new Date(d.getFullYear(), 0, 1)) / 864e5) + 1; }

  function fmtShort(d) { return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
  function fmtTiny(d) { return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  function fmtLong(d) { return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }); }

  // FNV-1a, 32-bit: a stable hash of a string, the same in every browser.
  function hash32(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // mulberry32: a small, good-enough generator seeded from that hash.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, random) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function create(opts) {
    if (!opts || !opts.game) throw new Error("ShozDaily.create needs a game name");
    var game = opts.game, title = opts.title || game;
    // The same prefix rule as the Puzzling games: the name without hyphens, then a colon.
    var store = game.replace(/-/g, "") + ":";
    var storage = opts.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    var clock = opts.now || function () { return new Date(); };

    function today() { return startOfDay(clock()); }
    function read(key, fallback) {
      if (!storage) return fallback;
      try { var v = storage.getItem(store + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    }
    function write(key, value) {
      if (!storage) return;
      try { storage.setItem(store + key, JSON.stringify(value)); } catch (e) { /* a blocked store never breaks the game */ }
    }

    function metaFor(date) {
      var d = startOfDay(date);
      return { mode: "daily", date: d, iso: iso(d), number: dayOfYear(d), seed: hash32(game + ":" + iso(d)) };
    }
    function todayMeta() { return metaFor(today()); }
    function practiceMeta() { return { mode: "practice", seed: hash32(game + ":practice:" + Math.random()) }; }

    function record(isoDate) { return read("daily:" + isoDate, null); }
    // The first finished score for a day is the one that is kept.
    function save(meta, res) {
      if (!meta || meta.mode !== "daily") return { first: false, saved: false };
      if (record(meta.iso)) return { first: false, saved: false };
      write("daily:" + meta.iso, {
        score: res.score, max: res.max === undefined ? null : res.max,
        results: res.results || [], recap: res.recap || [], at: Date.now()
      });
      return { first: true, saved: true };
    }
    function streak() {
      var t = today(), d = record(iso(t)) ? t : addDays(t, -1), n = 0;
      while (record(iso(d))) { n++; d = addDays(d, -1); }
      return n;
    }
    function best() {
      // Highest kept daily score, for a game that wants to show one.
      var b = null;
      if (!storage) return b;
      try {
        for (var i = 0; i < storage.length; i++) {
          var k = storage.key(i);
          if (k && k.indexOf(store + "daily:") === 0) {
            var r = JSON.parse(storage.getItem(k));
            if (r && (b === null || r.score > b.score)) b = r;
          }
        }
      } catch (e) { /* ignore */ }
      return b;
    }
    function pastDays(n) {
      var t = today(), out = [];
      for (var i = 0; i <= (n || PAST_DAYS); i++) {
        var d = addDays(t, -i), m = metaFor(d);
        m.record = record(m.iso); m.isToday = i === 0;
        out.push(m);
      }
      return out;
    }

    // ---- the standard wording ----
    function label(meta) {
      return meta && meta.mode === "daily" ? "Daily No. " + meta.number + " · " + fmtShort(meta.date) : "Random puzzles";
    }
    function verdict(score, max, meta) {
      var daily = meta && meta.mode === "daily";
      if (max === null || max === undefined) return daily ? "Saved as today’s run." : "A practice run.";
      var ratio = max ? score / max : 0;
      return ratio === 1 ? "A perfect game." : ratio >= 0.7 ? "A strong game." : ratio >= 0.4 ? "A fair game."
        : (daily ? "A tough one. Tomorrow’s is different." : "A tough one. The next one is different.");
    }
    function savedLine(meta, first) {
      if (!meta || meta.mode !== "daily") return "Random puzzle scores are not saved.";
      if (first) return "Saved as your score for " + (meta.iso === iso(today()) ? "today" : "this day") + ".";
      return "Your first score for this puzzle is the one that is kept.";
    }
    function streakLine() { var n = streak(); return n >= 2 ? n + " days in a row" : ""; }

    // ---- sharing ----
    // results: one number per item; perMax: the most an item can score. Full
    // marks is a green square, something is yellow, nothing is white. A game
    // with its own grid passes squares instead.
    function squares(results, perMax) {
      return (results || []).map(function (r) { return r === perMax ? "🟩" : r > 0 ? "🟨" : "⬜"; }).join("");
    }
    function shareText(res) {
      var meta = res.meta;
      var head = title + " " + (meta && meta.mode === "daily" ? "No. " + meta.number + " · " + fmtTiny(meta.date) : "random puzzles");
      var line = res.max === null || res.max === undefined ? "Score " + res.score : res.score + "/" + res.max;
      var sq = res.squares !== undefined ? res.squares : squares(res.results, res.perMax === undefined ? 1 : res.perMax);
      var url = res.url || (typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? location.origin + location.pathname : "");
      return head + "\n" + line + (sq ? " " + sq : "") + (url ? "\n" + url : "");
    }
    function share(text, btn, label) {
      var done = function () {
        if (!btn) return;
        var was = btn.textContent; btn.textContent = label || "Copied";
        setTimeout(function () { btn.textContent = was; }, 1600);
      };
      if (typeof navigator !== "undefined" && navigator.share) { navigator.share({ text: text }).catch(function () {}); return Promise.resolve("shared"); }
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { done(); return "copied"; }, function () { return "failed"; });
      }
      return Promise.resolve("failed");
    }

    return {
      game: game, title: title, store: store,
      today: today, iso: iso, parseIso: parseIso, addDays: addDays, dayOfYear: dayOfYear,
      fmtShort: fmtShort, fmtTiny: fmtTiny, fmtLong: fmtLong,
      metaFor: metaFor, todayMeta: todayMeta, practiceMeta: practiceMeta,
      rng: rng, shuffle: shuffle, hash32: hash32,
      record: record, save: save, streak: streak, best: best, pastDays: pastDays,
      read: read, write: write,
      label: label, verdict: verdict, savedLine: savedLine, streakLine: streakLine,
      squares: squares, shareText: shareText, share: share,
      PAST_DAYS: PAST_DAYS
    };
  }

  var api = { create: create, hash32: hash32, rng: rng, shuffle: shuffle, iso: iso, parseIso: parseIso, dayOfYear: dayOfYear, version: "2026-10-12" };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ShozDaily = api;
})(typeof window !== "undefined" ? window : globalThis);
