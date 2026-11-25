import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export function sh(cmd, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(cmd, args, {
      cwd: o.cwd, encoding: "utf8", timeout: o.timeout || 180000,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
      ...(o.env ? { env: o.env } : {}),
    });
    return { ok: true, out: out || "", code: 0 };
  } catch (e) {
    const out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    return { ok: false, out, code: e && e.status != null ? e.status : -1 };
  }
}

export function isGitRepo(dir) {
  return sh("git", ["-C", dir, "rev-parse", "--git-dir"]).ok;
}

export function headSha(dir) {
  const r = sh("git", ["-C", dir, "rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

/** 幂等：已存在就直接复用（崩溃恢复靠这条）。 */
export function ensureWorktree({ repo, dir, branch, base }) {
  if (existsSync(join(dir, ".git"))) return { ok: true, created: false, dir };
  const r = sh("git", ["-C", repo, "worktree", "add", "-B", branch, dir, base]);
  if (!r.ok) return { ok: false, error: r.out, dir };
  return { ok: true, created: true, dir };
}

/**
 * 重试前把 worktree 拉回基线。
 * 不这么做的话，第二次尝试看到的还是上一次已经写好的代码 —— coder 会"发现活已经干完了"，
 * 产出与上一轮逐字节相同的 diff，护栏照样不过，白烧一整轮 token（真实基准里就是这么翻车的）。
 */
export function resetToBase(dir, base) {
  const r = sh("git", ["-C", dir, "reset", "--hard", base]);
  if (!r.ok) return { ok: false, error: r.out };
  const c = sh("git", ["-C", dir, "clean", "-fdq"]);
  return { ok: c.ok, error: c.ok ? "" : c.out };
}

export function removeWorktree({ repo, dir }) {
  sh("git", ["-C", repo, "worktree", "remove", "--force", dir]);
  if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// 服务器/CI 上往往没有全局 git identity，不显式指定的话第一条提交就失败
// （报 Author identity unknown）。agent 的提交统一署名 Workbench，不冒用机器主人。
export const GIT_ID_ARGS = ["-c", "user.name=Workbench", "-c", "user.email=workbench@local"];

export function commitAll(dir, message) {
  sh("git", ["-C", dir, "add", "-A"]);
  const r = sh("git", ["-C", dir, ...GIT_ID_ARGS, "commit", "-m", message, "--no-verify"]);
  if (r.ok) return { ok: true, sha: headSha(dir) };
  if (/nothing to commit|no changes added/i.test(r.out)) return { ok: true, sha: headSha(dir), empty: true };
  return { ok: false, error: r.out };
}

export function diffStat(dir, base) {
  const r = sh("git", ["-C", dir, "diff", "--shortstat", base + "..HEAD"]);
  return r.ok ? r.out.trim() : "";
}

export function diffPatch(dir, base, maxChars) {
  const r = sh("git", ["-C", dir, "diff", base + "..HEAD"]);
  return r.ok ? r.out.slice(0, maxChars || 40000) : "";
}
/**
 * 主仓库的工作区状态（含未跟踪文件）。合并前必须干净 —— 脏的主仓库会拒绝 merge，
 * 而那句 "local changes would be overwritten" 对人毫无意义。
 */
export function statusPorcelain(dir) {
  const r = sh("git", ["-C", dir, "status", "--porcelain", "-z"]);
  if (!r.ok) return null;
  const parts = r.out.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw || raw.length < 4) continue;
    const code = raw.slice(0, 2);
    const path = raw.slice(3);
    entries.push({ code, path });
    if (code[0] === "R" || code[0] === "C") i++; // 改名/复制：下一个是源路径
  }
  return entries;
}

/** 两次状态之间「这次才变脏」的路径：别人的改动不能算在 coder 头上，更不能被顺手清掉。 */
export function newlyDirty(before, after) {
  if (!after) return [];
  const seen = new Map((before || []).map((e) => [e.path, e.code]));
  return after.filter((e) => seen.get(e.path) !== e.code).map((e) => e.path);
}

/** 把指定路径还原到 HEAD：跟踪文件 checkout 回来，未跟踪的新文件删掉。 */
export function restorePaths(dir, paths) {
  if (!paths.length) return { tracked: [], untracked: [] };
  const tracked = [];
  const untracked = [];
  for (const p of paths) {
    const known = sh("git", ["-C", dir, "ls-files", "--error-unmatch", "--", p]);
    (known.ok ? tracked : untracked).push(p);
  }
  if (tracked.length) sh("git", ["-C", dir, "checkout", "--", ...tracked]);
  if (untracked.length) sh("git", ["-C", dir, "clean", "-fdq", "--", ...untracked]);
  return { tracked, untracked };
}