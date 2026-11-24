import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { forceTransition, getTask } from "../src/core/ledger.mjs";
import {
  createProject, getProject, meetProject, signStages, startStage, backlogOf, decideBacklog, getStage,
} from "../src/core/stages.mjs";
import { openDecision, decisionsOf, resolveDecision, getDecision, TRIGGERS } from "../src/core/meetings.mjs";
import { memoryOf } from "../src/core/memory.mjs";
import { can } from "../src/core/permissions.mjs";

const freshDb = () => openDb(resolve(mkdtempSync(join(tmpdir(), "wb-meet-")), "t.db"));

async function runningStage(db, title = "给 calc 加乘法") {
  const p = createProject(db, { title, repo: "repo", lane: "chore", owner: "alice" });
  await meetProject(db, p.id, {});
  for (const b of backlogOf(db, p.id).filter((x) => x.status === "open")) {
    decideBacklog(db, p.id, b.id, { status: "next", by: "lead0" });
  }
  signStages(db, p.id, { group: "A", by: "lead0" });
  const out = startStage(db, p.id, 1, { by: "alice" });
  return { id: p.id, taskId: out.task.id, stageId: getProject(db, p.id).stages[0].stage_id };
}

test("复议会：同一个阶段同一个触发点只开一次（worker 重试不会刷屏）", async () => {
  const db = freshDb();
  const { id, stageId } = await runningStage(db);
  const a = openDecision(db, id, { trigger: "scope", stageId, evidence: ["越界文件：src/calc.mjs"], by: "worker" });
  const b = openDecision(db, id, { trigger: "scope", stageId, evidence: ["越界文件：src/other.mjs"], by: "worker" });
  assert.equal(a.decision_id, b.decision_id);
  assert.equal(decisionsOf(db, id).length, 1);
  assert.equal(openDecision(db, id, { trigger: "budget", stageId, evidence: ["x"], by: "worker" }).decision_id !== a.decision_id, true);
});

test("复议会：提案是确定性生成的（现状 + 可选路线 + 机器建议），不花 token 编", async () => {
  const db = freshDb();
  const { id, stageId } = await runningStage(db);
  const d = openDecision(db, id, { trigger: "scope", stageId, evidence: ["越界文件：src/calc.mjs", "阶段边界：docs/**"], by: "worker" });
  assert.match(d.proposal, /越界文件：src\/calc\.mjs/);
  assert.match(d.proposal, /扩边界/);
  assert.deepEqual(d.options.map((o) => o.id), TRIGGERS.scope.options.map((o) => o.id));
  assert.equal(d.status, "open");
});

test("复议会：非法选项报错且不落账；拍板后写决议 + 记忆 + 任务回队列", async () => {
  const db = freshDb();
  const { id, taskId, stageId } = await runningStage(db);
  forceTransition(db, taskId, "blocked", { actor: "worker", reason: "越界" });
  const d = openDecision(db, id, { trigger: "scope", stageId, evidence: ["越界文件：src/calc.mjs"], by: "worker" });
  assert.throws(() => resolveDecision(db, id, d.decision_id, { choice: "yolo", by: "lead0" }), /choice 只能是/);
  assert.equal(getDecision(db, d.decision_id).status, "open");

  const out = resolveDecision(db, id, d.decision_id, { choice: "extend_scope", by: "lead0", note: "这一关确实要动实现" });
  const stage = out.project.stages.find((s) => s.stage_id === stageId);
  assert.ok(stage.allowedGlobs.includes("src/**"), stage.allowedGlobs.join(","));
  assert.equal(getTask(db, taskId).state, "queued");
  assert.equal(getDecision(db, d.decision_id).status, "resolved");
  assert.equal(getDecision(db, d.decision_id).choice, "extend_scope");
  assert.ok(memoryOf(db, id).some((m) => m.kind === "decision" && /扩边界/.test(m.text)));
  assert.throws(() => resolveDecision(db, id, d.decision_id, { choice: "extend_scope", by: "lead0" }), /已经拍过板/);
});

test("复议会：abort = 人工接手，阶段标 blocked 且任务不自动回队列", async () => {
  const db = freshDb();
  const { id, taskId, stageId } = await runningStage(db);
  forceTransition(db, taskId, "blocked", { actor: "worker", reason: "越界" });
  const d = openDecision(db, id, { trigger: "scope", stageId, evidence: ["越界文件：src/calc.mjs"], by: "worker" });
  const out = resolveDecision(db, id, d.decision_id, { choice: "abort", by: "lead0", note: "先人工改" });
  assert.equal(out.project.stages.find((s) => s.stage_id === stageId).state, "blocked");
  assert.equal(getTask(db, taskId).state, "blocked");
});

test("复议会：预算超支拍板加预算，项目与当前任务一起 ×1.5", async () => {
  const db = freshDb();
  const { id, taskId, stageId } = await runningStage(db);
  const d = openDecision(db, id, { trigger: "budget", stageId, evidence: ["已花 800 / 1000（80%）"], by: "worker" });
  const before = getTask(db, taskId).budget_tokens;
  const out = resolveDecision(db, id, d.decision_id, { choice: "raise_budget", by: "lead0" });
  assert.equal(out.project.budget_tokens, 1500000);
  assert.equal(getTask(db, taskId).budget_tokens, Math.round(before * 1.5));
});

test("权限：只有 lead 能拍板与签收资产；阶段负责人 lead 或项目发起人可以改", async () => {
  const p = { owner: "alice" };
  assert.equal(can({ name: "bob", role: "member" }, "resolve_decision").ok, false);
  assert.equal(can({ name: "lead0", role: "lead" }, "resolve_decision").ok, true);
  assert.equal(can({ name: "bob", role: "member" }, "settle_assets").ok, false);
  assert.equal(can({ name: "lead0", role: "lead" }, "settle_assets").ok, true);
  assert.equal(can({ name: "bob", role: "member" }, "assign_stage_owner", null, p).ok, false);
  assert.equal(can({ name: "alice", role: "member" }, "assign_stage_owner", null, p).ok, true);
  assert.equal(can({ name: "lead0", role: "lead" }, "assign_stage_owner", null, p).ok, true);
  assert.equal(can({ name: "eve", role: "viewer" }, "add_memory").ok, false);
  assert.equal(can({ name: "bob", role: "member" }, "add_memory").ok, true);
});
