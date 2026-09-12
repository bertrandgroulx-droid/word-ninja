# 🥷 Word Ninja

**Letters fly. Drag through them to build words before the clock runs out.**

Word Ninja is a static, dependency-free arcade word game built for a phone in
portrait. Tiles arc up from the bottom of the screen. You drag a finger through
them to cut them into your word, in the order you touch them, and lift to
submit. No accounts, no network calls, no build step.

```
        S                 drag ────────────╮
   B         P                             │
        E                          cut: B E S T
   T              💣               lift to submit
```

## The round

Sixty seconds. Everything else follows from that.

- **Longer words pay far more.** A word scores its letter values times its
  length, so a six-letter cut is worth several three-letter ones.
- **Long words buy time.** Five letters adds two seconds, seven adds four. A
  good run sustains itself, up to a ceiling of ninety seconds on the clock.
- **Three valid words in a row doubles your score**, and a longer streak pushes
  the multiplier to five.
- **A word that isn't a word costs three seconds** and drops the multiplier.
  Too short, or a word you already cut, simply scores nothing.
- **Bombs cost ten seconds** and void the word in your hand. Late in a run,
  that ends it.
- **Missing a letter costs nothing.** Tiles you ignore fall away. Hesitation
  costs opportunity, not points.

Two modes. **Daily** deals the same letters to everyone, keyed to your local
date, one attempt. **Practice** deals fresh letters as often as you like. Best
scores and the day's result are kept on the device; nothing leaves it.

## Run it locally

Static files, but the game uses `localStorage`, so serve it rather than opening
`index.html` off the filesystem:

```sh
npm run serve
# then visit http://localhost:8000
```

## How the letters are chosen

`words.js` is generated, and `tools/generate-words.mjs` rebuilds it:

```sh
npm run generate    # needs network; caches its downloads in .cache/
```

| Source | Used for |
|---|---|
| [TWL Scrabble dictionary](https://github.com/redbo/scrabble) | What counts as a word. Scrabble lists carry no proper nouns |
| [OpenSubtitles frequency list](https://github.com/hermitdave/FrequencyWords) | Which of those a player is likely to know |
| [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) | Profanity, filtered out |
| [First-name databases](https://github.com/smashew/NameDatabases) | Names, filtered out |

That leaves about 15,000 words of three to eight letters.

The **letter bag is measured from those words**, not from English prose. Prose
frequency over-weights the letters of common short function words, and a bag
built from it starves you of the letters that actually finish a word. Letter
values run inversely to frequency, the Scrabble intuition, but derived from this
dictionary rather than copied from the board game. Every wave of two or more
tiles is guaranteed a vowel.

## The wave schedule, and why it is precomputed

A round's waves are built up front from a seed rather than rolled frame by
frame. Two things follow. The daily run deals identical letters to everyone
whatever their frame rate or screen size, since tile positions are stored as
fractions of the arena rather than pixels. And the round can be simulated
without rendering anything, which is how the difficulty was set.

The tuning is not guesswork. A simulation walks a round second by second,
works out which tiles are airborne, and counts how many dictionary words could
be formed from them. The first version failed badly:

| | Before | After |
|---|---|---|
| Tiles on screen | 6.1 | 11.1 |
| Moments with no word available | 20% | under 1% |
| Longest word available | 3.4 letters | 6.4 letters |

A fifth of the round with nothing to cut, and almost never anything longer than
three letters, made the "long words pay" rule decorative. Denser, longer-lived
waves fixed both.

## Testing

An arcade game can't be tested by chasing flying tiles, so `tests/smoke.mjs`
works at two levels. The round model is driven directly to check scoring,
penalties, streaks, repeats, bombs, the clock cap and the one-attempt daily. Then
one real pointer drag across a tile at a known position proves the slice
geometry actually connects.

```sh
npm install
npx playwright install chromium   # once
npm test
```

It also runs in CI on every push and PR (`.github/workflows/ci.yml`).

## What has not been verified

An arcade game lives or dies on feel, and feel needs a thumb on glass. Every
number here is checked against a simulation and a headless browser, which can
tell you the game is playable in principle but not whether the tiles float too
slowly, the blade feels mushy, or sixty seconds is too long. Expect the tuning
constants at the top of `game.js` to move once someone actually plays it.

## Deploying with GitHub Pages

`.github/workflows/pages.yml` deploys the site on every push to `main`. Set
**Settings → Pages → Build and deployment → Source** to **GitHub Actions** once,
and the game is served at `https://<your-username>.github.io/word-ninja/`.

## Add to Home Screen

The app ships `apple-touch-icon` images at every iPhone and iPad size, a
`favicon.ico`, and a web manifest, so on iOS (Share → *Add to Home Screen*) it
gets a crisp icon and launches full-screen. The broad icon set is deliberate:
several apps share one github.io address, and browsers tend to cache one
bookmark icon per address, so an app declaring only an SVG can end up wearing a
neighbour's icon.
