// The read: what this coin is about, where it came from, what the source says, why people care now, and whether it's
// real, a LARP or a copycat. It's pillbud's first output (the brief: "an assistant in interpretation at fast
// speeds while still maintaining quality"). Targets: about 2 to 4 s for tweet coins, under about 8 s otherwise.
//
// Everything starts in parallel the moment the coin is seen:
//   pump.fun's record (name, ticker, description, links, image)   DexScreener (market + links, for non-pump coins)
//   the linked tweet (fxtwitter: author, followers, text, media, time, engagement), or the linked profile
//   the linked page (title + description; YouTube/TikTok through oEmbed)   the coin image, read by Haiku's vision
//   coins with the same name or ticker, and coins on the same tweet (pump.fun search)
// Then brain.readStream interprets: with no tools when a source was found, or with web search when it wasn't.
// Never a guess: no source found = "I couldn't find what this is based on".
const pumpfun = require("./research/pumpfun");
const x = require("./research/x");
const { route, classify } = require("./sources");
const { ago, money } = require("./research/chart");
const { keys, settings } = require("./env");
const costs = require("./costs");

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) pillbud/0.1" };
const within = (p, ms, fallback = null) => Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const rel = (t) => (t ? ago(Math.max(0, Date.now() - t)) : null); // "20 min ago"
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
const COPY_WINDOW = 14 * 864e5;
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

const cidOf = (u) => (/\/ipfs\/([^/?#]+)/.exec(u || "") || [])[1] || null;
const fmt = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** every link the coin gives: its X, website, Telegram, and any URL in the description */
function linksOf(pf, dexLinks = {}) {
  const all = [pf?.twitter, pf?.website, dexLinks.twitter, dexLinks.website, ...((pf?.description || "").match(URL_RE) || [])].filter(Boolean);
  const seen = new Set(), out = [];
  for (const u of all) { const k = u.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(u); } }
  return out;
}

/** the coin image through Haiku's vision: who/what it shows and any text in it (the meme is often in the picture) */
async function vision(imageUrl, client) {
  if (!imageUrl) return null;
  const t0 = Date.now();
  const cid = (/\/ipfs\/([^/?#]+)/.exec(imageUrl) || [])[1];
  const urls = cid ? [`https://pump.mypinata.cloud/ipfs/${cid}?img-width=256&img-dpr=1`, `https://pump.mypinata.cloud/ipfs/${cid}`] : [imageUrl];
  let buf = null, type = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(2500) });
      type = (r.headers.get("content-type") || "").split(";")[0];
      if (r.ok && /^image\/(png|jpeg|webp|gif)$/.test(type)) { buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 4.5e6) break; }
      buf = null;
    } catch { /* next */ }
  }
  if (!buf) return null;
  const msg = await client.messages.create({
    model: "claude-haiku-5-5", max_tokens: 90, thinking: { type: "disabled" }, output_config: { effort: "low" },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } },
      { type: "text", text: "This is a memecoin's image. In one line of 25 words or fewer: who or what it shows, and any words written in it. If it's a screenshot of a tweet, post or headline, say whose it is and quote the key words. No opinions." },
    ] }],
  });
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  costs.log({ kind: "read:vision", model: "claude-haiku-5-5", input: msg.usage.input_tokens, output: msg.usage.output_tokens, ms: Date.now() - t0 });
  return { text, ms: Date.now() - t0, kb: Math.round(buf.length / 1024) };
}

/** other coins with the same name or ticker, and coins pointing at the same tweet: which came first, which is bigger */
async function lookalikes(fetcher, pf, tweetId) {
  if (!fetcher || !pf) return null;
  const terms = [...new Set([pf.symbol, pf.name].filter(Boolean).map((s) => s.trim()))].slice(0, 2);
  const found = (await Promise.all(terms.map((t) => pumpfun.search(fetcher, t, 50).catch(() => [])))).flat();
  const list = [...new Map(found.map((f) => [f.mint, f])).values()].filter((f) => f.mint !== pf.mint);
  const low = (s) => (s || "").trim().toLowerCase();
  const myCid = cidOf(pf.image);
  const samePicOf = (f) => !!myCid && cidOf(f.image) === myCid;
  const story = tweetId ? `x:${tweetId}` : storyId(pf.twitter) || storyId(pf.website);
  const sameStoryOf = (f) => !!story && [f.twitter, f.website].some((u) => storyId(u) === story);
  const older = (f) => f.createdAt && pf.createdAt && f.createdAt < pf.createdAt;
  const sameName = list.filter((f) => low(f.symbol) === low(pf.symbol) || low(f.name) === low(pf.name));
  const sameStory = list.filter(sameStoryOf);
  // copies: a coin on the same story, or a big coin that already ran with a similar name or the same picture
  const bigOriginal = [...sameName, ...list.filter(samePicOf)].filter((f) => older(f) && ranBig(f) && !(isEstablished(f) && !nameLike(f.name, pf.name) && !samePicOf(f)) && (nameLike(f.name, pf.name) || low(f.name) === low(pf.name) || samePicOf(f)))
    .sort((a, b) => (b.athMcUsd || b.mcUsd || 0) - (a.athMcUsd || a.mcUsd || 0))[0];
  const tickerOnlyBig = sameName.filter((f) => isEstablished(f) && !nameLike(f.name, pf.name) && low(f.name) !== low(pf.name) && !samePicOf(f) && !sameStoryOf(f));
  const brief = (f) => ({ ticker: f.symbol, name: f.name !== f.symbol ? f.name : undefined, launched: rel(f.createdAt), mc: money(f.mcUsd), peak: f.athMcUsd ? money(f.athMcUsd) : undefined, mint: `${f.mint.slice(0, 4)}...${f.mint.slice(-4)}` });
  const earlier = sameStory.filter(older).sort((a, b) => a.createdAt - b.createdAt);
  const bigger = sameStory.filter((f) => (f.mcUsd || 0) > (pf.mcUsd || 0)).sort((a, b) => (b.mcUsd || 0) - (a.mcUsd || 0));
  return {
    sameStory: { coins: sameStory.length, thisIsFirst: !earlier.length, thisIsBiggest: !bigger.length, firstOne: earlier[0] ? brief(earlier[0]) : null, biggerOne: bigger[0] ? brief(bigger[0]) : null },
    copiesBigCoin: bigOriginal ? brief(bigOriginal) : null,
    otherCoinsSharingNameOrPicture: sameName.length + list.filter((f) => samePicOf(f) && !sameName.includes(f)).length || undefined,
    note: "sharing a name, ticker or picture with smaller coins is normal and not a copy: the narrative is what counts",
    sharesTickerWith: tickerOnlyBig.length ? tickerOnlyBig.sort((a, b) => (b.mcUsd || 0) - (a.mcUsd || 0)).slice(0, 1).map((f) => `${f.name} ($${f.symbol}), an established ${money(f.mcUsd)} token: this coin only shares its ticker, so it isn't a copy of it`)[0] : undefined,
    _first: earlier[0]?.mint || null, _bigger: bigger[0]?.mint || null,
  };
}

/**
 * Gather the core facts fast. quickP: the DexScreener quick look (already started by the caller).
 * Returns { facts, path: "source" | "search", type, times, raw }: facts is the compact JSON the model reads; path
 * "search" means no readable source was linked, so the model web-searches for what the coin is based on.
 */
async function gather(mint, { fetcher, quickP, client, log = () => {} }) {
  const t0 = Date.now(), times = {};
  const mark = (k) => (v) => { times[k] = Date.now() - t0; return v; };
  const pfP = (fetcher ? pumpfun.coin(fetcher, mint) : Promise.reject(new Error("no fetcher"))).then(mark("pumpfun"), () => { times.pumpfun = Date.now() - t0; return null; });
  const [q, pf] = await Promise.all([within(quickP, 1500).then(mark("dexscreener")), within(pfP, 2500)]);
  const base = pf || (q && { mint, name: q.name, symbol: q.symbol, image: q.image, createdAt: q.market?.createdAt || null, mcUsd: q.market?.mcUsd || null, description: null });
  if (!base) throw new Error("no record of this coin on pump.fun or DexScreener");
  const links = linksOf(pf, q?.market?.links);
  const tweetId = links.map(classify).find((l) => l?.kind === "x-post")?.id || null;
  // all at once: the source router, the image, the lookalikes
  const routeP = route(links, base, { budgetMs: 2800, secondaryMs: 600, log }).then(mark("sources"));
  const visionP = vision(base.image, client).then(mark("vision"), (e) => { log(`read: vision failed (${e.message})`); return null; });
  const lookP = lookalikes(fetcher, pf, tweetId).then(mark("lookalikes"), () => null);
  const [src, look] = await Promise.all([within(routeP, 3200, { type: "meme", sources: [], times: {}, links: [] }), within(lookP, 2200)]);
  // the image matters most when nothing is linked (the meme is in the picture): wait longer for it then
  const img = await within(visionP, Math.max(250, (src.sources.length ? 1500 : 3200) - (Date.now() - t0)));
  times.core = Date.now() - t0;
  const m = q?.market;
  const words = [base.symbol, base.name].filter((w) => w && w.length >= 3).map((w) => w.toLowerCase());
  const ownSite = (s) => s.kind === "website" && words.some((w) => `${s.title || ""} ${s.host || ""}`.toLowerCase().includes(w));
  const strong = src.sources.filter((s) => (!s.status || s.status === "up") && (
    (s.kind === "x-post" && s.text) || (s.kind === "youtube" && s.title) || (s.kind === "tiktok" && s.caption) || (s.kind === "news" && s.title) ||
    (["stream", "instagram"].includes(s.kind) && s.title) || (s.kind === "github" && (s.repo || s.repos)) || (s.kind === "x-profile" && s.matchingPost) ||
    (s.kind === "website" && s.title && (!ownSite(s) || s.product?.github !== "none linked"))));
  const facts = {
    coin: {
      name: base.name || null, ticker: base.symbol || null, description: base.description || null,
      launched: rel(base.createdAt) || null, launchpad: pf ? "pump.fun" : m?.dex || null,
      image: img?.text || (base.image ? "not read in time" : "none"),
      links: links.length ? links : "none", livestream: pf?.live ? `live now${pf.liveViewers ? ` (${pf.liveViewers} watching)` : ""}` : undefined,
    },
    type: src.type, sources: src.sources.length ? src.sources : "nothing readable is linked",
    market: m ? { marketCap: money(m.mcUsd), change5m: m.change?.m5 != null ? `${m.change.m5 > 0 ? "+" : ""}${Math.round(m.change.m5)}%` : null, change1h: m.change?.h1 != null ? `${m.change.h1 > 0 ? "+" : ""}${Math.round(m.change.h1)}%` : null, volume1h: m.volume?.h1 != null ? money(m.volume.h1) : null } : pf ? { marketCap: money(pf.mcUsd) } : null,
    lookalikes: look ? (({ _first, _bigger, ...v }) => v)(look) : "unknown",
    xSearch: x.canSearch() ? "available" : "none (no X search key)",
  };
  Object.assign(times, Object.fromEntries(Object.entries(src.times).map(([k, v]) => [`src:${k}`, v])));
  return { facts, path: strong.length ? "source" : "search", type: src.type, times, raw: { pf, q, sources: src.sources, look, img } };
}

/** the balloon's details, built from the facts (not by the model): the source, what it says, the image, the receipt */
function details(g, text) {
  const ok = (x) => !x.status || x.status === "up";
  const s = (g.raw.sources || []).find((x) => ok(x) && ["x-post", "youtube", "tiktok", "news", "stream", "instagram", "github", "website", "x-profile"].includes(x.kind));
  const verified = (a) => (a?.verified || "").startsWith("yes");
  const source = !s ? "nothing readable is linked"
    : s.kind === "x-post" ? `X post by ${s.by} · ${s.account?.followers ?? "?"} followers${verified(s.account) ? " · verified" : ""} · ${s.posted} · still up`
    : s.kind === "youtube" ? `YouTube: ${s.channel} · uploaded ${s.uploaded} · ${s.views} views`
    : s.kind === "tiktok" ? `TikTok: ${s.by || "?"}`
    : s.kind === "github" ? `GitHub ${s.repo || s.account} · created ${s.created} · last push ${s.lastPush} · ${s.stars} stars${s.fork && s.fork !== "no" ? " · a fork" : ""}`
    : s.kind === "news" ? `${s.outlet || s.host}${s.published ? ` · ${s.published}` : ""}`
    : s.kind === "website" ? `${s.host} · domain registered ${s.domainRegistered}${s.looksLike ? " · no product" : ""}`
    : s.kind === "x-profile" ? `X profile ${s.account}` : `${s.kind}: ${s.title || ""}`;
  const says = !s ? null : s.kind === "x-post" ? `"${s.text}"${s.quoting ? ` (quoting ${s.quoting})` : ""}${s.replyingTo ? ` (replying to ${s.replyingTo})` : ""}`
    : s.kind === "youtube" ? `${s.title}${s.mentionsCoin?.length ? ` · "${s.mentionsCoin[0]}"` : ""}` : s.kind === "tiktok" ? s.caption
    : s.title ? `${s.title}${s.description ? `: ${s.description}` : ""}` : s.bio || null;
  const L = g.raw.look;
  const S = L?.sameStory;
  const receipt = !L ? null : L.copiesBigCoin ? `it copies ${L.copiesBigCoin.ticker}, a coin that already ran${L.copiesBigCoin.peak ? ` to ${L.copiesBigCoin.peak}` : ""}, launched ${L.copiesBigCoin.launched}`
    : !S?.coins ? null : S.biggerOne ? `a bigger coin on the same post: ${S.biggerOne.ticker} at ${S.biggerOne.mc}, launched ${S.biggerOne.launched}`
    : S.firstOne ? `not the first on this post: ${S.firstOne.ticker} launched ${S.firstOne.launched}` : "the first and the biggest coin on this post";
  return { whatItIs: text, source, says, image: g.facts.coin.image && g.facts.coin.image !== "none" ? g.facts.coin.image : null, receipt, sources: s?.url ? [s.url] : [] };
}

module.exports = { gather, details, vision, linksOf };
