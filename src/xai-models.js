// xAI model catalog: which models exist, what they cost, and which
// reasoning_effort values they accept. The live list comes from
// GET {baseURL}/language-models (see refreshXaiModelCatalog); the built-in
// list below is used until a refresh succeeds. Failed refreshes retain the
// current in-memory catalog, including a previously fetched API list.
// Prices are base USD per 1M tokens; context-length tiers are not modeled.

export const XAI_FALLBACK_MODELS = Object.freeze([
  {
    id: "grok-4.3",
    aliases: ["grok-4.3-latest"],
    pricing: { input: 1.25, cachedInput: 0.2, output: 2.5 },
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
  },
  {
    id: "grok-4.7",
    aliases: [],
    pricing: { input: 2.0, cachedInput: 0.5, output: 6.0 },
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "grok-build-0.1",
    aliases: ["grok-code-fast-1", "grok-code-fast", "grok-code-fast-1-0825"],
    pricing: { input: 1.0, cachedInput: 0.2, output: 2.0 },
    reasoningEfforts: [],
  },
]);

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
// xAI reports prices in 1/10,000 USD per 1M tokens (12500 -> $1.25).
const XAI_PRICE_UNITS_PER_USD = 10_000;
const REASONING_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh"];

/** @type {ReadonlyArray<{ id: string, aliases: string[], pricing: { input: number, cachedInput: number, output: number }, reasoningEfforts: string[] }>} */
let catalog = XAI_FALLBACK_MODELS;
let source = "fallback";

export function parseXaiLanguageModels(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .filter((model) => typeof model?.id === "string" && model.id)
    .map((model) => ({
      id: model.id,
      aliases: Array.isArray(model.aliases) ? model.aliases.filter((alias) => typeof alias === "string") : [],
      pricing: {
        input: toUsd(model.prompt_text_token_price),
        cachedInput: toUsd(model.cached_prompt_text_token_price ?? model.prompt_text_token_price),
        output: toUsd(model.completion_text_token_price),
      },
      reasoningEfforts: Array.isArray(model.capabilities?.reasoning_effort)
        ? model.capabilities.reasoning_effort.filter((effort) => typeof effort === "string")
        : [],
    }));
}

export function getXaiModelCatalog() {
  return { models: catalog, source };
}

export function findXaiModel(modelId) {
  return catalog.find((model) => model.id === modelId || model.aliases.includes(modelId)) ?? null;
}

export function resetXaiModelCatalog() {
  catalog = XAI_FALLBACK_MODELS;
  source = "fallback";
}

// Returns the effort to send, or undefined to omit reasoning_effort.
// Search upward from the requested effort, then use the first advertised
// effort if no higher level is supported. Unknown models or missing/empty
// capabilities omit the parameter and leave the provider's default in effect.
export function resolveXaiReasoningEffort(modelId, requested) {
  const supported = findXaiModel(modelId)?.reasoningEfforts ?? [];
  if (supported.length === 0) return undefined;
  const start = Math.max(0, REASONING_EFFORT_ORDER.indexOf(requested ?? "none"));
  return REASONING_EFFORT_ORDER.slice(start).find((effort) => supported.includes(effort)) ?? supported[0];
}

/**
 * Refresh the process-wide catalog, retaining the current list on failure or
 * when no key is supplied. A successful non-empty response replaces the list.
 * @param {{ apiKey?: string, baseURL?: string, fetchFn?: (url: string, init: any) => Promise<any>, timeoutMs?: number, log?: { warn: (message: string) => void } }} [options]
 */
export async function refreshXaiModelCatalog({
  apiKey,
  baseURL = DEFAULT_XAI_BASE_URL,
  fetchFn = fetch,
  timeoutMs = 5_000,
  log = console,
} = {}) {
  if (!apiKey) return getXaiModelCatalog();
  try {
    const url = `${(baseURL || DEFAULT_XAI_BASE_URL).replace(/\/+$/, "")}/language-models`;
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = parseXaiLanguageModels(await res.json());
    if (models.length === 0) throw new Error("empty model list");
    catalog = models;
    source = "api";
  } catch (error) {
    log.warn(`[xai] model list unavailable, keeping the ${source} list: ${error.message}`);
  }
  return getXaiModelCatalog();
}

function toUsd(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / XAI_PRICE_UNITS_PER_USD : 0;
}
