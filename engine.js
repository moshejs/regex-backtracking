/* engine.js — a from-scratch backtracking regex engine, instrumented to count
   every step. Shared by the interactive (regex.js), the challenge mode
   (challenge.js) and the node tests (test/). No native RegExp is used to match.
   Exposes window.RegexEngine in the browser and module.exports under node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RegexEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* =====================================================================
     PART 1 — THE ENGINE
     parse(pattern) -> AST, then a CPS backtracking matcher that ticks a
     global step counter on every attempt/advance/backtrack.
     Supported: literals, . , [..] classes (ranges + negation), quantifiers
     * + ? {n} {n,} {n,m} (greedy + lazy), alternation |, grouping (...),
     anchors ^ $, and escapes \d \w \s \D \W \S plus \. \* etc.
     ===================================================================== */

  const STEP_CAP = 5000000; // hard ceiling — the browser never hangs

  /* ---- Parser: recursive descent, each node carries its source position ---- */
  function parse(pattern) {
    let i = 0;
    const src = pattern;
    const peek = () => src[i];
    const nextc = () => src[i++];
    const eof = () => i >= src.length;

    function parseAlternation() {
      const branches = [parseConcat()];
      while (peek() === "|") { nextc(); branches.push(parseConcat()); }
      return branches.length === 1 ? branches[0] : { type: "alt", branches, pos: branches[0].pos };
    }

    function parseConcat() {
      const parts = [];
      while (!eof() && peek() !== "|" && peek() !== ")") parts.push(parseQuantified());
      if (parts.length === 1) return parts[0];
      if (parts.length === 0) return { type: "empty", pos: i };
      return { type: "concat", parts, pos: parts[0].pos };
    }

    function parseQuantified() {
      const atomPos = i;
      const atom = parseAtom();
      const q = peek();
      if (q === "*" || q === "+" || q === "?") {
        nextc();
        let min = 0, max = Infinity;
        if (q === "+") min = 1; else if (q === "?") max = 1;
        const greedy = peek() !== "?";
        if (!greedy) nextc();
        return { type: "repeat", min, max, greedy, child: atom, pos: atomPos };
      }
      if (q === "{") {
        const save = i;
        nextc();
        let a = "";
        while (/[0-9]/.test(peek() || "")) a += nextc();
        if (a === "") { i = save; return atom; }
        let min = parseInt(a, 10), max = min;
        if (peek() === ",") {
          nextc();
          let b = "";
          while (/[0-9]/.test(peek() || "")) b += nextc();
          max = b === "" ? Infinity : parseInt(b, 10);
        }
        if (peek() !== "}") { i = save; return atom; }
        nextc();
        const greedy = peek() !== "?";
        if (!greedy) nextc();
        return { type: "repeat", min, max, greedy, child: atom, pos: atomPos };
      }
      return atom;
    }

    function parseAtom() {
      const pos = i;
      const ch = peek();
      if (ch === "(") {
        nextc();
        if (peek() === "?" && src[i + 1] === ":") { nextc(); nextc(); } // (?: non-capturing
        const inner = parseAlternation();
        if (peek() !== ")") throw new Error("unbalanced '(' — missing ')'");
        nextc();
        return { type: "group", child: inner, pos };
      }
      if (ch === "[") return parseClass();
      if (ch === ".") { nextc(); return { type: "any", pos }; }
      if (ch === "^") { nextc(); return { type: "start", pos }; }
      if (ch === "$") { nextc(); return { type: "end", pos }; }
      if (ch === "\\") return parseEscape(false);
      if (ch === ")" || ch === "|" || ch === undefined) throw new Error("unexpected token");
      if (ch === "*" || ch === "+" || ch === "?") throw new Error("nothing to repeat before '" + ch + "'");
      nextc();
      return { type: "char", ch, pos };
    }

    const SHORT = {
      d: (c) => c >= "0" && c <= "9",
      D: (c) => !(c >= "0" && c <= "9"),
      w: (c) => /[A-Za-z0-9_]/.test(c),
      W: (c) => !/[A-Za-z0-9_]/.test(c),
      s: (c) => /\s/.test(c),
      S: (c) => !/\s/.test(c),
    };
    const CTRL = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", "0": "\0" };

    function parseEscape(inClass) {
      const pos = i;
      nextc(); // backslash
      const e = nextc();
      if (e === undefined) throw new Error("dangling backslash");
      if (SHORT[e]) {
        if (inClass) return { kind: "pred", test: SHORT[e] };
        return { type: "class", negate: false, test: SHORT[e], pos, label: "\\" + e };
      }
      const lit = CTRL[e] !== undefined ? CTRL[e] : e;
      if (inClass) return { kind: "char", ch: lit };
      return { type: "char", ch: lit, pos };
    }

    function parseClass() {
      const pos = i;
      nextc(); // [
      let negate = false;
      if (peek() === "^") { negate = true; nextc(); }
      const items = [];
      if (peek() === "]") items.push({ kind: "char", ch: nextc() }); // leading ] is literal
      while (!eof() && peek() !== "]") {
        let it = peek() === "\\" ? parseEscape(true) : { kind: "char", ch: nextc() };
        if (it.kind === "char" && peek() === "-" && src[i + 1] !== "]" && src[i + 1] !== undefined) {
          nextc(); // -
          const hi = peek() === "\\" ? parseEscape(true).ch : nextc();
          items.push({ kind: "range", lo: it.ch, hi });
        } else items.push(it);
      }
      if (peek() !== "]") throw new Error("unterminated '['");
      nextc(); // ]
      const test = (c) => {
        for (const it of items) {
          if (it.kind === "char" && c === it.ch) return true;
          if (it.kind === "range" && c >= it.lo && c <= it.hi) return true;
          if (it.kind === "pred" && it.test(c)) return true;
        }
        return false;
      };
      return { type: "class", negate, test, pos, label: src.slice(pos, i) };
    }

    const ast = parseAlternation();
    if (!eof()) throw new Error("unexpected '" + peek() + "'");
    return ast;
  }

  /* ---- Matcher: continuation-passing backtracking with a step counter ---- */
  function makeMatcher(opts) {
    opts = opts || {};
    const stepCap = opts.stepCap || STEP_CAP;
    const recordTrace = !!opts.recordTrace;
    const traceCap = opts.traceCap || 1200;

    let steps = 0, aborted = false, str = "", trace = null;

    const tick = () => { if (++steps >= stepCap) aborted = true; };
    const rec = (patternPos, stringPos, action) => {
      if (recordTrace && trace.length < traceCap) trace.push({ patternPos, stringPos, action });
    };

    function matchNode(node, pos, cont) {
      if (aborted) return false;
      tick();
      switch (node.type) {
        case "empty": return cont(pos);
        case "char":
          if (pos < str.length && str[pos] === node.ch) { rec(node.pos, pos, "match"); return cont(pos + 1); }
          rec(node.pos, pos, "fail"); return false;
        case "any":
          if (pos < str.length && str[pos] !== "\n") { rec(node.pos, pos, "match"); return cont(pos + 1); }
          rec(node.pos, pos, "fail"); return false;
        case "class":
          if (pos < str.length) {
            const hit = node.test(str[pos]);
            if (node.negate ? !hit : hit) { rec(node.pos, pos, "match"); return cont(pos + 1); }
          }
          rec(node.pos, pos, "fail"); return false;
        case "start":
          if (pos === 0) { rec(node.pos, pos, "match"); return cont(pos); }
          rec(node.pos, pos, "fail"); return false;
        case "end":
          if (pos === str.length) { rec(node.pos, pos, "match"); return cont(pos); }
          rec(node.pos, pos, "fail"); return false;
        case "group":
          return matchNode(node.child, pos, cont);
        case "concat": {
          const parts = node.parts;
          const seq = (idx, p) => {
            if (aborted) return false;
            if (idx >= parts.length) return cont(p);
            return matchNode(parts[idx], p, (p2) => seq(idx + 1, p2));
          };
          return seq(0, pos);
        }
        case "alt":
          for (const b of node.branches) {
            if (aborted) return false;
            if (matchNode(b, pos, cont)) return true;
          }
          return false;
        case "repeat":
          return matchRepeat(node, pos, cont);
        default:
          throw new Error("unknown node " + node.type);
      }
    }

    function matchRepeat(node, pos, cont) {
      const { min, max, greedy, child } = node;
      function loop(count, p) {
        if (aborted) return false;
        tick();
        const canMore = count < max;
        if (greedy) {
          if (canMore) {
            const ok = matchNode(child, p, (p2) => {
              if (p2 === p) return false;          // guard: empty match can't repeat
              return loop(count + 1, p2);
            });
            if (ok) return true;
          }
          if (count >= min) { rec(node.pos, p, "backtrack"); return cont(p); }
          return false;
        } else { // lazy
          if (count >= min && cont(p)) return true;
          if (canMore) {
            rec(node.pos, p, "backtrack");
            return matchNode(child, p, (p2) => {
              if (p2 === p) return false;
              return loop(count + 1, p2);
            });
          }
          return false;
        }
      }
      return loop(0, pos);
    }

    function run(ast, input) {
      str = input; steps = 0; aborted = false;
      trace = recordTrace ? [] : null;
      let matched = false, matchStart = -1, matchEnd = -1;
      for (let start = 0; start <= str.length; start++) {
        if (aborted) break;
        if (matchNode(ast, start, (p) => { matchEnd = p; return true; })) {
          matched = true; matchStart = start; break;
        }
      }
      return { matched, steps, capped: aborted, matchStart, matchEnd, trace };
    }

    return { run };
  }

  return { parse, makeMatcher, STEP_CAP };
});
