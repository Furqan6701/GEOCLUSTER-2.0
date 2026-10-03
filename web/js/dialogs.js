/**
 * Small modal dialogs (item 14): Keyboard shortcuts, About, and the New-session
 * confirmation.
 *
 * ONE builder, so the accessibility rules exist in exactly one place:
 *   - role="dialog" + aria-modal="true", labelled by its own heading;
 *   - focus moves into the dialog when it opens and returns to whatever had it
 *     before when it closes;
 *   - Tab / Shift+Tab cycle inside the dialog (focus trap);
 *   - Escape closes it (the same key the floating histogram windows use).
 *
 * The dialogs carry no developer wording: no API address, no port numbers.
 */

import { APP_VERSION, PROJECT_NAME } from "./config.js";
import { button, el, icon } from "./ui.js";

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The one open dialog, if any: { root, dialog, opener, onKey, close }. */
let current = null;

/** True while a dialog is open (a caller may want to swallow a stray key). */
export function isDialogOpen() {
  return current != null;
}

/** Close whatever dialog is open (no-op when none is). */
export function closeDialog(result = null) {
  if (!current) return false;
  const { root, opener, onKey, resolve } = current;
  current = null;
  root.ownerDocument.removeEventListener("keydown", onKey, true);
  root.remove();
  // put the user back where they were — never on <body>
  if (opener && typeof opener.focus === "function" && opener.isConnected !== false) opener.focus();
  resolve?.(result);
  return true;
}

/**
 * Open a dialog. `body` is a node (or a list of nodes), `actions` a list of
 * { label, variant, value, primary, autofocus } — pressing one closes the
 * dialog and resolves with its `value` (true for the primary action).
 *
 * Returns the dialog record; a second call replaces the first dialog, which is
 * what a double-click on a menu item would otherwise do.
 */
export function openDialog({ title, body = [], actions = [], className = "" } = {}) {
  const doc = globalThis.document;
  if (!doc) return null;
  if (current) closeDialog(null);
  const opener = doc.activeElement instanceof globalThis.HTMLElement ? doc.activeElement : null;
  const titleId = `dialog-title-${Math.random().toString(36).slice(2, 8)}`;

  const closeButton = el("button", {
    type: "button", class: "icon-btn dialog-close", "aria-label": "Close this dialog",
    title: "Close (Esc)",
  }, icon("close", { size: 14 }));

  const dialog = el("section", {
    class: ["app-dialog", className].filter(Boolean).join(" "),
    role: "dialog", "aria-modal": "true", "aria-labelledby": titleId,
  }, [
    el("header", { class: "app-dialog-head" }, [
      el("h2", { class: "app-dialog-title", id: titleId, text: title }),
      closeButton,
    ]),
    el("div", { class: "app-dialog-body" }, body),
    actions.length
      ? el("footer", { class: "app-dialog-actions" }, actions.map((action) => {
        const node = button(action.label, () => closeDialog(action.value ?? action.primary === true), {
          size: "small",
          variant: action.primary ? "primary" : "ghost",
          title: action.title ?? undefined,
        });
        if (action.primary) node.dataset.primary = "true";
        return node;
      }))
      : null,
  ]);

  const layer = el("div", { class: "app-dialog-layer" }, [dialog]);
  let resolve = null;
  const promise = new Promise((done) => { resolve = done; });

  const record = { root: layer, dialog, opener, onKey: null, resolve, close: closeDialog, promise };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(null);
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => !node.disabled && node.closest("[hidden]") == null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  record.onKey = onKey;

  layer.addEventListener("mousedown", (event) => {
    if (event.target === layer) closeDialog(null);
  });
  closeButton.addEventListener("click", () => closeDialog(false));
  doc.addEventListener("keydown", onKey, true);
  doc.body.append(layer);
  current = record;

  // focus the primary action (or the first control) so Enter does the obvious
  const target = dialog.querySelector("[data-primary='true']")
    ?? [...dialog.querySelectorAll(FOCUSABLE)].find((node) => !node.disabled)
    ?? dialog;
  if (typeof target.focus === "function") {
    target.focus();
    target.select?.();
  }
  return record;
}

/** A yes/no question. Resolves true only when the primary action was chosen. */
export async function confirmDialog({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  note = "",
} = {}) {
  const body = [
    el("p", { class: "app-dialog-text", text: message }),
    note ? el("p", { class: "app-dialog-note", text: note }) : null,
  ].filter(Boolean);
  const record = openDialog({
    title,
    className: "app-dialog-confirm",
    body,
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, primary: true },
    ],
  });
  if (!record) return false;
  const answer = await record.promise;
  return answer === true;
}

/**
 * Every keyboard shortcut the page really answers to (the Help dialog and the
 * manual checklist both read this table).
 */
export const SHORTCUTS = Object.freeze([
  { keys: "Ctrl+O", label: "Open an image" },
  { keys: "Ctrl+S", label: "Export the current image as PNG" },
  { keys: "Ctrl+Z", label: "Undo" },
  { keys: "Ctrl+Y · Ctrl+Shift+Z", label: "Redo" },
  { keys: "+ · −", label: "Zoom the active viewport in / out" },
  { keys: "0", label: "Fit the image to the active viewport" },
  { keys: "1", label: "Actual size (100%)" },
  { keys: "M", label: "Measure a distance (two clicks; Esc clears)" },
  { keys: "P", label: "Pixel readout under the cursor" },
  { keys: "Y", label: "Synchronise the two viewports" },
  { keys: "Esc", label: "Close a dialog, a histogram window or a measurement" },
  { keys: "Arrow keys", label: "Move / resize a focused histogram window" },
]);

/**
 * The credits the About dialog must carry (item 14). Exact wording, one copy —
 * the logic tests assert these strings directly.
 */
export const CREDITS = Object.freeze([
  "Contains modified Copernicus Sentinel data.",
  "Place search by OpenStreetMap contributors.",
]);

/** The Keyboard shortcuts dialog: a plain two-column list. */
export function showShortcutsDialog() {
  const list = el("dl", { class: "shortcut-list" }, SHORTCUTS.flatMap((entry) => [
    el("dt", { class: "shortcut-keys" }, [el("kbd", { text: entry.keys })]),
    el("dd", { class: "shortcut-what", text: entry.label }),
  ]));
  return openDialog({
    title: "Keyboard shortcuts",
    className: "app-dialog-shortcuts",
    body: [list],
    actions: [{ label: "Close", value: true, primary: true }],
  });
}

/** The About dialog: what this is, its version, and the required credits. */
export function showAboutDialog() {
  const body = [
    el("p", { class: "app-dialog-text", text: `${PROJECT_NAME} — an image processing and land-cover classification workstation for satellite and photo imagery.` }),
    el("p", { class: "app-dialog-version", text: `Version ${APP_VERSION}` }),
    el("ul", { class: "app-dialog-credits" }, CREDITS.map((line) => el("li", { text: line }))),
  ];
  return openDialog({
    title: `About ${PROJECT_NAME}`,
    className: "app-dialog-about",
    body,
    actions: [{ label: "Close", value: true, primary: true }],
  });
}
