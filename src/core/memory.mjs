import { newId } from "./ids.mjs";
import { record } from "./ledger.mjs";

/**
 * 项目记忆：全团队共享的那种「这一单踩过什么坑、定过什么接口」。
 *
 * 为什么要有：每个新 session 的 agent 都是失忆的。没有记忆，同一个坑每个阶段踩一遍，
 * 人还要在 review 里重复解释同一件事。记忆不是聊天记录，是**结论**：
 * 一条记忆必须是一句能被下一个 agent 直接照做的话，超过 200 字就说明还没想清楚。
 *
 * 为什么只加不改：改了就没有审计。要推翻一条旧决定，就写一条新的（带来源），
 * 让「什么时候改的主意」留在账本里。
 */

export const MEMORY_KINDS = {
  decision: "决定",
  constraint: "约束",
  pitfall: "踩坑",
  interface: "接口",
};

const MAX_CHARS = 200;

export function addMemory(db, projectId, { kind = "decision", text, source = null, by = "system" } = {}) {
  if (!MEMORY_KINDS[kind]) throw new Error("记忆类型只能是 " + Object.keys(MEMORY_KINDS).join(" / "));
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (!clean) throw new Error("记忆内容不能为空");
  const id = newId("m");
  record(db, {
    type: "memory.added", actor: by,
    payload: { project_id: projectId, memory_id: id, kind, text: clean, source, by },
  });
  return id;
}

export function memoryOf(db, projectId, { limit = 200 } = {}) {
  return db.prepare("SELECT * FROM memory WHERE project_id=? ORDER BY created_at ASC LIMIT ?").all(projectId, limit);
}

/** 按角色关心的类型召回：规划关心约束/接口，实现关心接口/踩坑，评审关心全部。 */
const ROLE_KINDS = {
  lead: ["constraint", "decision"],
  architect: ["constraint", "interface"],
  coder: ["interface", "pitfall"],
  verifier: ["pitfall", "constraint"],
  reviewer: ["decision", "interface", "pitfall"],
};

/**
 * 给提示词的摘要：最近 8 条 + 按角色召回的 5 条，去重。
 * 为什么限量：真引擎每次调用光 harness 就 7 万 token，"把全部记忆塞进去"会让成本翻倍，
 * 而记忆的价值在于少踩坑，不在于全。
 */
export function memoryDigest(db, projectId, { role = "coder", recent = 8, recall = 5 } = {}) {
  if (!projectId) return "";
  const all = memoryOf(db, projectId);
  if (!all.length) return "";
  const picked = [];
  const seen = new Set();
  const push = (m) => {
    if (!m || seen.has(m.memory_id)) return;
    seen.add(m.memory_id);
    picked.push(m);
  };
  all.slice(-recent).forEach(push);
  const kinds = ROLE_KINDS[role] || ["decision"];
  all.filter((m) => kinds.includes(m.kind)).slice(-recall).forEach(push);
  const lines = picked.map((m) => "- [" + MEMORY_KINDS[m.kind] + "] " + m.text + (m.source ? "（来源：" + m.source + "）" : ""));
  return [
    "## 项目记忆（全团队共享，按时间累积；这些是已经定过的事，不要再问一遍）",
    ...lines.slice(-13),
    "如果你认为某条记忆是错的，不要默默绕过：在结论里写明「与记忆冲突：…」，人会处理。",
  ].join("\n");
}
