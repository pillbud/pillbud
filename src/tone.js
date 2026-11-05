// pillbud's voice: short lines (about 3 s spoken, 12 words or fewer) in two tones.
//   friendly  (default) a warm, playful buddy who's on your side. Honest about LARPs, sells and dumps, said calmly
//             ("heads up"), never shouty, aggressive or doom-y
//   unhinged  roasting, deadpan, smug on a pump, gallows humor on a dump
// "normal" (the old default) means friendly. Rules for both: punch at coins, devs and the situation only. No slurs,
// no hate, nothing about real people's identities, and never buy/sell instructions ("ape", "buy now", "sell",
// "get out"): it warns and cheers with facts.
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const sym = (s) => (s ? `$${s}` : "this one");

const LINES = {
  // reaction words lead the line ("Ooh," "Aww," "Hm,"): the Text-mode voice gives them their own little melody
  friendly: {
    gm: ["gm! What are we looking at today?", "Good morning, friend! Coffee and coins?", "gm gm! Show me a coin."],
    gn: ["Late one? I'm here. Show me what you've got.", "Night owl mode! What are we looking at?", "Still up? Let's take a look together."],
    hello: ["Hi, I'm pillbud! Open a coin and I'll take a look.", "Hey friend! Open any coin in your browser and I'll check it out."],
    pumping: ["Ooh, {s} is having a good day: {chg}.", "Nice! {s} is climbing: {chg}.", "Look at {s} go: {chg}."],
    dumping: ["Aww, {s} is dipping: {chg}.", "Heads up, friend: {s} is {chg}.", "Aww, rough patch for {s}: {chg}."],
    flat: ["{s} is at {mc}, nice and calm.", "{s} is just chilling at {mc}.", "{s}, {mc} cap. A quiet one for now."],
    devSold: ["Heads up, friend: the dev already sold {pct}.", "Aww, the dev sold {pct} already. Just so you know.", "Quick heads up: the dev has sold {pct}."],
    devOut: ["Aww, the dev is fully out. Just so you know.", "Heads up: the dev sold all of theirs."],
    devHolds: ["Good news: the dev still holds {pct} and hasn't sold.", "The dev is hanging on to {pct}. No sells yet!"],
    devNone: ["The dev hasn't sold, and doesn't hold any right now.", "No dev sells, and the dev wallet holds none of it."],
    serialRugger: ["Heads up: this dev has rugged {n} other coins before.", "Careful, friend: this dev rugged {n} earlier coins."],
    bundled: ["Hm, {pct} was bundled at launch. Worth knowing.", "Heads up: about {pct} went to a launch bundle."],
    rigged: ["Heads up: the holders look rigged. {why}.", "Careful, friend: the holders look rigged. {why}."],
    clean: ["Holders look nicely spread out. Love that.", "The top ten hold just {pct}. Looks healthy!"],
    pump: ["Ooh! {s} is up {pct} in {dur}. Now {mc}.", "Look at that! {s} jumped {pct} in {dur}.", "Wheee, {s} is up {pct} in {dur}!"],
    dump: ["Aww, {s} dropped {pct} in {dur}. Now {mc}.", "Heads up, {s} slipped {pct} in {dur}.", "Careful, friend: {s} is down {pct} in {dur}."],
    devSell: ["Heads up, the dev just sold {pct}.", "Aww, the dev just sold {pct}. I'll keep an eye on it."],
    devRug: ["Oh no, the dev sold everything. That's a rug, I'm sorry.", "Aww, the dev is completely out. That's a rug, friend."],
    whaleSell: ["Heads up, a big holder just sold {pct}.", "A whale just sold {pct}. I'm watching it for you."],
    bonded: ["Yay, {s} just bonded! Off the curve it goes.", "{s} graduated to PumpSwap! Big day."],
    digging: ["Ooh, let me take a look!", "On it, one sec!", "Happy to check, give me a moment."],
    checking: ["Checking the X and the dev for you...", "Let's see if it's the real deal..."],
  },
  unhinged: {
    gm: ["gm. Who are we getting rugged by today?", "gm. Coffee's on, liquidity's off.", "gm, degenerate. Show me the bag."],
    gn: ["gn. The devs never sleep, why would you.", "It's late. Perfect time for bad decisions.", "Up this late? Your chart's not."],
    hello: ["pillbud online. Open a coin, I'll do the reading.", "Open a coin. I'll tell you if it's a larp."],
    pumping: ["{s} is pumping: {chg}. Act natural.", "{s} {chg}. Smugness levels rising.", "{s} going vertical, {chg}. Told nobody."],
    dumping: ["{s} {chg}. Pour one out.", "{s} is speedrunning zero: {chg}.", "{s} {chg}. It's fine. Everything's fine."],
    flat: ["{s} at {mc}, flatter than the dev's promises.", "{s}: {mc}, chart in a coma.", "{s} at {mc}. Riveting stuff."],
    devSold: ["Dev already sold {pct}. Classy.", "Dev cashed out {pct}. Trust issues unlocked.", "Dev sold {pct}. They believe in it less than you do."],
    devOut: ["Dev is out. Fully. Bye bye.", "Dev sold everything. Respect the honesty, I guess.", "Dev left the building with the bag."],
    devHolds: ["Dev's still in with {pct}. For now.", "Dev holding {pct}. Diamond hands or bait."],
    devNone: ["Dev holds nothing and never sold. Mysterious.", "Dev wallet's empty, no sells. Where'd it go?"],
    serialRugger: ["This dev has rugged {n} coins. Serial offender.", "{n} rugs on this dev's record. Bold."],
    bundled: ["{pct} bundled at launch. Wow, so organic.", "Launch bundle ate {pct}. Totally fair launch."],
    rigged: ["Holders are rigged. {why}. Cozy.", "Rigged holders. {why}. Very fair launch."],
    clean: ["Holders spread out. Suspiciously wholesome.", "Top ten hold {pct}. Almost healthy."],
    pump: ["{s} up {pct} in {dur}. I'd like to thank myself.", "{s} ripped {pct} in {dur}. Paper hands in shambles.", "{pct} in {dur}. {s} chose violence."],
    dump: ["{s} down {pct} in {dur}. Someone's crying.", "{pct} gone in {dur}. Paper hands found the button.", "{s} fell {pct}. Gravity remembered."],
    devSell: ["Dev just sold {pct}. Shocking. Truly.", "Dev dumped {pct}. Sir, this is a community."],
    devRug: ["Dev pulled the rug. Floor's gone.", "Dev sold everything. Rug confirmed, I'm devastated."],
    whaleSell: ["Whale just dumped {pct}. Splash.", "A whale sold {pct}. Hope you like swimming."],
    bonded: ["{s} bonded. Off the curve, onto the hopium.", "{s} graduated. Mom, get the camera."],
    digging: ["Hold on, opening the case file.", "Digging. Bring snacks.", "Pulling receipts."],
    checking: ["Checking if this is a LARP...", "Running the background check..."],
  },
};

function fill(t, v) { return t.replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? String(v[k]) : "")); }

/** "unhinged", else friendly ("normal" from older prefs means friendly) */
const toneOf = (t) => (t === "unhinged" ? "unhinged" : "friendly");

/** one templated line for a situation, in the chosen tone */
function line(kind, vars = {}, tone = "friendly") {
  const set = LINES[toneOf(tone)];
  const t = set[kind] || LINES.friendly[kind];
  return t ? fill(pick(t), { ...vars, s: sym(vars.symbol) }) : "";
}

/** gm before noon, gn late at night, plain hello otherwise */
function greeting(tone = "friendly", hour = new Date().getHours()) {
  return line(hour >= 5 && hour < 12 ? "gm" : hour >= 22 || hour < 5 ? "gn" : "hello", {}, tone);
}

// never advice: these get cut from anything generated
const ADVICE = /\b(you should|go ahead and|time to)\s+(ape|buy|sell|dump|exit|get out|load up)|\bape (in|now)\b|\b(buy|sell) (now|it|this)\b|\bnot selling would be\b|\bload (up|the bag)\b/i;
function clean(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")                 // no tags (web search answers come with <cite> marks)
    .replace(/[*_`#>]+/g, "")                // no markdown
    .replace(/\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // no emoji in spoken lines
    .split(/(?<=[.!?])\s+/).filter((s) => !ADVICE.test(s)).join(" ")
    .replace(/\s{2,}/g, " ").trim();
}

/** keep a spoken line to about 3 s: cut at a natural break (", and" / "," / ";" / ":") before maxWords, else at
 *  maxWords. A sentence that ends within a few more words is kept whole: a broken phrase reads worse than 4 words. */
function shorten(line, maxWords = 15) {
  const w = String(line).split(/\s+/);
  if (w.length <= maxWords + 4) return line;
  const head = w.slice(0, maxWords).join(" ");
  const cut = Math.max(head.lastIndexOf(", and "), head.lastIndexOf(", but "), head.lastIndexOf(","), head.lastIndexOf(";"), head.lastIndexOf(":"));
  const out = cut > head.length * 0.45 ? head.slice(0, cut) : head;
  return out.replace(/[,;:\s]+$/, "") + ".";
}

/** the style instruction for generated lines */
function style(tone = "friendly") {
  return toneOf(tone) === "unhinged"
    ? "Voice: trench-native, deadpan, roasting. Roast LARPs, bad devs, bundled launches and paper hands; smug on a pump, gallows humor on a dump. Punch only at coins, devs and the situation: no slurs, no hate, nothing about real people's identities."
    : "Voice: a warm, playful buddy who's happy to help and on the trader's side. Short and kind, like a friend leaning over to look at the screen with them. Only when the news is clearly good, bad or fishy, start with one little reaction word: \"Ooh,\" for good news (a pump, looks legit), \"Aww,\" for bad news (a dump, the dev selling), \"Hm,\" for something fishy (a LARP, a copycat). Otherwise, and for plain answers, no reaction word. Be honest about LARPs, dev sells and dumps, but say it gently (\"heads up\", \"just so you know\"). Never shouty, aggressive, sarcastic or doom-y: no roasting, no jabs at anyone. A little light, kind humor is welcome.";
}

module.exports = { line, greeting, clean, shorten, style, toneOf, LINES };
