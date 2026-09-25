import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SourceTextModule, createContext } from "node:vm";

const extensionId = "fixture-extension";
const ui = { id: extensionId, url: `chrome-extension://${extensionId}/options.html` };
const area = () => {
  const state = {};
  return { state, access: null,
    async setAccessLevel({ accessLevel }) { this.access = accessLevel; },
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(state[key])])); },
    async set(value) { Object.assign(state, structuredClone(value)); },
    async remove(key) { delete state[key]; },
  };
};
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
async function harness(fetcher = async () => { throw new Error("Unexpected network request"); }) {
  const tab = { id: 1, active: true, incognito: false, url: "http://127.0.0.1:5173/page" };
  const storage = { local: area(), session: area() };
  const chrome = {
    storage,
    runtime: { id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`, onMessage: event(), onInstalled: event(), onStartup: event() },
    permissions: { contains: async () => true, onRemoved: event(), onAdded: event() },
    tabs: { get: async () => ({ ...tab }), query: async () => [{ ...tab }], sendMessage: async () => {}, onRemoved: event(), onActivated: event() },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
  };
  const context = createContext({ chrome, crypto, TextEncoder, TextDecoder, URL, btoa, atob, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: fetcher });
  const cache = new Map();
  async function load(url) {
    if (cache.has(url)) return cache.get(url);
    let source = await readFile(new URL(url), "utf8");
    if (url.endsWith("/background.js")) source = source.replace(/^import collectorFile[^\n]+\n/, 'const collectorFile = "collector.js";\n');
    const module = new SourceTextModule(source, { context, identifier: url });
    cache.set(url, module);
    return module;
  }
  const main = await load(new URL("../extension/background.js", import.meta.url).href);
  await main.link((specifier, module) => load(new URL(specifier, module.identifier).href));
  await main.evaluate();
  const send = (message, sender = ui) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, sender, resolve));
  const sender = () => ({ id: extensionId, tab: { ...tab }, url: tab.url, frameId: 0, documentId: "document-one" });
  return { send, sender, tab, storage };
}
const snapshot = { feed: { explicit: true, candidate: true, reactions: 2 }, regions: [{ kind: "prompt", text: "private-fixture-text", actions: ["No thanks"] }], items: [] };

test("page collectors cannot save, unlock, read credentials or change preferences", async () => {
  const h = await harness();
  for (const type of ["KEY_SAVE", "KEY_UNLOCK", "SETTINGS_GET", "PREFERENCES_SET", "KEY_TEST"]) {
    const response = await h.send({ type, apiKey: "dummy-fixture-key", mode: "session", ai: true }, h.sender());
    assert.equal(response.ok, false);
  }
  assert.equal(h.storage.session.state.jevUnlockedV1, undefined);
  assert.equal(h.storage.local.access, "TRUSTED_CONTEXTS");
  assert.equal(h.storage.session.access, "TRUSTED_CONTEXTS");
});

test("an on-click grant binds observations to the current top document, route and origin", async () => {
  const h = await harness();
  assert.equal((await h.send({ type: "COLLECTOR_HELLO", visible: true }, h.sender())).ok, false);
  assert.equal((await h.send({ type: "SCAN", tabId: 1 })).ok, true);
  const hello = await h.send({ type: "COLLECTOR_HELLO", visible: true }, h.sender());
  assert.equal(hello.allowed, true);
  assert.equal((await h.send({ type: "OBSERVATION", scanId: hello.scanId, snapshot }, { ...h.sender(), frameId: 2 })).ok, false);
  assert.equal((await h.send({ type: "OBSERVATION", scanId: hello.scanId, snapshot }, h.sender())).allowed, true);
  const label = await h.send({ type: "LABEL_GET", tabId: 1 });
  assert.equal(label.summary.visited, 1); assert.equal(label.summary.criteria.feed.detected, 1);
  assert.ok(!JSON.stringify(h.storage.local.state).includes("private-fixture-text"));
  const replacement = await h.send({ type: "COLLECTOR_HELLO", visible: true }, { ...h.sender(), documentId: "document-two" });
  assert.equal(replacement.allowed, true);
  assert.equal((await h.send({ type: "OBSERVATION", scanId: hello.scanId, snapshot }, h.sender())).allowed, false);
  assert.equal((await h.send({ type: "LABEL_GET", tabId: 1 })).summary.visited, 1);
  h.tab.url = "http://127.0.0.1:5174/page";
  assert.equal((await h.send({ type: "COLLECTOR_HELLO", visible: true }, h.sender())).ok, false);
});

test("reset removes grants and late observations cannot recreate deleted history", async () => {
  const h = await harness();
  await h.send({ type: "SCAN", tabId: 1 });
  const hello = await h.send({ type: "COLLECTOR_HELLO", visible: true }, h.sender());
  await h.send({ type: "SITE_RESET", tabId: 1 });
  assert.equal((await h.send({ type: "OBSERVATION", scanId: hello.scanId, snapshot }, h.sender())).ok, false);
  assert.equal(Object.keys(h.storage.local.state.assessmentsV1).length, 0);
});

test("SPA routes use the current tab URL when Chrome reports the original sender URL", async () => {
  const h = await harness();
  await h.send({ type: "SCAN", tabId: 1 });
  const sender = h.sender();
  await h.send({ type: "COLLECTOR_HELLO", visible: true }, sender);
  h.tab.url = "http://127.0.0.1:5173/next-route";
  assert.equal((await h.send({ type: "COLLECTOR_HELLO", visible: true }, sender)).allowed, true);
  assert.equal((await h.send({ type: "LABEL_GET", tabId: 1 })).summary.visited, 2);
  assert.equal((await h.send({ type: "COLLECTOR_HELLO", visible: true }, { ...sender, documentLifecycle: "cached" })).ok, false);
});

test("locking during a Jev request prevents its late result from being applied", async () => {
  let respond, started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const h = await harness(async () => { started(); return new Promise(resolve => { respond = resolve; }); });
  await h.send({ type: "KEY_SAVE", apiKey: "dummy-fixture-key", mode: "session" });
  await h.send({ type: "PREFERENCES_SET", ai: true, feedText: false });
  await h.send({ type: "SCAN", tabId: 1 });
  const hello = await h.send({ type: "COLLECTOR_HELLO", visible: true }, h.sender());
  await h.send({ type: "OBSERVATION", scanId: hello.scanId, snapshot }, h.sender());
  await requestStarted;
  await h.send({ type: "KEY_LOCK" });
  respond(new Response(JSON.stringify({ model: "jev-1.13.0", answers: { deception_0: { type: "noul", noul: 0.99 } } })));
  await new Promise(resolve => setTimeout(resolve, 20));
  const label = await h.send({ type: "LABEL_GET", tabId: 1 });
  assert.equal(label.summary.criteria.deception.detected, 0);
  assert.equal(h.storage.session.state.jevUnlockedV1, undefined);
});
