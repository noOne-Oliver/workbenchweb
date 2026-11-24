import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { matchesAny, checkScope, globToRegExp } from "../src/core/glob.mjs";
import { WORKFLOWS, workflowFor, signatureGroupOf, agentForRole } from "../src/core/workflows.mjs";
import {
  createProject, getProject, meetProject, signStages, startStage, backlogOf, decideBacklog,
  completeStageForTask, stageGateFor,
} from "../src/core/stages.mjs";
import { artifactExists, runGuards } from "../src/runner/guards.mjs";

const freshDb = () => openDb(resolve(mkdtempSync(join(tmpdir(), "wb-stages-")), "t.db"));

/** 建项目 + 开会 + 分流掉发散项 —— 到「可以签字」这一步。 */
async function ready(db, opts = {}) {
  const p = createProject(db, { title: opts.title || "给 calc 加乘法", repo: "repo", lane: opts.lane || "feature", owner: "alice" });
  const met = await meetProject(db, p.id, { repoFiles: opts.repoFiles || [] });
  for (const b of backlogOf(db, p.id).filter((x) => x.status === "open")) {
    decideBacklog(db, p.id, b.id, { status: "next", by: "lead0" });
  }
  return { p: getProject(db, p.id), met };
}

test("glob：** 跨目录，* 不跨目录，空清单表示不限制", () => {
  assert.equal(globToRegExp("docs/**").test("docs/a/b.md"), true);
  assert.equal(globToRegExp("docs/**").test("src/a.mjs"), false);
  assert.equal(globToRegExp("src/*.mjs").test("src/a.mjs"), true);
  assert.equal(globToRegExp("src/*.mjs").test("src/deep/a.mjs"), false);
  assert.equal(matchesAny("package.json", ["package.json"]), true);
  assert.equal(checkScope(["src/a.mjs", "docs/b.md"], ["docs/**"]).ok, false);
  assert.equal(checkScope(["docs/b.md"], ["docs/**"]).ok, true);
  assert.equal(checkScope(["src/a.mjs"], []).ok, true, "空边界 = 不限制");
});

test("workflow 模板：功能 4 阶段签 2 次，杂活 1 阶段不开会，角色都能映射到 agent", () => {
  const f = WORKFLOWS.feature;
  assert.deepEqual(f.stages.map((s) => s.name), ["设计", "契约", "实现", "合并"]);
  assert.equal(new Set(f.stages.map((s) => signatureGroupOf(f, s.name))).size, 2);
  assert.equal(f.meeting, true);
  assert.equal(WORKFLOWS.chore.meeting, false);
  assert.equal(WORKFLOWS.chore.stages.length, 1);
  assert.equal(workflowFor("chore").stages[0].name, "实现");
  assert.equal(agentForRole("designer"), "architect");
  assert.equal(agentForRole("coder"), "coder");
  for (const lane of Object.keys(WORKFLOWS)) {
    for (const s of WORKFLOWS[lane].stages) {
      assert.ok(agentForRole(s.role), "阶段「" + s.name + "」的角色 " + s.role + " 没有对应 agent");
      assert.ok(Array.isArray(s.allowedGlobs), "边界就算不限制也要显式写空数组，不能漏");
    }
  }
  // 要交文档的阶段必须有机械可查的产出物；实现/合并的交付物是 diff + 测试，由别的护栏管。
  for (const s of WORKFLOWS.feature.stages.filter((x) => ["设计", "契约"].includes(x.name))) {
    assert.ok(s.artifacts.length, "阶段「" + s.name + "」没有产出物就没法机械验收");
  }
});

test("预备会：机器开完就等人，提案里有阶段/签字次数/人工分钟数/发散项", async () => {
  const db = freshDb();
  const { p, met } = await ready(db, { title: "给 calc 加乘法与除法" });
  assert.equal(p.state, "proposed", "开会只是提案，签字才进入 running");
  assert.equal(p.stages.length, 4);
  assert.ok(met.human_minutes <= 10);
  assert.ok(met.backlog.length >= 1, "功能 lane 的会必须摆出至少一件要人拍板的事");
  assert.equal(p.stages.every((s) => s.state === "proposed"), true);
  assert.ok(p.stages[0].goal.includes("给 calc 加乘法与除法"), "目标里的 {title} 要被填掉");
});

test("签字闸门：顺序、组内齐全、发散项必须先分流、签过不许重签", async () => {
  const db = freshDb();
  const p = createProject(db, { title: "给 calc 加乘法", repo: "repo", lane: "feature", owner: "alice" });
  await meetProject(db, p.id, { repoFiles: [] });

  assert.throws(() => signStages(db, p.id, { group: "A", by: "lead0" }), /分流/, "有发散项没分流不能签");
  for (const b of backlogOf(db, p.id).filter((x) => x.status === "open")) {
    decideBacklog(db, p.id, b.id, { status: "drop", by: "lead0" });
  }

  assert.throws(() => signStages(db, p.id, { group: "B", by: "lead0" }), /交付/, "B 组要等 A 组交付完");
  const a = signStages(db, p.id, { group: "A", by: "lead0", note: "目标对" });
  assert.equal(a.state, "running");
  assert.equal(a.stages.filter((s) => s.state === "approved").length, 2);
  assert.throws(() => signStages(db, p.id, { group: "A", by: "lead0" }), /签/, "同一组不能签两次");
  await assert.rejects(() => meetProject(db, p.id, { repoFiles: [] }), /复议会/, "签完不能重开预备会改目标");
});

test("开工闸门：没签字不能开工，跳关不能开工，开工后阶段挂到任务上", async () => {
  const db = freshDb();
  const { p } = await ready(db);
  assert.throws(() => startStage(db, p.id, "设计", { by: "alice" }), /还没签字/);

  signStages(db, p.id, { group: "A", by: "lead0" });
  assert.throws(() => startStage(db, p.id, "实现", { by: "alice" }), /还没签字/);
  const out = startStage(db, p.id, "设计", { by: "alice" });
  assert.equal(out.task.stage_id, p.stages[0].stage_id);
  assert.equal(out.task.project_id, p.id);
  assert.equal(getProject(db, p.id).stages[0].state, "running");
  assert.throws(() => startStage(db, p.id, "设计", { by: "alice" }), /已经有任务/);
});

test("阶段闸门 stage_scope：改到边界外必须 FAIL 并点名文件", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-scope-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "src/calc.mjs"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // 越界：设计阶段只许 docs/**，却改了 src/calc.mjs
  writeFileSync(join(repo, "src/calc.mjs"), "export const a = 2;\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "escape"], { cwd: repo });

  const stage = { stage_id: "s1", name: "设计", allowedGlobs: ["docs/**"], artifacts: [] };
  const r = runGuards({ workdir: repo, base, config: { testCmd: [process.execPath, "--test"] }, extra: { stage } });
  const scope = r.checks.find((c) => c.id === "stage_scope");
  assert.ok(scope, "护栏里必须有 stage_scope");
  assert.equal(scope.ok, false);
  assert.match(scope.detail, /src\/calc\.mjs/);
  assert.equal(r.ok, false);

  const gate = stageGateFor({ stage_id: "s1", name: "设计", goal: "画图", role: "designer", skill: "diagram", artifacts: ["docs/design.md"], allowedGlobs: ["docs/**"], nonGoals: ["不改实现"] });
  assert.deepEqual(gate.allowedGlobs, ["docs/**"]);
  assert.equal(gate.nonGoals[0], "不改实现");
});

test("阶段闸门 stage_artifacts：产出物缺失即 FAIL，通配目录也算数", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-art-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "src/a.mjs"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  assert.equal(artifactExists(repo, "docs/design.md"), false);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/design.svg"), "<svg/>\n");
  assert.equal(artifactExists(repo, "docs/design.svg"), true);
  assert.equal(artifactExists(repo, "docs/*.svg"), true, "通配要能命中目录里的文件");

  const stage = { stage_id: "s1", name: "设计", allowedGlobs: ["docs/**"], artifacts: ["docs/design.md", "docs/design.svg"] };
  const r = runGuards({ workdir: repo, base, config: { testCmd: [process.execPath, "--test"] }, extra: { stage } });
  const art = r.checks.find((c) => c.id === "stage_artifacts");
  assert.ok(art);
  assert.equal(art.ok, false);
  assert.match(art.detail, /docs\/design\.md/);
});

test("阶段收尾：合并完自动标 done，全部 done 后项目自己收口", async () => {
  const db = freshDb();
  const { p } = await ready(db, { lane: "chore", title: "补一条测试" });
  signStages(db, p.id, { group: "A", by: "lead0" });
  const out = startStage(db, p.id, 1, { by: "alice" });
  const stage = getProject(db, p.id).stages[0];
  completeStageForTask(db, { ...out.task, stage_id: stage.stage_id }, { by: "worker" });
  const after = getProject(db, p.id);
  assert.equal(after.stages[0].state, "done");
  assert.equal(after.state, "done", "单阶段项目交付完就该收口，不需要人再点完成");
});
