#!/usr/bin/env node
/**
 * 重新生成 README 里的界面截图 —— 用中性路径，绝不把本机用户名带进公开仓库。
 *
 * 工作区放在 /tmp/workbench-demo（不是 /Users/<你的名字>/...），任务 owner 用 oliver。
 * 截完会读一遍 DOM 断言：页面上不出现 "/Users/" 和本机用户名，出现就报错不写文件。
 *
 * 用法：node scripts/shots.mjs   → docs/{inbox,executor-live,activity-shot,review-diff,review-raw,web-login,web-review}.png
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ensureWorkspace } from "../src/core/workspace.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = resolve(ROOT, "docs");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORBIDDEN = [process.env.HOME || "/Users/", "liujie"];

mkdirSync(DOCS, { recursive: true });

let chrome = null;
const children = []; // 起过的内核进程：任何一步抛错都要收干净，否则下一轮会连到上一轮的内核
let seq = 0;
const pending = new Map();
let sock = null;
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  sock.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

async function openChrome(cdpPort) {
  const profile = "/tmp/wb-shots-cdp-" + process.pid;
  chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-breakpad", "--disable-crash-reporter",
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    "--window-size=1446,1000", "--user-data-dir=" + profile,
    "--remote-debugging-port=" + cdpPort, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  let wsUrl = null;
  for (let i = 0; i < 120 && !wsUrl; i++) {
    await sleep(150);
    try { wsUrl = (await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json()).webSocketDebuggerUrl; } catch {}
  }
  if (!wsUrl) throw new Error("Chrome 没起来");
  const target = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/new?url=about:blank", { method: "PUT" })).json();
  sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1446, height: 1000, deviceScaleFactor: 1, mobile: false });
  return profile;
}

/** 截图前先确认页面上没有任何本机痕迹；有就直接失败，别把脏图提交上去。 */
async function shot(name, { scrollTo = null, clip = null } = {}) {
  if (scrollTo) await evalJs("(" + scrollTo + ")()");
  await sleep(400);
  const leaks = await evalJs("(() => {" +
    "const bad = " + JSON.stringify(FORBIDDEN) + ";" +
    "const text = document.body.innerText || '';" +
    "const hits = bad.filter((s) => s && text.includes(s));" +
    "const openCompose = !!(document.getElementById('compose-box') && document.getElementById('compose-box').open);" +
    "const around = hits.map((h) => { const i = text.indexOf(h); return text.slice(Math.max(0, i - 60), i + 60).replace(/\\n/g, ' / '); });" +
    "return { hits, around, openCompose, chars: text.length };" +
    "})()");
  if (leaks.hits.length) throw new Error(name + " 里出现了本机痕迹 " + JSON.stringify(leaks.hits) + "；上下文: " + JSON.stringify(leaks.around));
  if (leaks.openCompose) throw new Error(name + " 里「新建任务」是展开的，会露出绝对路径");
  const r = await send("Page.captureScreenshot", clip
    ? { format: "png", clip: { ...clip, scale: 1 } }
    : { format: "png" });
  const buf = Buffer.from(r.data, "base64");
  writeFileSync(resolve(DOCS, name), buf);
  console.log("  shot " + name.padEnd(18) + buf.length + " 字节 · 文本 " + leaks.chars + " 字");
}

async function waitFor(expr, label, tries = 120, ms = 250) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(expr).catch(() => false)) return true;
    await sleep(ms);
  }
  const see = await evalJs("(document.body && document.body.innerText || '').slice(0, 300)").catch(() => "(页面读不到)");
  throw new Error("等不到 " + label + "；页面现在是: " + JSON.stringify(see) + " ；地址 " + (await evalJs("location.href").catch(() => "?")));
}

// ---------- 阶段 1：不需要登录的界面（收件箱 / 执行器 / 活动流 / diff / 原始输出） ----------
async function phaseNoAuth(base, cdpPort) {
  await assertPortFree(new URL(base).port);
  const WS = "/tmp/workbench-demo";
  rmSync(WS, { recursive: true, force: true });
  const ws = ensureWorkspace(WS);

  const up = spawn(process.execPath, [resolve(ROOT, "src/cli.mjs"), "up"], {
    cwd: ROOT,
    env: { ...process.env, WB_ROOT: WS, WB_CODE: ROOT, WB_PORT: String(new URL(base).port), WB_NO_AUTH: "1", WB_ENGINE: "mock", WB_WORKER_BEAT_MS: "1000", WB_MOCK_DELAY: "1200",
      // 工作进程默认用 hostname:pid 当身份，而这台机器的 hostname 里带用户名 → 截图里会露出来
      WB_WORKER_ID: "runner-1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(up);
  let log = "";
  up.stdout.on("data", (d) => { log += String(d); });
  up.stderr.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
  }

  // 免登录模式下 /api/tasks 会 403（没有登录用户就没有 create_task 权限），
  // 所以直接走 CLI 入队 —— 这也是"脚本/CI 提交任务"的真实用法。
  const mk = (title) => {
    const r = spawnSync(process.execPath, [resolve(ROOT, "src/cli.mjs"), "enqueue",
      "--title", title, "--repo", ws.starterRepo, "--owner", "oliver", "--budget", "2000000"], {
      env: { ...process.env, WB_ROOT: WS }, encoding: "utf8",
    });
    if (r.status !== 0) throw new Error("入队失败: " + (r.stderr || "").slice(0, 300));
    return r.stdout.trim();
  };
  const jobs = [mk("实现 calc 四则运算与除零报错"), mk("给 calc 加乘法")].map((id) => ({ id }));
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    const list = (await (await fetch(base + "/api/tasks")).json()).tasks.filter((t) => jobs.some((j) => j.id === t.id));
    if (list.every((t) => t.state.startsWith("awaiting_") || t.state === "blocked")) break;
  }

  await openChrome(cdpPort);
  await send("Page.navigate", { url: base + "/" });
  await waitFor("!!document.querySelector('.cards .card')", "卡片");
  await waitFor("document.getElementById('kernel-state') && document.getElementById('kernel-state').classList.contains('ok')", "执行器在线徽章");

  // 整页是 body flex + main 自己滚（body 是 overflow:hidden），所以 window.scrollTo 没用，要滚 main。
  await evalJs("(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 0; window.scrollTo(0, 0); })()");
  await shot("inbox.png");
  // 执行器徽章在图里很小，单独裁一条头部，README 里才看得清"在线/断线"这件事
  await shot("executor-live.png", { clip: { x: 0, y: 0, width: 1446, height: 74 } });
  await shot("activity-shot.png", { scrollTo: "() => { const m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight; const e = document.getElementById('events'); if (e) e.scrollTop = e.scrollHeight; }" });
  await shot("review-diff.png", { scrollTo: "() => { const d = document.querySelector('.dfile, .dlines'); if (d) d.scrollIntoView({block: 'start'}); }" });
  await evalJs("(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('全屏看原始输出')); if (b) b.click(); })()");
  await sleep(600);
  await shot("review-raw.png");

  up.kill("SIGTERM");
  await sleep(600);
  try { up.kill("SIGKILL"); } catch {}
  return log;
}

// ---------- 阶段 2：登录页 + 登录后的 review 界面 ----------
async function phaseAuth(base, cdpPort) {
  await assertPortFree(new URL(base).port);
  const WS = "/tmp/workbench-demo-auth";
  rmSync(WS, { recursive: true, force: true });
  const ws = ensureWorkspace(WS);

  const server = spawn(process.execPath, [resolve(ROOT, "src/server/index.mjs")], {
    cwd: ROOT,
    env: { ...process.env, WB_ROOT: WS, WB_CODE: ROOT, WB_PORT: String(new URL(base).port), WB_ADMIN_NAME: "lead0", WB_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(server);
  let log = "";
  server.stdout.on("data", (d) => { log += String(d); });
  server.stderr.on("data", (d) => { log += String(d); });
  let pw = null;
  for (let i = 0; i < 120 && !pw; i++) {
    await sleep(150);
    pw = (log.match(/一次性口令: (\S+)/) || [])[1];
  }
  if (!pw) throw new Error("服务没打印一次性口令: " + log.slice(0, 400));

  // 登录墙后面得先有东西可看：入队两个任务并推进到待裁决
  for (const title of ["实现 calc 四则运算", "给 calc 加乘法"]) {
    const r = spawnSync(process.execPath, [resolve(ROOT, "src/cli.mjs"), "enqueue",
      "--title", title, "--repo", ws.starterRepo, "--owner", "lead0", "--budget", "2000000"], {
      env: { ...process.env, WB_ROOT: WS }, encoding: "utf8",
    });
    if (r.status !== 0) throw new Error("入队失败: " + (r.stderr || "").slice(0, 300));
  }
  const run = spawnSync(process.execPath, [resolve(ROOT, "src/cli.mjs"), "run", "--once"], {
    env: { ...process.env, WB_ROOT: WS, WB_ENGINE: "mock", WB_MOCK_DELAY: "800", WB_WORKER_ID: "runner-1" }, encoding: "utf8", timeout: 120000,
  });
  if (run.status !== 0) throw new Error("推进任务失败: " + (run.stderr || "").slice(0, 300));

  await send("Page.navigate", { url: base + "/" });
  await waitFor("location.pathname === '/login.html'", "跳转到登录页");
  await sleep(300);
  await shot("web-login.png");

  await evalJs('document.getElementById("name").value = "lead0";' +
    'document.getElementById("password").value = ' + JSON.stringify(pw) + ';' +
    'document.getElementById("login").requestSubmit(); "ok"');
  await waitFor("location.pathname === '/' && !!document.querySelector('.cards .card')", "登录后看到卡片");

  await evalJs("window.scrollTo(0, 0)");
  await shot("web-review.png");

  server.kill("SIGTERM");
  await sleep(400);
  try { server.kill("SIGKILL"); } catch {}
  rmSync(WS, { recursive: true, force: true });
  return log;
}

const PORT_A = Number(process.env.SHOT_PORT || 7801);
const PORT_B = PORT_A + 1;
const CDP = Number(process.env.SHOT_CDP || 9341);

/** 端口必须空着：否则会连到上一轮遗留的内核，截图里是别人的工作区。 */
async function assertPortFree(port) {
  for (let i = 0; i < 20; i++) {
    try {
      await fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(800) });
    } catch {
      return; // 连不上 = 空着
    }
    await sleep(500);
  }
  throw new Error("端口 " + port + " 已被占用（上一轮的内核没退干净？先 lsof -nP -iTCP:" + port + " -sTCP:LISTEN）");
}

const phase = process.argv[2] || "all";
try {
  if (phase === "all" || phase === "noauth") {
    console.log("== 1/2 免登录界面（/tmp/workbench-demo）");
    await phaseNoAuth("http://127.0.0.1:" + PORT_A, CDP);
    sock && sock.close();
    chrome && chrome.kill("SIGKILL");
    chrome = null;
    await sleep(500);
  }
  if (phase === "all" || phase === "auth") {
    console.log("== 2/2 登录页与登录后（/tmp/workbench-demo-auth）");
    await openChrome(CDP + 1);
    await phaseAuth("http://127.0.0.1:" + PORT_B, CDP + 1);
  }
  console.log("完成");
} finally {
  try { sock && sock.close(); } catch {}
  try { chrome && chrome.kill("SIGKILL"); } catch {}
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch {}
  }
  await sleep(400);
  for (const c of children) {
    try { c.kill("SIGKILL"); } catch {}
  }
}
