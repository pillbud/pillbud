// Push feed: Helius' standard websocket (accountSubscribe, available on the free plan) instead of polling.
// Every trade changes the pump.fun curve account (or the PumpSwap pool's two vaults) and every sell changes the
// seller's token account, so watching those accounts gives price moves and dev/whale sells as they land
// ("processed" commitment: ~0.5 to 1.5 s after the trade). PumpPortal's trade stream would also work but is paid.
const WebSocket = require("ws");
const { keys } = require("./env");

function makeFeed(log = () => {}) {
  const url = (keys.HELIUS_RPC_URL || "").replace(/^http/, "ws");
  let ws = null, open = false, nextId = 1, retry = 0, pinger = null, reconnects = 0, lastMsg = Date.now();
  const pending = new Map();   // request id -> { account, params, handler, key }
  const subs = new Map();      // subscription id -> handler
  const wanted = new Map();    // key -> { account, params, handler, subId }

  function connect() {
    if (ws || !url) return;
    ws = new WebSocket(url);
    ws.on("open", () => {
      open = true; retry = 0;
      for (const w of wanted.values()) send(w);
      lastMsg = Date.now();
      // Helius drops idle sockets; and a socket that slept or lost the network can stay "open" while dead: if nothing
      // (not even a pong) came back for 75 s, drop it and reconnect
      pinger = setInterval(() => { try { if (Date.now() - lastMsg > 75000) { log("feed: no answer for 75 s, reconnecting"); ws.terminate(); } else ws.ping(); } catch { /* reconnect handles it */ } }, 30000);
    });
    ws.on("pong", () => { lastMsg = Date.now(); });
    ws.on("message", (buf) => {
      lastMsg = Date.now();
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (m.id && pending.has(m.id)) { const w = pending.get(m.id); pending.delete(m.id); if (m.result != null && wanted.get(w.key) === w) { w.subId = m.result; subs.set(m.result, w.handler); } return; }
      if (m.method === "accountNotification") {
        const h = subs.get(m.params.subscription);
        if (h) { try { h(m.params.result.value, m.params.result.context.slot, Date.now()); } catch (e) { log(`feed handler: ${e.message}`); } }
      }
    });
    ws.on("close", () => {
      open = false; ws = null; clearInterval(pinger); subs.clear();
      if (wanted.size) { reconnects++; const wait = Math.min(15000, 500 * 2 ** retry++); log(`feed: socket closed, reconnecting in ${wait} ms`); setTimeout(connect, wait); }
    });
    ws.on("error", (e) => log(`feed: ${e.message}`));
  }
  function send(w) {
    const id = nextId++;
    pending.set(id, w);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "accountSubscribe", params: [w.account, w.params] }));
  }

  /** push updates of one account to handler(value, slot, receivedAt); returns an unsubscribe function */
  function watchAccount(account, encoding, handler) {
    const key = `${account}:${encoding}`;
    const w = { key, account, params: { encoding, commitment: "processed" }, handler, subId: null };
    wanted.set(key, w);
    if (open) send(w); else connect();
    return () => {
      wanted.delete(key);
      if (w.subId != null) { subs.delete(w.subId); if (open) ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "accountUnsubscribe", params: [w.subId] })); }
      if (!wanted.size && ws) { try { ws.close(); } catch { /* gone */ } }
    };
  }

  /** kill the socket now (after sleep/resume, or to test recovery): it reconnects and resubscribes by itself */
  function drop() { if (ws) { try { ws.terminate(); } catch { /* gone */ } } else if (wanted.size) connect(); }
  return { watchAccount, drop, connected: () => open, count: () => wanted.size, reconnects: () => reconnects, close: () => { wanted.clear(); try { ws?.close(); } catch { /* gone */ } } };
}

module.exports = { makeFeed };
