// Claude: short verdict lines, streamed answers, and deep research on request. Fast model, small prompts, no thinking.
// Every line is said aloud, so: short, plain, no markdown, numbers only from the facts, never buy/sell instructions.
const Anthropic = require("@anthropic-ai/sdk");
const { keys, settings } = require("./env");
const costs = require("./costs");
const tone = require("./tone");

const client = new Anthropic({ apiKey: keys.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 60000 });
const MODEL = () => settings().model;

const BASE = `You are pillbud, a pill-shaped desktop buddy for Solana memecoin traders (think Clippy, for the trenches).
Everything you write is spoken aloud: plain sentences, no markdown, no lists, no emojis, no hashtags.
Use ONLY the facts in the JSON. Never invent a number, name or event. If a fact you need isn't there, say you don't know it yet.
Tokens a dev sent or transferred to other wallets were not sold: never call a transfer a sale.
Never give buy or sell instructions ("ape", "buy", "sell", "get out", "send it"): you warn and hype with facts, never advise.
No chart-pattern talk (no breakouts, support, resistance): the chart is just its state (pumping, dumping, flat, someone selling).`;

function text(msg) { return msg.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").replace(/\s+/g, " ").trim(); }
const usageOf = (m) => ({ input: m.usage.input_tokens, output: m.usage.output_tokens, searches: m.usage.server_tool_use?.web_search_requests || 0 });

async function call(kind, system, messages, maxTokens) {
  const t0 = Date.now();
  const msg = await client.messages.create({ model: MODEL(), max_tokens: maxTokens, system, thinking: { type: "disabled" }, output_config: { effort: "low" }, messages });
  const usage = usageOf(msg);
  costs.log({ kind, model: MODEL(), ...usage, ms: Date.now() - t0 });
  return { text: text(msg), usage, ms: Date.now() - t0, model: MODEL() };
}

/** split streamed text into sentences as they complete; flush() returns the rest */
function sentencer(onSentence, maxWords = 20) {
  let buf = "";
  return {
    push(t) {
      buf += t;
      // a sentence ends at . ! ? followed by a space (so "4.7" and "$2.7M" stay whole)
      let m;
      while ((m = /^([\s\S]*?[.!?]["')]?)\s+(?=\S)/.exec(buf))) { const s = tone.shorten(tone.clean(m[1]), maxWords); buf = buf.slice(m[0].length); if (s) onSentence(s); }
    },
    flush() { const s = tone.clean(buf); buf = ""; if (s) onSentence(s); },
  };
}

/** the verdict, said in 2 short lines (each 12 words or fewer, ~3 s), in the chosen tone */
async function verdictLines(facts, toneName = settings().tone) {
  const system = `${BASE}\n${tone.style(toneName)}
Write exactly 2 lines, each 12 words or fewer, separated by a newline:
line 1: starts with the verdict in plain words, optionally after its matching reaction word: "Ooh, looks legit", "Hm, likely a LARP", "Hm, unverified", "Hm, just a meme", "Hm, a copycat of the earlier $TICKER" (never read an address). Then a short remark in your voice. Opinions only about what the facts show.
line 2: the single most important receipt (from FACTS.legit.receipts, the X research, the dev, or the state), with a number if there is one.`;
  const t = await call("verdict", system, [{ role: "user", content: `FACTS ${JSON.stringify(facts)}` }], 120);
  const lines = t.text.split(/\n+|(?<=[.!?])\s+(?=[A-Z$])/).map((l) => tone.shorten(tone.clean(l), 18)).filter(Boolean).slice(0, 2);
  return { ...t, lines };
}

const ANSWER = (toneName) => `${BASE}\n${tone.style(toneName)}
The trader is talking to you about the coin they're looking at. Answer in 1 to 3 short sentences, each 15 words or fewer (it's spoken: about 3 seconds a sentence), straight to the point, from the facts.
How to answer the usual questions:
- "what is this", "what's the narrative", "what's the joke", "who tweeted this", "what did they say", "is this the real one": FACTS.read (the source and what it says, the coin's image and links, FACTS.read.lookalikes for which coin came first and which is bigger). If the read found no source, say so.
- "is this a larp": the read's verdict and receipt (FACTS.read.details), plus FACTS.legit when it's there.
- "who's shilling it": FACTS.legit.x (KOLs or callers with follower counts, the first post, how fast mentions grow); if X search isn't available say so.
- "is the dev selling", "how much does the dev hold": FACTS.dev (sold, how much, when, holds now) and FACTS.state.devSellingNow.
- "how bundled is it", "any snipers": FACTS.launch (bundle and snipers as % of supply, and how many wallets).
- "who are the top holders": FACTS.holders (the top 10's share, fresh wallets, the biggest wallets).
- "should I worry": the 2 or 3 most worrying facts, plainly and calmly (or that nothing alarming shows up), and that it's their call.`;

/** a spoken answer, streamed sentence by sentence. history: the last turns about this coin [{ q, a }] */
async function answerStream(question, facts, history, onSentence, toneName = settings().tone) {
  const t0 = Date.now();
  const messages = [];
  history.slice(-5).forEach((h) => { messages.push({ role: "user", content: h.q }); messages.push({ role: "assistant", content: h.a }); });
  messages.push({ role: "user", content: `FACTS ${JSON.stringify(facts)}\n\nQUESTION ${question}` });
  let first = null;
  const sp = sentencer((s) => { if (first == null) first = Date.now() - t0; onSentence(s); });
  const stream = client.messages.stream({ model: MODEL(), max_tokens: 200, system: ANSWER(toneName), thinking: { type: "disabled" }, output_config: { effort: "low" }, messages });
  stream.on("text", (d) => sp.push(d));
  const msg = await stream.finalMessage();
  sp.flush();
  const usage = usageOf(msg);
  costs.log({ kind: "answer", model: MODEL(), ...usage, firstSentenceMs: first, ms: Date.now() - t0 });
  return { text: text(msg), usage, firstSentenceMs: first, ms: Date.now() - t0 };
}

/** a question with no coin open yet */
async function chat(question, onSentence, toneName = settings().tone) {
  return answerStream(question, { note: "No coin is open. If they ask about a coin, tell them to open it on pump.fun, DexScreener, GMGN, Axiom, Photon, Birdeye or Solscan, or copy its contract address." }, [], onSentence, toneName);
}

const DEEP = (toneName) => `${BASE}\n${tone.style(toneName)}
The trader asked you to research this coin. Use web search (2 to 4 searches) plus the FACTS to find: what the coin is and the story it rides (is it real, is it recent), who the team or dev is and their history, its socials, website and community, and how it's trending on X.
Do not narrate what you're about to do: no text before your searches are done.
Reply in exactly this format:
First 3 or 4 short spoken sentences (60 words at most in total) with the most useful findings. Start straight with a finding: no heading, no label, no preamble.
Then a line with only: DETAILS
Then one JSON object: {"whatItIs":"","story":"","storyReal":"yes|no|unknown","team":"","socials":"","onX":"","sources":["url"]}
Use only what the searches and FACTS show; say "unknown" for anything you couldn't find.`;

/** deep research on request: streamed spoken summary, then details for the balloon */
async function deepResearch(question, facts, onSentence, toneName = settings().tone) {
  const t0 = Date.now();
  let spoken = true, first = null, tail = "";
  const sp = sentencer((s) => { if (first == null) first = Date.now() - t0; onSentence(s); });
  const stream = client.messages.stream({
    model: MODEL(), max_tokens: 1500, system: DEEP(toneName), thinking: { type: "disabled" }, output_config: { effort: "low" },
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
    messages: [{ role: "user", content: `FACTS ${JSON.stringify(facts)}\n\nREQUEST ${question}` }],
  });
  // speech waits for the first search result (anything before it is the model narrating its plan), text blocks are
  // joined with a space, and everything after "DETAILS" is the JSON for the balloon
  let searched = false, pre = "";
  const take = (d) => {
    if (!spoken) { tail += d; return; }
    const i = d.indexOf("DETAILS");
    if (i >= 0) { sp.push(d.slice(0, i)); sp.flush(); spoken = false; tail += d.slice(i + 7); } else sp.push(d);
  };
  for await (const ev of stream) {
    if (ev.type === "content_block_start" && ev.content_block.type === "web_search_tool_result") { searched = true; pre = ""; }
    else if (ev.type === "content_block_start" && ev.content_block.type === "text") { if (searched) take(" "); else pre += " "; }
    else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") { if (searched) take(ev.delta.text); else pre += ev.delta.text; }
  }
  const msg = await stream.finalMessage();
  if (!searched && pre) take(pre); // it answered without searching: say it anyway
  if (spoken) sp.flush();
  // keep only sources the searches really returned
  const seen = new Set();
  for (const b of msg.content) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) seen.add(r.url);
  let details = null;
  try {
    const a = tail.indexOf("{"), z = tail.lastIndexOf("}");
    details = JSON.parse(tail.slice(a, z + 1));
    for (const k of Object.keys(details)) if (typeof details[k] === "string") details[k] = details[k].replace(/<[^>]*>/g, "").trim();
    details.sources = (details.sources || []).filter((u) => seen.has(u));
  } catch { details = null; }
  const usage = usageOf(msg);
  const usd = (usage.input * 0.10 + usage.output * 0.50) / 1e6 + usage.searches * 0.01;
  costs.log({ kind: "deep", model: MODEL(), ...usage, usdTotal: +usd.toFixed(5), firstSentenceMs: first, ms: Date.now() - t0 });
  return { details, usage, usd, firstSentenceMs: first, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ the read: what this coin is, fast (src/read.js gathers the facts)
const READ = (toneName, search) => `${BASE}
${tone.style(toneName)}
A trader just opened this coin. Tell them what it is: this is the most important thing you say, and it has to be right.
${search ? "Nothing readable was linked: use web search (1 or 2 quick searches) to find what the coin is based on (a tweet, a news story, a meme, a stream, a person)." : "Use the FACTS only."}
Write exactly this and nothing else: one tag, [real] [larp] [copycat] [meme] or [unclear], then 2 or 3 short spoken sentences, 50 words at most in all. No JSON, no notes, no "I'll search", no plan.
1. What it's about and where it came from, with what the source actually says: who said what, and when. For an X post or a video, always give the key words of what was said.
2. Why people might care right now, only if the facts show it (it's brand new, it's moving fast, the source is blowing up).
3. Real, LARP, copycat or just a meme, with the one receipt that matters.
real = a fair meme or tribute on a real source. meme = just a meme: an original meme with nothing outside it (no post, news, person, product or known meme it riffs on) that isn't posing as anything; say "just a meme" plainly, it's neither good nor bad news. larp = it pretends to be official, or to be made by or tied to a person, brand or project, and nothing backs that; larp beats copycat. copycat = not a larp, but an earlier coin on the same source has more market cap (FACTS.lookalikes.sameStory), or it copies a big coin that already ran (FACTS.lookalikes.copiesBigCoin). The narrative is what counts: other coins that only share the name, ticker or picture are normal and not copies, so never call that a copycat and don't bring them up. unclear = not enough to say.
By source (FACTS.type and FACTS.sources):
- an X post: who posted it (is it really their account: verified, followers), what exactly they said, how long ago, whether it's still up. For a famous person, say plainly if the account is the real one.
- a YouTube or TikTok video: the title and channel, when it went up, and what in it the coin points at (from the description, chapters or the lines that mention the coin).
- tech (a repo or product site): does the product exist (repo age, commits, stars, a fork or not, docs, an app), or is it "a site with no product".
- news: the outlet, the headline, and when it was published.
- a meme with nothing linked: what the image and name show, and what it matches if you found it; else say it's a standalone meme.
- FACTS.lookalikes: on the same source, whether this is the first coin and if another has more market cap; and whether it copies a big coin that already ran.
Never guess a source. If you can't find what it's based on, say "I couldn't find what this is based on" and describe only what the coin itself shows (name, image, description).
Times relative ("20 min ago"), numbers rounded. Never read out a contract address or a URL.`;

const PRICE = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10] }; // $ per million tokens (2026-10)
const TAG = /\[(real|larp|copycat|meme|unclear)\]/i;

/**
 * the read, streamed: onTag(verdict) as soon as the tag arrives, then onSentence(s) per sentence. Nothing before the
 * tag is spoken (that's the model narrating). search: let the model web-search (no source was found in the facts).
 * Returns { text, verdict, usage, usd, firstSentenceMs, ms, model }.
 */
async function readStream(facts, { search = false, model = MODEL(), onTag = () => {}, onSentence = () => {}, toneName = settings().tone } = {}) {
  const t0 = Date.now();
  const sonnet = /sonnet/.test(model);
  let first = null, firstToken = null, tag = null, head = "", said = "";
  const NARRATION = /^(I need to|I'll|I will|Let me|I'm going to|First,? I|I should|The facts here)/i;
  const sp = sentencer((s) => { const c = s.replace(/\{[^{}]*\}/g, "").trim(); if (!c || NARRATION.test(c)) return; if (first == null) first = Date.now() - t0; said += `${c} `; onSentence(c); }, 32);
  const take = (d) => {
    if (firstToken == null) firstToken = Date.now() - t0;
    if (tag == null) { // everything up to the [tag] is dropped
      head += d;
      const m = TAG.exec(head);
      if (!m) return;
      tag = m[1].toLowerCase(); onTag(tag);
      d = head.slice(m.index + m[0].length); head = "";
    }
    sp.push(d.replace(TAG, ""));
  };
  const req = {
    model, max_tokens: search ? 500 : 260, system: READ(toneName, search), output_config: { effort: "low" },
    thinking: sonnet ? { type: "between_tools" } : { type: "disabled" },
    messages: [{ role: "user", content: `FACTS ${JSON.stringify(facts)}` }],
  };
  if (search) req.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]; // the basic search: much faster here than the filtering one
  const stream = client.messages.stream(req);
  for await (const ev of stream) {
    if (ev.type === "content_block_start" && ev.content_block.type === "text") take(" ");
    else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") take(ev.delta.text);
  }
  const msg = await stream.finalMessage();
  if (tag == null && head.trim()) { tag = "unclear"; sp.push(head.replace(/\{[\s\S]*\}/g, " ")); } // never tagged: say what it wrote, minus any JSON
  sp.flush();
  const usage = usageOf(msg);
  const [pi, po] = PRICE[model] || PRICE["claude-haiku-5-5"];
  const usd = (usage.input * pi + usage.output * po) / 1e6 + usage.searches * 0.01;
  costs.log({ kind: "read", model, ...usage, usdTotal: +usd.toFixed(5), firstTokenMs: firstToken, firstSentenceMs: first, ms: Date.now() - t0, search, stop: msg.stop_reason });
  if (msg.stop_reason === "refusal" && !said) throw new Error("the model declined this one");
  return { text: tone.clean(said.trim()), verdict: tag || "unclear", usage, usd, firstTokenMs: firstToken, firstSentenceMs: first, ms: Date.now() - t0, model, search };
}

/** is this a request for the full dig? (meaning questions like "what's the narrative" are answered from the read) */
const wantsDeep = (q) => /\b(research|dig|deep ?dive|look into|tell me more|who('s| is) behind|who made|who('s| is) the team)\b/i.test(q);

module.exports = { verdictLines, answerStream, chat, deepResearch, wantsDeep, sentencer, readStream, client };
