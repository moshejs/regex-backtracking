/* challenges.js — the "find the fix" interview-prep series: challenge data plus
   the grader. Pure functions, no DOM. Every step count comes from engine.js
   (never the browser's RegExp), so a verdict is the same on every machine.
   Exposes window.RegexChallenges in the browser and module.exports under node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"));
  else root.RegexChallenges = factory(root.RegexEngine);
})(typeof self !== "undefined" ? self : this, function (Engine) {
  "use strict";

  /* ---- the pass rule (one rule for every challenge) ----
     1. meaning: every must-match case matches and every must-not-match case doesn't;
     2. speed: on the attack input the engine takes at most STEPS_PER_CHAR steps per
        input character, AND
     3. shape: doubling the attack input at most GROWTH_LIMIT-times the steps
        (linear-ish — a quadratic fix that squeaks under the budget still fails). */
  const STEPS_PER_CHAR = 40;
  const GROWTH_LIMIT = 2.5;
  const CAP = 1000000; // challenge runs stop here; originals all reach it

  /* Original patterns and inputs, written for this page. `attack(n)` builds the
     input that makes the original blow up; `n` is the length the page shows. */
  const CHALLENGES = [
    {
      id: "digits",
      level: "Warm-up",
      title: "Digits only",
      brief: "A sign-up form checks that a PIN is all digits. A bot submits a long PIN that ends in a letter, and the request times out.",
      original: "^(\\d+)+$",
      solution: "^\\d+$",
      attack: (n) => "1".repeat(n) + "!",
      attackLabel: (n) => `"1" × ${n} + "!"`,
      n: 24,
      mustMatch: ["7", "0451", "1234567890"],
      mustNotMatch: ["", "12a4", " 123", "123!"],
      hint: "Count the quantifiers that are allowed to consume the same digits. You only need one.",
      explain: "<code>(\\d+)+</code> is a quantifier inside a quantifier over the same characters: n digits can be cut into groups in 2<sup>n−1</sup> ways, and when the final <code>$</code> fails the engine tries every one. One <code>+</code> says the same thing. Interviewers want you to name the smell (“nested quantifiers over overlapping input”) before you touch the keyboard.",
    },
    {
      id: "either",
      level: "Warm-up",
      title: "Two doors to the same room",
      brief: "A username check accepts letters, digits and underscores — written as “a digit, or a word character”, repeated.",
      original: "^(\\d|\\w)+$",
      solution: "^\\w+$",
      attack: (n) => "0".repeat(n) + "!",
      attackLabel: (n) => `"0" × ${n} + "!"`,
      n: 24,
      mustMatch: ["moshe_42", "0", "A_b_C"],
      mustNotMatch: ["", "two words", "dash-ed", "tab\there"],
      hint: "Is there any character that <code>\\d</code> matches and <code>\\w</code> doesn't?",
      explain: "<code>\\d</code> is a subset of <code>\\w</code>, so every digit can be taken by either branch. On failure the engine tries both doors for every digit: 2<sup>n</sup> paths. Alternation branches under a quantifier must be mutually exclusive — here the first branch is redundant, so delete it.",
    },
    {
      id: "trailing",
      level: "Easy",
      title: "Trailing whitespace",
      brief: "A linter flags lines that end in whitespace. Someone pastes a line made of thousands of spaces with one character at the end.",
      original: "\\s+$",
      solution: "\\s$",
      attack: (n) => " ".repeat(n) + "x",
      attackLabel: (n) => `" " × ${n.toLocaleString("en-US")} + "x"`,
      n: 1500,
      mustMatch: ["done ", "tab\t", "   ", "a  "],
      mustNotMatch: ["", "done", "  indented", "a b"],
      hint: "The pattern isn't anchored at the start, so the engine retries it from every position. How many whitespace characters do you actually need to see?",
      explain: "This one is quadratic, not exponential: from each of the n starting positions, <code>\\s+</code> eats the rest of the run, <code>$</code> fails, and it gives the characters back one by one — about n²/2 steps. To know a line ends in whitespace you only need the last character, so <code>\\s$</code> does constant work per position. Watch for <em>unanchored</em> patterns whose expensive part is at the end: the outer retry loop multiplies whatever the pattern costs.",
    },
    {
      id: "words",
      level: "Medium",
      title: "Words with optional spaces",
      brief: "A search box accepts words separated by single spaces (a trailing space is fine). The pattern is “a word, maybe a space”, repeated.",
      original: "^(\\w+\\s?)*$",
      solution: "^(\\w+(\\s\\w+)*\\s?)?$",
      attack: (n) => "a".repeat(n) + "!",
      attackLabel: (n) => `"a" × ${n} + "!"`,
      n: 24,
      mustMatch: ["", "hello", "hello world", "one two three ", "a b c"],
      mustNotMatch: [" leading", "two  spaces", "hello!", "a b!"],
      hint: "Because the space is optional, two adjacent words with no space between them look exactly like one word. Make the separator mandatory between repetitions.",
      explain: "<code>\\s?</code> makes the separator optional, so <code>(\\w+\\s?)*</code> can split <code>aaaa</code> into one word, two, three or four — the same blow-up as <code>(a+)+</code>, just better disguised. The fix makes each repetition start with a required separator: <code>\\w+(\\s\\w+)*</code>. Now there is exactly one way to read any input. Optional pieces inside a repeat are the most common real-world source of ReDoS.",
    },
    {
      id: "equals",
      level: "Medium",
      title: "Does it contain an equals sign?",
      brief: "A firewall rule looks for an <code>=</code> anywhere in a request field, written as <code>.*.*=.*</code>. A request arrives with a long run of characters and no <code>=</code>.",
      original: ".*.*=.*",
      solution: "=",
      attack: (n) => "x".repeat(n),
      attackLabel: (n) => `"x" × ${n}`,
      n: 200,
      mustMatch: ["a=b", "=", "key = value", "x=", "line one\nb=c"],
      mustNotMatch: ["", "abc", "a", "no equals here"],
      hint: "This is a search, not a full-line match. If the engine may start anywhere, what do the <code>.*</code> around the <code>=</code> contribute?",
      explain: "Two adjacent <code>.*</code> can share the same characters in n ways, the engine retries from every starting position, and the last <code>.*</code> adds nothing — roughly cubic work for a yes/no question. In an unanchored search, leading and trailing <code>.*</code> don't change what matches, so <code>=</code> alone is the same test. This shape is the one Cloudflare's public post-mortem of its 2 July 2019 outage singles out (<code>.*(?:.*=.*)</code>, simplified there to <code>.*.*=.*</code>).",
      source: { label: "Cloudflare, “Details of the Cloudflare outage on July 2, 2019”", url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/" },
    },
    {
      id: "email",
      level: "Medium",
      title: "Email local part",
      brief: "An email field allows dots and underscores in the name part, never two in a row. Someone pastes a long name and forgets the <code>@</code>.",
      original: "^([a-z0-9]+[._]?)+@[a-z]+\\.[a-z]+$",
      solution: "^[a-z0-9]+([._][a-z0-9]+)*[._]?@[a-z]+\\.[a-z]+$",
      attack: (n) => "a".repeat(n),
      attackLabel: (n) => `"a" × ${n} (no @)`,
      n: 24,
      mustMatch: ["moshe@example.com", "first.last@example.org", "a_b.c@x.io", "trailing.@x.io"],
      mustNotMatch: ["@example.com", ".lead@x.io", "two..dots@x.io", "no-at-sign.com", "a@b"],
      hint: "Same disease as the search box: the separator is optional inside the repeat. Pull the first name chunk out, then repeat “separator, then chunk”.",
      explain: "The <code>[._]?</code> is optional, so <code>([a-z0-9]+[._]?)+</code> can split a plain run of letters any number of ways, and a missing <code>@</code> forces the engine through all of them. Unrolling it as <code>chunk(sep chunk)*</code> keeps the same rules — no leading separator, no doubles, an optional trailing one — with exactly one parse. Validating emails with one regex is itself a trap; in an interview, say so, then fix the pattern you were given.",
    },
    {
      id: "quoted",
      level: "Hard",
      title: "Quoted string with escapes",
      brief: "A config parser accepts a double-quoted value where a backslash escapes the next character. A value full of backslashes arrives without its closing quote.",
      original: '^"(\\\\.|[^"])*"$',
      solution: '^"(\\\\.|[^"\\\\])*"$',
      attack: (n) => '"' + "\\\\".repeat(n),
      attackLabel: (n) => `'"' + "\\\\" × ${n} (no closing quote)`,
      n: 24,
      mustMatch: ['""', '"plain"', '"say \\"hi\\""', '"a\\\\b"', '"tab\\t"'],
      mustNotMatch: ['"open', 'closed"', '"a"b"', "plain"],
      hint: "A backslash can be read as the start of an escape or as an ordinary character. Make sure it can only be read one way.",
      explain: "<code>[^\"]</code> also matches a backslash, so every <code>\\\\</code> pair can be one escape or two plain characters — 2<sup>n</sup> readings when the closing quote is missing. Excluding the backslash from the plain branch (<code>[^\"\\\\]</code>) makes the branches disjoint. Strictly, this also stops accepting a lone trailing backslash such as <code>\"\\\"</code>, which the original allowed by accident; in a real tokenizer that is the behaviour you want, and it is worth saying out loud.",
    },
    {
      id: "fields",
      level: "Hard",
      title: "Fifth field says ok",
      brief: "A log filter keeps comma-separated lines whose fifth field is <code>ok</code>, written as four “anything then a comma” chunks. A line of commas arrives that doesn't end in <code>ok</code>.",
      original: "^(.*,){4}ok$",
      solution: "^([^,\\n]*,){3}.*,ok$",
      attack: (n) => ",".repeat(n) + "no",
      attackLabel: (n) => `"," × ${n} + "no"`,
      n: 60,
      mustMatch: ["a,b,c,d,ok", ",,,,ok", "a,b,c,d,e,f,ok", "1,2,3,x y,ok"],
      mustNotMatch: ["a,b,c,ok", "a,b,c,d,no", "a,b,c,d,ok,", "a,b\n,c,d,ok"],
      hint: "<code>.*</code> can swallow commas, so the four chunks can be placed in very many ways. Pin down the first three fields so they can't contain a comma, and let only one greedy <code>.*</code> float.",
      explain: "Each <code>.*,</code> can stop at any comma, so with many commas the engine tries every way to choose four of them — about n⁴ placements when the line fails. Because <code>.*</code> can contain commas, the original really means “at least four commas, then <code>ok</code> at the end”. Saying that with fields that cannot contain commas, plus a single greedy <code>.*</code> that backs off once, preserves the meaning in linear time. The general lesson: never chain several <code>.*</code> that can each end on the same delimiter.",
    },
  ];

  const run = (ast, input) => Engine.makeMatcher({ stepCap: CAP }).run(ast, input);

  /* steps the original pattern takes on the attack input (for "before") */
  function measure(pattern, input) {
    const r = run(Engine.parse(pattern), input);
    return { steps: r.steps, capped: r.capped };
  }

  /* grade(challenge, pattern) -> full verdict. Never throws. */
  function grade(ch, pattern) {
    const out = { pass: false, parseError: null, cases: [], meaningOk: false,
      attackLength: 0, steps: 0, capped: false, budget: 0, steps2: null, growth: null,
      speedOk: false, shapeOk: false };
    let ast;
    try { ast = Engine.parse(pattern); } catch (e) { out.parseError = e.message || "invalid pattern"; return out; }

    for (const input of ch.mustMatch) {
      const r = run(ast, input);
      out.cases.push({ input, want: true, got: r.matched, capped: r.capped, ok: !r.capped && r.matched });
    }
    for (const input of ch.mustNotMatch) {
      const r = run(ast, input);
      out.cases.push({ input, want: false, got: r.matched, capped: r.capped, ok: !r.capped && !r.matched });
    }
    out.meaningOk = out.cases.every((c) => c.ok);

    const a1 = ch.attack(ch.n);
    const r1 = run(ast, a1);
    out.attackLength = a1.length;
    out.steps = r1.steps;
    out.capped = r1.capped;
    out.budget = STEPS_PER_CHAR * a1.length;
    out.speedOk = !r1.capped && r1.steps <= out.budget;
    if (out.speedOk) {
      const r2 = run(ast, ch.attack(ch.n * 2));
      out.steps2 = r2.capped ? CAP : r2.steps;
      out.growth = out.steps2 / Math.max(1, r1.steps);
      out.shapeOk = !r2.capped && out.growth <= GROWTH_LIMIT;
    }
    out.pass = out.meaningOk && out.speedOk && out.shapeOk;
    return out;
  }

  return { CHALLENGES, grade, measure, STEPS_PER_CHAR, GROWTH_LIMIT, CAP };
});
