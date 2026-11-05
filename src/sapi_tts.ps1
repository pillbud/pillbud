# pillbud's backup voice: Windows' built-in speech (System.Speech, the same family of voices BonziBuddy used).
# Kept running by src/voice.js. Reads one JSON request per line on stdin: {"id":1,"out":"C:\...\x.wav","text":"..."}
# and answers "ok <id>" or "err <id> <message>". Used only when ElevenLabs can't be reached.
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $env:PILLBUD_SAPI_VOICE
if ($voice) { try { $s.SelectVoice($voice) } catch {} }
$s.Rate = 1
[Console]::Out.WriteLine("ready " + $s.Voice.Name); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $j = $null
  try {
    $j = $line | ConvertFrom-Json
    $s.SetOutputToWaveFile($j.out)
    $s.Speak([string]$j.text)
    $s.SetOutputToNull()
    [Console]::Out.WriteLine("ok " + $j.id)
  } catch { [Console]::Out.WriteLine("err " + $(if ($j) { $j.id } else { 0 }) + " " + $_.Exception.Message) }
  [Console]::Out.Flush()
}
