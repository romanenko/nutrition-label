const badgeCount = /^(?:[1-9]\d{0,5}|[1-9]\d{0,2}(?:,\d{3}){1,2})\+?$/;
const normalize = value => String(value || "").replace(/\s+/g, " ").trim();

export function isNotificationControl(label) {
  // Restrict this to notification navigation, excluding settings, permission
  // buttons, message inboxes, and incidental mentions in page content.
  const base = normalize(label).replace(/\b\d[\d,]*\+?/g, " ")
    .replace(/\b(new|unread)\b/gi, " ").replace(/[()[\]:,·+\-]/g, " ");
  return /^(notifications?|activity|alerts?)( (center|centre))?$/i.test(normalize(base));
}

export function hasNotificationBadge(label, visibleBadgeTexts = []) {
  if (!isNotificationControl(label)) return false;
  // The count may be part of the accessible name or a separate visible badge
  // excluded from that name by aria-label. A bare bell/Activity link is not enough.
  const nameCounts = normalize(label).match(/\b\d[\d,]*\+?/g) || [];
  return [...nameCounts, ...visibleBadgeTexts].some(value => badgeCount.test(
    normalize(value).replace(/\b(new|unread)\b/gi, "").trim(),
  ));
}
