// pillbud's screen watcher: reads what's on screen LOCALLY, nothing leaves this PC from here.
// Every 1.5 s: capture the window in front (PrintWindow: its own pixels, so pillbud's balloon on top never leaks in),
// skip it if it hasn't changed (a 48x27 luminance signature), else run Windows' built-in OCR (Windows.Media.Ocr) and
// print the text as one JSON line for pillbud to scan for contract addresses and tickers.
// Only apps where coins show up are ever captured: browsers, chat apps (Telegram, Discord, WhatsApp, Signal, Slack) and
// TradingView, plus any process names passed as arguments (config "watchApps"). Games, editors, terminals, password
// managers, Office and everything else are never captured. Also skipped: password fields (UI Automation IsPassword),
// minimized or tiny windows, and the one browser window showing a video tab.
// stdin: "pause" | "resume" | "skip <hwnd>" (0 = none) | "kick" | "interval <ms>" | "file <png path>" (OCR an image
// file, for tests). When pillbud quits, stdin closes and this exits.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

static class ScreenWatch {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  struct RECT { public int L, T, R, B; }

  static readonly HashSet<string> Watch = new HashSet<string> {
    "chrome", "msedge", "brave", "arc", "vivaldi", "opera", "chromium", "thorium", "firefox", "zen", "floorp", "librewolf", "waterfox",
    "telegram", "ayugram", "kotatogram", "64gram", "unigram", "discord", "discordptb", "discordcanary", "whatsapp", "signal", "slack",
    "tradingview",
  };
  static volatile bool paused = false, kicked = false;
  static long skipHwnd = 0; // a browser window with a video tab in front (twitch, youtube...): nothing to read there
  static volatile int intervalMs = 1500;
  static readonly Queue<string> files = new Queue<string>();

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c == '\n') b.Append("\\n");
      else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.ToString();
  }
  static readonly object outLock = new object();
  static void Out(string json) { lock (outLock) { Console.Out.WriteLine(json); Console.Out.Flush(); } }

  /** 48x27 luminance signature of the frame */
  static byte[] Signature(Bitmap bmp) {
    using (var small = new Bitmap(48, 27)) {
      using (var g = Graphics.FromImage(small)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear; g.DrawImage(bmp, 0, 0, 48, 27); }
      var sig = new byte[48 * 27];
      for (int y = 0; y < 27; y++) for (int x = 0; x < 48; x++) { var c = small.GetPixel(x, y); sig[y * 48 + x] = (byte)((c.R * 3 + c.G * 6 + c.B) / 10); }
      return sig;
    }
  }
  /** "the same frame": at most 3 of 1,296 cells moved (a ticking price or a blinking cursor doesn't count) */
  static bool Same(byte[] a, byte[] b) {
    if (a == null || b == null) return false;
    int moved = 0;
    for (int i = 0; i < a.Length; i++) if (Math.Abs(a[i] - b[i]) > 10 && ++moved > 3) return false;
    return true;
  }

  /** wait for a WinRT async call (polling its status; no SDK-only helpers needed) */
  static T Wait<T>(Windows.Foundation.IAsyncOperation<T> op) {
    while (op.Status == Windows.Foundation.AsyncStatus.Started) Thread.Sleep(4);
    if (op.Status != Windows.Foundation.AsyncStatus.Completed) throw new Exception("OCR " + op.Status);
    return op.GetResults();
  }

  static string Ocr(OcrEngine engine, Bitmap bmp) {
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var bytes = new byte[data.Stride * data.Height];
    Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
    bmp.UnlockBits(data);
    var buf = Windows.Security.Cryptography.CryptographicBuffer.CreateFromByteArray(bytes);
    using (var sb = SoftwareBitmap.CreateCopyFromBuffer(buf, BitmapPixelFormat.Bgra8, bmp.Width, bmp.Height)) {
      var result = Wait(engine.RecognizeAsync(sb));
      var text = new StringBuilder();
      foreach (var line in result.Lines) text.Append(line.Text).Append((char)10);
      return text.ToString();
    }
  }

  /** keep within the OCR engine's size limit (and don't OCR huge windows at full size) */
  static Bitmap Fit(Bitmap bmp, int max) {
    if (bmp.Width <= max && bmp.Height <= max) return null;
    double k = Math.Min((double)max / bmp.Width, (double)max / bmp.Height);
    var b = new Bitmap((int)(bmp.Width * k), (int)(bmp.Height * k), PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(b)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g.DrawImage(bmp, 0, 0, b.Width, b.Height); }
    return b;
  }

  static void OcrAndReport(OcrEngine engine, Bitmap bmp, string p, int max) {
    var sw = Stopwatch.StartNew();
    var fit = Fit(bmp, max);
    string text = Ocr(engine, fit ?? bmp);
    if (fit != null) fit.Dispose();
    Out("{\"p\":\"" + Esc(p) + "\",\"ms\":" + sw.ElapsedMilliseconds + ",\"w\":" + bmp.Width + ",\"h\":" + bmp.Height + ",\"t\":\"" + Esc(text) + "\"}");
  }

  static void Main(string[] args) {
    foreach (var a in args) Watch.Add(a.ToLowerInvariant());
    Console.OutputEncoding = new System.Text.UTF8Encoding(false); // UTF-8 out (the OEM code page turns a bullet into a raw control char)
    SetProcessDPIAware();
    var engine = OcrEngine.TryCreateFromUserProfileLanguages();
    if (engine == null) { Out("{\"error\":\"no OCR language installed\"}"); return; }
    int max = Math.Min((int)OcrEngine.MaxImageDimension, 2000); // bigger frames are scaled down first (OCR time grows with pixels)
    Out("{\"ready\":true,\"lang\":\"" + engine.RecognizerLanguage.LanguageTag + "\",\"max\":" + max + "}");
    new Thread(() => {
      try {
        string l;
        while ((l = Console.In.ReadLine()) != null) {
          if (l == "pause") paused = true;
          else if (l == "resume") paused = false;
          else if (l.StartsWith("interval ")) intervalMs = Math.Max(500, int.Parse(l.Substring(9)));
          else if (l.StartsWith("skip ")) Interlocked.Exchange(ref skipHwnd, long.Parse(l.Substring(5))); // that window shows a video
          else if (l == "kick") kicked = true;               // the tab changed: look again soon
          else if (l.StartsWith("file ")) lock (files) files.Enqueue(l.Substring(5));
        }
      } catch { }
      Environment.Exit(0);
    }) { IsBackground = true }.Start();

    var names = new Dictionary<uint, string>();
    byte[] lastSig = null; long lastHwnd = 0; int skippedSame = 0, streak = 0;
    while (true) {
      // a window that keeps changing (video, a scrolling feed) is read less often: 1.5 s, then 3 s, then 4.5 s
      int wait = streak <= 3 ? intervalMs : streak <= 8 ? intervalMs * 2 : intervalMs * 3;
      for (int slept = 0; slept < wait && !kicked; slept += 100) Thread.Sleep(100);
      if (kicked) { kicked = false; streak = 0; }
      // test images first
      string file = null;
      lock (files) if (files.Count > 0) file = files.Dequeue();
      if (file != null) {
        try { using (var b = new Bitmap(file)) using (var b32 = b.Clone(new Rectangle(0, 0, b.Width, b.Height), PixelFormat.Format32bppArgb)) OcrAndReport(engine, b32, "file", max); }
        catch (Exception e) { Out("{\"err\":\"" + Esc(e.Message) + "\"}"); }
        continue;
      }
      if (paused) continue;
      try {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero || IsIconic(h) || h.ToInt64() == Interlocked.Read(ref skipHwnd)) continue;
        uint pid; GetWindowThreadProcessId(h, out pid);
        string p;
        if (!names.TryGetValue(pid, out p)) {
          try { p = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { p = ""; }
          if (names.Count > 200) names.Clear();
          names[pid] = p;
        }
        if (!Watch.Contains(p)) continue; // not a browser, chat or charting app: never captured
        try { var f = AutomationElement.FocusedElement; if (f != null && f.Current.IsPassword) continue; } catch { }
        RECT r;
        if (!GetWindowRect(h, out r)) continue;
        int w = r.R - r.L, hh = r.B - r.T;
        if (w < 240 || hh < 120 || w > 8000 || hh > 8000) continue;
        using (var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb)) {
          using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); bool ok = PrintWindow(h, dc, 2); g.ReleaseHdc(dc); if (!ok) continue; }
          var sig = Signature(bmp);
          if (h.ToInt64() == lastHwnd && Same(sig, lastSig)) { skippedSame++; streak = 0; continue; }
          streak = h.ToInt64() == lastHwnd ? streak + 1 : 0;
          lastSig = sig; lastHwnd = h.ToInt64();
          OcrAndReport(engine, bmp, p, max);
        }
      } catch (Exception e) { Out("{\"err\":\"" + Esc(e.Message) + "\"}"); }
    }
  }
}
