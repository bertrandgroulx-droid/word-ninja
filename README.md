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
| [TWL Scrabble dictionary](https://github.com/redbo/scrabble) | What the game **accepts**. Scrabble lists carry no proper nouns |
| [OpenSubtitles frequency list](https://github.com/hermitdave/FrequencyWords) | Which of those are **common**, which is a different job — see below |
| [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) | Profanity, filtered out |

Two lists come out of that, and keeping them apart is the whole design.

**Accepted: 83,488 words**, every Scrabble word of two to eight letters. If a
board would take it, this takes it. That is a recent change: the game used to
accept only the 16,400 common ones, and a player asked whether `DEET` counted.
It is in the Scrabble dictionary, so it does now, along with `QOPH`, `ZARF` and
80,000 others.

**Common: 16,398 words**, the frequency-gated subset. This never reaches the
player as a rule. It is what the letter bag and the letter values are measured
from, so the tiles that fall are the ones that finish words people know.

Widening what is *accepted* is pure upside: more of what you try works, and
nothing you already knew stops working. Widening what is *dealt* is not — a bag
measured over the whole Scrabble dictionary weights letters toward words nobody
is going to spot mid-drag. So the bag and the points are byte-identical to what
they were, which also means the daily runs deal exactly the letters they did
before.

One consequence worth naming: the hundred two-letter Scrabble words are all live
now, and several are expensive. `ZA` is 22 points for two tiles. Knowing that
list is real Scrabble skill and the game pays for it, which is the same bargain
`QI` and `XU` were already making.

The whole list would be 649 KB of text, so it ships **front-coded** — each word
stored as a digit for how many leading letters it shares with the word before,
then the rest of it. That is 243 KB, about 103 KB gzipped. The digit sorts below
`a` and every letter above it, which is all the decoder needs to find a
boundary.

Unpacking it into a `Set` costs about a tenth of a second on a throttled phone.
That used to land *inside the first paint*, because the init script runs before
the browser draws anything, and it showed:

| | Median first contentful paint, 4× CPU throttle |
|---|---|
| Unpacked during init | 372 ms |
| Warmed after the first frame | **164 ms** |

Nothing needs the dictionary until a word is submitted, and the start card
stands between loading and the first cut, so the warm-up is scheduled just after
the first frame. The lookup still builds on demand, so a submit that somehow
beats the warm-up is correct rather than fast.

There is deliberately **no first-names filter**. An early version had one and it
threw away 813 ordinary words, `WILL` `BILL` `ROSE` `GRACE` `HOPE` `ART` `DAWN`
`MAY` `JACK` `CHASE` among them, because thousands of English words are also
somebody's name. A player reported `WILL` being refused and they were right.
The filter was redundant as well as harmful: a Scrabble dictionary contains no
proper nouns, so `HELEN`, `SANTA` and `MOORE` are already absent while `WILL`
and `ROSE` are correctly present. The dictionary is the authority, and the test
now pins both directions. The two-letter set keeps
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

## The rules card

The in-game rules open with a worked example rather than a wall of bullets, and
it plays rather than poses. Letters fall through a small frame, a blade draws
itself through three of them in numbered order, the word builds letter by letter
below, and the score lands — steering around a bomb and ignoring a high-value Z
on the way, because a single letter is not a word. The caption does the
arithmetic. It is inline SVG driven by CSS, so it scales with the card, stays in
the palette, and ships no image and no library.

A still picture can show the end of a cut but not the thing players actually
need to judge: how fast the letters come, and that you have time to plan a path
through them. That is the question every play test raised, so the diagram now
answers it by demonstration.

One eight-second loop drives every part, which is what keeps them in step: the
tiles fall the whole time, and the blade is drawn over the six tenths of a
second they take to cross the line it was drawn for. Two more tiles run the same
loop on a different phase, so the frame is never empty between cuts — the same
reason the real waves are spread rather than released together.

Every animation *ends* on the state the old static drawing held, so
`prefers-reduced-motion` switches them all off and leaves that drawing intact
rather than a blank box. The off-phase tiles hide themselves there too: standing
still they only crowd the tiles being cut.

The test drives the loop by hand rather than watching it: no blade before the
cut, a blade drawn through with three numbered badges, the word and the score at
the cut, and — sampled right around the loop — never a frame with no letters in
it. That last one is a real bug it caught, a one-second empty seam that reads as
a diagram which failed to load.

Below the bullets, scoring gets its own section, because "why did those two
three-letter words score differently" is the question players actually ask, and
one dense sentence in a list of ten was not answering it.

The results card then shows the same arithmetic for every word of the run, so
the answer is there whether or not anyone opened the rules. Each factor gets its
own column, headed once at the top:

```
WORD                        TILES  LEN  RUN  SCORE

JAZZ  [J10][A1][Z10][Z10]      31   ×4    –    124
GORE  [G3][O2][R1][E1]          7   ×4   ×2     56
BAY   [B3][A1][Y4]              8   ×3    –     24
```

The first version wrote the arithmetic inline after the tiles, `7 × 4 × 2`, and
a player reported it was still not landing: a three-letter word above a
four-letter word with a bigger number beside it reads as a fault. Two things
were wrong. The numbers followed tile groups of different widths, so nothing
lined up between rows and there was no column to compare down. And most rows
showed two factors while the caption named three, so the `× 2` that explained
the upset looked like a typo on the one row that had it.

Fixed columns solve the first. For the second, a word cut on a streak wears the
same amber pill the multiplier wears on the score bar, and its whole row is
tinted to match, so BAY out-scoring GORE reads as a bonus before you have read
a single digit. Rows without a streak get a dash rather than a blank, so the
column never looks like missing information.

The test checks each entry shows its own letters, that the values on them are
the real ones, that the Tiles column is those values added up, that Len is the
word's length, that Run is a dash or a multiplier and the row is tinted when
and only when it is a multiplier, and that the three multiply out to the stated
total and sum to the score.

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

The mark is a hooded ninja on the game's accent red, with the blade's cyan trail
cutting corner to corner behind the head. Four shapes and no detail on purpose:
at 60px on a home screen only the band and the two eyes actually read, so
nothing else competes with them. `tools/make-icons.mjs` draws it, writing the
PNGs and the `.ico` byte by byte rather than pulling in an image library, and
takes `ICON_SIZES` and `ICON_OUT` from the environment so a proof at any size
costs one command:

```sh
ICON_SIZES=60 ICON_OUT=/tmp/ node tools/make-icons.mjs
```

The app ships `apple-touch-icon` images at every iPhone and iPad size, a
`favicon.ico`, and a web manifest, so on iOS (Share → *Add to Home Screen*) it
gets a crisp icon and launches full-screen. The broad icon set is deliberate:
several apps share one github.io address, and browsers tend to cache one
bookmark icon per address, so an app declaring only an SVG can end up wearing a
neighbour's icon.
