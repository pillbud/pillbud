// electron test/make-screens.js : renders 3 synthetic "trader screens" off-screen (no window ever shows) and saves
// them to captures/look-*.png, so "look at this" can be tested without capturing anyone's real screen.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CSS = "body{margin:0;font:14px Segoe UI,sans-serif;background:#0d0f14;color:#d8dde6}.top{padding:14px 20px;border-bottom:1px solid #222}.big{font-size:22px;font-weight:700}.mut{color:#7d8696}.ca{font-family:Consolas,monospace;background:#151922;padding:6px 10px;border-radius:6px;display:inline-block;margin-top:6px}.g{color:#3ddc84}.r{color:#ff5c5c}.chart{margin:20px;height:260px;border:1px solid #222;position:relative;background:linear-gradient(180deg,#0f131b,#0b0d12)}.bar{position:absolute;bottom:0;width:10px}";
const SCREENS = {
  axiom: `<style>${CSS}</style><div class="top"><span class="big">GRANDPA</span> <span class="mut">/ SOL</span> &nbsp; <span class="mut">Grandpa, The Ultimate UNC</span><br><span class="ca">7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump</span> &nbsp; <span class="mut">MC</span> $11.2K &nbsp; <span class="g">+42.3% 5m</span> &nbsp; <span class="mut">Liq</span> $3.1K &nbsp; <span class="mut">Holders</span> 212</div>
    <div class="chart">${Array.from({ length: 40 }, (_, i) => `<div class="bar" style="left:${12 + i * 16}px;height:${40 + i * 5 + (i % 3) * 12}px;background:${i % 4 ? "#3ddc84" : "#ff5c5c"}"></div>`).join("")}</div><div class="mut" style="padding:0 20px">Axiom Pro · Trade · Buy 0.5 SOL · Sell 25%</div>`,
  telegram: `<style>${CSS}.msg{margin:30px;max-width:520px;background:#1d2533;border-radius:12px;padding:14px 16px;line-height:1.5}</style><div class="top"><b>SolTrending Calls</b> <span class="mut">bot · 41,203 subscribers</span></div>
    <div class="msg"><b>🚀 New call: $AMD (A Meme Dog)</b><br>CA: <span style="font-family:Consolas">DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump</span><br>MC: $2.4M · Liq $170k · 1h +38%<br>⚠️ Dev already sold. DYOR.<br><span class="mut">7:41 PM</span></div>`,
  "x-timeline": `<style>${CSS}.tw{border-bottom:1px solid #222;padding:12px 20px;max-width:600px}</style>
    <div class="tw"><b>Crypto Dad</b> <span class="mut">@cryptodad · 2h</span><br>$SOL looking strong above 150, $BTC chopping. Patience.</div>
    <div class="tw"><b>degen intern</b> <span class="mut">@intern · 1h</span><br>gm. memecoin season is back? $BONK and $WIF holders smiling today</div>
    <div class="tw"><b>ansem fan</b> <span class="mut">@fan · 45m</span><br>the trenches are cooked rn, 9 out of 10 launches rug in an hour</div>
    <div class="tw"><b>Nina</b> <span class="mut">@nina · 20m</span><br>lunch break then back to charts. who else is watching the fed today</div>`,
  "x-ca-tweet": `<style>${CSS}.tw{border-bottom:1px solid #222;padding:12px 20px;max-width:640px}</style>
    <div class="tw"><b>degen intern</b> <span class="mut">@intern · 1h</span><br>gm. $BONK holders smiling today</div>
    <div class="tw"><b>caller</b> <span class="mut">@caller · 3m</span><br>aped this one, grandpa energy<br><span style="font-family:Consolas">7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump</span></div>
    <div class="tw"><b>Nina</b> <span class="mut">@nina · 20m</span><br>back to charts</div>`,
  photon: `<style>${CSS}</style><div class="top"><span class="big">AMD</span> <span class="mut">A Meme Dog</span> &nbsp; <span class="mut">DDmG...pump</span><br><span class="mut">Price</span> $0.0024 &nbsp; <span class="mut">MC</span> $2.4M &nbsp; <span class="mut">Liq</span> $170K &nbsp; <span class="g">+12% 5m</span></div><div class="chart"></div><div class="mut" style="padding:0 20px">Photon · Quick Buy · PumpSwap</div>`,
  "tg-chat": `<style>${CSS}.msg{margin:10px 30px;max-width:560px;background:#1d2533;border-radius:12px;padding:10px 14px;line-height:1.45}</style><div class="top"><b>Trench Calls</b> <span class="mut">group · 3,410 members</span></div>
    <div class="msg">GRANDPA call <span style="font-family:Consolas">7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump</span></div>
    <div class="msg">AMD still running <span style="font-family:Consolas">DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump</span></div>
    <div class="msg">gato <span style="font-family:Consolas">HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump</span> anyone?</div>`,
  partial: `<style>${CSS}</style><div class="top"><span class="big">GTA6CAT</span> <span class="mut">($GATO)</span><br><span class="mut">Token</span> <span class="ca">Hspr...pump</span> &nbsp; <span class="mut">MC</span> $11M &nbsp; <span class="r">-2.1% 5m</span></div><div class="chart"></div><div class="mut" style="padding:0 20px">Photon · bonded · PumpSwap</div>`,
};

app.setPath("userData", path.join(require("node:os").tmpdir(), `pillbud-screens-${process.pid}`)); // never share the real app's profile
app.whenReady().then(async () => {
  setTimeout(() => app.exit(1), 30000); // never hang
  const w = new BrowserWindow({ width: 900, height: 520, show: false, webPreferences: { offscreen: true } });
  for (const [name, html] of Object.entries(SCREENS)) {
    const file = path.join(require("node:os").tmpdir(), `pillbud-screen-${name}.html`);
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8">${html}`);
    try { await w.loadFile(file); } catch (e) { console.log(name, "load:", e.message.slice(0, 80)); continue; }
    await new Promise((r) => setTimeout(r, 400));
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, "..", "captures", `look-${name}.png`), img.toPNG());
    console.log(`captures/look-${name}.png`);
  }
  w.destroy();
  app.quit();
});
