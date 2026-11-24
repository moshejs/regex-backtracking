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
npm test   # node --test, zero dependencies: engine sanity, every challenge's reference fix passes and its original fails, redos-check probes + CLI
```

## Check your own patterns from the command line

`bin/redos-check.js` runs the same engine over your patterns, from a terminal or a CI job. It
lives in this repo only: it is **not published to npm** (`package.json` is `"private": true`).
Node 18 or later, zero dependencies.

```bash
git clone https://github.com/moshejs/regex-backtracking && cd regex-backtracking

node bin/redos-check.js '(a+)+$' '^\d+$'          # patterns as arguments
node bin/redos-check.js --file patterns.txt         # one pattern per line
grep -v '^#' patterns.txt | node bin/redos-check.js # or on stdin
node bin/redos-check.js --json '(a|aa)+$'           # machine-readable
npm link && redos-check --help                      # optional: put it on your PATH locally
```

```text
BLOWUP      (a+)+$
            exponential: steps grow about 2.02x per extra character of input
            probe: "a" x n + "!"
            length 3: 60 steps | length 6: 505 steps | length 15: 262,128 steps | length 17: hit the 1,000,000-step budget

NONE FOUND  ^\d+$
            worst probe grew about linearly (local degree 1)
            probe: "01" x n + "!"
            length 385: 1,927 steps | length 769: 3,847 steps
            no blow-up found within 1,000,000 steps per run for these 36 probes (inputs up to 900 chars). Not a proof of safety.
```

| Option | Meaning |
|---|---|
| `-f, --file <path>` | read patterns from a file, one per line (empty lines skipped) |
| `--json` | JSON output: every probe point, the worst probe, a summary and the exit code |
| `--max-steps <n>` | step budget per engine run (default 1,000,000); reaching it counts as a blow-up |
| `--max-length <n>` | longest probe input (default 900 characters, at most 2000) |
| `--fail-on polynomial\|exponential` | `polynomial` (default) fails on quadratic or worse; `exponential` reports polynomial growth as `ALLOWED` and only fails on exponential |
| `--` | everything after it is a pattern, even one starting with `-` |

**Exit codes:** `0` no blow-up found · `1` a blow-up was found in at least one pattern · `2` usage
error, or a pattern was invalid or unsupported (a blow-up elsewhere takes precedence, so you still
see exit `1`).

**How it decides.** For every quantifier in the pattern it builds attack inputs
`prefix + pump×n + suffix` from the pattern's own structure: the prefix reaches the quantifier, the
pump is a string the quantified part can match (several variants, including pairs, so overlapping
alternatives and nested quantifiers fight over the same characters) and the suffix is something
that tries to make the overall match fail. Each probe runs through the engine at n = 1…14 and then
16…512, and the tool reads the curve of steps against input length:

- **exponential** — the per-character growth stays at 1.5× or more over four consecutive sizes
  without decaying;
- **polynomial** — steps grow with a local degree of 1.5 or more between the two largest sizes it
  measured (`a+b` on `aaaa…` is quadratic: the search restarts at every position);
- **linear** — neither, for every probe.

A run that hits `--max-steps` is a blow-up whatever its shape. Every finding prints the probe and
the step counts it is based on, and the counts are deterministic, so you can re-run them on the page.

**Supported syntax** (the engine's): literals, `.`, `[...]` classes with ranges and negation,
`\d \w \s \D \W \S`, `\n \t \r \f \v \0`, escaped punctuation, `* + ? {n} {n,} {n,m}` greedy and
lazy, `|`, `(...)` and `(?:...)`, `^` and `$`. Patterns are raw source as you would pass to
`new RegExp(...)`, with no flags. Anything else — backreferences, lookahead/lookbehind, named
groups, `\b`, `\x`, `\u`, `\p`, `[]`/`[^]`, flags such as `i`/`m`/`s`/`u`/`v`/`y` — is reported as
`UNSUPPORTED` (exit `2`) rather than guessed at. Native `RegExp` is used only as a syntax check
(`new RegExp(pattern)`); it never matches anything.

**Limits — read before trusting a result.**

- **"None found" is not "safe".** The probes are a heuristic search. A blow-up that needs an input
  shape the generator doesn't build (for example two different pumps interleaved, or a prefix other
  than the shortest one) will be missed. Treat exit `0` as "no blow-up found within N steps for these
  probes", which is all it claims.
- **False positives versus your real engine.** This engine has none of the optimisations production
  engines use (V8's Irregexp, PCRE, Java, .NET each have different ones), and it searches every
  start position. It can report growth, especially quadratic growth on unanchored patterns, that a
  particular engine optimises away. `--fail-on exponential` keeps only the exponential findings.
- **False negatives versus your real engine.** The reverse holds too: a real engine with different
  semantics or extra features can blow up where this one doesn't, and anything outside the supported
  syntax is refused, not checked.
- **Labels are approximate.** A high-degree polynomial over short inputs (`^(.*,){4}ok$`) can be
  labelled exponential, and a bounded repeat such as `(.*a){12}` is exponential only until the
  count is reached; the evidence line shows where the curve levels off.
- `.` matches any character except `\n` in this engine (JavaScript also excludes `\r`, U+2028 and
  U+2029). Inputs are capped at 2000 characters because the matcher is recursive.
- **No `--scan` of source files.** Pulling regex literals out of JS/TS reliably needs a real parser
  (`/` is also division, regexes hide in template strings and `new RegExp(...)` calls), so it is left
  out rather than done badly. Collect your patterns into a file and use `--file`.

Cross-check: every original pattern in the "Find the fix" challenge set is flagged and every
reference fix is not (`test/redos.test.js`).

## How it's built

Vanilla HTML/CSS/JS, **zero dependencies**. A recursive-descent parser builds an AST; a
continuation-passing backtracking matcher walks it, ticking a global step counter and
recording a bounded trace for the animation. The engine lives in `engine.js` (shared by the
page and the tests); `challenges.js` holds the challenge data and grader; `challenge.js` wires the
challenge UI; `lib/redos.js` and `bin/redos-check.js` are the command-line checker (node only, not
loaded by the page). Verified against native `RegExp` on 110
cases.

Part of [The Lab](https://github.com/moshejs) — handmade interactive explainers.

## License

MIT
