import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

async function discoverModels(cwd, env) {
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session"], { cwd, env });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const poll = setInterval(() => child.stdin.write('{"type":"get_available_models"}\n'), 100);
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    for await (const line of lines) {
      const reply = JSON.parse(line);
      if (reply.data?.models?.some(model => model.provider === "experiential-local" && model.id === "workbench")) return;
    }
    assert.fail("Pi RPC did not discover the local model. " + stderr);
  } finally {
    clearInterval(poll);
    clearTimeout(timeout);
    lines.close();
    child.kill();
    await exited;
  }
}

function chatReply(res, delta, finishReason) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason) => ({
    id: "chat-1", object: "chat.completion.chunk", created: 1, model: "workbench",
    choices: [{ index: 0, delta, finish_reason }],
  });
  for (const event of [chunk({ role: "assistant", ...delta }, null), chunk({}, finishReason)]) {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  }
  res.end("data: [DONE]\n\n");
}

test("an installed Pi package discovers a local model and completes a streaming tool turn", { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-experiential-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "package");
  const cwd = join(root, "work");
  await mkdir(pkg);
  await mkdir(cwd);
  await cp(new URL("../package.json", import.meta.url), join(pkg, "package.json"));
  await cp(new URL("../src/", import.meta.url), join(pkg, "src"), { recursive: true });
  await writeFile(join(cwd, "sample.txt"), "hello from the sample file");

  const turns = [];
  let listings = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer test-local-key") {
      res.writeHead(401).end();
    } else if (req.method === "GET" && req.url === "/v1/models") {
      listings++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "workbench" }] }));
    } else if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      turns.push(body);
      if (turns.length === 1) {
        chatReply(res, { tool_calls: [{
          index: 0, id: "call_1", type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "sample.txt" }) },
        }] }, "tool_calls");
      } else {
        chatReply(res, { content: "Sample received." }, "stop");
      }
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
    APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
    PI_CODING_AGENT_DIR: join(root, "profile"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    EXP_GATEWAY_KEY: "test-local-key", EXPLABS_BASE_URL: "http://127.0.0.1:" + server.address().port,
    NO_COLOR: "1",
  };
  const pi = (...args) => {
    const command = exec(process.execPath, [cli, ...args], { cwd, env, timeout: 25_000 });
    command.child.stdin.end();
    return command;
  };

  await pi("install", pkg);
  await discoverModels(cwd, env);
  assert.ok(listings > 0, "Pi refreshed the extension's model catalog");
  const listing = await pi("--list-models", "experiential-local");
  assert.match(listing.stdout, /experiential-local\s+workbench/);
  const answer = await pi("--no-session", "--tools", "read", "--model", "experiential-local/workbench",
    "-p", "Read sample.txt");
  assert.match(answer.stdout, /Sample received\./);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].model, "workbench");
  assert.ok(turns[0].tools.some(tool => tool.function.name === "read"));
  const result = turns[1].messages.find(message => message.role === "tool");
  assert.equal(result.tool_call_id, "call_1");
  assert.match(JSON.stringify(result.content), /hello from the sample file/);
});
