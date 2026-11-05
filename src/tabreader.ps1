# pillbud's tab reader: no browser extension needed. Every 500 ms it checks which window is in front; when it's a
# Chromium-based browser (Chrome, Edge, Brave, Arc, Vivaldi, Opera), it reads ONLY the address bar's value through
# Windows UI Automation (the same accessibility API screen readers use). No page content, no screenshots, no titles.
# The address bar element is found once per window and cached, so a tick costs one cheap property read.
# Output (one JSON line, only when something changes):  {"fg":<hwnd>,"p":"<process>"}   foreground window changed
#                                                       {"b":"<process>","u":"<address bar text>","h":<hwnd>}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class PbWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$A = [System.Windows.Automation.AutomationElement]
$editCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$valueProp = [System.Windows.Automation.ValuePattern]::ValueProperty
$browsers = @("chrome", "msedge", "brave", "arc", "vivaldi", "opera", "chromium", "thorium")
$names = @{}      # pid -> process name
$bars = @{}       # hwnd -> address bar element
$lastFg = 0; $lastUrl = ""
[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()

function Out($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

while ($true) {
  Start-Sleep -Milliseconds 500
  try {
    $h = [PbWin]::GetForegroundWindow()
    $hv = $h.ToInt64()
    if ($hv -eq 0) { continue }
    $procId = [uint32]0; [void][PbWin]::GetWindowThreadProcessId($h, [ref]$procId)
    if (-not $names.ContainsKey($procId)) {
      $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
      $names[$procId] = if ($pr) { $pr.ProcessName.ToLower() } else { "" }
      if ($names.Count -gt 200) { $names.Clear() }
    }
    $p = $names[$procId]
    if ($hv -ne $lastFg) { $lastFg = $hv; Out @{ fg = $hv; p = $p } }
    if ($browsers -notcontains $p) { continue }
    $bar = $bars[$hv]
    if (-not $bar) {
      # the omnibox is the first edit box in the browser's own UI (it comes before the page in the tree)
      $root = $A::FromHandle($h)
      $bar = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)
      if (-not $bar) { continue }
      $bars[$hv] = $bar
      if ($bars.Count -gt 50) { $bars.Clear() }
    }
    $u = [string]$bar.GetCurrentPropertyValue($valueProp)
    if ($u -and $u -ne $lastUrl) { $lastUrl = $u; Out @{ b = $p; u = $u; h = $hv } }
  } catch {
    $bars.Remove($lastFg)   # the window or its address bar went away: find it again next time
  }
}
