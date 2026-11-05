// node test/screen-live.js [minutes]   (start: PILLBUD_TEST=1 PILLBUD_PORT=47341 PILLBUD_TEST_SCREEN=1 electron .)
// The screen watcher on the real screen in DRY RUN (finds coins, never researches them) for N minutes. Reports only
// counts and timings, plus a 4-character prefix of any coin found: never the screen's text.
const { execSync } = require("node:child_process");
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47341";
const mins = Number(process.argv[2] || 10);
const j = async (p) => (await fetch(A + p)).json();
const cpuMs = (pid) => { try { return Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds"`).toString().trim()); } catch { return null; } };
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/status"); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  await new Promise((r) => setTimeout(r, 5000));
  const h0 = (await j("/debug/health")).screen, c0 = cpuMs(h0.pid), t0 = Date.now();
  setTimeout(async () => {
    const h1 = (await j("/debug/health")).screen, c1 = cpuMs(h1.pid), secs = (Date.now() - t0) / 1000;
    const finds = (await j("/debug/log")).filter((l) => /screen: found/.test(l)).map((l) => l.replace(/^\S+ \S+ /, ""));
    console.log(`${mins} min on the real screen: ${h1.frames - h0.frames} frames OCR'd (unchanged frames skipped), OCR avg ${h1.frames > h0.frames ? Math.round((h1.ocrMs - h0.ocrMs) / (h1.frames - h0.frames)) : "-"} ms, max ${h1.maxOcrMs} ms`);
    console.log(`helper CPU: ${Math.round(c1 - c0)} ms in ${Math.round(secs)} s = ${(((c1 - c0) / (secs * 1000)) * 100).toFixed(2)}% of one core`);
    console.log(`candidates looked up: ${h1.candidates - h0.candidates}, coins found: ${h1.triggers - h0.triggers}, rejected: ${h1.rejected - h0.rejected}`);
    finds.forEach((f) => console.log("  " + f));
    process.exit(0);
  }, mins * 60000);
})();
