import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * opencode provider：每个角色一次全新会话（不 --continue），
 * 保证 Verifier 不是 Coder 的同一实例——这是"人只 review"能否成立的前提。
 *
 * 2026-11-18 实测到的三个真实坑，这里全部兜住：
 * 1) opencode 必须写 ~/.local/share/opencode，沙箱里是只读的 → 把 XDG 三件套指进工作区。
 * 2) 模型额度耗尽时它不会退出，会一直挂着（实测 13 分钟 0 字节）→ 逐行看流，命中错误立刻 SIGKILL。
 * 3) 没有任何输出却 exit 0 的情况存在 → 空产出也算失败，不能当"干完了"。
 */

/** 这些字样出现在流里就说明这次调用已经废了，等下去只是烧时间。 */
const FATAL_PATTERNS = [
  /Free usage limit reached[^"\\]*/i,
  /AI_RetryError[^"\\]*/,
  /rate limit[^"\\]*/i,
  /No output generated[^"\\]*/i,
  /ProviderModelNotFoundError[^"\\]*/,
  /attempt to write a readonly database/i,
  /missing api key[^"\\]*/i,
  /unauthorized[^"\\]*/i,
  /insufficient[_ ]quota[^"\\]*/i,
];

export default async function createOpencode(opts = {}) {
  // 顺序：显式 opts.home → WB_OC_HOME → <WB_ROOT>/.oc → <cwd>/.oc。
  // 打包成 app 后 cwd 是包内 kernel/，只有落到工作区才读得到凭据。
  const home = path.resolve(
    opts.home || process.env.WB_OC_HOME || path.join(process.env.WB_ROOT || process.cwd(), ".oc"),
  );
  // 离线单包：引擎二进制随包分发（engine/opencode），不依赖 PATH。
  const userCfg = ensureProviderConfig(home);
  const model = opts.model || process.env.WB_MODEL || (userCfg ? userCfg.model : null);
  return {
    name: "opencode",
    async run({ prompt, cwd, timeoutMs, idleMs }) {
      const args = ["run", prompt, "--dir", cwd, "--format", "json"];
      if (model) args.push("--model", model);
      return await execOpencode(args, cwd, {
        timeoutMs: timeoutMs || 900000,
        idleMs: idleMs || 180000,
        home,
        model,
      });
    },
  };
}

function execOpencode(args, cwd, { timeoutMs, idleMs, home, model }) {
  const bin = engineBin();
  return new Promise((resolve) => {
    const env = {
      ...readProviderEnv(home),     // 本地凭据（.oc/private/provider.env，不进仓库）
      ...process.env,
      XDG_CONFIG_HOME: path.join(home, "config"),   // 自定义 provider 的 opencode.json 放这儿
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
    };
    // 规划阶段的 cwd 是临时目录，agent 想读目标仓库就是"目录外"，
    // 实测会被 opencode 自动拒绝（PermissionRejectedError），然后整轮只剩工具调用、
    // 一个字的正文都没有 —— 表现成"空产出"，白烧一整轮 token。
    // 这里用一层只读放行的配置把工作区根目录划进来；用户自己设了 OPENCODE_CONFIG 就不动。
    const overlay = process.env.OPENCODE_CONFIG ? null : ensureOverlay(home);
    if (overlay) env.OPENCODE_CONFIG = overlay;
    const p = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let pending = "";        // 还没凑成整行的尾巴
    let done = false;
    let idle = null;

    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(wall);
      clearTimeout(idle);
      clearInterval(logTimer);
      try { p.kill("SIGKILL"); } catch {}
      resolve({ ...v, model: model || null, elapsedMs: Date.now() - started });
    };
    const started = Date.now();

    const wall = setTimeout(() => {
      finish({ ok: false, error: "wall timeout " + timeoutMs + "ms", text: parseEvents(out).text, tokens: parseEvents(out).tokens });
    }, timeoutMs);

    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        finish({ ok: false, error: "idle timeout " + idleMs + "ms（引擎在跑但没有任何新输出）", text: parseEvents(out).text, tokens: parseEvents(out).tokens });
      }, idleMs);
    };
    bumpIdle();

    const onChunk = (d) => {
      const s = d.toString();
      out += s;
      pending += s;
      bumpIdle();
      // 只看完整行，避免半行 JSON 误判
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        const fatal = fatalFromLine(line);
        if (fatal) return finish({ ok: false, error: fatal, text: parseEvents(out).text, tokens: parseEvents(out).tokens });
      }
    };

    // opencode 把致命错误写进自己的日志文件，stdout 一个字节都不给（实测：限流时全程静默）。
    // 所以除了看流，还必须盯它自己的日志，否则只能等 wall timeout 才发现早已废掉。
    let logTimer = null;
    const logDir = path.join(env.XDG_DATA_HOME, "opencode", "log");
    let logCursor = null;
    const pollLog = () => {
      if (done) return;
      try {
        const names = fs.readdirSync(logDir).filter((f) => f.endsWith(".log")).sort();
        if (!names.length) return;
        const newest = names[names.length - 1];
        const file = path.join(logDir, newest);
        if (logCursor === null) {
          // 只认本次启动之后还在写的那个文件，避免捡到上一轮的历史错误
          if (fs.statSync(file).mtimeMs < started - 5000) return;
          logCursor = { file, offset: 0 };
        } else if (logCursor.file !== file) {
          logCursor = { file, offset: 0 };
        }
        const size = fs.statSync(file).size;
        if (size <= logCursor.offset) return;
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(size - logCursor.offset);
        fs.readSync(fd, buf, 0, buf.length, logCursor.offset);
        fs.closeSync(fd);
        logCursor.offset = size;
        const fatal = fatalFromLine(buf.toString());
        if (fatal) finish({ ok: false, error: fatal, text: parseEvents(out).text, tokens: parseEvents(out).tokens });
      } catch {
        // 日志目录可能还没建出来，下一轮再看
      }
    };
    logTimer = setInterval(pollLog, 1500);
    setTimeout(pollLog, 800);

    p.stdout.on("data", onChunk);
    p.stderr.on("data", onChunk);
    p.on("error", (e) => finish({ ok: false, error: "spawn failed: " + e.message, text: "", tokens: 0 }));

    p.on("close", (code) => {
      const parsed = parseEvents(out);
      const text = parsed.text || "";
      const tokens = parsed.tokens || estimate(text);
      if (code !== 0) {
        saveFailLog(home, out);
        return finish({ ok: false, error: "exit " + code + ": " + String(out).slice(-600), text, tokens });
      }
      if (!text.trim()) {
        saveFailLog(home, out);
        const bad = classifyFailure(out);
        return finish({ ok: false, fatal: !!(bad && bad.fatal), error: bad ? bad.error : "空产出", text: "", tokens });
      }
      finish({ ok: true, text, tokens });
    });
  });
}

/**
 * 没有正文时，判断这次失败要不要重试。
 * 规律（2026-11-22 实测）：opencode 一旦在工具上被权限拒绝，就让整轮结束在 tool-calls，
 * 正文一个字都不给，退出码还是 0 —— 上层如果当"空产出"重试，会把同样一幕再烧五遍钱。
 */
export function classifyFailure(raw) {
  const parsed = parseEvents(raw);
  if (String(parsed.text || "").trim()) return null;
  if (parsed.rejectedTool) {
    return {
      fatal: true,
      error: "引擎拒绝了文件访问（" + parsed.rejectedTool + "）：external_directory 权限拦住了工作区外的读写。",
    };
  }
  const why = parsed.lastReason
    ? "step-finish reason=" + parsed.lastReason + "，最后一轮只有工具调用没有正文"
    : "没有拿到任何 text 事件";
  return { fatal: false, error: "空产出：exit 0 但没有任何文本（" + why + "）" };
}

/** 从一行（可能就是错误事件的最后一行）里认出"已经废了"的原因。 */
function fatalFromLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  let ev = null;
  if (s.charAt(0) === "{") {
    try { ev = JSON.parse(s); } catch { ev = null; }
  }
  if (ev && ev.type === "error") {
    const e = ev.error || {};
    const msg = (e.data && (e.data.message || e.data.error)) || e.message || e.name || "unknown error";
    return "引擎报错: " + String(msg).slice(0, 400);
  }
  for (const re of FATAL_PATTERNS) {
    const m = s.match(re);
    if (m) return "引擎报错: " + String(m[0]).slice(0, 300);
  }
  return null;
}

/**
 * opencode --format json 是逐行 JSON 事件，形状随版本变，所以这里做宽进宽出：
 * 文本可能出现在 part.text / text / content；usage 可能在 usage / part.tokens。
 */
function parseEvents(raw) {
  let text = "";
  let tokens = 0;
  let lastReason = null;
  let rejectedTool = null;
  for (const line of String(raw).split("\n")) {
    const s = line.trim();
    if (s.charAt(0) !== "{") continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    if (ev.type === "error") continue;
    const part = ev.part || {};
    const cand = [part.text, ev.text, ev.content, part.content];
    for (const t of cand) if (typeof t === "string" && t) text += t;
    // 工具被权限拒绝时 opencode 只把错误塞在 tool part 的 state.error 里，正文一个字都不给。
    if (part.type === "tool" && part.state && part.state.status === "error") {
      const err = String(part.state.error || "");
      if (/PermissionRejected|permission/i.test(err)) {
        rejectedTool = String(part.tool || "tool") + " " + JSON.stringify(part.state.input || {});
      }
    }
    if (part.type === "step-finish" && part.reason) lastReason = part.reason;
    const u = ev.usage || part.tokens;
    if (u) {
      const total = u.total || ((u.input_tokens || u.input || 0) + (u.output_tokens || u.output || 0));
      tokens += total;
    }
  }
  return { text, tokens, lastReason, rejectedTool };
}

/** 失败时把原始事件落盘：万一是引擎事件形状变了，还能离线对着看，不用重跑烧钱。 */
function saveFailLog(home, raw) {
  try {
    const dir = path.join(home, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "fail-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl");
    fs.writeFileSync(file, String(raw).slice(-200000));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("fail-")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 5))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 日志写不下去不影响主流程 */ }
}

/**
 * 引擎二进制：WB_ENGINE_BIN 显式指定 → 包的 engine/opencode → PATH。
 * 离线私有云上 PATH 里不一定有 opencode，所以随包放一份是必须的。
 */
export function engineBin() {
  if (process.env.WB_ENGINE_BIN) return process.env.WB_ENGINE_BIN;
  const code = path.resolve(process.env.WB_CODE || process.cwd());
  const cands = [path.resolve(code, "../engine/opencode"), path.resolve(code, "engine/opencode")];
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 没有就试下一个 */ }
  }
  return "opencode";
}

/**
 * 内网 OpenAI 兼容端点：只靠三个环境变量（WB_LLM_BASE_URL / WB_LLM_API_KEY / WB_LLM_MODEL）
 * 就生成 opencode 的 provider 配置，不要求用户先学 opencode.json 的写法。
 * 已有配置且没给 WB_LLM_BASE_URL 时不碰，老用户不受影响。
 */
export function ensureProviderConfig(home) {
  const baseURL = process.env.WB_LLM_BASE_URL;
  const apiKeyVar = "WB_LLM_API_KEY";
  if (!baseURL || !process.env[apiKeyVar]) return null;
  const modelId = process.env.WB_LLM_MODEL || "gpt-4o-mini";
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      workbench: {
        npm: "@ai-sdk/openai-compatible",
        name: "workbench",
        options: { baseURL, apiKey: "{env:" + apiKeyVar + "}" },
        models: { [modelId]: { name: modelId } },
      },
    },
  };
  const file = path.join(home, "config/opencode/opencode.json");
  const body = JSON.stringify(cfg, null, 2) + "\n";
  try {
    let cur = "";
    try { cur = fs.readFileSync(file, "utf8"); } catch { /* 第一次写 */ }
    if (cur !== body) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
  } catch {
    // 写不进去就让引擎自己报错，至少不静默改掉用户已有配置
  }
  return { model: "workbench/" + modelId, baseURL };
}

/**
 * 只读放行"工作区根目录"的覆盖配置：规划阶段 cwd 在 .oc/scratch 下，
 * 目标仓库在 <root>/demo 之类的位置，不划进来的话 agent 一读就被拒。
 * 实测（2026-11-22）：拒绝之后整轮只剩工具调用、正文为空，表现成"空产出"。
 */
export function ensureOverlay(home) {
  const root = path.resolve(process.env.WB_ROOT || process.cwd());
  const scratch = path.join(home, "scratch");
  // bash 工具会把路径解析成 realpath（macOS 上 /tmp → /private/tmp），
  // 只放行 /tmp/... 的话 bash 那条路照样被拒。两个写法都给。
  const dirs = new Set([root, scratch]);
  for (const d of [root, scratch]) {
    try { dirs.add(fs.realpathSync(d)); } catch { /* 目录还不存在就算了 */ }
  }
  const file = path.join(home, "permission-overlay.json");
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    permission: {
      external_directory: Object.fromEntries([...dirs].map((d) => [d + "/*", "allow"])),
    },
  };
  const body = JSON.stringify(cfg, null, 2) + "\n";
  try {
    let cur = "";
    try { cur = fs.readFileSync(file, "utf8"); } catch { /* 第一次写 */ }
    if (cur !== body) fs.writeFileSync(file, body);
    return file;
  } catch {
    return null;   // 写不进去就退回原行为，至少不阻断运行
  }
}

/** 本机凭据只从 .oc/private/provider.env 读，绝不进仓库；已存在的环境变量优先。 */
function readProviderEnv(home) {
  const file = path.join(home, "private/provider.env");
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // 没有本地凭据就是没有，交给引擎自己报错
  }
  return out;
}

function estimate(s) { return s ? Math.max(1, Math.ceil(String(s).length / 4)) : 0; }