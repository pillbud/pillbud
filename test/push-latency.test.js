// node test/push-latency.test.js [mint] [seconds]
// How fast the Helius websocket delivers a trade: subscribe to the coin's pool vault (or pump.fun curve) and, for a
// sample of notifications, compare arrival time with the block's time (getBlockTime: 1 s resolution, so each sample
// is +/- 1 s; the median over many samples is what matters). Alerts fire synchronously on these pushes.
const { research } = require("../src/research");
const { curvePda } = require("../src/research/chain");
const { makeFeed } = require("../src/feed");
const { rpc } = require("../src/research/net");

(async () => {
  const mint = process.argv[2] || "3rgFUpCG4Vs2twJordBqLgUtuzdr7yckJNP33fQypump";
  const secs = Number(process.argv[3] || 60);
  const f = await research(mint);
  const account = f.pump && !f.pump.bonded ? curvePda(mint) : f.programs?.[0]?.account;
  console.log(`$${f.symbol}: watching ${f.pump && !f.pump.bonded ? "the pump.fun curve" : "the pool's token vault"} ${account}`);
  const feed = makeFeed((m) => console.log("feed:", m));
  const samples = [];
  let n = 0;
  feed.watchAccount(account, "base64", (v, slot, at) => {
    n++;
    if (n % 5 !== 1 || samples.length >= 40) return;
    setTimeout(() => rpc("getBlockTime", [slot]).then((bt) => { if (bt) samples.push(at - bt * 1000); }).catch(() => {}), 6000); // the block needs to be confirmed first
  });
  setTimeout(() => {
    feed.close();
    const s = samples.sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    console.log(`${n} pushes in ${secs} s; ${s.length} timed: median ${q(0.5)} ms after the block (p10 ${q(0.1)}, p90 ${q(0.9)}; block times are whole seconds, so each sample is +0 to +1000 ms high)`);
    process.exit(0);
  }, secs * 1000 + 8000);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
