// Free vs pro, decided in one place. config.json "tier": "free" | "pro" (default "pro").
// A payment or license-token check plugs into can() later; there is no payment code yet.
//   free: screen + tab reading, free data, the first words, dev and holder facts, live alerts, Haiku answers
//         (no web search), local / Windows voice
//   pro:  the LARP verdict (web search + X), deep research, ElevenLabs voice, "look closer" (Claude vision),
//         the product test (a hidden browser tries the coin's app; about $0.015 a coin)
const { settings } = require("./env");

const PRO = new Set(["legit", "deep", "elevenlabs", "lookCloser", "probe"]); // probe = the product test (a hidden browser tries the coin's app)

/** may this install use the feature right now? */
function can(feature) {
  const tier = settings().tier || "pro";
  return !PRO.has(feature) || tier === "pro";
}

module.exports = { can, PRO };
