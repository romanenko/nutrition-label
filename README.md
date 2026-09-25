# Nutrition Label

A nutrition label for the web: a Chrome extension that shows how the pages you visit compete for your attention. Inspired by [Vlada Bortnik's technology nutrition labels](https://www.linkedin.com/pulse/weve-been-talking-big-techs-tobacco-moment-years-lets-vlada-jpt2c).

## Version 0.2

The **Website Facts** popup collects real observations. It combines local DOM and behavior measurements with optional text-only Jev classification using your own API key.

| Criterion | Implemented method |
| --- | --- |
| Content feed | Explicit feed semantics; repeated article/card candidates; Jev classification of ambiguous structure. |
| Infinite scroll | New item identities after a near-end scroll, without a recent Load more action. |
| Likes, hearts, reactions | Named interactive controls within feed candidates. |
| Stars, ratings, votes | Named interactive rating/vote controls within feed candidates. |
| Political topics, hateful language, provocative framing | Three independent Jev questions for sampled visible feed items; requires separate feed-text opt-in. |
| Autoplay video | Starts without a matching recent play action. Muted starts count; already-playing video and autoplay attributes alone remain unknown. |
| Obstructive banners | Large visible fixed/sticky panels and dialogs, with approximate viewport obstruction. |
| Ads and sponsorship | Visible ad/sponsorship labels. |
| Deceptive prompts | Jev classifies wording from candidate prompts and action labels. |
| Recommendations, notification prompts, streaks/rewards | Visible wording rules. |
| Stopping points and controls | Pagination, Load more, caught-up, ordering and autoplay-control wording. |

**Overall grades and weights are intentionally pending.** A feed or political topic is a descriptive fact. Observed unsolicited autoplay is marked as a negative factor. Model probability is experimental, not a calibrated accuracy, severity or harm score. Findings use a 90% positive threshold, results at 10% or below can count as not observed, and the middle remains unknown. A written AI explanation is not required.

### Serving size and coverage

Serving size counts distinct pages visited while observation is active on the exact origin (scheme, host and port). Reloads and revisits update the same page. Known tracking parameters and ordinary anchors are ignored; meaningful queries and hash-router paths are retained. Raw paths are stored only as device-keyed digests.

The label shows **detected pages / pages assessed for that criterion**. Criteria that remain entirely unknown are hidden; assessed criteria with zero detections stay visible. Inspection details include remaining coverage gaps for visible rows. Local assessment coverage means a DOM snapshot was collected, not that every criterion was resolved. Positive findings remain in that page's sample until reset, even if a banner disappears or playback stops. This is an accumulating observation record, not a live absence guarantee or an assessment of the entire website.

## Local development with hot reload

Use Node.js 24 (or 22.12+) and npm. With `fnm`, run `fnm use` in this folder.

```sh
npm install
npm run dev
```

Keep the terminal running. Vite and CRXJS build into `dist/dev` as you edit `extension/`.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select `/Users/michael/Developer/nutrition-label/dist/dev` (or your checkout's `dist/dev`). On macOS, use **Command + Shift + G** in the picker to paste a path.
3. Disable any older copy loaded from `extension/` or `dist/release`. Pin **Nutrition Label (Dev)**.
4. Open a regular website and click the extension. It begins a two-minute observation window. Scroll and use the page normally, then reopen the popup to see findings.
5. Enable **Assess this site as I browse** to collect on future visits and route changes. Chrome asks for that site's access and navigation permission. Other origins need their own opt-in.

If you already have the extension loaded, **reload it once on `chrome://extensions` after this upgrade**, then reload the website tab. New permissions and the collector require a fresh extension instance.

- **Layout preview:** [http://127.0.0.1:5173/popup.html](http://127.0.0.1:5173/popup.html). Updates on save; Chrome extension APIs are unavailable here. Settings preview disables credential entry.
- **Real extension:** CSS updates live; JavaScript/HTML changes refresh the popup. Reopen it if Chrome closes it. Background/manifest changes can reload the whole extension; refresh the inspected page to replace its collector.
- **After restarting:** run `npm run dev` and reload the extension if it is not reconnecting. Session keys are cleared by an extension reload; saved encrypted keys must be unlocked again.

The server uses port 5173 and fails if it is occupied, rather than selecting a different port.

### Standalone build

```sh
npm run build
```

Load `dist/release` as an unpacked extension. It needs no development server. Building does not overwrite `dist/dev`. Local detection works without a Jev key.

## Jev settings

Open **Jev & settings** beneath the label, or the extension's **Options** from Chrome's extension menu.

1. Paste your TypeSafe API key into the installed extension's settings.
2. Choose **For this browser session**, or **Encrypted on this device** with a passphrase of 12–256 characters.
3. Save. This makes no API request. **Test connection** optionally sends a small synthetic request using your API credits.
4. Enable **Use Jev for classification** and save analysis preferences. Chrome requests access to `api.typesafe.ai`.
5. Enable **Include sampled feed text** separately for political topics, hateful language and provocative framing.

Calls go directly from the extension worker to the fixed TypeSafe endpoint using `jev-1.13.0`. Up to 12 visible feed items and a few candidate prompt/structure records are sent per batch. Text is bounded and common links, emails, long numbers and credential-like strings are redacted. Recognized private-message paths, password forms and chat logs suppress text upload. These are heuristics, not a guarantee that public or personalized page text contains no personal information; enable feed-text analysis only for pages you want to share with TypeSafe.

The worker limits automatic classification to 3 batches per page and 60 total per hour in a browser session. Unchanged input is cached; changed input may require another batch. Local measurements continue when the key is locked, the service fails or a request limit is reached. No request is made just by saving a key.

### Storage and privacy

- Session keys stay in restricted `chrome.storage.session`. Persistent keys use AES-256-GCM encryption with a fresh salt/IV and a PBKDF2-SHA-256 passphrase key (600,000 iterations). The passphrase is not stored.
- Both storage areas exclude content scripts. Only trusted extension pages can issue credential commands; no message returns the key. The inspected website never receives it.
- **Lock** clears the unlocked session and aborts requests. **Forget key** removes stored copies; revoke at TypeSafe to invalidate the provider credential.
- Page text is transient. Local records contain origin names, keyed page digests, dates, findings, probabilities, coverage and versions. Origins and findings can still reveal browsing interests. Nothing is synced to your Google account.
- **Reset this site** or **Clear all assessments & stop following** deletes observations independently of your key. History is capped at 1,000 pages and a conservative storage limit; collection pauses when full instead of silently dropping pages.
- Incognito assessment is disabled. There is no analytics backend. A compromised extension or device can access an unlocked key; passphrase encryption protects the locked saved copy.

Chrome host grants cover a scheme/host across ports. The worker still enforces exact-origin opt-in before accepting observations. Turning off following stops collection but retains Chrome's host permission; revoke that grant in Chrome's extension settings if desired.

## Testing

```sh
npm test
npm run build
```

Tests cover encrypted storage and failure states, content-script authorization, navigation/page identity, reset and late responses, input bounds, redaction, uncertainty and mocked Jev transport. They require no API key and make no paid requests.

For manual checks, visit [the local fixture](http://127.0.0.1:5173/fixture.html?page=one) while Vite runs. This synthetic page is excluded from the release build. Avoid editing source during a navigation test because hot reload resets the fixture.

1. Open the extension: feed, reaction/rating controls and visible sponsorship/prompt wording should be found. Jev-only rows remain unknown and hidden with AI off.
2. Scroll inside the bordered feed to its end. New items arrive; infinite scroll should become detected.
3. Click **Play video**: this is user-started playback. Pause, wait at least three seconds, then click **Schedule video**: the unsolicited muted start should be detected as a negative factor.
4. Enable site following; visit **Page two**, then **SPA route**. Serving size becomes three. Reload or revisit; the count stays three.
5. Try an unrelated origin: it has a separate assessment. Reset the fixture site: its saved findings disappear and following stops.
6. Use a dummy key to exercise encrypted Save, Lock, wrong-passphrase rejection, Unlock and Forget. Do not test a dummy key against the provider.
7. Open `chrome://extensions` and the localhost layout preview: neither should produce a fabricated page assessment or accept a real API key in the preview.

Verified in Chrome with the synthetic fixture: local feed/reaction/rating detection, infinite scroll, user-started versus unsolicited muted video, origin counting through full and SPA navigation, reload deduplication, restricted content-script storage, and the encrypted-key lifecycle. A user-provided key also passed the live connection test and returned classifications for synthetic feed text. Browser checks on a synthetic fixture validate mechanics, not real-world detection accuracy; representative Jev evaluation remains future work.

## Current limits and next steps

This is a first detector implementation. It inspects the top document and accessible shadow roots, with a 5,000-element cap and sampling about every 2.5 seconds while visible. It does not inspect iframe contents, perform OCR, transcribe video/audio, reconstruct Chrome's full accessibility tree, analyze network trackers or use maintained ad-blocking lists. Unnamed icons and non-English controls can be missed. Brief events before injection or between samples may be missed. Custom or delayed play controls can be misclassified. Overlay presence does not establish manipulative purpose, and a finite scroll observation cannot prove a feed is endless.

Next: evaluate false positives and Jev thresholds on representative pages, refine criteria with the user, then define grading weights and transparent score contributions. The broader [detection research](docs/detection-research.md), [origin design](docs/origin-assessments.md) and [key storage design](docs/jev-key-storage.md) include future work beyond this version.

```text
extension/
  background.js    Permissions, assessments, request budgets and credential commands
  collector.js     Local DOM, accessible-name and behavior observations
  lib/             Rules, identity/aggregation, Jev client and encrypted vault
  popup.*          Nutrition-style label
  options.*        Keys, privacy preferences and assessment management
  fixture.html     Local synthetic detector test page
tests/             Unit and worker integration tests
vite.config.js     Development and standalone packaging
dist/              Generated builds (gitignored)
```
