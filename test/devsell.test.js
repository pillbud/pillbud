// node test/devsell.test.js [mint]
// The dev-sell alert path with real chain reads: the watcher polls the dev's real token balance on Helius, but the
// STARTING balance is set 3% of supply higher than the truth, so the first poll looks like the dev just sold 3%.
// (Waiting for a real dev to sell on cue isn't possible; everything else here is live.) Also checks the "dev is out"
// (rugged) wording by pretending the dev's account is a sold-out one.
const { research } = require("../src/research");
const { makeWatcher, lines } = require("../src/watcher");

const MINT = process.argv[2] || "7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump";

(async () => {
  const f = await research(MINT);
  if (!f.dev || f.dev.unknown) throw new Error("no readable dev wallet for this coin");
  const real = f.dev.holdsTokens, supply = f.mintInfo.supply;
  console.log(`$${f.symbol} dev ${f.dev.wallet.slice(0, 4)}... really holds ${((real / supply) * 100).toFixed(2)}% (from Helius)`);
  f.dev = { ...f.dev, holdsTokens: real + supply * 0.03, others: [] }; // SIMULATED baseline: +3% of supply
  const got = await new Promise((resolve) => {
    const w = makeWatcher((r) => { w.stop(); resolve(r); }, (m) => console.log("  .", m));
    w.watch(f);
    setTimeout(() => { w.stop(); resolve(null); }, 40000);
  });
  if (!got) throw new Error("no devSell reaction within 40 s");
  console.log(`reaction: ${got.type} -> mood "${got.state}": "${got.text}"`);
  if (got.type !== "devSell" || Math.abs(got.data.soldPct - 3) > 0.15) throw new Error("wrong reaction");
  console.log(`rugged wording: "${lines("devSell", { soldPct: 8.2, holdsPct: 0, out: true })}"`);
  console.log("ok");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
