const website = document.querySelector("#website");
const pageNotice = document.querySelector("#page-notice");

function showNotice(message) {
  pageNotice.textContent = message;
  pageNotice.hidden = false;
}

async function showCurrentWebsite() {
  // Opening the HTML directly is a useful preview, without extension APIs.
  if (!globalThis.chrome?.tabs?.query) {
    website.textContent = "Label preview";
    showNotice("Open Nutrition Label from the Chrome toolbar to see the current website.");
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      website.textContent = "Website unavailable";
      showNotice("Open a website, then click the Nutrition Label icon again.");
      return;
    }

    const url = new URL(tab.url);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      website.textContent = "Not a website";
      showNotice("Open a regular web page to view its label.");
      return;
    }

    // Only display the hostname; paths and query strings may contain private data.
    website.textContent = url.hostname;
  } catch {
    website.textContent = "Website unavailable";
    showNotice("Couldn't read this tab. Open a website and try the extension again.");
  }
}

showCurrentWebsite();
