// node test/screen.test.js   (start a test instance first:
//   PILLBUD_TEST=1 PILLBUD_PORT=47341 PILLBUD_TEST_SCREEN=1 PILLBUD_TEST_SCREEN_ACT=1 electron .)
// Feeds the synthetic screens (captures/look-*.png) to the screen watcher's OCR as two consecutive frames each, with the
// live capture paused (so nobody's real screen is involved), and reports per screen: what was found (expected vs got),
// OCR time, and the time from the frame to pillbud's first words. Nothing from the OCR text is printed.
const path = require("node:path");
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47341";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => (await fetch(A + p, o)).json();
const post = (p, body) => j(p, { method: "POST", body });

const CASES = [ // screen, expected coin (null = must not trigger)
  ["x-timeline", null], ["x-ca-tweet", "7hp5"], ["photon", "DDmG"], ["tg-chat", null], ["partial", "Hspr"], ["telegram", "DDmG"], ["axiom", "7hp5"],
];

(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/status"); break; } catch { await sleep(1000); } }
  await sleep(4000);
  await post("/debug/screen-pause");
  const results = [];
  for (const [name, want] of CASES) {
    const m0 = (await j("/debug/metrics")).length;
    const h0 = (await j("/debug/health")).screen;
    const t0 = Date.now();
    const file = path.join(__dirname, "..", "captures", `look-${name}.png`);
    await post("/debug/screen-file", file); await sleep(1700); await post("/debug/screen-file", file); // two frames
    let found = null, first = null;
    for (let k = 0; k < 24 && !first; k++) {
      await sleep(500);
      const m = (await j("/debug/metrics")).slice(m0);
      found = found || m.find((x) => /screen found/.test(x.what));
      first = m.find((x) => x.what === "first words");
      if (!want && k > 8) break;
    }
    const log = (await j("/debug/log")).filter((l) => /screen: found/.test(l)).pop() || "";
    const got = found ? (/found (\w{4})\.\.\./.exec(log) || [])[1] : null;
    const h1 = (await j("/debug/health")).screen;
    const ocr = h1.frames > h0.frames ? Math.round((h1.ocrMs - h0.ocrMs) / (h1.frames - h0.frames)) : null;
    const ok = (want || null) === (got || null);
    results.push({ name, want, got, ok, ocrMs: ocr, how: found?.how, firstWordsMs: first ? first.at - t0 : null });
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(11)} expected ${want || "nothing"}, got ${got || "nothing"}${found ? ` (${found.how})` : ""}; OCR ${ocr} ms/frame${first ? `; first words ${first.at - t0} ms after the frame` : ""}`);
    await sleep(9000); // the watcher allows one new coin per 8 s
  }
  const fp = results.filter((r) => !r.want && r.got).length, fn = results.filter((r) => r.want && !r.got).length, wrong = results.filter((r) => r.want && r.got && r.want !== r.got).length;
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} right; false triggers ${fp}, missed ${fn}, wrong coin ${wrong}`);
  await post("/debug/screen-resume");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
