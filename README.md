# Why is my regex slow?

An innocent-looking pattern, a twenty-character string, and suddenly your CPU is doing
millions of steps. Meet catastrophic backtracking — live.

**[▶ Live demo](https://moshejs.github.io/regex-backtracking/)**

A **hand-written backtracking regex engine**, instrumented to count every single match
attempt, advance, and backtrack. Feed it `(a+)+$` and a string of `a`s plus one stray
character and watch the step counter explode past four million. A log-scale chart plots
the exponential blow-up against a linear engine, and an animated step-through shows the
matcher advancing and backtracking cell by cell.

The engine deliberately does **not** use the browser's native `RegExp` to match, and it
hard-caps its own step count so a pathological pattern can never freeze the tab.

**Find the fix** — an interview-prep challenge mode further down the page: eight rounds, warm-up
to hard, each a pattern that backtracks catastrophically plus the input that sets it off. Rewrite
the pattern; the page's own engine (not the browser's `RegExp`) checks that it still means the same
thing (must-match / must-not-match cases) and that its step count on the attack input stays linear
(at most 40 steps per character, and doubling the input at most 2.5× the steps). Solved rounds
explain why the fix works; progress is kept in `localStorage`.

## Run it

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Test it

```bash
npm test   # node --test, zero dependencies: engine sanity + every challenge's reference fix passes and its original fails
```

## How it's built

Vanilla HTML/CSS/JS, **zero dependencies**. A recursive-descent parser builds an AST; a
continuation-passing backtracking matcher walks it, ticking a global step counter and
recording a bounded trace for the animation. The engine lives in `engine.js` (shared by the
page and the tests); `challenges.js` holds the challenge data and grader; `challenge.js` wires the
challenge UI. Verified against native `RegExp` on 110
cases.

Part of [The Lab](https://github.com/moshejs) — handmade interactive explainers.

## License

MIT
