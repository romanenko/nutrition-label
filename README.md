# Nutrition Label

A nutrition label for the web: a Chrome extension that helps people understand how a page treats their attention.

The idea is to inspect the page the user is visiting, use an AI model to help classify observable patterns, and present a familiar food-label-style breakdown of potential manipulation and attention monetization. Examples include distracting banners, autoplay video, and feeds designed to keep people scrolling.

## Current version

**0.1.0 is the bare-bones label, ready to load in Chrome.** Click the extension icon to open a black-and-white **Website Facts** label with heavy dividing rules, an overall-score placeholder, and a per-criterion breakdown.

- Shows the active website's hostname.
- Includes placeholders for content feeds, infinite scroll, autoplay media, distracting banners, attention monetization, and deceptive prompts.
- Explicitly marks all criteria as **Not assessed** and leaves the overall score blank.
- Handles unavailable tabs and browser pages without inventing a result.

There is no page analysis, feed detection, AI integration, or scoring yet. The displayed criteria are a starting point for discussion, not a settled grading system.

## Local development with hot reload

Use Node.js 24 (or Node.js 22.12+) and npm. If you use `fnm`, run `fnm use` in this folder to select the version in `.node-version`.

```sh
npm install
npm run dev
```

Keep that terminal running. Vite and CRXJS watch the source in `extension/` and generate a development extension in `dist/dev/`.

### Load it into your Chrome once

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select **`dist/dev`** inside this repository. On macOS, press **Command + Shift + G** in the folder picker to paste its full path.
3. Pin **Nutrition Label (Dev)** using Chrome's extensions menu.
4. Visit a website and click the extension icon.

If you loaded the original `extension/` folder earlier, disable that copy so you're testing **Nutrition Label (Dev)**. Edit files in `extension/`, not the generated `dist/dev/` folder.

### Iterating together

- **Layout preview:** open [http://127.0.0.1:5173/popup.html](http://127.0.0.1:5173/popup.html) in a browser or the Codex browser panel. It stays open and updates as we save changes. It displays **Label preview** because it cannot access Chrome's extension APIs.
- **Real extension:** open the toolbar popup on the website you want to inspect. CSS updates live; HTML and JavaScript changes refresh the popup. Chrome closes toolbar popups when they lose focus, so click the icon again if it closes while editing.
- **Manifest and background changes:** these may reload the entire extension. Reopen the popup afterward. If Chrome shows an extension error after changing permissions, reload it on `chrome://extensions`.
- **After a restart:** run `npm run dev` again. If the extension isn't reconnecting, reload **Nutrition Label (Dev)** on `chrome://extensions`.

The development server uses the fixed local address above. If port 5173 is occupied, it fails rather than silently changing ports. Stop the other process using that port, then restart `npm run dev`.

### Test without a development server

```sh
npm run build
```

Load **`dist/release`** as an unpacked extension. This standalone build has no hot reload or dependency on the development server. Development and release outputs are separate, so building does not overwrite the copy loaded for local development. No AI API key is needed for either version.

## Product direction

Start small and develop the criteria together. The eventual label should show what was observed, how confidently it was classified, how each criterion was graded, and exactly how those grades contributed to an overall score.

| Candidate criterion | Questions to explore later |
| --- | --- |
| Content feed | Does the page contain a feed? Is it chronological, recommended, or personalized? |
| Infinite scroll | Does more content load automatically? Is there a clear stopping point? |
| Autoplay media | Does video or audio start without an explicit play action? Is it muted and easy to stop? |
| Distracting banners | Do overlays, sticky banners, or moving elements interrupt reading or obstruct content? |
| Attention monetization | What visible evidence suggests ads, sponsored content, or engagement incentives? Is sponsorship disclosed? |
| Deceptive prompts | Do choices use misleading labels, unequal prominence, repeated pressure, or unnecessary friction? |

**A feed's presence is a fact, not automatically a negative grade.** Context matters: an intentionally opened feed, user-started video, and unsolicited autoplay should not be treated as equivalent. Visible evidence also cannot conclusively establish a website's business model or intent.

### Grading questions for a later iteration

- Which criteria should be descriptive facts, and which should affect the score?
- What does a higher score mean, and what scale is useful?
- How should frequency, intrusiveness, and user control affect each grade?
- How should grades combine, and how can the breakdown make each contribution clear?
- How should unknowns, limited coverage, and low-confidence classifications be displayed?
- What should be evaluated per page, per visit, or across an entire website?

No weights, thresholds, score direction, or model provider are chosen yet. Unknown or unassessed criteria must remain distinguishable from an observed absence. The extension should explain its evidence and avoid presenting AI inferences as proven intent.

## Roadmap

- [x] Create the private repository and document the idea.
- [x] Build a minimal extension that displays the nutrition-style label on click.
- [ ] Refine the criteria and agree on definitions together.
- [ ] Collect page signals on demand, starting with a small set of observable facts such as feed presence.
- [ ] Choose an AI model and a privacy approach for classifying ambiguous patterns.
- [ ] Design per-criterion grades and a transparent overall score.
- [ ] Show evidence, confidence, and the contribution of each criterion to the score.
- [ ] Validate against varied pages and iterate on false positives.

## Implementation

Plain HTML, CSS, and JavaScript using Chrome's Manifest V3, with Vite and CRXJS for development and packaging. The release extension's only requested permission is `activeTab`, used to read the current tab's URL after the extension is invoked. The popup displays only its hostname.

The release version has no content scripts, background worker, network requests, AI calls, analytics, or stored browsing data. During development, CRXJS adds a reload worker and access to the local development server; these are excluded from the release build. A future analysis feature should request only the access it needs, explain any data sent to a model, and keep provider secrets out of the extension bundle.

```text
extension/
  manifest.json     Extension metadata and toolbar popup
  popup.html        Nutrition-style label and proposed criteria
  popup.css         Black-and-white food-label styling
  popup.js          Active website context and fallback messages
  icons/            Toolbar icons and their SVG source
vite.config.js     Dev server, extension bundling, and output directories
dist/dev/          Generated extension for hot reload (gitignored)
dist/release/      Generated standalone extension (gitignored)
```

### Manual checks

1. Load the extension and confirm that clicking its icon opens the label.
2. Open it on two different websites and check that the hostname follows the active tab.
3. Verify that every criterion says **Not assessed**, the score is an em dash, and the status says **Not analyzed**.
4. Open it on a browser page such as `chrome://extensions`; confirm that an unavailable-page message appears and no assessment is fabricated.
5. Open the local preview URL while `npm run dev` is running; confirm that it shows a layout preview and updates when source files change.
6. Inspect the popup and check that no JavaScript errors appear.

References: [CRXJS setup](https://crxjs.dev/guide/installation/from-scratch/), [toolbar popups](https://developer.chrome.com/docs/extensions/reference/api/action), [the activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), and [loading an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world).
