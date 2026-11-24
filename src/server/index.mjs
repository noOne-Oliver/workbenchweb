import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { openDb } from "../core/db.mjs";
import { createTask, getTask, listTasks, transition, record, addEvidence, migrateReviewStates } from "../core/ledger.mjs";
import { readForTask } from "../core/events.mjs";
import { feed as readFeed, live as readLive } from "../core/activity.mjs";
import { watchParent } from "../core/orphan.mjs";
import { readHeartbeat } from "../core/liveness.mjs";
import { codeVersion } from "../runner/worker.mjs";
import { can } from "../core/permissions.mjs";
import {
  createProject, getProject, listProjects, meetProject, signStages, startStage, decideBacklog, eventsOfProject,
} from "../core/stages.mjs";
import { getProvider } from "../runner/engine.mjs";
import {
  ROLES, authEnabled, createUser, ensureBootstrapAdmin, ensureLegacyOwners, getUser, listUsers,
  openSecret, publicUser, sessionUser, setActive, setPassword, setRole, signSession, tempPassword, verifyPassword,
} from "../core/users.mjs";

// ROOT = 工作区（账本、worktrees、凭据都写这里）；CODE = 内核代码目录（打包后是 app 内的 Resources/kernel）。
// 两者分开，才能把内核塞进 .app 而数据留在用户自己的工作区。
const ROOT = resolve(process.env.WB_ROOT || process.cwd());
const CODE = resolve(process.env.WB_CODE || ROOT);
const WEB = resolve(CODE, "web");
const TOKEN = process.env.WB_TOKEN || "";
const PORT = Number(process.env.WB_PORT || 7317);
const HOST = process.env.WB_HOST || "127.0.0.1";
const REVIEW_TTL_MS = Number(process.env.WB_REVIEW_TTL_MS || 30 * 60 * 1000);
const SESSION_TTL = 7 * 24 * 3600;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/**
 * 把 URL 路径解析成 web 目录里的文件。越界返回 null。
 * 按路径段比较（relative 后看是否以 .. 开头），不用字符串前缀——
 * startsWith 会把 /web-secret/x 这种兄弟目录误判成"在 web 里面"。
 */
export function resolveStatic(webDir, urlPath) {
  const raw = String(urlPath || "/");
  const rel = raw === "/" ? "/index.html" : raw;
  const file = join(webDir, rel);
  const out = relative(webDir, file);
  if (out.startsWith("..") || isAbsolute(out)) return null;
  return file;
}

const COOKIE = "wb_token";

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAge) {
  res.setHeader("set-cookie", COOKIE + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge);
}

// 登录失败退避：同一个人名连续错 5 次就锁 60 秒，之后每次翻倍，封顶 10 分钟。
// 内网也值得有——worker 跑在没人看的机器上，暴力破解不需要人配合。
const LOGIN_FAILS = new Map();
const LOGIN_MAX_FAILS = 5;
const LOGIN_BASE_LOCK_MS = 60_000;
const LOGIN_MAX_LOCK_MS = 10 * 60_000;

function loginLocked(name, now = Date.now()) {
  const e = LOGIN_FAILS.get(name);
  if (!e || !e.until || e.until <= now) return 0;
  return Math.ceil((e.until - now) / 1000);
}

function noteLoginFail(name, now = Date.now()) {
  const e = LOGIN_FAILS.get(name) || { n: 0, until: 0 };
  e.n += 1;
  if (e.n >= LOGIN_MAX_FAILS) {
    const extra = Math.min(LOGIN_MAX_LOCK_MS, LOGIN_BASE_LOCK_MS * 2 ** (e.n - LOGIN_MAX_FAILS));
    e.until = now + extra;
  }
  LOGIN_FAILS.set(name, e);
  if (LOGIN_FAILS.size > 1000) {
    for (const [k, v] of LOGIN_FAILS) if (!v.until || v.until <= now) LOGIN_FAILS.delete(k);
  }
}

async function readBody(req) {
  let buf = "";
  for await (const chunk of req) buf += chunk;
  if (!buf) return {};
  try { return JSON.parse(buf); } catch { return {}; }
}

/** 登录态只有两个来源：签名的 session cookie（人），或 WB_TOKEN（脚本 break-glass，记成 cli/lead）。 */
function makeCurrentUser(db, secret) {
  return function currentUser(req) {
    const u = sessionUser(db, secret, cookies(req)[COOKIE]);
    if (u) return u;
    const url = new URL(req.url, "http://x");
    const given = req.headers["x-wb-token"] || url.searchParams.get("token") || cookies(req)[COOKIE] || "";
    if (TOKEN && given === TOKEN) return { name: "cli", role: "lead", active: true };
    return null;
  };
}

export function createApp(db) {
  const SECRET = openSecret(ROOT);
  const currentUser = makeCurrentUser(db, SECRET);

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const authRequired = authEnabled(db);
    const me = currentUser(req);

    try {
      // 登录/登出自己不需要先登录（否则永远进不去）
      if (path === "/api/login" && req.method === "POST") {
        const b = await readBody(req);
        // 老式口令登录（脚本/外壳/兼容）：口令对就给 lead 身份的 cookie
        if (b.token !== undefined) {
          if (!TOKEN) return json(res, 200, { ok: true, tokenRequired: false });
          if (String(b.token) !== TOKEN) return json(res, 401, { error: "口令不对" });
          setCookie(res, TOKEN, SESSION_TTL);
          return json(res, 200, { ok: true, tokenRequired: true, user: { name: "cli", role: "lead" } });
        }
        const name = String(b.name ?? "").trim();
        const wait = loginLocked(name);
        if (wait > 0) {
          res.setHeader("retry-after", String(wait));
          return json(res, 429, { error: "口令错太多次，等 " + wait + " 秒再试" });
        }
        const u = getUser(db, name);
        if (!u || !u.active || !verifyPassword(b.password, u.password_hash)) {
          noteLoginFail(name);
          return json(res, 401, { error: "用户名或口令不对" });
        }
        LOGIN_FAILS.delete(name);
        setCookie(res, signSession(SECRET, { name: u.name, role: u.role, version: u.secret_version }), SESSION_TTL);
        return json(res, 200, { ok: true, user: publicUser(u) });
      }
      if (path === "/api/logout" && req.method === "POST") {
        setCookie(res, "", 0);
        return json(res, 200, { ok: true });
      }

      // 执行器活体：worker 崩了/被系统杀了，这里立刻看得出来。
      // 没有这个接口时，最贵的失败是「界面一片平静，队列其实没人消费」。
      // 免登录：它只说"有没有人在干活"，不吐路径、不吐任务内容。
      if (req.method === "GET" && path === "/api/health") {
        return json(res, 200, {
          ok: true,
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
          engine: process.env.WB_ENGINE || "mock",
          version: codeVersion(),
          worker: readHeartbeat(resolve(ROOT, "data", "worker.json")),
        });
      }

      if (path.startsWith("/api/") && authRequired && !me) return json(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && path === "/api/me") {
        return json(res, 200, { user: me, authRequired, roles: ROLES });
      }

      // ---- 成员管理（只有 lead） ----
      if (path === "/api/users" && req.method === "GET") {
        const c = can(me, "manage_users");
        if (!c.ok) return json(res, 403, { error: c.error });
        return json(res, 200, { users: listUsers(db).map(publicUser) });
      }
      if (path === "/api/users" && req.method === "POST") {
        const c = can(me, "manage_users");
        if (!c.ok) return json(res, 403, { error: c.error });
        const b = await readBody(req);
        if (!b.name) return json(res, 400, { error: "用户名必填" });
        try {
          const pw = b.password ? String(b.password) : null;
          const u = createUser(db, { name: b.name, role: b.role || "member", password: pw });
          // 没给口令就生成一个一次性口令，只回这一次（页面负责让人抄走）
          const oneTime = pw ? null : tempPassword();
          if (oneTime) setPassword(db, u.name, oneTime);
          return json(res, 201, { user: publicUser(getUser(db, u.name)), password: oneTime });
        } catch (e) {
          return json(res, 400, { error: String(e.message || e) });
        }
      }
      const um = path.match(/^\/api\/users\/([^/]+)$/);
      if (um && (req.method === "PATCH" || req.method === "POST")) {
        const c = can(me, "manage_users");
        if (!c.ok) return json(res, 403, { error: c.error });
        const b = await readBody(req);
        const name = decodeURIComponent(um[1]);
        try {
          // 重置口令：服务端生成一次性口令回给 lead 转述（页面只显示一次）
          let oneTime = null;
          if (b.reset) { oneTime = tempPassword(); setPassword(db, name, oneTime); }
          else if (b.password) setPassword(db, name, String(b.password));
          if (b.role) setRole(db, name, String(b.role));
          if (b.active !== undefined) setActive(db, name, !!b.active);
          return json(res, 200, { user: publicUser(getUser(db, name)), password: oneTime });
        } catch (e) {
          return json(res, 400, { error: String(e.message || e) });
        }
      }

      // ---- 任务 ----
      if (req.method === "GET" && path === "/api/tasks") {
        const state = url.searchParams.get("state");
        return json(res, 200, { tasks: listTasks(db, { state: state || null }) });
      }
      // "后台在跑什么"：增量事件流 + 每个在跑的任务此刻的角色/时长/是否静默。
      // 界面不该只有状态徽章——状态是结果，事件才是过程。
      if (req.method === "GET" && path === "/api/activity") {
        const since = Number(url.searchParams.get("since") || 0);
        const limit = Number(url.searchParams.get("limit") || 120);
        const task = url.searchParams.get("task") || null;
        const events = readFeed(db, { since, limit, task });
        return json(res, 200, {
          events,
          live: readLive(db),
          cursor: events.length ? events[events.length - 1].id : since,
        });
      }
      if (req.method === "GET" && path === "/api/workspace") {
        const { credentialStatus } = await import("../core/credentials.mjs");
        const c = credentialStatus(ROOT);
        return json(res, 200, {
          root: ROOT, code: CODE,
          starterRepo: resolve(ROOT, "demo"),
          engine: process.env.WB_ENGINE || "mock",
          ocHome: c.ocHome,
          credentials: { providerEnv: c.providerEnv, providers: c.providers },
          auth: { tokenRequired: authRequired, authRequired },
          me: me,
        });
      }
      if (req.method === "POST" && path === "/api/tasks") {
        const c = can(me, "create_task");
        if (!c.ok) return json(res, 403, { error: c.error });
        const b = await readBody(req);
        if (!b.title || !b.repo) return json(res, 400, { error: "title 与 repo 必填" });
        // 提交人只能是登录的人：身份来自会话，不来自请求体，否则「谁提交的」可以随便写。
        const t = createTask(db, {
          title: b.title, repo: b.repo, owner: me ? me.name : (b.owner || "unknown"),
          budgetTokens: Number(b.budgetTokens || process.env.WB_BUDGET || 1_000_000),
        });
        record(db, { taskId: t.id, type: "task.submitted", actor: me ? me.name : "unknown", payload: { role: me ? me.role : null } });
        return json(res, 201, { task: getTask(db, t.id) });
      }
      // ---- 项目 / 阶段链：开会 → 签字 → 开工 → 分流 ----------------
      // 这几条接口就是"人只做 3 次决定"的落点：目标对不对、边界够不够、要不要合。
      if (req.method === "GET" && path === "/api/projects") {
        return json(res, 200, { projects: listProjects(db) });
      }
      if (req.method === "POST" && path === "/api/projects") {
        const c = can(me, "create_project");
        if (!c.ok) return json(res, 403, { error: c.error });
        const b = await readBody(req);
        if (!b.title || !b.repo) return json(res, 400, { error: "title 与 repo 必填" });
        try {
          const p = createProject(db, {
            title: b.title, repo: b.repo, lane: b.lane,
            owner: me ? me.name : "unknown",
            budgetTokens: Number(b.budgetTokens || process.env.WB_BUDGET || 1_000_000),
            meetingBudget: Number(b.meetingBudget || 0),
          });
          return json(res, 201, { project: getProject(db, p.id) });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }
      const pm = path.match(/^\/api\/projects\/([^/]+)$/);
      if (req.method === "GET" && pm) {
        const p = getProject(db, pm[1]);
        if (!p) return json(res, 404, { error: "not found" });
        return json(res, 200, { project: p, events: eventsOfProject(db, p.id) });
      }

      // 预备会：机器先开，人之后再来看。默认走确定性模板（不烧 token）；
      // 配了真引擎才让 lead 参与改写目标 —— 开会本身也应该是可选的。
      const pmeet = path.match(/^\/api\/projects\/([^/]+)\/meeting$/);
      if (req.method === "POST" && pmeet) {
        const c = can(me, "meet_project");
        if (!c.ok) return json(res, 403, { error: c.error });
        let provider = null;
        if (String(process.env.WB_MEETING_ENGINE || "").length) {
          try { provider = getProvider(); } catch { provider = null; }
        }
        try {
          const p = await meetProject(db, pmeet[1], { provider });
          return json(res, 200, { project: p });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }

      const psign = path.match(/^\/api\/projects\/([^/]+)\/sign$/);
      if (req.method === "POST" && psign) {
        const c = can(me, "sign_stage");
        if (!c.ok) return json(res, 403, { error: c.error });
        const b = await readBody(req);
        try {
          const p = signStages(db, psign[1], { group: String(b.group || ""), by: me.name, role: me.role, note: b.note || null });
          return json(res, 200, { project: p });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }

      const pstart = path.match(/^\/api\/projects\/([^/]+)\/stages\/([^/]+)\/start$/);
      if (req.method === "POST" && pstart) {
        const c = can(me, "start_stage");
        if (!c.ok) return json(res, 403, { error: c.error });
        const b = await readBody(req);
        try {
          const out = startStage(db, pstart[1], decodeURIComponent(pstart[2]), {
            by: me.name, budgetTokens: b.budgetTokens ? Number(b.budgetTokens) : null,
          });
          return json(res, 201, { task: out.task, project: getProject(db, pstart[1]) });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }

      const pbl = path.match(/^\/api\/projects\/([^/]+)\/backlog\/([^/]+)$/);
      if (req.method === "POST" && pbl) {
        const c = can(me, "decide_backlog");
        if (!c.ok) return json(res, 403, { error: c.error });
        const b = await readBody(req);
        try {
          const p = decideBacklog(db, pbl[1], pbl[2], { status: String(b.status || ""), by: me.name, note: b.note || null });
          return json(res, 200, { project: p });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }

      const m = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const t = getTask(db, m[1]);
        if (!t) return json(res, 404, { error: "not found" });
        return json(res, 200, { task: t, events: readForTask(db, m[1]) });
      }

      // ---- 评审：领取 / 释放 / 初筛通过 / 打回 / 终审批准 ----
      const rv = path.match(/^\/api\/tasks\/([^/]+)\/review$/);
      if (req.method === "POST" && rv) {
        const b = await readBody(req);
        const action = String(b.action || "");
        const t = getTask(db, rv[1]);
        if (!t) return json(res, 404, { error: "not found" });
        if (!me) return json(res, 401, { error: "未登录" });
        const PERM = { claim: "claim_review", release: "release_review", pass: "pass_review", request_changes: "request_changes", approve: "approve" };
        const perm = PERM[action];
        if (!perm) return json(res, 400, { error: "action 只能是 " + Object.keys(PERM).join(" / ") });
        const c = can(me, perm, t);
        if (!c.ok) return json(res, 403, { error: c.error });

        const note = b.note ? String(b.note).trim().slice(0, 4000) : "";
        const base = { by: me.name, role: me.role, note: note || null };

        if (action === "claim") {
          record(db, { taskId: t.id, type: "review.claimed", actor: me.name, payload: { ...base, expires_at: Date.now() + REVIEW_TTL_MS } });
          return json(res, 200, { task: getTask(db, t.id) });
        }
        if (action === "release") {
          record(db, { taskId: t.id, type: "review.released", actor: me.name, payload: { by: me.name, reason: note || null } });
          return json(res, 200, { task: getTask(db, t.id) });
        }
        if (action === "request_changes") {
          if (!note) return json(res, 400, { error: "打回必须写理由——这是 coder 下一轮唯一的线索" });
          record(db, { taskId: t.id, type: "review.changes_requested", actor: me.name, payload: { ...base, stage: t.state } });
          addEvidence(db, t.id, { last_human_note: note }, "evidence.patch");
          record(db, {
            taskId: t.id, type: "attempt.reset", actor: me.name,
            payload: { reason: "human 打回：重试额度归零，上一轮证据留给 coder" },
          });
          transition(db, t.id, "queued", { actor: me.name, reason: "human request_changes" });
          return json(res, 200, { task: getTask(db, t.id) });
        }
        if (action === "pass") {
          record(db, { taskId: t.id, type: "review.passed", actor: me.name, payload: { ...base, waived: !!c.waived } });
          transition(db, t.id, "awaiting_approval", { actor: me.name, reason: "first review passed" });
          return json(res, 200, { task: getTask(db, t.id) });
        }
        // approve
        if (c.self_approved && !note) {
          return json(res, 400, { error: "自己提交的任务自己批，必须写理由（账本会标 self_approved 并统计）" });
        }
        record(db, {
          taskId: t.id, type: "human.decision", actor: me.name,
          payload: { decision: "approved", note: note || null, by: me.name, role: me.role, self_approved: !!c.self_approved, stage: t.state },
        });
        if (note) addEvidence(db, t.id, { last_human_note: note }, "evidence.patch");
        transition(db, t.id, "merging", { actor: me.name, reason: "approved" });
        return json(res, 200, { task: getTask(db, t.id) });
      }

      // 旧接口兼容：approve / reject 映射到 approve / request_changes
      const d = path.match(/^\/api\/tasks\/([^/]+)\/decision$/);
      if (req.method === "POST" && d) {
        const b = await readBody(req);
        const t = getTask(db, d[1]);
        if (!t) return json(res, 404, { error: "not found" });
        if (!me) return json(res, 401, { error: "未登录" });
        const action = b.decision === "approve" ? "approve" : "request_changes";
        const c = can(me, action === "approve" ? "approve" : "request_changes", t);
        if (!c.ok) return json(res, 403, { error: c.error });
        const note = b.note ? String(b.note).trim() : "";
        if (action === "request_changes" && !note) return json(res, 400, { error: "打回必须写理由" });
        if (action === "approve" && c.self_approved && !note) return json(res, 400, { error: "自己提交的任务自己批，必须写理由" });
        if (action === "request_changes") {
          record(db, { taskId: t.id, type: "review.changes_requested", actor: me.name, payload: { by: me.name, role: me.role, note, stage: t.state } });
          record(db, { taskId: t.id, type: "attempt.reset", actor: me.name, payload: { reason: "human 打回" } });
          transition(db, t.id, "queued", { actor: me.name, reason: "human request_changes" });
        } else {
          record(db, { taskId: t.id, type: "human.decision", actor: me.name, payload: { decision: "approved", note: note || null, by: me.name, role: me.role, self_approved: !!c.self_approved } });
          transition(db, t.id, "merging", { actor: me.name, reason: "approved" });
        }
        return json(res, 200, { task: getTask(db, t.id) });
      }

      if (req.method === "GET") {
        const rel = path === "/" ? "/index.html" : path;
        // 开了登录时，页面也挡住：没登录的人只能看到登录页（静态资源同理，除了登录页自己）
        if (authRequired && !me && rel !== "/login.html") {
          res.writeHead(302, { location: "/login.html", "cache-control": "no-store" });
          return res.end();
        }
        const file = resolveStatic(WEB, rel);
        if (!file) return json(res, 403, { error: "forbidden" });
        try {
          const body = await readFile(file);
          res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
          return res.end(body);
        } catch { return json(res, 404, { error: "not found" }); }
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (e) {
      return json(res, 500, { error: String(e && e.message || e) });
    }
  };
}

export function startServer() {
  watchParent({ log: (m) => process.stderr.write("[server] " + m + "\n") });
  const db = openDb();
  // 老账本自愈：单段待裁决 -> 两段评审；历史 owner 补成账号（锁住，等设口令）
  const migrated = migrateReviewStates(db);
  const legacy = ensureLegacyOwners(db);
  if (migrated) process.stdout.write("[server] 迁移 " + migrated + " 个待裁决任务到两段评审\n");
  if (legacy.length) process.stdout.write("[server] 历史 owner 已建成账号（未设口令）: " + legacy.join(", ") + "\n");
  const boot = ensureBootstrapAdmin(db);
  if (boot) {
    process.stdout.write("[server] 首次启动，已创建 lead 账号 " + boot.name + "\n");
    process.stdout.write("[server] 一次性口令: " + boot.password + "  （登录后请立刻改）\n");
  }
  const server = createServer(createApp(db));
  server.listen(PORT, HOST, () => {
    process.stdout.write("[server] http://" + HOST + ":" + PORT + (authEnabled(db) ? " (login required)" : " (open)") + "\n");
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server/index.mjs")) {
  startServer();
}
