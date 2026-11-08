// Keys and settings. Keys are read at runtime from the environment, then app/.env (git-ignored), then the file named
// by PILLBUD_ENV_FILE (set in the environment or in app/.env), for keys kept somewhere shared. Values are never printed
// or logged: only whether each one is present.
const fs = require("node:fs");
const path = require("node:path");

const APP_DIR = path.join(__dirname, "..");
const LOCAL_ENV = path.join(APP_DIR, ".env");
// where the app may write (prefs, the install token, caches, the cost log): the app folder when run from source, the
// user's own app-data folder when installed (an installed app can't write inside its own folder)
const DATA_DIR = (() => {
  if (process.env.PILLBUD_DATA) return process.env.PILLBUD_DATA;
  try { const { app } = require("electron"); if (app && app.isPackaged) return app.getPath("userData"); } catch { /* plain node */ }
  return APP_DIR;
})();
const NEEDED = ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "HELIUS_RPC_URL"];

function parse(file) {
  try {
    return Object.fromEntries(
      fs.readFileSync(file, "utf8").split(/\r?\n/)
        .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l)).filter(Boolean)
        .map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]),
    );
  } catch { return {}; }
}

const SOURCES = [LOCAL_ENV, process.env.PILLBUD_ENV_FILE || parse(LOCAL_ENV).PILLBUD_ENV_FILE].filter(Boolean);

// optional: an X data key turns on X search (see src/research/x.js). Neither exists yet.
const OPTIONAL = ["X_BEARER_TOKEN", "TWITTERAPI_IO_KEY"];
const keys = {};
for (const name of [...NEEDED, ...OPTIONAL]) {
  if (process.env[name]) { keys[name] = process.env[name]; continue; }
  for (const f of SOURCES) { const v = parse(f)[name]; if (v) { keys[name] = v; break; } }
}

const DEFAULTS = {
  port: 47321,                       // the extension posts the coin here
  whisperPort: 47322,                // the local speech-to-text sidecar
  model: "claude-haiku-5-5",         // the take and the answers (small prompts, fast, cheap)
  readModel: "auto",                // the read (what the coin is): auto = Sonnet 5.5 on pro, Haiku 5.5 on free (from the test on live coins)
  voiceId: "cgSgspJ2msm6clMCkdW9",   // ElevenLabs "Jessica - Playful, Bright, Warm" (premade). Candidates: captures/audio/voices/
  // calm and friendly: steadier delivery (stability up), little exaggeration (style down), normal pace
  voiceSettings: { stability: 0.6, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: 1.0 },
  ttsModel: "eleven_turbo_v2_5",     // A/B 2026-11-03: same credits as Flash (0.22/char), full clip ~150 ms sooner (pillbud waits for the whole clip)
  whisperModel: "base.en",           // faster-whisper model (already in the HF cache on this PC)
  stt: "scribe",                     // "scribe" (ElevenLabs, ~0.45 s) or "local" (faster-whisper on this PC, ~1.3 to 2.3 s, private)
  python: "python",
  hotkey: "Control+Shift+Space",     // hold to talk
  lookHotkey: "Control+Shift+L",     // "look closer": read the window in front with Claude's vision (on demand only); falls back to Ctrl+Alt+L, Ctrl+Shift+K
  tabReader: true,                   // read the active browser tab's URL (Windows UI Automation), no extension needed
  watchScreen: true,                 // OCR the window in front every 1.5 s, locally (Windows OCR); only a found coin leaves the PC
  tier: "pro",                       // "free" | "pro": see src/tier.js
  speak: true,                       // false = balloon only, no TTS
  watchEverySec: 10,                 // live price poll
  devEverySec: 15,                   // dev wallet balance poll
  pumpPct: 15,                       // react when the price moves this much...
  dumpPct: 15,
  moveWindowSec: 120,                // ...within this window
  reactCooldownSec: 90,
  clipboard: true,
  whalePct: 0.5,                     // a top-10 holder selling this much of supply at once is a "whale sold" alert
  // the user's own settings (tray menu), saved to prefs.json:
  mode: "text",                      // "text" (default: no speech, soft blips as words appear + event sounds) or "voice" (ElevenLabs, opt-in from the tray)
  textVoice: "beeps",                // Text mode's voice: "babble" (Animalese-style), "beeps" (character beeps) or "blips" (soft, calm)
  tone: "friendly",                  // "friendly" (default) or "unhinged"
  volume: 0.8,                       // 0..1, speech and sounds
  muted: false,                      // no sound at all (text still shows)
  dnd: false,                        // do not disturb: no automatic takes or alerts, only answers when asked
};

const PREFS_DEFAULT = path.join(DATA_DIR, "prefs.json");
const prefsFile = () => process.env.PILLBUD_PREFS || PREFS_DEFAULT; // test instances use their own (never the main one)
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
/** defaults < config.json (developer settings) < prefs.json (the user's tray choices) */
function settings() {
  const s = { ...DEFAULTS, ...readJson(path.join(APP_DIR, "config.json")), ...readJson(prefsFile()) };
  if (process.env.PILLBUD_PORT) { s.port = Number(process.env.PILLBUD_PORT); s.whisperPort = s.port + 1; }
  return s;
}
/** save one of the user's choices (mode, tone, volume, muted, dnd) */
function setPref(k, v) {
  const p = readJson(prefsFile()); p[k] = v;
  fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2) + "\n");
  return settings();
}

// Hosted mode (the downloaded app): with no keys of its own, pillbud runs its research through pillbud-api, which
// holds the keys and is paid for by the $PILLBUD creator fees. Each install makes one random token, kept in DATA_DIR.
const API = process.env.PILLBUD_API || "https://pillbud-api.vercel.app";
function installToken() {
  const f = path.join(DATA_DIR, "install.json");
  let j = readJson(f);
  if (!/^pb_[a-f0-9]{32}$/.test(j.token || "")) {
    j = { token: "pb_" + require("node:crypto").randomBytes(16).toString("hex"), made: new Date().toISOString() };
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2)); } catch { /* a fresh token next run */ }
  }
  return j.token;
}
const HOSTED = process.env.PILLBUD_HOSTED === "1" || !keys.ANTHROPIC_API_KEY || !keys.HELIUS_RPC_URL;
if (HOSTED) {
  const t = installToken();
  Object.assign(keys, {
    ANTHROPIC_API_KEY: t, ANTHROPIC_BASE_URL: `${API}/anthropic`,
    HELIUS_RPC_URL: `${API}/api/helius?t=${t}`, HELIUS_WS_URL: `${API.replace(/^http/, "ws")}/api/feed?t=${t}`,
    ELEVENLABS_API_KEY: t, ELEVENLABS_STT_URL: `${API}/api/stt`,
  });
}

/** which keys were found (names only, never values) */
const keyStatus = () => Object.fromEntries(NEEDED.map((k) => [k, !!keys[k]]));

module.exports = { keys, settings, setPref, keyStatus, APP_DIR, DATA_DIR, HOSTED };
