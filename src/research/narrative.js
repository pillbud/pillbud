// "Is the narrative real?" with Claude + the web_search server tool: what the coin claims to be about, whether that
// news/event/person is real and recent, whether the real subject (or its official account) acknowledged the coin or
// posted its contract address, and any known callers found posting it. Sources must come from the search results:
// any URL the model cites that the searches didn't return is dropped. No evidence = "unknown", never "clean".
const Anthropic = require("@anthropic-ai/sdk");
const { keys } = require("../env");
const costs = require("../costs");

const client = new Anthropic({ apiKey: keys.ANTHROPIC_API_KEY, baseURL: keys.ANTHROPIC_BASE_URL, maxRetries: 1, timeout: 60000 });
// Haiku 5.5 takes the basic web search tool; Sonnet 5.5 the dynamic-filtering one (fallback if Haiku refuses)
const PLANS = [
  // Haiku: thinking off (its default adaptive thinking ate the token budget before the JSON on 2026-11-03)
  { model: "claude-haiku-5-5", tool: { type: "web_search_20250305", name: "web_search", max_uses: 3 }, extra: { thinking: { type: "disabled" }, output_config: { effort: "low" } } },
  { model: "claude-sonnet-5-5", tool: { type: "web_search_20260209", name: "web_search", max_uses: 3 }, extra: {} },
];
const PRICE = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10] };

const SYSTEM = `You fact-check Solana memecoins for a trader. You get what one coin says about itself (name, ticker, description, its X link and that account's bio, its website). ALWAYS run web search first (1 to 3 searches: the subject's news, and the coin's contract address or name with the subject). Report only what the results show; never guess.
Definitions:
- subject: a well-known real person, company, brand, event or project (someone the coin's team is NOT). The coin's own X account, its creator, or an ordinary person who posted the coin is not a subject: then subject is "none".
- claimsAffiliation: "official" = it says it IS the subject's official coin; "implied" = it presents itself as the subject's own coin (its name is the subject's name plus coin/token/official, or it links the subject's real X account or website, or uses "official"); "parody" = a meme or joke ABOUT a real subject (named after its character, a moment, a news story, a ticker pun) without posing as the subject's own coin; "none" = an original meme with no real subject. When unsure between implied and parody, pick parody unless the coin uses the subject's name AS its own identity or the word official.
- narrative.real: "yes" = results show the news, event, meme or product it's about is real; "no" = results show it's false or made up (a fake partnership, an event that didn't happen, a quote nobody said); "unknown" = you couldn't find it (a deleted or private post, a tiny account, too new to be indexed) or there's nothing outside the coin to check (an original meme). Never "no" just because you found nothing.
- acknowledged.status: "yes" = a search result shows the real subject or its official account posting this coin or its contract address, or reputable news reporting that the subject launched or endorsed this coin (same contract address, or the same name and the same website); "no evidence" = you searched the contract address and the subject with the coin, and nothing shows the subject ever had a coin like it; "unknown" = you could not search, the results were unusable, or news shows the subject has a coin with this name but you can't tie it to this contract address.
Answer with ONLY one JSON object, no prose:
{"claims":"one line: who or what the coin says it is about","subject":"the real person/brand/event/project it refers to (a short name), or \"none\"","subjectType":"person|brand|event|project|meme|unclear",
"claimsAffiliation":"official|implied|parody|none","affiliationEvidence":"the coin's own words or links that show it (quote them), or null",
"narrative":{"real":"yes|no|unknown","recent":"yes|no|unknown","summary":"one line on the news/event and when it happened","sources":["url"]},
"acknowledged":{"status":"yes|no evidence|unknown","detail":"one line","sources":["url"]},
"officialHandle":"the real subject's official X handle without @, or null","callers":[{"who":"name or handle","detail":"what they posted","source":"url"}]}`;

function parseJson(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON in the answer");
  return JSON.parse(text.slice(a, b + 1));
}

async function checkNarrative(claim) {
  const user = `COIN ${JSON.stringify(claim)}`;
  let last;
  for (const plan of PLANS) {
    const t0 = Date.now();
    try {
      let messages = [{ role: "user", content: user }];
      let msg, usage = { input: 0, output: 0, searches: 0 };
      for (let turn = 0; turn < 4; turn++) {
        msg = await client.messages.create({ model: plan.model, max_tokens: 2500, system: SYSTEM, tools: [plan.tool], messages, ...plan.extra });
        usage.input += msg.usage.input_tokens; usage.output += msg.usage.output_tokens;
        usage.searches += msg.usage.server_tool_use?.web_search_requests || 0;
        if (msg.stop_reason === "pause_turn") { messages = [{ role: "user", content: user }, { role: "assistant", content: msg.content }]; continue; } // resume the server tool loop
        // it answered without searching (seen 2026-11-03): ask once more, a search is the whole point
        if (!usage.searches && turn === 0) { messages = [{ role: "user", content: `${user}\n\nRun your web searches first, then answer.` }]; continue; }
        break;
      }
      if (!usage.searches) throw new Error("the model wouldn't search");
      // every URL the searches really returned
      const seen = new Set();
      for (const b of msg.content) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) seen.add(r.url);
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      // web search answers carry <cite index="..."> marks: strip them from every string
      const strip = (v) => (typeof v === "string" ? v.replace(/<[^>]*>/g, "").replace(/\s{2,}/g, " ").trim() : Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)])) : v);
      const out = strip(parseJson(text));
      const keep = (list) => (Array.isArray(list) ? list.filter((u) => seen.has(u)) : []);
      if (out.narrative) out.narrative.sources = keep(out.narrative.sources);
      if (out.acknowledged) out.acknowledged.sources = keep(out.acknowledged.sources);
      out.callers = (out.callers || []).filter((c) => c && seen.has(c.source));
      // a "yes" with no surviving source isn't evidence
      if (out.acknowledged?.status === "yes" && !out.acknowledged.sources.length) out.acknowledged = { ...out.acknowledged, status: "unknown", detail: `${out.acknowledged.detail} (no source to back it)` };
      if (out.narrative?.real === "yes" && !out.narrative.sources.length) out.narrative.real = "unknown";
      const p = PRICE[plan.model];
      const usd = (usage.input * p[0] + usage.output * p[1]) / 1e6 + usage.searches * 0.01; // web search: $10 per 1,000
      costs.log({ kind: "narrative", model: plan.model, input: usage.input, output: usage.output, searches: usage.searches, ms: Date.now() - t0, usdTotal: +usd.toFixed(5) });
      return { ...out, model: plan.model, searches: usage.searches, resultsSeen: seen.size, ms: Date.now() - t0, usd: +usd.toFixed(5), tokens: usage };
    } catch (e) { last = e; console.log(`narrative check on ${plan.model} failed: ${e.message.slice(0, 120)}`); }
  }
  throw last;
}

module.exports = { checkNarrative };
