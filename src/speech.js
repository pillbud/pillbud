// Text for the voice, not the eyes: numbers, money, percents and tickers turned into words before TTS, because
// ElevenLabs Flash garbles "$3.0M" and "4.7 SOL". The balloon keeps the original text with digits.
//   "$3.0M market cap"   -> "three million market cap"
//   "4.7 SOL"            -> "four point seven sol"
//   "Up 17%"             -> "Up seventeen percent"     "+4,350%" -> "plus four thousand three hundred fifty percent"
//   "$AMD"               -> "AMD"                      "20 1m candles" -> "twenty one-minute candles"
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const BIG = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];

function int(n) {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${int(n % 100)}` : ""}`;
  for (const [v, w] of BIG) if (n >= v) return `${int(n / v)} ${w}${n % v ? ` ${int(n % v)}` : ""}`;
  return String(n);
}

/** "4.70" -> "four point seven", "0.05" -> "zero point zero five", "1,190" -> "one thousand one hundred ninety" */
function num(s) {
  const clean = String(s).replace(/,/g, "");
  const [a, b] = clean.split(".");
  const whole = int(Number(a || 0));
  const frac = (b || "").replace(/0+$/, "");
  return frac ? `${whole} point ${[...frac].map((d) => ONES[+d]).join(" ")}` : whole;
}

const SCALE = { k: "thousand", K: "thousand", m: "million", M: "million", b: "billion", B: "billion" };
const UNIT = { m: "minute", h: "hour", d: "day", s: "second" };

function speakable(text) {
  let t = String(text);
  // short wallet addresses like "Cx3t...UEgc" are unreadable aloud (first, before digits become words)
  t = t.replace(/\b[1-9A-HJ-NP-Za-km-z]{3,6}\.\.\.[1-9A-HJ-NP-Za-km-z]{3,6}\b/g, "a wallet");
  t = t.replace(/\s·\s/g, ", ").replace(/\bMC\b/g, "market cap").replace(/\bLiq\b/g, "liquidity");
  // amounts with a scale and a $ first: $3.0M / $12.6k / $3m -> "three million" (no "dollars": how traders say it)
  t = t.replace(/\$(\d[\d,]*(?:\.\d+)?)\s?([kKmMbB])\b/g, (_, n, k) => `${num(n)} ${SCALE[k]}`);
  // candle sizes and durations: "1m candles" -> "one-minute candles", "1h:" -> "one hour"
  t = t.replace(/\b(\d+)\s?([mhds])\b(?=\s*candles?)/g, (_, n, u) => `${int(+n)}-${UNIT[u]}`);
  t = t.replace(/\b(\d+)\s?([mhd])\s+(?=volume|change|high|low|chart)/g, (_, n, u) => `${int(+n)}-${UNIT[u]} `); // "24h volume" -> "twenty four-hour volume"
  t = t.replace(/\b(\d+)([hd])\b/g, (_, n, u) => `${int(+n)} ${UNIT[u]}${+n === 1 ? "" : "s"}`);
  t = t.replace(/\b(\d+)m\b(?!\s*market)/g, (_, n) => `${int(+n)} minute${+n === 1 ? "" : "s"}`); // lowercase m without $ = minutes
  t = t.replace(/\b(\d+)\s(min|mins|sec|secs)\b/g, (_, n, u) => `${int(+n)} ${u.startsWith("m") ? "minute" : "second"}${+n === 1 ? "" : "s"}`); // "5 min" -> "five minutes"
  // amounts with a scale and no $: 84k / 1.2B / 3M -> "eighty four thousand"
  t = t.replace(/\b(\d[\d,]*(?:\.\d+)?)\s?([kKMbB])\b/g, (_, n, k) => `${num(n)} ${SCALE[k]}`);
  // plain dollars: "$500" -> "five hundred dollars"
  t = t.replace(/\$(\d[\d,]*(?:\.\d+)?)(\s+dollars?)?/g, (_, n) => `${num(n)} dollars`);
  // tickers: "$AMD" -> "AMD"
  t = t.replace(/\$([A-Za-z][A-Za-z0-9]*)/g, "$1");
  // percents with a sign: "+17%" -> "plus seventeen percent", "-8%" -> "minus eight percent"
  t = t.replace(/([+-])(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, sg, n) => `${sg === "+" ? "plus" : "minus"} ${num(n)} percent`);
  t = t.replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, n) => `${num(n)} percent`);
  // "0.4x" -> "zero point four times"; "1277/910" -> "1277 to 910"
  t = t.replace(/(\d[\d,]*(?:\.\d+)?)x\b/g, (_, n) => `${num(n)} times`);
  t = t.replace(/(\d)\s*\/\s*(\d)/g, "$1 to $2").replace(/([a-z])\/([a-z])/gi, "$1 and $2");
  // SOL amounts and everything else numeric
  t = t.replace(/\bSOL\b/g, "sol");
  t = t.replace(/\d[\d,]*(?:\.\d+)?/g, (n) => num(n));
  return t.replace(/\s{2,}/g, " ").trim();
}

module.exports = { speakable, num, int };
