// Markdown -> DOM, ohne innerHTML (sicher gegen eingeschleustes HTML).
// renderMarkdown(box, text, openLink) füllt `box` mit Überschriften, Listen, Code, Tabellen, Links …
(function () {
  const mk = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };

  function inline(parent, text, openLink) {
    const re = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      last = re.lastIndex;
      if (m[1]) parent.appendChild(mk("code", "ic", m[2]));
      else if (m[3] != null) inline(parent.appendChild(mk("strong")), m[3], openLink);
      else if (m[4] != null) inline(parent.appendChild(mk("s")), m[4], openLink);
      else if (m[5] != null) inline(parent.appendChild(mk("em")), m[5], openLink);
      else if (m[6] != null) inline(parent.appendChild(mk("em")), m[6], openLink);
      else {
        const label = m[7] != null ? m[7] : m[9], url = m[8] != null ? m[8] : m[9];
        const a = mk("a", "", label); a.href = "#"; a.title = url;
        a.onclick = (e) => { e.preventDefault(); if (/^https?:\/\//i.test(url)) openLink(url); };
        parent.appendChild(a);
      }
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function codeBlock(lang, code) {
    const wrap = mk("div", "codeblock");
    const head = mk("div", "codehead");
    head.appendChild(mk("span", "", lang || "code"));
    const copy = mk("button", "copy", "Kopieren");
    copy.onclick = () => { navigator.clipboard.writeText(code).then(() => { copy.textContent = "✓ Kopiert"; setTimeout(() => (copy.textContent = "Kopieren"), 1500); }); };
    head.appendChild(copy);
    wrap.append(head, mk("pre", "", code));
    return wrap;
  }

  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  window.renderMarkdown = function (box, text, openLink) {
    openLink = openLink || (() => {});
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    let i = 0, para = [];
    const flush = () => { if (!para.length) return; const p = mk("p"); inline(p, para.join("\n"), openLink); box.appendChild(p); para = []; };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
      if (fence) {
        flush();
        const code = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
        i++;
        box.appendChild(codeBlock(fence[2], code.join("\n")));
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); const e = mk("h" + Math.min(6, h[1].length + 2)); inline(e, h[2], openLink); box.appendChild(e); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); box.appendChild(mk("hr")); i++; continue; }
      if (/^\s*>/.test(line)) {
        flush(); const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        const bq = mk("blockquote"); window.renderMarkdown(bq, q.join("\n"), openLink); box.appendChild(bq); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const table = mk("table"), head = mk("tr");
        cells(line).forEach((c) => inline(head.appendChild(mk("th")), c, openLink));
        table.appendChild(head); i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const tr = mk("tr"); cells(lines[i++]).forEach((c) => inline(tr.appendChild(mk("td")), c, openLink)); table.appendChild(tr);
        }
        const sc = mk("div", "tablewrap"); sc.appendChild(table); box.appendChild(sc); continue;
      }
      const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flush();
        const ordered = /\d/.test(li[1]), list = mk(ordered ? "ol" : "ul");
        while (i < lines.length) {
          const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
          if (!m || /\d/.test(m[1]) !== ordered) break;
          const item = mk("li"); const task = m[2].match(/^\[([ xX])\]\s+(.*)$/);
          if (task) { item.appendChild(mk("span", "task", task[1] === " " ? "☐ " : "☑ ")); inline(item, task[2], openLink); } else inline(item, m[2], openLink);
          list.appendChild(item); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { item.appendChild(document.createTextNode(" " + lines[i].trim())); i++; }
        }
        box.appendChild(list); continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line); i++;
    }
    flush();
  };
})();
