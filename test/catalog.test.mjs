import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
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

test("Pi offers the gateway's named efforts, including models with a single choice", () => {
  const data = [
    { id: "flash", supported_reasoning_efforts: ["none", "high", "max"] },
    { id: "fixed", supports_reasoning: true, supported_reasoning_efforts: ["medium"] },
    { id: "disabled", supports_reasoning: false, supported_reasoning_efforts: ["max"] },
    { id: "off-only", supported_reasoning_efforts: ["none"] },
    { id: "future", supported_reasoning_efforts: ["xhigh", "ultra"] },
    { id: "empty", supported_reasoning_efforts: [] },
    { id: "legacy", supports_reasoning: true },
  ];
  const models = parseCatalog({ data }, "experiential-local", local);
  assert.deepEqual(models.map(getSupportedThinkingLevels), [
    ["off", "high", "max"], ["medium"], ["off"], ["off"], ["xhigh"], ["off"],
    ["off", "minimal", "low", "medium", "high"],
  ]);
  assert.equal(models[0].thinkingLevelMap.off, "none");
  assert.equal(models[2].reasoning, false);
  assert.equal(models[3].thinkingLevelMap.off, "none");
});

test("matches account capabilities by exact ID then canonical slug while preserving catalog IDs", () => {
  const catalog = { data: [
    { id: "vendor/demo", canonical_slug: "demo", supported_parameters: ["tools"] },
    { id: "vendor/demo:fast", canonical_slug: "demo", supported_parameters: ["tools"] },
    { id: "vendor/demo:free", canonical_slug: "demo", supported_parameters: ["tools"] },
    { id: "vendor/other", canonical_slug: "other", supported_parameters: ["tools", "reasoning"] },
  ] };
  const capabilities = { data: [
    { id: "vendor/demo", object: "model" },
    { id: "demo", supports_reasoning: true, supported_reasoning_efforts: ["high", "max"] },
    { id: "vendor/demo:fast", supported_reasoning_efforts: ["low"] },
    { id: "demo:fast", supported_reasoning_efforts: ["minimal"] },
    { id: "demo:free", supported_reasoning_efforts: ["medium"] },
    { id: "other", supports_reasoning: false, supported_reasoning_efforts: [] },
    { id: "private-only", supported_reasoning_efforts: ["medium"] },
  ] };
  const models = parseCatalog(catalog, "experiential", hosted, capabilities);
  assert.deepEqual(models.map(m => [m.id, getSupportedThinkingLevels(m)]), [
    ["vendor/demo", ["high", "max"]], ["vendor/demo:fast", ["low"]], ["vendor/demo:free", ["medium"]],
    ["vendor/other", ["off"]],
  ]);
});
