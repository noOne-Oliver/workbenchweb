const TOKEN = new URLSearchParams(location.search).get("token") || "";
const api = (p, opts) =>
  fetch(p, {
    ...opts,
    headers: { "content-type": "application/json", ...(TOKEN ? { "x-wb-token": TOKEN } : {}), ...(opts?.headers || {}) },
  }).then((r) => {
    // 服务端开了口令、cookie 又过期了：别在页面上显示一堆 401，直接回登录页
    if (r.status === 401) {
      location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
      throw new Error("unauthorized");
    }
    return r;
  });

const RUNNING = new Set(["queued", "planning", "implementing", "verifying", "reviewing", "merging"]);
const LABEL = {
  queued: "排队", planning: "拆解中", implementing: "实现中", verifying: "验证中",
  reviewing: "初审中", awaiting_review: "待初筛", awaiting_approval: "待批准",
  awaiting_human: "待裁决", merging: "合并中", done: "已完成",
  failed: "失败", blocked: "已阻塞",
};
const ROLE_LABEL = { lead: "lead（终审）", member: "member（初筛）", viewer: "viewer（只读）" };

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const secs = (s) => (s == null ? "" : s < 60 ? s + "s" : Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s");
const hhmmss = (ts) => { try { return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return ""; } };

let tasks = [];
// 身份来自服务端会话（/api/workspace 的 me），不再让人自己填字符串——能绕过 UI 的才叫身份。
let ME = "";
let ROLE = "viewer";
const isLead = () => ROLE === "lead";
const isViewer = () => ROLE === "viewer";
let feed = [];          // 最近的活动事件（升序）
let live = [];          // 每个在跑的任务此刻在做什么
let cursor = 0;         // 增量拉取的游标（事件 id）
let filterTask = null;  // 只看某个任务的时间线

/** 事件 -> 人话。这是"后台在跑什么"的翻译层：没有它，人只能看到状态徽章。 */
function describe(e) {
  const p = e.payload || {};
  switch (e.type) {
    case "task.created": return ["提交", "预算 " + fmt(p.budget_tokens) + (p.owner ? " · owner " + p.owner : "")];
    case "task.transition": return ["状态", (LABEL[p.from] || p.from) + " → " + (LABEL[p.to] || p.to) + (p.reason ? "（" + p.reason + "）" : "")];
    case "attempt.started": return ["尝试", "第 " + (Number(p.attempt) + 1) + " 次"];
    case "attempt.resumed": return ["续跑", "崩溃后接着第 " + (Number(p.attempt) + 1) + " 次（不烧重试额度）"];
    case "attempt.reset": return ["重置", p.reason || "重试额度归零"];
    case "plan.produced": return ["方案", p.plan_md ? String(p.plan_md).length + " 字" : "已产出"];
    case "slices.produced": return ["切片", p.slices ? String(p.slices).length + " 字" : "已产出"];
    case "impl.produced": return ["实现", p.diff_stat || "已提交"];
    case "verify.result": {
      const v = (p.verify && p.verify.verdict) || {};
      const g = (p.verify && p.verify.guards) || [];
      return ["验证", "护栏 " + g.filter((c) => c.ok).length + "/" + g.length + " · Verifier " + (v.verdict || "?")];
    }
    case "review.result": {
      const v = (p.review && p.review.verdict) || {};
      return ["初审", (v.verdict || "?") + (v.summary ? "：" + v.summary : "")];
    }
    case "agent.started": return ["开工", p.role + " · 提示 " + fmt(p.prompt_chars) + " 字"];
    case "agent.finished": return ["完成", p.role + " · " + fmt(p.tokens) + " tok · " + (p.ms >= 1000 ? Math.round(p.ms / 1000) + "s" : p.ms + "ms") + (p.ok ? "" : " · 失败")];
    case "budget.spent": return ["预算", "+" + fmt(p.tokens) + " tok" + (p.detail && p.detail.role ? " · " + p.detail.role : "")];
    case "run.error": return ["错误", p.error || ""];
    case "human.decision": return ["终审", p.decision + (p.self_approved ? "（自己批的，已标红）" : "") + (p.note ? "：" + p.note : "")];
    case "task.submitted": return ["提交", "身份 " + (p.role || "?")];
    case "review.claimed": return ["领取初筛", p.by + " · 30 分钟内有效"];
    case "review.released": return ["释放初筛", p.by || ""];
    case "review.passed": return ["初筛通过", p.by + (p.waived ? "（lead 直接终审，记 waived）" : "") + (p.note ? "：" + p.note : "")];
    case "review.changes_requested": return ["打回", p.by + "（" + (p.stage === "awaiting_review" ? "初筛" : "终审") + "）" + (p.note ? "：" + p.note : "")];
    case "merge.done": return ["合并", String(p.sha || "").slice(0, 7)];
    case "project.created": return ["建项目", p.title + "（" + (p.lane === "chore" ? "杂活：不开会" : "功能：要开会") + "）"];
    case "project.meeting": return ["预备会", "拆成 " + ((p.stages && p.stages.length) || "?") + " 个阶段 · 你只需 2 次签字 · 约 " + (p.human_minutes || "?") + " 分钟"];
    case "project.transition": return ["项目", (PROJ_LABEL[p.from] || p.from) + " → " + (PROJ_LABEL[p.to] || p.to)];
    case "stage.transition": return ["阶段", (p.name || "?") + "：" + (STAGE_LABEL[p.from] || p.from) + " → " + (STAGE_LABEL[p.to] || p.to) + (p.reason ? "（" + p.reason + "）" : "")];
    case "stage.assigned": return ["阶段开工", "阶段挂了任务 " + String(p.task_id || "").slice(0, 14)];
    case "stage.signed": return ["签字", p.group + " 组（" + ((p.covers && p.covers.join("+")) || "?") + "）· " + (p.by || "") + (p.note ? "：" + p.note : "")];
    case "backlog.added": return ["发散项", String(p.text || "").slice(0, 90)];
    case "backlog.decided": return ["分流", String(p.status || "") + (p.by ? " · " + p.by : "")];
    case "task.scoped": return ["挂阶段", "任务被限定在一个阶段的边界内"];
    case "lease.acquired": return ["租约", "被 " + (p.owner || "?") + " 认领"];
    case "lease.released": return ["租约", "释放"];
    case "lease.lost": return ["租约", "丢失，被别的 worker 接手"];
    case "evidence.patch": return ["证据", "更新"];
    default: return [e.type, ""];
  }
}

// ---- 改动 diff：按文件分组、带行号、可只看改动 ----
// 之前是一整块 <pre>（max-height 220px），一屏只能看到几行，还套在页面的滚动里，
// 滚轮根本划不到头。现在每一行是独立的行，页面只有一层滚动。

function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const ln of String(text || "").split("\n")) {
    if (ln.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(ln);
      cur = { path: m ? m[1] : ln.slice(11), add: 0, del: 0, o: 0, n: 0, rows: [] };
      files.push(cur);
      continue;
    }
    if (!cur || ln === "\ No newline at end of file") continue;
    if (ln.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
      if (m) { cur.o = Number(m[1]); cur.n = Number(m[2]); }
      cur.rows.push({ t: "h", text: ln });
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |Binary )/.test(ln)) continue;
    const t = ln[0] === "+" ? "a" : ln[0] === "-" ? "d" : "c";
    const row = { t, text: ln.slice(1) };
    if (t === "a") { row.n = cur.n; cur.n += 1; cur.add += 1; }
    else if (t === "d") { row.o = cur.o; cur.o += 1; cur.del += 1; }
    else { row.o = cur.o; row.n = cur.n; cur.o += 1; cur.n += 1; }
    cur.rows.push(row);
  }
  return files;
}

function diffRow(r) {
  if (r.t === "h") {
    return '<div class="dlrow h"><span class="ln"></span><span class="ln"></span><span class="dlt">' + esc(r.text) + "</span></div>";
  }
  const mark = r.t === "a" ? "+" : r.t === "d" ? "−" : " ";
  return '<div class="dlrow ' + r.t + '"><span class="ln">' + (r.o == null ? "" : r.o) + '</span><span class="ln">' +
    (r.n == null ? "" : r.n) + '</span><span class="dlt"><span class="mark">' + esc(mark) + "</span>" + esc(r.text) + "</span></div>";
}

function diffSection(diff) {
  const files = parseDiff(diff);
  if (!files.length) return "";
  const body = files.map((f) => {
    const changed = f.rows.some((r) => r.t !== "c");
    return '<details class="dfile" open><summary><span class="fname">' + esc(f.path) + "</span>" +
      '<span class="plus">+' + f.add + '</span><span class="minus">−' + f.del + "</span>" +
      (changed ? "" : '<span class="dim">（只有上下文，没改动）</span>') + "</summary>" +
      '<div class="dlines">' + f.rows.map(diffRow).join("") + "</div></details>";
  }).join("");
  return '<div class="diffbar"><span>改动 diff</span>' +
    '<button class="ghost" onclick="toggleCtx(this)">只看改动</button></div>' + body;
}

function toggleCtx(btn) {
  const only = btn.dataset.on !== "1";
  btn.dataset.on = only ? "1" : "0";
  btn.textContent = only ? "显示全部上下文" : "只看改动";
  document.querySelectorAll(".dlines").forEach((d) => d.classList.toggle("only", only));
}

// ---- 测试结果：用例清单（失败的置顶）+ 回归对比 ----
function caseList(cases) {
  return '<ul class="cases">' + cases.map((c) =>
    '<li class="' + (c.ok ? "yes" : "no") + '"><span class="mark">' + (c.ok ? "✓" : "✗") + "</span>" +
    '<span class="nm">' + esc(c.name) + "</span>" +
    (c.detail && c.detail.length ? '<div class="why">' + esc(c.detail.slice(0, 2).join(" ")) + "</div>" : "") +
    "</li>").join("") + "</ul>";
}

function testSection(v, id) {
  const tc = v.testCases;
  const b = v.baseline;
  const out = [];
  if (tc && tc.total) {
    out.push('<div class="row">测试 <b>' + tc.total + "</b> 条 · " +
      '<span class="ok">' + tc.pass + " 通过</span>" +
      (tc.fail ? ' · <span class="bad">' + tc.fail + " 失败</span>" : "") + "</div>");
    const failed = tc.cases.filter((c) => !c.ok);
    if (failed.length) out.push(caseList(failed));
    const passed = tc.cases.filter((c) => c.ok);
    if (passed.length) {
      out.push('<details class="cases-box"><summary>通过的 ' + passed.length + " 条用例</summary>" + caseList(passed) + "</details>");
    }
  }
  if (b) {
    out.push('<div class="row">回归：' + (b.regressions.length
      ? '<span class="bad">' + b.regressions.length + " 条回退（" + esc(b.regressions.slice(0, 4).join("、")) + "）</span>"
      : '<span class="ok">0 条回退</span>') +
      " · 既有 " + b.pass + " 条绿" +
      (b.added.length ? " · 新增 " + b.added.length + " 条" : "") +
      (b.fixed.length ? " · 修好 " + b.fixed.length + " 条" : "") +
      (b.ok ? "" : " · 基线本身有 " + b.fail + " 条失败") + "</div>");
  } else if (tc && tc.total) {
    out.push('<div class="row dim">回归：没取到基线（base 提交里没有测试），只验证了当前全绿</div>');
  }
  if (v.testOutputTail) out.push('<button class="ghost" onclick="openRaw(\'' + id + '\')">全屏看原始输出</button>');
  return out.join("");
}

function openRaw(id) {
  const t = tasks.find((x) => x.id === id);
  const ev = (t && t.evidence) || {};
  const v = ev.verify || {};
  el("rv-title").textContent = "测试原始输出 · " + (t ? t.title : id) + (v.testCmd ? "（" + v.testCmd + "）" : "");
  el("rv-body").textContent = v.testOutputTail || "（没有输出）";
  el("raw-viewer").showModal();
}

async function load() {
  try {
    const r = await api("/api/tasks");
    const j = await r.json();
    tasks = j.tasks || [];
    render();
  } catch (e) {
    el("clock").textContent = "连接失败: " + e.message;
  }
}

/** 卡片上的"此刻"：跑的是哪个角色、多久了、是不是已经没动静了。 */
function liveLine(t) {
  const l = live.find((x) => x.taskId === t.id);
  if (!l) return "";
  const dead = l.stalled ? ' <span class="badge bad">⚠ ' + l.silent_s + "s 无事件，worker 可能已停</span>" : "";
  if (l.role) {
    return '<div class="row live"><span class="dot"></span><b>' + esc(l.role) + "</b> 正在跑 · 已 " + esc(secs(l.elapsed_s)) + dead + "</div>";
  }
  if (l.last_type) {
    const d = describe({ type: l.last_type, payload: {} });
    return '<div class="row live"><span class="dot idle"></span>最近：' + esc(d[0]) + (l.silent_s != null ? " · " + esc(secs(l.silent_s)) + " 前" : "") + dead + "</div>";
  }
  return "";
}

/** 谁在哪个环节：这两行决定「以为别人在看」不会发生。 */
function reviewBlock(t) {
  const rows = [];
  rows.push('<div class="row"><span>提交人: <b>' + esc(t.owner) + "</b></span>" +
    (t.first_reviewed_by ? "<span>初筛: " + esc(t.first_reviewed_by) + "</span>" : "") +
    (t.approved_by ? "<span>批准: " + esc(t.approved_by) + (t.self_approved ? " ⚠ self" : "") + "</span>" : "") +
    (t.review_seconds != null ? "<span>初筛用了 " + t.review_seconds + "s</span>" : "") +
    (t.approval_seconds != null ? "<span>终审用了 " + t.approval_seconds + "s</span>" : "") +
    "</div>");
  if (t.state === "awaiting_review" && t.reviewer) {
    const left = Math.max(0, Math.round((Number(t.review_lease_expires_at || 0) - Date.now()) / 60000));
    rows.push(left > 0
      ? '<div class="row">初筛领取人: <b>' + esc(t.reviewer) + "</b> · 锁 " + left + " 分钟</div>"
      : '<div class="row" style="color:var(--warn)">' + esc(t.reviewer) + " 的领取已超时，可以接手</div>");
  }
  if (t.owner === ME) {
    rows.push('<div class="row" style="color:var(--warn)">这是你自己提交的任务：终审必须别的 lead 批；自己批要写理由，账本标 self_approved 并进统计。</div>');
  }
  return rows.join("");
}

function reviewActions(t) {
  if (isViewer()) return '<div class="row hint">只读账号：可以看，不能裁决</div>';
  const btn = (action, cls, label) => '<button class="' + cls + '" onclick="reviewAction(\'' + t.id + '\',\'' + action + '\')">' + label + "</button>";
  const timeline = '<button class="ghost" onclick="watch(\'' + t.id + '\')">看时间线</button>';

  if (t.state === "awaiting_review") {
    const expired = t.reviewer && Number(t.review_lease_expires_at || 0) < Date.now();
    const canClaim = !t.reviewer || expired;
    const mine = t.reviewer === ME;
    const out = [];
    if (canClaim) out.push(btn("claim", "ghost", "领取初筛（锁 30 分钟）"));
    if (mine) out.push(btn("pass", "primary", "初筛通过 → 交给 lead 终审"));
    else if (isLead()) out.push(btn("pass", "primary", "lead 直接初筛通过（记 waived）"));
    out.push(btn("request_changes", "danger", "打回重做"));
    return '<textarea id="note-' + t.id + '" placeholder="打回必须写理由——这是 coder 下一轮唯一的线索"></textarea>' +
      '<div class="actions">' + out.join("") + timeline + "</div>";
  }
  if (t.state === "awaiting_approval" || t.state === "awaiting_human") {
    if (!isLead()) return '<div class="row hint">已初筛通过，等 lead 终审（member 的权限到初筛为止）</div>' +
      '<div class="actions">' + timeline + "</div>";
    const self = t.owner === ME;
    return '<textarea id="note-' + t.id + '" placeholder="' + (self ? "自己提交自己批，必须写理由" : "批注（可选）") + '"></textarea>' +
      '<div class="actions">' +
      btn("approve", "primary", self ? "自己批准并合并（标红 + 统计）" : "批准并合并") +
      btn("request_changes", "danger", "打回重做") + timeline + "</div>";
  }
  return "";
}

function card(t, actionable) {
  const ev = t.evidence || {};
  const v = ev.verify || {};
  const rv = ev.review || {};
  const checks = (v.guards || []).map((c) =>
    '<li class="' + (c.ok ? "yes" : "no") + '">' + (c.ok ? "✓ " : "✗ ") + esc(c.id) + " — " + esc(c.detail) + "</li>").join("");
  const raised = (rv.raised || []).map((x) => "<li>" + esc(x) + "</li>").join("");
  return '<div class="card ' + (actionable ? "awaiting" : "") + (t.self_approved ? " self" : "") + '">' +
    "<h3>" + esc(t.title) + "</h3>" +
    '<div class="row"><span class="badge">' + (LABEL[t.state] || t.state) + "</span>" +
      "<span>提交 " + esc(t.owner) + "</span>" +
      "<span>尝试 " + t.attempts + "</span>" +
      "<span>预算 " + fmt(t.spent_tokens) + "/" + fmt(t.budget_tokens) + "</span>" +
      (t.review_seconds != null ? "<span>初筛 " + t.review_seconds + "s</span>" : "") +
    "</div>" +
    (t.stage_id ? '<div class="row"><span class="badge">' + esc(stageTag(t)) + "</span></div>" : "") +
    liveLine(t) +
    (t.diff_stat ? '<div class="row mono">' + esc(t.diff_stat) + "</div>" : "") +
    (v.verdict ? '<div class="row">Verifier: <span class="badge ' + (v.passed ? "ok" : "bad") + '">' + esc(v.verdict.summary || "") + "</span></div>" : "") +
    (checks ? '<details><summary>机器护栏 (' + (v.guards || []).filter((c) => c.ok).length + "/" + (v.guards || []).length + ')</summary><ul class="checks">' + checks + "</ul></details>" : "") +
    (raised ? '<div class="row">初审上抛：</div><ul class="raised">' + raised + "</ul>" : "") +
    (v.diff ? diffSection(v.diff) : "") +
    testSection(v, t.id) +
    (ev.last_error ? '<div class="row" style="color:var(--bad)">最近错误: ' + esc(ev.last_error) + "</div>" : "") +
    reviewBlock(t) +
    (actionable ? reviewActions(t) : "") +
    (actionable ? "" : "") +
    "</div>";
}

/** 任务卡上的「属于哪个项目的哪个阶段」——否则阶段链跑起来后，卡片看不出彼此的关系。 */
function stageTag(t) {
  const p = projects.find((x) => x.id === t.project_id);
  const s = p && (p.stages || []).find((x) => x.stage_id === t.stage_id);
  if (!p || !s) return "阶段任务";
  return "项目 " + p.title + " · 阶段 " + s.seq + " " + s.name;
}

const AWAITING = new Set(["awaiting_review", "awaiting_approval", "awaiting_human"]);

function render() {
  // 初筛在前、终审在后：先来先看，别让一条终审把初筛队列挡住。
  const awaiting = tasks.filter((t) => AWAITING.has(t.state))
    .sort((a, b) => (a.state === "awaiting_review" ? 0 : 1) - (b.state === "awaiting_review" ? 0 : 1));
  const running = tasks.filter((t) => RUNNING.has(t.state));
  const done = tasks.filter((t) => ["done", "failed", "blocked"].includes(t.state));

  el("awaiting").innerHTML = awaiting.length ? awaiting.map((t) => card(t, true)).join("") : '<div class="empty">没有待处理的任务</div>';
  el("running").innerHTML = running.length ? running.map((t) => card(t, false)).join("") : '<div class="empty">后台空闲</div>';
  el("done").innerHTML = done.length ? done.slice(0, 20).map((t) => card(t, false)).join("") : '<div class="empty">暂无归档</div>';

  el("n-await").textContent = awaiting.length;
  el("n-run").textContent = running.length;
  el("n-done").textContent = done.length;
  el("clock").textContent = "更新于 " + new Date().toLocaleTimeString();
}

function renderFeed() {
  const box = el("events");
  if (!box) return;
  // 心跳只用来判断"还活着"，逐条刷屏没意义；卡片上的计时器已经在走。
  const rows = feed.filter((e) => e.type !== "agent.heartbeat");
  box.innerHTML = rows.length ? rows.slice(-200).map((e) => {
    const d = describe(e);
    return '<li><time>' + esc(hhmmss(e.ts)) + "</time>" +
      (filterTask ? "" : '<span class="who">' + esc(e.title || (e.taskId || "系统")) + "</span>") +
      '<span class="tag">' + esc(d[0]) + "</span>" +
      '<span class="det">' + esc(d[1]) + "</span></li>";
  }).join("") : '<li class="empty">还没有事件</li>';
  el("n-act").textContent = String(rows.length);

  const chip = el("filter-chip");
  if (chip) {
    if (filterTask) {
      const t = tasks.find((x) => x.id === filterTask);
      chip.textContent = "只看：" + (t ? t.title : filterTask) + " ✕";
      chip.style.display = "";
    } else {
      chip.style.display = "none";
    }
  }
  // 跟着最新一条走，除非用户在往上翻历史；首屏（刚填满 160 条）必须直接落到底
  const first = box.dataset.init !== "1";
  box.dataset.init = "1";
  const near = first || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (near) box.scrollTop = box.scrollHeight;
}

async function loadFeed() {
  try {
    let q = "/api/activity?limit=160";
    if (filterTask) q += "&task=" + encodeURIComponent(filterTask);
    if (cursor) q += "&since=" + cursor;
    const r = await api(q);
    if (!r.ok) return;
    const j = await r.json();
    live = j.live || [];
    if (!cursor) feed = j.events || [];
    else if ((j.events || []).length) feed = feed.concat(j.events);
    cursor = j.cursor || cursor;
    if (feed.length > 600) feed = feed.slice(-600);
    renderFeed();
    render();
  } catch { /* 服务端暂时不可达：保持上一帧，别把界面刷成错误页 */ }
}

window.watch = function (id) {
  filterTask = filterTask === id ? null : id;
  feed = [];
  cursor = 0;
  loadFeed();
};
window.clearFilter = function () { filterTask = null; feed = []; cursor = 0; loadFeed(); };
window.logout = async function () {
  await fetch("/api/logout", { method: "POST" });
  location.replace("/login.html");
};
// 模块作用域的函数不会自动挂到 window 上，内联 onclick 找不到它们（这里显式导出）
window.toggleCtx = toggleCtx;
window.openRaw = openRaw;

// 评审动作只有一个入口：服务端按角色判权限，前端只负责别显示不该点的按钮。
window.reviewAction = async function (id, action) {
  const note = ((document.getElementById("note-" + id) || {}).value || "").trim();
  if (action === "request_changes" && !note) { alert("打回必须写理由——这是 coder 下一轮唯一的线索"); return; }
  const t = tasks.find((x) => x.id === id);
  if (action === "approve" && t && t.owner === ME && !note) { alert("自己提交的任务自己批，必须写理由"); return; }
  const r = await api("/api/tasks/" + id + "/review", {
    method: "POST",
    body: JSON.stringify({ action, note }),
  });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "操作失败"); return; }
  await load();
  await loadFeed();
};

// 新建任务：打包后的 app 没有终端，这里是唯一入口。
async function loadWorkspace() {
  try {
    const r = await api("/api/workspace");
    const w = await r.json();
    const info = el("ws-info");
    if (info) {
      const c = w.credentials || {};
      const cred = w.engine === "mock" ? "假引擎" : (c.providerEnv ? "凭据已就位" + (c.providers && c.providers.length ? "（" + c.providers.join(", ") + "）" : "") : "缺凭据：把 provider.env 放进 " + (w.ocHome || "工作区/.oc") + "/private/");
      info.textContent = "工作区 " + w.root + " · 内核 " + w.code + " · 引擎 " + w.engine + " · " + cred;
    }
    const repo = el("t-repo");
    if (repo && !repo.value) repo.value = w.starterRepo;
    const prepo = el("p-repo");
    if (prepo && !prepo.value) prepo.value = w.starterRepo;

    // 身份以服务端为准：右上角显示「谁 + 什么角色」，按钮由角色决定。
    if (w.me) { ME = w.me.name || ""; ROLE = w.me.role || "viewer"; }
    const who = el("who");
    if (who) who.innerHTML = esc(ME || "未登录") + ' <span class="badge">' + esc(ROLE_LABEL[ROLE] || ROLE) + "</span>";
    const logout = el("logout");
    if (logout && w.auth && w.auth.authRequired) logout.hidden = false;
    const teamBtn = el("team-btn");
    if (teamBtn) teamBtn.hidden = !isLead();
    const compose = el("compose");
    if (compose) compose.hidden = isViewer();
  } catch { /* 老内核没有这个接口，忽略 */ }
}

// ---- 成员管理（只有 lead 看得见；服务端仍会 403） ----
async function fetchUsers() {
  const r = await api("/api/users");
  if (!r.ok) return [];
  return (await r.json()).users || [];
}

function teamRow(u) {
  // 名字只进 data-*，不进内联 onclick：onclick="f('名字')" 只要名字里有单引号就能跳出字符串。
  const n = esc(u.name);
  return "<tr><td>" + n + "</td><td>" + esc(ROLE_LABEL[u.role] || u.role) + "</td><td>" +
    (u.active ? (u.hasPassword ? "可登录" : "未设口令") : "已停用") + "</td><td>" +
    '<button class="ghost" data-act="reset" data-name="' + n + '">重置口令</button>' +
    '<button class="ghost" data-act="' + (u.active ? "disable" : "enable") + '" data-name="' + n + '">' +
    (u.active ? "停用" : "启用") + "</button></td></tr>";
}

window.openTeam = async function () {
  const dlg = el("team");
  const box = el("team-body");
  if (box && !box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("click", (ev) => {
      const btn = ev.target.closest ? ev.target.closest("button[data-act]") : null;
      if (!btn) return;
      const name = btn.dataset.name;
      if (btn.dataset.act === "reset") return resetPassword(name);
      return toggleUser(name, btn.dataset.act === "enable");
    });
  }
  if (!dlg.open) dlg.showModal();
  box.innerHTML = '<div class="hint">加载中…</div>';
  const users = await fetchUsers();
  box.innerHTML = '<table class="users"><thead><tr><th>名字</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
    users.map(teamRow).join("") + "</tbody></table>" +
    '<form id="add-user" class="adduser" autocomplete="off">' +
    '<input id="u-name" placeholder="名字" size="12" required />' +
    '<select id="u-role"><option value="member">member</option><option value="lead">lead</option><option value="viewer">viewer</option></select>' +
    '<button class="primary" type="submit">加人（生成一次性口令）</button></form>' +
    '<div id="team-msg" class="mono"></div>';
  el("add-user").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await api("/api/users", { method: "POST", body: JSON.stringify({ name: el("u-name").value.trim(), role: el("u-role").value }) });
    const j = await r.json();
    if (!r.ok) { el("team-msg").textContent = j.error || "失败"; return; }
    el("team-msg").textContent = "已创建 " + j.user.name + "（" + j.user.role + "）一次性口令：" + (j.password || "（无）") + " —— 只显示这一次";
    el("u-name").value = "";
    await refreshTeam();
  });
};

async function refreshTeam() {
  const users = await fetchUsers();
  const tbody = document.querySelector("#team-body tbody");
  if (tbody) tbody.innerHTML = users.map(teamRow).join("");
}

window.resetPassword = async function (name) {
  if (!confirm("给 " + name + " 重置口令？旧登录会立刻失效。")) return;
  const r = await api("/api/users/" + encodeURIComponent(name), { method: "PATCH", body: JSON.stringify({ reset: true }) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "失败"); return; }
  const msg = el("team-msg");
  if (msg) msg.textContent = name + " 的新一次性口令：" + (j.password || "（无）") + " —— 只显示这一次";
  await refreshTeam();
};

window.toggleUser = async function (name, active) {
  const r = await api("/api/users/" + encodeURIComponent(name), { method: "PATCH", body: JSON.stringify({ active }) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "失败"); return; }
  await refreshTeam();
};

const composeForm = el("new-task");
if (composeForm) {
  composeForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      title: el("t-title").value.trim(),
      repo: el("t-repo").value.trim(),
      owner: ME,
      budgetTokens: Number(el("t-budget").value || 1000000),
    };
    const r = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { alert(j.error || "提交失败"); return; }
    el("t-title").value = "";
    const msg = el("compose-msg");
    if (msg) { msg.textContent = "已提交 " + j.task.id + " · 后台会自动开跑，到待裁决时再找你"; setTimeout(() => { msg.textContent = ""; }, 8000); }
    await load();
    await loadFeed();
  });
}

// 执行器活体：worker 崩了/被杀了，这一行会立刻变红。
// 没有它的时候，"队列没人消费"和"暂时没任务"长得一模一样 —— 最贵的失败是无感。
async function loadHealth() {
  const box = el("kernel-state");
  if (!box) return;
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const h = await r.json();
    const w = h.worker || {};
    const staleCode = w.alive && w.version && h.version && w.version !== h.version;
    if (staleCode) {
      // 版本不一致就是"跑着的进程是旧代码"——真实事故就死在这里，不红不行。
      box.className = "mono bad";
      box.textContent = "执行器 跑着旧代码 v" + w.version + "（内核 v" + h.version + "）· 重启内核";
      box.title = "进程还是启动时的旧代码，新状态它不认识。杀掉内核重启即可（cli up 会自己拉起 worker）";
    } else if (w.alive) {
      box.className = "mono ok";
      box.textContent = "执行器 在线 · " + (w.age_s ?? 0) + "s 前心跳";
      box.title = "pid " + (w.pid || "?") + " · 引擎 " + (w.engine || h.engine || "?") + " · 内核已运行 " + (h.uptime_s || 0) + "s";
    } else {
      box.className = "mono bad";
      box.textContent = "执行器 已断线" + (w.age_s == null ? "" : " " + w.age_s + "s") + " · 任务不会推进";
      box.title = "worker 心跳超时（>" + (w.stale_after_s || 20) + "s）。它会按退避自动重启；一直红说明反复崩溃，看日志";
    }
  } catch {
    box.className = "mono bad";
    box.textContent = "执行器 未知（连不上内核）";
  }
}


// ---- 项目 / 阶段链 ------------------------------------------------
// 这一块是整个产品的"人只做三次决定"的落点：
//   开会（机器开，人不在场）-> 签 A 组（设计+契约）-> 签 B 组（实现+合并）。
// 每个阶段有目标、产出物、边界（allowedGlobs）、不管什么（nonGoals）、以及配的专家 agent，
// 阶段闸门在护栏里机械执行"不许发散"，越界就 FAIL 并把想法丢进 backlog 等人分流。
let projects = [];
const PROJ_LABEL = { drafting: "待开会", proposed: "待签字", running: "进行中", settling: "待签收资产", done: "已交付" };
const MEM_LABEL = { decision: "决定", constraint: "约束", pitfall: "踩坑", interface: "接口" };
const TRIGGER_LABEL = { scope: "越界", contract: "契约变更", baseline: "回归连挂", size: "体量过大", budget: "预算七成" };
let mineOnly = false;
const STAGE_LABEL = { proposed: "待签", approved: "已签", running: "在跑", done: "已交付", blocked: "卡住" };
const STAGE_CLS = { proposed: "wait", approved: "ok", running: "run", done: "done", blocked: "bad" };
const LANE_LABEL = { feature: "功能", chore: "杂活" };

function stageChip(p, s) {
  const cur = s.state === "running" || (p.state === "running" && s.state === "approved");
  const tip = "阶段 " + s.seq + " · " + s.name + " · " + (STAGE_LABEL[s.state] || s.state) +
    " · 负责人 " + (s.owner || "未指派") + (s.task_id ? " · 任务 " + s.task_id : "");
  return '<span class="stg st-' + (STAGE_CLS[s.state] || "wait") + (cur ? " cur" : "") + '" title="' + esc(tip) + '">' +
    s.seq + " " + esc(s.name) + "</span>";
}

/** 两次签字：A=[设计,契约] B=[实现,合并] —— 组由 workflow 决定，前端不写死。 */
function signatureGroups(p) {
  const out = [];
  for (const s of p.stages) {
    let g = out.find((x) => x.group === s.signature_group);
    if (!g) { g = { group: s.signature_group, names: [], signed: null, stages: [] }; out.push(g); }
    g.names.push(s.name);
    g.stages.push(s);
  }
  for (const g of out) g.signed = (p.signatures || []).find((x) => x.group_name === g.group) || null;
  return out;
}

function stageDetail(p, s) {
  const ev = (s.evidence) || {};
  const bits = [];
  bits.push('<div class="sg"><b>' + s.seq + " " + esc(s.name) + "</b>" +
    '<span class="badge ' + (STAGE_CLS[s.state] === "bad" ? "bad" : "") + '">' + esc(STAGE_LABEL[s.state] || s.state) + "</span>" +
    '<span class="dim">专家 ' + esc(s.agent || "?") + " · skill " + esc(s.skill || "?") + " · 角色 " + esc(s.role || "?") + "</span></div>");
  bits.push('<div class="goal">' + esc(s.goal) + "</div>");
  bits.push('<div class="row mono dim">产出物 ' + (s.artifacts.length ? esc(s.artifacts.join("、")) : "（无，交付物就是 diff + 测试）") + "</div>");
  bits.push('<div class="row mono dim">边界 ' + (s.allowedGlobs.length ? esc(s.allowedGlobs.join("、")) : "不限制") + "</div>");
  // 分发不是界面标签：换人要走账本（stage.owner.assigned），所以这里是一个动作而不是一段文字。
  bits.push('<div class="row dim">负责人 <b>' + esc(s.owner || "未指派") + "</b>" +
    ((isLead() || p.owner === ME) && p.state !== "done"
      ? ' <button class="ghost" onclick="assignOwner(\'' + p.id + "','" + s.stage_id + '\')">换人</button>'
      : "") +
    (s.owner ? "" : "（指派后「只看我盯的」才筛得到）") + "</div>");
  if (s.nonGoals && s.nonGoals.length) bits.push('<div class="row mono dim">不做 ' + esc(s.nonGoals.join("、")) + "</div>");
  if (s.task_id) bits.push('<div class="row dim">任务 <span class="mono">' + esc(s.task_id) + "</span></div>");
  return '<div class="stage">' + bits.join("") + "</div>";
}

function backlogBlock(p) {
  const open = (p.backlog || []).filter((b) => b.status === "open");
  const decided = (p.backlog || []).filter((b) => b.status !== "open");
  if (!open.length && !decided.length) return "";
  const DEC = { next: "下一阶段做", later: "以后做", drop: "不做" };
  const rows = open.map((b) =>
    '<li class="bl open"><span class="txt">' + esc(b.text) + '</span><span class="dim">（' + esc(b.source) + "）</span>" +
    '<span class="acts">' + Object.keys(DEC).map((k) =>
      '<button class="ghost" onclick="decideBacklog(\'' + p.id + "','" + b.id + "','" + k + '\')">' + DEC[k] + "</button>").join("") +
    "</span></li>").join("");
  const done = decided.map((b) =>
    '<li class="bl done"><span class="txt">' + esc(b.text) + '</span><span class="dim">→ ' + esc(DEC[b.status] || b.status) +
    (b.decided_by ? " · " + esc(b.decided_by) : "") + "</span></li>").join("");
  return '<div class="backlog"><div class="row"><b>发散项</b>' +
    (open.length ? '<span class="badge bad">' + open.length + " 条待分流（签字前必须分掉）</span>" : '<span class="badge ok">全部已分流</span>') +
    "</div><ul>" + rows + done + "</ul></div>";
}

function gatesBlock(p) {
  const groups = signatureGroups(p);
  const out = [];
  const lead = isLead();
  for (const g of groups) {
    if (g.signed) {
      out.push('<div class="row dim">已签 ' + esc(g.group) + " 组（" + esc(g.names.join("+")) + "）· " +
        esc(g.signed.by) + (g.signed.note ? "：" + esc(g.signed.note) : "") + "</div>");
      continue;
    }
    const notDelivered = g.stages.some((s) => s.state !== "approved" && s.state !== "done" && s.state !== "running");
    const label = "签 " + g.group + " 组（" + g.names.join(" + ") + "）";
    out.push('<div class="row">' +
      (lead
        ? '<button class="primary" onclick="signGroup(\'' + p.id + "','" + g.group + '\')">' + esc(label) + "</button>"
        : '<button class="primary" disabled title="只有 lead 能签字">' + esc(label) + "</button>") +
      '<span class="dim">签完 ' + esc(g.names.join("、")) + ' 才能开工' +
      (notDelivered ? "；但前一批要先交付（签字要基于交付物，不是预告）" : "") + "</span></div>");
  }
  return out.join("");
}

function startBlock(p) {
  const out = [];
  for (const s of p.stages) {
    if (s.state !== "approved" || s.task_id) continue;
    const behind = p.stages.filter((x) => x.seq < s.seq && x.state !== "done");
    if (behind.length) {
      out.push('<div class="row dim">' + s.seq + " " + esc(s.name) + "：等 " + esc(behind.map((x) => x.name).join("、")) + " 交付完</div>");
      continue;
    }
    out.push('<div class="row"><button class="ghost" onclick="startStage(\'' + p.id + "','" + s.stage_id + '\')">开工 ' +
      esc(s.seq + " " + s.name) + '（后台自动跑这个阶段）</button></div>');
  }
  return out.join("");
}

// 复议会：执行中撞上签字时没料到的岔路口，机器把选项摆好，人只拍板。
// 每一张都必须能机械执行（扩边界/加预算/打回），否则「拍板」只是给界面换颜色。
function meetingBlock(p) {
  const open = (p.decisions || []).filter((d) => d.status === "open");
  if (!open.length) return "";
  return '<div class="meet"><div class="row"><b>复议会</b><span class="badge bad">' + open.length +
    ' 张等你拍板</span><span class="dim">机器已经把现状与路线写在提案里，你只需要选一条</span></div>' +
    open.map((d) => '<div class="dec">' +
      '<div class="row"><span class="badge wait">' + esc(TRIGGER_LABEL[d.trigger] || d.trigger) + "</span>" +
      '<span class="dim">' + esc(String(d.created_at || "").slice(0, 16).replace("T", " ")) + " · 卡住的执行已暂停" + "</span></div>" +
      '<details class="prop"><summary>看机器提案（现状 / 可选路线 / 建议）</summary><pre>' + esc(d.proposal || "") + "</pre></details>" +
      '<div class="row">' + (d.options || []).map((o) =>
        '<button class="' + (o.id === "abort" ? "ghost" : "primary") + '" title="' + esc(o.desc) + '" onclick="resolveMeeting(\'' +
        p.id + "','" + d.decision_id + "','" + o.id + '\')">' + esc(o.label) + "</button>").join("") +
      "</div></div>").join("") + "</div>";
}

// 项目记忆：全团队共享的结论，不是聊天记录。只加不改；要推翻就写一条新的。
function memoryBlock(p) {
  const mem = p.memory || [];
  if (!mem.length && p.state === "drafting") return "";
  const recent = mem.slice(-6);
  return '<div class="mem"><div class="row"><b>项目记忆</b><span class="dim">' + mem.length + " 条 · 全团队共享 · agent 每次调用只带最近 8 条 + 按角色召回 5 条</span>" +
    (ME && ROLE !== "viewer" ? '<button class="ghost" onclick="addMemory(\'' + p.id + '\')">＋ 记一条</button>' : "") + "</div>" +
    (recent.length
      ? '<ul>' + recent.map((m) => '<li><span class="badge">' + esc(MEM_LABEL[m.kind] || m.kind) + "</span> " +
        esc(m.text) + '<span class="dim">（' + esc(m.source || "?") + "）</span></li>").join("") + "</ul>"
      : '<div class="row dim">还没有记忆：阶段交付时会自动攒下决定/约束/踩坑/接口，人也可以手工补。</div>') +
    (mem.length > recent.length ? '<div class="row dim">还有 ' + (mem.length - recent.length) + " 条更早的（收尾时会导出成 memory.md）</div>" : "") +
    "</div>";
}

// 收尾资产：第 3 次（也是最后一次）签字。收下 = 下次能直接用；不要 = 这次没有可复用的东西，不丢人。
function settleBlock(p) {
  if (p.state !== "settling") return "";
  const assets = p.assets || [];
  const files = ["postmortem.md", "decisions.md", "memory.md", "workflow.json", "contract-template.md"];
  return '<div class="settle"><div class="row"><b>收尾沉淀包</b><span class="badge wait">待签收</span>' +
    '<span class="dim">全部从账本生成（不花 token）：' + esc(files.join(" / ")) + "</span></div>" +
    (assets.length
      ? '<ul>' + assets.map((a) => '<li><span class="badge">' + esc(a.kind) + "</span> " + esc(a.title) +
        '<span class="dim mono">' + esc(a.path) + "</span>" +
        (a.status === "proposed"
          ? '<span class="acts"><button class="primary" onclick="settleAsset(\'' + p.id + "','" + a.asset_id + "','accepted" + '\')">收下</button>' +
            '<button class="ghost" onclick="settleAsset(\'' + p.id + "','" + a.asset_id + "','declined" + '\')">不要</button></span>'
          : '<span class="acts dim">' + (a.status === "accepted" ? "已收下" : "不要了") + "</span>") +
        "</li>").join("") +
        "</ul>"
      : '<div class="row dim">收尾还没跑完：执行器 3 秒内会补跑（进程崩了也不怕，settling 是持久状态）。</div>') +
    "</div>";
}

function projCard(p) {
  const stages = p.stages || [];
  const groups = signatureGroups(p);
  const open = (p.backlog || []).filter((b) => b.status === "open").length;
  const nextGate = groups.find((g) => !g.signed);
  return '<div class="proj">' +
    '<div class="phead"><b>' + esc(p.title) + "</b>" +
      '<span class="badge ' + (p.state === "done" ? "ok" : p.state === "running" ? "" : "wait") + '">' + esc(PROJ_LABEL[p.state] || p.state) + "</span>" +
      '<span class="dim">' + esc(LANE_LABEL[p.lane] || p.lane) + " · 提交 " + esc(p.owner) + " · 每阶段预算 " + fmt(p.budget_tokens) + "</span>" +
      (p.human_minutes ? '<span class="dim">预计占用你 ' + p.human_minutes + " 分钟</span>" : "") +
      (open ? '<span class="badge bad">' + open + " 条待分流</span>" : "") +
    "</div>" +
    (stages.length
      ? '<div class="bar">' + stages.map((s) => stageChip(p, s)).join('<span class="sep">›</span>') + "</div>"
      : '<div class="row dim">还没开会：点「开预备会」，机器 30 秒内出一份提案（阶段链 + 要你拍板的发散项）</div>') +
    (p.summary ? '<div class="row dim">' + esc(p.summary) + "</div>" : "") +
    (stages.length ? '<div class="row dim">签字 ' + (p.signatures || []).length + "/" + groups.length + " 次" +
      (nextGate ? " · 下一步：签 " + esc(nextGate.group) + " 组（" + esc(nextGate.names.join("+")) + "）" : "") + "</div>" : "") +
    (stages.length ? '<details class="pbody"><summary>展开：每个阶段的目标 / 产出物 / 边界 / 专家</summary>' +
      stages.map((s) => stageDetail(p, s)).join("") + "</details>" : "") +
    backlogBlock(p) +
    meetingBlock(p) +
    (p.state === "drafting" ? '<div class="row"><button class="primary" onclick="meetProject(\'' + p.id + '\')">开预备会（机器先开会，人之后再来看）</button></div>' : "") +
    (p.state === "settling" ? settleBlock(p) : p.state !== "done" ? gatesBlock(p) + startBlock(p) : "") +
    memoryBlock(p) +
    "</div>";
}

function renderProjects() {
  const box = el("projects");
  if (!box) return;
  // 每人只盯自己那几关：阶段负责人是我，或者项目是我发起的。多人同时看十几个项目时才不会互相淹。
  const mine = (p) => p.owner === ME || (p.stages || []).some((s) => s.owner === ME);
  const visible = mineOnly ? projects.filter(mine) : projects;
  const active = visible.filter((p) => p.state !== "done");
  const done = visible.filter((p) => p.state === "done");
  const hidden = projects.length - visible.length;
  const html = active.map(projCard).join("") +
    (done.length ? '<details class="pdone"><summary>已交付的项目 ' + done.length + " 个</summary>" + done.map(projCard).join("") + "</details>" : "");
  box.innerHTML = (html || '<div class="empty">' + (mineOnly
    ? "没有你盯的项目。关掉「只看我盯的」能看到全部（阶段负责人可以在展开详情里改）。"
    : "还没有项目。功能类工作从这里开：机器先开预备会，你只需要签 2 次字。")) +
    (mineOnly && hidden ? '<div class="row dim">已隐藏 ' + hidden + " 个不归你盯的项目</div>" : "");
  el("n-proj").textContent = active.length;
  const btn = el("mine-btn");
  if (btn) { btn.textContent = mineOnly ? "看全部项目" : "只看我盯的"; btn.classList.toggle("on", mineOnly); }
}

async function loadProjects() {
  try {
    const r = await api("/api/projects");
    if (!r.ok) return;
    const list = (await r.json()).projects || [];
    // 列表接口不带 backlog/signatures，展开要用的完整数据单独取（项目数量很少）。
    projects = await Promise.all(list.map(async (p) => {
      try {
        const d = await api("/api/projects/" + encodeURIComponent(p.id));
        if (!d.ok) return p;
        const j = await d.json();
        // 详情接口带回记忆/复议会/资产：看板要靠它们渲染，不能只取 project 丢掉。
        return j.project ? { ...j.project, memory: j.memory || [], decisions: j.decisions || [], assets: j.assets || [] } : p;
      } catch { return p; }
    }));
    renderProjects();
  } catch { /* 老内核没有这些接口：这一块留空即可 */ }
}

window.toggleNewProject = function () {
  const f = el("new-project");
  if (f) f.hidden = !f.hidden;
};

window.meetProject = async function (id) {
  const r = await api("/api/projects/" + id + "/meeting", { method: "POST", body: JSON.stringify({}) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "开会失败"); return; }
  await loadProjects();
  await loadFeed();
};

window.signGroup = async function (id, group) {
  const note = prompt("签 " + group + " 组：写一句你认可什么（会进账本，事后可追溯）") ;
  if (note === null) return;
  const r = await api("/api/projects/" + id + "/sign", { method: "POST", body: JSON.stringify({ group, note }) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "签字失败"); return; }
  await loadProjects();
  await loadFeed();
};

// 换阶段负责人：领了就要盯着看板，所以这是账本动作而不是标签。
window.assignOwner = async function (id, stageId) {
  const who = prompt("把这一阶段指派给谁？（填团队里的名字，留空取消）");
  if (!who || !who.trim()) return;
  const r = await api("/api/projects/" + id + "/stages/" + encodeURIComponent(stageId) + "/owner", {
    method: "POST", body: JSON.stringify({ owner: who.trim() }),
  });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "指派失败"); return; }
  await loadProjects();
  await loadFeed();
};

// 复议会拍板：每个选项都是机械可执行的（扩边界/加预算/打回），note 会进决议与项目记忆。
window.resolveMeeting = async function (id, did, choice) {
  const opt = { extend_scope: "扩边界", next_stage: "留到下一阶段", amend: "接受契约变更", revert: "退回契约原文", fix: "先修，继续重试", accept_risk: "接受风险继续", split: "拆小重做", continue: "继续", raise_budget: "加预算", stop: "不加", abort: "人工接手" }[choice] || choice;
  const note = prompt("拍板：" + opt + "\n写一句理由（会进账本和项目记忆，可留空）", "");
  if (note === null) return;
  const r = await api("/api/projects/" + id + "/decisions/" + encodeURIComponent(did), {
    method: "POST", body: JSON.stringify({ choice, note }),
  });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "拍板失败"); return; }
  await loadProjects();
  await load();
  await loadFeed();
};

// 人往项目记忆里补一条：agent 不会自己总结自己，人的结论最值钱。
window.addMemory = async function (id) {
  const text = prompt("记一条（一句能被下一个 agent 直接照做的话，200 字内）");
  if (!text || !text.trim()) return;
  const kind = prompt("类型：decision 决定 / constraint 约束 / pitfall 踩坑 / interface 接口", "decision");
  if (kind === null) return;
  const r = await api("/api/projects/" + id + "/memory", {
    method: "POST", body: JSON.stringify({ kind: kind.trim() || "decision", text: text.trim(), source: "人工补充" }),
  });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "写入失败"); return; }
  await loadProjects();
  await loadFeed();
};

// 资产签收：收下 = 下次能直接套用；不要 = 这次没有可复用的东西（也允许）。
window.settleAsset = async function (id, assetId, status) {
  const note = prompt(status === "accepted" ? "收下这个资产（可写一句用途，留空也行）" : "不要它（可写一句原因，留空也行）", "");
  if (note === null) return;
  const body = status === "accepted" ? { accept: [assetId], note } : { decline: [assetId], note };
  const r = await api("/api/projects/" + id + "/assets", { method: "POST", body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "签收失败"); return; }
  await loadProjects();
  await loadFeed();
};

window.toggleMine = function () {
  mineOnly = !mineOnly;
  renderProjects();
};

window.startStage = async function (id, ref) {
  const r = await api("/api/projects/" + id + "/stages/" + encodeURIComponent(ref) + "/start", { method: "POST", body: JSON.stringify({}) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "开工失败"); return; }
  await loadProjects();
  await load();
  await loadFeed();
};

window.decideBacklog = async function (id, bid, status) {
  const r = await api("/api/projects/" + id + "/backlog/" + bid, { method: "POST", body: JSON.stringify({ status }) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || "分流失败"); return; }
  await loadProjects();
  await loadFeed();
};

const projForm = el("new-project");
if (projForm) {
  projForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      title: el("p-title").value.trim(),
      repo: el("p-repo").value.trim(),
      lane: el("p-lane").value,
      budgetTokens: Number(el("p-budget").value || 1000000),
    };
    const r = await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { alert(j.error || "建项目失败"); return; }
    el("p-title").value = "";
    el("proj-msg").textContent = "已建 " + j.project.id + " · 先开预备会，人只签 2 次字";
    setTimeout(() => { el("proj-msg").textContent = ""; }, 8000);
    await loadProjects();
    await loadFeed();
  });
}

loadWorkspace();
loadProjects();
load();
loadFeed();
loadHealth();
setInterval(() => { load(); loadFeed(); loadProjects(); }, 2500);
setInterval(loadHealth, 4000);
