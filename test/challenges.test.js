const test = require("node:test");
const assert = require("node:assert/strict");
const { CHALLENGES, grade, STEPS_PER_CHAR } = require("../challenges.js");

test("there are 6-10 challenges with unique ids", () => {
  assert.ok(CHALLENGES.length >= 6 && CHALLENGES.length <= 10);
  assert.equal(new Set(CHALLENGES.map((c) => c.id)).size, CHALLENGES.length);
});

for (const ch of CHALLENGES) {
  test(`${ch.id}: original keeps the meaning but blows up`, () => {
    const g = grade(ch, ch.original);
    assert.equal(g.parseError, null);
    assert.equal(g.meaningOk, true, "original must pass its own meaning cases");
    assert.equal(g.speedOk, false, "original must exceed the step budget");
    assert.equal(g.pass, false);
  });

  test(`${ch.id}: reference solution passes`, () => {
    const g = grade(ch, ch.solution);
    assert.equal(g.parseError, null);
    assert.deepEqual(g.cases.filter((c) => !c.ok), []);
    assert.ok(g.steps <= STEPS_PER_CHAR * g.attackLength, `steps ${g.steps}`);
    assert.equal(g.shapeOk, true, `growth ${g.growth}`);
    assert.equal(g.pass, true);
  });

  test(`${ch.id}: cases agree with native RegExp for original and solution`, () => {
    for (const p of [ch.original, ch.solution]) {
      const re = new RegExp(p);
      for (const s of ch.mustMatch) assert.equal(re.test(s), true, `${p} should match ${JSON.stringify(s)}`);
      for (const s of ch.mustNotMatch) assert.equal(re.test(s), false, `${p} should not match ${JSON.stringify(s)}`);
    }
  });

  test(`${ch.id}: has a hint and an explanation`, () => {
    assert.ok(ch.hint.length > 20);
    assert.ok(ch.explain.length > 60);
  });
}

test("grader rejects shortcuts", () => {
  const byId = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));
  assert.equal(grade(byId.digits, "^$").meaningOk, false);         // fast but wrong
  assert.equal(grade(byId.digits, "(").parseError !== null, true);  // unparseable
  assert.equal(grade(byId.equals, "^.*=").meaningOk, false);       // misses "=" after a newline
  // linear-ish shape check: an unanchored [\s\S]*\s$ is quadratic and must fail
  assert.equal(grade(byId.trailing, "[\\s\\S]*\\s$").pass, false);
  // alternative correct answers are accepted
  assert.equal(grade(byId.words, "^(\\w+\\s)*\\w*$").pass, true);
  assert.equal(grade(byId.equals, "[=]").pass, true);
});
