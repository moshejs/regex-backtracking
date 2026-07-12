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

## Run it

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## How it's built

Vanilla HTML/CSS/JS, **zero dependencies**. A recursive-descent parser builds an AST; a
continuation-passing backtracking matcher walks it, ticking a global step counter and
recording a bounded trace for the animation. Verified against native `RegExp` on 110
cases.

Part of [The Lab](https://github.com/moshejs) — handmade interactive explainers.

## License

MIT
