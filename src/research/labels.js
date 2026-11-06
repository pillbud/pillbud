// Exchange wallets, by name. Each one was checked by hand against Solscan's public label (read 2026-11-05) after it
// showed up holding a big share of a top coin ($PNUT, $BONK, $WIF, $POPCAT, $PENGU, $FARTCOIN, $GOAT, $MOODENG, $TRUMP).
// A coin held by an exchange is held for its users, not by one person, so these never count as a whale or as linked
// wallets. Add a wallet only after checking its label; a guess here hides a real whale.
const EXCHANGES = {
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance",   // Binance 3
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase",   // Coinbase 1
  "4xLpwxgYuPwPvtQjE94RLS4WZ4aD8NJYYKr2AJk99Qdg": "Robinhood", // Robinhood Hot Wallet
  "51yZyDSnec4xnUv7XLRVYcDyV4x3wUtzrDcRaYbmQU5j": "Robinhood", // Robinhood deposit address
  CBEADkb8TZAXHjVE3zwad4L995GZE7rJcacJ7asebkVG: "OKX",        // OKX Cold Wallet
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit",      // Bybit Hot Wallet
  "9ZifroknFoYu4r6DUk6nYoJiUQnEyyoUyeAwjXbPoL2x": "Bybit",     // Bybit Wallet 11
  Gem2VAypSg7Ai7vjDKPTtqFahpoQWkfgVkyzx3rPoTka: "Bybit",      // Bybit Wallet 14
  CSSJFgoeqidqVtHKSNP7i7s6WX8APHfH2kYGdLV195Jb: "Bybit",      // Bybit deposit address
  E2RvJg2myWpKcbkhBuF81gfhYr6KvmNcDbSmr5qnatYy: "Kraken",     // Kraken Cold Wallet
  FYchVwTvXSDf1mEndg8p1DvBUagYV7444VYHWq9GTxq6: "Upbit",      // Upbit Hot Wallet
  "5PLU3MB93miiNvd1dcY6VkWSzjeGBQpssqbbBJDALrkm": "Upbit",     // Upbit Hot Wallet
  "8Mm46CsqxiyAputDUp2cXHg41HE3BfynTeMBDwzrMZQH": "Bithumb",   // Bithumb Hot Wallet 1
  "3B7XAQrLoEMDEGvX8569F9GRb9PcXXocJmj5wvhhei9z": "BtcTurk",   // BtcTurk Cold Wallet
  u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: "Gate",        // Gate Hot Wallet
  "9SLPTL41SPsYkgdsMzdfJsxymEANKr5bYoBsQzJyKpKS": "Hyperunit", // Hyperunit Hot Wallet
};
const exchangeOf = (w) => EXCHANGES[w] || null;

// A top holder with this much SOL is exchange-size: every one seen on 2026-11-05 (100,000 to 9.3 million SOL) was an
// exchange, and the one without a label (CLNE...JZDL, 279k SOL) was funded by Gate's hot wallet.
const EXCHANGE_SOL = 50000;

module.exports = { EXCHANGES, exchangeOf, EXCHANGE_SOL };
