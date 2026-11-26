import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export type GatewayApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export type GatewayId = "experiential" | "experiential-local";
export type ChatModel = Model<GatewayApi>;

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function rate(perToken: unknown, nanoDollarsPerMillion: unknown): number {
  const price = typeof perToken === "string" && perToken.trim() ? Number(perToken) : perToken;
  if (typeof price === "number" && Number.isFinite(price) && price >= 0) return price * 1_000_000;
  if (typeof nanoDollarsPerMillion === "number" && Number.isFinite(nanoDollarsPerMillion) && nanoDollarsPerMillion >= 0) {
    return nanoDollarsPerMillion / 1_000_000_000;
  }
  return 0;
}

function wireApi(id: string, provider: GatewayId): GatewayApi {
  const family = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  if (provider === "experiential" && family.startsWith("claude-")) return "anthropic-messages";
  if (/^(gpt-[56]|codex|o[1-9](?:$|[-:]))/.test(family)) return "openai-responses";
  return "openai-completions";
}

function tokenLimits(entry: Record<string, unknown>): Pick<ChatModel, "contextWindow" | "maxTokens"> {
  const top = record(entry.top_provider);
  const input = positiveInteger(entry.max_input_tokens) ?? positiveInteger(top?.max_input_tokens);
  const output = positiveInteger(top?.max_completion_tokens) ?? positiveInteger(entry.max_completion_tokens)
    ?? positiveInteger(entry.maximum_output_tokens) ?? positiveInteger(entry.max_output_tokens);
  const total = positiveInteger(entry.context_length) ?? positiveInteger(entry.context_window_tokens)
    ?? positiveInteger(entry.context_window) ?? positiveInteger(top?.context_length);
  const capacity = total ?? 128_000;
  const halfWindow = Math.max(1, Math.floor(capacity / 2));
  let maxTokens = output ?? Math.min(8192, halfWindow);
  if (total !== undefined) maxTokens = Math.min(maxTokens, total);
  // Leave room for input when both directions share one advertised limit.
  if (!input && maxTokens >= capacity) maxTokens = halfWindow;
  const contextWindow = input ?? Math.max(1, capacity - maxTokens);
  return { contextWindow: total ? Math.min(total, contextWindow) : contextWindow, maxTokens };
}

function thinkingLevels(efforts: unknown, supported: unknown, fallback: boolean): Pick<ChatModel, "reasoning" | "thinkingLevelMap"> {
  if (supported === false) return { reasoning: false, thinkingLevelMap: {} };
  if (!Array.isArray(efforts)) return { reasoning: supported === true || fallback };

  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const wire = level === "off" ? "none" : level;
    thinkingLevelMap[level] = efforts.includes(wire) ? wire : null;
  }
  return { reasoning: Object.values(thinkingLevelMap).some(value => value !== null), thinkingLevelMap };
}

function chatModel(entry: Record<string, unknown>, provider: GatewayId, baseUrl: string,
  detailsById: ReadonlyMap<string, Record<string, unknown>>): ChatModel | undefined {
  const id = entry.id;
  if (typeof id !== "string" || !id.trim()) return;
  const architecture = record(entry.architecture);
  const output = architecture?.output_modalities ?? entry.output_modalities;
  const parameters = entry.supported_parameters;
  if (entry.supports_completions === false || entry.supports_tools === false) return;
  if (Array.isArray(output) && !output.includes("text")) return;
  if (Array.isArray(parameters) && !parameters.includes("tools")) return;

  const api = wireApi(id, provider);
  const input = architecture?.input_modalities ?? entry.input_modalities;
  const vision = typeof entry.supports_image_input === "boolean"
    ? entry.supports_image_input : Array.isArray(input) && input.includes("image");
  const advertisedReasoning = Array.isArray(parameters)
    ? parameters.includes("reasoning") || parameters.includes("include_reasoning")
    : api !== "openai-completions";
  const slug = typeof entry.canonical_slug === "string" ? entry.canonical_slug : id;
  const suffix = id.match(/:[^/:]+$/)?.[0];
  const nativeId = suffix && !slug.includes(":") ? slug + suffix : slug;
  const details = detailsById.get(id) ?? detailsById.get(nativeId) ?? detailsById.get(slug);
  const thinking = thinkingLevels(entry.supported_reasoning_efforts ?? details?.supported_reasoning_efforts,
    entry.supports_reasoning ?? details?.supports_reasoning, advertisedReasoning);
  const prices = record(entry.pricing);
  const tokensField = entry.chat_max_tokens_field;

  return {
    id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
    provider,
    api,
    // The Anthropic SDK appends /v1/messages to its base URL.
    baseUrl: api === "anthropic-messages" ? baseUrl.replace(/\/v1$/, "") : baseUrl,
    input: vision ? ["text", "image"] : ["text"],
    ...thinking,
    ...tokenLimits(entry),
    cost: {
      input: rate(prices?.prompt, entry.input_nano_usd_per_million_tokens),
      output: rate(prices?.completion, entry.output_nano_usd_per_million_tokens),
      cacheRead: rate(prices?.input_cache_read, entry.cached_input_nano_usd_per_million_tokens),
      cacheWrite: rate(prices?.input_cache_write, entry.cache_write_input_nano_usd_per_million_tokens),
    },
    ...(api === "openai-completions" && (tokensField === "max_tokens" || tokensField === "max_completion_tokens")
      ? { compat: { maxTokensField: tokensField } } : {}),
    ...(api === "anthropic-messages" && thinking.reasoning && thinking.thinkingLevelMap
      ? { compat: { forceAdaptiveThinking: true } } : {}),
  };
}

export function parseCatalog(body: unknown, provider: GatewayId, baseUrl: string, capabilities?: unknown): ChatModel[] {
  const entries = record(body)?.data;
  if (!Array.isArray(entries)) throw new Error("Experiential returned a model catalog without a data array.");
  const detailsById = new Map<string, Record<string, unknown>>();
  const details = record(capabilities)?.data;
  if (Array.isArray(details)) {
    for (const value of details) {
      const row = record(value);
      if (typeof row?.id === "string") detailsById.set(row.id, row);
    }
  }
  const models = new Map<string, ChatModel>();
  for (const value of entries) {
    const entry = record(value);
    const model = entry && chatModel(entry, provider, baseUrl, detailsById);
    if (model) models.set(model.id, model);
  }
  return [...models.values()];
}
