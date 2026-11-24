#!/usr/bin/env node
import { openDb } from "./core/db.mjs";
import { createTask, getTask, listTasks, rebuild } from "./core/ledger.mjs";
import { readForTask } from "./core/events.mjs";
import { getProvider, listProviders } from "./runner/engine.mjs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { BUILTIN_ENGINES } from "./runner/providers/index.mjs";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];

async function main() {
  const db = openDb();
  if (cmd === "init") {
    process.stdout.write("账本就绪: data/ledger.db\n引擎: " + BUILTIN_ENGINES.join(", ") + "\n");
    return;
  }
  if (cmd === "enqueue") {
    const t = createTask(db, {
      title: arg("title"),
      repo: arg("repo", "sandbox/demo"),
      owner: arg("owner", process.env.USER || "unknown"),
      budgetTokens: Number(arg("budget", process.env.WB_BUDGET || 1_000_000)),
    });
    process.stdout.write(t.id + "\n");
    return;
  }
  if (cmd === "status") {
    const id = arg("id");
    if (id) {
      const t = getTask(db, id);
      if (!t) { process.stdout.write("不存在\n"); return; }
      process.stdout.write(JSON.stringify(t, null, 2) + "\n");
      for (const e of readForTask(db, id)) {
        process.stdout.write("  " + e.id + " " + e.ts + " " + e.type + " " + e.payload + "\n");
      }
      return;
    }
    for (const t of listTasks(db, { limit: 50 })) {
      process.stdout.write([t.id, t.state.padEnd(14), String(t.attempts).padStart(2), t.spent_tokens + "/" + t.budget_tokens, t.owner.padEnd(10), t.title].join("  ") + "\n");
    }
    return;
  }
  if (cmd === "rebuild") {
    process.stdout.write("重建投影，任务数: " + rebuild(db) + "\n");
    return;
  }
  if (cmd === "run") {
    const { watchParent } = await import("./core/orphan.mjs");
    watchParent({ log: (m) => process.stderr.write("[worker] " + m + "\n") });
    const { pump } = await import("./runner/worker.mjs");
    const engineName = process.env.WB_ENGINE || "mock";
    const provider = await getProvider(engineName);
    // WB_WORKER_ID 优先：脚本/截图/测试要能指定一个可预测的身份（默认 hostname:pid 会把机器名写进证据里）
    const workerId = arg("worker", process.env.WB_WORKER_ID || hostname() + ":" + process.pid);
    await pump(db, { workerId, provider, engine: engineName, once: process.argv.includes("--once") });
    return;
  }
  if (cmd === "workspace") {
    const { ensureWorkspace } = await import("./core/workspace.mjs");
    const w = ensureWorkspace(arg("dir", process.env.WB_WORKSPACE || join(homedir(), "Workbench")));
    process.stdout.write(JSON.stringify(w) + "\n");
    return;
  }
  if (cmd === "cred") {
    // 凭据只搬不打印：输出里永远只有文件种类和 provider 名字。
    const { credentialStatus, importCredentials } = await import("./core/credentials.mjs");
    const root = arg("dir", process.env.WB_ROOT || process.env.WB_WORKSPACE || process.cwd());
    const sub = process.argv[3];
    if (sub === "import") {
      const from = arg("from");
      if (!from) {
        process.stdout.write("用法: cli.mjs cred import --from <已有 .oc 目录> [--dir <工作区>]\n");
        process.exit(2);
      }
      const r = importCredentials(from, root);
      process.stdout.write(JSON.stringify({ imported: r.copied, ocHome: r.ocHome, providerEnv: r.providerEnv, providers: r.providers }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify(credentialStatus(root)) + "\n");
    return;
  }
  if (cmd === "user") {
    const u = await import("./core/users.mjs");
    const sub = process.argv[3] || "list";
    if (sub === "add") {
      const name = arg("name");
      const role = arg("role", "member");
      const pw = arg("password");
      if (!name) { process.stdout.write("用法: cli.mjs user add --name <名字> [--role lead|member|viewer] [--password <口令>]\n"); process.exit(2); }
      const oneTime = pw ? null : u.tempPassword();
      u.createUser(db, { name, role, password: pw || oneTime });
      process.stdout.write("已创建 " + name + " (" + role + ")\n");
      if (oneTime) process.stdout.write("一次性口令: " + oneTime + "\n");
      return;
    }
    if (sub === "passwd") {
      const name = arg("name");
      const pw = arg("password");
      if (!name) { process.stdout.write("用法: cli.mjs user passwd --name <名字> [--password <口令>]\n"); process.exit(2); }
      const oneTime = pw || u.tempPassword();
      u.setPassword(db, name, oneTime);
      process.stdout.write("已重置 " + name + " 的口令: " + oneTime + "\n（旧登录全部失效）\n");
      return;
    }
    if (sub === "role") {
      u.setRole(db, arg("name"), arg("role"));
      process.stdout.write("已改角色: " + arg("name") + " -> " + arg("role") + "\n");
      return;
    }
    if (sub === "disable" || sub === "enable") {
      u.setActive(db, arg("name"), sub === "enable");
      process.stdout.write("已" + (sub === "enable" ? "启用" : "停用") + ": " + arg("name") + "\n");
      return;
    }
    for (const x of u.listUsers(db)) {
      process.stdout.write([x.name.padEnd(12), x.role.padEnd(7), x.active ? "active" : "locked", x.password_hash ? "" : "(未设口令)"].join("  ") + "\n");
    }
    return;
  }
  // ---- 项目 / 阶段链 ----------------
  // 这条链路是"人只 review"的骨架：开会（机器）→ 签字（人，2 次）→ 开工（机器）→ 合（人，1 次）。
  if (cmd === "project") {
    const st = await import("./core/stages.mjs");
    const sub = process.argv[3];
    const id = arg("id", process.argv[4]);
    if (sub === "new") {
      const p = st.createProject(db, {
        title: arg("title"), repo: arg("repo", "demo"), lane: arg("lane", "feature"),
        owner: arg("owner", process.env.USER || "unknown"),
        budgetTokens: Number(arg("budget", process.env.WB_BUDGET || 1_000_000)),
      });
      process.stdout.write(p.id + "\n");
      return;
    }
    if (sub === "list" || !sub) {
      for (const p of st.listProjects(db)) {
        const done = p.stages.filter((s) => s.state === "done").length;
        process.stdout.write([p.id, p.state.padEnd(9), p.lane.padEnd(8), done + "/" + p.stages.length + " 阶段", "backlog " + p.open_backlog, p.title].join("  ") + "\n");
      }
      return;
    }
    if (sub === "show") {
      const p = st.getProject(db, id);
      if (!p) { process.stdout.write("不存在: " + id + "\n"); return; }
      process.stdout.write(p.title + "  [" + p.state + ", " + p.lane + "]\n" + (p.summary || "") + "\n");
      for (const s of p.stages) {
        process.stdout.write("  " + s.seq + ". " + s.name.padEnd(4) + " " + s.state.padEnd(9) + " 组" + s.signature_group +
          "  产出[" + s.artifacts.join(",") + "]  边界[" + s.allowedGlobs.join(",") + "]  " + (s.task_id || "") + "\n");
        process.stdout.write("     目标: " + s.goal + "\n");
      }
      for (const b of p.backlog) {
        process.stdout.write("  backlog " + b.id + " [" + b.status + "] " + b.text + "\n");
      }
      return;
    }
    if (sub === "meet") {
      let provider = null;
      if (arg("engine")) {
        process.env.WB_ENGINE = arg("engine");
        if (arg("model")) process.env.WB_MODEL = arg("model");
        provider = await getProvider(arg("engine"));
      }
      const p = await st.meetProject(db, id, { provider });
      process.stdout.write("预备会开完（" + (p.summary || "") + "）\n");
      for (const s of p.stages) process.stdout.write("  " + s.seq + ". " + s.name + " - " + s.goal + "\n");
      return;
    }
    if (sub === "sign") {
      const p = st.signStages(db, id, { group: arg("group", "A"), by: arg("by", process.env.USER || "lead"), note: arg("note") });
      process.stdout.write("已签字（组 " + arg("group", "A") + "），项目状态 " + p.state + "\n");
      return;
    }
    if (sub === "start") {
      const out = st.startStage(db, id, process.argv[4], { by: arg("by", process.env.USER || "unknown"), budgetTokens: arg("budget") ? Number(arg("budget")) : null });
      process.stdout.write("已开工: " + out.task.id + "（阶段 " + (out.stage && out.stage.name) + "）\n");
      return;
    }
    if (sub === "backlog") {
      const p = st.decideBacklog(db, arg("id", process.argv[4]), process.argv[5], { status: arg("decide"), by: arg("by", process.env.USER || "unknown") });
      process.stdout.write("已分流，剩余 open: " + st.openBacklogCount(db, p.id) + "\n");
      return;
    }
    process.stdout.write("用法: cli.mjs project <new|list|show|meet|sign|start|backlog>\n");
    return;
  }
  // 一条命令起整套：server + 看护着的 worker。
  // 外壳只 spawn 这一个进程，worker 崩了由这里的 supervise 拉起来 —— 人不用守着。
  if (cmd === "up") {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const { supervise } = await import("./core/supervisor.mjs");
    const { watchParent } = await import("./core/orphan.mjs");
    const log = (m) => process.stderr.write("[up] " + m + "\n");
    watchParent({ log });
    const self = fileURLToPath(import.meta.url);
    const here = dirname(self);
    const env = { ...process.env, WB_PARENT_PID: String(process.pid) };
    const kids = [];
    const launch = (args) => {
      const p = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", (d) => process.stdout.write(d));
      p.stderr.on("data", (d) => process.stderr.write(d));
      kids.push(p);
      return p;
    };
    let exiting = false;
    const shutdown = (code) => {
      if (exiting) return;
      exiting = true;
      try { sup.stop(); } catch {}
      for (const k of kids) { try { k.kill("SIGTERM"); } catch {} }
      setTimeout(() => process.exit(code), 250).unref();
    };
    const server = launch([join(here, "server", "index.mjs")]);
    const sup = supervise(() => launch([self, "run"]), {
      log,
      onExit: (code, signal, s) => {
        if (s.restarts >= 3) log("worker 连续退出 " + s.restarts + " 次，界面 /api/health 会显示断线");
      },
    });
    process.on("SIGTERM", () => shutdown(0));
    process.on("SIGINT", () => shutdown(0));
    server.once("exit", (code, signal) => {
      process.stderr.write("[up] server 退出 code=" + code + " signal=" + signal + "，整体收工\n");
      shutdown(code || 1);
    });
    log("server pid=" + server.pid + " worker pid=" + (sup.child() && sup.child().pid));
    await new Promise(() => {});
    return;
  }
  if (cmd === "serve") {
    const { startServer } = await import("./server/index.mjs");
    startServer();
    return;
  }
  process.stdout.write("用法: cli.mjs <init|workspace|cred|user|project|enqueue|status|rebuild|run|serve|up>\n");
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
