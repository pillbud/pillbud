// node test/read-study.js [out.json]   (a test instance must be up: PILLBUD_TEST=1 PILLBUD_PORT=47341 electron .)
// The read on live coins of every kind, Haiku vs Sonnet on the same gathered facts. Prints per coin: the type, the
// path (source found / web search), how long the facts took, and each model's read with its latency and cost.
// Latency = facts gathered + the model's first sentence (what the trader waits for before the first words).
const fs = require("node:fs");
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47341";
const MODELS = (process.env.MODELS || "claude-haiku-5-5,claude-sonnet-5-5").split(",");
const COINS = [ // picked from pump.fun's live lists, 2026-11-04 (one or two of each kind)
  ["x-post, famous", "KMifrkYmDdAKtVXAVBEPEQxJ7qP2iLgUcfZjUZipump"],   // RAMBO: links an @elonmusk post
  ["x-post, famous", "npz2FhoufQ7pKqhGpaipYWacrAkidyW2yDpVWSvpump"],   // DESSA: links a @jack post
  ["x-post", "jM9r9PJFyPaMEbhGZPbDeZJiysn2pfyz5TzdDs5pump"],           // uni
  ["news / announcement", "2qsriu8vGz8ZWCPcG1ht5wfhU54evM2R2bGfJ88jAnUc"], // PSA: a @WhiteHouse post
  ["news / announcement", "BJEQPva46JGzrmsd2oepjApouedCoQUAcwiiupFt8SiD"], // STONKS: a @WatcherGuru post
  ["youtube", "5Qfj5KTZPZMUTr1esg9hiWwiKXXzQejfYxSHCmi1pump"],          // STC
  ["youtube", "DTCNpKqec2RN3ptE9H863gWC4QTk1uXZf1b6jGTjpump"],          // PUPWIF
  ["tech", "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump"],             // Pippin (an AI agent; site + post)
  ["website", "wAtGLwZqJAsShscEkMki2DxiWfGfkz1XkwXdUj3pump"],          // USDP
  ["pure meme, no links", "A5HgibiDoeGHrJeeBPGJHDFsBkM2uwodQAG1TJ2spump"], // UODF
  ["x-profile", "LRxbtkvPfpctgR6MS52MAwtobrCCY9KiJgKMmpPpump"],        // GOLD
  ["obvious LARP", "JDyazKGDCUUv2UrLxYScLb6DpXiGeqQUfEJrG9Hr15G1"],     // NVIDIA
];
(async () => {
  const out = [];
  for (const [kind, mint] of COINS) {
    const t0 = Date.now();
    const r = await (await fetch(`${A}/debug/read`, { method: "POST", body: JSON.stringify({ mint, models: MODELS }) })).json();
    if (r.error) { console.log(`\n${kind} ${mint}: ERROR ${r.error.slice(0, 200)}`); out.push({ kind, mint, error: r.error }); continue; }
    out.push({ kind, ...r });
    const c = r.facts.coin;
    console.log(`\n=== ${kind}: $${c.ticker} (${c.name}), router type "${r.type}", path ${r.path}, facts in ${r.times.core} ms (${Object.entries(r.times).filter(([k]) => k !== "core").map(([k, v]) => `${k} ${v}`).join(", ")})`);
    for (const m of r.results) console.log(`  ${m.model.replace("claude-", "")}: first words ${m.readFirstWordsMs} ms (model ${m.firstSentenceMs} ms, all ${m.ms} ms), ${m.verdict}, $${m.usd}${m.searches ? `, ${m.searches} searches` : ""}\n    "${m.text}"`);
    console.log(`  (wall ${Date.now() - t0} ms)`);
  }
  fs.writeFileSync(process.argv[2] || "read-study.json", JSON.stringify(out, null, 1));
})();
