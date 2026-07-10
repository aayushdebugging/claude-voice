/**
 * Source of a tiny OpenAI-compatible Kokoro TTS server, run via `uv` (no Docker
 * needed). `claude-voice local` writes this to `~/.claude-voice/kokoro-server.py`
 * and prints the command to run it. It uses `kokoro-onnx` (CPU, no PyTorch),
 * auto-downloads the model on first run, and serves `/v1/audio/speech` → PCM.
 */
export const KOKORO_SERVER_PY = `import argparse, json, os, sys, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
from kokoro_onnx import Kokoro

MODELS = os.path.expanduser("~/.claude-voice/models")
FILES = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}

def ensure(name):
    os.makedirs(MODELS, exist_ok=True)
    path = os.path.join(MODELS, name)
    if not os.path.exists(path):
        print("downloading " + name + " ...", file=sys.stderr, flush=True)
        urllib.request.urlretrieve(FILES[name], path)
    return path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8880)
    a = ap.parse_args()
    kok = Kokoro(ensure("kokoro-v1.0.onnx"), ensure("voices-v1.0.bin"))

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        def do_POST(self):
            if "/audio/speech" not in self.path:
                self.send_response(404); self.end_headers(); return
            try:
                n = int(self.headers.get("content-length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                text = body.get("input", "")
                voice = body.get("voice", "af_heart")
                try:
                    speed = float(body.get("speed", 1.0))
                except (TypeError, ValueError):
                    speed = 1.0
                speed = min(3.0, max(0.5, speed))
                lang = body.get("lang", "en-us") or "en-us"
                try:
                    samples, sr = kok.create(text, voice=voice, speed=speed, lang=lang)
                except Exception:
                    # Unknown/unsupported language → fall back to English.
                    samples, sr = kok.create(text, voice=voice, speed=speed, lang="en-us")
                pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                self.send_response(200)
                self.send_header("content-type", "audio/pcm")
                self.send_header("content-length", str(len(pcm)))
                self.end_headers(); self.wfile.write(pcm)
            except Exception as e:
                msg = str(e).encode()
                self.send_response(500)
                self.send_header("content-length", str(len(msg)))
                self.end_headers(); self.wfile.write(msg)

    print("kokoro-onnx server on 127.0.0.1:" + str(a.port), file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()

if __name__ == "__main__":
    main()
`;
