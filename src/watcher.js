// Live watch on the coin that's open, pushed by the Helius websocket (src/feed.js):
//   price   - the pump.fun curve account while the coin is on the curve (exact), or the PumpSwap pool's two vaults
//             after it bonds; other DEXes fall back to polling DexScreener every 5 s
//   dev     - the dev wallets' token accounts: any drop is a sale, said right away
//   top     - the top 10 holders' token accounts: a drop of 0.5%+ of supply is a top holder selling
//   bundle  - the launch bundle's and snipers' wallets still holding (added once the launch is read): a drop of 0.2%+
//             of supply is the bundle selling (2026-11-06: the community watches bundles, not "whales")
// Reactions carry real numbers. Each alert is timed against its block (getBlockTime) to measure alert latency.
const { PublicKey } = require("@solana/web3.js");
const { pairNow, dexscreener } = require("./research/market");
const { curvePda } = require("./research/chain");
const { rpc } = require("./research/net");
const { money } = require("./research/chart");
const { settings } = require("./env");
const tone = require("./tone");

const WSOL = "So11111111111111111111111111111111111111112";
const dur = (ms) => { const s = Math.round(ms / 1000); return s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`; };
const pctStr = (x) => `${Math.round(x * 10) / 10}%`;

function decodeCurve(base64) {
  const b = Buffer.from(base64, "base64");
  if (b.length < 49) return null;
  const vT = Number(b.readBigUInt64LE(8)) / 1e6, vS = Number(b.readBigUInt64LE(16)) / 1e9, supply = Number(b.readBigUInt64LE(40)) / 1e6 || 1e9;
  return { complete: b[48] === 1, mcSol: vT > 0 ? (vS / vT) * supply : null };
}
const uiAmount = (v) => Number(v?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? NaN);

function makeWatcher(onReaction, log = () => {}, opts = {}) {
  const feedNow = () => opts.feed; // read when watching starts (the feed is created after the watcher)
  let cur = null, unsubs = [], timers = [], points = [], lastReact = {};

  function stop() { unsubs.forEach((u) => { try { u(); } catch { /* gone */ } }); unsubs = []; timers.forEach(clearInterval); timers = []; cur = null; points = []; }

  /** time from the block to the alert (blockTime has 1 s resolution) */
  async function latency(slot, receivedAt) {
    if (!slot) return null;
    try { const bt = await rpc("getBlockTime", [slot]); return bt ? receivedAt - bt * 1000 : null; } catch { return null; }
  }

  function react(type, x, state, slot, receivedAt) {
    const s = settings();
    const now = Date.now();
    if (type !== "devSell" && type !== "devRug" && now - (lastReact[type] || 0) < s.reactCooldownSec * 1000) return;
    lastReact[type] = now;
    const r = { type, state, data: x, mint: cur?.mint, symbol: cur?.symbol, at: now, slot, receivedAt, text: tone.line(type, { symbol: cur?.symbol, ...x }, s.tone) };
    onReaction(r);
    setTimeout(() => latency(slot, receivedAt).then((ms) => { if (ms != null) { r.latencyMs = ms; log(`alert ${type}: emitted ${Math.round(now - receivedAt)} ms after the push, ${ms} ms after the block (1 s resolution)`); } }), 6000); // the block must be confirmed first
  }

  /** one price point (from the feed or a poll): check for a fast pump or dump */
  function tick(mc, src, slot, receivedAt = Date.now()) {
    if (!cur || !mc) return;
    const s = settings();
    const now = Date.now();
    if (points.length && points[points.length - 1].src !== src) points = []; // one source per series
    points.push({ t: now, mc, src });
    points = points.filter((q) => now - q.t <= Math.max(s.moveWindowSec, 600) * 1000);
    cur.mcNow = mc;
    const win = points.filter((q) => now - q.t <= s.moveWindowSec * 1000);
    if (win.length < 2) return;
    const last = win[win.length - 1];
    const lo = win.reduce((a, b) => (b.mc < a.mc ? b : a)), hi = win.reduce((a, b) => (b.mc > a.mc ? b : a));
    const up = ((last.mc - lo.mc) / lo.mc) * 100, down = ((hi.mc - last.mc) / hi.mc) * 100;
    if (up >= s.pumpPct && lo.t < last.t) { react("pump", { pct: pctStr(up), dur: dur(last.t - lo.t), mc: money(last.mc) }, "celebrate", slot, receivedAt); points = [last]; }
    else if (down >= s.dumpPct && hi.t < last.t) { react("dump", { pct: pctStr(down), dur: dur(last.t - hi.t), mc: money(last.mc) }, "panic", slot, receivedAt); points = [last]; }
  }

  /** a token account to watch for sells: dev wallets and the top holders */
  function watchSeller(feed, account, startTokens, kind) {
    let last = startTokens;
    unsubs.push(feed.watchAccount(account, "jsonParsed", (v, slot, at) => {
      const bal = v ? uiAmount(v) : 0; // a closed account (sold out) comes back null
      if (!isFinite(bal)) return;
      const sold = last != null ? last - bal : 0;
      const min = cur.supply * (kind === "dev" ? 0.0005 : kind === "bundle" ? 0.002 : settings().whalePct / 100);
      if (last != null && sold >= min) {
        const soldPct = pctStr((sold / cur.supply) * 100), holdsPct = pctStr((bal / cur.supply) * 100);
        if (kind === "dev") react(bal < cur.supply * 0.0001 ? "devRug" : "devSell", { pct: soldPct, holds: holdsPct }, bal < cur.supply * 0.0001 ? "rugged" : "panic", slot, at);
        else if (kind === "bundle") react("bundleSell", { pct: soldPct, holds: holdsPct }, "panic", slot, at);
        else react("whaleSell", { pct: soldPct, holds: holdsPct }, "panic", slot, at);
      }
      last = bal;
    }));
  }

  /** start watching a researched coin (replaces whatever was watched) */
  async function watch(full) {
    stop();
    const s = settings();
    cur = { mint: full.mint, symbol: full.symbol, supply: full.mintInfo.supply, solUsd: full.solUsd, pair: full.market?.pair, source: null };
    lastReact = {};
    const me = cur;
    const feed = feedNow();
    // price: curve, PumpSwap vaults, or polling
    if (feed && full.pump && !full.pump.bonded && cur.solUsd) {
      cur.source = "pump.fun curve (push)";
      unsubs.push(feed.watchAccount(curvePda(full.mint), "base64", (v, slot, at) => {
        const c = v && decodeCurve(v.data[0]);
        if (!c || cur !== me) return;
        if (c.complete) { react("bonded", {}, "celebrate", slot, at); return; }
        tick(c.mcSol * cur.solUsd, "curve", slot, at);
      }));
    } else if (feed && full.market?.dex === "pumpswap" && cur.solUsd) {
      const pool = (full.programs || [])[0]; // the pool's token account for this coin (program-owned)
      try {
        const quote = (await rpc("getTokenAccountsByOwner", [pool.owner, { mint: WSOL }, { encoding: "jsonParsed" }])).value[0]?.pubkey;
        if (!quote) throw new Error("no WSOL vault");
        let base = null, q = null;
        const update = (slot, at) => { if (base > 0 && q > 0 && cur === me) tick((q / base) * cur.supply * cur.solUsd, "pool", slot, at); };
        unsubs.push(feed.watchAccount(pool.account, "jsonParsed", (v, slot, at) => { base = uiAmount(v); update(slot, at); }));
        unsubs.push(feed.watchAccount(quote, "jsonParsed", (v, slot, at) => { q = uiAmount(v); update(slot, at); }));
        cur.source = "PumpSwap pool vaults (push)";
      } catch (e) { log(`watch: no pool push (${e.message}), polling`); }
    }
    if (!cur.source) {
      cur.source = "DexScreener (polling every 5 s)";
      timers.push(setInterval(async () => { try { const p = await pairNow(cur.pair); if (p?.mcUsd) tick(p.mcUsd, "dexscreener"); } catch (e) { log(`watch price: ${e.message}`); } }, 5000));
    }
    // sellers: dev wallets and the top 10 holders (people, not pools)
    if (feed) {
      for (const d of (full.dev ? [full.dev, ...full.dev.others] : []).filter((d) => !d.unknown)) watchSeller(feed, d.account, d.holdsTokens, "dev");
      const devs = new Set((full.dev ? [full.dev, ...full.dev.others] : []).map((d) => d.wallet));
      for (const h of (full.holders || []).filter((h) => h.wallet && !devs.has(h.owner)).slice(0, 10)) watchSeller(feed, h.account, h.tokens, "whale");
    }
    log(`watching ${full.symbol}: price from ${cur.source}, ${feed ? feed.count() : 0} pushed accounts`);
  }

  /** the coin's state in plain words, from the live points (null until there's enough) */
  function liveState() {
    if (points.length < 2 || !cur) return null;
    const now = Date.now(), last = points[points.length - 1];
    const w5 = points.filter((p) => now - p.t <= 5 * 60e3);
    const first = w5[0];
    const ch = ((last.mc - first.mc) / first.mc) * 100;
    return { changePct: Math.round(ch * 10) / 10, overMin: Math.max(1, Math.round((now - first.t) / 60000)), mc: last.mc };
  }

  /** watch more sellers once they're known (the launch bundle and snipers): their token accounts, from their wallets */
  async function watchGroup(wallets, kind, mint, program) {
    const feed = feedNow();
    if (!feed || !cur || cur.mint !== mint || !wallets.length) return 0;
    const me = cur;
    const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const accs = wallets.slice(0, 15).map((w) => { try { return PublicKey.findProgramAddressSync([new PublicKey(w).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], ATA)[0].toBase58(); } catch { return null; } }).filter(Boolean);
    const got = await rpc("getMultipleAccounts", [accs, { encoding: "jsonParsed" }]).catch(() => null);
    if (cur !== me) return 0;
    let n = 0;
    accs.forEach((a, i) => { const bal = uiAmount(got?.value?.[i]); if (bal > 0) { watchSeller(feed, a, bal, kind); n++; } });
    log(`watching ${n} ${kind} wallets that still hold ${me.symbol}`);
    return n;
  }

  return { watch, watchGroup, stop, current: () => cur, points: () => points, liveState };
}

// for the line templates and the tests
const lines = (type, x, t = "friendly") => tone.line(type, x, t);
module.exports = { makeWatcher, lines, decodeCurve };
