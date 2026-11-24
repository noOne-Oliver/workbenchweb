import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { newId } from "./ids.mjs";
import { record } from "./ledger.mjs";
import { getProject, rootDir } from "./stages.mjs";
import { memoryOf, MEMORY_KINDS } from "./memory.mjs";
import { workflowFor } from "./workflows.mjs";

/**
 * 收尾（retro）与资产库。
 *
 * 为什么项目不能「最后一个阶段合并完就 done」：
 * 那时候团队脑子里还有上下文，是唯一能低成本写下「这单学到了什么」的时刻。
 * 拖到下周再复盘，产出的就是套话。所以收尾是强制的，而且**不花 token**：
 * 全部从账本里长出来（成本、耗时、护栏失败、记忆、决议），agent 只负责干活，不负责总结自己。
 *
 * 资产不是「文档」，是下次能直接用的东西：冻结的 workflow、契约模板、边界清单。
 * 入库要人签字 —— 这是整个产品里第 3 次（也是最后一次）签字，而且只在真有可复用资产时发生。
 */

const parseJson = (s, d) => {
  try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; }
};

export function assetsDir(project) {
  return join(rootDir(), "projects", project.id);
}

export function listAssets(db, { status = null, limit = 100 } = {}) {
  const rows = db.prepare("SELECT * FROM assets ORDER BY created_at DESC LIMIT ?").all(limit);
  return status ? rows.filter((r) => r.status === status) : rows;
}

export function assetsOf(db, projectId) {
  return db.prepare("SELECT * FROM assets WHERE project_id=? ORDER BY created_at ASC").all(projectId);
}

function money(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function taskRows(db, projectId) {
  return db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at ASC").all(projectId);
}

/** 项目收尾：写沉淀包 + 提资产候选，等人签收。幂等：重复调用不重复写事件。 */
export function settleProject(db, projectId, { by = "system" } = {}) {
  const p = getProject(db, projectId);
  if (!p) throw new Error("项目不存在: " + projectId);
  if (!p.stages.length || p.stages.some((s) => s.state !== "done")) {
    throw new Error("还有阶段没交付，不能收尾");
  }
  if (p.state === "done") return p;
  const dir = assetsDir(p);
  mkdirSync(dir, { recursive: true });
  const tasks = taskRows(db, projectId);
  const mem = memoryOf(db, projectId);
  const decisions = db.prepare("SELECT * FROM decisions WHERE project_id=? ORDER BY created_at ASC").all(projectId);
  const signatures = p.signatures;

  const written = [];
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    written.push({ name, path: join("projects", p.id, name) });
  };

  // 1) 复盘：全部从账本长出来，没有一句是模型编的。
  const totalTokens = tasks.reduce((n, t) => n + Number(t.spent_tokens || 0), 0);
  const totalSeconds = tasks.reduce((n, t) => n + Number(t.review_seconds || 0) + Number(t.approval_seconds || 0), 0);
  const L = [];
  L.push("# 收尾复盘 · " + p.title);
  L.push("");
  L.push("- 项目：" + p.id + "（lane=" + p.lane + "，workflow=" + p.workflow + "）");
  L.push("- 仓库：" + p.repo);
  L.push("- 阶段：" + p.stages.length + " 个，签字 " + signatures.length + " 次（预期 " + Object.keys(workflowFor(p.lane).signatureGroups).length + " 次）");
  L.push("- 成本：" + money(totalTokens) + " token（预算 " + money(p.budget_tokens) + "）");
  L.push("- 人在评审上花的时间：" + totalSeconds + " 秒");
  L.push("- 决议：" + decisions.length + " 次（其中复议会 " + decisions.filter((d) => d.trigger !== "meeting").length + " 次）");
  L.push("- 记忆：" + mem.length + " 条");
  L.push("");
  L.push("## 阶段与交付");
  L.push("");
  L.push("| # | 阶段 | 负责人 | 目标 | 任务 | 成本 | 初筛 | 终审 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of p.stages) {
    const t = tasks.find((x) => x.id === s.task_id);
    L.push("| " + s.seq + " | " + s.name + " | " + (s.owner || "未指派") + " | " + String(s.goal).replace(/\|/g, "\\|").slice(0, 60) +
      " | " + (s.task_id || "-") + " | " + money(t && t.spent_tokens) + " | " + ((t && t.review_seconds) || 0) + "s | " + ((t && t.approval_seconds) || 0) + "s |");
  }
  L.push("");
  L.push("## 机器发现的问题（这里才是下次要改的东西）");
  L.push("");
  const failed = [];
  for (const t of tasks) {
    let ev = {};
    try { ev = JSON.parse(t.evidence || "{}"); } catch { ev = {}; }
    const guards = (ev.verify && ev.verify.guards) || [];
    for (const g of guards.filter((c) => !c.ok)) failed.push("- " + t.id + " 的 " + g.id + "：" + String(g.detail).slice(0, 160));
  }
  L.push(failed.length ? failed.join("\n") : "- 没有护栏失败：这一单是干净的（也可能是任务太简单，别过度解读）。");
  L.push("");
  L.push("## 遗留（backlog 分流结果）");
  L.push("");
  const backlog = p.backlog;
  L.push(backlog.length ? backlog.map((b) => "- [" + b.status + "] " + b.text).join("\n") : "- 无");
  L.push("");
  L.push("## 记忆（全团队共享）");
  L.push("");
  L.push(mem.length ? mem.map((m) => "- [" + MEMORY_KINDS[m.kind] + "] " + m.text).join("\n") : "- 无");
  write("postmortem.md", L.join("\n"));

  // 2) 决议记录：下次遇到同类问题，先看这里。
  const D = ["# 决议记录 · " + p.title, ""];
  if (!decisions.length) D.push("没有开会：这一单没有需要人拍板的岔路口。");
  for (const d of decisions) {
    D.push("## " + (d.trigger === "meeting" ? "预备会" : "复议会") + " · " + d.trigger);
    D.push("");
    D.push("- 时间：" + d.created_at + (d.resolved_at ? " → " + d.resolved_at : "（未拍板）"));
    D.push("- 拍板：" + (d.choice || "未定") + (d.by ? "（" + d.by + "）" : ""));
    if (d.note) D.push("- 理由：" + d.note);
    D.push("");
    D.push("<details><summary>机器当时的提案</summary>");
    D.push("");
    D.push(String(d.proposal || "").slice(0, 4000));
    D.push("");
    D.push("</details>");
    D.push("");
  }
  write("decisions.md", D.join("\n"));

  // 3) 记忆导出：记忆的真源在账本，这份文件是给人 grep 和带走的。
  const M = ["# 项目记忆 · " + p.title, "", "只加不改；要推翻就写一条新的。", ""];
  M.push(mem.length ? mem.map((m) => "- [" + MEMORY_KINDS[m.kind] + "] " + m.text + "（" + (m.source || "?") + "）").join("\n") : "（空）");
  write("memory.md", M.join("\n"));

  // 4) 资产候选：下次能直接套用的三个东西。
  const wf = workflowFor(p.lane);
  write("workflow.json", JSON.stringify({
    lane: p.lane, workflow: p.workflow, source_project: p.id, title: p.title,
    stages: p.stages.map((s) => ({ seq: s.seq, name: s.name, goal: s.goal, role: s.role, skill: s.skill, artifacts: s.artifacts, allowed_globs: s.allowedGlobs, non_goals: s.nonGoals })),
    signature_groups: wf.signatureGroups,
  }, null, 2) + "\n");

  write("contract-template.md", [
    "# 契约模板（来自 " + p.title + "）",
    "",
    "## 阶段边界",
    ...p.stages.map((s) => "- " + s.name + "：只允许改 " + ((s.allowedGlobs || []).join("、") || "（未限制）")),
    "",
    "## 产出物清单",
    ...p.stages.map((s) => "- " + s.name + "：" + ((s.artifacts || []).join("、") || "（无）")),
    "",
    "## 复用方法",
    "把这份文件贴进新项目的契约阶段，再按新仓库改路径。不要直接照抄目标。",
  ].join("\n"));

  const proposed = [];
  const propose = (kind, title, file) => {
    const id = newId("a");
    record(db, { type: "asset.proposed", actor: by, payload: { project_id: p.id, asset_id: id, kind, title, path: file } });
    proposed.push(id);
  };
  propose("workflow", p.title + " 的阶段链（" + p.stages.length + " 阶段）", join("projects", p.id, "workflow.json"));
  propose("contract", p.title + " 的契约/边界模板", join("projects", p.id, "contract-template.md"));

  if (p.state !== "settling") {
    record(db, {
      type: "project.transition", actor: by,
      payload: { project_id: p.id, from: p.state, to: "settling", reason: "所有阶段已交付，生成沉淀包待签收" },
    });
  }
  return { project: getProject(db, projectId), written, proposed_assets: proposed };
}

/** 崩溃续跑：收尾写到一半进程没了，重启后补跑（已经生成过资产的不重复写）。 */
export function settlePending(db, { by = "system" } = {}) {
  const rows = db.prepare("SELECT id FROM projects WHERE state='settling'").all();
  for (const r of rows) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE project_id=?").get(r.id).n;
    if (n) continue;
    try { settleProject(db, r.id, { by }); } catch { /* 下次再试，不影响主循环 */ }
  }
  return rows.length;
}

/**
 * 资产入库签字。人可以全收、部分收、全拒 —— 拒掉不是失败，是「这次没有可复用的东西」。
 * 全部资产都表决完，项目才真正 done。
 */
export function decideAssets(db, projectId, { accept = [], decline = [], by = "unknown", note = null } = {}) {
  const p = getProject(db, projectId);
  if (!p) throw new Error("项目不存在: " + projectId);
  if (p.state === "done") throw new Error("项目已完成");
  if (p.state !== "settling") throw new Error("项目还在 " + p.state + "，没有待签收的资产");
  const all = assetsOf(db, projectId);
  const pendingIds = all.map((a) => a.asset_id);
  for (const id of [...accept, ...decline]) {
    if (!pendingIds.includes(id)) throw new Error("资产不存在或不属于这个项目: " + id);
  }
  for (const id of accept) record(db, { type: "asset.decided", actor: by, payload: { project_id: projectId, asset_id: id, status: "accepted", by } });
  for (const id of decline) record(db, { type: "asset.decided", actor: by, payload: { project_id: projectId, asset_id: id, status: "declined", by } });
  const left = assetsOf(db, projectId).filter((a) => a.status === "proposed");
  if (left.length) {
    return { project: getProject(db, projectId), pending: left.map((a) => a.asset_id) };
  }
  record(db, {
    type: "project.transition", actor: by,
    payload: { project_id: projectId, from: p.state, to: "done", reason: "沉淀包已签收" + (note ? "：" + note : "") },
  });
  record(db, { type: "project.settled", actor: by, payload: { project_id: projectId, accepted: accept.length, declined: decline.length, note } });
  return { project: getProject(db, projectId), pending: [] };
}
