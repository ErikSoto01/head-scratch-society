# Head Scratch Society: the site

The public clubhouse for the **Head Scratch Society** Page (`@headscratchsociety`). Followers come here to play and share.
Tagline: *Puzzles worth arguing about.*

It is a static site with no dependencies, no build step and no external requests: one `index.html` (CSS and JS inline), a `404.html`, and an `assets/` folder. Every URL is relative, so it works from a sub-path such as `https://name.github.io/head-scratch-society/`.

**Status: built and committed locally. Not published.** No GitHub repo, remote or deployment exists yet.

## What is on the page

| Section | What it does |
| --- | --- |
| Hero | Mark, wordmark, tagline, a button down to today's puzzle. |
| Today's scratcher | One puzzle per calendar day, the same for everyone on the same date. Type or pick an answer, or peek. Then the answer, the why and "the trap". Yesterday's answer sits underneath. A streak counts days played in a row. |
| Play | Five mini-games: **Stop at 10.00**, **Say the colour**, **Gone in five** (memory), **Odd one out**, **Dead centre** (a line-bisection illusion). Mouse, touch and keyboard. Personal bests are kept in this browser. |
| The wall | The whole puzzle pool, with tap-to-reveal answers and a filter by type. Today's puzzle stays locked there until it has been played. |
| House rules | What the Society is, the fairness promise, where the arguing happens. |
| Footer | A plain privacy note and a "Forget my scores" button. |

Sharing uses the Web Share API, with copy-to-clipboard as the fallback. The shared text is a short brag with no spoilers and no tracking parameters.

## Run it

```sh
python3 -m http.server 4180 --bind 127.0.0.1    # then open http://127.0.0.1:4180/
```

In this workspace the same server is the `head-scratch-site` entry in `../.claude/launch.json`.
The fonts need a server; opening `index.html` straight from disk falls back to system fonts.

## Things you will want to edit

All of these are in `index.html`.

### Follow links and the site address

Near the top of the script:

```js
const SITE = {
  facebook: "",   // e.g. "https://www.facebook.com/headscratchsociety"
  instagram: "",  // e.g. "https://www.instagram.com/headscratchsociety"
  url: ""         // public address of this site, used in shared text
};
```

- **While a value is empty, that link is hidden completely.** With both empty, the whole "The meeting is open" block is hidden, and "our Facebook Page" in the house rules is plain text. Fill in `facebook` and both appear. Links must start with `https://`.
- `url` is the address added to shared brags. Empty means "whatever address the visitor is on".

### Before launch: tell the site its address

Link previews (Facebook, Messenger, WhatsApp and friends) need **absolute** URLs for the preview image. Once the address is known, run:

```sh
npm run set-url -- https://name.github.io/head-scratch-society/
```

That writes `SITE.url`, `og:url`, `og:image`, `twitter:image` and a canonical link into `index.html`. `npm run set-url -- --reset` undoes it. It changes one file and uploads nothing.

### The puzzle pool

The pool is the JSON block `<script type="application/json" id="puzzle-pool">` in `index.html`. There are 49 puzzles: 8 number traps, 8 story problems, 6 sequences, 7 riddles, 7 word puzzles, 8 logic puzzles and 5 debates.

- Puzzle No. 01 runs on the `EPOCH` date in the script (1 October 2026). After that it is one a day, in pool order, and the pool repeats when it runs out. Adding puzzles to the **end** keeps the calendar stable until the current cycle finishes; inserting in the middle shifts every later day.
- `kind` decides how people answer: `num` (type a number), `text` (type a word, matched against `accept`), `choice` (pick one of `options`), `self` (think, reveal, then say whether you got it) and `debate` (pick a side; every side's case is shown and no answer is declared).
- **After any change run `npm run verify`.** `tools/verify-puzzles.mjs` recomputes or brute-forces every answer a machine can check and fails loudly on a mismatch. A new number, story, sequence or logic puzzle must get a solver there. Riddles that only a person can judge go in its `BY_HAND` list with the reason they have a single answer.

House rules for the words: original wording only, family-friendly, no invented numbers of any kind ("most people fail this"), and no asking for a specific comment, a tag or a share. Debates end on a real question.

## Checks

Development only. The live site needs none of this.

```sh
npm install          # puppeteer-core, which drives the Google Chrome already on this Mac
npm run verify       # puzzle answers
npm test             # verify + end-to-end checks in headless Chrome against a throwaway local server
npm run screens      # full-page screenshots into screens/ (gitignored)
npm run assets       # re-render assets/og.png and the PNG icons from tools/og.html
```

`npm test` covers: a clean load (no console errors, no failed requests), no external network requests, the daily puzzle being deterministic for a date, every puzzle accepting its own answer, each game played to a result by keyboard, share and its fallbacks, the theme toggle, no sideways scrolling at 320 / 390 / 768 / 1440 px in both themes, text contrast against WCAG AA in both themes, focus rings, 44 px touch targets, reduced motion, the privacy claims in the footer, and the copy rules above.

Chrome is expected at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Set `CHROME_PATH` to use another.

**Test date.** On a local development host only (`localhost`, `127.0.0.1`, `*.localhost`, `*.test`) the page honours `?date=YYYY-MM-DD`, for example `http://127.0.0.1:4180/?date=2026-10-05`. Everywhere else the parameter is ignored and the visitor's own calendar date is used.

## Files

```
index.html            the site: styles, puzzle pool and script, all inline
404.html              "Now that is a head scratcher."
assets/mark.svg       the mark (also the vector favicon)
assets/og.png         1200x630 social card      (npm run assets)
assets/favicon-32.png, assets/apple-touch-icon.png
assets/fonts/         Fraunces and Bricolage Grotesque (woff2) with their licences
tools/                verify-puzzles, render-assets (+ og.html), screens, set-url, static-server
tests/site.test.mjs   end-to-end checks
```

## Brand, fonts and licences

Colours, type and voice follow the Head Scratch Society brand kit (`reel-lab/brand/` in this workspace). The site carries its own copies of what it needs:

- **Fraunces** (headlines) and **Bricolage Grotesque** (everything else), both under the SIL Open Font License 1.1. The licence texts ship next to the font files: `assets/fonts/OFL-Fraunces.txt` and `assets/fonts/OFL-Bricolage-Grotesque.txt`.
- The mark, `assets/mark.svg`.

## Privacy

The footer makes four claims, and the tests hold the site to them: no accounts, no cookies, no tracking, and scores, streak and theme are saved only in this browser (`localStorage` keys `hss:v1` and `hss:theme`). Sound is synthesised in the browser and is off until someone switches it on.

## Publishing later

Any static host works. For GitHub Pages: publish the folder as it is, then run `set-url` with the final address and publish again. `404.html` works out the site root for `name.github.io/repo/` project sites and for sites at the root of a domain. A site served from a sub-folder of a custom domain would need its `<base>` set by hand in that file.
