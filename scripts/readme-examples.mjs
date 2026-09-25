// Render documentation examples with the production popup and synthetic observations.
// Requires Node.js and the agent-browser CLI; no extension, credentials or AI calls.
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sanitizeSnapshot, ruleFindings } from "../extension/lib/detection.js";
import { summarize } from "../extension/lib/model.js";
import { gradeAssessment } from "../extension/lib/grading.js";

const root = new URL("../", import.meta.url);
const output = new URL("docs/examples/", root);
const examples = [
  { id: "calm-reading", origin: "https://reading.example", grade: "A", pages: [
    { ui: { controls: 1 } }, { ui: { controls: 1 } }, { ui: { controls: 1 } },
  ] },
  { id: "recommended-feed", origin: "https://feed.example", grade: "D", pages: [
    { feed: { explicit: true, reactions: 4 }, infinite: { observed: true }, ui: { ads: 1, recommendations: 1, controls: 1 } },
    { feed: { explicit: true, reactions: 3 }, ui: { recommendations: 1, controls: 1 } },
    { feed: { explicit: true, reactions: 5 }, ui: { recommendations: 1, controls: 1 } },
  ] },
  { id: "all-four-categories", origin: "https://social.example", grade: "F", pages: [
    { feed: { explicit: true, reactions: 4 }, infinite: { observed: true }, media: { observed: 2, mutedStarts: 2 }, ui: { ads: 1, recommendations: 1, notificationBadges: 1 } },
    { feed: { explicit: true, reactions: 2 }, media: { observed: 1, mutedStarts: 1 }, ui: { recommendations: 1 } },
    { feed: { explicit: true, reactions: 4 }, media: { observed: 1, mutedStarts: 1 }, ui: { recommendations: 1, notificationBadges: 1, obstruction: 0.3 } },
    { feed: { explicit: true, reactions: 3 }, media: { observed: 1, mutedStarts: 1 }, ui: { recommendations: 1, controls: 1 } },
  ] },
];

const html = await readFile(new URL("extension/popup.html", root), "utf8");
const script = await readFile(new URL("extension/popup.js", root), "utf8");
if (!script.includes("void start();")) throw new Error("Popup entry point changed; update the example renderer.");
const assets = new Map();
for (const path of ["popup.css", "lib/model.js", "lib/grading.js"]) {
  assets.set(`/${path}`, await readFile(new URL(`extension/${path}`, root)));
}
for (const example of examples) {
  const pages = Object.fromEntries(example.pages.map((input, index) => {
    const snapshot = sanitizeSnapshot({ ...input, coverage: { ready: true }, media: { elements: input.media?.observed ? 1 : 0, ...input.media } }, {});
    return [index, { assessedAt: 1, lastVisitedAt: index + 1, coverage: snapshot.coverage, criteria: ruleFindings(snapshot) }];
  }));
  const data = { origin: example.origin, preferences: { ai: false }, summary: summarize({ pages }) };
  if (gradeAssessment(data.summary).letter !== example.grade) throw new Error(`Unexpected example grade: ${example.id}`);
  // Keep screenshot setup out of the shipped extension. The popup renderer and
  // styles are unchanged; only the live startup is replaced with example data.
  assets.set(`/${example.id}.js`, script.replace("void start();", `render(${JSON.stringify(data)});`));
  assets.set(`/${example.id}.html`, html.replace('src="popup.js"', `src="${example.id}.js"`));
}

await mkdir(output, { recursive: true });
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const content = assets.get(path);
  if (!content) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript");
  response.end(content);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const session = `nutrition-readme-${process.pid}`;
const exec = promisify(execFile);
const browser = (...args) => exec("agent-browser", ["--session", session, ...args]);
try {
  for (const example of examples) {
    await browser("open", `http://127.0.0.1:${server.address().port}/${example.id}.html`);
    await browser("set", "viewport", "440", "1000");
    await browser("wait", "--fn", `document.querySelector('#score-value').textContent === '${example.grade}'`);
    await browser("screenshot", ".label", fileURLToPath(new URL(`${example.id}.png`, output)));
    console.log(`${example.id}.png: ${example.grade}, ${example.pages.length} example pages`);
  }
} finally {
  await browser("close").catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
