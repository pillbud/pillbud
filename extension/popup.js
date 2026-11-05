(async () => {
  const app = document.getElementById("app"), tab = document.getElementById("tab");
  try {
    const s = await (await fetch("http://127.0.0.1:47321/status")).json();
    app.textContent = s.coin ? `Watching $${s.coin.symbol || "?"} (${s.coin.mint.slice(0, 4)}...${s.coin.mint.slice(-4)})` : s.busy ? "Researching..." : "Running. Open a coin page.";
  } catch { app.textContent = "The pillbud app isn't running. Start it, then reload this tab."; }
  const { last } = await chrome.storage.session.get("last");
  if (last) tab.textContent = `Last sent: ${last.url}${last.offline ? " (app offline)" : ""}`;
})();
