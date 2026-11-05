// The coin's website and Telegram: domain age (RDAP), template/builder fingerprints, whether the site shows THIS
// coin's contract address (or someone else's), dead links, and the Telegram group's public member count.
// All public, no keys: rdap.org (free), the site itself, t.me's public preview page.
const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0 Safari/537.36" };
const HOSTED = /(^|\.)(vercel\.app|netlify\.app|carrd\.co|github\.io|webflow\.io|framer\.(website|app|ai)|wixsite\.com|pages\.dev|linktr\.ee|lovable\.app|bolt\.host|replit\.app|web\.app|firebaseapp\.com|onrender\.com|godaddysites\.com|square\.site|my\.canva\.site)$/;
const ageDays = (d) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 864e5) : null);

async function get(url, ms = 8000, method = "GET") {
  const r = await fetch(url, { method, redirect: "follow", headers: UA, signal: AbortSignal.timeout(ms) });
  return r;
}

/** registration date of the domain (RDAP, via rdap.org's bootstrap redirect) */
async function domainAge(host) {
  const parts = host.split(".");
  const domain = parts.slice(-2).join(".");
  const r = await get(`https://rdap.org/domain/${domain}`, 10000);
  if (!r.ok) throw new Error(`rdap ${r.status}`);
  const j = await r.json();
  const reg = (j.events || []).find((e) => e.eventAction === "registration")?.eventDate;
  return { domain, registered: reg || null, ageDays: ageDays(reg), registrar: (j.entities || []).find((e) => (e.roles || []).includes("registrar"))?.vcardArray?.[1]?.find((v) => v[0] === "fn")?.[3] || null };
}

/** fingerprints of site builders and copy-paste memecoin templates */
function fingerprint(html) {
  const h = html.toLowerCase();
  const gen = (/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(html) || [])[1] || null;
  const builders = [
    ["Wix", /wix\.com|_wixcss|wixstatic/], ["Webflow", /webflow/], ["Framer", /framerusercontent|framer\.com\/m\//], ["Carrd", /carrd\.co|carrd/],
    ["WordPress", /wp-content|wp-includes/], ["Squarespace", /squarespace/], ["Lovable", /lovable|gpteng/], ["Bolt", /bolt\.new/], ["v0", /v0\.dev/],
    ["GoDaddy builder", /godaddy|img1\.wsimg/], ["Linktree", /linktr\.ee/], ["Shopify", /cdn\.shopify/],
  ].filter(([, re]) => re.test(h)).map(([n]) => n);
  const title = ((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || "").trim();
  const placeholders = [/lorem ipsum/, /your token name/, /token_name|\{\{\s*ticker\s*\}\}|\$ticker\b/, /coming soon/, /contract address:?\s*(tba|soon|xxxx)/, /create next app|vite \+ react|react app/].filter((re) => re.test(h)).map((re) => re.source.split("|")[0].replace(/\\/g, ""));
  return { title: title.slice(0, 80), generator: gen, builders, placeholders };
}

/** a few outgoing links, checked for being dead (DNS failure or HTTP 4xx/5xx) */
async function checkLinks(html, base) {
  const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"'#\s]+)["']/gi)].map((m) => m[1]);
  const uniq = [...new Set(hrefs)].filter((u) => { try { return new URL(u).host !== new URL(base).host; } catch { return false; } })
    .filter((u) => !/fonts\.|googleapis|gstatic|cdn\.|jsdelivr|unpkg|schema\.org|w3\.org/.test(u)).slice(0, 10);
  const out = await Promise.all(uniq.map(async (u) => {
    if (/(^|\/\/)(www\.)?(x|twitter)\.com\//.test(u)) return { url: u, kind: "x", status: "not checked here (see the X check)" };
    if (/t\.me\//.test(u)) { const t = await telegram(u).catch((e) => ({ error: e.message })); return { url: u, kind: "telegram", dead: !t.exists, status: t.exists ? "ok" : "no such group" }; }
    try { const r = await get(u, 6000); return { url: u, dead: r.status >= 400 && r.status !== 403 && r.status !== 429, status: r.status }; }
    catch (e) { return { url: u, dead: true, status: e.cause?.code || e.name || "failed" }; }
  }));
  return { checked: out.length, dead: out.filter((l) => l.dead).map((l) => `${l.url} (${l.status})`), links: out };
}

/** the website: is it up, how old is the domain, is it a template, does it show this coin's CA, are links dead */
async function website(url, mint) {
  if (!url) return { present: false };
  let u;
  try { u = new URL(/^https?:/.test(url) ? url : `https://${url}`); } catch { return { present: true, url, error: "not a valid URL" }; }
  const out = { present: true, url: u.href, host: u.hostname };
  const hosted = HOSTED.test(u.hostname);
  const [dom, page] = await Promise.all([
    hosted ? Promise.resolve({ hostedOn: u.hostname.split(".").slice(-2).join(".") }) : domainAge(u.hostname).catch((e) => ({ error: e.message })),
    get(u.href, 10000).then(async (r) => ({ status: r.status, finalUrl: r.url, html: (await r.text()).slice(0, 400_000) })).catch((e) => ({ error: e.cause?.code || e.message })),
  ]);
  out.domain = dom;
  if (page.error || page.status >= 400) { out.up = false; out.status = page.error || page.status; return out; }
  out.up = true;
  out.status = page.status;
  Object.assign(out, fingerprint(page.html));
  const cas = [...new Set(page.html.match(B58) || [])].filter((a) => a.length >= 32 && /pump$|[a-z]/.test(a) && /[A-Z]/.test(a) && /[0-9]/.test(a));
  out.showsThisCA = cas.includes(mint);
  out.otherCAs = cas.filter((a) => a !== mint && a.endsWith("pump")).slice(0, 3); // a site showing another coin's CA is a copied site
  out.jsOnly = page.html.length < 3000 || (/<div id=["'](root|__next|app)["']><\/div>/.test(page.html) && !/<a /i.test(page.html));
  out.links = out.jsOnly ? { checked: 0, note: "the page builds itself with JavaScript, so its links can't be read without a browser" } : await checkLinks(page.html, page.finalUrl || u.href);
  return out;
}

/** a Telegram group/channel's public page: does it exist, how many members */
async function telegram(url) {
  if (!url) return { present: false };
  const m = /(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_+]+)/.exec(url);
  if (!m) return { present: true, url, error: "not a t.me link" };
  if (m[1].startsWith("+") || m[1] === "joinchat") return { present: true, url, exists: null, note: "private invite link: member count isn't public" };
  const r = await get(`https://t.me/${m[1]}`, 8000);
  const html = await r.text();
  const exists = /tgme_page_title/.test(html);
  const extra = (/tgme_page_extra">([^<]*)/.exec(html) || [])[1] || "";
  const num = (s) => (s ? Number(s.replace(/[^\d]/g, "")) : null);
  return { present: true, url, handle: m[1], exists, members: num((/([\d\s,.]+)\s+(members|subscribers)/.exec(extra) || [])[1]), online: num((/([\d\s,.]+)\s+online/.exec(extra) || [])[1]), kind: /subscribers/.test(extra) ? "channel" : /members/.test(extra) ? "group" : null };
}

module.exports = { website, telegram, domainAge, fingerprint };
