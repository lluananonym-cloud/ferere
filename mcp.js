// Mythos Code – MCP-Client (stdio + Streamable HTTP), kompatibel mit dem .mcp.json-Format von Claude Code.
const { spawn, execFile } = require("child_process");

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "mythos-code", version: "1" };
const TIMEOUT = 60000;

function expandEnv(v) {
  if (typeof v === "string") return v.replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? "");
  if (Array.isArray(v)) return v.map(expandEnv);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)]));
  return v;
}

function contentToText(result) {
  if (!result) return "";
  const parts = (result.content || []).map((c) => {
    if (c.type === "text") return c.text;
    if (c.type === "image") return `[Bild ${c.mimeType || ""}]`;
    if (c.type === "resource") return c.resource?.text ?? `[Ressource ${c.resource?.uri || ""}]`;
    if (c.type === "resource_link") return `[Link ${c.uri}]`;
    return JSON.stringify(c);
  });
  if (result.structuredContent && !parts.length) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join("\n");
}

class StdioTransport {
  constructor(cfg, cwd, onMessage, onClose) {
    const win = process.platform === "win32";
    // Mit shell:true (nötig für npx.cmd & Co.) müssen Argumente mit Leerzeichen selbst gequotet werden.
    const args = (cfg.args || []).map((a) => (win && /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a));
    this.proc = spawn(cfg.command, args, {
      cwd: cwd || undefined, env: { ...process.env, ...(cfg.env || {}) }, shell: win, windowsHide: true,
    });
    this.stderr = "";
    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line)); } catch { /* keine JSON-Zeile */ }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on("close", (code) => onClose("Prozess beendet (Code " + code + ")" + (this.stderr ? ": " + this.stderr.trim().split("\n").pop() : "")));
    this.proc.on("error", (e) => onClose(e.message));
  }
  send(msg) { this.proc.stdin.write(JSON.stringify(msg) + "\n"); }
  close() {
    if (this.proc.exitCode !== null) return;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else this.proc.kill();
  }
}

class HttpTransport {
  constructor(cfg, onMessage) { this.url = cfg.url; this.headers = cfg.headers || {}; this.onMessage = onMessage; this.session = null; }
  async send(msg) {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, ...(this.session ? { "Mcp-Session-Id": this.session } : {}), ...this.headers },
      body: JSON.stringify(msg),
    });
    const sid = r.headers.get("mcp-session-id"); if (sid) this.session = sid;
    if (r.status === 202 || r.status === 204) return;
    if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
    const type = r.headers.get("content-type") || "";
    if (type.includes("text/event-stream")) {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (data) { try { this.onMessage(JSON.parse(data)); } catch { /* ignorieren */ } }
        }
      }
    } else {
      const text = await r.text();
      if (text.trim()) { const j = JSON.parse(text); (Array.isArray(j) ? j : [j]).forEach((m) => this.onMessage(m)); }
    }
  }
  close() {
    if (this.session) fetch(this.url, { method: "DELETE", headers: { "Mcp-Session-Id": this.session, ...this.headers } }).catch(() => {});
  }
}

class McpClient {
  constructor(name, cfg, scope, cwd, onChange) {
    this.name = name; this.cfg = cfg; this.scope = scope; this.cwd = cwd; this.onChange = onChange;
    this.status = "connecting"; this.error = null; this.tools = []; this.pending = new Map(); this.nextId = 1;
  }
  async start() {
    try {
      const cfg = expandEnv(this.cfg);
      const onMessage = (m) => this.handle(m);
      const isHttp = cfg.type === "http" || cfg.type === "streamable-http" || cfg.type === "sse" || (!cfg.command && cfg.url);
      if (!isHttp && !cfg.command) throw new Error("command fehlt");
      if (isHttp && !cfg.url) throw new Error("url fehlt");
      this.transport = isHttp ? new HttpTransport(cfg, onMessage) : new StdioTransport(cfg, this.cwd, onMessage, (why) => this.fail(why));
      const init = await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: { roots: { listChanged: false } }, clientInfo: CLIENT });
      this.serverInfo = init && init.serverInfo;
      await this.notify("notifications/initialized");
      await this.loadTools();
      this.status = "connected"; this.onChange();
    } catch (e) { this.fail(e.message); }
  }
  async loadTools() {
    const all = []; let cursor;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      all.push(...((r && r.tools) || [])); cursor = r && r.nextCursor;
    } while (cursor);
    this.tools = all;
  }
  fail(why) {
    if (this.status === "stopped") return;
    this.status = "error"; this.error = why;
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear(); this.onChange();
  }
  handle(m) {
    if (m.id != null && (m.result !== undefined || m.error)) {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || "MCP-Fehler")); else p.resolve(m.result);
      return;
    }
    if (m.id != null && m.method) {
      const reply = (result) => this.transport.send({ jsonrpc: "2.0", id: m.id, result });
      if (m.method === "ping") return reply({});
      if (m.method === "roots/list") return reply({ roots: this.cwd ? [{ uri: "file:///" + this.cwd.replace(/\\/g, "/").replace(/^\//, ""), name: "Projekt" }] : [] });
      return this.transport.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Nicht unterstützt" } });
    }
    if (m.method === "notifications/tools/list_changed") this.loadTools().then(() => this.onChange()).catch(() => {});
  }
  request(method, params, timeout = TIMEOUT) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ": Zeitüberschreitung")); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve(this.transport.send({ jsonrpc: "2.0", id, method, params })).catch((e) => {
        clearTimeout(timer); this.pending.delete(id); reject(e);
      });
    });
  }
  notify(method, params) { return Promise.resolve(this.transport.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })); }
  async call(tool, args) {
    if (this.status !== "connected") throw new Error(`MCP-Server "${this.name}" ist nicht verbunden (${this.error || this.status})`);
    const r = await this.request("tools/call", { name: tool, arguments: args || {} }, 300000);
    const text = contentToText(r);
    return { output: (r && r.isError ? "FEHLER: " : "") + (text || "(leeres Ergebnis)"), error: !!(r && r.isError) };
  }
  stop() { this.status = "stopped"; try { this.transport && this.transport.close(); } catch { /* egal */ } }
}

class McpManager {
  constructor({ onChange }) { this.onChange = onChange; this.clients = new Map(); this.defs = new Map(); }
  configure(globalServers, project) {
    const next = new Map();
    for (const [n, c] of Object.entries(globalServers || {})) if (!c.disabled) next.set(n, { cfg: c, scope: "global", cwd: project && project.cwd });
    for (const [n, c] of Object.entries((project && project.servers) || {})) if (!c.disabled) next.set(n, { cfg: c, scope: "projekt", cwd: project.cwd });
    for (const [n, cl] of this.clients) {
      const d = next.get(n);
      if (!d || JSON.stringify(d.cfg) !== JSON.stringify(cl.cfg) || d.cwd !== cl.cwd) { cl.stop(); this.clients.delete(n); }
    }
    for (const [n, d] of next) {
      if (this.clients.has(n)) continue;
      const cl = new McpClient(n, d.cfg, d.scope, d.cwd, () => this.onChange());
      this.clients.set(n, cl); cl.start();
    }
    this.defs = next; this.onChange();
  }
  restart(name) {
    const cl = this.clients.get(name); if (!cl) return this.status();
    cl.stop();
    const fresh = new McpClient(name, cl.cfg, cl.scope, cl.cwd, () => this.onChange());
    this.clients.set(name, fresh); fresh.start(); this.onChange();
    return this.status();
  }
  status() {
    return [...this.clients.values()].map((c) => ({
      name: c.name, scope: c.scope, status: c.status, error: c.error,
      tools: c.tools.map((t) => ({ name: t.name, description: (t.description || "").slice(0, 300), inputSchema: t.inputSchema })),
    }));
  }
  async call(server, tool, args) {
    const cl = this.clients.get(server);
    if (!cl) return { output: `FEHLER: MCP-Server "${server}" ist nicht konfiguriert`, error: true };
    try { return await cl.call(tool, args); } catch (e) { return { output: "FEHLER: " + e.message, error: true }; }
  }
  stopAll() { for (const c of this.clients.values()) c.stop(); }
}

module.exports = { McpManager };
