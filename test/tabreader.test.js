// node test/tabreader.test.js [seconds]
// Runs the tab reader against whatever browser is in front and reports, for privacy, only: which process was in
// front, the HOST of each address-bar change and whether it's a coin page. Plus the helper's CPU time and memory.
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fromUrl } = require("../src/detect");

const secs = Number(process.argv[2] || 30);
const script = fs.readFileSync(path.join(__dirname, "..", "src", "tabreader.ps1"), "utf8");
const EXE = path.join(__dirname, "..", "src", "native", "pillbud-tabreader2.exe");
const usePs = process.argv.includes("--ps") || !fs.existsSync(EXE);
const ps = usePs ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true }) : spawn(EXE, [], { windowsHide: true });
console.log(`helper: ${usePs ? "PowerShell" : "compiled exe"}`);
const stat = () => { try { const o = execSync(`powershell -NoProfile -Command "$p=Get-Process -Id ${ps.pid}; '{0}|{1}' -f $p.TotalProcessorTime.TotalMilliseconds, $p.WorkingSet64"`).toString().trim().split("|"); return { cpuMs: Number(o[0]), ram: Number(o[1]) }; } catch { return null; } };
let buf = "", ready = null, events = 0;
const t0 = Date.now();
ps.stdout.on("data", (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith("{")) continue;
    const m = JSON.parse(line);
    events++;
    if (m.ready) { ready = Date.now() - t0; console.log(`ready after ${ready} ms`); continue; }
    if (m.fg != null) { console.log(`front window: ${m.p || "?"}`); continue; }
    const url = /^[a-z]+:\/\//i.test(m.u) ? m.u : `https://${m.u}`;
    let host = "?"; try { host = new URL(url).hostname; } catch { /* typed text, not a URL */ }
    const hit = fromUrl(url);
    console.log(`address bar (${m.b}): host ${host}${hit ? ` -> COIN PAGE (${hit.site}, ${hit.address.slice(0, 4)}...)` : " (not a coin page, ignored)"}`);
  }
});
ps.stderr.on("data", (d) => { const t = String(d).trim(); if (t && !/CLIXML/.test(t)) console.log("stderr:", t.slice(0, 300)); });
setTimeout(() => {
  const a = stat();
  setTimeout(() => {
    const b = stat();
    if (a && b) console.log(`helper over ${secs - 5} s: CPU ${(b.cpuMs - a.cpuMs).toFixed(0)} ms (${(((b.cpuMs - a.cpuMs) / ((secs - 5) * 1000)) * 100).toFixed(2)}% of one core), RAM ${(b.ram / 1048576).toFixed(0)} MB; ${events} events`);
    ps.kill(); process.exit(0);
  }, (secs - 5) * 1000);
}, 5000);
