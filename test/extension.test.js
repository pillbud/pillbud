// node test/extension.test.js   (needs the app running: PILLBUD_TEST=1 npm start)
// Runs the extension's real background.js in Node with a stand-in `chrome` API, fires the tab events Chrome would
// fire for coin pages on each supported site, and checks the running app received and researched each coin.
// (Loading the unpacked extension into a headless Chromium hangs Chromium's startup on this PC, so this drives the
// same code without a browser. Loading it in real Chrome is the README's "Load unpacked" step.)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP = process.env.PILLBUD_URL || "http://127.0.0.1:47331"; // the test instance (47321 is the real app)
const MINT = "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump";        // $AMD
const CURVE_MINT = "7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump";  // $GRANDPA
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appLog = async () => (await (await fetch(`${APP}/debug/log`)).json());

// the bits of the chrome.* API background.js uses
const listeners = { updated: [], activated: [], focus: [] };
const badge = {};
const session = {};
const chrome = {
  tabs: {
    onUpdated: { addListener: (f) => listeners.updated.push(f) },
    onActivated: { addListener: (f) => listeners.activated.push(f) },
    get: async (id) => tabs[id], query: async () => [],
  },
  windows: { onFocusChanged: { addListener: (f) => listeners.focus.push(f) }, WINDOW_ID_NONE: -1 },
  action: { setBadgeText: async ({ text, tabId }) => { badge[tabId] = text; }, setBadgeBackgroundColor: async () => {} },
  storage: { session: { set: async (o) => Object.assign(session, o), get: async (k) => ({ [k]: session[k] }) } },
};
const tabs = {};
// the extension talks to the real app's port; in the test it talks to the test instance instead
const bgCode = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8").replace(/127\.0\.0\.1:47321/g, new URL(APP).host);
vm.runInNewContext(bgCode, { chrome, fetch, URL, console, setTimeout, Date, JSON });

(async () => {
  const st = await (await fetch(`${APP}/status`)).json().catch(() => null);
  if (!st?.ok) throw new Error("start the app first: PILLBUD_TEST=1 npm start");
  const pairs = await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${MINT}`)).json();
  const pool = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0].pairAddress;
  const pages = [
    ["pump.fun", `https://pump.fun/coin/${CURVE_MINT}`, CURVE_MINT, true],
    ["dexscreener", `https://dexscreener.com/solana/${pool.toLowerCase()}`, MINT, true],
    ["gmgn", `https://gmgn.ai/sol/token/${CURVE_MINT}`, CURVE_MINT, true],
    ["axiom", `https://axiom.trade/meme/${pool}`, MINT, true],
    ["pump.fun board (not a coin page)", "https://pump.fun/board", null, false],
  ];
  let pass = 0, id = 0;
  for (const [site, url, want, expect] of pages) {
    const tab = { id: ++id, url, title: site, active: true };
    tabs[tab.id] = tab;
    const n0 = (await appLog()).length;
    listeners.updated.forEach((f) => f(tab.id, { url }, tab)); // what Chrome fires when the tab's URL changes
    let got = null;
    for (let i = 0; i < 20 && !got; i++) { await sleep(400); got = (await appLog()).slice(n0 > 100 ? -40 : n0).find((l) => /coin from extension/.test(l) && (!want || l.includes(want))); }
    if (expect) {
      if (!got) { console.log(`FAIL ${site}: the app never got it (badge ${badge[tab.id]})`); continue; }
      console.log(`ok  ${site.padEnd(12)} badge ${badge[tab.id]} -> app: ${got.replace(/^\S+ \S+ \S+ /, "").slice(0, 120)}`);
      // wait for the research and the spoken take
      let take = null;
      for (let i = 0; i < 60 && !take; i++) { await sleep(500); const L = await appLog(); const after = L.slice(L.lastIndexOf(got) + 1); take = after.find((l) => / take \(/.test(l)); if (after.some((l) => /research failed/.test(l))) break; }
      console.log(take ? `    take: ${take.replace(/^\S+ \S+ \S+ /, "").slice(0, 230)}` : "    (same coin as before: no new take, the chip just updates)");
      pass++;
    } else {
      console.log(got ? `FAIL ${site}: should have been ignored` : `ok  ${site}: ignored, badge ${badge[tab.id] ?? "untouched"}`);
      if (!got) pass++;
    }
  }
  console.log(`\n${pass}/${pages.length} passed`);
  process.exit(pass === pages.length ? 0 : 1);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
