// "Look at this": on demand only (hotkey, tray item, or saying "look at this"). Captures the window in front (or the
// screen), asks Claude's vision for the coin on it (contract address, or ticker and name) plus anything notable
// (chart state, a Telegram message), and resolves that to a mint. Never automatic, never continuous.
const Anthropic = require("@anthropic-ai/sdk");
const { keys, settings } = require("./env");
const costs = require("./costs");
const { isAddress } = require("./detect");
const { getJson } = require("./research/net");

const client = new Anthropic({ apiKey: keys.ANTHROPIC_API_KEY, baseURL: keys.ANTHROPIC_BASE_URL, maxRetries: 1, timeout: 30000 });
const PROMPT = `This is a screenshot of a trader's screen. Find the Solana memecoin they are looking at.
Answer with ONLY one JSON object:
{"ca":"the full contract address if it's visible in full (32 to 44 base58 characters, often ending in pump), else null",
"caPartial":"a shortened address if that's all that shows (like 7hp5...pump), else null",
"ticker":"the ticker without $, else null","name":"the coin's name, else null",
"where":"the app or site (Axiom, Photon, pump.fun, DexScreener, GMGN, a Telegram bot, X, ...)",
"notable":"one short line about anything notable on screen (the chart pumping or dumping, a Telegram call or alert, a big buy), or null"}
Copy addresses character by character. If no coin is on screen, all fields null.`;

/** image (JPEG Buffer) -> what's on it, with timing and cost */
async function read(jpeg) {
  const t0 = Date.now();
  const model = settings().lookModel || "claude-haiku-5-5";
  const msg = await client.messages.create({
    model, max_tokens: 300, thinking: { type: "disabled" }, output_config: { effort: "low" },
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } }, { type: "text", text: PROMPT }] }],
  });
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let out = {};
  try { out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { out = {}; }
  const usage = { input: msg.usage.input_tokens, output: msg.usage.output_tokens };
  const usd = (usage.input * 0.10 + usage.output * 0.50) / 1e6;
  costs.log({ kind: "look", model, ...usage, usdTotal: +usd.toFixed(6), ms: Date.now() - t0 });
  return { ...out, usage, usd, ms: Date.now() - t0 };
}

/** what the screen showed -> a mint: the full CA if valid, else a search by ticker/name, matching a partial CA */
async function resolve(found, fetcher) {
  const ca = found.ca && String(found.ca).trim();
  if (ca && isAddress(ca)) return { mint: ca, how: "full contract address on screen" };
  const term = found.ticker || found.name;
  if (!term) return null;
  const [pre, suf] = String(found.caPartial || "").split(/\.{2,}|…/).map((s) => s.trim());
  const fits = (m) => (!pre || m.startsWith(pre)) && (!suf || m.endsWith(suf));
  let cands = [];
  if (fetcher) {
    try {
      const pumpfun = require("./research/pumpfun");
      cands = (await pumpfun.search(fetcher, term, 50)).map((c) => ({ mint: c.mint, symbol: c.symbol, name: c.name, size: c.mcUsd || 0 }));
    } catch { /* fall back to DexScreener */ }
  }
  try {
    const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`);
    for (const p of (j.pairs || []).filter((x) => x.chainId === "solana")) cands.push({ mint: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name, size: p.volume?.h24 || p.marketCap || 0 });
  } catch { /* nothing more */ }
  const t = String(found.ticker || "").toLowerCase(), n = String(found.name || "").toLowerCase();
  const scored = cands.filter((c) => fits(c.mint) && ((t && c.symbol?.toLowerCase() === t) || (n && c.name?.toLowerCase() === n)))
    .sort((a, b) => b.size - a.size);
  if (!scored.length) return null;
  return { mint: scored[0].mint, how: pre ? "ticker + partial address matched" : `ticker/name matched (${scored.length} candidates, picked the biggest)` };
}

module.exports = { read, resolve };
