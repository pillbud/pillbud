// node test/voice-loop.test.js [mint]
// The push-to-talk loop end to end, with no window and nothing played aloud:
//   question audio (Windows' Zira voice stands in for the trader's mic) -> local Whisper -> research facts ->
//   Claude's answer -> text to speech (ElevenLabs, or the Windows backup voice) -> saved to captures/audio/
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const voice = require("../src/voice");
const brain = require("../src/brain");
const { research } = require("../src/research");

const MINT = process.argv[2] || "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump";
const OUT = path.join(__dirname, "..", "captures", "audio");
const QUESTIONS = ["Hey pillbud, is the dev selling?", "Who are the top holders?", "What is the chart doing right now?"];

/** the trader's voice: a one-off Windows speech call with a different voice than pillbud's */
function traderSays(text, file) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop'); $s.SetOutputToWaveFile('${file}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
  return fs.readFileSync(file);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  voice.startWhisper(() => {});
  const facts = (await research(MINT)).facts;
  console.log(`researched $${facts.coin.symbol}`);
  const until = Date.now() + 90000;
  while (!voice.status().whisper && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  if (!voice.status().whisper) throw new Error("whisper sidecar didn't start");
  const history = [];
  for (const [i, q] of QUESTIONS.entries()) {
    const qFile = path.join(OUT, `q${i + 1}-trader.wav`);
    const audio = traderSays(q, qFile);
    const t0 = Date.now();
    const heard = await voice.transcribe(audio, "audio/wav");
    const t1 = Date.now();
    const a = await brain.answer(heard.text, facts, history);
    history.push({ q: heard.text, a: a.text });
    const t2 = Date.now();
    const spoken = await voice.speak(a.text, "answer");
    const t3 = Date.now();
    const aFile = path.join(OUT, `q${i + 1}-pillbud-answer.${spoken.mime.includes("wav") ? "wav" : "mp3"}`);
    fs.writeFileSync(aFile, spoken.audio);
    console.log(`\nQ${i + 1} said:   "${q}"`);
    console.log(`   heard:  "${heard.text}"  (${heard.engine}, ${heard.ms} ms for ${heard.audioSec}s of audio)`);
    console.log(`   answer: "${a.text}"  (${a.model}, ${a.usage.input} in / ${a.usage.output} out tokens, ${t2 - t1} ms)`);
    console.log(`   voice:  ${spoken.engine}, ${a.text.length} chars, ${t3 - t2} ms -> ${path.basename(aFile)}`);
    console.log(`   total from end of speech to reply audio ready: ${t3 - t0} ms`);
  }
  voice.stopVoices();
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); voice.stopVoices(); process.exit(1); });
