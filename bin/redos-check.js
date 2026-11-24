#!/usr/bin/env node
/* redos-check — probe regex patterns for catastrophic backtracking using the
   step-counting engine from this repo (engine.js). Zero dependencies.
   Run `node bin/redos-check.js --help` for usage. */
"use strict";

const fs = require("node:fs");
const { check, DEFAULTS } = require("../lib/redos.js");

const HELP = `redos-check — look for catastrophic backtracking in JavaScript regex patterns

Usage:
  redos-check [options] <pattern> [<pattern> ...]
  redos-check [options] --file patterns.txt
  printf '%s\\n' '(a+)+$' | redos-check [options]

Patterns are raw regex source, as you would pass to new RegExp(...): no /slashes/
and no flags. A file or stdin holds one pattern per line; empty lines are skipped.

Options:
  -f, --file <path>      read patterns from a file, one per line
      --json             machine-readable output
      --max-steps <n>    step budget per engine run (default ${DEFAULTS.maxSteps}); a run
                         that reaches it counts as a blow-up
      --max-length <n>   longest probe input in characters (default ${DEFAULTS.maxLength}, max 2000)
      --fail-on <kind>   "polynomial" (default: quadratic or worse fails) or
                         "exponential" (only exponential growth fails)
  -h, --help             show this help
      --                 everything after this is a pattern, even if it starts with "-"

Method: for each quantifier the tool builds inputs prefix + pump×n + suffix from the
pattern's own structure, runs them through this repo's backtracking engine at growing n,
and classifies how the engine's step count grows (linear / polynomial / exponential).
It is a heuristic search: "none found" means no blow-up was found within the step
budget for the probes tried, never that the pattern is safe.

Supported syntax: literals, . , [...] classes with ranges and negation, \\d \\w \\s \\D \\W \\S,
\\n \\t \\r \\f \\v \\0, escaped punctuation, * + ? {n} {n,} {n,m} (greedy and lazy),
| alternation, (...) and (?:...) groups, ^ and $ (no flags, so no /i /m /s /u /v /y).
Anything else (backreferences, lookaround, named groups, \\b, \\x, \\u, \\p, ...) is reported as
unsupported instead of guessed at.

Exit codes:
  0  no blow-up found in any pattern
  1  a blow-up was found in at least one pattern
  2  usage error, or a pattern was invalid/unsupported (and no blow-up was found elsewhere)
`;

function usageError(msg) {
  process.stderr.write("redos-check: " + msg + "\nTry 'redos-check --help'.\n");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { json: false, files: [], patterns: [], maxSteps: DEFAULTS.maxSteps, maxLength: DEFAULTS.maxLength, failOn: DEFAULTS.failOn, help: false };
  const needValue = (i, name) => {
    if (i + 1 >= argv.length) usageError(name + " needs a value");
    return argv[i + 1];
  };
  const posInt = (v, name, lo, hi) => {
    if (!/^[0-9]+$/.test(v)) usageError(name + " must be a whole number, got " + JSON.stringify(v));
    const n = parseInt(v, 10);
    if (n < lo || n > hi) usageError(name + " must be between " + lo + " and " + hi);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (/^--[a-z-]+=/.test(a)) { inline = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    const value = (name) => { if (inline !== null) return inline; const v = needValue(i, name); i++; return v; };
    if (a === "--") { opts.patterns.push(...argv.slice(i + 1)); break; }
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-f" || a === "--file") opts.files.push(value(a));
    else if (a === "--max-steps") opts.maxSteps = posInt(value(a), a, 1000, 1e9);
    else if (a === "--max-length") opts.maxLength = posInt(value(a), a, 10, 2000);
    else if (a === "--fail-on") {
      const v = value(a);
      if (v !== "polynomial" && v !== "exponential") usageError("--fail-on must be 'polynomial' or 'exponential'");
      opts.failOn = v;
    } else if (a.startsWith("-") && a.length > 1) usageError("unknown option " + a + " (use -- before a pattern that starts with '-')");
    else opts.patterns.push(a);
  }
  return opts;
}

function linesOf(text) {
  return text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

function show(s) {
  return JSON.stringify(s);
}

function describeProbe(w) {
  const parts = [];
  if (w.prefix) parts.push(show(w.prefix));
  parts.push(show(w.pump) + " x n");
  if (w.suffix) parts.push(show(w.suffix));
  return parts.join(" + ");
}

function describePoints(points, maxSteps) {
  return points.map((p) => p.capped
    ? `length ${p.length}: hit the ${fmt(maxSteps)}-step budget`
    : `length ${p.length}: ${fmt(p.steps)} steps`).join(" | ");
}

function textReport(r) {
  const pad = "            ";
  if (r.status === "unsupported") return `UNSUPPORTED ${r.pattern}\n${pad}${r.reason}\n`;
  const w = r.worst;
  const label = { blowup: "BLOWUP      ", allowed: "ALLOWED     ", "none-found": "NONE FOUND  " }[r.status];
  let out = label + r.pattern + "\n";
  if (!w) {
    return out + `${pad}no quantifier that can repeat, so there was nothing to pump; no blow-up found.\n`;
  }
  if (r.class === "exponential") {
    out += `${pad}exponential: steps grow about ${w.perCharGrowth}x per extra character of input\n`;
  } else if (r.class === "polynomial") {
    out += `${pad}polynomial: local degree about ${w.degree}${w.degreeStillRising ? " and still rising (could be worse than polynomial)" : ` (roughly n^${Math.round(w.degree)})`}\n`;
  } else if (r.class === "super-linear") {
    out += `${pad}hit the step budget before the growth curve could be measured\n`;
  } else {
    out += `${pad}worst probe grew about linearly (local degree ${w.degree === null ? "n/a" : w.degree})\n`;
  }
  out += `${pad}probe: ${describeProbe(w)}\n`;
  out += `${pad}${describePoints(w.evidence, r.maxSteps)}\n`;
  if (r.status === "blowup" && r.class !== "exponential" && r.class !== "super-linear" && !w.evidence.some((p) => p.capped)) {
    out += `${pad}(did not reach the step budget; this is a growth-rate finding)\n`;
  }
  if (r.class === "exponential" && !w.evidence.some((p) => p.capped)) {
    const peak = w.evidence.reduce((a, b) => (b.steps > a.steps ? b : a));
    out += `${pad}(the budget was not reached: growth levelled off, peaking at ${fmt(peak.steps)} steps at length ${peak.length})\n`;
  }
  if (r.status === "allowed") {
    out += `${pad}not failing: --fail-on exponential ignores polynomial growth\n`;
  }
  if (r.status === "none-found") {
    out += `${pad}no blow-up found within ${fmt(r.maxSteps)} steps per run for these ${r.probesRun} probes (inputs up to ${r.maxLength} chars). Not a proof of safety.\n`;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); process.exit(0); }

  const patterns = [...opts.patterns];
  for (const f of opts.files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch (e) { usageError("cannot read " + f + ": " + e.code); }
    patterns.push(...linesOf(text));
  }
  if (!patterns.length && !opts.patterns.length && !opts.files.length) {
    if (process.stdin.isTTY) usageError("no patterns given");
    patterns.push(...linesOf(fs.readFileSync(0, "utf8")));
  }
  if (!patterns.length) usageError("no patterns given");

  const results = patterns.map((p) => check(p, { maxSteps: opts.maxSteps, maxLength: opts.maxLength, failOn: opts.failOn }));
  const summary = {
    patterns: results.length,
    blowup: results.filter((r) => r.status === "blowup").length,
    allowed: results.filter((r) => r.status === "allowed").length,
    noneFound: results.filter((r) => r.status === "none-found").length,
    unsupported: results.filter((r) => r.status === "unsupported").length,
  };
  const exitCode = summary.blowup ? 1 : summary.unsupported ? 2 : 0;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      tool: "redos-check",
      method: "heuristic probes run through this repo's step-counting backtracking engine; 'none-found' is not a proof of safety",
      options: { maxSteps: opts.maxSteps, maxLength: opts.maxLength, failOn: opts.failOn },
      results,
      summary,
      exitCode,
    }, null, 2) + "\n");
  } else {
    process.stdout.write(results.map(textReport).join("\n"));
    process.stdout.write(`\n${summary.patterns} pattern(s): ${summary.blowup} blow-up, ${summary.allowed ? summary.allowed + " allowed, " : ""}${summary.noneFound} none found, ${summary.unsupported} unsupported\n`);
  }
  process.exitCode = exitCode;
}

main();
