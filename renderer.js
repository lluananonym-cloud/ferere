const CFG = { site: "https://ai-mythos.lovable.app", fn: "https://rdxaqiacoitzeowehdts.supabase.co/functions/v1" };
const $ = (id) => document.getElementById(id);
let cfg = {}, chat = null, attach = [], editing = null, gitInfo = null, searchQ = "", mcpStatus = [];
let prompts = { nudge: "", summary: "", memoryFile: "MYTHOS.md", models: [] };
// Laufende Aufgaben je Chat – mehrere Chats können gleichzeitig arbeiten.
const runs = new Map();
const EMPTY = $("empty").cloneNode(true);
const fmt = (ms) => { const s = Math.floor(ms / 1000); return (s >= 60 ? Math.floor(s / 60) + "m " : "") + (s % 60) + "s"; };
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " Mio." : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const post = (fn, body, h) => fetch(CFG.fn + "/" + fn, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, h || {}), body: JSON.stringify(body) });
const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const openLink = (u) => window.mythos.open(u);
const md = (box, text) => window.renderMarkdown(box, text, openLink);
const nearBottom = () => { const l = $("log"); return l.scrollHeight - l.scrollTop - l.clientHeight < 160; };
const scrollDown = () => { $("log").scrollTop = 1e9; };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const isBusy = (c) => !!(c && runs.has(c.id));
const runOf = (c) => (c ? runs.get(c.id) : null);

// ---------- Chat-Ansicht ----------
function diffBox(it) {
  const d = el("details", "diff"); d.open = it.d.lines.length <= 40;
  const s = el("summary"); s.append(el("span", "", "✎ " + it.path + "  "), el("span", "plus", "+" + it.d.added), el("span", "minus", " −" + it.d.removed));
  const pre = el("pre");
  it.d.lines.forEach(([op, l]) => pre.appendChild(el("span", op === "+" ? "ln add" : op === "-" ? "ln del" : op === "@" ? "ln gap" : "ln", (op === "@" ? "" : op + " ") + l)));
  d.append(s, pre); return d;
}
function draw(it, i) {
  let d;
  if (it.cls === "a" || it.cls === "sum") {
    d = el("div", "m a" + (it.cls === "sum" ? " sum glass" : "")); const img = el("img"); img.src = "icon.png";
    const b = el("div", "body"); if (it.cls === "sum") b.appendChild(el("div", "sumhead", "📋 Zusammenfassung")); md(b, it.text);
    const sp = el("button", "speak", "🔊"); sp.title = "Vorlesen";
    sp.onclick = () => { const S = window.MythosVoice.speaker; S.setVoice(cfg.voice || window.MythosVoice.VOICES[0].id); S.prepare(); S.speak(it.text); };
    d.append(img, b, sp);
  } else if (it.cls === "u") {
    d = el("div", "m u glass"); d.appendChild(document.createTextNode(it.text));
    const imgs = (it.att || []).filter((a) => a.image);
    if (imgs.length) { const box = el("div", "imgs"); imgs.forEach((a) => { const im = el("img"); im.src = "data:" + a.image.media_type + ";base64," + a.image.data; im.title = a.name; box.appendChild(im); }); d.appendChild(box); }
    const b = el("button", "edit", "✎"); b.title = "Nachricht bearbeiten"; b.onclick = () => startEdit(i); d.appendChild(b);
  } else if (it.cls === "diff") d = diffBox(it);
  else if (it.cls === "agents") { d = el("div", "agents"); renderAgents(d, it); agentEls.set(it, d); }
  else if (it.cls === "out") { d = el("details", "out"); d.append(el("summary", "", "▸ Ausgabe von " + (it.cmd || "Befehl")), el("pre", "", it.text)); }
  else d = el("div", "t " + it.cls, it.text);
  $("col").appendChild(d); scrollDown(); return d;
}
function addTo(c, cls, text, extra) {
  c.view.push(Object.assign({ cls: cls, text: text }, extra || {}));
  if ((cls === "a" || cls === "sum") && runs.has(c.id)) runs.get(c.id).lastText = text;
  if (c !== chat) return null;
  const e = $("empty"); if (e) e.remove();
  const d = draw(c.view[c.view.length - 1], c.view.length - 1);
  const r = runOf(c); if (r) paintRun(r);
  return d;
}
const add = (cls, text, extra) => addTo(chat, cls, text, extra);
const noteTo = (c, text) => addTo(c, "note", text);
const note = (text) => noteTo(chat, text);
const flash = (text) => draw({ cls: "note", text: text }, -1); // nur anzeigen, nicht speichern
function renderChat() {
  const col = $("col"); col.textContent = "";
  if (!chat.view.length && !isBusy(chat)) {
    const e = EMPTY.cloneNode(true);
    e.querySelectorAll("[data-s]").forEach((b) => b.onclick = () => { $("inp").value = b.dataset.s; grow(); $("inp").focus(); });
    col.appendChild(e);
  }
  chat.view.forEach(draw);
  const r = runOf(chat); if (r) { r.els = {}; paintRun(r); }
  renderGoal(); renderResume(); renderQueue(); renderTokens(); setBusyUI();
}

// Laufende Aufgabe im Chat darstellen: gestreamte Antwort, Live-Ausgabe, Timer.
function paintRun(run) {
  if (chat !== run.chat) return;
  const col = $("col"), e = run.els, stick = nearBottom();
  const vis = visibleText(run.stream).trim();
  if (vis) {
    if (!e.stream || !e.stream.isConnected) { e.stream = el("div", "m a streaming"); const img = el("img"); img.src = "icon.png"; e.body = el("div", "body"); e.stream.append(img, e.body); e.drawn = null; }
    if (e.drawn !== vis) { e.body.textContent = ""; md(e.body, vis); e.drawn = vis; }
    col.appendChild(e.stream);
  } else if (e.stream) { e.stream.remove(); e.drawn = null; }
  if (run.out != null) {
    if (!e.out || !e.out.isConnected) e.out = el("pre", "liveout");
    if (e.out.textContent !== run.out) { e.out.textContent = run.out; e.out.scrollTop = 1e9; }
    col.appendChild(e.out);
  } else if (e.out) e.out.remove();
  if (!e.live || !e.live.isConnected) e.live = el("div", "t live");
  e.live.textContent = "⏳ Mythos arbeitet… " + fmt(Date.now() - run.t0) + (run.phase ? " · " + run.phase : "");
  col.appendChild(e.live);
  if (stick) scrollDown();
}
function schedulePaint(run) { if (!run.paintTimer) run.paintTimer = setTimeout(() => { run.paintTimer = 0; paintRun(run); }, 60); }
function clearRunEls(run) { clearTimeout(run.paintTimer); Object.values(run.els).forEach((x) => x && x.remove && x.remove()); run.els = {}; }
setInterval(() => {
  const r = runOf(chat);
  if (r) { paintRun(r); $("timer").textContent = "arbeitet… " + fmt(Date.now() - r.t0); renderTokens(); }
}, 250);

// ---------- Modell ----------
const estTokens = (system, msgs) => {
  let chars = system.length, img = 0;
  msgs.forEach((m) => { if (typeof m.content === "string") chars += m.content.length; else m.content.forEach((b) => (b.type === "image" ? img++ : (chars += (b.text || "").length))); });
  return Math.ceil(chars / 4) + img * 1500;
};
async function systemPrompt(run) {
  return "Du bist Mythos Code, ein autonomer Coding-Agent als Desktop-App (Windows). Arbeitsordner: " + (run.folder || "(keiner)") +
    (run.git ? " · Git-Branch: " + run.git.branch : "") + ". Pfade relativ zum Arbeitsordner.\n" + await window.mythos.systemPrompt(run.folder, run.chat.goal || "");
}
const shorten = (s, max) => s.length <= max ? s : s.slice(0, Math.floor(max * 0.7)) + "\n…[gekürzt]…\n" + s.slice(s.length - Math.floor(max * 0.3));
const withImages = (m, content) => m.images && m.images.length
  ? { role: m.role, content: [{ type: "text", text: content }].concat(m.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } }))) }
  : { role: m.role, content: content };
function compact(h, level) {
  const keep = [6, 8, 4][level], recentMax = [20000, 3000, 1500][level], oldMax = [1500, 800, 400][level];
  const cut = Math.max(0, h.length - keep);
  const older = level === 0 ? h.slice(0, cut) : h.slice(0, Math.min(1, cut));
  return older.map((m) => ({ role: m.role, content: shorten(m.content, oldMax) }))
    .concat(h.slice(cut).map((m) => withImages(m, shorten(m.content, recentMax))));
}
async function once(run, messages, system, onText) {
  const c = run.ctl = new AbortController(); const to = setTimeout(() => c.abort(), 170000);
  const tok = run.chat.tokens = run.chat.tokens || { in: 0, out: 0 };
  tok.in += estTokens(system, messages);
  try {
    const r = await fetch(CFG.fn + "/v1-messages", { method: "POST", signal: c.signal,
      headers: { "content-type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: run.model, max_tokens: 8000, system: system, messages: messages, stream: true }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error((j.error && j.error.message) || ("HTTP " + r.status)); e.status = r.status; throw e; }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "", out = "", outTok = 0;
    for (;;) { const x = await rd.read(); if (x.done) break; buf += dec.decode(x.value, { stream: true }); let i;
      while ((i = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!l.startsWith("data:")) continue; let p; try { p = JSON.parse(l.slice(5)); } catch (e) { continue; }
        if (p.type === "error") { const e = new Error((p.error && p.error.message) || "Überlastet"); e.status = 529; throw e; }
        if (p.usage && p.usage.output_tokens) outTok = p.usage.output_tokens;
        if (p.delta && p.delta.text) { out += p.delta.text; if (onText) onText(out); } } }
    if (!out.trim()) throw new Error("Leere Antwort");
    tok.out += outTok || Math.ceil(out.length / 4);
    return out;
  } finally { clearTimeout(to); }
}
async function call(run, h, system, onText) {
  for (let a = 0; a < 6; a++) {
    if (run.stopped) throw new Error("Gestoppt");
    try { return await once(run, compact(h, Math.min(2, Math.floor(a / 2))), system, onText); }
    catch (e) {
      if (run.stopped) throw e;
      if (e.status === 401) throw new Error("Anmeldung abgelaufen – bitte abmelden und neu anmelden.");
      if (/Daily limit/i.test(e.message)) throw new Error("Tageslimit erreicht – mit Pro unbegrenzt.");
      const wait = Math.min(8000, 1500 * (a + 1));
      for (let w = 0; w < wait && !run.stopped; w += 250) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("Mythos ist gerade nicht erreichbar – bitte gleich nochmal versuchen.");
}
// Einzelne Anfrage außerhalb einer Aufgabe (z. B. Commit-Nachricht).
const quickCall = (content, system) => call({ stopped: false, ctl: null, model: cfg.model || "mythos-code", chat: chat }, [{ role: "user", content: content }], system);
async function usage() { try { const j = await (await post("cli-auth", { action: "usage", api_key: cfg.key })).json();
  $("usage").textContent = j.limit == null ? "Usage " + j.used + " · ∞ Pro" : "Usage " + j.used + " / " + j.limit; } catch (e) {} }
function renderTokens() {
  const t = (chat && chat.tokens) || { in: 0, out: 0 };
  $("tokens").textContent = "≈ " + fmtTok(t.in + t.out) + " Tokens";
  $("tokens").title = "Geschätzt für diesen Chat: " + fmtTok(t.in) + " Eingabe + " + fmtTok(t.out) + " Ausgabe";
}
// Antwort live mitlesen: sichtbarer Text ohne <tool>-Block (auch nicht halb angefangen).
function visibleText(full) {
  const k = full.indexOf("<tool>"); if (k >= 0) return full.slice(0, k);
  for (let n = 5; n > 0; n--) if (full.endsWith("<tool>".slice(0, n))) return full.slice(0, -n);
  return full;
}

// ---------- Senden, Warteschlange & Stoppen ----------
function setBusyUI() {
  const b = isBusy(chat), s = $("btnSend"), r = runOf(chat);
  s.textContent = b ? "■" : "↑"; s.title = b ? "Stoppen (Esc)" : "Senden"; s.classList.toggle("stop", b); s.disabled = !!(r && r.stopped);
  $("timer").classList.toggle("busy", b); document.body.classList.toggle("busy", b);
  if (!b) $("timer").textContent = "⏱ " + ((chat && chat.lastTook) || "0s");
  $("inp").placeholder = b ? "Nächste Aufgabe? Enter reiht sie in die Warteschlange ein" : "Was soll Mythos bauen?  ( / = Befehle )";
  grow(); renderResume();
}
function stop(c) {
  const run = runOf(c || chat); if (!run || run.stopped) return;
  run.stopped = true; if (run.chat === chat) $("btnSend").disabled = true;
  if (run.ctl) run.ctl.abort(); window.mythos.abort(run.id);
  (run.subs || []).forEach((s) => { if (s.ctl) s.ctl.abort(); window.mythos.abort(s.id); });
}
function setAuto(on) { $("auto").checked = !!on; cfg.auto = !!on; window.mythos.setCfg(cfg); }
// Neue Nutzer-Nachricht anhängen (beim Bearbeiten wird der Chat vorher ab dort abgeschnitten).
function pushUser(c, display, content, extra) {
  if (c === chat && editing != null) { const it = c.view[editing]; c.history.length = it.h; c.view.length = editing; editing = null; renderEdit(); renderChat(); }
  if (!c.history.length) { c.title = (extra.q || display).replace(/\s+/g, " ").slice(0, 48); c.folder = c.folder || cfg.folder || ""; }
  addTo(c, "u", display, Object.assign({ h: c.history.length }, extra));
  const images = (extra.att || []).filter((a) => a.image).map((a) => a.image);
  c.history.push(images.length ? { role: "user", content: content, images: images } : { role: "user", content: content });
}
function send() {
  const q = $("inp").value.trim(); if (!q && !attach.length) return;
  $("inp").value = ""; grow(); renderSlash();
  const item = { q: q || "Schau dir die angehängten Dateien an.", att: attach };
  attach = []; renderFiles();
  if (isBusy(chat)) { (chat.queue = chat.queue || []).push(item); renderQueue(); return; }
  submit(chat, item.q, item.att);
}
function submit(c, q, att, opts) {
  if (q.startsWith("/")) return c === chat ? command(q) : noteTo(c, "Befehl übersprungen: " + q);
  const files = att.filter((f) => !f.image);
  let content = q; if (files.length) content += "\n\nHochgeladene Dateien:\n" + files.map((f) => "### " + f.name + "\n" + f.content).join("\n\n");
  pushUser(c, q + (files.length ? "\n📎 " + files.map((f) => f.name).join(", ") : ""), content, { q: q, att: att });
  runAgent(c, opts || { fresh: true });
}
function renderQueue() {
  const bar = $("queuebar"), q = (chat && chat.queue) || [];
  bar.textContent = ""; bar.style.display = q.length ? "flex" : "none"; if (!q.length) return;
  bar.appendChild(el("span", "", "⏳ Warteschlange (" + q.length + "):"));
  q.forEach((it, i) => {
    const c = el("button", "chip", (it.q.length > 40 ? it.q.slice(0, 40) + "…" : it.q) + "  ✕"); c.title = "Aus der Warteschlange entfernen";
    c.onclick = () => { q.splice(i, 1); renderQueue(); }; bar.appendChild(c);
  });
  if (!isBusy(chat)) { const go = el("button", "chip", "▶ Abarbeiten"); go.onclick = () => processQueue(chat); bar.appendChild(go); }
}
function processQueue(c) { if (isBusy(c) || !c.queue || !c.queue.length) return; const it = c.queue.shift(); if (c === chat) renderQueue(); submit(c, it.q, it.att); }

function toolLabel(t) {
  if (t.name === "run") return "⚙ run " + t.cmd;
  if (t.name === "search") return "🔎 search /" + t.pattern + "/" + (t.glob ? " " + t.glob : "");
  if (t.name === "edit" || t.name === "write") return "✎ " + t.name + " " + t.path;
  if (t.name === "websearch") return "🌐 websearch " + t.query;
  if (t.name === "fetch") return "🌐 fetch " + t.url;
  if (t.name === "mcp") return "🔌 " + t.server + " / " + t.tool;
  return "⚙ " + t.name + " " + (t.path || "");
}
const needsConfirm = (t) => ["run", "write", "edit", "mcp"].includes(t.name);
const autoTestOn = (folder) => !!(folder && cfg.autoTest && cfg.autoTest[folder]);

async function runAgent(c, opts) {
  if (runs.has(c.id)) return;
  const run = { id: "run-" + c.id + "-" + Date.now(), chat: c, stopped: false, ctl: null, t0: Date.now(), stream: "", out: null, els: {}, phase: "",
    folder: c.folder || cfg.folder || "", model: cfg.model || "mythos-code" };
  runs.set(c.id, run); c.unfinished = true; c.folder = run.folder;
  window.mythos.working(true);
  if (c === chat) setBusyUI();
  renderSide(); saveChat(c);
  run.git = run.folder ? await window.mythos.git.info(run.folder).catch(() => null) : null;
  const goal = c.goal || "", max = goal ? 200 : 40, autoTest = autoTestOn(run.folder);
  let steps = 0, nudges = 0, finished = false, reached = false, summary = "", changed = false, testRounds = 0, testCmd = null;
  const ask = async () => {
    const sys = await systemPrompt(run);
    try { return await call(run, c.history, sys, (full) => { run.stream = full; schedulePaint(run); }); }
    finally { run.stream = ""; paintRun(run); }
  };
  try {
    // Multi-Agent: neue Aufgaben erst aufteilen und parallel bearbeiten lassen.
    if (opts && opts.fresh && cfg.multi && await multiAgentPhase(run, c)) changed = true;
    for (; steps < max && !run.stopped; steps++) {
      const out = await ask();
      if (run.stopped) break;
      c.history.push({ role: "assistant", content: out });
      const m = out.match(/<tool>([\s\S]*?)<\/tool>/); const text = out.replace(/<tool>[\s\S]*?<\/tool>/g, "").trim();
      if (text) addTo(c, "a", text);
      if (!m) {
        // /goal: Mythos hat aufgehört, ohne das Ziel als erreicht zu melden -> weiter antreiben.
        if (goal && !/ZIEL ERREICHT/.test(out)) {
          if (++nudges > 5) { noteTo(c, "🎯 Mythos kommt beim Ziel nicht weiter – schau es dir bitte an. Mit /weiter geht es weiter."); break; }
          c.history.push({ role: "user", content: prompts.nudge }); saveChat(c); continue;
        }
        // Automatisch testen: nach Änderungen Tests laufen lassen, Fehler von Mythos reparieren lassen.
        if (autoTest && changed && testRounds < 3) {
          testCmd = testCmd || (cfg.testCmd && cfg.testCmd[run.folder]) || await window.mythos.tests.detect(run.folder);
          if (!testCmd) { testRounds = 3; noteTo(c, "🧪 Kein Testbefehl gefunden – mit /tests <befehl> festlegen."); }
          else {
            testRounds++; changed = false;
            addTo(c, "tool", "🧪 Tests: " + testCmd); run.out = ""; run.phase = "Tests";
            const tr = await window.mythos.tests.run(run.folder, testCmd, run.id);
            run.out = null; run.phase = "";
            if (run.stopped) break;
            addTo(c, "out", tr.text.slice(-4000), { cmd: testCmd });
            if (tr.code !== 0) {
              if (testRounds >= 3) { noteTo(c, "🧪 Tests schlagen nach 3 Versuchen weiter fehl – bitte anschauen."); finished = true; break; }
              noteTo(c, "🧪 Tests fehlgeschlagen – Mythos repariert (Versuch " + testRounds + "/3)");
              c.history.push({ role: "user", content: "Die Tests (" + testCmd + ") schlagen fehl:\n" + tr.text.slice(-6000) + "\nBehebe die Ursache und prüfe danach erneut." });
              saveChat(c); continue;
            }
            noteTo(c, "🧪 Tests grün ✓");
          }
        }
        finished = true; reached = !!goal; break;
      }
      nudges = 0;
      let t; try { t = JSON.parse(m[1]); } catch (e) { c.history.push({ role: "user", content: "Tool-JSON ungültig." }); continue; }
      addTo(c, "tool", toolLabel(t));
      let r;
      if (needsConfirm(t) && !$("auto").checked && !confirm("Mythos möchte ausführen:\n" + toolLabel(t))) r = { result: "Vom Nutzer abgelehnt." };
      else {
        if (t.name === "run") run.out = "";
        try { r = await window.mythos.tool(t, run.folder, run.id); } finally { run.out = null; paintRun(run); }
        (r.hooks || []).filter((h) => h.out || h.code).forEach((h) => noteTo(c, "🪝 " + h.event + ": " + h.command + " → Exit " + h.code + (h.out ? "\n" + h.out.slice(0, 600) : "")));
        if (t.name === "run") addTo(c, "out", r.result.slice(-4000), { cmd: t.cmd });
        if (r.diff && r.diff.lines.length) { addTo(c, "diff", "", { path: t.path, d: r.diff }); changed = true; }
      }
      c.history.push({ role: "user", content: "Werkzeug-Ergebnis:\n" + r.result });
      saveChat(c);
    }
    if (!finished && !run.stopped && steps >= max) noteTo(c, "Schrittlimit (" + max + ") erreicht – mit /weiter macht Mythos weiter.");
    // Nach /goal: kurze Zusammenfassung, was passiert ist.
    if (goal && !run.stopped) {
      c.history.push({ role: "user", content: prompts.summary });
      summary = (await ask()).replace(/<tool>[\s\S]*?<\/tool>/g, "").trim();
      c.history.push({ role: "assistant", content: summary });
      addTo(c, "sum", summary);
    }
  } catch (e) { if (!run.stopped) addTo(c, "a", "⚠ " + e.message); }
  runs.delete(c.id); clearRunEls(run);
  const took = fmt(Date.now() - run.t0); c.lastTook = took;
  if (run.stopped && c.history[c.history.length - 1].role === "user") c.history.push({ role: "assistant", content: "(Vom Nutzer gestoppt.)" });
  if (reached) { noteTo(c, "🎯 Ziel erreicht: " + goal); c.goal = ""; if (c === chat) renderGoal(); }
  addTo(c, "done", run.stopped ? "■ Gestoppt nach " + took : "✓ Mythos hat " + took + " gearbeitet");
  c.unfinished = !finished;
  window.mythos.working(runs.size > 0);
  if (c === chat) { setBusyUI(); renderTokens(); }
  saveChat(c); usage();
  if (run.folder === cfg.folder) { refreshGit(); if (treeOpen()) renderTree(); }
  const status = run.stopped ? "stopped" : reached ? "reached" : finished ? "done" : "interrupted";
  window.mythos.hooks.run("Stop", { status: status, chat: c.title, took: took, summary: summary }, run.folder).then((hs) =>
    hs.filter((h) => h.out || h.code).forEach((h) => noteTo(c, "🪝 Stop: " + h.command + " → Exit " + h.code + (h.out ? "\n" + h.out.slice(0, 600) : ""))));
  const title = run.stopped ? "■ Gestoppt nach " + took : reached ? "🎯 Ziel erreicht" : finished ? "✓ Fertig nach " + took : "⚠ Unterbrochen – Mythos braucht dich";
  window.mythos.notify("Mythos Code – " + c.title, title);
  if (cfg.notify && (goal || Date.now() - run.t0 > 60000)) window.mythos.push(cfg.notify, "Mythos Code – " + (run.folder ? base(run.folder) : c.title), title + (summary ? "\n\n" + summary.slice(0, 1500) : ""));
  if (typeof voiceReply === "function") voiceReply(c, run.lastText || (run.stopped ? "Gestoppt." : "Fertig."));
  if (!run.stopped) processQueue(c); else if (c === chat) renderQueue();
}

// ---------- AFK: Weitermachen & Ziel ----------
function renderResume() { $("resumebar").style.display = chat && !isBusy(chat) && chat.unfinished && chat.history.length ? "flex" : "none"; }
function renderGoal() { $("goalbar").style.display = chat && chat.goal ? "flex" : "none"; $("goaltext").textContent = chat && chat.goal ? "Ziel: " + chat.goal : ""; }
function continueChat() {
  if (isBusy(chat) || !chat.history.length) return;
  if (chat.history[chat.history.length - 1].role === "assistant") chat.history.push({ role: "user", content: "Mach bitte genau dort weiter, wo du aufgehört hast." });
  note("▶ Weitermachen"); runAgent(chat);
}
function endGoal() { if (!chat.goal) return; chat.goal = ""; renderGoal(); note("🎯 Ziel beendet."); saveChat(chat); }

// ---------- Git ----------
async function refreshGit() {
  gitInfo = cfg.folder ? await window.mythos.git.info(cfg.folder).catch(() => null) : null;
  const g = $("git"); g.style.display = gitInfo ? "" : "none";
  if (gitInfo) { $("gitb").textContent = gitInfo.branch + (gitInfo.changed ? " · " + gitInfo.changed + " geändert" : " ✓"); g.title = gitInfo.status || "Keine Änderungen"; }
}
async function gitCommit(msg) {
  await refreshGit();
  if (!gitInfo) return note("Der Projektordner ist kein Git-Repository.");
  if (!gitInfo.changed) return note("Nichts zu committen – alles sauber ✓");
  if (!msg) {
    const n = flash("⏳ Mythos schreibt die Commit-Nachricht…");
    try {
      msg = (await quickCall("Schreibe eine kurze Git-Commit-Nachricht auf Deutsch für diese Änderungen: erste Zeile max. 72 Zeichen, optional Leerzeile + Stichpunkte. Antworte NUR mit der Nachricht, ohne Werkzeuge, ohne Codeblock.\n\n" + await window.mythos.git.diff(cfg.folder), "Du schreibst Git-Commit-Nachrichten."))
        .replace(/<tool>[\s\S]*?<\/tool>/g, "").replace(/^```\w*\n?|```$/g, "").trim();
    } catch (e) { return note("⚠ " + e.message); } finally { n.remove(); }
  }
  if (!confirm("Alle Änderungen committen mit dieser Nachricht?\n\n" + msg)) return note("Commit abgebrochen.");
  const r = await window.mythos.git.commit(cfg.folder, msg);
  note((r.ok ? "✓ Committet\n" : "⚠ Commit fehlgeschlagen\n") + r.out.trim());
  refreshGit();
}

// ---------- MCP ----------
async function configureMcp() { mcpStatus = await window.mythos.mcp.configure(cfg.folder || null).catch(() => []); renderMcp(); }
function renderMcp() {
  const b = $("mcp"), ok = mcpStatus.filter((s) => s.status === "connected").length, bad = mcpStatus.filter((s) => s.status === "error").length;
  b.style.display = mcpStatus.length ? "" : "none";
  b.textContent = "🔌 " + ok + "/" + mcpStatus.length + (bad ? " ⚠" : "");
  b.title = mcpStatus.map((s) => s.name + ": " + s.status + (s.error ? " (" + s.error + ")" : "") + " · " + s.tools.length + " Werkzeuge").join("\n");
}
function mcpReport() {
  if (!mcpStatus.length) return "🔌 Keine MCP-Server eingerichtet.\n/mcp bearbeiten – Server für dieses Projekt (.mcp.json)\n/mcp global – Server für alle Projekte";
  return "🔌 MCP-Server:\n" + mcpStatus.map((s) => (s.status === "connected" ? "✓ " : s.status === "error" ? "⚠ " : "⏳ ") + s.name + " (" + s.scope + ") – " +
    (s.status === "connected" ? s.tools.length + " Werkzeuge: " + s.tools.map((t) => t.name).slice(0, 12).join(", ") : s.error || s.status)).join("\n") +
    "\n\n/mcp neu – neu verbinden · /mcp bearbeiten · /mcp global";
}

// ---------- Befehle ----------
const COMMANDS = [
  ["/sprache", "", "Sprachmodus: mit Mythos sprechen (Whisper + Piper, lokal)"],
  ["/heymythos", "an|aus", "Im Hintergrund auf „Hey Mythos“ hören (lokal)"],
  ["/agenten", "an|aus", "Multi-Agent: große Aufgaben parallel von mehreren Agenten bearbeiten"],
  ["/stimme", "[name]", "Stimme für den Sprachmodus wählen"],
  ["/goal", "<ziel>", "Mythos arbeitet selbstständig, bis das Ziel erreicht ist – danach Zusammenfassung"],
  ["/weiter", "", "Unterbrochene oder gestoppte Arbeit fortsetzen"],
  ["/neu", "", "Neuen Chat starten (auch während ein anderer arbeitet)"],
  ["/projekt", "", "Projektordner wählen"],
  ["/modell", "[name]", "Modell anzeigen oder wechseln"],
  ["/vorschau", "[url|datei]", "Live-Vorschau öffnen (lädt bei Änderungen neu)"],
  ["/dateien", "", "Dateibaum ein-/ausblenden"],
  ["/terminal", "", "Terminal ein-/ausblenden"],
  ["/tests", "an|aus|jetzt|<befehl>", "Automatisch testen nach Änderungen"],
  ["/merken", "<text>", "Etwas ins Projekt-Gedächtnis (MYTHOS.md) schreiben"],
  ["/gedaechtnis", "", "Projekt-Gedächtnis anzeigen"],
  ["/git", "", "Git-Status anzeigen"],
  ["/commit", "[nachricht]", "Alles committen – ohne Nachricht schreibt Mythos sie"],
  ["/push", "", "git push"],
  ["/mcp", "[neu|bearbeiten|global]", "MCP-Server anzeigen und einrichten"],
  ["/hooks", "[bearbeiten|global]", "Hooks anzeigen und einrichten"],
  ["/handy", "<url>|test|aus", "Handy-Benachrichtigung (ntfy.sh-Thema oder Discord-Webhook)"],
  ["/warteschlange", "[leeren]", "Warteschlange anzeigen oder leeren"],
  ["/suche", "<text>", "Alle Chats durchsuchen"],
  ["/tokens", "", "Geschätzten Token-Verbrauch dieses Chats anzeigen"],
  ["/design", "hell|dunkel", "Helles oder dunkles Design"],
  ["/umbenennen", "<name>", "Aktuellen Chat umbenennen"],
  ["/vollzugriff", "an|aus", "Vollzugriff ein- oder ausschalten"],
  ["/hilfe", "", "Alle Befehle anzeigen"],
];
const needFolder = () => { if (!cfg.folder) { note("Wähle zuerst einen Projektordner."); return true; } return false; };
async function command(q) {
  const cmd = q.split(/\s+/)[0].toLowerCase(), arg = q.slice(cmd.length).trim();
  if (cmd !== "/goal" && cmd !== "/ziel" && editing != null) { editing = null; renderEdit(); }
  if (cmd === "/goal" || cmd === "/ziel") {
    if (!arg) return note(chat.goal ? "🎯 Aktuelles Ziel: " + chat.goal + "\nBeenden mit /goal stop" : "So geht's: /goal <was Mythos erreichen soll>\nMythos arbeitet dann ohne Rückfragen, bis das Ziel erreicht ist, und fasst am Ende zusammen.");
    if (/^(stop|aus|ende|beenden)$/i.test(arg)) return endGoal();
    if (!$("auto").checked) { if (!confirm("Mit /goal arbeitet Mythos ohne Nachfragen weiter.\nVollzugriff dafür einschalten?")) return; setAuto(true); }
    pushUser(chat, "🎯 /goal " + arg, "Neues Ziel: " + arg + "\nArbeite jetzt komplett selbstständig daran, bis es erreicht und geprüft ist.", { q: "/goal " + arg });
    chat.goal = arg; renderGoal();
    return runAgent(chat, { fresh: true });
  }
  if (cmd === "/sprache") return vm.on ? voiceStop() : voiceStart();
  if (cmd === "/heymythos") { const on = !/^(aus|off)$/i.test(arg); setWake(on); return note(on ? "👂 „Hey Mythos“ ist an – sag einfach „Hey Mythos, …“. Alles bleibt lokal auf deinem PC." : "👂 „Hey Mythos“ ist aus."); }
  if (cmd === "/agenten") { const on = !/^(aus|off)$/i.test(arg); setMulti(on); return note(on ? "🧩 Multi-Agent ist an – neue Aufgaben werden aufgeteilt und parallel bearbeitet." : "🧩 Multi-Agent ist aus."); }
  if (cmd === "/stimme") {
    const vs = window.MythosVoice.VOICES;
    if (!arg) return note("🔊 Stimmen:\n" + vs.map((v) => ((cfg.voice || vs[0].id) === v.id ? "● " : "○ ") + v.label).join("\n") + "\nWechseln: /stimme <name> oder im Sprachmodus oben rechts");
    const v = vs.find((x) => x.id === arg || x.label.toLowerCase().startsWith(arg.toLowerCase()));
    if (!v) return note("Unbekannte Stimme. Verfügbar: " + vs.map((x) => x.label.split(" ")[0]).join(", "));
    cfg.voice = v.id; window.mythos.setCfg(cfg); $("vvoice").value = v.id; window.MythosVoice.speaker.setVoice(v.id);
    return note("🔊 Stimme: " + v.label);
  }
  if (cmd === "/weiter") return chat.history.length ? continueChat() : note("Hier gibt es noch nichts zum Weitermachen.");
  if (cmd === "/neu") return newChat();
  if (cmd === "/projekt") return pickProject();
  if (cmd === "/modell" || cmd === "/model") {
    if (!arg) return note("🧠 Modelle:\n" + prompts.models.map((m) => (m.id === (cfg.model || "mythos-code") ? "● " : "○ ") + m.label + " – " + m.desc).join("\n") + "\nWechseln: oben im Auswahlfeld oder /modell <name>");
    const m = prompts.models.find((x) => x.id === arg.toLowerCase() || x.label.toLowerCase() === arg.toLowerCase());
    if (!m) return note("Unbekanntes Modell. Verfügbar: " + prompts.models.map((x) => x.label).join(", "));
    return setModel(m.id);
  }
  if (cmd === "/vorschau") { if (!arg && needFolder()) return; const r = await window.mythos.preview(arg, cfg.folder); return r.error ? note("👁 " + r.error) : note("👁 Vorschau geöffnet: " + r.url + "\nSie lädt automatisch neu, wenn sich Dateien im Projekt ändern."); }
  if (cmd === "/dateien") return toggleTree();
  if (cmd === "/terminal") return toggleTerm();
  if (cmd === "/tests") {
    if (needFolder()) return;
    const f = cfg.folder, detected = await window.mythos.tests.detect(f), own = cfg.testCmd && cfg.testCmd[f];
    if (/^(an|ein|on)$/i.test(arg)) { setAutoTest(true); return note("🧪 Automatisch testen ist an – nach Änderungen läuft " + (own || detected || "(noch kein Testbefehl – /tests <befehl>)") + "."); }
    if (/^(aus|off)$/i.test(arg)) { setAutoTest(false); return note("🧪 Automatisch testen ist aus."); }
    if (/^jetzt$/i.test(arg)) {
      const tc = own || detected; if (!tc) return note("🧪 Kein Testbefehl gefunden – mit /tests <befehl> festlegen.");
      const n = flash("⏳ Tests laufen: " + tc); const tr = await window.mythos.tests.run(f, tc, "manual-test"); n.remove();
      add("out", tr.text.slice(-4000), { cmd: tc }); return note(tr.code === 0 ? "🧪 Tests grün ✓" : "🧪 Tests fehlgeschlagen (Exit " + tr.code + ")");
    }
    if (arg) { cfg.testCmd = cfg.testCmd || {}; cfg.testCmd[f] = arg; window.mythos.setCfg(cfg); return note("🧪 Testbefehl für dieses Projekt: " + arg); }
    return note("🧪 Automatisch testen: " + (autoTestOn(f) ? "an" : "aus") + "\nTestbefehl: " + (own || detected || "keiner gefunden") + (own ? " (eigener)" : detected ? " (erkannt)" : "") + "\n/tests an · /tests aus · /tests jetzt · /tests <befehl>");
  }
  if (cmd === "/merken") {
    if (needFolder()) return;
    if (!arg) return note("So geht's: /merken <was Mythos sich für dieses Projekt merken soll>");
    await window.mythos.memory.add(cfg.folder, arg); return note("🧠 In " + prompts.memoryFile + " gemerkt: " + arg);
  }
  if (cmd === "/gedaechtnis" || cmd === "/gedächtnis") {
    const m = cfg.folder ? await window.mythos.memory.get(cfg.folder) : "";
    return note(m ? "🧠 " + prompts.memoryFile + ":\n" + m : "Noch kein Projekt-Gedächtnis. Mit /merken <text> anlegen – Mythos liest " + prompts.memoryFile + " dann bei jeder Aufgabe mit.");
  }
  if (cmd === "/git") { await refreshGit(); return note(gitInfo ? "⎇ " + gitInfo.branch + "\n" + (gitInfo.status.trim() || "Keine Änderungen ✓") : "Der Projektordner ist kein Git-Repository."); }
  if (cmd === "/commit") return gitCommit(arg);
  if (cmd === "/push") {
    if (needFolder()) return;
    const n = flash("⏳ git push…"); const r = await window.mythos.git.push(cfg.folder); n.remove();
    note((r.ok ? "✓ Gepusht\n" : "⚠ Push fehlgeschlagen\n") + r.out.trim()); return refreshGit();
  }
  if (cmd === "/mcp") {
    if (/^neu/i.test(arg)) { for (const s of mcpStatus) await window.mythos.mcp.restart(s.name); await configureMcp(); return note("🔌 MCP-Server werden neu verbunden …"); }
    if (/^bearbeiten/i.test(arg)) { if (needFolder()) return; const f = await window.mythos.openConfig("mcp-project", cfg.folder); return note("🔌 Geöffnet: " + f + "\nNach dem Speichern: /mcp neu"); }
    if (/^global/i.test(arg)) { const f = await window.mythos.openConfig("mcp-global", cfg.folder); return note("🔌 Geöffnet: " + f + "\nNach dem Speichern: /mcp neu"); }
    return note(mcpReport());
  }
  if (cmd === "/hooks") {
    if (/^bearbeiten/i.test(arg)) { if (needFolder()) return; const f = await window.mythos.openConfig("hooks-project", cfg.folder); return note("🪝 Geöffnet: " + f); }
    if (/^global/i.test(arg)) { const f = await window.mythos.openConfig("hooks-global", cfg.folder); return note("🪝 Geöffnet: " + f); }
    const h = await window.mythos.hooks.list(cfg.folder || null), lines = [];
    Object.entries(h).forEach(([ev, list]) => list.filter((x) => !x.disabled).forEach((x) => lines.push(ev + (x.matcher ? " [" + x.matcher + "]" : "") + ": " + x.command)));
    return note(lines.length ? "🪝 Aktive Hooks:\n" + lines.join("\n") + "\n\n/hooks bearbeiten · /hooks global"
      : "🪝 Keine Hooks aktiv.\nHooks sind Befehle, die automatisch laufen: PreToolUse (vor einem Werkzeug, Exit-Code 2 blockiert), PostToolUse (danach, z. B. Formatter), Stop (wenn eine Aufgabe endet).\n/hooks bearbeiten – für dieses Projekt · /hooks global – für alle");
  }
  if (cmd === "/handy") {
    if (/^(aus|off)$/i.test(arg)) { delete cfg.notify; window.mythos.setCfg(cfg); return note("📱 Handy-Benachrichtigung aus."); }
    if (/^test$/i.test(arg)) return note(cfg.notify && await window.mythos.push(cfg.notify, "Mythos Code", "Test – Benachrichtigungen funktionieren ✓") ? "📱 Test gesendet ✓" : "📱 Senden fehlgeschlagen – URL prüfen (/handy <url>).");
    if (!/^https:\/\//i.test(arg)) return note("📱 So geht's: App „ntfy“ aufs Handy, ein geheimes Thema abonnieren, dann:\n/handy https://ntfy.sh/dein-geheimes-thema\nOder einen Discord-Webhook-Link angeben. Test: /handy test");
    cfg.notify = arg; window.mythos.setCfg(cfg);
    return note("📱 Gespeichert. Bei /goal und Aufgaben über 1 Minute bekommst du eine Nachricht aufs Handy. Test: /handy test");
  }
  if (cmd === "/warteschlange") {
    const q2 = chat.queue || [];
    if (/^leeren$/i.test(arg)) { chat.queue = []; renderQueue(); return note("Warteschlange geleert."); }
    return note(q2.length ? "⏳ Warteschlange:\n" + q2.map((it, i) => (i + 1) + ". " + it.q).join("\n") : "Die Warteschlange ist leer. Tipp: Während Mythos arbeitet, reiht Enter neue Aufgaben ein.");
  }
  if (cmd === "/suche") { $("csearch").value = arg; searchQ = arg; renderSide(); return $("csearch").focus(); }
  if (cmd === "/tokens") { const t = chat.tokens || { in: 0, out: 0 }; return note("≈ " + fmtTok(t.in) + " Eingabe + " + fmtTok(t.out) + " Ausgabe = " + fmtTok(t.in + t.out) + " Tokens in diesem Chat (geschätzt)"); }
  if (cmd === "/design") { setTheme(/^hell|light/i.test(arg) ? "light" : /^dunkel|dark/i.test(arg) ? "dark" : cfg.theme === "light" ? "dark" : "light"); return; }
  if (cmd === "/umbenennen") {
    if (!arg) return note("So geht's: /umbenennen <neuer Name>");
    chat.title = arg.slice(0, 80); note("✎ Chat heißt jetzt „" + chat.title + "“."); return chat.history.length ? saveChat(chat) : renderSide();
  }
  if (cmd === "/vollzugriff") { const on = !/^(aus|off|0)$/i.test(arg); setAuto(on); return note(on ? "Vollzugriff ist an – Mythos fragt nicht mehr nach." : "Vollzugriff ist aus – Mythos fragt vor Befehlen nach."); }
  if (cmd === "/hilfe" || cmd === "/help") return note(COMMANDS.map((c) => c[0] + (c[1] ? " " + c[1] : "") + " – " + c[2]).join("\n"));
  note("Unbekannter Befehl: " + cmd + " – /hilfe zeigt alle Befehle.");
}
function renderSlash() {
  const v = $("inp").value, box = $("slash");
  const list = /^\/\S*$/.test(v) ? COMMANDS.filter((c) => c[0].startsWith(v.toLowerCase())) : [];
  box.textContent = ""; box.style.display = list.length ? "flex" : "none";
  list.forEach((c) => {
    const b = el("button"); b.append(el("span", "c", c[0] + (c[1] ? " " + c[1] : "")), el("span", "d", c[2]));
    b.onclick = () => { $("inp").value = c[0] + (c[1] ? " " : ""); renderSlash(); grow(); $("inp").focus(); };
    box.appendChild(b);
  });
}

// ---------- Einstellungen: Modell, Design, automatisch testen ----------
function setModel(id) {
  cfg.model = id; window.mythos.setCfg(cfg); $("model").value = id;
  const m = prompts.models.find((x) => x.id === id); note("🧠 Modell: " + (m ? m.label : id) + " – gilt ab der nächsten Aufgabe.");
}
function renderModels() {
  const s = $("model"); s.textContent = "";
  prompts.models.forEach((m) => { const o = el("option", "", m.label); o.value = m.id; o.title = m.desc; s.appendChild(o); });
  s.value = cfg.model || "mythos-code";
}
function applyTheme() { document.body.classList.toggle("light", cfg.theme === "light"); $("btnTheme").textContent = cfg.theme === "light" ? "🌙" : "☀"; }
function setTheme(t) { cfg.theme = t; window.mythos.setCfg(cfg); applyTheme(); }
function setAutoTest(on) { cfg.autoTest = cfg.autoTest || {}; cfg.autoTest[cfg.folder] = !!on; window.mythos.setCfg(cfg); $("autotest").checked = !!on; }

// ---------- Bearbeiten ----------
function renderEdit() { $("editbar").style.display = editing == null ? "none" : "flex"; }
function startEdit(i) {
  if (isBusy(chat)) return; const it = chat.view[i]; if (!it) return;
  editing = i; $("inp").value = it.q != null ? it.q : it.text; attach = (it.att || []).slice(); renderFiles(); grow(); renderEdit(); $("inp").focus();
}
function cancelEdit() {
  if (editing == null) return;
  editing = null; $("inp").value = ""; attach = []; renderFiles(); grow(); renderEdit();
}

// ---------- Gespeicherte Chats ----------
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function newChat() {
  chat = { id: newId(), title: "Neuer Chat", folder: cfg.folder || "", created: Date.now(), updated: Date.now(), history: [], view: [] };
  cancelEdit(); renderChat(); renderSide(); $("inp").focus();
}
async function saveChat(c) {
  if (!c.history.length) return;
  c.updated = Date.now();
  const copy = Object.assign({}, c); delete copy.queue; // Warteschlange nur im Speicher
  await window.mythos.chats.save(copy); renderSide();
}
async function openChat(id) {
  if (chat && chat.id === id) return;
  let c = runs.has(id) ? runs.get(id).chat : await window.mythos.chats.get(id);
  if (!c) return renderSide();
  chat = c; chat.view = chat.view || []; chat.history = chat.history || []; cancelEdit();
  if (c.folder && c.folder !== cfg.folder) await setFolder(c.folder);
  renderChat(); renderSide();
}
async function deleteChat(c) {
  if (runs.has(c.id)) return note("Dieser Chat arbeitet gerade – erst stoppen, dann löschen.");
  if (!confirm("Chat „" + (c.title || "Chat") + "“ löschen?")) return;
  await window.mythos.chats.remove(c.id);
  if (chat.id === c.id) newChat(); else renderSide();
}
function renameChat(c, span) {
  const inp = el("input", "ren"); inp.value = c.title || ""; span.replaceWith(inp); inp.focus(); inp.select();
  inp.onclick = (e) => e.stopPropagation();
  let done = false;
  const finish = async (ok) => {
    if (done) return; done = true; const t = inp.value.trim().slice(0, 80);
    if (ok && t) {
      const full = chat.id === c.id ? chat : runs.has(c.id) ? runs.get(c.id).chat : await window.mythos.chats.get(c.id);
      if (full) { full.title = t; await saveChat(full); }
    }
    renderSide();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  inp.onblur = () => finish(true);
}

// ---------- Projekte ----------
const projects = () => (cfg.projects = cfg.projects || []);
function addProject(p) { if (p && !projects().includes(p)) projects().unshift(p); }
function renderHeader() {
  $("folder").textContent = cfg.folder ? base(cfg.folder) : "Projekt wählen"; $("btnFolder").title = cfg.folder || "Projektordner wählen";
  $("autotest").checked = autoTestOn(cfg.folder);
}
// Aktiven Projektordner wechseln (Git, MCP, Dateibaum, Terminal ziehen mit).
async function setFolder(p) {
  cfg.folder = p || ""; addProject(p); await window.mythos.setCfg(cfg);
  renderHeader(); refreshGit(); configureMcp();
  if (treeOpen()) { expanded.clear(); renderTree(); }
  if (!termBusy) { termCwd = cfg.folder || termCwd; renderTermPrompt(); }
}
async function setProject(p) {
  await setFolder(p);
  if (chat.history.length || isBusy(chat)) newChat(); else { chat.folder = cfg.folder; renderSide(); }
}
async function pickProject() { const f = await window.mythos.pickFolder(); if (f) setProject(f); }
async function removeProject(p) {
  cfg.projects = projects().filter((x) => x !== p);
  if (cfg.folder === p) return setProject(cfg.projects[0] || "");
  await window.mythos.setCfg(cfg); renderSide();
}
function chatRow(c, snippet) {
  const running = runs.has(c.id);
  const row = el("div", "item" + (chat && c.id === chat.id ? " on" : "") + (running ? " running" : "")); row.title = c.title || "Chat";
  const name = el("span", "name", (running ? "⏳ " : "") + (c.title || "Chat"));
  const date = el("span", "date", new Date(c.updated || Date.now()).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }));
  const ed = el("button", "x", "✎"); ed.title = "Umbenennen"; ed.onclick = (e) => { e.stopPropagation(); renameChat(c, name); };
  const x = el("button", "x", running ? "■" : "✕"); x.title = running ? "Stoppen" : "Löschen";
  x.onclick = (e) => { e.stopPropagation(); running ? stop(runs.get(c.id).chat) : deleteChat(c); };
  row.append(name, date, ed, x); row.onclick = () => openChat(c.id);
  if (snippet == null) return row;
  const wrap = el("div", "hit"); wrap.append(row, el("div", "snip", (c.folder ? "📁 " + base(c.folder) + " · " : "") + snippet));
  wrap.onclick = () => openChat(c.id); return wrap;
}
async function renderSide() {
  const pl = $("plist"); pl.textContent = "";
  projects().forEach((p) => {
    const row = el("div", "item" + (p === cfg.folder ? " on" : "")); row.title = p;
    const x = el("button", "x", "✕"); x.title = "Aus der Liste entfernen (Dateien bleiben)"; x.onclick = (e) => { e.stopPropagation(); removeProject(p); };
    row.append(el("span", "name", "📁 " + base(p)), x);
    row.onclick = () => { if (p !== cfg.folder) setProject(p); };
    pl.appendChild(row);
  });
  if (!projects().length) pl.appendChild(el("div", "hint", "Noch keine Projekte"));
  // Laufende Aufgaben aus allen Projekten
  const al = $("alist"); al.textContent = "";
  const active = [...runs.values()].map((r) => r.chat);
  $("asec").style.display = active.length ? "" : "none";
  active.forEach((c) => al.appendChild(chatRow(c, "arbeitet seit " + fmt(Date.now() - runs.get(c.id).t0))));
  const q = searchQ.trim();
  let list = [];
  try { list = q ? await window.mythos.chats.search(q) : (await window.mythos.chats.list()).filter((c) => (c.folder || "") === (cfg.folder || "")); } catch (e) {}
  if (q !== searchQ.trim()) return; // inzwischen neue Suche
  const cl = $("clist"); cl.textContent = "";
  list.forEach((c) => cl.appendChild(chatRow(runs.has(c.id) ? runs.get(c.id).chat : c, q ? c.snippet : null)));
  if (!list.length) cl.appendChild(el("div", "hint", q ? "Keine Treffer in deinen Chats" : "Noch keine gespeicherten Chats"));
}

// ---------- Dateibaum & Editor ----------
const expanded = new Set();
const treeOpen = () => document.body.classList.contains("tree-open");
function toggleTree() {
  if (!treeOpen() && !cfg.folder) return note("Wähle zuerst einen Projektordner.");
  document.body.classList.toggle("tree-open"); cfg.treeOpen = treeOpen(); window.mythos.setCfg(cfg);
  if (treeOpen()) renderTree();
}
async function renderTree() {
  const box = $("tree"); box.textContent = "";
  $("treeTitle").textContent = cfg.folder ? base(cfg.folder) : "Dateien";
  if (!cfg.folder) return box.appendChild(el("div", "hint", "Kein Projekt gewählt"));
  const folder = cfg.folder;
  const level = async (rel, depth, parent) => {
    const items = await window.mythos.files.list(folder, rel);
    if (folder !== cfg.folder) return;
    for (const it of items) {
      const row = el("div", "trow" + (it.dir ? " dir" : ""));
      row.style.paddingLeft = 8 + depth * 14 + "px";
      const open = it.dir && expanded.has(it.rel);
      row.append(el("span", "tic", it.dir ? (open ? "▾" : "▸") : "·"), el("span", "tname", (it.dir ? "📁 " : "") + it.name));
      row.title = it.rel;
      row.onclick = () => { if (it.dir) { open ? expanded.delete(it.rel) : expanded.add(it.rel); renderTree(); } else openEditor(it.rel); };
      parent.appendChild(row);
      if (open) await level(it.rel, depth + 1, parent);
    }
  };
  await level("", 0, box);
}
let edFile = null, edOrig = "";
async function openEditor(rel) {
  const r = await window.mythos.files.read(cfg.folder, rel);
  edFile = rel; $("edpath").textContent = rel; $("editor").style.display = "flex";
  const ta = $("edtext");
  if (r.error) { ta.value = ""; ta.disabled = true; $("edstatus").textContent = r.error; edOrig = ""; }
  else { ta.value = r.text; ta.disabled = false; edOrig = r.text; $("edstatus").textContent = "Strg+S speichert"; ta.focus(); }
}
function closeEditor() {
  if (edFile && $("edtext").value !== edOrig && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
  $("editor").style.display = "none"; edFile = null;
}
async function saveEditor() {
  if (!edFile || $("edtext").disabled) return;
  const r = await window.mythos.files.save(cfg.folder, edFile, $("edtext").value);
  if (r.error) { $("edstatus").textContent = "⚠ " + r.error; return; }
  edOrig = $("edtext").value; $("edstatus").textContent = "✓ Gespeichert (+" + r.diff.added + " −" + r.diff.removed + ")";
  refreshGit();
}

// ---------- Eingebautes Terminal ----------
let termCwd = "", termBusy = false, termHist = [], termHi = 0;
const termOpen = () => document.body.classList.contains("term-open");
function toggleTerm() {
  document.body.classList.toggle("term-open"); cfg.termOpen = termOpen(); window.mythos.setCfg(cfg);
  if (termOpen()) { if (!termCwd) termCwd = cfg.folder || ""; renderTermPrompt(); $("termin").focus(); }
}
function renderTermPrompt() { $("termcwd").textContent = (termCwd ? base(termCwd) : "~") + " ›"; $("termcwd").title = termCwd; $("termkill").style.display = termBusy ? "" : "none"; }
function termWrite(s) { const o = $("termout"); o.textContent = (o.textContent + s).slice(-60000); o.scrollTop = 1e9; }
async function termRun(cmdline) {
  const cmd = cmdline.trim(); if (!cmd || termBusy) return;
  termHist.push(cmd); termHi = termHist.length;
  termWrite((termCwd ? base(termCwd) : "~") + " › " + cmd + "\n");
  if (/^(cls|clear)$/i.test(cmd)) { $("termout").textContent = ""; return; }
  const cd = cmd.match(/^cd(?:\s+\/d)?\s*(.*)$/i);
  if (cd) {
    const d = await window.mythos.term.cd(termCwd, cd[1].replace(/^"|"$/g, "") || undefined);
    if (d) termCwd = d; else termWrite("Ordner nicht gefunden\n");
    return renderTermPrompt();
  }
  termBusy = true; renderTermPrompt();
  const r = await window.mythos.term.run(termCwd || cfg.folder || undefined, cmd);
  termBusy = false; renderTermPrompt();
  if (r.code) termWrite("[Exit " + r.code + "]\n");
}

// ---------- Dateien, Drag & Drop, Bilder einfügen ----------
// Bilder verkleinern (max. 1568 px), damit sie schnell und günstig ans Modell gehen.
function shrinkImage(mediaType, b64) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
      if (scale === 1 && b64.length < 1.5e6) return res({ media_type: mediaType, data: b64 });
      const c = document.createElement("canvas"); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      res({ media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] });
    };
    img.onerror = () => res(null);
    img.src = "data:" + mediaType + ";base64," + b64;
  });
}
const readAs = (file, how) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r[how](file); });
async function addFiles(files) {
  for (const f of Array.from(files).slice(0, 10)) {
    try {
      if (/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) {
        const url = await readAs(f, "readAsDataURL");
        const image = await shrinkImage(f.type, String(url).split(",")[1]);
        if (image) attach.push({ name: f.name || "Bild.png", image: image });
      } else if (f.size <= 2e6) {
        const text = await readAs(f, "readAsText");
        attach.push({ name: f.name, content: String(text).includes("\u0000") ? "(Binärdatei)" : String(text).slice(0, 60000) });
      } else note("📎 " + f.name + " ist zu groß (max. 2 MB).");
    } catch (e) { note("📎 " + (f.name || "Datei") + " konnte nicht gelesen werden (Ordner lassen sich nicht ablegen – nutze dafür 📁)."); }
  }
  renderFiles(); $("inp").focus();
}
function renderFiles() {
  const f = $("files"); f.textContent = "";
  attach.forEach((a, i) => { const c = el("button", "chip", (a.image ? "🖼 " : "📎 ") + a.name + "  ✕"); c.title = "Entfernen"; c.onclick = () => { attach.splice(i, 1); renderFiles(); }; f.appendChild(c); });
}
let dragDepth = 0;
document.addEventListener("dragenter", (e) => { if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return; dragDepth++; document.body.classList.add("dragging"); });
document.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove("dragging"); });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
  if ($("app").style.display !== "none" && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
$("inp").addEventListener("paste", (e) => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length) return;
  e.preventDefault(); addFiles(files);
});

// ---------- Anmeldung ----------
function setStatus(text, code) {
  const s = $("lstat"); s.textContent = text;
  if (code) { s.appendChild(document.createElement("br")); s.appendChild(el("span", "code mono glass", code)); }
}
async function login() {
  $("btnLogin").disabled = true; setStatus("Browser öffnet sich …");
  let s; try { s = await (await post("cli-auth", { action: "start", client: "app" })).json(); } catch (e) { s = null; }
  if (!s || !s.code) { setStatus("Anmeldung gerade nicht möglich – bitte nochmal versuchen."); $("btnLogin").disabled = false; return; }
  window.mythos.open(CFG.site + "/cli-auth?code=" + s.code);
  setStatus("Klicke im Browser auf „Authentifizieren“. Dein Code:", s.code);
  const iv = setInterval(async () => {
    let p; try { p = await (await post("cli-auth", { action: "poll", code: s.code, poll_secret: s.poll_secret })).json(); } catch (e) { return; }
    if (p.status === "ok") { clearInterval(iv); cfg.key = p.api_key; cfg.name = p.name; await window.mythos.setCfg(cfg); show(); }
    if (p.status === "expired") { clearInterval(iv); setStatus("Abgelaufen – bitte nochmal versuchen."); $("btnLogin").disabled = false; }
  }, 2000);
}
function show() {
  $("login").style.display = "none"; $("app").style.display = "flex";
  renderHeader(); refreshGit(); configureMcp(); renderModels();
  $("multi").checked = !!cfg.multi; $("wake").checked = !!cfg.wake; if (cfg.wake) setTimeout(wakeOn, 800);
  if (cfg.treeOpen && cfg.folder) { document.body.classList.add("tree-open"); renderTree(); }
  if (cfg.termOpen) { document.body.classList.add("term-open"); termCwd = cfg.folder || ""; renderTermPrompt(); }
  if (!chat) newChat(); else renderSide();
  usage(); $("inp").focus();
}
function grow() { const t = $("inp"); t.style.height = "auto"; if (t.value) t.style.height = Math.min(200, t.scrollHeight) + "px"; }

// ---------- Ereignisse ----------
window.mythos.onOutput((p) => {
  for (const run of runs.values()) if (run.id === p.id && run.out != null) {
    run.out = (run.out + stripAnsi(p.chunk)).slice(-20000);
    if (run.chat === chat) schedulePaint(run);
  }
});
window.mythos.term.onOutput((p) => { if (p.id === "term") termWrite(stripAnsi(p.chunk)); });
window.mythos.mcp.onChange((s) => { mcpStatus = s; renderMcp(); });
$("btnLogin").onclick = login;
$("btnSend").onclick = () => (isBusy(chat) ? stop(chat) : send());
$("inp").oninput = () => { grow(); renderSlash(); };
$("inp").onkeydown = (e) => {
  if (e.key === "Tab" && $("slash").style.display !== "none") { e.preventDefault(); $("slash").firstChild.click(); return; }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
};
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && $("editor").style.display !== "none") { e.preventDefault(); saveEditor(); return; }
  if (e.key !== "Escape") return;
  if ($("editor").style.display !== "none") return closeEditor();
  if ($("slash").style.display !== "none") { $("slash").style.display = "none"; return; }
  if (typeof vm !== "undefined" && vm.on) return voiceStop();
  if (isBusy(chat)) stop(chat); else cancelEdit();
});
let searchTimer = 0;
$("csearch").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchQ = $("csearch").value; renderSide(); }, 200); };
$("git").onclick = () => command("/git");
$("mcp").onclick = () => command("/mcp");
$("tokens").onclick = () => command("/tokens");
$("model").onchange = () => setModel($("model").value);
$("btnTheme").onclick = () => setTheme(cfg.theme === "light" ? "dark" : "light");
$("btnPreview").onclick = () => command("/vorschau");
$("btnTree").onclick = toggleTree; $("treeClose").onclick = toggleTree; $("treeRefresh").onclick = () => renderTree();
$("btnTerm").onclick = toggleTerm; $("termClose").onclick = toggleTerm;
$("termkill").onclick = () => window.mythos.term.kill();
$("termin").onkeydown = (e) => {
  const t = $("termin");
  if (e.key === "Enter") { const v = t.value; t.value = ""; termRun(v); }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (termHi > 0) t.value = termHist[--termHi] || ""; }
  else if (e.key === "ArrowDown") { e.preventDefault(); if (termHi < termHist.length) t.value = termHist[++termHi] || ""; }
  else if (e.key === "c" && e.ctrlKey && termBusy) { e.preventDefault(); window.mythos.term.kill(); }
};
$("edsave").onclick = saveEditor; $("edclose").onclick = closeEditor;
$("edreveal").onclick = () => edFile && window.mythos.files.reveal(cfg.folder, edFile);
$("edattach").onclick = () => { if (!edFile) return; attach.push({ name: edFile, content: $("edtext").value.slice(0, 60000) }); renderFiles(); $("edstatus").textContent = "📎 An die nächste Nachricht angehängt"; };
$("edtext").onkeydown = (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault(); const t = e.target, s = t.selectionStart;
  t.value = t.value.slice(0, s) + "  " + t.value.slice(t.selectionEnd); t.selectionStart = t.selectionEnd = s + 2;
};
$("btnResume").onclick = continueChat; $("btnGoalEnd").onclick = endGoal;
$("auto").onchange = () => setAuto($("auto").checked);
$("autotest").onchange = () => { if (!cfg.folder) { $("autotest").checked = false; return note("Wähle zuerst einen Projektordner."); } setAutoTest($("autotest").checked); };
$("btnFolder").onclick = pickProject; $("btnAddProj").onclick = pickProject;
$("btnNew").onclick = () => newChat();
$("btnEditCancel").onclick = cancelEdit;
$("btnUp").onclick = async () => {
  const picked = await window.mythos.pickFiles();
  for (const p of picked) {
    if (p.image) { const image = await shrinkImage(p.image.media_type, p.image.data); if (image) attach.push({ name: p.name, image: image }); }
    else attach.push(p);
  }
  renderFiles();
};
$("btnOut").onclick = async () => {
  runs.forEach((r) => stop(r.chat));
  cfg = { projects: cfg.projects, folder: cfg.folder, auto: cfg.auto, notify: cfg.notify, model: cfg.model, theme: cfg.theme, autoTest: cfg.autoTest, testCmd: cfg.testCmd };
  await window.mythos.setCfg(cfg); location.reload();
};
Promise.all([window.mythos.prompts(), window.mythos.getCfg()]).then(([p, c]) => {
  prompts = p; cfg = c || {}; $("auto").checked = !!cfg.auto; $("vvoice").value = cfg.voice || window.MythosVoice.VOICES[0].id; addProject(cfg.folder); applyTheme();
  if (cfg.key) show();
});

// ---------- Sprachmodus: zuhören → Whisper → Mythos → Antwort vorlesen → wieder zuhören ----------
const V = window.MythosVoice;
const vm = { on: false, phase: "idle", rec: null, waitChat: null, orbStop: null, cam: null, scr: null };
function setVStatus(text, sub) { $("vstatus").textContent = text; if (sub != null) $("vsub").textContent = sub; }
const voiceLevel = () => (vm.phase === "listening" && vm.rec ? vm.rec.level() : vm.phase === "speaking" ? V.speaker.level() : 0);
function voiceStart(firstText) {
  if (vm.on) return;
  wakeOff();
  vm.on = true; document.body.classList.add("voice-on"); $("voicebar").style.display = "flex";
  V.speaker.setVoice(cfg.voice || V.VOICES[0].id); V.speaker.prepare(); V.loadStt();
  if (!vm.orbStop) vm.orbStop = V.createOrb($("vorb"), () => ({ status: vm.phase, level: voiceLevel() }));
  // „Hey Mythos, mach …“ – der Rest des Satzes ist schon die erste Aufgabe.
  if (firstText && firstText.length > 2) voiceHandleText(firstText); else voiceListen();
}
function voiceStop() {
  vm.on = false; vm.waitChat = null;
  if (vm.rec) { vm.rec.cancel(); vm.rec = null; }
  V.speaker.stop(); vm.phase = "idle";
  stopSee("cam"); stopSee("scr");
  document.body.classList.remove("voice-on"); $("voicebar").style.display = "none";
  if (vm.orbStop) { vm.orbStop(); vm.orbStop = null; }
  if (cfg.wake) setTimeout(wakeOn, 600);
}
async function voiceListen() {
  if (!vm.on || vm.rec) return;
  vm.phase = "listening"; setVStatus("Ich höre zu … sprich einfach los", "Kurze Pause = fertig · Klick auf das Logo = sofort senden");
  try {
    vm.rec = await V.record({
      onSpeech: () => setVStatus("Ich höre zu …"),
      onDone: async (pcm) => {
        vm.rec = null;
        if (!vm.on) return;
        if (!pcm) return voiceListen();
        vm.phase = "thinking"; setVStatus("Verstehe …", "");
        let text = "";
        try { text = await V.transcribe(pcm); } catch (e) { note("🎙 Spracherkennung fehlgeschlagen: " + e.message); return voiceStop(); }
        if (!vm.on) return;
        voiceHandleText(text);
      },
    });
  } catch (e) { note("🎙 Mikrofon nicht verfügbar: " + e.message); voiceStop(); }
}
function voiceHandleText(raw) {
  const text = String(raw).replace(/^\[.*?\]$|^\(.*?\)$/g, "").trim(); // Whisper-Geräusch-Markierungen
  if (text.length < 2) return voiceListen();
  if (/^(stopp?|beenden|tschüss|sprachmodus aus)[.!]?$/i.test(text)) { voiceStop(); return note("🎙 Sprachmodus beendet."); }
  // Kamera / Bildschirm: nur wenn eingeschaltet, ein Standbild pro Frage.
  const att = [];
  const cam = vm.cam && V.grabFrame($("vcam"), 1280); if (cam) att.push({ name: "Kamera.jpg", image: cam });
  const scr = vm.scr && V.grabFrame($("vscr"), 1568); if (scr) att.push({ name: "Bildschirm.jpg", image: scr });
  vm.phase = "thinking";
  setVStatus("„" + text + "“", "Mythos arbeitet …" + (att.length ? " (mit " + att.map((a) => a.name.replace(".jpg", "")).join(" + ") + ")" : ""));
  vm.waitChat = chat;
  if (isBusy(chat)) { (chat.queue = chat.queue || []).push({ q: text, att: att }); renderQueue(); }
  else submit(chat, text, att, { fresh: true });
}
// ---------- Kamera & Bildschirm (nur auf Knopfdruck, mit Vorschau) ----------
function stopSee(key) {
  if (!vm[key]) return;
  vm[key].getTracks().forEach((t) => t.stop()); vm[key] = null;
  const vid = $(key === "cam" ? "vcam" : "vscr"); vid.srcObject = null; vid.style.display = "none";
  $(key === "cam" ? "vcamBtn" : "vscrBtn").classList.remove("on");
  $("vsee").style.display = vm.cam || vm.scr ? "flex" : "none";
}
async function toggleSee(key) {
  if (vm[key]) return stopSee(key);
  try {
    vm[key] = key === "cam"
      ? await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const vid = $(key === "cam" ? "vcam" : "vscr");
    vid.srcObject = vm[key]; vid.style.display = "block"; await vid.play();
    $(key === "cam" ? "vcamBtn" : "vscrBtn").classList.add("on");
    $("vsee").style.display = "flex";
    vm[key].getVideoTracks()[0].onended = () => stopSee(key);
  } catch (e) { vm[key] = null; note((key === "cam" ? "📷 Kamera" : "🖥 Bildschirm") + " nicht verfügbar: " + e.message); }
}
// ---------- „Hey Mythos“ ----------
let wake = null;
function wakeOn() {
  if (wake || vm.on || !cfg.wake || $("app").style.display === "none") return;
  $("wakechip").style.display = "";
  wake = V.wakeListener({
    onWake: (rest) => {
      wake = null;
      const chip = $("wakechip"); chip.classList.add("heard"); setTimeout(() => chip.classList.remove("heard"), 1500);
      voiceStart(rest);
    },
    onError: (e) => { wake = null; note("👂 „Hey Mythos“ braucht das Mikrofon: " + e.message); setWake(false); },
  });
}
function wakeOff() { if (wake) { wake.stop(); wake = null; } }
function setWake(on) {
  cfg.wake = !!on; window.mythos.setCfg(cfg); $("wake").checked = !!on;
  if (on) wakeOn(); else { wakeOff(); $("wakechip").style.display = "none"; }
}
function voiceReply(c, text) {
  if (!vm.on || vm.waitChat !== c) return;
  vm.waitChat = null; vm.phase = "speaking"; setVStatus("Mythos spricht …", "Klick auf das Logo = unterbrechen");
  V.speaker.speak(text, { onEnd: () => { if (vm.on && vm.phase === "speaking") { vm.phase = "idle"; voiceListen(); } } });
}
function voiceInterrupt() {
  if (!vm.on) return;
  if (vm.phase === "listening" && vm.rec) vm.rec.stop();
  else if (vm.phase === "speaking") { V.speaker.stop(); vm.phase = "idle"; voiceListen(); }
  else if (vm.phase === "thinking" && isBusy(chat)) stop(chat);
}
V.onSttState((s) => { if (vm.on && s.status === "loading") $("vsub").textContent = "Spracherkennung wird geladen … " + s.pct + "% (nur beim ersten Mal)"; });
V.onTtsState((s) => { if (vm.on && s.status === "loading" && vm.phase !== "listening") $("vsub").textContent = "Stimme wird geladen … " + s.pct + "%"; });
V.VOICES.forEach((v) => { const o = el("option", "", v.label); o.value = v.id; $("vvoice").appendChild(o); });
$("vvoice").onchange = () => { cfg.voice = $("vvoice").value; window.mythos.setCfg(cfg); V.speaker.setVoice(cfg.voice); };
$("btnVoice").onclick = () => (vm.on ? voiceStop() : voiceStart());
$("vcamBtn").onclick = () => toggleSee("cam"); $("vscrBtn").onclick = () => toggleSee("scr");
$("wake").onchange = () => setWake($("wake").checked); $("wakechip").onclick = () => setWake(false);
$("vclose").onclick = voiceStop; $("vstop").onclick = voiceInterrupt; $("vorb").onclick = voiceInterrupt;

// ---------- Multi-Agent: Aufgabe aufteilen, Teil-Agenten parallel, danach Koordinator ----------
const AGENT_ICON = { wartet: "⏳", läuft: "⚙", fertig: "✓", fehler: "⚠", gestoppt: "■" };
const agentEls = new WeakMap();
function renderAgents(d, it) {
  d.textContent = "";
  d.appendChild(el("div", "ah", "🧩 Multi-Agent: " + it.agents.length + " Agenten arbeiten parallel"));
  it.agents.forEach((a) => {
    const row = el("div", "ag");
    row.append(el("span", "st", AGENT_ICON[a.status] || "⏳"), el("span", "ti", "Agent " + (a.i + 1) + ": " + a.title), el("span", "ph", a.phase || a.status));
    d.appendChild(row);
  });
}
const PLAN_PROMPT = "Zerlege die folgende Aufgabe in 2 bis 4 Teilaufgaben, die GLEICHZEITIG von verschiedenen Agenten erledigt werden können, ohne sich gegenseitig zu stören – also möglichst getrennte Dateien pro Teilaufgabe. " +
  "Wenn die Aufgabe klein ist oder sich nicht sinnvoll aufteilen lässt (z. B. eine Frage oder eine einzige Datei), gib genau EINE Teilaufgabe zurück. " +
  "Antworte NUR mit JSON, ohne Werkzeuge: {\"subtasks\":[{\"title\":\"kurzer Titel\",\"task\":\"was genau zu tun ist\",\"files\":[\"pfad/datei\"]}]}";
function parsePlan(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  try { const j = JSON.parse(m ? m[0] : text); return Array.isArray(j.subtasks) ? j.subtasks.filter((s) => s && s.task) : []; } catch (e) { return []; }
}
/** Liefert true, wenn Teil-Agenten Dateien geändert haben. */
async function multiAgentPhase(run, c) {
  const task = c.history[c.history.length - 1].content;
  run.phase = "plant Teilaufgaben";
  const top = run.folder ? (await window.mythos.files.list(run.folder, "")).map((f) => (f.dir ? f.name + "/" : f.name)).slice(0, 80).join(", ") : "";
  const plan = parsePlan(await call(run, [{ role: "user", content: PLAN_PROMPT + (top ? "\n\nProjektordner enthält: " + top : "") + "\n\nAUFGABE:\n" + task }], await systemPrompt(run)));
  run.phase = "";
  if (run.stopped || plan.length < 2) { if (!run.stopped) noteTo(c, "🧩 Die Aufgabe ist überschaubar – ein Agent reicht."); return false; }
  const subs = plan.slice(0, 4).map((s, i) => ({
    i, title: String(s.title || "Teil " + (i + 1)).slice(0, 60), task: String(s.task), files: Array.isArray(s.files) ? s.files.map(String) : [],
    status: "wartet", phase: "", id: run.id + "-a" + i, ctl: null, chat: c, model: run.model, result: "", changed: false,
    get stopped() { return run.stopped; },
  }));
  run.subs = subs;
  addTo(c, "agents", "", { agents: [] });
  const item = c.view[c.view.length - 1];
  const update = () => {
    item.agents = subs.map((s) => ({ i: s.i, title: s.title, status: s.status, phase: s.phase }));
    const d = agentEls.get(item); if (d && d.isConnected) renderAgents(d, item);
  };
  update();
  const sys = (await systemPrompt(run)) + "\n\nMULTI-AGENT: Du bist ein Teil-Agent und arbeitest parallel mit anderen. Bleib strikt bei deiner Teilaufgabe und deinen Dateien.";
  await Promise.all(subs.map((s) => runSubAgent(run, c, s, subs.length, task, sys, update)));
  const list = subs.map((s) => "- Agent " + (s.i + 1) + ": " + s.title).join("\n");
  c.history.push({ role: "assistant", content: "Ich habe die Aufgabe auf " + subs.length + " parallele Agenten aufgeteilt:\n" + list });
  c.history.push({ role: "user", content: "Ergebnisse der Teil-Agenten:\n\n" + subs.map((s) => "### Agent " + (s.i + 1) + ": " + s.title + " (" + s.status + ")\n" + s.result).join("\n\n") +
    "\n\nPrüfe jetzt als Koordinator, ob alles zusammenpasst (Dateien lesen, ggf. Build/Tests ausführen), behebe Konflikte oder Lücken und gib dann die Abschlussantwort." });
  saveChat(c);
  return subs.some((s) => s.changed);
}
async function runSubAgent(run, c, s, n, task, sys, update) {
  s.status = "läuft"; update();
  const tag = "🤖" + (s.i + 1) + " ";
  const hist = [{ role: "user", content: "Gesamtaufgabe:\n" + task + "\n\nDEINE Teilaufgabe (Agent " + (s.i + 1) + " von " + n + "): " + s.title + "\n" + s.task +
    (s.files.length ? "\nDu bist zuständig für: " + s.files.join(", ") + ". Ändere keine anderen Dateien – andere Agenten arbeiten gleichzeitig daran." : "") +
    "\nArbeite selbstständig und ohne Rückfragen. Am Ende: kurze Zusammenfassung, was du gemacht hast." }];
  try {
    for (let step = 0; step < 25 && !run.stopped; step++) {
      s.phase = "denkt …"; update();
      const out = await call(s, hist, sys);
      if (run.stopped) break;
      hist.push({ role: "assistant", content: out });
      const m = out.match(/<tool>([\s\S]*?)<\/tool>/), text = out.replace(/<tool>[\s\S]*?<\/tool>/g, "").trim();
      if (!m) { s.result = text || "(fertig, ohne Bericht)"; break; }
      let t; try { t = JSON.parse(m[1]); } catch (e) { hist.push({ role: "user", content: "Tool-JSON ungültig." }); continue; }
      s.phase = toolLabel(t); update();
      addTo(c, "tool", tag + toolLabel(t));
      let r;
      if (needsConfirm(t) && !$("auto").checked && !confirm("Agent " + (s.i + 1) + " möchte ausführen:\n" + toolLabel(t))) r = { result: "Vom Nutzer abgelehnt." };
      else {
        r = await window.mythos.tool(t, run.folder, s.id);
        if (t.name === "run") addTo(c, "out", r.result.slice(-3000), { cmd: tag + t.cmd });
        if (r.diff && r.diff.lines.length) { addTo(c, "diff", "", { path: tag + t.path, d: r.diff }); s.changed = true; }
      }
      hist.push({ role: "user", content: "Werkzeug-Ergebnis:\n" + r.result });
    }
    s.status = run.stopped ? "gestoppt" : "fertig"; s.phase = "";
    if (s.result && !run.stopped) addTo(c, "a", "**" + tag + "Agent " + (s.i + 1) + " – " + s.title + ":** " + s.result);
  } catch (e) {
    s.status = run.stopped ? "gestoppt" : "fehler"; s.phase = run.stopped ? "" : e.message; s.result = "FEHLER: " + e.message;
  }
  update();
}
function setMulti(on) { cfg.multi = !!on; window.mythos.setCfg(cfg); $("multi").checked = !!on; }
$("multi").onchange = () => setMulti($("multi").checked);
