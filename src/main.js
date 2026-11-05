// pillbud: the Electron main process.
//   - a transparent, frameless, always-on-top window with the character and its balloon (renderer/)
//   - a tray icon: show/hide, Voice or Text mode, tone, volume, mute, do not disturb, quit
//   - a localhost server the Chrome extension posts "the coin you're at" to, plus clipboard watching
//   - the instant flow: first words from cached quick facts (~1 s), the dev line, then the X + LARP verdict when it lands
//   - live alerts pushed by the Helius websocket, and push-to-talk questions answered by streamed voice
// Read-only research: no wallet, no trading, no transactions.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen, globalShortcut, session, net, desktopCapturer, powerMonitor } = require("electron");
const T0 = Date.now(); // startup timing
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { settings, setPref, keyStatus, APP_DIR } = require("./env");
const { fromUrl, fromClipboard, resolveMint } = require("./detect");
const { research, addLegit, quick } = require("./research");
const trench = require("./research/trench");
const holderMod = require("./research/holders");
const probeMod = require("./research/probe");
const feesMod = require("./research/fees");
const readMod = require("./read");
const brain = require("./brain");
const voice = require("./voice");
const tone = require("./tone");
const { spritePack } = require("./sprites");
const sentLines = []; // test mode only: the last lines sent to the page (GET /debug/lines)
const { makeWatcher } = require("./watcher");
const { makeFeed } = require("./feed");
const { money, ago } = require("./research/chart");
const x = require("./research/x");
const look = require("./look");
const { makeTabReader } = require("./tabreader");
const { makeScreenWatcher } = require("./screenwatch");
const { can } = require("./tier");

// Test mode (PILLBUD_TEST=1 or --test): nothing appears on the desktop. The window renders off-screen (no native
// window is shown), there's no tray icon and no global hotkey, audio is generated and saved but not played aloud,
// and the clipboard is only watched if PILLBUD_TEST_CLIPBOARD=1. /debug/capture screenshots the page.
const TEST = process.env.PILLBUD_TEST === "1" || process.argv.includes("--test");
if (TEST) {
  // a test instance never touches the real one: its own port (47331), prefs file and Electron profile folder
  const os = require("node:os");
  const dir = path.join(os.tmpdir(), `pillbud-test-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.PILLBUD_PORT = process.env.PILLBUD_PORT || "47331";
  process.env.PILLBUD_PREFS = process.env.PILLBUD_PREFS || path.join(dir, "prefs.json");
  app.setPath("userData", dir);
}
// screenshots at 150%: the off-screen renderer ignores Windows' display scale, so the test zooms the page by the same
// factor in a window that much bigger, which is what 150% scaling does to CSS pixels
const SCALE = TEST && Number(process.env.PILLBUD_SCALE) > 0 ? Number(process.env.PILLBUD_SCALE) : 1;
const S = () => settings();
let win = null, tray = null;
const state = { coin: null, mint: null, history: [], lastAddress: null, lastAt: 0, log: [], metrics: [] };
const cache = new Map(); // mint -> { quick, full, legit: { at, v } }, the 40 most recent coins
function cacheFor(mint) {
  let c = cache.get(mint);
  if (c) { cache.delete(mint); cache.set(mint, c); return c; } // most recent last
  c = {}; cache.set(mint, c);
  while (cache.size > 40) cache.delete(cache.keys().next().value);
  return c;
}
const fetcher = (...a) => net.fetch(...a);

function log(s) {
  const line = `${new Date().toLocaleTimeString()} ${s}`;
  state.log.push(line); if (state.log.length > 400) state.log.shift();
  console.log(line);
}
function metric(m) { state.metrics.push({ at: Date.now(), ...m }); if (state.metrics.length > 200) state.metrics.shift(); log(`metric ${JSON.stringify(m)}`); }

// ------------------------------------------------------------------ the window
// Balloon size (tray, then Balloon size): the balloon's text and boxes scale together; pillbud stays the same size.
// The window grows to fit the bigger balloon, from its bottom-left corner, so the buddy never moves.
const BALLOON_SIZES = [["small", "Small", 0.9], ["normal", "Normal", 1], ["large", "Large", 1.2], ["xl", "Extra large", 1.4]];
// Balloon look (tray, then Balloon look): colours, corners, shadow and type; the layout is the same in every look
const BALLOON_LOOKS = [["brand", "pillbud"], ["classic", "Classic (Windows 98)"], ["dark", "Dark"], ["white", "Clean white"], ["mint", "Mint"], ["toy", "Toy bubble"], ["game", "Game dialog"], ["sticker", "Sticker"]];
const balloonZoom = () => (BALLOON_SIZES.find(([k]) => k === S().balloonSize) || BALLOON_SIZES[1])[2];
function fullSize() {
  const z = balloonZoom(), wa = screen.getPrimaryDisplay().workArea;
  // the balloon sits 100 px in, 318 px wide; it starts 306 px up (the buddy plus its gap) and gets 414 px of height
  const w = Math.max(430, Math.ceil(100 + 318 * z + 14)), h = Math.min(wa.height - 8, Math.ceil(306 + 414 * z));
  return [Math.round(w * SCALE), Math.round(h * SCALE)];
}
function applyBalloonSize() {
  if (!sizes) return;
  sizes.full = fullSize();
  // a bigger balloon that would run off the right edge of the screen slides pillbud left just enough to fit
  const wa = screen.getDisplayNearestPoint({ x: Math.round(anchor.left), y: Math.round(anchor.bottom - 1) }).workArea;
  anchor.left = Math.min(anchor.left, wa.x + wa.width - 4 - sizes.full[0]);
  if (win && (sizeNow === "full" || TEST)) { const [w, h] = sizes.full; win.setBounds({ x: Math.round(anchor.left), y: Math.round(anchor.bottom - h), width: w, height: h }); }
}
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  // V3 layout: the buddy (225 x 250) at the bottom-left, the balloon above and to the right of its head
  const [W, H] = fullSize();
  anchor = { left: wa.x + wa.width - 12 - W, bottom: wa.y + wa.height - 4 }; // the window grows and shrinks around its bottom-left corner, so the buddy never moves
  sizes = { full: [W, H], compact: [Math.round(250 * SCALE), Math.round(296 * SCALE)] };
  win = new BrowserWindow({
    width: W, height: H, x: anchor.left, y: anchor.bottom - H,
    transparent: true, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: true, show: false, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: TEST },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(APP_DIR, "renderer", "index.html"), { query: TEST ? { test: "1" } : {} });
  if (!TEST) win.once("ready-to-show", () => win.showInactive());
  if (SCALE !== 1) win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(SCALE));
  win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === "warning") log(`[page ${e.level}] ${e.message}`); });
  win.on("closed", () => { win = null; pageReady = false; });
  win.webContents.on("did-start-loading", () => { pageReady = false; log("page loading"); });
  win.webContents.on("render-process-gone", (_e, d) => log(`page process gone: ${d.reason} (exit ${d.exitCode})`));
  win.webContents.on("unresponsive", () => log("page unresponsive"));
}

ipcMain.handle("sprites", () => { const p = spritePack(S().character); log(`character: ${p.manifest.name || "?"} (${p.manifest.kind}) from ${p.from}`); return p; });
ipcMain.handle("prefs", () => publicPrefs());
// balloonLook: pillbud ("brand") is the default look (2026-11-05)
const publicPrefs = () => { const s = S(); return { mode: s.mode, textVoice: s.textVoice, tone: s.tone, volume: s.volume, muted: s.muted, dnd: s.dnd, balloonSize: s.balloonSize || "normal", balloonZoom: balloonZoom(), balloonLook: BALLOON_LOOKS.some(([k]) => k === s.balloonLook) ? s.balloonLook : "brand", test: TEST }; };

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// ------------------------------------------------------------------ lines: one at a time, audio streamed in
// A line's speech starts generating the moment the line is made (so it's ready when its turn comes); its audio
// chunks go to the page as they arrive. Lines wait for the page's "ready" (a line sent earlier would be lost).
const queue = [];
let current = null, pageReady = false, watchdog = null, lineId = 0;

/** show a line and say it. kind: take | answer | reaction | info. sfx: hello | pump | dump | larp | rug | legit */
function say(text, o = {}) {
  const s = S();
  text = tone.clean(text);
  if (!text) return null;
  if (s.dnd && !["answer", "info"].includes(o.kind)) return null; // do not disturb: only what was asked for
  const line = { id: ++lineId, text, kind: o.kind || "info", mood: o.mood || "talk", sfx: o.sfx || null, coin: o.coin, heard: o.heard, append: !!o.append, details: o.details, mint: o.mint || state.mint,
    t: { made: Date.now(), detect: o.tDetect, ask: o.tAsk }, chunks: [], done: false, mime: null, rate: 1, voice: s.mode === "voice" && !s.muted };
  if (line.voice) {
    voice.speakStream(text, line.kind, (buf, mime) => {
      line.chunks.push(buf);
      if (line.t.firstByte == null) line.t.firstByte = Date.now();
      if (current === line) send("line-audio", { id: line.id, chunk: buf });
    }).then((info) => {
      line.done = true; line.mime = info.mime; line.rate = info.rate;
      if (TEST) saveAudio(line, info);
      if (current === line) send("line-audio-end", { id: line.id, mime: info.mime, rate: info.rate });
    }).catch((e) => { log(`tts failed: ${e.message}`); line.done = true; line.voice = false; if (current === line) send("line-audio-end", { id: line.id, failed: true }); });
  }
  queue.push(line);
  // reactions pile up on a wild chart: keep only the newest two waiting
  while (queue.filter((q) => q.kind === "reaction").length > 2) queue.splice(queue.findIndex((q) => q.kind === "reaction"), 1);
  pump();
  return line;
}
function saveAudio(line, info) {
  const dir = path.join(APP_DIR, "captures", "audio");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${line.kind}.${info.mime.includes("wav") ? "wav" : "mp3"}`), Buffer.concat(line.chunks));
}
function pump() {
  if (!pageReady || current || !queue.length) return;
  const line = queue.shift();
  if (line.mint && state.mint && line.mint !== state.mint && line.kind !== "answer") { pump(); return; } // about a coin we left
  current = line;
  if (TEST) { sentLines.push({ text: line.text, kind: line.kind, mood: line.mood, sfx: line.sfx, coin: line.coin, heard: line.heard, append: line.append }); if (sentLines.length > 60) sentLines.shift(); }
  send("line", { id: line.id, text: line.text, kind: line.kind, mood: line.mood, sfx: line.sfx, coin: line.coin, heard: line.heard, append: line.append, details: line.details, readMs: queue[0]?.append ? 250 : undefined, audio: line.voice ? "stream" : "none", mime: line.voice ? "audio/mpeg" : null });
  for (const c of line.chunks) send("line-audio", { id: line.id, chunk: c });
  if (line.done && line.voice) send("line-audio-end", { id: line.id, mime: line.mime, rate: line.rate });
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { if (current === line) { log("the page never finished a line: moving on"); current = null; pump(); } }, 25000 + line.text.length * 120);
}
ipcMain.on("line-done", (_e, { id }) => { if (current?.id === id) { clearTimeout(watchdog); current = null; pump(); } });
ipcMain.on("line-playing", (_e, { id }) => {
  const line = current?.id === id ? current : null;
  if (!line) return;
  const now = Date.now();
  if (line.t.detect && line.kind === "take" && !line.t.reported) metric({ what: line.firstOfCoin ? "first words" : line.verdict ? "x verdict" : "take line", ms: now - line.t.detect, coin: line.coin?.symbol, audio: line.voice ? `voice, first byte +${line.t.firstByte ? line.t.firstByte - line.t.made : "?"} ms` : "text" });
  if (line.t.ask && line.firstOfAnswer) metric({ what: "answer first words", ms: now - line.t.ask, voice: line.voice });
  line.t.reported = true;
});
let startupLogged = false;
ipcMain.on("ready", () => { pageReady = true; current = null; send("prefs", publicPrefs()); pump(); if (!startupLogged) { startupLogged = true; metric({ what: "startup", ms: Date.now() - T0 }); } });
/** a new coin: drop what was still waiting about the old one, and cut off the line playing now */
function hush() { queue.length = 0; if (current) { send("hush"); current = null; } }
function mood(m, text, clear = false) { send("mood", { mood: m, text, clear }); }

// ------------------------------------------------------------------ what the balloon shows (structured, no raw strings)
// The card, built to be read at a glance (2026-11-05): up to three stamps (the story, the holders,
// their product), one list of findings with a level each (bad, warn, good, info), what would change the verdict, and
// the numbers. Every word comes from the checks; nothing here is written by the model.
const LV = { rigged: "bad", sketchy: "warn", ok: "good", info: "info", bad: "bad", warn: "warn", good: "good", works: "good", missing: "bad", fake: "bad" };
const RANK = { bad: 0, warn: 1, good: 2, info: 3 };
const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
function coinCard(f, q) {
  const m = f?.market || q?.market, L = f?.legit, st = f?.state || q?.state, S0 = f?.holderStamp, P = f?.probe;
  const mint = f?.mint || q?.mint;
  const people = (f?.holders || []).filter((h) => h.wallet);
  const top10 = people.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
  const verdict = L?.verdict || state.readVerdict || null;

  // the stamps
  const storyWord = !verdict ? null : /^copycat/.test(verdict) ? "Copycat" : cap(verdict);
  const tiles = [{
    label: "Story", word: storyWord || "Reading...",
    level: !verdict ? "info" : /legit/.test(verdict) ? "good" : /unverified/.test(verdict) ? "warn" : "bad",
    tag: L ? L.tag || null : verdict ? (can("legit") ? "full check running" : "first read only") : null,
  }];
  if (S0 && S0.word !== "unknown") tiles.push({
    label: "Holders", word: cap(S0.word), level: { rigged: "bad", sketchy: "warn", "too early": "info", fair: "good" }[S0.word] || "info",
    tag: `${S0.tag}${S0.notChecked?.includes("linked wallets") && !/rigged|sketchy/.test(S0.word) ? ", still checking" : ""}`, score: S0.score,
  });
  else if (f || q) tiles.push({ label: "Holders", word: "Reading...", level: "info", tag: null });
  if (P) tiles.push(P.error ? { label: "Product", word: "Couldn't test", level: "info", tag: null }
    : { label: "Product", word: cap(P.verdict), level: { works: "good", "partly works": "warn", "not built": "bad", simulated: "bad", unreachable: "info" }[P.verdict] || "info", tag: P.tag || null });
  else if (mint && state.probing === mint) tiles.push({ label: "Product", word: "Testing...", level: "info", tag: "trying their app" });

  // one list of findings, worst first; what the stamps or the numbers already say isn't repeated
  const items = [];
  const shownByHolders = /linked wallets|bought at launch|wallets are new/i;
  for (const r of L?.allReceipts || []) {
    if (/^product test/.test(r.source || "")) continue; // the product's own findings come next
    if (S0 && shownByHolders.test(r.title || "")) continue;
    items.push({ level: r.level || "info", title: r.title || r.text, detail: r.detail || null, source: r.source, w: r.weight || 0 });
  }
  for (const x of S0?.findings || []) {
    if (/^[\d,]+\+? holders$/.test(x.title || "")) continue; // in the numbers
    items.push({ level: LV[x.level] || "info", title: x.title || x.text, detail: x.detail || null, source: x.evidence, w: x.level === "rigged" ? 9.5 : x.level === "sketchy" ? 7.5 : 3 });
  }
  for (const x of f?.fees || []) items.push({ level: x.level, title: x.title, detail: x.detail, source: x.source, w: { bad: 9, warn: 6.5, good: 6, info: 2.5 }[x.level] || 2 });
  for (const x of (P && !P.error ? P.findings : []) || []) items.push({ level: LV[x.status] || "info", title: x.title, detail: x.detail, source: x.evidence, w: 6 });
  if (P?.secretKey) items.push({ level: "bad", title: "Its site leaks a secret key", detail: P.secretKey, source: "product test", w: 9 });
  const seen = new Set();
  const findings = items.filter((x) => { const k = (x.title || "").toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => RANK[a.level] - RANK[b.level] || b.w - a.w).slice(0, 6).map(({ w, ...x }) => x);

  // the numbers, as a small grid
  const age = f?.ageMin != null ? (f.ageMin < 60 ? `${f.ageMin}m` : f.ageMin < 2880 ? `${Math.round(f.ageMin / 60)}h` : `${Math.round(f.ageMin / 1440)}d`) : null;
  const numbers = [
    m ? ["Market cap", money(m.mcUsd)] : null,
    m ? ["Liquidity", money(m.liquidityUsd)] : null,
    m ? ["Volume 24h", money(m.volume?.h24)] : null,
    f?.holderCount ? ["Holders", `${f.holderCount.count.toLocaleString("en-US")}${f.holderCount.capped ? "+" : ""}`] : null,
    f?.holders ? ["Top 10", `${Math.round(top10)}%`] : null,
    age ? ["Age", age] : f?.pump && !f.pump.bonded ? ["Bonding", `${f.pump.progressPct}%`] : null,
  ].filter(Boolean);
  return {
    mint, symbol: f?.symbol || q?.symbol, name: f?.name || q?.name, image: f?.image || q?.image,
    mood: m?.change?.h1 != null ? Math.max(-1, Math.min(1, m.change.h1 / 25)) : 0,
    verdict, tiles, findings, numbers,
    now: st ? { text: st.text + (st.devSellingNow ? ` · ${st.devSellingNow}` : ""), kind: st.kind } : null,
    bonding: f?.pump && !f.pump.bonded && age ? `${f.pump.progressPct}% to bond` : null,
    wouldChange: L?.wouldChange || null,
  };
}

// ------------------------------------------------------------------ the coin you're at: instant, then deeper
const fresh = (e, ms) => e && Date.now() - e.at < ms;
let feed = null;
const watcher = makeWatcher((r) => {
  log(`reaction ${r.type}: ${r.text}`);
  if (!state.coin || r.mint !== state.coin.mint) return;
  if (r.type === "devSell" || r.type === "whaleSell") return; // not spoken (ask about it, or see the details)
  const sfx = { pump: "pump", dump: "dump", devSell: "dump", devRug: "rug", whaleSell: "dump", bonded: "pump" }[r.type];
  say(r.text, { mood: r.state, kind: "reaction", sfx, coin: coinCard(state.coin) });
}, log, { get feed() { return feed; } });

async function onCoin(address, source, url) {
  if (!address) return;
  const tDetect = Date.now();
  if (address === state.lastAddress && tDetect - state.lastAt < 4000) return; // tab events come in bursts
  state.lastAddress = address; state.lastAt = tDetect;
  let mint, pairHint;
  try { ({ mint, pairHint } = await resolveMint(address)); }
  catch (e) { log(`not a coin: ${address} (${e.message})`); return; }
  if (state.mint === mint && (state.coin || state.read) && tDetect - (state.coin?.at || state.read?.at || 0) < 2 * 60_000) { if (state.coin) send("coin", coinCard(state.coin)); return; }
  const tn = S().tone;
  hush(); watcher.stop();
  state.mint = mint; state.coin = null; state.quick = null; state.read = null; state.readVerdict = null; state.alarmed = false; state.feeSaid = null; state.history = [];
  const c = cacheFor(mint);
  log(`coin from ${source}: ${mint}${url ? ` (${url})` : ""}`);
  send("coin", null);
  mood("research", "Reading this coin...", true);
  try {
    // everything starts now, in parallel: the market look, the read's sources, and (in the background) the chain
    const quickP = fresh(c.quick, 60_000) ? Promise.resolve(c.quick.v) : quick(mint, pairHint).then((v) => (c.quick = { at: Date.now(), v }).v);
    quickP.then((q) => { if (state.mint === mint && !state.coin) { state.quick = q; send("coin", cardNow()); } }).catch(() => {});
    const fullP = fresh(c.full, 60_000) ? Promise.resolve(c.full.v) : research(mint, { pairHint, fetcher, log: (s) => log(`  research: ${s}`) }).then((v) => (c.full = { at: Date.now(), v }).v);
    fullP.catch(() => {});
    // 1. the read: what this coin is about, its source, real or not. Always the first thing pillbud says
    const readP = theRead(mint, { quickP, tDetect, cache: c }).catch((e) => { log(`read failed: ${e.stack || e.message}`); if (state.mint === mint) say("Hm, I couldn't read that one.", { mood: "think", kind: "info" }); });
    // 2. dev, holders, bundle: fetched in the background so asking about them is instant; shown in the details
    const f = await fullP;
    if (state.mint !== mint) return;
    if (fresh(c.legit, 15 * 60_000)) { f.legit = c.legit.v.legit; f.facts.legit = c.legit.v.facts; }
    if (state.read) f.read = state.read;
    state.coin = f;
    send("coin", coinCard(f));
    watcher.watch(f).catch((e) => log(`watch failed: ${e.message}`));
    const devWallets = f.dev ? [f.dev, ...(f.dev.others || [])].map((d) => d.wallet).filter(Boolean) : [];
    // linked wallets (shared funders, SOL or tokens moved between holders): chain only, so every tier. Started as soon
    // as the holders are known (launch buyers who still hold a real share are top holders anyway), not awaited: the
    // full check reuses the same promise, and the stamp updates when it lands
    if (!f.clusters && !f.clustersP) {
      const t0 = Date.now();
      f.clustersP = trench.clusters({ holders: f.holders || [], supply: f.mintInfo.supply, devWallets, mint, early: [] })
        .catch((e) => ({ unknown: e.message }))
        .then((cl) => {
          f.clusters = cl;
          log(`linked wallets in ${Date.now() - t0} ms (${Date.now() - tDetect} ms after the coin was seen): ${cl.unknown ? `unknown (${cl.unknown})` : cl.clusters.map((c) => `${c.wallets.length} hold ${c.holdsPct}% (${c.how.join(", ")})`).join("; ") || "none"}`);
          if (state.mint === mint) { holderMod.refresh(f); send("coin", coinCard(f)); if (state.read) warnIfAlarming(f, tn, mint); }
          return cl;
        });
    }
    // where the creator fees go: pump.fun's fee setup and the money (about a second, chain only, every tier)
    if (!f.feesP && (f.pump || mint.endsWith("pump"))) {
      const t0 = Date.now();
      f.feesP = feesMod.feeCheck({ mint, curveCreator: f.pump?.creator, pf: f.pumpApi || {}, devWallets: [...devWallets, f.pumpApi?.creator], supply: f.mintInfo.supply, launchedAt: f.createdAt })
        .catch((e) => ({ unknown: e.message }))
        .then((F) => { f.feeSetup = F; log(`fees in ${Date.now() - t0} ms: ${F.unknown ? `unknown (${F.unknown})` : F.mode}`); return F; });
    }
    if (!f.launch) f.launch = await trench.launch(mint, f.mintInfo.supply, devWallets).catch((e) => ({ unknown: e.message }));
    if (state.mint !== mint) return;
    f.facts.launch = f.launch.unknown ? { unknown: f.launch.unknown } : { devBoughtPct: f.launch.devBuyPct, bundlePct: f.launch.bundle.pct, bundleWallets: f.launch.bundle.wallets.length, snipersPct: f.launch.snipers.pct, sniperWallets: f.launch.snipers.wallets.length, note: "bundle = bought in the launch slot by others; snipers = the next 3 slots (~1.2 s)" };
    // what the launch buyers still hold now: the holder stamp's sharpest input
    if (!f.early) f.early = await holderMod.earlyNow(f).catch((e) => ({ unknown: e.message }));
    if (state.mint !== mint) return;
    holderMod.refresh(f);
    send("coin", coinCard(f));
    log(`holders: ${f.holderStamp.word} (${f.holderStamp.score}) ${f.holderStamp.tag}`);
    send("coin", coinCard(f));
    await readP; // the read speaks first; a truly alarming fact comes right after it
    if (state.mint !== mint) return;
    warnIfAlarming(f, tn, mint);
    if (f.feesP) { await f.feesP; if (state.mint !== mint) return; judgeFees(f, tn, mint); }
    // 3. the full LARP check (X, website, dev history, clusters) refines the read if it disagrees. Pro only
    if (!can("legit")) { log("free tier: no full LARP check"); return; }
    const x0 = x.credits();
    // the product test runs alongside the full check: a coin that claims an app gets its app tried
    const probeP = maybeProbe(f, mint, c);
    if (!f.legit) {
      await addLegit(f, { fetcher, log: (s) => log(`  ${s}`) });
      c.legit = { at: Date.now(), v: { legit: f.legit, facts: f.facts.legit } };
    }
    if (state.mint !== mint) return;
    holderMod.refresh(f);
    send("coin", coinCard(f));
    warnIfAlarming(f, tn, mint);
    refineRead(f, tn, mint);
    await probeP;
    if (state.mint !== mint) return;
    if (f.probe && !f.probe.error) { applyProbe(f); sayProbe(f, tn, mint); }
    applyFees(f);
    send("coin", coinCard(f));
    costEstimate(f, null, x.credits() - x0);
  } catch (e) {
    log(`research failed: ${e.stack || e.message}`);
    if (state.mint === mint && !state.read) say(`Hmm, I couldn't read that one.`, { mood: "think", kind: "info" });
  }
}

// ------------------------------------------------------------------ the read (src/read.js gathers, brain.readStream interprets)
const BADGE = { real: "looks legit", larp: "likely LARP", copycat: "copycat", unclear: "unverified" };
const cardNow = () => (state.coin ? coinCard(state.coin) : coinCard(null, state.quick));
async function theRead(mint, { quickP, tDetect, cache: c }) {
  const tn = S().tone;
  if (fresh(c.read, 10 * 60_000)) { // read in the last 10 minutes: say it again, instantly
    const r = c.read.v;
    state.read = r; state.readVerdict = r.badge;
    r.lines.forEach((l, i) => say(l, { kind: "take", mood: i === 0 ? r.mood : "talk", sfx: i === 0 ? r.sfx : null, coin: cardNow(), tDetect, mint }));
    if (r.details) send("details", r.details);
    return r;
  }
  const g = await readMod.gather(mint, { fetcher, quickP, client: brain.client, log });
  if (state.mint !== mint) return null;
  const search = g.path === "search" && can("legit");
  log(`read: a ${g.type} coin, ${g.path === "search" ? (search ? "no readable source, web search" : "no readable source (free tier: no web search)") : "source found"}; core facts in ${g.times.core} ms (${Object.entries(g.times).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  mood("research", search ? "Looking up what this is based on..." : "Reading it...");
  let mood0 = "point", sfx0 = null, n = 0, firstAt = null;
  const lines = [];
  // Sonnet for the read on pro (it was right on 12 of 12 live coins; Haiku broke the format on 5), Haiku on free or as the fallback
  const want = S().readModel && S().readModel !== "auto" ? S().readModel : can("legit") ? "claude-sonnet-5-5" : "claude-haiku-5-5";
  const opts = (model) => ({
    search, model, toneName: tn,
    onTag: (t) => { mood0 = t === "real" ? "celebrate" : t === "unclear" ? "point" : "think"; sfx0 = t === "larp" || t === "copycat" ? "larp" : t === "real" ? "legit" : null; state.readVerdict = BADGE[t]; },
    onSentence: (s) => {
      if (state.mint !== mint) return;
      if (firstAt == null) { firstAt = Date.now(); metric({ what: "read first words", ms: firstAt - tDetect, type: g.type, path: g.path, coreMs: g.times.core }); }
      lines.push(s);
      if (!(state.askedAt > tDetect)) say(s, { kind: "take", mood: n === 0 ? mood0 : "talk", sfx: n === 0 ? sfx0 : null, coin: cardNow(), tDetect, mint, append: n > 0 }); // a question cuts the read short
      n++;
    },
  });
  let r;
  try { r = await brain.readStream(g.facts, opts(want)); }
  catch (e) { if (n || want === "claude-haiku-5-5") throw e; log(`read: ${want} failed (${e.message}), Haiku instead`); r = await brain.readStream(g.facts, opts("claude-haiku-5-5")); }
  if (state.mint !== mint) return null;
  const read = {
    at: Date.now(), mint, type: g.type, path: g.path, facts: g.facts, text: r.text, lines, details: readMod.details(g, r.text), verdict: r.verdict, badge: BADGE[r.verdict] || null,
    mood: mood0, sfx: sfx0, usd: r.usd, times: { ...g.times, firstWordsMs: firstAt ? firstAt - tDetect : null, readMs: Date.now() - tDetect, modelFirstSentenceMs: r.firstSentenceMs },
  };
  state.read = read; state.readVerdict = read.badge; c.read = { at: Date.now(), v: read };
  if (state.coin) state.coin.read = read;
  send("coin", cardNow());
  send("details", read.details);
  log(`read (${r.model}, ${r.usage.input} in / ${r.usage.output} out, ${r.usage.searches} searches, $${r.usd.toFixed(4)}; first words ${read.times.firstWordsMs} ms after the coin was seen): ${r.text}`);
  metric({ what: "read", ms: read.times.readMs, firstWordsMs: read.times.firstWordsMs, type: g.type, path: g.path, verdict: r.verdict, model: r.model, usd: +r.usd.toFixed(4) });
  return read;
}

/** one line, only for something truly alarming: a serial rugger, a dev who dumped everything, a 50%+ bundle */
function warnIfAlarming(f, tn, mint) {
  if (state.alarmed || state.mint !== mint) return;
  const d = f.dev, b = f.launch?.bundle, h = f.legit?.checks?.devHistory;
  let line = null, sfx = null;
  if (h && !h.unknown && h.rugged >= 3) line = tone.line("serialRugger", { n: h.rugged }, tn);
  else if (d && !d.unknown && d.sold && d.holdsPct < 0.05 && d.soldPct >= 50) { line = tone.line("devOut", {}, tn); sfx = "rug"; }
  // what insiders still hold now beats what a bundle bought at launch (a bundle that already sold is no threat)
  else if (f.holderStamp?.word === "rigged") line = tone.line("rigged", { why: f.holderStamp.tag.charAt(0).toUpperCase() + f.holderStamp.tag.slice(1) }, tn);
  else if (b && b.pct >= 50 && !(f.early && !f.early.unknown && f.early.nowPct < 5)) line = tone.line("bundled", { pct: `${Math.round(b.pct)}%` }, tn);
  if (!line) return;
  state.alarmed = true;
  say(line, { kind: "take", mood: "panic", sfx, coin: coinCard(f), mint });
}

/** the full check disagrees with the read (e.g. it found the coin's claims aren't backed): one short update */
function refineRead(f, tn, mint) {
  const r = state.read, L = f.legit;
  if (!r || !L || state.mint !== mint) return;
  const cat = /LARP/.test(L.verdict) ? "larp" : /copycat/.test(L.verdict) ? "copycat" : /legit/.test(L.verdict) ? "real" : "unclear";
  const bad = (v) => v === "larp" || v === "copycat";
  if (!((bad(cat) && !bad(r.verdict)) || (cat === "real" && r.verdict === "larp"))) return;
  // the strongest finding's short title ("an older coin on the same story is bigger"), so the line never stops mid-address
  const top = L.receipts?.[0];
  const receipt = top ? tone.clean(top.title ? top.title.charAt(0).toLowerCase() + top.title.slice(1) : top.text).replace(/\.$/, "") : null;
  const head = cat === "real" ? "it looks legit after all" : cat === "copycat" ? "it's a copycat of an earlier coin" : "it's likely a LARP";
  log(`read refined: the read said ${r.verdict}, the full check says ${L.verdict}`);
  say(tone.shorten(`On a closer look, ${head}${receipt ? `: ${receipt}` : ""}.`, 22), { kind: "take", mood: "think", sfx: bad(cat) ? "larp" : "legit", coin: coinCard(f), mint });
}

/** the product test, if the coin claims a product and links a site (pro). One at a time; a coin switch discards it. */
async function maybeProbe(f, mint, c, { force = false } = {}) {
  if (!can("probe")) return null;
  if (fresh(c.probe, 30 * 60_000)) { f.probe = c.probe.v; f.facts.probe = probeFacts(f.probe); return f.probe; }
  const url = probeMod.target(f, state.read) || (force ? f.legit?.checks?.claims?.website || f.pumpApi?.website || f.market?.links?.website : null);
  if (!url || state.probing) return null;
  state.probing = mint;
  send("coin", coinCard(f));
  try {
    const claim = { name: f.name, ticker: f.symbol, description: f.legit?.checks?.claims?.description || null, whatTheReadSaid: state.read?.text || null };
    const r = await probeMod.productTest(url, { client: brain.client, claim, log: (s) => log(`  ${s}`) });
    if (TEST) { try { const dir = path.join(APP_DIR, "captures", "probe"); fs.mkdirSync(dir, { recursive: true }); r.shots.forEach((b, i) => fs.writeFileSync(path.join(dir, `${f.symbol || mint.slice(0, 6)}-${i + 1}.jpg`), b)); } catch { /* test pictures only */ } }
    delete r.shots;
    c.probe = { at: Date.now(), v: r };
    if (state.mint === mint) { f.probe = r; f.facts.probe = probeFacts(r); }
    metric({ what: "product test", coin: f.symbol, verdict: r.verdict, ms: r.ms, browseMs: r.browseMs, usd: r.usd });
    return r;
  } catch (e) {
    log(`product test failed: ${e.message}`);
    if (state.mint === mint) f.probe = { error: `couldn't test it (${e.message})` };
    return null;
  } finally { if (state.probing === mint) state.probing = null; }
}
const probeFacts = (r) => (r.error ? { productTest: r.error } : { productTest: { site: r.url, verdict: r.verdict, found: r.line, pressed: r.pressed || "no launch-app button", findings: r.findings.map((x) => `${x.status}: ${x.title}: ${x.detail} [${x.evidence}]`), wouldChangeIt: r.wouldChange, secretKeyInPage: r.secretKey || undefined } });

/** the coin's fee promises (its own description and site) against pump.fun's fee setup and the money */
function judgeFees(f, tn, mint) {
  const F = f.feeSetup;
  if (!F || F.unknown) return;
  const r = state.read?.facts;
  const site = (r?.sources || []).filter?.((s) => s.kind === "website").map((s) => `${s.title || ""}. ${s.description || ""}`) || [];
  const claims = feesMod.feeClaims([r?.coin?.description, f.pumpApi?.description, ...site]);
  const devCoins = f.legit?.checks?.devHistory?.otherCoins || 0;
  f.fees = feesMod.judge(claims, F, { ticker: f.symbol, devCoins });
  f.facts.fees = { setup: F.mode, promises: claims.map((c) => `${c.kind}: "${c.quote}"`), findings: f.fees.map((x) => `${x.level}: ${x.title}: ${x.detail}`) };
  log(`fees: ${F.mode}; ${claims.length ? claims.map((c) => c.kind).join(", ") : "no promise"}; ${f.fees.map((x) => `[${x.level}] ${x.title}`).join("; ") || "nothing to say"}`);
  send("coin", coinCard(f));
  // a promise gets one spoken line: it checks out, or it doesn't
  const p = f.fees.find((x) => x.claim && (x.level === "good" || x.level === "bad"));
  if (p && !state.feeSaid) {
    state.feeSaid = mint;
    say(tone.shorten(p.level === "good" ? `The fee promise checks out: ${p.title.charAt(0).toLowerCase()}${p.title.slice(1)}.` : `Heads up: ${p.title.charAt(0).toLowerCase()}${p.title.slice(1)}. ${p.detail.charAt(0).toUpperCase()}${p.detail.slice(1)}.`, 30), { kind: "take", mood: p.level === "good" ? "point" : "think", sfx: p.level === "bad" ? "larp" : null, coin: coinCard(f), mint });
  }
}
/** a fee promise that the money contradicts can't look legit (a claim that isn't real is a LARP) */
function applyFees(f) {
  const L = f.legit, bad = (f.fees || []).find((x) => x.claim && x.level === "bad");
  if (!L || !bad) return;
  L.receipts = [{ text: `${bad.title}: ${bad.detail}`, source: bad.source, weight: 9.5, level: "bad", title: bad.title, detail: bad.detail }, ...L.receipts].slice(0, 3);
  if (/legit/.test(L.verdict)) { L.verdict = "unverified"; L.tag = "its fee promise doesn't check out"; }
  f.facts.legit = { ...(f.facts.legit || {}), verdict: L.verdict };
}

/** a product that's simulated is a LARP (the claim isn't real); one that isn't built can't look legit */
function applyProbe(f) {
  const L = f.legit, P = f.probe;
  if (!L || !P || P.error) return;
  const add = (text, weight) => { L.receipts = [{ text, source: `product test: ${P.url}`, weight, level: "info", title: text }, ...L.receipts].slice(0, 3); };
  if (P.verdict === "simulated") { L.verdict = "likely LARP"; L.tag = "its product is simulated"; L.wouldChange = P.wouldChange; add(`its product is simulated: ${P.line}`, 10); }
  else if (P.verdict === "not built" && /legit/.test(L.verdict)) { L.verdict = "unverified"; L.tag = "its product isn't built"; L.wouldChange = P.wouldChange; add(`its product isn't built yet: ${P.line}`, 9); }
  else if (P.verdict === "partly works" && /legit/.test(L.verdict)) { L.verdict = "unverified"; L.tag = "its product only partly works"; L.wouldChange = P.wouldChange; add(`I tried the product and it only partly works: ${P.line}`, 8); }
  else if (P.verdict === "works" || P.verdict === "partly works") add(`I tried the product: ${P.line}`, 7);
  if (P.secretKey) add(`its site leaks a secret API key in its own code (${P.secretKey})`, 8);
  f.facts.legit = { ...(f.facts.legit || {}), verdict: L.verdict, wouldChangeIt: L.wouldChange };
}

function sayProbe(f, tn, mint) {
  if (state.mint !== mint || !f.probe || f.probe.error) return;
  const head = { works: "I tried their app and it works", "partly works": "I tried their app: it partly works", "not built": "I tried their app: it isn't built yet", simulated: "I tried their app: it's simulated", unreachable: "I tried their site, but it didn't load" }[f.probe.verdict];
  const bad = f.probe.verdict === "simulated" || f.probe.verdict === "not built";
  say(tone.shorten(`${head}. ${f.probe.line}`, 30), { kind: "take", mood: bad ? "think" : "point", sfx: bad ? "larp" : f.probe.verdict === "works" ? "legit" : null, coin: coinCard(f), mint });
}
const wantsProbe = (q) => /((does|is|are) (the |their |its )?(app|product|site|website|bot|tool|platform|agents?|dapp|game)s? (work|real|live|legit|actually)|try (the |their |its )?(app|product|site|bot|tool)|test (the |their |its )?(app|product|site|bot|tool)|is (the |their |its )?(tech|product) real)\b/i.test(q);

// ------------------------------------------------------------------ talking to it (push-to-talk, streamed answers)
async function ask(question, tAsk = Date.now()) {
  log(`question: ${question}`);
  // the question goes first: whatever was still queued (the rest of a read, an alert, an earlier answer) is dropped
  state.askedAt = Date.now();
  queue.length = 0;
  if (current) { send("hush"); current = null; }
  if (!question) { say("Didn't catch that. Hold the key and try again?", { kind: "answer", mood: "idle" }); return; }
  mood("think", `"${question}"`);
  const tn = S().tone;
  let n = 0;
  const onSentence = (s) => { const ln = say(s, { kind: "answer", mood: "talk", heard: n === 0 ? question : undefined, append: n > 0, coin: state.coin ? coinCard(state.coin) : undefined, tAsk }); if (ln && n === 0) ln.firstOfAnswer = true; n++; };
  try {
    if (wantsLook(question) || (!state.coin && /what('s| is) this (coin|token)/i.test(question))) { lookAtScreen("asked"); return; }
    if (!state.coin && !state.read) { const t = await brain.chat(question, onSentence, tn); log(`chat (${t.usage.input} in / ${t.usage.output} out, first sentence ${t.firstSentenceMs} ms)`); return; }
    // chain numbers older than 45 s refresh in the background (the next answer gets them); this one answers now
    if (state.coin && Date.now() - state.coin.at > 45_000 && !state.refreshing) {
      state.refreshing = true;
      const old = state.coin;
      research(old.mint, { pairHint: old.market?.pair, fetcher }).then((f) => {
        if (state.mint !== f.mint) return;
        for (const k of ["legit", "launch", "read", "early", "probe", "clusters", "feeSetup", "fees", "feesP"]) if (old[k]) f[k] = old[k];
        if (old.facts.fees) f.facts.fees = old.facts.fees;
        if (old.facts.legit) f.facts.legit = old.facts.legit;
        if (old.facts.launch) f.facts.launch = old.facts.launch;
        if (old.facts.probe) f.facts.probe = old.facts.probe;
        holderMod.refresh(f);
        state.coin = f; cache.get(f.mint).full = { at: Date.now(), v: f }; send("coin", coinCard(f));
      }).catch((e) => log(`refresh failed: ${e.message}`)).finally(() => { state.refreshing = false; });
    }
    const live = watcher.liveState();
    const r = state.read;
    const facts = {
      ...(state.coin?.facts || {}),
      read: r ? { whatItIs: r.text, details: r.details, type: r.type, coin: r.facts.coin, sources: r.facts.sources, lookalikes: r.facts.lookalikes, market: r.facts.market } : "still reading it",
      live: live ? `${live.changePct >= 0 ? "up" : "down"} ${Math.abs(live.changePct)}% in the last ${live.overMin} min (pushed live)` : undefined,
    };
    if (!state.coin) facts.chain = "dev, holders and bundle are still loading (a few seconds)";
    if (wantsLook(question)) { lookAtScreen("asked"); return; }
    if (wantsProbe(question) && state.coin) {
      if (!can("probe")) { say("Trying their app is a pro feature. Ask me anything else about it.", { kind: "answer", mood: "talk" }); return; }
      const f = state.coin;
      if (!f.probe || f.probe.error) {
        onSentence("Let me try their app. Give me about fifteen seconds.");
        await maybeProbe(f, f.mint, cacheFor(f.mint), { force: true });
        if (state.mint !== f.mint) return;
        if (!f.probe) { say("They don't link a site I can try.", { kind: "answer", mood: "think" }); return; }
        if (f.probe.error) { say("Hm, I couldn't test that one.", { kind: "answer", mood: "think" }); return; }
        applyProbe(f); send("coin", coinCard(f));
      }
      sayProbe(f, tn, f.mint);
      state.history.push({ q: question, a: f.probe.line });
      return;
    }
    if (brain.wantsDeep(question) && !can("deep")) { say("Deep research is a pro feature. Ask me anything else about it.", { kind: "answer", mood: "talk" }); return; }
    if (brain.wantsDeep(question)) {
      onSentence(tone.line("digging", {}, tn));
      const r = await brain.deepResearch(question, facts, onSentence, tn);
      log(`deep research (${r.usage.input} in / ${r.usage.output} out, ${r.usage.searches} searches, $${r.usd.toFixed(4)}, first sentence ${r.firstSentenceMs} ms, ${r.ms} ms)`);
      if (r.details) send("details", r.details);
      state.history.push({ q: question, a: "(researched it: see the balloon)" });
      return;
    }
    const t = await brain.answerStream(question, facts, state.history, onSentence, tn);
    state.history.push({ q: question, a: t.text }); state.history = state.history.slice(-5);
    log(`answer (${t.usage.input} in / ${t.usage.output} out, first sentence ${t.firstSentenceMs} ms): ${t.text}`);
  } catch (e) { log(`answer failed: ${e.message}`); say("My brain glitched on that one. Try again?", { mood: "panic", kind: "answer" }); }
}

async function askAudio(buf, type) {
  const tAsk = Date.now();
  mood("listen", "...");
  try {
    const t = await voice.transcribe(buf, type);
    log(`heard (${t.engine}, ${t.ms} ms): ${t.text}`);
    metric({ what: "transcribe", ms: t.ms, audioSec: t.audioSec });
    ask(t.text.trim(), tAsk);
    return t;
  } catch (e) { log(`transcribe failed: ${e.message}`); say("My ears aren't working right now.", { mood: "panic", kind: "answer" }); return { error: e.message }; }
}
ipcMain.handle("ask-audio", (_e, { data, type }) => askAudio(Buffer.from(data), type));
ipcMain.on("interactive", (_e, on) => { if (win) win.setIgnoreMouseEvents(!on, { forward: true }); });
ipcMain.on("move-by", (_e, { dx, dy }) => { if (!win) return; anchor.left += dx; anchor.bottom += dy; const [w, h] = win.getSize(); win.setBounds({ x: Math.round(anchor.left), y: Math.round(anchor.bottom - h), width: w, height: h }); });
// full size while the balloon shows, compact (just the buddy) otherwise: fewer pixels to copy out every frame
let anchor = null, sizes = null, sizeNow = "full";
ipcMain.on("win-size", (e, which) => {
  if (win && sizes && which !== sizeNow && !TEST) {
    const [w, h] = sizes[which];
    win.setBounds({ x: Math.round(anchor.left), y: Math.round(anchor.bottom - h), width: w, height: h });
    sizeNow = which;
  }
  e.returnValue = true;
});
ipcMain.on("log", (_e, s) => log(`[ui] ${s}`));
ipcMain.on("sfx-export", (_e, { name, wav }) => { const dir = path.join(APP_DIR, "captures", "sfx"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name}.wav`), Buffer.from(wav)); log(`sfx exported: ${name}.wav`); });

// ------------------------------------------------------------------ the extension's door (localhost only)
function startServer() {
  const srv = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    // only the extension (chrome-extension://) or local tools with no Origin; a web page can't drive pillbud
    if (origin && !origin.startsWith("chrome-extension://")) { res.writeHead(403).end(); return; }
    res.setHeader("access-control-allow-origin", origin || "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const body = await new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o)); };
    try {
      if (req.method === "GET" && req.url === "/status") return json(200, { ok: true, app: "pillbud", coin: state.coin ? { mint: state.coin.mint, symbol: state.coin.symbol } : null, voice: voice.status(), x: x.mode(), prefs: publicPrefs(), keys: keyStatus() });
      if (req.method === "POST" && req.url === "/coin") {
        const j = JSON.parse(String(body) || "{}");
        const hit = j.url ? fromUrl(j.url) : null;
        const address = hit?.address || j.address;
        if (!address) return json(400, { error: "no address" });
        onCoin(address, `extension (${hit?.site || j.site || "?"})`, j.url); // research starts the moment the URL is seen
        return json(200, { ok: true, address });
      }
      // local test hooks (no Origin header = not a web page)
      if (!origin && req.method === "POST" && req.url.startsWith("/debug/ask-audio")) return json(200, await askAudio(body, req.headers["content-type"] || "audio/wav"));
      if (!origin && req.method === "POST" && req.url === "/debug/ask-text") { ask(String(body)); return json(200, { ok: true }); }
      if (!origin && req.method === "POST" && req.url === "/debug/pref") { const j = JSON.parse(String(body)); for (const [k, v] of Object.entries(j)) setPref(k, v); if ("balloonSize" in j) applyBalloonSize(); send("prefs", publicPrefs()); return json(200, publicPrefs()); }
      if (!origin && req.method === "POST" && req.url === "/debug/say") { const j = JSON.parse(String(body)); say(j.text, j); return json(200, { ok: true }); }
      if (!origin && req.method === "POST" && req.url === "/debug/sfx-export") { send("sfx-export"); return json(200, { ok: true }); }
      if (TEST && !origin && req.method === "POST" && req.url === "/debug/look-image") return json(200, await lookAtImage(body, "test image")); // the vision path on a given image
      if (TEST && !origin && req.method === "GET" && req.url === "/debug/capture-timing") { // times a capture; the image is discarded, never saved or sent
        const t0 = Date.now(); const src = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1568, height: 1568 }, fetchWindowIcons: false });
        const ms = Date.now() - t0; const size = src[0]?.thumbnail.getSize(); const jpegKB = src[0] ? Math.round(src[0].thumbnail.toJPEG(80).length / 1024) : null;
        return json(200, { ms, size, jpegKB, visionTokensEstimate: size ? Math.round((size.width * size.height) / 750) : null });
      }
      if (TEST && !origin && req.method === "POST" && req.url === "/debug/screen-pause") { screenWatcher?.pause(); return json(200, { ok: true }); }
      if (TEST && !origin && req.method === "POST" && req.url === "/debug/screen-resume") { screenWatcher?.resume(); return json(200, { ok: true }); }
      if (TEST && !origin && req.method === "POST" && req.url === "/debug/screen-file") { screenWatcher?.ocrFile(String(body)); return json(200, { ok: true, at: Date.now() }); }
      if (!origin && req.method === "POST" && req.url === "/debug/resume") { onResume("test"); return json(200, { ok: true }); }
      if (!origin && req.method === "POST" && req.url === "/debug/drop-feed") { feed?.drop(); return json(200, { ok: true }); }
      if (!origin && req.method === "GET" && req.url.startsWith("/debug/perf")) return json(200, await perf(Number(new URL(req.url, "http://x").searchParams.get("s") || 5)));
      if (!origin && req.method === "GET" && req.url === "/debug/health") return json(200, health());
      if (!origin && req.method === "GET" && req.url === "/debug/log") return json(200, state.log.slice(-150));
      if (!origin && req.method === "GET" && req.url === "/debug/metrics") return json(200, state.metrics);
      if (TEST && !origin && req.method === "GET" && req.url === "/debug/lines") return json(200, sentLines); // what was said (test mode: for the demo recordings)
      if (TEST && !origin && req.method === "GET" && req.url.startsWith("/debug/pumpfun?path=")) { // test mode: pump.fun lists, through the app's network stack
        const pth = decodeURIComponent(req.url.slice("/debug/pumpfun?path=".length));
        if (!/^\/[\w\-/?=&.,%]+$/.test(pth)) return json(400, { error: "bad path" });
        try { const r = await fetcher(`https://frontend-api-v3.pump.fun${pth}`, { headers: { accept: "application/json" } }); return json(r.status, await r.json()); } catch (e) { return json(500, { error: e.message }); }
      }
      if (TEST && !origin && req.method === "POST" && req.url === "/debug/read") { // test mode: the read on one coin, facts gathered once, each model run on them
        const { mint, models = [S().readModel] } = JSON.parse(String(body));
        try {
          const t0 = Date.now();
          const g = await readMod.gather(mint, { fetcher, quickP: quick(mint), client: brain.client, log });
          const results = [];
          for (const model of models) {
            const r = await brain.readStream(g.facts, { search: g.path === "search", model });
            results.push({ model, text: r.text, details: r.details, verdict: r.verdict, firstSentenceMs: r.firstSentenceMs, ms: r.ms, usd: +r.usd.toFixed(5), searches: r.usage.searches, readFirstWordsMs: g.times.core + (r.firstSentenceMs || r.ms) });
          }
          return json(200, { mint, type: g.type, path: g.path, gatherMs: Date.now() - t0 - results.reduce((s, x) => s + x.ms, 0), times: g.times, facts: g.facts, results });
        } catch (e) { return json(500, { error: e.stack || e.message }); }
      }
      if (TEST && !origin && req.method === "POST" && req.url === "/debug/scroll") { // test mode: scroll the balloon's details to a section, for the screenshots
        const id = String(body || "stamps").replace(/[^a-z]/g, "");
        await win.webContents.executeJavaScript(`(() => { const s = document.getElementById("scroll"), e = document.getElementById(${JSON.stringify("x")}.replace("x", "${id}")); if (s && e) s.scrollTop = e.offsetTop - s.offsetTop; return true; })()`);
        return json(200, { ok: true });
      }
      if (TEST && !origin && req.method === "GET" && req.url === "/debug/card") { // test mode: the card and the read as shown, for the site's demo data
        const r = state.read;
        return json(200, { mint: state.mint, card: cardNow(), read: r && { text: r.text, lines: r.lines, details: r.details, verdict: r.verdict, badge: r.badge, type: r.type, path: r.path, times: r.times } });
      }
      if (TEST && !origin && req.method === "GET" && req.url === "/debug/page") {
        const st = await win.webContents.executeJavaScript(`JSON.stringify({ balloon: document.getElementById("balloon").className, opacity: getComputedStyle(document.getElementById("balloon")).opacity, text: document.getElementById("text").textContent.slice(0, 120), current: current && current.meta.id, state: bud.state })`);
        return json(200, { ...JSON.parse(st), mainCurrent: current?.id ?? null, queued: queue.length });
      }
      if (TEST && !origin && req.method === "POST" && req.url === "/debug/anim") { // test mode: play one animation (with a read in the balloon), for the screenshots
        const j = JSON.parse(String(body) || "{}");
        if (j.text != null) send("details", { whatItIs: j.text, source: j.source || null, receipt: j.receipt || null });
        send("mood", { mood: j.state || "idle", hold: j.hold || 8000 });
        return json(200, { ok: true });
      }
      if (!origin && req.method === "GET" && req.url === "/debug/capture") { const img = await win.webContents.capturePage(); res.writeHead(200, { "content-type": "image/png" }).end(img.toPNG()); return; }
      if (!origin && req.method === "POST" && req.url === "/debug/quit") { json(200, { ok: true }); setTimeout(() => app.quit(), 200); return; }
      json(404, { error: "no" });
    } catch (e) { json(500, { error: e.message }); }
  });
  srv.on("error", (e) => log(`server: ${e.message}`));
  srv.listen(S().port, "127.0.0.1", () => log(`listening on 127.0.0.1:${S().port}`));
}

// ------------------------------------------------------------------ clipboard
function watchClipboard() {
  let last = clipboard.readText(); // whatever was there at startup doesn't count
  setInterval(() => {
    if (!S().clipboard || (TEST && process.env.PILLBUD_TEST_CLIPBOARD !== "1")) return;
    const t = clipboard.readText();
    if (t === last) return;
    last = t;
    const hit = fromClipboard(t);
    if (hit) onCoin(hit.address, "clipboard");
  }, 500);
}

// ------------------------------------------------------------------ push-to-talk hotkey (hold)
function setupHotkey() {
  let holding = false;
  const start = () => { if (holding) return; holding = true; send("ptt", "start"); };
  const stop = () => { if (!holding) return; holding = false; send("ptt", "stop"); };
  let hook = null;
  try { hook = require("uiohook-napi"); } catch { hook = null; }
  // globalShortcut swallows the keys so the space doesn't land in the browser; the hook sees the key going up
  const ok = globalShortcut.register(S().hotkey, () => { if (hook) start(); else (holding ? stop() : start()); });
  if (hook) {
    const { uIOhook, UiohookKey: K } = hook;
    // Hold Ctrl + Alt to talk (2026-11-05). Windows shortcuts can't be just two modifiers, so the key hook watches
    // them: talking starts once only Ctrl and Alt have been held for a moment. Another key joining in (Ctrl + Alt + L,
    // Ctrl + Alt + Delete, an AltGr character) makes it a shortcut: nothing starts, or the recording is dropped.
    const CTRL = [K.Ctrl, K.CtrlRight], ALT = [K.Alt, K.AltRight];
    const down = new Set();
    let comboTimer = null, byCombo = false;
    const both = () => CTRL.some((k) => down.has(k)) && ALT.some((k) => down.has(k));
    const onlyBoth = () => both() && [...down].every((k) => CTRL.includes(k) || ALT.includes(k));
    uIOhook.on("keydown", (e) => {
      down.add(e.keycode);
      if (S().holdCtrlAlt === false) return;
      if (onlyBoth()) { if (!holding && !comboTimer) comboTimer = setTimeout(() => { comboTimer = null; if (onlyBoth()) { byCombo = true; start(); } }, 220); }
      else {
        clearTimeout(comboTimer); comboTimer = null;
        if (holding && byCombo) { holding = false; byCombo = false; send("ptt", "cancel"); }
      }
    });
    uIOhook.on("keyup", (e) => {
      down.delete(e.keycode);
      if (comboTimer && !both()) { clearTimeout(comboTimer); comboTimer = null; }
      if (holding && byCombo && !both()) { byCombo = false; stop(); return; }
      // the other combo (Ctrl + Shift + Space) ends when any of its keys goes up
      if (holding && !byCombo && [K.Space, K.Ctrl, K.CtrlRight, K.Shift, K.ShiftRight].includes(e.keycode)) stop();
    });
    uIOhook.start();
  }
  log(`push-to-talk: ${hook && S().holdCtrlAlt !== false ? "hold Ctrl + Alt, or " : ""}${ok ? `hold ${S().hotkey}` : "hotkey unavailable"}${hook ? "" : " (tap to start / tap to stop)"}; or click and hold the buddy`);
  // the first free one of these (another app may own Ctrl+Shift+L)
  lookKey = [S().lookHotkey, "Control+Alt+L", "Control+Shift+K"].find((k) => { try { return globalShortcut.register(k, () => lookAtScreen("hotkey")); } catch { return false; } }) || null;
  log(`look closer: ${lookKey || "no free hotkey (use the tray)"}`);
}

// ------------------------------------------------------------------ tray: show/hide, mode, tone, volume, mute, DND
function setupTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(APP_DIR, "assets", "tray.png")));
  const set = (k, v) => { setPref(k, v); send("prefs", publicPrefs()); tray.setContextMenu(menu()); };
  const menu = () => {
    const s = S();
    return Menu.buildFromTemplate([
      { label: state.coin ? `On $${state.coin.symbol || "?"}` : "No coin yet", enabled: false },
      { type: "separator" },
      { label: win?.isVisible() ? "Hide pillbud" : "Show pillbud", click: () => { toggleVisible(); tray.setContextMenu(menu()); } },
      { label: "Text and sound effects", type: "radio", checked: s.mode !== "voice", click: () => set("mode", "text") },
      { label: "Voice (ElevenLabs)", type: "radio", checked: s.mode === "voice", click: () => set("mode", "voice") },
      { label: "Text voice", submenu: [["babble", "Babble (Animalese-style)"], ["beeps", "Character beeps"], ["blips", "Soft blips"]].map(([v, l]) => ({ label: l, type: "radio", checked: (s.textVoice || "beeps") === v, click: () => set("textVoice", v) })) },
      { type: "separator" },
      { label: "Tone: friendly", type: "radio", checked: s.tone !== "unhinged", click: () => set("tone", "friendly") },
      { label: "Tone: unhinged", type: "radio", checked: s.tone === "unhinged", click: () => set("tone", "unhinged") },
      { type: "separator" },
      { label: "Balloon look", submenu: BALLOON_LOOKS.map(([v, l]) => ({ label: l, type: "radio", checked: (s.balloonLook || "brand") === v, click: () => set("balloonLook", v) })) },
      { label: "Balloon size", submenu: BALLOON_SIZES.map(([v, l]) => ({ label: l, type: "radio", checked: (s.balloonSize || "normal") === v, click: () => { set("balloonSize", v); applyBalloonSize(); } })) },
      { label: "Volume", submenu: [0.25, 0.5, 0.75, 1].map((v) => ({ label: `${v * 100}%`, type: "radio", checked: Math.abs(s.volume - v) < 0.01, click: () => set("volume", v) })) },
      { label: "Mute", type: "checkbox", checked: !!s.muted, click: () => set("muted", !s.muted) },
      { label: "Do not disturb", type: "checkbox", checked: !!s.dnd, click: () => set("dnd", !s.dnd) },
      { label: "Hold Ctrl + Alt to talk", type: "checkbox", checked: s.holdCtrlAlt !== false, click: () => set("holdCtrlAlt", s.holdCtrlAlt === false) },
      { label: "Watch my screen (local OCR)", type: "checkbox", checked: s.watchScreen !== false, click: () => { set("watchScreen", s.watchScreen === false); if (S().watchScreen === false) screenWatcher?.stop(); else { screenWatcher = newScreenWatcher(); screenWatcher.start(); } } },
      { label: `Look closer (Claude vision${lookKey ? `, ${lookKey.replace(/Control/, "Ctrl")}` : ""})`, enabled: can("lookCloser"), click: () => lookAtScreen("tray") },
      { label: "Read my browser tab", type: "checkbox", checked: s.tabReader !== false, click: () => { set("tabReader", s.tabReader === false); if (S().tabReader === false) tabReader?.stop(); else { tabReader = newTabReader(); tabReader.start(); } } },
      { label: "Start with Windows", type: "checkbox", checked: loginItem().openAtLogin, click: () => { const on = !loginItem().openAtLogin; app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginArgs() }); tray.setContextMenu(menu()); } },
      { label: "Re-read this coin", enabled: !!state.coin, click: () => { const m = state.coin.mint; cache.delete(m); state.mint = null; state.lastAddress = null; onCoin(m, "tray"); } },
      { type: "separator" },
      { label: "Quit", click: () => quit("tray") },
    ]);
  };
  tray.setToolTip("pillbud");
  tray.setContextMenu(menu());
  tray.on("click", () => { toggleVisible(); tray.setContextMenu(menu()); });
  setInterval(() => tray.setContextMenu(menu()), 5000);
}

// ------------------------------------------------------------------ the active browser tab, without an extension
let tabReader = null;
const VIDEO = /(^|\.)(twitch\.tv|youtube\.com|youtu\.be|kick\.com|netflix\.com|primevideo\.com|disneyplus\.com|hulu\.com|max\.com|spotify\.com|tiktok\.com)$/;
function newTabReader() {
  return makeTabReader({
    log,
    onHost: (host, browser, hwnd) => { // a video tab in front: no point OCR-ing that window; any new tab: look again soon
      screenWatcher?.skip(host && VIDEO.test(host) ? hwnd : 0);
      screenWatcher?.kick();
    },
    onCoinUrl: (url, hit, browser) => {
      if (TEST) { log(`tab reader (dry run): a ${hit.site} coin page in ${browser}`); return; }
      onCoin(hit.address, `tab (${browser}, ${hit.site})`, url);
    },
  });
}

// ------------------------------------------------------------------ "watch my screen": local OCR, on by default
let screenWatcher = null, lookKey = null;
function newScreenWatcher() {
  const dry = TEST && process.env.PILLBUD_TEST_SCREEN_LIVE !== "1";
  return makeScreenWatcher({
    log, fetcher, dry, currentMint: () => state.mint, apps: S().watchApps || [],
    onCoin: (mint, source, r, isDry) => { if (isDry) { metric({ what: "screen found (dry run)", how: r.how }); if (process.env.PILLBUD_TEST_SCREEN_ACT === "1") onCoin(mint, source); return; } state.lastAddress = null; onCoin(mint, source); },
  });
}

/** what one coin cost to read (estimate, for pricing): Claude + X + Helius credits + ElevenLabs credits */
function costEstimate(f, v, xCredits) {
  const claude = (f.legit?.narrativeUsd || 0) + (f.probe?.usd || 0) + (f.read?.usd || state.read?.usd || 0) + ((v?.usage?.input || 0) * 0.10 + (v?.usage?.output || 0) * 0.50) / 1e6;
  const ttsChars = [...queue, current].filter((l) => l && l.mint === f.mint && l.voice).reduce((s, l) => s + l.text.length, 0) + 150; // + the lines already spoken
  metric({ what: "coin cost", coin: f.symbol, tier: S().tier, claudeUsd: +claude.toFixed(4), xUsd: +(xCredits / 100000).toFixed(4), heliusCredits: (f.heliusCredits || 0) + (f.legit?.heliusCredits || 0), elevenCredits: Math.round(ttsChars * 0.22) });
}

// ------------------------------------------------------------------ "look at this": on demand only
const wantsLook = (q) => /\b(look at (this|that|my screen|the screen)|what('s| is) on (my|the) screen|what am i looking at|check (this|my screen) out)\b/i.test(q);
let looking = false;
/** capture the window in front (or the whole screen), read it with Claude's vision, research the coin on it */
async function lookAtScreen(why) {
  if (looking) return;
  if (!can("lookCloser")) { say("Look closer is a pro feature. I'm still watching your screen locally.", { kind: "info" }); return; }
  looking = true;
  const t0 = Date.now();
  try {
    mood("think", "Looked at your screen (the window in front), finding the coin...");
    const own = win ? Number(win.getNativeWindowHandle().readBigUInt64LE(0)) : null;
    const fg = tabReader?.state.fg && tabReader.state.fg !== own ? tabReader.state.fg : null;
    const sources = await desktopCapturer.getSources({ types: fg ? ["window", "screen"] : ["screen"], thumbnailSize: { width: 1568, height: 1568 }, fetchWindowIcons: false });
    const src = (fg && sources.find((s) => s.id.startsWith(`window:${fg}:`))) || sources.find((s) => s.id.startsWith("screen:")) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error("nothing to capture");
    const jpeg = src.thumbnail.toJPEG(80);
    const tCap = Date.now() - t0;
    log(`looked at the screen (${why}): ${src.id.startsWith("window:") ? "the window in front" : "the whole screen"}, ${src.thumbnail.getSize().width}x${src.thumbnail.getSize().height}, captured in ${tCap} ms`);
    const r = await lookAtImage(jpeg, why, t0);
    return r;
  } catch (e) { log(`look failed: ${e.message}`); say("I couldn't read your screen just now.", { kind: "info", mood: "panic" }); }
  finally { looking = false; }
}
/** the vision half (also used by tests with a given image) */
async function lookAtImage(jpeg, why, t0 = Date.now()) {
  if (!Buffer.isBuffer(jpeg)) jpeg = Buffer.from(jpeg);
  if (jpeg[0] === 0x89) jpeg = nativeImage.createFromBuffer(jpeg).toJPEG(80); // a PNG from a test
  const found = await look.read(jpeg);
  const where = found.where ? ` on ${String(found.where).split(/[(,]/)[0].trim()}` : "";
  log(`look: ${JSON.stringify({ ca: found.ca ? `${found.ca.slice(0, 4)}...` : null, partial: found.caPartial, ticker: found.ticker, name: found.name, where: found.where, notable: found.notable })} (${found.usage.input} in / ${found.usage.output} out, $${found.usd.toFixed(5)}, ${found.ms} ms)`);
  const res = await look.resolve(found, fetcher).catch(() => null);
  metric({ what: "look", ms: Date.now() - t0, visionMs: found.ms, usd: +found.usd.toFixed(5), found: res ? res.how : "no coin" });
  if (!res) { say(found.ticker || found.name ? `I see ${found.ticker ? `$${found.ticker}` : found.name}${where}, but I can't pin down which coin it is.` : "I don't see a coin on your screen.", { kind: "info", mood: "think" }); return { found, res: null }; }
  if (found.notable) say(tone.shorten(`On your screen${where}: ${found.notable}`, 18), { kind: "info", mood: "point" });
  state.lastAddress = null;
  onCoin(res.mint, `screen (${why}${where})`);
  return { found, res };
}

// ------------------------------------------------------------------ staying healthy: sleep/resume, network, quit
function onResume(why) {
  log(`resumed (${why}): reconnecting the feed, checking the tab reader`);
  feed?.drop(); // a socket that slept is often half-dead without knowing it
  tabReader?.ensure();
  screenWatcher?.ensure(); screenWatcher?.resume();
}
function health() {
  const m = app.getAppMetrics();
  return {
    uptimeS: Math.round((Date.now() - T0) / 1000), feed: { connected: feed?.connected(), accounts: feed?.count(), reconnects: feed?.reconnects?.() },
    tabReader: tabReader ? { running: tabReader.running(), pid: tabReader.pid() } : null,
    screen: screenWatcher ? { running: screenWatcher.running(), pid: screenWatcher.pid(), ...screenWatcher.stats, avgOcrMs: screenWatcher.stats.frames ? Math.round(screenWatcher.stats.ocrMs / screenWatcher.stats.frames) : null } : null, cache: cache.size, queue: queue.length, log: state.log.length,
    mainHeapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1), mainRssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    processes: m.map((p) => ({ type: p.type, cpu: +p.cpu.percentCPUUsage.toFixed(2), memMB: Math.round(p.memory.workingSetSize / 1024) })),
  };
}
/** frame pacing of the character's animation, measured in the page over s seconds */
async function perf(s = 5) {
  if (!win) return null;
  const r = await win.webContents.executeJavaScript(`new Promise((ok) => { const requestAnimationFrame = window.__nativeRAF || window.requestAnimationFrame; window.frames60 && frames60.active(${s * 1000 + 500}); const d = []; let last = performance.now(); const end = last + ${s * 1000};
    function f(t) { d.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else { d.shift(); const s = [...d].sort((a, b) => a - b);
      ok({ frames: d.length, fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p50: +s[Math.floor(s.length * .5)].toFixed(1), p99: +s[Math.floor(s.length * .99)].toFixed(1), over20ms: d.filter((x) => x > 20).length, over50ms: d.filter((x) => x > 50).length }); } }
    requestAnimationFrame(f); })`);
  return { ...r, cpu: health().processes };
}
/** hide/show from the tray; while hidden the page stops animating */
function toggleVisible() { if (!win) return; if (win.isVisible()) { win.hide(); send("visible", false); } else { win.showInactive(); send("visible", true); } }
const loginArgs = () => [APP_DIR];
const loginItem = () => app.getLoginItemSettings({ path: process.execPath, args: loginArgs() });
function quit(why) { log(`quit (${why})`); app.quit(); }

// ------------------------------------------------------------------ boot
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required"); // it talks without being clicked first
if (!TEST && !app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  feed = makeFeed(log);
  createWindow();
  if (!TEST) setupTray();
  startServer();
  watchClipboard();
  if (!TEST) setupHotkey();
  // local Whisper and the Windows voice are fallbacks: start them only when they're needed (saves ~300 MB of RAM)
  if (S().stt === "local") voice.startWhisper(log);
  // the active browser tab's URL (no extension needed); test instances only run it when asked, and then dry
  if (!TEST || process.env.PILLBUD_TEST_TABREADER === "1") { if (S().tabReader !== false) { tabReader = newTabReader(); tabReader.start(); } }
  // warm the connections the read needs first (pump.fun through the app's network stack, fxtwitter): the first coin's read is ~0.7 s faster
  setTimeout(() => { fetcher("https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=1&includeNsfw=false").catch(() => {}); fetch("https://api.fxtwitter.com/", { method: "HEAD" }).catch(() => {}); }, 1500);
  if ((!TEST || process.env.PILLBUD_TEST_SCREEN === "1") && S().watchScreen !== false) { screenWatcher = newScreenWatcher(); screenWatcher.start(); }
  powerMonitor.on("resume", () => onResume("system resume"));
  powerMonitor.on("unlock-screen", () => { screenWatcher?.resume(); onResume("unlock"); });
  powerMonitor.on("lock-screen", () => { screenWatcher?.pause(); log("screen locked: screen watching paused"); });
  powerMonitor.on("suspend", () => screenWatcher?.pause());
  const ks = keyStatus();
  log(`keys present: ${Object.entries(ks).map(([k, v]) => `${k}=${v ? "yes" : "NO"}`).join(", ")}; X research: ${x.mode()}`);
  if (TEST) log("TEST MODE: off-screen window, no tray, no hotkey, audio saved to captures/audio and not played");
  setTimeout(() => say(tone.greeting(S().tone), { mood: "wave", kind: "info", sfx: "hello" }), 600);
});
app.on("will-quit", () => { globalShortcut.unregisterAll(); voice.stopVoices(); try { tabReader?.stop(); } catch { /* gone */ } try { screenWatcher?.stop(); } catch { /* gone */ } try { feed?.close(); } catch { /* gone */ } try { require("uiohook-napi").uIOhook.stop(); } catch { /* no hook */ } });
app.on("window-all-closed", (e) => e.preventDefault()); // lives in the tray
