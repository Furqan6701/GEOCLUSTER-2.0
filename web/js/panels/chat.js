/**
 * Assistant dock: the AI assistant plus the rule-based router commands.
 *
 * Rendering rules (deliberate):
 *   - replies are inserted with textContent, so LaTeX like \[ ... \] shows up
 *     as plain text and is never interpreted;
 *   - a 502 from the provider becomes a friendly message, not a raw error;
 *   - router commands are executed even when there is no model reply, because
 *     "Show me F-8 imagery" and friends need no language model at all.
 *
 * One message can now carry a reply AND one action the model chose. It
 * is executed through the same handler the matching UI control uses (the
 * Filters panel's slider commit, the Clusters panel's Run K-Means/Generate map
 * buttons, the View menu's zoom entries, the toolbar's Measure toggle), so the
 * undo history, the result viewport and the toasts behave as if the user had
 * clicked it. The app state (image loaded, K-Means result, undo/redo) is sent
 * with every message so the model can ask instead of guessing, and an action
 * that needs an image is refused here when there is none.
 *
 * The dock is compact on purpose: the image workspace keeps priority, and the
 * conversation scrolls inside its own column.
 */

import { ApiError, humanizeError } from "../errors.js";
import { activeImage } from "../state.js";
import { describeCommand, executeCommands } from "../commands.js";
import { button, el } from "../ui.js";

const HINTS = [
  { label: "What does Mean filter do?", text: "What does the mean filter do?" },
  { label: "Histogram", text: "Show histogram" },
  { label: "K-Means", text: "Run k-means" },
  { label: "Satellite", text: "Show me F-8 imagery" },
];

/**
 * The app state the model is allowed to rely on (never coordinates): the app
 * shell owns it (`ctx.appState`, set in app.js) and the chat only forwards it.
 */
function appState(ctx, state) {
  if (typeof ctx.appState === "function") return ctx.appState();
  return {
    has_image: Boolean(activeImage(state)),
    has_clusters: Boolean(state.kmeans),
    has_history: Boolean(state.original || state.result || state.kmeans),
    can_undo: false,
    can_redo: false,
  };
}

export function createChatPanel(ctx) {
  const { api, session, bus, state } = ctx;

  const log = el("div", { class: "chat-log" });
  const input = el("textarea", {
    rows: 1,
    placeholder: "Ask a question or type a command…",
    "aria-label": "Message",
  });
  const sendButton = button("Send", () => send(), { variant: "primary" });
  const form = el("form", { class: "chat-form" }, [input, sendButton]);

  let sending = false;

  function append(role, text) {
    const bubble = el("div", { class: `bubble ${role}`, text: String(text ?? "") });
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function setSending(value) {
    sending = value;
    sendButton.disabled = value;
    sendButton.textContent = value ? "…" : "Send";
  }

  async function send() {
    const message = input.value.trim();
    if (!message || sending) return;
    input.value = "";
    append("user", message);
    const thinking = append("assistant", "…");
    setSending(true);
    try {
      const response = await api.chat(message, appState(ctx, state));
      thinking.remove();
      const reply = response?.reply ?? "";
      const commands = Array.isArray(response?.commands) ? response.commands : [];
      const fromModel = Boolean(response?.action);

      if (reply) append("assistant", reply);
      if (commands.length) {
        append("system", `${fromModel ? "Action" : "Router"} → ${commands.map(describeCommand).join("; ")}`);
        const notes = await executeCommands(commands, handlers);
        for (const note of notes) append("system", note);
      }
      if (!reply && !commands.length) append("assistant", "(the assistant returned an empty reply)");
    } catch (error) {
      thinking.remove();
      append("error", friendlyChatError(error));
    } finally {
      setSending(false);
      input.focus();
    }
  }

  function friendlyChatError(error) {
    if (error instanceof ApiError) {
      if (error.status === 502) {
        return (
          "The AI assistant is unavailable right now (the provider returned an error). " +
          'Commands that do not need the model still work - try "Show me F-8 imagery" or "Run k-means".'
        );
      }
      if (error.status === 503) {
        return (
          "The AI assistant is not configured on this server (no API key). " +
          'Router commands still work without it - try "Show me F-8 imagery", "Histogram" or "Compress this image".'
        );
      }
      if (error.status === 429) {
        return "Too many chat requests - wait a minute and try again.";
      }
    }
    return humanizeError(error, { apiBase: ctx.api.base });
  }

  // ------------------------------------------------------------- command plumbing
  /** The shared UI entry points (the very functions the menus/toolbar use). */
  function ui() {
    return ctx.uiActions ?? {};
  }

  function requireImage(what) {
    if (!activeImage(state)) throw new Error(`no image loaded - upload or fetch one first (${what})`);
  }

  const handlers = {
    /**
     * Point operations go through the Filters panel's dispatcher, exactly like
     * the buttons; the three slider-driven operations go through the slider's own
     * commit, so the panel shows the value that was applied and the undo history
     * gets the same single step a slider release would create.
     */
    async runOperation(operation, params) {
      const filters = ctx.panels?.get?.("filters");
      if (filters) {
        const slider = filters.actions.isSliderOperation?.(operation);
        if (slider && params && typeof filters.actions.commit === "function") {
          filters.actions.revealParams?.(operation);
          const outcome = await filters.actions.commit(operation, sliderValue(operation, params));
          if (outcome?.ok === false && outcome.reason === "no-image") {
            throw new Error("no image loaded - upload or fetch one first");
          }
          return;
        }
        const outcome = await filters.actions.run(operation, params);
        if (outcome?.ok === false && outcome.reason === "no-image") {
          throw new Error("no image loaded - upload or fetch one first");
        }
        return;
      }
      requireImage(operation);
      const active = activeImage(state);
      const info = await session.withSession((sid) => api.runOperation(sid, active.id, operation, params));
      session.useAsResult(info);
    },
    async runKMeans(k) {
      const clusters = ctx.panels?.get?.("clusters");
      if (!clusters?.actions?.runKMeans) {
        requireImage("K-Means");
        throw new Error("the Clusters panel is unavailable");
      }
      requireImage("K-Means");
      // the panel's own button path; a K in the command is written into the
      // panel's field first, exactly as if the user had typed it there
      const outcome = await clusters.actions.runKMeans(k);
      if (outcome?.ok === false) throw new Error(outcome.reason ?? "K-Means could not run");
    },
    async classifyClusters() {
      const clusters = ctx.panels?.get?.("clusters");
      if (!clusters?.actions?.classify) {
        throw new Error("the Clusters panel is unavailable");
      }
      if (!state.kmeans) throw new Error("run K-Means first so there are ranges to classify");
      const outcome = await clusters.actions.classify();
      if (outcome?.ok === false) throw new Error(outcome.reason ?? "the classification could not run");
    },
    async openMapComposer() {
      requireImage("map composer");
      const action = ui().openMapComposer;
      if (!action) throw new Error("the map composer is unavailable");
      await action();
    },
    async openHistogram() {
      requireImage("histogram");
      bus.emit("histogram:request");
    },
    async openCompress() {
      requireImage("compression");
      bus.emit("huffman:compress-request");
    },
    async openDistance() {
      requireImage("distance tool");
      bus.emit("distance:request");
    },
    async exportPng() {
      requireImage("export");
      await callUi("exportPng");
    },
    async exportLabelMap() {
      requireImage("export");
      if (!state.kmeans) throw new Error("run K-Means first - the label map comes from it");
      await callUi("exportLabelMap");
    },
    async undo() {
      await callUi("undo");
    },
    async redo() {
      await callUi("redo");
    },
    async clearResult() {
      await callUi("clearResult");
    },
    async fitView() {
      requireImage("zoom");
      await callUi("fitView");
    },
    async actualSize() {
      requireImage("zoom");
      await callUi("actualSize");
    },
    async zoomIn() {
      requireImage("zoom");
      await callUi("zoomIn");
    },
    async zoomOut() {
      requireImage("zoom");
      await callUi("zoomOut");
    },
    async fetchSatellite(location) {
      const name = String(location ?? "").trim();
      if (!name) throw new Error("the command did not include a location");
      const info = await session.fetchSatellite({ location: name });
      bus.emit("satellite:fetched", { location: name, info });
    },
    describeError(error) {
      return humanizeError(error, { apiBase: api.base });
    },
  };

  async function callUi(name) {
    const action = ui()[name];
    if (!action) throw new Error("that control is not available in this window");
    await action();
  }

  // ------------------------------------------------------------------ markup
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  const hintRow = el("div", { class: "chat-hints" },
    HINTS.map((hint) =>
      button(hint.label, () => {
        input.value = hint.text;
        send();
      }, { size: "small", variant: "ghost", title: hint.text }),
    ),
  );

  append(
    "assistant",
    "Ask me what any tool does - for example \"What is the mean filter?\" or " +
      "\"How do I use threshold?\" - and I will answer in plain text, even when the " +
      "AI service is busy. I can also run the tools for you (filters, K-Means, zoom, " +
      "exports): try \"Run k-means with 6 clusters\", \"Smooth this image with a 5 by 5 " +
      "mean filter\" or \"Show me F-8 imagery\".",
  );

  const node = el("div", { class: "assistant" }, [log, hintRow, form]);
  return { node, send, append, handlers };
}

/** The slider value a command's parameters carry. */
function sliderValue(operation, params) {
  return operation === "meanfilter" ? params.window : params.value;
}
