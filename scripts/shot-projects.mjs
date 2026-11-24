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

// ---- 3.5) 项目 C：停在一张复议会（越界卡）+ 人补的记一条 ----
// 越界本来是 worker 在验证时机械触发（stage_scope FAIL → openDecision），
// 这里为了截图/点击验证直接落一张同样的卡：账本里它就是一张 open decision。
const pC = (await post(alice, "/api/projects", {
  title: "给 calc 加取模运算", repo: ws.starterRepo, lane: "feature", budgetTokens: 1_200_000,
})).project;
await post(lead0, "/api/projects/" + pC.id + "/meeting");
det = (await getJson(lead0, "/api/projects/" + pC.id)).project;
await triage(lead0, det);
process.env.WB_ROOT = WS;
const { openDb } = await import("../src/core/db.mjs");
const { openDecision } = await import("../src/core/meetings.mjs");
const cdb = openDb();
openDecision(cdb, pC.id, {
  trigger: "scope", stageId: det.stages[0].stage_id, by: "runner-1",
  evidence: ["越界文件：src/mod.mjs", "阶段边界：docs/**"],
});
cdb.close();
await post(lead0, "/api/projects/" + pC.id + "/memory", {
  kind: "constraint", text: "取模只做整数，负数按数学定义取余", source: "设计评审",
});

// ---- 3.6) 项目 D：四个阶段全部交付，停在待签收资产 ----
const pD = (await post(lead0, "/api/projects", {
  title: "给 calc 加幂运算与溢出保护", repo: ws.starterRepo, lane: "feature", budgetTokens: 1_500_000,
})).project;
await post(lead0, "/api/projects/" + pD.id + "/meeting");
det = (await getJson(lead0, "/api/projects/" + pD.id)).project;
await triage(lead0, det);
await post(lead0, "/api/projects/" + pD.id + "/sign", { group: "A", note: "先做设计和契约" });
for (const name of ["设计", "契约"]) {
  const st = (await post(lead0, "/api/projects/" + pD.id + "/stages/" + encodeURIComponent(name) + "/start", {})).task;
  await pump(lead0, st.id, ["awaiting_review"]);
  await approveTask(lead0, st.id);
  await pump(lead0, st.id, ["done"]);
}
await post(lead0, "/api/projects/" + pD.id + "/sign", { group: "B", note: "契约清楚，实现做完一起合" });
for (const name of ["实现", "合并"]) {
  const st = (await post(lead0, "/api/projects/" + pD.id + "/stages/" + encodeURIComponent(name) + "/start", {})).task;
  await pump(lead0, st.id, ["awaiting_review"]);
  await approveTask(lead0, st.id);
  await pump(lead0, st.id, ["done"]);
}
// 合并完 → 项目自己进 settling 并写出沉淀包；等 worker 一轮把收尾补完。
for (let i = 0; i < 12; i++) {
  const d = (await getJson(lead0, "/api/projects/" + pD.id)).project;
  if (d.state === "settling" && (d.assets || []).length >= 2) break;
  await runOnce();
  await sleep(200);
}
const pDnow = await getJson(lead0, "/api/projects/" + pD.id);
if (pDnow.project.state !== "settling" || (pDnow.assets || []).length < 2) {
  throw new Error("项目 D 没收尾: " + pDnow.project.state + " assets=" + (pDnow.assets || []).length);
}

console.log("数据就绪:", pA.id, "实现=" + impl.state, "|", pB.id, "| 复议会", pC.id, "| 收尾", pD.id, pDnow.assets.length + " 个资产");

// ---- 4) 截图（lead 视角）----
const profile = "/tmp/wb-cdp-projects-" + process.pid;
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-breakpad", "--disable-crash-reporter",
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--window-size=1446,2800", "--user-data-dir=" + profile,
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
await send("Emulation.setDeviceMetricsOverride", { width: 1446, height: 2800, deviceScaleFactor: 1, mobile: false });
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
      settleFirst: geo(".proj .settle"),
      activity: geo("#activity-panel"),
      docH: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
    },
  };
})()`);
console.log(JSON.stringify(dom, null, 2));

// 四张项目卡（复议会 / 收尾资产 / 记忆 / 负责人）必须全在画面里：
// 面板自己有滚动条时，截图只拍到第一张卡，等于没证据。
const clipped = dom.geometry.panelScroll && dom.geometry.panelScroll.clipped;
if (clipped) {
  console.warn("提醒：项目面板仍是滚动的（scrollH " + dom.geometry.panelScroll.scrollH + " > clientH " + dom.geometry.panelScroll.clientH + "），截图只包含首屏");
}
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
const buf = Buffer.from(shot.data, "base64");
writeFileSync(OUT, buf);
console.log("shot=ok bytes=" + buf.length + " -> " + OUT);

// 第二张：面板滚到底，拍「复议会 + 项目记忆 + 收尾资产」三块。
// 一张图里塞不下四张项目卡时，拆成两张比合成一张假的全景更诚实。
const lower = await evalJs(`(() => {
  const panel = document.getElementById("projects-panel");
  panel.scrollTop = panel.scrollHeight;
  const box = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const pr = panel.getBoundingClientRect();
  return { panel: { top: Math.round(pr.top), bottom: Math.round(pr.bottom) }, meet: box(".proj .meet"), settle: box(".proj .settle"), mem: box(".proj .mem") };
})()`);
console.log("lower:", JSON.stringify(lower));
const shot2 = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
const buf2 = Buffer.from(shot2.data, "base64");
const OUT2 = resolve(ROOT, process.env.SHOT_OUT2 || "docs/projects-meeting.png");
writeFileSync(OUT2, buf2);
console.log("shot2=ok bytes=" + buf2.length + " -> " + OUT2);
if (!dom.geometry.settleFirst) throw new Error("首屏没拍到收尾资产卡（第一张项目应是 settling）: " + JSON.stringify(dom.geometry));
if (!lower.meet || !lower.mem) throw new Error("下半屏没拍到复议会/项目记忆: " + JSON.stringify(lower));

// ---- 5) 截图之后再真点一次按钮：证明 onclick -> POST -> 重渲染这条路是通的 ----
// prompt/alert 在无头窗口里会阻塞或返回 null，这里替身掉，否则点了等于没点。
const ui = await evalJs(`(async () => {
  window.prompt = () => "UI 点击验证：方向认可";
  window.__alerts = [];
  window.alert = (m) => window.__alerts.push(String(m));
  const proj = () => [...document.querySelectorAll(".proj")].find((p) => /日志输出统一/.test(p.textContent));
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

// ---- 6) 复议会 / 项目记忆 / 收尾资产：三块新界面也真点一遍 ----
// 这三块是「人只在岔路口出现」的落点，必须证明每一下都能写到账本里，
// 否则它们只是好看的面板。
const ui2 = await evalJs(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byTitle = (t) => [...document.querySelectorAll(".proj")].find((p) => p.textContent.includes(t));
  const pick = (p, re) => [...p.querySelectorAll("button")].find((b) => re.test(b.textContent));
  window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m));
  const out = {};

  // 1) 复议会：点「扩边界」-> POST /decisions/:id -> 卡消失
  const pc = byTitle("取模运算");
  out.meetingBefore = { meet: !!pc.querySelector(".meet"), open: (pc.querySelector(".meet") || {}).textContent ? pc.querySelector(".meet").textContent.slice(0, 60) : null };
  window.prompt = () => "越界文件确实属于本阶段，扩张边界";
  const mbtn = pick(pc, /^扩边界/);
  if (mbtn) { mbtn.click(); await wait(1800); }
  const pc2 = byTitle("取模运算");
  out.meetingAfter = {
    meet: !!pc2.querySelector(".meet"),
    owner: (pc2.textContent.match(/负责人\s*(\S+)/) || [])[1] || null,
  };

  // 2) 项目记忆：人补一条（两个 prompt：内容、类型）
  let seq = ["UI 点击补记：取模允许负数，按数学定义取余", "constraint"];
  window.prompt = () => seq.shift();
  const abtn = pick(pc2, /记一条/);
  if (abtn) { abtn.click(); await wait(1600); }
  const pc3 = byTitle("取模运算");
  const memRows = [...pc3.querySelectorAll(".mem li")].map((x) => x.textContent);
  out.memory = { clicked: !!abtn, count: memRows.length, hasMine: memRows.some((t) => t.includes("允许负数")) };

  // 3) 收尾资产：两张都点「收下」-> 项目 done
  const pd = byTitle("幂运算");
  const before = (pd.querySelector(".settle") || {}).textContent || "";
  out.settle = { before: before.slice(0, 40), clicks: 0 };
  for (let i = 0; i < 4; i++) {
    const p = byTitle("幂运算");
    const b = pick(p, /^收下$/);
    if (!b) break;
    window.prompt = () => "以后新项目直接套这个 workflow";
    b.click();
    await wait(1600);
    out.settle.clicks++;
  }
  const pd2 = byTitle("幂运算");
  out.settle.after = { badge: pd2.querySelector(".badge")?.textContent || null, settleGone: !pd2.querySelector(".settle") };

  // 4) 换人：把 C 项目 1 设计 指派给 bob（只有 lead 看得到这个按钮）
  const pe = byTitle("取模运算");
  window.prompt = () => "bob";
  const obtn = pick(pe, /^换人$/);
  if (obtn) { obtn.click(); await wait(1500); }
  const pe2 = byTitle("取模运算");
  const ownerLine = (pe2.textContent.split("负责人")[1] || "").slice(0, 24);
  out.owner = { clicked: !!obtn, text: ownerLine };

  // 5) 只看我盯的：lead0 自己盯的是 pA/pD，alice 的项目应被筛掉
  const beforeCount = document.querySelectorAll(".proj").length;
  document.getElementById("mine-btn").click();
  await wait(600);
  const titles = [...document.querySelectorAll("#projects .proj .phead b")].map((h) => h.textContent);
  out.mine = {
    beforeCount, afterCount: titles.length, titles,
    projCount: document.querySelectorAll("#projects .proj").length,
    btn: document.getElementById("mine-btn").textContent,
  };
  document.getElementById("mine-btn").click();
  await wait(400);
  out.mineBack = document.querySelectorAll(".proj").length;

  out.alerts = window.__alerts;
  return out;
})()`);
console.log("ui-click-2:", JSON.stringify(ui2));
if (!ui2.meetingBefore.meet) throw new Error("C 项目没有复议会卡: " + JSON.stringify(ui2.meetingBefore));
if (ui2.meetingAfter.meet) throw new Error("点了扩边界但复议会卡还在: " + JSON.stringify(ui2.meetingAfter));
if (!ui2.memory.clicked || !ui2.memory.hasMine) throw new Error("人补的记忆没出现在界面上: " + JSON.stringify(ui2.memory));
if (!ui2.settle.clicks) throw new Error("收尾资产没有可点的「收下」: " + JSON.stringify(ui2.settle));
if (!/已交付|完成/.test(ui2.settle.after.badge || "")) throw new Error("资产签完项目没到 done: " + JSON.stringify(ui2.settle.after));
if (!/bob/.test(ui2.owner.text || "")) throw new Error("换人后界面没显示新负责人: " + JSON.stringify(ui2.owner));
if (!(ui2.mine.afterCount < ui2.mine.beforeCount)) throw new Error("「只看我盯的」没筛掉别人的项目: " + JSON.stringify(ui2.mine));
if (ui2.mineBack !== ui2.mine.beforeCount) throw new Error("再点一次没恢复全部项目: " + JSON.stringify(ui2.mine));
if (ui2.alerts.length) throw new Error("界面动作报错了: " + JSON.stringify(ui2.alerts));
console.log("ui-click-2=ok 复议会→记忆→资产签收→换人→看板筛选 五步都在界面上点通了");


sock.close();
chrome.kill("SIGKILL");
server.kill("SIGTERM");
await sleep(300);
if (server.exitCode === null) server.kill("SIGKILL");
rmSync(profile, { recursive: true, force: true });
