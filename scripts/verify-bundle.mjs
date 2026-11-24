#!/usr/bin/env node
/**
 * scripts/verify-bundle.mjs —— 离线单包验收。
 *
 * 做四件事，全部用「解包后的包内运行时」：
 *   1) 把 dist/workbench-<target>.tar.gz 解到临时目录，断言没有 data/.git/tests/scripts/node_modules 等禁忌目录；
 *   2) 用 env -i 的最小环境跑 install.sh --prefix <tmp> --no-systemd，再用包内 node 跑 wb doctor；
 *   3) WB_ENGINE=mock 起 server+worker，提交一个任务，等它跑完两轮（伪绿 → 真绿）；
 *   4) 用包内 node 读 sqlite 账本，断言护栏/事件/状态迁移都写了；然后 wb down，断言端口关闭。
 *
 * 用法：
 *   node scripts/verify-bundle.mjs [--target darwin-arm64|linux-x64] [--pkg <tarball>] [--keep] [--timeout 240]
 * 退出码：0 全绿，1 有断言失败（会先尽力把进程停掉）。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = { target: "", pkg: "", keep: false, timeout: 240 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--target") opt.target = args[++i];
  else if (a === "--pkg") opt.pkg = resolve(args[++i]);
  else if (a === "--keep") opt.keep = true;
  else if (a === "--timeout") opt.timeout = Number(args[++i]);
  else if (a === "--help" || a === "-h") { console.log("用法: node scripts/verify-bundle.mjs [--target ...] [--pkg ...] [--keep] [--timeout 240]"); process.exit(0); }
  else { console.error("未知参数: " + a); process.exit(1); }
}

function hostTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  return null;
}

const target = opt.target || hostTarget();
if (!target) { console.error("本机是 " + process.platform + "/" + process.arch + "，没有对应的可运行目标；请用 --target 指定后在有该架构的机器上验收。"); process.exit(1); }
if (target !== hostTarget()) { console.error("目标 " + target + " 无法在 " + process.platform + "/" + process.arch + " 上运行；linux-x64 包请在有 Linux 的机器上验收。"); process.exit(1); }

const pkgPath = opt.pkg || join(ROOT, "dist", "workbench-" + target + ".tar.gz");
if (!existsSync(pkgPath)) { console.error("找不到包: " + pkgPath + "（先跑 node scripts/bundle.mjs --target " + target + "）"); process.exit(1); }

let stepNo = 0;
function step(title) { stepNo++; console.log("\n[" + stepNo + "] " + title); }
const failures = [];
function check(ok, msg) {
  if (ok) { console.log("  ✓ " + msg); return true; }
  failures.push(msg);
  console.log("  ✗ " + msg);
  return false;
}
function fmtMB(n) { return (n / 1024 / 1024).toFixed(1) + " MB"; }

const tmp = mkdtempSync(join(tmpdir(), "wb-verify-"));
const extractDir = join(tmp, "extract");
const prefix = join(tmp, "prefix");
const home = join(tmp, "home");
mkdirSync(extractDir, { recursive: true });
mkdirSync(home, { recursive: true });
const pkgRoot = join(extractDir, "workbench-" + target);
const envFile = join(prefix, "workbench.env");
const nodeBin = join(prefix, "bin", "node");
const wbBin = join(prefix, "bin", "wb");
const wsDir = join(prefix, "workspace");
const pidsDir = join(wsDir, ".wb");
const logFile = join(pidsDir, "server.log");

function baseEnv(extra) {
  const pairs = [
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME=" + home,
    "TMPDIR=" + tmp,
    "LANG=C",
    "SHELL=/bin/sh",
  ].concat(extra || []);
  return pairs;
}
function minRun(cmd, cmdArgs, extraEnv, opts) {
  opts = opts || {};
  const r = spawnSync("/usr/bin/env", ["-i"].concat(baseEnv(extraEnv), [cmd], cmdArgs), {
    cwd: opts.cwd || tmp,
    timeout: opts.timeout || 120000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}
function wbRun(sub, extraEnv, opts) {
  return minRun(wbBin, [sub], ["WB_ENV_FILE=" + envFile].concat(extraEnv || []), opts);
}

function fetchJson(pathname, headers) {
  return fetch("http://127.0.0.1:" + port + pathname, { headers: headers || {}, signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .catch(() => null);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = await fetchJson("/api/health");
    if (j && j.ok) return j;
    await sleep(300);
  }
  return null;
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

let port = 0;
let upStarted = false;
let token = "";
let taskId = "";

async function stopAll(reason) {
  if (upStarted) {
    console.log("  · 收尾（" + reason + "）：wb down");
    const r = wbRun("down", [], { timeout: 40000 });
    if (r.status !== 0) console.log("    wb down 退出码 " + r.status + "：" + (r.stderr.trim() || r.stdout.trim()));
    upStarted = false;
  }
}

(async () => {
  console.log("workbench 离线包验收 · target=" + target);
  console.log("  包文件 " + pkgPath + "（" + fmtMB(statSync(pkgPath).size) + "）");
  console.log("  临时目录 " + tmp);

  step("包内容检查（tar -tzf）");
  const tarList = spawnSync("tar", ["-tzf", pkgPath], { encoding: "utf8", timeout: 120000 });
  check(tarList.status === 0, "tar 能读出包内容（条目 " + String(tarList.stdout.split("\n").filter(Boolean).length) + "）");
  const entries = tarList.stdout.split("\n").filter(Boolean);
  const forbidden = [
    [/(^|\/)(data|tests|scripts|node_modules|worktrees|\.git|\.oc|\.wb|\.cache)(\/|$)/, "data/tests/scripts/node_modules/worktrees/.git/.oc/.wb/.cache"],
    [/(^|\/)\.bench/, ".bench*"],
    [/(^|\/)\.demo/, ".demo*"],
    [/(^|\/)\.DS_Store$/, ".DS_Store"],
  ];
  for (const f of forbidden) {
    const hits = entries.filter((e) => f[0].test(e));
    check(hits.length === 0, "不含 " + f[1] + (hits.length ? "（命中 " + hits.slice(0, 5).join(", ") + "）" : ""));
  }
  for (const must of ["bin/node", "bin/wb", "engine/opencode", "kernel/package.json", "kernel/src/server/index.mjs", "SHA256SUMS", "install.sh", "uninstall.sh", "config.example.env", "README-OFFLINE.md", "licenses/NOTICE", "licenses/opencode-LICENSE", "licenses/node-LICENSE"]) {
    check(entries.some((e) => e === "workbench-" + target + "/" + must), "含 " + must);
  }

  step("解包 + install.sh（env -i 最小环境，非 root 模式）");
  const untar = spawnSync("tar", ["-xzf", pkgPath, "-C", extractDir], { encoding: "utf8", timeout: 180000 });
  check(untar.status === 0, "解包成功 → " + pkgRoot);
  const inst = minRun("sh", [join(pkgRoot, "install.sh"), "--prefix", prefix, "--no-systemd"], ["WB_PREFIX=" + prefix], { timeout: 180000 });
  if (inst.status !== 0) console.log(inst.stdout + "\n" + inst.stderr);
  check(inst.status === 0, "install.sh 退出 0");
  check(existsSync(nodeBin), "包内 node 已就位 bin/node");
  check(existsSync(wbBin), "wb 已就位 bin/wb");
  check(existsSync(join(prefix, "kernel", "src", "server", "index.mjs")), "kernel 已就位");
  check(existsSync(join(prefix, "engine", "opencode")), "engine/opencode 已就位");
  check(existsSync(envFile), "env 文件已生成 " + envFile);
  if (existsSync(envFile)) check((statSync(envFile).mode & 0o777) === 0o600, "env 文件权限 600");

  step("wb doctor（LLM 未配置时只应 WARN，不应 FAIL）");
  const doc = wbRun("doctor", [], { timeout: 120000 });
  console.log("  ---- doctor 输出 ----");
  for (const line of (doc.stdout + doc.stderr).trim().split("\n")) console.log("  " + line);
  console.log("  ---------------------");
  check(doc.status === 0, "doctor 退出 0（实际 " + doc.status + "）");
  check(!/\[FAIL\]/.test(doc.stdout + doc.stderr), "doctor 输出无 [FAIL]");
  const nodeVerLine = (doc.stdout.split("\n").find((l) => /node/.test(l)) || "").trim();
  check(/v2[2-9]\./.test(nodeVerLine), "doctor 报告包内 node 版本（" + nodeVerLine.replace(/\s+/g, " ") + "）");

  step("配置 mock 引擎（随机端口 + 一次性 token）");
  port = await freePort();
  token = randomBytes(16).toString("hex");
  const keepLines = readFileSync(envFile, "utf8").split("\n").filter((l) => l.trim() && !/^#/.test(l));
  const overrides = {
    WB_ENGINE: "mock", WB_MOCK_SCENARIO: "fakegreen", WB_NO_NPM: "1",
    WB_TOKEN: token, WB_PORT: String(port), WB_HOST: "127.0.0.1", WB_LOG_LINES: "200",
  };
  const baseLines = keepLines.filter((l) => !(l.split("=")[0] in overrides));
  const merged = baseLines.concat(Object.keys(overrides).map((k) => k + "=" + overrides[k])).join("\n") + "\n";
  writeFileSync(envFile, merged);
  check(readFileSync(envFile, "utf8").includes("WB_ENGINE=mock"), "env 写入 WB_ENGINE=mock（端口 " + port + "）");

  step("wb up + /api/health");
  const up = wbRun("up", [], { timeout: 90000 });
  console.log("  " + (up.stdout.trim() || up.stderr.trim() || "（无输出）").split("\n").join("\n  "));
  check(up.status === 0, "wb up 退出 0");
  upStarted = true;
  const health = await waitHealth(60000);
  check(!!health, "/api/health 通过" + (health ? "（pid " + health.pid + "，engine " + health.engine + "）" : ""));
  check(!!health && health.engine === "mock", "健康检查报告 engine=mock");
  check(existsSync(join(pidsDir, "server.pid")) && existsSync(join(pidsDir, "worker.pid")), "pid 文件在 " + pidsDir);
  check(existsSync(logFile), "server.log 已生成");

  step("提交任务并等它跑完（mock fakegreen：第一轮伪绿被护栏拦，第二轮真绿）");
  if (!health) throw new Error("服务没起来，后面无法验收；server.log 尾部：\n" + (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n") : "（无）"));
  const postRes = await fetch("http://127.0.0.1:" + port + "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-wb-token": token },
    body: JSON.stringify({ title: "离线包验证任务", repo: "demo" }),
    signal: AbortSignal.timeout(10000),
  });
  const postBody = await postRes.json().catch(() => ({}));
  check(postRes.status === 201 && !!postBody.task, "POST /api/tasks 返回 201（状态 " + postRes.status + "）");
  if (!postBody.task) console.log("    响应: " + JSON.stringify(postBody).slice(0, 500));
  taskId = postBody.task && postBody.task.id;
  check(!!taskId, "拿到任务 id " + taskId);

  const TERMINAL = new Set(["awaiting_review", "awaiting_approval", "awaiting_human", "done", "failed", "blocked"]);
  let lastState = "";
  const seen = new Set();
  const t0 = Date.now();
  let finalTask = null;
  while (Date.now() - t0 < opt.timeout * 1000) {
    const list = await fetchJson("/api/tasks", { "x-wb-token": token });
    const t = list && (list.tasks || []).find((x) => x.id === taskId);
    if (t) {
      finalTask = t;
      if (t.state !== lastState) {
        console.log("    · " + ((Date.now() - t0) / 1000).toFixed(1) + "s " + t.state + "（attempts " + t.attempts + "）");
        seen.add(t.state);
        lastState = t.state;
      }
      if (TERMINAL.has(t.state)) break;
    }
    await sleep(500);
  }
  check(!!finalTask && TERMINAL.has(finalTask.state), "任务到达终态 " + (finalTask && finalTask.state) + "（耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s）");
  check(!!finalTask && finalTask.state !== "failed" && finalTask.state !== "blocked", "任务没有被判 failed/blocked");
  // mock 的 verifying 只存在几十毫秒，500ms 轮询可能完全看不到；
  // 以账本里的 task.transition(to=verifying) 为准，不要用采样到的状态序列判。
  check(!!finalTask && finalTask.attempts >= 2, "attempts >= 2（实际 " + (finalTask && finalTask.attempts) + "，第一轮伪绿被拦下重做）");

  step("读账本（包内 node + node:sqlite）：护栏 / 事件 / 状态迁移");
  const dbPath = join(wsDir, "data", "ledger.db");
  check(existsSync(dbPath), "账本文件存在 " + dbPath);
  const reader = join(tmp, "dbread.mjs");
  writeFileSync(reader, [
    "import { DatabaseSync } from " + JSON.stringify("node:sqlite") + ";",
    "const [dbPath, taskId] = process.argv.slice(2);",
    "const db = new DatabaseSync(dbPath, { readOnly: true });",
    "const t = db.prepare(" + JSON.stringify("SELECT id,title,repo,state,attempts,owner,spent_tokens,evidence FROM tasks WHERE id = ?") + ").get(taskId);",
    "const ev = db.prepare(" + JSON.stringify("SELECT id,ts,type,actor,payload FROM events WHERE task_id = ? ORDER BY id") + ").all(taskId);",
    "console.log(JSON.stringify({ task: t, events: ev }));",
    "db.close();",
    "",
  ].join("\n"));
  let dbRead = minRun(nodeBin, [reader, dbPath, taskId || ""], [], { timeout: 30000 });
  if (dbRead.status !== 0 && /sqlite|experimental/i.test(dbRead.stderr)) {
    dbRead = minRun(nodeBin, ["--experimental-sqlite", reader, dbPath, taskId || ""], [], { timeout: 30000 });
  }
  if (dbRead.status !== 0) console.log(dbRead.stdout + "\n" + dbRead.stderr);
  check(dbRead.status === 0, "包内 node 能打开 sqlite 账本");
  let ledger = null;
  try { ledger = JSON.parse(dbRead.stdout.trim().split("\n").pop()); } catch { ledger = null; }
  check(!!ledger && !!ledger.task, "能查到任务行");
  const events = (ledger && ledger.events) || [];
  const parsed = events.map((e) => ({ id: e.id, type: e.type, actor: e.actor, payload: safeJson(e.payload) }));
  const verifyEvents = parsed.filter((e) => e.type === "evidence.patch" && e.payload && e.payload.verify);
  check(verifyEvents.length >= 2, "verify 证据写入 >= 2 条（实际 " + verifyEvents.length + "）");
  const transitions = parsed.filter((e) => e.type === "task.transition");
  check(transitions.length >= 4, "task.transition 事件 >= 4 条（实际 " + transitions.length + "）");
  check(parsed.some((e) => e.type === "impl.produced"), "impl.produced 事件已记录（coder 提交了实现）");
  check(parsed.some((e) => e.type === "task.transition" && e.payload && e.payload.to === "verifying"), "走过 verifying 阶段（账本有 to=verifying 迁移）");
  check(parsed.some((e) => e.type === "task.transition" && e.payload && e.payload.to === (ledger && ledger.task && ledger.task.state)), "有 to=" + (ledger && ledger.task && ledger.task.state) + " 的迁移");

  const v0 = verifyEvents[0] && verifyEvents[0].payload.verify;
  const vN = verifyEvents[verifyEvents.length - 1] && verifyEvents[verifyEvents.length - 1].payload.verify;
  check(!!v0 && v0.passed === false, "第一条 verify.passed=false（伪绿被拦）");
  check(!!vN && vN.passed === true, "最后一条 verify.passed=true（真绿放行）");
  const weakCheck = v0 && Array.isArray(v0.guards) && v0.guards.find((c) => c.id === "no_test_weakening");
  check(!!weakCheck && weakCheck.ok === false, "护栏 no_test_weakening 在第一次判定失败");
  check(!!v0 && Array.isArray(v0.guardsFailed) && v0.guardsFailed.length > 0, "第一次 guardsFailed 非空（" + (v0 && v0.guardsFailed && v0.guardsFailed.join(", ")) + "）");
  const lastFails = (vN && Array.isArray(vN.guards) ? vN.guards.filter((c) => !c.ok) : []).map((c) => c.id);
  check(!!vN && lastFails.length === 0, "最后一次全部护栏通过（" + ((vN && vN.guards) || []).length + " 项检查）");
  const testCheck = vN && Array.isArray(vN.guards) && vN.guards.find((c) => c.id === "tests_pass");
  check(!!testCheck && testCheck.ok === true, "护栏 tests_pass 在最终一轮通过");
  check(!!ledger && ledger.task && ledger.task.spent_tokens > 0, "账本记了 token 花费（" + (ledger && ledger.task && ledger.task.spent_tokens) + "）");
  check(existsSync(join(wsDir, "worktrees", taskId || "")), "任务 worktree 留在 worktrees/" + taskId);

  step("wb down：SIGTERM 停两进程，端口必须关闭");
  const down = wbRun("down", [], { timeout: 40000 });
  console.log("  " + (down.stdout.trim() || down.stderr.trim() || "（无输出）").split("\n").join("\n  "));
  check(down.status === 0, "wb down 退出 0");
  upStarted = false;
  let closed = false;
  const tDown = Date.now();
  while (Date.now() - tDown < 15000) {
    const h = await fetchJson("/api/health");
    if (!h) { closed = true; break; }
    await sleep(300);
  }
  check(closed, "/api/health 已不可达（端口 " + port + " 关闭，" + ((Date.now() - tDown) / 1000).toFixed(1) + "s）");
  const leftPids = existsSync(pidsDir) ? readdirSync(pidsDir).filter((f) => f.endsWith(".pid")) : [];
  check(leftPids.length === 0, "pid 文件已清理" + (leftPids.length ? "（残留 " + leftPids.join(", ") + "）" : ""));

  step("结果");
  const pkgSize = statSync(pkgPath).size;
  console.log("  包大小        " + fmtMB(pkgSize) + "（" + pkgSize + " 字节）");
  console.log("  任务          " + taskId + " → " + (finalTask && finalTask.state) + "，attempts " + (finalTask && finalTask.attempts));
  console.log("  verify 证据   " + verifyEvents.length + " 条（第一条 passed=" + (v0 && v0.passed) + "，最后一条 passed=" + (vN && vN.passed) + "）");
  console.log("  账本事件      " + events.length + " 条");

  if (failures.length) {
    console.log("\n✗ 验收失败 " + failures.length + " 项：");
    failures.forEach((f) => console.log("  - " + f));
    throw new Error("verify 失败");
  }
  console.log("\nVERIFY OK · " + target + " · " + fmtMB(pkgSize));
})().then(async () => {
  await stopAll("正常结束");
  cleanup();
  process.exit(failures.length ? 1 : 0);
}).catch(async (e) => {
  console.error("\n" + (e && e.stack || e));
  try { await stopAll("失败后收尾"); } catch { /* 收尾失败不该盖住原错误 */ }
  cleanup();
  process.exit(1);
});

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function cleanup() {
  if (opt.keep) { console.log("· --keep：保留临时目录 " + tmp); return; }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}
