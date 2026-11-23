import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "team-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let port;
let ws;

const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const url = (p) => "http://127.0.0.1:" + port + p;

before(async () => {
  port = await freePort();
  ws = mkdtempSync(join(tmpdir(), "wb-auth-"));
  server = spawn(process.execPath, [join(ROOT, "src/server/index.mjs")], {
    env: { ...process.env, WB_ROOT: ws, WB_CODE: ROOT, WB_PORT: String(port), WB_HOST: "127.0.0.1", WB_TOKEN: TOKEN },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // 起来的标准是「未登录的 /api/tasks 返回 401」——服务端在跑，只是没放行
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url("/api/tasks"));
      if (r.status === 401) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("服务端没起来");
});

after(() => {
  try { server.kill("SIGKILL"); } catch {}
  rmSync(ws, { recursive: true, force: true });
});

test("没登录：API 401，页面跳登录页", async () => {
  assert.equal((await fetch(url("/api/tasks"))).status, 401, "API 必须挡住");
  const page = await fetch(url("/"), { redirect: "manual" });
  assert.equal(page.status, 302, "页面也该挡住");
  assert.match(page.headers.get("location"), /\/login\.html/, "要被送到登录页");
});

test("登录页本身必须能打开（否则永远进不去）", async () => {
  const r = await fetch(url("/login.html"));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /口令/);
});

test("口令不对：401，且不下发 cookie", async () => {
  const r = await fetch(url("/api/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "wrong" }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null, "错口令不能给 cookie");
});

test("口令对了：下发 HttpOnly cookie，之后页面和 API 都放行", async () => {
  const r = await fetch(url("/api/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^wb_token=/);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/i, "session 不该被页面脚本读到");
  assert.match(r.headers.get("set-cookie"), /SameSite=Lax/i);

  const api = await fetch(url("/api/tasks"), { headers: { cookie } });
  assert.equal(api.status, 200, "带 cookie 的 API 要放行");
  const page = await fetch(url("/"), { headers: { cookie }, redirect: "manual" });
  assert.equal(page.status, 200, "带 cookie 的页面要放行（不是 302）");
});

test("脚本/外壳也能用：x-wb-token 与 ?token= 两种带法", async () => {
  assert.equal((await fetch(url("/api/tasks"), { headers: { "x-wb-token": TOKEN } })).status, 200);
  assert.equal((await fetch(url("/api/tasks?token=" + TOKEN))).status, 200, "一次性链接");
  assert.equal((await fetch(url("/api/tasks?token=nope"))).status, 401);
});

test("登出后立刻失效", async () => {
  const login = await fetch(url("/api/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.equal((await fetch(url("/api/tasks"), { headers: { cookie } })).status, 200);

  const out = await fetch(url("/api/logout"), { method: "POST", headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/, "要让浏览器把 cookie 删掉");
});

test("WB_NO_AUTH=1 时完全放开（.app 本机单用户）", async () => {
  const p2 = await freePort();
  const ws2 = mkdtempSync(join(tmpdir(), "wb-auth2-"));
  const s2 = spawn(process.execPath, [join(ROOT, "src/server/index.mjs")], {
    env: { ...process.env, WB_ROOT: ws2, WB_CODE: ROOT, WB_PORT: String(p2), WB_HOST: "127.0.0.1", WB_TOKEN: "", WB_NO_AUTH: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await sleep(200);
      try {
        ok = (await fetch("http://127.0.0.1:" + p2 + "/api/tasks")).status === 200;
      } catch {}
    }
    assert.ok(ok, "WB_NO_AUTH=1 时 API 应该直接 200");
  } finally {
    s2.kill("SIGKILL");
    rmSync(ws2, { recursive: true, force: true });
  }
});

test("首次启动自动建 lead 账号，一次性口令只打印一次，能直接登录", async () => {
  const p3 = await freePort();
  const ws3 = mkdtempSync(join(tmpdir(), "wb-auth3-"));
  const s3 = spawn(process.execPath, [join(ROOT, "src/server/index.mjs")], {
    env: { ...process.env, WB_ROOT: ws3, WB_CODE: ROOT, WB_PORT: String(p3), WB_HOST: "127.0.0.1", WB_TOKEN: "", WB_ADMIN_NAME: "lead0" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    let out = "";
    s3.stdout.on("data", (d) => { out += String(d); });
    let pw = null;
    for (let i = 0; i < 60 && !pw; i++) {
      await sleep(200);
      const m = out.match(/一次性口令: (\S+)/);
      if (m) pw = m[1];
    }
    assert.ok(pw, "启动日志里必须有一次性口令，否则没人能登录：" + out.slice(0, 400));

    const r = await fetch("http://127.0.0.1:" + p3 + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "lead0", password: pw }),
    });
    assert.equal(r.status, 200);
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    const me = await fetch("http://127.0.0.1:" + p3 + "/api/me", { headers: { cookie } });
    const j = await me.json();
    assert.equal(j.user.name, "lead0");
    assert.equal(j.user.role, "lead");
    assert.equal(j.user.password_hash, undefined, "不能把口令哈希发到前端");
  } finally {
    s3.kill("SIGKILL");
    rmSync(ws3, { recursive: true, force: true });
  }
});
test("口令连错 5 次就锁：第 6 次 429，正确口令也进不去（防在线爆破）", async () => {
  const p4 = await freePort();
  const ws4 = mkdtempSync(join(tmpdir(), "wb-auth4-"));
  const s4 = spawn(process.execPath, [join(ROOT, "src/server/index.mjs")], {
    env: { ...process.env, WB_ROOT: ws4, WB_CODE: ROOT, WB_PORT: String(p4), WB_HOST: "127.0.0.1", WB_TOKEN: "", WB_ADMIN_NAME: "boss" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    let out = "";
    s4.stdout.on("data", (d) => { out += String(d); });
    let pw = null;
    for (let i = 0; i < 60 && !pw; i++) {
      await sleep(200);
      const m = out.match(/一次性口令: (\S+)/);
      if (m) pw = m[1];
    }
    assert.ok(pw, "得有一次性口令才能测登录");
    const login = (password) => fetch("http://127.0.0.1:" + p4 + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "boss", password }),
    });
    for (let i = 0; i < 5; i++) assert.equal((await login("wrong-" + i)).status, 401, "第 " + (i + 1) + " 次错口令是 401");
    const locked = await login("wrong-again");
    assert.equal(locked.status, 429, "第 6 次该被锁");
    assert.ok(Number(locked.headers.get("retry-after")) > 0, "要告诉客户端等多久");
    assert.equal((await login(pw)).status, 429, "锁住期间正确口令也不放行（否则爆破只要猜对一次）");
  } finally {
    s4.kill("SIGKILL");
    rmSync(ws4, { recursive: true, force: true });
  }
});
