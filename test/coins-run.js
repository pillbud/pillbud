// node test/coins-run.js <out-dir> <SYM=url-or-mint> [...] : opens each coin in the hidden test app (PILLBUD_URL, default
// 127.0.0.1:47331), waits for the full check, saves the card and the log to <out-dir>/<SYM>.json and prints a summary.
const fs = require("node:fs"), path = require("node:path");
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47331";
const LIMIT = Number(process.env.COIN_SECONDS || 100) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(A + p).then((r) => r.json());

async function one(sym, target, outDir) {
  const body = /^https?:/.test(target) ? { url: target } : { address: target, site: "test" };
  const t0 = Date.now();
  await fetch(A + "/coin", { method: "POST", body: JSON.stringify(body) });
  let log = [];
  for (;;) {
    await sleep(2000);
    const all = await get("/debug/log").catch(() => []);
    let k = -1; all.forEach((l, i) => { if (/coin from/.test(l)) k = i; });
    log = k >= 0 ? all.slice(k) : all;
    const cost = log.some((l) => /"what":"coin cost"/.test(l));
    const links = log.some((l) => /linked wallets in \d+ ms/.test(l));
    const probeOpen = log.some((l) => /probe: starting|product test: opening/i.test(l)) && !log.some((l) => /probe: \S+.* in \d+ ms|product test failed/i.test(l));
    if ((cost && links && !probeOpen) || Date.now() - t0 > LIMIT) break;
  }
  await sleep(2500); // the last card update
  const card = await get("/debug/card").catch((e) => ({ error: e.message }));
  fs.writeFileSync(path.join(outDir, `${sym}.json`), JSON.stringify({ sym, target, ms: Date.now() - t0, card, log }, null, 1));
  const c = card?.card || {}, r = card?.read || {};
  const errs = log.filter((l) => /error|not a function|Invalid|Cannot read|unknown \(/i.test(l)).map((l) => "   ! " + l.slice(0, 200));
  console.log(`\n== $${sym} (${Math.round((Date.now() - t0) / 1000)} s) read: ${r.verdict || "?"} | final: ${c.verdict || "?"} | ${(c.tiles || []).map((t) => `${t.label}: ${t.word}${t.tag ? ` (${t.tag})` : ""}`).join(" | ")}`);
  for (const f of (c.findings || []).slice(0, 7)) console.log(`   ${f.level.padEnd(4)} ${f.title}${f.detail ? `: ${String(f.detail).slice(0, 110)}` : ""}`);
  if (errs.length) console.log(errs.join("\n"));
}

(async () => {
  const [outDir, ...pairs] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < 60; i++) { if (await get("/status").then(() => true).catch(() => false)) break; await sleep(1000); }
  for (const p of pairs) { const k = p.indexOf("="); await one(p.slice(0, k), p.slice(k + 1), outDir); }
})();
