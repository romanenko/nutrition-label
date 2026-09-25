import test from "node:test";
import assert from "node:assert/strict";
import { gradeAssessment } from "../extension/lib/grading.js";
import { summarize } from "../extension/lib/model.js";

const observed = (detected = 0, assessed = 1, unknown = 0) => ({ detected, assessed, unknown });
const assessedSummary = () => ({ assessed: 1, criteria: Object.fromEntries(
  ["ads", "recommendations", "notifications", "infinite", "autoplay", "streaks"].map(id => [id, observed()]),
) });

test("Vlada's four categories map to A, B, C, D and F with no E", () => {
  const summary = assessedSummary();
  const triggers = ["ads", "recommendations", "notifications", "autoplay"];
  for (const [count, letter] of ["A", "B", "C", "D", "F"].entries()) {
    if (count) summary.criteria[triggers[count - 1]] = observed(1);
    const grade = gradeAssessment(summary);
    assert.equal(grade.letter, letter); assert.equal(grade.count, count);
  }
});

test("infinite scroll, autoplay and streaks count once; descriptive criteria add no penalties", () => {
  const summary = assessedSummary();
  for (const id of ["infinite", "autoplay", "streaks", "feed", "reactions", "ratings", "politics", "hate", "provocation", "banners", "deception", "controls"]) summary.criteria[id] = observed(1);
  const grade = gradeAssessment(summary);
  assert.equal(grade.count, 1); assert.equal(grade.letter, "B");
  assert.deepEqual(grade.categories.find(category => category.id === "engagement").signals, ["infinite", "autoplay", "streaks"]);
});

test("unobserved or incomplete scans cannot receive an A; positive partial grades retain uncertainty", () => {
  assert.equal(gradeAssessment({ assessed: 0, criteria: {} }).letter, null);
  assert.equal(gradeAssessment({ assessed: 1, criteria: {} }).letter, null);
  const summary = assessedSummary();
  summary.criteria.autoplay = observed(0, 0, 1);
  assert.equal(gradeAssessment(summary).letter, null);
  summary.criteria.ads = observed(1);
  const grade = gradeAssessment(summary);
  assert.equal(grade.letter, "B"); assert.equal(grade.partial, true); assert.equal(grade.unknown, 1);
});

test("categories accumulate across pages without averaging away or duplicating detected harm", () => {
  const assessment = { pages: {
    one: { assessedAt: 1, criteria: { ads: { result: "detected" }, autoplay: { result: "detected" } } },
    two: { assessedAt: 2, criteria: { ads: { result: "detected" }, infinite: { result: "detected" } } },
    three: { assessedAt: 3, criteria: { notifications: { result: "detected" } } },
  } };
  assert.equal(gradeAssessment(summarize(assessment)).letter, "D");
  assessment.pages.four = { assessedAt: 4, criteria: {} };
  const grade = gradeAssessment(summarize(assessment));
  assert.equal(grade.letter, "D"); assert.equal(grade.count, 3); assert.equal(grade.partial, true);
});
