// node test/sol-links-debug.js <mint> : do top holders send SOL to each other (or share a quiet counterparty)?
// Reads each top holder's 100 most recent transactions; prints holder pairs linked by SOL moves (debug only).
const { rpc, pool } = require("../src/research/net");
const chain = require("../src/research/chain");
const short = (a) => a.slice(0, 4) + ".." + a.slice(-4);
const keysOf = (tx) => [...tx.transaction.message.accountKeys.map((k) => String(k.pubkey || k)), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
(async () => {
  const mint = process.argv[2];
  const mi = await chain.mintInfo(mint), hs = await chain.holders(mint, mi.supply);
  const people = hs.filter((h) => h.wallet).slice(0, 14), set = new Set(people.map((h) => h.owner)), pct = new Map(people.map((h) => [h.owner, h.pct]));
  const touches = new Map(); // counterparty -> Set(holders)
  const direct = [];
  await pool(people, 4, async (h) => {
    const res = await rpc("getTransactionsForAddress", [h.owner, { transactionDetails: "full", sortOrder: "desc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
    for (const tx of res?.data || []) {
      const m = tx.meta, keys = keysOf(tx), i = keys.indexOf(h.owner);
      if (i < 0 || !m) continue;
      const mine = m.postBalances[i] - m.preBalances[i];
      if (Math.abs(mine) < 1e6) continue; // under 0.001 SOL: fees, rent
      const hasTokens = (m.preTokenBalances || []).length + (m.postTokenBalances || []).length > 0;
      if (hasTokens) continue; // a swap, not a plain SOL transfer
      keys.forEach((k, j) => {
        if (j === i) return;
        const d = m.postBalances[j] - m.preBalances[j];
        if (Math.sign(d) === -Math.sign(mine) && Math.abs(d) >= 1e6 && chain.isWallet(k)) {
          if (set.has(k)) direct.push(`${short(h.owner)} <-> ${short(k)} ${(Math.abs(d) / 1e9).toFixed(3)} SOL`);
          (touches.get(k) || touches.set(k, new Set()).get(k)).add(h.owner);
        }
      });
    }
  });
  console.log("direct SOL between top holders:", direct.length ? direct.join(" | ") : "none");
  const shared = [...touches].filter(([k, s]) => s.size >= 2 && !set.has(k));
  for (const [k, s] of shared) {
    const sigs = await rpc("getSignaturesForAddress", [k, { limit: 1000 }]);
    console.log(`shared SOL counterparty ${short(k)} [${sigs.length} txs]: ${[...s].map((w) => `${short(w)} ${pct.get(w).toFixed(2)}%`).join(", ")}`);
  }
})();
