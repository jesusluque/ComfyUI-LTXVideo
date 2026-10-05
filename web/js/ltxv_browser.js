// Server file browser for path-based LTX nodes (fork addition).
//
// Adds a "📁 Browse…" button and a right-click "📁 Browse server…" entry to
// LTXVLoadEXRSequence. The modal lists folders and .exr files on the ComfyUI
// SERVER (e.g. a shared filespace under /mnt) through GET /ltxv/browse, so users
// don't have to type absolute paths.
//
// The node accepts either a single .exr still or a FOLDER of frames:
//   - picking a frame that belongs to a sequence fills the FOLDER (whole sequence);
//   - picking a lone .exr fills that file;
//   - "📂 Use folder" fills the current folder.
// Read-only info rows on the node show the frame count, the frame range and what
// trim_to_8k1 will keep (V2V needs 8k+1 frames). They are not serialized.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_WIDGET = { LTXVLoadEXRSequence: "path" };
const EXTS = "exr";
const BTN = "📁 Browse…";
const DEFAULT_START = "/mnt/s3files";

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Frames of the sequence a file belongs to (same prefix/suffix, variable number).
function seqOf(filename, files) {
  const m = filename.match(/^(.*?)(\d+)(\.[^.]+)$/);
  if (!m) return null;
  const [, prefix, , ext] = m;
  const re = new RegExp("^" + escRe(prefix) + "(\\d+)" + escRe(ext) + "$");
  const nums = [];
  for (const f of files || []) { const mm = f.match(re); if (mm) nums.push(parseInt(mm[1], 10)); }
  if (nums.length < 2) return null;
  nums.sort((a, b) => a - b);
  return { start: nums[0], end: nums[nums.length - 1], count: nums.length };
}

// Dominant sequence of a folder (largest group of numbered .exr files).
function seqOfFolder(files) {
  const groups = {};
  for (const f of files || []) {
    const m = f.match(/^(.*?)(\d+)(\.[^.]+)$/);
    if (!m) continue;
    const key = m[1] + "|" + m[2].length + "|" + m[3];
    (groups[key] = groups[key] || []).push(parseInt(m[2], 10));
  }
  let best = null;
  for (const k in groups) if (!best || groups[k].length > best.length) best = groups[k];
  if (!best || !best.length) return null;
  best.sort((a, b) => a - b);
  return { start: best[0], end: best[best.length - 1], count: best.length };
}

// Largest n <= count with n = 8k+1 (what trim_to_8k1 keeps).
function trim8k1(count) { return count < 1 ? 0 : count - ((count - 1) % 8); }

function dirname(p) {
  if (!p) return "/";
  p = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}
function joinPath(a, b) { return (a.replace(/\/?$/, "/") + b).replace(/\/{2,}/g, "/"); }

async function browse(path) {
  const q = new URLSearchParams({ path: path || DEFAULT_START, exts: EXTS });
  const r = await api.fetchApi("/ltxv/browse?" + q.toString());
  const j = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (!r.ok && !j.error) j.error = "HTTP " + r.status;
  return j;
}

function el(tag, style) {
  const n = document.createElement(tag);
  Object.assign(n.style, style || {});
  return n;
}
function btn(text, onclick) {
  const b = el("button", { background: "#2a2a30", color: "#eee", border: "1px solid #444",
    borderRadius: "6px", padding: "6px 9px", cursor: "pointer", whiteSpace: "nowrap" });
  b.textContent = text; b.onclick = onclick; return b;
}

function openBrowser(startPath, onPick) {
  const ov = el("div", { position: "fixed", inset: "0", zIndex: "10010",
    background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center" });
  const box = el("div", { width: "min(640px,92vw)", maxHeight: "78vh", display: "flex",
    flexDirection: "column", background: "#1b1b1f", color: "#eee", border: "1px solid #444",
    borderRadius: "10px", fontFamily: "system-ui", fontSize: "13px", overflow: "hidden",
    boxShadow: "0 10px 40px rgba(0,0,0,.5)" });
  const pathInput = el("input", { flex: "1", background: "#111", color: "#eee",
    border: "1px solid #444", borderRadius: "6px", padding: "6px" });
  const status = el("div", { padding: "4px 12px 8px", color: "#999", fontSize: "12px" });
  const list = el("div", { overflowY: "auto", padding: "6px 10px" });
  const head = el("div", { display: "flex", gap: "6px", alignItems: "center",
    padding: "10px", borderBottom: "1px solid #333" });
  let cur = startPath, curFiles = [], parent = null;
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  head.append(
    btn("⬆", () => { if (parent) nav(parent); }),
    pathInput,
    btn("Go", () => nav(pathInput.value)),
    btn("📂 Use folder", () => { onPick(cur, { isFile: false, dir: cur, files: curFiles }); close(); }),
    btn("✕", close),
  );
  pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nav(pathInput.value); });
  box.append(head, list, status); ov.append(box);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(ov);

  function row(icon, name, onclick) {
    const d = el("div", { display: "flex", gap: "8px", padding: "5px 6px", borderRadius: "6px",
      cursor: "pointer", alignItems: "center" });
    d.onmouseenter = () => (d.style.background = "#2a2a30");
    d.onmouseleave = () => (d.style.background = "");
    const i = el("span"); i.textContent = icon;
    const n = el("span", { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    n.textContent = name;
    d.append(i, n); d.onclick = onclick; return d;
  }
  async function nav(path) {
    cur = (path || DEFAULT_START).replace(/\\/g, "/");
    pathInput.value = cur; list.textContent = "loading…"; status.textContent = "";
    const j = await browse(cur);
    if (j.error) { list.textContent = "❌ " + j.error; parent = j.parent || null; return; }
    cur = j.path; parent = j.parent; curFiles = j.files || [];
    pathInput.value = cur;
    list.textContent = "";
    (j.dirs || []).forEach((d) => list.append(row("📁", d, () => nav(joinPath(cur, d)))));
    curFiles.forEach((f) => list.append(row("🖼", f, () => {
      onPick(joinPath(cur, f), { isFile: true, dir: cur, file: f, files: curFiles }); close();
    })));
    if (!(j.dirs || []).length && !curFiles.length) list.append(row("·", "(no folders or .exr files)", () => {}));
    const seq = seqOfFolder(curFiles);
    status.textContent = seq ? `${seq.count} .exr frames here (${seq.start}–${seq.end})` : `${curFiles.length} .exr files`;
  }
  nav(startPath);
}

function getW(node, name) { return node.widgets?.find((x) => x.name === name); }
function setW(node, name, value) {
  const w = getW(node, name);
  if (w) { w.value = value; try { w.callback?.(value); } catch (e) {} }
}

// Read-only info rows on the node (frontend only, never serialized).
function setInfo(node, name, value) {
  let w = node.widgets?.find((x) => x.__ltxvInfo && x.name === name);
  if (!w) {
    w = node.addWidget("text", name, "", () => {}, { serialize: false });
    w.__ltxvInfo = true;
    try { w.disabled = true; } catch (e) {}
  }
  w.value = String(value);
}
function showInfo(node, seq, single) {
  if (single) {
    setInfo(node, "▸ frames", "1 (still)");
    setInfo(node, "▸ range", "—");
    setInfo(node, "▸ 8k+1", "—");
  } else if (seq) {
    const keep = trim8k1(seq.count);
    const trimOn = getW(node, "trim_to_8k1")?.value !== false;
    setInfo(node, "▸ frames", seq.count);
    setInfo(node, "▸ range", `${seq.start}–${seq.end}`);
    setInfo(node, "▸ 8k+1", keep === seq.count ? "✓ already 8k+1"
      : (trimOn ? `trimmed to ${keep}` : `${seq.count} (not 8k+1; trim is off)`));
  } else {
    setInfo(node, "▸ frames", "—");
    setInfo(node, "▸ range", "—");
    setInfo(node, "▸ 8k+1", "—");
  }
  node.setDirtyCanvas?.(true, true);
}

function attach(node, widgetName) {
  const w = getW(node, widgetName);
  const v = w && w.value ? String(w.value) : "";
  const start = v.startsWith("/") ? (v.toLowerCase().endsWith(".exr") ? dirname(v) : v) : DEFAULT_START;
  openBrowser(start, (picked, info) => {
    let value = picked;
    if (info.isFile) {
      const seq = seqOf(info.file, info.files);
      if (seq) { value = info.dir; showInfo(node, seq, false); }   // whole sequence
      else { showInfo(node, null, true); }                           // lone still
    } else {
      showInfo(node, seqOfFolder(info.files), false);
    }
    setW(node, widgetName, value);
  });
}

app.registerExtension({
  name: "LTXVideo.ServerBrowser",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const widgetName = NODE_WIDGET[nodeData?.name];
    if (!widgetName) return;

    const getOpts = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = getOpts ? getOpts.apply(this, arguments) : undefined;
      options.unshift({ content: "📁 Browse server…", callback: () => attach(this, widgetName) });
      return r;
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      if (!this.widgets?.some((w) => w.name === BTN)) {
        this.addWidget("button", BTN, null, () => attach(this, widgetName));
      }
      return r;
    };
  },
});
