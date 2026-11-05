// HELIUS_RPS=8 node test/links-speed.js : the linked-wallet check on 4 coins, cold cache, with its call count and timing
const fs = require("node:fs"), path = require("node:path");
try { fs.unlinkSync(path.join(__dirname, "..", "cache", "wallet-activity.json")); } catch {}
const net = require("../src/research/net"), chain = require("../src/research/chain"), trench = require("../src/research/trench");
const MINTS = ["EiN69j8KVE5uYKheVkeVwptEVwRP5JtDhJDMGm1ppump", "9Bu1SsQ2wUQ4T8zwUXCnoJKNJvxDwFP8UyuxS7p1pump", "8crRRo8zpxJaUhnV81hzyqh4JU5RpuvVaP7iCfV2aXVV", "EiN69j8KVE5uYKheVkeVwptEVwRP5JtDhJDMGm1ppump"];
(async () => {
  let total = 0;
  for (const mint of MINTS) {
    const mi = await chain.mintInfo(mint), hs = await chain.holders(mint, mi.supply);
    await new Promise((r) => setTimeout(r, 1500));
    const c0 = net.rpcCount(), q0 = net.rpc429s(), k0 = net.rpcCredits(), t0 = Date.now();
    const r = await trench.clusters({ holders: hs, supply: mi.supply, devWallets: [], mint, early: [] });
    const ms = Date.now() - t0; total += ms;
    console.log(`${mint.slice(0, 4)} ${String(ms).padStart(5)} ms  ${net.rpcCount() - c0} calls  ${net.rpc429s() - q0} refused  ${net.rpcCredits() - k0} credits  ${r.clusters.map((c) => `${c.wallets.length} wallets ${c.holdsPct}%`).join(" | ") || "no groups"}`);
  }
  console.log(`rate ${process.env.HELIUS_RPS || "default"}: ${total} ms over ${MINTS.length} coins (the last one with a warm cache)`);
})();
