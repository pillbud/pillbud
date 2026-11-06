// research(mint): everything pillbud knows about a coin, from real sources only.
//   market  - DexScreener (price, market cap, liquidity, volume, buys/sells, changes)
//   pump    - the pump.fun bonding curve read from the chain (progress, bonded, creator); pump.fun's own API when it answers
//   holders - Helius: top 20 token accounts, concentration, fresh wallets
//   dev     - Helius: the creator's wallet history for this coin (bought, sold, sent out, holds)
//   state   - pumping / dumping / flat with the number (DexScreener 5 min / 1 h change); no chart patterns
const chain = require("./chain");
const market = require("./market");
const { marketState, money, ago } = require("./chart");
const { rpcCount, rpcCredits } = require("./net");
const holderMod = require("./holders");
const trench = require("./trench");
const { exchangeOf, EXCHANGE_SOL } = require("./labels");
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`over ${ms} ms`)), ms))]);

const round = (x, d = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const short = (a) => (a ? `${a.slice(0, 4)}...${a.slice(-4)}` : null);

/** pump.fun's own coin API (frontend-api-v3 /coins-v2). Cloudflare answers plain scripts with a 403, so this only
 *  works through Electron's network stack (the app passes net.fetch); the CLI skips it. Verified 2026-11-03. */
async function pumpApi(mint, fetcher) {
  if (!fetcher) return null;
  try {
    const j = await require("./pumpfun").coin(fetcher, mint); // shared with the read (one request)
    return {
      name: j.name, symbol: j.symbol, creator: j.creator, complete: j.complete, twitter: j.twitter, website: j.website,
      usdMarketCap: j.mcUsd, athMcUsd: j.athMcUsd, athAt: j.athAt, live: j.live, liveViewers: j.liveViewers, volume1hUsd: j.volume1hUsd,
      holderReward: j.holderReward, cashback: j.cashback, description: j.description,
    };
  } catch { return null; }
}

async function research(mint, { pairHint, fetcher, log = () => {}, deep = false } = {}) {
  const t0 = Date.now();
  const rpc0 = rpcCount(), cr0 = rpcCredits();
  const step = async (name, p) => { const s = Date.now(); try { const v = await p; log(`${name} ${Date.now() - s}ms`); return v; } catch (e) { log(`${name} failed: ${e.message}`); return null; } };

  // round 1: everything that only needs the mint
  const [mi, dex, curve, launch, pf] = await Promise.all([
    step("mint", chain.mintInfo(mint)),
    step("dexscreener", market.dexscreener(mint, pairHint)),
    step("curve", chain.bondingCurve(mint)),
    step("launch", chain.launchTx(mint)),
    step("pump.fun api", pumpApi(mint, fetcher)),
  ]);
  if (!mi) throw new Error("couldn't read that mint on-chain");
  const supply = mi.supply;
  // the dev can be two wallets: the one that signed the launch (and made the dev buy) and the "creator" written on the
  // pump.fun curve (where creator fees go). They often differ, so both are checked.
  const devWallets = [...new Set([launch?.payer, curve?.creator, pf?.creator].filter(Boolean))];
  const roleOf = (w) => [w === launch?.payer ? "signed the launch" : null, w === curve?.creator || w === pf?.creator ? "creator on the pump.fun curve" : null].filter(Boolean).join(" + ");
  if (!launch) log("launch tx unreadable: age and deployer come from DexScreener / the curve only");
  const createdAt = launch?.at || dex?.createdAt || null;
  // SOL in USD: from the pair when it's quoted in SOL, else Jupiter's price (pump.fun coins can be quoted in other tokens now)
  const WSOL = "So11111111111111111111111111111111111111112";
  const quotedInSol = !dex || dex.quoteAddress === WSOL;
  const solUsd = quotedInSol ? (dex?.priceUsd && dex?.priceSol ? dex.priceUsd / dex.priceSol : await solPrice().catch(() => null)) : null;
  // still on the curve: the market cap comes from the chain, exactly
  if (curve?.mcSol && solUsd) { curve.mcUsd = curve.mcSol * solUsd; if (dex) { dex.mcUsdDexscreener = dex.mcUsd; dex.mcUsd = curve.mcUsd; } }

  // round 2: holders, the dev
  const [hs, dv, hc] = await Promise.all([
    step("holders", chain.holders(mint, supply)),
    step("dev", Promise.all(devWallets.map((w) => chain.dev(mint, w, mi.program, supply).then((d) => d && { ...d, role: roleOf(w) })))),
    step("holder count", within(holderMod.holderCount(mint), 3500)), // a big coin can take longer: then it's left out
  ]);
  // who among the top holders isn't one person: named exchange wallets, exchange-size wallets (50,000+ SOL) and very
  // active ones (exchanges, market makers, bots). Checked side by side with the fresh wallets.
  const top12 = (hs || []).filter((h) => h.wallet && !devWallets.includes(h.owner)).slice(0, 12).map((h) => h.owner);
  const [fresh, active, sol] = hs ? await Promise.all([
    step("fresh wallets", chain.freshWallets(hs.filter((h) => !devWallets.includes(h.owner) && !exchangeOf(h.owner)))),
    step("very active holders", trench.activeWallets(top12.filter((w) => !exchangeOf(w)))),
    step("holder SOL", chain.solBalances((hs || []).filter((h) => h.wallet).map((h) => h.owner))), // all top 20: one call
  ]) : [null, null, null];
  for (const h of hs || []) {
    const name = exchangeOf(h.owner), solBal = sol?.get(h.owner) || 0;
    if (name) { h.active = true; h.label = name; h.exchange = true; }
    else if (solBal >= EXCHANGE_SOL) { h.active = true; h.label = `an exchange-size wallet (${Math.round(solBal / 1000)}k SOL)`; h.exchange = true; }
    else if (active?.get(h.owner)) { h.active = true; h.label = "a very active wallet"; }
  }
  // the main dev = whoever made the launch buy (else the first one read); any dev wallet selling counts as the dev selling
  const devList = (dv || []).filter(Boolean);
  const mainDev = devList.find((d) => !d.unknown && d.boughtPct > 0) || devList.find((d) => !d.unknown) || devList[0] || null;
  const dev = mainDev && { ...mainDev, others: devList.filter((d) => d !== mainDev), anySold: devList.some((d) => d.sold) };

  // holders: people only (the curve / AMM pool / lockers are program accounts)
  const people = (hs || []).filter((h) => h.wallet && !h.active);
  const programs = (hs || []).filter((h) => !h.wallet);
  const top10 = people.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);

  const full = {
    mint, at: Date.now(), ms: Date.now() - t0, rpcCalls: rpcCount() - rpc0, heliusCredits: rpcCredits() - cr0,
    name: dex?.name || pf?.name || null, symbol: dex?.symbol || pf?.symbol || null, image: dex?.image || null,
    createdAt, ageMin: createdAt ? Math.round((Date.now() - createdAt) / 60000) : null,
    mintInfo: mi, market: dex, pump: curve, pumpApi: pf, holders: hs, programs, fresh, dev, solUsd, holderCount: hc,
    sources: ["dexscreener", "helius", curve ? "pump.fun curve (on-chain)" : null, pf ? "pump.fun api" : null].filter(Boolean),
  };
  full.state = marketState(dex, dev);
  full.facts = facts(full, { top10, people });
  holderMod.refresh(full); // the first holder stamp, from the holders alone; launch buyers and linked wallets sharpen it later
  if (deep) await addLegit(full, { fetcher, log });
  return full;
}

/** the legit-or-LARP read and trench checks (slower: ~5 to 15 s), added onto a finished research */
async function addLegit(full, { fetcher, log = () => {} } = {}) {
  const { legitCheck, legitFacts } = require("./legit");
  full.legit = await legitCheck(full, { fetcher, log });
  full.facts.legit = legitFacts(full.legit);
  holderMod.refresh(full); // linked wallets and the dev's record are in now
  return full;
}

/** the compact JSON the model sees: rounded real numbers only, nothing it would have to guess */
function facts(f, { top10, people }) {
  const m = f.market;
  const bs = (t) => (t ? `${t.buys}/${t.sells}` : null);
  const out = {
    coin: { name: f.name, symbol: f.symbol, mint: short(f.mint), age: f.ageMin == null ? null : f.ageMin < 120 ? `${f.ageMin} min` : f.ageMin < 2880 ? `${round(f.ageMin / 60, 0)} hours` : `${round(f.ageMin / 1440, 0)} days`, launchpad: f.pump || f.mint.endsWith("pump") ? "pump.fun" : null },
  };
  if (m) out.market = {
    where: m.dex, marketCap: `${money(m.mcUsd)}${f.pump?.mcUsd ? " (live from the pump.fun curve)" : ""}`, liquidity: money(m.liquidityUsd),
    volume: { m5: money(m.volume.m5), h1: money(m.volume.h1), h24: money(m.volume.h24) },
    buysSells: { m5: bs(m.txns.m5), h1: bs(m.txns.h1), h24: bs(m.txns.h24) },
    changePct: m.change, socials: m.socials, dexscreenerBoosts: m.boosts || undefined,
  };
  else out.market = "not on DexScreener yet";
  if (f.pump) out.pumpCurve = f.pump.bonded ? { bonded: true } : { bonded: false, progressPct: f.pump.progressPct, solInCurve: f.pump.realSol };
  if (f.pumpApi) out.pumpFun = {
    allTimeHighMarketCap: f.pumpApi.athMcUsd ? `${money(f.pumpApi.athMcUsd)} (${ago(Date.now() - f.pumpApi.athAt)})` : undefined,
    livestream: f.pumpApi.live ? `live now${f.pumpApi.liveViewers ? `, ${f.pumpApi.liveViewers} watching` : ""}` : undefined,
  };
  if (f.holders) out.holders = {
    top10WalletsPct: round(top10), biggestWalletPct: round(people[0]?.pct), poolOrCurvePct: round(f.programs[0]?.pct),
    freshTop10: f.fresh ? `${f.fresh.fresh} of ${f.fresh.checked} top wallets are fresh (first tx < 3 days ago), holding ${f.fresh.freshPct}%` : undefined,
    top5: people.slice(0, 5).map((h) => {
      const a = f.fresh?.list?.find((x) => x?.owner === h.owner);
      const devW = f.dev && [f.dev, ...f.dev.others].some((d) => d.wallet === h.owner);
      return `${short(h.owner)} ${round(h.pct, 2)}%${devW ? " (the dev)" : a?.fresh ? ` (fresh wallet, ${a.ageDays} days old)` : a?.txs === "100+" ? " (busy wallet, 100+ txs)" : a?.ageDays != null ? ` (${a.ageDays} days old)` : ""}`;
    }),
  };
  if (f.dev?.unknown) out.dev = { wallet: short(f.dev.wallet), history: "couldn't read the dev's wallet history right now, so whether the dev sold is UNKNOWN" };
  else if (!f.dev) out.dev = "unknown: couldn't identify the creator wallet";
  else {
    const one = (d) => (d.unknown ? { wallet: short(d.wallet), role: d.role, history: "unreadable right now: unknown" } : {
      wallet: short(d.wallet), role: d.role, holdsPct: d.holdsPct, boughtPct: d.boughtPct,
      sold: d.sold, soldPct: d.soldPct, sells: d.sells, soldSol: d.soldSol || undefined, sentOutPct: d.sentOutPct || undefined,
      lastSell: d.lastSellAt ? ago(Date.now() - d.lastSellAt) : undefined,
    });
    out.dev = { ...one(f.dev), devSoldAtAll: f.dev.anySold, ...(f.dev.others.length ? { otherDevWallets: f.dev.others.map(one) } : {}) };
  }
  out.mintSafety = { mintAuthority: f.mintInfo.mintAuthority ? "still active" : "renounced", freezeAuthority: f.mintInfo.freezeAuthority ? "still active" : "renounced" };
  out.state = f.state; // pumping / dumping / flat with the number; no chart patterns
  return out;
}

let solCache = { at: 0, v: null };
/** SOL's USD price from Jupiter, cached a minute */
async function solPrice() {
  if (Date.now() - solCache.at < 60_000 && solCache.v) return solCache.v;
  const j = await require("./net").getJson("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { ms: 5000 });
  solCache = { at: Date.now(), v: Number(j.So11111111111111111111111111111111111111112?.usdPrice) || null };
  return solCache.v;
}

/** the fastest look at a coin (DexScreener only, ~0.1 to 0.3 s): enough for the first spoken words */
async function quick(mint, pairHint) {
  const t0 = Date.now();
  const m = await market.dexscreener(mint, pairHint);
  return { mint, symbol: m?.symbol || null, name: m?.name || null, image: m?.image || null, market: m, state: marketState(m), ms: Date.now() - t0 };
}

module.exports = { research, addLegit, quick };
