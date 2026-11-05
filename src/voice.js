// Voice: text-to-speech for pillbud's lines, and speech-to-text for push-to-talk.
//   TTS: ElevenLabs (the character voice). If ElevenLabs refuses (e.g. the subscription's payment failed) or is
//        unreachable, pillbud falls back to Windows' built-in voice, pitched up on playback, so it never goes mute.
//   STT: local faster-whisper sidecar (src/whisper_server.py, kept loaded: a short question takes about a second).
//        If the sidecar isn't up, ElevenLabs Scribe with the same key.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { keys, settings } = require("./env");
const costs = require("./costs");
const { speakable } = require("./speech");

const XI = "https://api.elevenlabs.io/v1";
let elevenDownUntil = 0, elevenWhy = null;

async function elevenlabs(text, kind) {
  const s = settings();
  const t0 = Date.now();
  const r = await fetch(`${XI}/text-to-speech/${s.voiceId}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": keys.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: s.ttsModel, voice_settings: s.voiceSettings }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    let why = `HTTP ${r.status}`;
    try { const j = await r.json(); why = j.detail?.code || j.detail?.status || why; } catch { /* keep the status */ }
    const err = new Error(`ElevenLabs TTS refused: ${why}`);
    err.account = r.status === 401 || r.status === 402 || r.status === 429;
    throw err;
  }
  const audio = Buffer.from(await r.arrayBuffer());
  costs.log({ kind: `tts:${kind}`, engine: "elevenlabs", model: s.ttsModel, chars: text.length, ms: Date.now() - t0 });
  return { audio, mime: "audio/mpeg", rate: 1, engine: `ElevenLabs ${s.ttsModel}` };
}

// ------------------------------------------------------------------ the Windows voice (backup)
let sapi = null, sapiBuf = "", sapiId = 0, sapiReady = null, sapiReadyOk = null;
const sapiWait = new Map();
function sapiStart() {
  if (sapi) return;
  sapiReady = new Promise((ok) => { sapiReadyOk = ok; });
  const script = fs.readFileSync(path.join(__dirname, "sapi_tts.ps1"), "utf8");
  sapi = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, env: { ...process.env, PILLBUD_SAPI_VOICE: settings().sapiVoice || "Microsoft David Desktop" } });
  sapi.stdout.on("data", (d) => {
    sapiBuf += String(d);
    let i;
    while ((i = sapiBuf.indexOf("\n")) >= 0) {
      const line = sapiBuf.slice(0, i).trim(); sapiBuf = sapiBuf.slice(i + 1);
      const m = /^(ok|err) (\d+) ?(.*)$/.exec(line);
      if (m && sapiWait.has(+m[2])) { const w = sapiWait.get(+m[2]); sapiWait.delete(+m[2]); m[1] === "ok" ? w.ok() : w.no(new Error(m[3])); }
      else if (/^ready/.test(line)) sapiReadyOk();
      else if (line) console.log(`[windows voice] ${line.slice(0, 160)}`);
    }
  });
  sapi.stderr.on("data", (d) => { const t = String(d).trim(); if (t && t !== "#< CLIXML") console.log(`[windows voice] ${t.slice(0, 300)}`); });
  sapi.on("exit", () => { sapi = null; for (const w of sapiWait.values()) w.no(new Error("windows voice exited")); sapiWait.clear(); });
}
async function windowsVoice(text, kind) {
  sapiStart();
  // PowerShell swallows stdin written before the script runs, so wait for its "ready" line first
  await Promise.race([sapiReady, new Promise((ok) => setTimeout(ok, 15000))]);
  const t0 = Date.now();
  const id = ++sapiId;
  const out = path.join(os.tmpdir(), `pillbud-${process.pid}-${id}.wav`);
  await new Promise((ok, no) => {
    sapiWait.set(id, { ok, no });
    sapi.stdin.write(JSON.stringify({ id, out, text }) + "\n");
    setTimeout(() => { if (sapiWait.delete(id)) no(new Error("windows voice timed out")); }, 20000);
  });
  const audio = fs.readFileSync(out);
  fs.rm(out, () => {});
  costs.log({ kind: `tts:${kind}`, engine: "windows", chars: text.length, ms: Date.now() - t0 });
  // played at a normal pace (it used to be sped up 1.18x for a squeaky BonziBuddy sound: too much)
  return { audio, mime: "audio/wav", rate: 1, engine: "Windows voice (ElevenLabs unavailable)" };
}

/** streamed speech: onChunk(Buffer) gets the mp3 as it's generated, so playback starts on the first chunk.
 *  Resolves { mime, rate, engine, ttfbMs, chars } when the clip is complete. Falls back to the Windows voice (one chunk). */
async function speakStream(shown, kind, onChunk) {
  const text = speakable(shown);
  const s = settings();
  if (Date.now() > elevenDownUntil && keys.ELEVENLABS_API_KEY && require("./tier").can("elevenlabs")) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${XI}/text-to-speech/${s.voiceId}/stream?output_format=mp3_44100_64`, {
        method: "POST",
        headers: { "xi-api-key": keys.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: s.ttsModel, voice_settings: s.voiceSettings }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) { const e = new Error(`ElevenLabs TTS refused: HTTP ${r.status}`); e.account = r.status === 401 || r.status === 402 || r.status === 429; throw e; }
      const reader = r.body.getReader();
      let ttfb = null;
      for (;;) { const { done, value } = await reader.read(); if (done) break; if (ttfb == null) ttfb = Date.now() - t0; onChunk(Buffer.from(value)); }
      costs.log({ kind: `tts:${kind}`, engine: "elevenlabs", model: s.ttsModel, chars: text.length, credits: r.headers.get("character-cost") ? Number(r.headers.get("character-cost")) : undefined, ttfbMs: ttfb, ms: Date.now() - t0 });
      return { mime: "audio/mpeg", rate: 1, engine: `ElevenLabs ${s.ttsModel}`, ttfbMs: ttfb, chars: text.length, credits: Number(r.headers.get("character-cost")) || null };
    } catch (e) { elevenWhy = e.message; elevenDownUntil = Date.now() + (e.account ? 10 * 60_000 : 60_000); console.log(`${e.message}; using the Windows voice for now`); }
  }
  const w = await windowsVoice(text, kind);
  onChunk(w.audio);
  return { mime: w.mime, rate: w.rate, engine: w.engine, ttfbMs: null, chars: text.length };
}

/** text -> { audio: Buffer, mime, rate, engine }. Numbers, money and percents are spoken as words (src/speech.js):
 *  the balloon shows "$3.0M", the voice says "three million". */
async function speak(shown, kind = "line") {
  const text = speakable(shown);
  if (Date.now() > elevenDownUntil && keys.ELEVENLABS_API_KEY) {
    try { return await elevenlabs(text, kind); }
    catch (e) { elevenWhy = e.message; elevenDownUntil = Date.now() + (e.account ? 10 * 60_000 : 60_000); console.log(`${e.message}; using the Windows voice for now`); }
  }
  return windowsVoice(text, kind);
}

// ------------------------------------------------------------------ speech to text
let sidecar = null, sidecarReady = false;

function startWhisper(log = console.log) {
  const s = settings();
  if (sidecar) return;
  sidecar = spawn(s.python, [path.join(__dirname, "whisper_server.py"), s.whisperModel, String(s.whisperPort)], { windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1" } });
  sidecar.stdout.on("data", (d) => { const t = String(d).trim(); if (/whisper ready/.test(t)) sidecarReady = true; log(`[whisper] ${t}`); });
  sidecar.stderr.on("data", (d) => { const t = String(d).trim(); if (t && !/warn/i.test(t)) log(`[whisper] ${t.slice(0, 200)}`); });
  sidecar.on("exit", (code) => { log(`[whisper] exited ${code}`); sidecar = null; sidecarReady = false; });
}
function stopVoices() { try { sidecar?.kill(); } catch { /* gone */ } try { sapi?.kill(); } catch { /* gone */ } }

async function transcribeLocal(audio, type) {
  const r = await fetch(`http://127.0.0.1:${settings().whisperPort}/transcribe`, { method: "POST", headers: { "content-type": type }, body: audio, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `whisper ${r.status}`);
  costs.log({ kind: "stt", engine: "local whisper", audioSec: j.audio_s, ms: j.ms });
  return { text: j.text, ms: j.ms, engine: `local faster-whisper ${settings().whisperModel}`, audioSec: j.audio_s };
}

async function transcribeScribe(audio, type) {
  const t0 = Date.now();
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("language_code", "en");
  form.append("file", new Blob([audio], { type }), type.includes("wav") ? "q.wav" : type.includes("mpeg") ? "q.mp3" : "q.webm");
  const r = await fetch(`${XI}/speech-to-text`, { method: "POST", headers: { "xi-api-key": keys.ELEVENLABS_API_KEY }, body: form, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (!r.ok) throw new Error(`ElevenLabs Scribe ${r.status}`);
  costs.log({ kind: "stt", engine: "scribe", ms: Date.now() - t0 });
  return { text: j.text, ms: Date.now() - t0, engine: "ElevenLabs Scribe" };
}

/** audio Buffer -> { text, ms, engine }. Default: ElevenLabs Scribe (0.4 to 0.5 s for a short question, measured
 *  2026-11-03) with local Whisper as the fallback; settings stt: "local" keeps the voice on this PC (1.3 to 2.3 s). */
async function transcribe(audio, type = "audio/webm") {
  if (settings().stt !== "local" && keys.ELEVENLABS_API_KEY) {
    try { return await transcribeScribe(audio, type); } catch (e) { console.log("Scribe failed, using local whisper:", e.message); if (!sidecar) startWhisper(); }
  }
  if (sidecarReady) return transcribeLocal(audio, type);
  return transcribeScribe(audio, type);
}

const status = () => ({ whisper: sidecarReady, elevenlabs: Date.now() > elevenDownUntil, elevenlabsProblem: Date.now() > elevenDownUntil ? null : elevenWhy });

/** start the backup voice early so the first fallback line isn't slow */
function warmUp() { try { sapiStart(); } catch { /* no PowerShell */ } }

module.exports = { warmUp, speakStream, speak, transcribe, startWhisper, stopVoices, status, windowsVoice };
