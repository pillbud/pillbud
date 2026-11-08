// Trench checks from the chain (Helius) and pump.fun:
//   launch   - how much supply the dev, the launch slot (bundle) and the next 3 slots (snipers) bought
//   clusters - which top holders / early buyers were first funded by the same wallet (or by the dev)
//   devHist  - the dev wallets' other pump.fun coins and how they ended (bonded / rugged / dead / alive)
// Every number comes from transactions or APIs; anything that can't be read comes back as unknown, never as clean.
const { PublicKey } = require("@solana/web3.js");
const { rpc, pool } = require("./net");
const pumpfun = require("./pumpfun");

const WSOL = "So11111111111111111111111111111111111111112";
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const isWallet = (a) => { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return false; } };
const keysOf = (tx) => [...tx.transaction.message.accountKeys.map((k) => String(k.pubkey || k)), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const short = (a) => (a ? `${a.slice(0, 4)}...${a.slice(-4)}` : null);

/** buys and sells inside one transaction, as balance changes of wallets (not program accounts) */
function tradesOf(tx, mint) {
  const m = tx.meta;
  if (!m || m.err) return [];
  const keys = keysOf(tx);
  const d = new Map();
  for (const [list, sign] of [[m.preTokenBalances, -1], [m.postTokenBalances, 1]]) {
    for (const b of list || []) if (b.owner && b.mint === mint) d.set(b.owner, (d.get(b.owner) || 0) + sign * Number(b.uiTokenAmount?.uiAmountString || 0));
  }
  const out = [];
  for (const [owner, tok] of d) {
    if (Math.abs(tok) < 1 || !isWallet(owner)) continue;
    const i = keys.indexOf(owner);
    const sol = i >= 0 ? (m.postBalances[i] - m.preBalances[i]) / 1e9 + (i === 0 ? m.fee / 1e9 : 0) : 0;
    if ((tok > 0 && sol >= 0) || (tok < 0 && sol <= 0)) continue; // transfers aren't trades
    out.push({ wallet: owner, side: tok > 0 ? "buy" : "sell", tokens: Math.abs(tok), sol: Math.abs(sol), slot: tx.slot, at: (tx.blockTime || 0) * 1000, payer: keys[0] });
  }
  return out;
}

/** the launch: dev buy, same-slot bundle, next-3-slot snipers, as % of supply */
async function launch(mint, supply, devWallets) {
  const res = await rpc("getTransactionsForAddress", [mint, { transactionDetails: "full", sortOrder: "asc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
  const txs = res?.data || [];
  if (!txs.length) throw new Error("no transactions");
  const s0 = txs[0].slot;
  const trades = txs.flatMap((t) => tradesOf(t, mint));
  const buys = trades.filter((t) => t.side === "buy");
  const pct = (list) => round((list.reduce((s, t) => s + t.tokens, 0) / supply) * 100, 2);
  const devs = new Set(devWallets);
  const devBuys = buys.filter((t) => devs.has(t.wallet) && t.slot === s0);
  const bundle = buys.filter((t) => t.slot === s0 && !devs.has(t.wallet));
  const snipers = buys.filter((t) => t.slot > s0 && t.slot <= s0 + 3 && !devs.has(t.wallet));
  const wallets = (list) => [...new Set(list.map((t) => t.wallet))];
  return {
    launchSlot: s0, launchedAt: (txs[0].blockTime || 0) * 1000, txsRead: txs.length,
    devBuyPct: pct(devBuys),
    bundle: { pct: pct(bundle), wallets: wallets(bundle) },        // bought in the very slot the coin was created
    snipers: { pct: pct(snipers), wallets: wallets(snipers) },     // bought within ~1.2 s (3 slots) after
  };
}

/** who first sent SOL to a wallet (the funder), from its 3 oldest transactions (oldest first) */
function funderFrom(txs, wallet) {
  for (const tx of txs.slice(0, 3)) {
    const keys = keysOf(tx);
    const i = keys.indexOf(wallet);
    if (i < 0 || !tx.meta) continue;
    const gain = tx.meta.postBalances[i] - tx.meta.preBalances[i];
    if (gain > 0 && keys[0] !== wallet) return { funder: keys[0], sol: gain / 1e9, at: (tx.blockTime || 0) * 1000 };
  }
  return { funder: null };
}
async function funderOf(wallet) {
  const res = await rpc("getTransactionsForAddress", [wallet, { transactionDetails: "full", sortOrder: "asc", limit: 3, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
  return funderFrom(res?.data || [], wallet);
}

// Busy wallets (1,000+ transactions: exchanges, routers, trading bots' fee payers) never link anything, and the same
// ones turn up on coin after coin (one relayer paid fees for top holders of both $WLFI and $QORB). So the answer is
// remembered: a busy wallet for 30 days, a quiet one for 6 hours. Kept in cache/wallet-activity.json.
const fs = require("node:fs");
const path = require("node:path");
let busyMem = null, saveTimer = null;
const busyFile = () => path.join(require("../env").DATA_DIR, "cache", "wallet-activity.json");
function busyStore() {
  if (!busyMem) { try { busyMem = new Map(Object.entries(JSON.parse(fs.readFileSync(busyFile(), "utf8")))); } catch { busyMem = new Map(); } }
  return busyMem;
}
function saveBusy() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.mkdirSync(path.dirname(busyFile()), { recursive: true }); fs.writeFileSync(busyFile(), JSON.stringify(Object.fromEntries([...busyMem].slice(-5000)))); } catch { /* a cache only */ } }, 1500);
  saveTimer.unref?.();
}
const busyAsking = new Map(); // wallet -> the check in flight
function busyOne(w) {
  const store = busyStore(), c = store.get(w);
  if (c && Date.now() - c.at < (c.busy ? 30 * 864e5 : 6 * 36e5)) return Promise.resolve(c.busy);
  if (busyAsking.has(w)) return busyAsking.get(w);
  const p = rpc("getSignaturesForAddress", [w, { limit: 1000 }])
    .then((sigs) => { const busy = sigs.length >= 1000; store.set(w, { busy, at: Date.now() }); saveBusy(); return busy; })
    .catch(() => null) // unknown: treated as not proven quiet, so it links nothing
    .finally(() => busyAsking.delete(w));
  busyAsking.set(w, p);
  return p;
}
// Very active wallets: 200 transactions in the last 6 hours. Exchanges' hot wallets, market makers and trading bots
// look like this; a person holding a coin doesn't. They hold tokens for many people (or flip them all day), so they're
// never one holder: left out of linking and of the whale and top-10 numbers (2026-11-05: Binance's 9WzD...AWWM held
// 31% of $PNUT and was called a whale, and on $BONK eleven exchange wallets were "linked"). Remembered for a day.
const ACTIVE_N = 200, ACTIVE_SPAN_H = 6;
const activeAsking = new Map();
function activeOne(w) {
  const store = busyStore(), k = `active:${w}`, c = store.get(k);
  if (c && Date.now() - c.at < 24 * 36e5) return Promise.resolve(c.active);
  if (activeAsking.has(w)) return activeAsking.get(w);
  const p = rpc("getSignaturesForAddress", [w, { limit: ACTIVE_N }])
    .then((sigs) => {
      const oldest = sigs[sigs.length - 1]?.blockTime;
      const active = sigs.length >= ACTIVE_N && !!oldest && Date.now() / 1000 - oldest < ACTIVE_SPAN_H * 3600;
      store.set(k, { active, at: Date.now() }); saveBusy(); return active;
    })
    .catch(() => null) // unknown: counted as a normal holder
    .finally(() => activeAsking.delete(w));
  activeAsking.set(w, p);
  return p;
}
/** wallet -> true when it's very active (see above) */
async function activeWallets(list) {
  const ws = [...new Set(list)].filter(Boolean);
  const got = await Promise.all(ws.map(activeOne));
  return new Map(ws.map((w, i) => [w, got[i] === true]));
}
async function busyWallets(list) {
  const ws = [...new Set(list)];
  const got = await Promise.all(ws.map(busyOne));
  return new Map(ws.map((w, i) => [w, got[i] == null ? true : got[i]]));
}

/** proof that top holders are one person, from each holder's own history of the coin (its first 100 changes):
 *  who sent it the tokens, who paid the fee for its buy, and which other wallets got tokens in the same transaction.
 *  A shared first funder alone misses most of these pairs. */
async function proofLinks({ holders, mint, max = 12 }) {
  const people = holders.filter((h) => h.wallet && h.account).slice(0, max);
  const edges = []; // { a, b, how, sig }
  const read = await pool(people, 8, async (h) => {
    const res = await rpc("getTransactionsForAddress", [h.account, { transactionDetails: "full", sortOrder: "asc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
    for (const tx of res?.data || []) {
      const m = tx.meta;
      if (!m || m.err) continue;
      const keys = keysOf(tx), payer = keys[0], sig = tx.transaction.signatures[0];
      const d = new Map();
      for (const [list, sign] of [[m.preTokenBalances, -1], [m.postTokenBalances, 1]]) for (const b of list || []) if (b.owner && b.mint === mint) d.set(b.owner, (d.get(b.owner) || 0) + sign * Number(b.uiTokenAmount?.uiAmountString || 0));
      const mine = d.get(h.owner) || 0;
      if (Math.abs(mine) < 1) continue;
      // someone else paid the fee for this wallet's move: a bundler, or the owner of both wallets
      if (payer !== h.owner && isWallet(payer)) edges.push({ a: payer, b: h.owner, how: "paid for its trades", sig });
      for (const [o, t] of d) {
        if (o === h.owner || Math.abs(t) < 1 || !isWallet(o)) continue; // curves and pool vaults are program-owned: skipped
        if (Math.sign(t) !== Math.sign(mine)) edges.push(mine > 0 ? { a: o, b: h.owner, how: "sent it tokens", sig } : { a: h.owner, b: o, how: "sent it tokens", sig });
        else if (mine > 0) edges.push({ a: h.owner, b: o, how: "bought in the same transaction", sig });
      }
    }
    return true;
  });
  return { edges, read: read.filter((x) => x === true).length, unreadable: read.filter((x) => x && x.error).length };
}

/** SOL moved between top holders, or through one quiet wallet: each holder's 100 most recent plain SOL transfers (no
 *  token in the transaction). On $QORB (2026-11-05) a wallet with 10 transactions had moved SOL with 3 top holders
 *  holding 8.5% together. */
async function solLinks({ holders, max = 12 }) {
  const people = holders.filter((h) => h.wallet).slice(0, max);
  const set = new Set(people.map((h) => h.owner));
  const edges = [], funders = new Map();
  const read = await pool(people, 8, async (h) => {
    const res = await rpc("getTransactionsForAddress", [h.owner, { transactionDetails: "full", sortOrder: "desc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
    const data = res?.data || [];
    if (data.length < 100 && !res?.paginationToken) funders.set(h.owner, funderFrom([...data].reverse(), h.owner)); // its whole history: no separate funder call
    for (const tx of data) {
      const m = tx.meta;
      if (!m || m.err || (m.preTokenBalances || []).length || (m.postTokenBalances || []).length) continue; // a swap, not a SOL transfer
      const keys = keysOf(tx), i = keys.indexOf(h.owner);
      if (i < 0) continue;
      const mine = m.postBalances[i] - m.preBalances[i];
      if (Math.abs(mine) < 1e6) continue; // under 0.001 SOL: fees and rent
      keys.forEach((k, j) => {
        if (j === i || !isWallet(k)) return;
        const d = m.postBalances[j] - m.preBalances[j];
        if (Math.abs(d) >= 1e6 && Math.sign(d) === -Math.sign(mine)) edges.push({ a: k, b: h.owner, how: set.has(k) ? "sent SOL to each other" : "moved SOL with the same private wallet", sig: tx.transaction.signatures[0] });
      });
    }
    return true;
  });
  return { edges, funders, read: read.filter((x) => x === true).length, wallets: people.map((h) => h.owner) };
}

// ---- the fast path: Helius getTransfersByAddress (parsed transfer rows, 100 a call, 10 credits; Developer plan).
// About 53 KB a call against 950 KB for 100 full transactions, and it can filter to one coin or read oldest first.
const isSolMint = (m) => typeof m === "string" && m.startsWith("So1111111111111111111111111111111111111111");
async function transfersOf(wallet, opts = {}) {
  const r = await rpc("getTransfersByAddress", [wallet, { limit: 100, ...opts }]);
  const rows = r?.data || [];
  return { rows, complete: rows.length < 100 };
}
/** who first sent SOL to a wallet, from its oldest transfers (one light call) */
async function firstFunder(wallet) {
  const { rows } = await transfersOf(wallet, { sortOrder: "asc", limit: 10 });
  const r = rows.find((x) => isSolMint(x.mint) && x.toUserAccount === wallet && x.fromUserAccount && x.fromUserAccount !== wallet);
  return r ? { funder: r.fromUserAccount, sol: Number(r.uiAmount) || null, at: (r.blockTime || 0) * 1000 } : { funder: null };
}
/** links from each top holder's transfers: SOL moved between holders or through one quiet wallet (plain transfers only,
 *  never the SOL legs of a swap), and this coin moved straight between two wallets. A wallet whose last 100 transfers
 *  are its whole history also gives its first funder. A busy wallet's 100 newest transfers may not reach this coin,
 *  so those get one more call filtered to the coin. */
async function transferLinks({ holders, mint, max = 12, wantFunder = new Set() }) {
  const people = holders.filter((h) => h.wallet).slice(0, max);
  const set = new Set(people.map((h) => h.owner));
  const edges = [], funders = new Map();
  const read = await pool(people, 8, async (h) => {
    const { rows, complete } = await transfersOf(h.owner);
    // a transaction that moved any token is a swap (or an airdrop): its SOL legs are fees and pool deposits, not links
    const tokenSigs = new Set(rows.filter((r) => !isSolMint(r.mint)).map((r) => r.signature));
    for (const r of rows) {
      if (!isSolMint(r.mint) || tokenSigs.has(r.signature) || Number(r.uiAmount) < 0.001) continue;
      const other = r.fromUserAccount === h.owner ? r.toUserAccount : r.toUserAccount === h.owner ? r.fromUserAccount : null;
      if (other && other !== h.owner && isWallet(other)) edges.push({ a: other, b: h.owner, how: set.has(other) ? "sent SOL to each other" : "moved SOL with the same private wallet", sig: r.signature });
    }
    // a busy holder: its coin history and its first funder, both at once (its 100 newest transfers don't reach them)
    const [coinRows, fundedBy] = await Promise.all([
      !complete && mint ? transfersOf(h.owner, { mint }).then((x) => x.rows) : Promise.resolve(rows.filter((r) => r.mint === mint)),
      // an active wallet (100+ transfers) is old: its first funder is nearly always an exchange, which links nobody
      // (on $QORB and $WLFI every one was), so it gets no funder call
      Promise.resolve(null),
    ]);
    if (fundedBy) { funders.set(h.owner, fundedBy); if (fundedBy.funder) busyOne(fundedBy.funder); }
    for (const r of coinRows) {
      const from = r.fromUserAccount, to = r.toUserAccount;
      if (!from || !to || from === to || !isWallet(from) || !isWallet(to) || (from !== h.owner && to !== h.owner)) continue; // pool vaults belong to programs
      edges.push({ a: from, b: to, how: "sent it tokens", sig: r.signature });
    }
    if (complete) {
      const first = [...rows].reverse().find((x) => isSolMint(x.mint) && x.toUserAccount === h.owner && x.fromUserAccount && x.fromUserAccount !== h.owner);
      funders.set(h.owner, first ? { funder: first.fromUserAccount, sol: Number(first.uiAmount) || null, at: (first.blockTime || 0) * 1000 } : { funder: null });
      if (first) busyOne(first.fromUserAccount); // its busy check starts now, not after every holder is read
    }
    return true;
  });
  const failed = read.find((x) => x && x.error);
  if (failed && !read.some((x) => x === true)) throw new Error(failed.error);
  return { edges, funders, read: read.filter((x) => x === true).length };
}

/** linked wallets: a shared first funder (or the dev as funder), plus proof links between holders (tokens sent between
 *  them, one paying for another's buy, buys in the same transaction). Groups are joined across all of these. */
async function clusters({ holders, supply, devWallets, early, mint }) {
  holders = holders.filter((h) => !h.active); // exchanges and bots aren't anyone's second wallet
  const people = holders.filter((h) => h.wallet);
  const top10 = people.slice(0, 10);
  const pctOf = new Map(people.map((h) => [h.owner, h.pct || 0]));
  const W = [...new Set([...top10.map((h) => h.owner), ...early.slice(0, 12), ...devWallets])].slice(0, 26);
  const top12 = new Set(people.slice(0, 12).map((h) => h.owner));
  let proof, fund;
  try {
    // fast path: one light getTransfersByAddress per top holder gives its SOL moves, its moves of this coin and (when
    // that's its whole history) its first funder. Only the gaps get a second call.
    const fundOne = async (w) => { const f = await firstFunder(w); if (f.funder) busyOne(f.funder); return { wallet: w, ...f }; };
    const [tr, fundOthers] = await Promise.all([
      transferLinks({ holders, mint, wantFunder: new Set(W.filter((w) => top12.has(w))) }),
      pool(W.filter((w) => !top12.has(w)), 8, fundOne),
    ]);
    fund = [...fundOthers, ...W.filter((w) => tr.funders.has(w)).map((w) => ({ wallet: w, ...tr.funders.get(w) }))];
    proof = { edges: tr.edges, read: tr.read };
    if (fund.some((f) => /getTransfersByAddress/.test(f.error || ""))) throw new Error("transfers unavailable");
  } catch (e) {
    // getTransfersByAddress needs Helius's Developer plan: on a free key, the full transaction histories instead
    const fundOne = async (w) => ({ wallet: w, ...(await funderOf(w)) });
    const [tok, sol, fundOthers] = await Promise.all([
      mint ? proofLinks({ holders, mint }).catch((x) => ({ edges: [], error: x.message })) : Promise.resolve({ edges: [], error: "no mint" }),
      solLinks({ holders }).catch((x) => ({ edges: [], funders: new Map(), error: x.message })),
      pool(W.filter((w) => !top12.has(w)), 8, fundOne),
    ]);
    const fundRest = await pool(W.filter((w) => top12.has(w) && !sol.funders.has(w)), 8, fundOne);
    fund = [...fundOthers, ...fundRest, ...W.filter((w) => sol.funders.has(w)).map((w) => ({ wallet: w, ...sol.funders.get(w) }))];
    proof = { edges: [...tok.edges, ...sol.edges], read: tok.read, error: [`fast path failed (${e.message})`, tok.error, sol.error].filter(Boolean).join("; ") };
  }
  const devs = new Set(devWallets);
  const holderSet = new Set(people.map((h) => h.owner));
  const inSet = new Set([...W, ...holderSet]);
  // hubs: outside wallets touching 2+ holders through the proof links
  const hubOf = new Map(); // outside wallet -> the holders it touches
  for (const e of proof.edges) for (const [o, h] of [[e.a, e.b], [e.b, e.a]]) if (!inSet.has(o) && holderSet.has(h)) (hubOf.get(o) || hubOf.set(o, new Set()).get(o)).add(h);
  const hubs = [...hubOf].filter(([, hs]) => hs.size >= 2).map(([o]) => o);
  // one busy check for every funder and hub (cached across coins): a busy wallet is shared by thousands of strangers
  const busy = await busyWallets([...fund.map((f) => f.funder).filter(Boolean), ...hubs]);

  // union-find over wallets; each union remembers how it was proven
  const parent = new Map(), how = new Map(), sigs = new Map();
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  // two wallets already in one group can be joined again (big coins have many links between the same wallets): merge
  // the other group's labels and proofs only when it really is another group, or the proof list doubles every time
  // (2026-11-05: "Invalid array length" on every coin over $10M)
  const join = (a, b, label, sig) => {
    const ra = find(a), rb = find(b), merge = ra !== rb;
    if (merge) parent.set(rb, ra);
    how.set(ra, new Set([...(how.get(ra) || []), ...(merge ? how.get(rb) || [] : []), label]));
    sigs.set(ra, [...new Set([...(sigs.get(ra) || []), ...(merge ? sigs.get(rb) || [] : []), ...(sig ? [sig] : [])])].slice(0, 6));
    if (merge) { how.delete(rb); sigs.delete(rb); }
  };
  for (const f of fund) {
    if (!f.funder || f.error || busy.get(f.funder)) continue;
    join(f.funder, f.wallet, devs.has(f.funder) ? "funded by the dev" : inSet.has(f.funder) ? "one funded the other" : "same first funder");
  }
  // a proof edge counts when both ends are in the set, or when an outside wallet (a hub, on either side of the
  // edges) ties 2+ holders together. A hub with 1,000+ transactions is a trading bot's fee payer or a router (seen
  // 2026-11-05: one paid the fees for 8 unrelated top holders of $WLFI, 1,000 transactions in minutes): never a link.
  const isHub = (o) => hubOf.get(o)?.size >= 2 && busy.get(o) === false;
  let proofEdges = 0;
  for (const e of proof.edges) {
    const ok = (inSet.has(e.a) && inSet.has(e.b)) || (inSet.has(e.b) && isHub(e.a)) || (inSet.has(e.a) && isHub(e.b));
    if (!ok || e.a === e.b) continue;
    join(e.a, e.b, devs.has(e.a) || devs.has(e.b) ? `the dev ${e.how === "sent it tokens" ? "sent it tokens" : e.how === "paid for its trades" ? "paid for its trades" : "bought in the same transaction"}` : e.how, e.sig);
    proofEdges++;
  }
  // the groups: the wallets that matter (holders, launch buyers, the dev) under each root
  const comp = new Map();
  for (const w of parent.keys()) if (inSet.has(w)) { const r = find(w); (comp.get(r) || comp.set(r, []).get(r)).push(w); }
  const top10Set = new Set(top10.map((h) => h.owner));
  const top10Pct = top10.reduce((s, h) => s + (h.pct || 0), 0);
  const out = [...comp.entries()].map(([r, ws]) => {
    const byDev = ws.some((w) => devs.has(w)) || [...(how.get(r) || [])].some((h) => /the dev/.test(h));
    const members = [...new Set(ws.filter((w) => !devs.has(w)))];
    const hows = [...(how.get(r) || [])];
    // the funder, when the group was joined by one (kept for the older receipts)
    const funder = fund.find((f) => members.includes(f.wallet) && f.funder && !busy.get(f.funder))?.funder || null;
    return { funder, fundedByDev: byDev, wallets: members, inTop10: members.filter((w) => top10Set.has(w)).length, holdsPct: round(members.reduce((s, w) => s + (pctOf.get(w) || 0), 0)),
      how: hows, proof: [...new Set(sigs.get(r) || [])].slice(0, 2) };
  }).filter((c) => c.wallets.length >= 2 || (c.fundedByDev && c.wallets.length >= 1)).sort((a, b) => b.holdsPct - a.holdsPct);
  const clusterTop10Pct = out.reduce((s, c) => s + c.wallets.filter((w) => top10Set.has(w)).reduce((x, w) => x + (pctOf.get(w) || 0), 0), 0);
  return {
    checked: fund.length, unreadable: fund.filter((f) => f.error).length, viaExchange: fund.filter((f) => busy.get(f.funder)).length,
    proofRead: proof.read ?? 0, proofEdges, proofError: proof.error || undefined,
    clusters: out.slice(0, 5), clusteredHoldPct: round(out.reduce((s, c) => s + c.holdsPct, 0)),
    shareOfTop10Pct: top10Pct ? round((clusterTop10Pct / top10Pct) * 100, 0) : null,
  };
}

const HOW = {
  "same first funder": "were first funded by the same wallet", "one funded the other": "funded each other", "funded by the dev": "were funded by the dev",
  "sent it tokens": "sent tokens to each other", "bought in the same transaction": "bought in the same transactions", "paid for its trades": "paid each other's fees",
  "sent SOL to each other": "sent SOL to each other", "moved SOL with the same private wallet": "moved SOL through the same private wallet",
  "the dev sent it tokens": "got tokens from the dev", "the dev paid for its trades": "had their fees paid by the dev", "the dev bought in the same transaction": "bought in the same transaction as the dev",
};
/** how a linked group was proven, in plain words: "moved SOL through the same private wallet" */
const linkWays = (c) => [...new Set((c.how || ["same first funder"]).map((h) => HOW[h] || h))].slice(0, 2).join(" and ");
/** "3 wallets that moved SOL through the same private wallet" */
function linkPhrase(c) {
  return `${c.wallets.length} wallet${c.wallets.length === 1 ? "" : "s"} that ${linkWays(c)}`;
}
/** the evidence line for a linked group: the transaction that proves it, when there is one */
const linkEvidence = (c) => (c.proof?.length ? `transaction ${c.proof[0].slice(0, 8)}... (Helius)` : "first funders (Helius)");

/** what one past coin's dev did: sold how much how soon after launch (from the dev's own token account) */
async function devExitOn(dev, mint) {
  const info = (await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]))?.value;
  if (!info?.data?.parsed?.info) return null;
  const supply = Number(info.data.parsed.info.supply) / 10 ** info.data.parsed.info.decimals;
  const ata = PublicKey.findProgramAddressSync([new PublicKey(dev).toBuffer(), new PublicKey(info.owner).toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0].toBase58();
  const res = await rpc("getTransactionsForAddress", [ata, { transactionDetails: "full", sortOrder: "asc", limit: 100, maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }]);
  const txs = res?.data || [];
  const t0 = (txs[0]?.blockTime || 0) * 1000;
  let bought = 0, sold = 0, firstSellAt = null;
  for (const tx of txs) for (const t of tradesOf(tx, mint)) {
    if (t.wallet !== dev) continue;
    if (t.side === "buy") bought += t.tokens; else { sold += t.tokens; firstSellAt = firstSellAt ?? t.at; }
  }
  return { boughtPct: round((bought / supply) * 100), soldPct: round((sold / supply) * 100), soldWithinMin: firstSellAt && t0 ? Math.round((firstSellAt - t0) / 60000) : null };
}

/** the dev wallets' other pump.fun coins and how they ended */
async function devHistory(fetcher, devWallets, thisMint) {
  if (!fetcher) return { unknown: "pump.fun's list of a wallet's coins only answers inside the app" };
  const lists = await Promise.all(devWallets.map((w) => pumpfun.createdBy(fetcher, w, 50).then((l) => l.map((c) => ({ ...c, dev: w }))).catch(() => null)));
  if (lists.every((l) => l === null)) return { unknown: "pump.fun didn't answer" };
  const others = lists.flat().filter((c) => c && c.mint !== thisMint);
  const total = lists.reduce((s, l) => s + (l ? Math.max(0, (l.total ?? l.length) - (l.some((c) => c.mint === thisMint) ? 1 : 0)) : 0), 0);
  const capped = total > others.length;
  const details = (await pool(others.slice(0, 40), 6, (c) => pumpfun.coin(fetcher, c.mint).then((d) => ({ ...c, ...d })))).filter((d) => d && !d.error && d.createdAt);
  details.sort((a, b) => b.createdAt - a.createdAt);
  const now = Date.now();
  // how the most recent ones ended: the dev's own sells decide "rugged"
  const recent = details.slice(0, 6);
  await pool(recent.filter((c) => !c.complete), 3, async (c) => { c.exit = await devExitOn(c.dev, c.mint).catch(() => null); });
  for (const c of details) {
    const fell = c.athMcUsd && c.mcUsd != null ? c.mcUsd / c.athMcUsd : null;
    // bonded and then faded to nothing is dead, not a success (2026-11-05: $MOODENG's dev had 21 "bonded" coins, all
    // now worth $3k to $6k)
    if (c.complete && c.mcUsd != null && c.mcUsd < 10_000) c.ended = "dead";
    else if (c.complete) c.ended = "bonded";
    // a rug is the dev dumping a real share (10%+ of the supply) early. A tweet deployer selling a small dev buy fast and
    // moving on is how those coins work, not a rug (2026-11-06): that coin just faded
    else if (c.exit && c.exit.soldPct >= 10 && c.exit.soldWithinMin != null && c.exit.soldWithinMin <= 180 && (fell == null || fell < 0.4 || c.mcUsd < 10_000)) c.ended = "rugged";
    else if (c.mcUsd != null && c.mcUsd < 8_000 && (!c.lastTradeAt || now - c.lastTradeAt > 12 * 36e5)) c.ended = "dead";
    else if (c.exit === undefined && c.mcUsd != null && c.mcUsd < 8_000) c.ended = "dead";
    else c.ended = "alive";
  }
  const count = (k) => details.filter((c) => c.ended === k).length;
  const last30 = details.filter((c) => now - c.createdAt < 30 * 864e5).length;
  return {
    otherCoins: total, capped, read: details.length, last30Days: last30,
    bonded: count("bonded"), rugged: count("rugged"), dead: count("dead"), alive: count("alive"),
    serialLauncher: total >= 5 || last30 >= 3,
    examples: details.slice(0, 4).map((c) => `$${c.symbol} ${c.ended}${c.exit?.soldWithinMin != null && c.ended === "rugged" ? ` (dev sold ${c.exit.soldPct}% ${c.exit.soldWithinMin} min after launch)` : ""}, ath ${c.athMcUsd ? `$${Math.round(c.athMcUsd / 1000)}k` : "?"}`),
  };
}

module.exports = { launch, clusters, proofLinks, solLinks, busyWallets, activeWallets, linkPhrase, linkWays, linkEvidence, devHistory, funderOf, tradesOf, short };
