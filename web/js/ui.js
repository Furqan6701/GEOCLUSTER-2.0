/**
 * DOM helpers. Everything renders through `textContent` — no `innerHTML`
 * anywhere in this frontend (chat replies especially: they may contain LaTeX
 * such as \[ ... \] and must be shown as plain text).
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") throw new Error("innerHTML is not allowed; use text");
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function setChildren(node, children) {
  clear(node);
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function button(label, onClick, { variant = "", size = "", disabled = false, title = "" } = {}) {
  const classes = ["btn", variant, size].filter(Boolean).join(" ");
  return el("button", { class: classes, type: "button", text: label, disabled, title, onclick: onClick });
}

export function labelled(labelText, control, hint = "") {
  return el("div", { class: "field" }, [
    el("label", { text: labelText }),
    control,
    hint ? el("span", { class: "muted", text: hint }) : null,
  ]);
}

export function numberInput({ value = 0, min = null, max = null, step = 1 } = {}) {
  return el("input", { type: "number", value: String(value), min, max, step });
}

export function chip(label, kind = "", title = "") {
  return el("span", { class: ["chip", kind].filter(Boolean).join(" "), text: label, title });
}

export function badge(label, kind = "") {
  return el("span", { class: ["badge", kind].filter(Boolean).join(" "), text: label });
}

export function swatch(color) {
  const [r, g, b] = color ?? [0, 0, 0];
  return el("span", {
    class: "swatch",
    style: { background: `rgb(${r}, ${g}, ${b})` },
    title: `rgb(${r}, ${g}, ${b})`,
  });
}

export function kv(pairs) {
  const list = el("dl", { class: "kv" });
  for (const [key, value] of pairs) {
    if (value == null) continue;
    list.append(el("dt", { text: key }), el("dd", { text: String(value) }));
  }
  return list;
}

export function table(headers, rows) {
  const thead = el("thead", {}, el("tr", {}, headers.map((header) =>
    el("th", { class: header && header.num ? "num" : "", text: header?.text ?? header }),
  )));
  const tbody = el("tbody", {}, rows.map((row) =>
    el("tr", {}, row.map((cell, index) => {
      const isNode = cell instanceof Node;
      const numeric = typeof cell === "number" || headers[index]?.num;
      return el("td", { class: numeric ? "num" : "" }, [isNode ? cell : String(cell ?? "")]);
    })),
  ));
  return el("table", { class: "grid" }, [thead, tbody]);
}

export function spinner() {
  return el("span", { class: "spinner", "aria-hidden": "true" });
}

// ------------------------------------------------------------------ toasts

let toastHost = null;

export function toast(message, kind = "", { timeout = 6000 } = {}) {
  if (!toastHost) toastHost = document.getElementById("toasts");
  if (!toastHost) return;
  const node = el("div", { class: ["toast", kind].filter(Boolean).join(" "), text: message });
  toastHost.append(node);
  if (timeout > 0) {
    setTimeout(() => node.remove(), timeout);
  }
  return node;
}

// -------------------------------------------------------------- formatting

export function fmtNumber(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

export function fmtBytes(value) {
  if (value == null) return "—";
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtMegapixels(value) {
  if (value == null) return "—";
  return `${Number(value).toFixed(2)} MP`;
}

export function fmtPercent(value) {
  if (value == null) return "—";
  return `${Number(value).toFixed(1)}%`;
}

/** Human summary of an ImageInfo object returned by the API. */
export function describeImage(info) {
  if (!info) return "";
  const parts = [`${info.width}×${info.height}`, `${Number(info.megapixels ?? 0).toFixed(2)} MP`];
  if (info.downscaled) {
    parts.push(`downscaled ${Number(info.scale).toFixed(3)}× from ${info.original_width}×${info.original_height}`);
  }
  return parts.join(" · ");
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
