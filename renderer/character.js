// The character on screen. It loads whatever renderer/character/manifest.json (or brand/sprites/manifest.json,
// when the real character exists) describes, so the art swaps without touching the app. Supported kinds:
//   "svg-inline"     one SVG + one CSS file; state = class st-<state> on the <svg>, talking = class "talking",
//                    mouth openness = CSS variable --open (0..1). (The placeholder pill.)
//   "svg-per-state"  { states: { idle: "idle.svg", talk: "talk.svg", ... } } each SVG animates itself (CSS/SMIL inside)
//   "frames"         { states: { idle: { frames: ["idle_0.png", ...], fps: 8, loop: true }, ... } }
//   "lottie"         { lottie: "lottie.min.js", states: { idle: "idle.json", ... } } (Lottie / bodymovin JSON)
//   "pillbud-rig"    the design agent's rig: { player: "pillbud-player.js", svg: "sprite.svg", animations: "animations.json" }
//                    played with Pillbud.mount(); states are the rig's animations, mood -1..1 tints it (dump..pump)
//   "pillbud-rig-js" the same rig while it's still authored as scripts: { scripts: [...], key: "gumball" } -> PB_CHARS[key]
// Missing states fall back to "idle". States used: idle talk think point celebrate panic rugged wave sleep.
/* global lottie */
class Character {
  constructor(el) { this.el = el; this.state = "idle"; this.talking = false; this.kind = null; this.timer = null; this.anim = null; }

  async load() {
    const pack = await window.pillbud.sprites();
    this.m = pack.manifest; this.dir = pack.dir; this.files = pack.files; this.kind = this.m.kind;
    this.skins = pack.skins || { colours: {}, accs: {} }; this.colour = "mint"; this.acc = null;
    if (this.want) this.setSkin(...this.want); // prefs that arrived before the art did
    if (this.m.size) { // the buddy's box follows the art (V3: 225 x 250); the balloon sits above it (style.css)
      this.el.style.width = `${this.m.size[0]}px`; this.el.style.height = `${this.m.size[1]}px`;
      const box = this.el.parentElement; if (box) { box.style.width = `${this.m.size[0]}px`; box.style.height = `${this.m.size[1]}px`; }
      document.documentElement.style.setProperty("--buddy-h", `${this.m.size[1]}px`);
    }
    if (this.kind === "frames") setTimeout(() => ["talk", "think", "research", "read", "point"].forEach((s) => this.preload(s)), 1500);
    if (this.kind === "svg-inline") {
      if (this.m.css) { const st = document.createElement("style"); st.textContent = this.files[this.m.css]; document.head.appendChild(st); }
      this.el.innerHTML = this.files[this.m.svg];
      this.svg = this.el.querySelector("svg");
    }
    if (this.kind === "lottie" && this.m.lottie) await this.script(this.m.lottie);
    if (this.kind === "pillbud-rig" || this.kind === "pillbud-rig-js") {
      let svg, data;
      if (this.kind === "pillbud-rig") { await this.script(this.m.player); svg = this.files[this.m.svg]; data = JSON.parse(this.files[this.m.animations]); }
      else { for (const s of this.m.scripts) await this.script(s); const c = window.PB_CHARS[this.m.key]; svg = c.svg; data = c; }
      this.el.style.width = ""; this.el.style.height = "";
      this.pb = window.Pillbud.mount(this.el, svg, data, { uid: "pb", size: this.m.bodySize || 120 });
      this.rigData = data;
      this.rigStates = Object.keys(data.anims || {});
      this.aliases = data.aliases || {}; // the rig's own names for the app's states, e.g. celebrate -> pump
    }
    this.set("idle", true);
  }

  script(rel) { return new Promise((ok) => { const s = document.createElement("script"); s.src = /^file:/.test(rel) ? rel : `${this.dir}/${rel}`; s.onload = ok; s.onerror = () => { window.pillbud.log(`character script failed: ${rel}`); ok(); }; document.head.appendChild(s); }); }

  has(s) {
    if (this.rigStates) return this.rigStates.includes(this.aliases[s] || s);
    return Array.isArray(this.m.states) ? this.m.states.includes(s) : !!this.m.states?.[s];
  }

  /** the rig: each animation says how it plays (loop, or an intro + sustained segment); one-shots return to talk/idle */
  playRig(state) {
    const name = this.aliases[state] || state;
    const anim = this.rigData.anims[name];
    if (anim.segments) this.pb.play(name, { sustain: true });
    else if (anim.loop !== false) this.pb.play(name, { loop: true });
    else this.pb.play(name, { onEnd: () => { if (this.state === state) { const next = this.talking && this.has("talk") ? "talk" : "idle"; this.state = next; this.pb.play(this.aliases[next] || next, { loop: true }); } } });
  }

  /** -1 (dumping) .. 0 .. +1 (pumping): rigs that support it change colour with the chart */
  mood(v) { if (this.pb) this.pb.setMood(v, 800); }

  set(state, force = false) {
    if (!this.has(state)) state = { listen: "think", read: "point", hello: "wave", research: "think" }[state] || state;
    if (!this.has(state)) state = "idle";
    if (state === this.state && !force) return;
    this.state = state;
    clearInterval(this.timer); this.timer = null;
    if (this.anim) { try { this.anim.destroy(); } catch { /* gone */ } this.anim = null; }
    const k = this.kind;
    if (this.pb) { this.playRig(state); this.el.dataset.state = state; return; }
    if (k === "svg-inline") {
      this.svg.setAttribute("class", `pill st-${state}${this.talking ? " talking" : ""}`);
    } else if (k === "svg-per-state") {
      this.el.innerHTML = this.files[this.m.states[state]] || "";
    } else if (k === "frames") {
      this.playFrames(state);
    } else if (k === "lottie" && window.lottie) {
      this.el.replaceChildren();
      this.anim = lottie.loadAnimation({ container: this.el, renderer: "svg", loop: true, autoplay: true, animationData: JSON.parse(this.files[this.m.states[state]]) });
    }
    this.el.dataset.state = state;
  }

  /** a frame pack: frames stepped on requestAnimationFrame, which the frame governor (frames.js) paces, so an idle buddy
   *  holds still between bursts instead of repainting 24 times a second. Time only advances while it's ticking (a held
   *  pause doesn't jump ahead). One-shots (loop: false) end on their last frame: rugged and sleep stay there, the rest
   *  go back to talk or idle. */
  /** skins (frame packs only): the colour swaps the whole frame set, the accessory is a second image layered on top,
   *  frame for frame. Unknown names (art not installed) fall back to mint / none. */
  setSkin(colour, acc) {
    this.want = [colour, acc];
    if (!this.skins) return;
    colour = colour && this.skins?.colours?.[colour] ? colour : "mint";
    acc = acc && acc !== "none" && this.skins?.accs?.[acc] ? acc : null;
    if (colour === this.colour && acc === this.acc) return;
    this.colour = colour; this.acc = acc; this.loaded = new Set();
    if (this.kind === "frames" && this.img) this.set(this.state, true);
  }
  baseUrl(f) { return this.colour !== "mint" ? `${this.skins.colours[this.colour]}/${f.replace(/\.png$/, ".webp")}` : `${this.dir}/${f}`; }
  overUrl(f) { return this.acc ? `${this.skins.accs[this.acc]}/${f.replace(/\.png$/, ".webp")}` : null; }

  playFrames(state) {
    const d = this.m.states[state];
    if (!this.img) {
      const mk = () => { const i = document.createElement("img"); i.draggable = false; i.alt = ""; Object.assign(i.style, { width: "100%", height: "100%", display: "block", position: "absolute", left: "0", top: "0", pointerEvents: "none" }); return i; };
      this.img = mk(); this.over = mk();
      if (getComputedStyle(this.el).position === "static") this.el.style.position = "relative";
      this.el.replaceChildren(this.img, this.over);
    }
    const urls = d.frames.map((f) => this.baseUrl(f)), overs = this.acc ? d.frames.map((f) => this.overUrl(f)) : null;
    this.over.style.display = overs ? "block" : "none";
    this.preload(state);
    const token = (this.playToken = (this.playToken || 0) + 1), fps = d.fps || 24;
    let t = 0, last = performance.now(), shown = -1;
    const step = (now) => {
      if (token !== this.playToken) return;
      t += Math.max(0, Math.min(100, now - last)); last = now;
      let i = Math.floor((t / 1000) * fps);
      if (i >= urls.length) {
        if (d.loop === false) {
          i = urls.length - 1;
          if (shown === i) { if (this.state === state && state !== "rugged" && state !== "sleep") this.set(this.talking && this.has("talk") ? "talk" : "idle"); return; }
        } else i %= urls.length;
      }
      if (i !== shown) { this.img.src = urls[i]; if (overs) this.over.src = overs[i]; shown = i; }
      requestAnimationFrame(step);
    };
    this.img.src = urls[0]; if (overs) this.over.src = overs[0]; shown = 0;
    requestAnimationFrame(step);
  }
  /** load a state's frames into the image cache ahead of time (the first loop doesn't stutter) */
  preload(state) {
    this.loaded = this.loaded || new Set();
    if (this.loaded.has(state) || !this.m.states?.[state]?.frames) return;
    this.loaded.add(state);
    for (const f of this.m.states[state].frames) for (const u of [this.baseUrl(f), this.overUrl(f)]) if (u) { const i = new Image(); i.decoding = "async"; i.src = u; }
  }

  /** talking on/off (mouth moves on top of any state that supports it) */
  talk(on) {
    this.talking = on;
    if (this.pb) { if (on && (this.state === "idle" || this.state === "point")) { this.state = "talk"; this.pb.play("talk", { loop: true }); } else if (!on && this.state === "talk") { this.state = "idle"; this.pb.play("idle", { loop: true }); } return; }
    if (this.kind === "svg-inline") this.svg.classList.toggle("talking", on);
    else if (on && this.state === "idle" && this.has("talk")) this.set("talk");
    else if (!on && this.state === "talk") this.set("idle");
  }

  /** mouth openness 0..1 from the voice level */
  mouth(v) { if (!this.pb) this.el.style.setProperty("--open", v.toFixed(2)); }
}
window.Character = Character;
