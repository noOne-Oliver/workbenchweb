import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { estimateTokens } from "../engine.mjs";

/**
 * builtin provider：不依赖 opencode，自己实现 agent loop，直接打内网 OpenAI 兼容端点。
 *   POST {baseURL}/chat/completions（baseURL 带不带 /v1 都行）
 *
 * 为什么要有这一条：opencode 在离线私有云上要额外装二进制、要写 XDG 目录、还会因为
 * external_directory 权限把整轮变成"空产出"。这条路线只有三个环境变量和一个 HTTP 端点，
 * 工具的手脚（路径越界、命令超时）全部由我们自己收紧，出错也能给出可读原因。
 *
 * 配置（env）：WB_LLM_BASE_URL / WB_LLM_API_KEY / WB_LLM_MODEL（或 WB_MODEL=builtin/<模型名>）。
 * 可选：WB_BUILTIN_MAX_STEPS（默认 40）、WB_BUILTIN_TIMEOUT_MS（默认 900000）、
 *       WB_BUILTIN_IDLE_MS（默认 180000）、WB_BUILTIN_READ_ROOTS（冒号分隔的只读根，
 *       默认取 WB_ROOT；读工具可以进去，写永远只认 cwd）。
 */

export const DEFAULT_MAX_STEPS = 40;
export const DEFAULT_WALL_MS = 900000;
export const DEFAULT_IDLE_MS = 180000;
export const DEFAULT_CMD_TIMEOUT_MS = 120000;
export const MAX_CMD_OUTPUT = 20000;

/** 这些状态是"再等一下可能就好了"，其余 4xx 立刻失败（重试只是多烧钱）。 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS = [1000, 2000];

const FINAL_ASK = "用中文简述你做了什么：改了哪些文件、怎么验证的、还有什么风险。";

const SYSTEM_PROMPT = [
  "你是 Workbench 的 {role} agent，在一台本地机器上的一个仓库里工作。",
  "工作目录（也是唯一允许写入的根目录）：{cwd}",
  "只读根目录（read_file / list_files / grep 可以读，write_file 和 run_command 仍然只在工作目录里）：",
  "{roots}",
  "",
  "读文件时可以越出工作目录去看只读根里的上游仓库，但写入只能落在工作目录内；越界（../、绝对路径、符号链接）依旧会被拒绝。",
  "命令通过 run_command 执行，它的工作目录固定为工作目录，不要指望 cd 到别处。",
  "工作方式：",
  "1. 先读清现状（read_file / list_files / grep），再动手改。",
  "2. 改完必须自己用 run_command 跑测试或复现命令验证，不要把「应该能跑」当成结果。",
  "3. 工具返回错误就如实处理；不要编造命令输出。",
  "4. 收工时用中文写一段正文，说明改了什么、怎么验证的、还有什么风险。",
].join("\n");

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取工作目录或只读根目录内一个文本文件的内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对工作目录的路径，例如 src/index.mjs" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "把内容写入工作目录内的文件（会按需创建父目录）。只读根目录里不能写。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的路径" },
          content: { type: "string", description: "完整文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出一个目录下的文件和子目录（可位于工作目录或只读根目录）。名称以 / 结尾的是目录。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对工作目录的目录路径，默认 ." } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "在工作目录或只读根目录内按正则搜索文件内容（不区分大小写），最多返回 200 行。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript 正则表达式" },
          path: { type: "string", description: "搜索起点（文件或目录），默认 ." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作目录里用 bash -lc 执行命令，返回退出码和输出（stdout+stderr 最多 20000 字符）。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
          timeout_ms: { type: "number", description: "超时毫秒数，默认 120000" },
        },
        required: ["command"],
      },
    },
  },
];

class BuiltinFailure extends Error {}
class RunAborted extends Error {}

/** 工具内部的失败：只回给模型看，不往上冒。 */
class ToolFailure extends Error {}

/** baseURL 带不带 /v1 都行，拼出来绝不出现 //（除了 https:// 那一处）。 */
export function completionsURL(baseURL) {
  const base = String(baseURL || "").trim().replace(/\/+$/, "");
  if (!base) throw new BuiltinFailure("baseURL 为空");
  const root = /\/v1$/i.test(base) ? base : base + "/v1";
  return root + "/chat/completions";
}

/** 缺配置要在 run 的时候报（worker 会把它记进账本），而不是在构造时把进程炸掉。 */
export default async function createBuiltin(opts = {}) {
  const env = opts.env || process.env;
  const doFetch = opts.fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const baseURL = String(opts.baseURL || env.WB_LLM_BASE_URL || "").trim();
  const apiKey = String(opts.apiKey || env.WB_LLM_API_KEY || "").trim();

  let model = String(opts.model || env.WB_LLM_MODEL || "").trim();
  if (!model && env.WB_MODEL) model = String(env.WB_MODEL).replace(/^builtin\//, "").trim();

  const maxSteps = positiveInt(opts.maxSteps, positiveInt(env.WB_BUILTIN_MAX_STEPS, DEFAULT_MAX_STEPS));
  const defaultWallMs = positiveInt(opts.timeoutMs, positiveInt(env.WB_BUILTIN_TIMEOUT_MS, DEFAULT_WALL_MS));
  const defaultIdleMs = positiveInt(opts.idleMs, positiveInt(env.WB_BUILTIN_IDLE_MS, DEFAULT_IDLE_MS));
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || defaultSleep;

  const missing = [];
  if (!baseURL) missing.push("WB_LLM_BASE_URL");
  if (!apiKey) missing.push("WB_LLM_API_KEY");
  if (!model) missing.push("WB_LLM_MODEL（或 WB_MODEL=builtin/<模型名>）");
  const configError = missing.length ? "builtin 缺少配置：" + missing.join("、") : null;

  async function run({ role = "coder", prompt = "", cwd, task = null, attempt = 0, timeoutMs, idleMs } = {}) {
    const startedMs = now();
    let tokens = 0;
    let text = "";
    let lastEvent = startedMs;
    let timer = null;
    let step = 0;
    const ctrl = new AbortController();
    const state = { abortReason: null };
    // 超时预算放在 try 外面：checkDeadline/arm 是闭包，要能看见这两个值。
    const wallMs = positiveInt(timeoutMs, defaultWallMs);
    const idleLimitMs = positiveInt(idleMs, defaultIdleMs);

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const elapsed = () => Math.max(0, now() - startedMs);
    const fail = (error, extra) => ({ ok: false, text, tokens, elapsedMs: elapsed(), error, ...extra });

    const checkDeadline = () => {
      if (state.abortReason) return state.abortReason;
      const t = now();
      if (t - startedMs >= wallMs) return "wall timeout " + wallMs + "ms（整轮超时）";
      if (t - lastEvent >= idleLimitMs) return "idle timeout " + idleLimitMs + "ms（长时间没有新进展）";
      return null;
    };

    const arm = () => {
      clearTimer();
      if (state.abortReason) return;
      const at = Math.min(startedMs + wallMs, lastEvent + idleLimitMs);
      const ms = Math.max(0, at - now());
      timer = setTimeout(() => {
        timer = null;
        if (state.abortReason) return;
        const reason = checkDeadline();
        state.abortReason = reason || ("wall timeout " + wallMs + "ms（整轮超时）");
        try {
          ctrl.abort();
        } catch {
          // 已经 abort 过就算了
        }
      }, Math.min(ms, 2147483647));
    };

    const bump = () => {
      lastEvent = now();
      arm();
    };

    try {
      if (configError) return fail(configError, { fatal: true });

      const rootLex = path.resolve(String(cwd || process.cwd()));
      let rootReal = rootLex;
      try {
        rootReal = fs.realpathSync(rootLex);
      } catch {
        return fail("工作目录不存在：" + rootLex, { fatal: true });
      }

      const ask = prompt && String(prompt).trim() ? String(prompt) : task && task.prompt ? String(task.prompt) : "";
      if (!ask.trim()) return fail("builtin: 没有收到 prompt，无法工作", { fatal: true });

      const endpoint = completionsURL(baseURL);
      const roots = readRootsOf(env, rootLex);
      const toolsCtx = { rootLex, rootReal, roots };
      const rootsText = roots.length > 1 ? roots.map((r) => "  - " + r.lex).join("\n") : "  - （无，只有工作目录）";

      // ---- HTTP ----------------------------------------------------------
      async function httpOnce(messages, useTools) {
        const body = { model, messages, stream: false };
        if (useTools) {
          body.tools = TOOLS;
          body.tool_choice = "auto";
        }
        const payload = JSON.stringify(body);
        let retried = 0;
        for (;;) {
          if (state.abortReason) throw new RunAborted(state.abortReason);
          arm();
          let res = null;
          try {
            res = await doFetch(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
              body: payload,
              signal: ctrl.signal,
            });
          } catch (e) {
            if (state.abortReason) throw new RunAborted(state.abortReason);
            if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) throw new RunAborted("请求被中断");
            throw new BuiltinFailure("调用端点失败：" + shortMessage(e));
          }

          const status = res && Number.isFinite(res.status) ? res.status : res && res.ok ? 200 : 0;
          const okRes = res && typeof res.ok === "boolean" ? res.ok : status >= 200 && status < 300;

          let raw = "";
          try {
            raw = await readBodyText(res);
          } catch (e) {
            if (state.abortReason) throw new RunAborted(state.abortReason);
            throw new BuiltinFailure("读取响应失败：" + shortMessage(e));
          }

          if (!okRes) {
            if (RETRY_STATUS.has(status) && retried < RETRY_DELAYS.length) {
              const delay = RETRY_DELAYS[retried++];
              try {
                await sleep(delay, ctrl.signal);
              } catch (e) {
                if (state.abortReason) throw new RunAborted(state.abortReason);
                if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) throw new RunAborted("请求被中断");
                throw e;
              }
              continue;
            }
            // 4xx 不会因为重试而变好：标成 fatal，让 worker 别再烧五轮预算。
            const err = new BuiltinFailure("HTTP " + status + "：" + String(raw).slice(0, 500));
            if (status >= 400 && status < 500) err.fatal = true;
            throw err;
          }

          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {
            throw new BuiltinFailure("响应不是合法 JSON：" + String(raw).slice(0, 300));
          }
          return { data, raw };
        }
      }

      function parseChat(data, messages, raw) {
        const message = data && Array.isArray(data.choices) && data.choices[0] ? data.choices[0].message : null;
        if (!message) throw new BuiltinFailure("响应里缺少 choices[0].message：" + String(raw).slice(0, 300));
        const usage = (data && data.usage) || null;
        let used = usage ? Number(usage.total_tokens) : NaN;
        if (!Number.isFinite(used) || used <= 0) {
          const alt = usage ? Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0) : 0;
          used = Number.isFinite(alt) && alt > 0 ? alt : estimateTokens(messagesText(messages)) + estimateTokens(assistantText(message));
        }
        return { message, used: Math.max(1, Math.round(used)) };
      }

      // 一次模型调用：返回原始 message，并累加 token。
      async function callModel(messages, useTools) {
        const res = await httpOnce(messages, useTools);
        const out = parseChat(res.data, messages, res.raw);
        tokens += out.used;
        return out.message;
      }

      // ---- agent loop ----------------------------------------------------
      const messages = [
        {
          role: "system",
          content: SYSTEM_PROMPT.replace("{role}", String(role || "coder"))
            .replace("{cwd}", rootLex)
            .replace("{roots}", rootsText),
        },
        { role: "user", content: ask },
      ];

      let finished = false;
      while (step < maxSteps) {
        const expired = checkDeadline();
        if (expired) return fail(expired);

        step += 1;
        let message;
        try {
          message = await callModel(messages, true);
        } catch (e) {
          return fail(errorText(e), e && e.fatal ? { fatal: true } : {});
        }
        bump();
        if (state.abortReason) return fail(state.abortReason);

        const calls = normalizeToolCalls(message && message.tool_calls, step);
        const content = flattenContent(message && message.content);
        messages.push(historyMessage(message, calls));
        if (content.trim()) text = content.trim();

        if (calls.length) {
          for (const call of calls) {
            const result = await execToolCall(call, toolsCtx, ctrl.signal);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          bump();
          if (state.abortReason) return fail(state.abortReason);
          continue;
        }

        finished = true;
        break;
      }

      if (!finished) {
        return fail(
          "达到最大步数 " + maxSteps + " 仍未给出最终正文（可调大 WB_BUILTIN_MAX_STEPS，或换更稳的模型）",
        );
      }

      // 只给了工具调用、没有正文：额外要一次收尾，别让整轮只剩工具输出。
      if (!text.trim()) {
        try {
          const message = await callModel(messages.concat([{ role: "user", content: FINAL_ASK }]), false);
          bump();
          text = flattenContent(message && message.content).trim();
        } catch (e) {
          return fail(errorText(e), e && e.fatal ? { fatal: true } : {});
        }
      }
      if (!text.trim()) return fail("模型没有给出任何正文（只返回了工具调用）");

      return { ok: true, text: text.trim(), tokens, elapsedMs: elapsed(), model };
    } finally {
      clearTimer();
    }
  }

  return { name: "builtin", model: model || null, run };
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

async function execToolCall(call, ctx, signal) {
  const name = call && call.function && call.function.name;
  const impl = TOOL_IMPL[name];
  if (!impl) return "错误：未知工具 " + String(name);
  let args = {};
  const rawArgs = call.function.arguments;
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return "错误：工具参数不是合法 JSON：" + String(rawArgs).slice(0, 200);
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs;
  }
  if (!args || typeof args !== "object") args = {};
  try {
    return String(await impl(args, ctx, signal));
  } catch (e) {
    return "错误：" + shortMessage(e);
  }
}

const TOOL_IMPL = {
  read_file(args, ctx) {
    const target = resolveReadable(ctx, args.path);
    let stat;
    try {
      stat = fs.statSync(target.real);
    } catch {
      throw new ToolFailure("文件不存在：" + relPath(ctx, target.abs));
    }
    if (!stat.isFile()) throw new ToolFailure("不是文件：" + relPath(ctx, target.abs));
    const buf = fs.readFileSync(target.real);
    if (buf.includes(0)) throw new ToolFailure("这是二进制文件，读不了：" + relPath(ctx, target.abs));
    const body = buf.toString("utf8");
    const CAP = 60000;
    if (body.length > CAP) {
      return body.slice(0, CAP) + "\n…（文件共 " + body.length + " 字符，已截断到 " + CAP + "）";
    }
    return body;
  },

  write_file(args, ctx) {
    const content = args.content === undefined || args.content === null ? "" : String(args.content);
    const target = resolveInside(ctx, args.path);
    try {
      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, content);
    } catch (e) {
      throw new ToolFailure("写入失败：" + (e && e.message || e));
    }
    return "已写入 " + relPath(ctx, target.abs) + "（" + Buffer.byteLength(content) + " 字节）";
  },

  list_files(args, ctx) {
    const target = resolveReadable(ctx, args.path === undefined ? "." : args.path);
    let stat;
    try {
      stat = fs.statSync(target.real);
    } catch {
      throw new ToolFailure("路径不存在：" + relPath(ctx, target.abs));
    }
    if (!stat.isDirectory()) throw new ToolFailure("不是目录：" + relPath(ctx, target.abs));
    const entries = fs.readdirSync(target.real, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return "（空目录）";
    const cap = 500;
    const lines = entries.slice(0, cap).map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    return lines.join("\n") + (entries.length > cap ? "\n…（共 " + entries.length + " 项，已截断）" : "");
  },

  grep(args, ctx) {
    const pattern = args.pattern;
    if (typeof pattern !== "string" || !pattern) throw new ToolFailure("pattern 不能为空");
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      throw new ToolFailure("正则不合法：" + shortMessage(e));
    }
    const target = resolveReadable(ctx, args.path === undefined ? "." : args.path);
    let stat;
    try {
      stat = fs.statSync(target.real);
    } catch {
      throw new ToolFailure("路径不存在：" + relPath(ctx, target.abs));
    }

    const files = stat.isFile() ? [target.real] : collectFiles(target.real, 2000);
    const hits = [];
    let truncated = false;
    const LINE_CAP = 200;
    outer: for (const file of files) {
      let body;
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        const buf = fs.readFileSync(file);
        if (buf.includes(0)) continue;
        body = buf.toString("utf8");
      } catch {
        continue;
      }
      const rel = relPath(ctx, file);
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          hits.push(rel + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 300));
          if (hits.length >= LINE_CAP) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    if (!hits.length) return "（无匹配）";
    return hits.join("\n") + (truncated ? "\n…（已达 " + LINE_CAP + " 行上限）" : "");
  },

  run_command(args, ctx, signal) {
    return runShell(String(args.command === undefined ? "" : args.command), args.timeout_ms, ctx, signal);
  },
};

/** 只走工作目录内的文件，符号链接一律跳过（不会顺藤摸到工作区外）。 */
function collectFiles(dir, budget) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= budget || depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
      if (out.length >= budget) return;
    }
  };
  walk(dir, 0);
  return out;
}

function runShell(command, timeoutArg, ctx, signal) {
  return new Promise((resolve) => {
    if (!command.trim()) return resolve("错误：command 不能为空");
    const timeout = Math.min(600000, positiveInt(timeoutArg, DEFAULT_CMD_TIMEOUT_MS));
    let child;
    try {
      child = spawn("bash", ["-lc", command], {
        cwd: ctx.rootLex,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,    // 自成进程组，超时能把整棵子树一起收掉
      });
    } catch (e) {
      return resolve("错误：命令启动失败：" + shortMessage(e));
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;

    const killTree = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已经死了
        }
      }
    };
    const onAbort = () => {
      aborted = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      cleanup();
      let combined = stdout;
      if (stderr) combined += (combined && !combined.endsWith("\n") ? "\n" : "") + stderr;
      let body = combined;
      let note = "";
      if (body.length > MAX_CMD_OUTPUT) {
        body = body.slice(0, MAX_CMD_OUTPUT);
        note = "\n…（输出超过 " + MAX_CMD_OUTPUT + " 字符，已截断）";
      }
      if (!body) body = "（无输出）";
      resolve(extra + body + note);
    };

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CMD_OUTPUT * 4) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CMD_OUTPUT * 4) stderr += d.toString();
    });
    child.on("error", (e) => finish("错误：命令启动失败：" + shortMessage(e) + "\n"));
    child.on("close", (code, sig) => {
      if (timedOut) return finish("错误：命令超时（" + timeout + "ms），已强制终止\n");
      if (aborted) return finish("错误：命令被中断\n");
      const how = sig ? "signal " + sig : "exit " + code;
      finish("[" + how + "]\n");
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);
  });
}

/** 命令子进程里不放凭据：模型能读到的输出里绝不该出现 key。 */
function childEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(k)) continue;
    // 我们自己就可能是被 node --test 拉起来的；不摘掉这个标记，
    // 子进程里的 node --test 会以为在递归调用自己，直接跳过整个文件。
    if (k === "NODE_TEST_CONTEXT") continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 路径与文本小工具
// ---------------------------------------------------------------------------

/**
 * 只读根目录：lead/architect 阶段的 cwd 是 <ws>/.oc/scratch/<taskId>，但要规划就得先读
 * <ws>/demo 这样的上游仓库。WB_BUILTIN_READ_ROOTS（冒号分隔，默认取 WB_ROOT，都没设就
 * 只有 cwd）列出这些根：read_file / list_files / grep 可以读，写入永远只认 cwd。
 */
function readRootsOf(env, rootLex) {
  const raw = String((env && env.WB_BUILTIN_READ_ROOTS) || (env && env.WB_ROOT) || "").trim();
  const roots = [];
  const seen = new Set();
  const add = (lex) => {
    const abs = path.resolve(lex);
    let real;
    try {
      real = fs.realpathSync(abs);
      if (!fs.statSync(real).isDirectory()) return;
    } catch {
      return; // 配置里的死路径不该拖垮整轮
    }
    if (seen.has(real)) return;
    seen.add(real);
    roots.push({ lex: abs, real });
  };
  add(rootLex);
  for (const part of raw.split(":")) {
    if (part.trim()) add(path.resolve(part.trim()));
  }
  return roots;
}

/** 读类工具：先按词法落在任一读根内，再按 realpath 校验一遍，符号链接绕不出去。 */
function resolveReadable(ctx, p) {
  const raw = p === undefined || p === null || String(p) === "" ? "." : String(p);
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ctx.rootLex, raw);
  if (!ctx.roots.some((r) => isInside(r.lex, abs))) {
    throw new ToolFailure("路径越界：只能只读访问工作目录或只读根目录内的路径（收到 " + raw + "）");
  }
  let real;
  try {
    real = realpathProbe(abs);
  } catch (e) {
    throw new ToolFailure("路径解析失败：" + shortMessage(e));
  }
  if (!ctx.roots.some((r) => isInside(r.real, real))) {
    throw new ToolFailure("路径越界：该路径的真实位置（可能是符号链接）不在可只读访问的根目录内（收到 " + raw + "）");
  }
  return { abs, real };
}

/** 写类工具：只认 cwd，词法 + realpath 双重校验。 */
function resolveInside(ctx, p) {
  const raw = p === undefined || p === null || String(p) === "" ? "." : String(p);
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ctx.rootLex, raw);
  if (!isInside(ctx.rootLex, abs)) {
    throw new ToolFailure("路径越界：只能写入工作目录内的路径（收到 " + raw + "）");
  }
  let real;
  try {
    real = realpathProbe(abs);
  } catch (e) {
    throw new ToolFailure("路径解析失败：" + shortMessage(e));
  }
  if (!isInside(ctx.rootReal, real)) {
    throw new ToolFailure("路径越界：写入目标经过符号链接指向了工作目录之外（收到 " + raw + "）");
  }
  return { abs, real };
}

/** 逐级 realpath：目标不存在时，用"最近存在的父目录"的 realpath 拼回尾巴。 */
function realpathProbe(p) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (!e || (e.code !== "ENOENT" && e.code !== "ENOTDIR")) throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  throw new ToolFailure("路径层级过深：" + p);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function relPath(ctx, abs) {
  // 只读根里的文件不在 cwd 下，用绝对路径显示，免得两棵树同名时混在一起。
  if (!isInside(ctx.rootLex, abs)) return abs;
  const rel = path.relative(ctx.rootLex, abs);
  return rel === "" ? "." : rel;
}

function normalizeToolCalls(raw, step) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i] || {};
    const fn = c.function || {};
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments === undefined ? {} : fn.arguments);
    out.push({
      id: typeof c.id === "string" && c.id ? c.id : "call_" + step + "_" + i,
      type: "function",
      function: { name: String(fn.name || ""), arguments: args },
    });
  }
  return out;
}

function historyMessage(message, calls) {
  const out = { role: "assistant", content: flattenContent(message && message.content) };
  if (calls.length) out.tool_calls = calls;
  return out;
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        return "";
      })
      .join("");
  }
  return "";
}

function assistantText(message) {
  if (!message) return "";
  const parts = [flattenContent(message.content)];
  if (Array.isArray(message.tool_calls)) {
    for (const c of message.tool_calls) {
      const fn = (c && c.function) || {};
      parts.push(String(fn.name || "") + String(fn.arguments || ""));
    }
  }
  return parts.join("\n");
}

function messagesText(messages) {
  return (messages || []).map((m) => assistantText(m)).join("\n");
}

async function readBodyText(res) {
  if (!res) return "";
  if (typeof res.text === "function") return await res.text();
  if (typeof res.json === "function") return JSON.stringify(await res.json());
  return "";
}

function shortMessage(e) {
  const s = e && e.message ? String(e.message) : String(e);
  return s.slice(0, 400);
}

function errorText(e) {
  if (e instanceof RunAborted || e instanceof BuiltinFailure) return e.message;
  return shortMessage(e);
}

function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      return reject(err);
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
