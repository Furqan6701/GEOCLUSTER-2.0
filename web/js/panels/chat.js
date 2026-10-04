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
      const response = await api.chat(message);
      thinking.remove();
      const reply = response?.reply ?? "";
      const commands = Array.isArray(response?.commands) ? response.commands : [];

      if (reply) append("assistant", reply);
      if (commands.length) {
        append("system", `Router → ${commands.map(describeCommand).join("; ")}`);
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
          'Commands that do not need the model still work — try "Show me F-8 imagery" or "Run k-means".'
        );
      }
      if (error.status === 503) {
        return (
          "The AI assistant is not configured on this server (no API key). " +
          'Router commands still work without it — try "Show me F-8 imagery", "Histogram" or "Compress this image".'
        );
      }
      if (error.status === 429) {
        return "Too many chat requests — wait a minute and try again.";
      }
    }
    return humanizeError(error, { apiBase: ctx.api.base });
  }

  // ------------------------------------------------------------- command plumbing
  const handlers = {
    async runOperation(operation, params) {
      // Same dispatcher as the Filters panel and the Processing menu, so the
      // chat gets identical parameters, feedback and error handling.
      const filters = ctx.panels?.get?.("filters");
      if (filters) {
        const outcome = await filters.actions.run(operation, params);
        if (outcome?.ok === false && outcome.reason === "no-image") {
          throw new Error("no image loaded — upload or fetch one first");
        }
        return;
      }
      const active = activeImage(state);
      if (!active) throw new Error("no image loaded — upload or fetch one first");
      const info = await session.withSession((sid) => api.runOperation(sid, active.id, operation, params));
      session.useAsResult(info);
    },
    async fetchSatellite(location) {
      const name = String(location ?? "").trim();
      if (!name) throw new Error("the command did not include a location");
      const info = await session.fetchSatellite({ location: name });
      bus.emit("satellite:fetched", { location: name, info });
    },
    async openHistogram() {
      bus.emit("histogram:request");
    },
    async openCompress() {
      bus.emit("huffman:compress-request");
    },
    async openDistance() {
      bus.emit("distance:request");
    },
    describeError(error) {
      return humanizeError(error, { apiBase: api.base });
    },
  };

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
    "Ask me what any tool does — for example \"What is the mean filter?\" or " +
      "\"How do I use threshold?\" — and I will answer in plain text, even when the " +
      "AI service is busy. I can also run commands and answer GIS questions: " +
      'try "Show me F-8 imagery", "Run k-means" or "Compress this image".',
  );

  const node = el("div", { class: "assistant" }, [log, hintRow, form]);
  return { node, send, append };
}
