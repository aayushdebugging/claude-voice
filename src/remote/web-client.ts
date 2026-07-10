/**
 * The single-page web client served to remote devices (e.g. a phone).
 *
 * Vanilla HTML/CSS/JS (no build step, no external requests — CSP-friendly). It
 * captures push-to-talk audio via MediaRecorder, streams each utterance to the
 * server over WebSocket, shows the transcript + Claude's streamed reply, and
 * plays the returned speech through the Web Audio API (which unlocks reliably
 * on iOS after the first tap). A live waveform (Web Audio AnalyserNode → canvas)
 * reacts to the mic while recording and to the reply while it plays. Branded as
 * "Claude Voice AI" with the same gradient palette as the terminal UI. The auth
 * token is read from the page URL.
 */
export function webClientHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<meta name="theme-color" content="#12121c" />
<title>Claude Voice AI</title>
<style>
  :root { --c1:#f5a623; --c2:#e8618c; --c3:#a66cff; --c4:#5b8cff;
          --bg:#12121c; --fg:#e6e6f0; --panel:#1c1c2b; --line:#2a2a3e; --dim:#8b8ba7; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; color: var(--fg);
         background: radial-gradient(1100px 560px at 50% -12%, #201a37, var(--bg));
         display: flex; flex-direction: column; height: 100dvh; }
  header { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
  .logo { font-size: 18px; }
  .brand { font-weight: 800; font-size: 19px; letter-spacing: .02em;
           background: linear-gradient(90deg,var(--c1),var(--c2),var(--c3),var(--c4),var(--c3),var(--c2),var(--c1));
           background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent;
           animation: flow 6s linear infinite; }
  @keyframes flow { to { background-position: 200% center; } }
  #status { margin-left: auto; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .09em;
            display: flex; align-items: center; gap: 7px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); }
  #dot.on { background: #a6e3a1; box-shadow: 0 0 9px #a6e3a1; }
  #dot.busy { background: var(--c3); box-shadow: 0 0 9px var(--c3); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
  .msg .who { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 3px; }
  .you .who { color: #7fdfe6; } .claude .who { color: var(--c3); } .note .who { color: #f9e2af; } .err .who { color: #f38ba8; }
  .msg .body { white-space: pre-wrap; line-height: 1.45; }
  canvas#wave { width: 100%; height: 60px; display: block; opacity: .9; }
  footer { padding: 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); border-top: 1px solid var(--line);
           display: flex; flex-direction: column; gap: 12px; background: rgba(28,28,43,.55); }
  #talk { user-select: none; touch-action: none; border: none; border-radius: 16px; padding: 22px; font-size: 18px;
          font-weight: 800; color: #12121c; background: linear-gradient(135deg,var(--c1),var(--c2),var(--c3));
          box-shadow: 0 8px 28px rgba(166,108,255,.35); transition: transform .06s; }
  #talk:active, #talk.rec { transform: scale(.98); background: linear-gradient(135deg,#f38ba8,#e8618c); }
  #talk[disabled] { background: #2a2a3e; color: #6c6c86; box-shadow: none; }
  #stop { border: 1px solid var(--line); border-radius: 12px; padding: 12px; font-size: 15px; font-weight: 700;
          color: #f38ba8; background: transparent; }
  #stop:active { background: #26263a; }
  .row { display: flex; gap: 8px; }
  #text { flex: 1; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font-size: 16px; }
  #send { background: linear-gradient(135deg,var(--c3),var(--c4)); color: #12121c; border: none; border-radius: 10px; padding: 0 16px; font-weight: 800; }
  .hint { font-size: 12px; color: var(--dim); text-align: center; }
</style>
</head>
<body>
  <header>
    <span class="logo">🎙️</span> <span class="brand">Claude Voice AI</span>
    <span id="status"><span id="dot"></span><span id="statustext">connecting…</span></span>
  </header>
  <div id="log"></div>
  <canvas id="wave"></canvas>
  <footer>
    <button id="talk" disabled>Hold to talk</button>
    <button id="stop">◼ Stop speaking</button>
    <div class="row">
      <input id="text" type="text" placeholder="…or type a message" autocomplete="off" />
      <button id="send">Send</button>
    </div>
    <div class="hint">Hold the button, speak, release. Replies play aloud. Tap Stop to cut it off.</div>
  </footer>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  var logEl = document.getElementById('log');
  var statusEl = document.getElementById('statustext');
  var dotEl = document.getElementById('dot');
  var talkBtn = document.getElementById('talk');
  var stopBtn = document.getElementById('stop');
  var textInput = document.getElementById('text');
  var sendBtn = document.getElementById('send');
  var canvas = document.getElementById('wave');

  var ws = null, recorder = null, chunks = [], stream = null, audioCtx = null;
  var liveEl = null, currentSource = null, analyser = null, waveData = null, micSource = null;

  function setStatus(s, kind) { statusEl.textContent = s; dotEl.className = kind || ''; }
  function add(cls, who) {
    var m = document.createElement('div'); m.className = 'msg ' + cls;
    var w = document.createElement('div'); w.className = 'who'; w.textContent = who;
    var b = document.createElement('div'); b.className = 'body';
    m.appendChild(w); m.appendChild(b); logEl.appendChild(m);
    logEl.scrollTop = logEl.scrollHeight; return b;
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws?t=' + encodeURIComponent(token));
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { setStatus('ready', 'on'); talkBtn.disabled = false; };
    ws.onclose = function () { setStatus('disconnected', ''); talkBtn.disabled = true; setTimeout(connect, 1500); };
    ws.onerror = function () { setStatus('error', ''); };
    ws.onmessage = function (ev) {
      if (typeof ev.data !== 'string') { playAudio(ev.data); return; }
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'state') { setStatus(m.state, m.state === 'idle' ? 'on' : 'busy'); if (m.state !== 'thinking') liveEl = null; }
      else if (m.type === 'transcript') { add('you', 'You').textContent = m.text; }
      else if (m.type === 'token') { if (!liveEl) liveEl = add('claude', 'Claude'); liveEl.textContent += m.text; logEl.scrollTop = logEl.scrollHeight; }
      else if (m.type === 'reply') { if (!liveEl) add('claude', 'Claude').textContent = m.text; liveEl = null; }
      else if (m.type === 'note') { add('note', '⚠').textContent = m.text; }
      else if (m.type === 'error') { add('err', '✖').textContent = m.text; }
    };
  }

  // Lazily create the audio context + a shared analyser (for the waveform).
  function ensureCtx() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (audioCtx && !analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.78;
      waveData = new Uint8Array(analyser.frequencyBinCount);
    }
  }

  function playAudio(arrayBuffer) {
    if (!audioCtx) return;
    audioCtx.decodeAudioData(arrayBuffer.slice(0), function (buf) {
      stopPlayback();
      var src = audioCtx.createBufferSource(); src.buffer = buf;
      if (analyser) src.connect(analyser); // tap for the waveform
      src.connect(audioCtx.destination);
      currentSource = src;
      src.onended = function () { if (currentSource === src) currentSource = null; };
      src.start();
    }, function () {});
  }
  function stopPlayback() { if (currentSource) { try { currentSource.stop(); } catch (e) {} currentSource = null; } }
  function cancelAll() {
    stopPlayback(); liveEl = null;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'cancel' }));
    setStatus('idle', 'on');
  }

  async function ensureRecorder() {
    if (recorder) return true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      add('err', '✖').textContent = 'Microphone blocked. Allow mic access for this page (and accept the certificate warning).';
      return false;
    }
    var mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
             : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = function () {
      var blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); chunks = [];
      if (blob.size > 800 && ws && ws.readyState === 1) ws.send(blob);
    };
    return true;
  }

  var recording = false;
  async function startRec(e) {
    if (e) e.preventDefault();
    ensureCtx();
    stopPlayback(); // barge-in: talking over a reply cuts its audio here
    if (recording || talkBtn.disabled) return;
    if (!(await ensureRecorder())) return;
    recording = true; chunks = []; talkBtn.classList.add('rec'); talkBtn.textContent = 'Listening… release to send';
    if (analyser && stream) { try { micSource = audioCtx.createMediaStreamSource(stream); micSource.connect(analyser); } catch (e2) {} }
    try { recorder.start(); } catch (e2) {}
  }
  function stopRec(e) {
    if (e) e.preventDefault();
    if (!recording) return;
    recording = false; talkBtn.classList.remove('rec'); talkBtn.textContent = 'Hold to talk';
    if (micSource) { try { micSource.disconnect(); } catch (e3) {} micSource = null; }
    try { recorder.stop(); } catch (e2) {}
  }

  talkBtn.addEventListener('pointerdown', startRec);
  talkBtn.addEventListener('pointerup', stopRec);
  talkBtn.addEventListener('pointercancel', stopRec);
  talkBtn.addEventListener('pointerleave', stopRec);
  stopBtn.addEventListener('click', cancelAll);

  function sendText() {
    var t = textInput.value.trim(); if (!t) return; ensureCtx();
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'text', text: t })); textInput.value = ''; }
  }
  sendBtn.addEventListener('click', sendText);
  textInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendText(); });

  // ---- live waveform ----------------------------------------------------
  var cctx = null;
  function sizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor((canvas.clientWidth || 320) * dpr);
    canvas.height = Math.floor(60 * dpr);
    cctx = canvas.getContext('2d');
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function draw() {
    requestAnimationFrame(draw);
    if (!cctx) return;
    var w = canvas.clientWidth || 320, h = 60;
    cctx.clearRect(0, 0, w, h);
    if (analyser && waveData) analyser.getByteFrequencyData(waveData);
    var bins = 32;
    var g = cctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#f5a623'); g.addColorStop(0.4, '#e8618c'); g.addColorStop(0.7, '#a66cff'); g.addColorStop(1, '#5b8cff');
    cctx.fillStyle = g;
    var bw = w / bins, t = Date.now() / 300;
    for (var i = 0; i < bins; i++) {
      var v = (analyser && waveData) ? waveData[Math.floor((i / bins) * waveData.length)] / 255 : 0;
      v = Math.max(v, 0.05 + 0.05 * Math.abs(Math.sin(t + i * 0.5))); // gentle idle shimmer
      var bh = Math.max(3, v * (h - 8));
      cctx.fillRect(i * bw + 1.5, (h - bh) / 2, bw - 3, bh);
    }
  }
  window.addEventListener('resize', sizeCanvas);
  sizeCanvas(); requestAnimationFrame(draw);

  if (!token) { setStatus('missing token', ''); add('err', '✖').textContent = 'This link is missing its access token.'; }
  else connect();
})();
</script>
</body>
</html>`;
}
