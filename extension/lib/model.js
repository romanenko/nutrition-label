export const DETECTOR_VERSION = "2";
export const MODEL = "jev-1.13.0";
export const THRESHOLD = 0.9;
export const CRITERIA = [
  { id: "feed", label: "Content feed" },
  { id: "infinite", label: "Infinite scroll", child: true },
  { id: "reactions", label: "Likes & reactions", child: true },
  { id: "ratings", label: "Ratings & votes", child: true },
  { id: "politics", label: "Political topics", child: true, text: true },
  { id: "hate", label: "Hateful language", child: true, text: true },
  { id: "provocation", label: "Provocative framing", child: true, text: true },
  { id: "autoplay", label: "Autoplay video", negative: true },
  { id: "banners", label: "Obstructive banners" },
  { id: "ads", label: "Ads & sponsorship" },
  { id: "deception", label: "Deceptive prompts" },
  { id: "recommendations", label: "Recommendations" },
  { id: "notifications", label: "Notifications" },
  { id: "streaks", label: "Streaks & rewards" },
  { id: "controls", label: "Stopping & control", positive: true },
];

export const defaults = () => ({ ai: false, feedText: false });
export const finding = (result, detail, method = "rule", extra = {}) => ({ result, detail, method, ...extra });
export const unknown = (detail = "Not assessed") => finding("unknown", detail);

export function originOf(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Open a regular website to analyze it.");
  return url.origin;
}

export function hostPattern(origin) {
  const url = new URL(originOf(origin));
  // Chrome match patterns do not narrow access to a specific port.
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizedRoute(value) {
  const url = new URL(value);
  originOf(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_(source|medium|campaign|term|content|id)|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  }
  if (!/^#!?\//.test(url.hash)) url.hash = "";
  return url.href;
}

export const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromBase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export async function pageDigest(secret, url) {
  const key = await crypto.subtle.importKey("raw", fromBase64(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const value = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1:${normalizedRoute(url)}`));
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function redact(value, limit = 700) {
  return String(value ?? "").replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(?:\+?\d[\s().-]*){8,}\b/g, "[number]")
    .replace(/\b(?:sk[-_]|Bearer\s+)[A-Za-z0-9_-]{8,}/gi, "[credential]")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}

export function summarize(assessment) {
  const pages = Object.values(assessment?.pages || {});
  const criteria = {};
  for (const { id } of CRITERIA) {
    const values = pages.map(page => page.criteria?.[id]).filter(Boolean);
    const assessed = values.filter(value => ["detected", "not_observed"].includes(value.result));
    const detected = assessed.filter(value => value.result === "detected");
    const latest = values.at(-1);
    const probabilities = detected.filter(value => value.method === "model").map(value => value.probability);
    criteria[id] = {
      assessed: assessed.length, detected: detected.length, unknown: pages.length - assessed.length,
      detail: detected.at(-1)?.detail || latest?.detail || "Not assessed",
      probability: probabilities.length ? Math.max(...probabilities) : null,
      sampleAssessed: values.reduce((sum, value) => sum + (value.sampleAssessed || 0), 0),
      sampleDetected: values.reduce((sum, value) => sum + (value.sampleDetected || 0), 0),
    };
  }
  return {
    visited: pages.length, assessed: pages.filter(page => page.assessedAt).length,
    criteria, updatedAt: assessment?.updatedAt || null, enabled: Boolean(assessment?.enabled),
    latest: pages.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)[0] || null,
  };
}

export function touchPage(assessment, digest, now = Date.now()) {
  assessment.pages[digest] ||= { firstVisitedAt: now, criteria: {} };
  assessment.pages[digest].lastVisitedAt = now;
  assessment.updatedAt = now;
  return assessment.pages[digest];
}

export function retainDetected(previous = {}, next) {
  const result = { ...next };
  for (const [id, value] of Object.entries(previous)) {
    if (value.result === "detected" && next[id]?.result !== "detected") {
      result[id] = { ...value, detail: value.detail.startsWith("Seen earlier:") ? value.detail : `Seen earlier: ${value.detail}` };
    }
  }
  return result;
}
