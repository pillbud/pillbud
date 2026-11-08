// node test/ask-insiders.js : find a fresh pump.fun coin with an insider group, open it in the hidden test app and ask
// "Are there insiders on this?" by text. Prints pillbud's real answer (for the explainer video). Needs the test app running.
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47331";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(A + p).then((r) => r.json());
const pf = (path) => get(`/debug/pumpfun?path=${encodeURIComponent(path)}`);

(async () => {
  const lists = await Promise.all([pf("/coins/currently-live?limit=40&offset=0&includeNsfw=false"), pf("/coins?offset=0&limit=40&sort=last_trade_timestamp&order=DESC&includeNsfw=false")].map((p) => p.catch(() => [])));
  const coins = lists.flatMap((l) => (Array.isArray(l) ? l : l?.coins || [])).filter((c) => c?.mint && (c.usd_market_cap || 0) > 8000);
  const seen = new Set();
  for (const c of coins) {
    if (seen.has(c.mint)) continue; seen.add(c.mint);
    await fetch(A + "/coin", { method: "POST", body: JSON.stringify({ address: c.mint, site: "test" }) });
    // wait for the launch buyers and linked wallets
    let log = [];
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const all = await get("/debug/log").catch(() => []);
      let k = -1; all.forEach((l, j) => { if (/coin from/.test(l)) k = j; });
      log = all.slice(k);
      if (log.some((l) => /linked wallets in \d+ ms/.test(l)) && log.some((l) => /holders: /.test(l))) break;
    }
    const st = log.filter((l) => /holders: |linked wallets in/.test(l)).join(" | ");
    const strong = /insiders hold|linked wallets hold|snipers hold|bots hold/i.test(st) && !/dumped/i.test(st);
    console.log(`$${c.symbol} ${Math.round(c.usd_market_cap / 1000)}k: ${st.slice(0, 200)}`);
    if (!strong) continue;
    await sleep(6000);
    const before = (await get("/debug/lines")).length;
    await fetch(A + "/debug/ask-text", { method: "POST", body: "Are there insiders on this?" });
    for (let i = 0; i < 30; i++) { await sleep(1000); const L = await get("/debug/lines"); if (L.length > before + 1 && i > 6) break; }
    const L = await get("/debug/lines");
    console.log(`\n== $${c.symbol} (${c.mint}) answer:`);
    for (const l of L.slice(before)) if (l.kind === "answer") console.log("  ", l.text);
    return;
  }
  console.log("no coin with a live insider group in this batch");
})();
