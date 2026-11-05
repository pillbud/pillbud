// node test/links-debug.js <mint> : every raw proof link among a coin's top holders, how busy each linking wallet is,
// and each top holder's first funder (debugging the linked-wallet check)
const { rpc } = require("../src/research/net");
const chain = require("../src/research/chain");
const trench = require("../src/research/trench");
const short = (a) => a.slice(0, 4) + ".." + a.slice(-4);
(async () => {
  const mint = process.argv[2];
  const mi = await chain.mintInfo(mint), hs = await chain.holders(mint, mi.supply);
  const people = hs.filter((h) => h.wallet), pct = new Map(people.map((h) => [h.owner, h.pct]));
  const p = await trench.proofLinks({ holders: hs, mint });
  const uniq = [...new Map(p.edges.map((e) => [`${e.a}|${e.b}|${e.how}`, e])).values()];
  console.log(`read ${p.read} holders, ${p.edges.length} raw links (${uniq.length} distinct)`);
  for (const a of [...new Set(uniq.map((e) => e.a))]) {
    const sigs = await rpc("getSignaturesForAddress", [a, { limit: 1000 }]);
    const span = sigs.length ? ((sigs[0].blockTime - sigs[sigs.length - 1].blockTime) / 3600).toFixed(1) : "?";
    for (const e of uniq.filter((x) => x.a === a)) console.log(`${e.how.padEnd(30)} ${short(e.a)}${pct.has(e.a) ? ` (${pct.get(e.a).toFixed(2)}%)` : ""} [${sigs.length} txs in ${span} h] -> ${short(e.b)} (${(pct.get(e.b) || 0).toFixed(2)}%)`);
  }
  const f = await Promise.all(people.slice(0, 14).map(async (h) => ({ h, f: await trench.funderOf(h.owner).catch(() => ({})) })));
  console.log("first funders:", f.map(({ h, f }) => `${short(h.owner)} ${h.pct.toFixed(2)}% <- ${f.funder ? short(f.funder) : "?"}`).join(" | "));
})();
