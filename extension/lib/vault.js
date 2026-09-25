import { fromBase64, toBase64 } from "./model.js";

const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const random = length => crypto.getRandomValues(new Uint8Array(length));
const header = record => encoder.encode(JSON.stringify({ version: record.version, provider: record.provider, revision: record.revision }));

export function validateKey(value) {
  const key = String(value || "").trim();
  if (!/^[\x21-\x7e]{8,4096}$/.test(key)) throw new Error("Enter a valid API key without spaces or line breaks.");
  return key;
}

async function derive(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptKey(value, passphrase) {
  const apiKey = validateKey(value);
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 256) {
    throw new Error("Use a passphrase with 12–256 characters.");
  }
  const record = { version: 1, provider: "typesafe", revision: crypto.randomUUID(), iterations: ITERATIONS,
    salt: toBase64(random(16)), iv: toBase64(random(12)) };
  const key = await derive(passphrase, fromBase64(record.salt));
  record.ciphertext = toBase64(await crypto.subtle.encrypt({ name: "AES-GCM", iv: fromBase64(record.iv), additionalData: header(record), tagLength: 128 }, key, encoder.encode(apiKey)));
  return record;
}

export async function decryptKey(record, passphrase) {
  try {
    if (record?.version !== 1 || record.provider !== "typesafe" || record.iterations !== ITERATIONS ||
      typeof record.revision !== "string" || record.revision.length > 100 ||
      typeof passphrase !== "string" || passphrase.length > 256 ||
      typeof record.ciphertext !== "string" || record.ciphertext.length > 6000 ||
      fromBase64(record.salt).length !== 16 || fromBase64(record.iv).length !== 12) throw new Error();
    const key = await derive(passphrase, fromBase64(record.salt));
    const value = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(record.iv), additionalData: header(record), tagLength: 128 }, key, fromBase64(record.ciphertext));
    return validateKey(new TextDecoder().decode(value));
  } catch {
    throw new Error("Could not unlock. Check your passphrase; the saved key may also be damaged.");
  }
}

export function createVault(storage, cancel = () => {}) {
  const ready = Promise.all([
    storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  let queue = Promise.resolve();
  const mutate = operation => {
    cancel();
    const result = queue.then(async () => { await ready; return operation(); });
    queue = result.catch(() => {});
    return result;
  };
  return {
    ready,
    async status() {
      await ready;
      const { jevVaultV1: saved } = await storage.local.get("jevVaultV1");
      const { jevUnlockedV1: unlocked } = await storage.session.get("jevUnlockedV1");
      return { saved: Boolean(saved), unlocked: Boolean(unlocked), rejected: Boolean(unlocked?.rejected) };
    },
    async credential() {
      await ready;
      await queue;
      const { jevUnlockedV1: value } = await storage.session.get("jevUnlockedV1");
      if (!value || value.rejected) throw new Error("Unlock or add a working Jev key in settings.");
      return value;
    },
    save(apiKey, mode, passphrase) {
      return mutate(async () => {
        const key = validateKey(apiKey);
        if (!["session", "encrypted"].includes(mode)) throw new Error("Choose a storage mode.");
        const record = mode === "encrypted" ? await encryptKey(key, passphrase) : null;
        await storage.session.remove("jevUnlockedV1");
        if (record) await storage.local.set({ jevVaultV1: record });
        else await storage.local.remove("jevVaultV1");
        await storage.session.set({ jevUnlockedV1: { apiKey: key, revision: record?.revision || crypto.randomUUID() } });
      });
    },
    unlock(passphrase) {
      return mutate(async () => {
        const { jevVaultV1: record } = await storage.local.get("jevVaultV1");
        const apiKey = await decryptKey(record, passphrase);
        await storage.session.set({ jevUnlockedV1: { apiKey, revision: record.revision } });
      });
    },
    lock() { return mutate(() => storage.session.remove("jevUnlockedV1")); },
    forget() {
      return mutate(async () => {
        await storage.session.remove("jevUnlockedV1");
        await storage.local.remove("jevVaultV1");
      });
    },
    reject(revision) {
      return mutate(async () => {
        const { jevUnlockedV1: value } = await storage.session.get("jevUnlockedV1");
        if (value?.revision === revision) await storage.session.set({ jevUnlockedV1: { ...value, rejected: true } });
      });
    },
  };
}
