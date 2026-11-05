// pillbud's Text-mode voice: the sounds that play while a reply types out. Three styles (tray: Text voice):
//   babble  Animalese-style: every letter is a tiny pitched vocal sound (formant-synthesized vowels through a small
//           "vocal tract"), quick and cute, so it reads as talking
//   beeps   character beeps (Undertale / Banjo-Kazooie style): a warm chiptune "bip" every other letter, in pillbud's
//           own timbre, with the pitch following the line
//   blips   soft blips: one round note per word (the calm option)
// In every style the emotion follows the line: happy on a pump (higher, livelier, a little "ooh!"), sympathetic on a
// dump or rug (lower, slower, an "aww" droop), curious on a LARP (a "hm?" that lifts). A leading reaction word
// ("Ooh," "Aww," "Hm,") is voiced as that melody. Questions lift at the end, sentences settle down, and commas and
// full stops pause. A little seeded pitch variation keeps it from droning (the same line always sounds the same).
// All synthesis is original WebAudio, nothing sampled. Everything is scheduled at exact times, so a recording of
// the events (window.__voiceLog) can be rendered again offline, sample-exact (the demo videos use that).
/* global SfxSynth */
(function () {
  const { N, chain } = window.SfxSynth;

  /** a tiny seeded random */
  function rng(str) {
    let h = 2166136261;
    for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => { h = (h + 0x6d2b79f5) | 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  const EMO = {
    neutral: { pitch: 1, range: 1, rate: 1 },
    happy: { pitch: 1.1, range: 1.35, rate: 1.07 },
    sad: { pitch: 0.87, range: 0.65, rate: 0.85 },
    curious: { pitch: 1.02, range: 1.1, rate: 0.96 },
  };
  const INTERJ = { ooh: "happy", oooh: "happy", ooo: "happy", yay: "happy", whee: "happy", wheee: "happy", aww: "sad", aw: "sad", awww: "sad", oh: "sad", hm: "curious", hmm: "curious", hmmm: "curious" };
  const PAUSE = { ",": 170, ";": 200, ":": 190, ".": 320, "!": 320, "?": 340 };

  // ------------------------------------------------------------------ the sounds (absolute start times)
  const SIZE = 1.18; // formants scaled up: a small creature's voice, cute and never deep
  /** a vowel through a two-formant vocal tract. p: { f, f2, F1, F2, F2a (onset), F1to, F2to, d, v, nasal } */
  function vocal(ac, out, at, p) {
    const end = at + p.d, hold = Math.max(at + 0.008, end - 0.022);
    const src = ac.createOscillator();
    src.type = "sawtooth";
    src.frequency.setValueAtTime(p.f, at);
    src.frequency.linearRampToValueAtTime(p.f2 || p.f, end);
    const pre = ac.createBiquadFilter(); pre.type = "lowpass"; pre.frequency.value = 2800; pre.Q.value = 0.4;
    const b1 = ac.createBiquadFilter(); b1.type = "bandpass"; b1.Q.value = p.nasal ? 3 : 5;
    b1.frequency.setValueAtTime(p.F1 * SIZE, at);
    if (p.F1to) b1.frequency.exponentialRampToValueAtTime(p.F1to * SIZE, end);
    const b2 = ac.createBiquadFilter(); b2.type = "bandpass"; b2.Q.value = 7;
    b2.frequency.setValueAtTime((p.F2a || p.F2) * SIZE, at);
    b2.frequency.exponentialRampToValueAtTime(p.F2 * SIZE, at + Math.min(0.035, p.d * 0.6));
    if (p.F2to) b2.frequency.exponentialRampToValueAtTime(p.F2to * SIZE, end);
    const body = ac.createBiquadFilter(); body.type = "lowpass"; body.frequency.value = 520;
    const g1 = ac.createGain(), g2 = ac.createGain(), gb = ac.createGain(), env = ac.createGain();
    g1.gain.value = p.nasal ? 0.5 : 1; g2.gain.value = p.nasal ? 0.2 : 0.6; gb.gain.value = p.nasal ? 0.2 : 0.16; // a hum sits on the pitch itself: kept softer
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(p.v, at + 0.008);
    env.gain.setValueAtTime(p.v, hold);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(pre); pre.connect(b1); pre.connect(b2); pre.connect(body);
    b1.connect(g1); b2.connect(g2); body.connect(gb); g1.connect(env); g2.connect(env); gb.connect(env); env.connect(out);
    src.start(at); src.stop(end + 0.02);
  }
  /** pillbud's beep: mostly sine with a little square for a chiptune edge, softened by a low-pass. p: { f, f2, d, v } */
  function beep(ac, out, at, p) {
    const end = at + p.d;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1900; lp.Q.value = 0.7;
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(p.v, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    for (const [type, lvl] of [["sine", 0.75], ["square", 0.25]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(p.f, at); o.frequency.exponentialRampToValueAtTime(p.f2 || p.f * 0.985, end);
      g.gain.value = lvl; o.connect(g); g.connect(lp); o.start(at); o.stop(end + 0.02);
    }
    lp.connect(env); env.connect(out);
  }
  /** a soft round note: sine plus a quiet octave. p: { f, f2, d, v } */
  function soft(ac, out, at, p) {
    const end = at + p.d, a = p.a || 0.01;
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(p.v, at + a);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    for (const [mult, lvl] of [[1, 1], [2, 0.14]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(p.f * mult, at);
      if (p.f2) o.frequency.exponentialRampToValueAtTime(p.f2 * mult, end);
      g.gain.value = lvl; o.connect(g); g.connect(env); o.start(at); o.stop(end + 0.02);
    }
    env.connect(out);
  }
  const SYNTH = { vocal, beep, soft };

  // ------------------------------------------------------------------ letters to sounds
  const VOWEL = { a: [750, 1150], e: [520, 1850], i: [320, 2250], o: [560, 880], u: [360, 920], y: [330, 2100] };
  const CONS = { // [F1, F2, F2 at the onset]: lips pull F2 down, the tongue tip pushes it up
    b: [450, 1050, 800], p: [450, 1050, 800], m: [300, 1100, 900], f: [430, 980, 1100], v: [430, 980, 1100], w: [380, 850, 700],
    d: [480, 1650, 1800], t: [480, 1650, 1800], n: [320, 1500, 1700], l: [420, 1350, 1200], s: [460, 1750, 2100], z: [460, 1750, 2100],
    r: [470, 1300, 1150], g: [500, 1450, 2000], k: [500, 1450, 2000], c: [500, 1450, 2000], q: [500, 1100, 1900], x: [500, 1600, 2000],
    h: [620, 1300, 1300], j: [400, 1900, 2100],
  };
  const DIGIT_VOWEL = "oiueaioeua"; // digits babble too, each with its own vowel
  const BASE = { babble: 360, beeps: 520, blips: 1 };
  const VOL = { babble: 0.37, beeps: 0.2, blips: 0.13 }; // measured: all three about -30 dBFS RMS while sounding, peaks under -17

  /** the little reaction melodies: "ooh!" (happy), "aww" (sad, a droop), "hm?" (curious, a lift) */
  function emote(style, emotion, base) {
    const b = base;
    if (style === "babble") {
      const v = VOL.babble;
      if (emotion === "happy") return { dur: 250, events: [{ dt: 0, k: "vocal", p: { f: b * 1.05, f2: b * 1.42, F1: 360, F2: 900, F1to: 560, F2to: 880, d: 0.21, v: v * 0.7 } }] };
      if (emotion === "sad") return { dur: 480, events: [{ dt: 0, k: "vocal", p: { f: b * 1.14, f2: b * 0.74, F1: 760, F2: 1150, F1to: 420, F2to: 860, d: 0.42, v: v * 0.95 } }] };
      if (emotion === "curious") return { dur: 380, events: [
        { dt: 0, k: "vocal", p: { f: b * 0.95, f2: b * 0.9, F1: 280, F2: 1250, nasal: true, d: 0.09, v: v * 0.7 } },
        { dt: 95, k: "vocal", p: { f: b * 0.92, f2: b * 1.32, F1: 280, F2: 1250, nasal: true, d: 0.25, v: v * 0.7 } }] };
    }
    if (style === "beeps") {
      const v = VOL.beeps;
      if (emotion === "happy") return { dur: 290, events: [1, 1.19, 1.5].map((m, i) => ({ dt: i * 75, k: "beep", p: { f: b * m, d: i === 2 ? 0.1 : 0.05, v } })) };
      if (emotion === "sad") return { dur: 480, events: [{ dt: 0, k: "beep", p: { f: b * 1.05, d: 0.09, v } }, { dt: 120, k: "beep", p: { f: b * 0.85, f2: b * 0.68, d: 0.3, v: v * 0.9 } }] };
      if (emotion === "curious") return { dur: 350, events: [{ dt: 0, k: "beep", p: { f: b * 0.9, d: 0.07, v } }, { dt: 100, k: "beep", p: { f: b * 0.95, f2: b * 1.35, d: 0.2, v } }] };
    }
    const v = VOL.blips * 1.4;
    if (emotion === "happy") return { dur: 380, events: [{ dt: 0, k: "soft", p: { f: N(5), d: 0.14, v } }, { dt: 110, k: "soft", p: { f: N(8), d: 0.22, v } }] };
    if (emotion === "sad") return { dur: 480, events: [{ dt: 0, k: "soft", p: { f: N(7), f2: N(3), d: 0.42, v } }] };
    if (emotion === "curious") return { dur: 350, events: [{ dt: 0, k: "soft", p: { f: N(4), f2: N(7), d: 0.28, v } }] };
    return null;
  }

  const letters = (w) => (w.toLowerCase().match(/[a-z0-9]/g) || []);
  const endPunct = (w) => { const m = w.match(/([.!?,;:]|\.\.\.|…)["')\]]*$/); return m ? (m[1] === "..." || m[1] === "…" ? "…" : m[1]) : ""; };

  /**
   * words: the line's words exactly as laid out in the balloon. Returns { lead, words: [{ events, dur, pause }] }:
   * lead = a wordless reaction before the first word (or null); events have dt (ms into the word), k (sound), p.
   */
  function plan(words, { style = "babble", emotion = "neutral" } = {}) {
    if (!BASE[style]) style = "babble";
    const E = EMO[emotion] || EMO.neutral, rnd = rng(`${style}|${words.join(" ")}`);
    const base = BASE[style] * E.pitch;
    // sentence position of every word, for the melody
    const info = []; let start = 0;
    words.forEach((w, i) => { const p = endPunct(w); if (/[.!?…]/.test(p) || i === words.length - 1) { for (let k = start; k <= i; k++) info[k] = { pos: i === start ? 0 : (k - start) / (i - start), last: k === i, end: /[.!?…]/.test(p) ? p : "." }; start = i + 1; } });
    const melody = (i, u) => { // pitch multiplier for word i, at u (0..1) through the word
      const s = info[i]; let m = 1.04 - 0.08 * s.pos;
      if (s.last) {
        if (s.end === "?") m *= 1 + 0.25 * u;
        else if (s.end === "!") m *= 1.07;
        else m *= 1 - (emotion === "sad" ? 0.16 : 0.07) * u;
        if (emotion === "happy" && s.end !== "?" && i === words.length - 1) m *= 1 + 0.05 * u;
      }
      return m;
    };
    const jitter = () => (rnd() * 2 - 1) * 0.045 * E.range;
    const pauseAfter = (w) => { const p = endPunct(w); return Math.round((p === "…" ? 380 : PAUSE[p] || 0) / E.rate); };

    const first = (words[0] || "").toLowerCase().replace(/[^a-z]/g, "");
    let ij = INTERJ[first] || null;
    if (first === "oh" && !/^no\b/i.test(words[1] || "")) ij = null; // only "oh no" is sad
    const out = { lead: !ij && emotion !== "neutral" ? emote(style, emotion, base) : null, words: [] };

    words.forEach((w, i) => {
      if (i === 0 && ij) { const e = emote(style, ij, BASE[style] * (EMO[ij] || E).pitch); out.words.push({ events: e.events, dur: e.dur, pause: pauseAfter(w) }); return; }
      const ls = letters(w), events = [];
      let dt = 0;
      if (style === "babble") {
        ls.forEach((c, j) => {
          const digit = /\d/.test(c), vow = digit ? DIGIT_VOWEL[+c] : VOWEL[c] ? c : null;
          const fm = vow ? VOWEL[vow] : CONS[c] || [500, 1400, 1400];
          const d = (vow ? 0.064 : 0.048) / E.rate;
          const f = base * melody(i, ls.length > 1 ? j / (ls.length - 1) : 1) * (1 + jitter()) * (j === 0 ? 1.03 : 1);
          events.push({ dt: Math.round(dt), k: "vocal", p: { f: +f.toFixed(1), f2: +(f * 0.95).toFixed(1), F1: fm[0], F2: fm[1], F2a: vow ? undefined : fm[2], d: +d.toFixed(3), v: vow ? VOL.babble : VOL.babble * 0.8, nasal: c === "m" || c === "n" || undefined } });
          dt += d * 1000 - 4;
        });
        out.words.push({ events, dur: Math.round(dt + 28 / E.rate), pause: pauseAfter(w) });
      } else if (style === "beeps") {
        const step = 40 / E.rate;
        ls.forEach((c, j) => {
          if (j % 2) return;
          const variant = (((c.charCodeAt(0) * 7) % 3) - 1) * 0.06 * E.range;
          const f = base * melody(i, ls.length > 1 ? j / (ls.length - 1) : 1) * (1 + variant + jitter() * 0.5);
          events.push({ dt: Math.round(j * step), k: "beep", p: { f: +f.toFixed(1), d: 0.034, v: VOL.beeps } });
        });
        out.words.push({ events, dur: Math.round(ls.length * step + 30 / E.rate), pause: pauseAfter(w) });
      } else {
        const c = ls[0];
        if (c) {
          const idx = 4 + ((c.charCodeAt(0) - 48) % 5) + (/[aeiouy]/.test(c) ? 1 : 0);
          const f = N(idx) * E.pitch * melody(i, 1) * (1 + jitter() * 0.5);
          events.push({ dt: 0, k: "soft", p: { f: +f.toFixed(1), f2: +(f * (info[i].last && info[i].end === "?" ? 1.06 : 0.985)).toFixed(1), d: 0.07, v: VOL.blips, a: 0.008 } });
        }
        out.words.push({ events, dur: Math.round((45 + w.length * 22) / E.rate), pause: pauseAfter(w) });
      }
    });
    return fit(out, words.join(" ").length, style);
  }

  /** a long line types out in at most ~4.5 s (about reading speed): everything speeds up together, pauses a little
   *  less, and fast babble voices every other letter (still chatter, never a buzz) */
  function fit(out, chars, style) {
    const natural = (out.lead?.dur || 0) + out.words.reduce((s, w) => s + w.dur + w.pause, 0);
    const target = Math.max(1200, Math.min(4500, chars * 28));
    const f = Math.min(2.6, natural / target);
    if (f <= 1.05) return out;
    for (const w of out.words) {
      let evs = w.events;
      if (style === "babble" && f > 1.5 && evs.length > 2) evs = evs.filter((_, j) => j % 2 === 0 || j === evs.length - 1);
      w.events = evs.map((e) => ({ ...e, dt: Math.round(e.dt / f), p: { ...e.p, d: +Math.max(0.035, e.p.d / Math.min(f, 1.6)).toFixed(3) } }));
      w.dur = Math.round(w.dur / f);
      w.pause = Math.round(w.pause / Math.sqrt(f));
    }
    return out;
  }

  function wav(data, sr) {
    const b = new DataView(new ArrayBuffer(44 + data.length * 2));
    const str = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); b.setUint32(4, 36 + data.length * 2, true); str(8, "WAVE"); str(12, "fmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, "data"); b.setUint32(40, data.length * 2, true);
    data.forEach((v, i) => b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
    return new Uint8Array(b.buffer);
  }

  class TextVoice {
    constructor(sfx) { this.sfx = sfx; }
    plan(words, o) { return plan(words, o); }
    /** play a word's (or a reaction's) sounds now */
    play(events) {
      if (!events?.length) return;
      if (window.__voiceLog) { const now = performance.now() + 12; for (const e of events) window.__voiceLog.push({ t: now + e.dt, k: e.k, p: e.p }); }
      if (this.sfx.muted) return;
      const ac = this.sfx.ctx(), t0 = ac.currentTime + 0.012;
      for (const e of events) SYNTH[e.k](ac, this.sfx.input, t0 + e.dt / 1000, e.p);
    }
    /** a recorded event log ({ t ms, k, p }) rendered offline from startMs, at the default volume: a WAV */
    static async render(log, startMs, seconds, volume = 0.8) {
      const sr = 44100, ac = new OfflineAudioContext(1, Math.ceil(sr * seconds), sr);
      const g = ac.createGain(); g.gain.value = volume * 0.6; g.connect(ac.destination);
      const input = chain(ac, g);
      for (const e of log) { const at = (e.t - startMs) / 1000; if (at >= 0 && at < seconds) SYNTH[e.k](ac, input, at, e.p); }
      return wav((await ac.startRendering()).getChannelData(0), sr);
    }
  }
  window.TextVoice = TextVoice;
})();
