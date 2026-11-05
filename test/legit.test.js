// electron test/legit.test.js [mint,mint,...]     (Electron with NO window: it only borrows its network stack,
// because pump.fun's API answers browsers, not scripts). Runs the full research + legit-or-LARP read + take on each
// coin and prints the verdict, receipts, every check, timings and costs. Output also goes to captures/legit-<sym>.json.
const { app, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT = [
  "JDyazKGDCUUv2UrLxYScLb6DpXiGeqQUfEJrG9Hr15G1", // "NVIDIA COIN": links the real @nvidia, 7+ same-name coins
  "8pto8cp9ftvJYxVMNCXriHXS8MZv1UZL6KUYrdegRfZa", // "OFFICIAL TRUMP COIN"
  "HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump", // $GATO: a GTA 6 meme
  "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump", // $AMD "A Meme Dog"
  "7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump", // $GRANDPA
];

app.whenReady().then(async () => {
  const { research } = require("../src/research");
  const { legitFacts } = require("../src/research/legit");
  const brain = require("../src/brain");
  const mints = (process.argv.find((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}(,|$)/.test(a)) || DEFAULT.join(",")).split(",");
  const fetcher = net.fetch.bind(net);
  for (const mint of mints) {
    const t0 = Date.now();
    try {
      const f = await research(mint, { fetcher, deep: true, log: (s) => { if (/legit:/.test(s)) console.log("   ", s); } });
      const t = await brain.take(f.facts);
      const L = f.legit;
      console.log(`\n=== $${f.symbol} (${mint}) in ${Date.now() - t0} ms (research ${f.ms} ms, legit ${L.ms} ms), ${f.rpcCalls} RPC calls before legit`);
      console.log(`VERDICT: ${L.verdict}`);
      L.receipts.forEach((r) => console.log(`  receipt: ${r.text}  [${r.source}]`));
      console.log("facts:", JSON.stringify(legitFacts(L), null, 1));
      console.log(`cost: base research ${f.rpcCalls} RPC / ${f.heliusCredits} Helius credits; legit ${L.rpcCalls} RPC / ${L.heliusCredits} Helius credits; narrative $${L.narrativeUsd}; take ${t.usage.input}/${t.usage.output} tokens`);
      console.log(`narrative: ${L.checks.narrative?.model || ""} ${L.checks.narrative?.searches ?? "?"} searches, $${L.checks.narrative?.usd ?? "?"}, affiliation=${L.checks.narrative?.claimsAffiliation}, subject=${L.checks.narrative?.subject}`);
      console.log(`TAKE (${t.usage.input} in / ${t.usage.output} out): ${t.text}`);
      fs.writeFileSync(path.join(__dirname, "..", "captures", `legit-${(f.symbol || mint).replace(/[^A-Za-z0-9]/g, "")}.json`), JSON.stringify({ mint, verdict: L.verdict, receipts: L.receipts, take: t.text, checks: L.checks, ms: L.ms }, null, 1));
    } catch (e) { console.log(`\n=== ${mint}: FAILED ${e.stack}`); }
  }
  app.quit();
});
