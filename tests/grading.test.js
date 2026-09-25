import test from "node:test";
import assert from "node:assert/strict";
import { gradeAssessment } from "../extension/lib/grading.js";
import { summarize, retainDetected } from "../extension/lib/model.js";
import { ruleFindings, sanitizeSnapshot } from "../extension/lib/detection.js";

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

test("empty scans stay ungraded; untested behavior keeps zero-harm grades provisional", () => {
  assert.equal(gradeAssessment({ assessed: 0, criteria: {} }).letter, null);
  assert.equal(gradeAssessment({ assessed: 1, criteria: {} }).letter, null);
  const summary = assessedSummary();
  summary.criteria.autoplay = observed(0, 0, 1);
  assert.equal(gradeAssessment(summary).letter, "A");
  assert.equal(gradeAssessment(summary).partial, true);
  summary.criteria.ads = observed(1);
  const grade = gradeAssessment(summary);
  assert.equal(grade.letter, "B"); assert.equal(grade.partial, true); assert.equal(grade.unknown, 1);
});

const cleanScan = { coverage: { ready: true }, media: { elements: 0 } };
const assess = input => {
  const snapshot = sanitizeSnapshot(input, {});
  return summarize({ pages: { one: { assessedAt: 1, coverage: snapshot.coverage, criteria: ruleFindings(snapshot) } } });
};

test("a readable page with no feed, videos or harmful signals earns A without AI", () => {
  const summary = assess(cleanScan);
  const grade = gradeAssessment(summary);
  assert.equal(grade.letter, "A"); assert.equal(grade.partial, false);
  assert.equal(summary.criteria.autoplay.assessed, 1);
  assert.equal(summary.criteria.autoplay.detected, 0);
  assert.equal(summary.criteria.infinite.assessed, 1);
  assert.equal(summary.criteria.infinite.detected, 0);
  assert.equal(summary.criteria.hate.assessed, 0);
});

test("a feed or untested video can earn provisional A while its behavior stays unknown", () => {
  for (const input of [
    { ...cleanScan, feed: { explicit: true } },
    { ...cleanScan, media: { elements: 1, alreadyPlaying: 1 } },
    { ...cleanScan, media: {} }, // Missing element counts must not be interpreted as no videos.
  ]) {
    const summary = assess(input);
    const grade = gradeAssessment(summary);
    assert.equal(grade.letter, "A"); assert.equal(grade.partial, true);
    assert.ok(summary.criteria.infinite.unknown || summary.criteria.autoplay.unknown);
  }
});

test("loading, blank, truncated and embedded-only scans do not earn a clean grade", () => {
  for (const coverage of [{}, { ready: false }, { ready: true, limited: true }, { ready: false, frames: 1 }]) {
    assert.equal(gradeAssessment(assess({ ...cleanScan, coverage })).letter, null);
    const grade = gradeAssessment(assess({ ...cleanScan, coverage, ui: { ads: 1 } }));
    assert.equal(grade.letter, "B"); assert.equal(grade.partial, true);
  }
});

test("an uninspected embed keeps a readable page's grade provisional without suppressing it", () => {
  const input = { ...cleanScan, coverage: { ready: true, frames: 1 } };
  const summary = assess(input);
  const grade = gradeAssessment(summary);
  assert.equal(grade.letter, "A"); assert.equal(grade.partial, true);
  assert.equal(summary.criteria.autoplay.assessed, 0);
  const harmful = assess({ ...input, ui: { ads: 1, recommendations: 1, notificationBadges: 1 }, media: { observed: 1 } });
  assert.equal(gradeAssessment(harmful).letter, "F");
  assert.equal(gradeAssessment(harmful).partial, true);
});

test("a clean observed page keeps a provisional A when another visited page is unassessed", () => {
  const snapshot = sanitizeSnapshot(cleanScan, {});
  const assessment = { pages: {
    one: { assessedAt: 1, coverage: snapshot.coverage, criteria: ruleFindings(snapshot) },
    two: { criteria: {} },
  } };
  const grade = gradeAssessment(summarize(assessment));
  assert.equal(grade.letter, "A"); assert.equal(grade.partial, true);
  assert.equal(grade.unknown, 4);
});

test("new harmful evidence replaces A and later clean scans or positive controls cannot erase it", () => {
  const page = { assessedAt: 1, criteria: ruleFindings(sanitizeSnapshot(cleanScan, {})) };
  const grade = () => gradeAssessment(summarize({ pages: { one: page } })).letter;
  assert.equal(grade(), "A");
  const harmful = { ...cleanScan, ui: { ads: 1, recommendations: 1, notificationBadges: 1 }, media: { elements: 1, observed: 1 } };
  page.criteria = retainDetected(page.criteria, ruleFindings(sanitizeSnapshot(harmful, {})));
  assert.equal(grade(), "F");
  page.criteria = retainDetected(page.criteria, ruleFindings(sanitizeSnapshot({ ...cleanScan, ui: { controls: 1 } }, {})));
  assert.equal(grade(), "F");
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
