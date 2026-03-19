const idb = {
  db: null,
  async open(){
    if (this.db) return this.db;
    return new Promise((res, rej) => {
      const req = indexedDB.open("offline_notepad_db", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => { this.db = req.result; res(this.db); };
      req.onerror = () => rej(req.error);
    });
  },
  async get(key){
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv","readonly");
      const req = tx.objectStore("kv").get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async set(key, val){
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv","readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  }
};

const state = {
  wsHandle: null,
  notes: [],
  current: null,
  saveTimer: null,
  autosaveMs: 500,
  _lastFp: ""
};

const el = {
  wsName: document.getElementById("wsName"),
  saveState: document.getElementById("saveState"),
  noteList: document.getElementById("noteList"),
  currentTitle: document.getElementById("currentTitle"),
  currentMeta: document.getElementById("currentMeta"),
  btnRename: document.getElementById("btnRename"),
  editor: document.getElementById("editor"),
  editorBox: document.getElementById("editorBox"),
  preview: document.getElementById("preview"),

  btnOpenWs: document.getElementById("btnOpenWs"),
  btnDisconnectWs: document.getElementById("btnDisconnectWs"),
  btnNew: document.getElementById("btnNew"),
  btnDelete: document.getElementById("btnDelete"),
  newName: document.getElementById("newName"),
  search: document.getElementById("search"),

  rightPanel: document.getElementById("rightPanel"),
  btnToggleRight: document.getElementById("btnToggleRight"),
  btnTogglePreview: document.getElementById("btnTogglePreview"),
  btnPdf: document.getElementById("btnPdf"),
  
  btnExportMenu: document.getElementById("btnExportMenu"),
  exportMenu: document.getElementById("exportMenu"),

  btnScan: document.getElementById("btnScan"),
  btnAddNote: document.getElementById("btnAddNote"),
  btnAddGlobal: document.getElementById("btnAddGlobal"),
  bookmarkSearch: document.getElementById("bookmarkSearch"),

  noteLinks: document.getElementById("noteLinks"),
  noteLinksEmpty: document.getElementById("noteLinksEmpty"),
  globalLinks: document.getElementById("globalLinks"),
  globalLinksEmpty: document.getElementById("globalLinksEmpty"),
  noteSort: document.getElementById("noteSort"),
  globalSort: document.getElementById("globalSort"),

  noteCard: document.getElementById("noteCard"),
  globalCard: document.getElementById("globalCard"),
  noteCardBody: document.getElementById("noteCardBody"),
  globalCardBody: document.getElementById("globalCardBody"),

  btnExport: document.getElementById("btnExport"),
  btnTxt: document.getElementById("btnTxt"),
  fileImport: document.getElementById("fileImport")
};

const LS = {
  keyNotesIndex: "onp_notes_index_v1",
  keyNotePrefix: "onp_note_",
  keyLinksNotePrefix: "onp_note_links_",
  keyLinksGlobal: "onp_global_links_v1",

  getIndex(){ try{return JSON.parse(localStorage.getItem(this.keyNotesIndex)||"[]");}catch{return [];} },
  setIndex(arr){ localStorage.setItem(this.keyNotesIndex, JSON.stringify(arr)); },

  getNote(name){ return localStorage.getItem(this.keyNotePrefix + name) ?? ""; },
  setNote(name, content){
    localStorage.setItem(this.keyNotePrefix + name, content);
    const idx = this.getIndex();
    const now = Date.now();
    const ex = idx.find(n=>n.name===name);
    if (ex) ex.updatedAt = now; else idx.push({name, updatedAt: now});
    this.setIndex(idx);
  },
  deleteNote(name){
    localStorage.removeItem(this.keyNotePrefix + name);
    localStorage.removeItem(this.keyLinksNotePrefix + name);
    this.setIndex(this.getIndex().filter(n=>n.name!==name));
  },

  getNoteLinks(name){ try{return JSON.parse(localStorage.getItem(this.keyLinksNotePrefix+name)||"[]");}catch{return [];} },
  setNoteLinks(name, arr){ localStorage.setItem(this.keyLinksNotePrefix+name, JSON.stringify(arr)); },

  getGlobalLinks(){ try{return JSON.parse(localStorage.getItem(this.keyLinksGlobal)||"[]");}catch{return [];} },
  setGlobalLinks(arr){ localStorage.setItem(this.keyLinksGlobal, JSON.stringify(arr)); }
};

const FS = {
  supported: ("showDirectoryPicker" in window),
  async verifyPerm(handle, rw=false){
    const opts = { mode: rw ? "readwrite" : "read" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return (await handle.requestPermission(opts)) === "granted";
  },
  async listNotes(dirHandle){
    const out = [];
    for await (const [name, handle] of dirHandle.entries()){
      if (handle.kind !== "file") continue;
      if (!name.toLowerCase().endsWith(".md")) continue;
      const file = await handle.getFile();
      out.push({ name: name.replace(/\.md$/i,""), updatedAt: file.lastModified, source:"fs" });
    }
    out.sort((a,b)=>b.updatedAt-a.updatedAt || a.name.localeCompare(b.name));
    return out;
  },
  async readNote(dirHandle, name){
    const fh = await dirHandle.getFileHandle(name + ".md", {create:true});
    const file = await fh.getFile();
    return await file.text();
  },
  async writeNote(dirHandle, name, content){
    const fh = await dirHandle.getFileHandle(name + ".md", {create:true});
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  },
  async deleteNote(dirHandle, name){
    await dirHandle.removeEntry(name + ".md");
  },
  async exists(dirHandle, name){
    try{
      await dirHandle.getFileHandle(name + ".md", {create:false});
      return true;
    } catch {
      return false;
    }
  }
};

function escapeHtml(s){
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function sanitizeName(name){
  name = (name || "").trim().replace(/[\\/:*?"<>|]/g, "-");
  return name || null;
}

function hasWorkspace(){
  return !!(state.wsHandle && FS.supported);
}

function setWorkspaceLabel(){
  el.wsName.textContent = hasWorkspace() ? (state.wsHandle.name || "Workspace") : "localStorage";
  el.btnDisconnectWs.disabled = !hasWorkspace();
}

async function getAllCurrentNotesForBackup(){
  if (hasWorkspace()){
    const notes = await FS.listNotes(state.wsHandle);
    const out = [];
    for (const n of notes){
      const content = await FS.readNote(state.wsHandle, n.name);
      out.push({
        name: n.name,
        updatedAt: n.updatedAt,
        content,
        links: LS.getNoteLinks(n.name)
      });
    }
    return out;
  }

  const idx = LS.getIndex().slice().sort((a,b)=>b.updatedAt-a.updatedAt);
  return idx.map(n => ({
    ...n,
    content: LS.getNote(n.name),
    links: LS.getNoteLinks(n.name)
  }));
}

function getAllLocalNotesForMigration(){
  const idx = LS.getIndex().slice().sort((a,b)=>b.updatedAt-a.updatedAt);
  return idx.map(n => ({
    ...n,
    content: LS.getNote(n.name),
    links: LS.getNoteLinks(n.name)
  }));
}

async function migrateLocalNotesToWorkspace(dirHandle){
  const localNotes = getAllLocalNotesForMigration();
  if (!localNotes.length) return { moved: 0, skipped: 0 };

  let moved = 0;
  let skipped = 0;

  for (const n of localNotes){
    const safeName = sanitizeName(n.name);
    if (!safeName) { skipped++; continue; }

    const exists = await FS.exists(dirHandle, safeName);
    if (exists){
      skipped++;
      continue;
    }

    await FS.writeNote(dirHandle, safeName, n.content || "");
    if (Array.isArray(n.links)) LS.setNoteLinks(safeName, n.links);
    moved++;
  }

  return { moved, skipped };
}

function renderMarkdown(md){
  md = (md || "").replace(/\r\n/g, "\n");
  const lines = md.split("\n");

  let out = "";
  let inFence = false;
  let fenceBuf = [];
  let fenceLang = "";

  const getFenceLang = (line) => {
    const m = line.match(/^\s*```([a-zA-Z0-9_+-]*)\s*$/);
    return m ? (m[1] || "") : null;
  };

  const flushFence = () => {
    const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : "";
    out += `<pre><code${langClass}>${escapeHtml(fenceBuf.join("\n"))}</code></pre>\n`;
    fenceBuf = [];
    fenceLang = "";
  };

  const renderInline = (text) => {
    text = text.replace(/```([^`\n]+)```/g, (m, inner) => {
      return `<code>${escapeHtml(inner.trim())}</code>`;
    });

    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    text = text.replace(/(^|[\s(])((https?:\/\/[^\s<]+))/g, (m, lead, url) => {
      const cleanUrl = url.replace(/[.,;:!?]+$/, "");
      const trailing = url.slice(cleanUrl.length);

      return `${lead}<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
    });

    text = text.replace(/`([^`\n]+)`/g, (m, c) => `<code>${escapeHtml(c)}</code>`);
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    return text;
  };

  for (let i = 0; i < lines.length; i++){
    const raw = lines[i];
    const line = raw.trimEnd();

    const maybeLang = getFenceLang(line);
    if (maybeLang !== null){
      if (!inFence){
        inFence = true;
        fenceBuf = [];
        fenceLang = maybeLang.toLowerCase();
      } else {
        inFence = false;
        flushFence();
      }
      continue;
    }

    if (inFence){
      fenceBuf.push(raw);
      continue;
    }

    if (/^---\s*$/.test(line)){
      out += "<hr>\n";
      continue;
    }

    if (/^>\s?/.test(line)) {
      let quoteLines = [];

      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }

      i--;

      out += "<blockquote>" +
             quoteLines
               .map(x => renderInline(escapeHtml(x)))
               .join("<br>") +
             "</blockquote>";
      continue;
    }

    if (/^######\s+/.test(line)){
      out += `<h6>${renderInline(escapeHtml(line.replace(/^######\s+/, "")))}</h6>\n`;
      continue;
    }
    if (/^#####\s+/.test(line)){
      out += `<h5>${renderInline(escapeHtml(line.replace(/^#####\s+/, "")))}</h5>\n`;
      continue;
    }
    if (/^####\s+/.test(line)){
      out += `<h4>${renderInline(escapeHtml(line.replace(/^####\s+/, "")))}</h4>\n`;
      continue;
    }
    if (/^###\s+/.test(line)){
      out += `<h3>${renderInline(escapeHtml(line.replace(/^###\s+/, "")))}</h3>\n`;
      continue;
    }
    if (/^##\s+/.test(line)){
      out += `<h2>${renderInline(escapeHtml(line.replace(/^##\s+/, "")))}</h2>\n`;
      continue;
    }
    if (/^#\s+/.test(line)){
      out += `<h1>${renderInline(escapeHtml(line.replace(/^#\s+/, "")))}</h1>\n`;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)){
      let ul = "";
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i].trimEnd())){
        const liText = lines[i].trimEnd().replace(/^\s*[-*+]\s+/, "");
        ul += `<li>${renderInline(escapeHtml(liText))}</li>`;
        i++;
      }
      i--;
      out += `<ul>${ul}</ul>\n`;
      continue;
    }

    if (!line){
      out += "\n";
      continue;
    }

    out += `<p>${renderInline(escapeHtml(line))}</p>\n`;
  }

  if (inFence){
    flushFence();
  }

  return out;
}

function highlightPreviewCode(){
  if (typeof window.runHighlight === "function") {
    window.runHighlight(el.preview);
  }
}

function renderPreview(){
  el.preview.innerHTML = renderMarkdown(el.editor.value);
  highlightPreviewCode();
}

async function exportTxt(){
  if (!state.current) return alert("Select a note first.");

  const title = state.current;
  const content = el.editor.value;

  try{
    const handle = await window.showSaveFilePicker({
      suggestedName: title + ".txt",
      types: [{
        description: "Text file",
        accept: { "text/plain": [".txt"] }
      }]
    });

    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();

  } catch (err){
    if (err.name !== "AbortError"){
      console.error(err);
      alert("Could not save file.");
    }
  }
}

function exportPdf(){
  if (!state.current) return alert("Select a note first.");

  renderPreview();

  const title = state.current;
  const highlightedHtml = el.preview.innerHTML;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(title)}</title>

  <style>
    :root{
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:var(--sans);
      color:#0b0d12;
      background:#fff;
      padding:24px;
    }
    .wrap{max-width:900px;margin:0 auto;}
    .doc-title{font-weight:800;font-size:22px;margin:0 0 10px 0;}

    .preview{padding:0}
    .preview h1,.preview h2,.preview h3{margin:.8em 0 .4em 0}
    .preview p{margin:.55em 0}
    .preview code{
      font-family:var(--mono);
      background:#a0a0a0;
      border:none;
      padding:.12em .35em;
      border-radius:8px;
      color:#111;
    }
    .preview pre{
      background:#0b0d12;
      color:#fff;
      padding:12px;
      border-radius:12px;
      overflow:auto;
      border:1px solid #0b0d12;
      white-space:pre !important;
    }
    .preview pre code{
      display:block;
      background:transparent !important;
      border:none !important;
      padding:0 !important;
      border-radius:0 !important;
      color:inherit !important;
      white-space:inherit !important;
      font-family:var(--mono);
    }
    .preview a{color:#2557a7}
    .preview blockquote{
      margin:10px 0;
      padding:10px 12px;
      border-left:3px solid #2557a7;
      background:#f2f6ff;
      border-radius:10px;
    }
    .preview hr{border:0;border-top:1px solid #e6e8f1;margin:14px 0}

    .hljs{
      color:#e6edf3;
      background:transparent;
    }
    .hljs-comment,
    .hljs-quote{
      color:#8b949e;
      font-style:italic;
    }
    .hljs-keyword,
    .hljs-selector-tag,
    .hljs-subst{
      color:#ff7b72;
    }
    .hljs-string,
    .hljs-doctag,
    .hljs-regexp{
      color:#a5d6ff;
    }
    .hljs-title,
    .hljs-section,
    .hljs-selector-id,
    .hljs-title.class_,
    .hljs-title.function_{
      color:#d2a8ff;
    }
    .hljs-number,
    .hljs-literal,
    .hljs-variable,
    .hljs-template-variable,
    .hljs-type,
    .hljs-params{
      color:#79c0ff;
    }
    .hljs-built_in,
    .hljs-builtin-name{
      color:#ffa657;
    }
    .hljs-symbol,
    .hljs-bullet,
    .hljs-link,
    .hljs-selector-attr,
    .hljs-selector-pseudo,
    .hljs-attribute{
      color:#79c0ff;
    }
    .hljs-meta{
      color:#c9d1d9;
    }
    .hljs-emphasis{
      font-style:italic;
    }
    .hljs-strong{
      font-weight:700;
    }

    @page { margin: 14mm; }

    @media print{
      body{padding:0}
      .preview pre,
      .preview code,
      .preview pre code,
      .preview pre code *{
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 class="doc-title">${escapeHtml(title)}</h1>
    <div class="preview">${highlightedHtml}</div>
  </div>

<script>
  setTimeout(() => window.print(), 100);
<\/script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);

  const w = window.open(url, "_blank");
  if (!w){
    URL.revokeObjectURL(url);
    alert("Popup blocked. Allow popups for this file, then click Export PDF again.");
    return;
  }

  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


function extractLinks(text){
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  const out = [];
  let m;

  while ((m = re.exec(text)) !== null){
    out.push(m[0].replace(/[.,;:!?]+$/,""));
  }

  return [...new Set(out)];
}

function renameBookmarkInList(list, item, newTitle){
  return list.map(x => {
    if (x.url === item.url) {
      return { ...x, title: newTitle };
    }
    return x;
  });
}

function getHostname(url){
  try{
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function getFaviconUrl(url){
  const host = getHostname(url);
  if (!host) return "";

  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

function getFallbackLetter(url){
  const host = getHostname(url).replace(/^www\./i, "");
  return host ? host.charAt(0) : "?";
}

function linkRow(item, opts){
  const wrap = document.createElement("div");
  wrap.className = "link";

  const ts = new Date(item.ts).toLocaleDateString();
  const label = item.title || item.url;

  const faviconUrl = getFaviconUrl(item.url);
  const fallbackLetter = escapeHtml(getFallbackLetter(item.url));

  wrap.innerHTML = `
    <img class="ico" src="${faviconUrl}" alt="" loading="lazy">

    <div class="link-main">
      <a class="u" href="${item.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>
      <div class="ts">
      <a href="${item.url}" target="_blank" rel="noopener noreferrer">
      ${escapeHtml(item.url)}
      </a>
      </div>
    </div>

    <div class="link-actions">
      <button class="link-edit" type="button" title="Rename bookmark">✏️</button>
      <button class="link-del" type="button" title="Delete bookmark">Delete</button>
    </div>
  `;

  const iconEl = wrap.querySelector(".ico");
  iconEl.onerror = () => {
    const fallback = document.createElement("div");
    fallback.className = "ico-fallback";
    fallback.textContent = fallbackLetter;
    iconEl.replaceWith(fallback);
  };

  const editBtn = wrap.querySelector(".link-edit");
  const delBtn = wrap.querySelector(".link-del");

  // ✏️ RENAME
  editBtn.onclick = () => {
    const currentTitle = item.title || "";
    const newTitle = (prompt("Rename bookmark:", currentTitle) || "").trim();
    if (!newTitle) return;

    if (opts.note){
      const arr = LS.getNoteLinks(state.current);
      const updated = renameBookmarkInList(arr, item, newTitle);
      LS.setNoteLinks(state.current, updated);
    } else {
      const arr = LS.getGlobalLinks();
      const updated = renameBookmarkInList(arr, item, newTitle);
      LS.setGlobalLinks(updated);
    }

    renderLinks();
  };

  // 🗑 DELETE
  delBtn.onclick = async () => {
    if (!(await showConfirm("Remove this bookmark?"))) return;

    if (opts.note){
      const noteId = state.current;

      // Remove from NOTE
      let noteArr = LS.getNoteLinks(noteId);
      noteArr = noteArr.filter(x => x.url !== item.url);
      LS.setNoteLinks(noteId, noteArr);

      // Check if exists in other notes
      const allNotes = LS.getIndex();
      let existsElsewhere = false;

      for (let note of allNotes) {
        if (note.name === noteId) continue;

        const links = LS.getNoteLinks(note.name);
        if (links.some(l => l.url === item.url)) {
          existsElsewhere = true;
          break;
        }
      }

      // Remove from -All links- if unused
      if (!existsElsewhere) {
        let globalArr = LS.getGlobalLinks();
        globalArr = globalArr.filter(l => l.url !== item.url);
        LS.setGlobalLinks(globalArr);
      }

    } else {
      // Remove from -All links-
      let globalArr = LS.getGlobalLinks();
      globalArr = globalArr.filter(x => x.url !== item.url);
      LS.setGlobalLinks(globalArr);

      // Also remove from ALL NOTES
      const allNotes = LS.getIndex();

      for (let note of allNotes) {
        let links = LS.getNoteLinks(note.name);
        links = links.filter(l => l.url !== item.url);
        LS.setNoteLinks(note.name, links);
      }
    }

    renderLinks();
  };

  return wrap;
}

function updateBookmarkCardSizing(){
  if (!el.noteCard || !el.globalCard || !el.noteLinks || !el.noteCardBody) return;

  const noteCount = LS.getNoteLinks(state.current || "__none__").length;

  if (!state.current || noteCount === 0){
    el.noteCard.style.flex = "0 0 auto";
    el.noteCard.style.height = "auto";
    el.noteCard.style.maxHeight = "180px";

    el.globalCard.style.flex = "1 1 auto";
    el.globalCard.style.height = "auto";
    el.globalCard.style.maxHeight = "none";

    el.noteCardBody.style.overflowY = "hidden";
    return;
  }

  const rightBody = el.noteCard.parentElement;
  if (!rightBody) return;

  const bodyHeight = rightBody.clientHeight;
  const gap = 14;
  const maxTopHeight = Math.floor((bodyHeight - gap) / 2);

  el.noteCard.style.flex = "0 0 auto";
  el.noteCard.style.height = "auto";
  el.noteCard.style.maxHeight = "none";

  const naturalHeight = el.noteCard.scrollHeight;
  const finalTopHeight = Math.min(naturalHeight, maxTopHeight);

  el.noteCard.style.height = finalTopHeight + "px";
  el.noteCard.style.maxHeight = maxTopHeight + "px";
  el.noteCard.style.flex = "0 0 auto";

  el.globalCard.style.flex = "1 1 auto";
  el.globalCard.style.height = "auto";
  el.globalCard.style.maxHeight = "none";

  requestAnimationFrame(() => {
    const bodyStyle = getComputedStyle(el.noteCardBody);
    const padTop = parseFloat(bodyStyle.paddingTop) || 0;
    const padBottom = parseFloat(bodyStyle.paddingBottom) || 0;
    const available = el.noteCardBody.clientHeight - padTop - padBottom;

    if (el.noteLinks.scrollHeight > available + 2){
      el.noteCardBody.style.overflowY = "auto";
    } else {
      el.noteCardBody.style.overflowY = "hidden";
    }
  });
}

function renderLinks(){
  const q = (el.bookmarkSearch?.value || "").trim().toLowerCase();

  const noteSort = el.noteSort ? el.noteSort.value : "newest";

  const noteLinks = LS.getNoteLinks(state.current || "__none__")
    .filter(item => {
      if (!q) return true;
      const label = (item.title || item.url || "").toLowerCase();
      const url = (item.url || "").toLowerCase();
      return label.includes(q) || url.includes(q);
    })
    .slice()
    .sort((a,b)=> noteSort === "newest" ? (b.ts - a.ts) : (a.ts - b.ts));

  el.noteLinks.innerHTML = "";

  if (!state.current){
    el.noteLinksEmpty.textContent = "No links for this note yet.";
    el.noteLinksEmpty.style.display = "block";
  } else if (noteLinks.length === 0){
    el.noteLinksEmpty.textContent = q
      ? "No matching links in this note."
      : "No links for this note yet.";
    el.noteLinksEmpty.style.display = "block";
  } else {
    el.noteLinksEmpty.style.display = "none";
  }

  for (const item of noteLinks){
    el.noteLinks.appendChild(linkRow(item, { note: true }));
  }

  const sort = el.globalSort.value;
  const all = LS.getGlobalLinks()
    .filter(item => {
      if (!q) return true;
      const label = (item.title || item.url || "").toLowerCase();
      const url = (item.url || "").toLowerCase();
      return label.includes(q) || url.includes(q);
    })
    .slice()
    .sort((a, b) =>
      sort === "newest" ? (b.ts - a.ts) : (a.ts - b.ts)
    );

  el.globalLinks.innerHTML = "";

  if (all.length === 0){
    el.globalLinksEmpty.textContent = q
      ? "No matching global links."
      : "No global links yet.";
    el.globalLinksEmpty.style.display = "block";
  } else {
    el.globalLinksEmpty.style.display = "none";
  }

  for (const item of all){
    el.globalLinks.appendChild(linkRow(item, { note: false }));
  }

  requestAnimationFrame(updateBookmarkCardSizing);
}

function renderNotesList(){
  const q = el.search.value.trim().toLowerCase();
  const items = state.notes.filter(n => !q || n.name.toLowerCase().includes(q));
  el.noteList.innerHTML = "";
  for (const n of items){
    const div = document.createElement("div");
    div.className = "note-item" + (state.current === n.name ? " active" : "");
    div.innerHTML = `
      <div class="note-dot"></div>
      <div class="note-name">${escapeHtml(n.name)}</div>
      <div class="note-meta">${new Date(n.updatedAt).toLocaleDateString()}</div>
    `;
    div.onclick = () => {
      if (state.current === n.name) return;
      openNote(n.name);
    };
    el.noteList.appendChild(div);
  }
}

function setHeader(){
  if (!state.current){
    el.currentTitle.textContent = "No note selected";
    el.currentMeta.textContent = "";

    el.editor.disabled = true;
    el.editorBox.style.opacity = "0.5";
    el.editorBox.style.pointerEvents = "none";

    el.editor.placeholder = "Select or create a note to start writing...";

    return;
  }

  const meta = state.notes.find(n=>n.name===state.current);
  el.currentTitle.textContent = state.current;
  el.currentMeta.textContent = meta ? ("Updated: " + new Date(meta.updatedAt).toLocaleString()) : "";

  el.editor.disabled = false;
  el.editorBox.style.opacity = "1";
  el.editorBox.style.pointerEvents = "auto";

  el.editor.placeholder = "Type here...";
}

async function refreshNotes(){
  if (hasWorkspace()) state.notes = await FS.listNotes(state.wsHandle);
  else state.notes = LS.getIndex().map(n=>({...n, source:"ls"})).sort((a,b)=>b.updatedAt-a.updatedAt);
  renderNotesList();
  setHeader();
  setWorkspaceLabel();
}

async function flushSave(force){
  if (!state.current) return;

  const content = el.editor.value;
  const fp = content.length + "|" + content.slice(0,40) + "|" + content.slice(-40);

  if (state._lastFp === fp){
    el.saveState.textContent = "idle";
    return;
  }

  state._lastFp = fp;

  try{
    el.saveState.textContent = "saving…";

    if (hasWorkspace()){
      if (!await FS.verifyPerm(state.wsHandle, true)){
        el.saveState.textContent = "no permission";
        return;
      }

      await FS.writeNote(state.wsHandle, state.current, content);
    } else {
      LS.setNote(state.current, content);
    }

    const meta = state.notes.find(n => n.name === state.current);
    if (meta) meta.updatedAt = Date.now();

    state.notes.sort((a,b)=>b.updatedAt-a.updatedAt || a.name.localeCompare(b.name));

    el.saveState.textContent = "saved";
    setHeader();
    renderNotesList();
    renderPreview();

  } catch (e){
    console.error(e);
    el.saveState.textContent = "error";
  }
}

function scheduleSave(){
  if (!state.current) return;

  el.saveState.textContent = "pending";

  const meta = state.notes.find(n => n.name === state.current);
  if (meta){
    meta.updatedAt = Date.now();
    state.notes.sort((a,b)=>b.updatedAt-a.updatedAt || a.name.localeCompare(b.name));
    renderNotesList();
    setHeader();
  }

  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flushSave(false), state.autosaveMs);
}

async function openNote(name){
  if (state.current === name) return;
  await flushSave(true);
  state.current = name;
  setHeader();

  let content = "";
  if (hasWorkspace()){
    if (!await FS.verifyPerm(state.wsHandle, false)){
      alert("Folder permission not granted.");
      return;
    }
    content = await FS.readNote(state.wsHandle, name);
  } else {
    content = LS.getNote(name);
  }

  el.editor.value = content;
  state._lastFp = content.length + "|" + content.slice(0,40) + "|" + content.slice(-40);
  renderPreview();
  renderLinks();
  renderNotesList();
}

async function createNote(){
  let rawName = el.newName.value.trim();

  if (!rawName){
    rawName = (prompt("Enter note name:", "") || "").trim();
  }

  const name = sanitizeName(rawName);
  if (!name) return alert("Error: Invalid note name.");

  el.newName.value = "";

  if (hasWorkspace()){
    if (!await FS.verifyPerm(state.wsHandle, true)){
      alert("Folder permission not granted.");
      return;
    }

    const exists = await FS.exists(state.wsHandle, name);
    if (exists) return alert(`A note named "${name}" already exists.`);

    await FS.writeNote(state.wsHandle, name, "");
  } else {
    const exists = LS.getIndex().some(n => n.name === name);
    if (exists) return alert(`A note named "${name}" already exists.`);

    LS.setNote(name, "");
  }

  await refreshNotes();
  await openNote(name);
  el.editor.focus();
}

async function deleteCurrent(){
  if (!state.current) return;
  if (!(await showConfirm(`Delete note "${state.current}"? This cannot be undone.`))) return;

  if (hasWorkspace()){
    if (!await FS.verifyPerm(state.wsHandle, true)){
      alert("Folder permission not granted.");
      return;
    }
    await FS.deleteNote(state.wsHandle, state.current);
  } else {
    LS.deleteNote(state.current);
  }

  state.current = null;

  await refreshNotes();

  if (state.notes.length){
    await openNote(state.notes[0].name);
    el.editor.disabled = false;
    el.editor.style.opacity = "1";
  } else {
    el.editor.value = "";
    renderPreview();
    setHeader();
    renderLinks();

    el.editor.disabled = true;
    el.editor.style.opacity = "0.6"; 
  }
}

async function renameCurrentNote(){
  if (!state.current) return;

  const oldName = state.current;
  const raw = prompt("Rename note:", oldName);
  const newName = sanitizeName(raw);

  if (!newName || newName === oldName) return;

  if (hasWorkspace()){
    if (!await FS.verifyPerm(state.wsHandle, true)){
      alert("Folder permission not granted.");
      return;
    }

    const exists = await FS.exists(state.wsHandle, newName);
    if (exists){
      alert("A note with this name already exists.");
      return;
    }

    const content = await FS.readNote(state.wsHandle, oldName);
    await FS.writeNote(state.wsHandle, newName, content);
    await FS.deleteNote(state.wsHandle, oldName);

  } else {
    const exists = LS.getIndex().some(n => n.name === newName);
    if (exists){
      alert("A note with this name already exists.");
      return;
    }

    const content = LS.getNote(oldName);
    const links = LS.getNoteLinks(oldName);

    LS.setNote(newName, content);
    LS.setNoteLinks(newName, links);
    LS.deleteNote(oldName);
  }

  state.current = newName;

  await refreshNotes();
  await openNote(newName);
}

async function openWorkspace(){
  if (!FS.supported){
    alert("File System Access API not available. Using localStorage + export/import instead.");
    state.wsHandle = null;
    setWorkspaceLabel();
    await refreshNotes();
    return;
  }

  try{
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });

    if (!await FS.verifyPerm(dir, true)){
      alert("Folder permission not granted.");
      return;
    }

    const workspaceNotes = await FS.listNotes(dir);
    const localNotes = getAllLocalNotesForMigration();

    if (workspaceNotes.length > 0){
      await flushSave(true);

      state.wsHandle = dir;
      await idb.set("wsHandle", dir);
      setWorkspaceLabel();

      await refreshNotes();
      if (state.notes.length) await openNote(state.notes[0].name);
      else {
        state.current = null;
        el.editor.value = "";
        renderPreview();
        setHeader();
        renderLinks();
      }
      return;
    }

    if (!localNotes.length){
      await flushSave(true);

      state.wsHandle = dir;
      await idb.set("wsHandle", dir);
      setWorkspaceLabel();

      await refreshNotes();
      if (state.notes.length) await openNote(state.notes[0].name);
      else {
        state.current = null;
        el.editor.value = "";
        renderPreview();
        setHeader();
        renderLinks();
      }
      return;
    }

    const shouldMigrate = await showConfirm(
      `This workspace folder is empty.\n` +
      `You have ${localNotes.length} local note(s).\n` +
      `Move them into this workspace as real .md files?\n` +
      `If you choose Cancel, the app will stay in browser storage.`
    );

    if (!shouldMigrate){
      state.wsHandle = null;
      await idb.set("wsHandle", null);
      setWorkspaceLabel();

      await refreshNotes();

      if (state.notes.length){
        await openNote(state.notes[0].name);
      } else {
        state.current = null;
        el.editor.value = "";
        renderPreview();
        setHeader();
        renderLinks();
      }

      alert("Workspace was not opened. Still using browser storage.");
      return;
    }

    await flushSave(true);

    const result = await migrateLocalNotesToWorkspace(dir);

    state.wsHandle = dir;
    await idb.set("wsHandle", dir);
    setWorkspaceLabel();

    await refreshNotes();
    if (state.notes.length) await openNote(state.notes[0].name);
    else {
      state.current = null;
      el.editor.value = "";
      renderPreview();
      setHeader();
      renderLinks();
    }

    alert(
      `Migration complete.\n` +
      `Moved: ${result.moved}\n` +
      `Skipped: ${result.skipped}\n` +
      `Your original localStorage notes were left untouched for safety.`
    );
  } catch {}
}

async function disconnectWorkspace(){
  if (!hasWorkspace()) return;

  await flushSave(true);

  if (!(await showConfirm("Disconnect the current workspace and switch back to browser localStorage?"))){
    return;
  }

  state.wsHandle = null;
  await idb.set("wsHandle", null);
  setWorkspaceLabel();

  await refreshNotes();

  if (state.notes.length){
    await openNote(state.notes[0].name);
  } else {
    state.current = null;
    el.editor.value = "";
    renderPreview();
    setHeader();
    renderLinks();
  }
}

async function tryRestoreWorkspace(){
  if (!FS.supported) return;
  const dir = await idb.get("wsHandle");
  if (!dir) return;
  try{
    if (!await FS.verifyPerm(dir, true)) return;
    state.wsHandle = dir;
    setWorkspaceLabel();
    await refreshNotes();
    if (state.notes.length) await openNote(state.notes[0].name);
  } catch {}
}

function isYouTubeUrl(url){
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

async function fetchYouTubeTitle(url){
  try{
    const endpoint =
      "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent(url);

    const res = await fetch(endpoint, {
      method: "GET"
    });

    if (!res.ok) return null;

    const data = await res.json();
    return (data && data.title) ? String(data.title).trim() : null;
  } catch (err){
    console.warn("Could not fetch YouTube title:", err);
    return null;
  }
}

async function promptLink(){
  const url = prompt("Paste link / URL:", "");
  if (!url) return null;

  const clean = url.trim();
  if (!/^https?:\/\/\S+/i.test(clean)){
    alert("Please provide a valid http:// or https:// link.");
    return null;
  }

  let title = "";

  if (isYouTubeUrl(clean)) {
    title = await fetchYouTubeTitle(clean) || "";
    if (!title) {
      title = (prompt("Bookmark name (optional):", "") || "").trim();
    }
  } else {
    title = (prompt("Bookmark name:", "") || "").trim();
    if (!title) {
      alert("Bookmark name is required for non-YouTube links.");
      return null;
    }
  }

  return {
    url: clean,
    title,
    ts: Date.now()
  };
}

async function addNoteLink(){
  if (!state.current) return alert("Select a note first.");

  const item = await promptLink();
  if (!item) return;

  // Add to -Links-
  const noteArr = LS.getNoteLinks(state.current);
  noteArr.push(item);
  LS.setNoteLinks(state.current, noteArr);

  // ALSO add to -All links- (no duplicates)
  let globalArr = LS.getGlobalLinks();
  const exists = globalArr.some(x => x.url === item.url);

  if (!exists) {
    globalArr.push(item);
    LS.setGlobalLinks(globalArr);
  }

  renderLinks();
}

async function addGlobalLink(){
  const item = await promptLink();
  if (!item) return;

  const arr = LS.getGlobalLinks();
  arr.push(item);
  LS.setGlobalLinks(arr);
  renderLinks();
}

async function scanCurrentNote(){
  if (!state.current) return alert("Select a note first.");

  const links = extractLinks(el.editor.value);
  if (!links.length) return alert("No links found in this note.");

  const arr = LS.getNoteLinks(state.current);
  const g = LS.getGlobalLinks();

  let addedNote = 0;
  let addedGlobal = 0;

  for (const url of links){
    const existsInNote = arr.some(x => x.url === url);
    const existsInGlobal = g.some(x => x.url === url);

    if (existsInNote && existsInGlobal) continue;

    let title = "";
    if (isYouTubeUrl(url)) {
      title = await fetchYouTubeTitle(url) || "";
    }

    const item = {
      url,
      title,
      ts: Date.now()
    };

    if (!existsInNote){
      arr.push(item);
      addedNote++;
    }

    if (!existsInGlobal){
      g.push(item);
      addedGlobal++;
    }
  }

  LS.setNoteLinks(state.current, arr);
  LS.setGlobalLinks(g);

  renderLinks();

  alert(
    `Scan complete.\n` +
    `Added ${addedNote} new link(s) to this note.\n` +
    `Added ${addedGlobal} new link(s) to the global list.`
  );
}

async function exportBackup(){
  const notes = await getAllCurrentNotesForBackup();
  const payload = {
    version: 2,
    exportedAt: Date.now(),
    source: hasWorkspace() ? "workspace" : "localStorage",
    notes,
    globalLinks: LS.getGlobalLinks()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "offline_notepad_backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importBackup(file){
  const text = await file.text();
  let payload;

  try{
    payload = JSON.parse(text);
  } catch {
    return alert("Invalid JSON.");
  }

  if (!payload || !Array.isArray(payload.notes)){
    return alert("Backup format not recognized.");
  }

  if (hasWorkspace()){
    if (!await FS.verifyPerm(state.wsHandle, true)){
      return alert("Folder permission not granted.");
    }

    let written = 0;
    let skipped = 0;

    const namesToSkip = [];

    // Pass 1: find existing note names
    for (const n of payload.notes){
      const safeName = sanitizeName(n.name);
      if (!safeName) continue;

      const exists = await FS.exists(state.wsHandle, safeName);
      if (exists){
        namesToSkip.push(safeName);
      }
    }

    // Show skip warning before importing
    if (namesToSkip.length){
      const shouldContinue = await showConfirm(
        "Some notes already exist in this workspace and will be skipped:",
        [...new Set(namesToSkip)]
      );

      if (!shouldContinue) return;
    }

    // Pass 2: import only non-existing notes
    for (const n of payload.notes){
      const safeName = sanitizeName(n.name);
      if (!safeName){
        skipped++;
        continue;
      }

      const exists = await FS.exists(state.wsHandle, safeName);
      if (exists){
        skipped++;
        continue;
      }

      await FS.writeNote(state.wsHandle, safeName, n.content || "");
      if (Array.isArray(n.links)) LS.setNoteLinks(safeName, n.links);
      written++;
    }

    if (Array.isArray(payload.globalLinks)) LS.setGlobalLinks(payload.globalLinks);

    await refreshNotes();
    if (state.notes.length) await openNote(state.notes[0].name);

    alert(
      `Imported into workspace.\n` +
      `Created .md files: ${written}\n` +
      `Skipped existing names: ${skipped}\n` +
      `Existing files were left unchanged.`
    );
    return;
  }

  const existingNames = LS.getIndex().map(n => n.name);

  const namesToOverwrite = [...new Set(
    payload.notes
      .map(n => sanitizeName(n.name))
      .filter(name => name && existingNames.includes(name))
  )];

  if (namesToOverwrite.length){
    const shouldOverwrite = await showConfirm(
      "Importing this backup will overwrite these existing notes:",
      namesToOverwrite
    );

    if (!shouldOverwrite) return;
  }

  for (const n of payload.notes){
    const safeName = sanitizeName(n.name);
    if (!safeName) continue;

    LS.setNote(safeName, n.content || "");
    if (Array.isArray(n.links)) LS.setNoteLinks(safeName, n.links);
  }

  if (Array.isArray(payload.globalLinks)) LS.setGlobalLinks(payload.globalLinks);

  await refreshNotes();
  if (state.notes.length) await openNote(state.notes[0].name);

  alert("Imported into localStorage.");
}

function showConfirm(message, listItems=[]){
  return new Promise(resolve => {

    const backdrop = document.getElementById("popupBackdrop");
    const box = document.getElementById("popupBox");
    const msg = document.getElementById("popupMessage");
    const list = document.getElementById("popupList");

    const ok = document.getElementById("popupConfirm");
    const cancel = document.getElementById("popupCancel");

    msg.textContent = message;

    if (listItems.length){
      list.style.display = "block";
      list.innerHTML = listItems.map(n => `- ${escapeHtml(n)}`).join("<br>");
    } else {
      list.style.display = "none";
      list.innerHTML = "";
    }

    backdrop.style.display = "block";
    box.style.display = "flex";

    const close = (result) => {
      backdrop.style.display = "none";
      box.style.display = "none";
      ok.onclick = null;
      cancel.onclick = null;
      resolve(result);
    };

    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    backdrop.onclick = () => close(false);
  });
}

el.btnOpenWs.onclick = openWorkspace;
el.btnDisconnectWs.onclick = disconnectWorkspace;
el.btnNew.onclick = createNote;
el.btnDelete.onclick = deleteCurrent;
el.btnRename.onclick = renameCurrentNote;


el.editor.addEventListener("input", () => { scheduleSave(); renderPreview(); });
el.editor.addEventListener("paste", () => setTimeout(() => { scheduleSave(); renderPreview(); }, 0));

el.editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();

    const start = el.editor.selectionStart;
    const end = el.editor.selectionEnd;
    const value = el.editor.value;

    el.editor.value =
      value.slice(0, start) + "\t" + value.slice(end);

    el.editor.selectionStart = el.editor.selectionEnd = start + 1;

    scheduleSave();
    renderPreview();
  }
});

el.search.addEventListener("input", renderNotesList);

window.addEventListener("resize", updateBookmarkCardSizing);

el.btnToggleRight.onclick = () => {
  el.rightPanel.classList.toggle("collapsed");
};

el.btnTogglePreview.onclick = () => {
  const isPreview = el.editorBox.classList.toggle("preview-mode");
  el.btnTogglePreview.textContent = isPreview ? "Edit" : "Preview";
  renderPreview();
};

el.btnAddNote.onclick = addNoteLink;
el.btnAddGlobal.onclick = addGlobalLink;
el.btnScan.onclick = scanCurrentNote;


console.log("btnExportMenu:", el.btnExportMenu);
console.log("exportMenu:", el.exportMenu);
if (el.btnExportMenu && el.exportMenu) {
  el.btnExportMenu.onclick = (e) => {
    e.stopPropagation();
    el.exportMenu.classList.toggle("show");
  };

  document.addEventListener("click", (e) => {
    const box = document.getElementById("exportDropdown");
    if (box && !box.contains(e.target)) {
      el.exportMenu.classList.remove("show");
    }
  });
}

if (el.btnTxt) {
  el.btnTxt.onclick = () => {
    exportTxt();
    el.exportMenu?.classList.remove("show");
  };
}

if (el.btnPdf) {
  el.btnPdf.onclick = () => {
    exportPdf();
    el.exportMenu?.classList.remove("show");
  };
}

el.globalSort.onchange = renderLinks;
if (el.noteSort) el.noteSort.onchange = renderLinks;
if (el.bookmarkSearch) el.bookmarkSearch.addEventListener("input", renderLinks);

el.btnExport.onclick = exportBackup;
el.fileImport.onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  await importBackup(f);
  e.target.value = "";
};

window.addEventListener("keydown", async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s"){
    e.preventDefault();
    await flushSave(true);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p"){
    e.preventDefault();
    el.btnTogglePreview.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b"){
    e.preventDefault();
    el.btnToggleRight.click();
  }
});

(async function init(){
  setWorkspaceLabel();
  await tryRestoreWorkspace();

  if (!hasWorkspace()){
    await refreshNotes();

    if (state.notes.length === 0){
      LS.setNote(
        "Welcome",
        "# Welcome! This is your offline notepad.\n" +
		"## What's supported:\n" +
		"- Headings (#, ##, ###)\n" +
		"- Lists (-, *)\n" +
		"- Blockquotes (>)\n" +
		"- Inline code (`code`)\n" +
		"- Code blocks (```lang)\n" +
		"- Links and plain URLs\n" +
		"- Horizontal rule (---)\n\n" +

        "## Important\n" +
        "Your notes are currently stored in this browser.\n" +
        "They may be lost if browser data is cleared.\n" +

        "For important notes, use a **workspace folder**.\n" +
        "Example setup:\n" +
        "- Create `_MyWorkspaces` folder in Documents\n" +
        "- Inside it create a folder naming your workspace, for eg. `Workspace1`\n" +
        "- Choose that folder using the **Open workspace folder** button from the top bar\n\n" +

        "Workspace requires a Chrome-based browser.\n" +
        "Workspace storage is safer, but you may need to select the folder everytime this notepad is reopened.\n" +

		"Tip: You can set this `index.html` as a desktop shortcut for easier access.\n" +  
        "Start exploring by trying the **Preview** button in the top-right corner. Happy noting!"
      );
      await refreshNotes();
    }
    if (state.notes.length) await openNote(state.notes[0].name);
  }

  renderLinks();
})();