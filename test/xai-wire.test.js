import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import { createWhiteboardAgentProviderOptions } from "../src/server.js";

// Captures the JSON body @ai-sdk/openai would send to xAI, without network.
async function captureXaiRequestBody(agentProvider) {
  let body = null;
  const xai = createOpenAI({
    name: "xai",
    baseURL: "http://xai.invalid/v1",
    apiKey: "test",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init.body));
      throw new Error("captured");
    },
  });
  await assert.rejects(
    generateText({
      model: xai.chat(agentProvider.model),
      prompt: "hi",
      maxRetries: 0,
      providerOptions: createWhiteboardAgentProviderOptions(agentProvider, "system"),
    }),
  );
  return body;
}

test("xAI requests disable parallel tool calls on the wire", async () => {
  const body = await captureXaiRequestBody({ provider: "xai", model: "grok-4.3" });
  assert.equal(body.parallel_tool_calls, false);
});

test("grok-4.3 requests send reasoning_effort none", async () => {
  const body = await captureXaiRequestBody({ provider: "xai", model: "grok-4.3", reasoningEffort: "none" });
  assert.equal(body.reasoning_effort, "none");
});

test("grok-4.7 requests send the nearest supported effort instead of none", async () => {
  const body = await captureXaiRequestBody({ provider: "xai", model: "grok-4.7", reasoningEffort: "none" });
  assert.equal(body.reasoning_effort, "low");
});

test("grok-build-0.1 requests omit reasoning_effort", async () => {
  const body = await captureXaiRequestBody({ provider: "xai", model: "grok-build-0.1", reasoningEffort: "none" });
  assert.equal("reasoning_effort" in body, false);
});
