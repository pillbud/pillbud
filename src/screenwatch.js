// "Watch my screen": the local screen reader. src/native/pillbud-screenwatch.exe captures the window in front every
// 1.5 s and runs Windows' own OCR on it (nothing leaves the PC there). This file scans that text for a coin:
//   1. a full contract address that checks out (base58, 32 bytes)
//   2. a near-miss address (OCR swapped a character or two) or a shortened one ("Hspr...pump") next to a ticker or
//      name on the same screen: the coins with that ticker are looked up and the address is matched (edit distance)
//   3. a $TICKER next to "MC"/"market cap"/"liq", seen on 2 frames in a row (tickers alone are noisy)
// Only then does anything leave the PC (DexScreener / pump.fun lookups of that one candidate). The screen text itself is
// never logged or sent anywhere.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isAddress, resolveMint } = require("./detect");
const { getJson } = require("./research/net");

const MAJORS = new Set(["SOL", "USD", "USDC", "USDT", "BTC", "ETH", "WSOL", "JUP", "MC", "LIQ", "ATH", "DYOR", "CA", "PM", "AM", "API", "NFT", "CEO", "AI", "TX", "TPS", "KOL", "OK", "LOL", "GM", "GN"]);
const CONTEXT = /\b(MC|M\.C\.|mcap|market ?cap|liq|liquidity|holders|bonding|volume|vol|fdv)\b/i;

/** the coin hints in one frame of OCR text (pure: no network) */
function extract(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const exact = new Set(), near = new Set(), partials = [], tickers = new Map(); // ticker -> context strength
  lines.forEach((line, i) => {
    const compact = line.replace(/\s+/g, "");
    for (const m of compact.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []) if (isAddress(m)) exact.add(m);
    for (const m of compact.match(/[A-Za-z0-9[\]|]{38,48}/g) || []) if (!exact.has(m) && (/pump$/i.test(m) || m.length >= 42)) near.add(m.replace(/^(CA:?|Token:?)/i, ""));
    const pm = /([1-9A-HJ-NP-Za-km-z]{3,6})\s*(?:\.{2,3}|…)\s*([1-9A-HJ-NP-Za-km-z]{3,6})/.exec(line);
    if (pm) partials.push({ pre: pm[1], suf: pm[2] });
    const ctx = [lines[i - 2], lines[i - 1], line, lines[i + 1], lines[i + 2]].filter(Boolean).some((l) => CONTEXT.test(l));
    // "$AMD"; OCR often reads "$" as "S" ("SAMD", "(SGATO)"): those only help match an address, never trigger alone
    for (const m of line.matchAll(/(?:^|[\s(])([$S])([A-Z][A-Z0-9]{1,9})\b/g)) {
      const t = m[2], realDollar = m[1] === "$";
      if (MAJORS.has(t) || (!realDollar && MAJORS.has("S" + t)) || (!realDollar && t.length < 3)) continue; // "SOL" isn't "$OL"
      tickers.set(t, Math.max(tickers.get(t) || 0, realDollar && ctx ? 2 : 1));
    }
  });
  // with an address hint on screen, plain all-caps words near the top (a token page's header) count as names too
  if (near.size || partials.length || exact.size) for (const l of lines.slice(0, 6)) for (const w of l.split(/[\s/()]+/)) if (/^[A-Z][A-Z0-9]{2,11}$/.test(w) && !MAJORS.has(w) && !tickers.has(w)) tickers.set(w, 1);
  return { exact: [...exact], near: [...near], partials, tickers: [...tickers].map(([t, strength]) => ({ ticker: t, strength })) };
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** coins with this ticker (pump.fun's search when the app has it, and DexScreener) */
async function byTicker(ticker, fetcher) {
  const out = new Map();
  if (fetcher) { try { for (const c of await require("./research/pumpfun").search(fetcher, ticker, 50)) out.set(c.mint, { mint: c.mint, symbol: c.symbol, size: c.mcUsd || 0 }); } catch { /* DexScreener below */ } }
  try { const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`); for (const p of (j.pairs || []).filter((x) => x.chainId === "solana")) if (!out.has(p.baseToken.address)) out.set(p.baseToken.address, { mint: p.baseToken.address, symbol: p.baseToken.symbol, size: p.volume?.h24 || 0 }); } catch { /* none */ }
  return [...out.values()];
}

/** the hints -> one mint, or null. Network only here, and only for real candidates */
async function resolveHints(h, fetcher, stableTickers) {
  if (h.exact.length + h.near.length > 2) return null; // a wall of addresses (a busy chat): ambiguous, don't guess
  const missed = [];
  for (const ca of h.exact) { try { const r = await resolveMint(ca); return { mint: r.mint, how: "full address on screen" }; } catch { missed.push(ca); } }
  h = { ...h, near: [...h.near, ...missed] }; // valid-looking but not a coin: probably an OCR slip, match it like one
  const tick = h.tickers.sort((a, b) => b.strength - a.strength).slice(0, 3);
  if ((h.near.length || h.partials.length) && tick.length) {
    for (const t of tick) {
      const cands = await byTicker(t.ticker, fetcher);
      for (const n of h.near) {
        const best = cands.map((c) => ({ c, d: lev(c.mint, n) })).sort((a, b) => a.d - b.d)[0];
        if (best && best.d <= 4) return { mint: best.c.mint, how: `address read with ${best.d} OCR slip${best.d === 1 ? "" : "s"}, matched via $${t.ticker}` };
      }
      for (const p of h.partials) {
        const hit = cands.filter((c) => c.mint.startsWith(p.pre) && c.mint.endsWith(p.suf)).sort((a, b) => b.size - a.size)[0];
        if (hit) return { mint: hit.mint, how: `$${t.ticker} + shortened address ${p.pre}...${p.suf}` };
      }
    }
  }
  // an address with an OCR slip and no ticker around it: DexScreener's search matches address prefixes
  for (const n of h.near.slice(0, 2)) {
    const pre = n.slice(0, 8);
    if (!/^[1-9A-HJ-NP-Za-km-z]{8}$/.test(pre)) continue;
    try {
      const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${pre}`);
      const mints = [...new Set((j.pairs || []).filter((p) => p.chainId === "solana").map((p) => p.baseToken.address))];
      const best = mints.map((m) => ({ m, d: lev(m, n) })).sort((a, b) => a.d - b.d)[0];
      if (best && best.d <= 4) return { mint: best.m, how: `address read with ${best.d} OCR slip${best.d === 1 ? "" : "s"}, matched by its start` };
    } catch { /* no match */ }
  }
  // a $TICKER right next to a market cap, on two frames in a row: the biggest coin with exactly that ticker
  for (const t of tick.filter((x) => x.strength >= 2 && stableTickers.has(x.ticker))) {
    const cands = (await byTicker(t.ticker, fetcher)).filter((c) => c.symbol?.toUpperCase() === t.ticker).sort((a, b) => b.size - a.size);
    if (cands[0]) return { mint: cands[0].mint, how: `$${t.ticker} next to a market cap (biggest of ${cands.length})` };
  }
  return null;
}

function helperExe(log) {
  const out = path.join(__dirname, "native", "pillbud-screenwatch2.exe"); // v2: app allowlist, per-window video skip
  if (fs.existsSync(out)) return out;
  try {
    const { execFileSync } = require("node:child_process");
    const win = process.env.SystemRoot || "C:/Windows";
    const fw = path.join(win, "Microsoft.NET", "Framework64", "v4.0.30319");
    const gac = (n) => `-r:${path.join(win, "Microsoft.NET", "assembly", "GAC_MSIL", n, "v4.0_4.0.0.0__31bf3856ad364e35", `${n}.dll`)}`;
    const wm = (n) => `-r:${path.join(win, "System32", "WinMetadata", `${n}.winmd`)}`;
    execFileSync(path.join(fw, "csc.exe"), ["-nologo", "-optimize+", "-target:exe", "-platform:x64", `-out:${out}`, gac("UIAutomationClient"), gac("UIAutomationTypes"), gac("WindowsBase"),
      `-r:${path.join(fw, "System.Drawing.dll")}`, `-r:${path.join(fw, "System.Runtime.dll")}`, wm("Windows.Foundation"), wm("Windows.Media"), wm("Windows.Graphics"), wm("Windows.Storage"), wm("Windows.Security"), wm("Windows.Globalization"),
      path.join(__dirname, "native", "screenwatch.cs")], { windowsHide: true });
    return out;
  } catch (e) { log(`screen watcher: couldn't build the helper (${e.message.slice(0, 80)})`); return null; }
}

function makeScreenWatcher({ onCoin, log = () => {}, fetcher, currentMint = () => null, dry = false, apps = [] }) {
  let proc = null, buf = "", stopped = false, restarts = 0, fails = 0;
  const stats = { frames: 0, ocrMs: 0, maxOcrMs: 0, candidates: 0, triggers: 0, rejected: 0, since: Date.now(), lastFrameAt: null };
  const seen = new Map();       // candidate key -> { at, mint|null } (each candidate is looked up once per 10 min)
  let lastTickers = new Set(), lastTrigger = 0, busy = false;

  async function onFrame(m) {
    stats.frames++; stats.ocrMs += m.ms; stats.maxOcrMs = Math.max(stats.maxOcrMs, m.ms); stats.lastFrameAt = Date.now();
    const h = extract(m.t);
    const stable = new Set(h.tickers.map((t) => t.ticker).filter((t) => lastTickers.has(t)));
    lastTickers = new Set(h.tickers.map((t) => t.ticker));
    if (!h.exact.length && !h.near.length && !h.partials.length && !h.tickers.some((t) => t.strength >= 2)) return;
    const key = JSON.stringify([h.exact.slice(0, 3), h.near.slice(0, 2), h.partials.slice(0, 2), h.tickers.filter((t) => t.strength >= 2 || h.near.length || h.partials.length).map((t) => t.ticker).sort().slice(0, 3), [...stable].sort()]);
    const prev = seen.get(key);
    if (prev && Date.now() - prev.at < 10 * 60_000) return; // this exact set of hints was already looked up
    if (busy) return;
    busy = true;
    stats.candidates++;
    try {
      const r = await resolveHints(h, fetcher, stable);
      seen.set(key, { at: Date.now(), mint: r?.mint || null });
      if (seen.size > 500) seen.delete(seen.keys().next().value);
      if (!r) { stats.rejected++; return; }
      if (r.mint === currentMint() || Date.now() - lastTrigger < 8000) return; // same coin, or too soon after the last one
      lastTrigger = Date.now(); stats.triggers++;
      log(`screen: found ${r.mint.slice(0, 4)}... in ${m.p} (${r.how})${dry ? " [dry run]" : ""}`);
      if (!dry) onCoin(r.mint, `screen (${m.p})`, r);
      else onCoin?.(r.mint, `screen (${m.p})`, r, true);
    } catch (e) { log(`screen: lookup failed (${e.message})`); }
    finally { busy = false; }
  }

  function start() {
    if (proc || stopped || process.platform !== "win32") return;
    const exe = helperExe(log);
    if (!exe) return;
    try { proc = spawn(exe, apps.filter((a) => /^[\w.-]{1,40}$/.test(a)), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { proc = null; if (++fails < 3) setTimeout(start, 1500); log(`screen watcher: couldn't start (${e.code || e.message})`); return; }
    log(`screen watcher: started (pid ${proc.pid}), OCR stays on this PC`);
    proc.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { log(`screen watcher: ready (OCR language ${m.lang})`); continue; }
        if (m.error || m.err) { if (m.error) log(`screen watcher: ${m.error}`); continue; }
        if (m.t != null) onFrame(m);
      }
    });
    proc.on("exit", (code) => {
      proc = null;
      if (stopped) return;
      const wait = Math.min(30000, 1000 * 2 ** restarts++);
      log(`screen watcher exited (${code}); restarting in ${wait} ms`);
      setTimeout(start, wait);
    });
  }
  const send = (cmd) => { try { proc?.stdin.write(cmd + "\n"); } catch { /* restarting */ } };
  return {
    start, stats,
    stop() { stopped = true; try { proc?.kill(); } catch { /* gone */ } proc = null; },
    pause: () => send("pause"), resume: () => send("resume"),
    /** don't read this window (a browser showing a video tab); 0 = read them all again */
    skip: (hwnd) => send(`skip ${Number(hwnd) || 0}`), kick: () => send("kick"),
    ocrFile: (file) => send(`file ${file}`),
    ensure() { if (!proc && !stopped) { restarts = 0; start(); } },
    pid: () => proc?.pid ?? null, running: () => !!proc,
  };
}

module.exports = { makeScreenWatcher, extract, resolveHints, lev };
