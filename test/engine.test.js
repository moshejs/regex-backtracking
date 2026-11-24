// Engine sanity: the hand-written matcher agrees with native RegExp on match/no-match
// (native RegExp is used here only as an oracle, never for step counts).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, makeMatcher } = require("../engine.js");

const CASES = [
  ["(a+)+$", ["aaaa", "aaa!", "", "!"]],
  ["^a+b?c*$", ["aaac", "ab", "b", "aabcc"]],
  ["[a-z]+@[a-z]+\\.[a-z]+$", ["hi@x.io", "hi@x", "@x.io"]],
  ["^\\d{2,3}$", ["1", "12", "123", "1234"]],
  ["a.*?b", ["axxb", "ab", "a\nb"]],
  ["^(cat|dog)s?$", ["cat", "dogs", "cow"]],
  ["[^\"\\\\]", ["\"", "\\", "x"]],
  ["\\s$", ["a ", "a", "\t"]],
];

test("matches agree with native RegExp", () => {
  for (const [pattern, inputs] of CASES) {
    const ast = parse(pattern);
    for (const input of inputs) {
      const got = makeMatcher().run(ast, input).matched;
      assert.equal(got, new RegExp(pattern).test(input), `${pattern} on ${JSON.stringify(input)}`);
    }
  }
});

test("step counts are deterministic and the cap holds", () => {
  const ast = parse("(a+)+$");
  const a = makeMatcher().run(ast, "a".repeat(16) + "!");
  const b = makeMatcher().run(ast, "a".repeat(16) + "!");
  assert.equal(a.steps, b.steps);
  const capped = makeMatcher({ stepCap: 1000 }).run(ast, "a".repeat(30) + "!");
  assert.equal(capped.capped, true);
  assert.ok(capped.steps <= 1000);
});

test("bad patterns throw", () => {
  assert.throws(() => parse("(a"));
  assert.throws(() => parse("+a"));
});
