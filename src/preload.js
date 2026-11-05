// The only bridge between the page and the main process.
const { contextBridge, ipcRenderer } = require("electron");

const IN = ["line", "line-audio", "line-audio-end", "hush", "mood", "coin", "ptt", "prefs", "details", "sfx-export", "visible"];
contextBridge.exposeInMainWorld("pillbud", {
  on: (ch, fn) => { if (IN.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
  lineDone: (id) => ipcRenderer.send("line-done", { id }),
  linePlaying: (id) => ipcRenderer.send("line-playing", { id }),
  ready: () => ipcRenderer.send("ready"),
  expand: () => ipcRenderer.sendSync("win-size", "full"),   // synchronous: the window is big before the balloon shows
  compact: () => ipcRenderer.send("win-size", "compact"),
  interactive: (on) => ipcRenderer.send("interactive", on),
  moveBy: (dx, dy) => ipcRenderer.send("move-by", { dx, dy }),
  askAudio: (data, type) => ipcRenderer.invoke("ask-audio", { data, type }),
  sprites: () => ipcRenderer.invoke("sprites"),
  prefs: () => ipcRenderer.invoke("prefs"),
  sfxExport: (name, wav) => ipcRenderer.send("sfx-export", { name, wav }),
  log: (s) => ipcRenderer.send("log", String(s)),
});
