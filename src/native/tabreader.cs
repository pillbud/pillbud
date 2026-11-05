// pillbud's tab reader (compiled helper; same job as src/tabreader.ps1, ~5x lighter).
// Every 500 ms: which window is in front; if it's a Chromium-based browser, read ONLY its address bar's value through
// Windows UI Automation (the accessibility API screen readers use). No page content, no screenshots, no window titles.
// The address bar element is found once per window and cached, so a tick is one cheap property read.
// Prints one JSON line per change:  {"fg":<hwnd>,"p":"<process>"}  or  {"b":"<process>","u":"<address bar>","h":<hwnd>}
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe (ships with Windows), see src/tabreader.js.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

static class TabReader {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  static readonly HashSet<string> Browsers = new HashSet<string> { "chrome", "msedge", "brave", "arc", "vivaldi", "opera", "chromium", "thorium" };
  static string Esc(string s) {
    var b = new System.Text.StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.ToString();
  }
  static void Out(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }

  static void Main() {
    Console.OutputEncoding = new System.Text.UTF8Encoding(false); // UTF-8 out (the OEM code page turns a bullet into a raw control char)
    var names = new Dictionary<uint, string>();
    var bars = new Dictionary<long, AutomationElement>();
    var edit = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
    long lastFg = 0; string lastUrl = "";
    Out("{\"ready\":true}");
    // parent gone (pillbud quit) = stdin closes: exit too, so no orphan is ever left behind
    new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();
    while (true) {
      Thread.Sleep(500);
      long hv = 0;
      try {
        IntPtr h = GetForegroundWindow();
        hv = h.ToInt64();
        if (hv == 0) continue;
        uint pid; GetWindowThreadProcessId(h, out pid);
        string p;
        if (!names.TryGetValue(pid, out p)) {
          try { p = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { p = ""; }
          if (names.Count > 200) names.Clear();
          names[pid] = p;
        }
        if (hv != lastFg) { lastFg = hv; Out("{\"fg\":" + hv + ",\"p\":\"" + Esc(p) + "\"}"); }
        if (!Browsers.Contains(p)) continue;
        AutomationElement bar;
        if (!bars.TryGetValue(hv, out bar)) {
          // the omnibox is the first edit box in the browser's own UI (it comes before the page in the tree)
          bar = AutomationElement.FromHandle(h).FindFirst(TreeScope.Descendants, edit);
          if (bar == null) continue;
          if (bars.Count > 50) bars.Clear();
          bars[hv] = bar;
        }
        string u = bar.GetCurrentPropertyValue(ValuePattern.ValueProperty) as string;
        if (!string.IsNullOrEmpty(u) && u != lastUrl) { lastUrl = u; Out("{\"b\":\"" + Esc(p) + "\",\"u\":\"" + Esc(u) + "\",\"h\":" + hv + "}"); }
      } catch {
        bars.Remove(hv); // the window or its address bar went away: find it again next time
      }
    }
  }
}
