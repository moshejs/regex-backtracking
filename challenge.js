/* challenge.js — "Find the fix": the interview-prep challenge mode. Wires the
   challenge data and grader (challenges.js) to the page. Step counts come from
   the page's own engine (engine.js), never from the browser's RegExp.
   Progress lives in localStorage; every access is wrapped so a private window
   or blocked storage just means progress isn't remembered. */
(function () {
  "use strict";

  const { CHALLENGES, grade, measure, STEPS_PER_CHAR, GROWTH_LIMIT, CAP } = window.RegexChallenges;
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => n.toLocaleString("en-US");
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // show invisible characters in case inputs
  const show = (s) => s === "" ? "(empty string)" : esc(JSON.stringify(s));

  const KEY = "regex-backtracking:challenges:v1";
  function load() {
    try {
      const raw = window.localStorage.getItem(KEY);
      const v = raw ? JSON.parse(raw) : null;
      if (v && typeof v === "object") return { solved: v.solved || {}, drafts: v.drafts || {}, current: v.current || CHALLENGES[0].id };
    } catch (e) { /* storage unavailable */ }
    return { solved: {}, drafts: {}, current: CHALLENGES[0].id };
  }
  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(progress)); } catch (e) { /* storage unavailable */ }
  }

  const progress = load();
  let idx = Math.max(0, CHALLENGES.findIndex((c) => c.id === progress.current));
  const beforeCache = {};

  $("#ch-rule-per").textContent = String(STEPS_PER_CHAR);
  $("#ch-rule-growth").textContent = String(GROWTH_LIMIT);

  /* ---- round list ---- */
  function renderList() {
    const ol = $("#ch-list");
    ol.innerHTML = "";
    CHALLENGES.forEach((ch, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      const solved = !!progress.solved[ch.id];
      b.innerHTML = `<span class="num">${String(i + 1).padStart(2, "0")}</span><span class="lbl">${esc(ch.title)}</span>` +
        `<span class="mark" aria-hidden="true">${solved ? "✓" : ""}</span>`;
      b.setAttribute("aria-label", `Round ${i + 1}: ${ch.title}, ${ch.level}${solved ? ", solved" : ""}`);
      if (i === idx) b.setAttribute("aria-current", "step");
      b.addEventListener("click", () => open(i, true));
      li.appendChild(b);
      ol.appendChild(li);
    });
    const done = CHALLENGES.filter((c) => progress.solved[c.id]).length;
    $("#ch-progress").textContent = `${done} / ${CHALLENGES.length} solved`;
  }

  /* ---- one round ---- */
  function before(ch) {
    if (!beforeCache[ch.id]) beforeCache[ch.id] = measure(ch.original, ch.attack(ch.n));
    return beforeCache[ch.id];
  }

  function open(i, focusTitle) {
    idx = i;
    const ch = CHALLENGES[i];
    progress.current = ch.id;
    save();
    renderList();
    $("#ch-level").textContent = `Round ${i + 1} · ${ch.level}`;
    $("#ch-title").textContent = ch.title;
    $("#ch-brief").innerHTML = ch.brief;
    $("#ch-original").textContent = ch.original;
    $("#ch-attack").textContent = ch.attackLabel(ch.n);
    $("#ch-hint").innerHTML = ch.hint;
    $("#ch-hint-box").open = false;
    $("#ch-input").value = progress.drafts[ch.id] != null ? progress.drafts[ch.id] : ch.original;
    $("#ch-result").innerHTML = "";
    $("#ch-solved").classList.add("hidden");
    if (progress.solved[ch.id] && progress.drafts[ch.id] != null) check(false);
    if (focusTitle) $("#ch-title").focus();
  }

  function check(announceSolve) {
    const ch = CHALLENGES[idx];
    const pattern = $("#ch-input").value;
    progress.drafts[ch.id] = pattern;
    const g = grade(ch, pattern);
    const res = $("#ch-result");

    if (g.parseError) {
      res.innerHTML = `<div class="verdict bad full"><div class="big"><span class="dot2"></span>Invalid pattern</div>` +
        `<div class="body">${esc(g.parseError)}.</div></div>`;
      $("#ch-solved").classList.add("hidden");
      save();
      return;
    }

    const b = before(ch);
    const failedCases = g.cases.filter((c) => !c.ok).length;
    const caseRows = g.cases.map((c) => {
      const want = c.want ? "should match" : "should not match";
      const why = c.capped ? " — too slow" : c.ok ? "" : (c.got ? " — matched" : " — didn't match");
      return `<li class="chcase ${c.ok ? "ok" : "no"}"><span class="ic" aria-hidden="true">${c.ok ? "✓" : "✗"}</span>` +
        `<span><code>${show(c.input)}</code> ${want}${why}<span class="sr">${c.ok ? " (passed)" : " (failed)"}</span></span></li>`;
    }).join("");

    const afterTxt = g.capped ? fmt(CAP) + "+" : fmt(g.steps);
    let speedNote;
    if (g.capped || !g.speedOk) speedNote = `Over budget: at most ${fmt(g.budget)} steps for ${fmt(g.attackLength)} characters.`;
    else if (!g.shapeOk) speedNote = `Under budget, but doubling the input took ${g.steps2 >= CAP ? "over " + fmt(CAP) : fmt(g.steps2)} steps (${g.growth.toFixed(1)}×) — that's not linear.`;
    else speedNote = `Linear: doubling the input took ${fmt(g.steps2)} steps (${g.growth.toFixed(1)}×).`;

    const meaningCls = g.meaningOk ? "" : " bad";
    const speedCls = g.speedOk && g.shapeOk ? "" : " bad";
    res.innerHTML =
      `<div class="verdict${meaningCls}"><div class="big"><span class="dot2"></span>Same meaning: ${g.meaningOk ? "yes" : failedCases + " case" + (failedCases === 1 ? "" : "s") + " wrong"}</div>` +
      `<ul class="chcases">${caseRows}</ul></div>` +
      `<div class="verdict${speedCls}"><div class="big"><span class="dot2"></span>Attack input: ${g.speedOk && g.shapeOk ? "survives" : "still blows up"}</div>` +
      `<div class="chsteps"><span class="n before">${b.capped ? fmt(CAP) + "+" : fmt(b.steps)}</span><span class="arrow">→</span>` +
      `<span class="n after ${g.speedOk && g.shapeOk ? "ok" : "no"}">${afterTxt}</span><span class="muted mono" style="font-size:12px">steps</span></div>` +
      `<div class="body">Original → yours, on ${fmt(g.attackLength)} characters. ${esc(speedNote)}</div></div>`;

    if (g.pass) {
      const first = !progress.solved[ch.id];
      progress.solved[ch.id] = true;
      $("#ch-explain").innerHTML = ch.explain;
      const src = $("#ch-source");
      if (ch.source) {
        src.innerHTML = `Source: <a href="${esc(ch.source.url)}" rel="noopener">${esc(ch.source.label)}</a>`;
        src.classList.remove("hidden");
      } else src.classList.add("hidden");
      const next = $("#ch-next");
      const nextIdx = CHALLENGES.findIndex((c, k) => k > idx && !progress.solved[c.id]);
      const anyLeft = nextIdx !== -1 || CHALLENGES.some((c) => !progress.solved[c.id]);
      next.textContent = anyLeft ? "Next round →" : "All rounds solved — start over";
      next.dataset.target = String(nextIdx !== -1 ? nextIdx : (anyLeft ? CHALLENGES.findIndex((c) => !progress.solved[c.id]) : 0));
      $("#ch-solved").classList.remove("hidden");
      if (first) renderList();
      if (announceSolve) $("#ch-progress").textContent += " — round solved";
    } else {
      $("#ch-solved").classList.add("hidden");
    }
    save();
  }

  $("#ch-form").addEventListener("submit", (e) => { e.preventDefault(); check(true); });
  $("#ch-reset").addEventListener("click", () => {
    const ch = CHALLENGES[idx];
    $("#ch-input").value = ch.original;
    delete progress.drafts[ch.id];
    $("#ch-result").innerHTML = "";
    $("#ch-solved").classList.add("hidden");
    save();
    $("#ch-input").focus();
  });
  $("#ch-next").addEventListener("click", (e) => open(+e.currentTarget.dataset.target || 0, true));

  open(idx, false);
})();
