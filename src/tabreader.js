// Runs src/tabreader.ps1 (Windows UI Automation: the foreground browser's address bar, nothing else) and turns its
// lines into events: onUrl(url, browser) for coin pages only, and the foreground window handle for "look at this".
// URLs that aren't coin pages are dropped here and never logged.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fromUrl } = require("./detect");

/** the compiled helper (src/native/pillbud-tabreader.exe), built with the C# compiler that ships with Windows' .NET
 *  Framework if it's missing. null = use the PowerShell script instead (same behaviour, ~5x more memory). */
function helperExe(log) {
  const out = path.join(__dirname, "native", "pillbud-tabreader2.exe"); // v2: UTF-8 output
  if (fs.existsSync(out)) return out;
  try {
    const { execFileSync } = require("node:child_process");
    const win = process.env.SystemRoot || "C:/Windows";
    const csc = path.join(win, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const ref = (n) => `-r:${path.join(win, "Microsoft.NET", "assembly", "GAC_MSIL", n, "v4.0_4.0.0.0__31bf3856ad364e35", `${n}.dll`)}`;
    execFileSync(csc, ["-nologo", "-optimize+", "-target:exe", "-platform:x64", `-out:${out}`, ref("UIAutomationClient"), ref("UIAutomationTypes"), ref("WindowsBase"), path.join(__dirname, "native", "tabreader.cs")], { windowsHide: true });
    return out;
  } catch (e) { log(`tab reader: couldn't build the helper (${e.message.slice(0, 80)}), using PowerShell`); return null; }
}

function makeTabReader({ onCoinUrl, onHost = () => {}, log = () => {} }) {
  let ps = null, buf = "", stopped = false, restarts = 0, readyAt = null, exeFails = 0, exeBlocked = false;
  const state = { fg: null, fgProc: null, browser: null, lastCoinUrl: null };

  function start() {
    if (ps || stopped || process.platform !== "win32") return;
    const exe = exeBlocked ? null : helperExe(log);
    try {
      if (exe) ps = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); // exits when this pipe closes
      else {
        const script = fs.readFileSync(path.join(__dirname, "tabreader.ps1"), "utf8");
        ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
      }
    } catch (e) {
      // a freshly built exe can be locked for a moment (antivirus scan): retry, then fall back to PowerShell
      ps = null;
      if (exe && ++exeFails >= 3) exeBlocked = true;
      log(`tab reader: couldn't start (${e.code || e.message}), retrying`);
      setTimeout(start, 1500);
      return;
    }
    log(`tab reader: ${exe ? "compiled helper" : "PowerShell helper"} (pid ${ps.pid})`);
    ps.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { readyAt = Date.now(); log("tab reader: ready"); continue; }
        if (m.fg != null) { state.fg = m.fg; state.fgProc = m.p; continue; }
        if (m.u) {
          state.browser = m.b;
          const url = /^[a-z]+:\/\//i.test(m.u) ? m.u : `https://${m.u}`; // the address bar hides "https://"
          let host = null; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* typed text */ }
          onHost(host, m.b, m.h);
          const hit = fromUrl(url);
          if (hit) { state.lastCoinUrl = url; onCoinUrl(url, hit, m.b); }
        }
      }
    });
    ps.stderr.on("data", (d) => { const t = String(d).trim(); if (t && !/CLIXML/.test(t)) log(`tab reader: ${t.slice(0, 200)}`); });
    ps.on("exit", (code) => {
      ps = null;
      if (stopped) return;
      const wait = Math.min(30000, 1000 * 2 ** restarts++);
      log(`tab reader exited (${code}); restarting in ${wait} ms`);
      setTimeout(start, wait);
    });
  }
  function stop() { stopped = true; try { ps?.kill(); } catch { /* gone */ } ps = null; }
  /** health check (after sleep/resume): restart if the helper died */
  function ensure() { if (!ps && !stopped) { restarts = 0; start(); } }

  return { start, stop, ensure, state, pid: () => ps?.pid ?? null, running: () => !!ps, readyAt: () => readyAt };
}

module.exports = { makeTabReader };
