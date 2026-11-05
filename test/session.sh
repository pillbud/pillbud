#!/usr/bin/env bash
# A scripted session against the hidden app (start it first: PILLBUD_TEST=1 [PILLBUD_SCALE=1.5] electron .).
# Captures the balloon at each step into captures/<prefix>-*.png and prints the timing metrics.
#   bash test/session.sh <prefix> [larp-mint] [legit-mint]
P=${1:-s}; LARP=${2:-JDyazKGDCUUv2UrLxYScLb6DpXiGeqQUfEJrG9Hr15G1}; OTHER=${3:-HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump}
A=${PILLBUD_URL:-http://127.0.0.1:47331}  # the test instance's port (47321 is the real app)
cd "$(dirname "$0")/.."
for i in $(seq 1 40); do curl -s -m 2 $A/status >/dev/null && break; sleep 1; done; sleep 4
waitlog() { for i in $(seq 1 ${2:-45}); do sleep 1; curl -s $A/debug/log | grep -q "$1" && return 0; done; return 1; }
idle() { for i in $(seq 1 ${1:-40}); do sleep 1; curl -s $A/debug/page | grep -q '"mainCurrent":null,"queued":0' && return 0; done; }
shot() { sleep ${2:-0.4}; curl -s -o "captures/$P-$1.png" $A/debug/capture; echo "shot captures/$P-$1.png"; }

curl -s -X POST -H "content-type: application/json" -d '{"mode":"voice","tone":"unhinged"}' $A/debug/pref >/dev/null
# 1. a LARP in voice mode: first words, then the verdict
curl -s -X POST -H "content-type: application/json" -d "{\"url\":\"https://pump.fun/coin/$LARP\"}" $A/coin >/dev/null
shot voice-first-words 2.2
waitlog 'out, [0-9]* ms): ' 50; sleep 3; shot voice-verdict; echo "page: $(curl -s $A/debug/page)"
idle 40
# 2. talk to it: a normal question, then a deep research request
curl -s -X POST --data "who's shilling it, and should I worry?" $A/debug/ask-text >/dev/null
waitlog 'answer (' 30; sleep 2; shot voice-answer
idle 40
curl -s -X POST --data "research this coin: what is it and who's behind it?" $A/debug/ask-text >/dev/null
waitlog 'deep research (' 90; sleep 3; shot voice-deep
idle 60
# 3. text mode, another coin: words typed with blips
curl -s -X POST -H "content-type: application/json" -d '{"mode":"text","tone":"friendly"}' $A/debug/pref >/dev/null
curl -s -X POST -H "content-type: application/json" -d "{\"url\":\"https://pump.fun/coin/$OTHER\"}" $A/coin >/dev/null
shot text-typing 1.2
waitlog 'out, [0-9]* ms): ' 50; sleep 6; shot text-verdict; echo "page: $(curl -s $A/debug/page)"
idle 40
curl -s -X POST -H "content-type: application/json" -d '{"mode":"voice","tone":"friendly"}' $A/debug/pref >/dev/null
echo "--- metrics"; curl -s $A/debug/metrics | node -e "const m=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(m.map(x=>x.what+': '+x.ms+' ms '+(x.coin||'')+' '+(x.audio||(x.voice===false?'text':''))).join('\n'))"
