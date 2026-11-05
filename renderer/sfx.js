// pillbud's sounds, synthesized with WebAudio: no audio files, all original, tiny and soft. In the default Text mode
// these ARE pillbud's voice, so they're tuned to be pleasant: round sine tones with a little warmth (a quiet octave
// partial), soft attacks (no clicks), notes from one major pentatonic scale (always in tune with each other), and a
// gentle low-pass on everything (nothing bright or buzzy).
//   blip    a soft "voice" blip per word as the text appears: a little speech melody that drops at the end of a
//           sentence and lifts on a question
//   hello   a friendly two-note "boop-beep" (gm, a new coin)
//   pump    a happy three-note rise with a soft sparkle (pumping, a pump alert, bonded)
//   dump    a gentle "uh-oh": two notes stepping down (dipping, a dev or whale sell)
//   larp    a quizzical low "hmm-mm" (likely LARP, copycat)
//   rug     a soft cartoon slide down and a little "bonk" (the dev is fully out)
//   legit   a warm two-note chime (looks legit)
// One master volume; muted = silent. render(name) gives a WAV of any sound (to listen to).
(function () {
  // C major pentatonic, C4 to E6
  const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];
  const N = (i) => SCALE[Math.max(0, Math.min(SCALE.length - 1, i))];

  /** a soft note: sine plus a quiet octave, attack a, decay d, optional glide to f2 */
  function note(ac, out, { f, f2, t = 0, a = 0.012, d = 0.18, v = 0.16, warm = 0.18 }) {
    const t0 = ac.currentTime + t, end = t0 + a + d;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    g.connect(out);
    for (const [mult, lvl] of [[1, 1], [2, warm]]) {
      if (!lvl) continue;
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f * mult, t0);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2 * mult, end);
      og.gain.value = lvl;
      o.connect(og); og.connect(g);
      o.start(t0); o.stop(end + 0.03);
    }
  }

  const VOWEL = /[aeiouy]/i;
  const SOUNDS = {
    /** ch: the word's first letter; how: "end" (last word of a sentence) | "ask" (ends with ?) | undefined */
    blip(ac, out, ch = "a", how) {
      const c = ((ch || "a").toLowerCase().charCodeAt(0) || 97) % 5;      // the letter picks one of 5 notes
      let i = 4 + c + (VOWEL.test(ch) ? 1 : 0);                            // around A4 to E5: a mid, friendly register
      if (how === "end") i -= 2; else if (how === "ask") i += 2;
      const f = N(i);
      note(ac, out, { f, f2: how === "ask" ? f * 1.06 : f * 0.985, a: 0.008, d: 0.07, v: 0.07, warm: 0.12 });
    },
    hello(ac, out) { note(ac, out, { f: N(5), d: 0.16, v: 0.13 }); note(ac, out, { f: N(8), t: 0.12, d: 0.26, v: 0.12 }); },
    pump(ac, out) {
      [5, 7, 8].forEach((i, k) => note(ac, out, { f: N(i), t: k * 0.085, d: 0.2, v: 0.12 }));
      note(ac, out, { f: N(10), t: 0.27, d: 0.35, v: 0.045, warm: 0 });
    },
    dump(ac, out) { note(ac, out, { f: N(7), d: 0.16, v: 0.12 }); note(ac, out, { f: N(5), f2: N(5) * 0.97, t: 0.16, d: 0.32, v: 0.11 }); },
    larp(ac, out) { note(ac, out, { f: N(3), d: 0.14, v: 0.12 }); note(ac, out, { f: N(2), f2: N(2) * 0.98, t: 0.17, d: 0.26, v: 0.11 }); },
    rug(ac, out) {
      note(ac, out, { f: N(9), f2: N(2), a: 0.02, d: 0.5, v: 0.09, warm: 0.08 });   // a soft slide down
      note(ac, out, { f: 150, f2: 110, t: 0.5, a: 0.008, d: 0.16, v: 0.11, warm: 0.3 }); // and a little bonk
    },
    legit(ac, out) { note(ac, out, { f: N(8), d: 0.3, v: 0.1 }); note(ac, out, { f: N(10), t: 0.1, d: 0.42, v: 0.08, warm: 0.1 }); },
  };
  const LENGTH = { blip: 0.15, hello: 0.5, pump: 0.7, dump: 0.55, larp: 0.5, rug: 0.75, legit: 0.6 };

  /** the shared chain: everything goes through a gentle low-pass, so nothing is ever bright or harsh */
  function chain(ac, dest) {
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 3200; lp.Q.value = 0.5;
    lp.connect(dest);
    return lp;
  }

  class Sfx {
    constructor() { this.ac = null; this.master = null; this.input = null; this.volume = 0.8; this.muted = false; }
    ctx() {
      if (!this.ac) { this.ac = new AudioContext(); this.master = this.ac.createGain(); this.master.connect(this.ac.destination); this.input = chain(this.ac, this.master); }
      this.master.gain.value = this.muted ? 0 : this.volume * 0.6;
      return this.ac;
    }
    play(name, ...args) { if (this.muted || !SOUNDS[name]) return; const ac = this.ctx(); SOUNDS[name](ac, this.input, ...args); }
    /** any sound as a 16-bit WAV (Uint8Array), rendered offline at the default volume (0.8) */
    async render(name) {
      const sr = 44100, ac = new OfflineAudioContext(1, Math.ceil(sr * LENGTH[name]), sr);
      const g = ac.createGain(); g.gain.value = 0.8 * 0.6; g.connect(ac.destination);
      SOUNDS[name](ac, chain(ac, g), "a");
      const data = (await ac.startRendering()).getChannelData(0);
      const b = new DataView(new ArrayBuffer(44 + data.length * 2));
      const str = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
      str(0, "RIFF"); b.setUint32(4, 36 + data.length * 2, true); str(8, "WAVE"); str(12, "fmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
      b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, "data"); b.setUint32(40, data.length * 2, true);
      data.forEach((v, i) => b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
      return new Uint8Array(b.buffer);
    }
  }
  window.Sfx = Sfx;
  window.SFX_NAMES = Object.keys(SOUNDS);
  window.SfxSynth = { N, chain }; // shared with the Text-mode voice (textvoice.js)
})();
