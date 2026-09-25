# Label examples

These screenshots use the real popup HTML, CSS, renderer and grading rules with synthetic observations on fictional `.example` sites. They are illustrations, not assessments of real websites. Unknown criteria are hidden as in the extension.

- **Calm reading — A:** three readable pages with no feed, video or harmful category signals; stopping controls are available.
- **Recommended feed — D:** ads, recommendation wording and infinite scroll indicate three categories. Ads appear on one of three pages.
- **All four categories — F:** a feed also has autoplay and unread notification badges. Ads appear on one of four pages, and notification badges on two of four.

To regenerate after changing the popup, run `node scripts/readme-examples.mjs` from the checkout. It requires Node.js and the `agent-browser` CLI, starts a temporary local server and isolated browser, and closes both when finished. No API key or browsing history is used.
