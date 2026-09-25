import test from "node:test";
import assert from "node:assert/strict";
import { hasNotificationBadge } from "../extension/lib/notifications.js";
import { sanitizeSnapshot, ruleFindings } from "../extension/lib/detection.js";
import { summarize } from "../extension/lib/model.js";
import { gradeAssessment } from "../extension/lib/grading.js";

test("notification badges can be named or separate visible counts", () => {
  for (const [name, texts] of [
    ["Activity", ["4", "Activity"]],
    ["Notifications (4 unread)", []],
    ["4 new notifications", []],
    ["Notifications", ["99+"]],
    ["Notification center", ["1,200 unread"]],
  ]) assert.equal(hasNotificationBadge(name, texts), true, name);
});

test("empty navigation, zero counts, settings and unrelated counters are not notification badges", () => {
  for (const [name, texts] of [
    ["Activity", []], ["Notifications", ["0"]], ["Notifications (0 unread)", []],
    ["Notifications", ["Latest updates"]], ["Notifications settings", ["4"]],
    ["Allow notifications", ["4"]], ["Messages", ["4"]], ["Cart", ["4"]],
    ["Like video 4 likes", []], ["Notifications alt+T", []],
  ]) assert.equal(hasNotificationBadge(name, texts), false, name);
});

test("a notification badge completes the fourth grade category without claiming push delivery", () => {
  const input = { ui: { ads: 1, recommendations: 1 }, media: { observed: 1 } };
  const assess = () => summarize({ pages: { one: { assessedAt: 1, criteria: ruleFindings(sanitizeSnapshot(input, {})) } } });
  assert.equal(gradeAssessment(assess()).letter, "D");
  input.ui.notificationBadges = 1;
  const summary = assess();
  assert.equal(gradeAssessment(summary).letter, "F");
  assert.match(summary.criteria.notifications.detail, /Unread notification\/activity badge/);
  assert.match(summary.criteria.notifications.detail, /push delivery unverified/);
  assert.doesNotMatch(summary.criteria.notifications.detail, /request visible/);
  input.ui.notifications = 1;
  assert.equal(gradeAssessment(assess()).count, 4);
});
