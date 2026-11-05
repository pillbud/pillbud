// node test/tts-ab.test.js
// ElevenLabs A/B on 5 real takes: Flash v2.5 vs Turbo v2.5 vs v3, each with the raw text and with numbers spoken as
// words (src/speech.js). Measures time to first audio byte (streaming endpoint), total time and credits used, and
// scores intelligibility by running every clip back through local Whisper (small) and computing the word error rate
// against what was meant. Clips go to captures/audio/ab/ to listen to; results to results.txt there.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { keys, settings } = require("../src/env");
const { research } = require("../src/research");
const brain = require("../src/brain");
const { speakable } = require("../src/speech");

const OUT = path.join(__dirname, "..", "captures", "audio", "ab");
const COINS = (process.argv[2] || "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump,7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump,HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump,6Na6huTtPekKeeJpmtpq8mw2ZVAC2qCaRBj8KeB4pump,4yxnt3xAdyBFFbzMWJy9sjGEoiBNkjwdSQZ8ZyULpump").split(",");
const MODELS = ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_v3"];
const XI = "https://api.elevenlabs.io/v1";
const WPORT = 47323;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function used() { const j = await (await fetch(`${XI}/user/subscription`, { headers: { "xi-api-key": keys.ELEVENLABS_API_KEY } })).json(); return j.character_count; }

/** stream one clip: time to first byte, total time, bytes, the credit header */
async function tts(model, text) {
  const s = settings();
  const vs = model === "eleven_v3" ? { stability: 0.5, similarity_boost: 0.75 } : { stability: 0.35, similarity_boost: 0.75, style: 0.45, use_speaker_boost: true, speed: 1.08 };
  const t0 = Date.now();
  const r = await fetch(`${XI}/text-to-speech/${s.voiceId}/stream?output_format=mp3_44100_64`, {
    method: "POST", headers: { "xi-api-key": keys.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: vs }), signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`${model} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const reader = r.body.getReader();
  const chunks = []; let first = null;
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (first == null) first = Date.now() - t0; chunks.push(Buffer.from(value)); }
  return { audio: Buffer.concat(chunks), ttfb: first, total: Date.now() - t0, creditHeader: r.headers.get("character-cost") };
}

/** word error rate between what was meant and what Whisper heard (both normalized to spoken words) */
function wer(ref, hyp) {
  const norm = (s) => speakable(s).toLowerCase().replace(/-/g, " ").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const a = norm(ref), b = norm(hyp);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.round((d[a.length][b.length] / Math.max(1, a.length)) * 1000) / 10;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const whisper = spawn(settings().python, [path.join(__dirname, "..", "src", "whisper_server.py"), "small", String(WPORT)], { windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: "1" } });
  let ready = false; whisper.stdout.on("data", (d) => { if (/ready/.test(String(d))) ready = true; });
  // 1. five real takes
  const takes = [];
  for (const mint of COINS) {
    const f = await research(mint);
    const t = await brain.take(f.facts);
    takes.push({ symbol: f.symbol.replace(/[^A-Za-z0-9]/g, ""), text: t.text });
    console.log(`take $${f.symbol}: ${t.text}\n`);
  }
  for (let i = 0; i < 120 && !ready; i++) await sleep(500);
  if (!ready) throw new Error("whisper didn't start");
  // 2. every take x model x (raw | words)
  const rows = [];
  for (const [n, tk] of takes.entries()) {
    for (const model of MODELS) {
      for (const variant of ["raw", "words"]) {
        const text = variant === "words" ? speakable(tk.text) : tk.text;
        const before = await used();
        let res;
        try { res = await tts(model, text); } catch (e) { console.log(`  ${tk.symbol} ${model} ${variant}: ${e.message}`); rows.push({ take: n + 1, symbol: tk.symbol, model, variant, error: e.message }); continue; }
        await sleep(1200);
        const after = await used();
        const file = path.join(OUT, `${n + 1}-${tk.symbol}-${model.replace("eleven_", "")}-${variant}.mp3`);
        fs.writeFileSync(file, res.audio);
        const heard = await (await fetch(`http://127.0.0.1:${WPORT}/transcribe`, { method: "POST", headers: { "content-type": "audio/mpeg" }, body: res.audio })).json();
        const row = { take: n + 1, symbol: tk.symbol, model, variant, chars: text.length, ttfb: res.ttfb, total: res.total, credits: after - before, creditHeader: res.creditHeader, audioSec: heard.audio_s, wer: wer(tk.text, heard.text), heard: heard.text, file: path.basename(file) };
        rows.push(row);
        console.log(`  ${tk.symbol.padEnd(8)} ${model.padEnd(18)} ${variant.padEnd(5)} first audio ${String(res.ttfb).padStart(5)} ms, done ${String(res.total).padStart(5)} ms, ${row.credits} credits (header ${res.creditHeader}) for ${row.chars} chars, ${heard.audio_s}s, WER ${row.wer}%`);
      }
    }
  }
  whisper.kill();
  // 3. summary per model x variant
  const ok = rows.filter((r) => !r.error);
  const lines = ["model x variant            avg first audio  avg done   avg credits/take  credits/char  avg WER", ""];
  for (const model of MODELS) for (const variant of ["raw", "words"]) {
    const g = ok.filter((r) => r.model === model && r.variant === variant);
    if (!g.length) { lines.push(`${model} ${variant}: no clips`); continue; }
    const avg = (k) => Math.round(g.reduce((s, r) => s + r[k], 0) / g.length);
    const cpc = (g.reduce((s, r) => s + r.credits, 0) / g.reduce((s, r) => s + r.chars, 0)).toFixed(2);
    lines.push(`${`${model} ${variant}`.padEnd(27)}${String(avg("ttfb")).padStart(8)} ms ${String(avg("total")).padStart(8)} ms ${String(avg("credits")).padStart(12)} ${cpc.padStart(14)} ${(g.reduce((s, r) => s + r.wer, 0) / g.length).toFixed(1).padStart(9)}%`);
  }
  const report = [...lines, "", "takes:", ...takes.map((t, i) => `${i + 1}. $${t.symbol}: ${t.text}`), "", "every clip (what Whisper heard):", ...rows.map((r) => r.error ? `${r.take} ${r.model} ${r.variant}: ERROR ${r.error}` : `${r.file}: WER ${r.wer}% | ${r.heard}`)].join("\n");
  fs.writeFileSync(path.join(OUT, "results.txt"), report + "\n");
  console.log("\n" + lines.join("\n"));
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
