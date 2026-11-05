"""pillbud's local speech-to-text: faster-whisper kept loaded in memory, answering on 127.0.0.1 only.

POST /transcribe  (body = audio bytes: webm/ogg/wav/mp3)  ->  {"text": "...", "ms": 812, "audio_s": 2.4}
GET  /health                                               ->  {"ok": true, "model": "base.en"}
Started by the Electron app (src/voice.js). Model name and port come from argv.
"""
import json, os, sys, tempfile, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = sys.argv[1] if len(sys.argv) > 1 else "base.en"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 47322
# words the trader is likely to say, so whisper spells them right
PROMPT = "Solana memecoin talk: pump.fun, the dev, dev selling, top holders, bonding curve, market cap, liquidity, rug, CA, ticker, chart, support, resistance, fresh wallets."

from faster_whisper import WhisperModel
t0 = time.time()
model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=max(2, (os.cpu_count() or 4) // 2))
print(f"whisper ready: {MODEL} in {time.time() - t0:.1f}s on port {PORT}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send(200, {"ok": True, "model": MODEL}) if self.path == "/health" else self.send(404, {"error": "no"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.send(404, {"error": "no"})
        n = int(self.headers.get("content-length") or 0)
        data = self.rfile.read(n)
        ext = {"audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg"}.get(self.headers.get("content-type", ""), ".webm")
        fd, path = tempfile.mkstemp(suffix=ext)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            t = time.time()
            segs, info = model.transcribe(path, language="en", beam_size=1, vad_filter=True, initial_prompt=PROMPT, condition_on_previous_text=False)
            text = " ".join(s.text.strip() for s in segs).strip()
            self.send(200, {"text": text, "ms": int((time.time() - t) * 1000), "audio_s": round(info.duration, 2)})
        except Exception as e:  # bad audio etc.
            self.send(500, {"error": str(e)})
        finally:
            try:
                os.remove(path)
            except OSError:
                pass


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
