/* lib/redos.js — a ReDoS probe built on the page's own engine (engine.js).
   Node only (CommonJS); used by bin/redos-check.js and the tests.

   Method, in one paragraph: check the pattern is a JavaScript regex the engine
   models faithfully (refuse anything else), parse it with engine.parse, then for
   every quantifier build attack inputs of the form  prefix + pump×n + suffix,
   where `prefix` reaches the quantifier, `pump` is a string the quantified part
   can match (several variants, so overlapping alternatives and nested
   quantifiers can fight over it) and `suffix` tries to make the overall match
   fail. Each probe is run through the engine's step counter at growing n, and
   the curve of steps against input length is classified. This is a heuristic
   search: finding nothing is NOT a proof of safety, only "no blow-up found
   within these probes and this step budget".

   Native RegExp is used for one thing only: `new RegExp(pattern)` as a syntax
   check, so a pattern JavaScript itself rejects is never silently guessed at.
   It never matches anything here. */
"use strict";

const Engine = require("../engine.js");

const DEFAULTS = {
  maxSteps: 1000000, // per engine run; a run that reaches it counts as a blow-up
  maxLength: 900, // the CPS matcher recurses per character; deeper inputs can overflow the JS stack
  failOn: "polynomial", // "polynomial" (degree >= POLY_DEGREE) or "exponential"
};
const POLY_DEGREE = 1.5; // local degree at or above this counts as polynomial (≈ quadratic or worse)
const EXP_RATIO = 1.5; // per-character growth that, sustained, counts as exponential
const UNIT_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const DOUBLING_SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];
const MAX_VARIANTS = 6;

/* ------------------------------------------------------------------ */
/* 1. Is this a pattern the engine models faithfully?                  */
/* ------------------------------------------------------------------ */

const ESCAPE_REASONS = {
  b: "\\b (word boundary; backspace inside a class) is not supported by the engine",
  B: "\\B (non-word boundary) is not supported by the engine",
  k: "\\k<name> (named backreference) is not supported by the engine",
  x: "\\xHH hex escapes are not supported by the engine",
  u: "\\uHHHH / \\u{...} unicode escapes are not supported by the engine",
  c: "\\cX control escapes are not supported by the engine",
  p: "\\p{...} unicode property escapes are not supported by the engine",
  P: "\\P{...} unicode property escapes are not supported by the engine",
};
const SUPPORTED_LETTER_ESCAPES = new Set(["d", "D", "w", "W", "s", "S", "n", "t", "r", "f", "v"]);

/** Returns null when the engine can model `pattern`, else a reason string. */
function unsupportedReason(pattern) {
  if (typeof pattern !== "string") return "pattern must be a string";
  try {
    new RegExp(pattern); // syntax check only — never used to match
  } catch (e) {
    return "not a valid JavaScript regex: " + e.message.replace(/^Invalid regular expression: /, "");
  }
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const e = pattern[i + 1];
      if (/[1-9]/.test(e)) return "\\" + e + " (backreference) is not supported by the engine";
      if (e === "0" && /[0-9]/.test(pattern[i + 2] || "")) return "octal escapes (\\0 followed by a digit) are not supported by the engine";
      if (ESCAPE_REASONS[e]) return ESCAPE_REASONS[e];
      if (/[A-Za-z]/.test(e) && !SUPPORTED_LETTER_ESCAPES.has(e)) return "\\" + e + " is not a supported escape";
      i++;
      continue;
    }
    if (inClass) {
      if (c === "-" && pattern[i + 1] === "\\" && /[dDwWsS]/.test(pattern[i + 2] || "") && pattern[i - 1] !== "[")
        return "a class range ending in \\" + pattern[i + 2] + " (like [a-\\d]) is not supported by the engine";
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (pattern[i + 1] === "^") i++;
      // JavaScript reads [] as "never matches" and [^] as "any character"; the engine
      // reads a leading ] as a literal, so these would be silently misread.
      if (pattern[i + 1] === "]") return "empty class [] or [^] is not supported (the engine reads a leading ] as a literal; JavaScript does not)";
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?" && pattern[i + 2] !== ":") {
      const kind = pattern[i + 2] === "=" || pattern[i + 2] === "!" ? "lookahead"
        : pattern[i + 2] === "<" && (pattern[i + 3] === "=" || pattern[i + 3] === "!") ? "lookbehind"
        : pattern[i + 2] === "<" ? "named group" : "(?...) group";
      return kind + " is not supported by the engine (only (...) and (?:...) groups are)";
    }
  }
  try {
    Engine.parse(pattern);
  } catch (e) {
    return "the engine could not parse it: " + e.message;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 2. Build probes from the AST                                         */
/* ------------------------------------------------------------------ */

function literalChars(node, out) {
  if (!node) return out;
  if (node.type === "char") out.push(node.ch);
  if (node.child) literalChars(node.child, out);
  if (node.parts) node.parts.forEach((p) => literalChars(p, out));
  if (node.branches) node.branches.forEach((b) => literalChars(b, out));
  return out;
}

function classLabelChars(pattern) {
  // characters written inside [...] in the source, so class witnesses prefer them
  const out = [];
  const re = /\[(\^?)((?:\\.|[^\]\\])*)\]/g;
  let m;
  while ((m = re.exec(pattern))) {
    if (m[1]) continue;
    for (const ch of m[2].replace(/\\./g, "")) if (ch !== "-") out.push(ch);
  }
  return out;
}

function candidateChars(ast, pattern) {
  const seen = new Set();
  const out = [];
  const add = (c) => { if (c && c.length === 1 && !seen.has(c)) { seen.add(c); out.push(c); } };
  literalChars(ast, []).forEach(add);
  classLabelChars(pattern).forEach(add);
  "aA0_ -.!@\t\n".split("").forEach(add);
  for (let code = 32; code < 127; code++) add(String.fromCharCode(code));
  return out;
}

function singleCharTest(node) {
  if (node.type === "char") return (c) => c === node.ch;
  if (node.type === "any") return (c) => c !== "\n";
  if (node.type === "class") return (c) => (node.negate ? !node.test(c) : node.test(c));
  return null;
}

function dedupe(list) {
  return [...new Set(list)];
}

/** Up to MAX_VARIANTS distinct short strings that `node` matches. */
function variants(node, chars) {
  switch (node.type) {
    case "empty": case "start": case "end": return [""];
    case "char": return [node.ch];
    case "any": case "class": {
      const t = singleCharTest(node);
      const hits = [];
      for (const c of chars) { if (t(c)) hits.push(c); if (hits.length >= 3) break; }
      return hits; // may be empty (an unsatisfiable class)
    }
    case "group": return variants(node.child, chars);
    case "alt": return dedupe(node.branches.flatMap((b) => variants(b, chars))).slice(0, MAX_VARIANTS);
    case "concat": {
      let acc = [""];
      for (const part of node.parts) {
        const vs = variants(part, chars);
        const next = [];
        for (const a of acc) for (const v of vs) next.push(a + v);
        acc = dedupe(next).slice(0, MAX_VARIANTS);
        if (!acc.length) return [];
      }
      return acc;
    }
    case "repeat": {
      const vs = variants(node.child, chars);
      const times = Math.min(Math.max(node.min, 1), 20);
      const out = node.min === 0 ? [""] : [];
      for (const v of vs) out.push(v.repeat(times));
      return dedupe(out).slice(0, MAX_VARIANTS);
    }
    default: return [];
  }
}

/** Every repeat node with its ancestor path. */
function repeats(ast) {
  const out = [];
  (function walk(node, path) {
    const here = path.concat([node]);
    if (node.type === "repeat" && node.max >= 2) out.push({ node, path: here });
    if (node.child) walk(node.child, here);
    if (node.parts) node.parts.forEach((p) => walk(p, here));
    if (node.branches) node.branches.forEach((b) => walk(b, here));
  })(ast, []);
  return out;
}

/** A string that walks from the start of the pattern up to `path`'s last node. */
function prefixFor(path, chars) {
  let prefix = "";
  for (let k = 0; k < path.length - 1; k++) {
    const parent = path[k], child = path[k + 1];
    if (parent.type === "concat") {
      for (const part of parent.parts) {
        if (part === child) break;
        const v = variants(part, chars);
        if (!v.length) return null;
        prefix += v[0];
      }
    }
  }
  return prefix;
}

function buildProbes(ast, pattern) {
  const chars = candidateChars(ast, pattern);
  const killers = [];
  const tests = [];
  (function collect(node) {
    const t = singleCharTest(node);
    if (t) tests.push(t);
    if (node.child) collect(node.child);
    if (node.parts) node.parts.forEach(collect);
    if (node.branches) node.branches.forEach(collect);
  })(ast);
  for (const c of chars) { if (!tests.some((t) => t(c))) { killers.push(c); break; } }
  const suffixes = dedupe(["", "!", "\n", ...killers]);

  const probes = [];
  const seen = new Set();
  for (const { node, path } of repeats(ast)) {
    const childVs = variants(node.child, chars).filter((v) => v.length > 0);
    if (!childVs.length) continue;
    const pumps = [...childVs];
    for (let a = 0; a < Math.min(3, childVs.length); a++)
      for (let b = 0; b < Math.min(3, childVs.length); b++)
        if (a !== b) pumps.push(childVs[a] + childVs[b]);
    const computed = prefixFor(path, chars);
    const prefixes = dedupe([computed === null ? "" : computed, ""]);
    for (const prefix of prefixes)
      for (const pump of dedupe(pumps))
        for (const suffix of suffixes) {
          const key = JSON.stringify([prefix, pump, suffix]);
          if (seen.has(key)) continue;
          seen.add(key);
          probes.push({ prefix, pump, suffix });
        }
  }
  return probes;
}

/* ------------------------------------------------------------------ */
/* 3. Run a probe and classify its curve                                */
/* ------------------------------------------------------------------ */

function runProbe(ast, probe, opts) {
  const points = [];
  let stopped = null;
  for (const n of UNIT_SIZES.concat(DOUBLING_SIZES)) {
    const input = probe.prefix + probe.pump.repeat(n) + probe.suffix;
    if (input.length > opts.maxLength) { stopped = "max-length"; break; }
    let r;
    try {
      r = Engine.makeMatcher({ stepCap: opts.maxSteps }).run(ast, input);
    } catch (e) {
      if (e instanceof RangeError) { stopped = "stack"; break; } // engine recursion limit
      throw e;
    }
    points.push({ n, length: input.length, steps: r.steps, capped: r.capped, matched: r.matched });
    if (r.capped) { stopped = "budget"; break; }
  }
  return { probe, points, stopped, verdict: classify(points) };
}

function perCharRatio(a, b) {
  return Math.pow(b.steps / a.steps, 1 / (b.length - a.length));
}

function classify(points) {
  const capped = points.find((p) => p.capped) || null;
  const live = points.filter((p) => !p.capped);

  // Exponential: >= 4 consecutive points (one pump apart) whose per-character
  // growth stays >= EXP_RATIO and does not decay (a polynomial's ratio decays
  // toward 1 as the input grows; an exponential's holds steady).
  let expWindow = null;
  for (let i = 0; i + 3 < live.length; i++) {
    const w = live.slice(i, i + 4);
    if (w[3].n - w[0].n !== 3 || w[0].length < 3) continue;
    const ratios = [perCharRatio(w[0], w[1]), perCharRatio(w[1], w[2]), perCharRatio(w[2], w[3])];
    if (ratios.every((r) => r >= EXP_RATIO) && ratios[2] >= 0.9 * ratios[0] && w[3].steps >= 500) {
      if (!expWindow || ratios[2] > expWindow.ratio) expWindow = { from: w[0], to: w[3], ratio: ratios[2] };
    }
  }

  // Local polynomial degree from the last two live points at least 1.5× apart in length.
  let degree = null, degreeFrom = null, degreeTo = null, rising = false;
  for (let j = live.length - 1; j > 0 && degree === null; j--) {
    for (let i = j - 1; i >= 0; i--) {
      if (live[j].length >= 1.5 * live[i].length && live[i].steps > 0) {
        degree = Math.log(live[j].steps / live[i].steps) / Math.log(live[j].length / live[i].length);
        degreeFrom = live[i]; degreeTo = live[j];
        // still rising? compare with the previous pair of the same spacing
        for (let k = i - 1; k >= 0; k--) {
          if (live[i].length >= 1.5 * live[k].length && live[k].steps > 0) {
            const prev = Math.log(live[i].steps / live[k].steps) / Math.log(live[i].length / live[k].length);
            rising = degree > prev + 0.25;
            break;
          }
        }
        break;
      }
    }
  }

  let cls;
  if (expWindow) cls = "exponential";
  else if (degree !== null && degree >= POLY_DEGREE) cls = "polynomial";
  else if (capped) cls = "super-linear"; // hit the budget before the shape could be measured
  else cls = "linear";
  return { class: cls, capped, expWindow, degree, degreeFrom, degreeTo, rising };
}

const RANK = { linear: 0, "super-linear": 1, polynomial: 2, exponential: 3 };
function worse(a, b) {
  const ra = RANK[a.verdict.class], rb = RANK[b.verdict.class];
  if (ra !== rb) return ra > rb;
  if (a.verdict.class === "exponential") return a.verdict.expWindow.ratio > b.verdict.expWindow.ratio;
  if (!!a.verdict.capped !== !!b.verdict.capped) return !!a.verdict.capped;
  return (a.verdict.degree || 0) > (b.verdict.degree || 0);
}

/* ------------------------------------------------------------------ */
/* 4. Public entry point                                                */
/* ------------------------------------------------------------------ */

function check(pattern, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const reason = unsupportedReason(pattern);
  if (reason) return { pattern, status: "unsupported", reason };

  const ast = Engine.parse(pattern);
  const probes = buildProbes(ast, pattern);
  let worst = null;
  let ran = 0;
  for (const probe of probes) {
    const res = runProbe(ast, probe, opts);
    ran++;
    if (!worst || worse(res, worst)) worst = res;
    if (worst.verdict.class === "exponential" && worst.verdict.capped) break; // cannot get worse
  }

  const blowup = !!worst && (
    worst.verdict.class === "exponential" ||
    (opts.failOn === "polynomial" && (worst.verdict.class === "polynomial" || worst.verdict.class === "super-linear"))
  );
  return {
    pattern,
    // "allowed": super-linear growth was found but --fail-on exponential does not fail on it
    status: blowup ? "blowup" : worst && worst.verdict.class !== "linear" ? "allowed" : "none-found",
    class: worst ? worst.verdict.class : "linear",
    probesRun: ran,
    probesBuilt: probes.length,
    maxSteps: opts.maxSteps,
    maxLength: opts.maxLength,
    worst: worst && summarize(worst),
  };
}

function summarize(res) {
  const v = res.verdict;
  return {
    prefix: res.probe.prefix,
    pump: res.probe.pump,
    suffix: res.probe.suffix,
    stopped: res.stopped,
    degree: v.degree === null ? null : Math.round(v.degree * 100) / 100,
    degreeStillRising: v.rising,
    perCharGrowth: v.expWindow ? Math.round(v.expWindow.ratio * 100) / 100 : null,
    evidence: pickEvidence(res.points, v),
    points: res.points.map(({ n, length, steps, capped }) => ({ n, length, steps, capped })),
  };
}

function pickEvidence(points, v) {
  const set = new Set();
  if (v.expWindow) {
    set.add(v.expWindow.from); set.add(v.expWindow.to);
    // the largest uncapped count too, so a curve that levels off (e.g. a bounded {12}) shows it
    const live = points.filter((p) => !p.capped);
    const peak = live.reduce((a, b) => (b.steps > a.steps ? b : a), live[0]);
    if (peak) set.add(peak);
  } else if (v.degreeFrom) { set.add(v.degreeFrom); set.add(v.degreeTo); }
  if (v.capped) set.add(v.capped);
  if (!set.size && points.length) { set.add(points[0]); set.add(points[points.length - 1]); }
  return [...set].sort((a, b) => a.length - b.length).map(({ n, length, steps, capped }) => ({ n, length, steps, capped }));
}

module.exports = { check, unsupportedReason, buildProbes, classify, DEFAULTS, POLY_DEGREE, EXP_RATIO };
