// electron test/probe-live.js <url> ["claim text"] : the product test on a live site, headless (nothing on screen).
// Writes the verdict and findings to captures/probe/run.log (Electron's stdout doesn't always reach a shell on
// Windows) and the two screenshots to captures/probe/ for checking by eye.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const DIR = path.join(__dirname, "..", "captures", "probe");
fs.mkdirSync(DIR, { recursive: true });
const LOG = path.join(DIR, "run.log");
const say = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 1))).join(" "); fs.appendFileSync(LOG, s + "\n"); console.log(s); };
say(`--- ${new Date().toISOString()} ${process.argv.slice(2).join(" ")}`);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {}); // the probe's hidden window closing must not quit the test early
app.whenReady().then(async () => {
  const { productTest } = require("../src/research/probe");
  const { client } = require("../src/brain");
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const url = args.find((a) => /^https?:/.test(a)), claim = { description: args.find((a) => !/^https?:/.test(a) && !a.endsWith(".js")) || "" };
  try {
    const r = await productTest(url, { client, claim, log: (s) => say("  " + s) });
    const slug = new URL(url).host.replace(/[^a-z0-9]+/gi, "-");
    r.shots.forEach((b, i) => fs.writeFileSync(path.join(DIR, `${slug}-${i + 1}.jpg`), b));
    say({ ...r, shots: r.shots.length });
  } catch (e) { say("FAILED", e.stack || e.message); }
  app.exit(0);
});
