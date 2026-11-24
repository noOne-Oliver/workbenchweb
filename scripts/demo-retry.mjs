#!/usr/bin/env node
/**
 * 端到端验证「护栏抓住 → 打回 → 重置 → 重做 → 通过」这条链路。
 *
 * 做法：把真实 provider 包一层故障注入（WB_FAULT=tautology），让 coder 第 1 次交出的测试
 * 变成 assert.equal(f(...), f(...)) 的同义反复；剩下的（护栏、重试、重置、Verifier、Reviewer）全是真的。
 *
 *   node scripts/demo-retry.mjs                                         # mock：免费、确定性、秒级
 *   WB_ENGINE=opencode WB_MODEL=<provider/model> node scripts/demo-retry.mjs --fresh
 *
 * 退出码：0 = 链路成立；2 = 链路没出现（比如模型没写数字断言，注入无从下手）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, ".demo/repo");
const DB = join(ROOT, "data/demo-retry.db");

process.env.WB_DB = DB;
process.env.WB_ROOT = ROOT;

const flag = (name) => process.argv.includes("--" + name);
const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
};

const TASK = {
  title: "给 src/calc.mjs 增加 pow(a, b)，并在 test/calc.test.mjs 补对应测试",
  accept: "node --test",
};

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

const CALC = [
  "export function calc(a, b, op) {",
  "  if (op === '+') return a + b;",
  "  if (op === '-') return a - b;",
  "  if (op === '*') return a * b;",
  "  if (op === '/') return a / b;",
  "  throw new Error('unknown op: ' + op);",
  "}",
  "",
].join("\n");

const TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert';",
  "import { calc } from '../src/calc.mjs';",
  "",
  "test('add', () => assert.equal(calc(2, 3, '+'), 5));",
  "test('sub', () => assert.equal(calc(5, 3, '-'), 2));",
  "test('mul', () => assert.equal(calc(2, 3, '*'), 6));",
  "test('div', () => assert.equal(calc(6, 3, '/'), 2));",
  "",
].join("\n");

function ensureRepo(fresh) {
  if (fresh && existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
  if (existsSync(join(REPO, ".git"))) return;
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(join(REPO, "test"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "demo-retry", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(REPO, "src/calc.mjs"), CALC);
  writeFileSync(join(REPO, "test/calc.test.mjs"), TEST);
  sh("git", ["init", "-q", "-b", "main"], REPO);
  sh("git", ["add", "-A"], REPO);
  sh("git", ["-c", "user.name=demo", "-c", "user.email=demo@local", "commit", "-q", "-m", "seed"], REPO);
  process.stdout.write("[demo] 种子仓库 " + REPO + "\n");
}

function freshDb() {
  if (!flag("fresh")) return;
  // sqlite 的 -wal/-shm 必须跟主文件一起删，否则投影会带着旧事务回来。
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = DB + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

const TERMINAL = new Set(["awaiting_review", "awaiting_approval", "awaiting_human", "blocked", "done"]);

function summarizeGuards(checks) {
  const failed = (checks || []).filter((c) => !c.ok);
  if (!failed.length) return "全绿";
  return failed.map((c) => c.id + "：" + String(c.detail).slice(0, 120)).join(" | ");
}

function printTimeline(db, taskId) {
  const evs = db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(taskId);
  for (const e of evs) {
    const p = JSON.parse(e.payload || "{}");
    if (e.type === "task.transition") {
      process.stdout.write("  " + e.type + " " + p.from + " -> " + p.to + " (" + (p.reason || "") + ")\n");
    } else if (e.type === "attempt.started") {
      process.stdout.write("  " + e.type + " #" + (p.attempt + 1) + "\n");
    } else if (e.type === "attempt.resumed") {
      process.stdout.write("  " + e.type + " #" + (p.attempt + 1) + " (" + (p.reason || "") + ")\n");
    } else if (e.type === "evidence.patch" && p.verify) {
      const v = p.verify;
      process.stdout.write("  verify " + (v.passed ? "PASS" : "FAIL") + "  " + summarizeGuards(v.guards) + "\n");
    } else if (e.type === "budget.spent") {
      process.stdout.write("  " + e.type + " " + p.tokens + " (" + ((p.detail || {}).role || "?") + ")\n");
    } else if (e.type === "impl.produced") {
      process.stdout.write("  " + e.type + " " + (p.diff_stat || "") + "\n");
    } else if (e.type === "run.error") {
      process.stdout.write("  " + e.type + " " + String(p.error || "").slice(0, 160) + "\n");
    } else {
      process.stdout.write("  " + e.type + "\n");
    }
  }
}

function checkChain(db, taskId) {
  const evs = db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(taskId);
  const verifies = evs.filter((e) => e.type === "evidence.patch" && JSON.parse(e.payload || "{}").verify)
    .map((e) => JSON.parse(e.payload).verify);
  const caught = verifies.find((v) => (v.guards || []).some((g) => g.id === "no_tautological_test" && !g.ok));
  const passedAfter = caught && verifies.slice(verifies.indexOf(caught) + 1).some((v) => v.passed);
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  const problems = [];
  if (!caught) problems.push("没看到 no_tautological_test 失败（注入没落地，或模型没写数字断言）");
  if (caught && !passedAfter) problems.push("护栏打回之后没有出现通过的验证");
  if (t.state !== "awaiting_review" && t.state !== "awaiting_human") problems.push("终态不是 awaiting_review（机器验证完、等人初筛），而是 " + t.state);
  if (t.attempts < 2) problems.push("attempts=" + t.attempts + "，没有发生重做");
  return { caught, passedAfter, task: t, problems };
}

async function main() {
  const engineName = process.env.WB_ENGINE || "mock";
  const fresh = flag("fresh") || !existsSync(DB);
  process.stdout.write("[demo] engine=" + engineName + " fault=" + (process.env.WB_FAULT || "-") + " db=" + DB + "\n");

  ensureRepo(fresh);
  freshDb();

  const { openDb } = await import("../src/core/db.mjs");
  const { createTask, getTask, transition, record } = await import("../src/core/ledger.mjs");
  const { pump } = await import("../src/runner/worker.mjs");
  const { getProvider } = await import("../src/runner/engine.mjs");
  await import("../src/runner/providers/index.mjs");

  const db = openDb(DB);
  const budget = Number(arg("budget", process.env.WB_BUDGET || 1000000));

  // 复用已有的待跑任务，避免每跑一次就多一条脏数据；没有就建一条。
  const existing = db.prepare("SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1").get();
  let taskId;
  if (fresh || !existing) {
    const created = createTask(db, { title: TASK.title, repo: REPO, owner: "demo", budgetTokens: budget });
    taskId = created.id;
    process.stdout.write("[demo] 新任务 " + taskId + " 预算 " + budget + "\n");
  } else {
    taskId = existing.id;
    process.stdout.write("[demo] 复用任务 " + taskId + "（当前 " + getTask(db, taskId).state + "）\n");
  }

  const prior = getTask(db, taskId);
  if (TERMINAL.has(prior.state)) {
    process.stdout.write("[demo] 任务已到终态 " + prior.state + "，改用 --fresh 重新跑一遍\n");
  } else if (prior.state === "blocked") {
    record(db, { taskId, type: "attempt.reset", actor: "demo", payload: { reason: "demo 重跑：额度归零" } });
    transition(db, taskId, "queued", { actor: "demo", reason: "demo 重跑" });
  }

  const provider = await getProvider(engineName);
  const workerId = "demo-" + process.pid;
  const startedAt = Date.now();

  for (let i = 0; i < 12; i += 1) {
    const picked = await pump(db, { workerId, provider, once: true });
    const t = getTask(db, taskId);
    if (!picked && TERMINAL.has(t.state)) break;
    if (!picked) {
      process.stdout.write("[demo] 没有可认领的任务，终态=" + t.state + "\n");
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  process.stdout.write("\n[demo] 事件时间线（" + elapsed + "s）\n");
  printTimeline(db, taskId);

  const { caught, task, problems } = checkChain(db, taskId);
  process.stdout.write("\n[demo] 终态=" + task.state + " attempts=" + task.attempts + " spent=" + task.spent_tokens + "\n");
  if (caught) {
    const g = caught.guards.find((x) => x.id === "no_tautological_test" && !x.ok);
    process.stdout.write("[demo] 护栏抓到：" + String(g.detail).slice(0, 200) + "\n");
  }
  if (problems.length) {
    process.stdout.write("[demo] 链路不成立：\n  - " + problems.join("\n  - ") + "\n");
    process.exit(2);
  }
  process.stdout.write("[demo] 链路成立：FAIL → 打回 → 重置 → 重做 → 通过 → awaiting_review（等人初筛）\n");
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + "\n");
  process.exit(1);
});
