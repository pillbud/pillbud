// node test/v3-anims.js p100|p150   (a hidden test instance on 47341: PILLBUD_TEST=1 PILLBUD_PORT=47341 [PILLBUD_SCALE=1.5] electron .)
// Every animation of the character pack, four moments each (15, 40, 65 and 90% through), with a read in the balloon:
// captures/v3/<prefix>-<state>.png (one strip per animation) and captures/v3/<prefix>-all.png (a contact sheet).
// Also checks every frame: the character drew something, and nothing of it is cut off at the window's edges.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const A = process.env.PILLBUD_URL || "http://127.0.0.1:47341";
const prefix = process.argv[2] || "p100";
const OUT = path.join(__dirname, "..", "captures", "v3");
const TMP = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pillbud-v3-"));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "brand", "sprites", "manifest.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ = "Ooh, this one riffs on a real Elon Musk post from 3 days ago, where he said \"The people deserve to have their RAM too!\" It's the biggest of seven RAMBO coins.";

/** alpha bounding box of a PNG capture (decoded with ffmpeg to raw RGBA) */
function alphaBox(png) {
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", png]).toString().trim().split(",").map(Number);
  const [w, h] = probe;
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 64 * 1024 * 1024 });
  return { w, h, raw };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < 60; i++) { try { await fetch(`${A}/status`); break; } catch { await sleep(1000); } }
  await sleep(5000); // the character loads and preloads
  const report = [];
  const strips = [];
  for (const [state, d] of Object.entries(manifest.states)) {
    const dur = (d.frames.length / (d.fps || 24)) * 1000;
    await fetch(`${A}/debug/anim`, { method: "POST", body: JSON.stringify({ state: "idle", hold: 500 }) });
    await sleep(300);
    const t0 = Date.now();
    await fetch(`${A}/debug/anim`, { method: "POST", body: JSON.stringify({ state, hold: dur + 3000, text: READ, source: "X post by @elonmusk · 241M followers · verified · 3 days ago", receipt: "the biggest of 7 coins on this name" }) });
    const shots = [];
    for (const f of [0.15, 0.4, 0.65, 0.9]) {
      const wait = t0 + f * dur - Date.now();
      if (wait > 0) await sleep(wait);
      const png = path.join(TMP, `${state}-${Math.round(f * 100)}.png`);
      for (let k = 0; k < 6; k++) { // the off-screen renderer can refuse a capture for a moment: retry
        const b = Buffer.from(await (await fetch(`${A}/debug/capture`)).arrayBuffer());
        if (b[0] === 0x89 && b[1] === 0x50) { fs.writeFileSync(png, b); break; }
        await sleep(250);
      }
      shots.push(png);
    }
    // checks: the buddy's box drew pixels; nothing opaque touches the window's left, right or bottom edge
    const issues = [];
    for (const png of shots) {
      const { w, h, raw } = alphaBox(png);
      const a = (x, y) => raw[(y * w + x) * 4 + 3];
      let edge = 0, drawn = 0;
      for (let y = 0; y < h; y++) { if (a(0, y) > 40) edge++; if (a(w - 1, y) > 40) edge++; }
      for (let x = 0; x < w; x++) if (a(x, h - 1) > 40) edge++;
      const s = w / 430; // the buddy's box: left 12, bottom 36, 225 x 250 (CSS px)
      for (let y = Math.round(h - (36 + 250) * s); y < h - 36 * s; y += 3) for (let x = Math.round(12 * s); x < (12 + 225) * s; x += 3) if (a(x, y) > 40) drawn++;
      if (!drawn) issues.push(`${path.basename(png)}: nothing drawn`);
      if (edge) issues.push(`${path.basename(png)}: ${edge} opaque pixels on the window edge`);
    }
    const strip = path.join(OUT, `${prefix}-${state}.png`);
    // over a soft desktop-like backdrop (the real window is transparent), alpha-blended
    const { w, h } = alphaBox(shots[0]);
    execFileSync("ffmpeg", ["-y", "-v", "error", ...shots.flatMap((p) => ["-i", p]), "-f", "lavfi", "-i", `color=c=0xdde5f0:s=${w}x${h}`, "-filter_complex",
      `[4]split=4[b0][b1][b2][b3];${shots.map((_, i) => `[b${i}][${i}]overlay=format=auto[o${i}]`).join(";")};${shots.map((_, i) => `[o${i}]`).join("")}hstack=inputs=4`, "-frames:v", "1", strip]);
    strips.push(strip);
    report.push(`${state.padEnd(10)} ${d.frames.length} frames, ${(dur / 1000).toFixed(1)} s: ${issues.length ? issues.join("; ") : "ok"}`);
    console.log(report.at(-1));
  }
  // a contact sheet at quarter size: one row per animation
  const sheet = path.join(OUT, `${prefix}-all.png`);
  execFileSync("ffmpeg", ["-y", "-v", "error", ...strips.flatMap((p) => ["-i", p]), "-filter_complex", `${strips.map((_, i) => `[${i}]scale=iw/3:-1[s${i}]`).join(";")};${strips.map((_, i) => `[s${i}]`).join("")}vstack=inputs=${strips.length}`, sheet]);
  fs.writeFileSync(path.join(OUT, `${prefix}-report.txt`), report.join("\n") + "\n");
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`strips: captures/v3/${prefix}-<state>.png, contact sheet: captures/v3/${prefix}-all.png`);
})().catch((e) => { console.error(e); process.exit(1); });
