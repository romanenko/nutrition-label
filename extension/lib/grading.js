// Vlada's four categories, not one penalty for every row in the label.
// DOM findings are observable proxies for the broader design/business choices.
export const GRADE_CATEGORIES = [
  { id: "monetization", label: "Attention monetization", criteria: ["ads"] },
  { id: "personalization", label: "Personalized ranking", criteria: ["recommendations"] },
  { id: "notifications", label: "Persistent notifications", criteria: ["notifications"] },
  { id: "engagement", label: "Infinite engagement", criteria: ["infinite", "autoplay", "streaks"] },
];

const LETTERS = ["A", "B", "C", "D", "F"];

export function gradeAssessment(summary) {
  const categories = GRADE_CATEGORIES.map(category => {
    const signals = category.criteria.filter(id => summary.criteria?.[id]?.detected > 0);
    const covered = category.criteria.every(id => {
      const value = summary.criteria?.[id];
      return value?.assessed > 0 && value.unknown === 0;
    });
    return { ...category, signals, result: signals.length ? "detected" : covered ? "not_observed" : "unknown" };
  });
  const count = categories.filter(category => category.result === "detected").length;
  const unknown = categories.filter(category => category.result === "unknown").length;
  // Grade what has been observed, including zero harmful categories. Untested
  // behavior keeps the grade provisional; an empty/failed scan has no evidence.
  const hasEvidence = count > 0 || categories.some(category =>
    category.criteria.some(id => summary.criteria?.[id]?.assessed > 0));
  const letter = summary.assessed > 0 && hasEvidence ? LETTERS[count] : null;
  return { letter, count, unknown, partial: unknown > 0 || summary.partialCoverage === true, categories };
}
