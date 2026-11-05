// Reading the chart from recent candles: trend, volume spike, drawdown from the high, support and resistance.
// Everything is computed from the candles; the words only describe the numbers. Levels are given as market cap,
// which is how memecoin traders talk about price.

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }
const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);

function money(x) {
  if (x == null || !isFinite(x)) return "?";
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `$${x.toFixed(0)}`;
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
}

/** swing points: a low (or high) that is the extreme of its 2 neighbours on each side */
function swings(list, key, cmp) {
  const out = [];
  for (let i = 2; i < list.length - 2; i++) {
    const x = list[i][key];
    if ([i - 2, i - 1, i + 1, i + 2].every((j) => cmp(x, list[j][key]))) out.push({ i, x });
  }
  return out;
}

/** how many candles touched a level (wick within 3% of it) */
const touches = (list, level, key) => list.filter((c) => Math.abs(c[key] - level) / level < 0.03).length;

function readChart(candles, supply) {
  const list = (candles?.list || []).filter((c) => c.h > 0 && c.l > 0);
  if (list.length < 6) return { ok: false, words: ["not enough trading history for a chart read yet"], candles: list.length, tf: candles?.label };
  const mc = (p) => (supply ? p * supply : p);
  const now = list[list.length - 1];
  const last = now.c;
  let hi = list[0], lo = list[0];
  for (const c of list) { if (c.h > hi.h) hi = c; if (c.l < lo.l) lo = c; }

  // trend over the last 20 candles: net move plus whether highs and lows are stepping up or down
  const n = Math.min(20, list.length);
  const recent = list.slice(-n);
  const move = pct(last, recent[0].o);
  const half = Math.floor(n / 2);
  const a = recent.slice(0, half), b = recent.slice(half);
  const hh = Math.max(...b.map((c) => c.h)) > Math.max(...a.map((c) => c.h));
  const hl = Math.min(...b.map((c) => c.l)) > Math.min(...a.map((c) => c.l));
  const trend = move > 8 && (hh || hl) ? "up" : move < -8 && !(hh && hl) ? "down" : "sideways";

  // volume: the last 3 CLOSED candles against the usual (median of the 30 before). The candle still open is left out:
  // it has only traded for a few seconds, so it would always look like volume is drying up
  const step = list.length > 1 ? list[list.length - 1].t - list[list.length - 2].t : 60000;
  const closed = now.t + step > Date.now() ? list.slice(0, -1) : list;
  const before = closed.slice(-33, -3).map((c) => c.v).filter((v) => v > 0);
  const lastVol = closed.slice(-3).reduce((s, c) => s + c.v, 0) / 3;
  const usual = median(before);
  const volX = usual > 0 ? lastVol / usual : null;

  // support: the highest swing low under the price; resistance: the lowest swing high over it
  const sLows = swings(list, "l", (x, y) => x <= y).filter((s) => s.x < last * 0.99).sort((p, q) => q.x - p.x);
  const sHighs = swings(list, "h", (x, y) => x >= y).filter((s) => s.x > last * 1.01).sort((p, q) => p.x - q.x);
  const support = sLows[0]?.x ?? (lo.l < last * 0.99 ? lo.l : null);
  const resistance = sHighs[0]?.x ?? (hi.h > last * 1.01 ? hi.h : null);

  const drawdown = pct(last, hi.h);          // negative = below the high
  const fromLow = pct(last, lo.l);
  const span = list[list.length - 1].t - list[0].t;

  const r = {
    ok: true, tf: candles.label, candles: list.length, source: candles.source, windowMin: Math.round(span / 60000),
    trend, trendMovePct: round(move), higherHighs: hh, higherLows: hl,
    volumeVsUsual: volX == null ? null : round(volX, 1), volumeSpike: volX != null && volX >= 3,
    mcNow: round(mc(last), 0), highMc: round(mc(hi.h), 0), highAgo: ago(Date.now() - hi.t), lowMc: round(mc(lo.l), 0),
    drawdownFromHighPct: round(drawdown), upFromLowPct: round(fromLow),
    supportMc: support ? round(mc(support), 0) : null, supportTouches: support ? touches(list, support, "l") : 0,
    resistanceMc: resistance ? round(mc(resistance), 0) : null, resistanceTouches: resistance ? touches(list, resistance, "h") : 0,
  };

  const w = [];
  w.push(trend === "up" ? `uptrend: up ${round(move, 0)}% over the last ${n} ${candles.label} candles${hh && hl ? ", higher highs and higher lows" : ""}`
    : trend === "down" ? `downtrend: down ${round(Math.abs(move), 0)}% over the last ${n} ${candles.label} candles${!hh && !hl ? ", lower highs and lower lows" : ""}`
    : `chopping sideways: ${move >= 0 ? "+" : ""}${round(move, 0)}% over the last ${n} ${candles.label} candles`);
  if (volX != null) w.push(volX >= 3 ? `volume spike: the last 3 candles traded ${round(volX, 1)}x the usual` : volX < 0.4 ? `volume drying up: the last 3 candles traded ${round(volX, 1)}x the usual` : `volume normal (${round(volX, 1)}x the usual)`);
  w.push(drawdown > -3 ? `sitting at its high of ${money(mc(hi.h))} for this window` : `${round(Math.abs(drawdown), 0)}% below the window high of ${money(mc(hi.h))} (${r.highAgo})`);
  if (support) w.push(`support around ${money(mc(support))}${r.supportTouches > 1 ? ` (tested ${r.supportTouches} times)` : ""}`);
  if (resistance) w.push(`resistance near ${money(mc(resistance))}${r.resistanceTouches > 1 ? ` (rejected ${r.resistanceTouches} times)` : ""}`);
  r.words = w;
  return r;
}

const round = (x, d = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** the only chart output pillbud says: pumping / dumping / flat, with the number (DexScreener's 5 min and 1 h change) */
function marketState(m, dev) {
  if (!m) return { kind: "unknown", text: "no market data yet" };
  const m5 = m.change?.m5, h1 = m.change?.h1;
  const r = (x) => Math.round(Math.abs(x));
  let st;
  if (m5 != null && m5 >= 10) st = { kind: "pumping", text: `up ${r(m5)}% in 5 min`, pct: m5 };
  else if (m5 != null && m5 <= -10) st = { kind: "dumping", text: `down ${r(m5)}% in 5 min`, pct: m5 };
  else if (h1 != null && h1 >= 25) st = { kind: "pumping", text: `up ${r(h1)}% in the last hour`, pct: h1 };
  else if (h1 != null && h1 <= -25) st = { kind: "dumping", text: `down ${r(h1)}% in the last hour`, pct: h1 };
  else st = { kind: "flat", text: m5 != null ? `${m5 >= 0 ? "up" : "down"} ${Math.abs(Math.round(m5 * 10) / 10)}% in 5 min` : "quiet", pct: m5 ?? 0 };
  // a dev wallet sold in the last 10 minutes: that's the state that matters
  const recent = (dev ? [dev, ...(dev.others || [])] : []).filter((d) => d.lastSellAt && Date.now() - d.lastSellAt < 10 * 60e3);
  if (recent.length) st.devSellingNow = `dev sold ${recent.map((d) => d.soldPct).join(" + ")}% total, last sale ${ago(Date.now() - Math.max(...recent.map((d) => d.lastSellAt)))}`;
  return st;
}

module.exports = { readChart, marketState, money, ago };
