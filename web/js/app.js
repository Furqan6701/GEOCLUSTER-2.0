/**
 * Application bootstrap: wires the API client, session manager, viewers,
 * sidebar panels and the status chips together.
 *
 * Serve this folder on http://localhost:5173 (see web/README.md) so the API's
 * ALLOWED_ORIGINS accepts the browser's requests.
 */

import { ApiClient } from "./api.js";
import { resolveApiBase } from "./config.js";
import { ApiError, humanizeError } from "./errors.js";
import { createChatPanel } from "./panels/chat.js";
import { createPanels } from "./panels/index.js";
import { SessionExpiredError, SessionManager } from "./session.js";
import { createAppState, createBus } from "./state.js";
import { chip, el, setChildren, toast } from "./ui.js";
import { Viewer } from "./viewer.js";

// ------------------------------------------------------------------- context
const apiBase = resolveApiBase({
  search: window.location.search,
  storage: window.localStorage,
  hostname: window.location.hostname,
});
const state = createAppState();
state.apiBase = apiBase;
const bus = createBus();
const api = new ApiClient({ base: apiBase });
const session = new SessionManager({ api, state, bus });
const ctx = { api, session, state, bus, apiBase };

// ------------------------------------------------------------------- viewers
const originalViewer = new Viewer(document.getElementById("viewer-original"), {
  title: "Original",
  role: "original",
  bus,
});
const resultViewer = new Viewer(document.getElementById("viewer-result"), {
  title: "Result",
  role: "result",
  bus,
});

const loadTokens = { original: 0, result: 0 };

async function showImage(role, info) {
  const viewer = role === "original" ? originalViewer : resultViewer;
  const token = ++loadTokens[role];
  try {
    const blob = await session.imageBlob(info.image_id);
    if (token !== loadTokens[role]) return; // a newer image replaced this one
    const source = info.source === "satellite" ? "satellite" : info.source;
    await viewer.setBlob(blob, `${source} · ${info.width}×${info.height}`);
  } catch (error) {
    if (token !== loadTokens[role]) return;
    report(error, "Could not display the image");
  }
}

bus.on("image:loaded", ({ role, info }) => {
  showImage(role, info);
});

bus.on("image:cleared", ({ role }) => {
  loadTokens[role] += 1;
  (role === "original" ? originalViewer : resultViewer).clear();
});

bus.on("session:reset", () => {
  loadTokens.original += 1;
  loadTokens.result += 1;
  originalViewer.clear();
  resultViewer.clear();
});

bus.on("viewer:distance", ({ text }) => {
  toast(text, "", { timeout: 9000 });
});

bus.on("viewer:distance-mode", ({ enabled, role }) => {
  if (enabled) toast(`Distance tool on the ${role} viewer — click two points (Esc clears).`, "", { timeout: 6000 });
});

bus.on("distance:request", () => {
  resultViewer.hasImage ? resultViewer.toggleDistance(true) : originalViewer.toggleDistance(true);
});

bus.on("histogram:request", () => selectTab("analysis"));

// -------------------------------------------------------------- tabs/panels
const tabsHost = document.getElementById("tabs");
const panelsHost = document.getElementById("tabpanels");
const panels = createPanels(ctx);
const tabButtons = new Map();

function selectTab(id) {
  for (const [tabId, button] of tabButtons) {
    const selected = tabId === id;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.node.hidden = panel.id !== id;
  }
  // the chat column scrolls itself; the sidebar keeps its scroll position
  return true;
}

for (const panel of panels) {
  const button = el("button", {
    class: "tab",
    type: "button",
    role: "tab",
    text: panel.label,
    "aria-selected": "false",
    onclick: () => selectTab(panel.id),
  });
  tabButtons.set(panel.id, button);
  tabsHost.append(button);
  panelsHost.append(panel.node);
}
selectTab(panels[0].id);

// -------------------------------------------------------------------- chat
document.getElementById("chat-column").append(createChatPanel(ctx));

// ------------------------------------------------------------------- chips
const chipHost = document.getElementById("status-chips");

function renderChips() {
  const nodes = [];
  nodes.push(chip(`API ${apiBase}`, "", "The API base URL this page was built with"));
  if (state.sessionId) {
    nodes.push(chip(`session ${state.sessionId.slice(0, 8)}… · ${state.ttlMinutes ?? "?"} min`, "", `Max ${state.maxImages ?? "?"} images per session`));
  } else {
    nodes.push(chip("session —", "warn", "No session yet"));
  }
  const health = state.health;
  if (health) {
    nodes.push(
      chip(
        `AI ${health.ai_configured ? "ready" : "not configured"}`,
        health.ai_configured ? "ok" : "warn",
        "FIREWORKS_API_KEY on the server",
      ),
    );
    nodes.push(
      chip(
        `Satellite ${health.satellite_configured ? "ready" : "not configured"}`,
        health.satellite_configured ? "ok" : "warn",
        "Copernicus credentials on the server",
      ),
    );
    nodes.push(chip(`max ${health.max_image_megapixels} MP`, "", "MAX_IMAGE_MEGAPIXELS"));
  } else {
    nodes.push(chip("API unreachable", "bad", "Could not reach GET /health"));
  }
  setChildren(chipHost, nodes);
}

// ------------------------------------------------------------------ banner
const banner = document.getElementById("banner");

function setBanner(message, kind = "") {
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${kind}`.trim();
  banner.textContent = message;
}

function report(error, prefix) {
  if (error instanceof SessionExpiredError) {
    toast(error.message, "warn", { timeout: 15000 });
    return;
  }
  if (error instanceof ApiError && error.isNetwork) {
    setBanner(humanizeError(error, { apiBase }), "bad");
  }
  toast(`${prefix}: ${humanizeError(error, { apiBase })}`, "bad", { timeout: 12000 });
}

// ------------------------------------------------------------- session ops
document.getElementById("new-session").addEventListener("click", async () => {
  try {
    await session.restart();
    toast("New session started — upload your image again.", "ok");
    renderChips();
  } catch (error) {
    report(error, "Could not start a session");
  }
});

bus.on("session", () => renderChips());
bus.on("health", () => renderChips());
bus.on("busy", () => renderChips());

// -------------------------------------------------------------- bootstrap
async function bootstrap() {
  renderChips();
  try {
    await session.refreshHealth();
    setBanner("");
  } catch (error) {
    setBanner(humanizeError(error, { apiBase }), "bad");
  }
  try {
    await session.ensure();
  } catch (error) {
    report(error, "Could not start a session");
  }
  renderChips();
}

bootstrap();

// expose a tiny debug handle (no secrets involved)
window.geocluster = { api, session, state, bus, selectTab };
