/**
 * DOM helpers for the GeoCluster workstation shell.
 *
 * Everything renders through `textContent` / `createElementNS` — there is no
 * `innerHTML` anywhere in this frontend (chat replies especially: they may
 * contain LaTeX such as \[ ... \] and must be shown as plain text). Icons are
 * real SVG nodes built with createElementNS rather than markup strings.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

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

// ------------------------------------------------------------------- icons

/**
 * Minimal 24×24 stroke icons. Each entry is a list of path `d` strings and/or
 * {circle:[cx,cy,r]} / {line:[x1,y1,x2,y2]} primitives.
 */
const ICONS = {
  open: ["M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"],
  upload: ["M12 16V4", "m7.5 8.5 4.5-4.5 4.5 4.5", "M4 20h16"],
  download: ["M12 4v12", "m7.5 11.5 4.5 4.5 4.5-4.5", "M4 20h16"],
  satellite: ["M12 13l3.5-3.5", { circle: [12, 12, 2.2] }, "M5 5a9.5 9.5 0 0 0 0 14", "M19 5a9.5 9.5 0 0 1 0 14"],
  archive: ["M3.5 6h17v3.5h-17z", "M5.5 9.5V18a1.5 1.5 0 0 0 1.5 1.5h10A1.5 1.5 0 0 0 18.5 18V9.5", "M10 13.5h4"],
  file: ["M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z", "M13.5 3.5V8.5h5"],
  filters: ["M3.5 5h17l-6.5 7.5V20l-4-2v-5.5z"],
  layers: ["m12 3.5 8.5 4.5-8.5 4.5L3.5 8z", "m4.5 12.5 7.5 4 7.5-4", "m4.5 16.5 7.5 4 7.5-4"],
  chart: ["M4 20h16", "M7 20V11", "M12 20V4.5", "M17 20v-6.5"],
  zoomIn: [{ circle: [10.5, 10.5, 6.5] }, "m20.5 20.5-5-5", "M7.5 10.5h6", "M10.5 7.5v6"],
  zoomOut: [{ circle: [10.5, 10.5, 6.5] }, "m20.5 20.5-5-5", "M7.5 10.5h6"],
  fit: ["M4 9.5V5.5A1.5 1.5 0 0 1 5.5 4h4", "M14.5 4h4A1.5 1.5 0 0 1 20 5.5v4", "M20 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-4", "M9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4"],
  pan: ["M9 12.5V6a1.6 1.6 0 0 1 3.2 0v5.5", "M12.2 11.5V4.8a1.6 1.6 0 0 1 3.2 0v6.7", "M15.4 11.8v-1a1.6 1.6 0 0 1 3.2 0V15a6 6 0 0 1-6 6h-1.4a5 5 0 0 1-5-5v-3.3a1.6 1.6 0 0 1 3.2 0"],
  pixel: [{ circle: [12, 12, 3] }, "M12 3v3.5", "M12 17.5V21", "M3 12h3.5", "M17.5 12H21"],
  measure: ["m3.5 9 5.5-5.5 11.5 11.5-5.5 5.5z", "m8 5.5 3 3", "m11 8.5 3 3", "m14 11.5 3 3", "m6.5 12 3 3"],
  sync: ["M4.5 10a7.5 7.5 0 0 1 12.6-3.9", "M19.5 14a7.5 7.5 0 0 1-12.6 3.9", "M17.5 3.5v3.2h-3.2", "M6.5 20.5v-3.2h3.2"],
  undo: ["M9.5 14.5 4 9l5.5-5.5", "M4 9h11a5 5 0 0 1 0 10h-5.5"],
  redo: ["m14.5 14.5 5.5-5.5-5.5-5.5", "M20 9H9a5 5 0 0 0 0 10h5.5"],
  chevronDown: ["m6.5 9.5 5.5 5.5 5.5-5.5"],
  chevronRight: ["m9.5 6 6 6-6 6"],
  panelLeft: ["M4 4.5h16v15H4z", "M10 4.5v15"],
  panelRight: ["M4 4.5h16v15H4z", "M14 4.5v15"],
  chat: ["M4.5 5.5h15v10h-9l-4.5 4v-4h-1.5z"],
  info: [{ circle: [12, 12, 8.5] }, "M12 11v5.5", "M12 7.6v.9"],
  map: ["m9 3.5 6 2.2 6-2.2v16l-6 2.2-6-2.2-6 2.2v-16z", "M9 3.5v16", "M15 5.7v16"],
  legend: ["M4 6h4.5v4.5H4z", "M4 14h4.5v4.5H4z", "M11 8.2h9", "M11 16.2h9"],
  help: [{ circle: [12, 12, 8.5] }, "M9.6 9.6a2.5 2.5 0 1 1 3.3 2.4V14", "M12.9 17.2v.9"],
  trash: ["M4.5 7h15", "M9.5 7V4.8h5V7", "M6.5 7l1 13h9l1-13"],
  run: ["m7.5 4.5 12 7.5-12 7.5z"],
  close: ["M6.5 6.5 17.5 17.5", "M17.5 6.5 6.5 17.5"],
  grid: ["M3.5 3.5h17v17h-17z", "M9 3.5v17", "M15 3.5v17", "M3.5 9h17", "M3.5 15h17"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  dot: [{ circle: [12, 12, 4] }],
  route: ["M6.5 20V8.5a4 4 0 0 1 4-4h7", "m14 1.5 3.5 3-3.5 3", { circle: [6.5, 20, 1.5] }],
};

const PRIMITIVE_TAGS = { circle: "circle", line: "line" };

export function icon(name, { size = 14, class: className = "" } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);

  const primitives = ICONS[name];
  if (!primitives) return svg; // unknown name → empty icon, never markup
  for (const item of primitives) {
    if (typeof item === "string") {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", item);
      svg.append(path);
      continue;
    }
    for (const [key, values] of Object.entries(item)) {
      const tag = PRIMITIVE_TAGS[key];
      if (!tag) continue;
      const node = document.createElementNS(SVG_NS, tag);
      if (key === "circle") {
        node.setAttribute("cx", String(values[0]));
        node.setAttribute("cy", String(values[1]));
        node.setAttribute("r", String(values[2]));
      } else {
        ["x1", "y1", "x2", "y2"].forEach((attr, index) => node.setAttribute(attr, String(values[index])));
      }
      svg.append(node);
    }
  }
  return svg;
}

// ----------------------------------------------------------------- buttons

export function button(label, onClick, { variant = "", size = "", disabled = false, title = "" } = {}) {
  const classes = ["btn", variant, size].filter(Boolean).join(" ");
  return el("button", { class: classes, type: "button", text: label, disabled, title, onclick: onClick });
}

/** Compact icon button; with a label it renders icon + text. */
export function iconButton(name, onClick, { label = "", title = "", variant = "", size = "small", disabled = false } = {}) {
  const node = button(label, onClick, { title: title || label, variant, size, disabled });
  node.classList.add("icon-btn");
  if (!label) node.classList.add("icon-only");
  node.prepend(icon(name, { size: size === "small" ? 13 : 15 }));
  return node;
}

/**
 * Push-button with an on/off state (toolbar tools, sync, panel toggles).
 * `aria-pressed` carries the state so tests and screen readers agree.
 */
export function toggleButton(name, { label = "", title = "", pressed = false, onChange = null, size = "small" } = {}) {
  const node = button(label, () => setPressed(!isPressed()), { title: title || label, size });
  node.classList.add("icon-btn", "toggle");
  if (!label) node.classList.add("icon-only");
  node.prepend(icon(name, { size: size === "small" ? 13 : 15 }));

  function isPressed() {
    return node.getAttribute("aria-pressed") === "true";
  }
  function setPressed(value) {
    const next = Boolean(value);
    node.setAttribute("aria-pressed", next ? "true" : "false");
    node.classList.toggle("active", next);
    onChange?.(next);
  }
  setPressed(pressed);
  return { node, setPressed, isPressed };
}

export function labelled(labelText, control, hint = "") {
  return el("div", { class: "field" }, [
    el("label", { text: labelText }),
    control,
    hint ? el("span", { class: "hint-line", text: hint }) : null,
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

// ---------------------------------------------------------------- sections

/**
 * Collapsible dock section (the toolbox is a stack of these).
 * Returns a handle so callers can expand it programmatically.
 */
export function createSection({ id, title, iconName = "", badgeText = null, collapsed = false, body }) {
  const chevron = icon("chevronRight", { size: 12, class: "chevron" });
  const head = el("button", {
    class: "section-head",
    type: "button",
    "aria-expanded": collapsed ? "false" : "true",
    "aria-controls": `section-body-${id}`,
    onclick: () => setCollapsed(!collapsedNow()),
  }, [
    chevron,
    iconName ? icon(iconName, { size: 13, class: "section-icon" }) : null,
    el("span", { class: "section-title", text: title }),
    badgeText ? badge(badgeText) : null,
  ]);
  const bodyNode = el("div", { class: "section-body", id: `section-body-${id}` }, body);
  const node = el("section", { class: "section", id: `section-${id}`, dataset: { section: id } }, [head, bodyNode]);

  function collapsedNow() {
    return node.classList.contains("collapsed");
  }
  function setCollapsed(value) {
    node.classList.toggle("collapsed", Boolean(value));
    head.setAttribute("aria-expanded", value ? "false" : "true");
    bodyNode.hidden = Boolean(value);
  }
  setCollapsed(collapsed);

  return { node, head, body: bodyNode, setCollapsed, isCollapsed: collapsedNow, toggle: () => setCollapsed(!collapsedNow()) };
}

/** Titled group of controls inside a section body. */
export function toolGroup(title, children, { actions = [] } = {}) {
  return el("div", { class: "tool-group" }, [
    (title || actions.length)
      ? el("div", { class: "tool-group-head" }, [
        title ? el("span", { class: "tool-group-title", text: title }) : null,
        actions.length ? el("span", { class: "tool-group-actions" }, actions) : null,
      ])
      : null,
    ...children,
  ]);
}

// ------------------------------------------------------------------ menus

/**
 * Menu bar with dropdowns. Items are rebuilt each time a menu opens so the
 * enabled state always reflects the current application state.
 *
 * item: { label, icon, shortcut, disabled, reason, checked, separator, onClick }
 */
export function createMenuBar(menus) {
  const bar = el("nav", { class: "menubar", role: "menubar" });
  const wrappers = [];
  let openWrapper = null;

  function closeAll() {
    if (!openWrapper) return;
    openWrapper.popup.hidden = true;
    openWrapper.button.setAttribute("aria-expanded", "false");
    openWrapper.wrapper.classList.remove("open");
    openWrapper = null;
  }

  function open(wrapper) {
    closeAll();
    setChildren(wrapper.popup, buildItems(wrapper.menu));
    wrapper.popup.hidden = false;
    wrapper.button.setAttribute("aria-expanded", "true");
    wrapper.wrapper.classList.add("open");
    openWrapper = wrapper;
  }

  function buildItems(menu) {
    const items = typeof menu.items === "function" ? menu.items() : menu.items;
    return (items ?? []).map((item) => {
      if (item == null || item.separator) return el("div", { class: "menu-sep", role: "separator" });
      const disabled = Boolean(item.disabled);
      const node = el("button", {
        class: ["menu-item", item.checked ? "checked" : ""].filter(Boolean).join(" "),
        type: "button",
        role: "menuitem",
        disabled,
        title: item.reason || "",
        onclick: () => {
          closeAll();
          item.onClick?.();
        },
      }, [
        icon(item.icon ?? (item.checked ? "check" : "dot"), { size: 13, class: "menu-item-icon" }),
        el("span", { class: "menu-item-label", text: item.label }),
        disabled && item.reason ? el("span", { class: "menu-item-note", text: item.reason }) : null,
        item.shortcut ? el("span", { class: "menu-item-shortcut", text: item.shortcut }) : null,
      ]);
      return node;
    });
  }

  for (const menu of menus) {
    const popup = el("div", { class: "menu-popup", role: "menu", hidden: true, "aria-label": menu.label });
    const button = el("button", {
      class: "menu-button",
      type: "button",
      text: menu.label,
      "aria-haspopup": "true",
      "aria-expanded": "false",
      onclick: (event) => {
        event.stopPropagation();
        if (openWrapper?.menu === menu) closeAll();
        else open({ menu, wrapper: wrapperElement, button, popup });
      },
    });
    const wrapperElement = el("div", { class: "menu-wrapper" }, [button, popup]);
    bar.append(wrapperElement);
    wrappers.push({ menu, wrapper: wrapperElement, button, popup });
  }

  bar.addEventListener("mouseover", (event) => {
    // once a menu is open, hovering a sibling switches to it (desktop behaviour)
    if (!openWrapper) return;
    const hovered = wrappers.find((entry) => entry.wrapper.contains(event.target));
    if (hovered && hovered !== openWrapper) open(hovered);
  });

  document.addEventListener("click", (event) => {
    if (openWrapper && !bar.contains(event.target)) closeAll();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });

  return { node: bar, closeAll, menus: wrappers.map((entry) => entry.menu) };
}

// ------------------------------------------------------------------ toasts

let toastHost = null;

export function toast(message, kind = "", { timeout = 6000 } = {}) {
  if (!toastHost) toastHost = document.getElementById("toasts");
  if (!toastHost) return;
  const node = el("div", { class: ["toast", kind].filter(Boolean).join(" "), text: message });
  toastHost.append(node);
  const remove = () => node.remove();
  if (timeout > 0) setTimeout(remove, timeout);
  node.addEventListener("click", remove);
  return node;
}

// ------------------------------------------------------------- formatting

export function fmtNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(digits).replace(/\.0+$/, "");
}

export function fmtBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtMegapixels(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number.toFixed(2)} MP`;
}

export function fmtPercent(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number.toFixed(digits)}%`;
}

/** One-line description of an image info object from the API. */
export function describeImage(info) {
  if (!info) return "no image";
  const parts = [`${info.width}×${info.height}`, `${info.channels} ch`, fmtMegapixels(info.megapixels)];
  if (info.source) parts.push(String(info.source));
  if (info.bytes) parts.push(fmtBytes(info.bytes));
  if (info.downscaled) parts.push(`downscaled from ${info.original_width}×${info.original_height}`);
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
