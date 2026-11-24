import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { createProject } from "../src/core/stages.mjs";
import { addMemory, memoryOf, memoryDigest, MEMORY_KINDS } from "../src/core/memory.mjs";

const freshDb = () => openDb(resolve(mkdtempSync(join(tmpdir(), "wb-mem-")), "t.db"));
const proj = (db) => createProject(db, { title: "记忆测试", repo: "repo", lane: "chore", owner: "alice" }).id;

test("记忆：去空白、截 200 字、记 memory.added 事件（真源在账本）", () => {
  const db = freshDb();
  const id = proj(db);
  const m = addMemory(db, id, { kind: "pitfall", text: "  除零要抛  错误\n 不要返回 Infinity ", source: "t1", by: "bob" });
  assert.match(m, /^m_/);
  const rows = memoryOf(db, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "除零要抛 错误 不要返回 Infinity");
  assert.equal(rows[0].kind, "pitfall");
  const ev = db.prepare("SELECT * FROM events WHERE type='memory.added' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(ev.payload).text, rows[0].text);
  assert.equal(JSON.parse(ev.payload).by, "bob");
  assert.equal(MEMORY_KINDS.permission, undefined);
});

test("记忆：类型白名单、空内容、200 字上限", () => {
  const db = freshDb();
  const id = proj(db);
  assert.throws(() => addMemory(db, id, { kind: "gossip", text: "x" }), /记忆类型/);
  assert.throws(() => addMemory(db, id, { text: "   " }), /不能为空/);
  addMemory(db, id, { text: "长".repeat(500) });
  assert.equal(memoryOf(db, id)[0].text.length, 200);
});

test("记忆摘要：最近 8 条 + 按角色召回 5 条，去重后不超过 13 行", () => {
  const db = freshDb();
  const id = proj(db);
  // 老条目：12 条决定（只有 lead 关心）+ 最近的坑与接口。
  for (let i = 0; i < 12; i++) addMemory(db, id, { kind: "decision", text: "第 " + i + " 条决定" });
  for (let i = 0; i < 8; i++) addMemory(db, id, { kind: "pitfall", text: "第 " + i + " 条坑" });
  addMemory(db, id, { kind: "interface", text: "testCmd 必须是 node --test" });

  const coder = memoryDigest(db, id, { role: "coder" });
  assert.ok(coder.startsWith("## 项目记忆"));
  assert.match(coder, /testCmd/);
  assert.match(coder, /第 7 条坑/);
  assert.match(coder, /与记忆冲突/);
  assert.doesNotMatch(coder, /第 0 条决定/, "coder 不需要老决定（省 token）");

  const lead = memoryDigest(db, id, { role: "lead" });
  assert.equal(lead.split("\n").filter((l) => l.startsWith("- [")).length, 13, "8 最近 + 5 条决定，去重后 13");
  assert.match(lead, /第 11 条决定/, "lead 能看到最近的决策记录");
  assert.doesNotMatch(lead, /第 0 条坑/, "最老的坑不会被塞进来");
});

test("记忆摘要：没有项目 / 没有条目时返回空串（提示词里不留空段）", () => {
  const db = freshDb();
  assert.equal(memoryDigest(db, null), "");
  assert.equal(memoryDigest(db, proj(db)), "");
});
