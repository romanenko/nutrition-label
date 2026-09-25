# Serving size across a website

Design date: September 24, 2026. Implemented in version 0.2: exact-origin assessments, keyed page identities, distinct serving size, per-criterion coverage, optional following and independent reset. Overall scores remain deferred. The [README](../README.md) describes current behavior and verification.

Implementation choices: local coverage means at least one collected snapshot; it does not imply semantic/media coverage. Positive findings accumulate until reset. Page identities ignore common tracking parameters and ordinary anchors, retaining meaningful queries and hash-router routes. Collection is bounded to 1,000 pages and approximately 7 MB of serialized records. Automatic rubric migration, retention/decay and comprehensive back/forward-cache evaluation remain future work.

## Product behavior

Make serving size the number of distinct pages visited on the given origin while assessment is enabled. The count accumulates locally through the current origin assessment, across tabs and browser sessions, until the user resets it. Reopening the popup or reloading a page updates that page's observations without adding another distinct page.

Example label:

```text
Website Facts
example.com
Serving size              5 pages visited
Assessment coverage       4 of 5 pages
Overall score             Pending grading rules
Autoplay media            Detected on 2 of 4 assessed pages
```

These are invented numbers illustrating the design. Each criterion has its own coverage: a page may be assessed for banners while autoplay remains unknown. The overall coverage line needs a defined minimum assessment contract before implementation; it must not imply every criterion was observed equally.

Update the origin label whenever a new page is visited or its assessment changes. A future overall score should be recomputed from the latest eligible page findings; simply incrementing serving size must not improve or worsen it. A locked Jev key, failed request or unsupported frame adds uncertainty, never a clean result.

## Scope and page identity

Use the browser's exact origin: scheme, host and effective port. Treat `example.com`, `www.example.com`, `app.example.com`, HTTP and HTTPS as separate assessments. Show the scheme or port in the UI when needed to distinguish them. Do not merge sites based only on a registrable domain.

“Visited” means a top-level page actually activated and visible while the feature is enabled. Background prefetches, prerendered pages, iframes and redirect hops do not add servings. A new background tab is counted when it is first viewed. We cannot recover visits from before enabling the feature, and do not request browser-history access.

Default counting rule: one distinct page/route per origin assessment. Keep a separate visit count if we later decide repeated exposure should affect scoring. Back/forward visits and another tab showing the same page refresh that page's record.

Derive a page identity from a normalized route, then persist only a keyed digest:

- Preserve path case and meaningful query parameters; dropping every query string would merge different search/product pages.
- Remove only a small, versioned list of known tracking parameters. Do not use an arbitrary page-supplied canonical URL as the identity.
- Ignore ordinary scroll-anchor fragments. Preserve recognized hash routes; record uncertainty for unsupported routing conventions.
- Include the normalization version in the identity. Compute an HMAC using a random local installation secret; raw paths, query values and fragments stay transient and never go to Jev merely to identify a page.

This is pseudonymous local bookkeeping, not anonymization. Origin names and repeated-page relationships are still browsing data. A person with access to the browser profile can access the installation secret; it is not the credential vault's encryption key.

## Following navigation

The initial on-click scanner uses `activeTab` and `scripting`. Chrome's temporary grant can continue across navigation within the same origin in that tab, but it does not automatically run the collector in each new document or authorize persistent monitoring of every tab. [activeTab][active-tab]

For automatic assessment across visits, add **Assess this site as I browse**. Request host access only for that site's scheme/host and register a content script for it. Match patterns and application origin checks have different granularity; enforce the exact origin again in the collector and worker, including ports. Stop and unregister when access is revoked. [Scripting API][scripting] · [Match patterns][match-patterns]

For reliable SPA navigation, optionally request `webNavigation` when enabling this mode. Handle committed top-level documents, History API changes and fragment changes, plus back/forward cache restoration. Treat these as candidate transitions; count only after activation/visibility and route deduplication. An extension reload or worker restart must not duplicate a visit. This permission is broader than one site, so filter events to enabled origins immediately and store nothing about other origins. [Web Navigation API][web-navigation]

Content-script startup handles ordinary document loads. Use navigation events to schedule a fresh snapshot after SPA changes; mutations alone are not navigation. Associate observations with the browser-provided document identity and a route revision so a late response from the previous page cannot overwrite the current page's record. Popup closure must not stop an enabled collector.

Turning off automatic assessment stops collection and model requests; it retains existing summaries until Reset. If permission is declined, on-click assessment remains available, with the count explicitly scoped to pages inspected that way.

## Local records and aggregation

Keep origin summaries and compact per-page findings under restricted extension storage, separately from the encrypted credential. Use one worker-owned write path to serialize updates and avoid lost counts from two tabs; persist recoverable page records and derive summaries so a worker interruption cannot leave an inflated counter.

Suggested schema:

```text
origin assessment
  schemaVersion, assessmentId, origin, startedAt, updatedAt
  enabled, pageIdentityVersion, distinctVisitedCount
  pages[pageDigest]
    firstVisitedAt, lastVisitedAt, lastAssessedAt
    observationRevision, detectorVersion, promptVersion, modelVersion
    criteria[criterion]
      result, method, probability?, coverage, measuredFacts
  criterionSummary[criterion]
    assessedPageCount, detectedPageCount, unknownPageCount
```

Store compact classifications and numeric measurements; raw page text and model payloads are transient by default. Internal evidence needed during evaluation can be kept in an explicit local diagnostic session rather than retaining every page's text. Cache results only for matching state and detector/model versions.

For an initial site breakdown, show counts such as **2 of 4 assessed pages**. Keep the probability attached to the specific classification that produced it. Do not average probabilities into a health score, treat cards as independent evidence, or let reloading one page repeatedly dominate the result. Preserve strongest observed findings alongside prevalence so averaging later cannot hide a severe event.

Keep feed-item denominators separate from page denominators: “3 of 12 sampled items use provocative framing” is different from “2 of 5 pages have a feed.” Likes/hearts/ratings, infinite scroll and feed-content classifications belong under Content feed. Observed unsolicited video autoplay is already designated a negative factor; its weight remains open.

The severity rubric, relative weights, decay policy and overall score formula remain deferred. Version changes should mark incompatible results stale until reassessed, rather than silently mixing different rubrics. Store timestamps so the label can make the age and scope of its sample clear.

## Retention and failure behavior

Provide Reset this site and Clear all assessments, separately from Forget Jev key. Preserve counts until reset rather than silently changing the meaning of “pages visited.” When storage capacity is reached, stop adding records and show that collection is paused; do not silently evict identities and later double-count them. A later retention policy should be an explicit product choice.

Disable persistent assessment in incognito. If an incognito mode is added later, it needs a separate transient store and must not merge observations into the regular profile. Chrome's privacy guidance recommends not saving browsing history from incognito windows. [Privacy guidance][privacy]

Verification should cover duplicate tabs, reloads, back/forward cache, redirects, background tabs, hash routers, query-based pages, worker restarts, revoked permissions and late AI responses. Confirm that visiting another origin changes the label's context immediately, while an outstanding result remains attached to its original assessment.

[active-tab]: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
[scripting]: https://developer.chrome.com/docs/extensions/reference/api/scripting
[match-patterns]: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
[web-navigation]: https://developer.chrome.com/docs/extensions/reference/api/webNavigation
[privacy]: https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy
