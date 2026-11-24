#!/usr/bin/env node
/**
 * 给「项目 / 阶段链」界面留证据：一个项目推进到实现阶段等人初筛，一个停在待签字。
 * 用 WB_ENGINE=stage（确定性按阶段产出）跑，不联网、几秒完成。
 */
import { execSync, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureWorkspace } from "../src/core/workspace.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WS = resolve(process.env.SHOT_WS || resolve(ROOT, ".demo/projects-ws"));
const PORT = Number(process.env.SHOT_PORT || 7795);
const CDP_PORT = Number(process.env.SHOT_CDP || 9341);
const BASE = "http://127.0.0.1:" + PORT;
const OUT = resolve(ROOT, process.env.SHOT_OUT || "docs/projects.png");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 上一次跑挂了会留下占着端口的服务（它握着的还是旧工作区），先收掉，
// 否则新口令没人打印、登录必然失败。
try {
  const pids = execSync("lsof -nP -iTCP:" + PORT + " -sTCP:LISTEN -t", { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
  for (const pid of pids) { process.kill(Number(pid), "SIGTERM"); console.log("清掉残留服务 pid=" + pid); }
  if (pids.length) await sleep(600);
} catch { /* 端口空闲，lsof 退出码 1 */ }

rmSync(WS, { recursive: true, force: true });
const ws = ensureWorkspace(WS);

const server = spawn(process.execPath, [resolve(ROOT, "src/server/index.mjs")], {
  cwd: ROOT,
  env: { ...process.env, WB_ROOT: WS, WB_CODE: ROOT, WB_PORT: String(PORT), WB_HOST: "127.0.0.1", WB_ADMIN_NAME: "lead0", WB_TOKEN: "", WB_WORKER_ID: "runner-1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvOut = "";
// 中途 throw 时也要收掉子进程，不然下次跑就撞端口。
const cleanup = () => { try { server.kill("SIGTERM"); } catch { /* ignore */ } };
process.on("exit", cleanup);
process.on("uncaughtException", (e) => { console.error(e); cleanup(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); cleanup(); process.exit(1); });
server.stdout.on("data", (d) => { srvOut += String(d); });
server.stderr.on("data", (d) => { srvOut += String(d); });

async function login(name, password) {
  const r = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  if (r.status !== 200) throw new Error("登录失败 " + name + ": " + (await r.text()));
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
const post = async (cookie, path, body) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new Error(path + " -> " + r.status + " " + (j.error || ""));
  return j;
};
const getJson = async (cookie, path) => (await fetch(BASE + path, { headers: { cookie } })).json();
const taskState = async (cookie, id) => (await getJson(cookie, "/api/tasks/" + id)).task.state;
const runOnce = () => new Promise((res) => {
  const c = spawn(process.execPath, [resolve(ROOT, "src/cli.mjs"), "run", "--once"], {
    cwd: ROOT, env: { ...process.env, WB_ROOT: WS, WB_ENGINE: "stage", WB_WORKER_ID: "runner-1" }, stdio: "ignore",
  });
  c.on("exit", res);
});
async function pump(cookie, id, want, max = 40) {
  for (let i = 0; i < max; i++) {
    const s = await taskState(cookie, id);
    if (want.includes(s)) return s;
    await runOnce();
  }
  throw new Error("任务没到 " + want.join("/") + "，最后是 " + (await taskState(cookie, id)));
}

// ---- 1) 账号 ----
for (let i = 0; i < 80 && !/一次性口令: /.test(srvOut); i++) await sleep(100);
const bootPw = (srvOut.match(/一次性口令: (\S+)/) || [])[1];
if (!bootPw) throw new Error("服务没起来: " + srvOut.slice(0, 300));
const lead0 = await login("lead0", bootPw);
for (const [name, role] of [["alice", "member"], ["bob", "member"]]) {
  await post(lead0, "/api/users", { name, role, password: "wb-" + name + "-123" });
}
const alice = await login("alice", "wb-alice-123");

const triage = async (cookie, project) => {
  for (const b of project.backlog.filter((x) => x.status === "open")) {
    await post(cookie, "/api/projects/" + project.id + "/backlog/" + b.id, { status: "next", note: "下一阶段做" });
  }
};
const approveTask = async (cookie, id) => {
  await post(alice, "/api/tasks/" + id + "/review", { action: "claim" });
  await post(alice, "/api/tasks/" + id + "/review", { action: "pass", note: "范围与目标一致" });
  await post(cookie, "/api/tasks/" + id + "/review", { action: "approve", note: "产出物齐全，合并" });
};

// ---- 2) 项目 A：跑到实现阶段，停在等人初筛 ----
const pA = (await post(lead0, "/api/projects", {
  title: "给 calc 加乘法、除法与除零报错", repo: ws.starterRepo, lane: "feature", budgetTokens: 2_000_000,
})).project;
await post(lead0, "/api/projects/" + pA.id + "/meeting");
let det = (await getJson(lead0, "/api/projects/" + pA.id)).project;
await triage(lead0, det);
await post(lead0, "/api/projects/" + pA.id + "/sign", { group: "A", note: "设计与契约的方向认可" });
for (const name of ["设计", "契约"]) {
  const st = (await post(lead0, "/api/projects/" + pA.id + "/stages/" + encodeURIComponent(name) + "/start", {})).task;
  await pump(lead0, st.id, ["awaiting_review"]);
  await approveTask(lead0, st.id);
  await pump(lead0, st.id, ["done"]);
}
await post(lead0, "/api/projects/" + pA.id + "/sign", { group: "B", note: "契约清楚，可以动手写" });
const impl = (await post(lead0, "/api/projects/" + pA.id + "/stages/" + encodeURIComponent("实现") + "/start", {})).task;
await pump(lead0, impl.id, ["awaiting_review"]);

// ---- 3) 项目 B：停在待签字，展示闸门与发散项分流 ----
const pB = (await post(alice, "/api/projects", {
  title: "把日志输出统一到 logger 模块", repo: ws.starterRepo, lane: "feature", budgetTokens: 1_500_000,
})).project;
await post(lead0, "/api/projects/" + pB.id + "/meeting");

console.log("数据就绪:", pA.id, "实现=" + impl.state, "|", pB.id);

// ---- 4) 截图（lead 视角）----
const profile = "/tmp/wb-cdp-projects-" + process.pid;
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-breakpad", "--disable-crash-reporter",
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--window-size=1446,1500", "--user-data-dir=" + profile,
  "--remote-debugging-port=" + CDP_PORT, "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(150);
  try { wsUrl = (await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json()).webSocketDebuggerUrl; } catch {}
}
if (!wsUrl) throw new Error("Chrome 没起来");

const target = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/new?url=about:blank", { method: "PUT" })).json();
const sock = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
let seq = 0;
const pending = new Map();
sock.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); sock.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1446, height: 1500, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE + "/login.html" });
await sleep(1200);
await evalJs('document.getElementById("name").value = "lead0";' +
  'document.getElementById("password").value = ' + JSON.stringify(bootPw) + ';' +
  'document.getElementById("login").requestSubmit(); "ok"');

let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  await sleep(250);
  ready = await evalJs('location.pathname === "/" && document.querySelectorAll(".proj").length >= 2').catch(() => false);
}
if (!ready) throw new Error("登录后没看到项目卡：" + (await evalJs("location.href")));

const dom = await evalJs(`(() => {
  const projects = [...document.querySelectorAll(".proj")].map((p) => ({
    title: p.querySelector("h3")?.textContent,
    state: p.querySelector(".badge")?.textContent,
    chips: [...p.querySelectorAll(".stg")].map((s) => s.textContent.trim()),
    buttons: [...p.querySelectorAll("button")].map((b) => b.textContent),
    backlog: [...p.querySelectorAll(".bl")].map((b) => b.textContent.slice(0, 40)),
  }));
  const cards = [...document.querySelectorAll(".cards .card")].map((c) => ({
    title: c.querySelector("h3")?.textContent,
    state: c.querySelector(".badge")?.textContent,
    badge: c.querySelector(".badge")?.textContent,
  }));
  const geo = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { top: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) } : null; };
  return {
    projects, cards, nodes: document.querySelectorAll("*").length,
    geometry: {
      viewport: [innerWidth, innerHeight],
      projectsPanel: geo("#projects-panel"),
      proj1: geo(".proj"),
      projLast: (() => { const all = [...document.querySelectorAll(".proj")]; const b = all[all.length - 1]?.getBoundingClientRect(); return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } : null; })(),
      panelScroll: (() => { const p = document.getElementById("projects-panel"); return p ? { scrollH: p.scrollHeight, clientH: p.clientHeight, clipped: p.scrollHeight > p.clientHeight } : null; })(),
      card1: geo(".cards .card"),
      activity: geo("#activity-panel"),
      docH: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
    },
  };
})()`);
console.log(JSON.stringify(dom, null, 2));

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
const buf = Buffer.from(shot.data, "base64");
writeFileSync(OUT, buf);
console.log("shot=ok bytes=" + buf.length + " -> " + OUT);

// ---- 5) 截图之后再真点一次按钮：证明 onclick -> POST -> 重渲染这条路是通的 ----
// prompt/alert 在无头窗口里会阻塞或返回 null，这里替身掉，否则点了等于没点。
const ui = await evalJs(`(async () => {
  window.prompt = () => "UI 点击验证：方向认可";
  window.__alerts = [];
  window.alert = (m) => window.__alerts.push(String(m));
  const proj = () => document.querySelector(".proj");
  const pick = (re) => [...proj().querySelectorAll("button")].find((b) => re.test(b.textContent));
  // 顺序很重要：有未分流的发散项时签字会被拦（「还有 N 条发散项没分流」），
  // 所以先点一次分流按钮，再点签字——这正是人在这页上真实的操作顺序。
  const triage = pick(/^下一阶段做/);
  if (triage) { triage.click(); await new Promise((r) => setTimeout(r, 1200)); }
  const btn = pick(/^签 A 组/);
  if (!btn) return { clicked: false, triaged: !!triage, buttons: [...proj().querySelectorAll("button")].map((b) => b.textContent) };
  btn.click();
  await new Promise((r) => setTimeout(r, 1800));
  // 顺手点一次「开工」：这是人在这页上的第二个动作，走 startStage -> POST -> 生出任务卡。
  const before = document.querySelectorAll(".card").length;
  const start = [...proj().querySelectorAll("button")].find((b) => /^开工 1 设计/.test(b.textContent));
  if (start) { start.click(); await new Promise((r) => setTimeout(r, 1500)); }
  const after = document.querySelectorAll(".card").length;
  const p = proj();
  return {
    clicked: true,
    triaged: !!triage,
    started: !!start,
    startButtonGone: ![...proj().querySelectorAll("button")].some((b) => /^开工/.test(b.textContent)),
    cardsBefore: before,
    cardsAfter: after,
    alerts: window.__alerts,
    stageChips: [...p.querySelectorAll(".stg")].map((x) => x.textContent),
    state: p.querySelector(".badge")?.textContent,
    signed: [...p.querySelectorAll(".row")].map((x) => x.textContent).filter((t) => /已签/.test(t)),
    backlogBadge: [...p.querySelectorAll(".backlog .badge")].map((x) => x.textContent),
    buttons: [...p.querySelectorAll("button")].map((b) => b.textContent),
  };
})()`);
console.log("ui-click:", JSON.stringify(ui));
if (!ui.clicked) throw new Error("找不到「签 A 组」按钮: " + JSON.stringify(ui));
if (!/已签 A 组/.test(ui.signed.join(" "))) throw new Error("点了签字但界面没更新: " + JSON.stringify(ui));
if (!ui.started) throw new Error("签完没出现「开工 1 设计」按钮: " + JSON.stringify(ui));
if (ui.cardsAfter <= ui.cardsBefore) throw new Error("点了开工但没生出任务卡: " + JSON.stringify(ui));
if (!ui.startButtonGone) throw new Error("开工后按钮还在，可能重复起了任务: " + JSON.stringify(ui));
if (ui.alerts && ui.alerts.length) throw new Error("界面动作报错了: " + JSON.stringify(ui.alerts));
console.log("ui-click=ok 分流→签字→开工三步都在界面上点通了（任务卡 " + ui.cardsBefore + " → " + ui.cardsAfter + "）");

sock.close();
chrome.kill("SIGKILL");
server.kill("SIGTERM");
await sleep(300);
if (server.exitCode === null) server.kill("SIGKILL");
rmSync(profile, { recursive: true, force: true });
