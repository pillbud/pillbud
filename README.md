# pillbud

![pillbud: know before you buy.](brand/readme-banner.png)

A desktop buddy for Solana memecoins. Open any coin in your browser and pillbud reads it in seconds: what the coin is about, the source behind it, whether the story is real, whether the holders are fair, and what just changed. It sits on your desktop and speaks up when something matters.

**Site:** [pillbud.fun](https://pillbud.fun) · **X:** [@pillbud](https://x.com/pillbud) · **Download:** [latest release](https://github.com/pillbud/pillbud/releases/latest) (Windows 10 and 11)

The installer needs no keys: the installed app runs its research through pillbud's hosted service, which holds the API keys and is paid for by the creator fees.

pillbud is read-only. It never connects to a wallet, never signs anything and never trades.

## What it checks

| Check | What you get | Time |
|---|---|---|
| **The read** | What the coin is, where it came from (the tweet, video or article behind it), why people care now, and whether it's real, a LARP, a copycat or just a meme | 3 to 4 s |
| **Holder stamp** | Fair, too early, sketchy, rigged or dumped: launch buyers still holding, the dev's share, linked wallets, and how far the price would drop if they sold. Exchange wallets are named and never counted as a whale | about 1 s |
| **Linked wallets** | Top holders that are one person: a shared first funder, tokens passed between them, or SOL moved through a quiet wallet. Busy wallets (exchanges, relayers) never count as a link | about 5 s |
| **Product test** | For a coin that says it has an app: pillbud opens the site in a hidden, throwaway browser, tries it, and says whether it works, partly works, is simulated or isn't built | 11 to 19 s |
| **Fee promises** | When a coin says its creator fees go to buybacks, burns, charity, holders or a treasury, pillbud reads pump.fun's fee setup and where the SOL actually went | about 1 s |
| **Live alerts** | Dev sells, whale sells, pumps and dumps, pushed from the chain as they happen | under 1 s |

**Copycats, judged on the story.** Coins share names, tickers and pictures all the time, and that alone isn't flagged. A coin is a copy when an earlier coin on the same story is worth at least twice as much, or when it copies a big coin that already ran.

**Just a meme.** A coin with nothing behind it (no post, news, person or product) that isn't pretending to be anything is called just that. It's neither a green light nor a LARP.

**Dumped.** On a coin under a week old, when the launch buyers and the dev already sold 10% or more into it and the price is 70% or more below its peak, the holder stamp says so instead of "too early".

**Talk to it.** Hold `Ctrl + Alt` and ask a question about the coin. Text mode is the default; voice is optional.

## The APIs it uses

Every check calls outside services. The paid ones are the running cost of each check, and the creator fees cover them.

| Service | What pillbud uses it for | Cost | Code |
|---|---|---|---|
| [Claude](https://www.anthropic.com/api) (Anthropic) | the read, the answers when you ask it something, and judging the app test | paid, per call | [read.js](src/read.js), [brain.js](src/brain.js), [narrative.js](src/research/narrative.js), [probe.js](src/research/probe.js) |
| [Helius](https://www.helius.dev) | Solana data: holders, the dev's wallet, linked wallets, launch buys, fee settings | paid plan (the free plan works, slower) | [chain.js](src/research/chain.js), [holders.js](src/research/holders.js), [trench.js](src/research/trench.js), [fees.js](src/research/fees.js) |
| [twitterapi.io](https://twitterapi.io) or the [X API](https://developer.x.com) | finding the tweet behind a coin and who really posted it | paid, per call | [x.js](src/research/x.js), [legit.js](src/research/legit.js) |
| [ElevenLabs](https://elevenlabs.io) | speech to text when you ask pillbud out loud | paid, per minute | [voice.js](src/voice.js) |
| [DexScreener](https://docs.dexscreener.com) | price, market cap, liquidity, pairs | free | [market.js](src/research/market.js) |
| [GeckoTerminal](https://www.geckoterminal.com/dex-api) | price history for the chart | free | [market.js](src/research/market.js) |
| [pump.fun](https://pump.fun) | the coin's page: creator, links, description | free | [pumpfun.js](src/research/pumpfun.js) |

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
- Facts about the coin go to Claude to write the read. A question you ask out loud goes to ElevenLabs to become text.
- The product test runs in a hidden browser with its own in-memory session: no cookies, no wallet, no extensions. Downloads are cancelled and never run.
- In the installed app these calls pass through pillbud's hosted service, which adds the API keys and forwards them. It sees the same coin facts, nothing from your screen. Run from source with your own keys in `.env` and it talks to the providers directly.

## Run it from source

You need Windows 10 or 11, [Node.js](https://nodejs.org) 20 or newer and [git](https://git-scm.com).

```bash
git clone https://github.com/pillbud/pillbud.git
cd pillbud
npm install
copy .env.example .env
```

Without keys, it uses pillbud's hosted service like the installed app does. To use your own, open `.env` and add them. These two go together:

- `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com)
- `HELIUS_RPC_URL` from [helius.dev](https://www.helius.dev) (the free plan works)

`ELEVENLABS_API_KEY` (voice) and `TWITTERAPI_IO_KEY` (X search) are optional. Then:

```bash
npm start
```

pillbud appears at the bottom right of your screen. Open a coin in your browser and it starts reading. With your own keys, you pay for your own API usage.

To build the Windows installer yourself: `npm run dist` (it lands in `dist/`).

### Settings

Right-click the tray icon for text or voice mode, tone, the balloon's look and size, volume, mute and do not disturb. Developer settings go in `config.json` (copy `config.example.json`).

### The browser extension (optional)

Tab reading works without it. To add it anyway: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `extension` folder. It sends only the page URL, only to pillbud on `localhost`.

## How the code is laid out

```
src/main.js            the app: finds the coin, runs the checks, alerts, the tray, the balloon
src/read.js            the read (what the coin is, its source, real or copy)
src/brain.js           the prompts for Claude
src/research/          chain data, holders, linked wallets (trench.js), exchange labels (labels.js), fees, the product test (probe.js), X, pump.fun
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
