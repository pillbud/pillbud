// The source router: what a coin is based on. The coin's links (X, website, description URLs) are classified the moment
// the coin is seen, and the right fetcher runs for each, in parallel. Each returns an interpretation-ready summary.
//   x-post     the post: author, real/verified, followers, text, media, time, engagement, quote / reply, deleted or not
//   x-profile  the account (and, with an X search key, the post the coin is named after)
//   x-community an X community (its posts need an X search key)
//   youtube    title, channel, upload time, views, description and chapters (captions need a token YouTube won't give
//              scripts, so they're skipped: fast wins), and the description lines that mention the coin
//   tiktok     oEmbed: caption and author      stream (Twitch, Kick)  page title and description
//   instagram  page title and description      github  repo age, last push, stars, fork or not, commits, docs
//   news       the article: outlet, headline, description, published time
//   website    title, description, domain age, and product signals (an app, docs, a repo) or "no product"
// All public endpoints, no keys (except X search when TWITTERAPI_IO_KEY exists). Timeouts are short: skip what's slow.
const x = require("./research/x");
const { domainAge } = require("./research/site");
const { ago } = require("./research/chart");

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "accept-language": "en-US,en;q=0.9" };
const rel = (t) => (t ? ago(Math.max(0, Date.now() - t)) : null);
const fmt = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const within = (p, ms, fallback = null) => Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
const NEWS = /(^|\.)(reuters|apnews|bloomberg|cnbc|cnn|bbc|nytimes|wsj|washingtonpost|theguardian|foxnews|nbcnews|cbsnews|abcnews|politico|axios|theverge|techcrunch|wired|coindesk|cointelegraph|theblock|decrypt|forbes|businessinsider|yahoo|nypost|dailymail|independent|sky|aljazeera|npr|usatoday|time|newsweek|variety|tmz|espn|ign|engadget|arstechnica|bitcoinmagazine|dlnews|blockworks)\.(com|co\.uk|org|net|co)$/;

/** what kind of link this is */
function classify(url) {
  let u; try { u = new URL(/^https?:/i.test(url) ? url : `https://${url}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|mobile)\./, "").toLowerCase();
  const xl = x.parseLink(u.href);
  if (xl) return xl.kind === "tweet" ? { ...xl, kind: "x-post", url: u.href } : xl.kind === "profile" ? { kind: "x-profile", url: u.href, handle: xl.handle } : xl.kind === "community" ? { kind: "x-community", url: u.href, id: xl.id } : { kind: "x-other", url: u.href };
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) {
    const id = host === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v") || (/^\/(shorts|live|embed)\/([\w-]{6,})/.exec(u.pathname) || [])[2];
    return id ? { kind: "youtube", url: u.href, id: id.slice(0, 20) } : { kind: "youtube-channel", url: u.href };
  }
  if (/(^|\.)tiktok\.com$/.test(host)) return { kind: "tiktok", url: u.href };
  if (/(^|\.)(twitch\.tv|kick\.com)$/.test(host)) return { kind: "stream", url: u.href, host };
  if (/(^|\.)instagram\.com$/.test(host)) return { kind: "instagram", url: u.href };
  if (host === "github.com") { const [owner, repo] = u.pathname.split("/").filter(Boolean); return owner ? { kind: "github", url: u.href, owner, repo: repo?.replace(/\.git$/, "") || null } : null; }
  if (/(^|\.)(t\.me|telegram\.me|pump\.fun|dexscreener\.com|birdeye\.so|solscan\.io|gmgn\.ai|axiom\.trade|photon-sol\.tinyastro\.io|linktr\.ee)$/.test(host)) return { kind: "skip", url: u.href, host };
  if (NEWS.test(host)) return { kind: "news", url: u.href, host };
  return { kind: "website", url: u.href, host };
}

async function html(url, ms = 2600, max = 900_000) {
  const r = await fetch(url, { headers: { ...UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { status: r.status, finalUrl: r.url, text: (await r.text()).slice(0, max) };
}
const dec = (s) => (s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
function meta(h, k) {
  const m = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)`, "i").exec(h) || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i").exec(h);
  return m ? dec(m[1]) : null;
}
const titleOf = (h) => meta(h, "og:title") || dec((/<title[^>]*>([^<]*)/i.exec(h) || [])[1]) || null;

// ---------------------------------------------------------------- X
async function xPost(l) {
  const t = await x.tweet(l.id, l.handle);
  if (!t) return { kind: "x-post", url: l.url, status: "unavailable: deleted, private, or the link is wrong" };
  const a = t.author || {};
  return {
    kind: "x-post", url: l.url,
    by: `@${a.handle}${a.name ? ` (${a.name})` : ""}`, account: { followers: fmt(a.followers), verified: a.verified ? `yes${a.verifiedType ? ` (${a.verifiedType})` : ""}` : "no", joined: a.joined ? rel(new Date(a.joined).getTime()) : null, bio: a.bio || undefined },
    linkHandleMatches: l.handle && a.handle ? l.handle.toLowerCase() === a.handle.toLowerCase() : undefined,
    text: t.text?.slice(0, 600), posted: rel(t.at), postedAt: t.at, status: "up",
    engagement: `${fmt(t.likes) ?? "?"} likes, ${fmt(t.retweets) ?? "?"} reposts, ${fmt(t.replies) ?? "?"} replies${t.views ? `, ${fmt(t.views)} views` : ""}`,
    media: t.photos?.length ? `${t.photos.length} photo${t.photos.length > 1 ? "s" : ""}` : t.video ? "a video" : undefined, photo: t.photos?.[0] || undefined,
    quoting: t.quote ? `@${t.quote.handle}: ${t.quote.text}` : undefined, replyingTo: t.replyingTo ? `@${t.replyingTo}` : undefined,
  };
}
async function xProfile(l, coin) {
  const u = await x.user(l.handle);
  const out = { kind: "x-profile", url: l.url, account: u ? `@${u.handle} (${u.name}${u.followers != null ? `, ${fmt(u.followers)} followers` : ""}${u.verified ? ", verified" : ""})` : `@${l.handle} (couldn't read it)`, bio: u?.bio || undefined, joined: u?.joined ? rel(new Date(u.joined).getTime()) : undefined, note: "the coin links a profile, not a post" };
  if (x.canSearch()) {
    const words = [coin.symbol, coin.name].filter(Boolean).join(" OR ");
    const r = await within(x.searchUser(l.handle, `(${words})`), 3000);
    const p = r?.posts?.[0];
    if (p) out.matchingPost = { text: p.text, posted: rel(p.at), likes: fmt(p.likes), url: p.url };
  }
  return out;
}

// ---------------------------------------------------------------- video and streams
async function youtube(l, coin) {
  const page = await html(`https://www.youtube.com/watch?v=${l.id}`, 3000, 2_500_000);
  const m = /ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var |<\/script>)/s.exec(page.text);
  if (!m) return { kind: "youtube", url: l.url, title: titleOf(page.text), note: "couldn't read the video page" };
  const pr = JSON.parse(m[1]), vd = pr.videoDetails || {}, mf = pr.microformat?.playerMicroformatRenderer || {};
  if (pr.playabilityStatus?.status && pr.playabilityStatus.status !== "OK" && !vd.title) return { kind: "youtube", url: l.url, status: `unavailable (${pr.playabilityStatus.status})` };
  const desc = vd.shortDescription || "";
  const lines = desc.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const words = [coin.symbol, coin.name].filter((w) => w && w.length >= 3).map((w) => w.toLowerCase());
  const chapters = lines.filter((s) => /^\(?\d{1,2}:\d{2}(:\d{2})?\)?\s/.test(s)).slice(0, 12);
  const published = mf.publishDate || mf.uploadDate;
  return {
    kind: "youtube", url: l.url, title: vd.title, channel: vd.author, uploaded: published ? rel(new Date(published).getTime()) : null,
    views: fmt(Number(vd.viewCount)), length: vd.lengthSeconds ? `${Math.floor(vd.lengthSeconds / 60)}:${String(vd.lengthSeconds % 60).padStart(2, "0")}` : null, live: vd.isLiveContent || undefined,
    description: desc.slice(0, 700) || null, chapters: chapters.length ? chapters : undefined,
    mentionsCoin: words.length ? lines.filter((s) => words.some((w) => s.toLowerCase().includes(w))).slice(0, 4) : undefined,
    transcript: "not available (YouTube requires a token for captions)",
  };
}
async function tiktok(l) {
  const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(l.url)}`, { headers: UA, signal: AbortSignal.timeout(2500) });
  const j = await r.json();
  return { kind: "tiktok", url: l.url, caption: j.title?.slice(0, 300) || null, by: j.author_name ? `@${j.author_unique_id || j.author_name} (${j.author_name})` : null };
}
async function pageMeta(l, kind) {
  const p = await html(l.url);
  return { kind, url: l.url, title: titleOf(p.text), description: (meta(p.text, "og:description") || meta(p.text, "description") || "").slice(0, 300) || null };
}

// ---------------------------------------------------------------- tech: GitHub and the product site
async function gh(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { "user-agent": "pillbud", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(2500) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`github ${r.status}`);
  return { j: await r.json(), link: r.headers.get("link") };
}
async function github(l) {
  if (!l.repo) { // a user or org: their most recently pushed repos
    const r = await gh(`/users/${l.owner}/repos?sort=pushed&per_page=5`);
    if (!r) return { kind: "github", url: l.url, status: "no such GitHub account" };
    return { kind: "github", url: l.url, account: l.owner, repos: r.j.map((p) => `${p.name}: ${p.stargazers_count} stars, pushed ${rel(new Date(p.pushed_at).getTime())}${p.fork ? ", a fork" : ""}`) };
  }
  const [repo, commits] = await Promise.all([gh(`/repos/${l.owner}/${l.repo}`), within(gh(`/repos/${l.owner}/${l.repo}/commits?per_page=1`), 2500)]);
  if (!repo) return { kind: "github", url: l.url, status: "repo not found (deleted, private, or a fake link)" };
  const p = repo.j;
  const count = commits?.link ? Number((/[?&]page=(\d+)>; rel="last"/.exec(commits.link) || [])[1]) || null : Array.isArray(commits?.j) ? commits.j.length : null;
  return {
    kind: "github", url: l.url, repo: p.full_name, description: p.description || null, created: rel(new Date(p.created_at).getTime()), lastPush: rel(new Date(p.pushed_at).getTime()),
    stars: p.stargazers_count, forks: p.forks_count, commits: count, fork: p.fork ? `yes, of ${p.parent?.full_name || "another repo"}` : "no", language: p.language || null,
    homepage: p.homepage || null, archived: p.archived || undefined,
  };
}
async function website(l, coin) {
  const [p, age] = await Promise.all([html(l.url), within(domainAge(l.host), 2500)]);
  const h = p.text;
  const text = dec(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  const hrefs = [...h.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const gitLinks = [...new Set(hrefs.filter((u) => /github\.com\/[\w.-]+/i.test(u)))].slice(0, 2);
  const docs = hrefs.find((u) => /docs\.|\/docs|gitbook|whitepaper|litepaper/i.test(u));
  // the product can be the page itself: an input with a tool's button ("Paste a token address" + SCAN on $QORB,
  // which the old check called "no app" on 2026-11-05). Newsletter and email boxes don't count.
  const inputs = [...h.matchAll(/<(input|textarea)\b[^>]*>/gi)].map((m) => m[0]).filter((t) => !/type=["']?(hidden|email|checkbox|radio|submit)/i.test(t) && !/newsletter|e-?mail|subscribe/i.test(t));
  const placeholder = inputs.map((t) => (/placeholder=["']([^"']{3,80})["']/i.exec(t) || [])[1]).find(Boolean);
  // the box has to ask for what a tool takes (an address, a token, a prompt, a question, a link): a plain "Search" box
  // or an unlabeled input isn't a product (seen on nyc.gov and a meme site, 2026-11-05)
  const toolAsk = /\b(paste|address|contract|ca|token|mint|wallet|prompt|ask|question|message|describe|url|link|scan|check|analy[sz]e|generate|swap|amount)\b/i;
  const onPageTool = placeholder && toolAsk.test(placeholder) && !/^\s*search\b[\s.…]*$/i.test(placeholder) ? `a tool on the page itself (an input: "${placeholder}")` : null;
  const app = hrefs.find((u) => /(^https?:\/\/app\.|\/app\b|launch app|dashboard|\/dapp)/i.test(u)) || (/launch app|open app|try it|get started|sign in|connect wallet/i.test(text) ? "a launch/sign-in button" : null) || onPageTool;
  const comingSoon = /coming soon|under construction|stay tuned|launching soon/i.test(text);
  // a page that builds itself with JavaScript shows almost no text to a plain fetch: its app can't be seen from here
  const words = text.split(/\s+/).filter(Boolean).length;
  const jsBuilt = words < 150 && /<script[^>]+src=/i.test(h) && (/<div id=["'](root|__next|app|__nuxt|svelte)["']/i.test(h) || (h.match(/<script[^>]+src=/gi) || []).length >= 2);
  const published = meta(h, "article:published_time");
  const kind = meta(h, "og:type") === "article" || published ? "news" : "website";
  const out = {
    kind, url: l.url, host: l.host, title: titleOf(h), description: (meta(h, "og:description") || meta(h, "description") || "").slice(0, 300) || null,
    published: published ? rel(new Date(published).getTime()) : undefined, outlet: meta(h, "og:site_name") || undefined,
    domainRegistered: age?.registered ? `${rel(new Date(age.registered).getTime())}` : age?.ageDays != null ? `${age.ageDays} days ago` : "unknown",
  };
  if (kind === "website") {
    out.product = {
      github: gitLinks.length ? gitLinks : "none linked", docs: docs || "none linked",
      app: app || (jsBuilt ? "can't tell: the page builds itself with JavaScript, so its app only shows when it's opened" : "none found"),
      textWords: words,
      // "coming soon" on a big page is usually one feature ("Telegram bot · coming soon"), not the whole product
      comingSoon: comingSoon ? (words < 600 ? true : "only for part of it (the page has a lot more)") : undefined,
    };
    // "no product" only when nothing shows one: never for a page that builds itself with JavaScript
    out.looksLike = !jsBuilt && !gitLinks.length && !docs && !app && (words < 250 || (comingSoon && words < 600)) ? "a site with no product (a landing page about the coin)" : undefined;
  }
  out._github = gitLinks[0] || null;
  return out;
}

const FETCH = {
  "x-post": xPost, "x-profile": xProfile, youtube, tiktok, github, website,
  "x-community": async (l) => ({ kind: "x-community", url: l.url, note: x.canSearch() ? "an X community" : "an X community (its posts can't be read without an X search key)" }),
  stream: (l) => pageMeta(l, "stream"), instagram: (l) => pageMeta(l, "instagram"), news: (l) => website(l), "youtube-channel": (l) => pageMeta(l, "youtube-channel"),
};

/**
 * route every link to its fetcher, all at once; a GitHub repo found on the website is fetched too.
 * Returns { type, sources: [...summaries], times }. type: the coin's main kind (the first strong source), or "meme".
 */
async function route(links, coin, { budgetMs = 3000, secondaryMs = budgetMs, log = () => {} } = {}) {
  const t0 = Date.now(), times = {};
  const ls = links.map(classify).filter((l) => l && l.kind !== "skip" && l.kind !== "x-other");
  const seen = new Set();
  const uniq = ls.filter((l) => { const k = `${l.kind}:${l.id || l.handle || l.url}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
  // with a post, video or article linked, everything else is extra: it gets a shorter budget
  const primary = new Set(["x-post", "youtube", "tiktok", "news"]);
  const hasPrimary = uniq.some((l) => primary.has(l.kind));
  const run = (l) => within(FETCH[l.kind](l, coin).then((v) => { times[l.kind] = Date.now() - t0; return v; }), hasPrimary && !primary.has(l.kind) ? secondaryMs : budgetMs, { kind: l.kind, url: l.url, status: "didn't answer in time" })
    .catch((e) => ({ kind: l.kind, url: l.url, status: `couldn't read it (${e.message})` }));
  let sources = await Promise.all(uniq.map(run));
  // a tech coin's repo is often linked from its site, not the coin
  const extraGit = sources.find((s) => s?._github)?._github;
  if (extraGit && !sources.some((s) => s?.kind === "github")) { const g = classify(extraGit); if (g?.kind === "github") sources.push(await run(g)); }
  sources = sources.filter(Boolean).map(({ _github, postedAt, ...s }) => s);
  const order = ["x-post", "youtube", "tiktok", "news", "stream", "instagram", "github", "website", "x-profile", "x-community", "youtube-channel"];
  const readable = sources.filter((s) => !s.status || s.status === "up");
  const main = order.find((k) => readable.some((s) => s.kind === k));
  const type = main === "github" || (main === "website" && sources.some((s) => s.kind === "github")) ? "tech" : main === "website" ? (readable.find((s) => s.kind === "website")?.looksLike ? "website (no product)" : "website") : main || "meme";
  times.router = Date.now() - t0;
  return { type, sources, times, links: uniq.map((l) => l.kind) };
}

module.exports = { route, classify };
