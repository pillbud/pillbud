// Where the fees go. A coin that promises its creator fees go somewhere (buybacks, burns, charity, a giveaway, holder
// rewards, a treasury, "the dev won't take fees") gets that promise checked on-chain, in about a second.
//
// How pump.fun creator fees can be set up (read live 2026-11-05: the fee program's on-chain IDL, pump.fun's coin
// record, and three coins):
//   1. to the dev: they collect in the creator vault, PDA ["creator-vault", creator] on the pump program (native SOL),
//      and after bonding the WSOL account of PDA ["creator_vault", creator] on PumpSwap. Claiming always pays the
//      creator's wallet. The vault is the creator's, not the coin's: a dev with several coins has one pot.
//   2. split: a SharingConfig on the fee program pfeeUx… (PDA ["sharing-config", mint]) lists shareholders with basis
//      points. A shareholder can be a wallet, a pump.fun DonationFeePda (charity), a SocialFeePda (an X account) or a
//      BuybackVault. If its admin is revoked, the split can never change.
//   3. to holders: pump.fun's record says is_holder_reward (fees are paid out to holders).
//   4. cashback: is_cashback_enabled (fees go back to traders).
// Burns show in the supply: pump.fun coins start at exactly 1,000,000,000.
const { PublicKey } = require("@solana/web3.js");
const { rpc } = require("./net");

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PFEE = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM = "11111111111111111111111111111111";
const RENT_EMPTY = 890880; // lamports a 0-byte account keeps for rent
// account discriminators from the fee program's IDL (2026-11-05)
const KIND = { d84a0900388c5d4b: "config", "99a64790b3bd89fb": "buyback", f6c56009c11e5d73: "donation", "8b6035112aa9ce96": "social" };
const isSol = (m) => typeof m === "string" && m.startsWith("So1111111111111111111111111111111111111111");
const r2 = (x) => Math.round(x * 100) / 100;
const short = (a) => (a ? `${a.slice(0, 4)}...${a.slice(-4)}` : "?");
const isWallet = (a) => { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return false; } };

// ---------------------------------------------------------------- 1. what the coin promises about its fees
const NEEDS_FEES = /\bfees?\b|creator rewards|trading rewards|\bproceeds\b|\b100\s?%/i;
const CLAIMS = [
  ["buyback", /\b(buy ?backs?|buying back|bought back)\b/i],
  ["burn", /\bburn(s|ed|ing)?\b/i],
  ["charity", /\b(charit(y|ies)|donat(e|es|ed|ing|ion|ions)|non-?profit)\b/i],
  ["giveaway", /\b(give ?aways?|raffles?|prizes?)\b/i],
  ["rewards", /\b(rewards? (to |for )?holders|holder rewards|rev(enue)?[- ]?share|airdrops? (to|for) holders|distribut(e|ed|es|ion)\b.{0,30}holders|paid (out )?to holders|dividends?)\b/i],
  ["treasury", /\b(treasury|community wallet|dev ?fund)\b/i],
  ["no dev fees", /\b(no dev fees|dev (won'?t|will not|doesn'?t|does not) (take|claim|touch)|fees? (are |is )?(locked|renounced|burned)|zero dev fees)\b/i],
];
/** the fee promises in a coin's own words, with the sentence that makes each one */
function feeClaims(texts) {
  const text = texts.filter(Boolean).join(" \n ").replace(/\s+/g, " ");
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?])\s+|\n/);
  const out = [];
  for (const [kind, re] of CLAIMS) {
    const s = sentences.find((x) => re.test(x) && (kind === "no dev fees" || NEEDS_FEES.test(x)));
    if (s) out.push({ kind, quote: s.trim().slice(0, 160) });
  }
  return out;
}

// ---------------------------------------------------------------- 2. the setup and the money, on-chain
function vaultsOf(owner) {
  const c = new PublicKey(owner);
  const curve = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), c.toBuffer()], PUMP)[0];
  const ammAuth = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), c.toBuffer()], AMM)[0];
  const amm = PublicKey.findProgramAddressSync([ammAuth.toBuffer(), TOKEN.toBuffer(), WSOL.toBuffer()], ATA)[0];
  return { curve: curve.toBase58(), ammAuth: ammAuth.toBase58(), amm: amm.toBase58() };
}
async function waitingIn(owner) {
  const v = vaultsOf(owner);
  const [c, a] = await Promise.all([rpc("getAccountInfo", [v.curve, { encoding: "base64" }]).catch(() => null), rpc("getTokenAccountBalance", [v.amm]).catch(() => null)]);
  return { vaults: v, sol: r2((c?.value ? Math.max(0, c.value.lamports - RENT_EMPTY) / 1e9 : 0) + Number(a?.value?.uiAmountString || 0)) };
}
function decodeConfig(b) {
  let o = 10; const status = b[o++] === 1 ? "active" : "paused";
  const mint = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32;
  const admin = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32;
  const locked = b[o++] === 1;
  const n = b.readUInt32LE(o); o += 4;
  const shares = [];
  for (let i = 0; i < n && o + 34 <= b.length; i++) { shares.push({ address: new PublicKey(b.subarray(o, o + 32)).toBase58(), pct: b.readUInt16LE(o + 32) / 100 }); o += 34; }
  return { status, mint, admin, locked, shares };
}
/** what a shareholder address is, and what it has paid out so far */
function shareKind(address, acc, devs) {
  if (devs.has(address)) return { kind: "dev" };
  if (!acc) return isWallet(address) ? { kind: "wallet" } : { kind: "unknown" };
  const b = Buffer.from(acc.data[0], "base64");
  if (acc.owner === PFEE.toBase58()) {
    const k = KIND[b.subarray(0, 8).toString("hex")] || "pump.fun account";
    if (k === "donation") return { kind: "donation", paidSol: r2(Number(b.readBigUInt64LE(10 + 32 * 4)) / 1e9) };
    if (k === "buyback") return { kind: "buyback", paidSol: r2(Number(b.readBigUInt64LE(8 + 32)) / 1e9) };
    if (k === "social") { const len = b.readUInt32LE(10); return { kind: "social", user: b.subarray(14, 14 + len).toString(), platform: b[14 + len], paidSol: r2(Number(b.readBigUInt64LE(15 + len)) / 1e9) }; }
    return { kind: k };
  }
  return acc.owner === SYSTEM && isWallet(address) ? { kind: "wallet" } : { kind: "unknown" };
}

/** how this coin's fees are set up, what is waiting, and (when they go to the dev) what the dev did with them */
async function feeCheck({ mint, curveCreator, pf = {}, devWallets = [], supply, launchedAt }) {
  const devs = new Set(devWallets.filter(Boolean));
  const burnedPct = supply && supply < 1e9 ? r2(((1e9 - supply) / 1e9) * 100) : 0;
  if (pf.holderReward) return { mode: "holders", burnedPct };
  if (pf.cashback) return { mode: "cashback", burnedPct };
  if (!curveCreator) return { unknown: "no creator on the pump.fun curve" };
  const cfgAddr = PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), new PublicKey(mint).toBuffer()], PFEE)[0].toBase58();
  const cfgAcc = await rpc("getAccountInfo", [cfgAddr, { encoding: "base64" }]).catch(() => null);
  if (cfgAcc?.value && cfgAcc.value.owner === PFEE.toBase58()) {
    const cfg = decodeConfig(Buffer.from(cfgAcc.value.data[0], "base64"));
    const accs = await rpc("getMultipleAccounts", [cfg.shares.map((s) => s.address), { encoding: "base64" }]).catch(() => ({ value: [] }));
    const shares = cfg.shares.map((s, i) => ({ ...s, ...shareKind(s.address, accs.value?.[i], devs) }));
    const waiting = await waitingIn(cfgAddr);
    return { mode: "split", locked: cfg.locked, adminIsDev: devs.has(cfg.admin), paused: cfg.status === "paused", shares, waitingSol: waiting.sol, burnedPct };
  }
  if (!isWallet(curveCreator)) return { mode: "program", burnedPct, note: "the curve's creator is a program account pillbud can't read yet" };
  return { mode: "dev", ...(await devFlow({ mint, creator: curveCreator, launchedAt })), burnedPct };
}

/** fees that go to the dev: waiting, claimed, and where the claimed SOL went after the first claim */
async function devFlow({ mint, creator, launchedAt }) {
  const [waiting, page1] = await Promise.all([waitingIn(creator), rpc("getTransfersByAddress", [creator, { limit: 100 }])]);
  let rows = page1?.data || [];
  if (rows.length === 100 && page1?.paginationToken && (!launchedAt || rows[rows.length - 1].blockTime * 1000 > launchedAt)) {
    const p2 = await rpc("getTransfersByAddress", [creator, { limit: 100, paginationToken: page1.paginationToken }]).catch(() => null);
    rows = rows.concat(p2?.data || []);
  }
  const readBackToLaunch = rows.length < 100 || (launchedAt && rows[rows.length - 1].blockTime * 1000 <= launchedAt);
  const vaultSet = new Set(Object.values(waiting.vaults));
  const claims = rows.filter((t) => isSol(t.mint) && vaultSet.has(t.fromUserAccount) && t.toUserAccount === creator);
  const claimedSol = claims.reduce((s, t) => s + Number(t.uiAmount || 0), 0);
  const firstClaim = claims.length ? Math.min(...claims.map((t) => t.blockTime)) : null;
  const bySig = new Map();
  for (const t of rows) { if (firstClaim && t.blockTime < firstClaim) continue; (bySig.get(t.signature) || bySig.set(t.signature, []).get(t.signature)).push(t); }
  let buybackSol = 0, soldSol = 0;
  const sentTo = new Map();
  for (const [, ts] of bySig) {
    if (ts.some((t) => vaultSet.has(t.fromUserAccount))) continue; // the claim itself
    const sum = (f) => ts.filter(f).reduce((s, t) => s + Number(t.uiAmount || 0), 0);
    const solOut = sum((t) => isSol(t.mint) && t.fromUserAccount === creator), solIn = sum((t) => isSol(t.mint) && t.toUserAccount === creator);
    const coinIn = sum((t) => t.mint === mint && t.toUserAccount === creator), coinOut = sum((t) => t.mint === mint && t.fromUserAccount === creator);
    if (coinIn > 0 && solOut > 0) { buybackSol += solOut; continue; }
    if (coinOut > 0 && solIn > 0) { soldSol += solIn; continue; }
    if (coinIn || coinOut || ts.some((t) => !isSol(t.mint))) continue; // a token transfer, or a trade of something else
    for (const t of ts) if (isSol(t.mint) && t.fromUserAccount === creator && t.toUserAccount !== creator && isWallet(t.toUserAccount) && Number(t.uiAmount) >= 0.01) sentTo.set(t.toUserAccount, (sentTo.get(t.toUserAccount) || 0) + Number(t.uiAmount));
  }
  const sent = [...sentTo].sort((a, b) => b[1] - a[1]);
  return {
    creator, waitingSol: waiting.sol, claimedSol: r2(claimedSol), claims: claims.length, readBackToLaunch: !!readBackToLaunch,
    after: { buybackSol: r2(buybackSol), soldSol: r2(soldSol), sentSol: r2(sent.reduce((s, [, x]) => s + x, 0)), wallets: sent.length, top: sent[0] ? { to: sent[0][0], sol: r2(sent[0][1]) } : null },
  };
}

// ---------------------------------------------------------------- 3. the promise against the setup and the money
const SHARE_NAME = { dev: "the dev", wallet: "a wallet", donation: "a pump.fun donation account", social: "an X account", buyback: "a buyback vault", unknown: "an address pillbud can't read", "pump.fun account": "a pump.fun account" };
function splitText(shares) {
  return shares.map((s) => `${s.pct}% to ${SHARE_NAME[s.kind] || s.kind}${s.kind === "wallet" ? ` (${short(s.address)})` : ""}`).join(", ");
}
/** the fee findings: one per promise, or one plain line about the setup when nothing is promised */
function judge(claims, F, { ticker, devCoins = 0 } = {}) {
  if (!F || F.unknown) return [];
  const T = ticker ? `$${ticker}` : "it";
  const out = [];
  const add = (level, title, detail, claim) => out.push({ level, title, detail, source: "pump.fun's fee setup + creator vault (Helius)", claim });
  const pct = (kind) => (F.shares || []).filter((s) => s.kind === kind).reduce((s, x) => s + x.pct, 0);
  const lockNote = F.mode === "split" ? (F.locked ? " The split is locked for good." : " Its admin can still change the split.") : "";
  const shareNote = devCoins > 0 ? ` (this vault also collects from ${devCoins} other coin${devCoins > 1 ? "s" : ""} by the dev)` : "";
  const c = F.claimedSol || 0, w = F.waitingSol || 0, A = F.after || {};

  // when the fees go to the dev, did the claimed SOL go where the promise says?
  const devPaid = (what, good) => {
    if (c < 0.05) return add("warn", `No fees claimed yet`, `it promises ${what}; ${w} SOL is still waiting in the dev's vault${F.readBackToLaunch ? "" : " (only the dev's latest 200 transfers were read)"}`);
    if (good >= 0.5 * c) return true;
    return false;
  };
  for (const cl of claims) {
    if (cl.kind === "burn") {
      if (F.burnedPct > 0.05) add("good", `${F.burnedPct}% of the supply is burned`, "read from the coin's supply, which started at 1 billion", cl.quote);
      else add(c >= 0.5 ? "bad" : "warn", "Nothing burned yet", `it promises burns, and the supply is still the full 1 billion`, cl.quote);
      continue;
    }
    if (F.mode === "holders") {
      if (cl.kind === "rewards" || cl.kind === "no dev fees") add("good", "pump.fun pays the fees to holders", "holder rewards are switched on for this coin, so the dev doesn't get them", cl.quote);
      else add("warn", "Fees go to holders, not as promised", `it promises ${cl.kind === "buyback" ? "buybacks" : cl.kind}, but pump.fun pays this coin's fees to its holders`, cl.quote);
      continue;
    }
    if (F.mode === "cashback") { add(cl.kind === "no dev fees" ? "good" : "warn", "Fees go back to traders", "pump.fun cashback is on for this coin, so fees return to the people trading it", cl.quote); continue; }
    if (F.mode === "split") {
      const want = { buyback: "buyback", charity: "donation", rewards: null, giveaway: null, treasury: null, "no dev fees": null }[cl.kind];
      const devPct = pct("dev");
      if (cl.kind === "no dev fees") { devPct > 0 ? add("bad", `The dev gets ${devPct}% of the fees`, `it says the dev won't take fees, but the split is ${splitText(F.shares)}.${lockNote}`, cl.quote) : add("good", "The dev gets none of the fees", `the split is ${splitText(F.shares)}.${lockNote}`, cl.quote); continue; }
      if (want && pct(want) >= 50) { const s = F.shares.find((x) => x.kind === want); add(F.locked ? "good" : "warn", `${pct(want)}% of the fees go to ${SHARE_NAME[want]}`, `set in pump.fun's own fee split${s?.paidSol ? `, ${s.paidSol} SOL paid out so far` : ", nothing paid out yet"}.${lockNote}`, cl.quote); continue; }
      const others = 100 - devPct;
      if (!want && others >= 50) { add(F.locked ? "good" : "warn", `${others}% of the fees go to other wallets`, `the split is ${splitText(F.shares)}. pillbud can't tell who owns them.${lockNote}`, cl.quote); continue; }
      add("bad", `No ${cl.kind === "buyback" ? "buyback" : cl.kind === "charity" ? "donation" : cl.kind} in the fee split`, `it promises ${cl.kind === "buyback" ? "buybacks" : `fees to ${cl.kind}`}, but the split is ${splitText(F.shares)}.${lockNote}`, cl.quote);
      continue;
    }
    if (F.mode === "dev") {
      if (cl.kind === "no dev fees") { c >= 0.05 ? add("bad", "The dev has claimed fees", `it says the dev won't take fees, but ${c} SOL went to the dev's wallet${shareNote}`, cl.quote) : add("good", "No fees claimed", `as promised, the dev hasn't claimed any; ${w} SOL is waiting`, cl.quote); continue; }
      if (cl.kind === "buyback") {
        const ok = devPaid("buybacks", A.buybackSol);
        if (ok === true) add("good", "Fees go to buybacks", `${A.buybackSol} of the ${c} SOL the dev claimed bought ${T} back${shareNote}`, cl.quote);
        else if (ok === false) add(A.buybackSol > 0 ? "warn" : "bad", A.buybackSol > 0 ? "Some fees go to buybacks" : "No buybacks seen", `the dev claimed ${c} SOL and spent ${A.buybackSol} buying ${T} back${A.sentSol ? `; ${A.sentSol} SOL went to other wallets` : ""}${shareNote}`, cl.quote);
        continue;
      }
      const what = { charity: "charity", giveaway: "a giveaway", rewards: "holders", treasury: "a treasury" }[cl.kind];
      const ok = devPaid(`fees to ${what}`, A.sentSol);
      if (ok === true) add("good", "Claimed fees were sent on", `${A.sentSol} of the ${c} SOL claimed went to ${A.wallets} wallet${A.wallets > 1 ? "s" : ""}, the most ${A.top.sol} SOL to ${short(A.top.to)}. pillbud can't tell who owns them${shareNote}`, cl.quote);
      else if (ok === false) add("bad", "The fees stayed with the dev", `it promises fees to ${what}, but of ${c} SOL claimed only ${A.sentSol} left the dev's wallet${A.soldSol ? `, and the dev sold ${A.soldSol} SOL of ${T}` : ""}${shareNote}`, cl.quote);
      continue;
    }
    add("info", "Fees go to a program account", "pillbud can't read this kind of fee setup yet", cl.quote);
  }
  // nothing promised: one plain line about the setup, when it's worth knowing
  if (!claims.length) {
    if (F.mode === "holders") add("good", "The fees are paid to holders", "pump.fun holder rewards are on for this coin");
    else if (F.mode === "cashback") add("info", "The fees go back to traders", "pump.fun cashback is on for this coin");
    else if (F.mode === "split" && F.shares.length) add("info", "The fees are split", `${splitText(F.shares)}.${lockNote}`);
    else if (F.mode === "dev" && c + w >= 0.5) add("info", `The dev has earned ${r2(c + w)} SOL in fees`, `${c} SOL claimed, ${w} SOL waiting${shareNote}`);
  }
  return out;
}

module.exports = { feeClaims, feeCheck, judge, vaultsOf, decodeConfig };
