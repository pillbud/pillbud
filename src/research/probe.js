// The product test. For a coin that says it has a product (an app, an agent, a tool, a game), pillbud opens the
// coin's site in a hidden, throwaway browser and looks at what it actually does, on your PC, in
// 11 to 19 s.
//   - The page loads in a hidden window with its own in-memory session: no cookies, no wallet, no extensions, nothing
//     saved. Downloads are cancelled (only their names are noted); pop-ups, dialogs and permission prompts are denied.
//   - Every request the page makes is recorded. A real product talks to an API, a chain or a model; a mock talks to
//     nothing.
//   - It presses the site's own way in once ("launch app", "try it", "dashboard"), never anything that buys,
//     connects a wallet, signs, mints or downloads. It never types into the site or submits a form.
//   - It reads the scripts the page loaded for simulated data (random feeds, mock data, demo switches) and for
//     secret API keys left in the page.
//   - Claude Sonnet looks at the two screenshots and that evidence and stamps it: works | partly works | not built |
//     simulated | unreachable, each finding pointing at the request, script or on-page text that shows it.
const { BrowserWindow, session } = require("electron");
const costs = require("../costs");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const NOISE = /(google-analytics|googletagmanager|gtag\/js|doubleclick|facebook\.net|connect\.facebook|hotjar|clarity\.ms|segment\.(io|com)|mixpanel|posthog|amplitude|sentry|datadog|_vercel\/(insights|speed-insights)|vitals\.vercel|plausible|cloudflareinsights|cdn-cgi\/(rum|challenge)|fonts\.(googleapis|gstatic)|typekit|intercom|crisp\.chat|tawk\.to|onesignal|recaptcha|hcaptcha|turnstile|favicon)/i;
const KIND = [
  ["chain", /(helius|quiknode|quicknode|alchemy|solana\.com|rpcpool|triton|syndica|ankr|infura|chainstack|shyft|rpc\.)/i],
  ["market data", /(dexscreener|birdeye|jup\.ag|jupiter|coingecko|geckoterminal|pump\.fun|raydium|moralis|solscan|defined\.fi|codex\.io|mobula)/i],
  ["AI model", /(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|openrouter\.ai|api\.groq\.com|api\.together|api\.mistral|api\.deepseek|replicate\.com|fal\.(ai|run)|elevenlabs|api\.x\.ai)/i],
  ["wallet kit", /(walletconnect|web3modal|reown|privy\.io|dynamic\.xyz|phantom\.app|magic\.link|thirdweb)/i],
  ["backend", /(supabase\.co|firebaseio\.com|firestore\.googleapis|convex\.cloud|appwrite|pocketbase|workers\.dev|onrender\.com|railway\.app|herokuapp|fly\.dev|amazonaws\.com|azurewebsites|\.vercel\.app\/api|\/api\/|graphql)/i],
];
const CTA_YES = /^(launch|open|enter|try|use|start|go to|explore|view)\b.{0,24}\b(app|dapp|demo|terminal|dashboard|platform|agents?|bot|tool|game|playground|studio|beta|product|chat)\b|^(app|demo|dashboard|terminal|playground|try it( now| free)?|get started|launch|enter|play( now)?|start( now)?|chat( now)?|launch app|(start )?build(ing| now| an? [a-z]+)?)$/i;
const CTA_NO = /buy|sell|swap|trade|connect|wallet|sign|log ?in|register|claim|mint|stake|deposit|withdraw|approve|pay|purchase|download|install|subscribe|whitepaper|docs|chart|dexscreener|pump\.fun|twitter|telegram|discord|copy|contract|\bca\b/i;
const regDomain = (h) => (h || "").split(".").slice(-2).join(".");

function kindOf(u, siteDomain) {
  let host = "";
  try { host = new URL(u).host; } catch { return "other"; }
  for (const [k, re] of KIND) if (re.test(u)) return k;
  return regDomain(host) === siteDomain ? "the site's own server" : "third party";
}

/** what the page shows: title, text, buttons, inputs (run in an isolated world, so the page can't tamper with it) */
const SNAP = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none"; };
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().replace(/\\s+/g, " ").slice(0, 40);
  const text = (document.body ? document.body.innerText : "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  return {
    title: document.title.slice(0, 120), url: location.href, words: text.split(/\\s+/).filter(Boolean).length, text: text.slice(0, 2600),
    buttons: [...new Set([...document.querySelectorAll("a,button,[role=button]")].filter(vis).map(label).filter(Boolean))].slice(0, 40),
    inputs: [...document.querySelectorAll("input,textarea,select")].filter(vis).map((el) => (el.placeholder || el.name || el.type || "").slice(0, 40)).slice(0, 10),
    canvases: document.querySelectorAll("canvas").length, iframes: [...document.querySelectorAll("iframe")].map((f) => f.src).filter(Boolean).slice(0, 4),
    inlineScript: [...document.scripts].filter((s) => !s.src).map((s) => s.textContent).join("\\n").slice(0, 200000),
  };
})()`;

/** the site's own way in: a link it navigates to (returned), or a button it clicks (clicked here). Never a wallet,
 *  buy, sign or download control. */
const CTA = `(() => {
  const yes = new RegExp(${JSON.stringify(CTA_YES.source)}, "i"), no = new RegExp(${JSON.stringify(CTA_NO.source)}, "i");
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none"; };
  const els = [...document.querySelectorAll("a,button,[role=button]")].filter(vis);
  for (const el of els) {
    const t = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ");
    if (!t || t.length > 40 || !yes.test(t) || no.test(t)) continue;
    if (el.closest("form")) continue;
    const href = el.tagName === "A" ? el.href : null;
    if (href && /^https?:/i.test(href)) return { text: t, href };
    if (href) continue;
    el.click();
    return { text: t, clicked: true };
  }
  return null;
})()`;

async function snap(wc, label) {
  const s = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: SNAP }]).catch(() => null);
  if (!s) return null;
  let jpeg = null;
  try {
    const img = await wc.capturePage();
    if (!img.isEmpty()) jpeg = img.resize({ width: 1024 }).toJPEG(62);
  } catch { /* no picture: the text still counts */ }
  return { label, ...s, jpeg };
}

/** look inside the page's own scripts for data that's simulated rather than fetched, and for leaked secret keys */
function scanCode(code, src) {
  const hits = [];
  const add = (kind, i, len = 0) => hits.push({ kind, src, snippet: code.slice(Math.max(0, i - 90), i + len + 110).replace(/\s+/g, " ") });
  const re = /\b(mock|fake|dummy|simulat\w*|hardcoded|sample|demo)(Data|Feed|Agents?|Trades?|Messages?|Responses?|Replies|Users?|Stats|Activity|Txs?|Transactions?|Prices?|Holders|Logs?|Events?|Signals?|Calls?)\b/gi;
  let m, n = 0;
  while ((m = re.exec(code)) && n < 4) { if (/^(simulateTransaction|simulateBundle|placeholderData|sampleRate|simulateTransactions)$/i.test(m[0])) continue; add("mock data", m.index, m[0].length); n++; }
  const demo = /\b(isDemo|demoMode|DEMO_MODE|useMock|USE_MOCK|MOCK_[A-Z_]+|FAKE_[A-Z_]+)\b/g;
  for (n = 0; (m = demo.exec(code)) && n < 2; n++) add("demo switch", m.index, m[0].length);
  let randomTimers = 0;
  const iv = /setInterval\(/g;
  while ((m = iv.exec(code)) && randomTimers < 50) { const w = code.slice(m.index, m.index + 500); if (/Math\.random\(\)/.test(w)) { if (randomTimers < 2) add("random on a timer", m.index, 40); randomTimers++; } }
  // AIza... Google keys aren't here: they're browser keys, public by design and locked to the site (2026-11-05: $WYTH
  // was marked down for one)
  const secret = /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}|xai-[A-Za-z0-9]{40,})\b/.exec(code);
  const ai = KIND[2][1].exec(code);
  return { hits, randomTimers, randoms: (code.match(/Math\.random\(\)/g) || []).length, secret: secret ? `${secret[0].slice(0, 5)}... (${secret[0].length} characters, in ${src})` : null, aiHost: ai ? ai[0] : null };
}

/** open the site, use it once, record everything. Returns the evidence (screenshots as JPEG buffers). */
async function run(url, { log = () => {}, budgetMs = 30000 } = {}) {
  const t0 = Date.now();
  const part = `probe-${t0}-${Math.random().toString(36).slice(2, 8)}`; // no "persist:" prefix: in memory only
  const ses = session.fromPartition(part, { cache: false });
  const reqs = [], downloads = [], popups = [], consoleErrors = [];
  const header = (h, k) => { if (!h) return null; const key = Object.keys(h).find((x) => x.toLowerCase() === k); return key ? String(h[key][0] || "") : null; };
  ses.setUserAgent(UA);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (_e, item) => { downloads.push({ name: item.getFilename(), url: item.getURL().slice(0, 160) }); item.cancel(); });
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(https?|wss?|data|blob):/i.test(d.url) }));
  ses.webRequest.onCompleted((d) => { if (reqs.length < 800) reqs.push({ url: d.url, method: d.method, status: d.statusCode, type: d.resourceType, mime: header(d.responseHeaders, "content-type"), bytes: Number(header(d.responseHeaders, "content-length")) || null, at: Date.now() - t0 }); });
  ses.webRequest.onErrorOccurred((d) => { if (reqs.length < 800 && !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(d.error)) reqs.push({ url: d.url, method: d.method, error: d.error, type: d.resourceType, at: Date.now() - t0 }); });
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800, paintWhenInitiallyHidden: true, skipTaskbar: true, focusable: false,
    webPreferences: { partition: part, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false, devTools: false, disableDialogs: true, autoplayPolicy: "user-gesture-required", navigateOnDragDrop: false, webviewTag: false },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(({ url: u }) => { popups.push(u.slice(0, 160)); return { action: "deny" }; });
  wc.on("will-navigate", (e, u) => { if (!/^https?:/i.test(u)) e.preventDefault(); });
  wc.on("console-message", (e) => { if (e.level === "error" && consoleErrors.length < 12) consoleErrors.push(String(e.message).slice(0, 160)); });
  const deadline = t0 + budgetMs;
  const left = () => Math.max(0, deadline - Date.now());
  const ev = { url, loadError: null, first: null, after: null, cta: null };
  try {
    await Promise.race([wc.loadURL(url, { userAgent: UA }), sleep(15000).then(() => { throw new Error("it didn't finish loading in 15 s"); })])
      .catch((e) => { ev.loadError = String(e.message || e).replace(/^.*?(ERR_[A-Z_]+).*$/s, "$1"); });
    log(`probe: loaded in ${Date.now() - t0} ms${ev.loadError ? ` (${ev.loadError})` : ""}`);
    await sleep(Math.min(3500, left()));
    ev.first = await snap(wc, "the page as it loaded");
    if (ev.first && left() > 6000) {
      ev.cta = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: CTA }]).catch(() => null);
      if (ev.cta?.href) await Promise.race([wc.loadURL(ev.cta.href, { userAgent: UA }).catch(() => {}), sleep(10000)]);
      if (ev.cta) { log(`probe: pressed "${ev.cta.text}"`); await sleep(Math.min(4500, left())); ev.after = await snap(wc, `after pressing "${ev.cta.text}"`); }
    }
    // the page's own scripts (not analytics or wallet kits), biggest first
    const site = regDomain((() => { try { return new URL(ev.after?.url || ev.first?.url || url).host; } catch { return ""; } })());
    const scripts = [...new Map(reqs.filter((r) => r.type === "script" && r.status === 200 && !NOISE.test(r.url) && !KIND[3][1].test(r.url)).map((r) => [r.url, r])).values()]
      .sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 6);
    const scans = [];
    for (const s of scripts) {
      if (left() < 1500) break;
      try { const r = await ses.fetch(s.url, { signal: AbortSignal.timeout(Math.min(5000, left())) }); scans.push(scanCode((await r.text()).slice(0, 4_000_000), new URL(s.url).pathname.split("/").pop() || s.url)); } catch { /* skip that one */ }
    }
    for (const sh of [ev.first, ev.after]) if (sh?.inlineScript) scans.push(scanCode(sh.inlineScript, "the page's inline script"));
    ev.scripts = {
      read: scans.length, hits: scans.flatMap((x) => x.hits).slice(0, 8), randomTimers: scans.reduce((s, x) => s + x.randomTimers, 0),
      secretKey: scans.map((x) => x.secret).find(Boolean) || null, aiApiInPage: scans.map((x) => x.aiHost).find(Boolean) || null,
    };
    // what the page talked to, without the noise
    const data = reqs.filter((r) => ["xhr", "webSocket", "other", "ping"].includes(r.type) || /json|event-stream|graphql|protobuf/.test(r.mime || ""))
      .filter((r) => !NOISE.test(r.url) && !/^(data|blob):/.test(r.url));
    const calls = [...new Map(data.map((r) => { let k = r.url; try { const u = new URL(r.url); k = `${r.method} ${u.host}${u.pathname}`; } catch {} return [k, { call: k.slice(0, 140), status: r.error || r.status, mime: (r.mime || "").split(";")[0] || undefined, kind: kindOf(r.url, site), atMs: r.at }]; })).values()];
    ev.network = {
      requests: reqs.length, dataCalls: calls.length, failed: calls.filter((c) => typeof c.status !== "number" || c.status >= 400).length,
      byKind: calls.reduce((o, c) => ((o[c.kind] = (o[c.kind] || 0) + 1), o), {}),
      calls: calls.slice(0, 30), websockets: data.filter((r) => r.type === "webSocket").map((r) => { try { return new URL(r.url).host; } catch { return r.url; } }).slice(0, 5),
    };
    ev.downloads = downloads; ev.popups = popups.slice(0, 5); ev.consoleErrors = consoleErrors;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    ses.clearStorageData().catch(() => {}); ses.clearCache().catch(() => {});
  }
  ev.ms = Date.now() - t0;
  return ev;
}

const SYSTEM = `You check whether a memecoin's product is real. A hidden browser opened the coin's website, waited, pressed the site's own "launch app" style button once (never anything that buys, connects a wallet or signs), recorded every network request, and scanned the page's scripts. You get the coin's claim, up to two screenshots and that evidence. Decide from the evidence only.

Verdicts:
- works: the claimed product is there and was seen doing its job: real data comes back from an API, a chain or a model (the requests show it), or the screenshots show it working.
- partly works: something real exists (a working app shell, a live endpoint, real on-chain reads) but the main claim wasn't seen working, or only part of it is built.
- not built: a landing page, "coming soon", a waitlist, or links to a product that isn't there.
- simulated: the page shows activity (a live feed, agent messages, stats, trades) with nothing real behind it: no requests that could feed it, plus random or hardcoded data in its scripts.
- unreachable: the site didn't load, or only an error page loaded.

Rules:
- Analytics, fonts, wallet-connect kits and price widgets aren't the product. A "connect wallet" button alone isn't a product.
- Reading the coin's own price or chart from DexScreener and the like isn't the product, unless the product claims to be exactly that.
- A product may call an AI model from the page itself and still work, but a secret API key visible in the page's code is a real problem: say so.
- Library code mentions words like mock or demo all the time. Only count a script hit that clearly feeds what the page shows.
- Say what you couldn't see (it needs a login, it needs a wallet, it needs input) instead of guessing. Never call something simulated without a script hit or a missing request that shows it.
- line: 22 words or fewer, plain words, what you found. No hype, no advice, no emojis.
- tag: 5 words or fewer, the gist for a small label under the verdict ("live backend, scan unproven", "landing page only").
- findings: 2 to 5, most important first. title: 8 words or fewer. detail: one plain sentence. evidence: the request (host and path), the script snippet, or the on-page text that shows it.
- wouldChange: 12 words or fewer, what would flip the verdict ("their scanner returning real holder data").`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["verdict", "tag", "line", "findings", "wouldChange"],
  properties: {
    verdict: { type: "string", enum: ["works", "partly works", "not built", "simulated", "unreachable"] },
    tag: { type: "string" },
    line: { type: "string" },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["status", "title", "detail", "evidence"], properties: {
      status: { type: "string", enum: ["works", "missing", "fake", "info"] }, title: { type: "string" }, detail: { type: "string" }, evidence: { type: "string" },
    } } },
    wouldChange: { type: "string" },
  },
};

/** the whole product test: run the page, then Claude Sonnet stamps it. claim: what the coin says its product is. */
async function productTest(url, { client, claim = {}, log = () => {}, model = "claude-sonnet-5-5" } = {}) {
  const t0 = Date.now();
  const ev = await run(url, { log });
  const shots = [ev.first, ev.after].filter((s) => s?.jpeg);
  const strip = (s) => s && (({ jpeg, inlineScript, ...rest }) => rest)(s);
  const evidence = { url, loadError: ev.loadError, page: strip(ev.first), pressed: ev.cta?.text || "no launch-app style button found", afterPressing: strip(ev.after), network: ev.network, scripts: ev.scripts, downloadsBlocked: ev.downloads, popupsBlocked: ev.popups, consoleErrors: ev.consoleErrors };
  const content = [];
  for (const s of shots) { content.push({ type: "text", text: `Screenshot: ${s.label} (${s.url})` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.jpeg.toString("base64") } }); }
  content.push({ type: "text", text: JSON.stringify({ coinClaims: claim, evidence }) });
  const t1 = Date.now();
  const msg = await client.messages.create({
    model, max_tokens: 1200, system: SYSTEM, thinking: /sonnet/.test(model) ? { type: "between_tools" } : { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  });
  if (msg.stop_reason === "refusal") throw new Error("the model declined to judge this site");
  const j = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  const c = costs.log({ kind: "probe", model, input: msg.usage.input_tokens, output: msg.usage.output_tokens, ms: Date.now() - t1, browseMs: ev.ms, url });
  log(`probe: ${j.verdict} in ${Date.now() - t0} ms (browse ${ev.ms} ms, judge ${Date.now() - t1} ms, $${c.usd})`);
  return {
    url, verdict: j.verdict, tag: j.tag, line: j.line, wouldChange: j.wouldChange,
    findings: j.findings.slice(0, 5).map((x) => (x.status === "missing" && /\b(needs?|requires?|behind)\b.*\b(wallet|log ?in|sign[- ]?in|account|connect)/i.test(`${x.title} ${x.detail}`) ? { ...x, status: "info" } : x)),
    pressed: ev.cta?.text || null, network: { dataCalls: ev.network?.dataCalls ?? 0, byKind: ev.network?.byKind || {}, failed: ev.network?.failed ?? 0 },
    secretKey: ev.scripts?.secretKey || null, ms: Date.now() - t0, browseMs: ev.ms, usd: c.usd, shots: shots.map((s) => s.jpeg),
  };
}

/** does this coin claim a product worth testing, and where? The site comes from the coin's own links. */
const PRODUCT_WORDS = /\b(app|dapp|agents?|ai|bot|tool|platform|terminal|protocol|launchpad|game|dex|swap|wallet|scanner|sniper|dashboard|sdk|api|engine|copilot|assistant|analytics|tracker|marketplace|exchange|infra|network|l1|l2|chain|automation|aggregator)\b/i;
const NOT_A_SITE = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|discord\.(gg|com)|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|linktr\.ee|pump\.fun|dexscreener\.com|github\.com|medium\.com|reddit\.com|twitch\.tv|kick\.com|google\.com|wikipedia\.org)$/i;
function target(f, read) {
  const site = f?.legit?.checks?.claims?.website || f?.pumpApi?.website || f?.market?.links?.website || null;
  if (!site) return null;
  let host;
  try { host = new URL(/^https?:/.test(site) ? site : `https://${site}`).host; } catch { return null; }
  if (NOT_A_SITE.test(host)) return null;
  const text = [f?.legit?.checks?.claims?.description, f?.legit?.checks?.claims?.name, f?.name, read?.text].filter(Boolean).join(" ");
  const tech = read?.type === "tech" || (read?.facts?.sources || []).some?.((s) => s.kind === "github" || (s.kind === "website" && s.product && (s.product.app !== "none found" || s.product.github !== "none linked")));
  if (!tech && !PRODUCT_WORDS.test(text)) return null;
  return /^https?:/.test(site) ? site : `https://${site}`;
}

/** the coin's pitch is a product (an app, an agent, a tool): only then can a half-built one cast doubt on the story.
 *  A meme coin with a fan site isn't claiming a product ($TRUMP, $PNUT on 2026-11-05). */
function claimsProduct(f, read) {
  if (read?.type === "tech") return true;
  const own = [f?.legit?.checks?.claims?.description, f?.legit?.checks?.claims?.name, f?.pumpApi?.description, f?.name, ...(read?.lines || []).slice(0, 2)].filter(Boolean).join(" ");
  return PRODUCT_WORDS.test(own);
}

module.exports = { productTest, run, target, scanCode, claimsProduct };
