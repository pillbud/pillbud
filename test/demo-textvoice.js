// node test/demo-textvoice.js [a|b|c ...]   (default: all three)
// Records captures/demos/textvoice-<a|b|c>.mp4: the real page (renderer/index.html, the real character rig) typing 4 real
// replies (captures/demos/replies.json, captured from the app) in one Text-mode voice style, with sound.
// Headless: Chromium with no window. Time is virtual (Playwright's clock), so each frame is stepped exactly 1/30 s and
// screenshotted; every sound the voice plays is logged with its virtual time and rendered offline afterwards by the same
// synth (TextVoice.render), so picture and sound line up to the sample. ffmpeg muxes the frames and the WAV.
// Needs playwright-core (PLAYWRIGHT_CORE=<path>, default: the copy in ../../evolve) and ffmpeg on PATH.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || path.join(__dirname, "..", "..", "..", "evolve", "node_modules", "playwright-core"));
const { spritePack } = require("../src/sprites");
const { settings } = require("../src/env");

const APP = path.join(__dirname, "..");
const OUT = path.join(APP, "captures", "demos");
const FPS = 30, W = 420, H = 680, SCALE = 2, GAP_MS = 350, END_MS = 1600, MAX_MS = 21000;
const STYLES = { a: ["babble", "a) Babble, Animalese-style"], b: ["beeps", "b) Character beeps"], c: ["blips", "c) Soft blips"] };
const { replies } = JSON.parse(fs.readFileSync(path.join(OUT, "replies.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(key) {
  const [style, label] = STYLES[key];
  const frames = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `pillbud-demo-${key}-`));
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  page.on("console", (m) => { if (/page error|rejection|failed/.test(m.text())) console.log(`  [page] ${m.text()}`); });
  const pack = spritePack(settings().character);
  // the bridge the Electron preload normally provides, as a stand-in (muted: sounds are logged, not played live)
  await page.addInitScript(({ pack, style }) => {
    window.__voiceLog = [];
    const d = window.__demo = { handlers: {}, typed: [], done: [], ready: false };
    window.__emit = (ch, data) => (d.handlers[ch] || []).forEach((f) => f(data));
    window.pillbud = {
      on: (ch, fn) => { (d.handlers[ch] = d.handlers[ch] || []).push(fn); },
      lineDone: (id) => d.done.push(id), linePlaying: () => {}, lineTyped: (id) => d.typed.push(id),
      ready: () => { d.ready = true; }, expand: () => true, compact: () => {}, interactive: () => {}, moveBy: () => {},
      askAudio: async () => {}, sprites: async () => pack, prefs: async () => ({ mode: "text", textVoice: style, tone: "friendly", volume: 0.8, muted: true }),
      sfxExport: () => {}, log: (s) => console.log(`[page] ${s}`),
    };
  }, { pack, style });
  await page.clock.install({ time: new Date("2026-11-04T15:00:00") });
  await page.goto(pathToFileURL(path.join(APP, "renderer", "index.html")).href);
  // a soft backdrop (the real window is transparent over the desktop) and a small label saying which style this is
  await page.addStyleTag({ content: `html, body { background: linear-gradient(160deg, #eef2f8 0%, #dde5f0 100%) !important; }
    #demo-label { position: fixed; left: 14px; top: 12px; font: 600 12px/1.3 "Segoe UI", sans-serif; color: #44506a; background: rgba(255,255,255,.72); border-radius: 6px; padding: 5px 9px; }` });
  await page.evaluate((t) => { const el = document.createElement("div"); el.id = "demo-label"; el.textContent = `pillbud Text voice: ${t}`; document.body.append(el); }, label);
  for (let i = 0; i < 100; i++) { if (await page.evaluate(() => window.__demo.ready && !!document.querySelector("#char svg"))) break; await sleep(100); }
  await sleep(300);
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 400));
  await page.clock.runFor(500); // settle
  const t0 = await page.evaluate(() => performance.now());

  let next = 0, waitUntil = 300, lastTyped = null, lineId = 0, ms = 0, frame = 0;
  for (; ms <= MAX_MS; frame++) {
    const st = await page.evaluate(() => ({ typed: window.__demo.typed.length, done: window.__demo.done.length }));
    if (next < replies.length && ms >= waitUntil && st.done >= next) { // the app sends the next line when the last one is done
      const r = replies[next];
      await page.evaluate((m) => window.__emit("line", m), { id: ++lineId, text: r.text, kind: r.kind, mood: r.mood || "talk", sfx: r.sfx, coin: r.coin, heard: r.heard, append: false, audio: "text", readMs: 1100 });
      next++;
    }
    if (st.typed > (lastTyped ?? 0)) { lastTyped = st.typed; waitUntil = ms + GAP_MS; if (st.typed === replies.length) { /* finish after a beat */ } }
    if (lastTyped === replies.length && ms >= waitUntil + END_MS) break;
    await page.screenshot({ path: path.join(frames, `${String(frame).padStart(5, "0")}.png`) });
    const step = Math.round(((frame + 1) * 1000) / FPS) - Math.round((frame * 1000) / FPS);
    await page.clock.runFor(step);
    ms += step;
  }
  const seconds = frame / FPS;
  const wavB64 = await page.evaluate(async ({ t0, seconds }) => {
    const bytes = await window.TextVoice.render(window.__voiceLog, t0, seconds);
    let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, { t0, seconds });
  const sounds = await page.evaluate(() => window.__voiceLog.length);
  await browser.close();
  const wav = path.join(frames, "audio.wav");
  fs.writeFileSync(wav, Buffer.from(wavB64, "base64"));
  const out = path.join(OUT, `textvoice-${key}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(frames, "%05d.png"), "-i", wav,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out]);
  fs.copyFileSync(wav, path.join(OUT, `textvoice-${key}.wav`));
  fs.rmSync(frames, { recursive: true, force: true });
  console.log(`${path.basename(out)}: ${style}, ${seconds.toFixed(1)} s, ${frame} frames, ${sounds} sounds, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

(async () => {
  const keys = process.argv.slice(2).filter((k) => STYLES[k]);
  for (const k of keys.length ? keys : Object.keys(STYLES)) await record(k);
})().catch((e) => { console.error(e); process.exit(1); });
