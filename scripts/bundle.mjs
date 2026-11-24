#!/usr/bin/env node
/**
 * 打「离线单包」：node 运行时 + workbench 内核 + opencode 引擎，装完不联网、不 npm install。
 *
 *   node scripts/bundle.mjs --target linux-x64|darwin-arm64
 *        [--out dist] [--node-version 22] [--opencode-version latest]
 *        [--skip-download] [--keep-staging]
 *
 * 下载的原料都缓存在 .cache/ 里，重复打包不会重新拉。
 * linux 二进制在本机（macOS）跑不起来，所以用文件头（ELF 类型 + e_machine）校验代替执行；
 * darwin 的必须真的能 --version。
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
const NODE_BASE = "https://nodejs.org/dist";
const REGISTRY = "https://registry.npmjs.org";
const GITHUB_API = "https://api.github.com/repos/sst/opencode/releases/latest";
const TEMPS = [];
let SKIP_DOWNLOAD = false;

const TARGETS = {
  "linux-x64": { nodePlatform: "linux", nodeArch: "x64", enginePkg: "opencode-linux-x64", binary: "elf-x86_64" },
  "darwin-arm64": { nodePlatform: "darwin", nodeArch: "arm64", enginePkg: "opencode-darwin-arm64", binary: "macho-arm64" },
};

function parseArgs(argv) {
  const out = { target: "", out: "dist", nodeVersion: "22", opencodeVersion: "latest", skipDownload: false, keepStaging: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(a + " 需要一个值");
      return v;
    };
    if (a === "--target") out.target = next();
    else if (a === "--out") out.out = next();
    else if (a === "--node-version") out.nodeVersion = next();
    else if (a === "--opencode-version") out.opencodeVersion = next();
    else if (a === "--skip-download") out.skipDownload = true;
    else if (a === "--keep-staging") out.keepStaging = true;
    else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    else fail("未知参数: " + a);
  }
  if (!out.target) fail("缺少 --target（" + Object.keys(TARGETS).join(" | ") + "）");
  if (!TARGETS[out.target]) fail("不支持的 --target: " + out.target + "（支持 " + Object.keys(TARGETS).join(" / ") + "）");
  return out;
}

function usage() {
  console.log([
    "用法: node scripts/bundle.mjs --target <" + Object.keys(TARGETS).join("|") + "> [选项]",
    "",
    "  --out DIR               输出目录（默认 dist）",
    "  --node-version VER      22 / 22.23.5（默认 22 = 最新 22 LTS）",
    "  --opencode-version VER  latest 或精确版本（默认 latest）",
    "  --skip-download         只用 .cache/ 里已有的原料，缺了直接失败",
    "  --keep-staging          打包后保留 .cache/staging/ 便于检查",
  ].join("\n"));
}

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

const log = (...a) => console.log(...a);
const human = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + "MB" : (n / 1024).toFixed(0) + "KB");

async function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function mkTmp(prefix) {
  const dir = mkdtempSyncSafe(prefix);
  TEMPS.push(dir);
  return dir;
}

function mkdtempSyncSafe(prefix) {
  const { mkdtempSync } = process.getBuiltinModule("node:fs");
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTemps() {
  for (const d of TEMPS.splice(0)) rmSync(d, { recursive: true, force: true });
}

async function download(url, dest, label) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    log("  · 缓存命中 " + (label || url) + "（" + human(statSync(dest).size) + "）");
    return dest;
  }
  if (SKIP_DOWNLOAD) fail("--skip-download 但缓存里没有 " + (label || dest) + "（先不带这个参数跑一次）");
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + ".part";
  log("  ↓ " + (label || url));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(900_000), redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
      const total = Number(res.headers.get("content-length") || 0);
      let got = 0;
      let nextMark = 20;
      const body = Readable.fromWeb(res.body);
      body.on("data", (chunk) => {
        got += chunk.length;
        if (!total) return;
        const pct = Math.floor((got / total) * 100);
        if (pct >= nextMark) {
          log("    " + (pct - (pct % 20)) + "%  " + human(got) + "/" + human(total));
          nextMark = pct - (pct % 20) + 20;
        }
      });
      await pipeline(body, createWriteStream(part));
      if (total && got !== total) throw new Error("大小不符：" + got + " != " + total);
      try { renameSync(part, dest); } catch { copyFileSync(part, dest); rmSync(part, { force: true }); }
      log("  ✓ " + (label || url) + "（" + human(statSync(dest).size) + "）");
      return dest;
    } catch (e) {
      rmSync(part, { force: true });
      if (attempt === 3) fail("下载失败 " + url + "：" + e.message);
      log("    … 第 " + attempt + " 次失败（" + e.message + "），重试");
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return dest;
}

async function retryFetch(url, init, attempts) {
  attempts = attempts || 4;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
      return res;
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw last;
}

async function fetchJson(url, what) {
  const res = await retryFetch(url, { signal: AbortSignal.timeout(120_000), headers: { accept: "application/json" } });
  return res.json();
}

async function fetchText(url, what) {
  const res = await retryFetch(url, { signal: AbortSignal.timeout(120_000) });
  return res.text();
}

/** nodejs.org/dist：返回 {version, shasums:Map<filename,sha256>, base} */
async function resolveNode(versionLine) {
  const exact = /^\d+\.\d+\.\d+$/.test(versionLine);
  const base = exact ? NODE_BASE + "/v" + versionLine : NODE_BASE + "/latest-v" + versionLine.replace(/\.x$/, "") + ".x";
  log("· 查 node（" + base + "）");
  let text;
  try {
    text = await fetchText(base + "/SHASUMS256.txt", "SHASUMS256.txt");
  } catch (e) {
    fail("拿不到 node 的 SHASUMS256.txt：" + e.message + "（--node-version 写 22 或 22.23.5）");
  }
  const shasums = new Map();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) shasums.set(m[2], m[1]);
  }
  const first = [...shasums.keys()].find((f) => /^node-v\d+\.\d+\.\d+-/.test(f));
  if (!first) fail("SHASUMS256.txt 内容看不懂");
  const version = first.match(/^node-v(\d+\.\d+\.\d+)-/)[1];
  return { version, shasums, base };
}

async function getNodeFiles(t, node, opts) {
  const dir = "node-v" + node.version + "-" + t.nodePlatform + "-" + t.nodeArch;
  const asset = dir + ".tar.xz";
  const want = node.shasums.get(asset);
  if (!want) fail("node " + node.version + " 没有 " + asset + "（不支持 " + t.nodePlatform + "-" + t.nodeArch + "）");
  const file = join(CACHE, "node", asset);
  await download(node.base + "/" + asset, file, asset);
  const got = await sha256File(file);
  if (got !== want) fail("node 校验失败：" + asset + " 期望 " + want + " 实际 " + got + "（缓存坏了？删掉 .cache/node/" + asset + " 重试）");
  log("  ✓ sha256 匹配 " + want.slice(0, 16) + "…");

  const tmp = mkTmp("wb-node-");
  for (const member of [dir + "/bin/node", dir + "/LICENSE"]) {
    const r = spawnSync("tar", ["-xJf", file, "-C", tmp, "--strip-components=2", member], { encoding: "utf8" });
    if (r.status !== 0) fail("解包 " + member + " 失败：" + (r.stderr || r.error));
  }
  return { nodeBin: join(tmp, "node"), license: join(tmp, "LICENSE"), asset, version: node.version };
}

/** npm registry：平台包版本 + tarball + 校验信息 */
async function resolveEngineFromNpm(pkgName, wantVersion) {
  const meta = await fetchJson(REGISTRY + "/opencode-ai", "opencode-ai metadata");
  const wrapperVersion = wantVersion === "latest" ? meta["dist-tags"].latest : wantVersion;
  const entry = meta.versions[wrapperVersion];
  if (!entry) fail("opencode-ai 没有版本 " + wrapperVersion);
  const engineVersion = (entry.optionalDependencies || {})[pkgName] || wrapperVersion;
  const engineMeta = await fetchJson(REGISTRY + "/" + pkgName + "/" + engineVersion, pkgName + " metadata");
  const dist = engineMeta.dist || {};
  return { wrapperVersion, engineVersion, tarball: dist.tarball, integrity: dist.integrity, shasum: dist.shasum, wrapperTarball: entry.dist && entry.dist.tarball };
}

async function verifyNpmTarball(file, info) {
  const buf = readFileSync(file);
  if (info.integrity && info.integrity.startsWith("sha512-")) {
    const got = "sha512-" + createHash("sha512").update(buf).digest("base64");
    if (got !== info.integrity) fail("opencode 包完整性不对：期望 " + info.integrity + " 实际 " + got);
    log("  ✓ npm integrity (sha512) 匹配");
  } else if (info.shasum) {
    const got = createHash("sha1").update(buf).digest("hex");
    if (got !== info.shasum) fail("opencode 包 sha1 不对：期望 " + info.shasum + " 实际 " + got);
    log("  ✓ npm shasum (sha1) 匹配");
  }
}

async function getEngineFromNpm(t, opts) {
  const info = await resolveEngineFromNpm(t.enginePkg, opts.opencodeVersion);
  log("· opencode-ai " + info.wrapperVersion + " → " + t.enginePkg + "@" + info.engineVersion);
  const tgz = join(CACHE, "opencode", t.enginePkg + "-" + info.engineVersion + ".tgz");
  await download(info.tarball, tgz, t.enginePkg + "-" + info.engineVersion + ".tgz");
  await verifyNpmTarball(tgz, info);

  const tmp = mkTmp("wb-engine-");
  const r = spawnSync("tar", ["-xzf", tgz, "-C", tmp, "--strip-components=2", "package/bin/opencode"], { encoding: "utf8" });
  if (r.status !== 0) fail("解包 " + t.enginePkg + " 失败：" + (r.stderr || r.error));
  const bin = join(tmp, "opencode");
  if (!existsSync(bin)) fail(t.enginePkg + " 里没有 bin/opencode");

  let license = null;
  if (info.wrapperTarball) {
    const w = join(CACHE, "opencode", "opencode-ai-" + info.wrapperVersion + ".tgz");
    try {
      await download(info.wrapperTarball, w, "opencode-ai-" + info.wrapperVersion + ".tgz");
      const licensePath = join(tmp, "LICENSE");
      const rr = spawnSync("tar", ["-xzf", w, "-C", tmp, "--strip-components=2", "package/LICENSE"], { encoding: "utf8" });
      if (rr.status === 0 && existsSync(licensePath)) license = licensePath;
    } catch (e) {
      log("  ! 没拿到 opencode LICENSE（" + e.message + "），继续");
    }
  }
  return { bin, license, version: info.engineVersion, pkg: t.enginePkg, source: "npm registry" };
}

/** 兜底：GitHub sst/opencode releases */
async function getEngineFromGithub(t, opts) {
  log("· npm 路线失败，退回 GitHub releases（sst/opencode）");
  const rel = await fetchJson(GITHUB_API, "sst/opencode latest release");
  const assetName = "opencode-" + t.enginePkg.replace(/^opencode-/, "");
  const asset = (rel.assets || []).find((a) => a.name === assetName + ".zip" || a.name === assetName + ".tar.gz");
  if (!asset) fail("GitHub release " + rel.tag_name + " 里没有 " + assetName + ".zip");
  const file = join(CACHE, "opencode", asset.name);
  await download(asset.browser_download_url, file, asset.name);
  const tmp = mkTmp("wb-engine-gh-");
  if (asset.name.endsWith(".zip")) {
    const r = spawnSync("unzip", ["-o", "-q", file, "-d", tmp], { encoding: "utf8" });
    if (r.status !== 0) fail("解压 " + asset.name + " 失败：" + (r.stderr || r.error));
  } else {
    const r = spawnSync("tar", ["-xzf", file, "-C", tmp], { encoding: "utf8" });
    if (r.status !== 0) fail("解包 " + asset.name + " 失败：" + (r.stderr || r.error));
  }
  const found = await findFile(tmp, "opencode");
  if (!found) fail("GitHub 包解出来找不到 opencode 二进制");
  return { bin: found, license: null, version: rel.tag_name.replace(/^v/, ""), pkg: t.enginePkg, source: "github release" };
}

async function findFile(dir, name) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

function inspectBinary(file, kind, label) {
  const buf = readFileSync(file);
  const size = buf.length;
  if (size < 1024) fail(label + " 太小（" + size + "B）");
  if (kind === "elf-x86_64") {
    const magic = buf.subarray(0, 4).toString("latin1");
    if (magic !== "\x7fELF") fail(label + " 不是 ELF（文件头 " + JSON.stringify(magic) + "）");
    const cls = buf[4];
    const data = buf[5];
    const machine = data === 1 ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    if (cls !== 2) fail(label + " 不是 64 位 ELF（ei_class=" + cls + "）");
    if (data !== 1) fail(label + " 不是小端 ELF（ei_data=" + data + "）");
    if (machine !== 62) fail(label + " 架构不对：e_machine=" + machine + "（期望 62 = x86-64）");
    return { format: "ELF64 little-endian", arch: "x86-64", machine, size };
  }
  if (kind === "macho-arm64") {
    // MH_MAGIC_64 = 0xfeedfacf，arm64 上按小端落盘（字节 cf fa ed fe）。
    const magic = buf.readUInt32LE(0);
    if (magic === 0xcafebabe) fail(label + " 是 fat/universal 二进制，不是单架构 arm64");
    if (magic !== 0xfeedfacf) fail(label + " 不是 64 位 Mach-O（magic=0x" + magic.toString(16) + "）");
    const cpu = buf.readUInt32LE(4);
    if (cpu !== 0x0100000c) fail(label + " 架构不对：cputype=0x" + cpu.toString(16) + "（期望 0x0100000c = arm64）");
    return { format: "Mach-O 64-bit", arch: "arm64", cpu, size };
  }
  return { format: "unknown", size };
}

function glibcFloor(file) {
  const text = readFileSync(file).toString("latin1");
  let max = null;
  const re = /GLIBC_2\.(\d+)/g;
  let m;
  while ((m = re.exec(text))) {
    const v = Number(m[1]);
    if (max === null || v > max) max = v;
  }
  return max === null ? null : "2." + max;
}

function runVersion(file, label) {
  const r = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 60_000 });
  if (r.error) fail(label + " --version 跑不起来：" + r.error.message);
  if (r.status !== 0) fail(label + " --version 退出码 " + r.status + "：" + String(r.stderr || r.stdout || "").slice(0, 300));
  const out = String(r.stdout || r.stderr || "").trim().split("\n")[0];
  if (!out) fail(label + " --version 没有输出");
  log("  ✓ " + label + " --version → " + out);
  return out;
}

async function walk(dir, base) {
  base = base || dir;
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else if (e.isFile()) out.push(p.slice(base.length + 1));
  }
  return out;
}

async function pruneStaging(staging) {
  const banned = /^(data|tests|scripts|node_modules|worktrees|\.git|\.oc|\.wb)$/;
  let removed = 0;
  const visit = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (banned.test(e.name) || e.name.startsWith(".bench") || e.name.startsWith(".demo")) {
          rmSync(p, { recursive: true, force: true });
          removed++;
        } else await visit(p);
      } else if (banned.test(e.name) || e.name.startsWith(".bench") || e.name.startsWith(".demo")) {
        rmSync(p, { force: true });
        removed++;
      }
    }
  };
  await visit(staging);
  if (removed) log("  ! 从 staging 里剔除了 " + removed + " 个不该进包的文件/目录");
}

function writeNotice(staging, opts, nodeAsset, engine, glibc) {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const lines = [
    "workbench 离线单包 —— 第三方组件与许可",
    "",
    "workbench " + version + "（本项目）— MIT，见 licenses/MIT.txt",
    "opencode " + engine.version + "（sst/opencode）— MIT，见 licenses/opencode-LICENSE",
    "Node.js " + nodeAsset.replace(/^node-v([0-9.]+)-.*$/, "$1") + "（nodejs.org）— MIT 及若干第三方许可，见 licenses/node-LICENSE",
    "",
    "目标平台: " + opts.target,
    "opencode 平台包: " + engine.pkg + "（" + engine.source + "）",
    "node 压缩包: " + nodeAsset,
  ];
  if (glibc) lines.push("linux 要求的 glibc 下限: " + glibc);
  lines.push(
    "",
    "Apache-2.0 文本随包附带（licenses/Apache-2.0.txt），供企业分发流程/合规检查使用；",
    "本包不解出任何 Apache-2.0 许可的运行时组件。",
    "",
    "构建时间: " + new Date().toISOString(),
    "本文件由 scripts/bundle.mjs 生成。",
    "",
  );
  writeFileSync(join(staging, "licenses", "NOTICE"), lines.join("\n"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t = TARGETS[opts.target];
  const started = Date.now();
  SKIP_DOWNLOAD = opts.skipDownload;
  mkdirSync(CACHE, { recursive: true });

  log("workbench 离线包 · target=" + opts.target + " · node=" + opts.nodeVersion + " · opencode=" + opts.opencodeVersion);
  log("  输出目录 " + join(ROOT, opts.out));

  const node = await resolveNode(opts.nodeVersion);
  log("· node 版本: " + node.version);
  const got = await getNodeFiles(t, node, opts);

  let engine;
  try {
    engine = await getEngineFromNpm(t, opts);
  } catch (e) {
    log("  ! npm 路线失败：" + e.message);
    engine = await getEngineFromGithub(t, opts);
  }

  log("· 校验二进制");
  const nodeInfo = inspectBinary(got.nodeBin, t.binary, "bin/node");
  log("  ✓ node: " + nodeInfo.format + " " + nodeInfo.arch + " " + human(nodeInfo.size));
  if (t.binary === "macho-arm64" && process.platform === "darwin" && process.arch === "arm64") runVersion(got.nodeBin, "包内 node");
  chmodSync(got.nodeBin, 0o755);

  const engInfo = inspectBinary(engine.bin, t.binary, "engine/opencode");
  log("  ✓ opencode: " + engInfo.format + " " + engInfo.arch + " " + human(engInfo.size));
  let engineVersionText = null;
  if (t.binary === "macho-arm64") engineVersionText = runVersion(engine.bin, "engine/opencode");
  else log("  · linux 二进制在本机跑不了：用文件头（ELF64 / e_machine=62）校验代替执行");
  chmodSync(engine.bin, 0o755);

  const glibc = t.binary === "elf-x86_64" ? glibcFloor(engine.bin) : null;
  if (glibc) {
    const nodeGlibc = glibcFloor(got.nodeBin);
    log("  · glibc 符号：opencode 要求 >= " + glibc + "，node 要求 >= " + nodeGlibc);
  }

  const staging = join(CACHE, "staging", "workbench-" + opts.target);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "bin"), { recursive: true });
  mkdirSync(join(staging, "kernel"), { recursive: true });
  mkdirSync(join(staging, "engine"), { recursive: true });
  mkdirSync(join(staging, "licenses"), { recursive: true });

  log("· 组装 staging");
  await cp(got.nodeBin, join(staging, "bin", "node"));
  await cp(join(ROOT, "bin", "wb"), join(staging, "bin", "wb"));
  await cp(join(ROOT, "src"), join(staging, "kernel", "src"), { recursive: true });
  await cp(join(ROOT, "web"), join(staging, "kernel", "web"), { recursive: true });
  await cp(join(ROOT, "package.json"), join(staging, "kernel", "package.json"));
  await cp(engine.bin, join(staging, "engine", "opencode"));
  chmodSync(join(staging, "engine", "opencode"), 0o755);
  chmodSync(join(staging, "bin", "node"), 0o755);
  chmodSync(join(staging, "bin", "wb"), 0o755);

  const engineVersion = (engineVersionText && (engineVersionText.match(/\d+\.\d+\.\d+/) || [])[0]) || engine.version;
  writeFileSync(join(staging, "engine", "VERSION"), "opencode " + engineVersion + " (" + engine.pkg + ", " + engine.source + ")\nnode " + node.version + "\ntarget " + opts.target + "\n");

  const licDir = join(ROOT, "packaging", "licenses");
  if (existsSync(join(ROOT, "LICENSE"))) await cp(join(ROOT, "LICENSE"), join(staging, "licenses", "MIT.txt"));
  else writeFileSync(join(staging, "licenses", "MIT.txt"), "MIT License\n\nCopyright (c) 2026 workbench contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n");
  await cp(join(licDir, "Apache-2.0.txt"), join(staging, "licenses", "Apache-2.0.txt"));
  if (engine.license && existsSync(engine.license)) await cp(engine.license, join(staging, "licenses", "opencode-LICENSE"));
  else writeFileSync(join(staging, "licenses", "opencode-LICENSE"), "opencode 平台包没带 LICENSE；opencode 本体是 MIT，见 https://github.com/sst/opencode/blob/dev/LICENSE\n");
  if (existsSync(got.license)) await cp(got.license, join(staging, "licenses", "node-LICENSE"));
  else writeFileSync(join(staging, "licenses", "node-LICENSE"), "Node.js is licensed under the MIT license; see https://github.com/nodejs/node/blob/main/LICENSE\n");
  writeNotice(staging, opts, got.asset, engine, glibc);

  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const versions = [
    "workbench " + version,
    "target " + opts.target,
    "node " + node.version + " (" + got.asset + ")",
    "opencode " + engineVersion + " (" + engine.pkg + ", " + engine.source + ")",
  ];
  if (glibc) versions.push("glibc >= " + glibc);
  versions.push("built " + new Date().toISOString(), "");
  writeFileSync(join(staging, "VERSIONS"), versions.join("\n"));

  for (const f of ["install.sh", "uninstall.sh", "config.example.env"]) {
    await cp(join(ROOT, "packaging", f), join(staging, f));
    chmodSync(join(staging, f), 0o755);
  }
  let readme = await readFile(join(ROOT, "packaging", "README-OFFLINE.md"), "utf8");
  readme = readme
    .replaceAll("{{TARGET}}", opts.target)
    .replaceAll("{{NODE_VERSION}}", node.version)
    .replaceAll("{{OPENCODE_VERSION}}", engineVersion)
    .replaceAll("{{GLIBC_FLOOR}}", glibc || "不适用（macOS）")
    .replaceAll("{{BUILT_AT}}", new Date().toISOString());
  writeFileSync(join(staging, "README-OFFLINE.md"), readme);
  chmodSync(join(staging, "bin", "wb"), 0o755);

  await pruneStaging(staging);

  const files = (await walk(staging)).filter((f) => f !== "SHA256SUMS").sort();
  const lines = [];
  for (const rel of files) lines.push((await sha256File(join(staging, rel))) + "  " + rel);
  writeFileSync(join(staging, "SHA256SUMS"), lines.join("\n") + "\n");
  log("  ✓ SHA256SUMS：" + files.length + " 个文件");

  const outDir = join(ROOT, opts.out);
  mkdirSync(outDir, { recursive: true });
  const tarball = join(outDir, "workbench-" + opts.target + ".tar.gz");
  rmSync(tarball, { force: true });
  log("· 打包");
  const tarRes = spawnSync("tar", ["-czf", tarball, "-C", join(CACHE, "staging"), "workbench-" + opts.target], { encoding: "utf8" });
  if (tarRes.status !== 0) fail("tar 失败：" + (tarRes.stderr || tarRes.error));

  const size = statSync(tarball).size;
  const digest = (await sha256File(tarball)).slice(0, 16);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log("");
  log("✓ 打包完成");
  log("  文件    " + tarball);
  log("  大小    " + human(size) + "（" + size + " 字节）");
  log("  sha256  " + digest + "…");
  log("  耗时    " + elapsed + "s");
  log("");
  log("  关键文件：");
  for (const rel of ["bin/node", "bin/wb", "kernel/src/server/index.mjs", "engine/opencode", "engine/VERSION", "licenses/NOTICE", "SHA256SUMS", "install.sh", "README-OFFLINE.md"]) {
    const p = join(staging, rel);
    if (existsSync(p)) log("    " + human(statSync(p).size).padStart(8) + "  " + rel);
  }
  log("    " + String(files.length).padStart(8) + " 个文件（见 SHA256SUMS）");

  if (opts.keepStaging) log("  staging 保留在 " + staging);
  else rmSync(join(CACHE, "staging"), { recursive: true, force: true });
  cleanupTemps();
}

main().catch((e) => { cleanupTemps(); fail(e.stack || String(e)); });
