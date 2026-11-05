// X (Twitter) research: who is posting the contract address, whether the real subject acknowledged the coin, and
// whether the coin's own X link is real. No X login, cookies or browser session, ever (a hard rule).
//
// Providers, in order:
//   twitterapi.io   TWITTERAPI_IO_KEY  DEFAULT, cheapest: $0.15 per 1,000 tweets (15 credits each, 20 per search page),
//                                      user info ~18 credits, community info 20 credits, 15-credit minimum per call
//                                      (twitterapi.io/pricing, 2026-11-03; $1 = 100,000 credits)
//   official X API  X_BEARER_TOKEN     pay-per-use, ~$0.005 per post read, ~$0.01 per user lookup (2026)
//   fxtwitter       none, free         public embed API: one profile or one tweet at a time, no search
// Without twitterapi.io or X keys there is no X search, so the read is labelled "X: partial" (fxtwitter for the
// linked account, Claude's web search for mentions). The keyed paths follow each provider's docs but have NOT been
// run here (no key exists yet).
const { keys } = require("../env");

const UA = { "user-agent": "pillbud/0.1 (+desktop research buddy)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ageDays = (d) => (d ? Math.round(((Date.now() - new Date(d).getTime()) / 864e5) * 10) / 10 : null);
let spend = 0; // twitterapi.io credits used this session (estimated from their published rates)

/** what an X link on a coin points at: a profile, one tweet, a community, or nothing usable */
function parseLink(url) {
  if (!url) return null;
  let u;
  try { u = new URL(/^https?:/.test(url) ? url : `https://${url}`); } catch { return null; }
  if (!/(^|\.)(x|twitter)\.com$/.test(u.hostname)) return null;
  const p = u.pathname.split("/").filter(Boolean);
  if (p[0] === "i" && p[1] === "communities" && p[2]) return { kind: "community", id: p[2], url: u.href };
  if (p[0] === "search" || p[0] === "hashtag" || p[0] === "home") return { kind: "other", url: u.href };
  if (p[0] && p[1] === "status" && p[2]) return { kind: "tweet", handle: p[0] === "i" ? null : p[0], id: p[2], url: u.href };
  if (p[0] && /^[A-Za-z0-9_]{1,15}$/.test(p[0])) return { kind: "profile", handle: p[0], url: u.href };
  return { kind: "other", url: u.href };
}

function userOut(u, source) {
  if (!u) return null;
  if (u.unavailable) return { handle: u.userName, unavailable: u.unavailableReason || "unavailable", source };
  const joined = u.joined || u.created_at || u.createdAt || null;
  return {
    handle: u.screen_name || u.username || u.userName, name: u.name,
    followers: u.followers ?? u.public_metrics?.followers_count ?? u.followers_count ?? null,
    tweets: u.tweets ?? u.public_metrics?.tweet_count ?? u.statusesCount ?? null,
    joined, ageDays: ageDays(joined),
    verified: u.verification ? !!u.verification.verified : u.isBlueVerified ?? u.verified ?? null,
    verifiedType: u.verification?.type || u.verifiedType || u.verified_type || null,
    bio: (u.description || u.profile_bio?.description || "").slice(0, 160), source,
  };
}

// ---------------------------------------------------------------- twitterapi.io (default)
const TAPI = "https://api.twitterapi.io/twitter";
async function tapi(path, credits) {
  const r = await fetch(`${TAPI}${path}`, { headers: { "X-API-Key": keys.TWITTERAPI_IO_KEY }, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status === "error") throw new Error(`twitterapi.io ${r.status}: ${j?.msg || j?.message || "error"}`);
  spend += credits(j);
  return j;
}
const twitterapiio = keys.TWITTERAPI_IO_KEY && {
  name: "twitterapi.io",
  async user(handle) { const j = await tapi(`/user/info?userName=${encodeURIComponent(handle)}`, () => 18); return userOut(j.data, "twitterapi.io"); },
  async community(id) {
    const j = await tapi(`/community/info?community_id=${encodeURIComponent(id)}`, () => 20);
    const c = j.community_info || {};
    return { name: c.name, members: c.member_count ?? null, createdAt: c.created_at || null, ageDays: ageDays(c.created_at), creator: userOut(c.creator, "twitterapi.io"), source: "twitterapi.io" };
  },
  /** newest-first posts matching a query, up to `pages` x 20 */
  async search(query, pages = 3) {
    const out = [];
    let cursor = "";
    for (let i = 0; i < pages; i++) {
      const j = await tapi(`/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest&cursor=${encodeURIComponent(cursor)}`, (x) => Math.max(15, 15 * (x.tweets?.length || 0)));
      for (const t of j.tweets || []) out.push({ id: t.id, url: t.url, text: (t.text || "").slice(0, 200), at: new Date(t.createdAt).getTime(), likes: t.likeCount, views: t.viewCount, retweets: t.retweetCount, author: userOut(t.author, "twitterapi.io") });
      if (!j.has_next_page || !j.next_cursor) return { posts: out, more: false };
      cursor = j.next_cursor;
    }
    return { posts: out, more: true };
  },
};

// ---------------------------------------------------------------- official X API v2 (if a bearer token exists)
const official = keys.X_BEARER_TOKEN && {
  name: "X API v2",
  async user(handle) {
    const r = await fetch(`https://api.x.com/2/users/by/username/${handle}?user.fields=created_at,public_metrics,verified,verified_type,description`, { headers: { authorization: `Bearer ${keys.X_BEARER_TOKEN}` } });
    const j = await r.json(); return j.data ? userOut(j.data, "X API v2") : null;
  },
  async search(query) {
    const r = await fetch(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=50&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,public_metrics,verified,verified_type,created_at`, { headers: { authorization: `Bearer ${keys.X_BEARER_TOKEN}` } });
    const j = await r.json();
    const users = new Map((j.includes?.users || []).map((u) => [u.id, userOut(u, "X API v2")]));
    return { posts: (j.data || []).map((t) => ({ id: t.id, url: `https://x.com/i/status/${t.id}`, text: t.text, at: new Date(t.created_at).getTime(), likes: t.public_metrics?.like_count, author: users.get(t.author_id) })), more: !!j.meta?.next_token };
  },
};

// ---------------------------------------------------------------- fxtwitter (free, no key)
async function fx(path) {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`https://api.fxtwitter.com/${path}`, { headers: UA, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (j?.code === 200) return j;
    if (j?.code === 404) return null;
    await sleep(600);
  }
  throw new Error("fxtwitter didn't answer");
}
const fxtwitter = {
  name: "fxtwitter",
  async user(handle) { const j = await fx(handle); return userOut(j?.user, "fxtwitter"); },
  async tweet(id, handle) {
    const j = await fx(`${handle || "i"}/status/${id}`);
    const t = j?.tweet; if (!t) return null;
    return {
      id: t.id || id, url: t.url || null, text: t.text, at: new Date(t.created_at).getTime(), likes: t.likes, retweets: t.retweets, replies: t.replies, views: t.views,
      author: userOut(t.author, "fxtwitter"), photos: (t.media?.photos || []).map((p) => p.url).slice(0, 2), video: !!t.media?.videos?.length,
      quote: t.quote ? { text: (t.quote.text || "").slice(0, 280), handle: t.quote.author?.screen_name || null, name: t.quote.author?.name || null } : null,
      replyingTo: t.replying_to || null, source: "fxtwitter",
    };
  },
};

const searcher = twitterapiio || official || null;
const profiler = twitterapiio || official || fxtwitter;
const mode = () => (searcher ? `full (${searcher.name})` : "partial (no X search key: fxtwitter for the linked account, web search for mentions)");

/** the coin's own X link: profile age/size/verified, the linked tweet, or the community's member count */
async function linked(url) {
  const link = parseLink(url);
  if (!link) return { link: null };
  if (link.kind === "profile") return { link, account: await profiler.user(link.handle) };
  if (link.kind === "tweet") {
    const tw = await fxtwitter.tweet(link.id, link.handle).catch(() => null);
    return { link, tweet: tw, account: tw?.author || (link.handle ? await profiler.user(link.handle) : null) };
  }
  if (link.kind === "community") {
    if (twitterapiio) return { link, community: await twitterapiio.community(link.id) };
    return { link, note: "an X community: member count needs twitterapi.io (no key yet)" };
  }
  return { link };
}

const KOL = 10_000; // followers: a "known caller" for this read

/** who is posting the contract address on X: callers by size, the first post, and whether mentions are speeding up */
async function mentions(mint) {
  if (!searcher) return null;
  const { posts, more } = await searcher.search(mint, 3);
  const now = Date.now();
  const byAuthor = new Map();
  for (const p of posts) if (p.author?.handle) { const a = byAuthor.get(p.author.handle) || { ...p.author, posts: 0, firstAt: p.at, url: p.url }; a.posts++; if (p.at < a.firstAt) { a.firstAt = p.at; a.url = p.url; } byAuthor.set(p.author.handle, a); }
  const authors = [...byAuthor.values()].sort((a, b) => (b.followers || 0) - (a.followers || 0));
  const first = posts.reduce((x, p) => (!x || p.at < x.at ? p : x), null);
  const in10 = posts.filter((p) => now - p.at < 10 * 60e3).length;
  const prev10 = posts.filter((p) => now - p.at >= 10 * 60e3 && now - p.at < 20 * 60e3).length;
  const in60 = posts.filter((p) => now - p.at < 60 * 60e3).length;
  return {
    source: searcher.name, posts: posts.length, capped: more, authors: authors.length,
    kols: authors.filter((a) => (a.followers || 0) >= KOL).slice(0, 5).map((a) => ({ handle: a.handle, followers: a.followers, verified: a.verified, posts: a.posts, firstAt: a.firstAt, url: a.url })),
    topPosters: authors.slice(0, 5).map((a) => `@${a.handle} (${a.followers ?? "?"} followers)`),
    firstPost: first ? { by: first.author?.handle, followers: first.author?.followers, at: first.at, url: first.url, olderMayExist: more } : null,
    velocity: { last10min: in10, prev10min: prev10, lastHour: in60, trend: in10 > prev10 * 1.5 && in10 >= 3 ? "speeding up" : in10 < prev10 * 0.5 ? "slowing down" : "steady" },
  };
}

/** did the real subject's account post this coin (CA or $TICKER)? Needs search. */
async function acknowledged(handle, mint, ticker) {
  if (!searcher || !handle) return null;
  const q = `from:${handle} (${mint}${ticker ? ` OR $${ticker}` : ""})`;
  const { posts } = await searcher.search(q, 1);
  return { searched: q, source: searcher.name, posts: posts.length, first: posts[posts.length - 1] ? { url: posts[posts.length - 1].url, at: posts[posts.length - 1].at, text: posts[posts.length - 1].text } : null };
}

const providers = () => ({ mode: mode(), profiles: profiler.name, search: searcher?.name || "none" });
const credits = () => spend;

module.exports = { parseLink, linked, tweet: (id, handle) => fxtwitter.tweet(id, handle), searchUser: (handle, words) => (searcher ? searcher.search(`from:${handle} ${words}`, 1) : null), canSearch: () => !!searcher, mentions, acknowledged, providers, credits, mode, user: (h) => profiler.user(h), lookupLink: linked, searchCA: async (m) => { const r = await mentions(m); return r && { source: r.source, posts: [] , ...r }; } };
