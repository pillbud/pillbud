// The page: balloon, character, coin chip; lines with streamed voice (MediaSource) or, in Text mode, typed out with
// pillbud's Text-mode voice (textvoice.js: babble, beeps or soft blips); event sounds in Voice mode; push-to-talk
// recording; dragging. Text is set with textContent only (never HTML).
/* global Character, Sfx, TextVoice */
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const balloon = $("balloon"), textEl = $("text"), titleEl = $("title"), heardEl = $("heard");
const detailsEl = $("details"), scrollEl = $("scroll"), tilesEl = $("tiles"), readEl = $("read"), findingsEl = $("findings"), changeEl = $("change"), numbersEl = $("numbers");
const buddy = $("buddy"), chip = $("chip"), rec = $("rec");
const bud = new Character($("char"));
const sfx = new Sfx();
const voice = new TextVoice(sfx);
const TEST = new URLSearchParams(location.search).get("test") === "1"; // test mode: everything runs, nothing is heard
let prefs = { mode: "text", textVoice: "beeps", volume: 0.8, muted: false };
let hideTimer = null, idleTimer = null, lastActive = Date.now(), current = null, card = null;

function applyPrefs(p) {
  prefs = { ...prefs, ...p }; sfx.volume = prefs.volume; sfx.muted = prefs.muted || TEST;
  document.documentElement.style.setProperty("--z", String(prefs.balloonZoom || 1)); // Balloon size (tray)
  document.body.dataset.look = prefs.balloonLook || "brand"; // Balloon look (tray); pillbud is the default
}
window.pillbud.prefs().then(applyPrefs);
window.pillbud.on("prefs", applyPrefs);

// ------------------------------------------------------------------ click-through except on our bits
let interactive = false;
document.addEventListener("mousemove", (e) => {
  const on = !!e.target.closest?.("#balloon:not(.hidden), #buddy, #chip");
  if (on !== interactive) { interactive = on; window.pillbud.interactive(on); }
});

// ------------------------------------------------------------------ the balloon
const clean = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim(); // never raw markdown or tags
// the window is only as big as what's showing: full size with the balloon, just the buddy without it
// (a transparent window is copied out every frame, so pixels cost CPU)
function showBalloon() { clearTimeout(hideTimer); if (balloon.classList.contains("hidden")) window.pillbud.expand(); balloon.classList.remove("hidden"); frames60.active(); }
function hideBalloon() { balloon.classList.add("hidden"); setTimeout(() => { if (balloon.classList.contains("hidden")) window.pillbud.compact(); }, 260); }
function hideBalloonSoon(ms) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!balloon.matches(":hover")) hideBalloon(); else hideBalloonSoon(4000); }, ms); }
window.addEventListener("error", (e) => window.pillbud.log(`page error: ${e.message} @${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => window.pillbud.log(`page rejection: ${e.reason?.message || e.reason}`));
$("close").addEventListener("click", () => hideBalloon());

// ------------------------------------------------------------------ the card (built in main's coinCard; text only, never HTML)
const ICON = { bad: "\u2715", warn: "!", good: "\u2713", info: "i" };
const cap = (t) => { const x = clean(t); return x.charAt(0).toUpperCase() + x.slice(1); };
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = clean(String(text)); return e; }
const isEmpty = () => !tilesEl.childElementCount && !findingsEl.childElementCount && !numbersEl.childElementCount && readEl.classList.contains("hidden") && detailsEl.classList.contains("hidden");

function setCard(c) {
  card = c;
  titleEl.textContent = c ? `$${clean(c.symbol) || "?"}${c.name && c.name.trim() !== c.symbol ? ` · ${clean(c.name)}` : ""}` : "";
  // the stamps: story, holders, their product
  const tiles = c?.tiles || [];
  tilesEl.replaceChildren(...tiles.map((t) => {
    const d = el("div", `tile ${t.level || "info"}`);
    d.append(el("div", "k", t.label), el("div", "tw", t.word));
    if (t.tag) d.append(el("div", "tt", cap(t.tag)));
    d.title = `${t.label}: ${t.word}${t.score != null ? ` (${t.score}/100)` : ""}${t.tag ? `, ${t.tag}` : ""}`;
    return d;
  }));
  // the findings, worst first, each with an icon; the source is on hover
  findingsEl.replaceChildren(...(c?.findings || []).map((x) => {
    const li = el("li", x.level);
    li.append(el("span", `ic ${x.level}`, ICON[x.level] || "i"));
    const b = el("div");
    b.append(el("div", "ft", cap(x.title)));
    if (x.detail) b.append(el("div", "fd", cap(x.detail)));
    li.append(b);
    if (x.source) li.title = `Source: ${clean(x.source)}`;
    return li;
  }));
  // what would change the verdict
  changeEl.replaceChildren();
  if (c?.wouldChange) { const w = cap(c.wouldChange); changeEl.append(el("span", "k", "What would change it"), document.createTextNode(/[.!?]$/.test(w) ? w : `${w}.`)); }
  // the numbers
  const nums = (c?.numbers || []).map(([k, v]) => { const d = el("div", "num"); d.append(el("div", "k", k), el("div", "v", v)); return d; });
  if (c?.now) { const d = el("div", `num wide ${c.now.kind || ""}`); d.append(el("div", "k", "Right now"), el("div", "v", cap(c.now.text) + (c.bonding ? ` · ${c.bonding}` : ""))); nums.push(d); }
  numbersEl.replaceChildren(...nums);
  scrollEl.classList.toggle("empty", isEmpty());
  // chip under the buddy: which coin it's on
  if (!c) { chip.classList.add("hidden"); return; }
  $("chip-img").src = c.image || "";
  $("chip-text").textContent = `on $${clean(c.symbol) || "?"} · ${c.mint.slice(0, 4)}…${c.mint.slice(-4)}`;
  chip.title = c.mint;
  chip.classList.remove("hidden");
  bud.mood(c.mood || 0);
}
window.pillbud.on("coin", (c) => { if (!c) { for (const e of [detailsEl, readEl]) { e.classList.add("hidden"); e.replaceChildren(); } } setCard(c); });

window.pillbud.on("details", (d) => {
  // the read: the whole of it (the balloon's text shows one line at a time), then the source it points at
  readEl.replaceChildren();
  if (d.whatItIs) readEl.append(el("div", "k", "The read"), el("p", "rt", d.whatItIs));
  const box = el("div", "srcbox");
  if (d.source) box.append(el("div", "sk", d.source === "nothing readable is linked" ? "Nothing readable is linked" : cap(d.source)));
  const says = d.says ? d.says.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim() : ""; // links aren't words
  if (says && says !== '""') box.append(el("div", "q", says));
  else if (d.image && !/not read in time/.test(d.image)) box.append(el("div", "q", `The picture: ${d.image}`));
  if (d.receipt) box.append(el("div", "lk", cap(d.receipt)));
  if (box.childElementCount) readEl.append(box);
  readEl.classList.toggle("hidden", !readEl.childElementCount);
  // deep research brings more sections
  const rows = [["Why now", d.whyNow], ["The story", d.story && `${d.story}${d.storyReal && d.storyReal !== "unknown" ? ` (real: ${d.storyReal})` : ""}`], ["Team / dev", d.team], ["Socials & community", d.socials], ["On X", d.onX], ["Sources", d.sources?.length && (d.story || d.team) ? d.sources.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }).join(", ") : null]].filter(([, v]) => v);
  detailsEl.replaceChildren(...rows.flatMap(([k, v]) => { const h = document.createElement("h4"), p = document.createElement("p"); h.textContent = k; p.textContent = clean(v); return [h, p]; }));
  detailsEl.classList.toggle("hidden", !rows.length);
  scrollEl.classList.toggle("empty", isEmpty());
  showBalloon(); hideBalloonSoon(45000);
});

/** lay out every word of a line up front (invisible), so revealing never reflows */
function layWords(text, append) {
  if (!append) textEl.replaceChildren();
  else textEl.append(document.createTextNode(" "));
  const spans = clean(text).split(" ").map((w, i, a) => { const s = document.createElement("span"); s.className = "w"; s.textContent = i < a.length - 1 ? `${w} ` : w; return s; });
  textEl.append(...spans);
  return spans;
}

// ------------------------------------------------------------------ moods
const REACT_MOOD = { celebrate: 1, panic: -0.85, rugged: -1 };
function mood(m, holdMs = 0) {
  lastActive = Date.now();
  bud.set(m);
  if (m === "idle" || m === "sleep") frames60.idle(m); else frames60.active(holdMs || 4000);
  clearTimeout(idleTimer);
  if (holdMs) idleTimer = setTimeout(() => { if (!current) { bud.set("idle"); frames60.idle("idle"); } }, holdMs);
}
// status ("checking X...", "listening") has its own line, so it never overwrites words being spoken
window.pillbud.on("mood", ({ mood: m, text, clear, hold }) => {
  if (!current) mood(m, hold || 0);
  if (clear) { setCard(null); heardEl.textContent = ""; textEl.replaceChildren(); statusEl.textContent = ""; }
  if (text != null) { statusEl.textContent = clean(text); showBalloon(); }
});

// ------------------------------------------------------------------ lines
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const lines = new Map(); // id -> { meta, chunks, player, ended }

window.pillbud.on("line", (meta) => {
  const L = { meta, chunks: [], player: null, end: null, stopped: false };
  lines.set(meta.id, L);
  current = L;
  playLine(L).catch((e) => window.pillbud.log(`line: ${e.message}`)).finally(() => {
    lines.delete(meta.id);
    if (current === L) current = null;
    if (!L.stopped) window.pillbud.lineDone(meta.id);
  });
});
window.pillbud.on("line-audio", ({ id, chunk }) => { const L = lines.get(id); if (!L) return; L.chunks.push(chunk); L.player?.push(chunk); });
window.pillbud.on("line-audio-end", ({ id, mime, rate, failed }) => { const L = lines.get(id); if (!L) return; L.end = { mime, rate, failed }; L.player?.end(L.end); L.onEnd?.(); });
window.pillbud.on("hush", () => { if (current) { current.stopped = true; current.stop?.(); } });

async function playLine(L) {
  const m = L.meta;
  if (m.coin) setCard(m.coin);
  if (m.kind === "answer" || m.kind === "reaction" || m.coin?.verdict) statusEl.textContent = "";
  heardEl.textContent = m.heard ? `You: “${clean(m.heard)}”` : m.append ? heardEl.textContent : "";
  const spans = layWords(m.text, m.append);
  showBalloon();
  mood(m.mood || "talk");
  if (REACT_MOOD[m.mood] != null) bud.mood(REACT_MOOD[m.mood]);
  if (m.sfx && m.audio === "stream") sfx.play(m.sfx); // in Text mode the voice's own reaction ("ooh!", "aww", "hm?") says it
  if (m.audio === "stream") await playVoice(L, spans);
  else await typeOut(L, spans);
  bud.talk(false);
  const hold = m.mood === "celebrate" || m.mood === "panic" || m.mood === "rugged" ? 3500 : 600;
  mood(m.mood === "rugged" ? "rugged" : "idle", hold);
  if (REACT_MOOD[m.mood] != null) setTimeout(() => bud.mood(card?.mood || 0), 6000);
  hideBalloonSoon(m.kind === "take" ? 25000 : 15000);
}

/** how a line feels, for the Text-mode voice: curious on a LARP, sad on a dump or rug, happy on a pump */
function emotionOf(m) {
  const t = m.text || "";
  if (m.sfx === "larp" || /\b(LARP|copycat|unverified)\b/i.test(t)) return "curious";
  if (m.sfx === "dump" || m.sfx === "rug" || m.mood === "panic" || m.mood === "rugged") return "sad";
  if (m.sfx === "pump" || m.sfx === "legit" || m.mood === "celebrate" || m.mood === "wave") return "happy";
  return "neutral";
}

/** Text mode (or no voice): type the words out in pillbud's Text-mode voice, then leave time to read */
async function typeOut(L, spans) {
  bud.talk(true);
  const words = spans.map((s) => s.textContent.trim());
  const plan = prefs.mode !== "voice" ? voice.plan(words, { style: prefs.textVoice || "beeps", emotion: emotionOf(L.meta) }) : null;
  window.pillbud.linePlaying(L.meta.id);
  if (plan?.lead && !L.stopped) { voice.play(plan.lead.events); await wait(plan.lead.dur); }
  for (let i = 0; i < spans.length; i++) {
    if (L.stopped) break;
    spans[i].classList.add("on");
    const w = plan?.words[i];
    if (w) { voice.play(w.events); await wait(w.dur + w.pause); }
    else await wait(45 + words[i].length * 22);
  }
  bud.talk(false);
  window.pillbud.lineTyped?.(L.meta.id); // (the demo recorder listens for this)
  if (!L.stopped) await wait(L.meta.readMs ?? Math.min(4000, 900 + L.meta.text.length * 28));
}

/** streamed voice: MediaSource fed with the mp3 chunks as they arrive; the words follow the audio */
function streamPlayer() {
  const audio = new Audio(), ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  audio.muted = TEST || prefs.muted; audio.volume = prefs.volume;
  let sb = null, ended = false;
  const q = [];
  const feed = () => { if (!sb || sb.updating) return; if (q.length) sb.appendBuffer(q.shift()); else if (ended && ms.readyState === "open") { try { ms.endOfStream(); } catch { /* already ended */ } } };
  ms.addEventListener("sourceopen", () => { sb = ms.addSourceBuffer("audio/mpeg"); sb.mode = "sequence"; sb.addEventListener("updateend", feed); feed(); });
  return { audio, push(c) { q.push(c instanceof Uint8Array ? c : new Uint8Array(c)); feed(); }, end() { ended = true; feed(); } };
}

async function playVoice(L, spans) {
  const m = L.meta;
  // an mp3 stream: play it as it arrives. (The Windows backup voice sends one WAV at the end instead.)
  const p = streamPlayer();
  L.player = p;
  for (const c of L.chunks) p.push(c);
  if (L.end) p.end(L.end);
  const audio = p.audio;
  L.stop = () => { audio.pause(); audio.onended?.(); };
  let playingSent = false;
  audio.addEventListener("playing", () => { if (!playingSent) { playingSent = true; window.pillbud.linePlaying(m.id); } });
  bud.talk(true);
  const total = m.text.length;
  const starts = []; let n = 0; for (const s of spans) { starts.push(n / total); n += s.textContent.length; }
  await new Promise((resolve) => {
    let raf, done = false;
    const finish = () => {
      if (done) return; done = true; cancelAnimationFrame(raf); spans.forEach((s) => s.classList.add("on"));
      // free the clip: no audio element, MediaSource or object URL outlives its line
      try { audio.pause(); URL.revokeObjectURL(audio.src); audio.removeAttribute("src"); audio.load(); } catch { /* already gone */ }
      L.chunks = []; L.player = null;
      resolve();
    };
    const frame = () => {
      // until the stream ends its duration is unknown: estimate ~14 spoken characters a second
      const d = isFinite(audio.duration) && L.end ? audio.duration : Math.max(1, total / 14);
      const p = Math.min(1, (audio.currentTime / d) * 1.06);
      spans.forEach((s, i) => { if (starts[i] <= p) s.classList.add("on"); });
      raf = requestAnimationFrame(frame);
    };
    audio.onended = finish;
    audio.onerror = () => { window.pillbud.log(`audio error ${audio.error?.code}`); finish(); };
    L.onEnd = () => {
      if (L.end?.failed) { finish(); return; }
      if (L.end?.mime && L.end.mime !== "audio/mpeg") { // the WAV backup voice: play the whole clip
        audio.pause();
        const a2 = new Audio(URL.createObjectURL(new Blob(L.chunks, { type: L.end.mime })));
        a2.muted = TEST || prefs.muted; a2.volume = prefs.volume; a2.preservesPitch = false; a2.playbackRate = L.end.rate || 1;
        a2.addEventListener("playing", () => { if (!playingSent) { playingSent = true; window.pillbud.linePlaying(m.id); } });
        a2.onended = finish; a2.onerror = finish; L.stop = () => { a2.pause(); finish(); };
        a2.play().catch(finish);
      }
    };
    if (L.end) L.onEnd();
    audio.play().then(frame).catch(() => frame());
    setTimeout(finish, 60000); // never hang on a broken clip
  });
}

// ------------------------------------------------------------------ push-to-talk recording
let recorder = null, chunks = [], recStart = 0, stream = null;
let recWanted = false; // false once the keys are let go (or the hold turns out to be a shortcut) before the mic is ready
async function startRec() {
  if (recorder) return;
  recWanted = true;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
  catch (e) { layWords(`I can't hear you: the microphone is blocked (${e.name}).`).forEach((s) => s.classList.add("on")); showBalloon(); window.pillbud.log(`mic: ${e.message}`); return; }
  if (!recWanted) { stream.getTracks().forEach((t) => t.stop()); return; }
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start(100);
  recStart = Date.now();
  rec.classList.remove("hidden");
  mood("listen");
  if (current) { current.stopped = true; current.stop?.(); } // talking over it: it stops and listens
  sfx.play("blip", "o");
  heardEl.textContent = ""; layWords("Listening... let go when you're done.").forEach((s) => s.classList.add("on")); showBalloon();
}
async function stopRec() {
  recWanted = false;
  if (!recorder) return;
  const r = recorder; recorder = null;
  rec.classList.add("hidden");
  const done = new Promise((ok) => { r.onstop = ok; });
  r.stop(); await done;
  stream.getTracks().forEach((t) => t.stop());
  if (Date.now() - recStart < 450) { layWords("Hold a bit longer and ask me something!").forEach((s) => s.classList.add("on")); hideBalloonSoon(3000); bud.set("idle"); return; }
  layWords("Got it, thinking...").forEach((s) => s.classList.add("on"));
  await window.pillbud.askAudio(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer(), "audio/webm");
}
/** the hold was a shortcut after all (Ctrl + Alt + L...): stop listening, send nothing */
function cancelRec() {
  recWanted = false;
  if (!recorder) return;
  const r = recorder; recorder = null;
  rec.classList.add("hidden");
  try { r.stop(); } catch { /* already stopped */ }
  stream?.getTracks().forEach((t) => t.stop());
  chunks = [];
  bud.set("idle");
  hideBalloonSoon(600);
}
window.pillbud.on("ptt", (what) => (what === "start" ? startRec() : what === "cancel" ? cancelRec() : stopRec()));

// ------------------------------------------------------------------ drag to move, click-and-hold to talk, click to re-open
let down = null;
buddy.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  buddy.setPointerCapture(e.pointerId);
  down = { x: e.screenX, y: e.screenY, lx: e.screenX, ly: e.screenY, drag: false, talk: false };
  down.timer = setTimeout(() => { if (down && !down.drag) { down.talk = true; startRec(); } }, 320);
});
buddy.addEventListener("pointermove", (e) => {
  if (!down) return;
  if (!down.drag && !down.talk && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 5) { down.drag = true; clearTimeout(down.timer); buddy.classList.add("dragging"); frames60.active(); }
  if (down.drag) { window.pillbud.moveBy(e.screenX - down.lx, e.screenY - down.ly); down.lx = e.screenX; down.ly = e.screenY; }
});
buddy.addEventListener("pointerup", () => {
  if (!down) return;
  clearTimeout(down.timer);
  const d = down; down = null;
  buddy.classList.remove("dragging");
  if (d.talk) stopRec();
  else if (!d.drag) { if (balloon.classList.contains("hidden")) { showBalloon(); hideBalloonSoon(15000); } else hideBalloon(); }
});

// ------------------------------------------------------------------ sounds out to files (to listen to them)
window.pillbud.on("sfx-export", async () => { for (const n of window.SFX_NAMES) window.pillbud.sfxExport(n, await sfx.render(n)); });

// ------------------------------------------------------------------ nap when nothing happens for a while
setInterval(() => { if (!current && !recorder && Date.now() - lastActive > 8 * 60_000 && bud.state !== "sleep") { bud.set("sleep"); frames60.idle("sleep"); } }, 15000);
// while a line plays, recording, or dragging: keep the full frame rate topped up
setInterval(() => { if (current || recorder || down) frames60.active(1500); }, 1000);
window.pillbud.on("visible", (v) => frames60.pause(!v)); // hidden from the tray: no animation at all

bud.load().then(() => window.pillbud.log("character loaded")).catch((e) => window.pillbud.log(`character failed: ${e.message}`));
// every listener above is registered: lines can come now
window.pillbud.ready();
