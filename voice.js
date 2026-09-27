// Mythos Code – Sprachmodus der App.
// Stimme: Piper (Open Source, MIT) im Worker tts-worker.js. Erkennung: Whisper (Open Source) im Worker stt-worker.js.
// Beides läuft lokal; Modelle werden beim ersten Mal geladen und danach im Browser-Speicher gehalten.
// Die Worker werden aus src/lib/mythosVoice.worker.ts und src/lib/mythosStt.worker.ts gebündelt (npm run build:app-voice).
(function () {
  // Müssen zu den gebündelten Versionen passen (package.json / @huggingface/transformers).
  const ORT_TTS = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
  const ORT_STT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/";
  const PIPER_WASM = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";

  const VOICES = [
    { id: "de_DE-thorsten-medium", label: "Thorsten – natürlich" },
    { id: "de_DE-thorsten_emotional-medium", label: "Thorsten – lebendig" },
    { id: "de_DE-kerstin-low", label: "Kerstin – weiblich" },
    { id: "de_DE-ramona-low", label: "Ramona – weiblich" },
    { id: "system", label: "Windows-Stimme (ohne Download)" },
  ];

  // Große Dateien einmal holen, im Cache ablegen und als Blob-URL weitergeben.
  const blobUrls = new Map();
  function cachedBlobUrl(url, type) {
    if (!blobUrls.has(url)) {
      const p = (async () => {
        let cache, res;
        try { cache = await caches.open("mythos-voice"); res = await cache.match(url); } catch (e) { /* ohne Cache */ }
        if (!res) {
          res = await fetch(url);
          if (!res.ok) throw new Error("Download fehlgeschlagen: " + url);
          try { await cache.put(url, res.clone()); } catch (e) { /* egal */ }
        }
        const blob = await res.blob();
        return URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
      })();
      p.catch(() => blobUrls.delete(url));
      blobUrls.set(url, p);
    }
    return blobUrls.get(url);
  }

  // ---------- Text vorbereiten ----------
  function cleanForSpeech(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, " (Code siehe Chat) ")
      .replace(/<tool>[\s\S]*?<\/tool>/g, " ")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " Link ")
      .replace(/ZIEL ERREICHT/g, "")
      .replace(/[#*_`>|~]/g, "")
      .replace(/^\s*[-•]\s+/gm, "")
      .replace(/\s+/g, " ").trim().slice(0, 3000);
  }
  function splitSentences(text, max) {
    max = max || 220;
    const out = []; let cur = "";
    for (const part of text.split(/(?<=[.!?…:;])\s+/)) {
      if (cur && (cur + " " + part).length > max) { out.push(cur); cur = part; } else cur = cur ? cur + " " + part : part;
      while (cur.length > max * 1.5) { const i = cur.lastIndexOf(" ", max) > 40 ? cur.lastIndexOf(" ", max) : max; out.push(cur.slice(0, i)); cur = cur.slice(i).trim(); }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // ---------- Worker-Hilfe ----------
  function workerClient(file, onEvent) {
    const w = new Worker(file);
    const pending = new Map(); let id = 1;
    let readyRes, readyRej;
    const ready = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") readyRes();
      else if (m.type === "error" && m.id == null) readyRej(new Error(m.message));
      else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.type === "error" ? p.rej(new Error(m.message)) : p.res(m); }
      else if (onEvent) onEvent(m);
    };
    w.onerror = (e) => readyRej(new Error(e.message || "Worker-Fehler"));
    return {
      ready, terminate: () => w.terminate(),
      init: (msg) => w.postMessage(msg),
      request: (msg, transfer) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); w.postMessage(Object.assign({ id: i }, msg), transfer || []); }),
    };
  }

  // ---------- Stimme (Piper) ----------
  let ttsClient = null, ttsVoice = "", ttsState = { status: "idle", pct: 0 };
  const ttsSubs = new Set();
  const setTts = (s) => { ttsState = s; ttsSubs.forEach((f) => f(s)); };
  function loadTts(voiceId) {
    if (voiceId === "system") return null;
    if (ttsClient && ttsVoice === voiceId) return ttsClient;
    if (ttsClient) ttsClient.terminate();
    ttsVoice = voiceId; setTts({ status: "loading", pct: 0 });
    const c = workerClient("tts-worker.js", (m) => { if (m.type === "progress") setTts({ status: "loading", pct: m.pct }); });
    ttsClient = c;
    Promise.all([cachedBlobUrl(PIPER_WASM + ".data"), cachedBlobUrl(PIPER_WASM + ".wasm", "application/wasm")])
      .then(([piperData, piperWasm]) => c.init({ type: "init", voiceId, wasmPaths: { onnxWasm: ORT_TTS, piperData, piperWasm } }))
      .catch((e) => setTts({ status: "error", pct: 0, error: e.message }));
    c.ready.then(() => { if (ttsClient === c) setTts({ status: "ready", pct: 100 }); }, (e) => { if (ttsClient === c) { ttsClient = null; setTts({ status: "error", pct: 0, error: e.message }); } });
    return c;
  }

  class Speaker {
    constructor() { this.ctx = null; this.analyser = null; this.source = null; this.token = 0; this.fakeUntil = 0; this.voice = "de_DE-thorsten-medium"; }
    audio() {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0.6;
        this.analyser.connect(this.ctx.destination);
        this.data = new Uint8Array(this.analyser.fftSize);
      }
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    setVoice(id) { this.voice = id; loadTts(id); }
    prepare() { try { this.audio(); } catch (e) { /* egal */ } loadTts(this.voice); }
    level() {
      if (this.source && this.analyser) {
        this.analyser.getByteTimeDomainData(this.data);
        let sum = 0; for (let i = 0; i < this.data.length; i++) { const v = (this.data[i] - 128) / 128; sum += v * v; }
        return Math.min(1, Math.sqrt(sum / this.data.length) * 3.2);
      }
      if (Date.now() < this.fakeUntil) { const t = Date.now() / 1000; return 0.35 + 0.3 * Math.abs(Math.sin(t * 7.3)) * Math.abs(Math.sin(t * 2.1 + 1)); }
      return 0;
    }
    stop() { this.token++; try { this.source && this.source.stop(); } catch (e) { /* aus */ } this.source = null; this.fakeUntil = 0; try { speechSynthesis.cancel(); } catch (e) { /* egal */ } }
    async speak(raw, opts) {
      opts = opts || {};
      this.stop();
      const my = ++this.token;
      const text = cleanForSpeech(raw);
      if (!text) { opts.onEnd && opts.onEnd(); return; }
      const parts = splitSentences(text);
      const c = loadTts(this.voice);
      if (!c || ttsState.status !== "ready") return this.speakSystem(parts, opts, my);
      const ctx = this.audio();
      const synth = (s) => c.request({ type: "predict", text: s }).then((m) => ctx.decodeAudioData(m.wav)).catch(() => null);
      let next = synth(parts[0]), started = false;
      for (let i = 0; i < parts.length; i++) {
        const buf = await next;
        if (my !== this.token) return;
        if (i + 1 < parts.length) next = synth(parts[i + 1]);
        if (!buf) continue;
        if (!started) { started = true; opts.onStart && opts.onStart(); }
        await new Promise((res) => { const s = ctx.createBufferSource(); s.buffer = buf; s.connect(this.analyser); s.onended = res; this.source = s; s.start(); });
        if (my !== this.token) return;
      }
      this.source = null;
      if (my === this.token) opts.onEnd && opts.onEnd();
    }
    speakSystem(parts, opts, my) {
      const voices = speechSynthesis.getVoices().filter((v) => /^de/i.test(v.lang));
      const v = voices.find((x) => /natural|neural|online/i.test(x.name)) || voices[0];
      parts.forEach((s, i) => {
        const u = new SpeechSynthesisUtterance(s); u.lang = "de-DE"; if (v) u.voice = v;
        u.onstart = () => { if (my !== this.token) return; this.fakeUntil = Date.now() + 60000; if (i === 0 && opts.onStart) opts.onStart(); };
        const done = () => { if (i === parts.length - 1 && my === this.token) { this.fakeUntil = 0; opts.onEnd && opts.onEnd(); } };
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
      });
    }
  }

  // ---------- Erkennung (Whisper) ----------
  let sttClient = null, sttState = { status: "idle", pct: 0, engine: "" };
  const sttSubs = new Set();
  const setStt = (s) => { sttState = Object.assign({}, sttState, s); sttSubs.forEach((f) => f(sttState)); };
  function startStt(model, dtype, device) {
    const files = {};
    const c = workerClient("stt-worker.js", (m) => {
      if (m.type !== "progress") return;
      files[m.file] = m.pct;
      const v = Object.values(files); setStt({ status: "loading", pct: Math.round(v.reduce((a, b) => a + b, 0) / v.length) });
    });
    c.init({ type: "init", model, dtype, device, ortWasm: ORT_STT });
    return c;
  }
  function loadStt() {
    if (sttClient) return sttClient;
    setStt({ status: "loading", pct: 0 });
    // Grafikkarte (WebGPU): Whisper Small, sehr genau und schnell. Sonst Whisper Base auf dem Prozessor.
    const p = (async () => {
      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            const c = startStt("onnx-community/whisper-small", { encoder_model: "fp32", decoder_model_merged: "q4" }, "webgpu");
            await c.ready; setStt({ status: "ready", pct: 100, engine: "Whisper Small (Grafikkarte)" }); return c;
          }
        } catch (e) { console.warn("[voice] WebGPU nicht nutzbar, nehme CPU", e); }
      }
      const c = startStt("onnx-community/whisper-base", "q4", "wasm");
      await c.ready; setStt({ status: "ready", pct: 100, engine: "Whisper Base (Prozessor)" }); return c;
    })();
    p.catch((e) => { sttClient = null; setStt({ status: "error", pct: 0, error: e.message }); });
    sttClient = p;
    return p;
  }
  async function transcribe(pcm) {
    const c = await loadStt();
    const m = await c.request({ type: "transcribe", audio: pcm, language: "german" }, [pcm.buffer]);
    return (m.text || "").trim();
  }

  // ---------- Aufnahme mit Sprach-Erkennung (Pause = fertig) ----------
  async function record(opts) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const chunks = []; let level = 0, heard = false, lastLoud = 0, startedAt = Date.now(), done = false, noise = 0.01;
    const finish = (cancel) => {
      if (done) return; done = true;
      try { proc.disconnect(); src.disconnect(); } catch (e) { /* egal */ }
      stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {});
      if (cancel || !heard) return opts.onDone(null);
      const len = chunks.reduce((a, c) => a + c.length, 0), pcm = new Float32Array(len);
      let o = 0; chunks.forEach((c) => { pcm.set(c, o); o += c.length; });
      opts.onDone(pcm);
    };
    proc.onaudioprocess = (e) => {
      if (done) return;
      const d = e.inputBuffer.getChannelData(0);
      let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      level = Math.min(1, rms * 12);
      const now = Date.now();
      if (now - startedAt < 400) noise = Math.max(noise, rms * 1.5); // Grundrauschen der ersten Zeit
      const loud = rms > Math.max(0.018, noise * 2);
      if (loud) { lastLoud = now; if (!heard) { heard = true; opts.onSpeech && opts.onSpeech(); } }
      if (heard || loud) chunks.push(new Float32Array(d));
      else { chunks.length = 0; chunks.push(new Float32Array(d)); } // kurzen Vorlauf behalten
      if (heard && now - lastLoud > (opts.silenceMs || 1300)) finish();
      if (now - startedAt > (opts.maxMs || 60000)) finish();
    };
    src.connect(proc); proc.connect(ctx.destination);
    return { level: () => level, stop: () => finish(false), cancel: () => finish(true) };
  }

  // ---------- „Hey Mythos“: lokal zuhören, nur bei Gesprochenem kurz erkennen ----------
  // Kein eigenes Weckwort-Modell: Sprachabschnitte werden lokal mit Whisper erkannt und
  // auf „Hey Mythos …“ geprüft. Nichts verlässt den PC, bis das Weckwort gefallen ist.
  // Whisper schreibt „Hey Mythos“ mal als „Hey Mythos“, „Hallo Mitos“, „Myth OS“ oder „Heimitus“.
  // Deshalb lautlich vereinfachen und höchstens einen Laut Abweichung zu „mitos“ erlauben.
  const sound = (w) => w.toLowerCase().replace(/[^a-zäöüß]/g, "").replace(/th/g, "t").replace(/[yü]/g, "i").replace(/ey|ei/g, "ai");
  const GREET = /^(hallo|okay|okai|ok|hai|hi|he|hej|ai)$/;
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  /** Rest des Satzes nach „Hey Mythos“ ("" wenn nur das Weckwort) oder null. */
  function matchWake(text) {
    const words = String(text).trim().split(/\s+/).filter(Boolean);
    const start = words.length && GREET.test(sound(words[0])) ? 1 : 0;
    for (let take = 1; take <= 2; take++) { // Name kann getrennt sein: „Myth OS“
      const joined = words.slice(start, start + take).map(sound).join("");
      const variants = [joined];
      if (start === 0) variants.push(joined.replace(/^(hallo|okay|ok|hai|hi|he)/, "")); // zusammengezogen: „Heimitus“
      if (variants.some((v) => v.length >= 4 && lev(v, "mitos") <= 1)) return words.slice(start + take).join(" ").replace(/^[,.!?:\s]+/, "");
    }
    return null;
  }
  function wakeListener(opts) {
    let active = true, rec = null;
    const loop = async () => {
      while (active) {
        const pcm = await new Promise((res) => {
          api.record({ silenceMs: 700, maxMs: 9000, onDone: res }).then((r) => { rec = r; if (!active) r.cancel(); }).catch((e) => { opts.onError && opts.onError(e); active = false; res(null); });
        });
        rec = null;
        if (!active) break;
        if (!pcm || pcm.length < 16000 * 0.35) continue; // zu kurz für „Hey Mythos“
        let text = "";
        try { text = await api.transcribe(pcm); } catch (e) { continue; }
        if (!active) break;
        const rest = matchWake(text);
        if (rest != null) { active = false; opts.onWake(rest.replace(/^[,.!?]\s*/, "")); }
      }
    };
    api.loadStt(); loop();
    return { stop: () => { active = false; if (rec) rec.cancel(); }, level: () => (rec ? rec.level() : 0) };
  }

  // ---------- Kamera / Bildschirm: Standbild für die nächste Frage ----------
  function grabFrame(video, maxSide) {
    if (!video || !video.videoWidth) return null;
    const s = Math.min(1, (maxSide || 1280) / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(video.videoWidth * s); c.height = Math.round(video.videoHeight * s);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return { media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.82).split(",")[1] };
  }

  // ---------- Logo-Orb (wie auf der Website) ----------
  function createOrb(canvas, getState) {
    const ctx = canvas.getContext("2d");
    const img = new Image(); img.src = "icon.png";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => { canvas.width = Math.max(1, canvas.clientWidth * dpr); canvas.height = Math.max(1, canvas.clientHeight * dpr); };
    resize(); const ro = new ResizeObserver(resize); ro.observe(canvas);
    let raf = 0, t = 0, amp = 0, lastRing = 0; const rings = [];
    const draw = () => {
      t += 1 / 60;
      const s = getState(), st = s.status;
      const target = st === "idle" ? 0 : Math.min(1, s.level || 0);
      amp += (target - amp) * (target > amp ? 0.35 : 0.12);
      const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, base = Math.min(W, H) * 0.3;
      const hue = st === "listening" ? 190 : st === "speaking" ? 278 : st === "thinking" ? 230 : 255;
      ctx.clearRect(0, 0, W, H);
      const halo = ctx.createRadialGradient(cx, cy, base * 0.2, cx, cy, base * 2.3);
      halo.addColorStop(0, "hsla(" + hue + ",95%,62%," + (0.28 + amp * 0.45) + ")");
      halo.addColorStop(0.5, "hsla(" + (hue + 25) + ",90%,55%," + (0.08 + amp * 0.18) + ")");
      halo.addColorStop(1, "hsla(" + (hue + 25) + ",90%,50%,0)");
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, base * 2.3, 0, Math.PI * 2); ctx.fill();
      if (st !== "idle" && amp > 0.3 && t - lastRing > 0.22) { rings.push({ r: base * 0.85, a: 0.25 + amp * 0.4, hue }); lastRing = t; }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i]; r.r += (1.6 + amp * 3) * dpr; r.a *= 0.965;
        if (r.a < 0.01 || r.r > base * 2.6) { rings.splice(i, 1); continue; }
        ctx.beginPath(); ctx.arc(cx, cy, r.r, 0, Math.PI * 2);
        ctx.strokeStyle = "hsla(" + r.hue + ",100%,75%," + r.a + ")"; ctx.lineWidth = Math.max(1, base * 0.012); ctx.stroke();
      }
      if (img.complete && img.naturalWidth) {
        const breathe = st === "idle" ? 0.025 * Math.sin(t * 1.6) : st === "thinking" ? 0.04 * Math.sin(t * 4) : 0;
        const size = base * 2 * (1 + amp * 0.2 + breathe);
        const spin = st === "thinking" ? t * 0.9 : t * 0.06;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(spin + amp * 0.06 * Math.sin(t * 9));
        ctx.shadowColor = "hsla(" + hue + ",100%,65%," + (0.55 + amp * 0.4) + ")"; ctx.shadowBlur = base * (0.18 + amp * 0.5);
        ctx.drawImage(img, -size / 2, -size / 2, size, size); ctx.shadowBlur = 0;
        if (amp > 0.02) {
          ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = Math.min(0.55, amp * 0.6);
          ctx.rotate(0.14 * Math.sin(t * 3)); const s2 = size * (1.05 + amp * 0.08);
          ctx.drawImage(img, -s2 / 2, -s2 / 2, s2, s2);
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }

  const api = window.MythosVoice = {
    VOICES, speaker: new Speaker(), loadStt, transcribe, record, createOrb, cleanForSpeech, wakeListener, matchWake, grabFrame,
    onTtsState: (f) => { ttsSubs.add(f); f(ttsState); }, onSttState: (f) => { sttSubs.add(f); f(sttState); },
  };
})();
