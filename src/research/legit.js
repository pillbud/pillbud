// Legit or LARP, plus the trench checks. A LARP is a coin that pretends to be connected to a real person, brand,
// event or project. Each check returns facts with their source, or { unknown: why }. The verdict is decided here
// in code from those facts (the model only phrases it): "looks legit" | "unverified" | "likely LARP" | "copycat of <CA>".
const { rpc } = require("./net");
const pumpfun = require("./pumpfun");
const x = require("./x");
const site = require("./site");
const trench = require("./trench");
const { checkNarrative } = require("./narrative");
const { getJson } = require("./net");
const { money, ago } = require("./chart");

const short = (a) => (a ? `${a.slice(0, 4)}...${a.slice(-4)}` : null);
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
async function safe(name, p, ms, log) {
  const t0 = Date.now();
  try { const v = await timeout(p, ms, name); log(`legit: ${name} ${Date.now() - t0}ms`); return v; }
  catch (e) { log(`legit: ${name} unknown (${e.message})`); return { unknown: e.message }; }
}
// A coin is only a copycat of a coin it copies. A big established token that only shares the ticker is a different
// thing: "The WLFI Files" (a meme about a Coffeezilla video on WLFI) was called a copycat of World Liberty Financial's
// $1.2B $WLFI on 2026-11-05. Established = $25M+ market cap, or $1M+ and older than 180 days. Its name has to match
// (or contain it) for it to count as the original.
const normName = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function nameLike(a, b) {
  const x = normName(a), y = normName(b);
  if (x.length < 3 || y.length < 3) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return s.length >= 5 && l.includes(s) && s.length / l.length >= 0.6;
}
const isEstablished = (f) => (f.mcUsd || 0) >= 25e6 || ((f.mcUsd || 0) >= 1e6 && f.createdAt && Date.now() - f.createdAt > 180 * 864e5);
// Copycats chase a coin while it's hot: a coin that only shares the ticker (a different name, picture and source)
// counts as the original only if it launched in the 14 days before this one. "The WLFI Files" was next called a copy
// of a dead 2024 "World Liberty Financial" coin ($78 of daily volume): a different coin that happens to share a ticker.
const COPY_WINDOW = 14 * 864e5; // (kept for the read's notes; copycats are now decided by the story, below)
// The narrative is what counts (2026-11-05): coins share names, tickers and pictures all the time, and a reused
// picture is no red flag. A coin is a copycat only when an earlier coin on the same source (the same tweet, video or
// article) is bigger, or when it copies a big coin that already ran: a similar name or the same picture as a coin that
// reached $5M+ or is worth $1M+ now. Everything else that only shares a name, ticker or picture is counted, not judged.
const ranBig = (f) => (f.athMcUsd || 0) >= 5e6 || (f.mcUsd || 0) >= 1e6;
/** the one thing a link points at: an X post, a video, or an article path. A bare profile or a homepage isn't a story */
function storyId(u) {
  if (!u) return null;
  const s = String(u);
  const tw = /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i.exec(s); if (tw) return `x:${tw[1]}`;
  const yt = /(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i.exec(s); if (yt) return `yt:${yt[1]}`;
  const tt = /tiktok\.com\/@[^/]+\/video\/(\d+)/i.exec(s); if (tt) return `tt:${tt[1]}`;
  try {
    const url = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
    if (/(^|\.)(x|twitter|t|telegram|discord|instagram|youtube|tiktok|pump|dexscreener)\.(com|me|gg|fun)$/i.test(url.hostname)) return null;
    const path = url.pathname.replace(/\/+$/, "");
    return path.split("/").filter(Boolean).length >= 2 ? `web:${url.hostname.replace(/^www\./, "")}${path}`.toLowerCase() : null;
  } catch { return null; }
}

const cidOf = (u) => (/\/ipfs\/([^/?#]+)/.exec(u || "") || [])[1] || null; // the same image file = the same IPFS CID
const days = (t) => (t ? Math.round(((Date.now() - t) / 864e5) * 10) / 10 : null);

/** 1. what it claims: the launch metadata (IPFS) plus pump.fun's own record */
async function claims(mint, fetcher, pf, dexLinks = {}) {
  const asset = await rpc("getAsset", { id: mint }).catch(() => null);
  const uri = pf?.metadataUri || asset?.content?.json_uri;
  const meta = uri ? await pumpfun.metadata(uri).catch(() => null) : null;
  return {
    name: meta?.name?.trim() || pf?.name || asset?.content?.metadata?.name || null,
    ticker: meta?.symbol?.trim() || pf?.symbol || asset?.content?.metadata?.symbol || null,
    description: (meta?.description || asset?.content?.metadata?.description || "").trim().slice(0, 400) || null,
    image: meta?.image || pf?.image || null,
    // links: the launch metadata first, then pump.fun's record, then what the team added on DexScreener
    twitter: meta?.twitter || pf?.twitter || dexLinks.twitter || null, telegram: meta?.telegram || pf?.telegram || dexLinks.telegram || null, website: meta?.website || pf?.website || dexLinks.website || null,
    linksFrom: meta?.twitter || meta?.website ? "launch metadata" : pf?.twitter || pf?.website ? "pump.fun" : dexLinks.twitter || dexLinks.website ? "DexScreener" : null,
    source: meta ? `launch metadata (${meta.via})` : pf ? "pump.fun" : asset ? "Helius getAsset" : null,
  };
}

/** 3. OG or copycat: other coins with the same ticker or name, which came first and which has the volume */
async function copies(mint, c, fetcher, self) {
  const ticker = (c.ticker || "").toLowerCase(), name = (c.name || "").toLowerCase();
  let list = [], source;
  if (fetcher) {
    const found = (await Promise.all([pumpfun.search(fetcher, c.ticker || c.name, 50), c.name && c.name !== c.ticker ? pumpfun.search(fetcher, c.name, 50) : []].map((p) => p.catch(() => [])))).flat();
    list = [...new Map(found.map((f) => [f.mint, f])).values()];
    source = "pump.fun search";
  } else {
    const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(c.ticker || c.name)}`);
    list = (j.pairs || []).filter((p) => p.chainId === "solana").map((p) => ({ mint: p.baseToken.address, name: p.baseToken.name, symbol: p.baseToken.symbol, createdAt: p.pairCreatedAt, mcUsd: p.marketCap }));
    source = "DexScreener search (pump.fun's search needs the app)";
  }
  const myCid = cidOf(c.image);
  const samePicOf = (f) => !!myCid && cidOf(f.image) === myCid;
  const story = storyId(c.twitter) || storyId(c.website);
  const sameStoryOf = (f) => !!story && [f.twitter, f.website].some((u) => storyId(u) === story);
  const older = (f) => f.createdAt && self.createdAt && f.createdAt < self.createdAt;
  const matches = list.filter((f) => f.mint !== mint && ((f.symbol || "").trim().toLowerCase() === ticker || (f.name || "").trim().toLowerCase() === name || samePicOf(f) || sameStoryOf(f)));
  // an established token that only shares the ticker is a different thing: an info line, never a copy
  const tickerOnly = (f) => !samePicOf(f) && !sameStoryOf(f) && !nameLike(f.name, c.name) && (f.name || "").trim().toLowerCase() !== name;
  const big = matches.filter((f) => tickerOnly(f) && isEstablished(f)).sort((a, b) => (b.mcUsd || 0) - (a.mcUsd || 0))[0];
  const sharesTickerWith = big ? { mint: big.mint, name: big.name, symbol: big.symbol, mcUsd: big.mcUsd } : null;
  // the two ways to be a copy: the same story, or a big coin that already ran
  const sameStory = matches.filter(sameStoryOf);
  const bigOriginals = matches.filter((f) => older(f) && ranBig(f) && (nameLike(f.name, c.name) || (f.name || "").trim().toLowerCase() === name || samePicOf(f)));
  const judged = [...new Map([...sameStory, ...bigOriginals].map((f) => [f.mint, f])).values()];
  const vol = new Map();
  for (let i = 0; i < Math.min(judged.length, 60); i += 30) {
    const batch = judged.slice(i, i + 30).map((f) => f.mint).join(",");
    try { for (const p of await getJson(`https://api.dexscreener.com/tokens/v1/solana/${batch}`)) vol.set(p.baseToken.address, Math.max(vol.get(p.baseToken.address) || 0, p.volume?.h24 || 0)); } catch { /* volume unknown */ }
  }
  const withVol = (f) => ({ ...f, vol24h: vol.get(f.mint) ?? null });
  const storyAll = [...sameStory.map(withVol), { mint, createdAt: self.createdAt, mcUsd: self.mcUsd, vol24h: self.vol24h, self: true }];
  const first = storyAll.filter((f) => f.createdAt).sort((a, b) => a.createdAt - b.createdAt)[0];
  const leader = storyAll.filter((f) => f.vol24h != null).sort((a, b) => b.vol24h - a.vol24h)[0];
  // "bigger" = worth clearly more right now. Market cap, not volume: a coin that pumped and died still shows big 24h
  // volume (on 2026-11-05 a $3.5k "420coin" beat a $36k one on the same post that way, while this one had no volume yet)
  const olderBiggerSameStory = self.mcUsd ? sameStory.map(withVol).filter((f) => older(f) && (f.mcUsd || 0) > 2 * self.mcUsd && (f.mcUsd || 0) > 20_000)
    .sort((a, b) => (b.mcUsd || 0) - (a.mcUsd || 0))[0] : null;
  const bigOriginal = bigOriginals.map(withVol).sort((a, b) => (b.athMcUsd || b.mcUsd || 0) - (a.athMcUsd || a.mcUsd || 0))[0];
  const pick = olderBiggerSameStory ? { f: olderBiggerSameStory, why: "same story" } : bigOriginal ? { f: bigOriginal, why: "big coin" } : null;
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  return {
    others: matches.length, sameStory: sameStory.length, source, og: !sameStory.length || first?.self === true, sharesTickerWith,
    samePicture: matches.filter(samePicOf).length, // counted, never a red flag on its own
    first: first && !first.self ? { mint: first.mint, symbol: first.symbol, launched: day(first.createdAt), vol24h: first.vol24h, mcUsd: first.mcUsd } : null,
    leader: leader ? (leader.self ? "this coin" : { mint: leader.mint, symbol: leader.symbol, vol24h: leader.vol24h, mcUsd: leader.mcUsd }) : null,
    copyOf: pick ? { mint: pick.f.mint, symbol: pick.f.symbol, name: pick.f.name, launched: pick.f.createdAt ? day(pick.f.createdAt) : "?", vol24h: pick.f.vol24h, mcUsd: pick.f.mcUsd, athMcUsd: pick.f.athMcUsd, why: pick.why } : null,
  };
}

/** 2. the linked X: what account it is, how old, how big, verified, and whether earlier coins used the same handle */
async function xCheck(mint, c, fetcher, createdAt) {
  if (!c.twitter) return { present: false };
  const r = await x.linked(c.twitter);
  const out = { present: true, link: c.twitter, kind: r.link?.kind || "not an X link", account: r.account || null, community: r.community || null, tweet: r.tweet ? { text: r.tweet.text?.slice(0, 200), at: r.tweet.at, likes: r.tweet.likes, views: r.tweet.views } : null, source: r.account?.source || r.community?.source || "fxtwitter" };
  if (r.note) out.note = r.note;
  const handle = r.link?.handle || r.account?.handle;
  if (handle && fetcher) {
    const hits = await pumpfun.search(fetcher, handle, 50).catch(() => null);
    if (hits) {
      const reused = hits.filter((h) => h.mint !== mint && h.twitter && h.twitter.toLowerCase().includes(`/${handle.toLowerCase()}`) && (!createdAt || h.createdAt < createdAt));
      out.handleReusedBy = reused.length;
      out.reusedExamples = reused.slice(0, 3).map((h) => `$${h.symbol} ${short(h.mint)} (${new Date(h.createdAt).toISOString().slice(0, 10)})`);
    }
  } else if (handle) out.handleReusedBy = "unknown (pump.fun search needs the app)";
  return out;
}

/** decide the verdict from the facts; return it with the receipts that back it.
 *  Order: a LARP (pretends to be tied to a real subject that never acknowledged it) beats a copycat, which beats
 *  legit. Linking a brand's real X account is NOT acknowledgment: anyone can paste @nvidia. Only the subject posting
 *  the coin (with a source) counts. */
function decide(ch) {
  const n = ch.narrative, cp = ch.copies, xa = ch.x, ws = ch.website, base = ch.base || {};
  // receipts: { text (the full sentence, for the model), title (the claim in a few words), detail (the specifics),
  // level (bad | warn | good | info: how the balloon marks it), source, weight }
  const r = [];
  const add = (text, source, weight, level = "info", title = null, detail = null) => r.push({ text, source, weight, level, title: title || text, detail });
  const ok = n && !n.unknown;
  let aff = ok ? n.claimsAffiliation : null;
  // the model leans "implied" on memes that only riff on something real (seen 2026-11-03 on $GATO, $AMD), so
  // "implied" needs hard evidence in the coin's OWN text: "official"-type wording, the subject's name used as the
  // coin's name ("NVIDIA COIN"), or its X link being the subject's real account. Otherwise it's parody.
  if (aff === "implied") {
    const own = [ch.claims?.name, ch.claims?.ticker, ch.claims?.description, xa?.account?.name, xa?.account?.bio].filter(Boolean).join(" ").toLowerCase();
    const nameStr = `${ch.claims?.name || ""} ${ch.claims?.ticker || ""}`.toLowerCase();
    const words = String(n.subject || "").toLowerCase().replace(/\(.*?\)/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !["the", "and", "inc", "corp", "corporation", "company", "games", "official", "coin", "meme"].includes(w));
    const officialLink = n.officialHandle && xa?.account?.handle && n.officialHandle.toLowerCase() === xa.account.handle.toLowerCase();
    const strong = /\bofficial\b|\bendorsed\b|backed by|launched by|\bceo\b|by the team of/.test(own) || officialLink || (/\b(coin|token)\b/.test(nameStr) && words.some((w) => nameStr.includes(w)));
    if (!strong) { aff = "parody"; ch.affiliationNote = "the model said implied; no official wording, name or link in the coin's own text, so treated as parody"; }
  }
  const claimsTie = aff === "official" || aff === "implied";
  const xAck = ch.xAck && !ch.xAck.unknown && ch.xAck.posts > 0 ? ch.xAck : null; // the subject's own account posted it (X search)
  const acked = (ok && n.acknowledged?.status === "yes" && n.acknowledged.sources?.length) || xAck;
  const officialMatch = ok && n.officialHandle && xa?.account?.handle && n.officialHandle.toLowerCase() === xa.account.handle.toLowerCase();
  const copy = cp && !cp.unknown && cp.copyOf;
  if (ok && n.subject) n.subject = String(n.subject).replace(/\s*\([^)]*\)/g, "").trim(); // "Donald J. Trump (OFFICIAL TRUMP meme coin)" -> "Donald J. Trump"
  const size = (c) => (c.vol24h ? `${money(c.vol24h)} of 24h volume` : c.mcUsd ? `a ${money(c.mcUsd)} market cap` : "more activity");
  const here = (c) => { const v = c.vol24h ? ch.self.vol24h : ch.self.mcUsd; return v ? money(v) : null; }; // unknown: left out, never "$0"

  let verdict;
  if (!ok) verdict = copy ? `copycat of ${copy.mint}` : "unverified";
  else if (claimsTie) verdict = acked ? "looks legit" : n.acknowledged?.status === "no evidence" || officialMatch ? "likely LARP" : "unverified";
  else if (n.narrative?.real === "no") verdict = "likely LARP";
  else if (copy) verdict = `copycat of ${copy.mint}`;
  else if (n.narrative?.real === "unknown" && aff !== "none") verdict = "unverified";
  else verdict = "looks legit";

  // receipts, strongest first
  const H = n?.officialHandle ? `@${n.officialHandle}` : n?.subject || "the subject";
  if (claimsTie && acked) add(xAck ? `@${n.officialHandle} itself posted it: "${(xAck.first?.text || "").slice(0, 80)}"` : `${n.subject} acknowledged it: ${n.acknowledged.detail}`, xAck ? `X: ${xAck.first?.url || xAck.source}` : `web search: ${n.acknowledged.sources[0]}`, 10,
    "good", `${H} acknowledged it`, xAck ? `it posted: "${(xAck.first?.text || "").slice(0, 80)}"` : n.acknowledged.detail);
  if (claimsTie && !acked && ch.xAck && !ch.xAck.unknown && ch.xAck.posts === 0) add(`@${n.officialHandle} never posted its address or ticker on X`, `X search (${ch.xAck.source})`, 9,
    "bad", `@${n.officialHandle} never posted it`, "no post with its address or ticker on X");
  if (claimsTie && !acked && n.acknowledged?.status === "no evidence") add(`it presents itself as tied to ${n.subject}, but nothing from ${n.subject} mentions it`, "web search", 10,
    "bad", `Not from ${n.subject}`, `it presents itself as tied to ${n.subject}, but nothing from them mentions it`);
  if (officialMatch && !acked) add(`its X link is just ${n.subject}'s real account @${n.officialHandle}, which anyone can paste; nothing shows that account posting the coin`, "fxtwitter + web search", 9,
    "bad", "Its X link is borrowed", `it links ${n.subject}'s real account, which anyone can paste`);
  if (ok && n.narrative?.real === "no") add(`the story it rides doesn't check out: ${n.narrative.summary}`, "web search", 9,
    "bad", "The story doesn't check out", n.narrative.summary);
  if (copy && copy.why === "big coin") add(`it copies $${copy.symbol}, a coin that already ran${copy.athMcUsd ? ` to ${money(copy.athMcUsd)}` : ""} (launched ${copy.launched})`, `${cp.source} + DexScreener`, verdict.startsWith("copycat") ? 10 : 6,
    verdict.startsWith("copycat") ? "bad" : "warn", `It copies $${copy.symbol}, a coin that already ran`, `${copy.name && copy.name !== copy.symbol ? `${copy.name}, ` : ""}launched ${copy.launched}${copy.athMcUsd ? `, peaked at ${money(copy.athMcUsd)}` : copy.mcUsd ? `, at ${money(copy.mcUsd)} now` : ""}`);
  else if (copy) add(`an earlier $${copy.symbol} on the same story (${short(copy.mint)}, launched ${copy.launched}) has ${size(copy)}${here(copy) ? `, against ${here(copy)} here` : ""}`, `${cp.source} + DexScreener`, verdict.startsWith("copycat") ? 10 : 6,
    verdict.startsWith("copycat") ? "bad" : "warn", `An older coin on the same story is bigger`, `$${copy.symbol}, launched ${copy.launched}, with ${size(copy)}${here(copy) ? ` against ${here(copy)} here` : ""}`);
  if (cp && !cp.unknown && cp.sharesTickerWith) add(`it shares the ticker $${cp.sharesTickerWith.symbol} with ${cp.sharesTickerWith.name}, an established ${money(cp.sharesTickerWith.mcUsd)} token, but it isn't a copy of it`, "pump.fun search + market cap", 3,
    "info", `Shares its ticker with ${cp.sharesTickerWith.name}`, `an established ${money(cp.sharesTickerWith.mcUsd)} token; this coin only shares the ticker`);
  if (ok && n.narrative?.real === "yes" && !claimsTie) add(`it's a meme riffing on something real, not posing as it: ${n.narrative.summary}`, `web search: ${n.narrative.sources[0] || "?"}`, 6,
    "good", "Something real behind the meme", n.narrative.summary);
  const dev = base.dev;
  if (dev && !dev.unknown && dev.sentOutPct >= 5) add(`the dev wallet sent ${dev.sentOutPct}% of supply to other wallets without selling it`, "Helius", dev.sentOutPct >= 50 ? 9 : dev.sentOutPct >= 20 ? 7 : 5,
    dev.sentOutPct >= 20 ? "bad" : "warn", `The dev sent out ${dev.sentOutPct}%`, "to other wallets, without selling it");
  if (base.fresh && base.fresh.fresh >= 5) add(`${base.fresh.fresh} of the top ${base.fresh.checked} wallets are brand new (first transaction under 3 days ago)`, "Helius", 7,
    "warn", `${base.fresh.fresh} of the top ${base.fresh.checked} wallets are new`, "their first transaction was under 3 days ago");
  if (base.launchpad && base.launchpad !== "pump.fun") add(`it launched on ${base.launchpad}, not pump.fun`, "DexScreener", 3,
    "info", `Launched on ${base.launchpad}`);
  if (xa?.account?.ageDays != null && xa.account.ageDays < 30) add(`the linked X account @${xa.account.handle} is ${Math.round(xa.account.ageDays)} days old with ${xa.account.followers} followers`, "fxtwitter", 7,
    "warn", `Its X account is ${Math.round(xa.account.ageDays)} days old`, `@${xa.account.handle}, ${xa.account.followers} followers`);
  else if (xa?.account && !officialMatch) add(`the linked X account @${xa.account.handle} is ${Math.round(xa.account.ageDays / 30)} months old with ${xa.account.followers} followers${xa.account.verified ? ", verified" : ""}`, "fxtwitter", 3,
    "info", `Its X account is ${Math.round(xa.account.ageDays / 30)} months old`, `@${xa.account.handle}, ${xa.account.followers} followers${xa.account.verified ? ", verified" : ""}`);
  if (xa?.present === false) add("it has no X link at all", "launch metadata", 5, "warn", "No X link");
  if (xa?.account?.unavailable) add(`its linked X account @${xa.account.handle} is ${String(xa.account.unavailable).toLowerCase()}`, xa.source, 8,
    "bad", `Its X account is ${String(xa.account.unavailable).toLowerCase()}`, `@${xa.account.handle}`);
  if (xa?.community?.members != null) add(`its X community has ${xa.community.members} members${xa.community.ageDays != null ? `, ${Math.round(xa.community.ageDays)} days old` : ""}`, xa.community.source, xa.community.members < 100 ? 5 : 3,
    "info", `X community: ${xa.community.members} members`, xa.community.ageDays != null ? `${Math.round(xa.community.ageDays)} days old` : null);
  const xm = ch.xMentions;
  if (xm && !xm.unknown) {
    if (xm.kols?.length) add(`${xm.kols.length} accounts with 10k+ followers posted the CA, biggest @${xm.kols[0].handle} (${Math.round(xm.kols[0].followers / 1000)}k)`, `X (${xm.source})`, 6,
      "info", `${xm.kols.length} big accounts posted it`, `the biggest is @${xm.kols[0].handle} (${Math.round(xm.kols[0].followers / 1000)}k followers)`);
    else if (xm.posts) add(`${xm.posts}${xm.capped ? "+" : ""} posts of the CA on X, none from accounts with 10k+ followers`, `X (${xm.source})`, 4,
      "info", `${xm.posts}${xm.capped ? "+" : ""} posts of it on X`, "none from accounts with 10k+ followers");
    else add("nobody has posted its contract address on X", `X (${xm.source})`, 6, "warn", "Nobody on X has posted it");
    if (xm.velocity?.trend === "speeding up") add(`mentions are speeding up: ${xm.velocity.last10min} in the last 10 min`, `X (${xm.source})`, 4,
      "info", "X mentions are speeding up", `${xm.velocity.last10min} in the last 10 minutes`);
  }
  if (typeof xa?.handleReusedBy === "number" && xa.handleReusedBy > 0) add(`its X link was already used by ${xa.handleReusedBy} earlier coin${xa.handleReusedBy > 1 ? "s" : ""}`, "pump.fun search", officialMatch ? 4 : 7,
    "warn", `Its X link was used before`, `by ${xa.handleReusedBy} earlier coin${xa.handleReusedBy > 1 ? "s" : ""}`);
  if (ws?.otherCAs?.length) add(`its website shows another coin's contract address (${short(ws.otherCAs[0])}): a copied site`, "the website", 8,
    "bad", "A copied website", `it shows another coin's address (${short(ws.otherCAs[0])})`);
  if (ws?.domain?.ageDays != null && ws.domain.ageDays < 14) add(`the website's domain was registered ${ws.domain.ageDays} days ago`, "RDAP", 5,
    "info", `Its site is ${ws.domain.ageDays} days old`, "the domain was registered recently");
  if (ws?.links?.dead?.length) add(`${ws.links.dead.length} of the website's links are dead`, "the website", 3,
    "info", `${ws.links.dead.length} dead links on its site`);
  const dh = ch.devHistory;
  if (dh && !dh.unknown && dh.otherCoins > 0) add(`the dev launched ${dh.otherCoins} other coins${dh.last30Days ? ` (${dh.last30Days} in the last 30 days)` : ""}; of ${dh.read} checked, ${dh.rugged} rugged (the dev sold within hours), ${dh.dead} dead, ${dh.bonded} bonded`, "pump.fun + Helius", dh.serialLauncher ? 8 : 4,
    dh.rugged >= 2 ? "bad" : dh.serialLauncher ? "warn" : "info", `The dev launched ${dh.otherCoins} other coins`, dh.read ? `of ${dh.read} checked: ${dh.rugged} rugged, ${dh.dead} dead, ${dh.bonded} bonded` : "couldn't read how they ended");
  const ln = ch.launch;
  if (ln && !ln.unknown && (ln.bundle.pct + ln.snipers.pct) >= 5) add(`${(ln.bundle.pct + ln.snipers.pct).toFixed(1)}% of supply was bought in the launch slot and the 3 after it, by ${ln.bundle.wallets.length + ln.snipers.wallets.length} wallets`, "Helius", 6,
    ln.bundle.pct + ln.snipers.pct >= 20 ? "warn" : "info", `${Math.round(ln.bundle.pct + ln.snipers.pct)}% was bought at launch`, `by ${ln.bundle.wallets.length + ln.snipers.wallets.length} wallets in the first slots`);
  const cl = ch.clusters;
  if (cl && !cl.unknown && cl.clusters.length) {
    const c = cl.clusters[0];
    add(`${trench.linkPhrase(c)}${c.fundedByDev && !/dev/.test(trench.linkPhrase(c)) ? " (tied to the dev)" : ""} hold ${c.holdsPct}% now${c.inTop10 ? ` (${c.inTop10} of them in the top 10)` : ""}`, trench.linkEvidence(c), c.fundedByDev || c.holdsPct >= 5 ? 8 : 5,
      c.fundedByDev || c.holdsPct >= 20 ? "bad" : c.holdsPct >= 5 ? "warn" : "info", `${c.wallets.length} linked wallets hold ${c.holdsPct}%`, `they ${trench.linkWays(c)}${c.fundedByDev && !/dev/.test(trench.linkWays(c)) ? " (tied to the dev)" : ""}`);
  }
  // an "unverified" says why: the story isn't confirmed yet, or the subject hasn't confirmed the tie
  if (verdict === "unverified" && ok && !claimsTie && n.narrative?.real === "unknown") add(`its story isn't confirmed yet${n.narrative.summary ? `: ${n.narrative.summary}` : ""}`, "web search", 9.5,
    "warn", "Its story isn't confirmed yet", n.narrative.summary || null);
  if (verdict === "unverified" && claimsTie && !acked && n.acknowledged?.status !== "no evidence") add(`nothing yet confirms it's tied to ${n.subject}`, "web search", 9.5,
    "warn", `Not confirmed by ${n.subject}`, "nothing from them mentions it yet, and nothing shows it's fake either");
  // "looks legit" means nothing alarming at all: a coin that isn't a LARP but has a serial-rugger dev, a dev who
  // shipped out most of the supply, dev-funded wallet clusters or a big launch bundle is only "unverified"
  const severe = [
    dh && !dh.unknown && dh.serialLauncher && dh.rugged >= 2 && "serial rugger",
    dev && !dev.unknown && dev.sentOutPct >= 50 && "dev shipped out most of the supply",
    cl && !cl.unknown && cl.clusters.some((c) => c.fundedByDev && c.holdsPct >= 3) && "wallets tied to the dev",
    ln && !ln.unknown && ln.bundle.pct + ln.snipers.pct >= 20 && "big launch bundle",
  ].filter(Boolean);
  if (verdict === "looks legit" && severe.length) verdict = "unverified";
  r.sort((a, b) => b.weight - a.weight);
  // what would flip it: one plain clause, so a "not yet" reads as "not yet"
  const who = ok && n.officialHandle ? `@${n.officialHandle}` : ok && n.subject ? n.subject : "the subject";
  const wouldChange = verdict === "likely LARP" && claimsTie ? `${who} posting its contract address or ticker`
    : verdict === "likely LARP" ? "a real source for the story it tells"
    : verdict.startsWith("copycat") && copy?.why === "big coin" ? `it showing a story of its own, apart from $${copy.symbol}`
    : verdict.startsWith("copycat") ? `this one overtaking the earlier $${copy.symbol} on the same story`
    : verdict === "unverified" && severe.length ? `the red flags clearing: ${severe.join(", ")}`
    : verdict === "unverified" && claimsTie ? `${who} acknowledging it, or saying it isn't theirs`
    : verdict === "unverified" ? "finding the source it's based on"
    : claimsTie ? `${who} disowning it` : "it starting to claim it's official";
  const lead = r.find((x) => (/legit/.test(verdict) ? x.level === "good" : x.level === "bad" || x.level === "warn")) || r[0];
  return { verdict, receipts: r.slice(0, 3), allReceipts: r, severe, wouldChange, tag: lead ? lead.title : null };
}

/** run every check (in parallel where possible) and decide */
async function legitCheck(base, { fetcher, log = () => {} } = {}) {
  const t0 = Date.now();
  const { rpcCount, rpcCredits } = require("./net");
  const c0 = rpcCount(), k0 = rpcCredits();
  const mint = base.mint;
  const devWallets = base.dev ? [base.dev, ...base.dev.others].map((d) => d.wallet) : [];
  const pf = fetcher ? await pumpfun.coin(fetcher, mint).catch(() => null) : null;
  const self = { createdAt: base.createdAt, mcUsd: base.market?.mcUsd || base.pump?.mcUsd || base.pumpApi?.usdMarketCap || null, vol24h: base.market?.volume?.h24 ?? null };
  const c = await safe("claims", claims(mint, fetcher, pf, base.market?.links), 10000, log);
  const C = c.unknown ? {} : c;
  const launchP = base.launch && !base.launch.unknown ? Promise.resolve(base.launch) : safe("launch", trench.launch(mint, base.mintInfo.supply, devWallets), 15000, log); // pre-fetched by the app
  const mentionsP = safe("x mentions", x.mentions(mint), 20000, log);
  const [xc, cp, ws, tg, dh, ln] = await Promise.all([
    safe("x", xCheck(mint, C, fetcher, base.createdAt), 15000, log),
    safe("copies", copies(mint, C, fetcher, self), 15000, log),
    safe("website", site.website(C.website, mint), 20000, log),
    safe("telegram", site.telegram(C.telegram), 10000, log),
    base.pump || mint.endsWith("pump") ? safe("dev history", trench.devHistory(fetcher, devWallets, mint), 25000, log) : Promise.resolve({ unknown: "not a pump.fun launch: the dev's other coins are only listed for pump.fun" }),
    launchP,
  ]);
  // the narrative check gets what the coin claims plus what its X link and website say
  const nP = safe("narrative", checkNarrative({
    ca: mint, name: C.name, ticker: C.ticker, description: C.description,
    x: xc?.account ? { handle: xc.account.handle, name: xc.account.name, followers: xc.account.followers, ageDays: xc.account.ageDays, bio: xc.account.bio } : xc?.link || null,
    tweet: xc?.tweet?.text || undefined, website: ws?.present ? { host: ws.host, title: ws.title } : null,
  }), 40000, log);
  const clP = base.clusters && !base.clusters.unknown ? Promise.resolve(base.clusters)
    : base.clustersP ? safe("clusters", base.clustersP, 30000, log)
    : base.holders ? safe("clusters", trench.clusters({ holders: base.holders, supply: base.mintInfo.supply, devWallets, mint, early: ln.unknown ? [] : [...ln.bundle.wallets, ...ln.snipers.wallets] }), 25000, log) : Promise.resolve({ unknown: "no holder list" });
  const [n, cl, xm] = await Promise.all([nP, clP, mentionsP]);
  // did the real subject's own X account post the coin? (needs X search)
  const xAck = n?.officialHandle ? await safe("x acknowledgment", x.acknowledged(n.officialHandle, mint, C.ticker), 12000, log) : null;
  const hype = {
    livestream: pf ? (pf.live ? `live now${pf.liveViewers ? `, ${pf.liveViewers} watching` : ""}` : "not live") : "unknown",
    telegramMembers: tg?.members ?? (tg?.present === false ? "no Telegram link" : "unknown"),
    callers: n?.callers?.length ? n.callers.map((k) => `${k.who}: ${k.detail}`.slice(0, 160)) : n?.unknown ? "unknown" : "none found by web search",
    xPostsAboutCA: xm === null ? "unknown (X: partial, no search key)" : xm?.unknown ? "unknown" : `${xm.posts}${xm.capped ? "+" : ""} posts by ${xm.authors} accounts (${xm.source})`,
    community: xc?.community ? `${xc.community.members} members in the X community` : xc?.kind === "community" ? "an X community (member count needs twitterapi.io)" : undefined,
  };
  const launchpad = base.pump || mint.endsWith("pump") ? "pump.fun" : base.market?.dex === "meteoradbc" ? "Meteora's bonding curve" : base.market?.dex || null;
  const checks = { claims: c, x: xc, xMentions: xm, xAck, xMode: x.mode(), copies: cp, website: ws, telegram: tg, devHistory: dh, launch: ln, clusters: cl, narrative: n, hype, self,
    base: { dev: base.dev, fresh: base.fresh ? { fresh: base.fresh.fresh, checked: base.fresh.checked } : null, launchpad } };
  const d = decide(checks);
  log(`legit: verdict "${d.verdict}" in ${Date.now() - t0}ms`);
  return { ...d, checks, ms: Date.now() - t0, xProviders: x.providers(), rpcCalls: rpcCount() - c0, heliusCredits: rpcCredits() - k0, narrativeUsd: n?.usd ?? 0 };
}

/** the compact version the take model sees */
function legitFacts(L) {
  const ch = L.checks;
  const u = (v, f) => (v == null ? "unknown" : v.unknown ? `unknown (${v.unknown})` : f(v));
  return {
    verdict: L.verdict,
    receipts: L.receipts.map((r) => `${r.text} [${r.source}]`),
    wouldChangeIt: L.wouldChange,
    claims: ch.narrative?.claims || "unknown",
    xResearch: ch.xMode,
    x: u(ch.x, (v) => (v.present === false ? "no X link" : v.account?.unavailable ? `@${v.account.handle}: ${v.account.unavailable}` : v.account ? `@${v.account.handle}, ${v.account.followers} followers, ${Math.round(v.account.ageDays)} days old${v.account.verified ? ", verified" : ""}` : v.community ? `X community, ${v.community.members} members` : v.note || v.kind)),
    xMentions: ch.xMentions == null ? "unknown (X: partial: no search key)" : u(ch.xMentions, (v) => ({ posts: `${v.posts}${v.capped ? "+" : ""} by ${v.authors} accounts`, kols: v.kols.map((k) => `@${k.handle} ${k.followers} followers`), topPosters: v.topPosters, firstPost: v.firstPost ? `@${v.firstPost.by} ${ago(Date.now() - v.firstPost.at)}${v.firstPost.olderMayExist ? " (or earlier)" : ""}` : null, velocity: `${v.velocity.last10min} in the last 10 min, ${v.velocity.lastHour} in the hour, ${v.velocity.trend}` })),
    subjectPostedOnX: ch.xAck == null ? "unknown (no X search key or no official account)" : u(ch.xAck, (v) => (v.posts ? `yes: ${v.first?.url}` : "no posts with its CA or ticker")),
    sameNameCoins: u(ch.copies, (v) => `${v.others || 0} other coins share its name, ticker, picture or source (sharing a name or picture is normal, not a copy)${v.sameStory ? `; ${v.sameStory} on the same story, ${v.og ? "this was first" : `the first was ${short(v.first?.mint)} on ${v.first?.launched}`}` : ""}${v.copyOf ? `; copy of $${v.copyOf.symbol} (${v.copyOf.why})` : ""}`),
    website: u(ch.website, (v) => (v.present === false ? "none" : v.up ? `${v.host}, domain ${v.domain?.ageDays ?? "?"} days old${v.builders?.length ? `, built with ${v.builders.join("/")}` : ""}${v.links?.dead?.length ? `, ${v.links.dead.length} dead links` : ""}` : `down (${v.status})`)),
    devHistory: u(ch.devHistory, (v) => `${v.otherCoins} other coins (${v.read} read): ${v.rugged} rugged, ${v.dead} dead, ${v.bonded} bonded, ${v.alive} alive${v.serialLauncher ? " (serial launcher)" : ""}`),
    launchBuys: u(ch.launch, (v) => `dev ${v.devBuyPct}%, launch-slot bundle ${v.bundle.pct}% (${v.bundle.wallets.length} wallets), snipers ${v.snipers.pct}% (${v.snipers.wallets.length} wallets)`),
    fundingClusters: u(ch.clusters, (v) => (v.clusters.length ? v.clusters.slice(0, 2).map((c) => `${trench.linkPhrase(c)}${c.fundedByDev ? " (tied to the dev)" : ""} hold ${c.holdsPct}%`).join("; ") + `; clusters = ${v.shareOfTop10Pct}% of the top 10's holdings` : `no shared funders among ${v.checked} wallets`) + (v.viaExchange ? `; ${v.viaExchange} were funded from busy hot wallets (exchanges?), which can't be clustered` : "")),
    launchpad: ch.base?.launchpad || "unknown",
    hype: ch.hype,
  };
}

module.exports = { legitCheck, legitFacts, decide };
