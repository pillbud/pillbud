// node test/links-timing.js <mint> : how long each part of the linked-wallet check takes, and how big the answers are
const { rpc, pool } = require("../src/research/net");
const chain = require("../src/research/chain");
const trench = require("../src/research/trench");
const t = async (name, p) => { const s = Date.now(); const v = await p; console.log(`${name.padEnd(34)} ${String(Date.now() - s).padStart(5)} ms`); return v; };
(async () => {
  const mint = process.argv[2];
  const mi = await chain.mintInfo(mint), hs = await chain.holders(mint, mi.supply);
  const people = hs.filter((h) => h.wallet);
  // raw size and time of the calls the check makes
  const one = async (label, method, params) => { const s = Date.now(); const r = await rpc(method, params); console.log(`  one ${label.padEnd(28)} ${String(Date.now() - s).padStart(5)} ms  ${(JSON.stringify(r).length / 1024).toFixed(0)} KB`); return r; };
  await one("token history (100 full)", "getTransactionsForAddress", [people[0].account, { transactionDetails: "full", sortOrder: "asc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
  await one("wallet history (100 full)", "getTransactionsForAddress", [people[0].owner, { transactionDetails: "full", sortOrder: "desc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
  await one("signatures (1000)", "getSignaturesForAddress", [people[0].owner, { limit: 1000 }]);
  await one("funder (3 full)", "getTransactionsForAddress", [people[1].owner, { transactionDetails: "full", sortOrder: "asc", limit: 3, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
  const devWallets = [];
  await t("funders (pool 5)", pool(people.slice(0, 10).map((h) => h.owner), 5, (w) => trench.funderOf(w)));
  await t("token links (16 holders, pool 5)", trench.proofLinks({ holders: hs, mint }));
  await t("SOL links (12 holders, pool 5)", trench.solLinks({ holders: hs }));
  await t("whole clusters()", trench.clusters({ holders: hs, supply: mi.supply, devWallets, mint, early: [] }));
})();
