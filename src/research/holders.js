// The holder stamp: is the coin fair for someone buying it NOW? A separate question from whether its story is real.
// Traders read the two apart, so pillbud stamps both on every coin.
//   fair       spread over a real base of holders, trading a while, nothing left that can change the coin under you
//   too early  too new or too few holders to say much yet, and nothing in them that warns a buyer
//   sketchy    something a buyer should know: the dev holding a real share, a linked group, launch buyers still in,
//              one big wallet, a dev with a bad record
//   rigged     a few wallets control the supply and can sell on everyone else when they choose, or the creator can
//              still freeze or mint. It says who has control, not that the price will fall.
// Decided here in code from on-chain facts: a score out of 100, a short tag ("insiders hold 26%"), the findings with
// the evidence behind each, how far the price would fall if the riskiest group sold at once, and what would change
// the stamp. A check that couldn't run is listed as not checked, never as clean.
const { PublicKey } = require("@solana/web3.js");
const { rpc } = require("./net");
const { linkWays, linkEvidence } = require("./trench");

const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ataOf = (owner, mint, program) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], ATA)[0].toBase58();
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const pctTxt = (x) => `${x >= 10 ? Math.round(x) : r1(x)}%`;
const short = (a) => (a ? `${a.slice(0, 4)}...${a.slice(-4)}` : null);
const devWalletsOf = (f) => (f.dev ? [f.dev, ...(f.dev.others || [])].map((d) => d.wallet).filter(Boolean) : []);

/** what a list of wallets holds of the coin right now, from their token accounts (one call per 100 wallets).
 *  Tokens moved to a second, non-standard account aren't seen, so this can only undercount. */
async function holdingsOf(wallets, mint, program) {
  const ws = [...new Set(wallets)].filter(Boolean).slice(0, 100);
  const out = new Map();
  if (!ws.length) return out;
  const r = await rpc("getMultipleAccounts", [ws.map((w) => ataOf(w, mint, program)), { encoding: "jsonParsed" }]);
  ws.forEach((w, i) => out.set(w, Number(r?.value?.[i]?.data?.parsed?.info?.tokenAmount?.uiAmountString || 0)));
  return out;
}

/** how many wallets hold the coin (Helius DAS getTokenAccounts, 1,000 per page, up to `pages` pages) */
async function holderCount(mint, pages = 3) {
  let n = 0;
  for (let page = 1; page <= pages; page++) {
    const r = await rpc("getTokenAccounts", { mint, page, limit: 1000 });
    const list = r?.token_accounts || [];
    n += list.filter((a) => Number(a.amount) > 0).length;
    if (list.length < 1000) return { count: n, capped: false };
  }
  return { count: n, capped: true };
}

/** the launch buyers (the launch slot and the 3 after it, not the dev) and what they still hold now */
async function earlyNow(f) {
  const L = f.launch;
  if (!L || L.unknown) return null;
  const devs = new Set(devWalletsOf(f));
  const wallets = [...new Set([...L.bundle.wallets, ...L.snipers.wallets])].filter((w) => !devs.has(w));
  const took = r1(L.bundle.pct + L.snipers.pct);
  if (!wallets.length) return { wallets: 0, tookPct: took, nowPct: 0, stillIn: 0, perWallet: {} };
  const held = await holdingsOf(wallets, f.mint, f.mintInfo.program);
  const supply = f.mintInfo.supply;
  const perWallet = Object.fromEntries([...held].map(([w, t]) => [w, (t / supply) * 100]));
  const nowPct = Object.values(perWallet).reduce((s, p) => s + p, 0);
  return { wallets: wallets.length, tookPct: took, nowPct: r1(nowPct), stillIn: Object.values(perWallet).filter((p) => p >= 0.05).length, perWallet };
}

/** how far the price falls, in %, if `pct` of the supply is sold at once. Constant product (x*y=k) on the pump.fun
 *  curve's virtual reserves before it bonds, on the pool's token reserve after (DexScreener liquidity.base). */
function sellImpact(f, pct) {
  if (!pct || !f.mintInfo?.supply) return null;
  const tokens = (pct / 100) * f.mintInfo.supply;
  const R = f.pump && !f.pump.bonded ? f.pump.vTokens : f.market?.liquidityBase;
  if (!R || R <= 0) return null;
  return Math.round((1 - (R / (R + tokens)) ** 2) * 100);
}

/** the stamp, from whatever has been read so far (holders first; launch buyers, linked wallets and the dev's record
 *  sharpen it as they arrive) */
function stamp(f) {
  if (!f?.holders) return { word: "unknown", score: null, tag: "couldn't read the holders", line: "couldn't read who holds it right now", findings: [], notChecked: ["holders"] };
  const devs = devWalletsOf(f), devSet = new Set(devs);
  const people = f.holders.filter((h) => h.wallet && !h.active);
  const act = f.holders.filter((h) => h.active), actPct = act.reduce((s, h) => s + (h.pct || 0), 0);
  const young = f.ageMin != null && f.ageMin < 3 * 1440;
  const pctOf = new Map(people.map((h) => [h.owner, h.pct || 0]));
  const top10 = people.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
  const devList = f.dev ? [f.dev, ...(f.dev.others || [])] : [];
  const devRead = devList.filter((d) => !d.unknown);
  const devHolds = devRead.length ? devRead.reduce((s, d) => s + (d.holdsPct || 0), 0) : null;
  const E = f.early && !f.early.unknown ? f.early : null;
  const earlySet = new Set(Object.keys(E?.perWallet || {}));
  const cl = f.clusters || f.legit?.checks?.clusters, clOk = cl && !cl.unknown;
  const dh = f.legit?.checks?.devHistory;
  // wallets the dev funded, not the dev's own and not already counted as launch buyers
  const devFunded = clOk ? [...new Set(cl.clusters.filter((c) => c.fundedByDev).flatMap((c) => c.wallets))].filter((w) => !devSet.has(w) && !earlySet.has(w)) : [];
  const devFundedPct = devFunded.reduce((s, w) => s + (pctOf.get(w) || 0), 0);
  const insiders = (devHolds || 0) + (E?.nowPct || 0) + devFundedPct;
  const linked = clOk ? cl.clusters.filter((c) => !c.fundedByDev).sort((a, b) => b.holdsPct - a.holdsPct)[0] : null;
  const whale = people.find((h) => !devSet.has(h.owner));
  const mi = f.mintInfo || {};

  const F = [];
  // each finding: a level, a title (the claim in a few words), a detail (the specifics), the evidence, points off the
  // score, the stamp's short tag and the share it covers (for the sell impact). text = the whole sentence, for the model.
  const add = (level, title, detail, evidence, pts = 0, tag = null, pct = null) => F.push({ level, title, detail, text: detail ? `${title}: ${detail}` : title, evidence, pts, tag, pct });
  const evIns = ["the dev's token account", E ? "launch buyers' token accounts" : null, devFunded.length ? "first funders" : null].filter(Boolean).join(", ") + " (Helius)";
  if (mi.freezeAuthority) add("rigged", "Can be frozen", "its creator can still freeze tokens in any wallet, so a sale can be blocked", "the mint account (Helius)", 60, "can be frozen");
  if (mi.mintAuthority) add("rigged", "Creator can mint more", "new tokens can still be created", "the mint account (Helius)", 50, "can mint more");
  const parts = [devHolds >= 0.5 ? `the dev ${pctTxt(devHolds)}` : null, E?.nowPct >= 0.5 ? `${E.stillIn} launch buyers ${pctTxt(E.nowPct)}` : null, devFundedPct >= 0.5 ? `${devFunded.length} wallets the dev funded ${pctTxt(devFundedPct)}` : null].filter(Boolean);
  if (insiders >= 30) add("rigged", `Insiders hold ${pctTxt(insiders)}`, parts.join(", "), evIns, 50, `insiders hold ${pctTxt(insiders)}`, insiders);
  else if (insiders >= 10) add("sketchy", `Insiders hold ${pctTxt(insiders)}`, parts.join(", "), evIns, 25, `insiders hold ${pctTxt(insiders)}`, insiders);
  else if (devHolds >= 4) add("sketchy", `The dev holds ${pctTxt(devHolds)}`, "still in the dev's wallet", "the dev's token account (Helius)", 12, `dev holds ${pctTxt(devHolds)}`, devHolds);
  else if (E?.nowPct >= 5) add("sketchy", `Launch buyers hold ${pctTxt(E.nowPct)}`, `${E.stillIn} wallets from the first slots are still in`, "launch buyers' token accounts (Helius)", 12, `snipers hold ${pctTxt(E.nowPct)}`, E.nowPct);
  const lw = linked ? `they ${linkWays(linked)}` : null;
  if (linked && linked.holdsPct >= 20) add("rigged", `${linked.wallets.length} linked wallets hold ${pctTxt(linked.holdsPct)}`, lw, linkEvidence(linked), 45, `${linked.wallets.length} linked wallets hold ${pctTxt(linked.holdsPct)}`, linked.holdsPct);
  else if (linked && linked.holdsPct >= 5) add("sketchy", `${linked.wallets.length} linked wallets hold ${pctTxt(linked.holdsPct)}`, lw, linkEvidence(linked), 18, `linked wallets hold ${pctTxt(linked.holdsPct)}`, linked.holdsPct);
  else if (linked && linked.holdsPct >= 2) add("info", `${linked.wallets.length} linked wallets hold ${pctTxt(linked.holdsPct)}`, lw, linkEvidence(linked), 4, null, linked.holdsPct);
  if (whale && whale.pct >= 20) add("rigged", `One wallet holds ${pctTxt(whale.pct)}`, short(whale.owner), "top holders (Helius)", 40, `one wallet holds ${pctTxt(whale.pct)}`, whale.pct);
  else if (whale && whale.pct >= 8) add("sketchy", `One wallet holds ${pctTxt(whale.pct)}`, short(whale.owner), "top holders (Helius)", 15, `one wallet holds ${pctTxt(whale.pct)}`, whale.pct);
  // exchanges hold for their users; very active unnamed wallets are exchanges, market makers or bots (on a coin only
  // days old, bots holding a share). Neither is one holder, so they're named here and left out of the whale numbers.
  if (actPct >= 1) {
    const by = new Map();
    for (const h of act) { const k = h.label || "a very active wallet"; by.set(k, (by.get(k) || 0) + (h.pct || 0)); }
    const list = [...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pctTxt(v)}`).join(", ");
    const exPct = act.filter((h) => h.exchange).reduce((s, h) => s + (h.pct || 0), 0);
    const bots = young && actPct - exPct >= 8;
    add(bots ? "sketchy" : "info", bots ? `Trading bots hold ${pctTxt(actPct - exPct)}` : exPct >= actPct / 2 ? `Exchanges hold ${pctTxt(actPct)}` : `Very active wallets hold ${pctTxt(actPct)}`,
      `${list}: held for many users or traded all day, so not counted as one holder`, "exchange labels (Solscan) + wallet activity (Helius)",
      bots ? 12 : 0, bots ? `bots hold ${pctTxt(actPct - exPct)}` : null, bots ? actPct - exPct : null);
  }
  if (top10 >= 60) add("rigged", `The top 10 hold ${pctTxt(top10)}`, null, "top holders (Helius)", 35, `top 10 hold ${pctTxt(top10)}`, top10);
  else if (top10 >= 40) add("sketchy", `The top 10 hold ${pctTxt(top10)}`, null, "top holders (Helius)", 12, `top 10 hold ${pctTxt(top10)}`, top10);
  if (f.fresh?.freshPct >= 20) add("sketchy", `New wallets hold ${pctTxt(f.fresh.freshPct)}`, `${f.fresh.fresh} of the top ${f.fresh.checked} are under 3 days old`, "wallet ages (Helius)", 12, `fresh wallets hold ${pctTxt(f.fresh.freshPct)}`, f.fresh.freshPct);
  if (dh && !dh.unknown && dh.rugged >= 3) add("sketchy", "The dev has rugged before", `${dh.rugged} of the ${dh.read} earlier coins read`, "pump.fun + Helius", 15, "serial rugger dev");
  // the good news and the plain facts
  if (E && E.tookPct >= 5 && E.nowPct < 2) add("ok", "Launch buyers already sold", `they took ${pctTxt(E.tookPct)}, so nothing is waiting to dump`, "launch buyers' token accounts (Helius)");
  const d = f.dev;
  if (d && !d.unknown && d.sold && d.boughtPct > 0) add("info", "The dev sold its launch buy", `${d.holdsPct < 0.05 ? "all of" : `${pctTxt(d.soldPct)} of`} its ${pctTxt(d.boughtPct)}`, "the dev's token account (Helius)");
  if (!mi.mintAuthority && !mi.freezeAuthority) add("ok", "Can't be minted or frozen", "mint and freeze authority are given up", "the mint account (Helius)");
  if (f.holderCount) add("info", `${f.holderCount.count.toLocaleString("en-US")}${f.holderCount.capped ? "+" : ""} holders`, null, "token accounts (Helius)");

  // dumped: the launch buyers and the dev already sold into it and the price collapsed, on a coin under a week old.
  // Nothing left in who holds it to warn about, but "too early" or "fair" would read as a green light (seen 2026-11-05
  // on $PEERLY, $LEVERAGED, $UMBRA)
  const peak = f.pumpApi?.athMcUsd, nowMc = f.market?.mcUsd || f.pump?.mcUsd || f.pumpApi?.usdMarketCap;
  const fell = peak && nowMc ? 1 - nowMc / peak : null;
  const insidersSold = Math.max(0, (E?.tookPct || 0) - (E?.nowPct || 0)) + (d && !d.unknown && d.sold ? Math.max(0, (d.boughtPct || 0) - (d.holdsPct || 0)) : 0);
  const dumped = fell != null && fell >= 0.7 && insidersSold >= 10 && f.ageMin != null && f.ageMin < 7 * 1440;
  if (dumped) { const i = F.findIndex((x) => x.title === "Launch buyers already sold"); if (i >= 0) F.splice(i, 1); } // not good news on a dumped coin
  if (dumped) add("sketchy", `Insiders already sold ${pctTxt(insidersSold)}`, `the price is ${Math.round(fell * 100)}% below its peak`, "launch buyers' and the dev's token accounts (Helius) + pump.fun", 20, `insiders sold, ${Math.round(fell * 100)}% off its peak`, null);

  const notChecked = [!E ? "launch buyers" : null, !clOk ? "linked wallets" : null, !f.holderCount ? "holder count" : null, devList.length && !devRead.length ? "the dev's wallet" : null].filter(Boolean);
  const has = (lv) => F.some((x) => x.level === lv);
  // under 200 holders is too thin to call fair
  const tooEarly = (f.ageMin != null && f.ageMin < 20) || (f.holderCount && !f.holderCount.capped && f.holderCount.count < 200);
  const word = has("rigged") ? "rigged" : dumped ? "dumped" : has("sketchy") ? "sketchy" : tooEarly ? "too early" : "fair";
  const band = { rigged: [0, 35], dumped: [10, 35], sketchy: [30, 65], "too early": [35, 65], fair: [60, 100] }[word];
  const score = Math.max(band[0], Math.min(band[1], 85 - F.reduce((s, x) => s + x.pts, 0)));
  const rank = { rigged: 0, sketchy: 1, info: 2, ok: 3 };
  F.sort((a, b) => rank[a.level] - rank[b.level] || b.pts - a.pts);
  const worst = (dumped && !has("rigged") && F.find((x) => /^Insiders already sold/.test(x.title))) || F.find((x) => x.level === "rigged" || x.level === "sketchy");
  const impact = worst?.pct ? sellImpact(f, worst.pct) : null;
  const soldOn = E && E.tookPct >= 5 && E.nowPct < 2;
  return {
    word, score,
    tag: worst?.tag || (word === "too early" ? "too new to say" : "spread out"),
    line: word === "fair" ? `spread out: the top 10 hold ${pctTxt(top10)}${soldOn ? ", and the launch buyers already sold" : ""}`
      : word === "too early" ? `${f.ageMin != null && f.ageMin < 20 ? `only ${f.ageMin} minute${f.ageMin === 1 ? "" : "s"} old` : `only ${f.holderCount?.count ?? "a few"} holders so far`}, and nothing alarming in who holds it yet`
      : worst.text,
    impact: impact != null && impact >= 5 ? `selling that ${pctTxt(worst.pct)} at once would drop the price about ${impact}%` : null,
    wouldChange: !worst ? (word === "too early" ? "more holders and a few hours of trading" : "a new group of wallets buying up a big share")
      : /frozen/.test(worst.tag) ? "only the creator giving up the freeze authority"
      : /mint more/.test(worst.tag) ? "only the creator giving up the mint authority"
      : /serial/.test(worst.tag || "") ? "nothing about this coin itself: it's the dev's record"
      : word === "dumped" ? "new buyers bringing it back; the insiders are already out"
      : "those wallets selling down, or the supply spreading out",
    findings: F.map(({ level, title, detail, text, evidence }) => ({ level, title, detail, text, evidence })),
    notChecked, top10: r1(top10), insidersPct: r1(insiders),
  };
}

/** recompute the stamp onto the research object, and the compact version the answer model sees */
function refresh(f) {
  f.holderStamp = stamp(f);
  if (f.facts) f.facts.holderStamp = facts(f.holderStamp);
  return f.holderStamp;
}

function facts(s) {
  return {
    stamp: s.word, score: s.score == null ? "unknown" : `${s.score}/100`, why: s.line, ifTheySold: s.impact || undefined,
    findings: s.findings.map((x) => `${x.level}: ${x.text} [${x.evidence}]`),
    notCheckedYet: s.notChecked.length ? s.notChecked : undefined,
    note: "the holder stamp answers 'is it fair to buy now', separate from whether the coin's story is real",
  };
}

module.exports = { stamp, refresh, facts, earlyNow, holderCount, holdingsOf, sellImpact };
