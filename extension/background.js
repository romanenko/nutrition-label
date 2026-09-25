import collectorFile from "./collector.js?script";
import { createVault } from "./lib/vault.js";
import { API_ORIGIN, buildQuestions, parseAnswers, PROMPT_VERSION, requestJev } from "./lib/jev.js";
import { sanitizeSnapshot, ruleFindings } from "./lib/detection.js";
import { defaults, DETECTOR_VERSION, MODEL, originOf, hostPattern, pageDigest, retainDetected, summarize, toBase64, touchPage } from "./lib/model.js";

const jobs = new Map();
const cancelJobs = origin => {
  for (const [id, job] of jobs) if (!origin || job.origin === origin) { job.controller.abort(); jobs.delete(id); }
};
const vault = createVault(chrome.storage, () => cancelJobs());
let queue = Promise.resolve();
function serial(operation) {
  const result = queue.then(async () => { await vault.ready; return operation(); });
  queue = result.catch(() => {});
  return result;
}
async function data() {
  const stored = await chrome.storage.local.get(["assessmentsV1", "preferencesV1", "identityV1"]);
  if (!stored.identityV1) {
    stored.identityV1 = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await chrome.storage.local.set({ identityV1: stored.identityV1 });
  }
  return { origins: stored.assessmentsV1 || {}, preferences: { ...defaults(), ...stored.preferencesV1 }, identity: stored.identityV1 };
}
async function saveOrigins(origins) {
  if (JSON.stringify(origins).length > 7_000_000) throw new Error("Assessment storage is full. Reset a site to continue.");
  await chrome.storage.local.set({ assessmentsV1: origins });
}
async function sessions() { return (await chrome.storage.session.get("scansV1")).scansV1 || {}; }
async function saveSessions(value) { await chrome.storage.session.set({ scansV1: value }); }
async function hash(value) {
  return toBase64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function ensureOrigin(store, origin) {
  store.origins[origin] ||= { id: crypto.randomUUID(), origin, startedAt: Date.now(), enabled: false, pages: {} };
  return store.origins[origin];
}
async function ensurePage(store, origin, url) {
  const assessment = ensureOrigin(store, origin);
  const digest = await pageDigest(store.identity, url);
  const total = Object.values(store.origins).reduce((sum, value) => sum + Object.keys(value.pages).length, 0);
  if (!assessment.pages[digest] && total >= 1000) throw new Error("Assessment storage is full. Reset a site to continue.");
  const page = touchPage(assessment, digest);
  return { assessment, digest, page };
}

function trustedPage(sender, paths) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  url.search = ""; url.hash = "";
  return paths.some(path => url.href === chrome.runtime.getURL(path));
}
async function validTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Choose a website tab.");
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito) throw new Error("Assessment is disabled in incognito.");
  originOf(tab.url);
  return tab;
}
async function collectorContext(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !sender.documentId) throw new Error("Unrecognized page collector.");
  const tab = await validTab(sender.tab.id);
  if (!tab.active || !sender.url || originOf(sender.url) !== originOf(tab.url) || (sender.documentLifecycle && sender.documentLifecycle !== "active")) throw new Error("This page is no longer active.");
  if (chrome.webNavigation?.getFrame && await chrome.permissions.contains({ permissions: ["webNavigation"] })) {
    const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
    if (!frame || frame.documentId !== sender.documentId) throw new Error("This document is no longer active.");
  }
  const origin = originOf(tab.url);
  const store = await data();
  const scans = await sessions();
  const prior = scans[tab.id];
  const followed = store.origins[origin]?.enabled && await chrome.permissions.contains({ origins: [hostPattern(origin)] });
  if (!followed && !(prior?.origin === origin && prior.expiresAt > Date.now())) throw new Error("Click Analyze page to start a new observation window.");
  return { tab, origin, store, scans, prior, followed };
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [collectorFile] });
  } catch { throw new Error("Chrome cannot inspect this page. Try another website or reload the tab."); }
}
async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message)));
}

async function reconcileRegistrations() {
  const store = await data();
  const existing = (await chrome.scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith("nutrition-"));
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map(script => script.id) });
  const registrations = [];
  for (const assessment of Object.values(store.origins)) {
    if (!assessment.enabled) continue;
    if (!(await chrome.permissions.contains({ origins: [hostPattern(assessment.origin)] }))) {
      assessment.enabled = false;
      cancelJobs(assessment.origin);
      await broadcast({ type: "STOP_COLLECTOR", origin: assessment.origin });
      continue;
    }
    registrations.push({ id: `nutrition-${(await pageDigest(store.identity, assessment.origin)).slice(0, 24)}`,
      matches: [hostPattern(assessment.origin)], js: [collectorFile], runAt: "document_start", persistAcrossSessions: true });
  }
  if (registrations.length) await chrome.scripting.registerContentScripts(registrations);
  await saveOrigins(store.origins);
}

async function handleCollector(message, sender) {
  const context = await collectorContext(sender);
  const { tab, origin, store, scans, prior, followed } = context;
  if (message.type === "COLLECTOR_HELLO") {
    if (message.visible !== true) return { allowed: false };
    const { assessment, digest } = await ensurePage(store, origin, tab.url);
    const scanId = crypto.randomUUID();
    scans[tab.id] = { origin, documentId: sender.documentId, scanId, digest, assessmentId: assessment.id,
      expiresAt: followed ? Date.now() + 120000 : prior.expiresAt };
    await saveSessions(scans); await saveOrigins(store.origins);
    return { allowed: true, scanId, ...store.preferences };
  }
  if (!prior || prior.scanId !== message.scanId || prior.documentId !== sender.documentId || prior.digest !== await pageDigest(store.identity, tab.url)) return { allowed: false };
  const assessment = store.origins[origin];
  if (!assessment || assessment.id !== prior.assessmentId || !assessment.pages[prior.digest]) return { allowed: false };
  const snapshot = sanitizeSnapshot(message.snapshot, store.preferences);
  if (/\/(messages?|inbox|chats?|direct)(\/|$)/i.test(new URL(tab.url).pathname)) {
    snapshot.regions = []; snapshot.items = []; snapshot.coverage.privateContext = true;
  }
  const page = assessment.pages[prior.digest];
  page.assessedAt = Date.now(); page.scanId = prior.scanId;
  page.coverage = snapshot.coverage; page.detectorVersion = DETECTOR_VERSION;
  const bundle = buildQuestions(snapshot);
  const modelHash = await hash(JSON.stringify([MODEL, PROMPT_VERSION, bundle.request]));
  if (page.modelHash !== modelHash) { delete page.modelCriteria; page.modelHash = modelHash; page.nextAIAt = 0; page.aiError = null; }
  page.criteria = retainDetected(page.criteria, { ...ruleFindings(snapshot), ...(store.preferences.ai ? page.modelCriteria : {}) });
  const canClassify = store.preferences.ai && Object.keys(bundle.tags).length > 0;
  page.aiStatus = !store.preferences.ai ? "Jev is off" : !canClassify ? "No eligible text to classify" : page.modelCriteria ? "Jev assessment available" : page.aiError || "Waiting for Jev";
  assessment.updatedAt = Date.now();
  await saveOrigins(store.origins);
  if (canClassify && !page.modelCriteria && (!page.nextAIAt || page.nextAIAt < Date.now())) {
    const jobKey = `${origin}/${prior.digest}/${modelHash}`;
    if (!jobs.has(jobKey)) {
      const controller = new AbortController();
      jobs.set(jobKey, { controller, origin });
      void classify({ jobKey, controller, origin, digest: prior.digest, assessmentId: assessment.id, scanId: prior.scanId, modelHash, bundle, tabId: tab.id }).catch(() => {}).finally(() => {
        if (jobs.get(jobKey)?.controller === controller) jobs.delete(jobKey);
      });
    }
  }
  return { allowed: true, ...store.preferences };
}

async function setAIResult(job, update) {
  await serial(async () => {
    if (job.controller.signal.aborted) return;
    const store = await data();
    const assessment = store.origins[job.origin];
    const page = assessment?.pages[job.digest];
    if (!store.preferences.ai || assessment?.id !== job.assessmentId || page?.scanId !== job.scanId || page.modelHash !== job.modelHash) return;
    Object.assign(page, update);
    if (update.modelCriteria) page.criteria = retainDetected(page.criteria, { ...page.criteria, ...update.modelCriteria });
    assessment.updatedAt = Date.now();
    await saveOrigins(store.origins);
  });
}

async function reserveBudget(job) {
  return serial(async () => {
    let { aiBudgetV1: budget } = await chrome.storage.session.get("aiBudgetV1");
    if (!budget || Date.now() - budget.startAt > 3600000) budget = { startAt: Date.now(), count: 0, pages: {} };
    const key = `${job.origin}/${job.digest}`;
    if (budget.count >= 60 || (budget.pages[key] || 0) >= 3) return false;
    budget.count++; budget.pages[key] = (budget.pages[key] || 0) + 1;
    await chrome.storage.session.set({ aiBudgetV1: budget });
    return true;
  });
}

async function classify(job) {
  let credential;
  try {
    credential = await vault.credential();
    if (!(await chrome.permissions.contains({ origins: [API_ORIGIN] }))) throw new Error("Enable Jev access in settings.");
    if (job.controller.signal.aborted) return;
    if (!(await reserveBudget(job))) { await setAIResult(job, { aiStatus: "AI request limit reached; local observations continue", aiError: "AI request limit reached; local observations continue", nextAIAt: Date.now() + 60000 }); return; }
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 20000);
    let response;
    try { response = await requestJev(credential.apiKey, job.bundle.request, { signal: AbortSignal.any([job.controller.signal, timeoutController.signal]) }); }
    catch (error) {
      if (timeoutController.signal.aborted) {
        throw new Error("Jev timed out. Local observations are still available.");
      }
      throw error;
    }
    finally { clearTimeout(timeout); }
    const current = await vault.credential();
    if (current.revision !== credential.revision || job.controller.signal.aborted) return;
    const modelCriteria = parseAnswers(response, job.bundle);
    await setAIResult(job, { modelCriteria, modelVersion: response.model, promptVersion: PROMPT_VERSION, aiStatus: "Jev assessment available", aiError: null, nextAIAt: 0 });
  } catch (error) {
    if (!job.controller.signal.aborted) await setAIResult(job, { aiStatus: safeError(error), aiError: safeError(error), nextAIAt: Date.now() + 30000 });
    if (error.status === 401 && credential) await vault.reject(credential.revision);
  }
}

function safeError(error) {
  const text = String(error?.message || "");
  if (/^(Enter a valid|Use a passphrase|Choose a storage|Could not unlock|Unlock or add|Enable Jev|Jev |This key|Assessment storage|Chrome cannot|Open a regular|Assessment is disabled|Choose a website)/.test(text)) return text.slice(0, 200);
  return "Could not complete this operation. Try again or check extension access.";
}

async function handleUI(message, sender) {
  const isSettings = trustedPage(sender, ["options.html"]);
  if (!isSettings && !trustedPage(sender, ["popup.html"])) throw new Error("Not authorized.");
  if (message.type.startsWith("KEY_")) {
    if (!isSettings && message.type !== "KEY_LOCK") throw new Error("Not authorized.");
    if (message.type === "KEY_SAVE") await vault.save(message.apiKey, message.mode, message.passphrase);
    else if (message.type === "KEY_UNLOCK") await vault.unlock(message.passphrase);
    else if (message.type === "KEY_LOCK") await vault.lock();
    else if (message.type === "KEY_FORGET") await vault.forget();
    else throw new Error("Not authorized.");
    return { key: await vault.status() };
  }
  if (message.type === "SETTINGS_GET") {
    const store = await data();
    return { preferences: store.preferences, key: await vault.status(), origins: Object.values(store.origins).map(value => ({ origin: value.origin, enabled: value.enabled, count: Object.keys(value.pages).length })) };
  }
  if (message.type === "PREFERENCES_SET") {
    if (!isSettings) throw new Error("Not authorized.");
    const preferences = { ai: message.ai === true, feedText: message.feedText === true };
    if (preferences.ai && !(await chrome.permissions.contains({ origins: [API_ORIGIN] }))) throw new Error("Enable Jev access in settings.");
    cancelJobs();
    await chrome.storage.local.set({ preferencesV1: preferences });
    await broadcast({ type: "RESCAN_COLLECTOR" });
    return { preferences };
  }
  if (message.type === "CLEAR_ALL") {
    if (!isSettings) throw new Error("Not authorized.");
    cancelJobs();
    await saveOrigins({}); await saveSessions({});
    await reconcileRegistrations(); await broadcast({ type: "STOP_COLLECTOR" });
    return {};
  }
  const tab = await validTab(message.tabId);
  const origin = originOf(tab.url);
  const store = await data();
  if (message.type === "LABEL_GET") return { origin, summary: summarize(store.origins[origin]), preferences: store.preferences, key: await vault.status() };
  if (message.type === "SITE_RESET") {
    cancelJobs(origin);
    delete store.origins[origin]; await saveOrigins(store.origins);
    const scans = await sessions();
    for (const [id, scan] of Object.entries(scans)) if (scan.origin === origin) delete scans[id];
    await saveSessions(scans); await reconcileRegistrations();
    await broadcast({ type: "STOP_COLLECTOR", origin });
    return {};
  }
  if (message.type === "SITE_FOLLOW") {
    if (message.enabled === true && !(await chrome.permissions.contains({ permissions: ["webNavigation"], origins: [hostPattern(origin)] }))) throw new Error("Enable site access to follow navigation.");
    ensureOrigin(store, origin).enabled = message.enabled === true;
    await saveOrigins(store.origins); await reconcileRegistrations();
    if (!message.enabled) {
      cancelJobs(origin);
      const scans = await sessions();
      for (const [id, scan] of Object.entries(scans)) if (scan.origin === origin) delete scans[id];
      await saveSessions(scans); await broadcast({ type: "STOP_COLLECTOR", origin });
      return {};
    }
  } else if (message.type !== "SCAN") throw new Error("Not authorized.");
  const scans = await sessions();
  scans[tab.id] = { origin, expiresAt: Date.now() + 120000 };
  await saveSessions(scans); await inject(tab.id);
  return {};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== "string") return false;
  // Test requests run outside the state queue because their network result may take seconds.
  if (message.type === "KEY_TEST") {
    if (!trustedPage(sender, ["options.html"])) { respond({ ok: false, error: "Not authorized." }); return false; }
    void testConnection().then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  const handler = ["COLLECTOR_HELLO", "OBSERVATION"].includes(message.type) ? handleCollector : handleUI;
  serial(() => handler(message, sender)).then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: safeError(error) }));
  return true;
});

async function testConnection() {
  const credential = await vault.credential();
  if (!(await chrome.permissions.contains({ origins: [API_ORIGIN] }))) throw new Error("Enable Jev access in settings.");
  const controller = new AbortController(), id = crypto.randomUUID();
  jobs.set(id, { controller });
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const result = await requestJev(credential.apiKey, { model: MODEL, state: "This is a connection test.", questions: { test: { type: "noul", instructions: "Does state describe a connection test?" } } }, { signal: controller.signal });
    if (result.answers?.test?.type !== "noul" || !Number.isFinite(result.answers.test.noul)) throw new Error("Jev returned an invalid answer.");
    return { message: "Connected to Jev. No page content was sent." };
  } catch (error) {
    if (error.status === 401) await vault.reject(credential.revision);
    throw error;
  } finally { clearTimeout(timeout); jobs.delete(id); }
}

chrome.runtime.onInstalled.addListener(() => { void serial(reconcileRegistrations).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void serial(reconcileRegistrations).catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { cancelJobs(); void serial(reconcileRegistrations).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { void serial(async () => { const scans = await sessions(); delete scans[tabId]; await saveSessions(scans); }).catch(() => {}); });
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void serial(async () => {
    const tab = await validTab(tabId);
    const store = await data();
    if (store.origins[originOf(tab.url)]?.enabled) await inject(tabId);
  }).catch(() => {});
});
function routeChanged(event) {
  if (event.frameId !== 0) return;
  void serial(async () => {
    const store = await data();
    if (!store.origins[originOf(event.url)]?.enabled) return;
    await chrome.tabs.sendMessage(event.tabId, { type: "RESCAN_COLLECTOR" }).catch(() => {});
  }).catch(() => {});
}
let navigationBound = false;
function bindNavigation() {
  if (navigationBound || !chrome.webNavigation?.onHistoryStateUpdated) return;
  chrome.webNavigation.onHistoryStateUpdated.addListener(routeChanged);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(routeChanged);
  navigationBound = true;
}
bindNavigation();
chrome.permissions.onAdded.addListener(bindNavigation);
