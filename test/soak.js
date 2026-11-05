// node test/soak.js [minutes]   (start the test instance first: PILLBUD_TEST=1 PILLBUD_TEST_TABREADER=1 electron .)
// Keeps the hidden app busy for an hour (a text-mode line every 10 s, a coin switch every 5 min so feed
// subscriptions churn, the tab reader on) and samples memory + CPU every minute. Reports growth per hour after a
// 5 min warm-up, then quits the instance.
const fs = require("node:fs");
const path = require("node:path");
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47331";
const mins = Number(process.argv[2] || 60);
const COINS = ["7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump", "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump", "HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump"];
const OUT = path.join(__dirname, "..", "captures", "soak.txt");
const j = async (p, o) => (await fetch(A + p, o)).json();
const post = (p, body) => fetch(A + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const log = (s) => { console.log(s); fs.appendFileSync(OUT, s + "\n"); };

(async () => {
  fs.writeFileSync(OUT, "");
  for (let i = 0; i < 60; i++) { try { await j("/status"); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  await post("/debug/pref", { mode: "text" });
  try { log(`capture timing (image discarded): ${JSON.stringify(await j("/debug/capture-timing"))}`); } catch (e) { log(`capture timing failed: ${e.message}`); }
  const samples = [];
  const t0 = Date.now();
  let n = 0, coin = 0;
  const talk = setInterval(() => post("/debug/say", { text: `Soak line ${++n}: still here, still watching.`, kind: "info" }).catch(() => {}), 10000);
  const switcher = setInterval(() => post("/coin", { url: `https://pump.fun/coin/${COINS[coin++ % COINS.length]}` }).catch(() => {}), 5 * 60000);
  post("/coin", { url: `https://pump.fun/coin/${COINS[coin++]}` });
  const sample = async () => {
    try {
      const h = await j("/debug/health");
      const total = h.processes.reduce((s, p) => s + p.memMB, 0), cpu = h.processes.reduce((s, p) => s + p.cpu, 0);
      const r = { min: +((Date.now() - t0) / 60000).toFixed(1), totalMB: total, mainHeapMB: h.mainHeapMB, rendererMB: h.processes.find((p) => p.type === "Tab")?.memMB, cpu: +cpu.toFixed(2), feed: h.feed.accounts, reconnects: h.feed.reconnects, cache: h.cache, tabReader: h.tabReader?.running };
      samples.push(r); log(JSON.stringify(r));
    } catch (e) { log(`sample failed: ${e.message}`); }
  };
  await sample();
  const sampler = setInterval(sample, 60000);
  setTimeout(async () => {
    clearInterval(talk); clearInterval(switcher); clearInterval(sampler);
    await sample();
    const after = samples.filter((s) => s.min >= 5);
    const slope = (k) => { const xs = after.map((s) => s.min), ys = after.map((s) => s[k]); const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length; const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), den = xs.reduce((a, x) => a + (x - mx) ** 2, 0); return den ? +((num / den) * 60).toFixed(1) : 0; };
    log(`SUMMARY over ${mins} min, ${n} lines, ${coin} coin switches: total memory ${after[0]?.totalMB} -> ${after[after.length - 1]?.totalMB} MB (trend ${slope("totalMB")} MB/hour), main heap ${after[0]?.mainHeapMB} -> ${after[after.length - 1]?.mainHeapMB} MB (trend ${slope("mainHeapMB")} MB/hour), renderer trend ${slope("rendererMB")} MB/hour; avg CPU ${(samples.reduce((s, x) => s + x.cpu, 0) / samples.length).toFixed(2)}%`);
    await post("/debug/quit", {}).catch(() => {});
    process.exit(0);
  }, mins * 60000);
})();
