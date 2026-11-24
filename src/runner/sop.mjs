/**
 * 角色 SOP。三条铁律写在提示词里，也写在代码里（不传验证者的 coder 上下文）：
 * 1. Verifier 必须是独立实例，只拿 diff + 真实测试输出，不拿 Coder 的推理。
 * 2. Agent Reviewer 只上抛证据裁决不了的事。
 * 3. 人只回答"要不要合"。
 */

const RULES = [
  "你在一个自动化的团队编程工作台里工作，人是最终 reviewer。",
  "禁止修改或删除已存在的测试文件来让测试通过；那会被判定为 test_weakened 并退回。",
  "禁止用 assert(true) / 空断言 / 被跳过的测试制造伪绿。",
  "只做被分配给你的那一个切片，不要越界重构。",
  "结束时必须输出一个 JSON 代码块，用三个波浪线包围，语言标 json，格式：",
  "~~~json",
  '{"verdict":"pass|fail","summary":"一句话","raised":["需要人裁决的点"]}',
  "~~~",
].join("\n");

export function leadPrompt(task, repoPath) {
  return [RULES, "",
    "## 角色：Lead（拆解者，不写码）",
    "任务标题：" + task.title,
    "目标仓库：" + task.repo + (repoPath ? "（绝对路径 " + repoPath + "，只读参考）" : ""),
    "你现在的工作目录是临时目录：不要在这里写实现，也不要写仓库；只输出拆解结果。",
    "",
    "把任务拆成 1-3 个可独立验证的切片，按依赖顺序排列。",
    "每个切片必须能用一条测试命令判定成败。",
    "只输出切片清单（编号 + 一句话 + 验收方式）。",
  ].join("\n");
}

export function architectPrompt(task, slices, repoPath) {
  return [RULES, "",
    "## 角色：Architect（定边界，不写码）",
    "任务：" + task.title,
    (repoPath ? "目标仓库（只读参考）：" + repoPath : ""),
    "当前目录是临时目录：不要写实现。",
    "", "切片清单：", slices, "",
    "产出一页以内的技术方案，必须包含：模块边界、对外接口签名、失败模式、回滚方式。",
    "不确定的地方标 [待确认]，不要编造。",
  ].join("\n");
}

export function coderPrompt(task, plan, attempt, feedback, memory = "") {
  const lines = [RULES, "",
    "## 角色：Coder（只实现，不自评）",
    "任务：" + task.title,
    "第 " + (attempt + 1) + " 次尝试。"];
  if (memory && String(memory).trim()) {
    lines.push("", String(memory).trim());
  }
  if (plan && plan.trim()) {
    lines.push("", "## 方案", plan);
  } else {
    // 快路径：没有上游拆解。这时 coder 自己就是方案作者，但必须一次想清楚，别来回试探。
    lines.push(
      "",
      "## 方案（没有上游拆解：这是一个单文件小改动）",
      "先读需要改的文件和它的测试，想清楚接口形状再动手：",
      "- 一次写入完整实现，不要先写半成品再回来补；",
      "- 测试文件只在缺失时新建，已存在就补用例，绝不删改既有断言；",
      "- 测试最多跑到绿一次，不要反复重跑。",
    );
  }
  lines.push(
    "",
    "在仓库里完成实现，并补上覆盖该实现的测试。改完自测通过即可。",
    "不要修改既有测试文件来迁就实现。",
    // 真事：coder 顺着 worktree 的 .git 找到主仓库，把测试写到了主仓库里，
    // 于是主仓库变脏、merge 被 git 拒掉，整轮验证作废。边界要写在 prompt 里。
    "只改当前工作目录（你自己所在的仓库副本）里的文件；主仓库和其他目录都不要写入，",
    "也不要对它们执行 git checkout / reset / stash / clean。",
  );
  // 重试必须带上"上一轮为什么没过"，否则就是无脑重试：同样的错会被原样再犯一次。
  if (feedback) lines.push("", "## 上一轮为什么没过（这次必须改掉）", String(feedback));
  return lines.join("\n");
}

/** 刻意不传 plan 里的 Coder 过程，只给 diff 与真实命令输出。 */
export function verifierPrompt({ task, diff, testOutput, guards, memory = "" }) {
  const mem = memory && String(memory).trim() ? ["", String(memory).trim()] : [];
  return [RULES, "",
    "## 角色：Verifier（独立判卷，与 Coder 不同实例）",
    "任务：" + task.title,
    ...mem,
    "", "## 变更 diff", diff.slice(0, 20000),
    "", "## 测试命令的真实输出", testOutput.slice(0, 8000),
    "", "## 机器护栏结论", JSON.stringify(guards.checks, null, 2),
    "",
    "判断这份实现是否真的解决了任务，而不是只让测试变绿。",
    "若护栏已判 fail，你必须判 fail 并说明是哪一条。",
  ].join("\n");
}

/**
 * Reviewer 复用 Verifier 已经算出来的证据（护栏清单 + 裁决 + 上抛点），
 * 不再把原始测试输出整段重贴：那一份几千字，重贴一次就是白烧上下文，
 * 而且它要回答的只有「证据裁决不了什么」，不是「测试过没过」——后者 Verifier 已经答了。
 */
export function reviewerPrompt({ task, plan, diff, guards, verifier, memory = "" }) {
  const v = verifier || {};
  const lines = [RULES, "",
    "## 角色：Agent Reviewer（只上抛，不做最终决定）",
    "任务：" + task.title,
    ...(memory && String(memory).trim() ? ["", String(memory).trim()] : []),
    "", "## 方案", String(plan || "（快路径：无上游拆解）").slice(0, 4000),
    "", "## 变更 diff", String(diff || "").slice(0, 12000),
    "", "## 机器护栏", JSON.stringify(guards.checks, null, 2),
    "", "## 独立 Verifier 的结论（复用，不要重复判定）",
    "verdict: " + (v.verdict || "?") + "；summary: " + (v.summary || "（无）"),
  ];
  if (Array.isArray(v.raised) && v.raised.length) lines.push("它已经上抛的点：" + v.raised.join("；"));
  lines.push(
    "",
    "测试过没过是 Verifier 的事；你只回答「这个改动有没有证据之外的问题」（越界、隐患、和任务不一致）。",
    "只有当证据裁决不了时，才把问题放进 raised 交给人类。",
    "如果证据足够、实现明显正确，verdict 给 pass 且 raised 为空。",
  );
  return lines.join("\n");
}

/** 从 agent 输出里抠最后一个 JSON verdict 块（支持 ~~~ 与 ``` 两种围栏）。 */
export function parseVerdict(text) {
  const tick = String.fromCharCode(96).repeat(3);
  const re = new RegExp("(?:" + tick + "|~{3})json\\s*([\\s\\S]*?)(?:" + tick + "|~{3})", "g");
  const found = [...String(text).matchAll(re)];
  for (let i = found.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(found[i][1]);
      if (v && typeof v === "object") return v;
    } catch { /* 继续找上一个 */ }
  }
  return null;
}