#!/usr/bin/env node
/**
 * 阶段链端到端演示（不需要真模型，几秒跑完）：
 *   建项目 -> 机器开预备会 -> 人签 A 组（设计+契约）-> 跑设计/契约 -> 人签 B 组（实现+合并）
 *   -> 跑实现/合并 -> 项目 done。另有一个故意越界的反例，验证阶段闸门真的会打回。
 *
 * 用法：node scripts/demo-stage.mjs [--fresh]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WS = resolve(ROOT, ".demo/stage-ws");
const REPO = join(WS, "repo");

if (process.argv.includes("--fresh")) rmSync(WS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });

// 必须在 import 内核之前设好：db / worker 的 ROOT 是模块级常量。
process.env.WB_ROOT = WS;
process.env.WB_DB = join(WS, "data/ledger.db");
process.env.WB_ENGINE = "mock";

const { openDb } = await import("../src/core/db.mjs");
const { getTask, record, transition } = await import("../src/core/ledger.mjs");
const st = await import("../src/core/stages.mjs");
const { pump } = await import("../src/runner/worker.mjs");
const { default: createStage } = await import("../src/runner/providers/stage.mjs");

const fails = [];
const rows = [];
function check(name, cond, extra = "") {
  const ok = !!cond;
  rows.push({ check: name, ok, extra });
  if (!ok) fails.push(name + (extra ? " — " + extra : ""));
  console.log((ok ? "  ok   " : "  FAIL ") + name + (extra ? "  (" + extra + ")" : ""));
  return ok;
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

function seedRepo() {
  if (existsSync(join(REPO, ".git"))) return;
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(join(REPO, "test"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "stage-demo", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(REPO, "src/calc.mjs"), ["export function add(a, b) {", "  return a + b;", "}", ""].join("\n"));
  writeFileSync(join(REPO, "test/calc.test.mjs"), [
    'import { test } from "node:test";',
    'import assert from "node:assert";',
    'import { add } from "../src/calc.mjs";',
    "",
    'test("加法", () => {',
    "  assert.equal(add(2, 3), 5);",
    "});",
    "",
  ].join("\n"));
  git(["-C", REPO, "init", "-q", "-b", "main"]);
  git(["-C", REPO, "add", "-A"]);
  git(["-C", REPO, "-c", "user.email=demo@wb", "-c", "user.name=demo", "commit", "-qm", "seed"]);
}

// 假 agent 抽到 src/runner/providers/stage.mjs：演示脚本和截图脚本共用同一份，
// 也顺便让它成为一个真注册引擎（WB_ENGINE=stage），能被 `node src/cli.mjs run` 直接驱动。
// 它只写自己阶段边界内的文件，所以阶段闸门是真放行而不是绕过的。

/** 跑到暂停点：没有进展就停，避免死循环。 */
async function drive(db, provider, ids) {
  for (let i = 0; i < 60; i++) {
    const before = ids.map((id) => getTask(db, id).state).join(",");
    await pump(db, { workerId: "demo-worker", provider, once: true, heartbeat: false });
    const after = ids.map((id) => getTask(db, id).state).join(",");
    if (before === after) return;
  }
}

/** 人做的事：初筛通过 + 终审批准（两段都留事件，账本可审计）。 */
function approve(db, id, { reviewer = "bob", lead = "lead0" } = {}) {
  const t = getTask(db, id);
  if (t.reviewer !== reviewer) {
    record(db, { taskId: id, type: "review.claimed", actor: reviewer, payload: { by: reviewer, expires_at: Date.now() + 30 * 60000 } });
  }
  const cur = getTask(db, id);
  if (cur.state === "awaiting_review") {
    record(db, { taskId: id, type: "review.passed", actor: reviewer, payload: { by: reviewer } });
    transition(db, id, "awaiting_approval", { actor: reviewer, reason: "初筛通过" });
  }
  const t2 = getTask(db, id);
  if (t2.state === "awaiting_approval") {
    record(db, { taskId: id, type: "human.decision", actor: lead, payload: { decision: "approved", by: lead, note: "批" } });
    transition(db, id, "merging", { actor: lead, reason: "终审批准，合并" });
  }
}

/** 人的动作：把所有发散项分流掉（签字的前提）。 */
function triageAll(db, projectId, by = "lead0") {
  const open = st.backlogOf(db, projectId).filter((b) => b.status === "open");
  for (const b of open) st.decideBacklog(db, projectId, b.id, { status: "next", by, note: "下一阶段一起做" });
  return open.length;
}

async function runStage(db, provider, projectId, ref) {
  const out = st.startStage(db, projectId, ref, { by: "alice" });
  const id = out.task.id;
  await drive(db, provider, [id]);
  if (getTask(db, id).state === "awaiting_review") {
    approve(db, id);
    await drive(db, provider, [id]);
  }
  return { task: getTask(db, id), id };
}

const t0 = Date.now();
seedRepo();
const db = openDb(process.env.WB_DB);

console.log("\n[1] 建项目 + 机器开预备会（异步，人之后来看）");
const p1 = st.createProject(db, { title: "给 calc 加乘法与除法", repo: "repo", lane: "feature", owner: "alice" });
const met = await st.meetProject(db, p1.id, {});
check("预备会拆出 4 个阶段", met.stages.length === 4, met.stages.map((s) => s.name).join("/"));
check("签字只需要 2 次（A=设计+契约，B=实现+合并）", new Set(met.stages.map((s) => s.signature_group)).size === 2);
check("预备会产出了要人拍板的发散项", met.backlog.length >= 1, (met.backlog[0] && met.backlog[0].text) || "");
check("人不需要坐在会里（估算分钟数 <= 10）", met.human_minutes <= 10, String(met.human_minutes));

console.log("\n[2] 闸门 1：没签字不许开工，没交付不许跳关卡");
let threw = null;
try { st.signStages(db, p1.id, { group: "B", by: "lead0" }); } catch (e) { threw = String(e.message); }
check("B 组在前序阶段没交付时签不了", !!threw && /前序|交付/.test(threw), threw || "");
threw = null;
try { st.startStage(db, p1.id, "设计", { by: "alice" }); } catch (e) { threw = String(e.message); }
check("没签字的阶段开不了工", !!threw, threw || "");

console.log("\n[3] 人签第一次字（设计 + 契约）：签字同时必须把发散项分流掉");
const openB = st.backlogOf(db, p1.id).filter((b) => b.status === "open");
let signBlocked = null;
try { st.signStages(db, p1.id, { group: "A", by: "lead0" }); } catch (e) { signBlocked = String(e.message); }
check("还有发散项没分流时签不了字", !!signBlocked && /分流/.test(signBlocked), (signBlocked || "").slice(0, 60));
st.decideBacklog(db, p1.id, openB[0].id, { status: "next", by: "lead0", note: "契约阶段一起写验收标准" });
check("分流后没有遗留发散项", st.backlogOf(db, p1.id).every((b) => b.status !== "open"), String(openB.length));

const signedA = st.signStages(db, p1.id, { group: "A", by: "lead0", note: "目标与边界可以" });
check("A 组签完，设计/契约变 approved", signedA.stages.filter((s) => s.state === "approved").length === 2);
check("项目进入 running", signedA.state === "running");
threw = null;
try { await st.meetProject(db, p1.id, {}); } catch (e) { threw = String(e.message); }
check("签完不许重开预备会改目标（要改走复议会）", !!threw && /复议|阶段|开工/.test(threw), threw || "");

console.log("\n[4] 跑设计阶段（agent 只许碰 docs/**）");
const good = await createStage({ db, behave: "good" });
const s1 = await runStage(db, good, p1.id, "设计");
check("设计阶段任务跑到 done", s1.task.state === "done", s1.task.state);
const g1 = (s1.task.evidence && s1.task.evidence.verify && s1.task.evidence.verify.guards) || [];
check("阶段闸门在护栏里生效（stage_scope 通过）", g1.some((c) => c.id === "stage_scope" && c.ok));
check("产出物检查也在护栏里（stage_artifacts 通过）", g1.some((c) => c.id === "stage_artifacts" && c.ok));
check("设计稿真的落进了主干", existsSync(join(REPO, "docs/design.md")) && existsSync(join(REPO, "docs/design.svg")));
check("阶段完成后状态为 done", s1.task.stage_id && st.getStage(db, s1.task.stage_id).state === "done", s1.task.stage_id ? st.getStage(db, s1.task.stage_id).state : "no stage");

console.log("\n[5] 跑契约阶段");
const s2 = await runStage(db, good, p1.id, "契约");
check("契约阶段 done", s2.task.state === "done", s2.task.state);
check("契约文档落盘", existsSync(join(REPO, "docs/contract.md")));

console.log("\n[6] 人签第二次字（实现 + 合并）");
const signedB = st.signStages(db, p1.id, { group: "B", by: "lead0", note: "契约没问题" });
check("B 组签完，实现/合并变 approved", signedB.stages.filter((s) => s.state === "approved").length === 2);
check("整个功能只签了 2 次字", signedB.signatures.length === 2, String(signedB.signatures.length));

console.log("\n[7] 跑实现阶段（只许碰 src/test）");
const s3 = await runStage(db, good, p1.id, "实现");
check("实现阶段 done", s3.task.state === "done", s3.task.state);
const g3 = (s3.task.evidence && s3.task.evidence.verify && s3.task.evidence.verify.guards) || [];
check("实现阶段护栏全绿（含阶段闸门）", g3.length > 0 && g3.every((c) => c.ok), g3.filter((c) => !c.ok).map((c) => c.id).join(","));
check("乘法除法真的进了主干", /mul/.test(readFileSync(join(REPO, "src/calc.mjs"), "utf8")));

console.log("\n[8] 跑合并阶段 -> 项目自动收尾");
const s4 = await runStage(db, good, p1.id, "合并");
check("合并阶段 done", s4.task.state === "done", s4.task.state);
const finalP = st.getProject(db, p1.id);
check("项目自动推进到 done（不需要人再点完成）", finalP.state === "done", finalP.state);

console.log("\n[9] 反例：agent 在「设计」阶段顺手改实现，闸门必须打回");
const p2 = st.createProject(db, { title: "顺手改实现的坏例子", repo: "repo", lane: "feature", owner: "alice" });
await st.meetProject(db, p2.id, {});
triageAll(db, p2.id);
st.signStages(db, p2.id, { group: "A", by: "lead0" });
const sloppy = await createStage({ db, behave: "sloppy" });
const bad = await runStage(db, sloppy, p2.id, "设计");
const badGuards = (bad.task.evidence && bad.task.evidence.verify && bad.task.evidence.verify.guards) || [];
const scope = badGuards.find((c) => c.id === "stage_scope");
check("越界改动被 stage_scope 抓住", scope && !scope.ok, ((scope && scope.detail) || "").slice(0, 90));
check("任务没有直接合进主干", bad.task.state !== "done", bad.task.state);
const bl = st.backlogOf(db, p2.id).filter((b) => b.source === "guard");
check("越界的想法落进 backlog，等人分流", bl.length >= 1, ((bl[0] && bl[0].text) || "").slice(0, 80));

console.log("\n[10] 杂活 lane：不开会，一个阶段，签一次");
const p3 = st.createProject(db, { title: "升级依赖小版本", repo: "repo", lane: "chore", owner: "alice" });
const met3 = await st.meetProject(db, p3.id, {});
check("杂活只有 1 个阶段", met3.stages.length === 1, met3.stages.map((s) => s.name).join("/"));
const signed3 = (triageAll(db, p3.id, "lead0"), st.signStages(db, p3.id, { group: "A", by: "lead0" }));
check("杂活签 1 次就能开工", signed3.stages[0].state === "approved");
check("杂活估算人只需要 1 分钟", met3.human_minutes <= 2, String(met3.human_minutes));

const secs = Math.round((Date.now() - t0) / 1000);
const report = { at: new Date().toISOString(), workspace: WS, seconds: secs, checks: rows, failed: fails };
mkdirSync(join(ROOT, "docs"), { recursive: true });
const outFile = join(ROOT, "docs", "stage-demo-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");

console.log("\n" + (fails.length ? "FAIL " + fails.length + " 项" : "全部通过") + " · " + rows.length + " 项检查 · " + secs + " 秒");
console.log("报告: " + outFile);
if (fails.length) { for (const f of fails) console.log("  - " + f); process.exit(2); }
