// pillbud extension: when the active tab is on a coin page of a supported site, tell the desktop app (localhost only).
// No "tabs" permission: Chrome only shows this extension the URLs of the sites listed in host_permissions.
// It sends the page URL and title, nothing else. The app pulls the mint (or pair) out of the URL and resolves it.
const APP = "http://127.0.0.1:47321";
const SITES = [/(^|\.)pump\.fun$/, /(^|\.)dexscreener\.com$/, /(^|\.)gmgn\.ai$/, /(^|\.)axiom\.trade$/, /^photon-sol\.tinyastro\.io$/, /(^|\.)birdeye\.so$/, /(^|\.)solscan\.io$/];
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

let last = { url: null, at: 0 };

function coinPage(url) {
  try {
    const u = new URL(url);
    if (!SITES.some((re) => re.test(u.hostname))) return false;
    // DexScreener lowercases pairs, so any long alphanumeric path segment counts there
    return /dexscreener/.test(u.hostname) ? /\/solana\/[1-9A-Za-z]{32,44}/.test(u.pathname) : ADDRESS.test(u.pathname + u.search);
  } catch { return false; }
}

async function report(tab) {
  if (!tab?.url || !tab.active || !coinPage(tab.url)) return;
  if (tab.url === last.url && Date.now() - last.at < 3000) return;
  last = { url: tab.url, at: Date.now() };
  try {
    const r = await fetch(`${APP}/coin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: tab.url, title: tab.title || "" }) });
    const j = await r.json().catch(() => ({}));
    await chrome.action.setBadgeBackgroundColor({ color: r.ok ? "#1f9d55" : "#c0392b" });
    await chrome.action.setBadgeText({ text: r.ok ? "ON" : "?" , tabId: tab.id });
    await chrome.storage.session.set({ last: { url: tab.url, ok: r.ok, address: j.address || null, at: Date.now() } });
  } catch {
    // the desktop app isn't running
    await chrome.action.setBadgeBackgroundColor({ color: "#7f7f7f" });
    await chrome.action.setBadgeText({ text: "OFF", tabId: tab.id });
    await chrome.storage.session.set({ last: { url: tab.url, ok: false, offline: true, at: Date.now() } });
  }
}

chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.url || info.status === "complete") report(tab); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { report(await chrome.tabs.get(tabId)); } catch { /* closed */ } });
chrome.windows.onFocusChanged.addListener(async (wid) => {
  if (wid === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
  last = { url: null, at: 0 }; // coming back to the browser re-announces the coin
  report(tab);
});
