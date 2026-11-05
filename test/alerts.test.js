// node test/alerts.test.js [minutes]
// Live push alerts (Helius websocket, src/feed.js) on two real, active coins: one on the pump.fun curve, one on
// PumpSwap. Thresholds are lowered for the run (pump/dump 5% in 60 s, whale 0.3%) so real moves fire, then restored.
// For every alert: time from the block (getBlockTime, 1 s resolution) and from the push to the alert.
const fs = require("node:fs");
const path = require("node:path");
const PREFS = path.join(__dirname, "..", "prefs.json");
const saved = fs.existsSync(PREFS) ? fs.readFileSync(PREFS, "utf8") : null;
fs.writeFileSync(PREFS, JSON.stringify({ pumpPct: 5, dumpPct: 5, moveWindowSec: 60, reactCooldownSec: 20, whalePct: 0.3 }));
const restore = () => { if (saved == null) fs.rmSync(PREFS, { force: true }); else fs.writeFileSync(PREFS, saved); };

const { research } = require("../src/research");
const { makeWatcher } = require("../src/watcher");
const { makeFeed } = require("../src/feed");
const { getJson } = require("../src/research/net");

(async () => {
  const mins = Number(process.argv[2] || 4);
  // the busiest pump.fun curve pool and the busiest PumpSwap pool right now (GeckoTerminal, by 1h transactions)
  const pick = async (dex) => {
    const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/${dex}/pools?page=1&sort=h24_tx_count_desc`);
    const pools = (j.data || []).map((p) => ({ mint: p.relationships.base_token.data.id.replace("solana_", ""), name: p.attributes.name, tx1h: (p.attributes.transactions?.h1?.buys || 0) + (p.attributes.transactions?.h1?.sells || 0) })).filter((p) => p.mint.endsWith("pump"));
    return pools.sort((a, b) => b.tx1h - a.tx1h)[0];
  };
  const coins = [await pick("pump-fun"), await pick("pumpswap")].filter(Boolean);
  const feed = makeFeed((m) => console.log("  feed:", m));
  const alerts = [];
  const watchers = [];
  for (const c of coins) {
    const f = await research(c.mint);
    console.log(`watching $${f.symbol} (${c.mint}), ${c.tx1h} tx in the last hour, ${f.pump && !f.pump.bonded ? "pump.fun curve" : f.market?.dex}`);
    const w = makeWatcher((r) => {
      const a = { coin: f.symbol, type: r.type, text: r.text, pushToAlertMs: r.at - r.receivedAt, slot: r.slot };
      alerts.push(a); console.log(`${new Date().toLocaleTimeString()} ALERT $${f.symbol} ${r.type}: "${r.text}"`);
      setTimeout(() => { a.blockToAlertMs = r.latencyMs ?? null; if (a.blockToAlertMs != null) console.log(`   $${f.symbol} ${r.type}: ${a.blockToAlertMs} ms after its block, ${a.pushToAlertMs} ms after the push`); }, 3000);
    }, (m) => console.log(`  [${f.symbol}] ${m}`), { feed });
    await w.watch(f);
    watchers.push({ w, f });
  }
  let ticks = 0;
  const t = setInterval(() => { for (const { w, f } of watchers) { const p = w.points(); ticks += 0; console.log(`  [${f.symbol}] ${p.length} pushed price points in the window, last $${Math.round(p[p.length - 1]?.mc || 0).toLocaleString()} (${w.current()?.source})`); } }, 60000);
  setTimeout(() => {
    clearInterval(t); watchers.forEach(({ w }) => w.stop()); feed.close(); restore();
    const lat = alerts.map((a) => a.blockToAlertMs).filter((x) => x != null);
    console.log(`\n${alerts.length} alerts in ${mins} min; block-to-alert: ${lat.length ? `median ${lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)]} ms, min ${Math.min(...lat)}, max ${Math.max(...lat)} (1 s resolution)` : "n/a"}`);
    process.exit(0);
  }, mins * 60000);
})().catch((e) => { console.error("FAIL", e.message); restore(); process.exit(1); });
