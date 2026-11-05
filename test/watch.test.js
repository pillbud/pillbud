// node test/watch.test.js <minutes> <mint> [mint...]
// Live watcher on real coins, no window: polls price (DexScreener), dev wallets (Helius) and the curve, and logs every
// reaction with its spoken line (saved to captures/audio/). Thresholds come from env.js / config.json.
const fs = require("node:fs");
const path = require("node:path");
const { research } = require("../src/research");
const { makeWatcher } = require("../src/watcher");
const voice = require("../src/voice");
const { settings } = require("../src/env");

const [mins = "6", ...mints] = process.argv.slice(2);
const OUT = path.join(__dirname, "..", "captures", "audio");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = settings();
  console.log(`thresholds: pump ${s.pumpPct}% / dump ${s.dumpPct}% within ${s.moveWindowSec}s, price every ${s.watchEverySec}s, dev every ${s.devEverySec}s`);
  const watchers = [];
  for (const mint of mints) {
    const f = await research(mint);
    const sym = f.symbol;
    const w = makeWatcher(async (r) => {
      console.log(`${new Date().toLocaleTimeString()} REACTION ${sym} ${r.type} -> ${r.state}: "${r.text}"`);
      try { const a = await voice.speak(r.text, "reaction"); const file = path.join(OUT, `reaction-${sym}-${r.type}-${Date.now()}.${a.mime.includes("wav") ? "wav" : "mp3"}`); fs.writeFileSync(file, a.audio); console.log(`   spoken (${a.engine}) -> ${path.basename(file)}`); }
      catch (e) { console.log("   tts failed", e.message); }
    }, (m) => console.log(`${new Date().toLocaleTimeString()} [${sym}] ${m}`));
    w.watch(f);
    watchers.push({ w, sym, mc0: f.market?.mcUsd });
  }
  const tick = setInterval(() => {
    for (const { w, sym, mc0 } of watchers) {
      const p = w.points(), last = p[p.length - 1];
      if (last) console.log(`${new Date().toLocaleTimeString()} [${sym}] mc $${Math.round(last.mc).toLocaleString()} (${(((last.mc - mc0) / mc0) * 100).toFixed(1)}% since start, ${p.length} pts in window)`);
    }
  }, 30000);
  setTimeout(() => { clearInterval(tick); watchers.forEach(({ w }) => w.stop()); voice.stopVoices(); console.log("done"); process.exit(0); }, Number(mins) * 60000);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
