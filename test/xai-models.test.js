import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  findXaiModel,
  getXaiModelCatalog,
  parseXaiLanguageModels,
  refreshXaiModelCatalog,
  resetXaiModelCatalog,
  resolveXaiReasoningEffort,
} from "../src/xai-models.js";

afterEach(() => resetXaiModelCatalog());

test("parseXaiLanguageModels converts xAI price units to USD per 1M tokens", () => {
  const [model] = parseXaiLanguageModels({
    models: [
      {
        id: "grok-4.3",
        aliases: ["grok-4.3-latest"],
        prompt_text_token_price: 12500,
        cached_prompt_text_token_price: 2000,
        completion_text_token_price: 25000,
        capabilities: { reasoning_effort: ["none", "low"], default_reasoning_effort: "low" },
      },
    ],
  });
  assert.deepEqual(model, {
    id: "grok-4.3",
    aliases: ["grok-4.3-latest"],
    pricing: { input: 1.25, cachedInput: 0.2, output: 2.5 },
    reasoningEfforts: ["none", "low"],
  });
});

test("parseXaiLanguageModels treats a missing capabilities block as no reasoning control", () => {
  const [model] = parseXaiLanguageModels({
    models: [{ id: "grok-build-0.1", prompt_text_token_price: 10000, completion_text_token_price: 20000 }],
  });
  assert.deepEqual(model.reasoningEfforts, []);
  assert.equal(model.pricing.cachedInput, 1);
});

test("parseXaiLanguageModels ignores malformed entries and payloads", () => {
  assert.deepEqual(parseXaiLanguageModels(null), []);
  assert.deepEqual(parseXaiLanguageModels({ models: [{}, { id: "" }] }), []);
});

test("the built-in catalog covers grok-4.3 and resolves aliases", () => {
  assert.equal(getXaiModelCatalog().source, "fallback");
  assert.equal(findXaiModel("grok-4.3")?.id, "grok-4.3");
  assert.equal(findXaiModel("grok-code-fast-1")?.id, "grok-build-0.1");
  assert.equal(findXaiModel("grok-unknown"), null);
});

test("resolveXaiReasoningEffort keeps a supported effort", () => {
  assert.equal(resolveXaiReasoningEffort("grok-4.3", "none"), "none");
  assert.equal(resolveXaiReasoningEffort("grok-4.7", "high"), "high");
});

test("resolveXaiReasoningEffort moves up to the nearest supported effort", () => {
  // grok-4.7 rejects "none" with HTTP 400; "low" is the fastest it accepts.
  assert.equal(resolveXaiReasoningEffort("grok-4.7", "none"), "low");
});

test("resolveXaiReasoningEffort defaults a missing effort to the fastest one", () => {
  assert.equal(resolveXaiReasoningEffort("grok-4.3", undefined), "none");
});

test("resolveXaiReasoningEffort omits the parameter when the model has no reasoning control or is unknown", () => {
  // grok-build-0.1 rejects reasoning_effort entirely with HTTP 400.
  assert.equal(resolveXaiReasoningEffort("grok-build-0.1", "none"), undefined);
  assert.equal(resolveXaiReasoningEffort("grok-unknown", "none"), undefined);
});

test("refreshXaiModelCatalog replaces the catalog with the API list", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return {
      ok: true,
      json: async () => ({
        models: [{ id: "grok-9", prompt_text_token_price: 30000, completion_text_token_price: 90000, capabilities: { reasoning_effort: ["low"] } }],
      }),
    };
  };
  const result = await refreshXaiModelCatalog({ apiKey: "k", baseURL: "https://api.x.ai/v1/", fetchFn });
  assert.deepEqual(calls, [{ url: "https://api.x.ai/v1/language-models", auth: "Bearer k" }]);
  assert.equal(result.source, "api");
  assert.equal(findXaiModel("grok-9")?.pricing.input, 3);
  assert.equal(findXaiModel("grok-4.3"), null);
});

test("refreshXaiModelCatalog keeps the current catalog when the API fails", async () => {
  const result = await refreshXaiModelCatalog({
    apiKey: "k",
    fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    log: { warn: () => {} },
  });
  assert.equal(result.source, "fallback");
  assert.equal(findXaiModel("grok-4.3")?.id, "grok-4.3");
});

test("refreshXaiModelCatalog does not call the API without a key", async () => {
  let called = false;
  await refreshXaiModelCatalog({ apiKey: "", fetchFn: async () => { called = true; } });
  assert.equal(called, false);
});
