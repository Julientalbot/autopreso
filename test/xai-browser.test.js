import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";
import { createSettingsStore } from "../src/settings-store.js";
import { resetXaiModelCatalog } from "../src/xai-models.js";

// Default: deterministic API/STT fixtures, real browser, server and AI SDK.
// Optional manual check: AUTOPRESO_TEST_LIVE_XAI=1, XAI_API_KEY and
// AUTOPRESO_TEST_AUDIO_FILE=/absolute/spoken-command.wav use real xAI APIs.
// AUTOPRESO_TEST_EVIDENCE_DIR saves screenshots and redacted API evidence.
const live = process.env.AUTOPRESO_TEST_LIVE_XAI === "1";
const chromeBin = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const transcript = "Draw three boxes connected from left to right: Speech, Grok, Whiteboard.";
const newModel = live ? (process.env.AUTOPRESO_TEST_MODEL ?? "grok-4.3") : "grok-validation-new";
const newEffort = live ? "none" : "medium";

const elements = [
  { type: "text", id: "title", x: 100, y: 70, text: "Speech to whiteboard", fontSize: 32 },
  ...["Speech", "Grok", "Whiteboard"].map((text, i) => ({
    type: "rectangle", id: `box-${i}`, x: 100 + i * 300, y: 180, width: 220, height: 100,
    backgroundColor: ["#d0ebff", "#e5dbff", "#d3f9d8"][i], fillStyle: "solid",
    label: { text, fontSize: 24 },
  })),
  ...[0, 1].map((i) => ({ type: "arrow", id: `arrow-${i}`, x: 330 + i * 300, y: 230, points: [[0, 0], [60, 0]], endArrowhead: "arrow" })),
];

const catalog = { models: [
  { id: "grok-4.3", prompt_text_token_price: 12500, completion_text_token_price: 25000, capabilities: { reasoning_effort: ["none", "low", "medium", "high", "xhigh"] } },
  { id: "grok-4.7", prompt_text_token_price: 20000, completion_text_token_price: 60000, capabilities: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
  { id: "grok-build-0.1", prompt_text_token_price: 10000, completion_text_token_price: 20000 },
  { id: newModel, prompt_text_token_price: 20000, completion_text_token_price: 30000, capabilities: { reasoning_effort: ["medium", "high"] } },
] };

test(`xAI browser settings to whiteboard (${live ? "live speech and xAI APIs" : "fixture APIs"})`, { timeout: 180_000 }, async (t) => {
  if (!existsSync(chromeBin)) return t.skip("Chrome is not installed; set CHROME_BIN.");
  if (live) {
    assert.ok(process.env.XAI_API_KEY, "live verification requires XAI_API_KEY");
    assert.ok(existsSync(process.env.AUTOPRESO_TEST_AUDIO_FILE ?? ""), "live verification requires a spoken WAV file");
  }
  const temp = await mkdtemp(path.join(tmpdir(), "autopreso-xai-browser-"));
  const evidenceDir = process.env.AUTOPRESO_TEST_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const requests = [];
  const events = [];
  const originalFetch = globalThis.fetch;
  let chrome, cdp, app, fixture;
  let audioFrames = 0;
  t.after(async () => {
    if (cdp && evidenceDir) {
      try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(evidenceDir, `${live ? "live" : "fixture"}-final.png`), Buffer.from(data, "base64"));
        await writeFile(path.join(evidenceDir, `${live ? "live" : "fixture"}-browser-diagnostics.json`), JSON.stringify({ errors: cdp.errors, audioFrames, events, requests }, null, 2));
      } catch (error) {
        t.diagnostic(`Could not capture final browser diagnostics: ${error.message}`);
      }
    }
    cdp?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill();
      await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), sleep(2000)]);
    }
    app?.state.cancelWarmup();
    app?.httpServer.closeAllConnections();
    if (app) await new Promise((resolve) => app.httpServer.close(resolve));
    if (fixture) await new Promise((resolve) => fixture.close(resolve));
    globalThis.fetch = originalFetch;
    resetXaiModelCatalog();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let baseURL = "https://api.x.ai/v1";
  if (!live) {
    fixture = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/language-models") return res.end(JSON.stringify(catalog));
      assert.equal(req.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const isWarmup = JSON.stringify(body.messages.at(-1)).includes("cache warmup");
      const draw = !isWarmup && body.messages.at(-1)?.role !== "tool";
      res.end(JSON.stringify({
        id: "chatcmpl-validation", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: draw ? "tool_calls" : "stop", message: {
          role: "assistant", content: draw ? null : isWarmup ? "UNDERSTOOD" : "DONE",
          ...(draw ? { tool_calls: [{ id: "draw-1", type: "function", function: {
            name: "whiteboard_apply", arguments: JSON.stringify({
              operations: elements.map((element, line) => ({ type: "insert_after", line, element })),
              viewport: { action: "scroll_to_content", focus_ids: elements.map((e) => e.id) },
            }),
          } }] } : {}),
        } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      }));
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${fixture.address().port}/v1`;
  }
  globalThis.fetch = async (url, init) => {
    let request;
    const started = Date.now();
    if (String(url) === `${baseURL}/chat/completions`) {
      const body = JSON.parse(String(init.body));
      request = { model: body.model, reasoning_effort: body.reasoning_effort,
        parallel_tool_calls: body.parallel_tool_calls, tool_choice: body.tool_choice,
        message_roles: body.messages.map((m) => m.role) };
      requests.push(request);
    }
    const response = await originalFetch(url, init);
    if (request) {
      const body = await response.clone().json();
      Object.assign(request, { status: response.status, responseModel: body.model, usage: body.usage, ...(body.error ? { error: body.error } : {}), elapsedMs: Date.now() - started });
    }
    return response;
  };
  const settingsStore = createSettingsStore({ filePath: path.join(temp, "settings.json"), env: {}, readCodexAuth: () => null });
  await settingsStore.save({ agent: { provider: "xai", xai: { baseURL } },
    transcription: { provider: "xai" }, apiKeys: { xai: live ? process.env.XAI_API_KEY : "fixture-key" } });
  app = await startServer({ host: "127.0.0.1", port: 0, settingsStore, env: {}, warmupMaxAttempts: 1, stopDrainMs: live ? 3500 : 50,
    onAgentEvent: (event) => events.push({ type: event.type, transcript: event.transcript, error: event.error }),
    ...(!live ? { createTranscription: ({ sendTranscript, queueTranscript }) => ({
      ready: async () => {}, sendAudio: () => {
        audioFrames += 1;
        if (audioFrames !== 1) return;
        sendTranscript({ type: "transcript", text: transcript, final: true });
        queueTranscript(transcript);
      }, stop() {}, close() {},
    }) } : {}),
  });
  chrome = spawn(chromeBin, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=0", `--user-data-dir=${path.join(temp, "chrome")}`,
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    ...(live ? [`--use-file-for-fake-audio-capture=${process.env.AUTOPRESO_TEST_AUDIO_FILE}%noloop`] : []), "about:blank"], { stdio: "ignore" });
  const port = await waitFor(async () => {
    try { return Number((await readFile(path.join(temp, "chrome", "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { return null; }
  });
  const tabs = await fetch(`http://127.0.0.1:${port}/json`).then((res) => res.json());
  cdp = await connect(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + result.exceptionDetails.exception?.description);
    return result.result?.value;
  };
  const click = async (selector, text) => {
    const point = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}));
    if (!el || el.disabled) throw new Error('Control unavailable: ' + ${JSON.stringify(text)});
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const field = (label) => `([...document.querySelectorAll('.editor .field')].find(e => e.querySelector('.field-label')?.textContent === ${JSON.stringify(label)})?.querySelector('select, input'))`;
  const select = (label, value) => evaluate(`(() => { const el = ${field(label)};
    if (!el || ![...el.options].some(o => o.value === ${JSON.stringify(value)})) throw new Error('Option unavailable: ' + ${JSON.stringify(value)}); el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const snapshot = async (name) => {
    if (!evidenceDir) return;
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(evidenceDir, `${live ? "live" : "fixture"}-${name}.png`), Buffer.from(data, "base64"));
  };
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Browser.grantPermissions", { origin: app.url, permissions: ["audioCapture"] });
  await cdp.send("Page.navigate", { url: app.url });
  await waitFor(() => evaluate("document.body?.innerText.includes('Start Preso') && !!document.querySelector('.excalidraw canvas')"), 40_000);
  await click(".status-row", "Agent");
  await waitFor(() => evaluate(`[${JSON.stringify(newModel)}, "grok-4.7", "grok-build-0.1"].every(id => [...(${field("Model")}?.options ?? [])].some(o => o.value === id))`));
  assert.equal(await evaluate(`${field("Reasoning")}.value`), "none");
  await snapshot("default-none");
  await select("Model", "grok-4.7");
  await waitFor(() => evaluate(`${field("Reasoning")}?.value === 'low'`));
  assert.equal(await evaluate(`[...${field("Reasoning")}.options].some(o => o.value === 'none')`), false);
  await snapshot("clamped-low");
  await select("Model", "grok-build-0.1");
  await waitFor(() => evaluate(`!${field("Reasoning")}`));
  await select("Model", newModel);
  await waitFor(() => evaluate(`${field("Reasoning")}?.value === ${JSON.stringify(newEffort)}`));
  await snapshot("discovered-model");
  await click(".editor button", "Save");
  await waitFor(() => evaluate("!document.querySelector('.editor')"));
  const persisted = JSON.parse(await readFile(path.join(temp, "settings.json"), "utf8"));
  assert.equal(persisted.agent.xai.model, newModel);
  assert.equal(persisted.agent.xai.reasoningEffort, newEffort);
  await evaluate("window.__beforeReload = true");
  await cdp.send("Page.reload");
  await waitFor(() => evaluate("!window.__beforeReload && document.readyState === 'complete'"), 40_000);
  await waitFor(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(newModel)}) && !!document.querySelector('.excalidraw canvas')`), 40_000);
  await click(".controls button", "Start Preso");
  await waitFor(() => evaluate("[...document.querySelectorAll('.controls button')].some(b => b.textContent.includes('Start Talking') && !b.disabled)"), 60_000);
  await click(".controls button", "Start Talking");
  await waitFor(() => evaluate("document.querySelector('.record-toggle')?.textContent.includes('Stop')"), 60_000);
  await waitFor(() => {
    const failure = events.find((e) => e.type === "turn:error");
    if (failure) throw new Error(failure.error);
    return app.state.elements.length > 0 && events.some((e) => e.type === "model:end");
  }, 60_000);
  await click(".controls button", "Stop");
  if (live) await sleep(4000); // Let xAI finish its audio.done response before inspecting the final scene.
  await app.state.idle();
  await waitFor(() => evaluate(`document.querySelector('.cost-card')?.innerText.includes(${JSON.stringify(newModel)})`));
  await sleep(1000); // Allow Excalidraw's viewport animation to finish before capture.
  await snapshot("whiteboard");
  assert.ok(events.some((e) => e.type === "tool:end"));
  assert.ok(requests.length >= 3, "warmup, tool request and follow-up must reach the real SDK transport");
  for (const request of requests) {
    assert.equal(request.model, newModel);
    assert.equal(request.reasoning_effort, newEffort);
    assert.equal(request.parallel_tool_calls, false);
  }
  const cost = app.state.cost.getSummary();
  assert.equal(cost.agent.priced, true);
  assert.ok(cost.agent.cost > 0);
  if (!live) {
    assert.ok(audioFrames > 0, "browser microphone frames must cross the websocket");
    assert.deepEqual(app.state.elements, elements);
  }
  const apiSettings = await fetch(`${app.url}/api/settings`).then((res) => res.json());
  assert.equal("apiKeys" in apiSettings, false);
  if (evidenceDir) await writeFile(path.join(evidenceDir, `${live ? "live" : "fixture"}-session.json`), JSON.stringify({
    mode: live ? "Real xAI STT + agent, prerecorded speech through browser microphone" : "Local catalog/chat fixtures and synthetic STT, real browser + server + AI SDK",
    settings: apiSettings, requests, events, cost, elements: app.state.elements,
    ...(!live ? { expectedAgentCost: requests.length * 0.0023 } : {}),
    modelCatalog: await fetch(`${app.url}/api/agent/xai/models`).then((res) => res.json()),
  }, null, 2));
  if (!live) {
    // Every fixture response bills 1000 input + 100 output tokens. Include
    // the tool-producing step as well as warmup and the final text step.
    assert.equal(cost.agent.cost.toFixed(4), (requests.length * 0.0023).toFixed(4),
      "session cost must include every billed SDK step using catalog prices");
  }
});

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeout} ms: ${check}`);
}
async function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const errors = [];
  let id = 0;
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown" || (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")) errors.push(message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  ws.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Chrome connection closed"));
    }
    pending.clear();
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return {
    errors,
    close: () => ws.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Chrome command timed out: ${method}`));
      }, 15_000);
      pending.set(requestId, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    }),
  };
}
