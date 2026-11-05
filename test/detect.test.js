// node test/detect.test.js  : URL + clipboard detection for every supported site, resolved against live data
const assert = require("node:assert");
const { fromUrl, fromClipboard, resolveMint } = require("../src/detect");
const { curvePda } = require("../src/research/chain");
const { getJson } = require("../src/research/net");

const MINT = process.argv[2] || "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump";   // $AMD (bonded, PumpSwap)
const CURVE_MINT = process.argv[3] || "7hp5zqyNdJbuTVMezPttjyjJA7fU2yH62CsFFErgpump"; // $GRANDPA (on the pump.fun curve)

(async () => {
  const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${MINT}`);
  const POOL = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0].pairAddress;
  const CURVE = curvePda(CURVE_MINT);
  const cases = [
    ["pump.fun", `https://pump.fun/coin/${MINT}`, MINT],
    ["pump.fun (no /coin)", `https://pump.fun/${CURVE_MINT}?include-nsfw=true`, CURVE_MINT],
    ["dexscreener (lowercased pair)", `https://dexscreener.com/solana/${POOL.toLowerCase()}`, MINT],
    ["gmgn", `https://gmgn.ai/sol/token/${MINT}`, MINT],
    ["gmgn (ref prefix)", `https://gmgn.ai/sol/token/aBc12xYz_${MINT}?tag=new`, MINT],
    ["axiom (pool)", `https://axiom.trade/meme/${POOL}`, MINT],
    ["axiom (pump.fun curve)", `https://axiom.trade/meme/${CURVE}`, CURVE_MINT],
    ["photon (pool)", `https://photon-sol.tinyastro.io/en/lp/${POOL}?handle=abc`, MINT],
    ["birdeye", `https://birdeye.so/token/${MINT}?chain=solana`, MINT],
    ["birdeye (path form)", `https://birdeye.so/solana/token/${MINT}`, MINT],
    ["solscan", `https://solscan.io/token/${MINT}`, MINT],
  ];
  let pass = 0;
  for (const [name, url, want] of cases) {
    const hit = fromUrl(url);
    assert(hit, `${name}: nothing found in ${url}`);
    const t0 = Date.now();
    const r = await resolveMint(hit.address);
    assert.strictEqual(r.mint, want, `${name}: resolved ${r.mint}, wanted ${want}`);
    console.log(`ok  ${name.padEnd(30)} ${hit.site.padEnd(11)} -> ${r.mint.slice(0, 6)}... ${Date.now() - t0}ms`);
    pass++;
  }
  // things that must NOT trigger
  for (const [name, url] of [["dexscreener other chain", `https://dexscreener.com/ethereum/0x${"a".repeat(40)}`], ["birdeye other chain", `https://birdeye.so/token/${MINT}?chain=ethereum`], ["pump.fun home", "https://pump.fun/board"], ["random site", `https://example.com/${MINT}`], ["solscan tx page", `https://solscan.io/tx/${"5".repeat(88)}`]]) {
    assert.strictEqual(fromUrl(url), null, `${name} should be ignored`); console.log(`ok  ignored: ${name}`); pass++;
  }
  // clipboard
  assert.strictEqual(fromClipboard(MINT).address, MINT); console.log("ok  clipboard: bare CA"); pass++;
  assert.strictEqual(fromClipboard(`CA: ${MINT}`).address, MINT); console.log("ok  clipboard: 'CA: <mint>'"); pass++;
  assert.strictEqual(fromClipboard(`https://pump.fun/coin/${MINT}`).address, MINT); console.log("ok  clipboard: copied pump.fun link"); pass++;
  assert.strictEqual(fromClipboard("gm frens, wagmi"), null); console.log("ok  clipboard: chat text ignored"); pass++;
  assert.strictEqual(fromClipboard(`${MINT} ${CURVE_MINT}`), null); console.log("ok  clipboard: two addresses = ambiguous, ignored"); pass++;
  assert.strictEqual(fromClipboard("So11111111111111111111111111111111111111112"), null); console.log("ok  clipboard: wrapped SOL ignored"); pass++;
  // a wallet (not a coin) copied: detected as an address, but resolving says it's not a coin
  const wallet = "5MVnXCSFxRkVv9HtoTLWQ2G2Y5jH4xmP8w9N6mK3BLJm";
  try { await resolveMint(wallet); assert.fail("a wallet resolved as a coin"); } catch (e) { assert(!/resolved as a coin/.test(e.message), e.message); console.log(`ok  wallet address rejected (${e.message})`); pass++; }
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
