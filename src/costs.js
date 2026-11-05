// Every paid call is logged to costs.jsonl (tokens, TTS characters, timings) so the cost per research call is
// measured, not guessed. Prices: Claude Haiku 5.5 $0.10 / $0.50 per million tokens in / out (Anthropic list price);
// ElevenLabs Flash v2.5 bills 0.5 credits per character.
const fs = require("node:fs");
const path = require("node:path");
const FILE = path.join(__dirname, "..", "costs.jsonl");
const PRICE = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };

function log(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  const p = PRICE[e.model];
  if (p && e.input != null) e.usd = +(((e.input * p[0]) + (e.output * p[1])) / 1e6).toFixed(6);
  try { fs.appendFileSync(FILE, JSON.stringify(e) + "\n"); } catch { /* never break the app over a log */ }
  return e;
}

module.exports = { log, FILE };
