import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实 CI 撞到的事：Linux runner 没有全局 git identity，worker 第一条提交就报
// Author identity unknown，任务在 implementing 里反复回队列。提交必须自带署名。
test("没有全局 git identity 时，agent 提交仍能成功且署名 Workbench", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-gitid-"));
  const repo = join(root, "repo");
  const empty = join(root, "empty-gitconfig");
  writeFileSync(empty, "");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "keep.txt"), "x");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  writeFileSync(join(repo, "agent.txt"), "agent\n");

  const saved = {};
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  for (const k of keys) { saved[k] = process.env[k]; }
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_SYSTEM = empty;
  for (const k of keys.slice(2)) delete process.env[k];
  try {
    const { commitAll } = await import("../src/runner/worktree.mjs");
    const r = commitAll(repo, "wb: agent change");
    assert.equal(r.ok, true, "提交失败：" + r.error);
    const who = execFileSync("git", ["-C", repo, "log", "-1", "--format=%an <%ae>"], { encoding: "utf8" }).trim();
    assert.equal(who, "Workbench <workbench@local>");
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(root, { recursive: true, force: true });
  }
});