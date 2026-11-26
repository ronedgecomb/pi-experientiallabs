import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { gatewayProvider } from "../src/index.ts";

const id = "experiential-local";
const endpoint = "http://127.0.0.1:8000/v1";

test("Pi login, refresh, offline restore, and key rotation use the active gateway account", async t => {
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore });
  models.setProvider(gatewayProvider(id, endpoint));
  const login = key => models.login(id, "api_key", {
    prompt: async prompt => { assert.equal(prompt.type, "secret"); return key; },
    notify() {},
  });
  await login("account-A");
  let response = Response.json({ data: [{ id: "private-a" }] });
  let sentKey;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, endpoint + "/models");
    assert.ok(options.signal instanceof AbortSignal);
    sentKey = options.headers.Authorization;
    return response.clone();
  });
  assert.equal((await models.refresh()).errors.size, 0);
  assert.equal(sentKey, "Bearer account-A");
  assert.ok(models.getModel(id, "private-a"));
  assert.ok(!JSON.stringify(await modelsStore.read(id)).includes("account-A"));

  const offline = createModels({ credentials, modelsStore });
  offline.setProvider(gatewayProvider(id, endpoint));
  await offline.refresh({ allowNetwork: false });
  assert.ok(offline.getModel(id, "private-a"));
  offline.setProvider(gatewayProvider(id, "http://127.0.0.1:8001/v1"));
  await offline.refresh({ allowNetwork: false });
  assert.deepEqual(offline.getModels(id), []);

  response = new Response("unavailable", { status: 503 });
  assert.match((await models.refresh()).errors.get(id).message, /HTTP 503/);
  assert.ok(models.getModel(id, "private-a"));
  await login("account-B");
  response = new Response("denied", { status: 401 });
  assert.match((await models.refresh()).errors.get(id).message, /HTTP 401/);
  assert.equal(sentKey, "Bearer account-B");
  assert.deepEqual(models.getModels(id), []);
  response = Response.json({ data: [] });
  assert.equal((await models.refresh()).errors.size, 0);
  assert.deepEqual((await modelsStore.read(id)).models, []);
});

test("a self-hosted login is only used at the gateway where it was saved", async t => {
  let envKey;
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, authContext: {
    env: async name => name === "EXP_GATEWAY_KEY" ? envKey : undefined,
    fileExists: async () => false,
  } });
  models.setProvider(gatewayProvider(id, endpoint));
  await models.login(id, "api_key", { prompt: async () => "key-for-a", notify() {} });
  assert.equal((await models.getAuth(id)).auth.apiKey, "key-for-a");

  const other = "http://127.0.0.1:8001/v1";
  models.setProvider(gatewayProvider(id, other));
  assert.equal(await models.getAuth(id), undefined);
  assert.equal(await models.checkAuth(id), undefined);
  await credentials.modify(id, async () => ({ type: "api_key", key: "unscoped-key" }));
  assert.equal(await models.getAuth(id), undefined);
  envKey = "key-for-b";
  assert.deepEqual((await models.getAuth(id)).auth, { apiKey: "key-for-b", baseUrl: other });
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, other + "/models");
    assert.equal(options.headers.Authorization, "Bearer key-for-b");
    return Response.json({ data: [{ id: "private-b" }] });
  });
  assert.equal((await models.refresh()).errors.size, 0);
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(models.getModel(id, "private-b"));
});

test("Pi streams hosted Claude and OpenAI models through their gateway endpoints", async t => {
  const claude = "anthropic/claude-demo";
  const gpt = "openai/gpt-5-demo";
  const requests = [];
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: claude }, { id: gpt }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: pathname, headers: req.headers, model: body.model });
    const item = { id: "msg_1", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Ready", annotations: [] }] };
    const responseEvents = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "Ready" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item] } },
    ];
    const messageEvents = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: claude,
        content: [], usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: null, stop_sequence: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    if (pathname !== "/api/v1/messages" && pathname !== "/api/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of pathname === "/api/v1/messages" ? messageEvents : responseEvents) {
      res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const models = createModels();
  models.setProvider(gatewayProvider("experiential", "http://127.0.0.1:" + server.address().port + "/api/v1"));
  await models.login("experiential", "api_key", { prompt: async () => "test-hosted-key", notify() {} });
  assert.equal((await models.refresh()).errors.size, 0);
  for (const modelId of [claude, gpt]) {
    const model = models.getModel("experiential", modelId);
    const message = await models.completeSimple(model, {
      messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
    }, { signal: AbortSignal.timeout(5000) });
    assert.equal(message.stopReason, "stop", requests.at(-1)?.path + " " + message.errorMessage);
    assert.equal(message.content.find(part => part.type === "text")?.text, "Ready");
  }
  assert.deepEqual(requests.map(({ path, model }) => [path, model]), [
    ["/api/v1/messages", claude], ["/api/v1/responses", gpt],
  ]);
  assert.equal(requests[0].headers["x-api-key"], "test-hosted-key");
  assert.equal(requests[1].headers.authorization, "Bearer test-hosted-key");
});
