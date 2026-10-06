// Server file browser for path-based LTX nodes (fork addition).
//
// Adds a "📁 Browse…" button and a right-click "📁 Browse server…" entry to
// LTXVLoadEXRSequence. The modal lists folders and .exr files on the ComfyUI
// SERVER (e.g. a shared filespace under /mnt) through GET /ltxv/browse, so users
// don't have to type absolute paths.
//
// The node accepts a single .exr still, a sequence PATTERN or a FOLDER of frames:
//   - picking a frame that belongs to a sequence fills its pattern, Nuke-style
//     (dir/shot.####.exr), so folders holding several sequences (proxy + 2K…) work;
//   - picking a lone .exr fills that file;
//   - "📂 Use folder" fills the current folder, only if it holds a single sequence.
// Read-only info rows on the node show the frame count, the frame range and what
// trim_to_8k1 will keep (V2V needs 8k+1 frames). They are not serialized.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_WIDGET = { LTXVLoadEXRSequence: "path" };
const EXTS = "exr";
const BTN = "📁 Browse…";
const DEFAULT_START = "/mnt/s3files";


// Same grouping as the server (hdr_io._sequence_groups): numbered frames are keyed
// by a "prefix####suffix" pattern; un-numbered files are their own group (a still).
const FRAME_RE = /^(.*?)(\d+)(\.exr)$/i;
function groupsOf(files) {
  const groups = {};
  for (const f of files || []) {
    const m = f.match(FRAME_RE);
    const key = m ? m[1] + "#".repeat(m[2].length) + m[3] : f;
    (groups[key] = groups[key] || []).push(m ? parseInt(m[2], 10) : null);
  }
  return groups;
}
function seqInfo(nums) {
  if (!nums || nums.length < 2) return null;
  const s = [...nums].sort((a, b) => a - b);
  return { start: s[0], end: s[s.length - 1], count: s.length };
}
// Sequence (pattern + info) a picked frame belongs to; null for a lone still.
function seqOf(filename, files) {
  const m = filename.match(FRAME_RE);
  if (!m) return null;
  const pattern = m[1] + "#".repeat(m[2].length) + m[3];
  const info = seqInfo(groupsOf(files)[pattern]);
  return info ? { pattern, ...info } : null;
}
// The single sequence of a folder, or null if it holds none or several.
function seqOfFolder(files) {
  const keys = Object.keys(groupsOf(files));
  return keys.length === 1 ? seqInfo(groupsOf(files)[keys[0]]) : null;
}
function isPattern(v) { return /#+|%0?\d*d/.test(String(v).split("/").pop() || ""); }

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
    btn("📂 Use folder", () => {
      const n = Object.keys(groupsOf(curFiles)).length;
      if (n > 1) {
        status.style.color = "#e6a23c";
        status.textContent = `This folder holds ${n} sequences/stills: pick a frame of the one you want.`;
        return;
      }
      onPick(cur, { isFile: false, dir: cur, files: curFiles }); close();
    }),
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
    const groups = groupsOf(curFiles);
    const n = Object.keys(groups).length;
    const seq = seqOfFolder(curFiles);
    status.style.color = "#999";
    status.textContent = seq ? `${seq.count} .exr frames here (${seq.start}–${seq.end})`
      : n > 1 ? `${n} sequences/stills here — pick a frame to load just its sequence`
      : `${curFiles.length} .exr files`;
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
  const start = v.startsWith("/") ? (v.toLowerCase().endsWith(".exr") || isPattern(v) ? dirname(v) : v) : DEFAULT_START;
  openBrowser(start, (picked, info) => {
    let value = picked;
    if (info.isFile) {
      const seq = seqOf(info.file, info.files);
      if (seq) { value = joinPath(info.dir, seq.pattern); showInfo(node, seq, false); }   // whole sequence, by pattern
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
        // serialize:false — a button is not an input; otherwise it lands in the prompt.
        const b = this.addWidget("button", BTN, null, () => attach(this, widgetName), { serialize: false });
        if (b) b.serialize = false;
      }
      return r;
    };
  },
});
