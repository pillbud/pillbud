// node test/holders-live.js <mint> : the holder stamp on a live coin (no app needed; pump.fun's API is skipped)
const { research } = require("../src/research");
const trench = require("../src/research/trench");
const holderMod = require("../src/research/holders");
(async () => {
  const mint = process.argv[2];
  const t0 = Date.now();
  const f = await research(mint, { log: (s) => console.log("  " + s) });
  console.log(`research ${Date.now() - t0} ms; first stamp:`, JSON.stringify({ word: f.holderStamp.word, score: f.holderStamp.score, tag: f.holderStamp.tag, line: f.holderStamp.line, notChecked: f.holderStamp.notChecked }));
  const devWallets = f.dev ? [f.dev, ...(f.dev.others || [])].map((d) => d.wallet) : [];
  f.launch = await trench.launch(mint, f.mintInfo.supply, devWallets).catch((e) => ({ unknown: e.message }));
  f.early = await holderMod.earlyNow(f).catch((e) => ({ unknown: e.message }));
  console.log("launch:", JSON.stringify(f.launch.unknown ? f.launch : { dev: f.launch.devBuyPct, bundle: f.launch.bundle.pct, snipers: f.launch.snipers.pct }), "early now:", JSON.stringify(f.early && { ...f.early, perWallet: undefined }));
  const people = f.holders.filter((h) => h.wallet);
  f.legit = { checks: { clusters: await trench.clusters({ holders: f.holders, supply: f.mintInfo.supply, devWallets, mint, early: f.launch.unknown ? [] : [...f.launch.bundle.wallets, ...f.launch.snipers.wallets] }).catch((e) => ({ unknown: e.message })) } };
  const s = holderMod.refresh(f);
  console.log("clusters:", JSON.stringify(f.legit.checks.clusters, null, 1));
  console.log(JSON.stringify(s, null, 1));
  console.log("holder count:", JSON.stringify(f.holderCount), "dev:", JSON.stringify(f.dev && { holds: f.dev.holdsPct, bought: f.dev.boughtPct, sold: f.dev.soldPct }), `total ${Date.now() - t0} ms`);
})().catch((e) => { console.error(e); process.exit(1); });
