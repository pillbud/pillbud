// "The coin you're at": pull a Solana address out of a trading-site URL or the clipboard, then resolve it to the
// coin's mint. Sites like DexScreener, Axiom and Photon put the PAIR (pool / bonding curve) in the URL, not the mint.
const { PublicKey } = require("@solana/web3.js");
const { getJson, rpc } = require("./research/net");

const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([WSOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const SYSTEM = new Set(["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** a real Solana address: base58 that decodes to 32 bytes */
function isAddress(s) {
  if (!s || s.length < 32 || s.length > 44) return false;
  try { return new PublicKey(s).toBytes().length === 32; } catch { return false; }
}

// host -> how to find the address in the URL (the last base58 run in the path, after a Solana check)
const SITES = [
  { site: "pump.fun", host: /(^|\.)pump\.fun$/, ok: () => true },
  { site: "dexscreener", host: /(^|\.)dexscreener\.com$/, ok: (u) => u.pathname.startsWith("/solana/") },
  { site: "gmgn", host: /(^|\.)gmgn\.ai$/, ok: (u) => u.pathname.startsWith("/sol/") },
  { site: "axiom", host: /(^|\.)axiom\.trade$/, ok: () => true },
  { site: "photon", host: /(^|\.)photon-sol\.tinyastro\.io$/, ok: () => true },
  { site: "birdeye", host: /(^|\.)birdeye\.so$/, ok: (u) => !u.searchParams.get("chain") || u.searchParams.get("chain") === "solana" },
  { site: "solscan", host: /(^|\.)solscan\.io$/, ok: (u) => /^\/(token|account)\//.test(u.pathname) },
];

/** { site, address } from a URL on one of the supported sites, or null */
function fromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const s = SITES.find((x) => x.host.test(u.hostname));
  if (!s || !s.ok(u)) return null;
  // DexScreener lowercases the pair in its URLs (base58 is case-sensitive), so take its id as-is: its API accepts it
  if (s.site === "dexscreener") { const id = u.pathname.split("/")[2]; return id && /^[1-9A-Za-z]{32,44}$/.test(id) ? { site: s.site, address: id } : null; }
  const found = (u.pathname.match(B58) || []).filter((a) => isAddress(a) && !SYSTEM.has(a));
  // gmgn sometimes prefixes a referral code: /sol/token/abc123_<mint>; the regex already splits on "_"
  const address = found[found.length - 1] || (u.searchParams.get("address") && isAddress(u.searchParams.get("address")) ? u.searchParams.get("address") : null);
  return address ? { site: s.site, address } : null;
}

/** a contract address copied on its own (or inside a short snippet) */
function fromClipboard(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 200) return null;
  const urlHit = /^https?:\/\//.test(t) ? fromUrl(t) : null;
  if (urlHit) return { ...urlHit, site: "clipboard" };
  const found = (t.match(B58) || []).filter((a) => isAddress(a) && !SYSTEM.has(a) && !STABLES.has(a));
  return found.length === 1 ? { site: "clipboard", address: found[0] } : null;
}

const resolved = new Map();
/** address (mint, pair, pool or bonding curve) -> { mint, pairHint }; throws if it isn't a coin */
async function resolveMint(address) {
  if (resolved.has(address)) return resolved.get(address);
  let out = null;
  if (!isAddress(address)) { // a lowercased DexScreener id: only DexScreener can say what it is
    const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${address}`);
    const id = address.toLowerCase();
    const p = (j.pairs || []).find((x) => x.chainId === "solana" && (x.pairAddress.toLowerCase() === id || x.baseToken.address.toLowerCase() === id));
    if (!p) throw new Error("DexScreener doesn't know that pair");
    out = p.baseToken.address.toLowerCase() === id || !STABLES.has(p.baseToken.address) ? { mint: p.baseToken.address, pairHint: p.pairAddress } : { mint: p.quoteToken.address, pairHint: p.pairAddress };
    resolved.set(address, out);
    return out;
  }
  // 1. it's a token DexScreener knows
  try {
    const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${address}`);
    if (Array.isArray(pairs) && pairs.some((p) => p.baseToken?.address === address)) out = { mint: address };
  } catch { /* try the next way */ }
  // 2. it's a pair DexScreener knows
  if (!out) {
    try {
      const j = await getJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${address}`);
      const p = j.pairs?.[0] || j.pair;
      if (p) out = { mint: STABLES.has(p.baseToken.address) ? p.quoteToken.address : p.baseToken.address, pairHint: address };
    } catch { /* try the chain */ }
  }
  // 3. ask the chain: a mint account, or an account (curve / pool) that owns the coin's token account
  if (!out) {
    const info = await rpc("getAccountInfo", [address, { encoding: "jsonParsed" }]);
    const v = info?.value;
    if (v?.data?.parsed?.type === "mint") out = { mint: address };
    else if (v) {
      for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
        const r = await rpc("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }]);
        const m = (r?.value || []).map((a) => a.account.data.parsed.info.mint).find((x) => !STABLES.has(x));
        if (m) { out = { mint: m, pairHint: address }; break; }
      }
    }
  }
  if (!out) throw new Error("that address isn't a coin I can find");
  resolved.set(address, out);
  return out;
}

module.exports = { fromUrl, fromClipboard, resolveMint, isAddress, WSOL };
