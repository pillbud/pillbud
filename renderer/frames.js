// Frame governor: the character animates at 60 fps only while something is happening (talking, listening, a
// reaction, being dragged). When idle it holds still and plays a short smooth burst of its idle animation now and then
// (1.5 s at 30 fps every 7 s; asleep: 2 s at 20 fps every 12 s). On Windows a transparent window is copied out on every
// frame: a non-stop 60 fps idle cost ~70% of a core (measured 2026-11-03).
// Loaded before the character player, it wraps requestAnimationFrame; held frames wait on a timer instead of waking
// every vsync. window.__nativeRAF stays available (the perf probe uses it).
(function () {
  const native = window.requestAnimationFrame.bind(window);
  window.__nativeRAF = native;
  let mode = "active", activeUntil = performance.now() + 5000, paused = false;
  const BURST = { idle: { every: 7000, len: 1500, fps: 30 }, sleep: { every: 12000, len: 2000, fps: 20 } };
  function fps() {
    const now = performance.now();
    if (paused) return 0;
    if (now < activeUntil) return 60;
    const b = BURST[mode] || BURST.idle;
    return now % b.every < b.len ? b.fps : 0; // a burst of motion, then hold the pose
  }
  window.requestAnimationFrame = function (cb) {
    const f = fps();
    if (f >= 60) return native(cb);
    if (f === 0) { // holding still: come back at the next burst (or sooner if something happens)
      const b = BURST[mode] || BURST.idle;
      const wait = paused ? 500 : Math.min(500, b.every - (performance.now() % b.every));
      const id = setTimeout(() => window.requestAnimationFrame(cb), Math.max(16, wait));
      return -id;
    }
    const id = setTimeout(() => native(cb), 1000 / f);
    return -id;
  };
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  window.cancelAnimationFrame = (id) => (id < 0 ? clearTimeout(-id) : nativeCancel(id));
  window.frames60 = {
    /** something is happening: full frame rate for ms (default 4 s) */
    active(ms = 4000) { activeUntil = Math.max(activeUntil, performance.now() + ms); },
    /** idle or asleep: bursts of motion */
    idle(state) { mode = state === "sleep" ? "sleep" : "idle"; },
    pause(on) { paused = !!on; },
    status: () => ({ fps: fps(), mode, active: performance.now() < activeUntil, paused }),
  };
})();
