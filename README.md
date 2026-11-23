# Faster makefun-site — a fast drop-in for makefun-site 1.0.0

[![make.fun entry](https://img.shields.io/badge/make.fun-site--generator--speed--01--run--20261122-blue)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-green.svg)](https://nodejs.org/)

Entry for [make.fun — Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122):
`solve.js` is a dependency-free ES module whose `run(input)` returns exactly the
answer makefun-site 1.0.0's `build` returns for the same input — the output tree
(each page's `index.html`, the index and tag pages, `build-report.txt`, every
static file), byte for byte — but faster. `main.ts` is the house driver, kept
unchanged: it reads every case from `/input/cases.json`, answers each one alone
with `run`, and writes `/output/answers.json`.

## How it is faster

Same pipeline, same rules (makefun-site's README is the spec, its code the
reference wherever the two differ), rewritten for speed:

- **Markdown is lexed and rendered in one pass**, with no token objects.
  Inline rendering scans to the next special character and copies the plain run
  between them as-is (it holds no escapable character), instead of escaping one
  character at a time.
- **Templates are compiled to small render functions** (their node tree turned
  into code: direct scope lookups, no per-node dispatch). Generated code holds
  template text only as JSON string literals and path/name pieces only after
  the reference's own regexes validated them; if compilation ever fails, the
  run falls back to the tree-walking renderer, which renders the same nodes.
- **Templates that read only `site`, `tags` and `recent` render the same on
  every page** (the header, the nav, the filler partials that do not read the
  page): each is rendered once with the root scope and reused at every include
  site. A template whose include chain reaches a cycle is never reused, and the
  reuse only applies where the entry depth plus the template's longest include
  chain cannot reach the include depth limit.
- **Memoised per run, never across cases:** slugify results (tag names come
  from a small table, titles and headings repeat), long dates, and each post's
  card (including its word count, computed once). Every cache is created fresh
  inside `run()`; each case is answered alone.
- **Cheaper primitives:** front matter scanned with `indexOf` instead of
  splitting (and rejoining) the whole body; word counting is a single
  `charCode` pass, not a regex match that allocates an array of every word;
  HTML escaping tests first and skips the replace when nothing needs escaping.

No dependency, no I/O, no clock, no randomness: the output is a function of
the input alone, exactly as the reference's is.

## Verification

- Practice set (kit): **3/3 cases byte-identical** to
  `practice/reference/expected.json` (the kit scorer's canonical comparison).
- Three freshly drawn sets from the kit generator (different seeds, 9 cases):
  **9/9 byte-identical** to the oracle's answers.
- Timing (this machine, median CPU over 7 runs of the practice set, `main.ts`
  end to end): house baseline **1.22 s**, this entry **0.62 s**
  (~2.0× total, ~2.4× net of the do-nothing control).

## Layout

- `solve.js` — the entry: `run(input)`.
- `main.ts` — the house driver (unchanged).
- `package.json` — `{"type": "module"}`.
- `.makefun/owner.json` — the payout wallet of the account entering this repo.
- `LICENSE` — MIT.

## Bounty

- Slug: `site-generator-speed-01-run-20261122`
- Opens: 2026-11-22T20:00:00Z · Deadline: 2026-11-24T20:00:00Z (03:00 WIB 25 Nov)
- Reward: $100 (10 × $10), places by CPU time, least first; a reward needs
  beating makefun-site 1.0.0, the house baseline, at 95% confidence.
