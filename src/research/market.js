// Market data: DexScreener's public API (price, market cap, liquidity, volume, buys/sells, price changes) and
// candles from GeckoTerminal's public OHLCV API (same pool). No keys needed for either.
const { getJson } = require("./net");

/** every pair DexScreener has for the mint, and the one that matters (most liquid; the pump.fun curve pre-bond) */
const dexCache = new Map(); // `${mint}|${pair}` -> { at, p }: one request when the read and the research ask together
function dexscreener(mint, pairHint) {
  const k = `${mint}|${pairHint || ""}`, c = dexCache.get(k);
  if (c && Date.now() - c.at < 10_000) return c.p;
  const p = dexscreenerUncached(mint, pairHint);
  dexCache.set(k, { at: Date.now(), p }); p.catch(() => dexCache.delete(k));
  if (dexCache.size > 50) dexCache.delete(dexCache.keys().next().value);
  return p;
}
async function dexscreenerUncached(mint, pairHint) {
  const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => p.baseToken?.address === mint);
  if (!mine.length) return null;
  const hinted = pairHint && mine.find((p) => p.pairAddress === pairHint);
  const best = hinted || [...mine].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0) || (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
  const priceUsd = Number(best.priceUsd) || null;
  const mcUsd = best.marketCap || best.fdv || null;
  return {
    name: best.baseToken.name?.trim(), symbol: best.baseToken.symbol?.trim(),
    dex: best.dexId, pair: best.pairAddress, url: best.url, pairs: mine.length,
    quote: best.quoteToken?.symbol, quoteAddress: best.quoteToken?.address,
    priceUsd, priceSol: Number(best.priceNative) || null,
    // DexScreener's market cap / price = the circulating supply it uses, so candle prices convert to market cap
    supply: priceUsd && mcUsd ? mcUsd / priceUsd : null,
    mcUsd, liquidityUsd: best.liquidity?.usd ?? null,
    // the pool's own reserves: tokens (base) and the quote side, for how far a sell would move the price
    liquidityBase: best.liquidity?.base ?? null, liquidityQuote: best.liquidity?.quote ?? null,
    volume: best.volume || {}, txns: best.txns || {}, change: best.priceChange || {},
    createdAt: best.pairCreatedAt || null,
    image: best.info?.imageUrl || null,
    socials: [...(best.info?.socials || []).map((s) => s.type), ...(best.info?.websites || []).length ? ["website"] : []],
    links: { twitter: (best.info?.socials || []).find((s) => s.type === "twitter")?.url || null, telegram: (best.info?.socials || []).find((s) => s.type === "telegram")?.url || null, website: best.info?.websites?.[0]?.url || null },
    boosts: best.boosts?.active || 0,
  };
}

/** just the price and market cap of one pair (the live watcher's poll) */
async function pairNow(pair) {
  const j = await getJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`, { ms: 6000 });
  const p = j.pairs?.[0] || j.pair;
  if (!p) return null;
  return { priceUsd: Number(p.priceUsd) || null, mcUsd: p.marketCap || p.fdv || null, txns: p.txns, volume: p.volume, change: p.priceChange, liquidityUsd: p.liquidity?.usd ?? null, dex: p.dexId };
}

/** pick a candle size from the coin's age: young coins move by the minute */
function timeframe(createdAt) {
  const ageH = createdAt ? (Date.now() - createdAt) / 3.6e6 : 99;
  if (ageH < 3) return { tf: "minute", agg: 1, label: "1m" };
  if (ageH < 24) return { tf: "minute", agg: 5, label: "5m" };
  if (ageH < 24 * 7) return { tf: "minute", agg: 15, label: "15m" };
  return { tf: "hour", agg: 1, label: "1h" };
}

/** recent candles, oldest first: [{ t, o, h, l, c, v }] in USD (price of the coin) */
async function candles(pool, createdAt) {
  const { tf, agg, label } = timeframe(createdAt);
  const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=120&currency=usd&token=base`, { ms: 10000 });
  const list = (j.data?.attributes?.ohlcv_list || []).map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v })).sort((a, b) => a.t - b.t);
  return { label, list, source: "geckoterminal" };
}

module.exports = { dexscreener, pairNow, candles, timeframe };
