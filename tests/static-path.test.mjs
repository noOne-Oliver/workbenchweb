import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";
import { resolveStatic } from "../src/server/index.mjs";

const WEB = "/tmp/wb-root/web";
const inside = (p) => {
  const rel = relative(WEB, p);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

test("正常路径解析到 web 目录里", () => {
  assert.equal(resolveStatic(WEB, "/"), WEB + "/index.html", "根路径给 index.html");
  assert.equal(resolveStatic(WEB, "/app.js"), WEB + "/app.js");
  assert.equal(resolveStatic(WEB, "/style.css"), WEB + "/style.css");
});

test("越界一律拒绝：不能靠字符串前缀判断", () => {
  // 这一条就是旧实现的漏洞：WEB=/x/web 时 /x/web-secret 以 /x/web 开头，startsWith 会放行
  assert.equal(resolveStatic(WEB, "/../web-secret/x.txt"), null, "兄弟目录不能被当成 web 里面");
  assert.equal(resolveStatic(WEB, "/../package.json"), null, "不能读到内核代码目录的文件");
  assert.equal(resolveStatic(WEB, "/../../etc/passwd"), null);
  assert.equal(resolveStatic(WEB, "/sub/../../outside.js"), null);
});

test("放行的路径一定在 web 目录里面（对一堆边界输入做不变量检查）", () => {
  const cases = ["/", "/app.js", "/a/b/c.js", "/..", "/../", "/.%2e/x", "/%2e%2e/x", "/./app.js", "//app.js"];
  for (const c of cases) {
    const got = resolveStatic(WEB, c);
    if (got === null) continue;
    assert.ok(inside(got), c + " 不该解析到 " + got);
  }
});

test("空路径/undefined 不炸", () => {
  assert.equal(resolveStatic(WEB, ""), WEB + "/index.html");
  assert.equal(resolveStatic(WEB, undefined), WEB + "/index.html");
});
