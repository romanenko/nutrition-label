import { CRITERIA, finding, redact, unknown } from "./model.js";

const count = value => Number.isFinite(value) ? Math.max(0, Math.min(10000, Math.floor(value))) : 0;
const ratio = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const counts = (input, keys) => Object.fromEntries(keys.map(key => [key, count(input?.[key])]));

// Construct a fresh object: content scripts never choose model questions or destinations.
export function sanitizeSnapshot(input, preferences) {
  if (!input || typeof input !== "object" || JSON.stringify(input).length > 80000) throw new Error("Page snapshot is too large or invalid.");
  const result = {
    feed: { explicit: input.feed?.explicit === true, candidate: input.feed?.candidate === true,
      ...counts(input.feed, ["items", "reactions", "ratings"]) },
    media: { ...counts(input.media, ["configured", "observed", "mutedStarts", "alreadyPlaying"]),
      elements: Number.isFinite(input.media?.elements) && input.media.elements >= 0 ? count(input.media.elements) : null },
    infinite: { observed: input.infinite?.observed === true, scrolled: input.infinite?.scrolled === true },
    ui: { ...counts(input.ui, ["overlays", "ads", "recommendations", "notifications", "notificationBadges", "streaks", "controls", "repeatedPrompts"]), obstruction: ratio(input.ui?.obstruction) },
    coverage: { ...counts(input.coverage, ["frames", "unlabeled", "durationSeconds"]), ready: input.coverage?.ready === true,
      limited: input.coverage?.limited === true, privateContext: input.coverage?.privateContext === true },
    regions: [], items: [],
  };
  if (preferences.ai && !result.coverage.privateContext) {
    result.regions = (Array.isArray(input.regions) ? input.regions : []).slice(0, 8).map((region, index) => ({
      id: `region-${index}`, kind: ["feed", "prompt"].includes(region.kind) ? region.kind : "prompt",
      text: redact(region.text, 700), actions: (Array.isArray(region.actions) ? region.actions : []).slice(0, 8).map(value => redact(value, 100)),
      coverage: ratio(region.coverage),
    }));
    if (preferences.feedText && !result.coverage.privateContext) {
      result.items = (Array.isArray(input.items) ? input.items : []).slice(0, 12).map((item, index) => ({ id: `item-${index}`, text: redact(item.text, 700) })).filter(item => item.text);
    }
  }
  return result;
}

export function ruleFindings(snapshot) {
  const result = Object.fromEntries(CRITERIA.map(({ id }) => [id, unknown()]));
  const readable = snapshot.coverage.ready && !snapshot.coverage.limited;
  const complete = readable && snapshot.coverage.frames === 0;
  const incomplete = !snapshot.coverage.ready ? "Page is loading or has no readable content" :
    snapshot.coverage.limited ? "DOM scan limit reached" : "Embedded frames were not inspected";
  // Positive evidence counts even in a partial scan. Missing evidence only
  // counts as not observed after a usable scan of the page.
  const seen = (n, text, absent = "Not observed in this scan") => n ? finding("detected", text) :
    readable ? finding("not_observed", absent) : unknown(incomplete);
  result.feed = snapshot.feed.explicit ? finding("detected", "Feed semantics in the page") :
    snapshot.feed.candidate ? unknown("Repeated cards; Jev can classify this region") : seen(0, "", "No feed candidate in the inspected page");
  for (const [id, n, label] of [["reactions", snapshot.feed.reactions, "reaction controls"], ["ratings", snapshot.feed.ratings, "rating or vote controls"]]) {
    result[id] = snapshot.feed.candidate || snapshot.feed.explicit ? seen(n, `${n} ${label} in feed candidates`) : unknown("No feed identified");
  }
  result.infinite = snapshot.infinite.observed ? finding("detected", "New feed items arrived after scrolling without Load more", "observation") :
    complete && !snapshot.feed.explicit && !snapshot.feed.candidate ? finding("not_observed", "No feed found in the inspected page") :
    unknown(complete ? snapshot.infinite.scrolled ? "Automatic continuation not demonstrated" : "Scroll a feed to assess continuation" : incomplete);
  result.autoplay = snapshot.media.observed ? finding("detected", `${snapshot.media.observed} unsolicited video start(s); ${snapshot.media.mutedStarts} muted. Negative factor.`, "observation") :
    complete && snapshot.media.elements === 0 && !snapshot.media.configured && !snapshot.media.alreadyPlaying ? finding("not_observed", "No video elements found in the inspected page") : unknown(
      !complete ? incomplete : snapshot.media.alreadyPlaying ? "Video was already playing when observation began" : snapshot.media.configured ? "Autoplay configured; no unsolicited start observed" : "No unsolicited video start observed during this window");
  result.banners = seen(snapshot.ui.obstruction >= 0.15, `Overlay covers about ${Math.round(snapshot.ui.obstruction * 100)}% of the viewport; purpose may be functional`, "No large obstructive overlay observed");
  result.ads = seen(snapshot.ui.ads, `${snapshot.ui.ads} visible ad or sponsorship label(s)`);
  result.recommendations = seen(snapshot.ui.recommendations, "Recommendation wording visible; personalization unverified");
  const notificationEvidence = [];
  if (snapshot.ui.notifications) notificationEvidence.push("Notification request visible");
  if (snapshot.ui.notificationBadges) notificationEvidence.push("Unread notification/activity badge visible");
  result.notifications = seen(notificationEvidence.length, `${notificationEvidence.join("; ")}. Notification frequency and push delivery unverified.`);
  result.streaks = seen(snapshot.ui.streaks, "Streak or daily reward wording visible");
  result.controls = seen(snapshot.ui.controls, "Stopping point, pagination, or attention control visible");
  result.deception = unknown(snapshot.regions.some(region => region.kind === "prompt") ? "Prompt found; enable Jev for classification" : "No classifiable prompt collected");
  for (const id of ["politics", "hate", "provocation"]) result[id] = unknown("Enable Jev and feed-text analysis in settings");
  return result;
}
