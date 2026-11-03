// Safe "markdown-ish" renderer for untrusted text (agent output, comments).
// Builds DOM nodes with textContent only — never innerHTML — so nothing the
// agent writes can become markup, script or a link. Supports headings, lists,
// task lists, code fences, block quotes, rules, inline `code` and **bold**.
// Tables and anything else render as plain text.

const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Append `text` to `parent`, turning `code` and **bold** spans into elements. */
function appendInline(parent, text) {
  for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      const c = el("code");
      c.textContent = part.slice(1, -1);
      parent.append(c);
    } else if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      const b = el("strong");
      b.textContent = part.slice(2, -2);
      parent.append(b);
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}

/** Render markdown-ish `src` into a DocumentFragment. */
export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para = [];
  let list = null; // { el, ordered }
  let lastItem = null;

  const flush = () => {
    if (para.length) {
      const p = el("p");
      appendInline(p, para.join(" "));
      frag.append(p);
      para = [];
    }
  };
  const endList = () => {
    list = null;
    lastItem = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flush();
      endList();
      const code = [];
      while (i + 1 < lines.length && !/^\s*```/.test(lines[i + 1])) code.push(lines[++i]);
      i++; // skip the closing fence (or run past the end while still streaming)
      const pre = el("pre");
      const c = el("code");
      c.textContent = code.join("\n");
      pre.append(c);
      frag.append(pre);
      continue;
    }
    if (!line.trim()) {
      flush();
      endList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      endList();
      const h = el(`h${heading[1].length + 2}`, `md-h${heading[1].length}`); // # -> h3 inside the report card
      appendInline(h, heading[2]);
      frag.append(h);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      endList();
      frag.append(el("hr"));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      endList();
      const q = el("blockquote");
      appendInline(q, quote[1]);
      frag.append(q);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = !!ordered;
      if (!list || list.ordered !== isOrdered) {
        list = { el: el(isOrdered ? "ol" : "ul"), ordered: isOrdered };
        frag.append(list.el);
      }
      let text = (bullet ?? ordered)[1];
      const li = el("li");
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
      if (task) {
        li.className = task[1] === " " ? "task" : "task done";
        text = task[2];
      }
      appendInline(li, text);
      list.el.append(li);
      lastItem = li;
      continue;
    }
    if (lastItem && /^\s{2,}\S/.test(line)) {
      // indented continuation of a list item
      lastItem.append(document.createTextNode(" "));
      appendInline(lastItem, line.trim());
      continue;
    }
    endList();
    para.push(line.trim());
  }
  flush();
  return frag;
}
