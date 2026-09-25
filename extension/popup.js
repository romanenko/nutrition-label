import { CRITERIA, hostPattern } from "./lib/model.js";
import { gradeAssessment } from "./lib/grading.js";

const $ = selector => document.querySelector(selector);
const extension = location.protocol === "chrome-extension:" && Boolean(globalThis.chrome?.runtime?.id);
const meanFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
let tabId = null, currentOrigin = null, enabled = false, polling = false;
const rows = new Map();
for (const criterion of CRITERIA) {
  const tr = document.createElement("tr");
  tr.hidden = true;
  if (criterion.child) tr.className = "sub-criterion";
  const th = document.createElement("th"); th.scope = "row"; th.textContent = criterion.label;
  const td = document.createElement("td"); td.textContent = "Unknown";
  tr.append(th, td); $("#criteria").append(tr); rows.set(criterion.id, td);
}
const notice = text => { $("#page-notice").textContent = text; };
function renderGrade(summary) {
  const grade = gradeAssessment(summary);
  const score = $("#score-value");
  score.textContent = grade.letter || "—";
  score.dataset.grade = grade.letter || "";
  const note = grade.letter === "A" ? `${grade.partial ? "Provisional" : "Estimated"} · No harmful categories detected` :
    grade.letter ? `Estimated · ${grade.count} ${grade.count === 1 ? "category" : "categories"}${grade.partial ? " · partial" : ""}` :
    summary.assessed ? "More evidence needed to assign a grade." : "Analyze a page to see its grade.";
  $("#score-note").textContent = note;
  score.setAttribute("aria-label", grade.letter ? `Estimated grade ${grade.letter}. ${note}` : "Not enough evidence to grade");
  $("#grade-breakdown").replaceChildren();
  for (const category of grade.categories) {
    const li = document.createElement("li");
    const label = document.createElement("strong"); label.textContent = `${category.label}: `;
    const signals = category.signals.map(id => CRITERIA.find(criterion => criterion.id === id).label).join(", ");
    li.append(label, document.createTextNode(category.result === "detected" ? `indicated by ${signals}. Counts once.` :
      category.result === "not_observed" ? "No mapped signals observed in assessed pages." : "Not enough evidence yet."));
    $("#grade-breakdown").append(li);
  }
}
async function send(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...values });
  if (!result?.ok) throw new Error(result?.error || "The extension is unavailable. Reload it and try again.");
  return result;
}
function render(data) {
  const { summary, origin } = data;
  renderGrade(summary);
  currentOrigin = origin;
  const url = new URL(origin);
  $("#website").textContent = `${url.protocol === "http:" ? "http://" : ""}${url.host}`;
  $("#serving-count").textContent = `${summary.visited} ${summary.visited === 1 ? "page" : "pages"}`;
  $("#coverage").textContent = summary.visited ? `Local coverage: ${Math.round(summary.assessed / summary.visited * 100)}%` : "No pages assessed";
  $("#coverage").title = `${summary.assessed} of ${summary.visited} pages locally assessed`;
  $("#analysis-status").textContent = summary.assessed ? "Observations available" : "Waiting for page";
  enabled = summary.enabled; $("#follow").checked = enabled;
  $("#finding-details").replaceChildren();
  let visibleCriteria = 0;
  for (const criterion of CRITERIA) {
    const value = summary.criteria[criterion.id];
    const td = rows.get(criterion.id);
    td.parentElement.hidden = value.assessed === 0;
    if (value.assessed === 0) continue;
    visibleCriteria++;
    const average = meanFormat.format(value.detected / value.assessed);
    const pageCount = `${value.detected} of ${value.assessed} assessed pages`;
    td.textContent = average;
    td.setAttribute("aria-label", `Mean detection per assessed page: ${average}`);
    td.classList.toggle("negative", criterion.negative === true && value.detected > 0);
    td.title = `${pageCount}. ${value.detail}`;
    const li = document.createElement("li");
    const strong = document.createElement("strong"); strong.textContent = `${criterion.label}: `;
    li.append(strong, document.createTextNode(`${pageCount}. ${value.detail}`));
    if (value.unknown) li.append(document.createTextNode(` ${value.unknown} page(s) unassessed for this criterion.`));
    if (value.probability !== null) li.append(document.createTextNode(` Jev probability: ${Math.round(value.probability * 100)}%. This is experimental, not a calibrated accuracy or severity score.`));
    $("#finding-details").append(li);
  }
  $("#criteria-table").hidden = visibleCriteria === 0;
  $("#empty-results").hidden = visibleCriteria > 0;
  $("#ai-status").textContent = summary.latest?.aiStatus || (data.preferences.ai ? "Jev enabled" : "Jev is off. Local observations still work.");
  const coverage = summary.latest?.coverage;
  $("#scope-note").textContent = coverage ? `Top document and accessible shadow roots; ${coverage.durationSeconds}s observed. ${coverage.frames} visible frame(s) not inspected. ${coverage.unlabeled} unnamed control(s).${coverage.limited ? " DOM scan limit reached." : ""}${coverage.privateContext ? " Text upload suppressed on this private-looking page." : ""}` : "No observation window yet.";
  $("#reset").disabled = !summary.visited && !enabled;
}
async function refresh() {
  if (!tabId || polling) return;
  polling = true;
  try { render(await send("LABEL_GET")); } catch (error) { notice(error.message); }
  finally { polling = false; }
}
async function scan() {
  $("#scan").disabled = true;
  try { await send("SCAN"); notice("Observing this page for two minutes. Browse normally; enable following for ongoing visits."); await refresh(); }
  catch (error) { notice(error.message); }
  finally { $("#scan").disabled = false; }
}
$("#scan").addEventListener("click", scan);
$("#settings").addEventListener("click", () => { if (extension) void chrome.runtime.openOptionsPage(); else location.href = "options.html"; });
$("#follow").addEventListener("change", async event => {
  const requested = event.target.checked;
  event.target.disabled = true;
  try {
    if (requested) {
      const granted = await chrome.permissions.request({ permissions: ["webNavigation"], origins: [hostPattern(currentOrigin)] });
      if (!granted) throw new Error("Site access was declined. Analyze page still works on click.");
    }
    await send("SITE_FOLLOW", { enabled: requested });
    notice(requested ? "This origin will be assessed as you browse. Other origins stay separate." : "Automatic assessment stopped. Saved findings remain until reset.");
  } catch (error) { notice(error.message); event.target.checked = enabled; }
  finally { event.target.disabled = false; await refresh(); }
});
$("#reset").addEventListener("click", async () => {
  try { await send("SITE_RESET"); notice("This origin’s assessment was cleared and following was stopped."); await refresh(); }
  catch (error) { notice(error.message); }
});
async function start() {
  if (!extension) {
    $("#website").textContent = "Label preview";
    $("#scan").disabled = true; $("#follow").disabled = true; $("#reset").disabled = true;
    notice("Layout preview. Open the Chrome toolbar extension to analyze a website.");
    return;
  }
  try {
    const requested = new URL(location.href).searchParams.get("tab");
    const [tab] = requested ? [await chrome.tabs.get(Number(requested))] : await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error("Open a regular website, then click the extension icon.");
    tabId = tab.id;
    await refresh(); await scan(); setInterval(refresh, 1000);
  } catch (error) {
    $("#website").textContent = "Website unavailable";
    $("#scan").disabled = true; $("#follow").disabled = true;
    notice(error.message);
  }
}
void start();
