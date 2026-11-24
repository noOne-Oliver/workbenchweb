import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import createBuiltin, {
  completionsURL,
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_WALL_MS,
} from "../src/runner/providers/builtin.mjs";

// ---------------------------------------------------------------------------
// 假的 OpenAI 兼容端点：不联网、不烧钱，但走的是同一套 HTTP 语义。
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function reply({ content = null, toolCalls = null, usage = null } = {}) {
  const message = { role: "assistant", content };
  if (toolCalls) message.tool_calls = toolCalls;
  const body = { choices: [{ index: 0, message }] };
  if (usage) body.usage = usage;
  return body;
}

function tool(name, args, id) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** 按顺序回放脚本；用完了就一直重复最后一个（给 maxSteps 用）。 */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    const req = {
      url,
      init,
      body: init && init.body ? JSON.parse(init.body) : null,
    };
    calls.push(req);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof step === "function" ? await step(req, calls.length - 1) : step;
  };
  impl.calls = calls;
  return impl;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wb-builtin-"));
}

function provider(overrides = {}) {
  return createBuiltin({
    fetchImpl: fakeFetch([jsonResponse(reply({ content: "ok", usage: { total_tokens: 1 } }))]),
    baseURL: "https://fake.local/v1",
    apiKey: "sk-test",
    model: "fake-model",
    sleep: async () => {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 端点到请求形状
// ---------------------------------------------------------------------------

test("baseURL 带不带 /v1 都能拼出正确端点，且不出现多余的 //", () => {
  assert.equal(completionsURL("https://h/v1"), "https://h/v1/chat/completions");
  assert.equal(completionsURL("https://h/v1/"), "https://h/v1/chat/completions");
  assert.equal(completionsURL("https://h"), "https://h/v1/chat/completions");
  assert.equal(completionsURL("https://h/"), "https://h/v1/chat/completions");
  for (const u of ["https://h/", "https://h/v1/"]) {
    assert.ok(!completionsURL(u).replace("https://", "").includes("//"), completionsURL(u));
  }
});

test("模型优先级：WB_LLM_MODEL → WB_MODEL 去 builtin/ 前缀", async () => {
  const dir = tmpdir();
  const fetchImpl = fakeFetch([jsonResponse(reply({ content: "好的", usage: { total_tokens: 3 } }))]);
  const p = await createBuiltin({
    fetchImpl,
    env: { WB_LLM_BASE_URL: "https://env.local/v1", WB_LLM_API_KEY: "k-env", WB_MODEL: "builtin/deepseek-v4.1-flash" },
    sleep: async () => {},
  });
  const res = await p.run({ role: "coder", prompt: "随便看看", cwd: dir });
  assert.equal(res.ok, true, res.error);
  assert.equal(fetchImpl.calls[0].url, "https://env.local/v1/chat/completions");
  assert.equal(fetchImpl.calls[0].body.model, "deepseek-v4.1-flash");
  assert.equal(fetchImpl.calls[0].init.headers.authorization, "Bearer k-env");

  const fetch2 = fakeFetch([jsonResponse(reply({ content: "好的", usage: { total_tokens: 3 } }))]);
  const p2 = await createBuiltin({
    fetchImpl: fetch2,
    env: { WB_LLM_BASE_URL: "https://env.local", WB_LLM_API_KEY: "k-env", WB_LLM_MODEL: "explicit-model", WB_MODEL: "builtin/other" },
    sleep: async () => {},
  });
  await p2.run({ role: "coder", prompt: "随便看看", cwd: dir });
  assert.equal(fetch2.calls[0].body.model, "explicit-model");
});

test("缺 env → 明确报错（不猜默认值，也不联网）", async () => {
  let called = false;
  const p = await createBuiltin({
    env: {},
    fetchImpl: async () => {
      called = true;
      throw new Error("不该联网");
    },
  });
  const res = await p.run({ role: "coder", prompt: "x", cwd: tmpdir() });
  assert.equal(res.ok, false);
  assert.match(res.error, /WB_LLM_BASE_URL/);
  assert.match(res.error, /WB_LLM_API_KEY/);
  assert.match(res.error, /WB_LLM_MODEL/);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// 工具循环
// ---------------------------------------------------------------------------

test("两轮工具调用：write_file 写实现 + run_command 跑测试，token 累加，最后返回正文", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tests/calc.test.mjs"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { calc } from '../src/calc.mjs';",
      "test('add', () => assert.equal(calc(2, 3), 5));",
      "",
    ].join("\n"),
  );
  const impl = "export function calc(a, b) { return a + b; }\n";
  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [tool("write_file", { path: "src/calc.mjs", content: impl }, "call_write")], usage: { total_tokens: 100 } })),
    jsonResponse(reply({ toolCalls: [tool("run_command", { command: "node --test tests/calc.test.mjs", timeout_ms: 20000 }, "call_test")], usage: { total_tokens: 150 } })),
    jsonResponse(reply({ content: "完成：新增 src/calc.mjs，并跑通 tests/calc.test.mjs。", usage: { total_tokens: 50 } })),
  ]);
  const p = await provider({ fetchImpl });
  const res = await p.run({ role: "coder", prompt: "实现 calc(2,3)=5，并跑测试", cwd: dir });

  assert.equal(res.ok, true, res.error);
  assert.match(res.text, /完成/);
  assert.equal(res.tokens, 300);
  assert.equal(res.elapsedMs >= 0, true);
  assert.equal(fs.readFileSync(path.join(dir, "src/calc.mjs"), "utf8"), impl);

  // 第二轮请求里带着 write_file 的工具结果
  const second = fetchImpl.calls[1].body;
  const toolMsgs2 = second.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs2.length, 1);
  assert.match(toolMsgs2[0].content, /已写入/);
  assert.equal(toolMsgs2[0].tool_call_id, "call_write");

  // 第三轮请求里带着测试输出（真的跑了 node --test）
  const third = fetchImpl.calls[2].body;
  const toolMsgs3 = third.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs3.length, 2);
  assert.match(toolMsgs3[1].content, /exit 0/);
  assert.match(toolMsgs3[1].content, /pass 1/);
  assert.match(toolMsgs3[1].content, /fail 0/);

  // 请求本身：工具声明在，system prompt 里写明工作目录
  assert.equal(fetchImpl.calls[0].body.tools.length, 5);
  assert.equal(fetchImpl.calls[0].body.tool_choice, "auto");
  assert.ok(fetchImpl.calls[0].body.messages[0].content.includes(dir), "system prompt 要写明工作目录");
  assert.equal(fetchImpl.calls.length, 3);
});

test("路径越界（../、绝对路径、符号链接）被拒绝，错误作为工具结果回给模型", async () => {
  const dir = tmpdir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOPSECRET-CONTENT");
  fs.symlinkSync(outside, path.join(dir, "linkout"));

  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [
      tool("read_file", { path: "../../etc/passwd" }, "c1"),
      tool("read_file", { path: "/etc/passwd" }, "c2"),
      tool("read_file", { path: "linkout/secret.txt" }, "c3"),
      tool("write_file", { path: "../escape.txt", content: "x" }, "c4"),
    ] })),
    jsonResponse(reply({ content: "三次越界都被拒绝，改为在工作目录内工作。" })),
  ]);
  const p = await provider({ fetchImpl });
  const res = await p.run({ role: "coder", prompt: "读 /etc/passwd", cwd: dir });

  assert.equal(res.ok, true, res.error);

  const toolMsgs = fetchImpl.calls[1].body.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 4);
  for (const m of toolMsgs) {
    assert.match(m.content, /错误：路径越界/, m.content);
  }
  assert.doesNotMatch(toolMsgs.map((m) => m.content).join("\n"), /TOPSECRET-CONTENT/);
  assert.doesNotMatch(toolMsgs.map((m) => m.content).join("\n"), /root:/);
});

test("只读根：cwd 外但在 WB_BUILTIN_READ_ROOTS 内可读，写入仍被拒绝", async () => {
  const ws = tmpdir();
  const cwd = path.join(ws, ".oc", "scratch", "t1");
  fs.mkdirSync(cwd, { recursive: true });
  const repo = path.join(ws, "demo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.mjs"), "export const answer = 42;\n");

  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [
      tool("read_file", { path: path.join(repo, "src", "app.mjs") }, "c1"),
      tool("list_files", { path: repo }, "c2"),
      tool("grep", { pattern: "answer", path: repo }, "c3"),
      tool("write_file", { path: path.join(repo, "src", "hack.mjs"), content: "bad" }, "c4"),
    ] })),
    jsonResponse(reply({ content: "读到了上游仓库，写入被拒绝。" })),
  ]);
  const p = await provider({ fetchImpl, env: { WB_BUILTIN_READ_ROOTS: ws } });
  const res = await p.run({ role: "architect", prompt: "看看 demo 仓库", cwd });

  assert.equal(res.ok, true, res.error);
  const systemPrompt = fetchImpl.calls[0].body.messages[0].content;
  assert.ok(systemPrompt.includes(ws), "系统提示要写明只读根: " + systemPrompt);
  assert.match(systemPrompt, /只读根目录/);
  assert.match(systemPrompt, /写入只能落在工作目录内/);
  const toolMsgs = fetchImpl.calls[1].body.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 4);
  assert.match(toolMsgs[0].content, /export const answer = 42/);
  assert.match(toolMsgs[1].content, /src\//);
  assert.match(toolMsgs[2].content, /app\.mjs:1: .*answer/);
  assert.match(toolMsgs[3].content, /错误：路径越界/);
  assert.equal(fs.existsSync(path.join(repo, "src", "hack.mjs")), false, "只读根里不能写");
});

test("只读根之外仍然拒绝：绝对路径与 ../ 都读不到（WB_ROOT 作为默认读根）", async () => {
  const ws = tmpdir();
  const cwd = path.join(ws, ".oc", "scratch", "t2");
  fs.mkdirSync(cwd, { recursive: true });
  const repo = path.join(ws, "demo");
  fs.mkdirSync(repo, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-outside2-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET");
  fs.writeFileSync(path.join(ws, "escape-secret.txt"), "OUTSIDE-SECRET");

  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [
      tool("read_file", { path: path.join(outside, "secret.txt") }, "c1"),
      tool("read_file", { path: "../escape-secret.txt" }, "c2"),
      tool("grep", { pattern: "OUTSIDE-SECRET", path: outside }, "c3"),
    ] })),
    jsonResponse(reply({ content: "读根外读不到。" })),
  ]);
  const p = await provider({ fetchImpl, env: { WB_ROOT: repo } });
  const res = await p.run({ role: "architect", prompt: "越界读", cwd });

  assert.equal(res.ok, true, res.error);
  const toolMsgs = fetchImpl.calls[1].body.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 3);
  for (const m of toolMsgs) assert.match(m.content, /错误：路径越界/, m.content);
  assert.doesNotMatch(toolMsgs.map((m) => m.content).join("\n"), /OUTSIDE-SECRET/);
});

test("run_command 超时被杀，并返回可读错误", async () => {
  const dir = tmpdir();
  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [tool("run_command", { command: "sleep 30", timeout_ms: 300 }, "c1")] })),
    jsonResponse(reply({ content: "命令超时，已放弃。" })),
  ]);
  const p = await provider({ fetchImpl });
  const started = Date.now();
  const res = await p.run({ role: "coder", prompt: "跑个会挂住的命令", cwd: dir });
  const took = Date.now() - started;

  assert.equal(res.ok, true, res.error);
  const toolMsg = fetchImpl.calls[1].body.messages.filter((m) => m.role === "tool")[0];
  assert.match(toolMsg.content, /错误：命令超时（300ms）/);
  assert.ok(took < 10000, "超时命令应该很快被杀掉，实际 " + took + "ms");
});

test("run_command 输出截断到 20000 字符", async () => {
  const dir = tmpdir();
  const cmd = "node -e \"process.stdout.write('x'.repeat(30000))\"";
  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [tool("run_command", { command: cmd, timeout_ms: 20000 }, "c1")] })),
    jsonResponse(reply({ content: "输出太长，已截断。" })),
  ]);
  const p = await provider({ fetchImpl });
  const res = await p.run({ role: "coder", prompt: "打印 30000 个 x", cwd: dir });
  assert.equal(res.ok, true, res.error);
  const toolMsg = fetchImpl.calls[1].body.messages.filter((m) => m.role === "tool")[0];
  assert.match(toolMsg.content, /已截断/);
  assert.ok(toolMsg.content.length <= 20100, "实际长度 " + toolMsg.content.length);
});

test("maxSteps 用尽 → ok:false，错误可读", async () => {
  const dir = tmpdir();
  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [tool("list_files", { path: "." }, "c1")], usage: { total_tokens: 7 } })),
  ]);
  const p = await provider({ fetchImpl, maxSteps: 3 });
  const res = await p.run({ role: "coder", prompt: "一直列目录", cwd: dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /最大步数 3/);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(res.tokens, 21);
});

test("默认预算：40 步 / 900s 墙钟 / 180s idle（接口契约）", () => {
  assert.equal(DEFAULT_MAX_STEPS, 40);
  assert.equal(DEFAULT_WALL_MS, 900000);
  assert.equal(DEFAULT_IDLE_MS, 180000);
});

test("wall timeout：挂住的请求会被 AbortController 中断", async () => {
  const dir = tmpdir();
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const p = await provider({ fetchImpl: hanging, timeoutMs: 200 });
  const res = await p.run({ role: "coder", prompt: "x", cwd: dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /wall timeout 200ms/);
});

test("idle timeout：长时间没有新事件就中断", async () => {
  const dir = tmpdir();
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const p = await provider({ fetchImpl: hanging, timeoutMs: 5000, idleMs: 150 });
  const res = await p.run({ role: "coder", prompt: "x", cwd: dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /idle timeout 150ms/);
});

test("只给工具调用没有正文时，额外要一次中文收尾", async () => {
  const dir = tmpdir();
  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [tool("list_files", { path: "." }, "c1")], usage: { total_tokens: 5 } })),
    jsonResponse(reply({ content: "", usage: { total_tokens: 6 } })),
    jsonResponse(reply({ content: "我列出了工作目录，没有改任何文件。", usage: { total_tokens: 7 } })),
  ]);
  const p = await provider({ fetchImpl });
  const res = await p.run({ role: "coder", prompt: "看看目录", cwd: dir });
  assert.equal(res.ok, true, res.error);
  assert.match(res.text, /列出了工作目录/);
  assert.equal(res.tokens, 18);
  const last = fetchImpl.calls[2].body;
  assert.equal(last.tools, undefined);
  assert.match(last.messages[last.messages.length - 1].content, /用中文简述你做了什么/);
});

// ---------------------------------------------------------------------------
// HTTP 行为
// ---------------------------------------------------------------------------

test("500 重试两次后成功：睡眠 1s、2s", async () => {
  const dir = tmpdir();
  const delays = [];
  const fetchImpl = fakeFetch([
    jsonResponse("upstream boom", 500),
    jsonResponse("still boom", 502),
    jsonResponse(reply({ content: "恢复后完成。", usage: { total_tokens: 30 } })),
  ]);
  const p = await provider({ fetchImpl, sleep: async (ms) => { delays.push(ms); } });
  const res = await p.run({ role: "coder", prompt: "x", cwd: dir });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(res.tokens, 30);
});

test("503 重试用尽后报可读错误", async () => {
  const dir = tmpdir();
  const delays = [];
  const fetchImpl = fakeFetch([jsonResponse("busy", 503)]);
  const p = await provider({ fetchImpl, sleep: async (ms) => { delays.push(ms); } });
  const res = await p.run({ role: "coder", prompt: "x", cwd: dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 503/);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(fetchImpl.calls.length, 3);
});

test("其它 4xx 立即失败，带响应体前 500 字，且不含 Authorization", async () => {
  const dir = tmpdir();
  const body = "bad request: " + "x".repeat(800);
  const fetchImpl = fakeFetch([jsonResponse(body, 400)]);
  const p = await provider({ fetchImpl });
  const res = await p.run({ role: "coder", prompt: "x", cwd: dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /^HTTP 400：bad request:/);
  assert.ok(res.error.length <= 520, "错误里只该带前 500 字，实际 " + res.error.length);
  assert.equal(fetchImpl.calls.length, 1);
  assert.doesNotMatch(res.error, /sk-test/);
  assert.doesNotMatch(res.error, /authorization/i);
  assert.equal(res.fatal, true, "4xx 不该被重试，要标 fatal");
});

test("响应不是合法 JSON → 可读报错", async () => {
  const dir = tmpdir();
  const fetchImpl = fakeFetch([jsonResponse("not-json at all", 200)]);
  const p = await provider({ fetchImpl });
  const res = await p.run({ role: "coder", prompt: "x", cwd: dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /不是合法 JSON/);
  assert.match(res.error, /not-json at all/);
});

test("缺 usage 时估算 token（不因缺字段算成 0）", async () => {
  const dir = tmpdir();
  const fetchImpl = fakeFetch([
    jsonResponse(reply({ toolCalls: [tool("list_files", { path: "." }, "c1")] })),
    jsonResponse(reply({ content: "看完了。" })),
  ]);
  const p = await provider({ fetchImpl });
  const res = await p.run({ role: "coder", prompt: "看看目录", cwd: dir });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.tokens > 0, "tokens=" + res.tokens);
});

test("真 HTTP：假端点先 503 再成功（走全局 fetch + AbortController）", async () => {
  const dir = tmpdir();
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end("busy");
        return;
      }
      assert.match(String(req.headers.authorization || ""), /^Bearer /);
      assert.equal(JSON.parse(body).stream, false);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply({ content: "HTTP 端点完成。", usage: { total_tokens: 42 } })));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const p = await createBuiltin({
      baseURL: "http://127.0.0.1:" + port,
      apiKey: "k-http",
      model: "m",
      sleep: async () => {},
    });
    const res = await p.run({ role: "coder", prompt: "hi", cwd: dir });
    assert.equal(res.ok, true, res.error);
    assert.match(res.text, /HTTP 端点完成/);
    assert.equal(res.tokens, 42);
    assert.equal(hits, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

test("index.mjs 把 builtin 注册成内置引擎", async () => {
  const mod = await import("../src/runner/providers/index.mjs");
  assert.ok(mod.BUILTIN_ENGINES.includes("builtin"));
  const { listProviders } = await import("../src/runner/engine.mjs");
  assert.ok(listProviders().includes("builtin"));
});
