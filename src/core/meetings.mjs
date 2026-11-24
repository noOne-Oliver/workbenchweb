import { newId } from "./ids.mjs";
import { record, getTask, transition } from "./ledger.mjs";
import { getProject, getStage, addBacklog } from "./stages.mjs";
import { addMemory } from "./memory.mjs";
import { listAssets } from "./retro.mjs";

/**
 * 复议会：执行中发现「按现在签的字做不下去」时的增量重开会。
 *
 * 和预备会的区别：预备会决定「要做哪几个阶段」，复议会只回答一个具体问题
 * 「这一处边界/契约/预算要不要改」。所以它必须短（机器 3 分钟、人 1 分钟），
 * 而且**不能顺手重写整个目标** —— 目标一旦签字就冻结，改目标要重新走预备会。
 *
 * 触发是机械的（见 TRIGGERS），不是 agent 觉得自己需要开会就能开：
 * 否则模型会用「开会」逃避干活。
 */

export const TRIGGERS = {
  scope: {
    label: "越界：改动超出签字时的阶段边界",
    blocking: true,
    question: "这些越界改动，是扩边界，还是留到下一阶段？",
    options: [
      { id: "extend_scope", label: "扩边界（把越界目录加进本阶段）", desc: "本次改动继续做，但边界会写进账本，后续阶段按新边界判" },
      { id: "next_stage", label: "越界部分不做，留到下一阶段", desc: "当前任务打回重做，越界内容进 backlog，签字时再分流" },
      { id: "abort", label: "停下，人工接手", desc: "阶段保持 blocked，不再自动重试" },
    ],
  },
  contract: {
    label: "改契约：实现阶段动了契约/接口文件",
    blocking: true,
    question: "实现阶段改契约，是契约写错了，还是实现跑偏了？",
    options: [
      { id: "amend", label: "契约写错了：接受这次修改", desc: "把变更写进记忆，后续阶段按新契约做" },
      { id: "revert", label: "实现跑偏了：打回重做", desc: "任务回队列，coder 会收到「不许改契约」的反馈" },
      { id: "abort", label: "停下，人工接手", desc: "阶段保持 blocked" },
    ],
  },
  baseline: {
    label: "回归：原来能过的用例连续两轮挂掉",
    blocking: false,
    question: "是这次改动真弄坏了，还是基线本身有问题？",
    options: [
      { id: "fix", label: "真弄坏了：打回重做", desc: "任务回队列，带上挂掉的用例清单" },
      { id: "accept_risk", label: "基线问题：接受风险继续", desc: "写进记忆，后面的人知道这里有已知红灯" },
    ],
  },
  size: {
    label: "体量：一次改动超过 8 个文件",
    blocking: false,
    question: "这一坨要不要拆成两次交付？",
    options: [
      { id: "split", label: "拆：把建议拆法记进 backlog", desc: "本次继续，下一单按拆分清单做" },
      { id: "continue", label: "不拆，这次一起交", desc: "记一条记忆，避免下次又讨论" },
    ],
  },
  budget: {
    label: "预算：阶段已花掉七成",
    blocking: false,
    question: "剩下的钱够不够跑完？要不要加预算？",
    options: [
      { id: "raise_budget", label: "加 50% 预算继续", desc: "项目和当前任务预算一起加，账本留痕" },
      { id: "stop", label: "不加，跑到哪算哪", desc: "预算熔断后任务会 blocked，人再接手" },
    ],
  },
};

const parseJson = (s, d) => {
  try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; }
};

export function getDecision(db, id) {
  const row = db.prepare("SELECT * FROM decisions WHERE decision_id=?").get(id);
  return row ? { ...row, options: parseJson(row.options, []), evidence: parseJson(row.evidence, []) } : null;
}

export function decisionsOf(db, projectId, { status = null } = {}) {
  const rows = db.prepare("SELECT * FROM decisions WHERE project_id=? ORDER BY created_at ASC").all(projectId);
  return rows.map((r) => ({ ...r, options: parseJson(r.options, []), evidence: parseJson(r.evidence, []) }))
    .filter((r) => !status || r.status === status);
}

/** 同一阶段同一触发点只开一次会：重试时不能把人的待办刷成 20 条。 */
export function openDecision(db, projectId, { trigger, stageId = null, evidence = [], by = "system" } = {}) {
  const spec = TRIGGERS[trigger];
  if (!spec) throw new Error("未知的会议触发点: " + trigger);
  const existing = db.prepare("SELECT * FROM decisions WHERE project_id=? AND stage_id IS ? AND trigger=? AND status='open'")
    .get(projectId, stageId, trigger);
  if (existing) return getDecision(db, existing.decision_id);

  const p = getProject(db, projectId);
  if (!p) throw new Error("项目不存在: " + projectId);
  const stage = stageId ? p.stages.find((s) => s.stage_id === stageId) : null;
  const id = newId("d");
  const lines = [];
  lines.push("## 复议会（增量重开，机器 3 分钟 + 人 1 分钟）");
  lines.push("触发：" + spec.label);
  lines.push("项目：" + p.title + (stage ? " · 阶段 " + stage.seq + "/" + p.stages.length + "「" + stage.name + "」" : ""));
  lines.push("要回答的问题：" + spec.question);
  lines.push("");
  lines.push("### 现状（机器看到的事实）");
  for (const e of evidence.slice(0, 6)) lines.push("- " + e);
  lines.push("");
  lines.push("### 可选路线");
  for (const o of spec.options) lines.push("- " + o.id + "：" + o.label + "。" + o.desc);
  lines.push("");
  lines.push("### 机器的建议");
  lines.push(suggestFor(trigger, evidence));
  const recalled = recallAssets(db, p.title + " " + (stage ? stage.name + " " + stage.goal : ""));
  if (recalled.length) {
    lines.push("");
    lines.push("### 以前项目留下的可复用资产（可以要求直接套用）");
    for (const a of recalled) lines.push("- " + a.title + "（" + a.path + "）");
  }
  lines.push("");
  lines.push("拍板后自动执行：改边界/加预算 → 任务回队列继续；打回 → 带反馈重做；决议本身写进项目记忆。");

  record(db, {
    type: "decision.requested", actor: by,
    payload: {
      project_id: projectId, decision_id: id, stage_id: stageId, trigger,
      proposal: lines.join("\n"), options: spec.options, evidence: evidence.slice(0, 6),
    },
  });
  return getDecision(db, id);
}

function suggestFor(trigger, evidence) {
  if (trigger === "scope") return "先看这些文件是不是这次目标的一部分。是 → extend_scope；不是 → next_stage。不要因为「代码已经写了」就扩边界。";
  if (trigger === "contract") return "契约是上游签字的东西。实现阶段发现契约写错很常见，但只能由人确认：amend 才算数。";
  if (trigger === "baseline") return "连挂两次通常说明基线本身有问题或改动真的破坏了行为。先看挂掉的是哪几条，再决定 fix 还是 accept_risk。";
  if (trigger === "size") return "超过 8 个文件时 review 成本会跳一个量级。能拆就拆（split），但别为了拆而拆。";
  return "七成是预警线不是熔断线。真跑得完就不加；反复熔断说明任务切太大。";
}

function recallAssets(db, text) {
  try {
    const words = String(text || "").split(/[\s，。、,:：;；()（）\[\]【】/]+/).filter((w) => w.length >= 2);
    const all = listAssets(db, { status: "accepted", limit: 50 });
    return all.filter((a) => words.some((w) => (a.title + " " + a.kind).includes(w))).slice(0, 3);
  } catch { return []; }
}

/**
 * 拍板。每个 choice 都必须是机械可执行的 —— 「按讨论结果处理」不算决议。
 * 执行完必须落一条记忆，否则下次开会又要从头讨论同一个问题。
 */
export function resolveDecision(db, projectId, decisionId, { choice, note = null, by = "unknown" } = {}) {
  const d = getDecision(db, decisionId);
  if (!d || d.project_id !== projectId) throw new Error("复议会不存在: " + decisionId);
  if (d.status !== "open") throw new Error("这个复议会已经拍过板了（" + d.choice + "，by " + d.by + "）");
  const spec = TRIGGERS[d.trigger];
  const opt = spec.options.find((o) => o.id === choice);
  if (!opt) throw new Error("choice 只能是 " + spec.options.map((o) => o.id).join(" / "));

  const p = getProject(db, projectId);
  const stage = d.stage_id ? p.stages.find((s) => s.stage_id === d.stage_id) : null;
  const effects = [];

  if (d.trigger === "scope") {
    const outside = (d.evidence || []).filter((e) => e.startsWith("越界文件：")).join("").replace("越界文件：", "")
      .split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    if (choice === "extend_scope" && stage) {
      const dirs = [...new Set(outside.map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".")))];
      const globs = [...new Set([...(stage.allowedGlobs || []), ...dirs.map((x) => (x === "." ? "**" : x + "/**"))])];
      record(db, { type: "stage.patched", actor: by, payload: { project_id: projectId, stage_id: stage.stage_id, allowed_globs: globs, reason: "复议会扩边界：" + dirs.join("、") } });
      effects.push("边界扩到 " + globs.join("、"));
    } else if (choice === "next_stage") {
      for (const f of outside.slice(0, 6)) {
        addBacklog(db, projectId, { text: "越界改动留到下一阶段：" + f, stageId: stage ? stage.stage_id : null, source: "meeting", by });
      }
      effects.push("越界内容进 backlog");
    }
  }

  if (d.trigger === "contract" && choice === "amend" && stage) {
    record(db, { type: "stage.patched", actor: by, payload: { project_id: projectId, stage_id: stage.stage_id, reason: "复议会接受契约变更" } });
    effects.push("契约变更被接受");
  }

  if (d.trigger === "size" && choice === "split") {
    addBacklog(db, projectId, { text: "复议会建议拆分：这次改了超过 8 个文件，下次按目录分批交付", stageId: d.stage_id, source: "meeting", by });
    effects.push("拆分建议进 backlog");
  }

  if (d.trigger === "budget" && choice === "raise_budget") {
    const next = Math.round(Number(p.budget_tokens || 0) * 1.5) || 1_500_000;
    record(db, { type: "project.patched", actor: by, payload: { project_id: projectId, budget_tokens: next } });
    const t = stage && stage.task_id ? getTask(db, stage.task_id) : null;
    if (t) record(db, { taskId: t.id, type: "task.budget.set", actor: by, payload: { budget_tokens: Math.round(Number(t.budget_tokens || 0) * 1.5) } });
    effects.push("预算加到 " + next);
  }

  record(db, {
    type: "decision.resolved", actor: by,
    payload: { project_id: projectId, decision_id: decisionId, choice, by, note, effects },
  });
  addMemory(db, projectId, {
    kind: "decision",
    text: "复议会（" + spec.label + "）拍板：" + opt.label + (note ? "。理由：" + note : ""),
    source: "复议会 " + decisionId, by,
  });

  // 能继续的决议必须真的让执行器继续，否则「拍板」只是给界面换了个颜色。
  const resume = ["extend_scope", "next_stage", "amend", "fix", "accept_risk", "split", "continue", "raise_budget"].includes(choice);
  if (resume && stage && stage.task_id) {
    const t = getTask(db, stage.task_id);
    if (t && t.state === "blocked") {
      transition(db, t.id, "queued", { actor: by, reason: "复议会已拍板（" + choice + "），继续执行" });
      effects.push("任务回队列");
    }
  }
  if (choice === "abort" && stage) {
    record(db, { type: "stage.transition", actor: by, payload: { project_id: projectId, stage_id: stage.stage_id, from: stage.state, to: "blocked", reason: "复议会决定人工接手" } });
    effects.push("阶段标记 blocked");
  }
  return { decision: getDecision(db, decisionId), project: getProject(db, projectId), effects };
}
