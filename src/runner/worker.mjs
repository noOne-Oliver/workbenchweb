import { openDb } from "../core/db.mjs";
import { getTask, listTasks, transition, record, spendBudget, addEvidence, overBudget, forceTransition } from "../core/ledger.mjs";
import { acquire, renew, release, reclaimExpired, reclaimDead } from "../core/lease.mjs";
import { hostname } from "node:os";
import { getProvider } from "./engine.mjs";
import { sh, ensureWorktree, resetToBase, commitAll, diffStat, diffPatch, headSha, isGitRepo, statusPorcelain, newlyDirty, restorePaths } from "./worktree.mjs";
import { loadRepoConfig, runGuards } from "./guards.mjs";
import { classifySize, repoFileCount } from "../core/sizing.mjs";
import { stageForTask, stageGateFor, completeStageForTask, addBacklog, advanceProject, getProject } from "../core/stages.mjs";
import { openDecision } from "../core/meetings.mjs";
import { settleProject, settlePending } from "../core/retro.mjs";
import { addMemory, memoryDigest } from "../core/memory.mjs";
import { agentForRole } from "../core/workflows.mjs";
import * as sop from "./sop.mjs";
import { resolve, join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { startHeartbeat } from "../core/liveness.mjs";

import { BUILTIN_ENGINES } from "./providers/index.mjs";
export { BUILTIN_ENGINES };

export const ROOT = resolve(process.env.WB_ROOT || process.cwd());
// builtin 引擎的只读根：规划/架构阶段 cwd 在 scratch 里，必须能读到工作区里的目标仓库。
// 不显式设置时 builtin 只认 WB_ROOT；没导出 WB_ROOT 的场景（cli --dir）就补这一行。
process.env.WB_BUILTIN_READ_ROOTS ||= ROOT;
const WORKTREES = resolve(ROOT, "worktrees");
const SCRATCH = resolve(ROOT, ".oc/scratch");
const MAX_ATTEMPTS = Number(process.env.WB_MAX_ATTEMPTS || 3);
const PAUSED = new Set(["awaiting_review", "awaiting_approval", "awaiting_human", "done", "blocked", "failed"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可被认领的任务：非暂停态 + 租约空闲或已过期（崩溃恢复走这条路）。 */
export function pickRunnable(db) {
  return db.prepare(
    "SELECT id, state FROM tasks WHERE state NOT IN ('awaiting_review','awaiting_approval','awaiting_human','done','blocked','failed') " +
    "AND (lease_expires_at IS NULL OR lease_expires_at < ?) ORDER BY created_at ASC LIMIT 1"
  ).get(Date.now());
}

/** 这个泵真正会处理的状态。不在这里的一律算"不认识"——见 pump 里的兜底。 */
/** 内核版本：心跳里带上它，才能看出"跑着的进程是旧代码"。 */
export function codeVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || "unknown";
  } catch { return "unknown"; }
}

export const HANDLED_STATES = new Set(["queued", "planning", "implementing", "verifying", "reviewing", "merging"]);

export async function runTask(db, id, ctx) {
  const { workerId, provider } = ctx;
  for (let step = 0; step < 60; step++) {
    const t = getTask(db, id);
    if (!t) return null;
    if (PAUSED.has(t.state)) return t;
    if (!renew(db, id, workerId, 300000)) {
      record(db, { taskId: id, type: "lease.lost", actor: workerId, payload: {} }, false);
      return getTask(db, id);
    }
    try {
      switch (t.state) {
        case "queued":      transition(db, id, "planning", { actor: workerId, reason: "claimed" }); break;
        case "planning":    await doPlanning(db, id, ctx); break;
        case "implementing":await doImplement(db, id, ctx); break;
        case "verifying":   await doVerify(db, id, ctx); break;
        case "reviewing":   await doReview(db, id, ctx); break;
        case "merging":     await doMerge(db, id, ctx); break;
        default: return t;
      }
    } catch (e) {
      const cur = getTask(db, id);
      const msg = String(e && e.message || e);
      addEvidence(db, id, { last_error: msg, at: new Date().toISOString() }, "evidence.patch");
      record(db, { taskId: id, type: "run.error", actor: workerId, payload: { state: cur && cur.state, error: msg.slice(0, 400) } }, false);
      if (cur && cur.state === "blocked") return cur; // 熔断后的状态不许被 catch 重新拉回队列
      // 确定性失败（权限/凭据/模型不存在）：重试是纯烧钱，直接交给人。
      if (e && e.fatal) {
        transition(db, id, "blocked", { actor: workerId, reason: msg.slice(0, 300) });
        return getTask(db, id);
      }
      // 计划和验证阶段的失败不会涨 attempts（没走到 implementing），
      // 只看 attempts 会让"每次调用都失败的引擎"无限重试、白烧时间。所以单独数错误。
      const errors = db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='run.error'").get(id).n;
      if ((cur && cur.attempts >= MAX_ATTEMPTS) || errors >= MAX_ATTEMPTS * 2) {
        transition(db, id, "blocked", { actor: workerId, reason: "error(" + errors + "): " + msg.slice(0, 200) });
      } else {
        transition(db, id, "queued", { actor: workerId, reason: "retry after error" });
      }
      return getTask(db, id);
    }
  }
  return getTask(db, id);
}

/**
 * 一次 agent 调用。
 * 人不在终端前面，所以"现在是谁在跑、跑了多久、有没有动静"必须落成事件：
 * agent.started / agent.heartbeat / agent.finished。没有这三条，界面只能给一个状态徽章，
 * 分不清"在思考"和"进程已经死了"——那正是值班员的活。
 */
async function callAgent(db, id, ctx, { role, prompt, attempt }) {
  const t = getTask(db, id);
  if (overBudget(t)) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "budget exhausted" });
    throw new Error("budget exhausted");
  }
  const zeroBased = attempt === undefined ? Math.max(0, t.attempts - 1) : attempt;
  const startedMs = Date.now();
  record(db, {
    taskId: id, type: "agent.started", actor: ctx.workerId,
    payload: { role, attempt: zeroBased, prompt_chars: prompt.length },
  }, false);

  const timer = setInterval(() => renew(db, id, ctx.workerId, 300000), 60000);
  const beat = setInterval(() => {
    record(db, {
      taskId: id, type: "agent.heartbeat", actor: ctx.workerId,
      payload: { role, elapsed_s: Math.round((Date.now() - startedMs) / 1000) },
    }, false);
  }, Number(process.env.WB_HEARTBEAT_MS || 15000));
  if (timer.unref) timer.unref();
  if (beat.unref) beat.unref();

  let res = null;
  let thrown = null;
  try {
    res = await ctx.provider.run({ role, prompt, cwd: ctx.cwd, task: t, attempt: zeroBased });
    if (res && res.tokens) spendBudget(db, id, res.tokens, { role });
  } catch (e) {
    thrown = e;
  } finally {
    clearInterval(timer);
    clearInterval(beat);
  }

  record(db, {
    taskId: id, type: "agent.finished", actor: ctx.workerId,
    payload: {
      role,
      ok: !thrown && !!(res && res.ok),
      tokens: (res && res.tokens) || 0,
      ms: Date.now() - startedMs,
      error: thrown ? String(thrown && thrown.message || thrown).slice(0, 200)
        : (res && res.ok ? null : String(res && res.error || "unknown").slice(0, 200)),
    },
  }, false);

  if (thrown) throw thrown;
  if (!res || !res.ok) {
    const err = new Error((role + " 调用失败: ") + (res && res.error || "unknown"));
    // 引擎自己判定"再试也一样"的（权限、凭据、模型不存在），不该再烧掉五轮预算。
    err.fatal = !!(res && res.fatal);
    throw err;
  }
  return res;
}

/** 规划阶段的沙箱：真引擎会真的写文件，绝不能让 lead/architect 以仓库根为 cwd。 */
function scratchFor(id) {
  const d = join(SCRATCH, id);
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 规划阶段。体量分级决定要不要花「拆解 + 定边界」两次调用：
 * 每个 agent 调用光 harness + 推理就要 7~17 万 token，小改动上这两刀纯属浪费。
 * 但省钱不能省质量：small 只在第一次尝试走快路径，一旦没过（attempts > 0）
 * 就自动降级成 normal，重试时拿到完整拆解。
 */
/** 把阶段定义压成 coder 能读的方案：目标、边界、产出物、不做什么。 */
function stagePlanMd(stage) {
  const L = [];
  L.push("## 这个阶段要做的事");
  L.push(stage.goal);
  L.push("");
  L.push("## 边界（越界会被护栏打回）");
  const globs = Array.isArray(stage.allowedGlobs) ? stage.allowedGlobs : [];
  L.push(globs.length ? "只允许改这些路径：" + globs.join("、") : "本阶段不限制改动路径");
  const artifacts = Array.isArray(stage.artifacts) ? stage.artifacts : [];
  if (artifacts.length) L.push("必须产出这些文件：" + artifacts.join("、"));
  const nonGoals = Array.isArray(stage.nonGoals) ? stage.nonGoals : [];
  if (nonGoals.length) {
    L.push("");
    L.push("## 这个阶段明确不做");
    for (const n of nonGoals) L.push("- " + n);
  }
  L.push("");
  L.push("## 纪律");
  L.push("只做上面这一件事。想到的其他改进不要顺手做，写进交付说明里的「遗留」即可——它们下次开会再决定。");
  return L.join("\n");
}

async function doPlanning(db, id, ctx) {
  const t = getTask(db, id);
  const dir = scratchFor(id);
  const repoAbs = resolve(ROOT, t.repo);
  const stage = stageForTask(db, t);

  // 挂了阶段的任务不再"自由发挥"：这一阶段要做什么，会议里已经定死了（目标 + 产出物 + 边界）。
  // 再让 lead 重新想一遍方案，等于每个阶段都重开一次会，也给了它悄悄改目标的余地。
  if (stage) {
    record(db, { taskId: id, type: "task.sized", actor: ctx.workerId, payload: { size: "normal", reason: "阶段任务：方案由阶段目标决定，不另起规划" } }, false);
    addEvidence(db, id, { size: "normal", size_reason: "阶段任务：方案由阶段目标决定", stage: stage.stage_id, stage_name: stage.name }, "evidence.patch");
    record(db, { taskId: id, type: "plan.produced", actor: ctx.workerId, payload: { plan_md: stagePlanMd(stage) } });
    transition(db, id, "implementing", { actor: ctx.workerId, reason: "阶段「" + stage.name + "」目标已定，直接开工" });
    return;
  }

  const { size, reason } = classifySize(t, { repoFiles: repoFileCount(repoAbs) });
  record(db, { taskId: id, type: "task.sized", actor: ctx.workerId, payload: { size, reason, attempt: t.attempts } }, false);
  addEvidence(db, id, { size, size_reason: reason }, "evidence.patch");

  if (size === "small" && t.attempts === 0) {
    record(db, { taskId: id, type: "plan.skipped", actor: ctx.workerId, payload: { size, reason: reason + "；Coder 自己决定实现方式，Verifier 仍然独立" } }, false);
    transition(db, id, "implementing", { actor: ctx.workerId, reason: "fast path: " + size });
    return;
  }

  const lead = await callAgent(db, id, { ...ctx, cwd: dir }, { role: "lead", prompt: sop.leadPrompt(t, repoAbs) });
  record(db, { taskId: id, type: "plan.produced", actor: "lead", payload: { plan_md: lead.text } });

  // 单模块的活不需要「拆成几个切片」——那是 large 才付得起的钱。
  // normal 保留 lead 出方案（否则 coder 连要改什么都得自己猜），砍掉 architect。
  if (size === "large") {
    const arch = await callAgent(db, id, { ...ctx, cwd: dir }, { role: "architect", prompt: sop.architectPrompt(t, lead.text, repoAbs) });
    record(db, { taskId: id, type: "slices.produced", actor: "architect", payload: { slices: arch.text } });
  }
  transition(db, id, "implementing", { actor: ctx.workerId, reason: "plan ready (" + size + ")" });
}

/**
 * 预算里必须给"验证"留出余量。
 * 真实基准里翻过的车：实现花了 18 万 token 写完，账上没钱再跑一轮 Verifier，
 * 于是整个任务 blocked —— 那一轮实现的钱白花，人还得手动加预算重来。
 * 所以进入实现之前就检查：剩余预算够不够"再实现一次 + 验证一次"。
 */
export function reserveShort(task, ratio) {
  const budget = Number((task && task.budget_tokens) || 0);
  const spent = Number((task && task.spent_tokens) || 0);
  if (!budget) return "";
  const need = Math.max(budget * (ratio === undefined ? Number(process.env.WB_VERIFY_RESERVE || 0.25) : ratio), 150000);
  const left = budget - spent;
  if (left >= need) return "";
  return "预算不足：剩 " + left + "，实现+验证至少还要 " + Math.round(need) + "；加预算或人工接手";
}

/**
 * 把「上一轮为什么没过」压成一段话，喂给重试的 Coder。没有失败则返回空串。
 * 两个来源：机器护栏/Verifier 的证据，和人在初筛/终审打回时写的意见——人的意见优先级更高，
 * 因为它编码的是「机器判断不了的事」：做的是不是这件事、范围能不能接受。
 */
export function retryFeedback(task, db = null) {
  const v = (task && task.evidence && task.evidence.verify) || null;
  const lines = [];

  if (db && task && task.id) {
    const ev = db.prepare("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'review.changes_requested' ORDER BY id DESC LIMIT 1").get(task.id);
    if (ev) {
      let p = {};
      try { p = JSON.parse(ev.payload); } catch { p = {}; }
      const stage = p.stage === "awaiting_review" ? "初筛" : "终审";
      lines.push("人（" + (p.by || "?") + "，" + stage + "）把上一版打回了，原话：" + (p.note ? "「" + p.note + "」" : "（没写理由）"));
      lines.push("这条是人的意见，优先级高于机器结论。不要原样重做——先想清楚他要的是哪个方向的改动，再动手。");
    }
  }

  if (!v) return lines.join("\n");
  const failed = (v.guards || []).filter((c) => !c.ok);
  if (failed.length) {
    lines.push("机器护栏判定失败（这些是确定的，不是建议）：");
    for (const c of failed) lines.push("- " + c.id + "：" + c.detail);
  }
  const verdict = v.verdict || null;
  if (verdict && verdict.verdict === "fail" && verdict.summary) {
    lines.push("独立 Verifier 的结论：" + verdict.summary);
  }
  if (verdict && Array.isArray(verdict.raised) && verdict.raised.length) {
    lines.push("需要一并处理的点：" + verdict.raised.join("；"));
  }
  return lines.join("\n");
}

async function doImplement(db, id, ctx) {
  let t = getTask(db, id);
  const repo = resolve(ROOT, t.repo);
  if (!isGitRepo(repo)) throw new Error("目标不是 git 仓库: " + repo);

  // 阶段任务必须由 startStage 正式开工（会记 stage.transition= running）。
  // 直接改库或绕过接口塞进来的任务在这里被拦住——否则"没签字的阶段"能照跑，闸门形同虚设。
  const stage = stageForTask(db, t);
  if (stage && stage.state !== "running") {
    transition(db, id, "blocked", {
      actor: ctx.workerId,
      reason: "阶段「" + stage.name + "」当前是 " + stage.state + "，还没签字/开工，不能动手",
    });
    return;
  }

  if (t.attempts >= MAX_ATTEMPTS) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "max attempts reached" });
    return;
  }

  const base = t.base_sha || headSha(repo);
  const branch = t.branch || ("wb/" + id);
  const dir = join(WORKTREES, id);
  const wt = ensureWorktree({ repo, dir, branch, base });
  if (!wt.ok) throw new Error("worktree 失败: " + wt.error);

  // 崩溃续跑：上一次 attempt 没有产出 impl（进程被 kill -9），就不该白烧一次重试额度
  const inflight = hasInflightAttempt(db, id);

  // 真重试（不是崩溃续跑）必须从基线重来：否则 coder 看到的是上一轮已经写好的代码，
  // 会"发现活已干完"并产出逐字节相同的 diff，护栏照样不过 —— 白烧一整轮。
  if (!inflight && t.attempts > 0) {
    const reset = resetToBase(dir, base);
    if (!reset.ok) throw new Error("重置 worktree 到基线失败: " + reset.error);
  }

  // 预算要留出验证的钱：实现跑完却没钱验证，等于把上一轮的钱一起扔掉。
  const low = reserveShort(t);
  if (low) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: low });
    return;
  }
  const tries = db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type IN ('attempt.started','attempt.resumed')").get(id).n;
  if (tries >= MAX_ATTEMPTS * 3) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "too many retries (incl. crash resumes)" });
    return;
  }
  record(db, {
    taskId: id,
    type: inflight ? "attempt.resumed" : "attempt.started",
    actor: ctx.workerId,
    payload: inflight ? { attempt: t.attempts - 1, reason: "resumed after crash" } : { attempt: t.attempts },
  });
  t = getTask(db, id);
  const attempt = t.attempts - 1;

  // 容器化靠不住：引擎能执行 shell，就可能把文件写到 worktree 外面（真实基准里 coder 顺着
  // worktree 的 .git 找到主仓库，把测试写进去了，然后 merge 因为主仓库脏而失败）。
  // 这里的规矩是：只还原「这次 coder 跑之前是干净的、跑完变脏了」的路径 —— 别人未提交的改动
  // 一个字都不碰，但 coder 越界写的东西必须原样退回，否则整轮验证白做。
  const repoBefore = statusPorcelain(repo);

  // 设计/契约阶段由 architect 视角的 agent 干，实现阶段才是 coder。
  // 同一个 provider，换的是"这个人现在是谁"——角色先于模型。
  await callAgent(db, id, { ...ctx, cwd: dir }, {
    role: agentForRole(stage ? stage.role : "coder"),
    prompt: sop.coderPrompt(t, t.plan_md || "", attempt, retryFeedback(t, db),
      memoryDigest(db, t.project_id, { role: stage ? stage.role : "coder" })),
    attempt,
  });

  const escaped = newlyDirty(repoBefore, statusPorcelain(repo));
  if (escaped.length) {
    restorePaths(repo, escaped);
    record(db, {
      taskId: id, type: "workspace.restored", actor: ctx.workerId,
      payload: { files: escaped.slice(0, 20), reason: "coder 写到了 worktree 外面，已还原主仓库" },
    });
    addEvidence(db, id, { containment: { escaped: escaped.slice(0, 20), at: new Date().toISOString() } }, "evidence.patch");
  }

  const c = commitAll(dir, "wb: " + t.title + " (attempt " + (attempt + 1) + ")");
  if (!c.ok) throw new Error("commit 失败: " + c.error);

  record(db, {
    taskId: id, type: "impl.produced", actor: "coder",
    payload: { diff_stat: diffStat(dir, base), branch, base_sha: base },
  });
  transition(db, id, "verifying", { actor: ctx.workerId, reason: "impl committed" });
}

async function doVerify(db, id, ctx) {
  const t = getTask(db, id);
  const dir = join(WORKTREES, id);
  const base = t.base_sha;
  if (!base || !isGitRepo(dir)) {
    transition(db, id, "implementing", { actor: ctx.workerId, reason: "worktree/base missing" });
    return;
  }

  const cfg = loadRepoConfig(dir);
  const stage = stageForTask(db, t);
  // 阶段闸门交给确定性护栏判：越界改动 / 产出物缺失都算 FAIL，不靠 Verifier 自觉。
  const guards = runGuards({ workdir: dir, base, config: cfg, extra: stage ? { stage: stageGateFor(stage) } : {} });
  const diff = diffPatch(dir, base, 20000);

  // 越界的想法不丢：落进 backlog，等这一阶段签字时由人分流。
  // 直接丢掉的话，agent 下次还会"顺手做"，人也没机会说"这个以后做"。
  const scopeCheck = (guards.checks || []).find((c) => c.id === "stage_scope");
  if (stage && scopeCheck && !scopeCheck.ok) {
    try {
      const outside = (guards.files || []).map((f) => f.path);
      addBacklog(db, stage.project_id, {
        text: "「" + stage.name + "」阶段改了边界外的文件：" + outside.slice(0, 6).join(", ") + "（需要决定是扩边界还是留到下一阶段）",
        stageId: stage.stage_id,
        source: "guard",
        by: "stage_scope",
      });
    } catch { /* backlog 写不进去不该连带把验证搞挂 */ }
  }

  // 越界不是"再试一次"能解决的：边界是签字定的，改边界要人拍板。
  // 这里直接进复议会，省掉一轮 Verifier 的钱（真引擎一次 7 万 token）。
  if (stage && scopeCheck && !scopeCheck.ok) {
    const outside = (guards.files || []).filter((x) => (x.status === "A" || x.status === "M" || x.status === "D") && x.path)
      .map((x) => x.path);
    const d = openDecision(db, stage.project_id, {
      trigger: "scope", stageId: stage.stage_id, by: ctx.workerId,
      evidence: ["越界文件：" + outside.slice(0, 8).join("，"), "阶段边界：" + ((stage.allowedGlobs || []).join("、") || "（未限制）")],
    });
    // 没叫 Verifier，但证据必须落账：人打开任务要能直接看到「哪个文件越界了」，
    // 而不是只看到一句「blocked，去开会」。
    addEvidence(db, id, {
      verify: {
        passed: false, guards: guards.checks, guardsFailed: guards.failed, testCmd: guards.testCmd,
        testCases: guards.testCases || null, baseline: guards.baseline || null,
        testOutputTail: guards.testOutput.slice(-3000), diff: String(diff || "").slice(0, 12000),
        verdict: { verdict: "fail", summary: "阶段边界被改动，已进复议会", raised: outside.slice(0, 6) },
        at: new Date().toISOString(),
      },
      meeting: { decision_id: d.decision_id, trigger: "scope", at: new Date().toISOString() },
    }, "verify.result");
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "等复议会拍板：改动越界（" + outside.slice(0, 3).join("，") + "）" });
    return;
  }

  const res = await callAgent(db, id, { ...ctx, cwd: dir }, {
    role: "verifier",
    prompt: sop.verifierPrompt({ task: t, diff, testOutput: guards.testOutput, guards, memory: memoryDigest(db, t.project_id, { role: "verifier" }) }),
  });

  const v = sop.parseVerdict(res.text) || { verdict: guards.ok ? "pass" : "fail", summary: "未给出结构化结论，按护栏判定", raised: [] };
  const passed = guards.ok && v.verdict === "pass";

  addEvidence(db, id, {
    verify: {
      passed,
      guards: guards.checks,
      guardsFailed: guards.failed,
      testCmd: guards.testCmd,
      testCases: guards.testCases || null,
      baseline: guards.baseline || null,
      testOutputTail: guards.testOutput.slice(-3000),
      diff: String(diff || "").slice(0, 12000),
      verdict: v,
      at: new Date().toISOString(),
    },
  }, "verify.result");

  if (!passed && stage) {
    // 不阻断但要记账的三种情况：回归连挂、体量过大、预算七成。
    // 它们不该让任务停下（停下就是让人当值班员），但必须出现在复议会列表里。
    try {
      const failedIds = (guards.checks || []).filter((c) => !c.ok).map((c) => c.id);
      if (failedIds.includes("no_regression")) {
        const prev = db.prepare("SELECT payload FROM events WHERE task_id=? AND type='verify.result' ORDER BY id DESC LIMIT 1").get(id);
        let prevFailed = [];
        try { prevFailed = (JSON.parse(prev && prev.payload).guardsFailed) || []; } catch { prevFailed = []; }
        if (prevFailed.includes("no_regression")) {
          openDecision(db, stage.project_id, {
            trigger: "baseline", stageId: stage.stage_id, by: ctx.workerId,
            evidence: ["连续两轮 no_regression 失败", "当前挂掉的用例：" + String((guards.baseline && guards.baseline.regressions || []).join("、") || "见测试输出")],
          });
        }
      }
      if ((guards.files || []).length > 8) {
        openDecision(db, stage.project_id, {
          trigger: "size", stageId: stage.stage_id, by: ctx.workerId,
          evidence: ["本次改动 " + (guards.files || []).length + " 个文件：" + (guards.files || []).slice(0, 8).map((x) => x.path).join("，")],
        });
      }
      const ratio = Number(t.spent_tokens || 0) / Math.max(1, Number(t.budget_tokens || 1));
      if (ratio >= 0.7) {
        openDecision(db, stage.project_id, {
          trigger: "budget", stageId: stage.stage_id, by: ctx.workerId,
          evidence: ["已花 " + Math.round(t.spent_tokens || 0) + " / " + (t.budget_tokens || 0) + "（" + Math.round(ratio * 100) + "%）", "剩余 " + Math.max(0, (t.budget_tokens || 0) - (t.spent_tokens || 0))],
        });
      }
    } catch { /* 开会失败不该连带把验证搞挂 */ }
  }

  if (passed) {
    transition(db, id, "reviewing", { actor: ctx.workerId, reason: "verified" });
  } else if (t.attempts >= MAX_ATTEMPTS) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "verify failed: " + guards.failed.join(",") });
  } else if (!(t.plan_md && String(t.plan_md).trim())) {
    // 上一轮走的是快路径、根本没有方案，这轮失败了说明「一次想清」不成立：
    // 回 queued 让规划段真的出一份方案，再带着失败证据重做。
    transition(db, id, "queued", { actor: ctx.workerId, reason: "fast path failed, need a plan: " + guards.failed.join(",") });
  } else {
    transition(db, id, "implementing", { actor: ctx.workerId, reason: "verify failed: " + guards.failed.join(",") });
  }
}

async function doReview(db, id, ctx) {
  const t = getTask(db, id);
  const dir = join(WORKTREES, id);
  const base = t.base_sha;
  const verify = (t.evidence && t.evidence.verify) || {};
  const guards = { checks: verify.guards || [], ok: true, failed: [] };

  // 小改动不再多花一次 agent 调用：护栏 + 独立 Verifier 已经答完「对不对」，
  // 剩下的「要不要合」本来就是人初筛的活。跳过要留痕，否则以后没人知道这里少了一道。
  // 只在第一次尝试跳过：被打回过说明这一版有风险，多一道 reviewer 是省不得的。
  if (t.evidence && t.evidence.size === "small" && t.attempts <= 1) {
    record(db, {
      taskId: id, type: "review.skipped", actor: ctx.workerId,
      payload: { size: "small", reason: (t.evidence.size_reason || "小改动") + "：护栏 + 独立 Verifier + 人初筛已覆盖，不再多调一次 reviewer" },
    }, false);
    addEvidence(db, id, {
      review: { verdict: { verdict: verify.verdict && verify.verdict.verdict || "pass", summary: "已跳过 Agent Reviewer（小改动），结论来自独立 Verifier", raised: [] }, raised: [], diffStat: t.diff_stat, skipped: true, at: new Date().toISOString() },
    }, "review.result");
    transition(db, id, "awaiting_review", { actor: ctx.workerId, reason: "ready for first review (reviewer skipped)" });
    return;
  }

  const diff = base ? diffPatch(dir, base, 12000) : "";
  const res = await callAgent(db, id, { ...ctx, cwd: dir }, {
    role: "reviewer",
    prompt: sop.reviewerPrompt({ task: t, plan: t.plan_md || "", diff, guards, verifier: verify.verdict }),
  });

  const v = sop.parseVerdict(res.text) || { verdict: "pass", summary: "未给出结构化结论", raised: [] };
  addEvidence(db, id, {
    review: { verdict: v, raised: v.raised || [], diffStat: t.diff_stat, at: new Date().toISOString() },
  }, "review.result");
  // 两段评审的第一段：机器 review 之后进「待初筛」，由成员认领；lead 也能直接终审（记 waived）。
  transition(db, id, "awaiting_review", { actor: ctx.workerId, reason: "ready for first review" });
}

/** 上一次 attempt.started 之后没有 impl.produced，说明那次尝试没跑完（通常是崩溃）。 */
function hasInflightAttempt(db, id) {
  const s = db.prepare("SELECT COALESCE(MAX(id),0) AS i FROM events WHERE task_id=? AND type='attempt.started'").get(id).i;
  const c = db.prepare("SELECT COALESCE(MAX(id),0) AS i FROM events WHERE task_id=? AND type='impl.produced'").get(id).i;
  return s > c;
}

/**
 * 阶段交付时自动写记忆：决定、约束、踩坑、接口。
 * 为什么由机器写：这几类事实在账本里本来就有（谁签的字、边界是什么、哪条护栏挂了），
 * 让 agent「总结一下」既花钱又会美化。人可以在界面里再补一条自己的判断。
 */
function recordStageMemory(db, task, stage) {
  try {
    addMemory(db, stage.project_id, {
      kind: "decision",
      text: "阶段「" + stage.name + "」已交付并合并（任务 " + task.id + "，负责人 " + (stage.owner || "未指派") + "）",
      source: "stage " + stage.stage_id, by: "system",
    });
    const globs = stage.allowedGlobs || [];
    if (globs.length) {
      addMemory(db, stage.project_id, {
        kind: "constraint",
        text: "阶段「" + stage.name + "」的边界：" + globs.join("、") + "；下一阶段不要顺手改这些路径之外的东西",
        source: "stage " + stage.stage_id, by: "system",
      });
    }
    const verify = (task.evidence && task.evidence.verify) || {};
    const failed = (verify.guards || []).filter((g) => !g.ok).slice(0, 2);
    for (const g of failed) {
      addMemory(db, stage.project_id, {
        kind: "pitfall",
        text: "「" + stage.name + "」这一关在 " + g.id + " 上翻过车：" + String(g.detail || "").slice(0, 120),
        source: "stage " + stage.stage_id, by: "system",
      });
    }
    if ((stage.artifacts || []).some((a) => /contract|契约|interface|接口/i.test(a))) {
      addMemory(db, stage.project_id, {
        kind: "interface",
        text: "「" + stage.name + "」的契约与产出物：" + (stage.artifacts || []).join("、") + "（接口变更要走复议会）",
        source: "stage " + stage.stage_id, by: "system",
      });
    }
  } catch { /* 记忆写失败不该让已经合并的任务变成失败 */ }
}

async function doMerge(db, id, ctx) {
  const t = getTask(db, id);
  const repo = resolve(ROOT, t.repo);
  const branch = t.branch || ("wb/" + id);
  const dirty = (statusPorcelain(repo) || []).map((e) => e.code + " " + e.path);
  if (dirty.length) {
    const reason = "主仓库有未提交改动，合并会失败：" + dirty.slice(0, 5).join("；") +
      (dirty.length > 5 ? " 等 " + dirty.length + " 处" : "") + "。先提交或清理这些改动，再重试合并。";
    addEvidence(db, id, { merge_error: reason, last_error: reason, at: new Date().toISOString() }, "evidence.patch");
    transition(db, id, "blocked", { actor: ctx.workerId, reason });
    return;
  }
  const r = sh("git", ["-C", repo, "merge", "--no-ff", "-m", "wb: merge " + t.title, branch]);
  if (!r.ok) {
    addEvidence(db, id, { merge_error: String(r.out).slice(-2000) }, "evidence.patch");
    transition(db, id, "awaiting_approval", { actor: ctx.workerId, reason: "merge conflict, needs human" });
    return;
  }
  record(db, { taskId: id, type: "merge.done", actor: ctx.workerId, payload: { sha: headSha(repo) } });
  transition(db, id, "done", { actor: ctx.workerId, reason: "merged" });

  // 阶段的任务合进去了 = 这个阶段的交付物进了主干，阶段收工，项目自动判下一步。
  // 阶段完成是账本里的机械动作，不需要人再点一次"完成"。
  const merged = getTask(db, id);
  const stage = stageForTask(db, merged);
  try {
    const done = completeStageForTask(db, merged, { by: ctx.workerId });
    if (stage && done) recordStageMemory(db, merged, stage);
    const p = advanceProject(db, merged.project_id, { by: ctx.workerId });
    // 阶段都交付了：立刻生成沉淀包（不烧 token），等人签收资产才算项目完成。
    if (p && p.state === "settling") settleProject(db, p.id, { by: ctx.workerId });
  } catch { /* 非阶段任务：没有 project_id，忽略 */ }
}

/** 主泵：认领 -> 跑到暂停点 -> 释放租约。可被 kill -9，重启后从状态机续跑。 */
export async function pump(db, { workerId, provider, once = false, idleMs = 1500, onTask, heartbeat = true, engine = "unknown" } = {}) {
  // 活着要有痕迹：worker 崩了界面得看得出来（见 src/core/liveness.mjs）
  const stopBeat = heartbeat
    ? startHeartbeat(join(ROOT, "data", "worker.json"), { workerId, engine, root: ROOT, version: codeVersion() })
    : null;
  const stalls = new Map();
  try {
    for (;;) {
      reclaimDead(db);
      reclaimExpired(db);
      // 收尾写到一半崩了：重启后补跑（已生成资产的不重复写）。
      settlePending(db, { by: workerId });
      const cand = pickRunnable(db);
      if (!cand) {
        if (once) return null;
        await sleep(idleMs);
        continue;
      }
      // 不认识的状态：宁可停住等人，也不能原地空转。
      // 真实事故：老进程 + 新状态 → runTask 立刻 return → 泵每毫秒重来一次，
      // 2 小时写了 17GB、8600 万条 lease 事件，最后 V8 自己 abort。
      if (!HANDLED_STATES.has(cand.state)) {
        record(db, {
          taskId: cand.id, type: "run.stalled", actor: workerId,
          payload: { state: cand.state, note: "执行器不认识这个状态（多半是内核版本不一致）" },
        }, false);
        forceTransition(db, cand.id, "blocked", {
          actor: workerId,
          reason: "执行器不认识状态 " + cand.state + "：重启内核（cli up）后重新入队",
        });
        process.stderr.write("[worker] 状态 " + cand.state + " 不认识，已把 " + cand.id + " 停到 blocked\n");
        continue;
      }
      if (!acquire(db, cand.id, workerId, 300000)) continue;
      const before = getTask(db, cand.id);
      try {
        const t = await runTask(db, cand.id, { workerId, provider, cwd: ROOT });
        if (onTask && t) onTask(t);
        // 兜底：认领了却什么都没推进（doX 提前 return、状态机写坏），也不能空转。
        const after = getTask(db, cand.id);
        const sig = (x) => x ? x.state + "|" + x.attempts + "|" + x.spent_tokens : "gone";
        if (before && after && sig(before) === sig(after) && HANDLED_STATES.has(after.state)) {
          stalls.set(cand.id, (stalls.get(cand.id) || 0) + 1);
          const n = stalls.get(cand.id);
          if (n >= 3) {
            record(db, { taskId: cand.id, type: "run.stalled", actor: workerId, payload: { state: after.state, rounds: n } }, false);
            forceTransition(db, cand.id, "blocked", { actor: workerId, reason: "连续 " + n + " 轮认领但状态没有推进（停在 " + after.state + "）" });
            stalls.delete(cand.id);
          } else {
            await sleep(250 * n);
          }
        } else {
          stalls.delete(cand.id);
        }
      } finally {
        release(db, cand.id, workerId, "yield");
      }
      if (once) return cand.id;
    }
  } finally {
    if (stopBeat) stopBeat();
  }
}

async function main() {
  const db = openDb();
  const workerId = process.env.WB_WORKER_ID || (hostname() + ":" + process.pid);
  const engineName = process.env.WB_ENGINE || "mock";
  const provider = await getProvider(engineName);
  process.stdout.write("[worker] " + workerId + " engine=" + engineName + " root=" + ROOT + "\n");
  await pump(db, {
    workerId, provider, engine: engineName,
    onTask: (t) => process.stdout.write("[worker] " + t.id + " -> " + t.state + " attempts=" + t.attempts + "\n"),
  });
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("worker.mjs");
if (invokedDirectly) {
  main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
}