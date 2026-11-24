import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScope, matchesAny } from "../core/glob.mjs";
import { sh } from "./worktree.mjs";

/**
 * 确定性护栏 —— 不依赖任何模型判断的那一层。
 * 这是"伪绿照妖镜"：agent 最常见的作弊是改测试或空断言，这里靠 git 与真实命令抓它。
 */

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const ASSERT_RE = /\b(assert|expect|should|XCTAssert|#expect)\b/;

const DEFAULTS = { testCmd: ["npm", "test"], sizeLimitLines: 600, testTimeoutMs: 300000 };

/** 本机有没有可用的 npm：打包后的 app 只带 node，没有 npm。 */
const NPM_OK = (() => {
  try { return sh("npm", ["--version"], { timeout: 10000 }).ok; } catch { return false; }
})();

/**
 * 测试命令：默认 npm test，但打包环境里没有 npm 时要能退回 node --test，
 * 否则「护栏跑不起来」会被误读成「测试不过」，每个任务都会平白打回。
 */
export function testCommandFor(cfg, opts) {
  const npmOk = opts && "npmOk" in opts ? opts.npmOk : (process.env.WB_NO_NPM ? false : NPM_OK);
  const raw = (cfg && cfg.testCmd) || DEFAULTS.testCmd;
  const cmd = Array.isArray(raw) ? raw.slice() : String(raw).split(/\s+/).filter(Boolean);
  if (cmd[0] !== "npm" || npmOk) return { cmd, note: "" };
  return { cmd: [process.execPath, "--test"], note: "本机没有可用的 npm，已退回 node --test；" };
}

/**
 * 跑仓库的整套测试。
 * 必须清掉 NODE_TEST_CONTEXT：从 node --test 里再起 node --test（我们自己的测试就是这么跑的），
 * 子进程会以为自己是被调度的测试子进程，直接退出 0 —— 失败用例被当成通过。
 */
function runSuite(dir, cfg) {
  const { cmd } = testCommandFor(cfg);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return sh(cmd[0], cmd.slice(1), { cwd: dir, timeout: cfg.testTimeoutMs || DEFAULTS.testTimeoutMs, env });
}

export function loadRepoConfig(workdir) {
  const p = join(workdir, "wb.config.json");
  if (!existsSync(p)) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}

export function changedFiles(dir, base) {
  const r = sh("git", ["-C", dir, "diff", "--name-status", base + "..HEAD"]);
  if (!r.ok) return [];
  return r.out.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return { status: parts[0].charAt(0), path: parts[parts.length - 1] };
  });
}

const ASSERT_G = /\b(assert|expect|should|XCTAssert|#expect)\b/g;
const CASE_G = /\b(?:test|it|describe)\s*\(/g;

function countTests(src) {
  const s = String(src || "");
  return {
    tests: (s.match(CASE_G) || []).length,
    asserts: (s.match(ASSERT_G) || []).length,
  };
}

function gitShow(dir, ref, path) {
  const r = sh("git", ["-C", dir, "show", ref + ":" + path]);
  return r.ok ? r.out : "";
}

function testOutputTail(dir, base) {
  const r = sh("git", ["-C", dir, "diff", base + "..HEAD", "--", "*/test/*", "test/*"]);
  return r.ok ? r.out.slice(0, 4000) : "";
}

/**
 * 把测试输出解析成用例清单（node --test 的 TAP 与 mocha 风格都认）。
 * 只负责"人能不能看懂哪条挂了"，判定仍然只看退出码。
 */
export function parseTestCases(out) {
  const cases = [];
  let cur = null;
  const push = (name, ok) => {
    cur = { name, ok, detail: [] };
    cases.push(cur);
  };
  for (const raw of String(out || "").split("\n")) {
    if (!raw.trim()) continue;
    const tap = /^(not ok|ok)\b\s*(?:\d+\s*)?(?:-\s*)?(.*)$/.exec(raw.trim());
    if (tap) {
      const name = tap[2].replace(/\s+#.*$/, "").trim();
      if (!name || /^tests?$/.test(name)) { cur = null; continue; }
      push(name, tap[1] === "ok");
      continue;
    }
    const mocha = /^(✓|✗|✖|√)\s+(.*)$/.exec(raw.trim());
    if (mocha) { push(mocha[2].trim(), mocha[1] === "✓" || mocha[1] === "√"); continue; }
    if (/^(#|1\.\.)/.test(raw.trim())) { cur = null; continue; }
    if (cur && !cur.ok && cur.detail.length < 4) {
      const t = raw.trim();
      if (/^(error|Error|AssertionError|expected|actual|at |code:|name:)/.test(t)) cur.detail.push(t.slice(0, 400));
    }
  }
  const pass = cases.filter((c) => c.ok).length;
  return { total: cases.length, pass, fail: cases.length - pass, cases };
}

/** 纯函数：把「基线跑出来的用例」与「这次跑出来的用例」对照出四类差异。 */
export function compareBaseline(baseCases, nowCases) {
  const names = (list) => new Set(list.map((c) => c.name));
  const basePass = names(baseCases.filter((c) => c.ok));
  const baseFail = names(baseCases.filter((c) => !c.ok));
  const nowPass = names(nowCases.filter((c) => c.ok));
  const nowFail = names(nowCases.filter((c) => !c.ok));
  const allNow = names(nowCases);
  return {
    // 回退 = 原来过、现在挂。用例被改名/删掉不算回退（那是对不上名字），单列在 removed 里给人看
    regressions: [...basePass].filter((n) => nowFail.has(n)),
    fixed: [...baseFail].filter((n) => nowPass.has(n)),
    added: [...allNow].filter((n) => !basePass.has(n) && !baseFail.has(n)),
    removed: [...basePass].filter((n) => !allNow.has(n)),
    basePassCount: basePass.size,
    baseFailCount: baseFail.size,
  };
}

/**
 * 基线：把 base 提交原样展开到临时目录跑一遍测试，得到「改动之前哪些用例是绿的」。
 * 没有基线就只能说"现在全绿"，说不出"这次改动有没有弄坏原来能用的东西"。
 * 用 git archive 而不是 worktree：不注册、不留残枝，也不用 --force 清理。
 */
export function baselineSnapshot({ workdir, base, config }) {
  if (process.env.WB_NO_BASELINE === "1") return null;
  const cfg = config || loadRepoConfig(workdir);
  const tree = sh("git", ["-C", workdir, "ls-tree", "-r", "--name-only", base]);
  const hasTests = tree.ok && tree.out.split("\n").some((p) => TEST_FILE_RE.test(p));
  if (!hasTests) return null;
  const tmp = mkdtempSync(join(tmpdir(), "wb-base-"));
  try {
    const cmd = "git -C " + JSON.stringify(workdir) + " archive " + JSON.stringify(base) + " | tar -x -C " + JSON.stringify(tmp);
    if (!sh("/bin/sh", ["-c", cmd]).ok) return null;
    const run = runSuite(tmp, cfg);
    return { ...parseTestCases(run.out), ok: run.ok, exitCode: run.code };
  } catch {
    return null;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}


// ---- 同义反复检测（测试把实现里的同一个调用当成期望值） ----
// 例：实现 return Math.pow(a,b)；测试 assert.equal(pow(2,0.5), Math.pow(2,0.5))
// 测试永远是绿的——因为它校验的不是"实现对不对"，而是"实现等于实现"。

const SRC_FILE_RE = /\.(m|c)?[jt]sx?$/i;
const SKIP_CALLEES = new Set(["console.log", "console.error", "console.warn", "JSON.parse"]);

function sliceBalanced(src, openIdx) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const open = src[openIdx];
  const close = pairs[open];
  if (!close) return { body: "", end: openIdx };
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { body: src.slice(openIdx + 1, i), end: i };
    }
  }
  return { body: src.slice(openIdx + 1), end: src.length };
}

function paramNames(paramSrc) {
  return String(paramSrc || "")
    .split(",")
    .map((p) => p.trim().replace(/=.*$/, "").trim())
    .map((p) => (/^[A-Za-z_$][\w$]*$/.test(p) ? p : ""))
    .filter(Boolean);
}

/** 从源码里抠出函数名、形参、函数体；支持 function 声明与箭头函数。 */
export function extractFunctions(src) {
  const s = String(src || "");
  const out = [];
  const decl = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = decl.exec(s))) {
    const openIdx = s.indexOf("(", m.index + m[0].length - 1);
    const { end } = sliceBalanced(s, openIdx);
    const braceIdx = s.indexOf("{", end);
    if (braceIdx < 0) continue;
    const body = sliceBalanced(s, braceIdx).body;
    const params = paramNames(s.slice(openIdx + 1, end));
    out.push({ name: m[1], params, body });
  }
  const arrow = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = arrow.exec(s))) {
    const openIdx = s.indexOf("(", m.index + m[0].length - 1);
    const { end } = sliceBalanced(s, openIdx);
    const params = paramNames(s.slice(openIdx + 1, end));
    const rest = s.slice(end + 1);
    const arrowAt = rest.indexOf("=>");
    if (arrowAt < 0 || arrowAt > 8) continue;
    const afterArrow = s.slice(end + 1 + arrowAt + 2);
    const trimmed = afterArrow.replace(/^\s*/, "");
    let body = "";
    if (trimmed.startsWith("{")) {
      const braceIdx = s.indexOf("{", end + 1 + arrowAt + 2);
      body = sliceBalanced(s, braceIdx).body;
    } else {
      const stop = trimmed.search(/;\s*(\n|$)/);
      body = stop >= 0 ? trimmed.slice(0, stop) : trimmed.split("\n")[0];
    }
    out.push({ name: m[1], params, body });
  }
  return out;
}

/**
 * 函数体里"实现所依赖的调用"：
 *  - 命名空间调用 Math.pow / JSON.stringify / xs.slice…
 *  - 同文件内定义的辅助函数 double(...)
 * 排除形参自身的成员调用（a.slice() 这种是操作入参，不算实现手段）。
 */
export function calleesOf(body, params, knownFns) {
  const own = new Set(params || []);
  const src = String(body || "");
  const found = new Set();
  const dotted = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
  let m;
  while ((m = dotted.exec(src))) {
    const full = m[1].replace(/\s+/g, "");
    if (own.has(full.split(".")[0])) continue;
    if (SKIP_CALLEES.has(full)) continue;
    found.add(full);
  }
  if (knownFns && knownFns.size) {
    const plain = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = plain.exec(src))) {
      const name = m[1];
      if (own.has(name) || !knownFns.has(name)) continue;
      found.add(name);
    }
  }
  return found;
}

function splitTopLevelArgs(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

const ASSERT_CALLS = [
  /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual)\s*\(/g,
  /\.(?:toBe|toEqual|toStrictEqual)\s*\(/g,
];

/**
 * 断言的"实际值"和"期望值"是不是同一个表达式（忽略空白与引号风格）。
 * 例：calc(2,3) vs calc(2, 3)、pow(2,0.5) vs pow(2,"0.5" 不算，引号统一后才算)。
 * 这是与实现无关的恒真判据 —— 实现只用运算符时也必须检查。
 */
export function sameExpression(a, b) {
  const norm = (x) => String(x || "").replace(/\s+/g, "").replace(/["']/g, '"');
  const x = norm(a), y = norm(b);
  return Boolean(x) && x === y && x.includes("(");
}

/** 判断期望值是不是"实现里同一个调用"的复制品；返回命中的调用名或 null。 */
export function tautologyIn(actual, expected, fnName, callees) {
  const a = String(actual || "").replace(/\s+/g, " ").trim();
  const b = String(expected || "").replace(/\s+/g, " ").trim();
  if (!a || !b) return null;
  // 类别一：两边是同一个表达式（含同函数不同参数）
  if (sameExpression(a, b)) return a;
  // 类别二：期望值是纯调用，且这个调用正是实现内部的实现手段
  const pure = /^[A-Za-z_$][\w$.]*\s*\([\s\S]*\)$/.exec(b);
  if (!pure) return null;
  const head = pure[0].split("(")[0].replace(/\s+/g, "");
  const actualCalls = String(a).match(/[A-Za-z_$][\w$.]*\s*\(/g) || [];
  const usesImpl = actualCalls.some((c) => c.replace(/\s+/g, "").replace(/\($/, "") === fnName);
  if (!usesImpl) return null;
  if (callees.has(head)) return head;
  return null;
}

/** 目录里所有文件（相对路径），跳过 .git/node_modules 这类噪音。 */
function walkFiles(root, prefix = "", out = [], depth = 0) {
  if (depth > 8) return out;
  let entries = [];
  try { entries = readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === ".oc" || e.name === "dist") continue;
    const rel = prefix ? prefix + "/" + e.name : e.name;
    if (e.isDirectory()) walkFiles(root, rel, out, depth + 1);
    else out.push(rel);
  }
  return out;
}

/** 阶段产出物是否真的存在：精确路径看文件，带通配的看是否有文件命中。 */
export function artifactExists(workdir, artifact) {
  const a = String(artifact || "").trim();
  if (!a) return true;
  if (!a.includes("*")) return existsSync(join(workdir, a));
  return walkFiles(workdir).some((f) => matchesAny(f, [a]));
}

export function runGuards({ workdir, base, config, extra }) {
  const cfg = config || loadRepoConfig(workdir);
  const checks = [];
  const files = changedFiles(workdir, base);

  // 0. 阶段闸门（只在任务挂了阶段时生效）：机械执行「这个阶段只做这件事」。
  //    守的是"目标不发散"，不是代码质量——质量交给测试与 Verifier。
  const stage = extra && extra.stage ? extra.stage : null;
  if (stage) {
    const globs = Array.isArray(stage.allowedGlobs) ? stage.allowedGlobs : [];
    const scope = checkScope(files.map((f) => f.path), globs);
    checks.push({
      id: "stage_scope",
      ok: scope.ok,
      detail: scope.ok
        ? "改动都在「" + stage.name + "」范围内" + (globs.length ? "（" + globs.slice(0, 6).join(" ") + (globs.length > 6 ? " …" : "") + "）" : "（本阶段不限制文件）")
        : "越界改动：本阶段「" + stage.name + "」只允许 " + (globs.join(" ") || "（无）") + "，却改了 " +
          scope.outside.slice(0, 8).join(", ") + (scope.outside.length > 8 ? " 等 " + scope.outside.length + " 个文件" : "") +
          "。越界的想法请写进 backlog，不要在实现阶段顺手做。",
    });
    const artifacts = Array.isArray(stage.artifacts) ? stage.artifacts : [];
    const missing = artifacts.filter((a) => !artifactExists(workdir, a));
    checks.push({
      id: "stage_artifacts",
      ok: missing.length === 0,
      detail: artifacts.length === 0
        ? "本阶段不要求产出物"
        : missing.length === 0
          ? "本阶段产出物齐全：" + artifacts.join(", ")
          : "本阶段产出物缺失：" + missing.join(", ") + "（要求 " + artifacts.join(", ") + "）",
    });
  }

  // 1. 测试必须真的跑，且真的绿（跑的是仓库整套测试，不是只跑新增那条）
  const { cmd, note } = testCommandFor(cfg);
  const run = runSuite(workdir, cfg);
  const now = parseTestCases(run.out);
  const caseNote = now.total ? "（" + now.total + " 条用例：" + now.pass + " 过" + (now.fail ? "，" + now.fail + " 挂" : "") + "）" : "";
  checks.push({
    id: "tests_pass",
    ok: run.ok,
    detail: note + (run.ok ? "整套测试退出码 0" + caseNote : "测试命令失败（exit " + run.code + "）" + caseNote),
  });

  // 1b. 回归：拿 base 提交跑一遍做基线，看有没有"原来能过、现在挂了"的用例。
  //     只跑当前代码看不出回归——那正是人 review 时最该被机器顶掉的一步。
  let baseline = null;
  try { baseline = baselineSnapshot({ workdir, base, config: cfg }); } catch { baseline = null; }
  const cmp = baseline ? compareBaseline(baseline.cases, now.cases) : null;
  checks.push({
    id: "no_regression",
    ok: !cmp || cmp.regressions.length === 0,
    detail: !cmp
      ? "没有取到基线（WB_NO_BASELINE=1 或 base 提交里没有测试），本次只验证当前全绿"
      : cmp.regressions.length
        ? "原来能过的用例现在挂了: " + cmp.regressions.slice(0, 5).join("；") +
          (cmp.regressions.length > 5 ? " 等 " + cmp.regressions.length + " 条" : "")
        : "既有 " + cmp.basePassCount + " 条用例全绿" +
          (cmp.added.length ? "，新增 " + cmp.added.length + " 条" : "") +
          (cmp.fixed.length ? "，修好 " + cmp.fixed.length + " 条" : "") +
          (cmp.removed.length ? "，删掉了 " + cmp.removed.length + " 条原本能过的（改名也算，看 diff 确认）: " + cmp.removed.slice(0, 3).join("；") : "") +
          (baseline.ok ? "" : "（基线本身有 " + baseline.fail + " 条本就失败，不算这次改动）"),
  });

  // 2. 不许把测试改弱：删文件、或断言/用例数变少都算削弱。
  //    允许"加强测试"（数量不减），否则正常任务会被误杀。
  const touchedTests = files.filter((f) => TEST_FILE_RE.test(f.path) && (f.status === "M" || f.status === "D"));
  const weakened = [];
  for (const f of touchedTests) {
    if (f.status === "D") { weakened.push(f.path + " (已删除)"); continue; }
    const before = gitShow(workdir, base, f.path);
    let after = "";
    try { after = readFileSync(join(workdir, f.path), "utf8"); } catch { after = ""; }
    const b = countTests(before);
    const a = countTests(after);
    if (a.tests < b.tests || a.asserts < b.asserts) {
      weakened.push(f.path + " (用例 " + b.tests + "->" + a.tests + "，断言 " + b.asserts + "->" + a.asserts + ")");
    }
  }
  checks.push({
    id: "no_test_weakening",
    ok: weakened.length === 0,
    detail: weakened.length === 0
      ? (touchedTests.length ? "改动了测试但未削弱（用例/断言数不减）" : "未改动既有测试文件")
      : "测试被削弱: " + weakened.join("；"),
  });

  // 3. 新增测试必须有断言
  const addedTests = files.filter((f) => TEST_FILE_RE.test(f.path) && f.status === "A");
  const emptyTests = addedTests.filter((f) => {
    try {
      const body = readFileSync(join(workdir, f.path), "utf8");
      return !ASSERT_RE.test(body);
    } catch { return true; }
  });
  checks.push({
    id: "no_empty_tests",
    ok: emptyTests.length === 0,
    detail: emptyTests.length === 0
      ? (addedTests.length ? "新增测试含断言" : "无新增测试文件")
      : "新增测试无任何断言: " + emptyTests.map((f) => f.path).join(", "),
  });

  // 5. 不许"同义反复"测试：期望值直接抄实现里的同一个调用。
  //    例：实现 return Math.pow(a,b) → 测试 assert.equal(pow(2,0.5), Math.pow(2,0.5))
  //    这种测试永远绿，因为它校验的是"实现等于实现"，也就测不出实现写错。
  const implFiles = files.filter((f) =>
    (f.status === "A" || f.status === "M") && !TEST_FILE_RE.test(f.path) && SRC_FILE_RE.test(f.path));
  const implFns = new Map();
  for (const f of implFiles) {
    let src = "";
    try { src = readFileSync(join(workdir, f.path), "utf8"); } catch { continue; }
    const fns = extractFunctions(src);
    const known = new Set(fns.map((fn) => fn.name));
    for (const fn of fns) {
      const callees = calleesOf(fn.body, fn.params, known);
      if (callees.size) implFns.set(fn.name, { file: f.path, callees });
    }
  }
  const tautologies = [];
  const testFiles = files.filter((f) =>
    TEST_FILE_RE.test(f.path) && (f.status === "A" || f.status === "M"));
  for (const f of testFiles) {
    let src = "";
    try { src = readFileSync(join(workdir, f.path), "utf8"); } catch { continue; }
    src.split("\n").forEach((line, idx) => {
      if (line.length > 600) return;
      for (const re of ASSERT_CALLS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const openIdx = line.indexOf("(", m.index + m[0].length - 1);
          const args = splitTopLevelArgs(sliceBalanced(line, openIdx).body);
          if (args.length < 2) continue;
          // 类别一：断言的期望值与实际值是同一表达式 —— 恒真，与实现长什么样无关。
          // 必须放在 implFns 门之外：实现只用运算符（a+b / a**b）时 implFns 为空，
          // 否则 assert.equal(calc(2,3), calc(2,3)) 会直接漏过去。
          if (sameExpression(args[0], args[1])) {
            tautologies.push(f.path + ":" + (idx + 1) + " 断言的期望值与实际值完全一样: " + args[0].trim());
            continue;
          }
          // 类别二：期望值是实现内部同一个调用的复制品（需要实现信息）。
          for (const [fnName, meta] of implFns) {
            if (!new RegExp("\\b" + fnName + "\\s*\\(").test(line)) continue;
            const hit = tautologyIn(args[0], args[1], fnName, meta.callees)
              || tautologyIn(args[1], args[0], fnName, meta.callees);
            if (!hit) continue;
            tautologies.push(f.path + ":" + (idx + 1) + " 「" + fnName + "」的期望值就是实现里的 " + hit);
          }
        }
      }
    });
  }
  checks.push({
    id: "no_tautological_test",
    ok: tautologies.length === 0,
    detail: tautologies.length === 0
      ? (implFns.size
        ? "断言未复制实现内部的调用，两边也不是同一表达式"
        : "实现只含字面量/入参：已按「两边同一表达式」检查，未发现恒真断言")
      : "同义反复测试（测不出实现错）: " + tautologies.join("；"),
  });

  // 4. 变更规模上限（防止越界重构）
  const numstat = sh("git", ["-C", workdir, "diff", "--numstat", base + "..HEAD"]);
  let lines = 0;
  if (numstat.ok) {
    for (const ln of numstat.out.split("\n").filter(Boolean)) {
      const c = ln.split("\t");
      lines += (parseInt(c[0], 10) || 0) + (parseInt(c[1], 10) || 0);
    }
  }
  const limit = cfg.sizeLimitLines || DEFAULTS.sizeLimitLines;
  checks.push({
    id: "diff_size",
    ok: lines <= limit,
    detail: "改动 " + lines + " 行（上限 " + limit + "）",
  });

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return {
    ok: failed.length === 0,
    failed,
    checks,
    files,
    stage: stage ? { id: stage.id, name: stage.name } : null,
    testOutput: String(run.out || "").slice(-12000),
    testCmd: cmd.join(" "),
    testDiff: testOutputTail(workdir, base),
    // 给界面用：用例清单 + 基线对比（都是"人能不能看懂"，不参与判定）
    testCases: { total: now.total, pass: now.pass, fail: now.fail, cases: now.cases.slice(0, 300) },
    baseline: cmp
      ? {
        ok: baseline.ok,
        pass: cmp.basePassCount,
        fail: cmp.baseFailCount,
        regressions: cmp.regressions,
        fixed: cmp.fixed,
        added: cmp.added,
        removed: cmp.removed,
      }
      : null,
  };
}
