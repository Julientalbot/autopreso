// @ts-nocheck - hand-rolled EventEmitter is used as a fake WebSocket; structural types fight here.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createXAITranscription } from "../src/xai-transcription.js";

function createMockSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.closed = false;
  socket.send = (data) => {
    socket.sent.push(data);
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit("close");
  };
  return socket;
}

test("createXAITranscription opens a streaming STT websocket with bearer auth and language", async () => {
  const socket = createMockSocket();
  const calls = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    log: { debug: () => {} },
    createWebSocket: (url, protocols, init) => {
      calls.push({ url, protocols, init });
      return socket;
    },
  });

  const readyPromise = transcription.ready();
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  await readyPromise;

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "wss://api.x.ai/v1/stt");
  assert.equal(url.searchParams.get("sample_rate"), "24000");
  assert.equal(url.searchParams.get("encoding"), "pcm");
  assert.equal(url.searchParams.get("interim_results"), "true");
  assert.equal(url.searchParams.get("language"), "fr");
  assert.equal(url.searchParams.get("smart_turn_timeout"), "1200");
  assert.equal(calls[0].init.headers.Authorization, "Bearer xai-test");
});

test("createXAITranscription lets xAI smart turn timeout be tuned", async () => {
  const socket = createMockSocket();
  const calls = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr", xaiSttSmartTurnTimeoutMs: 800 },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: (url, protocols, init) => {
      calls.push({ url, protocols, init });
      return socket;
    },
  });

  const readyPromise = transcription.ready();
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  await readyPromise;

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("smart_turn_timeout"), "800");
});

test("createXAITranscription sends raw PCM bytes instead of base64 text frames", () => {
  const socket = createMockSocket();
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "en" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio(Buffer.from([1, 2, 3, 4]).toString("base64"));
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));

  assert.equal(socket.sent.length, 1);
  assert.ok(Buffer.isBuffer(socket.sent[0]));
  assert.deepEqual([...socket.sent[0]], [1, 2, 3, 4]);
});

test("createXAITranscription maps partial and final speech-final events into app transcripts", () => {
  const socket = createMockSocket();
  const messages = [];
  const queued = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "Bonjour",
    is_final: false,
    speech_final: false,
  }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "Bonjour tout le monde",
    is_final: true,
    speech_final: true,
  }));

  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "Bonjour" },
    { type: "transcript:partial", text: "Bonjour tout le monde" },
    { type: "transcript:committed", text: "Bonjour tout le monde" },
  ]);
  assert.deepEqual(queued, ["Bonjour tout le monde"]);
});

test("createXAITranscription does not commit xAI chunk-final partials until speech-final", () => {
  const socket = createMockSocket();
  const messages = [];
  const queued = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "Bonjour",
    is_final: true,
    speech_final: false,
  }));

  assert.deepEqual(messages, [
    { type: "transcript:partial", text: "Bonjour" },
  ]);
  assert.deepEqual(queued, []);
});

test("createXAITranscription stop sends audio.done and flushes the last partial once", () => {
  const socket = createMockSocket();
  const messages = [];
  const queued = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { xaiSttLanguage: "en" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  transcription.sendAudio("a");
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  socket.emit("message", JSON.stringify({
    type: "transcript.partial",
    text: "final words",
    is_final: false,
    speech_final: false,
  }));
  transcription.stop();
  transcription.stop();

  assert.deepEqual(
    socket.sent.filter((item) => typeof item === "string").map((item) => JSON.parse(item)),
    [{ type: "audio.done" }],
  );
  assert.deepEqual(queued, ["final words"]);
  assert.deepEqual(messages.at(-1), { type: "transcript:committed", text: "final words" });
});

test("createXAITranscription sends session keywords as xAI keyterms and reconnects when they change", () => {
  const sockets = [];
  const calls = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    log: { debug: () => {} },
    createWebSocket: (url, protocols, init) => {
      const socket = createMockSocket();
      sockets.push(socket);
      calls.push({ url, protocols, init });
      return socket;
    },
  });

  transcription.setSessionContext({ keywords: ["Kafka", "", "  Avro  "] });
  transcription.sendAudio(Buffer.from([1]).toString("base64"));

  assert.deepEqual(new URL(calls[0].url).searchParams.getAll("keyterm"), ["Kafka", "Avro"]);

  sockets[0].emit("open");
  sockets[0].emit("message", JSON.stringify({ type: "transcript.created" }));
  transcription.setSessionContext({ keywords: ["Kafka", "gRPC"] });
  transcription.sendAudio(Buffer.from([2]).toString("base64"));

  assert.equal(sockets[0].closed, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(new URL(calls[1].url).searchParams.getAll("keyterm"), ["Kafka", "gRPC"]);
});

test("createXAITranscription opens a fresh websocket for audio after stop", () => {
  const sockets = [];
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "en" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => {
      const socket = createMockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  transcription.sendAudio(Buffer.from([1]).toString("base64"));
  sockets[0].emit("open");
  sockets[0].emit("message", JSON.stringify({ type: "transcript.created" }));
  transcription.stop();
  transcription.sendAudio(Buffer.from([2]).toString("base64"));
  sockets[1].emit("open");
  sockets[1].emit("message", JSON.stringify({ type: "transcript.created" }));

  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  assert.deepEqual([...sockets[1].sent[0]], [2]);
});

test("createXAITranscription waits for transcript.created before flushing pending audio", async () => {
  const socket = createMockSocket();
  const transcription = createXAITranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: { xaiSttLanguage: "fr" },
    env: { XAI_API_KEY: "xai-test" },
    createWebSocket: () => socket,
  });

  const readyPromise = transcription.ready();
  transcription.sendAudio(Buffer.from([9]).toString("base64"));
  socket.emit("open");

  assert.equal(socket.sent.length, 0);

  socket.emit("message", JSON.stringify({ type: "transcript.created" }));
  await readyPromise;

  assert.equal(socket.sent.length, 1);
  assert.deepEqual([...socket.sent[0]], [9]);
});

test("createXAITranscription reports missing API key without throwing from sendAudio", () => {
  const messages = [];
  const transcription = createXAITranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: () => {},
    options: { xaiSttLanguage: "en" },
    env: {},
  });

  transcription.sendAudio("a");

  assert.deepEqual(messages, [
    { type: "error", message: "XAI_API_KEY is required for the xAI transcription provider." },
  ]);
});

function createTranscriptionHarness() {
  const sockets = [];
  const messages = [];
  const queued = [];
  const transcription = createXAITranscription({
    sendTranscript: (message) => messages.push(message),
    queueTranscript: (text) => queued.push(text),
    options: {},
    env: { XAI_API_KEY: "xai-test" },
    log: { debug: () => {} },
    createWebSocket: () => {
      const socket = createMockSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const emit = (message) => sockets.at(-1).emit("message", JSON.stringify(message));
  return { transcription, sockets, messages, queued, emit };
}

for (const reconnect of ["stop", "keywords"]) {
  for (const failure of ["error", "close"]) {
    test(`audio-triggered reconnect handles ${failure} after ${reconnect}`, async () => {
      const { transcription, sockets, messages, emit } = createTranscriptionHarness();
      transcription.sendAudio("YQ==");
      emit({ type: "transcript.created" });
      if (reconnect === "stop") transcription.stop();
      else transcription.setSessionContext({ keywords: ["Kafka"] });
      transcription.sendAudio("Yg==");
      sockets.at(-1).emit(failure, new Error("connection failed"));
      await new Promise((resolve) => setImmediate(resolve));
      if (failure === "error") assert.equal(messages.at(-1).message, "connection failed");
      transcription.close();
    });
  }
}

test("ready still rejects when connection fails", async () => {
  const { transcription, sockets } = createTranscriptionHarness();
  const ready = transcription.ready();
  const rejected = assert.rejects(ready, /connection failed/);
  sockets[0].emit("error", new Error("connection failed"));
  await rejected;
  transcription.close();
});

test("stop before readiness sends buffered audio then audio.done exactly once", async () => {
  const { transcription, sockets, emit } = createTranscriptionHarness();
  const ready = transcription.ready();
  transcription.sendAudio("YQ==");
  transcription.sendAudio("Yg==");
  transcription.stop();
  transcription.stop();
  assert.deepEqual(sockets[0].sent, []);
  emit({ type: "transcript.created" });
  await ready;
  assert.deepEqual(sockets[0].sent, [Buffer.from("a"), Buffer.from("b"), JSON.stringify({ type: "audio.done" })]);
  transcription.stop();
  assert.equal(sockets[0].sent.length, 3);
  transcription.sendAudio("Yw==");
  assert.equal(sockets.length, 2);
  emit({ type: "transcript.created" });
  assert.deepEqual(sockets[1].sent, [Buffer.from("c")]);
  transcription.close();
});

test("audio resumed before readiness does not reuse a stopped connection", () => {
  const { transcription, sockets, emit } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  transcription.stop();
  transcription.sendAudio("Yg==");
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true);
  emit({ type: "transcript.created" });
  assert.deepEqual(sockets[1].sent, [Buffer.from("b")]);
  transcription.close();
});

function utterance(text, start, duration, speech_final = true) {
  return { type: "transcript.partial", text, start, duration, is_final: speech_final, speech_final };
}

for (const words of [undefined, [
  { text: "First.", start: 0, end: 1 },
  { text: "Second.", start: 2, end: 3 },
]]) {
  test(`done does not replay committed utterances ${words ? "with" : "without"} words`, () => {
    const { transcription, emit, queued } = createTranscriptionHarness();
    transcription.sendAudio("YQ==");
    emit({ type: "transcript.created" });
    emit(utterance("First.", 0, 1));
    emit(utterance("Second.", 2, 1));
    transcription.stop();
    emit({ type: "transcript.done", text: "First. Second.", duration: 4, words });
    assert.deepEqual(queued, ["First.", "Second."]);
    transcription.close();
  });
}

test("separate utterances with identical text commit once per audio range", () => {
  const { transcription, emit, queued } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  emit({ type: "transcript.created" });
  emit(utterance("Zoom in", 0, 1));
  emit(utterance("Zoom in", 0, 1));
  emit(utterance("Zoom in", 2, 1));
  emit(utterance("Zoom in", 2, 1));
  transcription.stop();
  emit({ type: "transcript.done", text: "Zoom in Zoom in", duration: 3 });
  assert.deepEqual(queued, ["Zoom in", "Zoom in"]);
  transcription.close();
});

test("stop flush uses the new partial's range even when its text repeats", () => {
  const { transcription, emit, queued } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  emit({ type: "transcript.created" });
  emit(utterance("Zoom in", 0, 1));
  emit(utterance("Zoom in", 2, 1, false));
  transcription.stop();
  transcription.stop();
  emit(utterance("Zoom in", 2, 1));
  emit({ type: "transcript.done", text: "Zoom in Zoom in", duration: 3 });
  assert.deepEqual(queued, ["Zoom in", "Zoom in"]);
  transcription.close();
});

for (const words of [undefined, [
  { text: "First.", start: 0, end: 1 },
  { text: "Second.", start: 2, end: 3 },
  { text: "Tail.", start: 4, end: 5 },
]]) {
  test(`done commits only the uncommitted tail ${words ? "with" : "without"} words`, () => {
    const { transcription, emit, queued } = createTranscriptionHarness();
    transcription.sendAudio("YQ==");
    emit({ type: "transcript.created" });
    emit(utterance("First.", 0, 1));
    emit(utterance("Second.", 2, 1, false));
    transcription.stop();
    emit({ type: "transcript.done", text: "First. Second. Tail.", duration: 5, words });
    emit({ type: "transcript.done", text: "First. Second. Tail.", duration: 5, words });
    assert.deepEqual(queued, ["First.", "Second.", "Tail."]);
    transcription.close();
  });
}

test("done uses audio ranges when final text revises committed wording", () => {
  const { transcription, emit, queued } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  emit({ type: "transcript.created" });
  emit(utterance("forty two", 0, 1));
  transcription.stop();
  emit({ type: "transcript.done", text: "42. Next.", duration: 3, words: [
    { text: "42.", start: 0, end: 1 },
    { text: "Next.", start: 2, end: 3 },
  ] });
  assert.deepEqual(queued, ["forty two", "Next."]);
  transcription.close();
});

test("done recovers uncommitted words before a later committed range", () => {
  const { transcription, emit, queued } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  emit({ type: "transcript.created" });
  emit(utterance("First.", 0, 1, false));
  emit(utterance("Second.", 2, 1));
  transcription.stop();
  emit({ type: "transcript.done", text: "First. Second.", duration: 3, words: [
    { text: "First.", start: 0, end: 1 },
    { text: "Second.", start: 2, end: 3 },
  ] });
  assert.deepEqual(queued, ["Second.", "First."]);
  transcription.close();
});

test("new socket resets committed ranges and ignores late events from the old socket", () => {
  const { transcription, sockets, emit, queued } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  emit({ type: "transcript.created" });
  emit(utterance("Zoom in", 0, 1));
  transcription.stop();
  transcription.sendAudio("Yg==");
  sockets[0].emit("message", JSON.stringify({ type: "transcript.done", text: "Zoom in Old tail", duration: 3 }));
  emit({ type: "transcript.created" });
  emit(utterance("Zoom in", 0, 1));
  assert.deepEqual(queued, ["Zoom in", "Zoom in"]);
  transcription.close();
});

test("closing a connecting socket settles callers waiting on ready", async () => {
  const { transcription } = createTranscriptionHarness();
  const ready = transcription.ready();
  const rejection = assert.rejects(ready, /connection was closed/);
  transcription.close();
  await rejection;
});

test("done without word timing does not split a revised word into a command", () => {
  const { transcription, emit, queued } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  emit({ type: "transcript.created" });
  emit(utterance("car", 0, 1));
  transcription.stop();
  emit({ type: "transcript.done", text: "cartwheel", duration: 2 });
  assert.deepEqual(queued, ["car"]);
  transcription.close();
});

test("done without prior commits delivers the full transcript once", () => {
  const { transcription, emit, queued } = createTranscriptionHarness();
  transcription.sendAudio("YQ==");
  emit({ type: "transcript.created" });
  transcription.stop();
  emit({ type: "transcript.done", text: "Zoom in", duration: 1 });
  emit({ type: "transcript.done", text: "Zoom in", duration: 1 });
  assert.deepEqual(queued, ["Zoom in"]);
  transcription.close();
});
