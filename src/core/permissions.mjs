import { ROLES } from "./users.mjs";

/**
 * 权限矩阵。所有动作在服务端判一次，前端只是不显示按钮——能绕过 UI 的才叫身份。
 * 返回 { ok, error?, self_approved? }，错误文案直接给人看。
 */
export function can(user, action, task = null, project = null) {
  if (!user) return { ok: false, error: "未登录" };
  if (!ROLES.includes(user.role)) return { ok: false, error: "角色未知: " + user.role };
  if (action === "view") return { ok: true };
  if (user.role === "viewer") return { ok: false, error: "只读账号不能做这个（viewer）" };

  const lead = user.role === "lead";
  switch (action) {
    case "create_task":
    case "claim_review":
      if (action === "claim_review") {
        if (!task) return { ok: false, error: "任务不存在" };
        if (task.state !== "awaiting_review") return { ok: false, error: "任务当前状态是 " + task.state + "，不在待初筛" };
        const held = task.reviewer && task.reviewer !== user.name &&
          Number(task.review_lease_expires_at || 0) > Date.now();
        if (held) return { ok: false, error: "已被 " + task.reviewer + " 领取，稍后再试（30 分钟自动释放）" };
      }
      return { ok: true };

    case "pass_review": {
      if (!task) return { ok: false, error: "任务不存在" };
      if (task.state !== "awaiting_review") return { ok: false, error: "任务当前状态是 " + task.state + "，不在待初筛" };
      if (lead) return { ok: true, waived: task.reviewer !== user.name };
      if (task.reviewer !== user.name) return { ok: false, error: "先领取再初筛（当前领取人：" + (task.reviewer || "无") + "）" };
      return { ok: true };
    }

    case "request_changes": {
      if (!task) return { ok: false, error: "任务不存在" };
      if (!["awaiting_review", "awaiting_approval"].includes(task.state)) {
        return { ok: false, error: "任务当前状态是 " + task.state + "，不能打回" };
      }
      if (lead || task.reviewer === user.name) return { ok: true };
      return { ok: false, error: "只有领取初筛的人或 lead 能打回" };
    }

    case "approve": {
      if (!task) return { ok: false, error: "任务不存在" };
      if (!lead) return { ok: false, error: "只有 lead 能批准合并（member 的权限到初筛为止）" };
      if (task.state !== "awaiting_approval") return { ok: false, error: "任务当前状态是 " + task.state + "，不在待批准" };
      // 自己提交自己批：允许，但要留理由，账本里标 self_approved，统计能看见。
      if (task.owner === user.name) return { ok: true, self_approved: true };
      return { ok: true };
    }

    case "release_review": {
      if (!task) return { ok: false, error: "任务不存在" };
      if (lead || task.reviewer === user.name) return { ok: true };
      return { ok: false, error: "只有领取人自己（或 lead）能释放" };
    }

    case "cancel_task": {
      if (!task) return { ok: false, error: "任务不存在" };
      if (["done"].includes(task.state)) return { ok: false, error: "已完成的任务不能取消" };
      if (lead || task.owner === user.name) return { ok: true };
      return { ok: false, error: "只能取消自己提交的任务" };
    }

    case "create_project":
    case "meet_project":
    case "decide_backlog":
    case "add_memory":
      return { ok: true };

    // 分发：lead 可以把阶段指派给任何人；项目 owner 只能指派自己的项目。
    case "assign_stage_owner": {
      if (lead) return { ok: true };
      if (project && project.owner === user.name) return { ok: true };
      return { ok: false, error: "只有 lead 或项目发起人能调整阶段负责人" };
    }

    // 拍板必须落在一个人头上。lead 拍，账本记名字；member 可以提意见（backlog）但不能拍板。
    case "resolve_decision":
      return lead ? { ok: true } : { ok: false, error: "只有 lead 能在复议会上拍板" };

    // 资产入库是第 3 次签字：只在真有可复用资产时发生。
    case "settle_assets":
      return lead ? { ok: true } : { ok: false, error: "只有 lead 能签收资产" };

    case "start_stage": {
      if (!task) return { ok: true };
      return { ok: true };
    }

    // 签字 = 为「这一组阶段的目标与边界」背书，且默认不改内容。
    // 只有 lead 能签：成员可以提意见（backlog / 打回），但背书责任不在成员身上。
    case "sign_stage":
      return lead ? { ok: true } : { ok: false, error: "只有 lead 能给阶段签字（成员可以提 backlog 或打回）" };

    case "set_budget":
    case "manage_users":
      return lead ? { ok: true } : { ok: false, error: "只有 lead 可以" + (action === "set_budget" ? "改预算" : "管理成员") };

    default:
      return { ok: false, error: "未知动作: " + action };
  }
}
