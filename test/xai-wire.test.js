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
