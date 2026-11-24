import { resolve } from "node:path";
import { newId } from "./ids.mjs";
import { record, createTask, getTask } from "./ledger.mjs";
import { workflowFor, signatureGroupOf, agentForRole } from "./workflows.mjs";
import { sh } from "../runner/worktree.mjs";

/**
 * 项目 = 一条阶段链。
 *
 * 为什么任务之上还要加一层：任务只回答「这一坨改完了吗」，回答不了「我们是不是跑偏了」。
 * 跑偏是这类系统最贵的失败 —— 每一单都合格，合起来不是用户要的东西。
 * 所以把「阶段目标」做成账本里的对象：目标、产出物、允许改的路径在签字那一刻冻结，
 * 之后执行器只能按这个边界干活，越界由确定性护栏直接打回（见 guards.mjs 的 stage_scope）。
 *
 * 签字力度：一个功能 2 次 —— 设计+契约一次（想清楚），实现+合并一次（敢上线）。
 * 再加就是让人当橡皮章，那还不如不签。
 */

export const LANES = ["feature", "chore"];
export const PROJECT_STATES = ["drafting", "proposed", "running", "done"];
export const STAGE_STATES = ["proposed", "approved", "running", "done", "blocked"];

const parseJson = (s, d) => {
  try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; }
};

export function rootDir() {
  return resolve(process.env.WB_ROOT || process.cwd());
}

/**. 项目仓库的绝对路径：库里只存相对工作区的路径，和任务保持一致。 */
export function repoAbs(project) {
  return resolve(rootDir(), project.repo);
}

export function createProject(db, { title, repo, lane = "feature", owner = "unknown", budgetTokens = 1_000_000, meetingBudget = 0 } = {}) {
  if (!title || !repo) throw new Error("title 与 repo 必填");
  if (!LANES.includes(lane)) throw new Error("lane 只能是 " + LANES.join(" / "));
  const wf = workflowFor(lane);
  const id = newId("p");
  record(db, {
    type: "project.created", actor: owner,
    payload: { project_id: id, title, repo, lane: wf.id, workflow: wf.id, owner, budget_tokens: budgetTokens, meeting_budget: meetingBudget },
  });
  return getProject(db, id);
}

export function getProject(db, id) {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    stages: stagesOf(db, id),
    backlog: backlogOf(db, id),
    signatures: signaturesOf(db, id),
  };
}

export function listProjects(db, { limit = 100 } = {}) {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC LIMIT ?").all(limit)
    .map((r) => ({ ...r, stages: stagesOf(db, r.id), open_backlog: openBacklogCount(db, r.id) }));
}

export function stagesOf(db, projectId) {
  return db.prepare("SELECT * FROM stages WHERE project_id = ? ORDER BY seq ASC").all(projectId).map(hydrateStage);
}

export function getStage(db, stageId) {
  const row = db.prepare("SELECT * FROM stages WHERE stage_id = ?").get(stageId);
  return row ? hydrateStage(row) : null;
}

export function hydrateStage(row) {
  return {
    ...row,
    artifacts: parseJson(row.artifacts, []),
    allowedGlobs: parseJson(row.allowed_globs, []),
    nonGoals: parseJson(row.non_goals, []),
    agent: agentForRole(row.role),
  };
}

export function backlogOf(db, projectId, { status = null } = {}) {
  const rows = db.prepare("SELECT * FROM backlog WHERE project_id = ? ORDER BY created_at ASC").all(projectId);
  return status ? rows.filter((r) => r.status === status) : rows;
}

export function openBacklogCount(db, projectId) {
  return db.prepare("SELECT COUNT(*) AS n FROM backlog WHERE project_id = ? AND status = 'open'").get(projectId).n;
}

export function signaturesOf(db, projectId) {
  return db.prepare("SELECT * FROM signatures WHERE project_id = ? ORDER BY created_at ASC").all(projectId)
    .map((r) => ({ ...r, covers: parseJson(r.covers, []) }));
}

/** 这条任务属于哪个阶段（不属于任何阶段返回 null，老账本全是 null）。 */
export function stageForTask(db, task) {
  if (!task || !task.stage_id) return null;
  return getStage(db, task.stage_id);
}

/** 给护栏用的纯数据：闸门要判的东西全在这里，不让它去读库。 */
export function stageGateFor(stage) {
  if (!stage) return null;
  return {
    stage_id: stage.stage_id,
    name: stage.name,
    goal: stage.goal,
    skill: stage.skill,
    agent: stage.agent,
    artifacts: stage.artifacts || [],
    allowedGlobs: stage.allowedGlobs || [],
    nonGoals: stage.nonGoals || [],
  };
}

/** 仓库里有哪些文件（会议提案要用它判断「有没有测试」）。非 git 仓库返回空。 */
export function repoFileList(project) {
  const r = sh("git", ["-C", repoAbs(project), "ls-files"]);
  if (!r.ok) return [];
  return String(r.out || "").split("\n").filter(Boolean);
}

const HEAVY = /重构|迁移|架构|设计文档|多个模块|全部|批量|升级|清理|并发|安全|性能|协议|接口不兼容/;
const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * 预备会的提案。确定性生成 —— 同样的输入永远得到同样的阶段链，可测、可复现。
 * 目标里带 {title} 的地方用项目标题填，其余边界/产出物/角色原样来自 workflow 模板。
 */
export function buildProposal(project, { repoFiles = [] } = {}) {
  const wf = workflowFor(project.lane);
  const stages = wf.stages.map((s, i) => ({
    stage_id: newId("s"),
    seq: i + 1,
    name: s.name,
    goal: String(s.goal).replace(/\{title\}/g, project.title),
    role: s.role,
    skill: s.skill,
    artifacts: s.artifacts.slice(),
    allowed_globs: s.allowedGlobs.slice(),
    non_goals: s.nonGoals.slice(),
    signature_group: signatureGroupOf(wf, s.name) || "A",
    state: "proposed",
  }));

  // 发散捕获：预备会不只是排版阶段，还要把「现在就该拍但没拍」的事摆到桌上。
  const backlog = [];
  const heavy = HEAVY.exec(project.title);
  if (heavy) {
    backlog.push({ id: newId("b"), stage_id: stages[0].stage_id, source: "meeting",
      text: "标题里有「" + heavy[0] + "」这类大词：要不要先做一次影响面梳理，再定契约？" });
  }
  if (wf.meeting && repoFiles.length && !repoFiles.some((p) => TEST_FILE_RE.test(p))) {
    backlog.push({ id: newId("b"), stage_id: stages[stages.length - 1].stage_id, source: "meeting",
      text: "仓库里没找到测试：实现阶段先补最小测试再改功能，还是接受只靠人工 review？" });
  }

  // 会议不能白开：功能 lane 至少要摆一件「机器不敢替人决定」的事上来。
  if (wf.meeting && backlog.length === 0) {
    backlog.push({ id: newId("b"), stage_id: stages[stages.length - 1].stage_id, source: "meeting",
      text: "目标只有一句话：要不要在契约阶段把验收标准写成清单？不写的话只能按「测试通过」验收。" });
  }

  const groups = Object.keys(wf.signatureGroups);
  const minutes = wf.meeting ? Math.max(6, 3 + stages.length) : 1;
  const summary = wf.meeting
    ? "机器开完预备会：拆成 " + stages.length + " 个阶段，只需要签 " + groups.length + " 次字（约 " +
      minutes + " 分钟）。你只回答三件事：目标对不对、边界够不够、清单要不要调。"
    : "杂活 lane 不开会：一个阶段，签一次字就能跑（约 1 分钟）。";

  return { stages, backlog, summary, human_minutes: minutes };
}

/**
 * 异步预备会：机器先把提案写出来，人之后再来看。
 * provider 可选：给了就让 agent 按项目背景重写「目标」并补充发散项；
 * 但产出物与边界（allowedGlobs）不允许被 agent 放宽 —— 收缩安全边界是人的事，不是模型的。
 */
export async function meetProject(db, projectId, { provider = null, repoFiles = null } = {}) {
  const p = getProject(db, projectId);
  if (!p) throw new Error("项目不存在: " + projectId);
  if (p.state === "done") throw new Error("项目已完成，不能再开会");
  if (p.stages.some((s) => s.state !== "proposed")) {
    throw new Error("已经有阶段开工或签字了：要改目标请走复议会（这会攒证据），不要重开预备会");
  }
  const files = repoFiles || repoFileList(p);
  const proposal = buildProposal(p, { repoFiles: files });
  let agent = "deterministic";
  const notes = [];

  if (provider) {
    try {
      const prompt = [
        "## 角色：Lead（预备会主持人，不写代码）",
        "项目：" + p.title,
        "仓库：" + p.repo + "（" + files.length + " 个文件）",
        "机器已经按模板拆出 " + proposal.stages.length + " 个阶段：",
        proposal.stages.map((s) => s.seq + ". " + s.name + " - " + s.goal).join("\n"),
        "",
        "请只做两件事，输出一个 JSON 代码块（三个波浪线包围，语言标 json）：",
        "1. 用项目背景把每个阶段的 goal 写得更具体（保留阶段名与顺序，不改产出物与边界）；",
        "2. 补充最多 2 条「现在就该拍但没拍」的发散项（backlog）。",
        "格式：{\"stages\":[{\"name\":\"设计\",\"goal\":\"...\"}],\"backlog\":[\"\"...\"]}",
      ].join("\n");
      const res = await provider.run({ role: "lead", prompt, cwd: rootDir(), task: { id: p.id, title: p.title } });
      if (res && res.ok && res.text) {
        const refined = parseProposalBlock(res.text);
        if (refined) {
          agent = "lead";
          for (const s of proposal.stages) {
            const hit = (refined.stages || []).find((x) => x && x.name === s.name && x.goal);
            if (hit) s.goal = String(hit.goal).slice(0, 600);
          }
          for (const text of (refined.backlog || []).slice(0, 2)) {
            if (!text || typeof text !== "string") continue;
            proposal.backlog.push({ id: newId("b"), stage_id: proposal.stages[0].stage_id, source: "meeting", text: String(text).slice(0, 300) });
          }
        } else notes.push("模型的提案没能解析成 JSON，已退回确定性模板");
      } else notes.push("模型没给出可用提案（" + ((res && res.error) || "空产出") + "），已退回确定性模板");
    } catch (e) {
      notes.push("模型开会失败：" + String((e && e.message) || e) + "；已退回确定性模板");
    }
  }

  record(db, {
    type: "project.meeting", actor: agent,
    payload: {
      project_id: p.id, agent, summary: proposal.summary, human_minutes: proposal.human_minutes,
      stages: proposal.stages, backlog: proposal.backlog, notes,
    },
  });
  if (p.state !== "proposed") {
    record(db, { type: "project.transition", actor: agent, payload: { project_id: p.id, from: p.state, to: "proposed", reason: "预备会开完，提案等人签" } });
  }
  return getProject(db, projectId);
}

/** 从 agent 输出里抠出提案 JSON（容忍前后夹带解释）。 */
export function parseProposalBlock(text) {
  const tick = String.fromCharCode(96).repeat(3);
  const re = new RegExp("(?:" + tick + "|~{3})json\\s*([\\s\\S]*?)(?:" + tick + "|~{3})", "g");
  const hits = [...String(text || "").matchAll(re)];
  for (let i = hits.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(hits[i][1]);
      if (v && (Array.isArray(v.stages) || Array.isArray(v.backlog))) return v;
    } catch { /* 继续往上找 */ }
  }
  return null;
}

/**
 * 签字。一次签一组（设计+契约 / 实现+合并），这一组里的阶段一起解锁。
 * 两个硬约束：
 * 1. 这一批之前的阶段必须已经交付完 —— 签字要基于交付物，不是基于承诺。
 * 2. 所有 open 的发散项必须被分流 —— 签字的动作本身就是分流，「以后再说」不算分流。
 */
export function signStages(db, projectId, { group, by = "unknown", role = null, note = null } = {}) {
  const p = getProject(db, projectId);
  if (!p) throw new Error("项目不存在: " + projectId);
  const wf = workflowFor(p.lane);
  const names = wf.signatureGroups[group];
  if (!names) throw new Error("没有签字组「" + group + "」，可选：" + Object.keys(wf.signatureGroups).join(" / "));
  if (p.state === "done") throw new Error("项目已完成");
  const covered = p.stages.filter((s) => names.includes(s.name));
  if (covered.length !== names.length) throw new Error("阶段配置模板不一致（缺阶段），重新开预备会");
  const already = p.signatures.filter((s) => s.group_name === group);
  if (already.length) {
    throw new Error("「" + names.join(" + ") + "」在 " + already[0].created_at + " 已经由 " + already[0].by + " 签过");
  }
  const firstSeq = Math.min(...covered.map((s) => s.seq));
  const behind = p.stages.filter((s) => s.seq < firstSeq && s.state !== "done");
  if (behind.length) {
    throw new Error("先让 " + behind.map((s) => "「" + s.name + "」").join("、") + " 交付完再签这一批：签字要基于交付物，不是预告");
  }
  const open = p.backlog.filter((b) => b.status === "open");
  if (open.length) {
    throw new Error("还有 " + open.length + " 条发散项没分流（签字的同时把它们分流掉）：" +
      open.map((b) => b.id + " " + b.text.slice(0, 40)).join("；"));
  }

  record(db, {
    type: "stage.signed", actor: by,
    payload: { project_id: projectId, group, covers: names, by, role, note: note || null },
  });
  if (p.state !== "running") {
    record(db, { type: "project.transition", actor: by, payload: { project_id: projectId, from: p.state, to: "running", reason: "已签「" + names.join(" + ") + "」" } });
  }
  return getProject(db, projectId);
}

/** 阶段开工：给这个阶段建一条真正的任务，并把它挂上去。任务本身走原来的执行器。 */
export function startStage(db, projectId, ref, { by = "system", budgetTokens = null } = {}) {
  const p = getProject(db, projectId);
  if (!p) throw new Error("项目不存在: " + projectId);
  if (p.state === "done") throw new Error("项目已完成");
  const stage = findStage(p, ref);
  if (!stage) throw new Error("没有这个阶段: " + ref + "（可选 " + p.stages.map((s) => s.seq + "." + s.name).join(" / ") + "）");
  if (stage.task_id) throw new Error("阶段「" + stage.name + "」已经有任务了: " + stage.task_id);
  if (stage.state !== "approved") {
    throw new Error("阶段「" + stage.name + "」还没签字（当前 " + stage.state + "）：先签 " +
      (stage.signature_group || "?") + " 组");
  }
  const behind = p.stages.filter((s) => s.seq < stage.seq && s.state !== "done");
  if (behind.length) {
    throw new Error("先等 " + behind.map((s) => "「" + s.name + "」").join("、") + " 交付完：阶段要按顺序走，跳关就是发散");
  }
  const t = createTask(db, {
    title: stage.goal, repo: p.repo, owner: by,
    budgetTokens: Number(budgetTokens || p.budget_tokens || 1_000_000),
  });
  record(db, { taskId: t.id, type: "task.scoped", actor: by, payload: { project_id: projectId, stage_id: stage.stage_id } });
  record(db, { type: "stage.assigned", actor: by, payload: { project_id: projectId, stage_id: stage.stage_id, task_id: t.id } });
  record(db, {
    type: "stage.transition", actor: by,
    payload: { project_id: projectId, stage_id: stage.stage_id, from: stage.state, to: "running", reason: "开工：任务 " + t.id },
  });
  // 返回重放后的任务：createTask 的返回值是插入前那一刻的投影，stage_id 还没写上去。
  return { project: getProject(db, projectId), task: getTask(db, t.id) };
}

export function findStage(project, ref) {
  const s = String(ref);
  return project.stages.find((x) => String(x.seq) === s) ||
    project.stages.find((x) => x.name === s) ||
    // 界面上的按钮带的是 stage_id（s_xxx）：URL 里塞不下中文阶段名，别再让这条路 404。
    project.stages.find((x) => x.stage_id === s) || null;
}

/** 发散项分流：next（下一阶段做）/ later（以后做）/ drop（不做）。 */
export const BACKLOG_DECISIONS = { next: "下一阶段做", later: "以后做", drop: "不做" };

export function addBacklog(db, projectId, { text, stageId = null, source = "agent", by = "agent" } = {}) {
  if (!text) throw new Error("发散项要写清楚是什么");
  const id = newId("b");
  record(db, {
    type: "backlog.added", actor: by,
    payload: { project_id: projectId, id, stage_id: stageId, text: String(text).slice(0, 300), source },
  });
  return id;
}

export function decideBacklog(db, projectId, backlogId, { status, by = "unknown", note = null } = {}) {
  if (!BACKLOG_DECISIONS[status]) {
    throw new Error("status 只能是 " + Object.keys(BACKLOG_DECISIONS).join(" / "));
  }
  const item = db.prepare("SELECT * FROM backlog WHERE id = ? AND project_id = ?").get(backlogId, projectId);
  if (!item) throw new Error("这条发散项不存在: " + backlogId);
  record(db, {
    type: "backlog.decided", actor: by,
    payload: { project_id: projectId, id: backlogId, status, by, note: note || null },
  });
  return getProject(db, projectId);
}

/** 阶段的任务合并完了：把阶段标成 done，并在全部交付后把项目关掉。 */
export function completeStageForTask(db, task, { by = "system" } = {}) {
  if (!task || !task.stage_id) return null;
  const stage = getStage(db, task.stage_id);
  if (!stage || stage.state === "done") return null;
  record(db, {
    type: "stage.transition", actor: by,
    payload: { project_id: stage.project_id, stage_id: stage.stage_id, from: stage.state, to: "done", reason: "任务 " + task.id + " 已合并" },
  });
  return advanceProject(db, stage.project_id, { by });
}

export function advanceProject(db, projectId, { by = "system" } = {}) {
  const p = getProject(db, projectId);
  if (!p) return null;
  if (p.state === "done") return p;
  if (p.stages.length && p.stages.every((s) => s.state === "done")) {
    record(db, {
      type: "project.transition", actor: by,
      payload: { project_id: projectId, from: p.state, to: "done", reason: "所有阶段都已交付" },
    });
    return getProject(db, projectId);
  }
  return p;
}

/** 一条项目的事件时间线（界面/报告用）。 */
export function eventsOfProject(db, projectId) {
  return db.prepare("SELECT * FROM events WHERE type LIKE 'project.%' OR type LIKE 'stage.%' OR type LIKE 'backlog.%' ORDER BY id ASC").all()
    .filter((e) => {
      try { return JSON.parse(e.payload).project_id === projectId; } catch { return false; }
    });
}