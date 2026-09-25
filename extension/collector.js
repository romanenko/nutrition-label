import { computeAccessibleName } from "dom-accessibility-api";
import { redact } from "./lib/model.js";
import { hasNotificationBadge, isNotificationControl } from "./lib/notifications.js";

const PRIVATE = "input,textarea,[contenteditable]:not([contenteditable=false]),[role=log],[role=textbox],[data-private],[data-sensitive]";
const INTERACTIVE = "button,a,[role=button],[role=checkbox],[role=switch],[role=radio],[role=slider],input[type=checkbox],input[type=radio]";
const ARTICLE = "article,[role=article],[data-testid=tweet],[data-testid=post],.feed-shared-update-v2";
const reaction = /\b(like|unlike|heart|react|reaction|love|clap|applaud)\b/i;
const rating = /\b(upvote|downvote|rate|rating|[1-5] stars?)\b/i;
const control = /^(next( page)?|previous( page)?|load more|show more|you.?re all caught up|you.?ve reached the end|chronological|following|autoplay|turn off autoplay)$/i;
let visibilityCache = null;

function visible(element) {
  if (visibilityCache?.has(element)) return visibilityCache.get(element);
  const r = element.getBoundingClientRect();
  let left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
  let top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
  let result = r.width > 0 && r.height > 0 && left < right && top < bottom;
  for (let node = element; result && node; node = node.parentElement || node.getRootNode().host) {
    const style = getComputedStyle(node);
    if (["hidden", "collapse"].includes(style.visibility) || style.display === "none" || Number(style.opacity) === 0) { result = false; break; }
    if (node === element) continue;
    const bounds = node.getBoundingClientRect();
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
    }
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
    result = left < right && top < bottom;
  }
  visibilityCache?.set(element, result);
  return result;
}

function isPrivate(element) {
  for (let node = element; node; node = node.getRootNode().host) {
    if (node.closest(PRIVATE)) return true;
  }
  return false;
}

function name(element) {
  try { return redact(computeAccessibleName(element), 120); } catch { return redact(element.getAttribute("aria-label") || element.textContent, 120); }
}

function safeText(element, limit = 700) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts = [];
  let length = 0, walked = 0;
  while (walker.nextNode() && length < limit && walked++ < 500) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || isPrivate(parent) || parent.closest("script,style,noscript,[hidden]") || !visible(parent)) continue;
    parts.push(node.textContent);
    length += node.textContent.length;
  }
  return redact(parts.join(" "), limit);
}

function fingerprint(value) {
  let h = 2166136261;
  for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16);
}

export function createCollector(send = message => chrome.runtime.sendMessage(message)) {
  let stopped = false, grant = null, currentUrl = location.href, startedAt = Date.now(), timer, busy = false;
  let seenItems = new Set(), scrollAt = 0, manualMoreAt = 0, continuation = false, scrolled = false;
  let media = new WeakMap(), mediaCounts = { configured: 0, observed: 0, mutedStarts: 0, alreadyPlaying: 0 };
  let dismissed = new Map(), repeatedPrompts = 0;
  const attached = new Set();
  const abort = new AbortController();
  const privateContext = () => /\/(messages?|inbox|chats?|direct)(\/|$)/i.test(location.pathname) || Boolean(document.querySelector('[role=log],input[type=password]'));

  function trackVideo(video, initial = true) {
    if (!media.has(video)) {
      const playing = initial && !video.paused && !video.ended && video.currentTime > 0;
      media.set(video, { actionAt: 0, playing, source: video.currentSrc });
      if (playing) mediaCounts.alreadyPlaying++;
    }
    return media.get(video);
  }

  function onPlay(event) {
    if (!(event.target instanceof HTMLVideoElement) || stopped || !grant) return;
    const video = event.target;
    const state = trackVideo(video, false);
    if (state.playing && state.source === video.currentSrc) return;
    if (Date.now() - state.actionAt > 2500) {
      mediaCounts.observed++;
      if (video.muted || video.volume === 0) mediaCounts.mutedStarts++;
    }
    state.playing = true;
    state.source = video.currentSrc;
  }

  function onPause(event) {
    if (event.target instanceof HTMLVideoElement) trackVideo(event.target).playing = false;
  }

  function onAction(event) {
    if (!event.isTrusted || stopped || !(event.target instanceof Element)) return;
    if (event.type === "keydown" && ![" ", "Enter", "k", "K"].includes(event.key)) return;
    const target = event.composedPath().find(node => node instanceof Element) || event.target;
    const button = target.closest(INTERACTIVE);
    const label = button ? name(button) : "";
    if (/\b(load|show|see) more\b|^next\b/i.test(label)) manualMoreAt = Date.now();
    const video = target instanceof HTMLVideoElement ? target : /\b(play|resume|watch)\b/i.test(label) && !/autoplay/i.test(label) ?
      target.closest('figure,[role=group],[class*=player],[class*=video]')?.querySelector("video") : null;
    if (video) trackVideo(video).actionAt = Date.now();
    if (/\b(close|dismiss|no thanks|not now|decline|reject)\b/i.test(label)) {
      const region = target.closest('[role=dialog],dialog,[aria-modal=true]');
      if (region) dismissed.set(fingerprint(safeText(region)), { absent: false, counted: false });
    }
  }

  function onScroll(event) {
    const element = event.target === document ? document.scrollingElement : event.target;
    if (!(element instanceof Element)) return;
    scrolled = true;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < Math.max(200, element.clientHeight * 0.7)) scrollAt = Date.now();
  }

  function attach(root) {
    if (attached.has(root)) return;
    attached.add(root);
    const options = { capture: true, passive: true, signal: abort.signal };
    root.addEventListener("play", onPlay, options);
    root.addEventListener("pause", onPause, options);
    root.addEventListener("ended", onPause, options);
    root.addEventListener("pointerdown", onAction, options);
    root.addEventListener("keydown", onAction, options);
    root.addEventListener("scroll", onScroll, options);
  }
  attach(document);

  function elements() {
    const all = [], roots = [document];
    for (let i = 0; i < roots.length && all.length < 5000; i++) {
      const root = roots[i];
      attach(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode() && all.length < 5000) {
        const node = walker.currentNode;
        all.push(node);
        let shadow = node.shadowRoot;
        try { shadow ||= globalThis.chrome?.dom?.openOrClosedShadowRoot(node); } catch { /* Unsupported root. */ }
        if (shadow && !roots.includes(shadow)) roots.push(shadow);
      }
    }
    return all;
  }

  function snapshot() {
    visibilityCache = new WeakMap();
    const all = elements();
    const shown = all.filter(element => !isPrivate(element) && visible(element));
    const feeds = shown.filter(element => element.getAttribute("role") === "feed");
    let cards = all.filter(element => element.matches(ARTICLE) && !isPrivate(element));
    if (feeds.length) {
      cards = feeds.flatMap(feed => {
        const articles = [...feed.querySelectorAll(ARTICLE)];
        return articles.length ? articles : [...feed.children].filter(child => child.children.length > 0);
      });
    }
    if (!cards.length) {
      // Repeated sibling cards with time or reaction controls; never a whole-page text match.
      const parents = new Map();
      for (const element of shown.filter(el => el.matches("time,[role=button],button")).slice(0, 250)) {
        if (element.tagName !== "TIME" && !reaction.test(name(element))) continue;
        const card = element.closest("li") || element.parentElement?.parentElement;
        if (card?.parentElement) {
          const siblings = parents.get(card.parentElement) || new Set();
          siblings.add(card); parents.set(card.parentElement, siblings);
        }
      }
      cards = [...parents.values()].filter(group => group.size >= 3).flatMap(group => [...group]);
    }
    cards = [...new Set(cards)].filter(card => !isPrivate(card) && !cards.some(other => other !== card && other.contains(card))).slice(0, 100);
    const feedCandidate = feeds.length > 0 || cards.length >= 3;
    if (!feedCandidate) cards = [];
    const visibleCards = cards.filter(visible);
    const controls = shown.filter(el => el.matches(INTERACTIVE)).slice(0, 250);
    const names = new Map(controls.map(el => [el, name(el)]));
    const inFeed = element => cards.some(card => card.contains(element)) || feeds.some(feed => feed.contains(element));
    const identities = cards.map(card => fingerprint(card.getAttribute("data-id") || card.getAttribute("data-urn") ||
      card.getAttribute("aria-posinset") || card.querySelector("a[href]")?.getAttribute("href") || (card.textContent || "").slice(0, 150)));
    if (seenItems.size && identities.some(id => !seenItems.has(id)) && Date.now() - scrollAt < 3500 && Date.now() - manualMoreAt > 5000) continuation = true;
    for (const id of identities) { if (seenItems.size < 1000) seenItems.add(id); }
    const videos = all.filter(element => element instanceof HTMLVideoElement);
    for (const video of videos) trackVideo(video);
    mediaCounts.configured = videos.filter(video => video.autoplay).length;

    const overlays = shown.filter(element => {
      if (element.matches("nav,header") || element.closest("nav")) return false;
      const style = getComputedStyle(element);
      const r = element.getBoundingClientRect();
      return ((element.matches('[role=dialog],dialog[open],[aria-modal=true]')) || ["fixed", "sticky"].includes(style.position)) && r.width * r.height > innerWidth * innerHeight * 0.08;
    }).filter((element, _, array) => !array.some(parent => parent !== element && parent.contains(element))).slice(0, 6);
    let covered = 0;
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) {
      const point = document.elementFromPoint((x + 0.5) * innerWidth / 10, (y + 0.5) * innerHeight / 10);
      if (overlays.some(element => element === point || element.contains(point))) covered++;
    }
    const snippets = shown.filter(element => element.children.length < 2 && element.textContent?.trim().length < 100).map(element => safeText(element, 100)).filter(Boolean);
    const labels = [...names.values(), ...snippets];
    const promptIds = new Set(overlays.map(element => fingerprint(safeText(element))));
    for (const [id, state] of dismissed) {
      if (!promptIds.has(id)) state.absent = true;
      else if (state.absent && !state.counted) { repeatedPrompts++; state.counted = true; }
    }
    const result = {
      feed: { explicit: feeds.length > 0, candidate: feedCandidate, items: visibleCards.length,
        reactions: controls.filter(el => inFeed(el) && reaction.test(names.get(el))).length,
        ratings: controls.filter(el => inFeed(el) && rating.test(names.get(el))).length },
      media: { ...mediaCounts }, infinite: { observed: continuation, scrolled },
      ui: { overlays: overlays.length, obstruction: covered / 100, repeatedPrompts,
        ads: new Set(labels.filter(text => /^(ad|advertisement|sponsored|promoted|paid partnership|sponsored content)(\s*[:·|].*)?$/i.test(text))).size,
        recommendations: labels.filter(text => /^(for you|recommended( for you)?|suggested( for you)?|because you (watched|liked).*)$/i.test(text)).length,
        notifications: labels.filter(text => /\b(enable|allow|turn on|get|receive) (push )?notifications\b/i.test(text)).length,
        notificationBadges: controls.filter(el => isNotificationControl(names.get(el)) && hasNotificationBadge(names.get(el),
          [...el.querySelectorAll("*")].slice(0, 40).filter(child => !child.children.length && !isPrivate(child) && visible(child))
            .map(child => safeText(child, 60)))).length,
        streaks: labels.filter(text => /\b(\d+[- ]day streak|daily reward|keep your streak|lose your streak)\b/i.test(text)).length,
        controls: labels.filter(text => control.test(text)).length },
      coverage: { frames: shown.filter(el => el.matches("iframe,frame")).length,
        unlabeled: controls.filter(el => !names.get(el)).length, limited: all.length >= 5000,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000), privateContext: privateContext() },
      regions: [], items: [],
    };
    if (grant?.ai && !privateContext()) {
      result.regions = overlays.map(element => ({ kind: "prompt", text: safeText(element), coverage: covered / 100,
        actions: [...element.querySelectorAll(INTERACTIVE)].slice(0, 8).map(name) }));
      if (feedCandidate && !feeds.length) result.regions.push({ kind: "feed", text: visibleCards.slice(0, 3).map(card =>
        `${card.tagName.toLowerCase()}; controls: ${[...card.querySelectorAll(INTERACTIVE)].slice(0, 5).map(name).join(", ")}; time: ${Boolean(card.querySelector("time"))}`).join(" | "), actions: [] });
      if (grant.feedText) result.items = visibleCards.slice(0, 12).map(card => ({ text: safeText(card) }));
    }
    visibilityCache = null;
    return result;
  }

  async function begin() {
    if (stopped || document.visibilityState !== "visible" || document.prerendering) return false;
    try {
      const reply = await send({ type: "COLLECTOR_HELLO", visible: true });
      if (!reply?.ok || !reply.allowed) { stop(); return false; }
      grant = reply;
      return true;
    } catch { stop(); return false; }
  }

  async function tick() {
    if (stopped || busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      if (location.href !== currentUrl) {
        currentUrl = location.href; grant = null; startedAt = Date.now(); seenItems = new Set();
        media = new WeakMap(); mediaCounts = { configured: 0, observed: 0, mutedStarts: 0, alreadyPlaying: 0 };
        continuation = false; scrolled = false; scrollAt = 0; dismissed = new Map(); repeatedPrompts = 0;
      }
      if (!grant && !(await begin())) return;
      const reply = await send({ type: "OBSERVATION", scanId: grant.scanId, snapshot: snapshot() });
      if (!reply?.ok || !reply.allowed) stop();
      else { grant.ai = reply.ai; grant.feedText = reply.feedText; }
    } catch { stop(); } finally { busy = false; }
  }

  function stop() { stopped = true; clearInterval(timer); abort.abort(); }
  function rescan() { grant = null; return tick(); }
  timer = setInterval(tick, 2500);
  document.addEventListener("visibilitychange", tick, { signal: abort.signal });
  window.addEventListener("pageshow", tick, { signal: abort.signal });
  void tick();
  return { stop, rescan, snapshot, get stopped() { return stopped; } };
}

export function onExecute() {
  if (globalThis.__nutritionCollector && !globalThis.__nutritionCollector.stopped) {
    void globalThis.__nutritionCollector.rescan();
    return;
  }
  globalThis.__nutritionCollector = createCollector();
}

if (globalThis.chrome?.runtime?.id) {
  onExecute();
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "STOP_COLLECTOR" && (!message.origin || message.origin === location.origin)) globalThis.__nutritionCollector?.stop();
    if (message.type === "RESCAN_COLLECTOR") {
      if (globalThis.__nutritionCollector?.stopped) onExecute();
      else void globalThis.__nutritionCollector?.rescan();
    }
  });
}
