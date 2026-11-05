// Small HTTP + Solana RPC helpers shared by the research modules.
const { keys } = require("../env");

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function getJson(url, { ms = 10000, headers = {} } = {}) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json", ...headers } });
    if (r.status === 429 && tries < 3) { await sleep(800 * (tries + 1)); continue; }
    if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
    return r.json();
  }
}

let rpcCalls = 0, rpcCredits = 0, rpc429 = 0;
const refusedBy = {}; // method -> refusals (to see which calls hit the limit)
// Helius credits (helius.dev/docs/billing/credits, 2026-11-03): standard RPC 1; DAS (getAsset) 10;
// getTransactionsForAddress 10 per 100 transactions returned (10 minimum)
function credit(method, result) {
  if (method === "getTransactionsForAddress") return 10 * Math.max(1, Math.ceil((result?.data?.length || 0) / 100));
  if (method === "getAsset" || method === "getAssetsByOwner" || method === "searchAssets" || method === "getTokenAccounts" || method === "getTransfersByAddress") return 10; // getTransfersByAddress: 10 flat (helius.dev/docs/billing/credits, 2026-11-05)
  return 1;
}
// Pacing. This Helius plan refuses calls above about 12 a second (measured 2026-11-05: 12/s clean for most calls,
// getSignaturesForAddress refused 8 of 36 at 12/s, 10/s clean for all). Bursting and backing off after a refusal
// wasted most of the time (20 calls at once: 3.2 s). So calls draw from a token bucket: 4 can go at once (the first
// look at a coin stays instant), then 10 a second. A call that has to wait reserves its slot, so the queue is fair.
// config.json "heliusRps" overrides the rate (a paid plan allows more).
const RPS = () => Math.max(1, Number(process.env.HELIUS_RPS) || Number(require("../env").settings().heliusRps) || 10);
// The key can be shared with other tools, so the rate also adapts: a refusal cuts it by 30% (never under 3 a second)
// and every answered call wins a little back, up to the plan's rate.
const BURST = 4;
let tokens = BURST, filledAt = Date.now(), rateNow = null;
const adapt = (refused) => { const max = RPS(); rateNow = refused ? Math.max(3, (rateNow ?? max) * 0.7) : Math.min(max, (rateNow ?? max) + 0.15); };
function slot() {
  const now = Date.now(), rate = Math.min(RPS(), rateNow ?? RPS());
  tokens = Math.min(BURST, tokens + ((now - filledAt) * rate) / 1000);
  filledAt = now;
  tokens -= 1;
  return tokens >= 0 ? Promise.resolve() : sleep((-tokens * 1000) / rate);
}

/** one JSON-RPC call to Helius, paced to the plan's rate (a refusal still retries, after a short wait) */
async function rpc(method, params, ms = 15000) {
  if (!keys.HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL missing");
  for (let tries = 0; ; tries++) {
    await slot();
    rpcCalls++;
    const r = await fetch(keys.HELIUS_RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(ms),
    });
    if (r.status === 429 && tries < 5) { rpc429++; refusedBy[method] = (refusedBy[method] || 0) + 1; adapt(true); await sleep(200 * (tries + 1)); continue; }
    adapt(false);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    rpcCredits += credit(method, j.result);
    return j.result;
  }
}

/** run async jobs with at most n at a time (keeps Helius under its rate limit) */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; } }
  }));
  return out;
}

module.exports = { getJson, rpc, pool, sleep, rpcCount: () => rpcCalls, rpcCredits: () => rpcCredits, rpc429s: () => rpc429, refusedBy: () => ({ ...refusedBy }) };
