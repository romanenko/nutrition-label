import test from "node:test";
import assert from "node:assert/strict";
import { encryptKey, decryptKey, createVault } from "../extension/lib/vault.js";
import { normalizedRoute, pageDigest, originOf, retainDetected, summarize, toBase64, touchPage } from "../extension/lib/model.js";
import { sanitizeSnapshot, ruleFindings } from "../extension/lib/detection.js";
import { buildQuestions, parseAnswers, requestJev, ENDPOINT } from "../extension/lib/jev.js";

const key = "fixture-key-not-a-real-credential";
const password = "a long fixture passphrase";
const storageArea = () => {
  const items = {};
  return { items, access: null,
    async setAccessLevel({ accessLevel }) { this.access = accessLevel; },
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(name => [name, structuredClone(items[name])])); },
    async set(values) { Object.assign(items, structuredClone(values)); },
    async remove(name) { delete items[name]; },
  };
};

test("vault encrypts a key, randomizes ciphertext, and authenticates envelope and passphrase", async () => {
  const first = await encryptKey(key, password), second = await encryptKey(key, password);
  assert.equal(await decryptKey(first, password), key);
  assert.notEqual(first.salt, second.salt); assert.notEqual(first.iv, second.iv);
  assert.ok(!JSON.stringify(first).includes(key)); assert.ok(!JSON.stringify(first).includes(password));
  await assert.rejects(decryptKey(first, "the wrong passphrase"), /Could not unlock/);
  await assert.rejects(decryptKey({ ...first, revision: "tampered" }, password), /Could not unlock/);
  await assert.rejects(decryptKey({ ...first, iterations: 1e10 }, password), /Could not unlock/);
  await assert.rejects(decryptKey({ ...first, ciphertext: first.ciphertext.slice(4) }, password), /Could not unlock/);
});

test("credentials survive worker recreation, lock without plaintext persistence, and can be forgotten", async () => {
  const storage = { local: storageArea(), session: storageArea() };
  const vault = createVault(storage);
  await vault.save(key, "encrypted", password);
  assert.equal(storage.local.access, "TRUSTED_CONTEXTS");
  assert.equal(storage.session.access, "TRUSTED_CONTEXTS");
  assert.ok(!JSON.stringify(storage.local.items).includes(key));
  assert.equal((await createVault(storage).credential()).apiKey, key);
  await vault.lock();
  assert.deepEqual(await vault.status(), { saved: true, unlocked: false, rejected: false });
  await assert.rejects(vault.credential(), /Unlock/);
  await vault.unlock(password);
  await vault.forget();
  assert.deepEqual(storage.local.items, {}); assert.deepEqual(storage.session.items, {});
});

test("session-only replacement removes the saved vault; stale rejection cannot reject a replacement", async () => {
  const storage = { local: storageArea(), session: storageArea() };
  const vault = createVault(storage);
  await vault.save(key, "encrypted", password);
  const old = await vault.credential();
  await vault.save("replacement-fixture-key", "session");
  await vault.reject(old.revision);
  assert.equal((await vault.credential()).apiKey, "replacement-fixture-key");
  assert.deepEqual(storage.local.items, {});
});

test("storage initialization failure prevents any credential write", async () => {
  const storage = { local: storageArea(), session: storageArea() };
  storage.local.setAccessLevel = async () => { throw new Error("access failed"); };
  const vault = createVault(storage);
  await assert.rejects(vault.save(key, "session"), /access failed/);
  assert.deepEqual(storage.local.items, {}); assert.deepEqual(storage.session.items, {});
});

test("failed encrypted replacement leaves a locked previous vault, never a plaintext fallback", async () => {
  const storage = { local: storageArea(), session: storageArea() };
  const vault = createVault(storage);
  await vault.save(key, "encrypted", password);
  const original = structuredClone(storage.local.items.jevVaultV1);
  storage.local.set = async () => { throw new Error("quota"); };
  await assert.rejects(vault.save("replacement-fixture-key", "encrypted", password), /quota/);
  assert.deepEqual(storage.local.items.jevVaultV1, original);
  assert.deepEqual(storage.session.items, {});
});

test("page identity deduplicates tracking/anchors, preserves semantic queries, routes and exact origins", async () => {
  const secret = toBase64(new Uint8Array(32).fill(3));
  const a = "https://example.com/search?q=one";
  assert.equal(await pageDigest(secret, a), await pageDigest(secret, `${a}&utm_source=x#section`));
  assert.notEqual(await pageDigest(secret, a), await pageDigest(secret, "https://example.com/search?q=two"));
  assert.notEqual(await pageDigest(secret, a), await pageDigest(secret, "http://example.com/search?q=one"));
  assert.notEqual(normalizedRoute("https://example.com/#/one"), normalizedRoute("https://example.com/#/two"));
  assert.equal(originOf("https://example.com:443/path"), "https://example.com");
  assert.throws(() => originOf("chrome://extensions"));
});

test("page updates do not inflate serving size, unknown never contributes a clean page", () => {
  const assessment = { pages: {} };
  touchPage(assessment, "one", 1).criteria = { feed: { result: "detected", detail: "Feed" } };
  touchPage(assessment, "one", 2);
  touchPage(assessment, "two", 3).criteria = { feed: { result: "unknown", detail: "Not observed long enough" } };
  const summary = summarize(assessment);
  assert.equal(summary.visited, 2); assert.equal(summary.criteria.feed.detected, 1);
  assert.equal(summary.criteria.feed.assessed, 1); assert.equal(summary.criteria.feed.unknown, 1);
});

test("an observed finding remains in the origin sample after a later clean snapshot", () => {
  const result = retainDetected({ autoplay: { result: "detected", detail: "Observed start" } }, { autoplay: { result: "unknown", detail: "Already playing" } });
  assert.equal(result.autoplay.result, "detected"); assert.match(result.autoplay.detail, /Seen earlier/);
});

test("snapshot extraction strips unknown fields, bounds text, and enforces text opt-in", () => {
  const input = { apiKey: "untrusted", regions: [{ kind: "prompt", text: "Contact person@example.com at https://example.com/secret?token=yes" }], items: [{ text: "Some personal feed text" }], ui: { obstruction: 9 }, media: { observed: -4 } };
  const local = sanitizeSnapshot(input, { ai: false, feedText: false });
  assert.deepEqual(local.regions, []); assert.deepEqual(local.items, []);
  assert.equal(local.apiKey, undefined); assert.equal(local.ui.obstruction, 1); assert.equal(local.media.observed, 0);
  const ai = sanitizeSnapshot(input, { ai: true, feedText: false });
  assert.deepEqual(ai.items, []); assert.equal(ai.regions[0].text, "Contact [email] at [link]");
  const privatePage = sanitizeSnapshot({ ...input, coverage: { privateContext: true } }, { ai: true, feedText: true });
  assert.deepEqual(privatePage.items, []); assert.deepEqual(privatePage.regions, []);
});

test("autoplay configuration and earlier playback are unknown; observed unsolicited playback is flagged", () => {
  for (const media of [{ configured: 1 }, { alreadyPlaying: 1 }]) {
    assert.equal(ruleFindings(sanitizeSnapshot({ media }, {})).autoplay.result, "unknown");
  }
  const result = ruleFindings(sanitizeSnapshot({ media: { observed: 1, mutedStarts: 1 } }, {}));
  assert.equal(result.autoplay.result, "detected"); assert.match(result.autoplay.detail, /Negative factor/);
  assert.equal(result.infinite.result, "unknown");
});

test("Jev classifies independent content properties, rejects malformed answers, and abstains", () => {
  const snapshot = sanitizeSnapshot({ items: [{ text: "A neutral report about an election." }], feed: { explicit: true } }, { ai: true, feedText: true });
  const bundle = buildQuestions(snapshot);
  const response = { model: "jev-1.13.0", answers: {
    politics_0: { type: "noul", noul: 0.97 }, hate_0: { type: "noul", noul: 0.02 }, provocation_0: { type: "noul", noul: 0.5 },
  } };
  const findings = parseAnswers(response, bundle);
  assert.equal(findings.politics.result, "detected"); assert.equal(findings.hate.result, "not_observed");
  assert.equal(findings.provocation.result, "unknown");
  assert.throws(() => parseAnswers({ model: "jev", answers: {} }, bundle), /invalid/);
  assert.throws(() => parseAnswers({ ...response, answers: { ...response.answers, politics_0: { type: "noul", noul: 2 } } }, bundle), /invalid/);
});

test("provider transport fixes destination, isolates key from state, refuses redirects and sanitizes errors", async () => {
  const request = { model: "jev-1.13.0", state: "fixture", questions: {} };
  await requestJev(key, request, { fetcher: async (url, options) => {
    assert.equal(url, ENDPOINT); assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.ok(!options.body.includes(key));
    return new Response(JSON.stringify({ answers: {} }), { status: 200 });
  } });
  await assert.rejects(requestJev(key, request, { fetcher: async () => new Response(`private error ${key}`, { status: 401 }) }), error => error.status === 401 && !error.message.includes(key));
});
