import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { createTask, getTask, migrateReviewStates, record, transition } from "../src/core/ledger.mjs";
import { can } from "../src/core/permissions.mjs";
import { createUser } from "../src/core/users.mjs";
import { retryFeedback } from "../src/runner/worker.mjs";

const freshDb = () => openDb(resolve(mkdtempSync(join(tmpdir(), "wb-flow-")), "t.db"));
const as = (name, role) => ({ name, role });

/** 把任务推到「待初筛」——两段评审的入口。 */
function toReview(db, owner = "alice") {
  const t = createTask(db, { title: "加法", repo: "/tmp/r", owner });
  transition(db, t.id, "planning", { actor: "w" });
  transition(db, t.id, "implementing", { actor: "w" });
  transition(db, t.id, "verifying", { actor: "w" });
  transition(db, t.id, "reviewing", { actor: "w" });
  transition(db, t.id, "awaiting_review", { actor: "w" });
  return getTask(db, t.id);
}

test("权限矩阵：viewer 只读，member 到初筛为止，lead 才能批准合并", () => {
  const db = freshDb();
  const t = toReview(db);
  const viewer = as("v", "viewer");
  const member = as("m", "member");
  const lead = as("l", "lead");

  assert.equal(can(viewer, "view").ok, true);
  assert.equal(can(viewer, "claim_review", t).ok, false);
  assert.equal(can(viewer, "create_task").ok, false);

  assert.equal(can(member, "claim_review", t).ok, true);
  assert.equal(can(member, "create_task").ok, true);
  assert.equal(can(member, "approve", t).ok, false, "member 不能批准合并");

  const approved = { ...t, state: "awaiting_approval" };
  assert.equal(can(member, "approve", approved).ok, false);
  assert.equal(can(lead, "approve", approved).ok, true);
  assert.equal(can(lead, "manage_users").ok, true);
});

test("领取锁定 30 分钟：别人领不走，超时后可接手", () => {
  const db = freshDb();
  let t = toReview(db);
  record(db, { taskId: t.id, type: "review.claimed", actor: "bob", payload: { by: "bob", expires_at: Date.now() + 30 * 60 * 1000 } });
  t = getTask(db, t.id);
  assert.equal(t.reviewer, "bob");
  assert.equal(can(as("carol", "member"), "claim_review", t).ok, false, "被别人领走时不能抢");
  assert.equal(can(as("bob", "member"), "claim_review", t).ok, true, "同一个人可以续领");

  // 把锁改成已过期：读的时候按时间判，不需要定时任务
  db.prepare("UPDATE tasks SET review_lease_expires_at = ? WHERE id = ?").run(Date.now() - 1000, t.id);
  t = getTask(db, t.id);
  assert.equal(can(as("carol", "member"), "claim_review", t).ok, true, "超时后任何人都能接手");
});

test("两段评审：初筛通过 → 待批准 → 批准 → 合并，两段耗时都记账", () => {
  const db = freshDb();
  let t = toReview(db);

  record(db, { taskId: t.id, type: "review.claimed", actor: "bob", payload: { by: "bob", expires_at: Date.now() + 1e6 } });
  t = getTask(db, t.id);
  assert.equal(can(as("bob", "member"), "pass_review", t).ok, true);
  record(db, { taskId: t.id, type: "review.passed", actor: "bob", payload: { by: "bob", note: "范围没问题" } });
  t = transition(db, t.id, "awaiting_approval", { actor: "bob" });

  assert.equal(t.state, "awaiting_approval");
  assert.equal(t.reviewer, null, "初筛通过后释放领取锁");
  assert.equal(t.first_reviewed_by, "bob");
  assert.ok(t.review_seconds !== null && t.review_seconds >= 0, "初筛耗时要有值");

  assert.equal(can(as("bob", "member"), "approve", t).ok, false);
  assert.equal(can(as("lead1", "lead"), "approve", t).ok, true);
  record(db, { taskId: t.id, type: "human.decision", actor: "lead1", payload: { decision: "approved", by: "lead1", role: "lead" } });
  t = transition(db, t.id, "merging", { actor: "lead1" });
  assert.equal(t.approved_by, "lead1");
  assert.ok(t.approval_seconds !== null && t.approval_seconds >= 0, "终审耗时要有值");
});

test("lead 自己提交自己批：允许但必须写理由，账本标 self_approved", () => {
  const db = freshDb();
  const t = { ...toReview(db, "boss"), state: "awaiting_approval" };
  assert.equal(can(as("boss", "lead"), "approve", t).self_approved, true, "自己提交的要标出来");
  assert.equal(can(as("other", "lead"), "approve", t).self_approved, undefined);

  record(db, { taskId: t.id, type: "human.decision", actor: "boss", payload: { decision: "approved", by: "boss", self_approved: true, note: "急，自己批" } });
  assert.equal(getTask(db, t.id).self_approved, 1);
});

test("打回：初筛和终审都能独立打回，任务回队列并记下人的原话", () => {
  const db = freshDb();
  const t = toReview(db);
  record(db, { taskId: t.id, type: "review.changes_requested", actor: "bob", payload: { by: "bob", role: "member", note: "这不是我要的除法", stage: "awaiting_review" } });
  const after = transition(db, t.id, "queued", { actor: "bob" });
  assert.equal(after.state, "queued");
  assert.equal(after.decision, "rejected");

  const fb = retryFeedback(getTask(db, t.id), db);
  assert.match(fb, /人是打回了|把上一版打回了/);
  assert.match(fb, /这不是我要的除法/, "人的原话必须进下一轮 prompt");
  assert.match(fb, /初筛/);
});

test("老账本：单段 awaiting_human 迁到待批准，且幂等", () => {
  const db = freshDb();
  const t = createTask(db, { title: "旧任务", repo: "/tmp/r", owner: "alice" });
  transition(db, t.id, "planning", { actor: "w" });
  transition(db, t.id, "implementing", { actor: "w" });
  transition(db, t.id, "verifying", { actor: "w" });
  transition(db, t.id, "reviewing", { actor: "w" });
  // 模拟老账本：直接落到单段状态（新账本已经不允许 reviewing -> awaiting_human）
  db.prepare("UPDATE tasks SET state = 'awaiting_human' WHERE id = ?").run(t.id);
  assert.equal(migrateReviewStates(db), 1);
  assert.equal(getTask(db, t.id).state, "awaiting_approval");
  assert.equal(migrateReviewStates(db), 0, "幂等");
});

test("创建者身份来自会话：createUser 后任务 owner 用它，不是请求体", () => {
  const db = freshDb();
  createUser(db, { name: "alice", role: "member", password: "secret1" });
  const t = createTask(db, { title: "x", repo: "/tmp/r", owner: "alice" });
  assert.equal(getTask(db, t.id).owner, "alice");
});

test("reviewing 阶段调用失败能回队列，不会把任务卡死", () => {
  // 真实事故：builtin 引擎在 doReview 里超时，catch 想回 queued，但状态机不允许 reviewing→queued，
  // 结果 worker 自己抛「非法迁移」退出，任务永远停在 reviewing 且没人再捡。
  const db = freshDb();
  const t = createTask(db, { title: "除法", repo: "/tmp/r", owner: "alice" });
  transition(db, t.id, "planning", { actor: "w" });
  transition(db, t.id, "implementing", { actor: "w" });
  transition(db, t.id, "verifying", { actor: "w" });
  transition(db, t.id, "reviewing", { actor: "w" });
  assert.doesNotThrow(() => transition(db, t.id, "queued", { actor: "w", reason: "reviewer timeout" }));
  assert.equal(getTask(db, t.id).state, "queued");
});
