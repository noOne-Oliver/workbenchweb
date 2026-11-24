import { append, readAll } from "./events.mjs";
import { newId } from "./ids.mjs";

/**
 * 状态机。所有迁移必须在这里声明，未声明的迁移一律拒绝——这是"账本先于执行器"的落点。
 */
export const STATES = [
  "queued", "planning", "implementing", "verifying", "reviewing",
  "awaiting_review",    // 成员初筛（做的是不是这件事）
  "awaiting_approval",  // lead 终审（要不要合）
  "awaiting_human",     // 旧账本兼容：两段评审之前的单段状态
  "merging", "done", "failed", "blocked",
];

/** 两段评审：机器 review 之后进初筛，初筛通过进终审，任一段都能打回 queued。 */
export const TRANSITIONS = {
  queued:            ["planning", "blocked", "failed"],
  planning:          ["implementing", "queued", "blocked", "failed"],
  implementing:      ["verifying", "queued", "blocked", "failed"],
  // queued = 快路径没过、需要先补方案（见 worker.doVerify）
  verifying:         ["reviewing", "implementing", "queued", "blocked", "failed"],
  reviewing:         ["awaiting_review", "implementing", "blocked", "failed"],
  awaiting_review:   ["awaiting_approval", "queued", "blocked", "failed"],
  awaiting_approval: ["merging", "queued", "failed"],
  awaiting_human:    ["awaiting_approval", "merging", "queued", "failed"],
  // blocked：主仓库有未提交改动，合并会失败——等人清理，不是让 worker 空转
  merging:           ["done", "awaiting_approval", "blocked", "failed"],
  done:              [],
  failed:            ["queued"],
  blocked:           ["queued"],
};

/** 老账本迁移：单段 awaiting_human 视作「已初筛、等 lead 终审」。幂等。 */
export function migrateReviewStates(db) {
  const rows = db.prepare("SELECT id, owner FROM tasks WHERE state = 'awaiting_human'").all();
  for (const r of rows) {
    transition(db, r.id, "awaiting_approval", { actor: "migration", reason: "两段评审：单段待裁决迁到待批准" });
  }
  return rows.length;
}

const TERMINAL = new Set(["done"]);

/** 写一条事件并同步应用到投影。apply=false 用于调用方已用 CAS 改过行的场景。 */
export function record(db, { taskId = null, type, actor = "system", payload = {} }, apply = true) {
  const ev = append(db, { taskId, type, actor, payload });
  // append() 返回驼峰字段，投影层统一用 snake_case（与 events 表列名一致）
  if (apply) applyEvent(db, { ...ev, task_id: taskId, payload: JSON.stringify(payload) });
  return ev;
}

export function createTask(db, { title, repo, owner = "unknown", budgetTokens = 1_000_000, baseSha = null, branch = null }) {
  if (!title || !repo) throw new Error("title 与 repo 必填");
  const id = newId();
  record(db, {
    taskId: id,
    type: "task.created",
    actor: owner,
    payload: { title, repo, owner, budget_tokens: budgetTokens, base_sha: baseSha, branch },
  });
  return getTask(db, id);
}

export function getTask(db, id) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? hydrate(row) : null;
}

export function listTasks(db, { state = null, owner = null, limit = 200 } = {}) {
  let sql = "SELECT * FROM tasks";
  const where = [], args = [];
  if (state) { where.push("state = ?"); args.push(state); }
  if (owner) { where.push("owner = ?"); args.push(owner); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT ?";
  args.push(limit);
  return db.prepare(sql).all(...args).map(hydrate);
}

/** 严格迁移：同态直接返回（幂等），非法迁移抛错。 */
export function transition(db, id, to, { actor = "system", reason = null } = {}) {
  const t = getTask(db, id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.state === to) return t;
  const allowed = TRANSITIONS[t.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`非法迁移 ${t.state} -> ${to} (任务 ${id})`);
  }
  record(db, {
    taskId: id,
    type: "task.transition",
    actor,
    payload: { from: t.state, to, reason },
  });
  return getTask(db, id);
}

/**
 * 逃生门：只有"状态机里没有的路"才用它 —— 例如老进程遇到新状态。
 * 严格版 transition() 会直接抛错，抛错就意味着这个任务永远卡在那里、被反复认领。
 * 卡住不算最坏，反复认领的无限循环才会把磁盘写满（真实事故：2 小时写了 17GB、8600 万条事件）。
 */
export function forceTransition(db, id, to, { actor = "system", reason = null } = {}) {
  const t = getTask(db, id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.state === to) return t;
  record(db, {
    taskId: id,
    type: "task.transition",
    actor,
    payload: { from: t.state, to, reason, forced: true },
  });
  return getTask(db, id);
}

export function isTerminal(state) {
  return TERMINAL.has(state);
}

export function addEvidence(db, id, patch, type = "evidence.patch", actor = "system") {
  const t = getTask(db, id);
  const merged = { ...(t?.evidence ?? {}), ...patch };
  record(db, { taskId: id, type: "evidence.patch", actor, payload: merged });
  return merged;
}

export function spendBudget(db, id, tokens, detail = null) {
  if (!tokens || tokens <= 0) return getTask(db, id);
  record(db, { taskId: id, type: "budget.spent", payload: { tokens, detail } });
  return getTask(db, id);
}

export function overBudget(t) {
  return t.spent_tokens >= t.budget_tokens;
}

/** 从事件流全量重建投影——kill -9 之后的自愈入口。 */
export function rebuild(db) {
  db.exec("DELETE FROM tasks;");
  // 阶段链的投影也要清掉，否则重放会留下孤儿项目/阶段。
  db.exec("DELETE FROM projects; DELETE FROM stages; DELETE FROM backlog; DELETE FROM signatures;");
  for (const row of readAll(db)) applyEvent(db, row);
  return db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
}

const nowIso = () => new Date().toISOString();

/** 事件 -> 投影。唯一允许改 tasks 表的地方。 */
export function applyEvent(db, ev) {
  const p = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
  switch (ev.type) {
    case "task.created": {
      db.prepare(`INSERT OR REPLACE INTO tasks
        (id,title,repo,branch,base_sha,owner,state,budget_tokens,spent_tokens,attempts,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`)
        .run(ev.task_id, p.title, p.repo, p.branch ?? null, p.base_sha ?? null,
             p.owner, "queued", p.budget_tokens ?? 200000, ev.ts, ev.ts);
      break;
    }
    case "task.transition": {
      const t = db.prepare("SELECT state, review_started_at, approval_started_at FROM tasks WHERE id = ?").get(ev.task_id);
      if (!t) break;
      const nowMs = Date.parse(ev.ts);
      let reviewStarted = t.review_started_at ?? null;
      let reviewSeconds = null;
      let approvalStarted = t.approval_started_at ?? null;
      let approvalSeconds = null;

      // 初筛一段：进 awaiting_review 开始计时，离开时结算。旧单段状态同样计时，历史数据才有意义。
      if (p.to === "awaiting_review" || p.to === "awaiting_human") reviewStarted = nowMs;
      if ((t.state === "awaiting_review" || t.state === "awaiting_human") &&
          p.to !== "awaiting_review" && p.to !== "awaiting_human" && reviewStarted) {
        reviewSeconds = Math.max(0, Math.round((nowMs - reviewStarted) / 1000));
        reviewStarted = null;
      }
      // 终审一段
      if (p.to === "awaiting_approval") approvalStarted = nowMs;
      if (t.state === "awaiting_approval" && p.to !== "awaiting_approval" && approvalStarted) {
        approvalSeconds = Math.max(0, Math.round((nowMs - approvalStarted) / 1000));
        approvalStarted = null;
      }

      db.prepare(`UPDATE tasks SET state=?, updated_at=?,
        review_started_at = COALESCE(?, review_started_at),
        review_seconds = COALESCE(?, review_seconds),
        approval_started_at = COALESCE(?, approval_started_at),
        approval_seconds = COALESCE(?, approval_seconds) WHERE id=?`)
        .run(p.to, ev.ts, reviewStarted, reviewSeconds, approvalStarted, approvalSeconds, ev.task_id);
      break;
    }
    // 初筛领取：锁定 30 分钟，超时自动可被别人领（不需要定时任务，读的时候按时间判）。
    case "review.claimed":
      db.prepare("UPDATE tasks SET reviewer=?, review_lease_expires_at=?, updated_at=? WHERE id=?")
        .run(p.by, p.expires_at, ev.ts, ev.task_id);
      break;
    case "review.released":
      db.prepare("UPDATE tasks SET reviewer=NULL, review_lease_expires_at=NULL, updated_at=? WHERE id=?")
        .run(ev.ts, ev.task_id);
      break;
    case "review.passed":
      db.prepare(`UPDATE tasks SET reviewer=NULL, review_lease_expires_at=NULL,
        first_reviewed_by=?, first_reviewed_at=?, updated_at=? WHERE id=?`)
        .run(p.by, ev.ts, ev.ts, ev.task_id);
      break;
    case "review.changes_requested":
      db.prepare("UPDATE tasks SET reviewer=NULL, review_lease_expires_at=NULL, decision='rejected', decision_note=?, updated_at=? WHERE id=?")
        .run(p.note ?? null, ev.ts, ev.task_id);
      break;
    case "lease.acquired":
      db.prepare("UPDATE tasks SET lease_owner=?, lease_expires_at=?, updated_at=? WHERE id=?")
        .run(p.owner, p.expires_at, ev.ts, ev.task_id);
      break;
    case "lease.renewed":
      db.prepare("UPDATE tasks SET lease_expires_at=?, updated_at=? WHERE id=?")
        .run(p.expires_at, ev.ts, ev.task_id);
      break;
    case "lease.released":
      db.prepare("UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
        .run(ev.ts, ev.task_id);
      break;
    case "plan.produced":
      db.prepare("UPDATE tasks SET plan_md=?, updated_at=? WHERE id=?").run(p.plan_md, ev.ts, ev.task_id);
      break;
    case "impl.produced":
      db.prepare("UPDATE tasks SET diff_stat=?, branch=?, base_sha=COALESCE(?, base_sha), updated_at=? WHERE id=?")
        .run(p.diff_stat ?? null, p.branch ?? null, p.base_sha ?? null, ev.ts, ev.task_id);
      break;
    case "verify.result":
    case "evidence.patch":
      db.prepare("UPDATE tasks SET evidence=?, updated_at=? WHERE id=?").run(JSON.stringify(p), ev.ts, ev.task_id);
      break;
    case "budget.spent":
      db.prepare("UPDATE tasks SET spent_tokens = spent_tokens + ?, updated_at=? WHERE id=?")
        .run(p.tokens, ev.ts, ev.task_id);
      break;
    case "attempt.started":
      db.prepare("UPDATE tasks SET attempts = attempts + 1, updated_at=? WHERE id=?").run(ev.ts, ev.task_id);
      break;
    // 人打回是"重新开局"，不该吃掉机器人的重试额度。
    // 不重置的话，人 reject 两次就能把 attempts 顶到 MAX_ATTEMPTS，机器直接 blocked —— 人明明刚让它重做。
    case "attempt.reset":
      db.prepare("UPDATE tasks SET attempts = 0, updated_at=? WHERE id=?").run(ev.ts, ev.task_id);
      break;
    // ---- 阶段链：项目 / 阶段 / 发散项。改投影只能走这里，和任务一样。 ----
    case "project.created":
      db.prepare("INSERT OR REPLACE INTO projects (id,title,repo,lane,workflow,owner,state,budget_tokens,meeting_budget,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(p.project_id, p.title, p.repo, p.lane ?? "feature", p.workflow ?? p.lane ?? "feature", p.owner,
             "drafting", p.budget_tokens ?? 1000000, p.meeting_budget ?? 0, ev.ts, ev.ts);
      break;
    case "project.meeting": {
      db.prepare("UPDATE projects SET summary=?, human_minutes=?, state=?, updated_at=? WHERE id=?")
        .run(p.summary ?? null, p.human_minutes ?? null, p.to ?? "proposed", ev.ts, p.project_id);
      const insStage = db.prepare("INSERT OR REPLACE INTO stages (stage_id,project_id,seq,name,goal,role,skill,artifacts,allowed_globs,non_goals,state,signature_group,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const st of p.stages || []) {
        insStage.run(st.stage_id, p.project_id, st.seq, st.name, st.goal, st.role, st.skill ?? null,
          JSON.stringify(st.artifacts || []), JSON.stringify(st.allowed_globs || []),
          JSON.stringify(st.non_goals || []), st.state || "proposed", st.signature_group || "A", ev.ts, ev.ts);
      }
      const insBacklog = db.prepare("INSERT OR REPLACE INTO backlog (id,project_id,stage_id,text,source,status,created_at) VALUES (?,?,?,?,?,?,?)");
      for (const b of p.backlog || []) {
        insBacklog.run(b.id, p.project_id, b.stage_id ?? null, b.text, b.source ?? "meeting", b.status ?? "open", ev.ts);
      }
      break;
    }
    case "project.transition":
      db.prepare("UPDATE projects SET state=?, updated_at=? WHERE id=?").run(p.to, ev.ts, p.project_id);
      break;
    case "stage.transition":
      db.prepare("UPDATE stages SET state=?, updated_at=?, started_at=COALESCE(?, started_at), ended_at=COALESCE(?, ended_at) WHERE stage_id=?")
        .run(p.to, ev.ts, p.to === "running" ? ev.ts : null, p.to === "done" ? ev.ts : null, p.stage_id);
      break;
    case "stage.assigned":
      db.prepare("UPDATE stages SET task_id=?, updated_at=? WHERE stage_id=?").run(p.task_id, ev.ts, p.stage_id);
      break;
    // 签字就是解锁：这一组里的阶段一起进入 approved，之后才允许开工。
    case "stage.signed": {
      db.prepare("INSERT INTO signatures (project_id,group_name,covers,by,note,created_at) VALUES (?,?,?,?,?,?)")
        .run(p.project_id, p.group, JSON.stringify(p.covers || []), p.by ?? null, p.note ?? null, ev.ts);
      const upd = db.prepare("UPDATE stages SET state=?, updated_at=? WHERE project_id=? AND name=?");
      for (const name of p.covers || []) upd.run("approved", ev.ts, p.project_id, name);
      break;
    }
    case "backlog.added":
      db.prepare("INSERT OR REPLACE INTO backlog (id,project_id,stage_id,text,source,status,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(p.id, p.project_id, p.stage_id ?? null, p.text, p.source ?? "agent", "open", ev.ts);
      break;
    case "backlog.decided":
      db.prepare("UPDATE backlog SET status=?, decided_by=?, decided_at=? WHERE id=?")
        .run(p.status, p.by ?? null, ev.ts, p.id);
      break;
    // 任务挂到阶段上。执行器据此拿边界去判护栏，不用在任务里冗余存阶段定义。
    case "task.scoped":
      db.prepare("UPDATE tasks SET project_id=?, stage_id=?, updated_at=? WHERE id=?")
        .run(p.project_id ?? null, p.stage_id ?? null, ev.ts, ev.task_id);
      break;
    case "human.decision":
      db.prepare(`UPDATE tasks SET decision=?, decision_note=?,
        approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
        approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
        self_approved = CASE WHEN ? = 1 THEN 1 ELSE self_approved END,
        updated_at=? WHERE id=?`)
        .run(p.decision, p.note ?? null,
             p.decision, p.by ?? null,
             p.decision, ev.ts,
             p.self_approved ? 1 : 0,
             ev.ts, ev.task_id);
      break;
    default:
      break;
  }
}

function hydrate(row) {
  let evidence = null;
  if (row.evidence) { try { evidence = JSON.parse(row.evidence); } catch { evidence = { raw: row.evidence }; } }
  return { ...row, evidence };
}
