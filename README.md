# 🥷 Word Ninja

**Letters fly. Drag through them to build words before the clock runs out.**

Word Ninja is a static, dependency-free arcade word game built for a phone in
portrait. Tiles fall from the top of the screen and leave at the bottom. You drag
a finger through them to cut them into your word, in the order you touch them,
and lift to submit. No accounts, no network calls, no build step.

```
   B      S            falling ↓
        P      💣
   E                   drag ─────────────╮
        T                                │
                       cut: B E S T, lift to submit
```

## The round

Sixty seconds. Everything else follows from that.

- **A word scores the sum of its letter values, times its length.** So length
  pays twice over, and rare letters pay too. Each tile carries its value in the
  corner:

  | Word | Letters | | Score |
  |---|---|---|---|
  | PUT | 3 + 3 + 2 = 8 | × 3 | 24 |
  | PAN | 3 + 1 + 2 = 6 | × 3 | 18 |
  | SAD | 1 + 1 + 2 = 4 | × 3 | 12 |

  Values run from 1 for `a e i r s` up to 10 for `j q x z`, derived from how
  often each letter appears in this dictionary rather than copied from Scrabble.
  The rules card in the game shows this same worked example, since "why did
  those two both-three-letter words score differently" is the question players
  actually ask.
- **Long words buy time.** Five letters adds two seconds, seven adds four. A
  good run sustains itself, up to a ceiling of ninety seconds on the clock.
- **Three valid words in a row doubles your score**, and a longer streak pushes
  the multiplier to five.
- **A word that isn't a word costs three seconds** and drops the multiplier.
  Too short, or a word you already cut, simply scores nothing.
- **Bombs cost ten seconds** and void the word in your hand. Late in a run,
  that ends it.
- **Two letters is the floor.** A single tile never scores, whatever it says, so
  every word costs you at least two cuts and a route between them.
- **Missing a letter costs nothing.** Tiles you ignore fall past. Hesitation
  costs opportunity, not points. Nor does one clipped tile: a single letter is
  never a word, so it is treated as a slip rather than a guess. Two letters is a
  real attempt, and a wrong one costs three seconds like any other.

**Slow or Fast** sets how long a tile takes to cross the screen, about ten
seconds against seven. Slow is the default, chosen by play testing. Same letters, same scoring, more or less time to think. The first build
ran at two seconds and the first person to play it called it unplayable; both
settings have come down twice since on play-test feedback, and what is called
Fast here is still very floaty by arcade standards. Deliberately so: reading a
dozen letters and planning a path through them is not a reflex.

Two modes. **Daily** deals the same letters to everyone on the same speed, keyed
to your local date, one attempt. **Practice** deals fresh letters as often as you
like. Each speed keeps its own daily run and its own best score, on the device;
nothing leaves it.

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

That leaves about 15,700 words of two to eight letters. The two-letter set keeps
the Scrabble oddities that survive the frequency filter, QI and XU among them:
the validity standard is the same dictionary at every length, and rewarding that
knowledge is part of the skill.

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

What the simulation could not tell me was pace. It counts what is *available*,
not whether a person can read it in time, and the first build was tuned for
reflex: tiles crossed the screen in about two seconds. That is fine for cutting
fruit and hopeless for a game where you must read a dozen letters, find a word
among them, and plan a path through it in order.

Two rounds of play-test feedback later, the motion itself changed. Tiles used to
arc up from the bottom under gravity. They now **fall from the top at a constant
speed**, because an arc spends its slowest, most readable moment at the apex and
its fastest at the edges, while a steady fall gives the same reading time
everywhere on screen and lets you plan a path ahead of where the tiles are now.
Predictability is worth more than drama here.

| Speed | Crossing time | Wave gap | Tiles on screen |
|---|---|---|---|
| Slow | ~9.7s | 4.6s → 3.4s | ~13 |
| Fast | ~6.8s | 3.4s → 2.4s | ~12 |

Only the pace changes; the crowd stays the same size. Each wave's tiles enter
spread across most of the gap to the next wave, rather than together: released
at once they descend as a horizontal band with dead space between bands, and
spread out they read as a steady drizzle.

## Testing

An arcade game can't be tested by chasing flying tiles, so `tests/smoke.mjs`
works at two levels. The round model is driven directly to check scoring,
penalties, streaks, repeats, bombs, the clock cap and the one-attempt daily. It
also holds a floor under hang time and checks the two speeds really differ,
since that is the tuning most likely to be broken by accident. Then one real
pointer drag across a tile at a known position proves the slice geometry
actually connects.

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
