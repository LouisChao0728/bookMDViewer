import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import frontMatterPlugin from "markdown-it-front-matter";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// hljs theme CSS as strings, so HTML export can be fully self-contained.
import hljsLightCss from "highlight.js/styles/github.css?inline";
import hljsDarkCss from "highlight.js/styles/github-dark.css?inline";

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

// Apply the matching highlight.js theme to the live app.
{
  const style = document.createElement("style");
  style.textContent = prefersDark ? hljsDarkCss : hljsLightCss;
  document.head.appendChild(style);
}

let lastFrontMatter = "";

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    // Leave mermaid blocks untouched so we can render them lazily later.
    if (lang === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(str)}</pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${
          hljs.highlight(str, { language: lang }).value
        }</code></pre>`;
      } catch {
        /* fall through to plain escaping */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
})
  .use(taskLists, { enabled: true, label: true })
  .use(frontMatterPlugin, (fm: string) => {
    lastFrontMatter = fm;
  });

// Disable setext headings so `text` immediately above `---` / `===` stays a
// paragraph + horizontal rule (the usual intent) instead of becoming a heading
// that pollutes the outline.
md.disable("lheading");

// ---------- Source-line mapping ----------
// markdown-it records [line_begin, line_end] on block tokens. Copying that onto
// the rendered element gives the preview anchors that point back at exact source
// lines, which is what lets the two panes line up: a heading costs one line in
// the editor but a whole band of height in the preview, so any whole-document
// ratio between them drifts further the longer the document gets.
md.core.ruler.push("source_line", (state) => {
  for (const token of state.tokens) {
    // Closing tokens carry no map; opening and self-closing block tokens do.
    // Nested blocks are anchored too - one anchor per top-level block leaves
    // long lists, tables and blockquotes badly under-sampled.
    if (token.map && token.nesting >= 0) {
      token.attrSet("data-line", String(token.map[0]));
    }
  }
});

// The `highlight` callback above returns a finished <pre …> string, which
// markdown-it emits verbatim - token attributes never reach it. Re-inject the
// anchor into the opening tag so fenced code and mermaid stay mappable.
const renderFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const html = renderFence(tokens, idx, options, env, self);
  const line = tokens[idx].map?.[0];
  if (line == null) return html;
  return html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)/, `$1 data-line="${line}"`);
};

const content = document.getElementById("content") as HTMLElement;
const toc = document.getElementById("toc") as HTMLElement;
const layout = document.getElementById("layout") as HTMLElement;
const tocToggle = document.getElementById("toc-toggle") as HTMLButtonElement;
const editor = document.getElementById("editor") as HTMLTextAreaElement;
const editorGutter = document.getElementById("editor-gutter") as HTMLElement;
const gutterSizer = document.getElementById("gutter-sizer") as HTMLElement;
const gutterInner = document.getElementById("gutter-inner") as HTMLElement;
const editorMirror = document.getElementById("editor-mirror") as HTMLElement;
const editToggle = document.getElementById("edit-toggle") as HTMLButtonElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const fontInc = document.getElementById("font-inc") as HTMLButtonElement;
const fontDec = document.getElementById("font-dec") as HTMLButtonElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const filesBtn = document.getElementById("files-btn") as HTMLButtonElement;
const filesPanel = document.getElementById("files") as HTMLElement;
const findBar = document.getElementById("find-bar") as HTMLElement;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findCount = document.getElementById("find-count") as HTMLElement;
const closeModal = document.getElementById("close-modal") as HTMLElement;
const closeDocBtn = document.getElementById("close-doc-btn") as HTMLButtonElement;
const toastEl = document.getElementById("toast") as HTMLElement;
const appWindow = getCurrentWindow();
const EMPTY_STATE_HTML = `<div class="empty-state">
  <h1>Markdown Viewer</h1>
  <p>Drag a <code>.md</code> file here, or <a id="empty-open" href="#">open one</a>.</p>
  <p class="app-version"><a id="about-open" href="#">關於 / About</a></p>
  <div id="recent-list"></div>
</div>`;
let closeAction: "window" | "doc" | "switch" = "window";
let pendingSwitchPath: string | null = null;
let currentPath: string | null = null;
let currentText = "";
let editMode = false;
let dirty = false;
let suppressReloadUntil = 0;
let mermaidLoaded = false;
let spy: IntersectionObserver | null = null;

// Build the left-hand outline from the rendered headings.
function buildToc(): void {
  spy?.disconnect();
  toc.innerHTML = "";
  const headings = Array.from(
    content.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  if (headings.length < 2) {
    layout.classList.remove("has-toc");
    return;
  }
  layout.classList.add("has-toc");

  const links = new Map<string, HTMLAnchorElement>();
  headings.forEach((h, i) => {
    h.id = `h-${i}`;
    const a = document.createElement("a");
    a.href = `#h-${i}`;
    a.textContent = h.textContent ?? "";
    a.className = `toc-link toc-${h.tagName.toLowerCase()}`;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      // Expand any collapsed <details> the heading lives inside, otherwise it's
      // hidden and scrollIntoView can't reach it (e.g. unclosed <details>).
      let p: HTMLElement | null = h.parentElement;
      while (p && p !== content) {
        if (p instanceof HTMLDetailsElement) p.open = true;
        p = p.parentElement;
      }
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    toc.appendChild(a);
    links.set(h.id, a);
  });

  // Scroll-spy: highlight the heading currently near the top.
  spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          toc.querySelector(".active")?.classList.remove("active");
          const link = links.get(e.target.id);
          link?.classList.add("active");
          link?.scrollIntoView({ block: "nearest" });
        }
      }
    },
    { root: content, rootMargin: "0px 0px -80% 0px", threshold: 0 },
  );
  headings.forEach((h) => spy!.observe(h));
}

// Resolve relative-path images against the open file's folder via the asset protocol.
function resolveImages(): void {
  if (!currentPath) return;
  const dir = currentPath.replace(/[\\/][^\\/]*$/, "");
  content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    // Skip absolute URLs (http:, data:, asset:, file:, …) and protocol-relative.
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return;
    const abs = `${dir}/${src}`.replace(/\\/g, "/");
    img.src = convertFileSrc(abs);
  });
}

// Obsidian-style copy button on hover for fenced code blocks (lucide "copy").
const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

function addCopyButtons(): void {
  content.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
    // Mermaid blocks render to SVG and already have the zoom lightbox.
    if (pre.classList.contains("mermaid")) return;
    const btn = document.createElement("button");
    btn.className = "copy-code-button";
    btn.type = "button";
    btn.title = "複製程式碼";
    btn.innerHTML = COPY_ICON_SVG;
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      void copyToClipboard(code?.innerText ?? pre.innerText).then(() =>
        toast("已複製程式碼"),
      );
    });
    pre.appendChild(btn);
  });
}

function formatFmValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function buildFmCard(data: Record<string, unknown>): HTMLElement | null {
  const card = document.createElement("div");
  card.className = "fm-card";
  const used = new Set<string>();

  if (typeof data.title === "string" && data.title.trim()) {
    const t = document.createElement("div");
    t.className = "fm-title";
    t.textContent = data.title;
    card.appendChild(t);
  }
  used.add("title");

  if (typeof data.description === "string" && data.description.trim()) {
    const d = document.createElement("div");
    d.className = "fm-desc";
    d.textContent = data.description;
    card.appendChild(d);
  }
  used.add("description");

  const meta = document.createElement("div");
  meta.className = "fm-meta";
  const dateVal = data.pubDate ?? data.date ?? data.published;
  ["pubDate", "date", "published"].forEach((k) => used.add(k));
  if (dateVal) {
    const s = document.createElement("span");
    s.className = "fm-chip fm-date";
    s.textContent = `📅 ${formatFmValue(dateVal)}`;
    meta.appendChild(s);
  }
  used.add("tags");
  if (Array.isArray(data.tags)) {
    data.tags.forEach((tag) => {
      const c = document.createElement("span");
      c.className = "fm-chip fm-tag";
      c.textContent = `#${String(tag)}`;
      meta.appendChild(c);
    });
  }
  used.add("draft");
  if (data.draft === true) {
    const b = document.createElement("span");
    b.className = "fm-chip fm-badge";
    b.textContent = "Draft";
    meta.appendChild(b);
  }
  if (meta.childNodes.length) card.appendChild(meta);

  const rest = Object.keys(data).filter((k) => {
    if (used.has(k)) return false;
    const v = data[k];
    if (v === null || v === "" || v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
  if (rest.length) {
    const dl = document.createElement("dl");
    dl.className = "fm-dl";
    rest.forEach((k) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = formatFmValue(data[k]);
      dl.append(dt, dd);
    });
    card.appendChild(dl);
  }

  return card.childNodes.length ? card : null;
}

// Parse YAML front matter (lazy-loaded) and prepend a metadata card.
async function renderFrontMatter(): Promise<void> {
  if (!lastFrontMatter.trim()) return;
  try {
    const yaml = await import("js-yaml");
    const data = yaml.load(lastFrontMatter);
    if (!data || typeof data !== "object") return;
    const card = buildFmCard(data as Record<string, unknown>);
    if (card) content.prepend(card);
  } catch (e) {
    console.error("front matter parse failed", e);
  }
}

async function renderMarkdown(
  text: string,
  preserveScroll = false,
): Promise<void> {
  const scrollTop = content.scrollTop;
  lastFrontMatter = "";
  // Sanitize rendered HTML to neutralise scripts / event handlers in untrusted docs.
  content.innerHTML = DOMPurify.sanitize(md.render(text), {
    ADD_TAGS: ["pre"],
    ADD_ATTR: ["class", "data-line"],
  });
  anchors = [];
  await renderFrontMatter();
  resolveImages();
  addCopyButtons();
  buildToc();

  // Lazily pull in mermaid only when a diagram is actually present.
  const diagrams = content.querySelectorAll<HTMLElement>("pre.mermaid");
  if (diagrams.length > 0) {
    const mermaid = (await import("mermaid")).default;
    if (!mermaidLoaded) {
      mermaid.initialize({
        startOnLoad: false,
        theme: prefersDark ? "dark" : "default",
        securityLevel: "strict",
      });
      mermaidLoaded = true;
    }
    try {
      await mermaid.run({ nodes: Array.from(diagrams) });
    } catch (e) {
      console.error("mermaid render failed", e);
    }
    // Click a rendered diagram to open it in the zoom/pan lightbox.
    diagrams.forEach((pre) => {
      const svg = pre.querySelector("svg");
      if (!svg) return;
      pre.classList.add("mermaid-zoomable");
      pre.addEventListener("click", () => openDiagram(svg));
    });
  }

  // New documents start at the top; only hot-reload / live-edit keep position.
  content.scrollTop = preserveScroll ? scrollTop : 0;

  // Re-rendering threw away the DOM the find ranges pointed at.
  refreshFindHighlights();
}

function setTitle(): void {
  const name = currentPath?.split(/[\\/]/).pop() ?? "Markdown Viewer";
  document.title = `${dirty ? "● " : ""}${name} — Markdown Viewer`;
  saveBtn.hidden = !editMode;
  saveBtn.disabled = !dirty;
  saveBtn.textContent = dirty ? "💾 Save*" : "💾 Saved";
  closeDocBtn.hidden = !currentPath;
}

// Close the current document and return to the home / empty-state screen.
function goHome(): void {
  currentPath = null;
  currentText = "";
  dirty = false;
  if (editMode) {
    editMode = false;
    layout.classList.remove("mode-edit");
    editToggle.textContent = "✎ Edit";
  }
  content.innerHTML = EMPTY_STATE_HTML;
  buildToc();
  renderRecents();
  if (filesOpen) void renderFiles(null);
  setTitle();
}

async function openFile(
  path: string,
  watch = true,
  preserveScroll = false,
): Promise<void> {
  try {
    const text = await invoke<string>("read_md", { path });
    currentPath = path;
    currentText = text;
    dirty = false;
    addRecent(path);
    if (editMode) {
      editor.value = text;
      renderGutter();
    }
    setTitle();
    await renderMarkdown(text, preserveScroll);
    if (watch) {
      await invoke("watch_file", { path });
    }
    if (filesOpen) void renderFiles(dirOf(path));
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>${String(e)}</p></div>`;
    buildToc();
  }
}

// ---------- Editor line-number gutter (Notepad++ style) ----------
// The textarea soft-wraps, so one logical line can occupy several visual rows.
// The same text is laid out in a hidden mirror with identical metrics; each
// line's offsetTop there is where its number belongs in the gutter.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
let gutterFrame = 0;
// Pixel offset of every source line inside the textarea, measured on the mirror.
// The gutter needs these to place line numbers; scroll sync reuses them as the
// editor-side half of each anchor pair.
let lineTops: number[] = [];

function syncGutterScroll(): void {
  gutterInner.style.transform = `translateY(${-editor.scrollTop}px)`;
}

function renderGutter(): void {
  if (!editMode) return;
  const lines = editor.value.split("\n");

  // clientWidth excludes the textarea's scrollbar, so the mirror wraps identically.
  editorMirror.style.width = `${editor.clientWidth}px`;
  editorMirror.textContent = "";
  const rows = document.createDocumentFragment();
  for (const line of lines) {
    const row = document.createElement("div");
    // An empty div collapses to zero height; a zero-width space keeps the row.
    row.textContent = line === "" ? ZERO_WIDTH_SPACE : line;
    rows.appendChild(row);
  }
  editorMirror.appendChild(rows);

  const tops = Array.from(editorMirror.children, (el) => (el as HTMLElement).offsetTop);
  lineTops = tops;

  gutterSizer.textContent = String(lines.length);
  gutterInner.textContent = "";
  const numbers = document.createDocumentFragment();
  tops.forEach((top, i) => {
    const n = document.createElement("span");
    n.style.top = `${top}px`;
    n.textContent = String(i + 1);
    numbers.appendChild(n);
  });
  gutterInner.appendChild(numbers);

  syncGutterScroll();
}

function scheduleGutter(): void {
  if (gutterFrame) return;
  gutterFrame = requestAnimationFrame(() => {
    gutterFrame = 0;
    renderGutter();
  });
}

// Re-wrap on width changes (window resize, panels toggling).
new ResizeObserver(() => scheduleGutter()).observe(editorGutter.parentElement!);

// ---------- Edit mode + live preview ----------

let previewTimer: number | undefined;
function schedulePreview(): void {
  dirty = editor.value !== currentText;
  setTitle();
  scheduleGutter();
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(
    () => void renderMarkdown(editor.value, true),
    180,
  );
}

function setEditMode(on: boolean): void {
  editMode = on;
  layout.classList.toggle("mode-edit", on);
  editToggle.textContent = on ? "👁 Preview" : "✎ Edit";
  if (on) {
    editor.value = currentText;
    renderGutter();
    editor.focus();
  } else {
    // Leaving edit mode: render the latest source, keep position.
    void renderMarkdown(editor.value, true);
  }
  setTitle();
}

function toggleEdit(): void {
  setEditMode(!editMode);
}

async function save(): Promise<void> {
  if (!currentPath || !dirty) return;
  try {
    // Ignore the watcher event our own write is about to trigger.
    suppressReloadUntil = Date.now() + 1000;
    await invoke("write_md", { path: currentPath, content: editor.value });
    currentText = editor.value;
    dirty = false;
    setTitle();
  } catch (e) {
    console.error("save failed", e);
  }
}

editToggle.addEventListener("click", toggleEdit);
editor.addEventListener("input", schedulePreview);
saveBtn.addEventListener("click", () => void save());

// ---------- Tab / Shift+Tab indentation (Notepad++ style) ----------
const INDENT = "\t"; // indent unit; switch to "    " for 4-space indentation
const TAB_SIZE = 4; // leading spaces that count as one indent level on outdent

// Length of one indent level at a line start: one tab, or up to TAB_SIZE spaces.
function leadingIndentLen(s: string): number {
  if (s.startsWith("\t")) return 1;
  let n = 0;
  while (n < TAB_SIZE && s[n] === " ") n++;
  return n;
}

editor.addEventListener("keydown", (e) => {
  // Enter: the new line inherits the current line's leading indentation.
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing
  ) {
    const value = editor.value;
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    const lineStart = value.lastIndexOf("\n", selStart - 1) + 1;
    const nl = value.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? value.length : nl;
    const indent = value.slice(lineStart, lineEnd).match(/^[\t ]*/)?.[0] ?? "";
    e.preventDefault();
    const insert = "\n" + indent;
    editor.value = value.slice(0, selStart) + insert + value.slice(selEnd);
    editor.selectionStart = editor.selectionEnd = selStart + insert.length;
    schedulePreview();
    return;
  }

  if (e.key !== "Tab") return;
  e.preventDefault(); // stop Tab from moving focus out of the textarea

  const value = editor.value;
  const selStart = editor.selectionStart;
  const selEnd = editor.selectionEnd;
  const multiLine = value.slice(selStart, selEnd).includes("\n");
  const lineStart = value.lastIndexOf("\n", selStart - 1) + 1;

  if (!multiLine) {
    if (!e.shiftKey) {
      // Tab: insert one indent (replacing any single-line selection).
      const pos = selStart + INDENT.length;
      editor.value = value.slice(0, selStart) + INDENT + value.slice(selEnd);
      editor.selectionStart = editor.selectionEnd = pos;
    } else {
      // Shift+Tab: outdent the caret's line.
      const r = leadingIndentLen(value.slice(lineStart, lineStart + TAB_SIZE + 1));
      if (r > 0) {
        editor.value = value.slice(0, lineStart) + value.slice(lineStart + r);
        editor.selectionStart = editor.selectionEnd = Math.max(lineStart, selStart - r);
      }
    }
  } else {
    // Multi-line selection: indent / outdent every touched line.
    const blockStart = lineStart;
    let blockEnd = selEnd;
    if (selEnd > selStart && value[selEnd - 1] === "\n") blockEnd = selEnd - 1;
    const before = value.slice(0, blockStart);
    const after = value.slice(blockEnd);
    const lines = value.slice(blockStart, blockEnd).split("\n");

    let firstDelta = 0; // first-line char change, to fix selectionStart
    let totalDelta = 0; // total char change, to fix selectionEnd
    const newLines = lines.map((line, i) => {
      if (!e.shiftKey) {
        if (i === 0) firstDelta = INDENT.length;
        totalDelta += INDENT.length;
        return INDENT + line;
      }
      const r = leadingIndentLen(line);
      if (i === 0) firstDelta = -r;
      totalDelta -= r;
      return line.slice(r);
    });
    editor.value = before + newLines.join("\n") + after;
    editor.selectionStart = Math.max(blockStart, selStart + firstDelta);
    editor.selectionEnd = Math.max(editor.selectionStart, selEnd + totalDelta);
  }

  schedulePreview();
});

// ---------- Toast ----------
let toastTimer: number | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

// ---------- Export to standalone HTML (with TOC sidebar) ----------
const EXPORT_CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code-bg:#f6f8fa;--pre-bg:#eaeaea;--inline-code-fg:#eb5757;--inline-code-bg:rgba(135,131,120,.15);--accent:#0969da;--stripe:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#30363d;--code-bg:#161b22;--pre-bg:#242424;--inline-code-fg:#ff7a7a;--inline-code-bg:rgba(135,131,120,.25);--accent:#4493f8;--stripe:#161b22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;display:flex;align-items:flex-start}
.toc{flex:0 0 264px;width:264px;position:sticky;top:0;max-height:100vh;overflow:auto;padding:24px 12px 40px;border-right:1px solid var(--border);font-size:13.5px;line-height:1.5}
.toc a{display:block;padding:3px 10px;margin:1px 0;color:var(--muted);text-decoration:none;border-left:2px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc a:hover{color:var(--fg);background:var(--code-bg)}
.toc .l1{font-weight:600}.toc .l2{padding-left:22px}.toc .l3{padding-left:34px;font-size:13px}
.markdown-body{flex:1;min-width:0;max-width:860px;margin:0 auto;padding:32px 40px 80px;word-wrap:break-word}
.markdown-body h1,.markdown-body h2{border-bottom:1px solid var(--border);padding-bottom:.3em}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{margin-top:1.4em;margin-bottom:.6em;font-weight:600;line-height:1.25}
.markdown-body h1{font-size:2.25em;background-color:rgba(255,0,0,.12);padding:2px 6px}
.markdown-body h2{font-size:1.875em;background-color:rgba(255,200,0,.12);padding:2px 6px}
.markdown-body h3{font-size:1.375em;background-color:rgba(0,180,0,.06);padding:2px 6px}
.markdown-body h4{font-size:1.25em}
.markdown-body h5,.markdown-body h6{font-size:1.125em}
.markdown-body a{color:var(--accent);text-decoration:none}.markdown-body a:hover{text-decoration:underline}
.markdown-body code{color:var(--inline-code-fg);background:var(--inline-code-bg);padding:.2em .4em;border-radius:3px;font-size:85%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.markdown-body pre{position:relative;min-height:38px;background:var(--pre-bg);padding:12px 16px;border-radius:4px;white-space:pre-wrap;overflow:auto;line-height:1.45}
.markdown-body pre code{color:inherit;background:transparent;padding:0;font-size:.875em;font-family:ui-monospace,SFMono-Regular,"Cascadia Mono","Roboto Mono","DejaVu Sans Mono","Liberation Mono",Menlo,Monaco,Consolas,"Source Code Pro",monospace}
.markdown-body blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:4px solid var(--border)}
.markdown-body table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;margin:1em 0}
.markdown-body th,.markdown-body td{border:1px solid var(--border);padding:6px 13px}
.markdown-body tr:nth-child(2n){background:var(--stripe)}
.markdown-body img{max-width:100%}
.markdown-body hr{border:none;border-top:1px solid #ffb6c1;margin:1.6em 0}
.markdown-body .task-list-item{list-style:none}
.markdown-body .task-list-item input{margin:0 .4em .25em -1.4em}
.markdown-body pre.mermaid{background:transparent;text-align:center;padding:8px 0}
`;

function buildExportHtml(): string {
  // Clone so we don't mutate the live DOM.
  const article = content.cloneNode(true) as HTMLElement;
  // Copy buttons need the app's JS; drop them from the static export.
  article
    .querySelectorAll("button.copy-code-button")
    .forEach((b) => b.remove());
  // Source-line anchors only mean anything next to the editor; a static export
  // has nothing to line up with.
  article
    .querySelectorAll("[data-line]")
    .forEach((el) => el.removeAttribute("data-line"));
  const headings = Array.from(
    article.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  let tocHtml = "";
  if (headings.length >= 2) {
    const items = headings
      .map((h, i) => {
        if (!h.id) h.id = `h-${i}`;
        const level = h.tagName.toLowerCase().replace("h", "l");
        const label = (h.textContent ?? "").replace(/[<>&]/g, "");
        return `<a class="${level}" href="#${h.id}">${label}</a>`;
      })
      .join("\n");
    tocHtml = `<nav class="toc">\n${items}\n</nav>\n`;
  }

  const title = currentPath?.split(/[\\/]/).pop()?.replace(/\.(md|markdown)$/i, "") ?? "Document";
  const themeCss = prefersDark ? hljsDarkCss : hljsLightCss;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${EXPORT_CSS}</style>
<style>${themeCss}</style>
</head>
<body>
${tocHtml}<article class="markdown-body">
${article.innerHTML}
</article>
</body>
</html>`;
}

async function exportHtml(): Promise<void> {
  if (!currentPath) {
    toast("沒有開啟的檔案");
    return;
  }
  // Make sure the preview reflects the latest source (e.g. while editing).
  if (editMode) await renderMarkdown(editor.value, true);

  const base = currentPath.replace(/\.(md|markdown)$/i, "");
  const out = `${base}.html`;
  try {
    await invoke("write_md", { path: out, content: buildExportHtml() });
    toast(`已匯出 ${out.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast(`匯出失敗: ${String(e)}`);
  }
}

exportBtn.addEventListener("click", () => void exportHtml());

// ---------- Synced scrolling (editor <-> preview) ----------
// Both panes are driven off shared anchor pairs: a source line's pixel offset in
// the editor, and the offset of the preview element rendered from that same
// line. Between two anchors the position is interpolated, so the panes agree at
// every mapped block rather than only at the two ends of the document.
type Anchor = { src: number; prv: number; line: number | null; el: HTMLElement | null };
let anchors: Anchor[] = [];
let anchorSig = "";

// Mermaid, images and font-size changes resize the preview after render, so the
// measurements are keyed on a cheap signature instead of asking every producer
// of a height change to remember to invalidate them.
function anchorSignature(): string {
  return [
    lineTops.length,
    editor.scrollHeight,
    editor.clientHeight,
    content.scrollHeight,
    content.clientHeight,
  ].join("|");
}

function buildAnchors(): void {
  const pairs: Anchor[] = [];
  const base = content.getBoundingClientRect().top - content.scrollTop;
  content.querySelectorAll<HTMLElement>("[data-line]").forEach((el) => {
    const line = Number(el.dataset.line);
    const src = lineTops[line];
    if (!Number.isFinite(line) || src === undefined) return;
    // A block inside a collapsed <details> takes part in no layout, so its rect
    // reads as zero and would yield an offset that changes with wherever the
    // preview happened to be scrolled when the anchors were rebuilt.
    if (el.getClientRects().length === 0) return;
    const prv = el.getBoundingClientRect().top - base;
    // A nested block usually starts on the same line as its parent, and a block
    // that grew after render can overlap the one before it; the first
    // forward-moving pair wins, because going backwards would invert the
    // interpolation between this anchor and the last.
    const last = pairs[pairs.length - 1];
    if (last && (src <= last.src || prv <= last.prv)) return;
    pairs.push({ src, prv, line, el });
  });
  // Sentinels pin the stretches with no anchors of their own. At the top that is
  // the front-matter card, which has no source line. At the bottom there are
  // two: where the text ends, and where the scrollable box ends. Both panes
  // carry the same trailing blank (see #editor in styles.css), so the run
  // between those two maps one pixel to one pixel and the panes stay together
  // to the last line rather than drifting apart across the tail.
  const tail = (el: HTMLElement) =>
    el.scrollHeight - parseFloat(getComputedStyle(el).paddingBottom || "0");
  pairs.unshift({ src: 0, prv: 0, line: null, el: null });
  // Only strictly forward-moving sentinels; a document shorter than its own
  // padding could otherwise put one behind the last real anchor.
  for (const end of [
    { src: tail(editor), prv: tail(content), line: null, el: null },
    { src: editor.scrollHeight, prv: content.scrollHeight, line: null, el: null },
  ]) {
    const last = pairs[pairs.length - 1];
    if (end.src > last.src && end.prv > last.prv) pairs.push(end);
  }
  anchors = pairs;
  anchorSig = anchorSignature();
}

type Axis = "src" | "prv";

// The two anchors bracketing y along the given axis.
function bracket(y: number, from: Axis): [Anchor, Anchor] {
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid][from] <= y) lo = mid;
    else hi = mid;
  }
  return [anchors[lo], anchors[hi]];
}

// Has either pane moved under a measurement we already took? Re-wrapping the
// editor or reflowing the preview can leave the total heights the signature
// watches unchanged, so the two anchors about to be used are checked against
// the live geometry rather than trusted. Only those two, not the whole table.
function drifted(a: Anchor, b: Anchor): boolean {
  let base: number | null = null;
  for (const anchor of [a, b]) {
    if (anchor.line === null || !anchor.el) continue;
    // Editor side: a re-measured gutter changes where a source line sits.
    if (lineTops[anchor.line] !== anchor.src) return true;
    // Preview side: the block itself may have moved or been collapsed away.
    if (anchor.el.getClientRects().length === 0) return true;
    base ??= content.getBoundingClientRect().top - content.scrollTop;
    if (Math.abs(anchor.el.getBoundingClientRect().top - base - anchor.prv) >= 1) {
      return true;
    }
  }
  return false;
}

// Piecewise-linear lookup: project a y offset in one pane onto the other.
function project(y: number, from: Axis, to: Axis): number {
  if (anchors.length < 2 || anchorSig !== anchorSignature()) buildAnchors();
  let [a, b] = bracket(y, from);
  if (drifted(a, b)) {
    buildAnchors();
    [a, b] = bracket(y, from);
  }
  const span = b[from] - a[from];
  return a[to] + (span > 0 ? ((y - a[from]) / span) * (b[to] - a[to]) : 0);
}

// Remember the value we wrote, so the scroll event it causes is not mistaken for
// the user scrolling that pane. A single shared flag loses the race when both
// panes settle in the same frame, which is what makes ratio sync feel sticky.
const programmatic = new WeakMap<HTMLElement, number>();

function applyScroll(to: HTMLElement, top: number): void {
  const max = Math.max(0, to.scrollHeight - to.clientHeight);
  const next = Math.min(Math.max(top, 0), max);
  if (Math.abs(next - to.scrollTop) < 1) return;
  programmatic.set(to, next);
  to.scrollTop = next;
}

function syncScroll(from: HTMLElement, to: HTMLElement): void {
  if (!editMode) return;
  const echo = programmatic.get(from);
  programmatic.delete(from);
  if (echo !== undefined && Math.abs(from.scrollTop - echo) < 1) return;
  // scrollHeight and clientHeight are whole pixels while scrollTop is not, so a
  // pane parked at its bottom stops a fraction short of the end sentinel - and
  // the tail segment is steep enough to turn that fraction into a visible gap.
  const fromMax = Math.max(0, from.scrollHeight - from.clientHeight);
  if (from.scrollTop >= fromMax - 1) {
    applyScroll(to, Infinity);
    return;
  }
  const fromKey: Axis = from === editor ? "src" : "prv";
  const toKey: Axis = fromKey === "src" ? "prv" : "src";
  // The top edge is the focal point, so whatever line sits at the top of the
  // editor sits at the top of the preview.
  applyScroll(to, project(from.scrollTop, fromKey, toKey));
}

editor.addEventListener("scroll", () => {
  syncGutterScroll();
  syncScroll(editor, content);
});
content.addEventListener("scroll", () => syncScroll(content, editor));

// ---------- Close confirmation when there are unsaved changes ----------
function showCloseModal(): void {
  closeModal.hidden = false;
}
function hideCloseModal(): void {
  closeModal.hidden = true;
}
(document.getElementById("modal-cancel") as HTMLButtonElement).addEventListener(
  "click",
  hideCloseModal,
);
function finishClose(): void {
  dirty = false;
  if (closeAction === "doc") {
    goHome();
  } else if (closeAction === "switch") {
    if (pendingSwitchPath) void openFile(pendingSwitchPath);
  } else {
    void appWindow.destroy();
  }
}
(document.getElementById("modal-discard") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    hideCloseModal();
    finishClose();
  },
);
(document.getElementById("modal-save") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    await save();
    hideCloseModal();
    finishClose();
  },
);

// Close the current document (back to home), confirming if there are edits.
closeDocBtn.addEventListener("click", () => {
  if (dirty) {
    closeAction = "doc";
    showCloseModal();
  } else {
    goHome();
  }
});

// Content font scaling (persisted).
let fontScale = parseFloat(localStorage.getItem("fontScale") ?? "1") || 1;
function applyFontScale(): void {
  fontScale = Math.min(2.6, Math.max(0.6, Math.round(fontScale * 10) / 10));
  document.documentElement.style.setProperty("--content-scale", String(fontScale));
  localStorage.setItem("fontScale", String(fontScale));
  // The gutter follows the editor's font size, so line offsets must be remeasured.
  scheduleGutter();
}
function bumpFont(delta: number): void {
  fontScale += delta;
  applyFontScale();
}
fontInc.addEventListener("click", () => bumpFont(0.1));
fontDec.addEventListener("click", () => bumpFont(-0.1));
applyFontScale();

// ---------- About dialog (version info) ----------
const REPO_URL = "https://github.com/LouisChao0728/bookMDViewer";
const aboutModal = document.getElementById("about-modal") as HTMLElement;
const aboutVersion = document.getElementById("about-version") as HTMLElement;
aboutVersion.textContent = `v${__APP_VERSION__}`;
document.getElementById("about-close")?.addEventListener("click", () => {
  aboutModal.hidden = true;
});
document.getElementById("about-github")?.addEventListener("click", () => {
  void openUrl(REPO_URL);
});

// ---------- Open file dialog + recent files ----------
async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof selected === "string") await openFile(selected);
}
openBtn.addEventListener("click", () => void openViaDialog());
// Delegated so the empty-state links keep working after goHome() rebuilds them.
content.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  if (target.closest("#empty-open")) {
    ev.preventDefault();
    void openViaDialog();
  } else if (target.closest("#about-open")) {
    ev.preventDefault();
    aboutModal.hidden = false;
  }
});

function getRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem("recents") ?? "[]") as string[];
  } catch {
    return [];
  }
}
function addRecent(path: string): void {
  const list = getRecents().filter((p) => p !== path);
  list.unshift(path);
  localStorage.setItem("recents", JSON.stringify(list.slice(0, 8)));
}
function renderRecents(): void {
  const host = document.getElementById("recent-list");
  if (!host) return;
  host.innerHTML = "";
  const list = getRecents();
  if (!list.length) return;
  const h = document.createElement("h3");
  h.textContent = "最近開啟";
  host.appendChild(h);
  list.forEach((p) => {
    const a = document.createElement("a");
    a.className = "recent-item";
    a.href = "#";
    const name = document.createElement("span");
    name.className = "rf-name";
    name.textContent = p.split(/[\\/]/).pop() ?? p;
    const full = document.createElement("span");
    full.className = "rf-path";
    full.textContent = p;
    a.append(name, full);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openFile(p);
    });
    host.appendChild(a);
  });
}

// ---------- File explorer panel ----------
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
interface DirListing {
  dir: string;
  parent: string | null;
  entries: DirEntry[];
}

let filesOpen = localStorage.getItem("filesOpen") === "true";

function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, "");
}

function fileRow(
  label: string,
  icon: string,
  onClick: () => void,
  opts: { active?: boolean; muted?: boolean; onContext?: (ev: MouseEvent) => void } = {},
): HTMLElement {
  const a = document.createElement("a");
  a.className = "file-item";
  if (opts.active) a.classList.add("active");
  if (opts.muted) a.classList.add("muted");
  a.href = "#";
  const ic = document.createElement("span");
  ic.className = "fi-icon";
  ic.textContent = icon;
  const nm = document.createElement("span");
  nm.className = "fi-name";
  nm.textContent = label;
  a.append(ic, nm);
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    onClick();
  });
  if (opts.onContext) a.addEventListener("contextmenu", opts.onContext);
  return a;
}

// Copy text to the system clipboard, falling back to execCommand for webviews
// where the async Clipboard API is unavailable or blocked.
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to the legacy path below
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
  }
}

// Right-click context menu for files and folders.
let fileMenuEl: HTMLElement | null = null;
function closeFileMenu(): void {
  fileMenuEl?.remove();
  fileMenuEl = null;
}
function showFileMenu(ev: MouseEvent, path: string, isDir: boolean): void {
  ev.preventDefault();
  closeFileMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  // "Open in new window" only makes sense for files (the app opens .md files).
  if (!isDir) {
    const openItem = document.createElement("button");
    openItem.textContent = "在新視窗開啟";
    openItem.addEventListener("click", () => {
      closeFileMenu();
      void invoke("open_new_window", { path });
    });
    menu.appendChild(openItem);

    // "Show in folder" — opens the OS file manager with the file selected,
    // the way Obsidian's "Show in system explorer" does.
    const revealItem = document.createElement("button");
    revealItem.textContent = "在資料夾中顯示";
    revealItem.addEventListener("click", () => {
      closeFileMenu();
      void revealItemInDir(path).catch((e) =>
        toast(`開啟資料夾失敗: ${String(e)}`),
      );
    });
    menu.appendChild(revealItem);
  }

  // "Copy path" — the full absolute filesystem path; available for both.
  const copyItem = document.createElement("button");
  copyItem.textContent = "複製路徑";
  copyItem.addEventListener("click", () => {
    closeFileMenu();
    void copyToClipboard(path).then(() => toast("已複製路徑"));
  });
  menu.appendChild(copyItem);

  document.body.appendChild(menu);
  // Keep within the viewport.
  const mw = 180;
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - mw)}px`;
  menu.style.top = `${ev.clientY}px`;
  fileMenuEl = menu;
}
window.addEventListener("click", closeFileMenu);
window.addEventListener("blur", closeFileMenu);

async function renderFiles(dir: string | null): Promise<void> {
  if (!dir) {
    filesPanel.innerHTML = "";
    const hint = document.createElement("div");
    hint.className = "files-hint";
    hint.textContent = "開啟檔案後可瀏覽其目錄";
    filesPanel.appendChild(hint);
    return;
  }
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: dir });
  } catch (e) {
    // Keep the current view; just report (e.g. typed a path that doesn't exist).
    toast(String(e));
    return;
  }

  filesPanel.innerHTML = "";

  // Editable full-path bar — type a folder and press Enter to jump there.
  const pathInput = document.createElement("input");
  pathInput.className = "files-path";
  pathInput.value = listing.dir;
  pathInput.spellcheck = false;
  pathInput.title = listing.dir;
  pathInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const v = pathInput.value.trim();
      if (v) void renderFiles(v);
    } else if (ev.key === "Escape") {
      pathInput.value = listing.dir;
      pathInput.blur();
    }
  });
  filesPanel.appendChild(pathInput);

  if (listing.parent) {
    filesPanel.appendChild(
      fileRow("..", "📁", () => void renderFiles(listing.parent), {
        muted: true,
      }),
    );
  }
  for (const entry of listing.entries) {
    if (entry.is_dir) {
      filesPanel.appendChild(
        fileRow(entry.name, "📁", () => void renderFiles(entry.path), {
          onContext: (ev) => showFileMenu(ev, entry.path, true),
        }),
      );
    } else {
      filesPanel.appendChild(
        fileRow(entry.name, "📄", () => switchToFile(entry.path), {
          active: entry.path === currentPath,
          onContext: (ev) => showFileMenu(ev, entry.path, false),
        }),
      );
    }
  }
}

function switchToFile(path: string): void {
  if (path === currentPath) return;
  if (dirty) {
    closeAction = "switch";
    pendingSwitchPath = path;
    showCloseModal();
  } else {
    void openFile(path);
  }
}

function toggleFiles(): void {
  filesOpen = !filesOpen;
  layout.classList.toggle("files-open", filesOpen);
  localStorage.setItem("filesOpen", String(filesOpen));
  if (filesOpen) void renderFiles(currentPath ? dirOf(currentPath) : null);
}
filesBtn.addEventListener("click", toggleFiles);
// Restore persisted state on load.
if (filesOpen) layout.classList.add("files-open");

// ---------- Mermaid diagram lightbox (click to zoom/pan) ----------
const diagramModal = document.getElementById("diagram-modal") as HTMLElement;
const diagramStage = document.getElementById("diagram-stage") as HTMLElement;
const dgZoomLabel = document.getElementById("dg-zoom") as HTMLElement;
let dgEl: HTMLElement | null = null;
let dgScale = 1;
let dgX = 0;
let dgY = 0;
let dgNatW = 0;
let dgNatH = 0;

function dgApply(): void {
  if (dgEl) dgEl.style.transform = `translate(${dgX}px, ${dgY}px) scale(${dgScale})`;
  dgZoomLabel.textContent = `${Math.round(dgScale * 100)}%`;
}
function dgFit(): void {
  const sw = diagramStage.clientWidth;
  const sh = diagramStage.clientHeight;
  if (!dgNatW || !dgNatH) return;
  dgScale = Math.min(sw / dgNatW, sh / dgNatH, 1) || 1;
  dgX = (sw - dgNatW * dgScale) / 2;
  dgY = (sh - dgNatH * dgScale) / 2;
  dgApply();
}
function dgZoomAt(cx: number, cy: number, factor: number): void {
  const ns = Math.min(8, Math.max(0.1, dgScale * factor));
  const k = ns / dgScale;
  dgX = cx - (cx - dgX) * k;
  dgY = cy - (cy - dgY) * k;
  dgScale = ns;
  dgApply();
}
function openDiagram(svg: SVGElement): void {
  diagramStage.innerHTML = "";
  const card = document.createElement("div");
  card.className = "dg-card";
  const clone = svg.cloneNode(true) as SVGElement;
  const vb = (svg as SVGSVGElement).viewBox?.baseVal;
  clone.removeAttribute("style");
  if (vb && vb.width && vb.height) {
    clone.setAttribute("width", String(vb.width));
    clone.setAttribute("height", String(vb.height));
  }
  card.appendChild(clone);
  diagramStage.appendChild(card);
  dgEl = card;
  diagramModal.hidden = false;
  dgNatW = card.offsetWidth;
  dgNatH = card.offsetHeight;
  dgFit();
}
function closeDiagram(): void {
  diagramModal.hidden = true;
  diagramStage.innerHTML = "";
  dgEl = null;
}

diagramStage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = diagramStage.getBoundingClientRect();
    dgZoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);
let dgDragging = false;
let dgLastX = 0;
let dgLastY = 0;
diagramStage.addEventListener("mousedown", (e) => {
  dgDragging = true;
  dgLastX = e.clientX;
  dgLastY = e.clientY;
  diagramStage.classList.add("grabbing");
});
window.addEventListener("mousemove", (e) => {
  if (!dgDragging) return;
  dgX += e.clientX - dgLastX;
  dgY += e.clientY - dgLastY;
  dgLastX = e.clientX;
  dgLastY = e.clientY;
  dgApply();
});
window.addEventListener("mouseup", () => {
  dgDragging = false;
  diagramStage.classList.remove("grabbing");
});
function dgCenterZoom(factor: number): void {
  dgZoomAt(diagramStage.clientWidth / 2, diagramStage.clientHeight / 2, factor);
}
(document.getElementById("dg-zoomin") as HTMLButtonElement).addEventListener("click", () => dgCenterZoom(1.25));
(document.getElementById("dg-zoomout") as HTMLButtonElement).addEventListener("click", () => dgCenterZoom(0.8));
(document.getElementById("dg-reset") as HTMLButtonElement).addEventListener("click", dgFit);
(document.getElementById("dg-close") as HTMLButtonElement).addEventListener("click", closeDiagram);

// ---------- Find in document (Ctrl+F) ----------
// Matches are painted with the CSS Custom Highlight API instead of window.find():
// window.find() moves the document selection (and focus) into the article, which
// kicked the caret out of the find box after the first typed character.
interface HighlightLike {
  add(range: Range): void;
}
interface HighlightRegistry {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}
const highlightRegistry = (CSS as unknown as { highlights?: HighlightRegistry })
  .highlights;
const HighlightCtor = (
  window as unknown as { Highlight?: new () => HighlightLike }
).Highlight;
const canHighlight = Boolean(highlightRegistry && HighlightCtor);

const FIND_MATCH_CAP = 2000; // stop painting absurd match counts on huge docs
let findMatches: Range[] = [];
let findIndex = -1;
let findQuery = "";

// Collect every match as a Range, spanning element boundaries (so `**bo**ld`
// still matches "bold") by searching one concatenated string of all text nodes.
function collectMatches(query: string): Range[] {
  const out: Range[] = [];
  if (!query) return out;

  const nodes: Text[] = [];
  const starts: number[] = [];
  let raw = "";
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (!text.nodeValue) continue;
    nodes.push(text);
    starts.push(raw.length);
    raw += text.nodeValue;
  }
  if (!nodes.length) return out;

  // Case-insensitive matching, unless lowercasing would shift the offsets
  // (a few characters expand, e.g. "İ"), in which case fall back to exact case.
  const lowered = raw.toLowerCase();
  const sameLength = lowered.length === raw.length;
  const hay = sameLength ? lowered : raw;
  const needle = sameLength ? query.toLowerCase() : query;

  // Which text node holds the character at a global index.
  const locate = (index: number): [Text, number] => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], index - starts[lo]];
  };

  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    const [startNode, startOffset] = locate(at);
    const [endNode, endOffset] = locate(at + needle.length - 1);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset + 1);
    out.push(range);
    from = at + needle.length;
    if (out.length >= FIND_MATCH_CAP) break;
  }
  return out;
}

function paintFind(): void {
  if (!canHighlight) return;
  const all = new HighlightCtor!();
  const current = new HighlightCtor!();
  findMatches.forEach((r, i) => (i === findIndex ? current : all).add(r));
  highlightRegistry!.set("find-match", all);
  highlightRegistry!.set("find-current", current);
}

function clearFindPaint(): void {
  if (!canHighlight) return;
  highlightRegistry!.delete("find-match");
  highlightRegistry!.delete("find-current");
}

function updateFindCount(): void {
  if (!findInput.value) {
    findCount.textContent = "";
  } else if (!findMatches.length) {
    findCount.textContent = "無相符";
  } else {
    findCount.textContent = `${findIndex + 1}/${findMatches.length}`;
  }
}

// Scroll the active match into view without touching focus.
function revealMatch(): void {
  const range = findMatches[findIndex];
  if (!range) return;
  const rect = range.getBoundingClientRect();
  const view = content.getBoundingClientRect();
  if (rect.top < view.top + 40 || rect.bottom > view.bottom - 40) {
    content.scrollTop += rect.top - view.top - content.clientHeight / 3;
  }
}

// Re-run the search against freshly rendered HTML, keeping the current position.
function refreshFindHighlights(): void {
  if (findBar.hidden || !canHighlight || !findInput.value) return;
  const previous = findIndex;
  findMatches = collectMatches(findInput.value);
  findQuery = findInput.value;
  findIndex = findMatches.length
    ? Math.min(Math.max(previous, 0), findMatches.length - 1)
    : -1;
  paintFind();
  updateFindCount();
}

// Fallback for webviews without the Highlight API: keep window.find(), but hand
// focus straight back to the input so typing is not interrupted.
function legacyFind(backwards: boolean): void {
  const q = findInput.value;
  if (!q) {
    findCount.textContent = "";
    return;
  }
  const caretStart = findInput.selectionStart;
  const caretEnd = findInput.selectionEnd;
  // window.find(text, caseSensitive, backwards, wrapAround)
  const found = (
    window as unknown as {
      find: (s: string, c: boolean, b: boolean, w: boolean) => boolean;
    }
  ).find(q, false, backwards, true);
  findCount.textContent = found ? "" : "無相符";
  findInput.focus();
  if (caretStart !== null && caretEnd !== null) {
    findInput.setSelectionRange(caretStart, caretEnd);
  }
}

function openFind(): void {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind(false);
}

function closeFind(): void {
  findBar.hidden = true;
  findCount.textContent = "";
  clearFindPaint();
  findMatches = [];
  findIndex = -1;
  findQuery = "";
  window.getSelection()?.removeAllRanges();
}

function runFind(backwards: boolean): void {
  if (!canHighlight) {
    legacyFind(backwards);
    return;
  }
  if (findInput.value !== findQuery) {
    // New query: search from the top.
    findQuery = findInput.value;
    findMatches = collectMatches(findQuery);
    findIndex = findMatches.length ? 0 : -1;
  } else if (findMatches.length) {
    // Same query: step to the next / previous match, wrapping around.
    findIndex =
      (findIndex + (backwards ? -1 : 1) + findMatches.length) %
      findMatches.length;
  }
  paintFind();
  updateFindCount();
  revealMatch();
}
findInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    runFind(ev.shiftKey);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeFind();
  }
});
findInput.addEventListener("input", () => runFind(false));
(document.getElementById("find-next") as HTMLButtonElement).addEventListener("click", () => runFind(false));
(document.getElementById("find-prev") as HTMLButtonElement).addEventListener("click", () => runFind(true));
(document.getElementById("find-close") as HTMLButtonElement).addEventListener("click", closeFind);

// Collapse / expand the outline.
function toggleToc(): void {
  layout.classList.toggle("toc-collapsed");
}
tocToggle.addEventListener("click", toggleToc);
window.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && ev.key === "\\") {
    ev.preventDefault();
    toggleToc();
  } else if (ev.ctrlKey && (ev.key === "e" || ev.key === "E")) {
    ev.preventDefault();
    toggleEdit();
  } else if (ev.ctrlKey && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    void save();
  } else if (ev.ctrlKey && (ev.key === "=" || ev.key === "+")) {
    ev.preventDefault();
    bumpFont(0.1);
  } else if (ev.ctrlKey && ev.key === "-") {
    ev.preventDefault();
    bumpFont(-0.1);
  } else if (ev.ctrlKey && (ev.key === "o" || ev.key === "O")) {
    ev.preventDefault();
    void openViaDialog();
  } else if (ev.ctrlKey && (ev.key === "f" || ev.key === "F")) {
    ev.preventDefault();
    openFind();
  } else if (ev.ctrlKey && (ev.key === "b" || ev.key === "B")) {
    ev.preventDefault();
    toggleFiles();
  } else if (ev.key === "Escape" && !diagramModal.hidden) {
    closeDiagram();
  } else if (ev.key === "Escape" && !findBar.hidden) {
    closeFind();
  }
});

// Open external links in the user's default browser instead of navigating
// the webview away from the document.
content.addEventListener("click", (ev) => {
  const anchor = (ev.target as HTMLElement).closest("a");
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      ev.preventDefault();
      void openUrl(href);
    }
  }
});

async function init(): Promise<void> {
  // Hot reload when the watched file changes on disk. Skip while editing or
  // when the change came from our own save.
  await listen<string>("md-changed", () => {
    if (currentPath && !editMode && Date.now() > suppressReloadUntil) {
      void openFile(currentPath, false, true);
    }
  });

  // macOS delivers file-association opens at runtime.
  await listen<string>("open-file", (ev) => {
    void openFile(ev.payload);
  });

  // Drag-and-drop a .md file onto the window.
  await getCurrentWebview().onDragDropEvent((ev) => {
    if (ev.payload.type === "drop") {
      const file = ev.payload.paths.find((p) => /\.(md|markdown)$/i.test(p));
      if (file) {
        void openFile(file);
      }
    }
  });

  // Intercept window close when there are unsaved edits.
  await appWindow.onCloseRequested((event) => {
    if (dirty) {
      event.preventDefault();
      closeAction = "window";
      showCloseModal();
    }
  });

  // Signal the backend that listeners are ready, flushing any file-open
  // requests that arrived during cold start (fixes macOS first-open blank).
  await invoke("frontend_ready");

  // Populate the empty-state recent-files list.
  renderRecents();

  // Restore the file-explorer panel if it was left open.
  if (filesOpen) void renderFiles(null);

  // File the app was launched with (Windows / Linux association).
  const initial = await invoke<string | null>("get_initial_path");
  if (initial) {
    await openFile(initial);
    // Optional `--edit` flag opens straight into edit mode.
    if (await invoke<boolean>("start_in_edit")) {
      setEditMode(true);
    }
  }

  // Optional `--zoom=<factor>` flag scales the whole UI.
  const zoom = await invoke<number>("start_zoom");
  if (zoom && zoom > 0) {
    await getCurrentWebview().setZoom(zoom);
  }
}

void init();
