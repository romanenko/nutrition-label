import { API_ORIGIN } from "./lib/jev.js";

const $ = selector => document.querySelector(selector);
const extension = location.protocol === "chrome-extension:" && Boolean(globalThis.chrome?.runtime?.id);
const status = text => { $("#status").textContent = text; };
async function send(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...values });
  if (!result?.ok) throw new Error(result?.error || "The extension is unavailable. Reload it and try again.");
  return result;
}
async function refresh() {
  const data = await send("SETTINGS_GET");
  const key = data.key;
  $("#key-status").textContent = key.rejected ? "Key rejected" : key.saved ? key.unlocked ? "Saved and unlocked" : "Saved and locked" : key.unlocked ? "Available this session" : "Not configured";
  $("#unlock-form").hidden = !key.saved || key.unlocked;
  $("#test-key").disabled = !key.unlocked || key.rejected;
  $("#lock-key").disabled = !key.unlocked;
  $("#forget-key").disabled = !key.unlocked && !key.saved;
  $("#enable-ai").checked = data.preferences.ai;
  $("#feed-text").checked = data.preferences.feedText;
  $("#sites").replaceChildren();
  for (const site of data.origins) {
    const li = document.createElement("li");
    li.textContent = `${site.origin} · ${site.count} page(s)${site.enabled ? " · following" : ""}`;
    $("#sites").append(li);
  }
}
async function perform(button, action, success) {
  button.disabled = true;
  try { await action(); status(success); }
  catch (error) { status(error.message); }
  finally { button.disabled = false; await refresh().catch(() => {}); }
}
$("#storage-mode").addEventListener("change", event => {
  const encrypted = event.target.value === "encrypted";
  $("#passphrase-field").hidden = !encrypted;
  $("#passphrase").required = encrypted;
  $("#storage-hint").textContent = encrypted ? "Saved with passphrase encryption on this device. Saving does not make an API request." : "Kept in memory until Chrome restarts or the extension reloads. Saving does not make an API request.";
});
$("#save-form").addEventListener("submit", event => {
  event.preventDefault();
  const apiKey = $("#api-key").value, passphrase = $("#passphrase").value, mode = $("#storage-mode").value;
  $("#api-key").value = ""; $("#passphrase").value = "";
  void perform(event.submitter, () => send("KEY_SAVE", { apiKey, passphrase, mode }), "Key saved. No API request was made.");
});
$("#unlock-form").addEventListener("submit", event => {
  event.preventDefault();
  const passphrase = $("#unlock-passphrase").value;
  $("#unlock-passphrase").value = "";
  void perform(event.submitter, () => send("KEY_UNLOCK", { passphrase }), "Key unlocked for this browser session.");
});
$("#lock-key").addEventListener("click", event => { void perform(event.target, () => send("KEY_LOCK"), "Key locked; active Jev requests stopped."); });
$("#forget-key").addEventListener("click", event => { void perform(event.target, () => send("KEY_FORGET"), "Saved key removed. Revoke it at TypeSafe if you also want to invalidate it there."); });
$("#test-key").addEventListener("click", event => {
  void perform(event.target, async () => {
    const granted = await chrome.permissions.request({ origins: [API_ORIGIN] });
    if (!granted) throw new Error("Jev access was declined.");
    await send("KEY_TEST");
  }, "Connected to Jev. No page content was sent.");
});
$("#preferences-form").addEventListener("submit", event => {
  event.preventDefault();
  const ai = $("#enable-ai").checked, feedText = $("#feed-text").checked;
  void perform(event.submitter, async () => {
    if (ai && !(await chrome.permissions.request({ origins: [API_ORIGIN] }))) throw new Error("Jev access was declined.");
    await send("PREFERENCES_SET", { ai, feedText });
  }, "Analysis preferences saved.");
});
$("#clear-data").addEventListener("click", event => { void perform(event.target, () => send("CLEAR_ALL"), "All assessments cleared and site following stopped. Your key was kept."); });

if (extension) void refresh().catch(error => status(error.message));
else {
  $("#preview").hidden = false;
  for (const element of document.querySelectorAll("input,select,button")) element.disabled = true;
}
