// Where the character comes from, first match wins (the art lives in brand/, inside the app or next to it):
//   1. config.json "character": a rig folder (sprite.svg + animations.json) or a manifest.json
//   2. brand/sprites/manifest.json, brand/app/manifest.json, brand/manifest.json
//   3. a rig export anywhere under brand/ (3 levels deep): a folder with sprite.svg + animations.json, played by the
//      pillbud-player.js next to it (or brand/shared/). A final export beats drafts under brand/_review; newest first.
//   4. the placeholder in renderer/character (only so the app runs before any art exists)
// Used by the main process (the "sprites" IPC) and by the headless demo recorder (test/demo-textvoice.js).
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_DIR = path.join(__dirname, "..");
const BRAND = [path.join(APP_DIR, "brand"), path.join(APP_DIR, "..", "brand")].find((d) => fs.existsSync(d)) || path.join(APP_DIR, "brand");
const url = (f) => pathToFileURL(f).href;

function rigAt(dir) {
  if (!fs.existsSync(path.join(dir, "sprite.svg")) || !fs.existsSync(path.join(dir, "animations.json"))) return null;
  const player = [path.join(dir, "pillbud-player.js"), path.join(BRAND, "shared", "pillbud-player.js")].find((f) => fs.existsSync(f));
  return player && { file: path.join(dir, "animations.json"), manifest: { name: path.relative(BRAND, dir) || "brand", kind: "pillbud-rig", player: url(player), svg: "sprite.svg", animations: "animations.json" } };
}

function spriteManifest(character) {
  const c = character;
  if (c && fs.existsSync(c)) return fs.statSync(c).isDirectory() ? rigAt(c) || { file: path.join(c, "manifest.json") } : { file: c };
  for (const rel of ["sprites/manifest.json", "app/manifest.json", "manifest.json"]) { const f = path.join(BRAND, rel); if (fs.existsSync(f)) return { file: f }; }
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const r = rigAt(dir); if (r) found.push(r);
    if (depth < 3) for (const e of entries) if (e.isDirectory() && e.name !== "node_modules") walk(path.join(dir, e.name), depth + 1);
  };
  walk(BRAND, 0);
  found.sort((a, b) => (a.file.includes("_review") - b.file.includes("_review")) || fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
  if (found.length) return found[0];
  return { file: path.join(APP_DIR, "renderer", "character", "manifest.json") };
}

/** the manifest plus the text files it names (SVG, CSS, Lottie JSON), read here because the page can't fetch file:// */
function spritePack(character) {
  const found = spriteManifest(character);
  const dir = path.dirname(found.file);
  const manifest = found.manifest || JSON.parse(fs.readFileSync(found.file, "utf8"));
  const names = [manifest.svg, manifest.css, manifest.animations, ...Object.values(Array.isArray(manifest.states) ? {} : manifest.states || {}).filter((v) => typeof v === "string")].filter(Boolean);
  const files = {};
  for (const n of names) { try { files[n] = fs.readFileSync(path.join(dir, n), "utf8"); } catch { /* missing art: that state falls back */ } }
  return { manifest, dir: url(dir), files, from: dir, skins: { colours: skinDirs("skins"), accs: skinDirs("acc") } };
}

/** skins: brand/skins/<colour> (a whole frame set) and brand/acc/<accessory> (a layer drawn over it), same frame names
 *  as brand/sprites but .webp. { name: file URL } for each folder that has frames. */
function skinDirs(sub) {
  const d = path.join(BRAND, sub);
  try { return Object.fromEntries(fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(d, e.name, "frames"))).map((e) => [e.name, url(path.join(d, e.name))])); }
  catch { return {}; }
}

module.exports = { spritePack };
