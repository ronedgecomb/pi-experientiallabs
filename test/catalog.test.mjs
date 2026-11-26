import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalog } from "../src/catalog.ts";

const hosted = "https://api.experientiallabs.ai/api/v1";
const local = "http://127.0.0.1:8000/v1";

test("maps the integration catalog to Pi chat models and per-million-token rates", () => {
  const data = [
    {
      id: "anthropic/claude-demo:fast",
      name: "Claude Demo",
      context_length: 200_000,
      top_provider: { max_completion_tokens: 16_000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning"],
      pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
    },
    { id: "image", architecture: { output_modalities: ["image"] } },
    { id: "embedding", supported_parameters: [] },
    { id: "text-only", supported_parameters: ["temperature"] },
    null,
  ];
  const models = parseCatalog({ data }, "experiential", hosted);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    id: "anthropic/claude-demo:fast", name: "Claude Demo", provider: "experiential",
    api: "anthropic-messages", baseUrl: "https://api.experientiallabs.ai/api",
    input: ["text", "image"], reasoning: true, contextWindow: 184_000, maxTokens: 16_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  });
});

test("accepts plain gateway aliases and honors local limits, capabilities, and prices", () => {
  const data = [
    { id: "small" },
    { id: "small", context_window_tokens: 4096, supports_tools: true, chat_max_tokens_field: "max_tokens",
      supports_image_input: true, input_nano_usd_per_million_tokens: 500_000_000 },
    { id: "gpt-5-demo", supports_reasoning: false },
    { id: "claude-local" },
    { id: "no-tools", supports_tools: false }, { id: "no-chat", supports_completions: false }, { id: " " },
  ];
  const [small, gpt, claude, ...others] = parseCatalog({ data }, "experiential-local", local);
  assert.equal(small.contextWindow, 2048);
  assert.equal(small.maxTokens, 2048);
  assert.deepEqual(small.input, ["text", "image"]);
  assert.equal(small.cost.input, 0.5);
  assert.deepEqual(small.compat, { maxTokensField: "max_tokens" });
  assert.equal(gpt.api, "openai-responses");
  assert.equal(gpt.reasoning, false);
  assert.equal(claude.api, "openai-completions");
  assert.equal(claude.baseUrl, local);
  assert.deepEqual(others, []);
  assert.throws(() => parseCatalog({ error: "unavailable" }, "experiential-local", local), /data array/);
  assert.deepEqual(parseCatalog({ data: [] }, "experiential-local", local), []);
});

test("preserves explicit input caps and reserves output within a shared window", () => {
  const data = [
    { id: "combined", context_length: 1_050_000, top_provider: { max_completion_tokens: 128_000 } },
    { id: "separate", context_window: 64_000, max_input_tokens: 64_000, max_completion_tokens: 2048 },
    { id: "full-window", context_length: 8192, max_output_tokens: 8192 },
  ];
  const limits = parseCatalog({ data }, "experiential", hosted).map(m => [m.contextWindow, m.maxTokens]);
  assert.deepEqual(limits, [[922_000, 128_000], [64_000, 2048], [4096, 4096]]);
});
