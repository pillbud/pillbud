# pillbud

A desktop buddy for Solana memecoins. Open any coin in your browser and pillbud reads it in seconds: what the coin is about, the source behind it, whether the story is real, whether the holders are fair, and what just changed. It sits on your desktop and speaks up when something matters.

**Site:** [pillbud.vercel.app](https://pillbud.vercel.app) · **X:** [@pillbud](https://x.com/pillbud)

pillbud is read-only. It never connects to a wallet, never signs anything and never trades.

## What it checks

| Check | What you get | Time |
|---|---|---|
| **The read** | What the coin is, where it came from (the tweet, video or article behind it), why people care now, and whether it's real, a LARP or a copycat | 3 to 4 s |
| **Holder stamp** | Fair, too early, sketchy or rigged: launch buyers still holding, the dev's share, linked wallets, and how far the price would drop if they sold | about 1 s |
| **Linked wallets** | Top holders that are one person: a shared first funder, tokens passed between them, or SOL moved through a quiet wallet. Busy wallets (exchanges, relayers) never count as a link | about 5 s |
| **Product test** | For a coin that says it has an app: pillbud opens the site in a hidden, throwaway browser, tries it, and says whether it works, partly works, is simulated or isn't built | 11 to 19 s |
| **Fee promises** | When a coin says its creator fees go to buybacks, burns, charity, holders or a treasury, pillbud reads pump.fun's fee setup and where the SOL actually went | about 1 s |
| **Live alerts** | Dev sells, whale sells, pumps and dumps, pushed from the chain as they happen | under 1 s |

**Copycats, judged on the story.** Coins share names, tickers and pictures all the time, and that alone isn't flagged. A coin is a copy when an earlier coin on the same story is worth at least twice as much, or when it copies a big coin that already ran.

**Talk to it.** Hold `Ctrl + Alt` and ask a question about the coin. Text mode is the default; voice is optional.

## How it sees the coin

You don't paste anything. pillbud picks up the coin you're on from:

- the address of your browser tab (Windows UI Automation),
- the window in front of you, read on your PC with Windows OCR,
- a copied contract address,
- or the optional browser extension in `extension/`.

Works with pump.fun, DexScreener, GMGN, Axiom, Photon, Birdeye and Solscan.

## Privacy

- Screen and tab reading happen on your PC. Only a coin address that pillbud finds leaves it.
- The coin address goes to Helius (Solana data), DexScreener, pump.fun and, if you add a key, an X search API.
- Facts about the coin go to Claude to write the read. In voice mode, spoken lines go to ElevenLabs.
- The product test runs in a hidden browser with its own in-memory session: no cookies, no wallet, no extensions. Downloads are cancelled and never run.
- Your keys stay in `.env` on your PC. Nothing is sent anywhere else.

## Run it from source

You need Windows 10 or 11, [Node.js](https://nodejs.org) 20 or newer and [git](https://git-scm.com).

```bash
git clone https://github.com/pillbud/pillbud.git
cd pillbud
npm install
copy .env.example .env
```

Open `.env` and add your keys. Two are required:

- `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com)
- `HELIUS_RPC_URL` from [helius.dev](https://www.helius.dev) (the free plan works)

`ELEVENLABS_API_KEY` (voice) and `TWITTERAPI_IO_KEY` (X search) are optional. Then:

```bash
npm start
```

pillbud appears at the bottom right of your screen. Open a coin in your browser and it starts reading. You pay for your own API usage.

### Settings

Right-click the tray icon for text or voice mode, tone, the balloon's look and size, volume, mute and do not disturb. Developer settings go in `config.json` (copy `config.example.json`).

### The browser extension (optional)

Tab reading works without it. To add it anyway: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `extension` folder. It sends only the page URL, only to pillbud on `localhost`.

## How the code is laid out

```
src/main.js            the app: finds the coin, runs the checks, alerts, the tray, the balloon
src/read.js            the read (what the coin is, its source, real or copy)
src/brain.js           the prompts for Claude
src/research/          chain data, holders, linked wallets (trench.js), fees, the product test (probe.js), X, pump.fun
src/detect.js          finds a coin address in a URL, a window or the clipboard
renderer/              the window: the character, the balloon, sounds
extension/             the optional Chrome extension
test/                  tests; most run against live coins and need keys
brand/sprites/         the pillbud character (not MIT, see below)
```

## License

The code is MIT: see [LICENSE](LICENSE).

The pillbud character art in `brand/` and the pillbud name and character are **not** MIT. You can use them to run pillbud and your own builds of it, not in other apps, tokens or products: see [brand/LICENSE.md](brand/LICENSE.md). If you fork pillbud into your own app, bring your own character.

Fonts in `renderer/fonts` are under the SIL Open Font License (license files included).

## Not financial advice

pillbud reads public data and can be wrong. It tells you what it found and where it found it, so you can check. Do your own research.
