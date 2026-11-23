import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs");
mkdirSync(OUT, { recursive: true });

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const C = {
  bg: "#0b0f14",
  panel: "#101821",
  panel2: "#0f151c",
  line: "#22303f",
  text: "#e6edf3",
  muted: "#8b9bad",
  cyan: "#38bdf8",
  green: "#34d399",
  amber: "#fbbf24",
  red: "#f87171",
  violet: "#a78bfa",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function head(w, h, title) {
  const markers = Object.entries({ cyan: C.cyan, green: C.green, amber: C.amber, red: C.red, muted: C.muted, violet: C.violet })
    .map(([k, v]) => '<marker id="a-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + v + '"/></marker>')
    .join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" font-family="' + FONT + '" role="img" aria-label="' + esc(title) + '">' +
    '<defs>' + markers + '</defs>' +
    '<rect width="' + w + '" height="' + h + '" fill="' + C.bg + '"/>';
}

function text(x, y, s, o = {}) {
  const size = o.size || 15;
  const fill = o.fill || C.text;
  const anchor = o.anchor || "start";
  const weight = o.weight || 400;
  const mono = o.mono ? " ui-monospace,SFMono-Regular,Menlo,monospace" : "";
  return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + fill + '" text-anchor="' + anchor + '" font-weight="' + weight + '"' +
    (mono ? ' font-family="ui-monospace,SFMono-Regular,Menlo,monospace"' : "") + '>' + esc(s) + "</text>";
}

function box(x, y, w, h, o = {}) {
  const fill = o.fill || C.panel2;
  const stroke = o.stroke || C.line;
  const rx = o.rx === undefined ? 12 : o.rx;
  const dash = o.dash ? ' stroke-dasharray="6 5"' : "";
  const sw = o.sw || 1.2;
  return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + rx + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"' + dash + "/>";
}

function line(x1, y1, x2, y2, o = {}) {
  const color = o.color || C.muted;
  const sw = o.sw || 1.6;
  const dash = o.dash ? ' stroke-dasharray="' + (o.dash === true ? "7 6" : o.dash) + '"' : "";
  const marker = o.arrow === false ? "" : ' marker-end="url(#a-' + (o.kind || "muted") + ')"';
  return '<path d="' + (o.d || ("M" + x1 + "," + y1 + " L" + x2 + "," + y2)) + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '"' + dash + marker + "/>";
}

/* ---------------- 1. 架构图 ---------------- */
function arch() {
  const W = 1180, H = 700;
  let s = head(W, H, "工作台架构");
  s += text(44, 62, "工作台架构：一台机器当执行器，人只在两个闸口出现", { size: 25, weight: 700 });
  s += text(44, 92, "浏览器只是客户端；内核、账本、worktree、模型调用全在这台机器上，代码和数据不出内网", { size: 14.5, fill: C.muted });

  // 第一层：人
  s += box(360, 128, 460, 92, { fill: C.panel, stroke: C.cyan });
  s += text(590, 160, "人（浏览器打开一个地址）", { size: 17, weight: 600, anchor: "middle", fill: C.cyan });
  s += text(590, 188, "提交一句话任务 · 初筛 30 秒 · 终审要不要合", { size: 13.5, anchor: "middle", fill: C.muted });
  s += text(590, 210, "lead / member / viewer 三种角色，一人一号", { size: 13.5, anchor: "middle", fill: C.muted });

  s += line(590, 220, 590, 268, { kind: "cyan" });
  s += text(604, 250, "HTTP + 签名 cookie", { size: 12.5, fill: C.cyan });

  // 第二层：服务
  s += box(240, 270, 700, 104, { fill: C.panel, stroke: C.line });
  s += text(262, 302, "HTTP 服务", { size: 17, weight: 600 });
  s += text(262, 326, "src/server · 登录与会话 · 权限矩阵（服务端判，不靠前端藏按钮）", { size: 13.5, fill: C.muted });
  s += text(262, 350, "两段评审 API · 活动流 · 静态界面 · /api/health 体检", { size: 13.5, fill: C.muted });

  s += line(590, 374, 590, 420, { kind: "violet" });
  s += text(604, 402, "只 append，不改历史", { size: 12.5, fill: C.violet });

  // 第三层：账本
  s += box(240, 422, 700, 104, { fill: C.panel, stroke: C.violet });
  s += text(262, 454, "事件账本（唯一真源）", { size: 17, weight: 600, fill: C.violet });
  s += text(262, 478, "events 只追加 → tasks 是它的物化投影；kill -9 后重放，不失忆、不乱序", { size: 13.5, fill: C.muted });
  s += text(262, 502, "租约是单条 CAS UPDATE + pid 存活探测：两个 worker 抢不到同一个任务", { size: 13.5, fill: C.muted });

  s += line(430, 526, 430, 566, { kind: "green" });
  s += text(444, 552, "领任务", { size: 12.5, fill: C.green });
  s += line(760, 526, 760, 566, { kind: "amber" });
  s += text(774, 552, "留证据", { size: 12.5, fill: C.amber });

  // 第四层：worker + 引擎
  s += box(150, 568, 400, 108, { fill: C.panel, stroke: C.green });
  s += text(172, 600, "worker（常驻，崩了自动拉起）", { size: 16, weight: 600, fill: C.green });
  s += text(172, 624, "状态机 · 重试 ≤3 轮 · 预算熔断 · 体量分级", { size: 13.5, fill: C.muted });
  s += text(172, 648, "每次调用落 agent.started / heartbeat / finished", { size: 13.5, fill: C.muted });
  s += text(172, 668, "界面靠心跳分得清「模型在思考」和「worker 已死」", { size: 12.5, fill: C.muted });

  s += line(550, 622, 606, 622, { kind: "green" });
  s += text(578, 612, "每次一个独立进程", { size: 12, fill: C.green, anchor: "middle" });

  s += box(608, 568, 424, 108, { fill: C.panel, stroke: C.cyan });
  s += text(630, 600, "agent provider（可换）", { size: 16, weight: 600, fill: C.cyan });
  s += text(630, 624, "mock 确定性假引擎 / opencode 真模型", { size: 13.5, fill: C.muted });
  s += text(630, 648, "每角色一个进程：Verifier 拿不到 Coder 的上下文", { size: 13.5, fill: C.muted });
  s += text(630, 668, "在独立 git worktree 里改，主仓库只接受合并", { size: 12.5, fill: C.muted });

  // 底部结论条
  s += box(150, 690 - 4, 882, 0, { fill: "none", stroke: "none" });
  s += text(44, H - 18, "四条不变量：账本只追加 · 单任务单 worker · 改动只在 worktree · 合并必须由人批准", { size: 13, fill: C.muted });
  s += "</svg>";
  return s;
}

/* ---------------- 2. 状态机 ---------------- */
function flow() {
  const W = 1180, H = 620;
  let s = head(W, H, "任务状态机");
  s += text(44, 58, "一个任务活多久：机器跑四段，人只卡两关", { size: 25, weight: 700 });
  s += text(44, 88, "两段人工是显式状态，不是「awaiting_human + 一个字段」——账本重放一眼看出卡在哪一关，两段耗时也能分开统计", { size: 14, fill: C.muted });

  const bw = 196, bh = 66, y1 = 130, y2 = 330;
  const xs = [44, 300, 556, 812];
  const row1 = [["queued", "排队"], ["planning", "规划"], ["implementing", "实现"], ["verifying", "验收"]];
  const colors1 = [C.muted, C.violet, C.green, C.cyan];
  row1.forEach(([id, name], i) => {
    s += box(xs[i], y1, bw, bh, { fill: C.panel, stroke: colors1[i] });
    s += text(xs[i] + bw / 2, y1 + 28, name, { size: 16, weight: 600, anchor: "middle", fill: colors1[i] });
    s += text(xs[i] + bw / 2, y1 + 50, id, { size: 12, anchor: "middle", fill: C.muted, mono: true });
    if (i < 3) s += line(xs[i] + bw + 4, y1 + bh / 2, xs[i + 1] - 6, y1 + bh / 2, { kind: colors1[i + 1] });
  });

  // 下行到第二排
  s += line(910, y1 + bh + 4, 910, y2 - 6, { kind: "amber" });

  const row2 = [["awaiting_review", "初筛（人）", C.amber], ["awaiting_approval", "终审（人）", C.amber], ["merging", "合并", C.violet], ["done", "完成", C.green]];
  row2.forEach(([id, name, col], i) => {
    const human = i < 2;
    s += box(xs[i], y2, bw, bh, { fill: human ? "#1d1a10" : C.panel, stroke: col, sw: human ? 1.8 : 1.2 });
    s += text(xs[i] + bw / 2, y2 + 28, name, { size: 16, weight: 600, anchor: "middle", fill: col });
    s += text(xs[i] + bw / 2, y2 + 50, id, { size: 12, anchor: "middle", fill: C.muted, mono: true });
    if (i < 3) s += line(xs[i] + bw + 4, y2 + bh / 2, xs[i + 1] - 6, y2 + bh / 2, { kind: col });
  });

  s += text(xs[0] + bw / 2, y2 - 18, "人闸 1", { size: 12.5, fill: C.amber, anchor: "middle", weight: 600 });
  s += text(xs[1] + bw / 2, y2 - 18, "人闸 2", { size: 12.5, fill: C.amber, anchor: "middle", weight: 600 });

  // 打回：awaiting_review -> queued（虚线，从左侧绕出去，不穿过卡片）
  s += line(0, 0, 0, 0, { d: "M" + (xs[0] - 2) + "," + (y2 + bh / 2) + " L" + (xs[0] - 22) + "," + (y2 + bh / 2) + " L" + (xs[0] - 22) + "," + (y1 + bh / 2) + " L" + (xs[0] - 2) + "," + (y1 + bh / 2), kind: "red", dash: true });
  s += text(xs[2] - 10, y2 + bh + 36, "打回（必须写理由）→ 重置 worktree → 重做，人的原话排在下轮提示词第一行", { size: 12.5, fill: C.red, anchor: "end" });

  // 重试：verifying -> implementing
  s += line(0, 0, 0, 0, { d: "M" + (xs[3] + 40) + "," + (y1 + bh + 4) + " C" + (xs[3] + 40) + "," + (y1 + bh + 46) + " " + (xs[2] + 130) + "," + (y1 + bh + 46) + " " + (xs[2] + 130) + "," + (y1 + bh + 4), kind: "red", dash: true });
  s += text(xs[3] - 10, y1 + bh + 34, "护栏 / Verifier 没过：自动重试（≤3 轮）", { size: 12.5, fill: C.red, anchor: "end" });

  // blocked
  s += box(xs[2], y2 + bh + 64, 300, 74, { fill: "#1b1114", stroke: C.red, dash: true });
  s += text(xs[2] + 150, y2 + bh + 92, "blocked 机器认输", { size: 15, weight: 600, anchor: "middle", fill: C.red });
  s += text(xs[2] + 150, y2 + bh + 116, "重试耗尽 · 预算熔断 · 权限被拒（确定性失败不重试）", { size: 12, anchor: "middle", fill: C.muted });
  s += line(0, 0, 0, 0, { d: "M" + (xs[3] + bw - 30) + "," + (y1 + bh + 4) + " L" + (xs[3] + bw - 30) + "," + (y2 + bh + 100) + " L" + (xs[2] + 306) + "," + (y2 + bh + 100), kind: "red", dash: true });
  s += text(xs[3] + bw - 18, y1 + bh + 96, "重试耗尽", { size: 12, fill: C.red });

  s += text(44, H - 22, "只有 awaiting_review / awaiting_approval 会停住等人；其余状态里人可以不看，因为系统会自己重试、自己升级、自己记完", { size: 13, fill: C.muted });
  s += "</svg>";
  return s;
}

/* ---------------- 3. 成本图 ---------------- */
function cost() {
  const W = 1180, H = 470;
  let s = head(W, H, "成本对比");
  s += text(44, 58, "同样一套 5 个任务，砍掉多余编排之后", { size: 25, weight: 700 });
  s += text(44, 88, "真引擎实跑（opencode + deepseek-v4.1-flash），单位：token / 单任务平均", { size: 14, fill: C.muted });

  // 左：对比
  const baseY = 380, maxH = 250, maxV = 700000;
  const bar = (x, w, v, color, label, sub) => {
    const h = Math.round((v / maxV) * maxH);
    let o = '<rect x="' + x + '" y="' + (baseY - h) + '" width="' + w + '" height="' + h + '" rx="6" fill="' + color + '" opacity="0.85"/>';
    o += text(x + w / 2, baseY - h - 12, label, { size: 15, weight: 700, anchor: "middle", fill: color });
    o += text(x + w / 2, baseY + 22, sub, { size: 12.5, anchor: "middle", fill: C.muted });
    return o;
  };
  s += text(60, 130, "① 编排成本：5 次调用 → 2 次调用", { size: 16, weight: 600 });
  s += bar(80, 110, 482743, C.red, "482,743", "旧：5 次调用");
  s += bar(240, 110, 230630, C.green, "230,630", "新：2 次调用");
  s += text(190, 300, "-52.2%", { size: 34, weight: 700, anchor: "middle", fill: C.green });
  s += line(60, baseY, 400, baseY, { color: C.line, arrow: false, sw: 1 });

  // 右：按体量
  s += text(470, 130, "② 不同体量各花多少（同一个真实套件）", { size: 16, weight: 600 });
  s += bar(500, 92, 210118, C.cyan, "21 万", "small 改一处");
  s += bar(636, 92, 514444, C.amber, "51 万", "normal 多文件");
  s += bar(772, 92, 622392, C.violet, "62 万", "large 重构");
  s += line(480, baseY, 950, baseY, { color: C.line, arrow: false, sw: 1 });

  s += text(60, 432, "贵的地方不是提示词长度（每次 prompt 只有几百到几千字），是「调用次数 × 每次自带的工具往返」——所以省钱只能靠少调几次。", { size: 12.5, fill: C.muted });
  s += text(44, H - 16, "报告：docs/bench-real-2026-11-22T13-25-24-476Z.json（6 单混跑：small/normal/large 各走各的路径 + 一次确定性降级）", { size: 12, fill: C.muted });
  s += "</svg>";
  return s;
}

const files = { "arch.svg": arch(), "flow.svg": flow(), "cost.svg": cost() };
for (const [name, body] of Object.entries(files)) {
  writeFileSync(join(OUT, name), body, "utf8");
  console.log("write docs/" + name, body.length, "字节");
}
