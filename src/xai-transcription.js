import { WebSocket } from "ws";

const XAI_STT_URL = "wss://api.x.ai/v1/stt";
const SAMPLE_RATE = 24000;
const DEFAULT_LANGUAGE = "en";
export const DEFAULT_XAI_SMART_TURN_TIMEOUT_MS = 1_200;

export function createXAITranscription({
  sendTranscript,
  queueTranscript,
  options,
  env = process.env,
  createWebSocket = (url, protocols, init) => new WebSocket(url, protocols, init),
  log = console,
}) {
  let socket = null;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let configured = false;
  let pendingAudio = [];
  let transcript = createTranscriptTracker({ sendTranscript, queueTranscript });
  let doneRequested = false;
  let doneSent = false;
  let sessionContext = { keywords: [] };

  function buildURL() {
    const url = new URL(XAI_STT_URL);
    url.searchParams.set("sample_rate", String(SAMPLE_RATE));
    url.searchParams.set("encoding", "pcm");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("language", normalizeLanguage(options.xaiSttLanguage));
    url.searchParams.set("smart_turn", "0.7");
    url.searchParams.set("smart_turn_timeout", String(normalizeSmartTurnTimeoutMs(options.xaiSttSmartTurnTimeoutMs)));
    for (const keyword of normalizeKeywords(sessionContext.keywords)) {
      url.searchParams.append("keyterm", keyword);
    }
    return url.toString();
  }

  function resetSocketState() {
    socket = null;
    readyPromise = null;
    resolveReady = null;
    rejectReady = null;
    configured = false;
    pendingAudio = [];
    doneRequested = false;
    doneSent = false;
    transcript = createTranscriptTracker({ sendTranscript, queueTranscript });
  }

  function detachSocket() {
    if (!socket) return null;
    const previous = socket;
    rejectReady?.(new Error("xAI STT connection was closed."));
    resetSocketState();
    return previous;
  }

  function ensureSocket() {
    if (socket && !doneRequested) return socket;

    if (socket && doneRequested) {
      const previous = detachSocket();
      previous?.close();
    }

    const apiKey = env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error("XAI_API_KEY is required for the xAI transcription provider.");
    }

    const nextSocket = createWebSocket(buildURL(), undefined, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readyPromise.catch(() => {});
    socket = nextSocket;

    nextSocket.on("message", (raw) => {
      if (socket !== nextSocket) return;
      handleSocketMessage(raw.toString("utf8"), {
        sendTranscript,
        transcript,
        onReady: () => {
          if (socket !== nextSocket) return;
          configured = true;
          for (const audio of pendingAudio) nextSocket.send(audio);
          pendingAudio = [];
          if (doneRequested) sendDone();
          resolveReady?.();
        },
      });
    });

    nextSocket.on("error", (error) => {
      if (socket !== nextSocket) return;
      sendTranscript({ type: "error", message: error.message });
      rejectReady?.(error);
    });

    nextSocket.on("close", () => {
      if (socket !== nextSocket) return;
      rejectReady?.(new Error("xAI STT socket closed before it was ready."));
      resetSocketState();
    });

    return socket;
  }

  function sendDone() {
    if (!socket) return;
    doneRequested = true;
    if (!configured || doneSent) return;
    doneSent = true;
    socket.send(JSON.stringify({ type: "audio.done" }));
  }

  return {
    ready: async () => {
      try {
        ensureSocket();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        throw error;
      }
      await readyPromise;
    },
    sendAudio: (audio) => {
      if (!audio) return;
      let connection;
      try {
        connection = ensureSocket();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        return;
      }
      const buffer = Buffer.from(audio, "base64");
      if (!configured) {
        pendingAudio.push(buffer);
        return;
      }
      connection.send(buffer);
    },
    /** @param {{ keywords?: string[] | null }} [ctx] */
    setSessionContext: (ctx) => {
      const next = { keywords: ctx?.keywords ?? [] };
      const unchanged = JSON.stringify(normalizeKeywords(next.keywords)) === JSON.stringify(normalizeKeywords(sessionContext.keywords));
      sessionContext = next;
      if (unchanged) return;
      if (socket) {
        log.debug?.("[xai-transcription] session context changed; reconnecting STT websocket");
        const previous = detachSocket();
        previous?.close();
      }
    },
    stop: () => {
      transcript.flush();
      sendDone();
    },
    close: () => {
      if (!socket) return;
      const previous = detachSocket();
      previous?.close();
    },
  };
}

function handleSocketMessage(line, { sendTranscript, transcript, onReady }) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendTranscript({ type: "error", message: `Invalid xAI STT message: ${line}` });
    return;
  }

  if (message.type === "transcript.created") {
    onReady?.();
    return;
  }

  if (message.type === "transcript.partial") {
    transcript.partial(message);
    return;
  }

  if (message.type === "transcript.done") {
    transcript.done(message);
    return;
  }

  if (message.type === "error") {
    sendTranscript({ type: "error", message: message.message ?? message.error?.message ?? "xAI STT error" });
  }
}

function createTranscriptTracker({ sendTranscript, queueTranscript }) {
  let lastPartial = null;
  const committed = [];
  let completed = false;

  function commit(message) {
    const fullText = typeof message.text === "string" ? message.text.trim() : "";
    if (!fullText) return;
    const range = transcriptRange(message);
    const overlapping = committed.filter((entry) => !range || !entry.range || (
      entry.range.end > range.start + 1e-6 && entry.range.start < range.end - 1e-6
    ));
    let text = fullText;
    if (overlapping.length > 0) {
      if (range && overlapping.some((entry) => entry.range && entry.range.start <= range.start + 1e-6 && entry.range.end >= range.end - 1e-6)) return;
      const words = message.words;
      if (overlapping.every((entry) => entry.range) && Array.isArray(words) && words.length > 0 && words.every((word) => Number.isFinite(word.end))) {
        text = words.filter((word) => !overlapping.some((entry) => (
          word.end > entry.range.start + 1e-6 && word.end <= entry.range.end + 1e-6
        ))).map((word) => word.text).join(" ").trim();
      } else if (range || message.type === "transcript.done") {
        const prefix = overlapping.map((entry) => entry.text).join(" ").replace(/\s+/g, " ");
        const normalized = fullText.replace(/\s+/g, " ");
        const suffix = normalized.slice(prefix.length);
        const boundary = !suffix || /[\s.,!?;:]$/u.test(prefix) || /^[\s.,!?;:]/u.test(suffix);
        text = normalized.startsWith(prefix) && boundary ? suffix.replace(/^[\s.,!?;:]+/u, "") : "";
      } else if (fullText === committed.at(-1)?.text) {
        return;
      }
    }
    if (!text) return;
    committed.push({ text, range });
    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
  }

  return {
    partial: (message) => {
      if (completed) return;
      const text = typeof message.text === "string" ? message.text.trim() : "";
      if (text) {
        lastPartial = message;
        sendTranscript({ type: "transcript:partial", text });
      }
      if (message.speech_final) {
        commit(message);
        lastPartial = null;
      }
    },
    done: (message) => {
      if (completed) return;
      if (message.text != null) commit(message);
      else if (lastPartial) commit(lastPartial);
      lastPartial = null;
      completed = true;
    },
    flush: () => {
      if (lastPartial) commit(lastPartial);
      lastPartial = null;
    },
  };
}

function transcriptRange(message) {
  const start = message.type === "transcript.done" ? 0 : message.start;
  if (!Number.isFinite(start) || !Number.isFinite(message.duration) || message.duration < 0) return null;
  return { start, end: start + message.duration };
}

function normalizeLanguage(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_LANGUAGE;
}

function normalizeSmartTurnTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_XAI_SMART_TURN_TIMEOUT_MS;
  return Math.min(5_000, Math.max(300, Math.round(numeric)));
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .map((keyword) => (typeof keyword === "string" ? keyword.trim() : ""))
    .filter((keyword) => keyword.length > 0)
    .slice(0, 100)
    .map((keyword) => keyword.slice(0, 50));
}
