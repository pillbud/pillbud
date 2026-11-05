// node src/cli-research.js <mint | pair | url> [--take]
// Runs the same research the app runs and prints it (no keys printed). --take also asks Claude for the spoken take.
const { research } = require("./research");
const { fromUrl, fromClipboard, resolveMint } = require("./detect");

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.log("usage: node src/cli-research.js <mint|pair|url> [--take]"); process.exit(1); }
  const hit = fromUrl(arg) || fromClipboard(arg);
  if (!hit) throw new Error("no Solana address in that");
  const { mint, pairHint } = await resolveMint(hit.address);
  console.log("site:", hit.site, "address:", hit.address, "-> mint:", mint);
  const r = await research(mint, { pairHint, log: (s) => console.log("  .", s) });
  console.log(`research ${r.ms} ms, ${r.rpcCalls} RPC calls, sources: ${r.sources.join(", ")}`);
  console.log(JSON.stringify(r.facts, null, 1));
  if (process.argv.includes("--take")) {
    const brain = require("./brain");
    const t = await brain.take(r.facts);
    console.log("\nTAKE:", t.text, "\nusage:", JSON.stringify(t.usage), `${t.ms} ms`);
  }
})().catch((e) => { console.error("error:", e.message); process.exit(1); });
