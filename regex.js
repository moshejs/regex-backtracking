/* regex.js — a from-scratch backtracking regex engine, instrumented to count
   every step, plus the interactive: a live step counter, a log-scale blowup
   chart, and an animated step-through of the matcher advancing and backtracking.

   No native RegExp is used to perform matching — the engine below does it all.
   Everything is one self-contained IIFE. */
(function () {
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

  /* =====================================================================
     PART 2 — THE INTERACTIVE
     ===================================================================== */
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => n.toLocaleString("en-US");

  const PRESETS = [
    { name: "nested +",       pattern: "(a+)+$",                 string: "aaaaaaaaaaaaaaaaaa!",  kind: "boom", tag: "boom" },
    { name: "alternation",    pattern: "(a|a)+$",                string: "aaaaaaaaaaaaaaaaa!",   kind: "boom", tag: "boom" },
    { name: "nested .*",      pattern: "(.*a){10}$",             string: "aaaaaaaaaaaaaa!",       kind: "boom", tag: "boom" },
    { name: "well-behaved",   pattern: "a+b?c*$",                string: "aaaaaaaaaaaaaaaac",     kind: "safe", tag: "safe" },
    { name: "email",          pattern: "[a-z]+@[a-z]+\\.[a-z]+$", string: "hello@moshemalka.com", kind: "safe", tag: "safe" },
  ];

  const CHART_N = 26; // sweep input lengths 1..26

  const state = {
    pattern: "(a+)+$",
    string: "aaaaaaaaaaaaaaaaaa!",
    ast: null,
    parseError: null,
    result: null,
    // chart
    sweep: [],          // [{L, steps, capped}]
    sweepToken: 0,
    // step-through
    anim: "",
    trace: [],
    traceCapped: false,
    idx: 0,
    playing: false,
    lastT: 0,
    rafPlay: null,
  };

  /* ---- parse (with caching) + main run ---- */
  function reparse() {
    try {
      state.ast = parse(state.pattern);
      state.parseError = null;
    } catch (e) {
      state.ast = null;
      state.parseError = e.message || "invalid pattern";
    }
  }

  function runAll() {
    state.pattern = $("#rx-pattern").value;
    state.string = $("#rx-string").value;
    reparse();

    if (state.parseError) {
      renderCounterError();
      state.sweep = [];
      drawChart();
      buildStepThrough(); // will show pattern-invalid note
      return;
    }

    const m = makeMatcher({ stepCap: STEP_CAP });
    state.result = m.run(state.ast, state.string);
    renderCounter();
    startSweep();
    buildStepThrough();
  }

  /* ---- counter / verdict ---- */
  function renderCounter() {
    const r = state.result;
    const big = $("#rx-steps");
    big.classList.remove("capped", "calm");
    if (r.capped) { big.textContent = fmt(STEP_CAP) + "+"; big.classList.add("capped"); }
    else { big.textContent = fmt(r.steps); if (r.matched && r.steps < 50000) big.classList.add("calm"); }

    const n = state.string.length;
    $("#rx-headline").textContent = r.capped
      ? `${n} character${n === 1 ? "" : "s"} → more than ${fmt(STEP_CAP)} steps (and counting)`
      : `${n} character${n === 1 ? "" : "s"} → ${fmt(r.steps)} step${r.steps === 1 ? "" : "s"}`;

    const v = $("#rx-verdict");
    const setV = (cls, title, body) => {
      v.className = "verdict" + (cls ? " " + cls : "");
      $("#rx-verdict-title").textContent = title;
      $("#rx-verdict-body").textContent = body;
    };
    if (r.capped) {
      setV("warn", "Still going — capped",
        "The engine hit its 5,000,000-step safety limit and bailed. A real backtracking engine would keep chewing on this for a very long time. That is the catastrophe.");
    } else if (r.matched) {
      const span = state.string.slice(r.matchStart, r.matchEnd);
      setV("", "Match", `Found a match${span ? ` (“${trunc(span)}”)` : ""} in ${fmt(r.steps)} step${r.steps === 1 ? "" : "s"}.`);
    } else if (r.steps > 50000) {
      setV("bad", "No match — and it thrashed",
        `It failed, but only after ${fmt(r.steps)} steps of backtracking. Fine on this input; a few more characters and it explodes.`);
    } else {
      setV("", "No match", `Failed cleanly in ${fmt(r.steps)} step${r.steps === 1 ? "" : "s"}. No blow-up here.`);
    }
  }

  function renderCounterError() {
    const big = $("#rx-steps");
    big.textContent = "—"; big.classList.remove("capped", "calm");
    $("#rx-headline").textContent = "the pattern doesn't parse";
    const v = $("#rx-verdict");
    v.className = "verdict bad";
    $("#rx-verdict-title").textContent = "Invalid pattern";
    $("#rx-verdict-body").textContent = state.parseError + ".";
  }

  const trunc = (s) => (s && s.length > 30 ? s.slice(0, 29) + "…" : s);

  /* ---- the blowup chart (chunked sweep + log-scale draw) ---- */
  function chartInputs() {
    const s = state.string || "a";
    const base = s[0] || "a";
    const last = s[s.length - 1];
    const poison = (s.length > 1 && last !== base) ? last : "";
    return (L) => base.repeat(L) + poison;
  }

  function startSweep() {
    const token = ++state.sweepToken;
    state.sweep = [];
    if (!state.ast) { drawChart(); return; }
    const mk = chartInputs();
    let L = 1, capped = false;
    const stepChunk = () => {
      if (token !== state.sweepToken) return; // superseded
      const budget = 3; // lengths per frame — keeps the UI responsive
      for (let k = 0; k < budget && L <= CHART_N; k++, L++) {
        if (capped) { state.sweep.push({ L, steps: STEP_CAP, capped: true }); continue; }
        const m = makeMatcher({ stepCap: STEP_CAP });
        const r = m.run(state.ast, mk(L));
        state.sweep.push({ L, steps: Math.max(1, r.steps), capped: r.capped });
        if (r.capped) capped = true;
      }
      drawChart();
      if (L <= CHART_N) requestAnimationFrame(stepChunk);
    };
    requestAnimationFrame(stepChunk);
  }

  const chart = $("#rx-chart");
  const cctx = chart.getContext("2d");
  const cvar = (name, fb) =>
    (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb);

  function drawChart() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = chart.clientWidth || 640, H = 300;
    chart.style.height = H + "px";
    chart.width = Math.round(W * dpr);
    chart.height = Math.round(H * dpr);
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);

    const padL = 52, padR = 14, padT = 14, padB = 30;
    const x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
    const ink = cvar("--ink-soft", "#b7bdca");
    const mute = cvar("--ink-mute", "#7c8494");
    const faint = cvar("--ink-faint", "#525a6b");
    const line = cvar("--line", "#262b37");
    const accent = cvar("--accent", "#ff6b6b");
    const dim = cvar("--dim", "#5b6377");

    const CAP = STEP_CAP;
    const logCap = Math.log10(CAP);
    const xAt = (L) => x0 + ((L - 1) / (CHART_N - 1)) * (x1 - x0);
    const yAt = (v) => {
      const t = Math.log10(Math.min(CAP, Math.max(1, v))) / logCap;
      return y0 - t * (y0 - y1);
    };

    // y gridlines at powers of ten + cap
    cctx.font = "10px " + cvar("--mono", "monospace");
    cctx.textBaseline = "middle";
    const ticks = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, CAP];
    const tlab = { 1: "1", 10: "10", 100: "100", 1000: "1k", 10000: "10k", 100000: "100k", 1000000: "1M" };
    for (const t of ticks) {
      const y = yAt(t);
      cctx.strokeStyle = (t === CAP) ? accent : line;
      cctx.globalAlpha = (t === CAP) ? 0.5 : 1;
      cctx.setLineDash(t === CAP ? [4, 4] : []);
      cctx.lineWidth = 1;
      cctx.beginPath(); cctx.moveTo(x0, y); cctx.lineTo(x1, y); cctx.stroke();
      cctx.setLineDash([]);
      cctx.globalAlpha = 1;
      cctx.fillStyle = (t === CAP) ? accent : mute;
      cctx.textAlign = "right";
      cctx.fillText(t === CAP ? "5M cap" : tlab[t], x0 - 8, y);
    }

    // x axis ticks
    cctx.textAlign = "center";
    cctx.textBaseline = "top";
    cctx.fillStyle = mute;
    for (let L = 1; L <= CHART_N; L += 5) cctx.fillText(String(L), xAt(L), y0 + 7);
    cctx.fillStyle = faint;
    cctx.fillText("input length (characters)  →", (x0 + x1) / 2, y0 + 18);

    // y axis title
    cctx.save();
    cctx.translate(13, (y0 + y1) / 2);
    cctx.rotate(-Math.PI / 2);
    cctx.textAlign = "center"; cctx.textBaseline = "middle";
    cctx.fillStyle = faint;
    cctx.fillText("steps  (log scale)  →", 0, 0);
    cctx.restore();

    // linear reference line: an O(n·m) engine
    const patLen = Math.max(1, (state.pattern || "").length);
    cctx.strokeStyle = dim;
    cctx.setLineDash([3, 4]);
    cctx.lineWidth = 1.5;
    cctx.beginPath();
    for (let L = 1; L <= CHART_N; L++) {
      const v = L * patLen;
      const X = xAt(L), Y = yAt(v);
      L === 1 ? cctx.moveTo(X, Y) : cctx.lineTo(X, Y);
    }
    cctx.stroke();
    cctx.setLineDash([]);

    // current-string marker
    const cur = state.string.length;
    if (cur >= 1 && cur <= CHART_N) {
      const X = xAt(cur);
      cctx.strokeStyle = cvar("--accent-soft", "#4a2626");
      cctx.globalAlpha = 0.9; cctx.lineWidth = 1; cctx.setLineDash([2, 3]);
      cctx.beginPath(); cctx.moveTo(X, y1); cctx.lineTo(X, y0); cctx.stroke();
      cctx.setLineDash([]); cctx.globalAlpha = 1;
      cctx.fillStyle = mute; cctx.textAlign = "center"; cctx.textBaseline = "top";
      cctx.fillText("your string", X, y1 - 2 < 0 ? 0 : y1);
    }

    // the measured curve (accent)
    if (state.sweep.length) {
      cctx.strokeStyle = accent;
      cctx.lineWidth = 2.5;
      cctx.lineJoin = "round";
      cctx.beginPath();
      state.sweep.forEach((p, i) => {
        const X = xAt(p.L), Y = yAt(p.steps);
        i === 0 ? cctx.moveTo(X, Y) : cctx.lineTo(X, Y);
      });
      cctx.stroke();
      // dots, and a flag at the first capped length
      let flagged = false;
      for (const p of state.sweep) {
        const X = xAt(p.L), Y = yAt(p.steps);
        cctx.fillStyle = accent;
        cctx.beginPath(); cctx.arc(X, Y, 2.4, 0, Math.PI * 2); cctx.fill();
        if (p.capped && !flagged) {
          flagged = true;
          cctx.fillStyle = ink;
          cctx.textAlign = "left"; cctx.textBaseline = "bottom";
          cctx.fillText("hits the cap", Math.min(X + 6, x1 - 60), Y - 4);
        }
      }
    }

    // caption
    const cap = $("#rx-chart-cap");
    if (state.parseError) {
      cap.innerHTML = "Fix the pattern to plot the curve.";
    } else {
      const boom = state.sweep.some((p) => p.capped);
      cap.innerHTML = boom
        ? "The red curve is a <b>straight diagonal on a log scale</b> — that's exponential. Every extra character doubles the work until it slams the cap."
        : "The red curve tracks this pattern; it stays low and flat — no blow-up. Compare with the gray linear reference.";
    }
  }

  /* ---- step-through: build cells, play back a bounded trace ---- */
  function shortenForAnim(s) {
    if (s.length <= 6) return s;
    const head = s.slice(0, 5);
    const last = s[s.length - 1];
    if (last !== head[head.length - 1]) return s.slice(0, 4) + last;
    return head;
  }

  function buildStepThrough() {
    stopPlay();
    const patCells = $("#rx-pat-cells");
    const strCells = $("#rx-str-cells");
    const note = $("#rx-anim-note");

    if (state.parseError) {
      patCells.innerHTML = "";
      strCells.innerHTML = "";
      state.trace = [];
      $("#rx-action").textContent = "—";
      $("#rx-action").className = "actionpill";
      $("#rx-scrub").max = 0; $("#rx-scrub").value = 0;
      $("#rx-stepcnt").textContent = "0 / 0";
      note.innerHTML = "The pattern is invalid, so there's nothing to step through.";
      return;
    }

    const anim = shortenForAnim(state.string);
    state.anim = anim;

    // pattern cells (one per source character)
    patCells.innerHTML = "";
    for (let k = 0; k < state.pattern.length; k++) {
      const c = document.createElement("span");
      c.className = "cell";
      c.dataset.pos = k;
      c.textContent = state.pattern[k];
      patCells.appendChild(c);
    }
    // string cells + a trailing end-of-string slot (for $ / end cursor)
    strCells.innerHTML = "";
    for (let k = 0; k < anim.length; k++) {
      const c = document.createElement("span");
      c.className = "cell";
      c.dataset.idx = k;
      c.textContent = anim[k] === " " ? "␣" : anim[k];
      strCells.appendChild(c);
    }
    const end = document.createElement("span");
    end.className = "cell endcap";
    end.dataset.idx = anim.length;
    end.textContent = "␉"; // end marker
    end.title = "end of string";
    strCells.appendChild(end);

    // record the trace on the (short) animation input
    const m = makeMatcher({ recordTrace: true, traceCap: 1200, stepCap: STEP_CAP });
    const r = m.run(state.ast, anim);
    state.trace = r.trace || [];
    state.traceCapped = r.trace && r.trace.length >= 1200;

    $("#rx-scrub").max = Math.max(0, state.trace.length - 1);
    state.idx = 0;
    renderFrame(0);

    // note
    const traceLen = state.trace.length;
    const shortened = anim !== state.string;
    let msg = shortened
      ? `Stepping through a shortened input <b>${escapeHtml(anim)}</b> so the trace stays watchable — the counter and chart above use the full string.`
      : `Stepping through the full input <b>${escapeHtml(anim)}</b>.`;
    msg += ` ${fmt(traceLen)} recorded step${traceLen === 1 ? "" : "s"}` + (state.traceCapped ? " (trace truncated)." : ".");
    if (traceLen === 0) msg = "This match resolved with no recorded steps.";
    note.innerHTML = msg;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderFrame(idx) {
    const trace = state.trace;
    const patCells = $("#rx-pat-cells").children;
    const strCells = $("#rx-str-cells").children;
    for (const c of patCells) c.className = "cell";
    for (const c of strCells) c.className = c.classList.contains("endcap") ? "cell endcap" : "cell";

    const pill = $("#rx-action");
    if (!trace.length) {
      pill.textContent = "no steps";
      pill.className = "actionpill";
      $("#rx-stepcnt").textContent = "0 / 0";
      return;
    }
    idx = Math.max(0, Math.min(idx, trace.length - 1));
    state.idx = idx;
    const t = trace[idx];

    // pattern cursor
    for (const c of patCells) {
      if (+c.dataset.pos === t.patternPos) c.classList.add("patcursor");
    }
    // string cursor + eaten
    for (const c of strCells) {
      const i2 = +c.dataset.idx;
      if (i2 < t.stringPos) c.classList.add("eaten");
      else if (i2 === t.stringPos) c.classList.add("cursor");
    }

    const desc = { match: "MATCH — advance", fail: "FAIL — no match here", backtrack: "BACKTRACK — giving back" };
    pill.className = "actionpill " + t.action;
    pill.innerHTML = "<b>" + desc[t.action] + "</b>";

    $("#rx-scrub").value = idx;
    $("#rx-stepcnt").textContent = (idx + 1) + " / " + trace.length;
  }

  /* ---- playback controls ---- */
  function stepBy(d) { stopPlay(); renderFrame(state.idx + d); }

  function togglePlay() {
    if (state.playing) { stopPlay(); return; }
    if (!state.trace.length) return;
    if (state.idx >= state.trace.length - 1) state.idx = 0; // restart if at end
    state.playing = true;
    $("#rx-play").textContent = "⏸ Pause";
    state.lastT = performance.now();
    const loop = (now) => {
      if (!state.playing) return;
      const speed = +$("#rx-speed").value;      // 1..30
      const perSec = 1.5 + speed * 1.6;          // steps per second
      const elapsed = (now - state.lastT) / 1000;
      const advance = Math.floor(elapsed * perSec);
      if (advance > 0) {
        state.lastT = now;
        let next = state.idx + advance;
        if (next >= state.trace.length - 1) { renderFrame(state.trace.length - 1); stopPlay(); return; }
        renderFrame(next);
      }
      state.rafPlay = requestAnimationFrame(loop);
    };
    state.rafPlay = requestAnimationFrame(loop);
  }

  function stopPlay() {
    state.playing = false;
    if (state.rafPlay) cancelAnimationFrame(state.rafPlay);
    state.rafPlay = null;
    const p = $("#rx-play");
    if (p) p.textContent = "▶ Play";
  }

  /* ---- wiring ---- */
  function buildPresetChips() {
    const host = $("#rx-presets");
    for (const p of PRESETS) {
      const el = document.createElement("span");
      el.className = "preset " + p.kind;
      el.innerHTML = `${escapeHtml(p.name)}<span class="tag">${p.tag}</span>`;
      el.addEventListener("click", () => {
        $("#rx-pattern").value = p.pattern;
        $("#rx-string").value = p.string;
        runAll();
      });
      host.appendChild(el);
    }
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  buildPresetChips();
  $("#rx-run").addEventListener("click", runAll);
  $("#rx-pattern").addEventListener("input", debounce(runAll, 350));
  $("#rx-string").addEventListener("input", debounce(runAll, 350));
  $("#rx-pattern").addEventListener("keydown", (e) => { if (e.key === "Enter") runAll(); });
  $("#rx-string").addEventListener("keydown", (e) => { if (e.key === "Enter") runAll(); });

  $("#rx-play").addEventListener("click", togglePlay);
  $("#rx-fwd").addEventListener("click", () => stepBy(1));
  $("#rx-back").addEventListener("click", () => stepBy(-1));
  $("#rx-restart").addEventListener("click", () => { stopPlay(); renderFrame(0); });
  $("#rx-scrub").addEventListener("input", (e) => { stopPlay(); renderFrame(+e.target.value); });

  window.addEventListener("resize", debounce(drawChart, 120));

  // go
  runAll();
})();
