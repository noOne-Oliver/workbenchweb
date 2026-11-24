import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../../core/db.mjs";

/**
 * 确定性「按阶段产出」provider —— 不联网、不烧钱，专门用来演示/测试阶段链。
 *
 * 它和 mock.mjs 的区别：mock 演的是「一次性任务 + 伪绿」，这个演的是「阶段链」——
 * 每个阶段只写自己 allowedGlobs 里的东西（所以阶段闸门能真的放行），
 * 需要产出物文档的阶段就把文档落到仓库里（所以 stage_artifacts 能真的通过）。
 * 想演「agent 越界」时把 behave 设成 "sloppy"（或 WB_STAGE_BEHAVE=sloppy），
 * 它会在设计阶段顺手改实现，让 stage_scope 打回。
 */
const TICK = String.fromCharCode(96).repeat(3);

function verdict(summary) {
  return "结论：\n" + TICK + "json\n" +
    JSON.stringify({ verdict: "pass", summary, raised: [] }) + "\n" + TICK + "\n";
}

/** 这个任务挂在哪个阶段上：阶段名决定写哪些文件。 */
function stageName(db, task) {
  if (!task || !task.stage_id) return null;
  try {
    const row = db().prepare("SELECT name FROM stages WHERE stage_id = ?").get(task.stage_id);
    return row ? row.name : null;
  } catch {
    return null;
  }
}

export default async function createStage({ db = null, behave = null } = {}) {
  const mode = behave || process.env.WB_STAGE_BEHAVE || "good";
  const handle = () => {
    if (!db) db = openDb();
    return db;
  };
  const write = (cwd, rel, body) => {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  return {
    name: "stage",
    async run({ role, cwd, task }) {
      if (role === "verifier" || role === "reviewer") {
        return { ok: true, text: verdict("改动与阶段目标一致，测试真实通过"), tokens: 900 };
      }
      if (mode === "sloppy") {
        // 越界：设计阶段只许写 docs/**，这里故意去改实现。
        write(cwd, "src/calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n\nexport const HACKED = true;\n");
        return { ok: true, text: "顺手把实现也改了", tokens: 800 };
      }

      const name = stageName(handle, task) || "实现";
      const title = (task && task.title) || "这个功能";

      if (name === "设计") {
        write(cwd, "docs/design.md", [
          "# " + title + " 设计",
          "",
          "## 流程",
          "",
          "1. 输入 -> 2. 计算 -> 3. 输出",
          "",
          "## 组件",
          "",
          "- src/calc.mjs：纯函数，不做 IO",
          "",
        ].join("\n"));
        write(cwd, "docs/design.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90">' +
          '<rect x="8" y="28" width="80" height="34" rx="6" fill="none" stroke="#3b82f6"/>' +
          '<text x="20" y="50" font-size="13">输入</text>' +
          '<path d="M92 45 H210" stroke="#94a3b8" stroke-width="1.5"/>' +
          '<rect x="214" y="28" width="80" height="34" rx="6" fill="none" stroke="#3b82f6"/>' +
          '<text x="226" y="50" font-size="13">输出</text></svg>\n');
        return { ok: true, text: "设计与流程图已出", tokens: 900 };
      }

      if (name === "契约") {
        write(cwd, "docs/contract.md", [
          "# 契约",
          "",
          "| 函数 | 签名 | 行为 |",
          "| --- | --- | --- |",
          "| add | (a,b) | 相加 |",
          "| mul | (a,b) | 相乘 |",
          "| div | (a,b) | 相除，b=0 抛错 |",
          "",
          "边界：只改 src/calc.mjs 与 test/calc.test.mjs。",
          "",
        ].join("\n"));
        return { ok: true, text: "契约已定", tokens: 900 };
      }

      if (name === "实现") {
        write(cwd, "src/calc.mjs", [
          "export function add(a, b) { return a + b; }",
          "export function mul(a, b) { return a * b; }",
          "export function div(a, b) {",
          '  if (b === 0) throw new Error("除零错误");',
          "  return a / b;",
          "}",
          "",
        ].join("\n"));
        write(cwd, "test/calc.test.mjs", [
          'import { test } from "node:test";',
          'import assert from "node:assert";',
          'import { add, mul, div } from "../src/calc.mjs";',
          "",
          'test("加法", () => { assert.equal(add(2, 3), 5); });',
          'test("乘法", () => { assert.equal(mul(3, 4), 12); });',
          'test("除法", () => { assert.equal(div(8, 2), 4); });',
          'test("除零报错", () => { assert.throws(() => div(1, 0), /除零/); });',
          "",
        ].join("\n"));
        return { ok: true, text: "按契约实现完毕", tokens: 900 };
      }

      if (name === "合并") {
        write(cwd, "docs/RELEASE.md", "# 交付说明\n\n- 新增 mul / div（含除零报错）\n- 测试 4 条全绿\n");
        return { ok: true, text: "合成可合状态，附交付说明", tokens: 900 };
      }

      return { ok: true, text: "无操作", tokens: 100 };
    },
  };
}
