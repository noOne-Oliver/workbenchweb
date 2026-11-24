import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * 确定性 provider：不联网、不烧钱，用来验证账本/调度/护栏本身。
 * 默认场景 fakegreen：第一次故意交一个"伪绿"实现（改既有测试 + 空断言），
 * 用来证明护栏真的能把它打回去，而不是自己给自己判卷。
 */
function scenario() {
  return process.env.WB_MOCK_SCENARIO || "fakegreen";
}

function write(workdir, rel, content) {
  const p = join(workdir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function verdict(v, summary, raised) {
  const tick = String.fromCharCode(96).repeat(3);
  return "完成。\n\n" + tick + "json\n" +
    JSON.stringify({ verdict: v, summary, raised: raised || [] }, null, 2) +
    "\n" + tick + "\n";
}

const GOOD_IMPL = [
  "export function calc(a, b, op) {",
  "  if (op === '+') return a + b;",
  "  if (op === '-') return a - b;",
  "  if (op === '*') return a * b;",
  "  if (op === '/') return a / b;",
  "  throw new Error('unknown op: ' + op);",
  "}",
  "",
].join("\n");

const GOOD_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert';",
  "import { calc } from '../src/calc.mjs';",
  "",
  "test('add', () => assert.equal(calc(2, 3, '+'), 5));",
  "test('sub', () => assert.equal(calc(5, 3, '-'), 2));",
  "test('mul', () => assert.equal(calc(2, 3, '*'), 6));",
  "test('div', () => assert.equal(calc(6, 3, '/'), 2));",
  "test('unknown op throws', () => assert.throws(() => calc(1, 2, '?'), /unknown op/));",
  "",
].join("\n");

const FAKE_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert';",
  "",
  // 伪绿的典型形态：用例还在、断言没了。这里刻意不写断言，护栏要靠
  // 用例/断言计数下降抓住，而不是靠 Verifier 的判断。
  "test('calc works', () => {});",
  "",
].join("\n");

function est(s) { return Math.max(1, Math.ceil(String(s).length / 4)); }

export default async function createMock() {
  return {
    name: "mock",
    async run({ role, task, cwd, attempt }) {
      const sc = scenario();
      if (role === "lead") {
        return { ok: true, tokens: 40, text: "1. 实现 src/calc.mjs 的运算符分支（验收：npm test）\n2. 补边界与异常测试（验收：npm test）" };
      }
      if (role === "architect") {
        const plan = [
          "# 方案",
          "- 模块：src/calc.mjs 导出 calc(a, b, op)",
          "- 接口：calc(a: number, b: number, op: string) -> number",
          "- 失败模式：未知 op 抛 Error",
          "- 回滚：删除 src/calc.mjs 与新增测试即可",
          "",
        ].join("\n");
        return { ok: true, tokens: est(plan), text: plan };
      }
      if (role === "coder") {
        const d = Number(process.env.WB_MOCK_DELAY || 0);
        if (d > 0) await new Promise((r) => setTimeout(r, d));
        if (sc === "fakegreen" && attempt === 0) {
          write(cwd, "src/calc.mjs", "export function calc(a, b, op) { return 0; }\n");
          write(cwd, "test/calc.test.mjs", FAKE_TEST);
          return { ok: true, tokens: 30, text: "实现完成（自测通过）。" };
        }
        write(cwd, "src/calc.mjs", GOOD_IMPL);
        write(cwd, "test/calc.test.mjs", GOOD_TEST);
        return { ok: true, tokens: est(GOOD_IMPL), text: "实现完成，测试已补。" };
      }
      if (role === "verifier") {
        const weakened = sc === "fakegreen" && attempt === 0;
        if (weakened) {
          return { ok: true, tokens: 25, text: verdict("fail", "改写了既有测试并留下空断言，属伪绿。", ["test_weakened: test/calc.test.mjs"]) };
        }
        return { ok: true, tokens: 25, text: verdict("pass", "实现与测试一致，未知 op 边界已覆盖。") };
      }
      if (role === "reviewer") {
        return { ok: true, tokens: 15, text: verdict("pass", "证据充分，可交由人决定。") };
      }
      return { ok: false, error: "unknown role: " + role };
    },
  };
}
