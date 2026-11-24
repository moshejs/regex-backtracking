// redos-check: the probe library (lib/redos.js) and the CLI (bin/redos-check.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { check, unsupportedReason } = require("../lib/redos.js");
const { parse, makeMatcher } = require("../engine.js");
const { CHALLENGES } = require("../challenges.js");

const CLI = path.join(__dirname, "..", "bin", "redos-check.js");
const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input: input === undefined ? "" : input, encoding: "utf8" });

const KNOWN_BAD = {
  "(a+)+$": "exponential",
  "(a|aa)+$": "exponential",
  "(.*a){12}": "exponential",
  "^(\\d+)+$": "exponential",
  "(x+x+)+y": "exponential",
  "(a*)*$": "exponential",
  "\\s+$": "polynomial",
};
const KNOWN_FINE = [
  "^\\d+$",
  "^[a-z0-9_]+$",
  "^abc$",
  "^\\d{3}-\\d{4}$",
  "^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$",
  "^(a|b)*$",
  "\\d+",
];
const UNSUPPORTED = [
  "(a)\\1", "(?=a)a", "(?!a)b", "(?<=a)b", "(?<!a)b", "(?<n>a)", "\\bword", "[\\b]", "\\B",
  "\\x41", "\\u0041", "\\p{L}", "\\cJ", "\\01", "\\k<n>", "\\q", "[]a]", "[^]", "[a-\\d]",
  "a{2}{3}", "(a", "+a", "[a", // invalid JavaScript regex
];

for (const [pattern, cls] of Object.entries(KNOWN_BAD)) {
  test(`known-bad ${pattern} is flagged ${cls}`, () => {
    const r = check(pattern);
    assert.equal(r.status, "blowup");
    assert.equal(r.class, cls);
    assert.ok(r.worst.evidence.length >= 2, "evidence carries at least two sizes");
  });
}

for (const pattern of KNOWN_FINE) {
  test(`known-fine ${pattern}: no blow-up found`, () => {
    const r = check(pattern);
    assert.equal(r.status, "none-found");
    assert.equal(r.class, "linear");
  });
}

for (const pattern of UNSUPPORTED) {
  test(`unsupported/invalid ${JSON.stringify(pattern)} is refused, not guessed at`, () => {
    assert.ok(unsupportedReason(pattern), "has a reason");
    assert.equal(check(pattern).status, "unsupported");
  });
}

test("supported syntax is accepted", () => {
  for (const p of ["a.b", "[^a-z\\d]", "(?:ab)+?", "a{2,}", "a{,3}", "\\.\\*\\n\\t", "^$", "", "[a\\]]", "\\0", "[\\d-z]", "[-\\d]"]) {
    assert.equal(unsupportedReason(p), null, p);
  }
});

test("evidence is reproducible with the engine directly", () => {
  const r = check("(a|aa)+$");
  const w = r.worst;
  const ast = parse("(a|aa)+$");
  for (const p of w.evidence.filter((e) => !e.capped)) {
    const input = w.prefix + w.pump.repeat(p.n) + w.suffix;
    assert.equal(input.length, p.length);
    assert.equal(makeMatcher({ stepCap: r.maxSteps }).run(ast, input).steps, p.steps);
  }
});

test("--fail-on exponential lets polynomial growth through but still reports it", () => {
  assert.equal(check("\\s+$", { failOn: "exponential" }).status, "allowed");
  assert.equal(check("(a+)+$", { failOn: "exponential" }).status, "blowup");
});

test("agrees with the page's challenge set: every original flagged, every reference fix not", () => {
  for (const c of CHALLENGES) {
    assert.equal(check(c.original).status, "blowup", c.id + " original");
    assert.equal(check(c.solution).status, "none-found", c.id + " fix");
  }
});

/* ---- CLI ---- */

test("cli: exit 1 and BLOWUP line for a bad pattern", () => {
  const r = cli(["(a+)+$"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /BLOWUP\s+\(a\+\)\+\$/);
  assert.match(r.stdout, /exponential/);
});

test("cli: exit 0 and an honest 'not a proof' line for a fine pattern", () => {
  const r = cli(["^\\d+$"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no blow-up found within 1,000,000 steps/);
  assert.match(r.stdout, /Not a proof of safety/);
  assert.doesNotMatch(r.stdout, /\bis safe\b/i);
});

test("cli: exit 2 for unsupported syntax, with the reason", () => {
  const r = cli(["(a)\\1"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /UNSUPPORTED/);
  assert.match(r.stdout, /backreference/);
});

test("cli: a blow-up outranks an unsupported pattern (exit 1)", () => {
  assert.equal(cli(["(a+)+$", "\\1"]).status, 1);
});

test("cli: usage errors exit 2", () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["--bogus"]).status, 2);
  assert.equal(cli(["--max-steps", "abc", "a"]).status, 2);
  assert.equal(cli(["--max-steps"]).status, 2);
  assert.equal(cli(["--fail-on", "quadratic", "a"]).status, 2);
  assert.equal(cli(["--file", "/nonexistent/patterns.txt"]).status, 2);
});

test("cli: --help exits 0 and documents exit codes and syntax", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Exit codes/);
  assert.match(r.stdout, /Supported syntax/);
});

test("cli: --json is machine-readable and matches the exit code", () => {
  const r = cli(["--json", "(a+)+$", "^\\d+$", "(?=x)"]);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.results.map((x) => x.status), ["blowup", "none-found", "unsupported"]);
  assert.equal(out.exitCode, 1);
  assert.equal(out.summary.blowup, 1);
  assert.ok(out.results[0].worst.points.length > 0);
});

test("cli: reads patterns from stdin and from --file, one per line", () => {
  const viaStdin = cli(["--json"], "^\\d+$\r\n\n(a+)+$\n");
  assert.equal(viaStdin.status, 1);
  assert.deepEqual(JSON.parse(viaStdin.stdout).results.map((x) => x.pattern), ["^\\d+$", "(a+)+$"]);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "redos-")), "patterns.txt");
  fs.writeFileSync(file, "^[a-z]+$\n^abc$\n");
  const viaFile = cli(["--file", file]);
  assert.equal(viaFile.status, 0);
  assert.match(viaFile.stdout, /2 pattern\(s\): 0 blow-up/);
});

test("cli: --max-steps sets the budget a blow-up is measured against", () => {
  const out = JSON.parse(cli(["--json", "--max-steps", "5000", "(a+)+$"]).stdout);
  assert.equal(out.options.maxSteps, 5000);
  const capped = out.results[0].worst.points.find((p) => p.capped);
  assert.ok(capped && capped.steps <= 5000);
});

test("cli: -- lets a pattern start with a dash", () => {
  assert.equal(cli(["--", "-a+"]).status, 0);
});
