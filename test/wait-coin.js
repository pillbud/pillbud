// node test/wait-coin.js [seconds] : waits for the hidden app to finish a coin (the product test, or the full check
// when there's nothing to test), then prints the relevant log lines and what pillbud said.
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47331";
const limit = Number(process.argv[2] || 90) * 1000, t0 = Date.now();
(async function poll() {
  const all = await fetch(A + "/debug/log").then((r) => r.json()).catch(() => []);
  let k = -1; all.forEach((l, i) => { if (/coin from/.test(l)) k = i; });
  const log = k >= 0 ? all.slice(k) : all; // only the latest coin
  const done = log.some((l) => /probe: \S+( works| built)? in \d+ ms \(browse|product test failed|metric \{"what":"coin cost"/.test(l));
  if (done || Date.now() - t0 > limit) {
    console.log(log.filter((l) => /coin from|read \(|holders:|legit: verdict|probe:|product test|refined|failed/i.test(l)).map((l) => l.slice(0, 300)).join("\n"));
    const lines = await fetch(A + "/debug/lines").then((r) => r.json()).catch(() => []);
    console.log("--- said:"); for (const l of lines.slice(-6)) console.log(" *", (l.text || JSON.stringify(l)).slice(0, 320));
    if (!done) console.log("(timed out waiting)");
    return;
  }
  setTimeout(poll, 1500);
})();
