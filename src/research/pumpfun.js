// pump.fun's own data. The frontend API (frontend-api-v3) answers only through a browser network stack: Cloudflare
// returns 403 to plain scripts, so the app passes Electron's net.fetch as `fetcher` (verified 2026-11-03).
// Coin metadata JSON (description, X, Telegram, website) comes from IPFS through pump.fun's own Pinata gateway,
// which plain Node can reach (ipfs.io and dweb.link now refuse scripts).
const { getJson } = require("./net");

const API = "https://frontend-api-v3.pump.fun";
const GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

async function api(fetcher, path, ms = 8000) {
  if (!fetcher) throw new Error("pump.fun API needs the app (Cloudflare blocks plain scripts)");
  const r = await fetcher(`${API}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`pump.fun ${r.status}`);
  return r.json();
}

/** one coin (coins-v2): creator, ATH, livestream, links */
const coinCache = new Map(); // mint -> { at, p }: the read and the background research ask at the same moment
async function coin(fetcher, mint) {
  const c = coinCache.get(mint);
  if (c && Date.now() - c.at < 10_000) return c.p;
  const p = coinUncached(fetcher, mint);
  coinCache.set(mint, { at: Date.now(), p }); p.catch(() => coinCache.delete(mint));
  if (coinCache.size > 50) coinCache.delete(coinCache.keys().next().value);
  return p;
}
async function coinUncached(fetcher, mint) {
  const j = await api(fetcher, `/coins-v2/${mint}`);
  return {
    mint: j.mint, name: j.name?.trim(), symbol: j.symbol?.trim(), creator: j.creator, createdAt: j.created_timestamp, complete: !!j.complete,
    image: j.image_uri, metadataUri: j.metadata_uri, description: (j.description || "").trim().slice(0, 500) || null, twitter: j.twitter || null, telegram: j.telegram || null, website: j.website || null,
    mcUsd: j.usd_market_cap ?? j.market_cap_usd ?? null, athMcUsd: j.ath_market_cap ?? null, athAt: j.ath_market_cap_timestamp ?? null,
    lastTradeAt: j.last_trade_timestamp ?? null, live: !!j.is_currently_live, liveViewers: j.is_currently_live ? j.num_participants ?? null : null,
    volume1hUsd: j.volume_1h_usd ?? null, replies: j.reply_count ?? null,
    holderReward: !!j.is_holder_reward, cashback: !!j.is_cashback_enabled, // where creator fees go (fees.js)
  };
}

/** coins whose name or ticker matches (pump.fun's own search) */
async function search(fetcher, term, limit = 50) {
  const list = await api(fetcher, `/coins/search-v2?searchTerm=${encodeURIComponent(term)}&limit=${limit}`);
  // pump.fun also lists coins on other chains now (0x... mints): Solana only
  return (Array.isArray(list) ? list : []).filter((j) => (!j.chain_id || String(j.chain_id).startsWith("solana")) && !/^0x/i.test(j.mint || "")).map((j) => ({
    mint: j.mint, name: j.name?.trim(), symbol: j.symbol?.trim(), creator: j.creator, createdAt: j.created_timestamp, complete: !!j.complete,
    twitter: j.twitter || null, website: j.website || null, image: j.image_uri || null, mcUsd: j.market_cap_usd ?? j.usd_market_cap ?? null, athMcUsd: j.ath_market_cap ?? null, lastTradeAt: j.last_trade_timestamp ?? null,
  }));
}

/** every coin a wallet created on pump.fun (up to `limit`) */
async function createdBy(fetcher, wallet, limit = 50) {
  // answers { limit, offset, count, coins: [...] } (an array in older versions)
  const j0 = await api(fetcher, `/coins-v2/user-created-coins/${wallet}?offset=0&limit=${limit}&includeNsfw=true`);
  const list = Array.isArray(j0) ? j0 : j0?.coins || [];
  const out = list.map((j) => ({ mint: j.mint, name: j.name?.trim(), symbol: j.symbol?.trim(), complete: !!j.complete }));
  out.total = Array.isArray(j0) ? list.length : j0?.count ?? list.length;
  return out;
}

/** the metadata JSON the coin was launched with: name, symbol, description, image, twitter, telegram, website */
async function metadata(uri) {
  if (!uri) throw new Error("no metadata uri");
  const cid = (/\/ipfs\/([^/?#]+)/.exec(uri) || [])[1];
  const urls = cid ? GATEWAYS.map((g) => g + cid) : [uri];
  let last;
  for (const u of urls) {
    try { return { ...(await getJson(u, { ms: 6000 })), via: new URL(u).host }; } catch (e) { last = e; }
  }
  throw last;
}

module.exports = { coin, search, createdBy, metadata };
