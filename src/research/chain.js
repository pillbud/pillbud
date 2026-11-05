// On-chain research through Helius RPC: the pump.fun bonding curve (progress, creator), top holders and how
// concentrated they are, the creator's wallet and whether it has sold, and how many top holders are fresh wallets.
// Read-only: nothing here signs or sends a transaction.
const { PublicKey } = require("@solana/web3.js");
const { rpc, pool } = require("./net");

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WSOL = "So11111111111111111111111111111111111111112";
// pump.fun curve: 1,073,000,000 virtual tokens at the start; it bonds once 793,100,000 have been sold
const CURVE_START = 1_073_000_000, CURVE_SELL = 793_100_000;
const FRESH_DAYS = 3;

/** every account of a transaction in balance order: static keys, then lookup-table writable, then readonly */
const keysOf = (tx) => [...tx.transaction.message.accountKeys.map((k) => String(k.pubkey || k)), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
const isWallet = (a) => { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return false; } };
const curvePda = (mint) => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0].toBase58();
const ataOf = (owner, mint, program) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0].toBase58();

/** the mint: supply, decimals, which token program */
async function mintInfo(mint) {
  const r = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const v = r?.value;
  if (!v || v.data?.parsed?.type !== "mint") throw new Error("not a token mint");
  const info = v.data.parsed.info;
  return { program: v.owner, decimals: info.decimals, supply: Number(info.supply) / 10 ** info.decimals, mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority };
}

/** pump.fun bonding curve state, or null if this isn't a pump.fun coin */
async function bondingCurve(mint) {
  const address = curvePda(mint);
  const r = await rpc("getAccountInfo", [address, { encoding: "base64" }]);
  const v = r?.value;
  if (!v || v.owner !== PUMP_PROGRAM.toBase58()) return null;
  const buf = Buffer.from(v.data[0], "base64");
  if (buf.length < 49) return null;
  const vTokens = Number(buf.readBigUInt64LE(8)) / 1e6;
  const vSol = Number(buf.readBigUInt64LE(16)) / 1e9;
  const realSol = Number(buf.readBigUInt64LE(32)) / 1e9;
  const supply = Number(buf.readBigUInt64LE(40)) / 1e6 || 1_000_000_000;
  const complete = buf[48] === 1;
  let creator = null;
  if (buf.length >= 81) { const c = buf.subarray(49, 81); if (c.some((b) => b)) creator = new PublicKey(c).toBase58(); }
  const progress = complete ? 100 : Math.max(0, Math.min(100, ((CURVE_START - vTokens) / CURVE_SELL) * 100));
  // the exact price right now, from the curve's reserves (DexScreener's two endpoints both lag it by a few %)
  const mcSol = !complete && vTokens > 0 ? (vSol / vTokens) * supply : null;
  return { address, bonded: complete, progressPct: round(progress, 1), realSol: round(realSol, 2), creator, mcSol, vTokens, vSol };
}

/** the very first transaction of the mint: when it launched and who paid for it (the deployer) */
async function launchTx(mint) {
  const res = await rpc("getTransactionsForAddress", [mint, { transactionDetails: "full", sortOrder: "asc", limit: 1, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
  const tx = res?.data?.[0];
  if (!tx) return null;
  return { at: (tx.blockTime || 0) * 1000, payer: String(tx.transaction.message.accountKeys[0]?.pubkey || tx.transaction.message.accountKeys[0]) };
}

/** the 20 biggest token accounts, with who owns them. Program-owned (curve, AMM pool, locker) = not a person */
async function holders(mint, supply) {
  const big = (await rpc("getTokenLargestAccounts", [mint])).value || [];
  const own = await rpc("getMultipleAccounts", [big.map((b) => b.address), { encoding: "jsonParsed" }]);
  return big.map((b, i) => {
    const owner = own.value[i]?.data?.parsed?.info?.owner || null;
    const tokens = Number(b.uiAmountString ?? b.uiAmount ?? 0);
    return { account: b.address, owner, tokens, pct: supply ? (tokens / supply) * 100 : null, wallet: !!owner && isWallet(owner) };
  }).filter((h) => h.tokens > 0);
}

/** every change to one wallet's balance of the coin, from the history of its token account */
async function walletTrades(owner, mint, account) {
  const out = [];
  let token;
  for (let page = 0; page < 3; page++) {
    const res = await rpc("getTransactionsForAddress", [account, { transactionDetails: "full", sortOrder: "asc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" }, ...(token ? { paginationToken: token } : {}) }]);
    for (const tx of res?.data || []) {
      const m = tx.meta;
      if (!m || m.err) continue;
      const bal = (list) => (list || []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + Number(b.uiTokenAmount?.uiAmountString || 0), 0);
      const dTok = bal(m.postTokenBalances) - bal(m.preTokenBalances);
      if (Math.abs(dTok) < 1e-6) continue;
      const keys = keysOf(tx);
      const i = keys.indexOf(owner);
      let dSol = i >= 0 ? (m.postBalances[i] - m.preBalances[i]) / 1e9 + (i === 0 ? m.fee / 1e9 : 0) : 0;
      const wsol = (list) => (list || []).filter((b) => b.owner === owner && b.mint === WSOL).reduce((s, b) => s + Number(b.uiTokenAmount?.uiAmountString || 0), 0);
      dSol += wsol(m.postTokenBalances) - wsol(m.preTokenBalances);
      const kind = dTok > 0 ? (dSol < 0 ? "buy" : "received") : (dSol > 0 ? "sell" : "sent");
      out.push({ kind, tokens: Math.abs(dTok), sol: Math.abs(dSol), at: (tx.blockTime || 0) * 1000, sig: tx.transaction.signatures[0] });
    }
    token = res?.paginationToken;
    if (!token || (res?.data || []).length < 100) break;
  }
  return out;
}

/** the creator's wallet: what it bought, whether it sold or moved tokens out, and what it holds now */
async function dev(mint, creator, program, supply) {
  if (!creator) return null;
  const account = ataOf(creator, mint, program);
  const [trades, bal] = await Promise.all([
    walletTrades(creator, mint, account).catch((e) => ({ error: e.message })),
    devBalance(account).catch((e) => ({ error: e.message })),
  ]);
  // couldn't read = unknown, never "hasn't sold" (zero is not a measurement)
  if (trades.error || bal?.error) return { wallet: creator, account, unknown: true, why: trades.error || bal.error };
  const sum = (k) => trades.filter((t) => t.kind === k).reduce((s, t) => s + t.tokens, 0);
  const sells = trades.filter((t) => t.kind === "sell");
  const pct = (x) => (supply ? round((x / supply) * 100, 2) : null);
  return {
    wallet: creator, account,
    boughtPct: pct(sum("buy")), soldPct: pct(sum("sell")), sentOutPct: pct(sum("sent")), holdsPct: pct(bal),
    holdsTokens: bal, sold: sells.length > 0, sells: sells.length,
    soldSol: round(sells.reduce((s, t) => s + t.sol, 0), 3),
    lastSellAt: sells.length ? sells[sells.length - 1].at : null,
  };
}

/** how many of the top wallet holders are fresh (first transaction ever under FRESH_DAYS ago) */
async function freshWallets(list) {
  const top = list.filter((h) => h.wallet).slice(0, 10);
  const ages = await pool(top, 4, async (h) => {
    const sigs = await rpc("getSignaturesForAddress", [h.owner, { limit: 100 }]);
    if (sigs.length >= 100) return { ...h, txs: "100+", fresh: false };
    const first = sigs[sigs.length - 1]?.blockTime;
    const days = first ? (Date.now() / 1000 - first) / 86400 : null;
    return { ...h, txs: sigs.length, ageDays: days == null ? null : round(days, 1), fresh: days != null && days < FRESH_DAYS };
  });
  const fresh = ages.filter((a) => a && a.fresh);
  return { checked: ages.length, fresh: fresh.length, freshPct: round(fresh.reduce((s, a) => s + (a.pct || 0), 0), 2), list: ages };
}

/** the dev's balance right now (the live watcher's poll). 0 if the account is gone (sold out and closed) */
async function devBalance(account) {
  try { return Number((await rpc("getTokenAccountBalance", [account], 8000)).value.uiAmountString); }
  catch (e) { if (/could not find account|Invalid param/i.test(e.message)) return 0; throw e; }
}

/** candles built straight from the chain's swaps, for coins too new for GeckoTerminal. Prices in USD. */
async function chainCandles(mint, solUsd, supply, bucketMs = 60_000) {
  const trades = [];
  let token;
  for (let page = 0; page < 4; page++) {
    const res = await rpc("getTransactionsForAddress", [mint, { transactionDetails: "full", sortOrder: "desc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" }, ...(token ? { paginationToken: token } : {}) }]);
    for (const tx of res?.data || []) {
      const m = tx.meta;
      if (!m || m.err) continue;
      const keys = keysOf(tx);
      const d = new Map();
      const add = (list, sign) => { for (const b of list || []) { if (!b.owner || b.mint !== mint) continue; d.set(b.owner, (d.get(b.owner) || 0) + sign * Number(b.uiTokenAmount?.uiAmountString || 0)); } };
      add(m.preTokenBalances, -1); add(m.postTokenBalances, 1);
      for (const [owner, dTok] of d) {
        if (Math.abs(dTok) < 1 || !isWallet(owner)) continue;
        const i = keys.indexOf(owner);
        if (i < 0) continue;
        const dSol = (m.postBalances[i] - m.preBalances[i]) / 1e9 + (i === 0 ? m.fee / 1e9 : 0);
        if ((dTok > 0 && dSol >= 0) || (dTok < 0 && dSol <= 0)) continue; // a transfer, not a trade
        trades.push({ at: (tx.blockTime || 0) * 1000, price: (Math.abs(dSol) / Math.abs(dTok)) * solUsd, usd: Math.abs(dSol) * solUsd, side: dTok > 0 ? "buy" : "sell" });
      }
    }
    token = res?.paginationToken;
    if (!token || (res?.data || []).length < 100) break;
  }
  trades.sort((a, b) => a.at - b.at);
  const buckets = new Map();
  for (const t of trades) {
    const k = Math.floor(t.at / bucketMs) * bucketMs;
    const c = buckets.get(k) || { t: k, o: t.price, h: t.price, l: t.price, c: t.price, v: 0 };
    c.h = Math.max(c.h, t.price); c.l = Math.min(c.l, t.price); c.c = t.price; c.v += t.usd;
    buckets.set(k, c);
  }
  return { label: "1m", list: [...buckets.values()], source: "chain swaps", trades: trades.length };
}

const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

module.exports = { mintInfo, bondingCurve, launchTx, holders, dev, freshWallets, devBalance, chainCandles, curvePda, isWallet, TOKEN, TOKEN22 };
