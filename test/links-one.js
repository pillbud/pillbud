// node test/links-one.js <mint> [<mint>...] : the linked-wallet check on each coin, with the full error if it fails
const chain = require("../src/research/chain"), trench = require("../src/research/trench");
(async () => {
  for (const mint of process.argv.slice(2)) {
    const t0 = Date.now();
    try {
      const mi = await chain.mintInfo(mint), hs = await chain.holders(mint, mi.supply);
      const r = await trench.clusters({ holders: hs, supply: mi.supply, devWallets: [], mint, early: [] });
      console.log(`${mint.slice(0, 6)} ${Date.now() - t0} ms: ${r.clusters.map((c) => `${c.wallets.length} wallets ${c.holdsPct}% (${c.how || ""})`).join(" | ") || "no groups"}`);
    } catch (e) { console.log(`${mint.slice(0, 6)} FAILED after ${Date.now() - t0} ms:\n${e.stack}`); }
  }
})();
