/**
 * Workflow 模板 —— 「一条 workflow 对应要做的事 + 该由哪个角色做」。
 *
 * 这是数据，不是代码分支：阶段名、目标、产出物、边界、角色、专家包都写在这里。
 * 加一条 lane 或改一个阶段的边界，改这张表就够，不用改执行器。
 *
 * 角色之所以写「人类角色」而不是 agent 名字：这些位置现在由人占着，之后由对应的
 * Agent 代替（AGENT_FOR_ROLE 就是那个替换点）。
 */

/** 人类角色 -> 实际执行它的 agent。替换点只有这一处。 */
export const AGENT_FOR_ROLE = {
  designer: "architect",
  architect: "architect",
  coder: "coder",
  integrator: "coder",
};

export function agentForRole(role) {
  return AGENT_FOR_ROLE[role] || "coder";
}

export const WORKFLOWS = {
  feature: {
    id: "feature",
    label: "功能开发",
    meeting: true,
    // 2 次签字 / 功能：设计+契约一次，实现+合并一次。再多就是让人当橡皮章。
    signatureGroups: { A: ["设计", "契约"], B: ["实现", "合并"] },
    stages: [
      {
        name: "设计",
        role: "designer",
        skill: "diagram-expert",
        goal: "把「{title}」画成一张能指着讨论的设计图（流程 + 组件边界），不碰任何代码",
        artifacts: ["docs/design.md", "docs/design.svg"],
        allowedGlobs: ["docs/**", "*.md"],
        nonGoals: ["不写实现", "不动 src/**", "不引新依赖", "不扩需求"],
      },
      {
        name: "契约",
        role: "architect",
        skill: "api-contract",
        goal: "把设计图翻译成可执行的契约：接口签名、数据结构、文件边界、切片清单",
        artifacts: ["docs/contract.md"],
        allowedGlobs: ["docs/**", "*.md"],
        nonGoals: ["不改实现", "不引新依赖", "不扩需求"],
      },
      {
        name: "实现",
        role: "coder",
        skill: "test-first",
        goal: "按 docs/contract.md 逐条实现切片；契约要改就停下来走复议会",
        artifacts: [],
        allowedGlobs: ["src/**", "lib/**", "app/**", "test/**", "tests/**", "package.json", "*.md"],
        nonGoals: ["不重构契约外的文件", "不加新依赖", "不改契约"],
      },
      {
        name: "合并",
        role: "integrator",
        skill: "merge-proof",
        goal: "把实现整理成可合状态并产出证据包：测试全绿、无回归、diff 与契约一致",
        artifacts: [],
        allowedGlobs: ["**"],
        nonGoals: ["不新增功能", "不改契约"],
      },
    ],
  },
  chore: {
    id: "chore",
    label: "杂活 / 维护",
    // 杂活绝不开会：开会成本比活本身贵。走已有的 small 快路径（两次调用）。
    meeting: false,
    signatureGroups: { A: ["实现"] },
    stages: [
      {
        name: "实现",
        role: "coder",
        skill: "small-diff",
        goal: "做掉「{title}」，改动尽量小，测试照常跑",
        artifacts: [],
        allowedGlobs: ["**"],
        nonGoals: ["不扩范围", "不顺手重构"],
      },
    ],
  },
};

export function workflowFor(lane) {
  return WORKFLOWS[lane === "chore" ? "chore" : "feature"];
}

/** 这个阶段属于哪个签字组（找不到返回 null，表示配置写坏了）。 */
export function signatureGroupOf(wf, stageName) {
  for (const [g, names] of Object.entries(wf.signatureGroups)) {
    if (names.includes(stageName)) return g;
  }
  return null;
}

export function stageNames(wf) {
  return wf.stages.map((s) => s.name);
}