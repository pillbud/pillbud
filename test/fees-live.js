// node test/fees-live.js <mint> [<mint>...] : the fee check on live coins (setup, money, promise). The coin's record
// comes from pump.fun through a running test instance (PILLBUD_URL, default 127.0.0.1:47331), because pump.fun's API
// blocks plain scripts.
const chain = require("../src/research/chain");
const fees = require("../src/research/fees");
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47331";
(async () => {
  for (const mint of process.argv.slice(2)) {
    const t0 = Date.now();
    const [mi, curve, launch] = await Promise.all([chain.mintInfo(mint), chain.bondingCurve(mint), chain.launchTx(mint).catch(() => null)]);
    const j = await fetch(`${A}/debug/pumpfun?path=${encodeURIComponent(`/coins-v2/${mint}`)}`).then((r) => r.json()).catch(() => ({}));
    const pf = { holderReward: !!j.is_holder_reward, cashback: !!j.is_cashback_enabled };
    const claims = fees.feeClaims([j.description, j.name]);
    const F = await fees.feeCheck({ mint, curveCreator: curve?.creator, pf, devWallets: [j.creator, launch?.payer], supply: mi.supply, launchedAt: launch?.at });
    const out = fees.judge(claims, F, { ticker: j.symbol });
    console.log(`\n=== $${j.symbol} (${mint.slice(0, 6)}) ${Date.now() - t0} ms | mode ${F.mode || F.unknown}`);
    if (claims.length) console.log("claims:", claims.map((c) => `${c.kind}: "${c.quote}"`).join(" | "));
    for (const x of out) console.log(`  [${x.level}] ${x.title}: ${x.detail}`);
    if (!out.length) console.log("  (nothing worth saying)", JSON.stringify({ ...F, shares: F.shares?.length }).slice(0, 200));
  }
})().catch((e) => { console.error(e); process.exit(1); });
